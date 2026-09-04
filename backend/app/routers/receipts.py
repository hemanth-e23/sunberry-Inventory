from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from datetime import datetime
import json
import logging

import uuid
from app.database import get_db
from app.models import Receipt, ReceiptAllocation, User, StorageRow, PalletLicence, Product, Category
from app.schemas import (
    Receipt as ReceiptSchema, ReceiptCreate, ReceiptUpdate, ReceiptAssignStorage,
    ReceiptAllocation as ReceiptAllocationSchema
)
from app.utils.auth import get_current_active_user, require_role, warehouse_filter, resolve_warehouse_for_write, require_approval_access
from app.enums import ReceiptStatus, PalletStatus
from app.services import receipt_service
from app.constants import ROLE_WAREHOUSE, CATEGORY_FINISHED, DEFAULT_CASES_PER_PALLET

logger = logging.getLogger(__name__)

router = APIRouter()


def _warn_over_capacity(storage_row, current_occupied: float, pallets_to_add: float) -> None:
    """Note an over-full row. Does NOT refuse it.

    `pallet_capacity` is a planning hint, not a physical limit — rows routinely
    take more than their nominal figure and the warehouse is the authority on
    what fits. This used to raise HTTP 400, which turned the hint into a gate and
    made the counter's own drift self-sealing: nothing ever decremented
    `occupied_pallets`, so rows climbed past capacity (ROW 1 reached 501 against
    a capacity of 22) and then refused every further receipt, including the
    corrective ones. A row that has drifted must stay usable, because entering
    what is really on it is the only way to fix the number.
    """
    capacity = storage_row.pallet_capacity or 0
    if capacity > 0 and (current_occupied + pallets_to_add) > capacity:
        logger.warning(
            "Row %s over nominal capacity: %s occupied + %s incoming > %s",
            storage_row.name, current_occupied, pallets_to_add, capacity,
        )

@router.get("/", response_model=List[ReceiptSchema])
def get_receipts(
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
def get_pending_approvals(
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
def create_receipt(
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
    
    wh_id_for_write = resolve_warehouse_for_write(current_user)

    db_receipt = Receipt(
        **receipt_dict,
        submitted_by=str(current_user.id),
        warehouse_id=wh_id_for_write,
        status=ReceiptStatus.RECORDED
    )
    
    db.add(db_receipt)
    # flush (not commit) so the receipt id is assigned and the row is visible to
    # the rest of this function, but the WHOLE create — receipt + occupancy +
    # allocations + pallet licences — commits atomically below. Previously this
    # committed the bare receipt first, so a later IntegrityError rolled back only
    # the pallets and left an orphaned receipt that the client's retry duplicated.
    db.flush()

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
                    current_occupied = storage_row.occupied_pallets or 0
                    _warn_over_capacity(storage_row, current_occupied, pallets_to_add)
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
                    current_occupied = storage_row.occupied_pallets or 0
                    _warn_over_capacity(storage_row, current_occupied, pallets_to_add)
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
        total_plan_pallets = sum(int(i.get("pallets", 0)) for i in plan)

        # Continue the existing sequence for this (lot, product) instead of
        # restarting at 001. Real-world flow: pallets 001-020 already exist
        # (from the palletizer kiosk or an earlier receipt); when the
        # operator logs another batch (e.g. "found 20 more"), we append
        # 021-040 instead of failing on duplicate licence numbers.
        max_existing_seq = (
            db.query(func.coalesce(func.max(PalletLicence.sequence), 0))
            .filter(
                PalletLicence.lot_number == db_receipt.lot_number,
                PalletLicence.product_id == db_receipt.product_id,
            )
            .scalar()
            or 0
        )
        start_seq = int(max_existing_seq) + 1
        end_seq = start_seq + total_plan_pallets - 1

        seq = start_seq
        for item in plan:
            row_id = item.get("rowId")
            area_id = item.get("areaId")
            pallets = int(item.get("pallets", 0))
            item_cases = float(item.get("cases", 0))
            cases_per_pallet = (item_cases / pallets) if pallets > 0 else (db_receipt.cases_per_pallet or DEFAULT_CASES_PER_PALLET)
            for p in range(pallets):
                # `is_last` is the last pallet of THIS receipt's batch, not of
                # the whole (lot, product). Only this batch's tail can be a
                # partial pallet.
                is_last = seq == end_seq
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
                    warehouse_id=wh_id_for_write,
                )
                db.add(pl)
                seq += 1

    try:
        db.commit()
    except IntegrityError as e:
        # Defensive net for any unique-constraint race that slipped past the
        # pre-check above (concurrent receipt submission of the same lot).
        db.rollback()
        msg = str(getattr(e, "orig", e))
        if "ix_pallet_licences_licence_number" in msg or "pallet_licences" in msg:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "A pallet licence with the same number already exists for "
                    "this lot + product. Another session may have just created "
                    "them. Refresh and try again with a different lot, or "
                    "remove the existing pallets."
                ),
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Could not save receipt — a uniqueness conflict occurred.",
        )
    db.refresh(db_receipt)

    # Tag the response with the exact licence range that was generated, so
    # the toast can show real numbers instead of the frontend's guesswork.
    if is_finished_goods and db_receipt.lot_number and db_receipt.product_id and total_plan_pallets > 0:
        db_receipt.generated_licence_first = f"{db_receipt.lot_number}-{product_code}-{str(start_seq).zfill(3)}"
        db_receipt.generated_licence_last = f"{db_receipt.lot_number}-{product_code}-{str(end_seq).zfill(3)}"
        db_receipt.generated_licence_count = total_plan_pallets

    return db_receipt

