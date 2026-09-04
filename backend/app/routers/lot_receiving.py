"""Lot-level receiving: incoming orders, sticker printing, and the scan endpoints.

Mount with:
    app.include_router(lot_receiving.router, prefix="/api/lot-receiving",
                       tags=["Lot Receiving"])

**The scan endpoints must never return a 4xx for a soft question.** The offline
scan queue (`frontend/src/utils/scanQueue.js`) treats anything that is not
no-response / 5xx / 408 / 429 as terminal, writes the item to localStorage as
permanently failed and drops the driver's optimistic row. A full rack, an
unrecognised sticker, a held lot — every one of them is a 200 carrying a `status`
discriminator, and the gun decides what to say. 4xx is reserved for a request
that is genuinely malformed or a receipt that genuinely does not exist.

Auth shape, and why it differs per endpoint:
  * order create / release / close — warehouse role and up. Corporate planning is
    a CONVENTION in this codebase rather than an enforced gate (scheduled
    ship-out has no role check at all), so this follows the same floor and lets
    the UI decide who is shown the button.
  * scan / undo / resolve-row — any active user, because the role doing the
    scanning is `forklift`, which is absent from APPROVAL_ROLES and from
    require_role("admin"). Blocking it here would make the gun unusable.
  * print stickers — warehouse and up. Printing is not receiving, but an
    identical sticker applied to the wrong material is unrecoverable, so it is
    not a forklift-level action.
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.constants import ROLE_FORKLIFT
from app.database import get_db
from app.enums import IncomingOrderStatus
from app.exceptions import ForbiddenError, NotFoundError, ValidationError
from app.models import (
    IngredientIntake,
    IntakeLot,
    MaterialLot,
    Product,
    Receipt,
    User,
    Vendor,
)
from app.schemas.lot_receiving import (
    CloseOrderRequest,
    ReleaseOrderRequest,
    IncomingOrderCreate,
    IncomingOrderOut,
    LotLabelSheet,
    LotScanRequest,
    LotScanResponse,
    PrintLabelsRequest,
    ReceivingSummary,
    StartReceivingRequest,
)
from app.services import lot_placement_service as lps
from app.services import lot_receiving_service as lrs
from app.utils.auth import (
    get_current_active_user,
    resolve_warehouse_for_write,
    warehouse_filter,
)

router = APIRouter()


def require_receiver(current_user: User = Depends(get_current_active_user)) -> User:
    """Warehouse and up. Forklift plans nothing and prints nothing."""
    if current_user.role == ROLE_FORKLIFT:
        raise ForbiddenError("Forklift users cannot create or change incoming orders")
    return current_user


# ─── incoming orders ──────────────────────────────────────────────────────────

def _serialize_order(db: Session, order: IngredientIntake) -> dict:
    vendor = (
        db.query(Vendor).filter(Vendor.id == order.vendor_id).first()
        if order.vendor_id else None
    )
    lines = []
    for line in (order.lots or []):
        product = db.query(Product).filter(Product.id == line.product_id).first()
        lot = (
            db.query(MaterialLot).filter(MaterialLot.id == line.material_lot_id).first()
            if line.material_lot_id else None
        )
        receipt = (
            db.query(Receipt).filter(Receipt.id == line.receipt_id).first()
            if line.receipt_id else None
        )
        lines.append({
            "id": line.id,
            "product_id": line.product_id,
            "product_name": product.name if product else "",
            "product_sid": product.sid if product else None,
            "vendor_id": line.vendor_id or order.vendor_id,
            "vendor_lot": line.vendor_lot,
            "lot_unknown": bool(line.lot_unknown),
            "bbd": line.bbd,
            "expected_count": int(line.expected_count or 0),
            "received_count": (
                lrs.session_counts(db, receipt)["total"] if receipt else 0
            ),
            "unit_label": line.container_type,
            "weight_per_unit": line.net_weight_per_container,
            "weight_unit": line.weight_unit,
            "units_per_pallet": line.units_per_pallet,
            "brix": line.brix,
            "material_lot_id": line.material_lot_id,
            "lot_code": lot.lot_code if lot else None,
            "receipt_id": line.receipt_id,
        })

    return {
        "id": order.id,
        "order_number": order.intake_number,
        "status": order.status,
        "vendor_id": order.vendor_id,
        "vendor_name": vendor.name if vendor else None,
        "bol": order.bol,
        "purchase_order": order.purchase_order,
        "origin_name": order.origin_name,
        "origin_warehouse_id": order.origin_warehouse_id,
        "warehouse_id": order.warehouse_id,
        "expected_date": order.expected_date,
        "expected_time": order.expected_time,
        "expected_count": int(order.expected_count or 0),
        "received_count": lrs.order_received_count(db, order),
        "short_count": int(order.short_count or 0),
        "over_received": bool(order.over_received),
        "close_reason": order.close_reason,
        "notes": order.notes,
        "released_at": order.released_at,
        "closed_at": order.closed_at,
        "created_at": order.created_at,
        "lines": lines,
    }


def _require_same_warehouse(current_user: User, record, label: str) -> None:
    """Refuse to touch another warehouse's record.

    Scoping a LIST is not enough on its own: every id in this API is guessable
    from a list the user can legitimately see in another context, so a by-id
    fetch has to check membership too. Same guard, same wording, as
    routers/receipts.py's assign_storage.

    `warehouse_filter` returns None for a corporate user on "All Warehouses",
    which is deliberate — that is how corporate sees every site's inbound at
    once — so a None scope passes through.
    """
    wh_id = warehouse_filter(current_user)
    if wh_id and getattr(record, "warehouse_id", None) != wh_id:
        raise ForbiddenError(f"Cannot access a different warehouse's {label}")


def _get_order(db: Session, order_id: str, current_user: User = None) -> IngredientIntake:
    order = (
        db.query(IngredientIntake)
        .filter(
            IngredientIntake.id == order_id,
            IngredientIntake.is_incoming_order == True,  # noqa: E712
            IngredientIntake.is_deleted == False,  # noqa: E712
        )
        .first()
    )
    if not order:
        raise NotFoundError("Incoming order", order_id)
    if current_user is not None:
        _require_same_warehouse(current_user, order, "incoming order")
    return order


@router.get("/orders", response_model=List[IncomingOrderOut])
def list_orders(
    status: Optional[str] = Query(None),
    include_closed: bool = Query(False),
    date: Optional[str] = Query(
        None, description="YYYY-MM-DD. Orders expected that day, plus every draft."
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Orders headed for the warehouse in view.

    Scoped through `warehouse_filter`, which returns None for a corporate user on
    "All Warehouses" — that is deliberate, it is how corporate sees every site's
    inbound at once.

    `date` organises the plant's screen by day, the same way the outbound tab
    works. DRAFTS ARE ALWAYS INCLUDED regardless of the day: a draft has no
    arrival slot yet — that is the whole point of it being a draft — so filtering
    it by date would hide corporate's own to-do list from them on every day view.
    """
    query = db.query(IngredientIntake).filter(
        IngredientIntake.is_incoming_order == True,  # noqa: E712
        IngredientIntake.is_deleted == False,  # noqa: E712
    )
    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.filter(IngredientIntake.warehouse_id == wh_id)
    if status:
        query = query.filter(IngredientIntake.status == status)
    elif not include_closed:
        query = query.filter(
            IngredientIntake.status.in_((
                IncomingOrderStatus.DRAFT.value,
                IncomingOrderStatus.IN_TRANSIT.value,
                IncomingOrderStatus.RECEIVING.value,
            ))
        )

    if date:
        from datetime import datetime as _dt, timedelta, timezone as _tz

        try:
            day = _dt.strptime(date, "%Y-%m-%d").replace(tzinfo=_tz.utc)
        except ValueError:
            raise ValidationError("date must be YYYY-MM-DD")
        # Half-open range on the stored instant. expected_date is written as
        # midnight UTC (see schemas/base.py), so comparing against a UTC window
        # is exact — a `func.date()` cast would be evaluated in the SESSION
        # timezone and would silently pick up the neighbouring day.
        query = query.filter(
            or_(
                and_(
                    IngredientIntake.expected_date >= day,
                    IngredientIntake.expected_date < day + timedelta(days=1),
                ),
                IngredientIntake.status == IncomingOrderStatus.DRAFT.value,
            )
        )

    orders = query.order_by(IngredientIntake.created_at.desc()).limit(500).all()
    return [_serialize_order(db, o) for o in orders]


