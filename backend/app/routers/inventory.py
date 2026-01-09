from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import func, and_
from datetime import datetime
import json
import uuid

from app.database import get_db
from app.models import (
    Receipt, InventoryTransfer, InventoryAdjustment, InventoryHoldAction,
    StorageArea, StorageRow, Location, SubLocation, User, Category, CycleCount
)
from app.schemas import (
    InventoryTransfer as InventoryTransferSchema, InventoryTransferCreate, InventoryTransferUpdate,
    InventoryAdjustment as InventoryAdjustmentSchema, InventoryAdjustmentCreate, InventoryAdjustmentUpdate,
    InventoryHoldAction as InventoryHoldActionSchema, InventoryHoldActionCreate, InventoryHoldActionUpdate,
    CycleCount as CycleCountSchema, CycleCountCreate
)
from app.utils.auth import get_current_active_user, require_role

router = APIRouter()

# Inventory Transfer endpoints
@router.get("/transfers", response_model=List[InventoryTransferSchema])
async def get_transfers(
    skip: int = 0,
    limit: int = 100,
    status: str = None,
    requested_by: str = None,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get all inventory transfers"""
    query = db.query(InventoryTransfer)
    
    if status:
        query = query.filter(InventoryTransfer.status == status)
    if requested_by:
        query = query.filter(InventoryTransfer.requested_by == requested_by)
    
    transfers = query.offset(skip).limit(limit).all()
    return transfers

@router.post("/transfers", response_model=InventoryTransferSchema)
async def create_transfer(
    transfer_data: InventoryTransferCreate,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Create a new inventory transfer"""
    # Validate receipt exists
    receipt = db.query(Receipt).filter(Receipt.id == transfer_data.receipt_id).first()
    if not receipt:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Receipt not found"
        )
    
    # Validate quantity
    if transfer_data.quantity <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Quantity must be greater than zero"
        )
    
    if transfer_data.quantity > receipt.quantity:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Transfer quantity cannot exceed available quantity"
        )
    
    # Validate order number for shipped-out transfers
    if transfer_data.transfer_type == "shipped-out" and not transfer_data.order_number:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Order number is required for shipped-out transfers"
        )
    
    import uuid
    transfer_dict = transfer_data.dict()
    transfer_id = f"transfer-{int(datetime.utcnow().timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
    
    db_transfer = InventoryTransfer(
        id=transfer_id,
        **transfer_dict,
        requested_by=str(current_user.id),
        status="pending"
    )
    
    # Set receipt on hold when transfer is pending (shows as "on hold" during review)
    receipt.hold = True
    
    db.add(db_transfer)
    db.commit()
    db.refresh(db_transfer)
    return db_transfer

