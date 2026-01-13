from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from datetime import datetime
import json

from app.database import get_db
from app.models import Receipt, ReceiptAllocation, User, StorageRow
from app.schemas import (
    Receipt as ReceiptSchema, ReceiptCreate, ReceiptUpdate,
    ReceiptAllocation as ReceiptAllocationSchema
)
from app.utils.auth import get_current_active_user, require_role

router = APIRouter()

@router.get("/", response_model=List[ReceiptSchema])
async def get_receipts(
    skip: int = 0,
    limit: int = 100,
    status: str = None,
    product_id: str = None,
    submitted_by: str = None,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get all receipts"""
    query = db.query(Receipt)
    
    if status:
        query = query.filter(Receipt.status == status)
    if product_id:
        query = query.filter(Receipt.product_id == product_id)
    if submitted_by:
        query = query.filter(Receipt.submitted_by == submitted_by)
    
    receipts = query.offset(skip).limit(limit).all()
    return receipts

@router.get("/pending-approvals", response_model=List[ReceiptSchema])
async def get_pending_approvals(
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get receipts pending approval
    
    - Admin/supervisor can see all pending receipts
    - Warehouse worker can only see receipts submitted by OTHER users (not their own)
    """
    query = db.query(Receipt).filter(
        Receipt.status.in_(["recorded", "reviewed"])
    )
    
    # Warehouse workers can only see receipts submitted by others
    if current_user.role == "warehouse":
        query = query.filter(Receipt.submitted_by != str(current_user.id))
    
    receipts = query.all()
    return receipts

@router.post("/", response_model=ReceiptSchema)
async def create_receipt(
    receipt_data: ReceiptCreate,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Create a new receipt"""
    # Create receipt
    receipt_dict = receipt_data.dict(exclude_unset=True)
    allocations_data = receipt_dict.pop("allocations", [])
    
    # Generate ID if not provided
    if "id" not in receipt_dict or not receipt_dict["id"]:
        import uuid
        receipt_dict["id"] = f"rcpt-{uuid.uuid4().hex[:12]}"
    
    db_receipt = Receipt(
        **receipt_dict,
        submitted_by=str(current_user.id),
        status="recorded"
    )
    
    db.add(db_receipt)
    db.commit()
    db.refresh(db_receipt)
    
    # Create allocations
    for allocation_data in allocations_data:
        db_allocation = ReceiptAllocation(
            receipt_id=db_receipt.id,
            **allocation_data
        )
        db.add(db_allocation)
    
    # Update storage row occupancy for finished goods receipts when created
    # This reserves the capacity immediately to prevent double-booking
    if db_receipt.allocation:
        if isinstance(db_receipt.allocation, str):
            allocation_data = json.loads(db_receipt.allocation)
        else:
            allocation_data = db_receipt.allocation
        
        if allocation_data.get("success") and allocation_data.get("plan"):
            plan = allocation_data["plan"]
            for item in plan:
                row_id = item.get("rowId")
                pallets = float(item.get("pallets", 0))
                cases = float(item.get("cases", 0))
                
                if row_id and pallets > 0:
                    storage_row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
                    if storage_row:
                        # Add to existing occupancy (reserve capacity)
                        storage_row.occupied_pallets = (storage_row.occupied_pallets or 0) + pallets
                        storage_row.occupied_cases = (storage_row.occupied_cases or 0) + cases
                        # Set product_id if not already set
                        if not storage_row.product_id:
                            storage_row.product_id = db_receipt.product_id
    
    # Update storage row occupancy for raw materials and packaging receipts
    # Handle multiple row allocations if provided, otherwise use single row
    raw_material_allocations = receipt_dict.get("rawMaterialRowAllocations")
    
    if raw_material_allocations and isinstance(raw_material_allocations, list):
        # Multiple row allocations
        for alloc in raw_material_allocations:
            row_id = alloc.get("rowId")
            pallets_to_add = float(alloc.get("pallets", 0))
            
            if row_id and pallets_to_add > 0:
                storage_row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
                if storage_row:
                    # Check capacity
                    current_occupied = storage_row.occupied_pallets or 0
                    capacity = storage_row.pallet_capacity or 0
                    if capacity > 0 and (current_occupied + pallets_to_add) > capacity:
                        raise HTTPException(
                            status_code=status.HTTP_400_BAD_REQUEST,
                            detail=f"Adding {pallets_to_add} pallets to row {storage_row.name} would exceed capacity ({capacity}). Currently occupied: {current_occupied}"
                        )
                    
                    # Add to existing occupancy (reserve capacity)
                    storage_row.occupied_pallets = current_occupied + pallets_to_add
                    # Set product_id if not already set
                    if not storage_row.product_id:
                        storage_row.product_id = db_receipt.product_id
    elif db_receipt.storage_row_id:
        # Single row allocation (backward compatibility)
        pallets_to_add = receipt_dict.get("pallets")
        if pallets_to_add is not None:
            pallets_to_add = float(pallets_to_add)
            if pallets_to_add > 0:
                storage_row = db.query(StorageRow).filter(StorageRow.id == db_receipt.storage_row_id).first()
                if storage_row:
                    # Check capacity
                    current_occupied = storage_row.occupied_pallets or 0
                    capacity = storage_row.pallet_capacity or 0
                    if capacity > 0 and (current_occupied + pallets_to_add) > capacity:
                        raise HTTPException(
                            status_code=status.HTTP_400_BAD_REQUEST,
                            detail=f"Adding {pallets_to_add} pallets would exceed row capacity ({capacity}). Currently occupied: {current_occupied}"
                        )
                    
                    # Add to existing occupancy (reserve capacity)
                    storage_row.occupied_pallets = current_occupied + pallets_to_add
                    # Set product_id if not already set
                    if not storage_row.product_id:
                        storage_row.product_id = db_receipt.product_id
    
    db.commit()
    db.refresh(db_receipt)
    return db_receipt

@router.get("/{receipt_id}", response_model=ReceiptSchema)
async def get_receipt(
    receipt_id: str,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get a specific receipt"""
    receipt = db.query(Receipt).filter(Receipt.id == receipt_id).first()
    if not receipt:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Receipt not found"
        )
    return receipt

@router.put("/{receipt_id}", response_model=ReceiptSchema)
async def update_receipt(
    receipt_id: str,
    receipt_update: ReceiptUpdate,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Update a receipt"""
    receipt = db.query(Receipt).filter(Receipt.id == receipt_id).first()
    if not receipt:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Receipt not found"
        )
    
    # Check permissions
    if current_user.role == "warehouse" and receipt.submitted_by != str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only edit your own receipts"
        )
    
    update_data = receipt_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(receipt, field, value)
    
    db.commit()
    db.refresh(receipt)
    return receipt

@router.post("/{receipt_id}/approve")
async def approve_receipt(
    receipt_id: str,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Approve a receipt
    
    - Admin/supervisor can approve anything
    - Warehouse worker can approve receipts submitted by OTHER users (not their own)
    """
    receipt = db.query(Receipt).filter(Receipt.id == receipt_id).first()
    if not receipt:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Receipt not found"
        )
    
    if receipt.status not in ["recorded", "reviewed"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Receipt is not in a state that can be approved"
        )
    
    # Check permissions: warehouse workers cannot approve their own receipts
    if current_user.role == "warehouse" and receipt.submitted_by == str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You cannot approve your own receipts. Only other users' receipts can be approved."
        )
    
    # Check if receipt was already approved (to avoid double-counting)
    was_already_approved = receipt.status == "approved"
    
    receipt.status = "approved"
    receipt.approved_by = str(current_user.id)
    receipt.approved_at = datetime.utcnow()
    
    # Note: Storage rows are already updated when receipt is created (status: "recorded")
    # So we don't need to update again on approval - it's already reserved
    
    db.commit()
    db.refresh(receipt)
    
    return {"message": "Receipt approved successfully", "receipt": receipt}

