"""The ONLY writer of `lot_placements`. See models/material_lot.py for the model.

Three rules hold everywhere in this module, and none of them is optional:

1. **Units are the record. Pounds are derived.**
   `full_units` is an integer somebody counted. Weight is always
   `full_units * lot.weight_per_unit + open_remaining_qty`, computed on read.
   Never the reverse — different vendors ship different weights per drum, so a
   pound figure cannot be counted or reconciled by a person on a rack.

2. **Every mutation is: lock -> change -> log -> project, in ONE transaction.**
   Lock the placement row (`SELECT ... FOR UPDATE`), apply the delta, append
   exactly one `LotPlacementEvent` per affected placement, then re-project the
   legacy allocation JSON. A move touches two placements, so it writes two
   events sharing a `ref_id`.

3. **The legacy JSON is PROJECTED, never dual-written.**
   `Receipt.raw_material_row_allocations` and `StorageRow.occupied_*` are
   overwritten from placements after every change. Two independent writers of
   one fact will disagree, and when they do nothing errors — the wrong one just
   wins, depending on which reader you ask. A one-directional idempotent
   projection cannot durably disagree: the only failure mode is "it did not
   run", which self-heals on the next mutation and is visible to
   `reconcile_lot`.

This module does NOT commit. The router owns the transaction boundary.
"""

import math
import re
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.exceptions import ConflictError, NotFoundError, ValidationError
from app.utils.calendar_dates import calendar_day, calendar_day_compact
from app.models import (
    LotPlacement,
    LotPlacementEvent,
    MaterialLot,
    Product,
    Receipt,
    StorageArea,
    StorageRow,
)

# Event types on the placement ledger.
EVENT_RECEIVED = "received"
EVENT_MOVED = "moved"
EVENT_COUNTED = "counted"
EVENT_CONSUMED = "consumed"
EVENT_STAGED = "staged"
EVENT_RETURNED = "returned"
EVENT_ADJUSTED = "adjusted"
EVENT_OPENED = "opened"
EVENT_OPENING_BALANCE = "opening_balance"

# Exact text, because find_or_create_lot clears the flag only when it is the one
# it raised — a conflicting-weight review is somebody else's to resolve.
_NO_WEIGHT_REASON = (
    "No weight per unit recorded. Pounds are derived from it, so without it this "
    "lot reads as zero stock to production. Fill it in before printing stickers."
)


def _mint_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"





# ─── lot identity ─────────────────────────────────────────────────────────────

def normalize_lot_number(value: Optional[str]) -> str:
    """Trim, collapse internal whitespace, upper. Nothing else.

    Deliberately conservative. Over-normalizing (stripping punctuation, leading
    zeros, etc.) merges two genuinely different vendor lots — and because every
    drum of a lot wears an IDENTICAL sticker, a wrong merge is a traceability
    failure a recall cannot untangle after the fact. Under-normalizing only
    costs an extra sticker design, which is recoverable.
    """
    if not value:
        return ""
    return re.sub(r"\s+", " ", value.strip()).upper()


def build_lot_key(
    product_id: str,
    vendor_id: Optional[str],
    vendor_lot_number: Optional[str],
    bbd_original: Optional[datetime],
    *,
    lot_unknown: bool = False,
) -> str:
    """The natural key, as a single string.

    A UNIQUE index across the four columns would NOT work: `vendor_id` and
    `bbd_original` are nullable and Postgres treats NULLs as distinct, so the
    constraint would silently fail to constrain. Collapsing to one non-null
    string makes the uniqueness real.

    Uses `bbd_original`, never `bbd_current` — see the model docstring. A
    shelf-life extension must not re-key the lot, or every sticker already
    applied to a drum in the barn would point at a lot that no longer exists.
    """
    day = calendar_day(bbd_original) or ""
    key = f"{product_id}|{vendor_id or ''}|{normalize_lot_number(vendor_lot_number)}|{day}"

    if lot_unknown or not normalize_lot_number(vendor_lot_number):
        # AN UNKNOWN LOT NEVER MATCHES ANOTHER UNKNOWN LOT.
        #
        # Without this, two trucks whose drum markings were unreadable both
        # normalize their lot number to "" and produce an IDENTICAL key, so the
        # second one silently becomes the first one's lot — and since every drum
        # of a lot wears the same sticker, two genuinely different deliveries end
        # up indistinguishable on the rack. That is the "one giant unknown
        # bucket" the model explicitly forbids, and a recall could not untangle
        # it afterwards.
        #
        # The suffix makes each unknown arrival its own lot. They are QA-flagged
        # and used first; they are never merged.
        key = f"{key}|unknown:{uuid.uuid4().hex[:12]}"
    return key


