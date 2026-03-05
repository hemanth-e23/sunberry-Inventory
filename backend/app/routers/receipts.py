from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from datetime import datetime
import json

import uuid
from app.database import get_db
from app.models import Receipt, ReceiptAllocation, User, StorageRow, PalletLicence, Product, Category
from app.schemas import (
    Receipt as ReceiptSchema, ReceiptCreate, ReceiptUpdate,
    ReceiptAllocation as ReceiptAllocationSchema
)
from app.utils.auth import get_current_active_user, require_role, warehouse_filter
from app.enums import ReceiptStatus, PalletStatus
from app.services import receipt_service
from app.constants import ROLE_WAREHOUSE, CATEGORY_FINISHED, DEFAULT_CASES_PER_PALLET

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

    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.filter(Receipt.warehouse_id == wh_id)

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
        Receipt.status.in_([ReceiptStatus.RECORDED, ReceiptStatus.REVIEWED])
    )

    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.filter(Receipt.warehouse_id == wh_id)

    # Warehouse workers can only see receipts submitted by others
    if current_user.role == ROLE_WAREHOUSE:
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
    raw_material_row_allocs = receipt_dict.pop("rawMaterialRowAllocations", None)
    
    # Generate ID if not provided
    if "id" not in receipt_dict or not receipt_dict["id"]:
        receipt_dict["id"] = f"rcpt-{uuid.uuid4().hex[:12]}"
    
    # ----------------------------------------------------------------
    # Auto-derive sub_location_id from storage_row when missing
    # (safety net: if frontend fails to send sub_location_id but
    #  does send storage_row_id, we can look up the parent)
    # ----------------------------------------------------------------
    if not receipt_dict.get("sub_location_id") and receipt_dict.get("storage_row_id"):
        row = db.query(StorageRow).filter(StorageRow.id == receipt_dict["storage_row_id"]).first()
        if row and row.sub_location_id:
            receipt_dict["sub_location_id"] = row.sub_location_id

    # ----------------------------------------------------------------
    # Auto-compute quantity as total weight when container + weight
    # info is provided (e.g. 40 barrels × 500 lbs = 20000 lbs)
    # ----------------------------------------------------------------
    container_count = receipt_dict.get("container_count")
    weight_per_container = receipt_dict.get("weight_per_container")
    weight_unit = receipt_dict.get("weight_unit")
    container_unit = receipt_dict.get("container_unit")

    if container_count and weight_per_container and weight_unit:
        total_weight = float(container_count) * float(weight_per_container)
        receipt_dict["quantity"] = round(total_weight, 3)
        receipt_dict["unit"] = weight_unit  # quantity is now in weight units for staging/availability
    elif container_count and container_unit and not weight_per_container:
        # Container count only (no weight info) — quantity stays as container count
        receipt_dict["quantity"] = float(container_count)
        receipt_dict["unit"] = container_unit
    
    db_receipt = Receipt(
        **receipt_dict,
        submitted_by=str(current_user.id),
        warehouse_id=current_user.warehouse_id,
        status=ReceiptStatus.RECORDED
    )
    
    db.add(db_receipt)
    db.commit()
    db.refresh(db_receipt)

    # Persist multi-row pallet allocations for raw materials/packaging so they
    # can be used later when approving ship-outs or marking staging as used
    if raw_material_row_allocs:
        db_receipt.raw_material_row_allocations = raw_material_row_allocs

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
    raw_material_allocations = raw_material_row_allocs
    
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
    
    # Generate pallet licences for finished goods receipts
    category = db.query(Category).filter(Category.id == db_receipt.category_id).first()
    is_finished_goods = category and category.type == CATEGORY_FINISHED
    if is_finished_goods and db_receipt.allocation and db_receipt.lot_number and db_receipt.product_id:
        alloc = db_receipt.allocation if isinstance(db_receipt.allocation, dict) else json.loads(db_receipt.allocation or "{}")
        plan = alloc.get("plan") or []
        product = db.query(Product).filter(Product.id == db_receipt.product_id).first()
        product_code = (product.short_code or product.fcc_code or product.name or "PRD")[:10].replace(" ", "").upper()
        seq = 1
        total_plan_pallets = sum(int(i.get("pallets", 0)) for i in plan)
        for item in plan:
            row_id = item.get("rowId")
            area_id = item.get("areaId")
            pallets = int(item.get("pallets", 0))
            item_cases = float(item.get("cases", 0))
            cases_per_pallet = (item_cases / pallets) if pallets > 0 else (db_receipt.cases_per_pallet or DEFAULT_CASES_PER_PALLET)
            for p in range(pallets):
                is_last = seq == total_plan_pallets
                is_partial = is_last and (db_receipt.partial_cases or 0) > 0
                cases = int(db_receipt.partial_cases) if is_partial else int(cases_per_pallet)
                lic_num = f"{db_receipt.lot_number}-{product_code}-{str(seq).zfill(3)}"
                pl = PalletLicence(
                    id=f"pl-{uuid.uuid4().hex[:12]}",
                    licence_number=lic_num,
                    receipt_id=db_receipt.id,
                    product_id=db_receipt.product_id,
                    lot_number=db_receipt.lot_number,
                    storage_area_id=area_id,
                    storage_row_id=row_id,
                    cases=cases,
                    is_partial=is_partial,
                    sequence=seq,
                    status=PalletStatus.PENDING,
                    warehouse_id=current_user.warehouse_id,
                )
                db.add(pl)
                seq += 1

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
    if current_user.role == ROLE_WAREHOUSE and receipt.submitted_by != str(current_user.id):
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
    
    receipt_service.approve_receipt(db, receipt, current_user)
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
    
    receipt_service.reject_receipt(db, receipt, reason, current_user)
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
    
    receipt_service.send_back_receipt(db, receipt, reason, current_user)
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
