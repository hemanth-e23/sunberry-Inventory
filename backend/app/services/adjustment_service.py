from datetime import datetime, timezone
from sqlalchemy.orm import Session

from app.models import Receipt, InventoryAdjustment, PalletLicence
from app.enums import AdjustmentStatus, ReceiptStatus
from app.exceptions import ForbiddenError, ValidationError
from app.constants import ROLE_WAREHOUSE

# Adjustment types that reduce inventory quantity
DEDUCTION_TYPES = frozenset({
    "reduce",
    "stock-correction",
    "damage-reduction",
    "donation",
    "trash-disposal",
    "quality-rejection",
    "used-in-production",
})


def approve_adjustment(db: Session, adjustment: InventoryAdjustment, current_user) -> InventoryAdjustment:
    """Approve an adjustment: validate permissions, apply quantity change to receipt."""
    if adjustment.status != AdjustmentStatus.PENDING:
        raise ValidationError("Adjustment is not in pending status")

    if current_user.role == ROLE_WAREHOUSE and adjustment.submitted_by == str(current_user.id):
        raise ForbiddenError("You cannot approve your own adjustments. Only other users' adjustments can be approved.")

    adjustment.status = AdjustmentStatus.APPROVED
    adjustment.approved_by = str(current_user.id)
    adjustment.approved_at = datetime.now(timezone.utc)

    if adjustment.pallet_licence_ids:
        # Pallet-based (Finished Goods): subtract each pallet's cases from its receipt
        pallets = db.query(PalletLicence).filter(
            PalletLicence.id.in_(adjustment.pallet_licence_ids)
        ).all()
        affected: dict = {}
        for pallet in pallets:
            if pallet.receipt_id:
                affected.setdefault(pallet.receipt_id, []).append(pallet)
        for receipt_id, receipt_pallets in affected.items():
            receipt = db.query(Receipt).filter(Receipt.id == receipt_id).first()
            if receipt and adjustment.adjustment_type in DEDUCTION_TYPES:
                cases_removed = sum(p.cases or 0 for p in receipt_pallets)
                adjustment.original_quantity = receipt.quantity
                receipt.quantity = max(0, receipt.quantity - cases_removed)
                adjustment.new_quantity = receipt.quantity
                if receipt.quantity <= 0:
                    receipt.status = ReceiptStatus.DEPLETED
    else:
        # Lot-based (RM / Packaging)
        receipt = db.query(Receipt).filter(Receipt.id == adjustment.receipt_id).first()
        if receipt:
            adjustment.original_quantity = receipt.quantity
            if adjustment.adjustment_type in DEDUCTION_TYPES:
                receipt.quantity = max(0, receipt.quantity - adjustment.quantity)
            adjustment.new_quantity = receipt.quantity
            if receipt.quantity <= 0:
                receipt.status = ReceiptStatus.DEPLETED

    return adjustment


def reject_adjustment(db: Session, adjustment: InventoryAdjustment, reason: str, current_user) -> InventoryAdjustment:
    """Reject an adjustment: validate permissions, append rejection note."""
    if adjustment.status != AdjustmentStatus.PENDING:
        raise ValidationError("Adjustment is not in pending status")

    if current_user.role == ROLE_WAREHOUSE and adjustment.submitted_by == str(current_user.id):
        raise ForbiddenError("You cannot reject your own adjustments. Only other users' adjustments can be rejected.")

    adjustment.status = AdjustmentStatus.REJECTED
    adjustment.reason = f"{adjustment.reason}\n[Rejected by {current_user.name}]: {reason}"

    return adjustment