def find_or_create_lot(
    db: Session,
    *,
    product_id: str,
    vendor_id: Optional[str],
    vendor_lot_number: Optional[str],
    bbd: Optional[datetime],
    unit_label: str,
    weight_per_unit: Optional[float] = None,
    weight_unit: Optional[str] = None,
    brix: Optional[float] = None,
    warehouse_id: Optional[str] = None,
    lot_unknown: bool = False,
    units_per_pallet: Optional[int] = None,
) -> MaterialLot:
    """Resolve the lot this material belongs to, creating it on first sight.

    The same vendor lot arriving on a second truck resolves to the SAME lot, so
    its stickers, its BBD and its recall trace are shared. That is the whole
    point of lot identity — and it is why this cannot live on Receipt.

    A conflicting `weight_per_unit` between arrivals sets `needs_review` and does
    NOT pick a winner. A human decides, and no sticker prints until they do.

    A MISSING `weight_per_unit` also sets `needs_review`, for a reason that is
    less obvious and more dangerous. Pounds are derived as
    `full_units * weight_per_unit`, so a NULL makes every derived pound ZERO —
    and because a counted lot's receipt steps aside from the legacy availability
    sum to avoid double-counting, scanning that material IN makes it vanish from
    availability entirely. Production's scheduling gate reads that number, so
    eighty drums in the barn would read as nothing at all. Flagging the lot stops
    stickers printing, and since nothing can be scanned in without a sticker, the
    number has to be filled in before any of it becomes stock.
    """
    if not product_id:
        raise ValidationError("A lot needs a product")

    lot_key = build_lot_key(
        product_id, vendor_id, vendor_lot_number, bbd, lot_unknown=lot_unknown
    )
    existing = (
        db.query(MaterialLot)
        .filter(MaterialLot.lot_key == lot_key, MaterialLot.is_deleted == False)  # noqa: E712
        .first()
    )

    now = datetime.now(timezone.utc)
    if existing:
        if (
            weight_per_unit is not None
            and existing.weight_per_unit is not None
            and abs(float(existing.weight_per_unit) - float(weight_per_unit)) > 0.001
        ):
            # Do not overwrite. Every pound already derived from this lot used
            # the old figure; silently changing it would restate history.
            existing.needs_review = True
            existing.review_reason = (
                f"Arrived at {weight_per_unit} {weight_unit or ''} per unit but the lot "
                f"is recorded as {existing.weight_per_unit} {existing.weight_unit or ''}."
            )
        # A packing fact, so a later arrival may simply know it when the first
        # did not. Filled in when missing; never overwritten, because a pallet
        # already received was counted under the old figure.
        if existing.units_per_pallet is None and units_per_pallet:
            existing.units_per_pallet = int(units_per_pallet)
        if existing.weight_per_unit is None and weight_per_unit is not None:
            existing.weight_per_unit = weight_per_unit
            existing.weight_unit = weight_unit
            # The gap that flagged it is now filled, so the lot can be labelled.
            # Only clear a review this function itself raised for that reason —
            # a conflicting-weight flag is somebody else's to resolve.
            if existing.needs_review and existing.review_reason == _NO_WEIGHT_REASON:
                existing.needs_review = False
                existing.review_reason = None
        existing.last_received_at = now
        db.flush()
        return existing

    product = db.query(Product).filter(Product.id == product_id).first()
    lot = MaterialLot(
        id=_mint_id("mlot"),
        lot_code=build_lot_code(
            db,
            product_sid=product.sid if product else None,
            product_id=product_id,
            vendor_id=vendor_id,
            vendor_lot=vendor_lot_number,
            bbd=bbd,
        ),
        lot_key=lot_key,
        product_id=product_id,
        vendor_id=vendor_id,
        vendor_lot_number=vendor_lot_number,
        lot_unknown=bool(lot_unknown) or not vendor_lot_number,
        # Both dates start equal. Only an approved extension moves bbd_current.
        bbd_original=bbd,
        bbd_current=bbd,
        unit_label=unit_label or "unit",
        weight_per_unit=weight_per_unit,
        # POUNDS unless something explicitly says otherwise. Nothing in this
        # system converts between weight units — every pound is derived as
        # `full_units * weight_per_unit` — so a mixed store means every aggregate
        # has to know which row is which, and one missed conversion is silent.
        # One canonical unit removes the question. The entry forms no longer
        # offer a choice; this is the backstop for anything that posts directly.
        weight_unit=weight_unit or "lbs",
        brix=brix,
        units_per_pallet=int(units_per_pallet) if units_per_pallet else None,
        warehouse_id=warehouse_id,
        # See the docstring: a lot with no weight per unit derives zero pounds,
        # which reads as "no stock" to the production availability gate.
        needs_review=weight_per_unit is None,
        review_reason=_NO_WEIGHT_REASON if weight_per_unit is None else None,
        first_received_at=now,
        last_received_at=now,
    )
    db.add(lot)
    db.flush()
    return lot


# Segment separator for the printed code.
#
# NOT a pipe: the QR payload is `SB2|<lot_code>|<vendor_lot>|<bbd>` and does not
# escape, so a pipe inside the code would produce a label nothing can parse.
# A dot is safe there, is in the QR ALPHANUMERIC character set (0-9 A-Z space
# $%*+-./:) so the code stays in that denser mode rather than falling back to
# byte mode, and cannot appear inside a segment because `_clean_for_code` strips
# it — which keeps the join unambiguous.
_CODE_SEP = "."


def _clean_for_code(value: str) -> str:
    """Uppercase, keep A-Z 0-9 and dashes. Nothing else reaches a code.

    Dashes survive because vendor lot numbers are full of them ("MG-2411") and
    stripping them would make two different lots look alike. The separator is a
    dot precisely so a dash inside a segment can never be confused for one.
    """
    return re.sub(r"[^A-Z0-9-]", "", (value or "").upper())


