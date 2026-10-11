"""Finished-goods pallet lifecycle helpers (FG-PALLET-LIFECYCLE-SPEC.md).

One place for the things every FG path now needs:

- `record_event`  — append a PalletEvent (who / when / why) for any status a
  person or the shuttle puts on a pallet outside scan → approve → ship.
- `restore_to_stock` — a MISSING / NOT_PRODUCED / CANCELLED pallet that turns up
  again goes back IN_STOCK in a row and back onto its lot's receipt. Used by the
  ship-out scans, the gun cycle check and Find Pallet, so "found" is the same
  operation wherever the pallet is found.
- `shipped_detail` / `not_produced_detail` — the human sentence for "this pallet
  already left" and "this was marked not produced", built from the pallet's
  transfer and scan events, so every rejection names the order / trailer, the
  date and who scanned it.

Callers own commit/rollback.
"""
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app.constants import (
    CATEGORY_FINISHED, DAYS_PER_YEAR, DEFAULT_CASES_PER_PALLET, DEFAULT_EXPIRE_YEARS,
    TRANSFER_TYPE_MOYEL_SHUTTLE,
)
from app.enums import PalletEventType, PalletStatus, ReceiptStatus
from app.models import (
    Category, InventoryTransfer, PalletEvent, PalletLicence, Product, Receipt,
    StorageRow, TransferScanEvent, User,
)
from app.utils.warehouse_time import warehouse_timezone, zone

# Statuses a later scan resolves instead of refusing (§1.2, §2.1): the pallet
# exists physically, the books just lost it. EMPTIED is deliberately NOT here:
# a pallet case-adjusted to 0 stays at 0 and every scan path refuses it with
# `emptied_detail`.
FOUNDABLE_STATUSES = (
    PalletStatus.MISSING.value,
    PalletStatus.NOT_PRODUCED.value,
    PalletStatus.CANCELLED.value,
)


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _user_id(user) -> Optional[str]:
    return str(user.id) if user is not None and getattr(user, "id", None) is not None else None


def record_event(
    db: Session,
    pallet: Optional[PalletLicence],
    event_type: str,
    *,
    user=None,
    licence_number: Optional[str] = None,
    from_status: Optional[str] = None,
    to_status: Optional[str] = None,
    reason_code: Optional[str] = None,
    reason: Optional[str] = None,
    cases_before: Optional[int] = None,
    cases_after: Optional[int] = None,
    storage_row_id: Optional[str] = None,
    ref_type: Optional[str] = None,
    ref_id: Optional[str] = None,
) -> PalletEvent:
    ev = PalletEvent(
        id=_new_id("pev"),
        pallet_licence_id=pallet.id if pallet is not None else None,
        licence_number=licence_number or (pallet.licence_number if pallet is not None else None),
        event_type=event_type.value if hasattr(event_type, "value") else event_type,
        from_status=from_status,
        to_status=to_status if to_status is not None else (pallet.status if pallet is not None else None),
        reason_code=reason_code,
        reason=reason,
        cases_before=cases_before,
        cases_after=cases_after,
        storage_row_id=storage_row_id if storage_row_id is not None else (
            pallet.storage_row_id if pallet is not None else None
        ),
        ref_type=ref_type,
        ref_id=ref_id,
        user_id=_user_id(user),
        warehouse_id=pallet.warehouse_id if pallet is not None else None,
        created_at=datetime.now(timezone.utc),
    )
    db.add(ev)
    return ev


# ---------------------------------------------------------------------------
# Human-readable details
# ---------------------------------------------------------------------------

def _tz_for(db: Session, warehouse_id: Optional[str]) -> ZoneInfo:
    return zone(warehouse_timezone(db, warehouse_id))


def fmt_local(db: Session, dt: Optional[datetime], warehouse_id: Optional[str]) -> str:
    """M/D/YYYY h:mm AM in the warehouse's timezone — for messages only."""
    if not dt:
        return "an unknown date"
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    local = dt.astimezone(_tz_for(db, warehouse_id))
    hour = local.hour % 12 or 12
    ampm = "AM" if local.hour < 12 else "PM"
    return f"{local.month}/{local.day}/{local.year} {hour}:{local.minute:02d} {ampm}"


