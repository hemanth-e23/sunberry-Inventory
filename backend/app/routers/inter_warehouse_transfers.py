"""
Inter-warehouse transfer API.
Corporate initiates; sender warehouse confirms and ships; receiver confirms receipt.
Status flow: initiated → confirmed_by_sender → in_transit → received → completed
             (cancelled or disputed at any non-final stage)
"""
from typing import List, Optional
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, joinedload
import uuid

from app.database import get_db
from app.models import InterWarehouseTransfer, Notification, Warehouse, Product, Receipt, PalletLicence, StorageRow
from app.schemas import (
    InterWarehouseTransferCreate,
    InterWarehouseTransferAction,
    InterWarehouseTransferConfirmAction,
    InterWarehouseTransferDisputeAction,
    InterWarehouseTransferOut,
    ReceiptSummary,
)
from app.utils.auth import get_current_active_user, CORPORATE_ROLES
from app.enums import InterWarehouseStatus, ReceiptStatus
from app.services import inter_warehouse_transfer_service as iwt_service

router = APIRouter()

CORPORATE_INITIATE_ROLES = {"superadmin", "corporate_admin"}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _now():
    return datetime.now(timezone.utc)


def _notify(
    db: Session,
    warehouse_id: Optional[str],
    ntype: str,
    title: str,
    message: str,
    reference_id: str,
):
    notif = Notification(
        id=f"notif-{uuid.uuid4().hex[:12]}",
        warehouse_id=warehouse_id,
        type=ntype,
        title=title,
        message=message,
        reference_id=reference_id,
        reference_type="inter_warehouse_transfer",
        is_read=False,
    )
    db.add(notif)


def _load(db: Session, transfer_id: str) -> InterWarehouseTransfer:
    transfer = (
        db.query(InterWarehouseTransfer)
        .options(
            joinedload(InterWarehouseTransfer.from_warehouse),
            joinedload(InterWarehouseTransfer.to_warehouse),
            joinedload(InterWarehouseTransfer.product),
            joinedload(InterWarehouseTransfer.initiator),
            joinedload(InterWarehouseTransfer.source_receipt),
        )
        .filter(InterWarehouseTransfer.id == transfer_id)
        .first()
    )
    if not transfer:
        raise HTTPException(status_code=404, detail="Transfer not found")
    return transfer


def _check_warehouse_access(current_user, transfer: InterWarehouseTransfer, side: str):
    """Raise 403 if a plant user tries to act on the wrong side of a transfer."""
    wh_id = current_user.warehouse_id
    if not wh_id:
        return  # corporate — unrestricted
    if side == "sender" and wh_id != transfer.from_warehouse_id:
        raise HTTPException(status_code=403, detail="Only the sender warehouse can perform this action")
    if side == "receiver" and wh_id != transfer.to_warehouse_id:
        raise HTTPException(status_code=403, detail="Only the receiving warehouse can perform this action")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/available-products")