def build_lot_code(
    db: Session,
    *,
    product_sid: str = None,
    product_id: str = None,
    vendor_id: str = None,
    vendor_lot: str = None,
    bbd: Optional[datetime] = None,
) -> str:
    """The identifier on the sticker. THE WHOLE NATURAL KEY, and nothing else.

        S528506.VENDOR-1772201342794.LOT001234.20270820
        └──┬──┘ └────────┬─────────┘ └───┬───┘ └──┬───┘
          SID          vendor        THEIR lot   BBD

    NO MARKER, NO COUNTER, NOTHING INVENTED. Every segment is a fact about the
    material, and the four together are unique by construction — which is the
    whole reason a marker was never actually necessary. Two vendors shipping a
    "001" differ in the vendor segment; one vendor reusing "001" next year
    differs in the BBD; the same product, vendor, lot and BBD IS the same
    material, and matching it is the point rather than a collision.

    LENGTH DOES NOT MATTER because nobody reads this. A scanner does not care
    whether it is 20 characters or 60, and the label's big text carries the
    vendor's lot number — the thing a person on a dock actually recognises — so
    this string is never spoken aloud or keyed by hand.

    `vendor_id` rather than the vendor's NAME, deliberately. The name is not
    unique and can be retyped; the id cannot collide. Since nothing reads the
    code, legibility buys nothing and a collision would cost a UNIQUE violation
    at exactly the wrong moment — a truck on the dock.

    Falls back to `product_id` when a product has no SID (29 of 113 do not), so
    the product segment is never empty.
    """
    parts = [
        _clean_for_code(product_sid) or _clean_for_code(product_id),
        _clean_for_code(vendor_id),
        _clean_for_code(vendor_lot),
        calendar_day_compact(bbd),
    ]
    code = _CODE_SEP.join(p for p in parts if p)

    # Uniqueness backstop, and it should never fire for anything printable.
    #
    # It exists for the lot with NO lot number: `build_lot_key` gives those a
    # random suffix so two unreadable deliveries never merge, and without the
    # same treatment here their codes would collide. Such a lot cannot be
    # stickered at all (`can_print_labels` refuses), so the suffix never reaches
    # a label — it only keeps the column's UNIQUE constraint honest.
    if not code:
        code = "LOT"
    if db.query(MaterialLot.id).filter(MaterialLot.lot_code == code).first():
        code = f"{code}{_CODE_SEP}{uuid.uuid4().hex[:6].upper()}"
    return code


def can_print_labels(lot: MaterialLot) -> tuple:
    """(allowed, reason). THE single gate on printing.

    Every drum of a lot wears an IDENTICAL sticker, so applying one to material
    whose identity is in doubt is not a mistake anybody can find later — the
    sticker becomes the thing everyone trusts, and there is no second copy to
    compare it against.

    RECORDING AND PRINTING ARE DIFFERENT BARS, deliberately. Stock whose lot
    number is unreadable still gets COUNTED — it physically exists, and refusing
    to record it would just make the inventory wrong. But it cannot be
    STICKERED: a label reading "LOT UNKNOWN · BBD —" applied to forty drums
    produces exactly the untraceable pile this whole model exists to prevent,
    and a recall could not untangle it. Such a lot sits on the awaiting-stickers
    list until somebody supplies the missing detail.
    """
    if lot.is_deleted:
        return (False, "This lot has been deleted.")
    if lot.needs_review:
        return (False, lot.review_reason or "This lot is flagged for review.")

    missing = []
    if lot.lot_unknown or not (lot.vendor_lot_number or "").strip():
        missing.append("a vendor lot number")
    # bbd_CURRENT: an approved extension is the date that should be printed.
    if not lot.bbd_current:
        missing.append("a best-by date")
    if missing:
        return (False, (
            f"This lot has no {' and no '.join(missing)}. Every drum would carry "
            "an identical sticker saying so, and nothing could tell them apart "
            "afterwards — fill it in from the paperwork first."
        ))
    return (True, None)


# ─── reads ────────────────────────────────────────────────────────────────────

def derived_weight(lot: MaterialLot, placement: LotPlacement) -> float:
    """Pounds for one placement. Derived, never stored."""
    per_unit = float(lot.weight_per_unit or 0)
    return float(placement.full_units or 0) * per_unit + float(placement.open_remaining_qty or 0)


def placements_for_lot(db: Session, material_lot_id: str, *, include_empty: bool = False):
    q = db.query(LotPlacement).filter(LotPlacement.material_lot_id == material_lot_id)
    if not include_empty:
        # A depleted placement is kept at 0/0 for history; reads hide it.
        q = q.filter((LotPlacement.full_units > 0) | (LotPlacement.open_units > 0))
    return q.order_by(LotPlacement.storage_row_id).all()


def units_on_hand(db: Session, material_lot_id: str) -> dict:
    rows = placements_for_lot(db, material_lot_id)
    return {
        "full_units": sum(int(p.full_units or 0) for p in rows),
        "open_units": sum(int(p.open_units or 0) for p in rows),
        "open_remaining_qty": sum(float(p.open_remaining_qty or 0) for p in rows),
        "row_count": len(rows),
        # Quarantined containers are ON the rack and counted, but not available.
        # Reported separately rather than netted out of `full_units`, because a
        # count that silently excluded them would disagree with the rack when
        # somebody walks over and counts it.
        "held_units": sum(int(p.held_units or 0) for p in rows),
    }


def is_counted_lot(db: Session, material_lot_id: Optional[str]) -> bool:
    """True once this lot has any placement at all.

    This is the dual-mode switch, and it is per LOT rather than per warehouse:
    zero placements means legacy (every existing code path works untouched),
    one or more means this lot's location truth lives in `lot_placements` and
    the legacy JSON is a projection of it.
    """
    if not material_lot_id:
        return False
    return (
        db.query(LotPlacement.id)
        .filter(LotPlacement.material_lot_id == material_lot_id)
        .first()
        is not None
    )