@router.put("/transfers/{transfer_id}", response_model=InventoryTransferSchema)
async def update_transfer(
    transfer_id: str,
    transfer_update: InventoryTransferUpdate,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Update an inventory transfer"""
    transfer = db.query(InventoryTransfer).filter(InventoryTransfer.id == transfer_id).first()
    if not transfer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Transfer not found"
        )
    
    # Check permissions
    if current_user.role == "warehouse" and transfer.requested_by != str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only edit your own transfers"
        )
    
    update_data = transfer_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(transfer, field, value)
    
    db.commit()
    db.refresh(transfer)
    return transfer

@router.post("/transfers/{transfer_id}/approve")
async def approve_transfer(
    transfer_id: str,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Approve an inventory transfer
    
    - Admin/supervisor can approve anything
    - Warehouse worker can approve transfers submitted by OTHER users (not their own)
    """
    transfer = db.query(InventoryTransfer).filter(InventoryTransfer.id == transfer_id).first()
    if not transfer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Transfer not found"
        )
    
    if transfer.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Transfer is not in pending status"
        )
    
    # Check permissions: warehouse workers cannot approve their own transfers
    if current_user.role == "warehouse" and transfer.requested_by == str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You cannot approve your own transfers. Only other users' transfers can be approved."
        )
    
    receipt = db.query(Receipt).filter(Receipt.id == transfer.receipt_id).first()
    if not receipt:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Receipt not found"
        )
    
    # Check if this is a finished goods receipt
    category = db.query(Category).filter(Category.id == receipt.category_id).first()
    is_finished_goods = category and (category.parent_id == 'group-finished' or category.type == 'finished')
    
    # For finished goods, subtract from storage row occupancy
    if is_finished_goods and receipt.allocation:
        if isinstance(receipt.allocation, str):
            allocation_data = json.loads(receipt.allocation)
        else:
            allocation_data = receipt.allocation
        
        if allocation_data.get("success") and allocation_data.get("plan"):
            plan = allocation_data["plan"]
            transfer_quantity = float(transfer.quantity)
            
            # Use source_breakdown if available (more accurate), otherwise use proportional distribution
            if transfer.source_breakdown and isinstance(transfer.source_breakdown, list):
                # source_breakdown format: [{ id: "row-{rowId}", quantity: cases }]
                for source in transfer.source_breakdown:
                    source_id = source.get("id", "")
                    cases_to_subtract = float(source.get("quantity", 0))
                    
                    # Extract rowId from "row-{rowId}" format
                    if source_id.startswith("row-"):
                        row_id = source_id.replace("row-", "")
                        # Find the allocation item for this row to get pallet info
                        alloc_item = next((item for item in plan if item.get("rowId") == row_id), None)
                        if alloc_item:
                            row_cases = float(alloc_item.get("cases", 0))
                            row_pallets = float(alloc_item.get("pallets", 0))
                            cases_per_pallet = row_cases / row_pallets if row_pallets > 0 else 1
                            pallets_to_subtract = cases_to_subtract / cases_per_pallet if cases_per_pallet > 0 else 0
                            
                            storage_row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
                            if storage_row:
                                storage_row.occupied_cases = max(0, (storage_row.occupied_cases or 0) - cases_to_subtract)
                                storage_row.occupied_pallets = max(0, (storage_row.occupied_pallets or 0) - pallets_to_subtract)
                                if storage_row.occupied_pallets <= 0:
                                    storage_row.product_id = None
                    elif source_id == "floor":
                        # Floor staging - no storage row to update
                        pass
            else:
                # Fallback: Calculate how much to subtract from each row proportionally
                total_cases = sum(float(item.get("cases", 0)) for item in plan)
                if total_cases > 0:
                    for item in plan:
                        row_id = item.get("rowId")
                        row_cases = float(item.get("cases", 0))
                        row_pallets = float(item.get("pallets", 0))
                        
                        if row_id and row_cases > 0:
                            # Calculate proportion of cases to subtract from this row
                            proportion = row_cases / total_cases
                            cases_to_subtract = transfer_quantity * proportion
                            # Calculate pallets to subtract based on cases per pallet from allocation
                            cases_per_pallet = row_cases / row_pallets if row_pallets > 0 else 1
                            pallets_to_subtract = cases_to_subtract / cases_per_pallet if cases_per_pallet > 0 else 0
                            
                            storage_row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
                            if storage_row:
                                # Subtract from occupancy
                                storage_row.occupied_cases = max(0, (storage_row.occupied_cases or 0) - cases_to_subtract)
                                storage_row.occupied_pallets = max(0, (storage_row.occupied_pallets or 0) - pallets_to_subtract)
                                # Clear product_id if occupancy is now zero
                                if storage_row.occupied_pallets <= 0:
                                    storage_row.product_id = None
    
    # Update receipt quantity based on transfer type
    if transfer.transfer_type == "shipped-out":
        # For shipped-out, reduce quantity
        receipt.quantity = max(0, receipt.quantity - transfer.quantity)
    else:
        # For warehouse transfer (internal), update allocation data
        # Don't reduce quantity - just move cases between locations
        if transfer.to_location_id:
            receipt.location_id = transfer.to_location_id
        if transfer.to_sub_location_id:
            receipt.sub_location_id = transfer.to_sub_location_id
        
        # Update allocation JSON for finished goods transfers
        if receipt.allocation and transfer.source_breakdown and transfer.destination_breakdown:
            try:
                if isinstance(receipt.allocation, str):
                    allocation_data = json.loads(receipt.allocation)
                else:
                    allocation_data = receipt.allocation
                
                if allocation_data.get("success") and allocation_data.get("plan"):
                    import copy
                    allocation_data = copy.deepcopy(allocation_data)
                    plan = allocation_data["plan"]
                    
                    # Determine cases per pallet
                    cases_per_pallet = 40  # Default fallback
                    if receipt.cases_per_pallet and receipt.cases_per_pallet > 0:
                        cases_per_pallet = receipt.cases_per_pallet
                    
                    # Subtract from source rows
                    for source in transfer.source_breakdown:
                        source_id = source.get("id", "")
                        cases_to_subtract = float(source.get("quantity", 0))
                        
                        if source_id.startswith("row-"):
                            row_id = source_id.removeprefix("row-")
                            for item in plan:
                                if item.get("rowId") == row_id:
                                    item["cases"] = max(0, float(item.get("cases", 0)) - cases_to_subtract)
                                    # Recalculate pallets
                                    item["pallets"] = max(0, int(item["cases"] / cases_per_pallet) + (1 if item["cases"] % cases_per_pallet > 0 else 0))
                    
                    # Add to destination rows
                    for dest in transfer.destination_breakdown:
                        dest_id = dest.get("id", "")
                        cases_to_add = float(dest.get("quantity", 0))
                        
                        if dest_id.startswith("row-"):
                            row_id = dest_id.removeprefix("row-")
                            # Find existing row or add new
                            existing_row = next((item for item in plan if item.get("rowId") == row_id), None)
                            if existing_row:
                                existing_row["cases"] = float(existing_row.get("cases", 0)) + cases_to_add
                                existing_row["pallets"] = max(1, int(existing_row["cases"] / cases_per_pallet) + (1 if existing_row["cases"] % cases_per_pallet > 0 else 0))
                            else:
                                # Add new row to plan - get row info from database
                                storage_row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
                                if storage_row:
                                    storage_area = db.query(StorageArea).filter(StorageArea.id == storage_row.storage_area_id).first()
                                    cases_per_pallet = 40
                                    plan.append({
                                        "areaId": storage_row.storage_area_id,
                                        "rowId": row_id,
                                        "areaName": storage_area.name if storage_area else "FG",
                                        "rowName": storage_row.name,
                                        "pallets": max(1, int(cases_to_add / cases_per_pallet) + (1 if cases_to_add % cases_per_pallet > 0 else 0)),
                                        "cases": cases_to_add
                                    })
                    
                    # Remove rows with 0 cases
                    allocation_data["plan"] = [item for item in plan if item.get("cases", 0) > 0]
                    
                    # Recalculate totals
                    allocation_data["totalCases"] = sum(float(item.get("cases", 0)) for item in allocation_data["plan"])
                    allocation_data["totalPallets"] = sum(int(item.get("pallets", 0)) for item in allocation_data["plan"])
                    
                    receipt.allocation = allocation_data
            except Exception as e:
                print(f"Error updating allocation: {e}")
                # Don't fail the transfer if allocation update fails
    
    # Clear hold status when transfer is approved (only if no held quantity)
    if not receipt.held_quantity or receipt.held_quantity <= 0:
        receipt.hold = False
    
    # Mark receipt as depleted if quantity reaches 0
    if receipt.quantity <= 0:
        receipt.status = "depleted"
    
    transfer.status = "approved"
    transfer.approved_by = str(current_user.id)
    transfer.approved_at = datetime.utcnow()
    
    db.commit()
    db.refresh(transfer)
    
    return {"message": "Transfer approved successfully", "transfer": transfer}

