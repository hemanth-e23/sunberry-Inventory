from datetime import datetime, timezone
from sqlalchemy.orm import Session

from app.models import (
    Receipt, InventoryHoldAction, LotPlacement, MaterialLot, StorageRow, PalletLicence
)
from app.enums import HoldStatus, PalletStatus
from app.exceptions import ForbiddenError, ValidationError, NotFoundError
from app.constants import ROLE_WAREHOUSE
from app.services import lot_placement_service as lps


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
            "total_quantity": sum(p.cases or 0 for p in pallets),
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

        # `receipt.hold` alone is NOT the answer any more. A partial hold —
        # eight wet bags on one rack — deliberately leaves it False so the other
        # thirty-two stay stageable, and the quarantine lives on the placements
        # instead. Gating on the flag alone made a partially-held lot
        # impossible to release: the screen offered Release and the server
        # answered "not on hold".
        held = is_receipt_held(db, receipt)

        if hold_action_data.action == "release" and not held:
            raise ValidationError("Cannot release a lot that is not on hold")

        if hold_action_data.action == "hold" and held:
            raise ValidationError("Lot is already on hold")

        result = hold_action_data.dict()
        result["pallet_licence_ids"] = None
        return result


def is_receipt_held(db: Session, receipt: Receipt) -> bool:
    """Is anything about this receipt's material quarantined?

    THREE places a hold can live, and any one of them counts:

      * `receipt.hold`            — legacy, and still the only option for
                                    material with no placements (a rows-less
                                    location has no rack to hold)
      * `MaterialLot.is_held`     — the whole lot, wherever it sits
      * `LotPlacement.held_units` — N containers on specific racks

    Reading only the first is what made a partially-held lot unreleasable.
    """
    if receipt is None:
        return False
    if receipt.hold:
        return True
    if not receipt.material_lot_id:
        return False

    lot = db.query(MaterialLot).filter(MaterialLot.id == receipt.material_lot_id).first()
    if lot is not None and lot.is_held:
        return True
    return bool(
        db.query(LotPlacement.id)
        .filter(
            LotPlacement.material_lot_id == receipt.material_lot_id,
            LotPlacement.held_units > 0,
        )
        .first()
    )


def resolve_row_id(db: Session, location_id: str):
    """The storage row a hold item names, or None if it names something else.

    Resolved by LOOKUP rather than by string surgery, because the obvious
    `location_id.split("-row-")[-1]` is wrong and had been wrong since it was
    written. Storage row ids literally contain the separator — they look like
    `sub-row-1768418496176` and `fg-row-1768397469384` — so a greedy split eats
    the id's own prefix and yields a bare timestamp that matches no row. Every
    hold that named a rack silently resolved to nothing, which is why
    `receipt.hold_location` has always come back empty.

    Splitting once instead does not fix it either: `sub-row-123` is genuinely
    ambiguous with a prefixed `<something>-row-<id>`. So every candidate split is
    tried against the table and the one that is a real row wins. A hold item
    naming a location or sub-location resolves to None and is skipped, which is
    the intended behaviour — only racks hold drums.
    """
    if not location_id:
        return None
    if db.query(StorageRow.id).filter(StorageRow.id == location_id).first():
        return location_id

    marker = "-row-"
    index = location_id.find(marker)
    while index != -1:
        candidate = location_id[index + len(marker):]
        if db.query(StorageRow.id).filter(StorageRow.id == candidate).first():
            return candidate
        index = location_id.find(marker, index + 1)
    return None


def _rows_from_hold_items(db: Session, hold_items) -> dict:
    """`{storage_row_id: {"units": int|None, "quantity": float}}` per named rack.

    Both are carried because callers count differently: QA counts drums, and the
    older hold form collects weight. `units` wins when given — see HoldItem.
    """
    out: dict = {}
    for item in (hold_items or []):
        row_id = resolve_row_id(db, (item or {}).get("location_id", "") or "")
        if not row_id:
            continue
        entry = out.setdefault(row_id, {"units": None, "quantity": 0.0})
        entry["quantity"] += float((item or {}).get("quantity", 0) or 0)
        units = (item or {}).get("units")
        if units is not None:
            entry["units"] = (entry["units"] or 0) + int(units)
    return out