# ─── the single write path ────────────────────────────────────────────────────

def warehouse_for_row(db: Session, storage_row_id: str) -> Optional[str]:
    """Which warehouse a rack physically sits in.

    `StorageRow` carries no warehouse_id — warehouse lives four levels up on
    Location — and a row hangs off EITHER a sub_location (raw material and
    ingredients) OR a storage_area (finished goods), so both parents have to be
    walked. This is exactly why `LotPlacement.warehouse_id` is denormalized: so
    every scoped query afterwards is one column instead of this join.

    Returns None when the chain is incomplete, which is drift rather than an
    error — the caller falls back rather than refusing to record a scan.
    """
    from app.models import Location, SubLocation

    row = db.query(StorageRow).filter(StorageRow.id == storage_row_id).first()
    if not row:
        return None

    location_id = None
    if row.sub_location_id:
        sub = db.query(SubLocation).filter(SubLocation.id == row.sub_location_id).first()
        location_id = sub.location_id if sub else None
    if not location_id and row.storage_area_id:
        area = db.query(StorageArea).filter(StorageArea.id == row.storage_area_id).first()
        location_id = area.location_id if area else None
    if not location_id:
        return None

    location = db.query(Location).filter(Location.id == location_id).first()
    return location.warehouse_id if location else None


def _lock_placement(db: Session, material_lot_id: str, storage_row_id: str) -> Optional[LotPlacement]:
    """SELECT ... FOR UPDATE. Copies routers/transfers.py:_lock_pallets_for_update."""
    return (
        db.query(LotPlacement)
        .filter(
            LotPlacement.material_lot_id == material_lot_id,
            LotPlacement.storage_row_id == storage_row_id,
        )
        .with_for_update()
        .first()
    )


def _get_or_create_placement(
    db: Session, lot: MaterialLot, storage_row_id: str
) -> LotPlacement:
    placement = _lock_placement(db, lot.id, storage_row_id)
    if placement:
        return placement

    row = db.query(StorageRow).filter(StorageRow.id == storage_row_id).first()
    if not row:
        raise NotFoundError("Storage row", storage_row_id)

    placement = LotPlacement(
        id=_mint_id("lplc"),
        material_lot_id=lot.id,
        storage_row_id=storage_row_id,
        product_id=lot.product_id,
        # FROM THE RACK, not from the lot.
        #
        # A lot's key has no warehouse component — deliberately, because the same
        # vendor lot arriving anywhere is the same material. So
        # `MaterialLot.warehouse_id` is only ever whichever site saw it first.
        # Copying it here would file Plant B's drums under Plant A the moment a
        # supplier split one vendor lot between two sites: availability scopes on
        # the PLACEMENT, so B would read zero while A's number included stock it
        # does not physically hold.
        warehouse_id=warehouse_for_row(db, storage_row_id) or lot.warehouse_id,
        full_units=0,
        open_units=0,
        open_remaining_qty=0,
    )
    db.add(placement)
    db.flush()
    # Re-take the lock now the row exists, so concurrent callers serialize here
    # rather than both proceeding on their own in-memory object.
    return _lock_placement(db, lot.id, storage_row_id) or placement


def _record_event(
    db: Session,
    lot: MaterialLot,
    storage_row_id: str,
    event_type: str,
    *,
    full_units_delta: int = 0,
    open_units_delta: int = 0,
    qty_delta: float = 0.0,
    counterpart_row_id: Optional[str] = None,
    actor_id: Optional[str] = None,
    ref_type: Optional[str] = None,
    ref_id: Optional[str] = None,
    reason: Optional[str] = None,
    reason_code: Optional[str] = None,
    idempotency_key: Optional[str] = None,
) -> LotPlacementEvent:
    event = LotPlacementEvent(
        id=_mint_id("lpev"),
        material_lot_id=lot.id,
        storage_row_id=storage_row_id,
        counterpart_row_id=counterpart_row_id,
        event_type=event_type,
        full_units_delta=full_units_delta,
        open_units_delta=open_units_delta,
        qty_delta=qty_delta,
        actor_id=actor_id,
        ref_type=ref_type,
        ref_id=ref_id,
        reason=reason,
        reason_code=reason_code,
        occurred_at=datetime.now(timezone.utc),
        idempotency_key=idempotency_key,
    )
    db.add(event)
    return event


