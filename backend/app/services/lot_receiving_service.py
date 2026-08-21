"""Receiving under lot-level identity — the corporate order path and the walk-in path.

Both paths end in the SAME place, which is the point:

    a Receipt (the paperwork)  +  a MaterialLot (the identity)  +  LotPlacements (the count)

**Path 1 — corporate order.** Corporate creates one incoming order per
destination site: product, vendor, vendor lot, BBD, expected unit count.
Multi-product and multi-lot, because one truck carries mango and guava. At the
plant a worker opens it, checks the driver's BOL, fills anything corporate left
blank, prints stickers, then scans a row and scans every unit into it.

**Path 2 — walk-in.** Material arrives with no order. The worker uses the
EXISTING Log Receipt screen, enters what the BOL says, saves, then prints
stickers and scans exactly the same way. The dock is never blocked waiting for
corporate, and the receipt is flagged for their review afterwards.

Three rules that shaped this module:

* **Printing is not receiving.** A printed sticker is paper. Material becomes
  stock when somebody scans it into a row, and not one moment earlier. This is
  why `label_sheet` writes no placement and `ensure_lot_for_receipt` is safe to
  call from a print button.

* **Every soft question is a 200.** A full row, an unknown sticker, a lot on
  hold, more units than the paperwork says — all of them come back as a 200 with
  a `status` discriminator. A 4xx makes the offline scan queue mark the item
  permanently failed (`scanQueue.js` classifies anything that is not
  no-response/5xx/408/429 as terminal) and the driver's scan is lost with no way
  to retry it.

* **The idempotency check runs FIRST.** Before the session-state gate, before
  the row lookup, before anything. A scan that succeeded, lost its response and
  is retried after the session closed must return its original result — the
  write already landed. `scanner_service.scan_pallet` gets this order wrong and
  turns a successful scan into a permanently-failed queue item.
"""

import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.enums import (
    INCOMING_RECEIVABLE_STATUSES,
    IncomingOrderStatus,
    ReceiptStatus,
)
from app.exceptions import ConflictError, NotFoundError, ValidationError
from app.models import (
    IngredientIntake,
    IntakeLot,
    LotPlacement,
    LotPlacementEvent,
    MaterialLot,
    Product,
    Receipt,
    StorageRow,
    Vendor,
)
from app.services import lot_placement_service as lps
from app.services.ingredient_row_service import resolve_row

# Scans that belong to a receiving session, so undo and the per-session counters
# can find them without walking the whole ledger.
REF_TYPE_RECEIVING = "receiving"


def _mint_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def unit_word(lot: Optional[MaterialLot], count: int = 2) -> str:
    """'drum' / 'drums'. NEVER 'cases'.

    `Receipt.unit` defaults to "cases", and that default is exactly how an
    80-barrel receipt once came to render as "80 cases". The word comes from the
    lot's own `unit_label` or not at all.
    """
    label = (lot.unit_label if lot else None) or "unit"
    if count == 1:
        return label
    return label if label.endswith("s") else f"{label}s"


# ─── lot resolution ───────────────────────────────────────────────────────────

def ensure_lot_for_receipt(db: Session, receipt: Receipt, *, user_id=None) -> MaterialLot:
    """Resolve (or mint) the material lot this receipt's paperwork describes.

    Called by the print-stickers button on BOTH paths. Idempotent: a receipt
    already carrying a `material_lot_id` returns that lot untouched, so pressing
    Print twice cannot fork a lot in two.

    `weight_per_unit` comes from `weight_per_container`, never from
    `quantity / container_count` — the latter looks equivalent and is not, because
    `quantity` is decremented by consumption while `container_count` is frozen at
    what arrived. Deriving from those two would make the per-drum weight drift
    downward every time production used some.
    """
    if receipt.material_lot_id:
        lot = db.query(MaterialLot).filter(MaterialLot.id == receipt.material_lot_id).first()
        if lot:
            return lot

    if not receipt.product_id:
        raise ValidationError("This receipt has no product, so it cannot have a lot")

    lot = lps.find_or_create_lot(
        db,
        product_id=receipt.product_id,
        vendor_id=receipt.vendor_id,
        vendor_lot_number=receipt.lot_number,
        bbd=receipt.expiration_date,
        unit_label=_unit_label_for(db, receipt),
        weight_per_unit=receipt.weight_per_container,
        weight_unit=receipt.weight_unit,
        warehouse_id=receipt.warehouse_id,
        lot_unknown=not bool(receipt.lot_number),
    )
    receipt.material_lot_id = lot.id
    db.flush()
    return lot