async def list_available_products(
    warehouse_id: str = Query(..., description="Source warehouse ID"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """List products that have available inventory at a given warehouse."""
    results = (
        db.query(Product)
        .join(Receipt, Receipt.product_id == Product.id)
        .filter(
            Receipt.warehouse_id == warehouse_id,
            Receipt.status.in_([ReceiptStatus.APPROVED, ReceiptStatus.RECORDED, ReceiptStatus.REVIEWED]),
            Receipt.quantity > 0,
            Receipt.is_deleted == False,
        )
        .distinct()
        .order_by(Product.name)
        .all()
    )
    return [{"id": p.id, "name": p.name, "fcc_code": p.fcc_code} for p in results]


@router.get("/available-receipts", response_model=List[ReceiptSummary])
async def list_available_receipts(
    warehouse_id: str = Query(..., description="Source warehouse ID"),
    product_id: str = Query(..., description="Product ID"),
    lot_number: Optional[str] = Query(None, description="Filter by lot number"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """List receipts available for inter-warehouse transfer at a given warehouse."""
    query = db.query(Receipt).filter(
        Receipt.product_id == product_id,
        Receipt.warehouse_id == warehouse_id,
        Receipt.status.in_([ReceiptStatus.APPROVED, ReceiptStatus.RECORDED, ReceiptStatus.REVIEWED]),
        Receipt.quantity > 0,
        Receipt.is_deleted == False,
    )
    if lot_number:
        query = query.filter(Receipt.lot_number == lot_number)
    return query.order_by(Receipt.receipt_date.asc()).all()


@router.get("/", response_model=List[InterWarehouseTransferOut])
async def list_transfers(
    status: Optional[str] = Query(None, description="Filter by status"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """List inter-warehouse transfers. Plant users only see their warehouse's transfers."""
    query = db.query(InterWarehouseTransfer).options(
        joinedload(InterWarehouseTransfer.from_warehouse),
        joinedload(InterWarehouseTransfer.to_warehouse),
        joinedload(InterWarehouseTransfer.product),
        joinedload(InterWarehouseTransfer.initiator),
        joinedload(InterWarehouseTransfer.source_receipt),
    )
    if current_user.warehouse_id:
        query = query.filter(
            (InterWarehouseTransfer.from_warehouse_id == current_user.warehouse_id)
            | (InterWarehouseTransfer.to_warehouse_id == current_user.warehouse_id)
        )
    if status:
        query = query.filter(InterWarehouseTransfer.status == status)
    return query.order_by(InterWarehouseTransfer.initiated_at.desc()).all()


@router.post("/", response_model=InterWarehouseTransferOut)
async def initiate_transfer(
    data: InterWarehouseTransferCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Initiate a new inter-warehouse transfer (corporate admin only)."""
    if current_user.role not in CORPORATE_INITIATE_ROLES:
        raise HTTPException(
            status_code=403,
            detail="Only corporate admin can initiate inter-warehouse transfers",
        )
    if data.from_warehouse_id == data.to_warehouse_id:
        raise HTTPException(
            status_code=400, detail="Source and destination warehouses must be different"
        )

    from_wh = db.query(Warehouse).filter(
        Warehouse.id == data.from_warehouse_id, Warehouse.is_active == True
    ).first()
    to_wh = db.query(Warehouse).filter(
        Warehouse.id == data.to_warehouse_id, Warehouse.is_active == True
    ).first()
    product = db.query(Product).filter(Product.id == data.product_id).first()

    if not from_wh:
        raise HTTPException(status_code=404, detail="Source warehouse not found")
    if not to_wh:
        raise HTTPException(status_code=404, detail="Destination warehouse not found")
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    # Validate source receipt if provided
    source_receipt_id = None
    if data.source_receipt_id:
        receipt = db.query(Receipt).filter(Receipt.id == data.source_receipt_id).first()
        if not receipt:
            raise HTTPException(status_code=404, detail="Source receipt not found")
        if receipt.warehouse_id != data.from_warehouse_id:
            raise HTTPException(status_code=400, detail="Source receipt does not belong to the sender warehouse")
        if receipt.product_id != data.product_id:
            raise HTTPException(status_code=400, detail="Source receipt product does not match")
        source_receipt_id = receipt.id

    transfer = InterWarehouseTransfer(
        id=f"iwt-{uuid.uuid4().hex[:12]}",
        from_warehouse_id=data.from_warehouse_id,
        to_warehouse_id=data.to_warehouse_id,
        product_id=data.product_id,
        lot_number=data.lot_number,
        quantity=data.quantity,
        unit=data.unit,
        source_receipt_id=source_receipt_id,
        reference_number=data.reference_number,
        expected_arrival_date=data.expected_arrival_date,
        notes=data.notes,
        initiated_by=current_user.id,
        status=InterWarehouseStatus.INITIATED,
    )
    db.add(transfer)
    db.flush()

    lot_label = data.lot_number or "any lot"
    _notify(
        db, from_wh.id, "inter_warehouse_transfer",
        f"Transfer Requested: {product.name}",
        f"Corporate has requested a transfer of {data.quantity} {data.unit} of {product.name}"
        f" (Lot: {lot_label}) to {to_wh.name}. Please confirm when ready to ship.",
        transfer.id,
    )
    _notify(
        db, to_wh.id, "inter_warehouse_transfer",
        f"Incoming Transfer: {product.name}",
        f"Corporate has initiated an incoming transfer of {data.quantity} {data.unit}"
        f" of {product.name} (Lot: {lot_label}) from {from_wh.name}."
        + (f" Expected by {data.expected_arrival_date.date()}." if data.expected_arrival_date else ""),
        transfer.id,
    )

    db.commit()
    return _load(db, transfer.id)


@router.get("/{transfer_id}", response_model=InterWarehouseTransferOut)
async def get_transfer(
    transfer_id: str,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    return _load(db, transfer_id)


@router.post("/{transfer_id}/confirm", response_model=InterWarehouseTransferOut)
async def confirm_transfer(
    transfer_id: str,
    data: InterWarehouseTransferConfirmAction = None,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Sender warehouse confirms they are ready to ship. Links source receipt."""
    transfer = _load(db, transfer_id)
    if transfer.status != InterWarehouseStatus.INITIATED:
        raise HTTPException(status_code=400, detail=f"Cannot confirm from status '{transfer.status}'")
    _check_warehouse_access(current_user, transfer, "sender")

    # Link source receipt (validate inventory availability)
    source_receipt_id = data.source_receipt_id if data else None
    receipt = iwt_service.link_source_receipt(db, transfer, source_receipt_id)

    # Validate and save pallet_licence_ids (FG)
    if data and data.pallet_licence_ids:
        pl_ids = data.pallet_licence_ids
        licences = db.query(PalletLicence).filter(
            PalletLicence.id.in_(pl_ids),
            PalletLicence.receipt_id == receipt.id,
        ).all()
        found_ids = {pl.id for pl in licences}
        missing = [pid for pid in pl_ids if pid not in found_ids]
        if missing:
            raise HTTPException(status_code=400, detail=f"Pallet licence(s) not found on this receipt: {missing}")
        not_in_stock = [pl.id for pl in licences if pl.status != "in_stock"]
        if not_in_stock:
            raise HTTPException(status_code=400, detail=f"Pallet(s) not in stock: {not_in_stock}")
        held = [pl.id for pl in licences if pl.is_held]
        if held:
            raise HTTPException(status_code=400, detail=f"Pallet(s) currently on hold: {held}")
        transfer.pallet_licence_ids = pl_ids

    # Validate and save source_breakdown (RM)
    if data and data.source_breakdown:
        breakdown = data.source_breakdown
        total = sum(float(entry.get("quantity", 0)) for entry in breakdown)
        if abs(total - transfer.quantity) > 0.01:
            raise HTTPException(
                status_code=400,
                detail=f"Source breakdown quantities ({total}) must equal transfer quantity ({transfer.quantity})"
            )
        for entry in breakdown:
            source_id = entry.get("id", "")
            if not source_id.startswith("row-"):
                raise HTTPException(status_code=400, detail=f"Invalid row ID format: {source_id}")
            row_id = source_id.removeprefix("row-")
            row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
            if not row:
                raise HTTPException(status_code=400, detail=f"Storage row not found: {row_id}")
        transfer.source_breakdown = breakdown

    transfer.status = InterWarehouseStatus.CONFIRMED_BY_SENDER
    transfer.confirmed_by = current_user.id
    transfer.confirmed_at = _now()
    if data and data.notes:
        transfer.notes = (transfer.notes or "") + f"\nSender note: {data.notes}"

    _notify(
        db, transfer.to_warehouse_id, "inter_warehouse_transfer",
        "Transfer Confirmed by Sender",
        f"{transfer.from_warehouse.name} has confirmed shipment preparation of"
        f" {transfer.quantity} {transfer.unit} of {transfer.product.name}. Awaiting dispatch.",
        transfer.id,
    )
    db.commit()
    return _load(db, transfer_id)


@router.post("/{transfer_id}/ship", response_model=InterWarehouseTransferOut)
async def ship_transfer(
    transfer_id: str,
    data: InterWarehouseTransferAction = None,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Sender marks goods as dispatched (in transit). Deducts inventory from source."""
    transfer = _load(db, transfer_id)
    if transfer.status != InterWarehouseStatus.CONFIRMED_BY_SENDER:
        raise HTTPException(status_code=400, detail=f"Cannot mark as shipped from status '{transfer.status}'")
    _check_warehouse_access(current_user, transfer, "sender")

    # Deduct inventory from source warehouse
    iwt_service.deduct_source_inventory(db, transfer)

    transfer.status = InterWarehouseStatus.IN_TRANSIT
    transfer.shipped_at = _now()
    if data and data.notes:
        transfer.notes = (transfer.notes or "") + f"\nShipping note: {data.notes}"

    _notify(
        db, transfer.to_warehouse_id, "inter_warehouse_transfer",
        "Transfer In Transit",
        f"Goods ({transfer.quantity} {transfer.unit} of {transfer.product.name}) have been"
        f" dispatched from {transfer.from_warehouse.name} and are on their way to you.",
        transfer.id,
    )
    db.commit()
    return _load(db, transfer_id)


@router.post("/{transfer_id}/receive", response_model=InterWarehouseTransferOut)
async def receive_transfer(
    transfer_id: str,
    data: InterWarehouseTransferAction = None,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Receiver warehouse confirms goods have arrived. Creates destination receipt."""
    transfer = _load(db, transfer_id)
    if transfer.status != InterWarehouseStatus.IN_TRANSIT:
        raise HTTPException(status_code=400, detail=f"Cannot receive from status '{transfer.status}'")
    _check_warehouse_access(current_user, transfer, "receiver")

    # Create receipt at destination warehouse
    iwt_service.create_destination_receipt(db, transfer, str(current_user.id))

    transfer.status = InterWarehouseStatus.RECEIVED
    transfer.received_by = current_user.id
    transfer.received_at = _now()
    transfer.actual_arrival_date = _now()
    if data and data.notes:
        transfer.notes = (transfer.notes or "") + f"\nReceiver note: {data.notes}"

    _notify(
        db, transfer.from_warehouse_id, "inter_warehouse_transfer",
        "Transfer Received",
        f"{transfer.to_warehouse.name} has confirmed receipt of {transfer.quantity}"
        f" {transfer.unit} of {transfer.product.name}.",
        transfer.id,
    )
    _notify(
        db, None, "inter_warehouse_transfer",
        "Transfer Received",
        f"Transfer of {transfer.product.name} ({transfer.quantity} {transfer.unit}) from"
        f" {transfer.from_warehouse.name} to {transfer.to_warehouse.name} has been received."
        f" Destination receipt created.",
        transfer.id,
    )
    db.commit()
    return _load(db, transfer_id)


@router.post("/{transfer_id}/complete", response_model=InterWarehouseTransferOut)
async def complete_transfer(
    transfer_id: str,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Mark transfer as fully completed (any authorised user)."""
    transfer = _load(db, transfer_id)
    if transfer.status != InterWarehouseStatus.RECEIVED:
        raise HTTPException(status_code=400, detail=f"Cannot complete from status '{transfer.status}'")

    transfer.status = InterWarehouseStatus.COMPLETED
    db.commit()
    return _load(db, transfer_id)


@router.post("/{transfer_id}/cancel", response_model=InterWarehouseTransferOut)
async def cancel_transfer(
    transfer_id: str,
    data: InterWarehouseTransferAction = None,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Cancel a transfer. Restores inventory if already shipped."""
    transfer = _load(db, transfer_id)
    if transfer.status in (InterWarehouseStatus.RECEIVED, InterWarehouseStatus.COMPLETED):
        raise HTTPException(
            status_code=400, detail=f"Cannot cancel a transfer that is '{transfer.status}'"
        )

    # Restore source inventory if it was already deducted
    iwt_service.restore_source_inventory(db, transfer)

    transfer.status = InterWarehouseStatus.CANCELLED
    if data and data.notes:
        transfer.notes = (transfer.notes or "") + f"\nCancellation reason: {data.notes}"

    _notify(
        db, transfer.from_warehouse_id, "inter_warehouse_transfer",
        "Transfer Cancelled",
        f"The transfer of {transfer.product.name} ({transfer.quantity} {transfer.unit}) has been cancelled.",
        transfer.id,
    )
    _notify(
        db, transfer.to_warehouse_id, "inter_warehouse_transfer",
        "Transfer Cancelled",
        f"The incoming transfer of {transfer.product.name} from {transfer.from_warehouse.name} has been cancelled.",
        transfer.id,
    )
    db.commit()
    return _load(db, transfer_id)


@router.post("/{transfer_id}/dispute", response_model=InterWarehouseTransferOut)
async def dispute_transfer(
    transfer_id: str,
    data: InterWarehouseTransferDisputeAction,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Receiver raises a dispute (quantity mismatch, damaged goods, etc.)."""
    transfer = _load(db, transfer_id)
    if transfer.status not in (InterWarehouseStatus.IN_TRANSIT, InterWarehouseStatus.RECEIVED):
        raise HTTPException(
            status_code=400, detail=f"Cannot dispute from status '{transfer.status}'"
        )
    _check_warehouse_access(current_user, transfer, "receiver")

    transfer.status = InterWarehouseStatus.DISPUTED
    transfer.dispute_reason = data.dispute_reason

    _notify(
        db, transfer.from_warehouse_id, "inter_warehouse_transfer",
        "Transfer Disputed",
        f"{transfer.to_warehouse.name} has raised a dispute on the transfer of"
        f" {transfer.product.name}. Reason: {data.dispute_reason}",
        transfer.id,
    )
    _notify(
        db, None, "inter_warehouse_transfer",
        "Transfer Disputed",
        f"Transfer of {transfer.product.name} from {transfer.from_warehouse.name} to"
        f" {transfer.to_warehouse.name} is disputed. Reason: {data.dispute_reason}",
        transfer.id,
    )
    db.commit()
    return _load(db, transfer_id)