def apply_delta(
    db: Session,
    lot: MaterialLot,
    storage_row_id: str,
    *,
    event_type: str,
    full_units_delta: int = 0,
    open_units_delta: int = 0,
    open_qty_delta: float = 0.0,
    actor_id: Optional[str] = None,
    counterpart_row_id: Optional[str] = None,
    ref_type: Optional[str] = None,
    ref_id: Optional[str] = None,
    reason: Optional[str] = None,
    reason_code: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    allow_negative: bool = False,
) -> LotPlacement:
    """Change one placement by a signed delta. THE primitive — everything uses it.

    Refuses to drive a count below zero rather than clamping. A clamp destroys
    the evidence: the operator sees a plausible number and the discrepancy that
    produced it is gone. An explicit error makes someone look.
    """
    if idempotency_key:
        prior = (
            db.query(LotPlacementEvent)
            .filter(LotPlacementEvent.idempotency_key == idempotency_key)
            .first()
        )
        if prior:
            # A replayed offline scan. Return the state the ORIGINAL event
            # produced, without re-applying it.
            #
            # Both the lot AND the row come from the prior event, never from the
            # current call. The index is global rather than scoped per lot, so a
            # client that reused a key across two different lots would otherwise
            # get back a placement for the lot it just named at the row the OTHER
            # scan used — a row that may hold none of it. Returning the prior
            # event's own pair is the only answer that is true.
            return _lock_placement(db, prior.material_lot_id, prior.storage_row_id)

    placement = _get_or_create_placement(db, lot, storage_row_id)

    new_full = int(placement.full_units or 0) + int(full_units_delta)
    new_open = int(placement.open_units or 0) + int(open_units_delta)
    new_qty = float(placement.open_remaining_qty or 0) + float(open_qty_delta)

    if not allow_negative and (new_full < 0 or new_open < 0 or new_qty < -0.001):
        row = db.query(StorageRow).filter(StorageRow.id == storage_row_id).first()
        raise ConflictError(
            f"{lot.unit_label} count for lot {lot.lot_code} in "
            f"{row.name if row else storage_row_id} would go negative "
            f"({placement.full_units} on hand, change {full_units_delta:+d}). "
            "Count the row and correct it instead."
        )

    placement.full_units = max(0, new_full)
    placement.open_units = max(0, new_open)
    placement.open_remaining_qty = max(0.0, new_qty)
    placement.last_movement_at = datetime.now(timezone.utc)
    if event_type in (EVENT_COUNTED, EVENT_OPENING_BALANCE):
        placement.last_counted_at = datetime.now(timezone.utc)
        placement.last_counted_by = actor_id

    _record_event(
        db, lot, storage_row_id, event_type,
        full_units_delta=full_units_delta,
        open_units_delta=open_units_delta,
        qty_delta=open_qty_delta,
        counterpart_row_id=counterpart_row_id,
        actor_id=actor_id, ref_type=ref_type, ref_id=ref_id,
        reason=reason, reason_code=reason_code,
        idempotency_key=idempotency_key,
    )
    db.flush()
    project_lot(db, lot)
    return placement


def set_count(
    db: Session,
    lot: MaterialLot,
    storage_row_id: str,
    *,
    full_units: int,
    open_units: int = 0,
    open_remaining_qty: float = 0.0,
    actor_id: Optional[str] = None,
    event_type: str = EVENT_COUNTED,
    reason: Optional[str] = None,
) -> LotPlacement:
    """Set a placement to an ABSOLUTE counted figure.

    This is what a physical count writes, and what the cutover opening balance
    writes. The event records the DELTA from what the system believed, so the
    ledger still reconciles and the variance is visible rather than overwritten
    silently.
    """
    if full_units < 0 or open_units < 0 or open_remaining_qty < 0:
        raise ValidationError("A count cannot be negative")
    if open_units == 0 and open_remaining_qty > 0:
        raise ValidationError("Remaining quantity needs at least one open unit")

    placement = _get_or_create_placement(db, lot, storage_row_id)
    return apply_delta(
        db, lot, storage_row_id,
        event_type=event_type,
        full_units_delta=int(full_units) - int(placement.full_units or 0),
        open_units_delta=int(open_units) - int(placement.open_units or 0),
        open_qty_delta=float(open_remaining_qty) - float(placement.open_remaining_qty or 0),
        actor_id=actor_id,
        reason=reason,
        allow_negative=True,   # the absolute figure is already validated above
    )


def move_units(
    db: Session,
    lot: MaterialLot,
    *,
    from_row_id: str,
    to_row_id: str,
    full_units: int,
    actor_id: Optional[str] = None,
    reason: Optional[str] = None,
    ref_id: Optional[str] = None,
    idempotency_key: Optional[str] = None,
) -> dict:
    """Move whole units between rows. Writes TWO events sharing a ref."""
    if from_row_id == to_row_id:
        raise ValidationError("Source and destination rows are the same")
    if full_units <= 0:
        raise ValidationError("Move at least one unit")

    # A quarantine is quarantine-IN-PLACE. Held drums cannot be carried to
    # another rack, because the hold is recorded against the rack they are on
    # and moving them would either strand the count on an empty rack or silently
    # launder held material into a clean one. Releasing first is a decision with
    # somebody's name on it.
    if lot.is_held:
        raise ConflictError(
            f"Lot {lot.lot_code} is on hold"
            f"{f' — {lot.hold_reason}' if lot.hold_reason else ''}. "
            "Release the hold before moving any of it."
        )
    source = _lock_placement(db, lot.id, from_row_id)
    if source is not None and _free_units(source) < full_units:
        held = int(source.held_units or 0)
        raise ConflictError(
            f"Only {_free_units(source)} {lot.unit_label}s of lot {lot.lot_code} "
            f"can be moved from that rack ({held} on hold). "
            "Release the hold first if they need to move."
        )

    ref = ref_id or _mint_id("mv")
    src = apply_delta(
        db, lot, from_row_id, event_type=EVENT_MOVED,
        full_units_delta=-int(full_units), counterpart_row_id=to_row_id,
        actor_id=actor_id, ref_type="move", ref_id=ref, reason=reason,
        idempotency_key=idempotency_key,
    )
    dst = apply_delta(
        db, lot, to_row_id, event_type=EVENT_MOVED,
        full_units_delta=int(full_units), counterpart_row_id=from_row_id,
        actor_id=actor_id, ref_type="move", ref_id=ref, reason=reason,
    )
    return {"from": src, "to": dst, "ref_id": ref}


