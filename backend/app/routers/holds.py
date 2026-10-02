from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from datetime import datetime
import uuid

from app.database import get_db
from app.models import Receipt, InventoryHoldAction, StorageRow, PalletLicence, StorageArea
from app.schemas import (
    InventoryHoldAction as InventoryHoldActionSchema,
    InventoryHoldActionCreate,
    InventoryHoldActionUpdate,
)
from app.utils.auth import get_current_active_user, warehouse_filter, resolve_warehouse_for_write, require_approval_access
from app.enums import HoldStatus
from app.services import hold_service
from app.services import lot_status as lot_status_service
from app.constants import ROLE_WAREHOUSE

router = APIRouter()


def _lot_status_for(db: Session, receipt_id, cache: dict = None):
    """The LOT's current racks and held amount for a lot hold (B4/B5): the
    receipt's own held_quantity and location are a snapshot of one delivery
    and of the last transfer, not of the lot."""
    if not receipt_id:
        return None
    receipt = db.query(Receipt).filter(Receipt.id == receipt_id).first()
    if receipt is None:
        return None
    key = receipt.material_lot_id or receipt.id
    if cache is not None and key in cache:
        return cache[key]
    status_ = lot_status_service.lot_status(db, receipt)
    if cache is not None:
        cache[key] = status_
    return status_


def _hold_action_to_response(hold: InventoryHoldAction, db: Session, lot_cache: dict = None) -> dict:
    """Serialize a hold action, enriching pallet holds with licence + location details
    and lot holds with the lot's CURRENT racks and held amount (`lot_status`)."""
    data = {
        "id": hold.id,
        "receipt_id": hold.receipt_id,
        "action": hold.action,
        "reason": hold.reason,
        "hold_items": hold.hold_items,
        "total_quantity": hold.total_quantity,
        "pallet_licence_ids": hold.pallet_licence_ids,
        "status": hold.status,
        "submitted_by": hold.submitted_by,
        "approved_by": hold.approved_by,
        "approved_at": hold.approved_at,
        "submitted_at": hold.submitted_at,
        "created_at": hold.created_at,
        "pallet_licence_details": [],
        # What the action covered when it was approved (stamped at approval;
        # None for actions approved before 2026-10-01).
        "quantity_at_action": hold.total_quantity,
        "lot_status": None,
    }
    if hold.receipt_id and not hold.pallet_licence_ids:
        data["lot_status"] = _lot_status_for(db, hold.receipt_id, lot_cache)
    pl_ids = hold.pallet_licence_ids or []
    if pl_ids:
        pallets = db.query(PalletLicence).filter(PalletLicence.id.in_(pl_ids)).all()
        details = []
        for p in pallets:
            row_name = None
            area_name = None
            if p.storage_row_id:
                row = db.query(StorageRow).filter(StorageRow.id == p.storage_row_id).first()
                if row:
                    row_name = row.name
                    if row.storage_area_id:
                        area = db.query(StorageArea).filter(StorageArea.id == row.storage_area_id).first()
                        if area:
                            area_name = area.name
            location = f"{area_name} / {row_name}" if area_name and row_name else (row_name or "Floor")
            details.append({
                "id": p.id,
                "licence_number": p.licence_number or "",
                "cases": p.cases or 0,
                "lot_number": p.lot_number or "",
                "location": location,
                "is_held": p.is_held,
                "product_id": p.product_id or "",
            })
        data["pallet_licence_details"] = details
    return data


