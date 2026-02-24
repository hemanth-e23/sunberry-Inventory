from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import func, and_
from datetime import datetime, date
import json
import uuid
import copy
import os
import httpx
import logging

from app.database import get_db
from app.models import (
    Receipt, InventoryTransfer, InventoryAdjustment, InventoryHoldAction,
    StorageArea, StorageRow, Location, SubLocation, User, Category, CycleCount, StagingItem, Product,
    PalletLicence, TransferScanEvent
)
from app.schemas import (
    InventoryTransfer as InventoryTransferSchema, InventoryTransferCreate, InventoryTransferUpdate,
    ShipOutPickListCreate, ScanPickRequest, ForkliftSubmitRequest,
    InventoryAdjustment as InventoryAdjustmentSchema, InventoryAdjustmentCreate, InventoryAdjustmentUpdate,
    InventoryHoldAction as InventoryHoldActionSchema, InventoryHoldActionCreate, InventoryHoldActionUpdate,
    CycleCount as CycleCountSchema, CycleCountCreate,
    StagingItem as StagingItemSchema, StagingItemCreate, StagingItemUpdate,
    StagingLotSuggestion, CreateStagingRequest, MarkStagingUsedRequest, ReturnStagingRequest
)
from app.utils.auth import get_current_active_user, require_role

router = APIRouter()

# Inventory Transfer endpoints
def _transfer_to_response(transfer, db: Session) -> dict:
    """Convert transfer to response dict including pallet licence details."""
    data = {
        "id": transfer.id,
        "receipt_id": transfer.receipt_id,
        "from_location_id": transfer.from_location_id,
        "from_sub_location_id": transfer.from_sub_location_id,
        "to_location_id": transfer.to_location_id,
        "to_sub_location_id": transfer.to_sub_location_id,
        "quantity": transfer.quantity,
        "unit": transfer.unit or "cases",
        "reason": transfer.reason,
        "transfer_type": transfer.transfer_type or "warehouse-transfer",
        "order_number": transfer.order_number,
        "source_breakdown": transfer.source_breakdown,
        "destination_breakdown": transfer.destination_breakdown,
        "pallet_licence_ids": transfer.pallet_licence_ids,
        "status": transfer.status,
        "requested_by": transfer.requested_by,
        "approved_by": transfer.approved_by,
        "approved_at": transfer.approved_at,
        "submitted_at": transfer.submitted_at,
        "created_at": transfer.created_at,
        "forklift_submitted_at": getattr(transfer, "forklift_submitted_at", None),
        "forklift_notes": getattr(transfer, "forklift_notes", None),
        "skipped_pallet_ids": getattr(transfer, "skipped_pallet_ids", None) or [],
    }
    pl_ids = transfer.pallet_licence_ids or []
    if pl_ids:
        licences = db.query(PalletLicence).filter(PalletLicence.id.in_(pl_ids)).all()
        licence_list = []
        for pl in licences:
            row_name = None
            area_name = None
            if pl.storage_row_id:
                row = db.query(StorageRow).filter(StorageRow.id == pl.storage_row_id).first()
                if row:
                    row_name = row.name
                    if row.storage_area_id:
                        area = db.query(StorageArea).filter(StorageArea.id == row.storage_area_id).first()
                        if area:
                            area_name = area.name
            location_label = "Floor" if not row_name else f"{area_name}/{row_name}" if area_name else row_name
            licence_list.append({
                "id": pl.id,
                "licence_number": pl.licence_number or "",
                "cases": pl.cases or 0,
                "lot_number": pl.lot_number or "",
                "storage_row_id": pl.storage_row_id,
                "location": location_label,
            })
        data["pallet_licence_details"] = licence_list
    else:
        data["pallet_licence_details"] = []
    return data


@router.get("/transfers")
async def get_transfers(
    skip: int = 0,
    limit: int = 1000,
    status: str = None,
    requested_by: str = None,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get all inventory transfers with pallet licence details."""
    query = db.query(InventoryTransfer)
    
    if status:
        query = query.filter(InventoryTransfer.status == status)
    if requested_by:
        query = query.filter(InventoryTransfer.requested_by == requested_by)
    
    transfers = query.order_by(InventoryTransfer.submitted_at.desc()).offset(skip).limit(limit).all()
    return [_transfer_to_response(t, db) for t in transfers]

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
    return _transfer_to_response(db_transfer, db)


@router.post("/ship-out/pick-list")
async def create_ship_out_pick_list(
    data: ShipOutPickListCreate,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Create ship-out transfer with specific pallet licence IDs (pick list).
    Warehouse selects exact pallets to ship; quantity and source breakdown are derived from licences."""
    receipt = db.query(Receipt).filter(Receipt.id == data.receipt_id).first()
    if not receipt:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Receipt not found")

    licences = db.query(PalletLicence).filter(
        PalletLicence.id.in_(data.pallet_licence_ids),
        PalletLicence.receipt_id == receipt.id,
        PalletLicence.status == "in_stock"
    ).all()
    if len(licences) != len(data.pallet_licence_ids):
        found_ids = {pl.id for pl in licences}
        missing = [x for x in data.pallet_licence_ids if x not in found_ids]
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Some pallet licences not found or not in stock: {missing}"
        )

    total_cases = sum(pl.cases for pl in licences)
    if total_cases <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No cases in selected pallets")

    # Build source_breakdown from storage rows
    row_cases = {}
    for pl in licences:
        rid = pl.storage_row_id or "floor"
        key = f"row-{rid}" if rid != "floor" else "floor"
        row_cases[key] = row_cases.get(key, 0) + pl.cases

    source_breakdown = [{"id": k, "quantity": v} for k, v in row_cases.items()]

    transfer_id = f"transfer-{int(datetime.utcnow().timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
    db_transfer = InventoryTransfer(
        id=transfer_id,
        receipt_id=receipt.id,
        quantity=total_cases,
        unit="cases",
        transfer_type="shipped-out",
        order_number=data.order_number,
        source_breakdown=source_breakdown,
        pallet_licence_ids=data.pallet_licence_ids,
        requested_by=str(current_user.id),
        status="pending"
    )
    receipt.hold = True
    db.add(db_transfer)
    db.commit()
    db.refresh(db_transfer)
    return _transfer_to_response(db_transfer, db)