def received_into_by_receipt(db: Session, product_id: str) -> Dict[str, list]:
    """`{receipt_id: [{storage_row_id, storage_row_name, units}]}` — where each
    DELIVERY was put, from the ledger.

    The projection cannot answer this. Placements belong to the LOT, not to one
    truck: eight drums of the same vendor lot arriving on two days are one
    placement picture, and `project_lot` writes that whole picture onto the
    newest receipt and blanks the older ones. Ask it "which rack did Tuesday's
    delivery go on" and it has nothing to say.

    The EVENT ledger does, because every put-away is stamped with the receipt
    that caused it. So this is a replay of `received` events, grouped by
    receipt.

    IT IS WHERE IT WENT, NOT WHERE IT IS. A later rack-to-rack move writes its
    own events and does not rewrite these — which is the honest reading of "ROW
    10 received this day", and the reason this is shown beside a receipt date
    rather than offered as a current location.
    """
    rows = (
        db.query(LotPlacementEvent, StorageRow)
        .join(StorageRow, StorageRow.id == LotPlacementEvent.storage_row_id)
        .join(MaterialLot, MaterialLot.id == LotPlacementEvent.material_lot_id)
        .filter(
            MaterialLot.product_id == product_id,
            LotPlacementEvent.ref_type == "receipt",
            LotPlacementEvent.event_type == EVENT_RECEIVED,
            LotPlacementEvent.full_units_delta > 0,
        )
        .order_by(LotPlacementEvent.occurred_at)
        .all()
    )

    out: Dict[str, list] = {}
    for event, row in rows:
        if not event.ref_id:
            continue
        bucket = out.setdefault(event.ref_id, [])
        # One receipt can put away onto the same rack twice (a paused and
        # resumed scan); report the rack once with the total.
        for entry in bucket:
            if entry["storage_row_id"] == row.id:
                entry["units"] += int(event.full_units_delta)
                break
        else:
            bucket.append({
                "storage_row_id": row.id,
                "storage_row_name": row.name,
                "units": int(event.full_units_delta),
            })
    return out


# ─── translating the legacy quantity language into units ──────────────────────
#
# Staging, adjustments and transfers all speak in CONTENT — "stage 500 lbs",
# "adjust down by 250". A placement counts CONTAINERS. These two functions are
# the whole of the translation, and every converted caller goes through them.
#
# The old code did this by spreading the requested weight across every rack
# holding the lot, proportionally to each rack's share. That is a smear: it
# leaves 12.7 drums on one rack and 27.3 on another, and nobody ever removed
# seven tenths of a drum. Worse, it makes the numbers unfalsifiable — you cannot
# walk to a rack and check a fraction. Whole units off named racks can be
# checked, which is the entire point of counting them.

def _free_units(placement: LotPlacement) -> int:
    """Sealed units on this rack that are NOT quarantined.

    The one definition of "available on this rack", used by every path that
    takes or moves units so a hold cannot be walked around by picking a
    different operation.
    """
    return max(0, int(placement.full_units or 0) - int(placement.held_units or 0))


def units_for_quantity(lot: MaterialLot, quantity: float) -> int:
    """Whole units carrying at least `quantity` of content.

    Rounds UP, because containers are indivisible: pulling 600 lbs of a 500 lb
    drum means taking two drums off the rack, not one and a fifth. The remainder
    comes back as a partial when production returns it.

    A lot with no weight per unit cannot answer this. That is already blocked
    upstream — `find_or_create_lot` flags such a lot for review and no sticker
    prints for it — so reaching here means something skipped the gate.
    """
    per_unit = float(lot.weight_per_unit or 0)
    if per_unit <= 0:
        raise ValidationError(
            f"Lot {lot.lot_code} has no weight per {lot.unit_label}, so a "
            f"quantity of {quantity} cannot be turned into a count."
        )
    return int(math.ceil((float(quantity) - 1e-9) / per_unit))


def take_units(
    db: Session,
    lot: MaterialLot,
    *,
    units: int,
    event_type: str,
    from_row_id: Optional[str] = None,
    actor_id: Optional[str] = None,
    ref_type: Optional[str] = None,
    ref_id: Optional[str] = None,
    reason: Optional[str] = None,
) -> List[dict]:
    """Remove `units` whole units from this lot's racks. Returns what went where.

    `from_row_id` names the rack when the caller knows it. When it does not, the
    racks are drained FULLEST FIRST — a deliberate choice over "a bit from each",
    because it produces a pull instruction a person can follow ("take 2 from
    ROW 3") and it empties racks rather than leaving a scatter of ones and twos
    across the warehouse.

    The returned list is what actually happened, per rack, and is what the caller
    should show on the ticket.
    """
    if units <= 0:
        return []

    # A held lot is quarantined entire, wherever it sits. Refused here rather
    # than filtered to zero further down, because "there is none" and "it is on
    # hold" are different facts and only one of them is somebody's to fix.
    if lot.is_held:
        raise ConflictError(
            f"Lot {lot.lot_code} is on hold"
            f"{f' — {lot.hold_reason}' if lot.hold_reason else ''}. "
            "Release the hold before moving any of it."
        )

    if from_row_id:
        candidates = [p for p in placements_for_lot(db, lot.id) if p.storage_row_id == from_row_id]
        if not candidates:
            raise ConflictError(
                f"Lot {lot.lot_code} has nothing in that rack to take."
            )
    else:
        candidates = sorted(
            placements_for_lot(db, lot.id),
            key=lambda p: _free_units(p),
            reverse=True,
        )

    # Quarantined drums are frozen in place: they are on the rack but they are
    # not available, so they count towards neither what can be taken nor what
    # "there is not enough" is measured against.
    on_hand = sum(_free_units(p) for p in candidates)
    if on_hand < units:
        held = sum(int(p.held_units or 0) for p in candidates)
        raise ConflictError(
            f"Lot {lot.lot_code} has {on_hand} {lot.unit_label}"
            f"{'' if on_hand == 1 else 's'} in reach but {units} "
            f"{'was' if units == 1 else 'were'} asked for"
            + (f" ({held} on hold)" if held else "")
            + ". Count the racks and correct them, or take less."
        )

    taken: List[dict] = []
    remaining = units
    for placement in candidates:
        if remaining <= 0:
            break
        available = _free_units(placement)
        if available <= 0:
            continue
        n = min(available, remaining)
        apply_delta(
            db, lot, placement.storage_row_id,
            event_type=event_type,
            full_units_delta=-n,
            actor_id=actor_id, ref_type=ref_type, ref_id=ref_id, reason=reason,
        )
        taken.append({"storage_row_id": placement.storage_row_id, "units": n})
        remaining -= n

    return taken