@router.post("/transfers/{transfer_id}/reject")
async def reject_transfer(
    transfer_id: str,
    reason: str,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Reject an inventory transfer
    
    - Admin/supervisor can reject anything
    - Warehouse worker can reject transfers submitted by OTHER users (not their own)
    """
    transfer = db.query(InventoryTransfer).filter(InventoryTransfer.id == transfer_id).first()
    if not transfer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Transfer not found"
        )
    
    if transfer.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Transfer is not in pending status"
        )
    
    # Check permissions: warehouse workers cannot reject their own transfers
    if current_user.role == "warehouse" and transfer.requested_by == str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You cannot reject your own transfers. Only other users' transfers can be rejected."
        )
    
    receipt = db.query(Receipt).filter(Receipt.id == transfer.receipt_id).first()
    if receipt:
        # Clear hold status when transfer is rejected
        receipt.hold = False
    
    transfer.status = "rejected"
    transfer.reason = f"{transfer.reason or ''}\n[Rejected by {current_user.name}]: {reason}".strip()
    
    db.commit()
    db.refresh(transfer)
    
    return {"message": "Transfer rejected successfully", "transfer": transfer}

# Inventory Adjustment endpoints
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
    # Validate receipt exists
    receipt = db.query(Receipt).filter(Receipt.id == adjustment_data.receipt_id).first()
    if not receipt:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Receipt not found"
        )
    
    # Validate quantity
    if adjustment_data.quantity <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Quantity must be greater than zero"
        )
    
    if adjustment_data.quantity > receipt.quantity:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Adjustment quantity cannot exceed available quantity"
        )
    
    adjustment_dict = adjustment_data.dict()
    db_adjustment = InventoryAdjustment(
        id=f"adj-{uuid.uuid4().hex[:12]}",
        **adjustment_dict,
        submitted_by=str(current_user.id),
        status="pending"
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
    if current_user.role == "warehouse" and adjustment.submitted_by != str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only edit your own adjustments"
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
    
    if adjustment.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Adjustment is not in pending status"
        )
    
    # Check permissions: warehouse workers cannot approve their own adjustments
    if current_user.role == "warehouse" and adjustment.submitted_by == str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You cannot approve your own adjustments. Only other users' adjustments can be approved."
        )
    
    adjustment.status = "approved"
    adjustment.approved_by = str(current_user.id)
    adjustment.approved_at = datetime.utcnow()
    
    # Update the receipt quantity based on adjustment type
    receipt = db.query(Receipt).filter(Receipt.id == adjustment.receipt_id).first()
    if receipt:
        # Store original quantity for audit trail
        adjustment.original_quantity = receipt.quantity
        
        if adjustment.adjustment_type in ["stock-correction", "damage-reduction", "donation", "trash-disposal", "quality-rejection"]:
            receipt.quantity = max(0, receipt.quantity - adjustment.quantity)
        
        # Store new quantity for audit trail
        adjustment.new_quantity = receipt.quantity
        
        # Mark receipt as depleted if quantity reaches 0
        if receipt.quantity <= 0:
            receipt.status = "depleted"
    
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
    
    if adjustment.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Adjustment is not in pending status"
        )
    
    # Check permissions: warehouse workers cannot reject their own adjustments
    if current_user.role == "warehouse" and adjustment.submitted_by == str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You cannot reject your own adjustments. Only other users' adjustments can be rejected."
        )
    
    adjustment.status = "rejected"
    adjustment.reason = f"{adjustment.reason}\n[Rejected by {current_user.name}]: {reason}"
    
    db.commit()
    db.refresh(adjustment)
    
    return {"message": "Adjustment rejected successfully", "adjustment": adjustment}

# Inventory Hold Action endpoints
@router.get("/hold-actions", response_model=List[InventoryHoldActionSchema])
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
    
    if status:
        query = query.filter(InventoryHoldAction.status == status)
    if receipt_id:
        query = query.filter(InventoryHoldAction.receipt_id == receipt_id)
    if submitted_by:
        query = query.filter(InventoryHoldAction.submitted_by == submitted_by)
    
    hold_actions = query.offset(skip).limit(limit).all()
    return hold_actions

@router.post("/hold-actions", response_model=InventoryHoldActionSchema)
async def create_hold_action(
    hold_action_data: InventoryHoldActionCreate,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Create a new inventory hold action - supports both full-lot and partial holds"""
    
    # Validate action
    if hold_action_data.action not in ["hold", "release"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Action must be 'hold' or 'release'"
        )
    
    # Determine if this is a partial hold (by location) or full-lot hold
    if hold_action_data.hold_items and len(hold_action_data.hold_items) > 0:
        # Partial hold mode - validate all receipt IDs exist
        receipt_ids = set(item.receipt_id for item in hold_action_data.hold_items)
        for receipt_id in receipt_ids:
            receipt = db.query(Receipt).filter(Receipt.id == receipt_id).first()
            if not receipt:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Receipt {receipt_id} not found"
                )
        
        # Use first receipt_id for backward compatibility in the main field
        first_receipt_id = hold_action_data.hold_items[0].receipt_id
        
        hold_action_dict = {
            "receipt_id": first_receipt_id,
            "action": hold_action_data.action,
            "reason": hold_action_data.reason,
            "hold_items": [item.dict() for item in hold_action_data.hold_items],
            "total_quantity": hold_action_data.total_quantity
        }
    else:
        # Legacy full-lot hold mode - require receipt_id
        if not hold_action_data.receipt_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Either receipt_id or hold_items must be provided"
            )
        
        receipt = db.query(Receipt).filter(Receipt.id == hold_action_data.receipt_id).first()
        if not receipt:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Receipt not found"
            )
        
        # Validate: can't release if not on hold, can't hold if already on hold
        if hold_action_data.action == "release" and not receipt.hold:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot release a lot that is not on hold"
            )
        
        if hold_action_data.action == "hold" and receipt.hold:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Lot is already on hold"
            )
        
        hold_action_dict = hold_action_data.dict()
    
    db_hold_action = InventoryHoldAction(
        id=f"hold-{uuid.uuid4().hex[:12]}",
        **hold_action_dict,
        submitted_by=str(current_user.id),
        status="pending"
    )
    
    db.add(db_hold_action)
    db.commit()
    db.refresh(db_hold_action)    
    return db_hold_action

