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
from app.services import adjustment_service
from app.constants import ROLE_WAREHOUSE

router = APIRouter()


@router.get("/adjustments", response_model=List[InventoryAdjustmentSchema])
async def get_adjustments(
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

    adjustments = query.offset(skip).limit(limit).all()
    return adjustments

@router.post("/adjustments", response_model=InventoryAdjustmentSchema)
async def create_adjustment(
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
        if adjustment_data.quantity <= 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Quantity must be greater than zero")
        if adjustment_data.quantity > receipt.quantity:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Adjustment quantity cannot exceed available quantity")
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
async def update_adjustment(
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
async def approve_adjustment(
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
async def reject_adjustment(
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