@router.get("/hold-actions")
def get_hold_actions(
    skip: int = 0,
    limit: int = 100,
    status: str = None,
    receipt_id: str = None,
    submitted_by: str = None,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get all inventory hold actions"""
    query = db.query(InventoryHoldAction)

    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.filter(InventoryHoldAction.warehouse_id == wh_id)

    if status:
        query = query.filter(InventoryHoldAction.status == status)
    if receipt_id:
        query = query.filter(InventoryHoldAction.receipt_id == receipt_id)
    if submitted_by:
        query = query.filter(InventoryHoldAction.submitted_by == submitted_by)

    # Order newest-first before limiting so the 100-row cap returns the most
    # recent holds, not an arbitrary subset.
    hold_actions = query.order_by(InventoryHoldAction.created_at.desc()).offset(skip).limit(limit).all()
    lot_cache: dict = {}
    return [_hold_action_to_response(h, db, lot_cache) for h in hold_actions]


@router.get("/hold-actions/held-lots")
def get_held_lots(
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Raw-material / packaging lots on QA hold NOW — one entry per lot, with
    its current racks and the lot-wide held amount (drums and weight)."""
    return lot_status_service.held_lots(db, warehouse_filter(current_user))


@router.get("/hold-actions/lot-status/{receipt_id}")
def get_lot_status(
    receipt_id: str,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """The lot's current racks, totals and hold, lot-wide, for the hold form."""
    receipt = db.query(Receipt).filter(Receipt.id == receipt_id).first()
    if not receipt:
        raise HTTPException(status_code=404, detail="Receipt not found")
    wh_id = warehouse_filter(current_user)
    if wh_id and receipt.warehouse_id and receipt.warehouse_id != wh_id:
        raise HTTPException(status_code=404, detail="Receipt not found")
    return lot_status_service.lot_status(db, receipt)

@router.post("/hold-actions", response_model=InventoryHoldActionSchema)
def create_hold_action(
    hold_action_data: InventoryHoldActionCreate,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Create a new inventory hold action - supports both full-lot and partial holds"""

    hold_action_dict = hold_service.validate_and_build_hold_dict(db, hold_action_data)

    db_hold_action = InventoryHoldAction(
        id=f"hold-{uuid.uuid4().hex[:12]}",
        **hold_action_dict,
        submitted_by=str(current_user.id),
        warehouse_id=resolve_warehouse_for_write(current_user),
        status=HoldStatus.PENDING
    )

    db.add(db_hold_action)
    db.commit()
    db.refresh(db_hold_action)
    return db_hold_action

@router.put("/hold-actions/{hold_action_id}", response_model=InventoryHoldActionSchema)
def update_hold_action(
    hold_action_id: str,
    hold_action_update: InventoryHoldActionUpdate,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Update an inventory hold action"""
    hold_action = db.query(InventoryHoldAction).filter(InventoryHoldAction.id == hold_action_id).first()
    if not hold_action:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Hold action not found"
        )

    # Check permissions
    if current_user.role == ROLE_WAREHOUSE and hold_action.submitted_by != str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only edit your own hold actions"
        )

    # Only pending records may be edited — an approved/rejected hold is final.
    if hold_action.status != HoldStatus.PENDING:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only pending hold actions can be edited"
        )

    update_data = hold_action_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(hold_action, field, value)

    db.commit()
    db.refresh(hold_action)
    return hold_action

@router.post("/hold-actions/{hold_action_id}/approve")
def approve_hold_action(
    hold_action_id: str,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Approve an inventory hold action

    - Admin/supervisor can approve anything
    - Warehouse worker can approve hold actions submitted by OTHER users (not their own)
    """
    hold_action = db.query(InventoryHoldAction).filter(InventoryHoldAction.id == hold_action_id).first()
    if not hold_action:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Hold action not found"
        )

    require_approval_access(current_user, hold_action)
    hold_service.approve_hold_action(db, hold_action, current_user)
    db.commit()
    db.refresh(hold_action)

    return {"message": "Hold action approved successfully", "hold_action": hold_action}

@router.post("/hold-actions/{hold_action_id}/reject")
def reject_hold_action(
    hold_action_id: str,
    reason: str,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Reject an inventory hold action

    - Admin/supervisor can reject anything
    - Warehouse worker can reject hold actions submitted by OTHER users (not their own)
    """
    hold_action = db.query(InventoryHoldAction).filter(InventoryHoldAction.id == hold_action_id).first()
    if not hold_action:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Hold action not found"
        )

    require_approval_access(current_user, hold_action)
    hold_service.reject_hold_action(db, hold_action, reason, current_user)
    db.commit()
    db.refresh(hold_action)

    return {"message": "Hold action rejected successfully", "hold_action": hold_action}