@router.post("/transfers/{transfer_id}/scan-pick")
async def scan_pick_transfer(
    transfer_id: str,
    data: ScanPickRequest,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Forklift scans pallet during ship-out picking. Validates pallet is on the pick list."""
    transfer = db.query(InventoryTransfer).filter(InventoryTransfer.id == transfer_id).first()
    if not transfer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer not found")
    if transfer.transfer_type != "shipped-out":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Not a ship-out transfer")
    if transfer.status != "pending":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Transfer is not pending")

    pl_ids = transfer.pallet_licence_ids or []
    if not pl_ids:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Transfer has no pick list")

    if data.licence_id:
        pl = db.query(PalletLicence).filter(PalletLicence.id == data.licence_id).first()
    elif data.licence_number:
        pl = db.query(PalletLicence).filter(PalletLicence.licence_number == data.licence_number).first()
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="licence_number or licence_id required")

    if not pl:
        # Persist exception: scanned licence not found in system
        event_id = f"scan-{int(datetime.utcnow().timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
        scan_event = TransferScanEvent(
            id=event_id,
            transfer_id=transfer_id,
            licence_number=data.licence_number or data.licence_id or "",
            licence_id=None,
            on_list=False,
            scanned_by=str(current_user.id) if current_user else None,
        )
        db.add(scan_event)
        db.commit()
        return {"success": False, "on_list": False, "message": "Pallet licence not found"}

    on_list = pl.id in pl_ids

    # Persist scan event for progress and exception reporting
    event_id = f"scan-{int(datetime.utcnow().timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
    scan_event = TransferScanEvent(
        id=event_id,
        transfer_id=transfer_id,
        licence_number=pl.licence_number or data.licence_number or "",
        licence_id=pl.id,
        on_list=on_list,
        scanned_by=str(current_user.id) if current_user else None,
    )
    db.add(scan_event)
    db.commit()

    return {
        "success": True,
        "on_list": on_list,
        "licence": {"id": pl.id, "licence_number": pl.licence_number, "cases": pl.cases},
        "message": "On pick list" if on_list else "Not on pick list (override allowed)"
    }


@router.get("/transfers/{transfer_id}/scan-progress")
async def get_transfer_scan_progress(
    transfer_id: str,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get ship-out picking progress with per-pallet status (for forklift UI and approvals live view)."""
    transfer = db.query(InventoryTransfer).filter(InventoryTransfer.id == transfer_id).first()
    if not transfer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer not found")
    pl_ids = transfer.pallet_licence_ids or []
    total_pallets = len(pl_ids) if isinstance(pl_ids, list) else 0
    skipped_ids = set(getattr(transfer, "skipped_pallet_ids", None) or [])

    events = (
        db.query(TransferScanEvent)
        .filter(TransferScanEvent.transfer_id == transfer_id)
        .order_by(TransferScanEvent.scanned_at)
        .all()
    )

    # Build scan lookup: pallet_id -> latest scan event
    scanned_pl_ids: dict = {}
    exceptions = []
    last_scan = None
    for e in events:
        scanner_name = None
        if e.scanned_by:
            u = db.query(User).filter(User.id == e.scanned_by).first()
            scanner_name = u.name if u else e.scanned_by
        evt = {
            "licence_number": e.licence_number,
            "on_list": e.on_list,
            "scanned_by": scanner_name or e.scanned_by,
            "scanned_at": e.scanned_at.isoformat() if e.scanned_at else None,
        }
        if e.on_list and e.licence_id:
            scanned_pl_ids[e.licence_id] = evt
        if not e.on_list:
            exceptions.append(evt)
        last_scan = evt

    # Build per-pallet pick list
    pick_list = []
    if pl_ids:
        licences = db.query(PalletLicence).filter(PalletLicence.id.in_(pl_ids)).all()
        pl_map = {pl.id: pl for pl in licences}
        for pl_id in pl_ids:
            pl = pl_map.get(pl_id)
            if not pl:
                continue
            row_name = None
            area_name = None
            if pl.storage_row_id:
                row = db.query(StorageRow).filter(StorageRow.id == pl.storage_row_id).first()
                if row:
                    row_name = row.name
                    if row.storage_area_id:
                        area = db.query(StorageArea).filter(StorageArea.id == row.storage_area_id).first()
                        if area:
                            area_name = area.name
            location_label = "Floor" if not row_name else f"{area_name}/{row_name}" if area_name else row_name
            scan_evt = scanned_pl_ids.get(pl_id)
            pick_list.append({
                "pallet_id": pl.id,
                "licence_number": pl.licence_number or "",
                "cases": pl.cases or 0,
                "lot_number": pl.lot_number or "",
                "location": location_label,
                "is_scanned": pl_id in scanned_pl_ids,
                "is_skipped": pl_id in skipped_ids,
                "scanned_at": scan_evt["scanned_at"] if scan_evt else None,
                "scanned_by": scan_evt["scanned_by"] if scan_evt else None,
            })

    return {
        "transfer_id": transfer_id,
        "order_number": transfer.order_number,
        "total_pallets": total_pallets,
        "scanned_count": len(scanned_pl_ids),
        "pick_list": pick_list,
        "exceptions": exceptions,
        "last_scan": last_scan,
        "forklift_submitted_at": getattr(transfer, "forklift_submitted_at", None),
        "forklift_notes": getattr(transfer, "forklift_notes", None),
        "skipped_pallet_ids": list(skipped_ids),
    }


@router.post("/transfers/{transfer_id}/forklift-submit")
async def forklift_submit_transfer(
    transfer_id: str,
    data: ForkliftSubmitRequest,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Forklift driver submits the ship-out pick as done (full or partial).
    Sets forklift_submitted_at and stores notes + any skipped pallet IDs."""
    transfer = db.query(InventoryTransfer).filter(InventoryTransfer.id == transfer_id).first()
    if not transfer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer not found")
    if transfer.transfer_type != "shipped-out":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Not a ship-out transfer")
    if transfer.status not in ("pending",):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Transfer cannot be submitted in its current state")

    transfer.forklift_submitted_at = datetime.utcnow()
    transfer.forklift_notes = data.notes or None
    transfer.skipped_pallet_ids = data.skipped_pallet_ids or []
    db.commit()
    db.refresh(transfer)
    return {"success": True, "message": "Pick submitted for approval", "transfer": _transfer_to_response(transfer, db)}


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

    # Handle pallet licence aware transfers
    pl_ids = transfer.pallet_licence_ids if isinstance(transfer.pallet_licence_ids, list) else []
    if pl_ids and is_finished_goods:
        licences = db.query(PalletLicence).filter(
            PalletLicence.id.in_(pl_ids),
            PalletLicence.receipt_id == receipt.id,
            PalletLicence.status == "in_stock"
        ).all()
        if transfer.transfer_type == "shipped-out":
            for pl in licences:
                pl.status = "shipped"
                pl.transfer_id = transfer_id
                if pl.storage_row_id:
                    row = db.query(StorageRow).filter(StorageRow.id == pl.storage_row_id).first()
                    if row:
                        row.occupied_pallets = max(0, (row.occupied_pallets or 0) - 1)
                        row.occupied_cases = max(0, (row.occupied_cases or 0) - pl.cases)
                        if row.occupied_pallets <= 0:
                            row.product_id = None
        else:
            # Internal transfer - update pallet locations from destination_breakdown
            # Support per-destination pallet_licence_ids (forklift scanner) or fallback to single dest
            dest_list = transfer.destination_breakdown or []
            has_per_row_pl_ids = any(d.get("pallet_licence_ids") for d in dest_list)
            for dest in dest_list:
                dest_id = dest.get("id", "")
                if not dest_id.startswith("row-"):
                    continue
                to_row_id = dest_id.removeprefix("row-")
                to_row = db.query(StorageRow).filter(StorageRow.id == to_row_id).first()
                if not to_row:
                    continue
                # Pallets going to this row: explicit list or all to first dest (legacy)
                dest_pl_ids = dest.get("pallet_licence_ids")
                if dest_pl_ids:
                    dest_licences = [pl for pl in licences if pl.id in dest_pl_ids]
                elif not has_per_row_pl_ids and dest_list[0].get("id") == dest_id:
                    dest_licences = licences  # legacy: all pallets to first dest
                else:
                    dest_licences = []
                for pl in dest_licences:
                    if pl.storage_row_id:
                        src_row = db.query(StorageRow).filter(StorageRow.id == pl.storage_row_id).first()
                        if src_row:
                            src_row.occupied_pallets = max(0, (src_row.occupied_pallets or 0) - 1)
                            src_row.occupied_cases = max(0, (src_row.occupied_cases or 0) - pl.cases)
                            if src_row.occupied_pallets <= 0:
                                src_row.product_id = None
                    pl.storage_row_id = to_row_id
                    pl.storage_area_id = to_row.storage_area_id
                    to_row.occupied_pallets = (to_row.occupied_pallets or 0) + 1
                    to_row.occupied_cases = (to_row.occupied_cases or 0) + pl.cases
                    if not to_row.product_id:
                        to_row.product_id = pl.product_id
    
    # For finished goods (without pallet_licence_ids), subtract from storage row occupancy
    if is_finished_goods and not pl_ids and receipt.allocation:
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
                        row_id = source_id.removeprefix("row-")
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
    
    # For raw materials/packaging (non-finished goods), free storage row occupancy when shipping out
    if transfer.transfer_type == "shipped-out" and not is_finished_goods:
        transfer_quantity = float(transfer.quantity)
        receipt_total_quantity = float(receipt.quantity)
        
        if receipt_total_quantity > 0:
            proportion_shipped = min(1.0, transfer_quantity / receipt_total_quantity)
            
            # Handle multiple row allocations (rawMaterialRowAllocations)
            if receipt.raw_material_row_allocations and isinstance(receipt.raw_material_row_allocations, list):
                for alloc in receipt.raw_material_row_allocations:
                    row_id = alloc.get("rowId")
                    alloc_pallets = float(alloc.get("pallets", 0))
                    
                    if row_id and alloc_pallets > 0:
                        pallets_to_free = alloc_pallets * proportion_shipped
                        
                        storage_row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
                        if storage_row and pallets_to_free > 0:
                            # Free pallets from storage row (location is now available again)
                            storage_row.occupied_pallets = max(0, (storage_row.occupied_pallets or 0) - pallets_to_free)
                            
                            # Also update cases if receipt has cases_per_pallet
                            if receipt.cases_per_pallet and receipt.cases_per_pallet > 0:
                                cases_to_free = pallets_to_free * receipt.cases_per_pallet
                                storage_row.occupied_cases = max(0, (storage_row.occupied_cases or 0) - cases_to_free)
                            
                            # Clear product_id if row is now empty (location is free for new inventory)
                            if storage_row.occupied_pallets <= 0:
                                storage_row.product_id = None
            
            # Handle single row allocation (backward compatibility)
            elif receipt.storage_row_id and receipt.pallets:
                receipt_total_pallets = float(receipt.pallets)
                
                if receipt_total_pallets > 0:
                    pallets_to_free = receipt_total_pallets * proportion_shipped
                    
                    storage_row = db.query(StorageRow).filter(StorageRow.id == receipt.storage_row_id).first()
                    if storage_row and pallets_to_free > 0:
                        # Free pallets from storage row (location is now available again)
                        storage_row.occupied_pallets = max(0, (storage_row.occupied_pallets or 0) - pallets_to_free)
                        
                        # Also update cases if receipt has cases_per_pallet
                        if receipt.cases_per_pallet and receipt.cases_per_pallet > 0:
                            cases_to_free = pallets_to_free * receipt.cases_per_pallet
                            storage_row.occupied_cases = max(0, (storage_row.occupied_cases or 0) - cases_to_free)
                        
                        # Clear product_id if row is now empty (location is free for new inventory)
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

        # Rebuild receipt.allocation from PalletLicence for pallet-licence transfers
        # (inventory overview reads allocation; without this, transferred rows don't show)
        if pl_ids and is_finished_goods:
            # Flush pending ORM changes so the query below sees updated storage_row_id values
            # (session uses autoflush=False, so explicit flush is required here)
            db.flush()
            all_in_stock = db.query(PalletLicence).filter(
                PalletLicence.receipt_id == receipt.id,
                PalletLicence.status == "in_stock",
                PalletLicence.storage_row_id.isnot(None),
            ).all()
            row_groups = {}
            for pl in all_in_stock:
                rid = pl.storage_row_id
                if rid not in row_groups:
                    row_groups[rid] = {"pallets": 0, "cases": 0}
                row_groups[rid]["pallets"] += 1
                row_groups[rid]["cases"] += pl.cases
            plan = []
            for row_id, data in row_groups.items():
                row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
                area = db.query(StorageArea).filter(StorageArea.id == row.storage_area_id).first() if row else None
                plan.append({
                    "areaId": row.storage_area_id if row else None,
                    "rowId": row_id,
                    "areaName": area.name if area else "",
                    "rowName": row.name if row else "",
                    "pallets": data["pallets"],
                    "cases": data["cases"],
                })
            total_cases = sum(p["cases"] for p in plan)
            total_pallets = sum(p["pallets"] for p in plan)
            receipt.allocation = {
                "success": True,
                "plan": plan,
                "totalCases": total_cases,
                "totalPallets": total_pallets,
            }

        # Update allocation JSON for finished goods transfers (skip when using pallet_licence_ids)
        if not pl_ids and receipt.allocation and transfer.source_breakdown and transfer.destination_breakdown:
            try:
                if isinstance(receipt.allocation, str):
                    allocation_data = json.loads(receipt.allocation)
                else:
                    allocation_data = receipt.allocation
                
                if allocation_data.get("success") and allocation_data.get("plan"):
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

# Staging endpoints
@router.get("/staging/suggest-lots", response_model=List[StagingLotSuggestion])
async def suggest_lots_for_staging(
    product_id: str,
    quantity: float,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Suggest lots for staging based on expiry date (FEFO - First Expiry First Out)"""
    # Get all approved receipts for this product that are available (not on hold)
    receipts = db.query(Receipt).filter(
        Receipt.product_id == product_id,
        Receipt.status == "approved",
        Receipt.quantity > 0,
        Receipt.hold == False  # Exclude items on hold
    ).order_by(Receipt.expiration_date.asc().nullslast()).all()
    
    suggestions = []
    
    for receipt in receipts:
        # Get all staging items for this receipt
        staged_items = db.query(StagingItem).filter(
            StagingItem.receipt_id == receipt.id
        ).all()
        
        # Calculate how much is currently still in staging (not used, not returned)
        # Only count active staging items (not fully used/returned)
        quantity_still_in_staging = sum(
            item.quantity_staged - item.quantity_used - item.quantity_returned 
            for item in staged_items
            if item.status in ["staged", "partially_used", "partially_returned"]
        )
        
        # Calculate total that was staged (including used/returned)
        total_staged = sum(item.quantity_staged for item in staged_items)
        
        # Calculate total that was used (already deducted from receipt.quantity via adjustments)
        total_used = sum(item.quantity_used for item in staged_items)
        
        # Calculate total that was returned (moved back to warehouse via transfers)
        total_returned = sum(item.quantity_returned for item in staged_items)
        
        # Available quantity calculation:
        # receipt.quantity = current quantity (may have been reduced by usage)
        # We need to add back what was used (since it was deducted), and subtract what's still in staging
        # But actually, receipt.quantity already reflects the current state after usage
        # So: available = receipt.quantity - quantity_still_in_staging
        # However, if items were returned, they're back in the original location, so receipt.quantity should include them
        # The simplest approach: receipt.quantity is the current quantity at the receipt's location
        # Available to stage = receipt.quantity - what's still in staging
        available_quantity = receipt.quantity - quantity_still_in_staging
        
        # Use a small epsilon to handle floating point precision issues
        # Only include if there's meaningful available quantity (> 0.01 to account for rounding)
        if available_quantity > 0.01:
            # Get location info
            location_name = None
            sub_location_name = None
            storage_row_name = None
            if receipt.location_id:
                location = db.query(Location).filter(Location.id == receipt.location_id).first()
                location_name = location.name if location else None
            if receipt.sub_location_id:
                sub_location = db.query(SubLocation).filter(SubLocation.id == receipt.sub_location_id).first()
                sub_location_name = sub_location.name if sub_location else None
            if receipt.storage_row_id:
                storage_row = db.query(StorageRow).filter(StorageRow.id == receipt.storage_row_id).first()
                storage_row_name = storage_row.name if storage_row else None
                # Fallback: derive sub_location from storage_row when receipt is missing it
                if not sub_location_name and storage_row and storage_row.sub_location_id:
                    sub_location = db.query(SubLocation).filter(SubLocation.id == storage_row.sub_location_id).first()
                    sub_location_name = sub_location.name if sub_location else None
            
            # Get unit from receipt or product
            unit = receipt.unit or "cases"
            if not unit or unit == "cases":
                product = db.query(Product).filter(Product.id == receipt.product_id).first()
                if product and product.quantity_uom:
                    unit = product.quantity_uom
            
            suggestions.append({
                "receipt_id": receipt.id,
                "lot_number": receipt.lot_number or "",
                "location_id": receipt.location_id,
                "location_name": location_name,
                "sub_location_id": receipt.sub_location_id,
                "sub_location_name": sub_location_name,
                "storage_row_name": storage_row_name,
                "expiration_date": receipt.expiration_date,
                "available_quantity": available_quantity,
                "unit": unit,
                # Container/weight info for display
                "container_count": receipt.container_count,
                "container_unit": receipt.container_unit,
                "weight_per_container": receipt.weight_per_container,
                "weight_unit": receipt.weight_unit,
            })
    
    # Return ALL available lots (sorted by expiry), not just enough to meet quantity
    # This allows user to see and choose from all options
    return suggestions

@router.post("/staging/transfer")
async def create_staging_transfer(
    staging_data: CreateStagingRequest,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Create staging transfer for multiple products"""
    staging_batch_id = f"staging-{int(datetime.utcnow().timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
    created_transfers = []
    created_staging_items = []
    
    for item_request in staging_data.items:
        # Handle multiple lots per product
        if not item_request.lots or len(item_request.lots) == 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"No lots specified for product {item_request.product_id}"
            )
        
        # Validate total quantity matches
        total_lot_quantity = sum(lot.quantity for lot in item_request.lots)
        if abs(total_lot_quantity - item_request.quantity_needed) > 0.01:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Total lot quantities ({total_lot_quantity}) must match requested quantity ({item_request.quantity_needed})"
            )
        
        # Process each lot
        for lot_request in item_request.lots:
            receipt = db.query(Receipt).filter(Receipt.id == lot_request.receipt_id).first()
            if not receipt:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Receipt {lot_request.receipt_id} not found"
                )
            
            # Verify receipt belongs to the product
            if receipt.product_id != item_request.product_id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Receipt {lot_request.receipt_id} does not belong to product {item_request.product_id}"
                )
            
            # Check available quantity
            staged_items = db.query(StagingItem).filter(
                StagingItem.receipt_id == receipt.id,
                StagingItem.status.in_(["staged", "partially_used", "partially_returned"])
            ).all()
            
            quantity_still_in_staging = sum(
                item.quantity_staged - item.quantity_used - item.quantity_returned 
                for item in staged_items
                if item.status in ["staged", "partially_used", "partially_returned"]
            )
            available_quantity = receipt.quantity - quantity_still_in_staging
            
            if lot_request.quantity > available_quantity:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Insufficient quantity for lot {receipt.lot_number}. Available: {available_quantity}, Requested: {lot_request.quantity}"
                )
            
            # Get unit from receipt or product
            unit = receipt.unit or "cases"
            if not unit or unit == "cases":
                product = db.query(Product).filter(Product.id == receipt.product_id).first()
                if product and product.quantity_uom:
                    unit = product.quantity_uom
            
            # Create transfer
            transfer_id = f"transfer-{int(datetime.utcnow().timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
            transfer = InventoryTransfer(
                id=transfer_id,
                receipt_id=receipt.id,
                from_location_id=receipt.location_id,
                from_sub_location_id=receipt.sub_location_id,
                to_location_id=staging_data.staging_location_id,
                to_sub_location_id=staging_data.staging_sub_location_id,
                quantity=lot_request.quantity,
                unit=unit,
                reason="Staging for production",
                transfer_type="staging",
                requested_by=str(current_user.id),
                status="completed"  # Staging transfers are auto-completed (no approval needed)
            )
            
            db.add(transfer)
            db.flush()  # Get transfer ID
            
            # Calculate pallets staged proportionally from receipt
            # Store this for later use when marking as used or returning
            pallets_staged = None
            if receipt.pallets and receipt.pallets > 0 and receipt.quantity > 0:
                # Calculate proportionally: (quantity_staged / receipt.quantity) * receipt.pallets
                pallets_staged = (lot_request.quantity / receipt.quantity) * receipt.pallets
            
            # Store original storage_row_id for tracking which rack space to free when used/returned
            original_storage_row_id = receipt.storage_row_id
            
            # Update receipt location to staging location (physical move)
            receipt.location_id = staging_data.staging_location_id
            receipt.sub_location_id = staging_data.staging_sub_location_id
            # Note: We keep receipt.storage_row_id for now, but store original in StagingItem for freeing space later
            
            # Find or set staging storage row (if staging location uses storage rows)
            staging_storage_row_id = None
            if staging_data.staging_sub_location_id:
                # Check if staging sub-location has storage rows
                staging_rows = db.query(StorageRow).filter(
                    StorageRow.sub_location_id == staging_data.staging_sub_location_id
                ).all()
                # For now, we don't auto-allocate staging rows - they can be assigned manually later
                # staging_storage_row_id will be set to None, meaning items are in staging location but not in a specific row
            
            # Create staging item with pallet tracking
            staging_item_id = f"staging-{int(datetime.utcnow().timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
            staging_item = StagingItem(
                id=staging_item_id,
                transfer_id=transfer.id,
                receipt_id=receipt.id,
                product_id=item_request.product_id,
                quantity_staged=lot_request.quantity,
                pallets_staged=pallets_staged,
                original_storage_row_id=original_storage_row_id,  # Store original row to free space when used/returned
                staging_storage_row_id=staging_storage_row_id,  # Will be set if staging location has rows
                staging_batch_id=staging_batch_id
            )
            
            # Reserve pallets in staging location's storage row (if staging row is specified)
            if staging_storage_row_id and pallets_staged:
                staging_row = db.query(StorageRow).filter(StorageRow.id == staging_storage_row_id).first()
                if staging_row:
                    staging_row.occupied_pallets = (staging_row.occupied_pallets or 0) + pallets_staged
                    if receipt.cases_per_pallet and receipt.cases_per_pallet > 0:
                        cases_to_reserve = pallets_staged * receipt.cases_per_pallet
                        staging_row.occupied_cases = (staging_row.occupied_cases or 0) + cases_to_reserve
                    if not staging_row.product_id:
                        staging_row.product_id = item_request.product_id
            
            db.add(staging_item)
            created_transfers.append(transfer)
            created_staging_items.append(staging_item)
    
    db.commit()
    
    return {
        "staging_batch_id": staging_batch_id,
        "transfers": [{"id": t.id, "receipt_id": t.receipt_id, "quantity": t.quantity} for t in created_transfers],
        "staging_items": [{"id": s.id, "receipt_id": s.receipt_id, "quantity_staged": s.quantity_staged} for s in created_staging_items]
    }

@router.get("/staging/items")
async def get_staging_items(
    status_filter: Optional[str] = None,
    product_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get all staging items with receipt information"""
    try:
        query = db.query(StagingItem)
        
        if status_filter:
            query = query.filter(StagingItem.status == status_filter)
        else:
            # Default: show only active staging items (not fully used or returned)
            query = query.filter(StagingItem.status.in_(["staged", "partially_used", "partially_returned"]))
        
        if product_id:
            query = query.filter(StagingItem.product_id == product_id)
        
        staging_items = query.order_by(StagingItem.staged_at.desc()).all()
        
        # Include receipt data in response
        result = []
        for item in staging_items:
            try:
                receipt = db.query(Receipt).filter(Receipt.id == item.receipt_id).first()
                
                item_dict = {
                    "id": item.id,
                    "transfer_id": item.transfer_id,
                    "receipt_id": item.receipt_id,
                    "product_id": item.product_id,
                    "quantity_staged": item.quantity_staged,
                    "quantity_used": item.quantity_used or 0,
                    "quantity_returned": item.quantity_returned or 0,
                    "status": item.status,
                    "staging_batch_id": getattr(item, 'staging_batch_id', None),
                    "staged_at": item.staged_at.isoformat() if item.staged_at else None,
                    "used_at": item.used_at.isoformat() if item.used_at else None,
                    "returned_at": item.returned_at.isoformat() if item.returned_at else None,
                    "receipt": {
                        "id": receipt.id if receipt else None,
                        "lot_number": receipt.lot_number if receipt else None,
                        "location_id": receipt.location_id if receipt else None,
                        "sub_location_id": receipt.sub_location_id if receipt else None,
                        "unit": getattr(receipt, 'unit', None) or "cases",
                        "pallets": getattr(receipt, 'pallets', None),
                        "cases_per_pallet": getattr(receipt, 'cases_per_pallet', None)
                    } if receipt else None,
                    "pallets_staged": getattr(item, 'pallets_staged', None),
                    "pallets_used": getattr(item, 'pallets_used', 0) or 0,
                    "pallets_returned": getattr(item, 'pallets_returned', 0) or 0,
                    "original_storage_row_id": getattr(item, 'original_storage_row_id', None),
                    "staging_storage_row_id": getattr(item, 'staging_storage_row_id', None)
                }
                result.append(item_dict)
            except Exception as e:
                # Log error for this item but continue processing others
                print(f"Error processing staging item {item.id}: {str(e)}")
                import traceback
                traceback.print_exc()
                continue
        
        return result
    except Exception as e:
        print(f"Error in get_staging_items: {str(e)}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error fetching staging items: {str(e)}"
        )

@router.post("/staging/{staging_item_id}/mark-used")
async def mark_staging_used(
    staging_item_id: str,
    request: MarkStagingUsedRequest,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Mark staged item as used for production"""
    staging_item = db.query(StagingItem).filter(StagingItem.id == staging_item_id).first()
    if not staging_item:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Staging item not found"
        )
    
    available_quantity = staging_item.quantity_staged - staging_item.quantity_used - staging_item.quantity_returned
    
    if request.quantity > available_quantity:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot use more than available. Available: {available_quantity}, Requested: {request.quantity}"
        )
    
    # Get receipt for pallet calculations
    receipt = db.query(Receipt).filter(Receipt.id == staging_item.receipt_id).first()
    if not receipt:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Receipt not found for staging item"
        )
    
    # Calculate pallets used proportionally
    pallets_to_free = 0
    if staging_item.pallets_staged and staging_item.pallets_staged > 0 and staging_item.quantity_staged > 0:
        # Calculate: (quantity_used / quantity_staged) * pallets_staged
        pallets_to_free = (request.quantity / staging_item.quantity_staged) * staging_item.pallets_staged
    
    # Calculate proportion of receipt that was staged, and proportion of staged that is now being used
    receipt_total_quantity = float(receipt.quantity)
    quantity_staged = float(staging_item.quantity_staged)
    quantity_used_now = float(request.quantity)
    
    # Proportion: how much of the original receipt is being freed (used from staging)
    proportion_of_receipt_freed = 0
    if receipt_total_quantity > 0 and quantity_staged > 0:
        proportion_of_receipt_freed = (quantity_used_now / quantity_staged) * (quantity_staged / receipt_total_quantity)
    
    # Handle raw materials/packaging with multiple row allocations
    if receipt.raw_material_row_allocations and isinstance(receipt.raw_material_row_allocations, list):
        for alloc in receipt.raw_material_row_allocations:
            row_id = alloc.get("rowId")
            alloc_pallets = float(alloc.get("pallets", 0))
            
            if row_id and alloc_pallets > 0:
                # Free proportional pallets from this row
                pallets_to_free_from_row = alloc_pallets * proportion_of_receipt_freed
                
                storage_row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
                if storage_row and pallets_to_free_from_row > 0:
                    # Free pallets from original location (rack space is now empty and available)
                    storage_row.occupied_pallets = max(0, (storage_row.occupied_pallets or 0) - pallets_to_free_from_row)
                    
                    # Also update cases if receipt has cases_per_pallet
                    if receipt.cases_per_pallet and receipt.cases_per_pallet > 0:
                        cases_to_free = pallets_to_free_from_row * receipt.cases_per_pallet
                        storage_row.occupied_cases = max(0, (storage_row.occupied_cases or 0) - cases_to_free)
                    
                    # Clear product_id if row is now empty (rack space is free for new inventory)
                    if storage_row.occupied_pallets <= 0:
                        storage_row.product_id = None
    
    # Handle single row allocation (backward compatibility)
    elif staging_item.original_storage_row_id and pallets_to_free > 0:
        original_row = db.query(StorageRow).filter(StorageRow.id == staging_item.original_storage_row_id).first()
        if original_row:
            # Free pallets from original location (rack space is now empty and available)
            original_row.occupied_pallets = max(0, (original_row.occupied_pallets or 0) - pallets_to_free)
            
            # Also update cases if receipt has cases_per_pallet
            if receipt.cases_per_pallet and receipt.cases_per_pallet > 0:
                cases_to_free = pallets_to_free * receipt.cases_per_pallet
                original_row.occupied_cases = max(0, (original_row.occupied_cases or 0) - cases_to_free)
            
            # Clear product_id if row is now empty (rack space is free for new inventory)
            if original_row.occupied_pallets <= 0:
                original_row.product_id = None
    
    # Also free from staging location's storage row if staging uses rows
    if staging_item.staging_storage_row_id and pallets_to_free > 0:
        staging_row = db.query(StorageRow).filter(StorageRow.id == staging_item.staging_storage_row_id).first()
        if staging_row:
            # Free pallets from staging location
            staging_row.occupied_pallets = max(0, (staging_row.occupied_pallets or 0) - pallets_to_free)
            
            # Also update cases if receipt has cases_per_pallet
            if receipt.cases_per_pallet and receipt.cases_per_pallet > 0:
                cases_to_free = pallets_to_free * receipt.cases_per_pallet
                staging_row.occupied_cases = max(0, (staging_row.occupied_cases or 0) - cases_to_free)
            
            # Clear product_id if row is now empty
            if staging_row.occupied_pallets <= 0:
                staging_row.product_id = None
    
    # Update staging item
    staging_item.quantity_used += request.quantity
    staging_item.pallets_used = (staging_item.pallets_used or 0) + pallets_to_free
    
    if staging_item.quantity_used >= staging_item.quantity_staged:
        staging_item.status = "used"
    elif staging_item.quantity_used > 0:
        staging_item.status = "partially_used"
    staging_item.used_at = datetime.utcnow()
    
    # Create adjustment for consumption
    adjustment_id = f"adjust-{int(datetime.utcnow().timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
    adjustment = InventoryAdjustment(
        id=adjustment_id,
        receipt_id=staging_item.receipt_id,
        category_id=receipt.category_id,
        product_id=staging_item.product_id,
        adjustment_type="production-consumption",
        quantity=request.quantity,
        reason="Used from staging for production",
        status="approved",  # Auto-approved for staging usage
        original_quantity=receipt.quantity,
        new_quantity=receipt.quantity - request.quantity,
        submitted_by=str(current_user.id),
        approved_by=str(current_user.id),
        approved_at=datetime.utcnow()
    )
    
    # Update receipt quantity
    receipt.quantity -= request.quantity
    if receipt.quantity <= 0:
        receipt.quantity = 0
    
    db.add(adjustment)
    
    db.commit()
    db.refresh(staging_item)
    return staging_item

@router.post("/staging/{staging_item_id}/return")
async def return_staging_item(
    staging_item_id: str,
    request: ReturnStagingRequest,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Return staged item to warehouse"""
    staging_item = db.query(StagingItem).filter(StagingItem.id == staging_item_id).first()
    if not staging_item:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Staging item not found"
        )
    
    available_quantity = staging_item.quantity_staged - staging_item.quantity_used - staging_item.quantity_returned
    
    if request.quantity > available_quantity:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot return more than available. Available: {available_quantity}, Requested: {request.quantity}"
        )
    
    # Get receipt for pallet calculations
    receipt = db.query(Receipt).filter(Receipt.id == staging_item.receipt_id).first()
    if not receipt:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Receipt not found for staging item"
        )
    
    # Get original transfer
    transfer = db.query(InventoryTransfer).filter(InventoryTransfer.id == staging_item.transfer_id).first()
    if not transfer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Original transfer not found"
        )
    
    # Get unit from receipt
    unit = receipt.unit or "cases"
    product = db.query(Product).filter(Product.id == receipt.product_id).first()
    if not unit or unit == "cases":
        if product and product.quantity_uom:
            unit = product.quantity_uom
    
    # Calculate pallets returned proportionally
    pallets_to_free_from_original = 0
    if staging_item.pallets_staged and staging_item.pallets_staged > 0 and staging_item.quantity_staged > 0:
        # Calculate: (quantity_returned / quantity_staged) * pallets_staged
        pallets_to_free_from_original = (request.quantity / staging_item.quantity_staged) * staging_item.pallets_staged
    
    # Free pallets from original location's storage row (where items came from)
    # This empties the original rack space since items are being returned to a different location
    if staging_item.original_storage_row_id and pallets_to_free_from_original > 0:
        original_row = db.query(StorageRow).filter(StorageRow.id == staging_item.original_storage_row_id).first()
        if original_row:
            # Free pallets from original location (rack space is now empty)
            original_row.occupied_pallets = max(0, (original_row.occupied_pallets or 0) - pallets_to_free_from_original)
            
            # Also update cases if receipt has cases_per_pallet
            if receipt.cases_per_pallet and receipt.cases_per_pallet > 0:
                cases_to_free = pallets_to_free_from_original * receipt.cases_per_pallet
                original_row.occupied_cases = max(0, (original_row.occupied_cases or 0) - cases_to_free)
            
            # Clear product_id if row is now empty (rack space is free for new inventory)
            if original_row.occupied_pallets <= 0:
                original_row.product_id = None
    
    # Also free from staging location's storage row if staging uses rows
    if staging_item.staging_storage_row_id and pallets_to_free_from_original > 0:
        staging_row = db.query(StorageRow).filter(StorageRow.id == staging_item.staging_storage_row_id).first()
        if staging_row:
            # Free pallets from staging location
            staging_row.occupied_pallets = max(0, (staging_row.occupied_pallets or 0) - pallets_to_free_from_original)
            
            # Also update cases if receipt has cases_per_pallet
            if receipt.cases_per_pallet and receipt.cases_per_pallet > 0:
                cases_to_free = pallets_to_free_from_original * receipt.cases_per_pallet
                staging_row.occupied_cases = max(0, (staging_row.occupied_cases or 0) - cases_to_free)
            
            # Clear product_id if row is now empty
            if staging_row.occupied_pallets <= 0:
                staging_row.product_id = None
    
    # Pallets to reserve in return location
    pallets_to_reserve_in_return = pallets_to_free_from_original
    
    # Reserve pallets in return location's storage row (if specified)
    if request.to_storage_row_id and pallets_to_reserve_in_return > 0:
        return_row = db.query(StorageRow).filter(StorageRow.id == request.to_storage_row_id).first()
        if return_row:
            # Check capacity
            current_occupied = return_row.occupied_pallets or 0
            capacity = return_row.pallet_capacity or 0
            if capacity > 0 and (current_occupied + pallets_to_reserve_in_return) > capacity:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Returning {pallets_to_reserve_in_return} pallets would exceed row capacity ({capacity}). Currently occupied: {current_occupied}"
                )
            
            # Reserve pallets in return location (new rack space is occupied)
            return_row.occupied_pallets = current_occupied + pallets_to_reserve_in_return
            
            # Also update cases if receipt has cases_per_pallet
            if receipt.cases_per_pallet and receipt.cases_per_pallet > 0:
                cases_to_reserve = pallets_to_reserve_in_return * receipt.cases_per_pallet
                return_row.occupied_cases = (return_row.occupied_cases or 0) + cases_to_reserve
            
            # Set product_id if row doesn't have one
            if not return_row.product_id:
                return_row.product_id = receipt.product_id
    elif pallets_to_reserve_in_return > 0:
        # If no storage row specified, we free from original/staging but don't reserve anywhere
        # This means items are returned but not assigned to a specific rack yet
        pass
    
    # Create return transfer
    return_transfer_id = f"transfer-{int(datetime.utcnow().timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
    return_transfer = InventoryTransfer(
        id=return_transfer_id,
        receipt_id=staging_item.receipt_id,
        from_location_id=transfer.to_location_id,  # From staging
        from_sub_location_id=transfer.to_sub_location_id,
        to_location_id=request.to_location_id,  # To new warehouse location
        to_sub_location_id=request.to_sub_location_id,
        quantity=request.quantity,
        unit=unit,
        reason="Returned from staging",
        transfer_type="warehouse-transfer",
        requested_by=str(current_user.id),
        status="completed"  # Auto-completed
    )
    
    db.add(return_transfer)
    
    # Update receipt location
    receipt.location_id = request.to_location_id
    receipt.sub_location_id = request.to_sub_location_id
    if request.to_storage_row_id:
        receipt.storage_row_id = request.to_storage_row_id
    
    # Update staging item
    staging_item.quantity_returned += request.quantity
    staging_item.pallets_returned = (staging_item.pallets_returned or 0) + pallets_to_free_from_original
    
    if staging_item.quantity_returned >= staging_item.quantity_staged - staging_item.quantity_used:
        staging_item.status = "returned" if staging_item.quantity_used == 0 else "partially_returned"
    staging_item.returned_at = datetime.utcnow()
    
    db.commit()
    db.refresh(staging_item)
    return staging_item


