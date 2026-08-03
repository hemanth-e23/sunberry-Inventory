from datetime import datetime, timezone
from sqlalchemy.orm import Session

from app.models import Receipt, InventoryAdjustment, PalletLicence
from app.models.location import StorageRow
from app.enums import AdjustmentStatus, ReceiptStatus, PalletStatus, AdjustmentType
from app.enums import DEDUCTION_TYPES  # noqa: F401  (re-exported; routers/adjustments.py:65 reads adjustment_service.DEDUCTION_TYPES)
from app.exceptions import ForbiddenError, ValidationError
from app.constants import ROLE_WAREHOUSE
from app.services.ship_out_service import _release_row_capacity
from app.services.transfer_service import _rebuild_receipt_allocation_from_licences
from app.services.row_allocation import parse_breakdown, parse_pallet_breakdown, deduct_rm_rows, deduct_rm_total

# DEDUCTION_TYPES moved to app/enums.py (2026-08-03) and is imported above.
# It is derived from AdjustmentType there so a new adjustment type cannot be
# added without a deliberate decision about whether it decrements the receipt —
# previously an unlisted type silently produced an APPROVED adjustment that left
# `receipt.quantity` untouched. Membership is unchanged.


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
                # Take the adjusted pallets out of stock and free the storage
                # rows they occupied. Without this they stayed IN_STOCK and
                # could be picked again at ship-out — deducting the receipt a
                # second time for goods that were already written off.
                for pallet in receipt_pallets:
                    _release_row_capacity(db, pallet, pallet.cases or 0)
                    pallet.status = PalletStatus.CANCELLED
                # Rebuild the FG occupancy view from the remaining IN_STOCK
                # pallets so row cards and allocation stay in sync.
                _rebuild_receipt_allocation_from_licences(db, receipt)
                if receipt.quantity <= 0:
                    receipt.status = ReceiptStatus.DEPLETED
    else:
        # Lot-based (RM / Packaging)
        receipt = db.query(Receipt).filter(Receipt.id == adjustment.receipt_id).first()
        if receipt:
            adjustment.original_quantity = receipt.quantity
            if adjustment.adjustment_type in DEDUCTION_TYPES:
                receipt.quantity = max(0, receipt.quantity - adjustment.quantity)
                # When the operator picked specific rows on the form, deduct
                # from those rows so on-hand-by-row stays accurate.
                _apply_row_breakdown(db, receipt, adjustment)
            adjustment.new_quantity = receipt.quantity
            if receipt.quantity <= 0:
                receipt.status = ReceiptStatus.DEPLETED

    return adjustment


def _apply_row_breakdown(db: Session, receipt: Receipt, adjustment: InventoryAdjustment) -> None:
    """Deduct from storage rows + receipt.raw_material_row_allocations via the
    shared helper. When the operator picked specific rows, deduct exactly those;
    otherwise prorate the adjustment across the lot's current allocations so a
    plain quantity deduction no longer leaves rows/JSON untouched."""
    deductions = parse_breakdown(adjustment.source_breakdown)
    if deductions:
        # Free exactly the pallets the operator entered per row (no cases/cpp).
        pallets = parse_pallet_breakdown(adjustment.source_breakdown)
        deduct_rm_rows(db, receipt, deductions, pallets_by_row=pallets, update_rows=True)
    else:
        deduct_rm_total(db, receipt, float(adjustment.quantity or 0), update_rows=True)


def reject_adjustment(db: Session, adjustment: InventoryAdjustment, reason: str, current_user) -> InventoryAdjustment:
    """Reject an adjustment: validate permissions, append rejection note."""
    if adjustment.status != AdjustmentStatus.PENDING:
        raise ValidationError("Adjustment is not in pending status")

    if current_user.role == ROLE_WAREHOUSE and adjustment.submitted_by == str(current_user.id):
        raise ForbiddenError("You cannot reject your own adjustments. Only other users' adjustments can be rejected.")

    adjustment.status = AdjustmentStatus.REJECTED
    adjustment.reason = f"{adjustment.reason}\n[Rejected by {current_user.name}]: {reason}"

    return adjustment
