from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from datetime import datetime
import uuid

from app.database import get_db
from app.models import Receipt, InventoryAdjustment, PalletLicence
from app.schemas import (
    InventoryAdjustment as InventoryAdjustmentSchema,
    InventoryAdjustmentCreate,
    InventoryAdjustmentUpdate,
)
from app.utils.auth import get_current_active_user, warehouse_filter, resolve_warehouse_for_write, require_approval_access
from app.enums import AdjustmentStatus
from app.services import adjustment_service, transfer_service
from app.services import lot_placement_service as lps
from app.constants import ROLE_WAREHOUSE

router = APIRouter()


@router.get("/adjustments", response_model=List[InventoryAdjustmentSchema])
def get_adjustments(
    skip: int = 0,
    limit: int = 100,
    status: str = None,
    adjustment_type: str = None,
    submitted_by: str = None,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get all inventory adjustments"""
    query = db.query(InventoryAdjustment)

    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.filter(InventoryAdjustment.warehouse_id == wh_id)

    if status:
        query = query.filter(InventoryAdjustment.status == status)
    if adjustment_type:
        query = query.filter(InventoryAdjustment.adjustment_type == adjustment_type)
    if submitted_by:
        query = query.filter(InventoryAdjustment.submitted_by == submitted_by)

    # Order newest-first before limiting, otherwise the 100-row cap returns an
    # arbitrary subset and the UI's recent/duplicate checks operate on noise.
    adjustments = query.order_by(InventoryAdjustment.created_at.desc()).offset(skip).limit(limit).all()
    return adjustments

@router.post("/adjustments", response_model=InventoryAdjustmentSchema)
def create_adjustment(
    adjustment_data: InventoryAdjustmentCreate,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Create a new inventory adjustment"""
    adjustment_dict = adjustment_data.dict()
    # The unit is derived server-side (from the pallets/receipt); ignore any
    # client-supplied unit so it can't disagree with the inventory it touches.
    adjustment_dict.pop("unit", None)

    # Only deduction types actually change inventory on approval. Reject anything
    # else here rather than approving a silent no-op the user thinks corrected stock.
    if adjustment_data.adjustment_type not in adjustment_service.DEDUCTION_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported adjustment type '{adjustment_data.adjustment_type}'.",
        )

    if adjustment_data.pallet_licence_ids:
        # Pallet-based adjustment (Finished Goods) — always measured in cases.
        pallets = db.query(PalletLicence).filter(
            PalletLicence.id.in_(adjustment_data.pallet_licence_ids)
        ).all()
        if len(pallets) != len(adjustment_data.pallet_licence_ids):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="One or more pallets not found")
        adjustment_dict['quantity'] = sum(p.cases or 0 for p in pallets)
        resolved_unit = "cases"
    else:
        # Lot-based adjustment (RM / Packaging)
        receipt = db.query(Receipt).filter(Receipt.id == adjustment_data.receipt_id).first()
        if not receipt:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Receipt not found")
        # The product is the receipt's. A mismatched product_id was accepted and
        # then shown under the receipt's name (2026-10-01 PART 3, B6).
        if adjustment_data.product_id and adjustment_data.product_id != receipt.product_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="The product does not match this lot's receipt.",
            )
        adjustment_dict["product_id"] = receipt.product_id
        # Stated in containers: price exactly what will leave each rack (its
        # deliveries' weights) plus any partial, so the worker, the approver
        # and the books see the same pounds (PART 3, B4/B5).
        if adjustment_data.source_breakdown and lps.is_counted_lot(db, receipt.material_lot_id):
            priced, total = transfer_service.price_counted_breakdown(
                db, receipt, adjustment_data.source_breakdown, allow_partial=True,
            )
            if total is not None:
                adjustment_data.source_breakdown = priced
                adjustment_data.quantity = total
                adjustment_dict["source_breakdown"] = priced
                adjustment_dict["quantity"] = total
            transfer_service.check_source_racks(db, receipt, adjustment_data.source_breakdown)
        if adjustment_data.quantity <= 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Quantity must be greater than zero")
        # A held lot refuses the write-off at SUBMIT time — the approve-time
        # check already existed, but the person who can fix the form is here,
        # not at the approval queue days later (2026-09-29 audit, GAP 6).
        if adjustment_service._hold_blocks_deduction(db, receipt):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Lot {receipt.lot_number or receipt.id} is on hold. "
                    "Release the hold before writing any of it off."
                ),
            )
        # Cap at LOT scope, not this one receipt: a lot received on two trucks
        # is two receipts and the form routes everything to the one carrying
        # the projection — its own quantity refuses write-offs the lot covers
        # (2026-09-29). Approval spills the deduction across siblings.
        # Net of pending transfers: those drums are spoken for, and the hold
        # gate above no longer treats a transfer's review lock as a hold.
        pool = transfer_service.lot_scoped_availability(db, receipt)
        cap = pool["available"]
        if adjustment_data.quantity > cap + 1e-6:
            q = lambda v: transfer_service.describe_qty(receipt, v)  # noqa: E731
            detail = (
                f"Adjustment quantity {q(adjustment_data.quantity)} exceeds "
                f"lot {pool['lot_label']}'s available {q(max(0.0, cap))}"
            )
            if pool["reserved"] > 0:
                detail += f" — {q(pool['reserved'])} is promised to other pending requests"
            if pool.get("staged", 0) > 0:
                detail += f" — {q(pool['staged'])} is out in staging"
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=detail,
            )
        # When the operator picks specific source rows, their quantities must
        # add up to the adjustment quantity — otherwise the deduction and the
        # per-row breakdown disagree and row availability drifts.
        if adjustment_data.source_breakdown:
            bd_sum = sum(
                float((e or {}).get("quantity", 0) or 0) for e in adjustment_data.source_breakdown
            )
            if abs(bd_sum - float(adjustment_data.quantity or 0)) > 0.01:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Source breakdown quantities must sum to the adjustment quantity"
                )
        resolved_unit = receipt.unit

    db_adjustment = InventoryAdjustment(
        id=f"adj-{uuid.uuid4().hex[:12]}",
        **adjustment_dict,
        unit=resolved_unit,
        submitted_by=str(current_user.id),
        warehouse_id=resolve_warehouse_for_write(current_user),
        status=AdjustmentStatus.PENDING
    )

    db.add(db_adjustment)
    db.commit()
    db.refresh(db_adjustment)
    return db_adjustment