def _unit_label_for(db: Session, receipt: Receipt) -> str:
    """What one counted unit of this receipt IS.

    Prefers what the receiver typed (`container_unit`), then the storage unit of
    the room they put it in, then a bare "unit". Deliberately never guesses from
    the product.
    """
    raw = (receipt.container_unit or "").strip().lower()
    if raw:
        # "barrels" -> "barrel". The label is singular everywhere else.
        return raw[:-1] if raw.endswith("s") and len(raw) > 1 else raw

    if receipt.storage_row_id:
        row = db.query(StorageRow).filter(StorageRow.id == receipt.storage_row_id).first()
        if row and row.sub_location_id:
            from app.models import SubLocation

            sub = db.query(SubLocation).filter(SubLocation.id == row.sub_location_id).first()
            if sub and sub.storage_unit:
                return sub.storage_unit
    return "unit"


def resolve_lot_code(db: Session, code: str) -> Optional[MaterialLot]:
    """A scanned sticker -> its lot. Accepts the bare code or the SB2 envelope."""
    if not code:
        return None
    token = code.strip()
    if "|" in token:
        parts = token.split("|")
        # SB2|<lot_code>|<vendor_lot>|<bbd>. Segment 2 is the identity; the rest
        # is human-readable context that must never be parsed for meaning.
        token = parts[1].strip() if len(parts) > 1 else ""
    if not token:
        return None
    return (
        db.query(MaterialLot)
        .filter(
            func.upper(MaterialLot.lot_code) == token.upper(),
            MaterialLot.is_deleted == False,  # noqa: E712
        )
        .first()
    )


# ─── the receiving session ────────────────────────────────────────────────────

def session_counts(db: Session, receipt: Receipt) -> dict:
    """Scanned so far on this receipt, per row and in total.

    Counts SCAN EVENTS, not placements, and scopes on `ref_id == receipt.id`.
    Placements are shared with everything else that ever put this lot in this row
    — an earlier truck, a move, a staging return — so reading them would show a
    worker a number that includes material they did not just scan.
    """
    query = (
        db.query(
            LotPlacementEvent.storage_row_id,
            func.coalesce(func.sum(LotPlacementEvent.full_units_delta), 0),
        )
        .filter(
            LotPlacementEvent.ref_type == REF_TYPE_RECEIVING,
            LotPlacementEvent.ref_id == receipt.id,
        )
    )
    if receipt.material_lot_id:
        # Scoped to THIS session's lot, not just its ref_id.
        #
        # A cross-lot scan is legal — one truck carries mango and guava — and it
        # is recorded against the lot actually scanned, which is correct for
        # stock. But it is written with THIS session's ref_id, so without this
        # filter the mango session would count guava drums and then weigh them at
        # mango's pounds-per-drum. The approver's paperwork-vs-scanned check would
        # be comparing two different materials.
        query = query.filter(LotPlacementEvent.material_lot_id == receipt.material_lot_id)

    rows = query.group_by(LotPlacementEvent.storage_row_id).all()
    by_row = {r[0]: int(r[1] or 0) for r in rows}
    return {"by_row": by_row, "total": sum(by_row.values())}


def expected_units(db: Session, receipt: Receipt) -> int:
    """What the paperwork says. 0 when nobody wrote a count down."""
    return int(receipt.container_count or 0)


