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
from app.utils.auth import get_current_active_user, warehouse_filter, resolve_warehouse_for_write
from app.enums import HoldStatus
from app.services import hold_service
from app.constants import ROLE_WAREHOUSE

router = APIRouter()


def _hold_action_to_response(hold: InventoryHoldAction, db: Session) -> dict:
    """Serialize a hold action, enriching pallet holds with licence + location details."""
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
    }
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
async def get_hold_actions(
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

    hold_actions = query.offset(skip).limit(limit).all()
    return [_hold_action_to_response(h, db) for h in hold_actions]

@router.post("/hold-actions", response_model=InventoryHoldActionSchema)
async def create_hold_action(
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
async def update_hold_action(
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

    update_data = hold_action_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(hold_action, field, value)

    db.commit()
    db.refresh(hold_action)
    return hold_action

@router.post("/hold-actions/{hold_action_id}/approve")
async def approve_hold_action(
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

    hold_service.approve_hold_action(db, hold_action, current_user)
    db.commit()
    db.refresh(hold_action)

    return {"message": "Hold action approved successfully", "hold_action": hold_action}

@router.post("/hold-actions/{hold_action_id}/reject")
async def reject_hold_action(
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

    hold_service.reject_hold_action(db, hold_action, reason, current_user)
    db.commit()
    db.refresh(hold_action)

    return {"message": "Hold action rejected successfully", "hold_action": hold_action}