def _apply_lot_hold(db: Session, receipt: Receipt, hold_action, current_user) -> None:
    """Quarantine (or release) the actual drums, at whichever granularity was asked.

    Two shapes, and the difference is which question QA is answering:

      * NO racks named -> the WHOLE LOT. A bad vendor certificate makes every
        drum suspect wherever it is sitting, including drums from a different
        truck of the same vendor lot. `MaterialLot.is_held` covers exactly that.

      * racks named    -> N drums ON THOSE RACKS. Eight of the forty got wet.
        The lot is fine; those eight are not. Held per placement.

    A per-rack quantity arrives in the receipt's own unit (pounds), because that
    is what the hold form has always collected, and is converted to whole drums.
    Rounded UP: holding "500 lbs" of a 500 lb drum has to quarantine the whole
    drum, since half a sealed drum cannot be released.
    """
    if not receipt.material_lot_id:
        return
    lot = db.query(MaterialLot).filter(MaterialLot.id == receipt.material_lot_id).first()
    if not lot:
        return

    now = datetime.now(timezone.utc)
    actor = str(current_user.id)
    releasing = hold_action.action == "release"
    by_row = _rows_from_hold_items(db, hold_action.hold_items)

    if releasing:
        # Release everything this lot has held, at both granularities. A release
        # that only cleared the level the hold happened to use would leave
        # material quarantined with no visible hold against it.
        lot.is_held = False
        lot.hold_reason = None
        lot.held_by = None
        lot.held_at = None
        for placement in lps.placements_for_lot(db, lot.id, include_empty=True):
            if by_row and placement.storage_row_id not in by_row:
                # A rack-scoped release leaves other racks quarantined.
                continue
            placement.held_units = 0
            placement.hold_reason = None
            placement.held_by = None
            placement.held_at = None
        # PROJECT. A hold changes what is available without moving a container,
        # and the allocation JSON is how most screens learn about it — including
        # the Holds screen deciding whether to offer Hold or Release. Skipping
        # this left the quarantine invisible to every reader of that JSON.
        lps.project_lot(db, lot)
        db.flush()
        return

    if not by_row:
        lot.is_held = True
        lot.hold_reason = hold_action.reason
        lot.held_by = actor
        lot.held_at = now
        lps.project_lot(db, lot)
        db.flush()
        return

    placements = {
        p.storage_row_id: p
        for p in lps.placements_for_lot(db, lot.id, include_empty=True)
    }
    for row_id, want in by_row.items():
        placement = placements.get(row_id)
        if placement is None:
            continue
        if want["units"] is not None:
            units = int(want["units"])
        else:
            qty = want["quantity"]
            units = lps.units_for_quantity(lot, qty) if qty > 0 else 0
        # Never more than is on the rack — the database enforces this too, and a
        # CheckConstraint violation mid-approval is a worse error message than
        # quietly holding everything that is actually there.
        placement.held_units = min(int(units), int(placement.full_units or 0))
        placement.hold_reason = hold_action.reason
        placement.held_by = actor
        placement.held_at = now
    lps.project_lot(db, lot)
    db.flush()


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
            # Only hold pallets that are still in stock — a pallet that shipped
            # between hold-request and approval must not be re-held.
            if is_hold and pallet.status != PalletStatus.IN_STOCK:
                continue
            pallet.is_held = is_hold

        # Recalculate held_quantity for each affected receipt
        affected_receipt_ids = set(p.receipt_id for p in pallets if p.receipt_id)
        for receipt_id in affected_receipt_ids:
            held_cases = sum(
                (p.cases or 0) for p in db.query(PalletLicence).filter(
                    PalletLicence.receipt_id == receipt_id,
                    PalletLicence.is_held == True,
                    PalletLicence.status == PalletStatus.IN_STOCK,
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
            # `receipt.hold` is a WHOLE-RECEIPT flag and the staging suggestion
            # list filters on it, so setting it for a PARTIAL hold would hide a
            # lot with thirty-two perfectly good drums because eight got wet.
            #
            # Only a counted lot can express the partial somewhere better: its
            # placements carry the held count per rack, and availability
            # subtracts exactly those. A legacy receipt has nowhere else to put
            # it, so there the flag still goes on and the whole receipt is held —
            # coarse, but not silently wrong.
            partial_on_a_counted_lot = bool(
                lps.is_counted_lot(db, receipt.material_lot_id)
                and _rows_from_hold_items(db, hold_action.hold_items)
            )
            receipt.hold = not partial_on_a_counted_lot
            if hold_action.total_quantity and hold_action.total_quantity > 0:
                receipt.held_quantity = hold_action.total_quantity
            elif receipt.hold:
                receipt.held_quantity = receipt.quantity

            # Resolve hold location name from hold_items
            if hold_action.hold_items and len(hold_action.hold_items) > 0:
                location_names = []
                for item in hold_action.hold_items:
                    row_id = resolve_row_id(db, item.get("location_id", ""))
                    if not row_id:
                        continue
                    storage_row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
                    if storage_row:
                        location_names.append(storage_row.name)
                if location_names:
                    receipt.hold_location = ", ".join(location_names)

        elif hold_action.action == "release":
            receipt.hold = False
            receipt.held_quantity = 0
            receipt.hold_location = None

        # THE part that makes the hold real for lot-tracked material.
        #
        # Everything above writes `receipt.hold`, which for a counted lot no
        # reader consults any more: the receipt steps aside from the availability
        # sum so its drums are not counted twice, once as a legacy quantity and
        # once as placements. Setting it alone produced a hold that held nothing
        # — QA quarantined a lot for a positive swab and production could still
        # stage every drum, silently.
        _apply_lot_hold(db, receipt, hold_action, current_user)

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
