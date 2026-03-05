from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import func, and_
from datetime import datetime, timezone
import json
import uuid
import copy
import logging

from app.database import get_db
from app.models import (
    Receipt, InventoryTransfer, StorageArea, StorageRow, User, Category,
    PalletLicence, TransferScanEvent
)
from app.schemas import (
    InventoryTransfer as InventoryTransferSchema, InventoryTransferCreate, InventoryTransferUpdate,
    ShipOutPickListCreate, ScanPickRequest, ForkliftSubmitRequest,
)
from app.utils.auth import get_current_active_user, warehouse_filter
from app.enums import TransferStatus, PalletStatus, ReceiptStatus
from app.services import transfer_service
from app.constants import ROLE_FORKLIFT, ROLE_WAREHOUSE

router = APIRouter()


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
    if current_user.role == ROLE_FORKLIFT:
        raise HTTPException(
            status_code=403,
            detail="Forklift role does not have access to the transfer list"
        )

    query = db.query(InventoryTransfer)

    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.filter(InventoryTransfer.warehouse_id == wh_id)

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
    transfer_id = f"transfer-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"

    db_transfer = InventoryTransfer(
        id=transfer_id,
        **transfer_dict,
        requested_by=str(current_user.id),
        warehouse_id=current_user.warehouse_id,
        status=TransferStatus.PENDING
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
        PalletLicence.status == PalletStatus.IN_STOCK
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

    transfer_id = f"transfer-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
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
        warehouse_id=current_user.warehouse_id,
        status=TransferStatus.PENDING
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
    if transfer.status != TransferStatus.PENDING:
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
        event_id = f"scan-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
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
    event_id = f"scan-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
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
    if transfer.status not in (TransferStatus.PENDING,):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Transfer cannot be submitted in its current state")

    transfer.forklift_submitted_at = datetime.now(timezone.utc)
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
    if current_user.role == ROLE_WAREHOUSE and transfer.requested_by != str(current_user.id):
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

    transfer_service.approve_transfer(db, transfer, current_user)
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

    transfer_service.reject_transfer(db, transfer, reason, current_user)
    db.commit()
    db.refresh(transfer)

    return {"message": "Transfer rejected successfully", "transfer": transfer}