# ===========================
# Cycle Count Routes
# ===========================

@router.post("/cycle-counts", response_model=CycleCountSchema)
async def create_cycle_count(
    cycle_count_data: CycleCountCreate,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Create a new cycle count"""
    cycle_count_dict = cycle_count_data.dict()
    
    db_cycle_count = CycleCount(
        id=f"cycle-{uuid.uuid4().hex[:12]}",
        **cycle_count_dict
    )
    
    db.add(db_cycle_count)
    db.commit()
    db.refresh(db_cycle_count)
    
    return db_cycle_count

@router.get("/cycle-counts", response_model=List[CycleCountSchema])
async def get_cycle_counts(
    location_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get all cycle counts, optionally filtered by location"""
    query = db.query(CycleCount)
    
    if location_id:
        query = query.filter(CycleCount.location_id == location_id)
    
    cycle_counts = query.order_by(CycleCount.count_date.desc()).all()
    return cycle_counts

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
    if current_user.role == "warehouse" and hold_action.submitted_by != str(current_user.id):
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
    
    if hold_action.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Hold action is not in pending status"
        )
    
    # Check permissions: warehouse workers cannot approve their own hold actions
    if current_user.role == "warehouse" and hold_action.submitted_by == str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You cannot approve your own hold actions. Only other users' hold actions can be approved."
        )
    
    receipt = db.query(Receipt).filter(Receipt.id == hold_action.receipt_id).first()
    if not receipt:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Receipt not found"
        )
    
    # Update receipt hold status and quantity
    if hold_action.action == "hold":
        receipt.hold = True
        # If partial hold, use the specific quantity
        if hold_action.total_quantity and hold_action.total_quantity > 0:
            receipt.held_quantity = hold_action.total_quantity
        else:
            # Full lot hold - assume entire current quantity if not specified
            receipt.held_quantity = receipt.quantity
        
        # Extract hold location name from hold_items
        if hold_action.hold_items and len(hold_action.hold_items) > 0:
            location_names = []
            for item in hold_action.hold_items:
                location_id = item.get("location_id", "")
                # Extract row ID from location_id (format: rcpt-xxx-row-{rowId})
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
    
    hold_action.status = "approved"
    hold_action.approved_by = str(current_user.id)
    hold_action.approved_at = datetime.utcnow()
    
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
    
    if hold_action.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Hold action is not in pending status"
        )
    
    # Check permissions: warehouse workers cannot reject their own hold actions
    if current_user.role == "warehouse" and hold_action.submitted_by == str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You cannot reject your own hold actions. Only other users' hold actions can be rejected."
        )
    
    hold_action.status = "rejected"
    hold_action.reason = f"{hold_action.reason}\n[Rejected by {current_user.name}]: {reason}".strip()
    
    db.commit()
    db.refresh(hold_action)
    
    return {"message": "Hold action rejected successfully", "hold_action": hold_action}