def scan_unit(
    db: Session,
    *,
    receipt_id: str,
    lot_code: str,
    storage_row_id: str,
    user_id: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    allow_overfill: bool = False,
    units: int = 1,
) -> dict:
    """One sticker scan = +1 unit of that lot into that row.

    ALWAYS returns 200. Read the module docstring before changing that.
    """
    # 1. Idempotent replay FIRST — before the receipt lookup, before the session
    #    gate, before the row lookup. See the module docstring.
    if idempotency_key:
        prior = (
            db.query(LotPlacementEvent)
            .filter(LotPlacementEvent.idempotency_key == idempotency_key)
            .first()
        )
        if prior:
            receipt = db.query(Receipt).filter(Receipt.id == prior.ref_id).first()
            lot = db.query(MaterialLot).filter(MaterialLot.id == prior.material_lot_id).first()
            row = db.query(StorageRow).filter(StorageRow.id == prior.storage_row_id).first()
            return _scan_payload(
                db, receipt, lot, row,
                status="ok",
                message="Already recorded.",
                scan_id=prior.id,
            )

    receipt = db.query(Receipt).filter(Receipt.id == receipt_id).first()
    if not receipt:
        raise NotFoundError("Receipt", receipt_id)

    lot = resolve_lot_code(db, lot_code)
    if lot is None:
        return _scan_payload(
            db, receipt, None, None,
            status="unknown_lot",
            message="That sticker is not one of ours. Check it and scan again.",
        )

    if lot.is_held:
        return _scan_payload(
            db, receipt, lot, None,
            status="lot_held",
            message=f"Lot {lot.lot_code} is on hold. A supervisor has to release it first.",
        )

    # A sticker from a DIFFERENT lot than the one this receipt is about. Not an
    # error — one truck legitimately carries several lots — but the worker is
    # told, because the usual cause is picking up the wrong sticker stack.
    session_lot_mismatch = bool(receipt.material_lot_id) and receipt.material_lot_id != lot.id

    row = db.query(StorageRow).filter(StorageRow.id == storage_row_id).first()
    if not row:
        return _scan_payload(
            db, receipt, lot, None,
            status="unknown_row",
            message="That rack is not one we know. Scan the rack label again.",
        )
    if row.is_active is False:
        return _scan_payload(
            db, receipt, lot, row,
            status="unknown_row",
            message=f"{row.name} is deactivated — pick an active rack.",
        )

    # 2. Capacity is a PROMPT, never a gate. Over-filling a rack is accepted at
    #    the point of work and surfaced later as a walk-list; refusing here would
    #    strand a driver holding a drum with nowhere the system will accept.
    warning, warning_detail = _row_capacity_warning(db, row)
    if warning and not allow_overfill:
        return _scan_payload(
            db, receipt, lot, row,
            status="needs_confirm",
            message=f"{row.name} is full by the system. Load into it anyway?",
            warning=warning,
            warning_detail=warning_detail,
        )

    placement = lps.apply_delta(
        db, lot, row.id,
        event_type=lps.EVENT_RECEIVED,
        full_units_delta=int(units),
        actor_id=user_id,
        ref_type=REF_TYPE_RECEIVING,
        ref_id=receipt.id,
        idempotency_key=idempotency_key,
    )

    event = (
        db.query(LotPlacementEvent)
        .filter(LotPlacementEvent.idempotency_key == idempotency_key)
        .first()
        if idempotency_key
        else None
    )

    message = f"Received @ {row.name}"
    if session_lot_mismatch:
        message = f"Received @ {row.name} — note this is lot {lot.lot_code}, not the one on this receipt."

    return _scan_payload(
        db, receipt, lot, row,
        status="ok",
        message=message,
        warning=warning if allow_overfill else None,
        warning_detail=warning_detail if allow_overfill else None,
        scan_id=event.id if event else None,
        placement=placement,
        lot_mismatch=session_lot_mismatch,
    )


