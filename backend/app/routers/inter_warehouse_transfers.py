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
from app.models import InterWarehouseTransfer, Notification, Warehouse, Product
from app.schemas import (
    InterWarehouseTransferCreate,
    InterWarehouseTransferAction,
    InterWarehouseTransferDisputeAction,
    InterWarehouseTransferOut,
)
from app.utils.auth import get_current_active_user, CORPORATE_ROLES
from app.enums import InterWarehouseStatus

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

    transfer = InterWarehouseTransfer(
        id=f"iwt-{uuid.uuid4().hex[:12]}",
        from_warehouse_id=data.from_warehouse_id,
        to_warehouse_id=data.to_warehouse_id,
        product_id=data.product_id,
        lot_number=data.lot_number,
        quantity=data.quantity,
        unit=data.unit,
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
    data: InterWarehouseTransferAction = None,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Sender warehouse confirms they are ready to ship."""
    transfer = _load(db, transfer_id)
    if transfer.status != InterWarehouseStatus.INITIATED:
        raise HTTPException(status_code=400, detail=f"Cannot confirm from status '{transfer.status}'")
    _check_warehouse_access(current_user, transfer, "sender")

    transfer.status = "confirmed_by_sender"
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
    """Sender marks goods as dispatched (in transit)."""
    transfer = _load(db, transfer_id)
    if transfer.status != "confirmed_by_sender":
        raise HTTPException(status_code=400, detail=f"Cannot mark as shipped from status '{transfer.status}'")
    _check_warehouse_access(current_user, transfer, "sender")

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
    """Receiver warehouse confirms goods have arrived."""
    transfer = _load(db, transfer_id)
    if transfer.status != InterWarehouseStatus.IN_TRANSIT:
        raise HTTPException(status_code=400, detail=f"Cannot receive from status '{transfer.status}'")
    _check_warehouse_access(current_user, transfer, "receiver")

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
        f" {transfer.unit} of {transfer.product.name}. Please update your inventory records.",
        transfer.id,
    )
    # Notify corporate (NULL warehouse = all corporate users)
    _notify(
        db, None, "inter_warehouse_transfer",
        "Transfer Received",
        f"Transfer of {transfer.product.name} ({transfer.quantity} {transfer.unit}) from"
        f" {transfer.from_warehouse.name} to {transfer.to_warehouse.name} has been received.",
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

    transfer.status = "completed"
    db.commit()
    return _load(db, transfer_id)


@router.post("/{transfer_id}/cancel", response_model=InterWarehouseTransferOut)
async def cancel_transfer(
    transfer_id: str,
    data: InterWarehouseTransferAction = None,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Cancel a transfer (not allowed once in transit or later)."""
    transfer = _load(db, transfer_id)
    if transfer.status in (InterWarehouseStatus.IN_TRANSIT, InterWarehouseStatus.RECEIVED, "completed"):
        raise HTTPException(
            status_code=400, detail=f"Cannot cancel a transfer that is '{transfer.status}'"
        )

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