def _user_name(db: Session, user_id: Optional[str]) -> Optional[str]:
    if not user_id:
        return None
    u = db.query(User).filter(User.id == user_id).first()
    return (u.name or u.username) if u else None


def shipped_info(db: Session, pl: PalletLicence) -> dict:
    """Where a SHIPPED pallet went: order / trailer, customer, when, who."""
    t = (
        db.query(InventoryTransfer).filter(InventoryTransfer.id == pl.transfer_id).first()
        if pl.transfer_id else None
    )
    scan = (
        db.query(TransferScanEvent)
        .filter(TransferScanEvent.licence_id == pl.id, TransferScanEvent.on_list == True)  # noqa: E712
        .order_by(TransferScanEvent.scanned_at.desc())
        .first()
    )
    is_shuttle = bool(t and t.transfer_type == TRANSFER_TYPE_MOYEL_SHUTTLE)
    when = None
    who = None
    if scan is not None:
        when, who = scan.scanned_at, scan.scanned_by
    if t is not None and when is None:
        when = t.time_out or t.approved_at or t.docs_generated_at or t.created_at
        who = t.approved_by or t.requested_by
    customer = None
    if t is not None and t.ship_to_location is not None:
        customer = t.ship_to_location.customer_name
    return {
        "transfer_id": t.id if t else None,
        "is_shuttle": is_shuttle,
        "order_number": t.order_number if t else None,
        "trailer_number": t.trailer_number if t else None,
        "customer": customer,
        "at": when,
        "by_id": who,
        "by": _user_name(db, who),
    }


def shipped_detail(db: Session, pl: PalletLicence) -> str:
    """'already shipped on order SO-1 (COSTCO), 10/2/2026 9:14 AM, scanned by Joe'."""
    info = shipped_info(db, pl)
    label = pl.licence_number or pl.id
    when = fmt_local(db, info["at"], pl.warehouse_id)
    if info["is_shuttle"]:
        return f"Pallet {label} already left on Moyel shuttle trailer {info['trailer_number'] or '?'}, {when}"
    if not info["transfer_id"]:
        return f"Pallet {label} is already shipped"
    order = info["order_number"] or info["transfer_id"]
    parts = [f"Pallet {label} already shipped on order {order}"]
    if info["customer"]:
        parts[0] += f" ({info['customer']})"
    parts.append(when)
    if info["by"]:
        parts.append(f"scanned by {info['by']}")
    return ", ".join(parts)


def shipped_label(db: Session, pl: PalletLicence) -> str:
    """Short badge for the forklift review: '🚚 Moyel shuttle · trailer 12'."""
    info = shipped_info(db, pl)
    if info["is_shuttle"]:
        return f"🚚 Moyel shuttle · trailer {info['trailer_number'] or '?'}"
    order = info["order_number"] or info["transfer_id"] or "?"
    who = f" by {info['by']}" if info["by"] else ""
    return f"🚚 Shipped on {order}{who}, {fmt_local(db, info['at'], pl.warehouse_id)}"


def last_event(db: Session, pl: PalletLicence, event_type: str) -> Optional[PalletEvent]:
    return (
        db.query(PalletEvent)
        .filter(PalletEvent.pallet_licence_id == pl.id, PalletEvent.event_type == event_type)
        .order_by(PalletEvent.created_at.desc())
        .first()
    )


def not_produced_detail(db: Session, pl: PalletLicence) -> str:
    """'#045 was marked Not Produced by Ann on 10/2/2026 — now scanned'."""
    ev = last_event(db, pl, PalletEventType.NOT_PRODUCED.value)
    seq = f"#{int(pl.sequence):03d}" if pl.sequence is not None else (pl.licence_number or "This pallet")
    if ev is None:
        return f"{seq} was marked Not Produced — now scanned"
    who = _user_name(db, ev.user_id) or "someone"
    return f"{seq} was marked Not Produced by {who} on {fmt_local(db, ev.created_at, pl.warehouse_id)} — now scanned"