def undo_last_scan(db: Session, *, receipt_id: str, user_id: Optional[str] = None) -> dict:
    """Take one unit back off. The honest answer to "I think that double-counted".

    Identical stickers make client-side dedupe impossible — the gun cannot tell a
    second drum from the same drum scanned twice — so the worker needs a way to
    say so. Undo writes a COMPENSATING event rather than deleting the original,
    because a ledger you can delete from is not a ledger.
    """
    receipt = db.query(Receipt).filter(Receipt.id == receipt_id).first()
    if not receipt:
        raise NotFoundError("Receipt", receipt_id)

    last = _last_undoable_scan(db, receipt_id)
    if not last:
        return {"status": "nothing_to_undo", "message": "No scans to undo."}

    lot = db.query(MaterialLot).filter(MaterialLot.id == last.material_lot_id).first()
    row = db.query(StorageRow).filter(StorageRow.id == last.storage_row_id).first()

    lps.apply_delta(
        db, lot, last.storage_row_id,
        event_type=lps.EVENT_ADJUSTED,
        full_units_delta=-int(last.full_units_delta),
        actor_id=user_id,
        ref_type=REF_TYPE_RECEIVING,
        ref_id=receipt_id,
        reason="Undo last scan",
        reason_code="undo",
    )
    return _scan_payload(
        db, receipt, lot, row,
        status="undone",
        message=f"Took one {unit_word(lot, 1)} back off {row.name if row else 'the rack'}.",
    )


def _last_undoable_scan(db: Session, receipt_id: str):
    """The most recent scan on this session that has NOT already been undone.

    Walking the ledger as a STACK rather than taking "the newest positive event"
    is load-bearing. A compensating event is negative, so it is invisible to a
    `full_units_delta > 0` filter, and the ledger is immutable by design — there
    is no flag to mark the original as spent. Take the naive newest-positive and
    the second undo re-picks the SAME event: it decrements a rack that has
    already been corrected, silently eating a drum that was on the rack before
    this session started, while the scan it should have undone stays counted.

    Pushing on a positive and popping on an undo makes undo behave the way the
    button reads — press it twice, two scans come off, most recent first.
    """
    events = (
        db.query(LotPlacementEvent)
        .filter(
            LotPlacementEvent.ref_type == REF_TYPE_RECEIVING,
            LotPlacementEvent.ref_id == receipt_id,
        )
        .order_by(LotPlacementEvent.seq)
        .all()
    )
    stack = []
    for event in events:
        if int(event.full_units_delta or 0) > 0:
            stack.append(event)
        elif event.reason_code == "undo" and stack:
            stack.pop()
    return stack[-1] if stack else None


def _row_capacity_warning(db: Session, row: StorageRow):
    """(code, detail) when the rack is at or over its stated capacity, else (None, None).

    Reads the ROOM's `unit_capacity`, not `StorageRow.pallet_capacity`. The two
    are different physical facts and ingredient rows deliberately carry
    pallet_capacity 0, which means "no opinion" — treating that as "capacity
    zero" would warn on every single scan.
    """
    from app.models import SubLocation

    if not row.sub_location_id:
        return (None, None)
    sub = db.query(SubLocation).filter(SubLocation.id == row.sub_location_id).first()
    if not sub or not sub.storage_unit or not sub.unit_capacity:
        return (None, None)

    on_hand = (
        db.query(
            func.coalesce(func.sum(LotPlacement.full_units + LotPlacement.open_units), 0)
        )
        .filter(LotPlacement.storage_row_id == row.id)
        .scalar()
    )
    if int(on_hand or 0) < int(sub.unit_capacity):
        return (None, None)
    return (
        "row_full",
        f"{row.name} holds {int(on_hand or 0)} of {sub.unit_capacity} {sub.storage_unit}s.",
    )