@router.put("/adjustments/{adjustment_id}", response_model=InventoryAdjustmentSchema)
def update_adjustment(
    adjustment_id: str,
    adjustment_update: InventoryAdjustmentUpdate,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Update an inventory adjustment"""
    adjustment = db.query(InventoryAdjustment).filter(InventoryAdjustment.id == adjustment_id).first()
    if not adjustment:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Adjustment not found"
        )

    # Check permissions
    if current_user.role == ROLE_WAREHOUSE and adjustment.submitted_by != str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only edit your own adjustments"
        )

    # Only pending records may be edited — an approved/rejected adjustment is
    # final, and editing it would desync the inventory it already mutated.
    if adjustment.status != AdjustmentStatus.PENDING:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only pending adjustments can be edited"
        )

    update_data = adjustment_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(adjustment, field, value)

    db.commit()
    db.refresh(adjustment)
    return adjustment

@router.post("/adjustments/{adjustment_id}/approve")
def approve_adjustment(
    adjustment_id: str,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Approve an inventory adjustment

    - Admin/supervisor can approve anything
    - Warehouse worker can approve adjustments submitted by OTHER users (not their own)
    """
    adjustment = db.query(InventoryAdjustment).filter(InventoryAdjustment.id == adjustment_id).first()
    if not adjustment:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Adjustment not found"
        )

    require_approval_access(current_user, adjustment)
    adjustment_service.approve_adjustment(db, adjustment, current_user)
    db.commit()
    db.refresh(adjustment)

    return {"message": "Adjustment approved successfully", "adjustment": adjustment}

@router.post("/adjustments/{adjustment_id}/reject")
def reject_adjustment(
    adjustment_id: str,
    reason: str,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Reject an inventory adjustment

    - Admin/supervisor can reject anything
    - Warehouse worker can reject adjustments submitted by OTHER users (not their own)
    """
    adjustment = db.query(InventoryAdjustment).filter(InventoryAdjustment.id == adjustment_id).first()
    if not adjustment:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Adjustment not found"
        )

    require_approval_access(current_user, adjustment)
    adjustment_service.reject_adjustment(db, adjustment, reason, current_user)
    db.commit()
    db.refresh(adjustment)

    return {"message": "Adjustment rejected successfully", "adjustment": adjustment}