def put_units(
    db: Session,
    lot: MaterialLot,
    *,
    units: int,
    to_row_id: str,
    event_type: str,
    actor_id: Optional[str] = None,
    ref_type: Optional[str] = None,
    ref_id: Optional[str] = None,
    reason: Optional[str] = None,
) -> Optional[LotPlacement]:
    """Put `units` back on a named rack — the reverse of `take_units`.

    Always takes a rack rather than guessing one. Material coming back from
    staging goes where somebody physically puts it, and the caller knows that
    (staging remembers `original_storage_row_id`); inventing a rack here would
    make the system confidently wrong about where to look for it.
    """
    if units <= 0:
        return None
    if not to_row_id:
        raise ValidationError(
            f"Returning {units} {lot.unit_label}s needs a rack to put them on."
        )
    return apply_delta(
        db, lot, to_row_id,
        event_type=event_type,
        full_units_delta=int(units),
        actor_id=actor_id, ref_type=ref_type, ref_id=ref_id, reason=reason,
    )


# ─── projection into the legacy shape ─────────────────────────────────────────

def project_lot(db: Session, lot: MaterialLot) -> None:
    """Overwrite the legacy allocation JSON and row counters from placements.

    Runs inside the same transaction as every mutation. Recompute-from-source,
    never a delta — so running it twice is identical to running it once, and a
    missed run self-heals on the next mutation.

    Writing a REAL `cases` value fixes two live defects for free:
      * `row_allocation._entry_cases` stops falling back to
        `pallets * DEFAULT_CASES_PER_PALLET (40)`, which made a 20,000 lb /
        40-pallet lot read back as 1,600 "cases"
      * `frontend/src/utils/rowSources.js` filters `cases > 0`, so ingredient
        receipts stop skipping allocation mode 1 and falling into its
        product-row scanning heuristics
    """
    placements = placements_for_lot(db, lot.id, include_empty=True)
    by_row = {p.storage_row_id: p for p in placements}

    receipts = (
        db.query(Receipt)
        .filter(Receipt.material_lot_id == lot.id, Receipt.is_deleted == False)  # noqa: E712
        .order_by(Receipt.receipt_date, Receipt.created_at)
        .all()
    )
    if not receipts:
        # Still flush. A lot can legitimately have no receipt — the Phase 3
        # opening balance creates the lot and its placement directly — and the
        # row counters it just wrote must be visible to the rest of this
        # transaction, not left pending in the session.
        _project_rows(db, lot, by_row)
        db.flush()
        return

    # One lot can span several receipts (the same vendor lot on many trucks).
    # The placement is the truth for the LOT, so the newest receipt carries the
    # full projected picture and older ones are emptied — otherwise the same
    # drums would be counted once per receipt by anything summing the JSON.
    primary = receipts[-1]
    rows_by_id = _rows_by_id(db, [p.storage_row_id for p in placements])
    areas_by_id = _areas_by_id(db, [r.storage_area_id for r in rows_by_id.values()])

    entries = []
    for placement in placements:
        units = int(placement.full_units or 0) + int(placement.open_units or 0)
        if units <= 0:
            continue
        row = rows_by_id.get(placement.storage_row_id)
        area = areas_by_id.get(row.storage_area_id) if row else None
        # Key-for-key the shape add_rm_rows writes, so every existing reader of
        # this JSON keeps working without knowing lots exist.
        entries.append({
            "rowId": placement.storage_row_id,
            "rowName": row.name if row else "",
            "areaId": row.storage_area_id if row else None,
            "areaName": area.name if area else "",
            # Content in the receipt's storage unit — for an ingredient that is
            # weight, which is exactly what `cases` means in this JSON.
            "cases": round(derived_weight(lot, placement), 3),
            # Physical footprint. Units are what we actually know; pallets are
            # not tracked in the lot model, so report the unit count rather than
            # inventing a pallet estimate from a cases-per-pallet ratio that has
            # no meaning for drums.
            "pallets": units,
            # Additive keys — ignored by existing readers, and the honest figure
            # for anything that learns to read them.
            "units": units,
            "unitLabel": lot.unit_label,
            # QUARANTINE, projected so every reader of this JSON can see it
            # without asking the lot separately.
            #
            # A whole-lot hold reports ALL of them held, because that is what it
            # means — the flag lives on the lot and the placements know nothing
            # about it. Without this a partially-held lot looked completely
            # un-held to `receipt.hold`, which is what made it impossible to
            # release from the Holds screen.
            "heldUnits": units if lot.is_held else int(placement.held_units or 0),
        })

    primary.raw_material_row_allocations = entries
    for older in receipts[:-1]:
        if older.raw_material_row_allocations:
            older.raw_material_row_allocations = []

    _project_rows(db, lot, by_row)
    db.flush()