@router.get("/orders/{order_id}", response_model=IncomingOrderOut)
def get_order(
    order_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    return _serialize_order(db, _get_order(db, order_id, current_user))


@router.post("/orders", response_model=IncomingOrderOut)
def create_order(
    payload: IncomingOrderCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_receiver),
):
    """One order per destination site.

    `resolve_warehouse_for_write`, not `warehouse_filter` — the latter returns
    None for a corporate user on "All Warehouses" and would create an order with
    a NULL warehouse_id that is then invisible in every scoped list.
    """
    wh_id = resolve_warehouse_for_write(current_user)
    order = lrs.create_incoming_order(
        db, payload.model_dump(), user_id=str(current_user.id), warehouse_id=wh_id
    )
    db.commit()
    db.refresh(order)
    return _serialize_order(db, order)


@router.post("/orders/{order_id}/release", response_model=IncomingOrderOut)
def release(
    order_id: str,
    payload: ReleaseOrderRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_receiver),
):
    """Draft -> in transit, with the arrival slot.

    A separate step from creating: corporate raises the order when they have the
    PO, and agrees the slot with the carrier afterwards.
    """
    order = lrs.release_order(
        db, _get_order(db, order_id, current_user),
        user_id=str(current_user.id),
        expected_date=payload.expected_date,
        expected_time=payload.expected_time,
    )
    db.commit()
    db.refresh(order)
    return _serialize_order(db, order)