@router.get("/{receipt_id}", response_model=ReceiptSchema)
def get_receipt(
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
def update_receipt(
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

    # Only pre-approval / sent-back (corrections) receipts may be edited. An
    # approved/rejected/depleted receipt is final — editing its fields would
    # desync the pallets, storage rows, and allocations it already drives.
    editable_statuses = {
        ReceiptStatus.PENDING,
        ReceiptStatus.RECORDED,
        ReceiptStatus.REVIEWED,
        ReceiptStatus.SENT_BACK,
    }
    if receipt.status not in editable_statuses:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only pending or sent-back receipts can be edited"
        )

    update_data = receipt_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(receipt, field, value)

    # If container/weight inputs changed, recompute the stored quantity and unit
    # from them — same derivation as receipt creation — so the weight total and
    # unit stay consistent (e.g. 40 barrels × 500 lbs = 20000 lbs).
    if "container_count" in update_data or "weight_per_container" in update_data:
        if receipt.container_count and receipt.weight_per_container and receipt.weight_unit:
            receipt.quantity = round(float(receipt.container_count) * float(receipt.weight_per_container), 3)
            receipt.unit = receipt.weight_unit
        elif receipt.container_count and receipt.container_unit and not receipt.weight_per_container:
            receipt.quantity = float(receipt.container_count)
            receipt.unit = receipt.container_unit

    db.commit()
    db.refresh(receipt)
    return receipt

@router.post("/{receipt_id}/resubmit")
def resubmit_receipt(
    receipt_id: str,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Resubmit a corrected receipt back into the approval queue.

    Used by the Receipt Corrections page after a supervisor sends a receipt
    back. Transitions a sent-back (or otherwise pre-approval) receipt to
    `reviewed`. Status changes go through this dedicated endpoint rather than
    the generic PUT so an approved receipt can never be reset for re-approval.
    """
    receipt = db.query(Receipt).filter(Receipt.id == receipt_id).first()
    if not receipt:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Receipt not found"
        )

    if current_user.role == ROLE_WAREHOUSE and receipt.submitted_by != str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only resubmit your own receipts"
        )

    resubmittable = {
        ReceiptStatus.PENDING,
        ReceiptStatus.RECORDED,
        ReceiptStatus.REVIEWED,
        ReceiptStatus.SENT_BACK,
    }
    if receipt.status not in resubmittable:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only sent-back or pending receipts can be resubmitted"
        )

    receipt.status = ReceiptStatus.REVIEWED
    db.commit()
    db.refresh(receipt)

    return {"message": "Receipt resubmitted successfully", "receipt": receipt}

@router.post("/{receipt_id}/approve")
def approve_receipt(
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
    
    require_approval_access(current_user, receipt)
    receipt_service.approve_receipt(db, receipt, current_user)
    db.commit()
    db.refresh(receipt)

    return {"message": "Receipt approved successfully", "receipt": receipt}

@router.post("/{receipt_id}/reject")
def reject_receipt(
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
    
    require_approval_access(current_user, receipt)
    receipt_service.reject_receipt(db, receipt, reason, current_user)
    db.commit()
    db.refresh(receipt)

    return {"message": "Receipt rejected successfully", "receipt": receipt}

@router.post("/{receipt_id}/send-back")
def send_back_receipt(
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
    
    require_approval_access(current_user, receipt)
    receipt_service.send_back_receipt(db, receipt, reason, current_user)
    db.commit()
    db.refresh(receipt)

    return {"message": "Receipt sent back for correction", "receipt": receipt}

@router.post("/{receipt_id}/assign-storage", response_model=ReceiptSchema)
def assign_storage(
    receipt_id: str,
    data: ReceiptAssignStorage,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """
    Assign storage location to a receipt that doesn't have one yet
    (e.g. destination receipts from inter-warehouse transfers).
    """
    receipt = db.query(Receipt).filter(Receipt.id == receipt_id).first()
    if not receipt:
        raise HTTPException(status_code=404, detail="Receipt not found")

    # Warehouse users can only assign storage to receipts at their warehouse
    wh_id = resolve_warehouse_for_write(current_user)
    if wh_id and receipt.warehouse_id != wh_id:
        raise HTTPException(status_code=403, detail="Cannot assign storage for a different warehouse's receipt")

    # Idempotency guard: assigning storage increments row occupancy, so calling
    # it twice would double-book. Reject if storage was already assigned.
    already_assigned = bool(
        receipt.storage_row_id
        or (isinstance(receipt.raw_material_row_allocations, list)
            and len(receipt.raw_material_row_allocations) > 0)
    )
    if already_assigned:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Storage has already been assigned for this receipt.",
        )

    # Update location fields
    if data.location_id:
        receipt.location_id = data.location_id
    if data.sub_location_id:
        receipt.sub_location_id = data.sub_location_id
    if data.cases_per_pallet:
        receipt.cases_per_pallet = data.cases_per_pallet

    # Handle multi-row RM allocations
    if data.raw_material_row_allocations and isinstance(data.raw_material_row_allocations, list):
        allocs_in = [
            a for a in data.raw_material_row_allocations
            if a.get("rowId") and float(a.get("pallets", 0) or 0) > 0
        ]
        total_pallets = sum(float(a.get("pallets", 0) or 0) for a in allocs_in)
        # Row content = the ACTUAL transferred content, split across the chosen
        # rows by pallet share — never pallets × cases_per_pallet (wrong for
        # weight/drum lots). Pallets and content are tracked independently.
        total_content = float(receipt.quantity or 0)
        enriched = []
        first_row_id = None
        for alloc in allocs_in:
            row_id = alloc.get("rowId")
            pallets_to_add = float(alloc.get("pallets", 0) or 0)
            if not first_row_id:
                first_row_id = row_id
            cases_to_add = (total_content * pallets_to_add / total_pallets) if total_pallets > 0 else 0
            storage_row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
            if storage_row:
                current_occupied = storage_row.occupied_pallets or 0
                capacity = storage_row.pallet_capacity or 0
                if capacity > 0 and (current_occupied + pallets_to_add) > capacity:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Adding {pallets_to_add} pallets to row {storage_row.name} would exceed capacity ({capacity}). Currently occupied: {current_occupied}"
                    )
                storage_row.occupied_pallets = current_occupied + pallets_to_add
                storage_row.occupied_cases = (storage_row.occupied_cases or 0) + cases_to_add
                if not storage_row.product_id:
                    storage_row.product_id = receipt.product_id
            enriched.append({**alloc, "pallets": pallets_to_add, "cases": cases_to_add})
        receipt.raw_material_row_allocations = enriched
        receipt.pallets = total_pallets
        if len(enriched) == 1 and first_row_id:
            receipt.storage_row_id = first_row_id

    # Handle single-row allocation
    elif data.storage_row_id and data.pallets:
        receipt.storage_row_id = data.storage_row_id
        receipt.pallets = data.pallets
        storage_row = db.query(StorageRow).filter(StorageRow.id == data.storage_row_id).first()
        if storage_row:
            pallets_to_add = float(data.pallets)
            current_occupied = storage_row.occupied_pallets or 0
            capacity = storage_row.pallet_capacity or 0
            if capacity > 0 and (current_occupied + pallets_to_add) > capacity:
                raise HTTPException(
                    status_code=400,
                    detail=f"Adding {pallets_to_add} pallets would exceed row capacity ({capacity}). Currently occupied: {current_occupied}"
                )
            storage_row.occupied_pallets = current_occupied + pallets_to_add
            # Content = the actual transferred content placed here (not pallets × cpp).
            storage_row.occupied_cases = (storage_row.occupied_cases or 0) + float(receipt.quantity or 0)
            if not storage_row.product_id:
                storage_row.product_id = receipt.product_id

    # Auto-derive sub_location_id from storage_row if missing
    if not receipt.sub_location_id and receipt.storage_row_id:
        row = db.query(StorageRow).filter(StorageRow.id == receipt.storage_row_id).first()
        if row and row.sub_location_id:
            receipt.sub_location_id = row.sub_location_id

    db.commit()
    db.refresh(receipt)
    return receipt


@router.get("/{receipt_id}/allocations", response_model=List[ReceiptAllocationSchema])
def get_receipt_allocations(
    receipt_id: str,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get allocations for a specific receipt"""
    allocations = db.query(ReceiptAllocation).filter(
        ReceiptAllocation.receipt_id == receipt_id
    ).all()
    return allocations