def emptied_detail(db: Session, pl: PalletLicence) -> str:
    """'#045 was emptied to 0 cases by Ann on 10/2/2026 9:14 AM (damaged) —
    it stays at 0 and can't be scanned back in'. Built from the CASE_ADJUSTED
    event that took it to 0; every scan path refuses an EMPTIED pallet with it."""
    ev = (
        db.query(PalletEvent)
        .filter(
            PalletEvent.pallet_licence_id == pl.id,
            PalletEvent.event_type == PalletEventType.CASE_ADJUSTED.value,
            PalletEvent.cases_after == 0,
        )
        .order_by(PalletEvent.created_at.desc())
        .first()
    )
    seq = f"#{int(pl.sequence):03d}" if pl.sequence is not None else (pl.licence_number or "This pallet")
    label = seq
    tail = " — it stays at 0 and can't be scanned back in"
    if ev is None:
        return f"{label} was emptied to 0 cases{tail}"
    who = _user_name(db, ev.user_id) or "someone"
    why = ev.reason or (ev.reason_code or "").replace("_", " ")
    why = f" ({why})" if why else ""
    return f"{label} was emptied to 0 cases by {who} on {fmt_local(db, ev.created_at, pl.warehouse_id)}{why}{tail}"


# ---------------------------------------------------------------------------
# Back into stock
# ---------------------------------------------------------------------------

def _lot_dates(product: Optional[Product], lot_number: str):
    from app.services.scanner_service import parse_production_date_from_lot
    prod_date = parse_production_date_from_lot(lot_number) or datetime.now(timezone.utc)
    years = (product.expire_years if product and product.expire_years else DEFAULT_EXPIRE_YEARS)
    return prod_date, prod_date + timedelta(days=DAYS_PER_YEAR * years)


def receipt_for_lot(db: Session, pl: PalletLicence, user=None) -> Receipt:
    """The receipt a pallet of this lot+product belongs on. Re-uses the lot's
    existing FG receipt (most recent first); creates an approved, empty one
    when the lot has none yet (a not-produced or never-scanned pallet that
    turns up before its lot was ever approved)."""
    if pl.receipt_id:
        r = db.query(Receipt).filter(Receipt.id == pl.receipt_id).first()
        if r is not None:
            return r
    q = db.query(Receipt).filter(
        Receipt.product_id == pl.product_id,
        Receipt.lot_number == pl.lot_number,
        Receipt.status.in_((ReceiptStatus.APPROVED.value, ReceiptStatus.DEPLETED.value)),
        Receipt.is_deleted == False,  # noqa: E712
    )
    if pl.warehouse_id:
        q = q.filter(Receipt.warehouse_id == pl.warehouse_id)
    r = q.order_by(Receipt.created_at.desc()).first()
    if r is not None:
        return r

    from app.services.scanner_service import _resolve_production_line
    product = db.query(Product).filter(Product.id == pl.product_id).first()
    category = (
        db.query(Category).filter(Category.id == product.category_id).first() if product else None
    )
    prod_date, exp_date = _lot_dates(product, pl.lot_number or "")
    now = datetime.now(timezone.utc)
    r = Receipt(
        id=f"rcpt-{int(now.timestamp() * 1000)}-{uuid.uuid4().hex[:8]}",
        product_id=pl.product_id,
        category_id=category.id if category else None,
        lot_number=pl.lot_number,
        quantity=0,
        unit="cases",
        production_date=prod_date,
        expiration_date=exp_date,
        receipt_date=now,
        cases_per_pallet=(product.default_cases_per_pallet if product else None) or DEFAULT_CASES_PER_PALLET,
        full_pallets=0,
        partial_cases=0,
        quantity_produced=0,
        line_id=_resolve_production_line(db, pl.lot_number) if pl.lot_number else None,
        status=ReceiptStatus.APPROVED.value,
        submitted_by=_user_id(user),
        approved_by=_user_id(user),
        approved_at=now,
        submitted_at=now,
        allocation={"success": True, "plan": [], "totalCases": 0, "totalPallets": 0},
        warehouse_id=pl.warehouse_id,
        note="Created when a pallet with no receipt was found (FG pallet lifecycle).",
    )
    db.add(r)
    db.flush()
    return r