@router.post("/orders/{order_id}/close", response_model=IncomingOrderOut)
def close(
    order_id: str,
    payload: CloseOrderRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_receiver),
):
    """Close the order. Short closes require a reason — see the service."""
    order = lrs.close_order(
        db, _get_order(db, order_id, current_user), user_id=str(current_user.id), reason=payload.reason
    )
    db.commit()
    db.refresh(order)
    return _serialize_order(db, order)


@router.post("/orders/{order_id}/cancel", response_model=IncomingOrderOut)
def cancel(
    order_id: str,
    payload: CloseOrderRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_receiver),
):
    order = lrs.cancel_order(
        db, _get_order(db, order_id, current_user), user_id=str(current_user.id), reason=payload.reason
    )
    db.commit()
    db.refresh(order)
    return _serialize_order(db, order)


@router.post("/orders/{order_id}/start-receiving", response_model=ReceivingSummary)
def start_receiving(
    order_id: str,
    payload: StartReceivingRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_receiver),
):
    """Open one line and begin. Creates the receipt and resolves the lot.

    Warehouse role and up, NOT forklift. This is not a scan: it creates the
    paperwork, mints the lot identity, and writes back the corrected vendor lot,
    BBD and weight-per-unit — the last of which is the single number every
    derived pound in the system comes from. Checking a driver's BOL against
    corporate's order is desk work, and the gun holds the weakest credential in
    the building.

    Idempotent: a line already being received returns its existing receipt, so a
    worker who backs out and comes in again resumes rather than starting a second
    session against the same drums.
    """
    order = _get_order(db, order_id, current_user)
    line = db.query(IntakeLot).filter(IntakeLot.id == payload.line_id).first()
    if not line:
        raise NotFoundError("Order line", payload.line_id)

    overrides = {
        k: v for k, v in payload.model_dump(exclude={"line_id"}).items() if v is not None
    }
    receipt = lrs.start_receiving(
        db, order, line, user_id=str(current_user.id), overrides=overrides
    )
    summary = lrs.receiving_summary(db, receipt)
    db.commit()
    return summary


# ─── the receiving session ────────────────────────────────────────────────────

def _get_receipt(db: Session, receipt_id: str, current_user: User = None) -> Receipt:
    receipt = (
        db.query(Receipt)
        .filter(Receipt.id == receipt_id, Receipt.is_deleted == False)  # noqa: E712
        .first()
    )
    if not receipt:
        raise NotFoundError("Receipt", receipt_id)
    if current_user is not None:
        _require_same_warehouse(current_user, receipt, "receipt")
    return receipt