# ---------------------------------------------------------------------------
# BOL Report (Batch Output vs Logged) - compares Production actual batch size to Inventory finished goods
# ---------------------------------------------------------------------------

PRODUCTION_API_URL = os.environ.get("PRODUCTION_API_URL", "http://localhost:8001")
BOL_VARIANCE_THRESHOLD_PCT = 3.0  # Within ±3% is OK


@router.get("/bol-report")
async def get_bol_report(
    production_date_start: Optional[str] = None,
    production_date_end: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """
    BOL (Batch Output vs Logged) report. Compares actual batch size from Production
    (after lab test, when batch is Complete) to finished goods logged in Inventory.
    Aggregates by production_date and product/flavor. Shows variance and flags if outside ±3%.
    """
    # 1. Fetch batch output summary from Production
    try:
        params = {}
        if production_date_start:
            params["production_date_start"] = production_date_start
        if production_date_end:
            params["production_date_end"] = production_date_end
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{PRODUCTION_API_URL}/service/batch-output-summary",
                params=params,
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        logging.warning(f"BOL: Could not reach Production API: {e}")
        data = {"rows": []}

    prod_rows = data.get("rows", [])

    # 2. Get finished goods receipts from Inventory, aggregated by (production_date, product_name)
    fg_category_ids = [
        c.id for c in db.query(Category).filter(Category.parent_id == "group-finished").all()
    ]
    if not fg_category_ids:
        fg_receipts = []
    else:
        fg_receipts = (
            db.query(Receipt)
            .filter(
                Receipt.category_id.in_(fg_category_ids),
                Receipt.status.in_(["approved", "recorded", "reviewed"]),
            )
            .all()
        )

    # Aggregate receipts by (production_date_str, product_id)
    receipt_agg = {}
    product_ids_seen = set()
    for r in fg_receipts:
        pd = r.production_date
        pd_str = pd.date().isoformat() if pd else None
        if not pd_str:
            continue
        key = (pd_str, r.product_id)
        if key not in receipt_agg:
            receipt_agg[key] = {"production_date": pd_str, "product_id": r.product_id, "logged_cases": 0}
        receipt_agg[key]["logged_cases"] += float(r.quantity or 0)
        product_ids_seen.add(r.product_id)

    products_by_id = {
        p.id: p for p in db.query(Product).filter(Product.id.in_(product_ids_seen)).all()
    } if product_ids_seen else {}

    # 3. Match Production rows to Inventory data and calculate variance
    result = []
    for pr in prod_rows:
        prod_date = pr.get("production_date") or ""
        prod_name = pr.get("product_name") or "Unknown"
        total_gal = float(pr.get("total_actual_batch_size_gal") or 0)
        batch_count = int(pr.get("batch_count") or 0)

        inv_product = db.query(Product).filter(Product.name == prod_name).first()
        if not inv_product:
            inv_product = db.query(Product).filter(Product.name.ilike(f"%{prod_name}%")).first()
        gal_per_case = None
        if inv_product and inv_product.gal_per_case and inv_product.gal_per_case > 0:
            gal_per_case = float(inv_product.gal_per_case)
        else:
            gal_per_case = 4.0

        expected_cases = total_gal / gal_per_case if gal_per_case else None

        logged_cases = 0
        for (pd_str, pid), agg in receipt_agg.items():
            if pd_str != prod_date:
                continue
            p = products_by_id.get(pid)
            if not p:
                continue
            name_match = (
                (p.name == prod_name) or
                (p.name and prod_name and p.name.lower() == prod_name.lower()) or
                (p.name and prod_name and prod_name.lower() in p.name.lower()) or
                (p.name and prod_name and p.name.lower() in prod_name.lower())
            )
            if name_match or (inv_product and pid == inv_product.id):
                logged_cases += agg["logged_cases"]

        variance_pct = None
        status_flag = "no_data"
        if expected_cases is not None and expected_cases > 0:
            variance_pct = ((logged_cases - expected_cases) / expected_cases) * 100.0
            if abs(variance_pct) <= BOL_VARIANCE_THRESHOLD_PCT:
                status_flag = "ok"
            elif variance_pct < -BOL_VARIANCE_THRESHOLD_PCT:
                status_flag = "under"
            else:
                status_flag = "over"

        result.append({
            "production_date": prod_date,
            "product_name": prod_name,
            "total_actual_batch_size_gal": round(total_gal, 2),
            "batch_count": batch_count,
            "gal_per_case": gal_per_case,
            "expected_cases": round(expected_cases, 1) if expected_cases is not None else None,
            "logged_cases": round(logged_cases, 1),
            "variance_pct": round(variance_pct, 2) if variance_pct is not None else None,
            "status": status_flag,
        })

    return {"rows": result}