def _scan_payload(
    db: Session,
    receipt: Optional[Receipt],
    lot: Optional[MaterialLot],
    row: Optional[StorageRow],
    *,
    status: str,
    message: str,
    warning: Optional[str] = None,
    warning_detail: Optional[str] = None,
    scan_id: Optional[str] = None,
    placement=None,
    lot_mismatch: bool = False,
) -> dict:
    """The one response shape every scan outcome uses.

    Deliberately uniform. `scanner_service.scan_pallet` returns four DIFFERENT
    shapes from one endpoint — a four-key `pallet` on success, an eight-key one
    on replay, and none at all on a duplicate — so its client detects outcomes by
    which fields are ABSENT. That is not a contract, it is a guessing game.
    """
    counts = session_counts(db, receipt) if receipt else {"by_row": {}, "total": 0}
    expected = expected_units(db, receipt) if receipt else 0
    return {
        "status": status,
        "message": message,
        "lot_code": lot.lot_code if lot else None,
        "lot_id": lot.id if lot else None,
        "row_id": row.id if row else None,
        "row_name": row.name if row else None,
        "row_scanned_count": counts["by_row"].get(row.id, 0) if row else 0,
        "row_on_hand": (
            int(placement.full_units or 0) + int(placement.open_units or 0)
            if placement is not None else None
        ),
        "session_scanned_count": counts["total"],
        "session_expected_count": expected,
        "count_unit": unit_word(lot, 2),
        "warning": warning,
        "warning_detail": warning_detail,
        "scan_id": scan_id,
        "lot_mismatch": lot_mismatch,
    }


# ─── labels ───────────────────────────────────────────────────────────────────

def label_sheet_for_lot(db: Session, lot: MaterialLot, count: int, *, receipt=None) -> dict:
    """`count` IDENTICAL stickers for one lot.

    There is no per-sticker identity, so there is no serial, no "17 of 80", and
    no ordering problem. A reprint is trivially the same sticker again — the
    guarantee the per-drum design needed a locked sequence counter to provide.

    Refuses when the lot is flagged for review. An identical sticker applied to
    the wrong material cannot be found later: every drum on the pile is wearing
    it, so there is nothing to compare against.
    """
    allowed, reason = lps.can_print_labels(lot)
    if not allowed:
        raise ConflictError(f"Cannot print stickers for this lot — {reason}")
    if count <= 0:
        raise ValidationError("Print at least one sticker")
    if count > 500:
        raise ValidationError("That is more than 500 stickers — split the print run")

    product = db.query(Product).filter(Product.id == lot.product_id).first()
    vendor = (
        db.query(Vendor).filter(Vendor.id == lot.vendor_id).first() if lot.vendor_id else None
    )

    label = {
        "lot_code": lot.lot_code,
        "product_name": product.name if product else "",
        # The production app checks SID, so it has to be derivable from the
        # sticker — printed as text, and reachable from the QR via the lot.
        "product_sid": product.sid if product else None,
        "vendor_name": vendor.name if vendor else "",
        "vendor_lot": lot.vendor_lot_number,
        "lot_unknown": bool(lot.lot_unknown),
        # bbd_CURRENT: an approved extension is the one case where stickers are
        # reprinted and reapplied, and the new date is the whole reason.
        "bbd": lot.bbd_current,
        "net_weight": lot.weight_per_unit,
        "weight_unit": lot.weight_unit,
        "unit_label": lot.unit_label,
        "receipt_date": receipt.receipt_date if receipt else None,
    }

    lot.label_printed_at = datetime.now(timezone.utc)
    db.flush()
    return {
        "lot_code": lot.lot_code,
        "count": int(count),
        "labels": [dict(label) for _ in range(int(count))],
    }


# ─── incoming orders ──────────────────────────────────────────────────────────

def _category_for_product(db: Session, product_id: str) -> Optional[str]:
    product = db.query(Product).filter(Product.id == product_id).first()
    return product.category_id if product else None


def _next_order_number(db: Session) -> str:
    from sqlalchemy import text

    db.execute(text("CREATE SEQUENCE IF NOT EXISTS incoming_order_seq"))
    seq = db.execute(text("SELECT nextval('incoming_order_seq')")).scalar()
    return f"IN-{int(seq):06d}"