@router.get("/sessions", response_model=List[ReceivingSummary])
def list_sessions(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Everything the gun can pick up, from BOTH paths, in one list.

    A worker does not care whether corporate raised an order or somebody logged a
    walk-in off the driver's BOL — they care that there is material to scan in.
    """
    return lrs.open_sessions(db, warehouse_id=warehouse_filter(current_user))


@router.get("/sessions/{receipt_id}", response_model=ReceivingSummary)
def get_session(
    receipt_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Paperwork vs scanned, per row. Also what the gun resumes from."""
    return lrs.receiving_summary(db, _get_receipt(db, receipt_id, current_user))


@router.post("/sessions/{receipt_id}/scan", response_model=LotScanResponse)
def scan(
    receipt_id: str,
    payload: LotScanRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """+1 unit of a lot into a rack.

    ALWAYS 200 for a scan the system understood, whatever the answer. Read the
    module docstring before adding a raise here.
    """
    # The warehouse check is a 403, and that is correct even here: a session in
    # another warehouse is not a soft question about this scan, it is a request
    # the user is not entitled to make. A gun can only ever reach a session id it
    # was shown by the scoped list.
    _get_receipt(db, receipt_id, current_user)
    result = lrs.scan_unit(
        db,
        receipt_id=receipt_id,
        lot_code=payload.lot_code,
        storage_row_id=payload.storage_row_id,
        user_id=str(current_user.id),
        idempotency_key=payload.idempotency_key,
        allow_overfill=payload.allow_overfill,
        units=payload.units,
    )
    db.commit()
    return result


@router.post("/sessions/{receipt_id}/undo", response_model=LotScanResponse)
def undo(
    receipt_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Take the last unit back off.

    Identical stickers make client-side dedupe impossible, so "I think that
    double-counted" needs a real answer rather than a supervisor correction the
    next day.
    """
    _get_receipt(db, receipt_id, current_user)
    result = lrs.undo_last_scan(db, receipt_id=receipt_id, user_id=str(current_user.id))
    db.commit()
    return result


@router.post("/sessions/{receipt_id}/print-labels", response_model=LotLabelSheet)
def print_labels(
    receipt_id: str,
    payload: PrintLabelsRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_receiver),
):
    """`count` identical stickers for this receipt's lot.

    Printing is NOT receiving. This writes no placement and creates no stock —
    material becomes stock when somebody scans it into a rack. It does resolve
    the lot if the receipt has none yet, which is what makes the walk-in path
    work: log the receipt off the BOL, press Print, scan.
    """
    receipt = _get_receipt(db, receipt_id, current_user)
    lot = lrs.ensure_lot_for_receipt(
        db,
        receipt,
        user_id=str(current_user.id),
        # Carries "50 bags to a pallet" from the entry form onto the lot, which
        # is what lets a PALLET-scope sticker be printed at all. Without it a
        # Log Receipt of 500 bags could only ever print 500 bag stickers.
        units_per_pallet=receipt.units_per_pallet,
    )
    sheet = lrs.label_sheet_for_lot(
        db, lot, payload.count, receipt=receipt, scope=payload.scope
    )
    db.commit()
    return sheet


@router.post("/lots/{lot_id}/print-labels", response_model=LotLabelSheet)
def print_labels_for_lot(
    lot_id: str,
    payload: PrintLabelsRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_receiver),
):
    """Stickers for a lot on demand, with no receiving session.

    This is the cutover's third step: existing stock sits unstickered with a known
    count, and stickers are printed and applied lazily — at first staging, or here
    for a slow-moving lot that would otherwise sit unstickered for months.
    """
    lot = (
        db.query(MaterialLot)
        .filter(MaterialLot.id == lot_id, MaterialLot.is_deleted == False)  # noqa: E712
        .first()
    )
    if not lot:
        raise NotFoundError("Material lot", lot_id)
    # A lot carries the warehouse it was first received into. Stickers for
    # another site's material are not this user's to print.
    _require_same_warehouse(current_user, lot, "lot")
    sheet = lrs.label_sheet_for_lot(db, lot, payload.count, scope=payload.scope)
    db.commit()
    return sheet


@router.get("/received-into")
def received_into(
    product_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Which rack each DELIVERY of this product was put away on.

    One request for the whole product rather than one per receipt: the caller
    is a table of receipts, and N round trips to fill one column is how a modal
    becomes slow.

    Replayed from the event ledger — see `received_into_by_receipt` for why the
    projection cannot answer it.
    """
    return lps.received_into_by_receipt(db, product_id)


@router.get("/resolve-row")
def resolve_row_endpoint(
    code: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """A scanned rack label -> exactly one row.

    Refuses an ambiguous name rather than picking one. Row names are not unique —
    two barns can each hold an "A-12" — and under lot identity a wrong row cannot
    be untangled afterwards, because every drum on both racks wears the same
    sticker.
    """
    return lrs.resolve_scanned_row(db, current_user, code)


@router.get("/lots/lookup")
def lookup_lot(
    code: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """What a sticker says, without recording anything.

    The production app calls this to derive the SID before a batch scan, and the
    gun calls it to show the worker what they are holding.
    """
    lot = lrs.resolve_lot_code(db, code)
    if not lot:
        raise NotFoundError("Lot", code)
    product = db.query(Product).filter(Product.id == lot.product_id).first()
    vendor = (
        db.query(Vendor).filter(Vendor.id == lot.vendor_id).first()
        if lot.vendor_id else None
    )
    on_hand = lrs.lps.units_on_hand(db, lot.id)
    return {
        "lot_id": lot.id,
        "lot_code": lot.lot_code,
        "product_id": lot.product_id,
        "product_name": product.name if product else "",
        "product_sid": product.sid if product else None,
        "vendor_id": lot.vendor_id,
        "vendor_name": vendor.name if vendor else "",
        "vendor_lot": lot.vendor_lot_number,
        "lot_unknown": bool(lot.lot_unknown),
        "bbd": lot.bbd_current,
        "bbd_original": lot.bbd_original,
        "unit_label": lot.unit_label,
        "weight_per_unit": lot.weight_per_unit,
        "weight_unit": lot.weight_unit,
        "is_held": bool(lot.is_held),
        "hold_reason": lot.hold_reason,
        "needs_review": bool(lot.needs_review),
        "full_units": on_hand["full_units"],
        "open_units": on_hand["open_units"],
        "row_count": on_hand["row_count"],
    }