def _rows_by_id(db: Session, row_ids) -> Dict[str, StorageRow]:
    ids = [r for r in set(row_ids) if r]
    if not ids:
        return {}
    return {
        r.id: r for r in db.query(StorageRow).filter(StorageRow.id.in_(ids)).all()
    }


def _areas_by_id(db: Session, area_ids) -> Dict[str, StorageArea]:
    ids = [a for a in set(area_ids) if a]
    if not ids:
        return {}
    return {
        a.id: a for a in db.query(StorageArea).filter(StorageArea.id.in_(ids)).all()
    }


def _pallet_footprint(lot: Optional[MaterialLot], units: int) -> int:
    """How many rack pallet-slots `units` of this lot take up.

    For barrels and totes the container IS the thing on the shelf, so the
    footprint is the count — one drum, one slot. That was the only case when
    this was written, and drum rooms carry `pallet_capacity = 0` ("no opinion"),
    so nobody noticed it was the only case.

    For bags and boxes it is wrong by a factor of fifty. Five hundred bags are
    ten wrapped pallets, and a rack holding ten pallets that reports 500 against
    a capacity of 100 is telling the warehouse something untrue about its own
    shelf.

    Rounded UP and computed PER LOT, never per row: two lots of twenty-five bags
    are two part-used pallets, not one, because different lots do not share a
    wrap. Summing ceilings is therefore the honest total even though it exceeds
    ceil(sum).
    """
    if units <= 0:
        return 0
    per = int(getattr(lot, "units_per_pallet", None) or 0)
    if per > 1:
        return int(math.ceil(units / per))
    return int(units)


def _project_rows(db: Session, lot: MaterialLot, by_row: Dict[str, LotPlacement]) -> None:
    """Recompute StorageRow.occupied_* for every row this lot touches.

    Sums across ALL lots in the row, not just this one — a row holds several lots
    and several products, and `occupied_*` is a row-level total read by hard gates
    in routers/receipts.py. Recomputing this lot's share alone would leave the
    other lots' contribution behind as a permanent overcount.
    """
    row_ids = [rid for rid in by_row if rid]
    if not row_ids:
        return

    placements = (
        db.query(LotPlacement).filter(LotPlacement.storage_row_id.in_(row_ids)).all()
    )
    lot_ids = {p.material_lot_id for p in placements}
    lots = {lot.id: lot}
    missing = [lid for lid in lot_ids if lid not in lots]
    if missing:
        for other in db.query(MaterialLot).filter(MaterialLot.id.in_(missing)).all():
            lots[other.id] = other

    footprints: Dict[str, int] = {rid: 0 for rid in row_ids}
    weight_totals: Dict[str, float] = {rid: 0.0 for rid in row_ids}
    for placement in placements:
        rid = placement.storage_row_id
        units = int(placement.full_units or 0) + int(placement.open_units or 0)
        p_lot = lots.get(placement.material_lot_id)
        footprints[rid] = footprints.get(rid, 0) + _pallet_footprint(p_lot, units)
        if p_lot:
            weight_totals[rid] = weight_totals.get(rid, 0.0) + derived_weight(p_lot, placement)

    for row in _rows_by_id(db, row_ids).values():
        row.occupied_cases = round(weight_totals.get(row.id, 0.0), 3)
        row.occupied_pallets = footprints.get(row.id, 0)
        # Deliberately NOT setting row.product_id: it encodes one-product-per-row,
        # which directly contradicts a row holding several lots and products. The
        # products in a row are derived from its placements instead.


# ─── reconciliation ───────────────────────────────────────────────────────────

def reconcile_lot(db: Session, material_lot_id: str) -> dict:
    """Ledger vs placement, per row. A non-empty result means a write path is wrong.

    Nothing auto-heals here. Silently correcting drift is how the previous
    denormalisation bugs stayed invisible for so long.
    """
    ledger = (
        db.query(
            LotPlacementEvent.storage_row_id,
            func.coalesce(func.sum(LotPlacementEvent.full_units_delta), 0),
            func.coalesce(func.sum(LotPlacementEvent.open_units_delta), 0),
        )
        .filter(LotPlacementEvent.material_lot_id == material_lot_id)
        .group_by(LotPlacementEvent.storage_row_id)
        .all()
    )
    ledger_by_row = {r[0]: (int(r[1] or 0), int(r[2] or 0)) for r in ledger}

    rows = []
    for placement in placements_for_lot(db, material_lot_id, include_empty=True):
        l_full, l_open = ledger_by_row.get(placement.storage_row_id, (0, 0))
        if l_full == int(placement.full_units or 0) and l_open == int(placement.open_units or 0):
            continue
        rows.append({
            "storage_row_id": placement.storage_row_id,
            "placement_full_units": int(placement.full_units or 0),
            "ledger_full_units": l_full,
            "placement_open_units": int(placement.open_units or 0),
            "ledger_open_units": l_open,
        })
    return {"material_lot_id": material_lot_id, "drifted": len(rows), "rows": rows}