def create_incoming_order(db: Session, payload: dict, *, user_id: str, warehouse_id: str):
    """Corporate plans a delivery into one destination site.

    One order per destination. "500 drums to the Chicago 3PL, 300 to Florida, 200
    to our plant" is three orders — each is received, shorted and closed
    independently, and a shared header would couple three unrelated events.

    Creates NO stock. Mirrors the scheduled ship-out precedent, where creating an
    order deliberately reserves nothing: correctness is enforced at scan time.
    """
    lines = payload.get("lines") or []
    if not lines:
        raise ValidationError("An incoming order needs at least one product line")

    order = IngredientIntake(
        id=_mint_id("inord"),
        intake_number=_next_order_number(db),
        is_incoming_order=True,
        vendor_id=payload.get("vendor_id"),
        bol=payload.get("bol"),
        purchase_order=payload.get("purchase_order"),
        warehouse_id=warehouse_id,
        origin_name=payload.get("origin_name"),
        origin_warehouse_id=payload.get("origin_warehouse_id"),
        expected_date=payload.get("expected_date"),
        status=IncomingOrderStatus.DRAFT.value,
        expected_count=0,
        notes=payload.get("notes"),
        submitted_by=user_id,
        submitted_at=datetime.now(timezone.utc),
    )
    db.add(order)
    db.flush()

    total = 0
    for line in lines:
        count = int(line.get("expected_count") or 0)
        total += count
        # Fall back to the product's own category. Without it every receipt
        # created from this order would carry a NULL category_id, and `IN (...)`
        # never matches NULL — so the material would be missing from every
        # category-scoped report and from every is_ingredient predicate in the
        # codebase, including the cutover's own scoping.
        category_id = line.get("category_id") or _category_for_product(db, line["product_id"])
        db.add(IntakeLot(
            id=_mint_id("inline"),
            intake_id=order.id,
            product_id=line["product_id"],
            category_id=category_id,
            container_type=(line.get("unit_label") or "drum"),
            vendor_id=line.get("vendor_id") or payload.get("vendor_id"),
            vendor_lot=line.get("vendor_lot"),
            lot_unknown=not bool(line.get("vendor_lot")),
            bbd=line.get("bbd"),
            expected_count=count,
            brix=line.get("brix"),
            net_weight_per_container=line.get("weight_per_unit"),
            weight_unit=line.get("weight_unit"),
        ))
    order.expected_count = total
    db.flush()
    return order


def release_order(db: Session, order: IngredientIntake, *, user_id: str):
    """Draft -> in transit. Corporate says it has left."""
    if order.status != IncomingOrderStatus.DRAFT.value:
        raise ConflictError(f"This order is {order.status}, so it cannot be released again")
    order.status = IncomingOrderStatus.IN_TRANSIT.value
    order.released_at = datetime.now(timezone.utc)
    order.released_by = user_id
    db.flush()
    return order


def close_order(db: Session, order: IngredientIntake, *, user_id: str, reason: str = None):
    """Close the order, short or complete.

    "The market is short but corporate can close it with a reason" — so a reason
    is REQUIRED when fewer units arrived than the paperwork promised. Without it
    the difference becomes an unexplained hole that nobody can answer for later.
    """
    received = order_received_count(db, order)
    short = int(order.expected_count or 0) - received
    if short > 0 and not (reason or "").strip():
        raise ValidationError(
            f"{short} short of {order.expected_count} — closing short needs a reason"
        )

    order.received_count = received
    order.short_count = max(0, short)
    order.over_received = received > int(order.expected_count or 0)
    order.status = (
        IncomingOrderStatus.CLOSED_SHORT.value if short > 0
        else IncomingOrderStatus.RECEIVED.value
    )
    order.close_reason = reason
    order.closed_at = datetime.now(timezone.utc)
    order.closed_by = user_id
    db.flush()
    return order


def cancel_order(db: Session, order: IngredientIntake, *, user_id: str, reason: str = None):
    if order_received_count(db, order) > 0:
        raise ConflictError(
            "Some of this order has already been received — close it short instead of cancelling"
        )
    order.status = IncomingOrderStatus.CANCELLED.value
    order.close_reason = reason
    order.closed_at = datetime.now(timezone.utc)
    order.closed_by = user_id
    db.flush()
    return order


