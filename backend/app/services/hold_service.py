from datetime import datetime, timezone
from sqlalchemy.orm import Session

from app.models import Receipt, InventoryHoldAction, StorageRow, PalletLicence
from app.enums import HoldStatus
from app.exceptions import ForbiddenError, ValidationError, NotFoundError
from app.constants import ROLE_WAREHOUSE


def validate_and_build_hold_dict(db: Session, hold_action_data) -> dict:
    """Validate hold action input and build the dict for InventoryHoldAction creation.

    Supports three modes:
    - Pallet hold (FG): pallet_licence_ids list provided
    - Partial hold: hold_items list with per-receipt quantities
    - Full-lot hold: single receipt_id
    """
    if hold_action_data.action not in ("hold", "release"):
        raise ValidationError("Action must be 'hold' or 'release'")

    if hold_action_data.pallet_licence_ids and len(hold_action_data.pallet_licence_ids) > 0:
        # Pallet hold mode — validate each pallet licence
        pallets = db.query(PalletLicence).filter(
            PalletLicence.id.in_(hold_action_data.pallet_licence_ids)
        ).all()
        if len(pallets) != len(hold_action_data.pallet_licence_ids):
            raise ValidationError("One or more pallet licence IDs not found")

        if hold_action_data.action == "hold":
            already_held = [p.licence_number for p in pallets if p.is_held]
            if already_held:
                raise ValidationError(f"Pallets already on hold: {', '.join(already_held)}")
        else:
            not_held = [p.licence_number for p in pallets if not p.is_held]
            if not_held:
                raise ValidationError(f"Pallets not on hold: {', '.join(not_held)}")

        return {
            "receipt_id": None,
            "action": hold_action_data.action,
            "reason": hold_action_data.reason,
            "hold_items": None,
            "total_quantity": sum(p.cases for p in pallets),
            "pallet_licence_ids": hold_action_data.pallet_licence_ids,
        }

    elif hold_action_data.hold_items and len(hold_action_data.hold_items) > 0:
        # Partial hold mode — validate each receipt
        receipt_ids = {item.receipt_id for item in hold_action_data.hold_items}
        for receipt_id in receipt_ids:
            receipt = db.query(Receipt).filter(Receipt.id == receipt_id).first()
            if not receipt:
                raise NotFoundError("Receipt", receipt_id)

        first_receipt_id = hold_action_data.hold_items[0].receipt_id
        return {
            "receipt_id": first_receipt_id,
            "action": hold_action_data.action,
            "reason": hold_action_data.reason,
            "hold_items": [item.dict() for item in hold_action_data.hold_items],
            "total_quantity": hold_action_data.total_quantity,
            "pallet_licence_ids": None,
        }
    else:
        # Full-lot hold mode
        if not hold_action_data.receipt_id:
            raise ValidationError("Either receipt_id, hold_items, or pallet_licence_ids must be provided")

        receipt = db.query(Receipt).filter(Receipt.id == hold_action_data.receipt_id).first()
        if not receipt:
            raise NotFoundError("Receipt", hold_action_data.receipt_id)

        if hold_action_data.action == "release" and not receipt.hold:
            raise ValidationError("Cannot release a lot that is not on hold")

        if hold_action_data.action == "hold" and receipt.hold:
            raise ValidationError("Lot is already on hold")

        result = hold_action_data.dict()
        result["pallet_licence_ids"] = None
        return result


def approve_hold_action(db: Session, hold_action: InventoryHoldAction, current_user) -> InventoryHoldAction:
    """Approve a hold action: validate permissions, apply hold/release to receipt or pallets."""
    if hold_action.status != HoldStatus.PENDING:
        raise ValidationError("Hold action is not in pending status")

    if current_user.role == ROLE_WAREHOUSE and hold_action.submitted_by == str(current_user.id):
        raise ForbiddenError("You cannot approve your own hold actions. Only other users' hold actions can be approved.")

    # Pallet hold mode
    if hold_action.pallet_licence_ids:
        pallets = db.query(PalletLicence).filter(
            PalletLicence.id.in_(hold_action.pallet_licence_ids)
        ).all()
        is_hold = hold_action.action == "hold"
        for pallet in pallets:
            pallet.is_held = is_hold

        # Recalculate held_quantity for each affected receipt
        affected_receipt_ids = set(p.receipt_id for p in pallets if p.receipt_id)
        for receipt_id in affected_receipt_ids:
            held_cases = sum(
                p.cases for p in db.query(PalletLicence).filter(
                    PalletLicence.receipt_id == receipt_id,
                    PalletLicence.is_held == True,
                ).all()
            )
            receipt = db.query(Receipt).filter(Receipt.id == receipt_id).first()
            if receipt:
                receipt.held_quantity = held_cases
                receipt.hold = held_cases > 0
    else:
        # Lot-hold path (raw materials / packaging / partial hold)
        receipt = db.query(Receipt).filter(Receipt.id == hold_action.receipt_id).first()
        if not receipt:
            raise NotFoundError("Receipt", hold_action.receipt_id)

        if hold_action.action == "hold":
            receipt.hold = True
            if hold_action.total_quantity and hold_action.total_quantity > 0:
                receipt.held_quantity = hold_action.total_quantity
            else:
                receipt.held_quantity = receipt.quantity

            # Resolve hold location name from hold_items
            if hold_action.hold_items and len(hold_action.hold_items) > 0:
                location_names = []
                for item in hold_action.hold_items:
                    location_id = item.get("location_id", "")
                    if "-row-" in location_id:
                        row_id = location_id.split("-row-")[-1]
                        storage_row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
                        if storage_row:
                            location_names.append(storage_row.name)
                if location_names:
                    receipt.hold_location = ", ".join(location_names)

        elif hold_action.action == "release":
            receipt.hold = False
            receipt.held_quantity = 0
            receipt.hold_location = None

    hold_action.status = HoldStatus.APPROVED
    hold_action.approved_by = str(current_user.id)
    hold_action.approved_at = datetime.now(timezone.utc)

    return hold_action


def reject_hold_action(db: Session, hold_action: InventoryHoldAction, reason: str, current_user) -> InventoryHoldAction:
    """Reject a hold action: validate permissions, append rejection note."""
    if hold_action.status != HoldStatus.PENDING:
        raise ValidationError("Hold action is not in pending status")

    if current_user.role == ROLE_WAREHOUSE and hold_action.submitted_by == str(current_user.id):
        raise ForbiddenError("You cannot reject your own hold actions. Only other users' hold actions can be rejected.")

    hold_action.status = HoldStatus.REJECTED
    hold_action.reason = f"{hold_action.reason}\n[Rejected by {current_user.name}]: {reason}".strip()

    return hold_action