# Inventory Overview endpoints
@router.get("/overview")
async def get_inventory_overview(
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get inventory overview with metrics"""
    # Get total receipts count
    total_receipts = db.query(Receipt).count()
    
    # Get receipts by status
    receipts_by_status = db.query(
        Receipt.status, func.count(Receipt.id)
    ).group_by(Receipt.status).all()
    
    # Get pending approvals count
    pending_approvals = db.query(Receipt).filter(
        Receipt.status.in_(["recorded", "reviewed"])
    ).count()
    
    # Get pending transfers count
    pending_transfers = db.query(InventoryTransfer).filter(
        InventoryTransfer.status == "pending"
    ).count()
    
    # Get pending adjustments count
    pending_adjustments = db.query(InventoryAdjustment).filter(
        InventoryAdjustment.status == "pending"
    ).count()
    
    return {
        "total_receipts": total_receipts,
        "receipts_by_status": dict(receipts_by_status),
        "pending_approvals": pending_approvals,
        "pending_transfers": pending_transfers,
        "pending_adjustments": pending_adjustments
    }

@router.get("/capacity-summary")
async def get_capacity_summary(
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get storage capacity summary"""
    # Get storage areas with their allocations
    storage_areas = db.query(StorageArea).all()
    
    capacity_data = []
    total_capacity = 0
    total_occupied = 0
    
    for area in storage_areas:
        # Calculate occupied pallets from allocations
        occupied_pallets = db.query(func.sum(ReceiptAllocation.pallet_quantity)).filter(
            ReceiptAllocation.storage_area_id == area.id
        ).scalar() or 0
        
        available_pallets = area.pallet_capacity - occupied_pallets
        
        capacity_data.append({
            "id": area.id,
            "name": area.name,
            "total_capacity": area.pallet_capacity,
            "occupied_pallets": occupied_pallets,
            "available_pallets": available_pallets,
            "utilization_percentage": (occupied_pallets / area.pallet_capacity * 100) if area.pallet_capacity > 0 else 0
        })
        
        total_capacity += area.pallet_capacity
        total_occupied += occupied_pallets
    
    overall_utilization = (total_occupied / total_capacity * 100) if total_capacity > 0 else 0
    
    return {
        "storage_areas": capacity_data,
        "total_capacity": total_capacity,
        "total_occupied": total_occupied,
        "total_available": total_capacity - total_occupied,
        "overall_utilization": overall_utilization
    }