def order_received_count(db: Session, order: IngredientIntake) -> int:
    """Units scanned against every line of this order."""
    receipt_ids = [
        line.receipt_id for line in (order.lots or []) if line.receipt_id
    ]
    if not receipt_ids:
        return 0
    total = (
        db.query(func.coalesce(func.sum(LotPlacementEvent.full_units_delta), 0))
        .filter(
            LotPlacementEvent.ref_type == REF_TYPE_RECEIVING,
            LotPlacementEvent.ref_id.in_(receipt_ids),
        )
        .scalar()
    )
    return int(total or 0)


def start_receiving(
    db: Session,
    order: IngredientIntake,
    line: IntakeLot,
    *,
    user_id: str,
    overrides: dict = None,
) -> Receipt:
    """The plant opens a line and begins. Creates the receipt and the lot.

    The lot is resolved HERE, not when corporate wrote the order: corporate types
    a vendor lot off paperwork, and paperwork for a truck that never arrives
    should not mint identity. `overrides` is what the worker corrected against the
    driver's BOL — corporate fills 99% of it, and the last 1% is why this exists.
    """
    if order.status not in INCOMING_RECEIVABLE_STATUSES:
        raise ConflictError(
            f"This order is {order.status} — only an in-transit order can be received"
        )
    if line.intake_id != order.id:
        raise ValidationError("That line is not on this order")

    if line.receipt_id:
        existing = db.query(Receipt).filter(Receipt.id == line.receipt_id).first()
        if existing:
            return existing   # resuming, not restarting

    overrides = overrides or {}
    vendor_lot = overrides.get("vendor_lot", line.vendor_lot)
    bbd = overrides.get("bbd", line.bbd)
    weight_per_unit = overrides.get("weight_per_unit", line.net_weight_per_container)
    weight_unit = overrides.get("weight_unit", line.weight_unit)
    expected = int(overrides.get("expected_count", line.expected_count) or 0)

    receipt = Receipt(
        id=_mint_id("rcpt"),
        product_id=line.product_id,
        # Never NULL — see the note in create_incoming_order. A receipt with no
        # category is invisible to every category-scoped report in the app.
        category_id=line.category_id or _category_for_product(db, line.product_id),
        lot_number=vendor_lot,
        expiration_date=bbd,
        # Weight, derived — matching what routers/receipts.py does on create so
        # every existing reader of Receipt.quantity keeps working.
        quantity=round(expected * float(weight_per_unit or 0), 3) if weight_per_unit else expected,
        unit=(weight_unit or "lbs") if weight_per_unit else (line.container_type or "unit"),
        container_count=expected,
        container_unit=line.container_type,
        weight_per_container=weight_per_unit,
        weight_unit=weight_unit,
        vendor_id=line.vendor_id or order.vendor_id,
        bol=overrides.get("bol", order.bol),
        purchase_order=order.purchase_order,
        warehouse_id=order.warehouse_id,
        status=ReceiptStatus.RECORDED,
        submitted_by=user_id,
        receipt_date=datetime.now(timezone.utc),
        note=f"Received against incoming order {order.intake_number}",
    )
    db.add(receipt)
    db.flush()

    lot = ensure_lot_for_receipt(db, receipt, user_id=user_id)

    line.receipt_id = receipt.id
    line.material_lot_id = lot.id
    if vendor_lot != line.vendor_lot:
        line.vendor_lot = vendor_lot
        line.lot_unknown = not bool(vendor_lot)
    if bbd != line.bbd:
        line.bbd = bbd
    if weight_per_unit != line.net_weight_per_container:
        line.net_weight_per_container = weight_per_unit
    if weight_unit != line.weight_unit:
        line.weight_unit = weight_unit

    if order.status == IncomingOrderStatus.IN_TRANSIT.value:
        order.status = IncomingOrderStatus.RECEIVING.value
    db.flush()
    return receipt


# ─── the approval view ────────────────────────────────────────────────────────