def restore_to_stock(
    db: Session,
    pl: PalletLicence,
    *,
    row: Optional[StorageRow],
    user,
    reason: Optional[str] = None,
    ref_type: Optional[str] = None,
    ref_id: Optional[str] = None,
) -> PalletEvent:
    """Put a MISSING / NOT_PRODUCED / CANCELLED pallet back IN_STOCK.

    - row: where it was found (None keeps its last known row).
    - The receipt is re-credited with the pallet's cases. A pallet that never
      counted as produced (not_produced, cancelled from a rejected session)
      also counts toward the receipt's produced total.
    - Row counters gain the pallet (it was released when it went missing).
    Returns the FOUND / NOT_PRODUCED_SCANNED / REVIVED event it recorded.
    """
    from app.services.ship_out_service import _add_to_row
    from app.services.transfer_service import _rebuild_receipt_allocation_from_licences

    prev = pl.status
    if prev not in FOUNDABLE_STATUSES:
        raise ValueError(f"restore_to_stock: pallet {pl.licence_number} is {prev}")

    product = db.query(Product).filter(Product.id == pl.product_id).first()
    cases_before = pl.cases
    if not pl.cases:
        # Not-produced markers carry 0 cases; a real pallet carries a full one.
        pl.cases = (product.default_cases_per_pallet if product else None) or DEFAULT_CASES_PER_PALLET
        pl.is_partial = False

    # Was this pallet ever in the receipt's produced total? A MISSING pallet
    # was (it was in stock); a not-produced marker or a rejected-session
    # leftover was not.
    was_counted = prev == PalletStatus.MISSING.value or (
        prev == PalletStatus.CANCELLED.value and bool(pl.receipt_id)
    )
    receipt = receipt_for_lot(db, pl, user)
    pl.receipt_id = receipt.id
    receipt.quantity = float(receipt.quantity or 0) + float(pl.cases or 0)
    if not was_counted:
        receipt.quantity_produced = float(receipt.quantity_produced or 0) + float(pl.cases or 0)
    if receipt.status == ReceiptStatus.DEPLETED.value and receipt.quantity > 0:
        receipt.status = ReceiptStatus.APPROVED.value

    if row is not None:
        pl.storage_row_id = row.id
        pl.storage_area_id = row.storage_area_id
    pl.status = PalletStatus.IN_STOCK.value
    pl.transfer_id = None
    pl.is_deleted = False
    pl.deleted_at = None
    pl.deleted_by_id = None
    if pl.warehouse_id is None:
        pl.warehouse_id = receipt.warehouse_id
    target_row = row or (
        db.query(StorageRow).filter(StorageRow.id == pl.storage_row_id).first()
        if pl.storage_row_id else None
    )
    if target_row is not None:
        _add_to_row(target_row, pl, float(pl.cases or 0))
    db.flush()
    _rebuild_receipt_allocation_from_licences(db, receipt)

    event_type = {
        PalletStatus.MISSING.value: PalletEventType.FOUND,
        PalletStatus.NOT_PRODUCED.value: PalletEventType.NOT_PRODUCED_SCANNED,
        PalletStatus.CANCELLED.value: PalletEventType.REVIVED,
    }[prev]
    return record_event(
        db, pl, event_type, user=user, from_status=prev, to_status=pl.status,
        reason=reason, cases_before=cases_before, cases_after=pl.cases,
        ref_type=ref_type, ref_id=ref_id,
    )


def found_message(db: Session, pl: PalletLicence, prev_status: str) -> str:
    if prev_status == PalletStatus.NOT_PRODUCED.value:
        return not_produced_detail(db, pl)
    if prev_status == PalletStatus.CANCELLED.value:
        return f"Pallet {pl.licence_number} had been written off — back in stock"
    return f"Found missing pallet {pl.licence_number}"


def is_finished_good(db: Session, product_id: Optional[str]) -> bool:
    if not product_id:
        return False
    p = db.query(Product).filter(Product.id == product_id).first()
    if not p:
        return False
    c = db.query(Category).filter(Category.id == p.category_id).first()
    return bool(c and c.type == CATEGORY_FINISHED)