@router.post("/{receipt_id}/reject")
async def reject_receipt(
    receipt_id: str,
    reason: str,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Reject a receipt
    
    - Admin/supervisor can reject anything
    - Warehouse worker can reject receipts submitted by OTHER users (not their own)
    """
    receipt = db.query(Receipt).filter(Receipt.id == receipt_id).first()
    if not receipt:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Receipt not found"
        )
    
    if receipt.status not in ["recorded", "reviewed"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Receipt is not in a state that can be rejected"
        )
    
    # Check permissions: warehouse workers cannot reject their own receipts
    if current_user.role == "warehouse" and receipt.submitted_by == str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You cannot reject your own receipts. Only other users' receipts can be rejected."
        )
    
    # Clear storage row occupancy for rejected receipts (free up reserved capacity)
    # Handle finished goods (allocation-based)
    if receipt.allocation:
        if isinstance(receipt.allocation, str):
            allocation_data = json.loads(receipt.allocation)
        else:
            allocation_data = receipt.allocation
        
        if allocation_data.get("success") and allocation_data.get("plan"):
            plan = allocation_data["plan"]
            for item in plan:
                row_id = item.get("rowId")
                pallets = float(item.get("pallets", 0))
                cases = float(item.get("cases", 0))
                
                if row_id and pallets > 0:
                    storage_row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
                    if storage_row:
                        # Subtract from occupancy (free up capacity)
                        storage_row.occupied_pallets = max(0, (storage_row.occupied_pallets or 0) - pallets)
                        storage_row.occupied_cases = max(0, (storage_row.occupied_cases or 0) - cases)
                        # Clear product_id if occupancy is now zero
                        if storage_row.occupied_pallets <= 0:
                            storage_row.product_id = None
    
    # Handle raw materials/packaging (direct pallet count)
    if receipt.storage_row_id and receipt.pallets:
        pallets_to_free = float(receipt.pallets)
        if pallets_to_free > 0:
            storage_row = db.query(StorageRow).filter(StorageRow.id == receipt.storage_row_id).first()
            if storage_row:
                # Subtract from occupancy (free up capacity)
                storage_row.occupied_pallets = max(0, (storage_row.occupied_pallets or 0) - pallets_to_free)
                # Clear product_id if occupancy is now zero
                if storage_row.occupied_pallets <= 0:
                    storage_row.product_id = None
    
    receipt.status = "rejected"
    receipt.note = f"{receipt.note or ''}\n[Rejected by {current_user.name}]: {reason}".strip()
    
    db.commit()
    db.refresh(receipt)
    
    return {"message": "Receipt rejected successfully", "receipt": receipt}

@router.post("/{receipt_id}/send-back")
async def send_back_receipt(
    receipt_id: str,
    reason: str,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Send back a receipt for correction
    
    - Only Admin/supervisor can send back receipts
    - Warehouse workers cannot send back (they can only approve/reject)
    """
    receipt = db.query(Receipt).filter(Receipt.id == receipt_id).first()
    if not receipt:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Receipt not found"
        )
    
    if receipt.status not in ["recorded", "reviewed"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Receipt is not in a state that can be sent back"
        )
    
    # Check permissions: only admin and supervisor can send back
    if current_user.role == "warehouse":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Warehouse workers cannot send back receipts. Only admins and supervisors can send back for correction."
        )
    
    # Clear storage row occupancy for sent-back receipts (free up reserved capacity for correction)
    # Handle finished goods (allocation-based)
    if receipt.allocation:
        if isinstance(receipt.allocation, str):
            allocation_data = json.loads(receipt.allocation)
        else:
            allocation_data = receipt.allocation
        
        if allocation_data.get("success") and allocation_data.get("plan"):
            plan = allocation_data["plan"]
            for item in plan:
                row_id = item.get("rowId")
                pallets = float(item.get("pallets", 0))
                cases = float(item.get("cases", 0))
                
                if row_id and pallets > 0:
                    storage_row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
                    if storage_row:
                        # Subtract from occupancy (free up capacity)
                        storage_row.occupied_pallets = max(0, (storage_row.occupied_pallets or 0) - pallets)
                        storage_row.occupied_cases = max(0, (storage_row.occupied_cases or 0) - cases)
                        # Clear product_id if occupancy is now zero
                        if storage_row.occupied_pallets <= 0:
                            storage_row.product_id = None
    
    # Handle raw materials/packaging (direct pallet count)
    if receipt.storage_row_id and receipt.pallets:
        pallets_to_free = float(receipt.pallets)
        if pallets_to_free > 0:
            storage_row = db.query(StorageRow).filter(StorageRow.id == receipt.storage_row_id).first()
            if storage_row:
                # Subtract from occupancy (free up capacity)
                storage_row.occupied_pallets = max(0, (storage_row.occupied_pallets or 0) - pallets_to_free)
                # Clear product_id if occupancy is now zero
                if storage_row.occupied_pallets <= 0:
                    storage_row.product_id = None
    
    receipt.status = "recorded"  # Back to recorded for warehouse worker to fix
    receipt.note = f"{receipt.note or ''}\n[Sent Back by {current_user.name}]: {reason}".strip()
    
    db.commit()
    db.refresh(receipt)
    
    return {"message": "Receipt sent back for correction", "receipt": receipt}

@router.get("/{receipt_id}/allocations", response_model=List[ReceiptAllocationSchema])
async def get_receipt_allocations(
    receipt_id: str,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get allocations for a specific receipt"""
    allocations = db.query(ReceiptAllocation).filter(
        ReceiptAllocation.receipt_id == receipt_id
    ).all()
    return allocations
