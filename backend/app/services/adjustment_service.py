import copy
from datetime import datetime, timezone
from sqlalchemy.orm import Session

from app.models import Receipt, InventoryAdjustment, PalletLicence
from app.models.location import StorageRow
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
                # When the operator picked specific rows on the form, deduct
                # from those rows so on-hand-by-row stays accurate.
                _apply_row_breakdown(db, receipt, adjustment)
            adjustment.new_quantity = receipt.quantity
            if receipt.quantity <= 0:
                receipt.status = ReceiptStatus.DEPLETED

    return adjustment


def _apply_row_breakdown(db: Session, receipt: Receipt, adjustment: InventoryAdjustment) -> None:
    """Deduct cases from the specific storage rows the operator picked.

    `adjustment.source_breakdown` is a list of `{id, quantity}`; ids prefixed
    `row-` reference a StorageRow. Updates StorageRow.occupied_cases/_pallets
    AND receipt.raw_material_row_allocations so future totals stay consistent.
    """
    breakdown = adjustment.source_breakdown
    if not breakdown or not isinstance(breakdown, list):
        return

    cases_per_pallet = float(receipt.cases_per_pallet or 0)
    deductions_by_row: dict[str, float] = {}
    for entry in breakdown:
        src_id = (entry or {}).get("id", "")
        if not isinstance(src_id, str) or not src_id.startswith("row-"):
            continue
        row_id = src_id.removeprefix("row-")
        qty = float(entry.get("quantity", 0) or 0)
        if qty <= 0:
            continue
        deductions_by_row[row_id] = deductions_by_row.get(row_id, 0.0) + qty

    if not deductions_by_row:
        return

    # 1. Update each StorageRow's occupancy
    for row_id, cases_to_free in deductions_by_row.items():
        row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
        if not row:
            continue
        pallets_to_free = (cases_to_free / cases_per_pallet) if cases_per_pallet > 0 else 0
        row.occupied_cases = max(0.0, float(row.occupied_cases or 0) - cases_to_free)
        row.occupied_pallets = max(0.0, float(row.occupied_pallets or 0) - pallets_to_free)
        if row.occupied_pallets <= 0:
            row.product_id = None

    # 2. Update receipt.raw_material_row_allocations so the next form view
    #    shows the right per-row availability.
    if receipt.raw_material_row_allocations and isinstance(receipt.raw_material_row_allocations, list):
        allocs = copy.deepcopy(receipt.raw_material_row_allocations)
        for alloc in allocs:
            row_id = alloc.get("rowId")
            if row_id in deductions_by_row:
                cases_left = max(0.0, float(alloc.get("cases", 0) or 0) - deductions_by_row[row_id])
                alloc["cases"] = cases_left
                if cases_per_pallet > 0:
                    alloc["pallets"] = cases_left / cases_per_pallet
                elif cases_left == 0:
                    alloc["pallets"] = 0
        receipt.raw_material_row_allocations = [a for a in allocs if float(a.get("cases", 0) or 0) > 0]


def reject_adjustment(db: Session, adjustment: InventoryAdjustment, reason: str, current_user) -> InventoryAdjustment:
    """Reject an adjustment: validate permissions, append rejection note."""
    if adjustment.status != AdjustmentStatus.PENDING:
        raise ValidationError("Adjustment is not in pending status")

    if current_user.role == ROLE_WAREHOUSE and adjustment.submitted_by == str(current_user.id):
        raise ForbiddenError("You cannot reject your own adjustments. Only other users' adjustments can be rejected.")

    adjustment.status = AdjustmentStatus.REJECTED
    adjustment.reason = f"{adjustment.reason}\n[Rejected by {current_user.name}]: {reason}"

    return adjustment