def open_sessions(db: Session, *, warehouse_id: Optional[str] = None, limit: int = 50) -> list:
    """Receiving sessions the gun can pick up — from BOTH paths, in one list.

    A worker at the gun does not care whether corporate raised an order or
    somebody logged a walk-in receipt off the driver's BOL. They care that there
    is material to scan in. Splitting this into two screens would make them
    choose the right one before they can do the job.

    A session is open while its receipt is still `recorded` or `reviewed` and its
    lot is resolved. Deliberately NOT filtered on "scanned < expected": over-
    receiving is legal, and hiding a session the moment it hits the paperwork
    count would strand the 81st drum of an expected 80.
    """
    query = (
        db.query(Receipt)
        .filter(
            Receipt.material_lot_id.isnot(None),
            Receipt.is_deleted == False,  # noqa: E712
            Receipt.status.in_((ReceiptStatus.RECORDED, ReceiptStatus.REVIEWED)),
        )
    )
    if warehouse_id:
        query = query.filter(Receipt.warehouse_id == warehouse_id)

    receipts = query.order_by(Receipt.receipt_date.desc()).limit(limit).all()
    return [receiving_summary(db, r) for r in receipts]


def receiving_summary(db: Session, receipt: Receipt) -> dict:
    """Paperwork vs scanned, per row — what the approver actually looks at.

    The approval is a CHECK, not a gate on stock: the units are already in the
    racks and already count as availability. What the second worker is confirming
    is that the paperwork and the scanning agree, and where the difference is if
    they do not.
    """
    lot = (
        db.query(MaterialLot).filter(MaterialLot.id == receipt.material_lot_id).first()
        if receipt.material_lot_id else None
    )
    counts = session_counts(db, receipt)
    expected = expected_units(db, receipt)

    rows = []
    for row_id, n in sorted(counts["by_row"].items(), key=lambda kv: -kv[1]):
        row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
        rows.append({
            "storage_row_id": row_id,
            "storage_row_name": row.name if row else row_id,
            "count": n,
        })

    line = db.query(IntakeLot).filter(IntakeLot.receipt_id == receipt.id).first()
    order = (
        db.query(IngredientIntake).filter(IngredientIntake.id == line.intake_id).first()
        if line else None
    )

    product = (
        db.query(Product).filter(Product.id == receipt.product_id).first()
        if receipt.product_id else None
    )

    return {
        "receipt_id": receipt.id,
        # The gun leads with this. A lot code is what the sticker says, but a
        # driver walking to a truck is looking for mango, not L0000003.
        "product_id": receipt.product_id,
        "product_name": product.name if product else "",
        "lot_code": lot.lot_code if lot else None,
        "vendor_lot": lot.vendor_lot_number if lot else receipt.lot_number,
        "bbd": (lot.bbd_current if lot else receipt.expiration_date),
        "unit_label": lot.unit_label if lot else None,
        "count_unit": unit_word(lot, 2),
        "expected_count": expected,
        "scanned_count": counts["total"],
        "difference": counts["total"] - expected,
        "weight_per_unit": lot.weight_per_unit if lot else receipt.weight_per_container,
        "derived_weight": round(
            counts["total"] * float(lot.weight_per_unit or 0), 3
        ) if lot else None,
        "rows": rows,
        "source": "incoming_order" if order else "walk_in",
        "order_number": order.intake_number if order else None,
        "order_id": order.id if order else None,
        "needs_review": bool(lot.needs_review) if lot else False,
        "blocked_reason": lps.can_print_labels(lot)[1] if lot else None,
        "label_printed_at": lot.label_printed_at if lot else None,
    }


def resolve_scanned_row(db: Session, current_user, code: str) -> dict:
    """Scan a rack label -> exactly one row.

    Delegates to the existing resolver rather than matching on name client-side.
    `storage_rows.name` carries no uniqueness constraint — two barns can each hold
    an "A-12" — and under lot identity a wrong row is unrecoverable: every drum
    wears the same sticker, so nobody can work out afterwards which pile was
    which. The resolver refuses an ambiguous name instead of picking one.
    """
    return resolve_row(db, current_user, code)
