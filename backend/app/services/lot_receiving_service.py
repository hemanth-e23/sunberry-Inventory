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

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.enums import (
    INCOMING_RECEIVABLE_STATUSES,
    IncomingOrderStatus,
    ReceiptStatus,
)
from app.exceptions import ConflictError, NotFoundError, ValidationError
from app.constants import CATEGORY_FINISHED, is_palletised_unit, pluralize_unit
from app.models import (
    Category,
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
from app.utils.calendar_dates import calendar_day

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
    return pluralize_unit(label)


# What a sticker with no lot behind it means. It is not "not one of ours":
# the usual case is a real supplier lot whose truck was not checked in yet, or
# the supplier's own barcode scanned instead of ours (browser test F13).
UNKNOWN_STICKER_MESSAGE = (
    "No lot with this sticker has been checked in or received yet. Scan the "
    "sticker the office printed, or ask the office."
)


# ─── lot resolution ───────────────────────────────────────────────────────────

def ensure_lot_for_receipt(
    db: Session, receipt: Receipt, *, user_id=None, units_per_pallet=None
) -> MaterialLot:
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
            # A packing fact the lot may not have had when it was minted — the
            # receipt can be approved (which mints the lot) before anybody fills
            # in how many bags ride a pallet. Filled when missing, NEVER
            # overwritten: pallets already received were counted under the old
            # figure, and restating it would restate their footprint too. Same
            # rule `find_or_create_lot` applies on the second-truck path.
            # ...and only for material that arrives wrapped. This path skips
            # `find_or_create_lot`, so it needs the same guard: a drum lot given
            # a per-pallet figure prints pallet stickers for containers that
            # each wear their own.
            if (
                lot.units_per_pallet is None
                and units_per_pallet
                and is_palletised_unit(lot.unit_label)
            ):
                lot.units_per_pallet = int(units_per_pallet)
                db.flush()
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
        units_per_pallet=units_per_pallet,
    )
    receipt.material_lot_id = lot.id
    db.flush()
    return lot


def logged_rows(receipt: Receipt) -> list:
    """`(row_id, units)` for what the Log Receipt form typed. Units, not pallets.

    The form has always sent PALLETS per row; units per row is new, and older
    receipts do not carry it. Three cases, in order:

      * any row states units -> use the stated ones, ignore rows stating none
      * exactly one row and no units -> every container is on that row, so
        `container_count` is exact rather than a guess
      * several rows and none state units -> place NOTHING

    That last case looks unhelpful and is the honest answer. Splitting 40 drums
    across three rows by their pallet share invents a per-rack number nobody
    counted, and it would be indistinguishable afterwards from one somebody did.
    Leaving the material unplaced is visible and fixable; a fabricated placement
    is neither.
    """
    total = int(float(receipt.container_count or 0))
    allocs = receipt.raw_material_row_allocations

    if isinstance(allocs, list) and allocs:
        # Entries written by `project_lot` are a read-model of the placement
        # ledger, not a person's claim about where drums went. Treating them
        # as typed rows re-applies every scanned unit at approval time — and
        # when they are ALL projected, the answer is "nothing left to place",
        # not the storage_row_id fallback below (same replay, other door).
        human = [
            a for a in allocs
            if not (isinstance(a, dict) and a.get("source") == "projection")
        ]
        if not human:
            return []
        typed = [
            (a.get("rowId"), int(float(a.get("units") or 0)))
            for a in human
            if isinstance(a, dict) and a.get("rowId")
        ]
        stated = [(rid, units) for rid, units in typed if units > 0]
        if stated:
            return stated
        if len(typed) == 1 and total > 0:
            return [(typed[0][0], total)]
        return []

    if receipt.storage_row_id and total > 0:
        return [(receipt.storage_row_id, total)]
    return []


def place_logged_receipt(db: Session, receipt: Receipt, *, actor_id=None):
    """Record WHERE a logged receipt's material physically sits.

    Route 1 of the three ways material enters. Somebody with a clipboard types
    what is ALREADY on the racks — product, vendor lot, BBD, how many drums, and
    which rows — and this turns the rows they typed into placements. Without it
    the system knows the lot exists and prints correct stickers for it, but
    picking, staging and the row cards cannot see where the drums are.

    Runs at APPROVAL rather than at save: entering a receipt is a claim, and
    approving it is the confirmation that the claim is true.

    ADDITIVE, never absolute. `set_count` is the wrong primitive here despite the
    form stating a total, because the total is this DELIVERY's and not the
    RACK's: a second truck of the same vendor lot onto the same row has to make
    it 80 drums, not overwrite 40 with 40. A per-(receipt, row) idempotency key
    is what makes a replay safe instead.
    """
    if receipt is None or not receipt.product_id:
        return None

    # Finished goods locate themselves through pallet licences and their own
    # allocation plan. They have no lot and must not be given one here.
    category = (
        db.query(Category).filter(Category.id == receipt.category_id).first()
        if receipt.category_id
        else None
    )
    if category and category.type == CATEGORY_FINISHED:
        return None

    # If ANY unit of this receipt was scanned in on the gun, the scans are the
    # placement and approval must not add a second one on top. The projection
    # filter in `logged_rows` is the primary defence; this guard also covers
    # older receipts whose JSON predates the `source` tag.
    if receipt.material_lot_id:
        scanned = (
            db.query(LotPlacementEvent.id)
            .filter(
                LotPlacementEvent.material_lot_id == receipt.material_lot_id,
                LotPlacementEvent.event_type == lps.EVENT_RECEIVED,
                LotPlacementEvent.ref_id == receipt.id,
                or_(
                    LotPlacementEvent.idempotency_key.is_(None),
                    ~LotPlacementEvent.idempotency_key.like("logged:%"),
                ),
            )
            .first()
        )
        if scanned:
            return (
                db.query(MaterialLot)
                .filter(MaterialLot.id == receipt.material_lot_id)
                .first()
            )

    rows = logged_rows(receipt)
    if not rows:
        # Room-level receipt: the form named a room, not a rack. When the room
        # has exactly ONE active row, that row is what the person meant — the
        # same resolution `resolve_breakdown` applies to transfer sources. A
        # room with several rows stays unplaced: picking one would invent a
        # rack nobody counted from.
        total = int(float(receipt.container_count or 0))
        if total > 0 and receipt.sub_location_id:
            row_ids = [
                rid
                for (rid,) in db.query(StorageRow.id)
                .filter(
                    StorageRow.sub_location_id == receipt.sub_location_id,
                    StorageRow.is_active == True,  # noqa: E712
                )
                .all()
            ]
            if len(row_ids) == 1:
                rows = [(row_ids[0], total)]
    if not rows:
        return None

    lot = ensure_lot_for_receipt(
        db, receipt, user_id=actor_id, units_per_pallet=receipt.units_per_pallet
    )
    for row_id, units in rows:
        lps.apply_delta(
            db,
            lot,
            row_id,
            event_type=lps.EVENT_RECEIVED,
            full_units_delta=units,
            actor_id=actor_id,
            ref_type="receipt",
            ref_id=receipt.id,
            reason="Logged receipt",
            idempotency_key=f"logged:{receipt.id}:{row_id}",
        )
    return lot


_WEIGHT_UNITS = {"lb", "lbs", "pound", "pounds", "kg", "kgs", "kilogram", "kilograms"}


def _expected_units_for_approval(receipt: Receipt) -> Optional[int]:
    """How many containers the paperwork claims, best effort.

    Priority: the typed container count; then weight ÷ weight-per-container;
    then — when the quantity is itself a count (its unit is neither a weight
    nor the FG word "cases") — the quantity. None when no reading is
    defensible, which the approval gate turns into a refusal rather than a
    guess.
    """
    cc = float(receipt.container_count or 0)
    if cc > 0:
        return int(round(cc))
    qty = float(receipt.quantity or 0)
    w = float(receipt.weight_per_container or 0)
    if qty > 0 and w > 0:
        return int(round(qty / w))
    unit = (receipt.unit or "").strip().lower()
    if qty > 0 and unit and unit not in _WEIGHT_UNITS and unit != "cases":
        return int(round(qty))
    return None


def approve_gate_and_place(db: Session, receipt: Receipt, *, actor_id=None):
    """The approval-time contract: the ledger must end up matching the paper.

    Approving a receipt is what puts its quantity into every product total, so
    this is the moment the physical ledger has to agree — approving paper the
    racks contradict is exactly the 2026-09-14 phantom incident (~170 drums in
    the books, zero on any rack). Two intake modes, detected by whether the gun
    touched this receipt:

    * SCAN MODE (receiving scans exist): the scans ARE the placement. Approval
      requires the forklift to have submitted the session, and the paperwork
      is corrected TO the scanned count — the submitted session is the audit
      trail for a short or over delivery.

    * LOGGED MODE (no scans): drums were racked before the system heard of
      them; the typed rows become placements here, and approval refuses unless
      they fully cover the stated container count.

    Finished goods pass straight through — pallet licences are their ledger.
    """
    if receipt is None or not receipt.product_id:
        return None
    category = (
        db.query(Category).filter(Category.id == receipt.category_id).first()
        if receipt.category_id
        else None
    )
    if category and category.type == CATEGORY_FINISHED:
        return None

    scanned = int(session_counts(db, receipt).get("total") or 0)

    if scanned > 0:
        lot = ensure_lot_for_receipt(
            db, receipt, user_id=actor_id, units_per_pallet=receipt.units_per_pallet
        )
        word = unit_word(lot, scanned)
        if not receipt.forklift_submitted_at:
            raise ValidationError(
                f"{scanned} {word} scanned but the forklift has not submitted the "
                "receiving session yet. Approval waits for the forklift's submit."
            )
        # Usually a no-op by now: the forklift's Finish already booked the
        # scanned count (F9). It still runs for scans that landed after Finish
        # and for sessions finished before that change.
        book_scanned_count(db, receipt, lot=lot, stage="Approval correction")
        return lot

    expected = _expected_units_for_approval(receipt)
    if not expected or expected <= 0:
        raise ValidationError(
            "This receipt does not say how many containers arrived. Add the "
            "container count (or scan the units in) before approving."
        )
    lot = place_logged_receipt(db, receipt, actor_id=actor_id)
    placed = int(
        db.query(func.coalesce(func.sum(LotPlacementEvent.full_units_delta), 0))
        .filter(
            LotPlacementEvent.ref_type == "receipt",
            LotPlacementEvent.ref_id == receipt.id,
        )
        .scalar()
        or 0
    )
    if placed < expected:
        word = unit_word(lot, expected)
        raise ValidationError(
            f"The rows on this receipt place {placed} of {expected} {word}. "
            "Enter the count for every row (or scan the units in) before approving."
        )
    return lot


def book_scanned_count(
    db: Session,
    receipt: Receipt,
    *,
    lot: Optional[MaterialLot] = None,
    stage: str = "Approval correction",
) -> bool:
    """Make the receipt's quantity and container count say what was SCANNED.

    The one rule, shared by Finish and by approval. Scanned units are live stock
    the moment they are scanned, so a receipt still carrying the paperwork
    figure misleads everything that reads `receipt.quantity` until somebody
    approves it (browser test 2026-10-01, F9: 80 bags on paper, 70 on the
    rack). Finish books the count; approval then finds nothing to correct,
    which is what keeps approval idempotent.

    Returns True when something changed. A receipt with no scans is left
    alone: that is a logged receipt, and its paperwork is all there is.
    """
    scanned = int(session_counts(db, receipt).get("total") or 0)
    if scanned <= 0:
        return False
    expected = _expected_units_for_approval(receipt)
    if expected is not None and scanned == expected:
        return False
    if lot is None and receipt.material_lot_id:
        lot = db.query(MaterialLot).filter(MaterialLot.id == receipt.material_lot_id).first()
    word = unit_word(lot, scanned)
    w = float(receipt.weight_per_container or 0)
    if w > 0:
        receipt.quantity = float(scanned) * w
    elif expected and float(receipt.quantity or 0) > 0:
        receipt.quantity = float(receipt.quantity) * scanned / expected
    else:
        receipt.quantity = float(scanned)
    receipt.container_count = float(scanned)
    receipt.note = (
        f"{receipt.note or ''}\n[{stage}: booked at the "
        f"{scanned} {word} the forklift scanned"
        + (f"; paperwork said {expected}" if expected else "")
        + "]"
    ).strip()
    return True


def reverse_receiving_for_reject(
    db: Session,
    receipt: Receipt,
    *,
    actor_id: Optional[str] = None,
    reason: Optional[str] = None,
) -> int:
    """Take a rejected line's scanned units back off the racks. Returns units removed.

    Rejecting the paperwork of a line whose drums were already scanned in used
    to be refused with "have the forklift undo the scans", which is impossible
    once the truck is finished because the truck leaves the gun (browser test
    2026-10-01, F8). The supervisor's reject now reverses the receiving events
    itself: one compensating ledger event per lot and rack, on the same
    `receiving` ref so the session nets to zero, with the reason recorded.

    Refuses, and changes nothing, when the units cannot honestly be taken
    back: anything of that lot has left that rack since the first scan of this
    receipt (moved, staged, used; drums of one lot are interchangeable, so the
    system cannot tell whose left), the rack holds fewer than were scanned, or
    some of them are on a per-rack QA hold.
    """
    events = (
        db.query(LotPlacementEvent)
        .filter(
            LotPlacementEvent.ref_type == REF_TYPE_RECEIVING,
            LotPlacementEvent.ref_id == receipt.id,
        )
        .order_by(LotPlacementEvent.seq)
        .all()
    )
    if not events:
        return 0

    net: dict = {}
    first_seq: dict = {}
    for ev in events:
        key = (ev.material_lot_id, ev.storage_row_id)
        net[key] = net.get(key, 0) + int(ev.full_units_delta or 0)
        first_seq.setdefault(key, int(ev.seq or 0))
    net = {k: n for k, n in net.items() if n > 0}
    if not net:
        return 0

    lots = {
        l.id: l for l in db.query(MaterialLot)
        .filter(MaterialLot.id.in_({k[0] for k in net})).all()
    }
    rows = {
        r.id: r for r in db.query(StorageRow)
        .filter(StorageRow.id.in_({k[1] for k in net})).all()
    }

    problems = []
    for (lot_id, row_id), n in net.items():
        lot = lots.get(lot_id)
        row = rows.get(row_id)
        rack = row.name if row else row_id
        word = unit_word(lot, n)
        left_since = (
            db.query(LotPlacementEvent)
            .filter(
                LotPlacementEvent.material_lot_id == lot_id,
                LotPlacementEvent.storage_row_id == row_id,
                LotPlacementEvent.seq > first_seq[(lot_id, row_id)],
                LotPlacementEvent.full_units_delta < 0,
                # Receiving corrections (a removed scan, a rack recount) only
                # take back that truck's own scans; anything else that took
                # units off is a move, a pull or a use.
                or_(
                    LotPlacementEvent.ref_type.is_(None),
                    LotPlacementEvent.ref_type != REF_TYPE_RECEIVING,
                ),
            )
            .order_by(LotPlacementEvent.seq)
            .first()
        )
        placement = (
            db.query(LotPlacement)
            .filter(
                LotPlacement.material_lot_id == lot_id,
                LotPlacement.storage_row_id == row_id,
            )
            .first()
        )
        on_rack = int(placement.full_units or 0) if placement else 0
        held = int(getattr(placement, "held_units", 0) or 0) if placement else 0
        label = (lot.vendor_lot_number or lot.lot_code) if lot else lot_id
        if left_since is not None:
            what = (left_since.event_type or "moved").replace("_", " ")
            problems.append(
                f"{rack}: lot {label} has been {what} off this rack since it was scanned in"
            )
        elif on_rack < n:
            problems.append(
                f"{rack}: only {on_rack} of the {n} {word} scanned in are still there"
            )
        elif on_rack - n < held:
            problems.append(
                f"{rack}: {held} {unit_word(lot, held)} there are on QA hold; release the hold first"
            )
    if problems:
        raise ValidationError(
            "Cannot reject: some of this line's scanned units have moved or been "
            "used since they were received, so they cannot be taken back "
            "automatically. " + "; ".join(problems) + ". Approve it and adjust "
            "instead, or correct the racks first."
        )

    note = f"Receipt rejected: {reason}" if reason else "Receipt rejected"
    removed = 0
    for (lot_id, row_id), n in net.items():
        lps.apply_delta(
            db, lots[lot_id], row_id,
            event_type=lps.EVENT_ADJUSTED,
            full_units_delta=-n,
            actor_id=actor_id,
            ref_type=REF_TYPE_RECEIVING,
            ref_id=receipt.id,
            reason=note[:500],
            reason_code="receipt_rejected",
        )
        removed += n
    return removed


def _unit_label_for(db: Session, receipt: Receipt) -> str:
    """What one counted unit of this receipt IS.

    Prefers what the receiver typed (`container_unit`), then the storage unit of
    the room they put it in, then a bare "unit". Deliberately never guesses from
    the product.
    """
    raw = (receipt.container_unit or "").strip().lower()
    if raw:
        # "barrels" -> "barrel", "boxes" -> "box". The label is singular
        # everywhere else. Blind s-stripping produced "boxe", which failed
        # `is_palletised_unit` and silently dropped the lot's units_per_pallet
        # — one sticker per box and 1-per-scan on the gun (2026-09-29 audit,
        # bags finding 8; the exact trap constants.py warns about).
        if raw.endswith(("xes", "ches", "shes", "zes")) and len(raw) > 3:
            return raw[:-2]
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

    # A closed receipt takes no more scans (audit I6): an offline queue
    # replaying after the office rejected — or after approval booked the
    # count — must not book stock against closed paperwork. Soft answer, so
    # the queued scan is not marked permanently failed; genuine replays of
    # already-recorded scans returned above, before this gate.
    if receipt.status not in (ReceiptStatus.RECORDED, ReceiptStatus.REVIEWED):
        return _scan_payload(
            db, receipt, None, None,
            status="receipt_closed",
            message=(
                f"This receipt is {receipt.status} and takes no more scans. "
                "See the office before placing these units."
            ),
        )

    lot = resolve_lot_code(db, lot_code)
    if lot is None:
        return _scan_payload(
            db, receipt, None, None,
            status="unknown_lot",
            message=UNKNOWN_STICKER_MESSAGE,
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

    # The per-scan multiplier belongs to the SESSION's lot, not necessarily to
    # the one just scanned. A bag session at "each scan = 50" that reads one
    # drum sticker from the same truck must book ONE drum, not fifty
    # (2026-09-29 audit, bags finding 4). On a cross-lot scan the scanned
    # lot's own packing decides the multiplier.
    if session_lot_mismatch:
        own_per_scan = int(lot.units_per_pallet or 1)
        if int(units) != own_per_scan:
            units = own_per_scan

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
    warning, warning_detail = _row_capacity_warning(db, row, incoming=int(units))
    if warning and not allow_overfill:
        return _scan_payload(
            db, receipt, lot, row,
            status="needs_confirm",
            message=_rack_full_question(db, row),
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
        message = (
            f"Received {int(units)} {unit_word(lot, int(units))} @ {row.name} — "
            f"note this is lot {lot.lot_code}, not the one on this receipt."
        )

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


def submit_session(
    db: Session,
    *,
    receipt_id: str,
    user_id: Optional[str] = None,
    confirmed: bool = False,
) -> dict:
    """The worker says this line is finished, and it leaves the gun.

    Completion is an ACTION, never an inference. `open_sessions` deliberately
    does not hide a line once scanned >= expected, because over-receiving is
    legal and auto-hiding would strand the 81st drum of an expected 80. So the
    only honest way for a line to close is somebody saying so.

    A count that disagrees with the paperwork is not blocked — it is confirmed.
    Both directions happen and both are legal: short means the truck was short,
    over means it carried more. Refusing either would teach workers to make the
    number fit rather than report what they counted. Without `confirmed` a
    mismatch comes back as `needs_confirm` with the difference spelled out, and
    the same call with `confirmed=True` goes through.

    Does NOT touch `receipt.status`. Pending-approval is status in
    (recorded, reviewed); moving it to clear the gun would also drop the receipt
    out of the office's approvals queue, which is the check that happens next.
    """
    receipt = db.query(Receipt).filter(Receipt.id == receipt_id).first()
    if not receipt:
        raise NotFoundError("Receipt", receipt_id)

    if receipt.forklift_submitted_at:
        return {
            "status": "already_submitted",
            "message": "This line was already marked finished.",
            "summary": receiving_summary(db, receipt),
        }

    counts = session_counts(db, receipt)
    scanned = int(counts.get("total") or 0)
    expected = int(expected_units(db, receipt) or 0)
    difference = scanned - expected

    if difference != 0 and not confirmed:
        lot = (
            db.query(MaterialLot).filter(MaterialLot.id == receipt.material_lot_id).first()
            if receipt.material_lot_id else None
        )
        word = unit_word(lot, abs(difference))
        detail = (
            f"{difference} more {word} than the paperwork says."
            if difference > 0
            else f"{-difference} {word} short of the paperwork."
        )
        return {
            "status": "needs_confirm",
            "message": f"{detail} Finish this line anyway?",
            "scanned_count": scanned,
            "expected_count": expected,
            "difference": difference,
            "summary": receiving_summary(db, receipt),
        }

    receipt.forklift_submitted_at = datetime.now(timezone.utc)
    receipt.forklift_submitted_by = user_id
    # The scanned units are already live stock; the receipt says so now, not
    # at approval (F9).
    book_scanned_count(db, receipt, stage="Finished")

    return {
        "status": "submitted",
        "message": "Finished. The office checks the paperwork against these counts.",
        "scanned_count": scanned,
        "expected_count": expected,
        "difference": difference,
        "summary": receiving_summary(db, receipt),
    }


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

    # A hold placed after receiving freezes the lot: undo is a negative delta
    # like any other and must not walk drums off a quarantined rack
    # (2026-09-29 audit, hold GAP 7).
    if lot is not None and lot.is_held:
        return _scan_payload(
            db, receipt, lot, row,
            status="lot_held",
            message=(
                f"Lot {lot.lot_code} is on QA hold — the scan cannot be "
                "undone until the hold is released."
            ),
        )

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


def _row_capacity_warning(db: Session, row: StorageRow, incoming: int = 1):
    """(code, detail) when adding `incoming` units would leave the rack over
    its stated capacity, else (None, None).

    Reads the ROOM's `unit_capacity`, not `StorageRow.pallet_capacity`. The two
    are different physical facts and ingredient rows deliberately carry
    pallet_capacity 0, which means "no opinion" — treating that as "capacity
    zero" would warn on every single scan.

    `incoming` matters for palletised material: at 50 bags a scan, checking
    only what is already on the rack fired the prompt one full pallet late —
    a rack at 40 of 60 took 50 more without a word (2026-09-29 audit, bags
    finding 5). Still a prompt, never a gate.
    """
    fill = _row_fill(db, row)
    if fill is None:
        return (None, None)
    on_hand, capacity, unit = fill
    after = on_hand + max(1, int(incoming or 1))
    if after <= capacity:
        return (None, None)
    return (
        "row_full",
        f"{row.name} would hold {after} of {capacity} "
        f"{pluralize_unit(unit)} after this scan.",
    )


def _row_fill(db: Session, row: StorageRow):
    """(on_hand, capacity, storage unit) for a rack whose room states a unit
    capacity, else None."""
    from app.models import SubLocation

    if not row.sub_location_id:
        return None
    sub = db.query(SubLocation).filter(SubLocation.id == row.sub_location_id).first()
    if not sub or not sub.storage_unit or not sub.unit_capacity:
        return None
    on_hand = (
        db.query(
            func.coalesce(func.sum(LotPlacement.full_units + LotPlacement.open_units), 0)
        )
        .filter(LotPlacement.storage_row_id == row.id)
        .scalar()
    )
    return int(on_hand or 0), int(sub.unit_capacity), sub.storage_unit


def _rack_full_question(db: Session, row: StorageRow) -> str:
    """'QA-D3 holds 12 drums — load past its capacity?' The old 'is full by
    the system' read as a fault in the software (browser test F13)."""
    fill = _row_fill(db, row)
    if fill is None:
        return f"{row.name} is at its capacity — load past it?"
    on_hand, _capacity, unit = fill
    word = unit if on_hand == 1 else pluralize_unit(unit)
    return f"{row.name} holds {on_hand} {word} — load past its capacity?"


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

def label_sheet_for_lot(
    db: Session, lot: MaterialLot, count: int, *, receipt=None, scope: str = "unit"
) -> dict:
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
        "bbd": calendar_day(lot.bbd_current),
        "net_weight": lot.weight_per_unit,
        "weight_unit": lot.weight_unit,
        "unit_label": lot.unit_label,
        # 'unit' or 'pallet'. THE SAME STICKER either way — same lot, same code,
        # same QR — with one word different in the middle band, so a person can
        # see at a glance whether they are holding a bag or a wrapped pallet of
        # them. Scanning either resolves to the same lot, because a bag does not
        # become different material by coming off a pallet.
        #
        # The pallet sticker deliberately prints NO COUNT. If it said "50 BAGS"
        # it would start lying the moment somebody took one, and nobody
        # re-labels a pallet per bag. The count lives in lot_placements, where
        # it can change.
        "pack_scope": scope,
        "units_per_pallet": lot.units_per_pallet,
        "receipt_date": receipt.receipt_date if receipt else None,
    }

    lot.label_printed_at = datetime.now(timezone.utc)
    db.flush()
    return {
        "lot_code": lot.lot_code,
        "count": int(count),
        "scope": scope,
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


def line_lot_key(product_id, vendor_id, vendor_lot, bbd) -> Optional[tuple]:
    """What makes two order lines the SAME lot, or None when it cannot be told.

    The same four parts as `lps.build_lot_key`, with the same normalisation, so
    "two lines are one lot here" agrees exactly with "two receipts mint one lot"
    later. A line with no vendor lot number is never anybody's duplicate — an
    unknown lot never merges with another unknown lot.
    """
    lot = lps.normalize_lot_number(vendor_lot)
    if not lot:
        return None
    return (product_id, vendor_id or "", lot, calendar_day(bbd) or "")


def merge_duplicate_lines(lines: list, *, default_vendor_id=None) -> list:
    """Fold order lines describing the same lot into one, adding their counts.

    A truck has ONE line per lot. Two lines for the same lot cannot be told
    apart at the gun — every drum wears the same sticker — so a scan would have
    no way to know which line it belongs to. Typing it twice is a data-entry
    slip, and the honest correction is one line carrying the sum.
    """
    merged: list = []
    by_key: dict = {}
    for line in lines:
        key = line_lot_key(
            line.get("product_id"),
            line.get("vendor_id") or default_vendor_id,
            line.get("vendor_lot"),
            line.get("bbd"),
        )
        if key is not None and key in by_key:
            keeper = by_key[key]
            keeper["expected_count"] = (
                int(keeper.get("expected_count") or 0) + int(line.get("expected_count") or 0)
            )
            continue
        copy = dict(line)
        merged.append(copy)
        if key is not None:
            by_key[key] = copy
    return merged


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
    for line in merge_duplicate_lines(lines, default_vendor_id=payload.get("vendor_id")):
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
            units_per_pallet=(
                int(line["units_per_pallet"]) if line.get("units_per_pallet") else None
            ),
        ))
    order.expected_count = total
    db.flush()
    return order


def release_order(
    db: Session,
    order: IngredientIntake,
    *,
    user_id: str,
    expected_date=None,
    expected_time: str = None,
):
    """Draft -> in transit, WITH an arrival slot.

    Releasing is a separate step from creating on purpose. Corporate raises the
    order as soon as they have the PO, but the arrival slot is agreed with the
    carrier afterwards — so a draft with no date is a normal state, and the date
    is required only at the moment the order becomes something a plant is
    expected to act on.

    The date is REQUIRED here because the plant's screen is organised by day. An
    order released without one would sit outside every day view and be found only
    by someone who thought to look for it.
    """
    if order.status != IncomingOrderStatus.DRAFT.value:
        raise ConflictError(f"This order is {order.status}, so it cannot be released again")

    if expected_date is not None:
        order.expected_date = expected_date
    if expected_time is not None:
        order.expected_time = (expected_time or "").strip() or None

    if not order.expected_date:
        raise ValidationError(
            "Pick the day this shipment reaches the warehouse before releasing it — "
            "the plant's incoming screen is organised by day."
        )

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
    lot: Optional[MaterialLot] = None,
) -> Receipt:
    """The plant opens a line and begins. Creates the receipt and the lot.

    `lot` is passed only for a line the truck flow adds on the fly, for a drum
    whose lot was not on the paperwork. That lot already exists — the sticker
    was read off it — so its identity is reused as-is rather than re-derived
    from the line, and the vendor gate below has nothing left to protect.

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
    vendor_id = overrides.get("vendor_id") or line.vendor_id or order.vendor_id
    vendor_lot = overrides.get("vendor_lot", line.vendor_lot)
    bbd = overrides.get("bbd", line.bbd)
    weight_per_unit = overrides.get("weight_per_unit", line.net_weight_per_container)
    weight_unit = overrides.get("weight_unit", line.weight_unit)
    units_per_pallet = overrides.get("units_per_pallet", line.units_per_pallet)
    expected = int(overrides.get("expected_count", line.expected_count) or 0)

    # THE VENDOR GATE, here rather than at order creation.
    #
    # Corporate raises orders before every detail is known and that is fine —
    # an order creates no lot, so nothing can collide. This line is where the
    # lot is minted, and the person running it is holding the driver's BOL.
    #
    # Enforced in the SERVICE rather than only in the form because this failure
    # is silent: `can_print_labels` refuses a lot with no vendor lot number or
    # no best-by, so those two announce themselves at the printer. A missing
    # vendor announces nothing — `build_lot_key` just writes an empty segment,
    # and two suppliers' "LOT001" of the same product with the same best-by
    # quietly become one lot wearing one sticker.
    if not vendor_id and lot is None:
        raise ValidationError(
            "This delivery has no vendor. It is part of what tells this lot "
            "apart from another supplier's lot with the same number, so it has "
            "to be set before anything can be received against it."
        )

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
        # The order path never wrote this, so every order-received bag/box
        # lot's receipt read as non-palletised: the approvals card dropped
        # its pallet line and the pallet-scope tag option vanished
        # (2026-09-29 audit, bags finding 6). The lot gets the same figure
        # via ensure_lot_for_receipt below.
        units_per_pallet=units_per_pallet,
        vendor_id=vendor_id,
        bol=overrides.get("bol", order.bol),
        purchase_order=order.purchase_order,
        warehouse_id=order.warehouse_id,
        status=ReceiptStatus.RECORDED,
        submitted_by=user_id,
        receipt_date=datetime.now(timezone.utc),
        note=f"Received against incoming order {order.intake_number}",
    )
    if lot is not None:
        # ensure_lot_for_receipt returns an already-linked lot untouched.
        receipt.material_lot_id = lot.id
    db.add(receipt)
    db.flush()

    lot = ensure_lot_for_receipt(
        db, receipt, user_id=user_id, units_per_pallet=units_per_pallet
    )

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
    if units_per_pallet != line.units_per_pallet:
        line.units_per_pallet = units_per_pallet

    if order.status == IncomingOrderStatus.IN_TRANSIT.value:
        order.status = IncomingOrderStatus.RECEIVING.value
    db.flush()
    return receipt


# ─── the approval view ────────────────────────────────────────────────────────

def open_sessions(
    db: Session,
    *,
    warehouse_id: Optional[str] = None,
    limit: int = 50,
    walk_in_only: bool = False,
) -> list:
    """Receiving sessions the gun can pick up — from BOTH paths, in one list.

    A worker at the gun does not care whether corporate raised an order or
    somebody logged a walk-in receipt off the driver's BOL. They care that there
    is material to scan in. Splitting this into two screens would make them
    choose the right one before they can do the job.

    A session is open while its receipt is still `recorded` or `reviewed`, its lot
    is resolved, AND — if it came from an incoming order — that order is still
    open. Closing an order does not touch its receipts, so without the second
    half a closed truck stayed on the gun forever with nothing left to scan.

    Deliberately NOT filtered on "scanned < expected": over-receiving is legal,
    and hiding a session the moment it hits the paperwork count would strand the
    81st drum of an expected 80.

    A walk-in has no order, so its receipt status IS its lifecycle — the NOT
    EXISTS below leaves it alone.
    """
    # Receipts belonging to an order that is finished. A closed or cancelled
    # order has nothing left to receive against it.
    closed_order = (
        db.query(IntakeLot.id)
        .join(IngredientIntake, IngredientIntake.id == IntakeLot.intake_id)
        .filter(
            IntakeLot.receipt_id == Receipt.id,
            IngredientIntake.status.in_((
                IncomingOrderStatus.RECEIVED.value,
                IncomingOrderStatus.CLOSED_SHORT.value,
                IncomingOrderStatus.CANCELLED.value,
            )),
        )
        .exists()
    )

    query = (
        db.query(Receipt)
        .filter(
            Receipt.material_lot_id.isnot(None),
            Receipt.is_deleted == False,  # noqa: E712
            Receipt.status.in_((ReceiptStatus.RECORDED, ReceiptStatus.REVIEWED)),
            # The worker said this line is finished. Still pending the office's
            # paperwork check — that is `status` — but done at the gun, so it
            # stops competing for attention with lines still expecting a truck.
            Receipt.forklift_submitted_at.is_(None),
            ~closed_order,
        )
    )
    if warehouse_id:
        query = query.filter(Receipt.warehouse_id == warehouse_id)
    if walk_in_only:
        # Receipts that belong to an incoming order are received a TRUCK at a
        # time (see the truck section below); only the order-less ones are
        # still per-receipt sessions.
        on_order = (
            db.query(IntakeLot.id).filter(IntakeLot.receipt_id == Receipt.id).exists()
        )
        query = query.filter(~on_order)

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
        "bbd": calendar_day(lot.bbd_current if lot else receipt.expiration_date),
        "unit_label": lot.unit_label if lot else None,
        "count_unit": unit_word(lot, 2),
        "expected_count": expected,
        "scanned_count": counts["total"],
        "difference": counts["total"] - expected,
        "weight_per_unit": lot.weight_per_unit if lot else receipt.weight_per_container,
        # NULL for drums and totes, so the gun stays one-scan-one-unit for them.
        # Set for bags and boxes, and it is the prefill for "how many are under
        # this pallet sticker?".
        "units_per_pallet": lot.units_per_pallet if lot else None,
        # THIS delivery's weight per unit: a second truck of the lot at 474
        # is not 502s (2026-10-01).
        "derived_weight": round(
            counts["total"] * float(receipt.weight_per_container or lot.weight_per_unit or 0), 3
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


# ─── truck receiving (2026-10) ────────────────────────────────────────────────
#
# One gun session per incoming order — per TRUCK — instead of one per lot line.
#
# A trailer carries several lots mixed together. Receiving it a line at a time
# made the worker pick a lot and then walk round the trailer hunting for that
# lot's drums; a drum from any other lot was booked against the wrong receipt.
#
# Here the worker scans a rack, then ANY drum on the trailer, and the server
# routes it to its own line by the lot on the sticker. Every line still keeps
# its own receipt and lot underneath, so stock, holds, tracing and the approval
# gate are untouched — only the entry point changes.
#
# Stickers are identical per lot, so two drums of one lot cannot be told apart
# and a double scan is invisible at the moment it happens. The checks that
# compensate, because the person on the gun will make every mistake there is:
#   * more than the paperwork          -> stop and ask, then flag
#   * a lot not on this truck          -> ask, accept, flag (on another truck too)
#   * a held lot                       -> accept (it stays held), flag
#   * a full rack                      -> ask, accept, flag
#   * every rack touched is RECOUNTED  -> by eye, at the rack, before finishing;
#                                         a disagreement corrects the count and
#                                         is flagged
#   * finishing short                  -> needs a reason from a fixed list
# Nothing is refused at the dock: refusing strands a driver holding a drum the
# system will not take. Everything lands on the approval card instead.

from app.constants import (  # noqa: E402
    RECEIVING_FLAG_LOT_HELD,
    RECEIVING_FLAG_NOT_ON_TRUCK,
    RECEIVING_FLAG_OTHER_TRUCK,
    RECEIVING_FLAG_OVER_PAPERWORK,
    RECEIVING_FLAG_RACK_FULL,
    RECEIVING_FLAG_RECOUNT_CORRECTED,
    RECEIVING_FLAG_RECOUNT_OK,
    RECEIVING_FLAG_SHORT,
    TRUCK_SHORT_REASONS,
)
from app.models import ReceivingFlag, User  # noqa: E402

SHORT_REASON_LABELS = {
    "truck_short": "Truck arrived short",
    "damaged": "Damaged on arrival",
    "refused": "Refused at the dock",
    "other": "Other",
}


def _truck_open(order: IngredientIntake) -> bool:
    return (
        order.status in INCOMING_RECEIVABLE_STATUSES
        and order.forklift_submitted_at is None
        and not order.is_deleted
    )


def _lot_words(db: Session, lot: MaterialLot) -> str:
    """'Banana Puree lot E2E-B1' — what is printed big on the drum, which is
    what the worker reads. Our sticker code is a long machine string.

    The product name exactly as stored: `.title()` turned "QA Mango Puree"
    into "Qa Mango Puree" and "(SB)" into "(Sb)" (browser test F13)."""
    product = db.query(Product).filter(Product.id == lot.product_id).first()
    name = (product.name if product and product.name else "").strip()
    number = lot.vendor_lot_number or lot.lot_code
    return f"{name} lot {number}".strip()


def _per_scan_units(lot: MaterialLot, single: bool = False) -> int:
    """What one sticker scan books. The SYSTEM decides, never the worker.

    A palletised lot is stickered per pallet at check-in, so a scan is a whole
    pallet; `single` is the one explicit escape for a loose bag that was given
    its own sticker.
    """
    if single:
        return 1
    return max(1, int(lot.units_per_pallet or 1))


def _line_receipt(db: Session, line: IntakeLot) -> Optional[Receipt]:
    if not line.receipt_id:
        return None
    return db.query(Receipt).filter(Receipt.id == line.receipt_id).first()


def _line_for_lot(order: IngredientIntake, lot: MaterialLot) -> Optional[IntakeLot]:
    for line in order.lots or []:
        if line.material_lot_id == lot.id and line.receipt_id:
            return line
    return None


def _max_seq(db: Session, receipt_id: str, row_id: Optional[str] = None) -> int:
    query = db.query(func.max(LotPlacementEvent.seq)).filter(
        LotPlacementEvent.ref_type == REF_TYPE_RECEIVING,
        LotPlacementEvent.ref_id == receipt_id,
    )
    if row_id:
        query = query.filter(LotPlacementEvent.storage_row_id == row_id)
    return int(query.scalar() or 0)


def _add_flag(
    db: Session,
    order: IngredientIntake,
    kind: str,
    *,
    line: Optional[IntakeLot] = None,
    row_id: Optional[str] = None,
    expected: Optional[int] = None,
    actual: Optional[int] = None,
    detail: Optional[str] = None,
    actor_id: Optional[str] = None,
    event_seq: Optional[int] = None,
) -> ReceivingFlag:
    flag = ReceivingFlag(
        id=_mint_id("rflag"),
        order_id=order.id,
        line_id=line.id if line else None,
        receipt_id=line.receipt_id if line else None,
        material_lot_id=line.material_lot_id if line else None,
        storage_row_id=row_id,
        kind=kind,
        expected=expected,
        actual=actual,
        detail=detail,
        actor_id=actor_id,
        event_seq=event_seq,
    )
    db.add(flag)
    db.flush()
    return flag


def _has_flag(db: Session, order_id: str, kind: str, line_id=None, row_id=None) -> bool:
    query = db.query(ReceivingFlag.id).filter(
        ReceivingFlag.order_id == order_id, ReceivingFlag.kind == kind
    )
    if line_id is not None:
        query = query.filter(ReceivingFlag.line_id == line_id)
    if row_id is not None:
        query = query.filter(ReceivingFlag.storage_row_id == row_id)
    return db.query(query.exists()).scalar()


def _pending_recounts(db: Session, order: IngredientIntake, line_counts: dict) -> list:
    """(rack, line) pairs holding scans nobody has counted by eye yet.

    A recount flag records the ledger `seq` it covered. Any receiving event on
    that line's receipt and rack with a higher seq — another drum, a removal —
    re-opens the rack. A rack whose net count for the line is 0 has nothing to
    count and is skipped.
    """
    receipt_ids = [l.receipt_id for l in order.lots or [] if l.receipt_id]
    if not receipt_ids:
        return []

    latest = {
        (r[0], r[1]): int(r[2] or 0)
        for r in (
            db.query(
                LotPlacementEvent.ref_id,
                LotPlacementEvent.storage_row_id,
                func.max(LotPlacementEvent.seq),
            )
            .filter(
                LotPlacementEvent.ref_type == REF_TYPE_RECEIVING,
                LotPlacementEvent.ref_id.in_(receipt_ids),
            )
            .group_by(LotPlacementEvent.ref_id, LotPlacementEvent.storage_row_id)
            .all()
        )
    }
    counted = {
        (r[0], r[1]): int(r[2] or 0)
        for r in (
            db.query(
                ReceivingFlag.receipt_id,
                ReceivingFlag.storage_row_id,
                func.max(ReceivingFlag.event_seq),
            )
            .filter(
                ReceivingFlag.order_id == order.id,
                ReceivingFlag.kind.in_((RECEIVING_FLAG_RECOUNT_OK, RECEIVING_FLAG_RECOUNT_CORRECTED)),
            )
            .group_by(ReceivingFlag.receipt_id, ReceivingFlag.storage_row_id)
            .all()
        )
    }

    pending = []
    for line in order.lots or []:
        if not line.receipt_id:
            continue
        for row_id, count in (line_counts.get(line.id) or {}).items():
            if count <= 0:
                continue
            if latest.get((line.receipt_id, row_id), 0) > counted.get((line.receipt_id, row_id), 0):
                pending.append({"line_id": line.id, "storage_row_id": row_id, "scanned": count})
    return pending


def truck_summary(db: Session, order: IngredientIntake) -> dict:
    """Everything the gun and the approval card show for one truck."""
    vendor = (
        db.query(Vendor).filter(Vendor.id == order.vendor_id).first()
        if order.vendor_id else None
    )

    lines = []
    line_counts: dict = {}
    row_ids: set = set()
    totals: dict = {}
    for line in order.lots or []:
        product = db.query(Product).filter(Product.id == line.product_id).first()
        lot = (
            db.query(MaterialLot).filter(MaterialLot.id == line.material_lot_id).first()
            if line.material_lot_id else None
        )
        receipt = _line_receipt(db, line)
        counts = session_counts(db, receipt) if receipt else {"by_row": {}, "total": 0}
        by_row = {k: v for k, v in counts["by_row"].items() if v}
        line_counts[line.id] = by_row
        row_ids.update(by_row.keys())

        expected = int(line.expected_count or 0)
        scanned = int(counts["total"] or 0)
        unit = (lot.unit_label if lot else None) or line.container_type or "unit"
        bucket = totals.setdefault(unit, {"unit": unit, "expected": 0, "scanned": 0})
        bucket["expected"] += expected
        bucket["scanned"] += scanned

        lines.append({
            "line_id": line.id,
            "receipt_id": line.receipt_id,
            "receipt_status": receipt.status if receipt else None,
            "product_id": line.product_id,
            "product_name": product.name if product else "",
            "material_lot_id": line.material_lot_id,
            "lot_code": lot.lot_code if lot else None,
            "vendor_lot": line.vendor_lot,
            "bbd": calendar_day(line.bbd),
            "unit_label": unit,
            "count_unit": pluralize_unit(unit),
            "units_per_pallet": lot.units_per_pallet if lot else line.units_per_pallet,
            "expected_count": expected,
            "scanned_count": scanned,
            "difference": scanned - expected,
            "is_held": bool(lot.is_held) if lot else False,
            "rows": [{"storage_row_id": rid, "count": n} for rid, n in by_row.items()],
        })

    pending = _pending_recounts(db, order, line_counts)

    flags = (
        db.query(ReceivingFlag)
        .filter(ReceivingFlag.order_id == order.id)
        .order_by(ReceivingFlag.created_at)
        .all()
    )
    row_ids.update(f.storage_row_id for f in flags if f.storage_row_id)
    row_ids.update(p["storage_row_id"] for p in pending)
    row_names = {
        r.id: r.name
        for r in (
            db.query(StorageRow).filter(StorageRow.id.in_(row_ids)).all() if row_ids else []
        )
    }
    by_line = {l["line_id"]: l for l in lines}
    for line in lines:
        for r in line["rows"]:
            r["storage_row_name"] = row_names.get(r["storage_row_id"], r["storage_row_id"])
    for p in pending:
        line = by_line.get(p["line_id"]) or {}
        p["storage_row_name"] = row_names.get(p["storage_row_id"], p["storage_row_id"])
        p["product_name"] = line.get("product_name")
        p["lot_code"] = line.get("lot_code")
        p["vendor_lot"] = line.get("vendor_lot")
        p["count_unit"] = line.get("count_unit")

    receipt_ids = [l.receipt_id for l in order.lots or [] if l.receipt_id]
    scanner_ids = (
        [
            r[0] for r in db.query(LotPlacementEvent.actor_id)
            .filter(
                LotPlacementEvent.ref_type == REF_TYPE_RECEIVING,
                LotPlacementEvent.ref_id.in_(receipt_ids),
                LotPlacementEvent.actor_id.isnot(None),
            )
            .distinct()
            .all()
        ]
        if receipt_ids else []
    )
    actor_ids = set(scanner_ids) | {f.actor_id for f in flags if f.actor_id}
    if order.forklift_submitted_by:
        actor_ids.add(order.forklift_submitted_by)
    names = {
        u.id: (u.name or u.username)
        for u in (db.query(User).filter(User.id.in_(actor_ids)).all() if actor_ids else [])
    }

    return {
        "order_id": order.id,
        "order_number": order.intake_number,
        "status": order.status,
        "vendor_id": order.vendor_id,
        "vendor_name": vendor.name if vendor else None,
        "origin_name": order.origin_name,
        "bol": order.bol,
        "purchase_order": order.purchase_order,
        "expected_date": order.expected_date,
        "warehouse_id": order.warehouse_id,
        "checked_in": bool(order.lots) and all(l.receipt_id for l in order.lots),
        "forklift_submitted_at": order.forklift_submitted_at,
        "forklift_submitted_by_name": names.get(order.forklift_submitted_by),
        "short_reason": order.short_reason,
        "scanned_by": sorted({names.get(a, a) for a in scanner_ids}),
        "lines": lines,
        "totals": list(totals.values()),
        "pending_recounts": pending,
        "flags": [
            {
                "id": f.id,
                "kind": f.kind,
                "line_id": f.line_id,
                "lot_code": (by_line.get(f.line_id) or {}).get("lot_code"),
                "vendor_lot": (by_line.get(f.line_id) or {}).get("vendor_lot"),
                "product_name": (by_line.get(f.line_id) or {}).get("product_name"),
                "storage_row_id": f.storage_row_id,
                "storage_row_name": row_names.get(f.storage_row_id),
                "expected": f.expected,
                "actual": f.actual,
                "detail": f.detail,
                "actor_name": names.get(f.actor_id),
                "created_at": f.created_at,
            }
            for f in flags
        ],
    }


def _truck_payload(
    db: Session,
    order: IngredientIntake,
    *,
    status: str,
    message: str,
    line: Optional[IntakeLot] = None,
    lot: Optional[MaterialLot] = None,
    row: Optional[StorageRow] = None,
    units: int = 0,
    warning: Optional[str] = None,
    warning_detail: Optional[str] = None,
    flag: Optional[str] = None,
    scan_id: Optional[str] = None,
) -> dict:
    """The one shape every truck scan / remove answer uses. Always the whole
    truck too, so the gun never has to stitch counts together itself."""
    summary = truck_summary(db, order)
    line_out = next(
        (l for l in summary["lines"] if line is not None and l["line_id"] == line.id), None
    )
    row_count = 0
    if line_out and row is not None:
        row_count = next(
            (r["count"] for r in line_out["rows"] if r["storage_row_id"] == row.id), 0
        )
    return {
        "status": status,
        "message": message,
        "order_id": order.id,
        "line_id": line.id if line else None,
        "lot_code": lot.lot_code if lot else None,
        "product_name": line_out["product_name"] if line_out else None,
        "row_id": row.id if row else None,
        "row_name": row.name if row else None,
        "units": int(units or 0),
        "line_scanned_count": line_out["scanned_count"] if line_out else 0,
        "line_expected_count": line_out["expected_count"] if line_out else 0,
        "row_line_count": row_count,
        "count_unit": line_out["count_unit"] if line_out else unit_word(lot, 2),
        "warning": warning,
        "warning_detail": warning_detail,
        "flag": flag,
        "scan_id": scan_id,
        "truck": summary,
    }


def _other_open_order_for_lot(db: Session, order: IngredientIntake, lot: MaterialLot):
    return (
        db.query(IngredientIntake)
        .join(IntakeLot, IntakeLot.intake_id == IngredientIntake.id)
        .filter(
            IntakeLot.material_lot_id == lot.id,
            IngredientIntake.id != order.id,
            IngredientIntake.is_incoming_order == True,  # noqa: E712
            IngredientIntake.is_deleted == False,  # noqa: E712
            IngredientIntake.status.in_(INCOMING_RECEIVABLE_STATUSES),
        )
        .first()
    )


def _add_extra_line(db: Session, order: IngredientIntake, lot: MaterialLot, *, user_id: str):
    """A drum whose lot is not on this truck's paperwork. Accepted — the drum is
    physically here and has to go somewhere — as a new line with nothing
    expected, so its count is visibly all-extra on the approval card."""
    line = IntakeLot(
        id=_mint_id("inline"),
        intake=order,
        product_id=lot.product_id,
        category_id=_category_for_product(db, lot.product_id),
        container_type=((lot.unit_label or "drum")[:10]),
        vendor_id=lot.vendor_id,
        vendor_lot=lot.vendor_lot_number,
        lot_unknown=bool(lot.lot_unknown),
        bbd=lot.bbd_original,
        expected_count=0,
        brix=lot.brix,
        net_weight_per_container=lot.weight_per_unit,
        weight_unit=lot.weight_unit,
        units_per_pallet=lot.units_per_pallet,
    )
    db.add(line)
    db.flush()
    start_receiving(db, order, line, user_id=user_id, lot=lot)
    return line


def truck_scan(
    db: Session,
    *,
    order: IngredientIntake,
    lot_code: str,
    storage_row_id: str,
    user_id: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    allow_overfill: bool = False,
    confirm_over: bool = False,
    single: bool = False,
) -> dict:
    """One sticker scan into one rack, on whichever line of the truck it is.

    ALWAYS returns 200 — see the module docstring. Idempotent replay FIRST.
    """
    if idempotency_key:
        prior = (
            db.query(LotPlacementEvent)
            .filter(LotPlacementEvent.idempotency_key == idempotency_key)
            .first()
        )
        if prior:
            line = db.query(IntakeLot).filter(IntakeLot.receipt_id == prior.ref_id).first()
            lot = db.query(MaterialLot).filter(MaterialLot.id == prior.material_lot_id).first()
            row = db.query(StorageRow).filter(StorageRow.id == prior.storage_row_id).first()
            return _truck_payload(
                db, order, status="ok", message="Already recorded.",
                line=line, lot=lot, row=row, units=int(prior.full_units_delta or 0),
                scan_id=prior.id,
            )

    if not _truck_open(order):
        return _truck_payload(
            db, order, status="truck_closed",
            message=(
                f"{order.intake_number} is finished and takes no more scans. "
                "See the office before putting these away."
            ),
        )

    lot = resolve_lot_code(db, lot_code)
    if lot is None:
        return _truck_payload(
            db, order, status="unknown_lot",
            message=(
                f"No lot with this sticker is expected on {order.intake_number} — "
                "it has not been checked in or received yet. Scan the sticker the "
                "office printed, or ask the office."
            ),
        )

    row = db.query(StorageRow).filter(StorageRow.id == storage_row_id).first()
    if not row or row.is_active is False:
        return _truck_payload(
            db, order, status="unknown_row", lot=lot,
            message=(
                f"{row.name} is deactivated — pick an active rack." if row
                else "That rack is not one we know. Scan the rack label again."
            ),
        )

    units = _per_scan_units(lot, single)
    word = unit_word(lot, units)
    what = _lot_words(db, lot)
    line = _line_for_lot(order, lot)

    # Every prompt is asked BEFORE anything is written, so a "No" leaves the
    # truck exactly as it was — including not adding an extra line for a lot
    # the worker then decides is not theirs to put away.
    other_order = None
    if line is None:
        other_order = _other_open_order_for_lot(db, order, lot)
        if not confirm_over:
            where = (
                f"It is on {other_order.intake_number}, not this truck."
                if other_order else "It is not on any truck we are expecting."
            )
            return _truck_payload(
                db, order, status="needs_confirm_over", lot=lot, row=row, units=units,
                message=f"{what} is not on {order.intake_number}'s paperwork. {where} Put it away anyway?",
            )
    else:
        receipt = _line_receipt(db, line)
        scanned = int(session_counts(db, receipt)["total"] or 0)
        expected = int(line.expected_count or 0)
        if scanned + units > expected and not confirm_over:
            # Say what THIS scan adds, in the line's own unit: a pallet sticker
            # is +40 bags, and "is there really another bag?" hid that (F13).
            question = (
                f"Is there really another full pallet of {units} {word}?"
                if units > 1 else f"Is there really another {word}?"
            )
            return _truck_payload(
                db, order, status="needs_confirm_over", line=line, lot=lot, row=row, units=units,
                message=(
                    f"Paperwork says {expected} {unit_word(lot, expected)} of {what}; "
                    f"this scan adds {units} {word} and would make {scanned + units}. {question}"
                ),
            )

    warning, warning_detail = _row_capacity_warning(db, row, incoming=units)
    if warning and not allow_overfill:
        return _truck_payload(
            db, order, status="needs_confirm", line=line, lot=lot, row=row, units=units,
            message=_rack_full_question(db, row),
            warning=warning, warning_detail=warning_detail,
        )

    flag = None
    if line is None:
        line = _add_extra_line(db, order, lot, user_id=user_id)
        flag = RECEIVING_FLAG_OTHER_TRUCK if other_order else RECEIVING_FLAG_NOT_ON_TRUCK
        _add_flag(
            db, order, flag, line=line, expected=0, actor_id=user_id,
            detail=(
                f"Lot {lot.lot_code} belongs to {other_order.intake_number}"
                if other_order else f"Lot {lot.lot_code} was not on any expected truck"
            ),
        )
    receipt = _line_receipt(db, line)

    lps.apply_delta(
        db, lot, row.id,
        event_type=lps.EVENT_RECEIVED,
        full_units_delta=units,
        actor_id=user_id,
        ref_type=REF_TYPE_RECEIVING,
        ref_id=receipt.id,
        idempotency_key=idempotency_key,
    )
    event = (
        db.query(LotPlacementEvent)
        .filter(LotPlacementEvent.idempotency_key == idempotency_key)
        .first()
        if idempotency_key else None
    )

    expected = int(line.expected_count or 0)
    scanned = int(session_counts(db, receipt)["total"] or 0)
    if expected > 0 and scanned > expected and not _has_flag(
        db, order.id, RECEIVING_FLAG_OVER_PAPERWORK, line_id=line.id
    ):
        flag = flag or RECEIVING_FLAG_OVER_PAPERWORK
        _add_flag(
            db, order, RECEIVING_FLAG_OVER_PAPERWORK, line=line, expected=expected,
            actual=scanned, actor_id=user_id,
            detail="Worker confirmed more than the paperwork",
        )
    if warning and not _has_flag(db, order.id, RECEIVING_FLAG_RACK_FULL, line_id=line.id, row_id=row.id):
        flag = flag or RECEIVING_FLAG_RACK_FULL
        _add_flag(
            db, order, RECEIVING_FLAG_RACK_FULL, line=line, row_id=row.id,
            actor_id=user_id, detail=warning_detail,
        )
    if lot.is_held and not _has_flag(db, order.id, RECEIVING_FLAG_LOT_HELD, line_id=line.id):
        flag = flag or RECEIVING_FLAG_LOT_HELD
        _add_flag(
            db, order, RECEIVING_FLAG_LOT_HELD, line=line, actor_id=user_id,
            detail=lot.hold_reason or "Lot was on QA hold when it arrived",
        )

    message = f"{units} {word} of {what} → {row.name}" if units > 1 else f"{what} → {row.name}"
    if lot.is_held:
        message += " — this lot is ON HOLD, it stays held"
    return _truck_payload(
        db, order, status="ok", message=message,
        line=line, lot=lot, row=row, units=units,
        warning=warning if allow_overfill else None,
        warning_detail=warning_detail if allow_overfill else None,
        flag=flag, scan_id=event.id if event else None,
    )


def truck_remove(
    db: Session,
    *,
    order: IngredientIntake,
    line_id: str,
    storage_row_id: str,
    user_id: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    single: bool = False,
) -> dict:
    """Take one scan's worth of a SPECIFIC lot back off a SPECIFIC rack.

    The per-line undo it replaces popped "the last scan" — whatever lot that
    was, with no idempotency key, so a retried request undid twice. Here the
    worker names what they double-counted, and a replay is a no-op.

    Allowed on a held lot: this corrects the truck's own miscount before it is
    finished, it does not walk material off a quarantined rack.
    """
    if idempotency_key:
        prior = (
            db.query(LotPlacementEvent)
            .filter(LotPlacementEvent.idempotency_key == idempotency_key)
            .first()
        )
        if prior:
            line = db.query(IntakeLot).filter(IntakeLot.receipt_id == prior.ref_id).first()
            lot = db.query(MaterialLot).filter(MaterialLot.id == prior.material_lot_id).first()
            row = db.query(StorageRow).filter(StorageRow.id == prior.storage_row_id).first()
            return _truck_payload(
                db, order, status="removed", message="Already removed.",
                line=line, lot=lot, row=row, units=-int(prior.full_units_delta or 0),
            )

    if not _truck_open(order):
        return _truck_payload(
            db, order, status="truck_closed",
            message=f"{order.intake_number} is finished. See the office to correct it.",
        )

    line = next((l for l in order.lots or [] if l.id == line_id), None)
    receipt = _line_receipt(db, line) if line else None
    if receipt is None:
        return _truck_payload(db, order, status="nothing_to_remove", message="That line is not on this truck.")
    lot = db.query(MaterialLot).filter(MaterialLot.id == line.material_lot_id).first()
    row = db.query(StorageRow).filter(StorageRow.id == storage_row_id).first()

    on_row = int(session_counts(db, receipt)["by_row"].get(storage_row_id, 0))
    if on_row <= 0 or lot is None:
        return _truck_payload(
            db, order, status="nothing_to_remove", line=line, lot=lot, row=row,
            message=f"Nothing of this lot was scanned into {row.name if row else 'that rack'}.",
        )
    units = min(on_row, _per_scan_units(lot, single))

    lps.apply_delta(
        db, lot, storage_row_id,
        event_type=lps.EVENT_ADJUSTED,
        full_units_delta=-units,
        actor_id=user_id,
        ref_type=REF_TYPE_RECEIVING,
        ref_id=receipt.id,
        reason="Removed a scan (truck receiving)",
        reason_code="undo",
        idempotency_key=idempotency_key,
    )
    return _truck_payload(
        db, order, status="removed", line=line, lot=lot, row=row, units=units,
        message=f"Took {units} {unit_word(lot, units)} of {_lot_words(db, lot)} back off {row.name if row else 'the rack'}.",
    )


def truck_recount(
    db: Session,
    *,
    order: IngredientIntake,
    storage_row_id: str,
    counts: list,
    user_id: Optional[str] = None,
) -> dict:
    """The worker counted a rack by eye. Where they disagree with the scans,
    THE COUNT WINS — they are standing in front of it — and the difference is
    booked and flagged so the office sees it.

    This is the check that stands in for per-drum stickers: a double scan or a
    missed one shows up as a rack that does not add up.

    Naturally idempotent: a second identical recount finds scans == count and
    writes a plain `recount_ok`.
    """
    if not _truck_open(order):
        return {"status": "truck_closed", "message": f"{order.intake_number} is finished.", "truck": truck_summary(db, order)}

    row = db.query(StorageRow).filter(StorageRow.id == storage_row_id).first()
    if not row:
        return {"status": "unknown_row", "message": "That rack is not one we know.", "truck": truck_summary(db, order)}

    corrected = []
    for item in counts or []:
        line = next((l for l in order.lots or [] if l.id == item.get("line_id")), None)
        receipt = _line_receipt(db, line) if line else None
        if receipt is None:
            continue
        actual = max(0, int(item.get("actual") or 0))
        scanned = int(session_counts(db, receipt)["by_row"].get(row.id, 0))
        lot = db.query(MaterialLot).filter(MaterialLot.id == line.material_lot_id).first()
        diff = actual - scanned
        if diff != 0 and lot is not None:
            lps.apply_delta(
                db, lot, row.id,
                event_type=lps.EVENT_ADJUSTED,
                full_units_delta=diff,
                actor_id=user_id,
                ref_type=REF_TYPE_RECEIVING,
                ref_id=receipt.id,
                reason=f"Rack recount: scanned {scanned}, counted {actual}",
                reason_code="recount",
            )
            corrected.append(
                f"{_lot_words(db, lot)}: {scanned} → {actual}"
            )
        _add_flag(
            db, order,
            RECEIVING_FLAG_RECOUNT_CORRECTED if diff else RECEIVING_FLAG_RECOUNT_OK,
            line=line, row_id=row.id, expected=scanned, actual=actual, actor_id=user_id,
            event_seq=_max_seq(db, receipt.id, row.id),
        )

    return {
        "status": "corrected" if corrected else "ok",
        "message": (
            f"{row.name} corrected — " + "; ".join(corrected) if corrected
            else f"{row.name} counted — matches."
        ),
        "truck": truck_summary(db, order),
    }


def truck_finish(
    db: Session,
    *,
    order: IngredientIntake,
    user_id: Optional[str] = None,
    confirmed: bool = False,
    short_reason: Optional[str] = None,
    short_note: Optional[str] = None,
) -> dict:
    """The worker says the whole truck is put away. Soft answers, in order:

      already_submitted  nothing to do
      needs_recount      a rack still has uncounted scans — count it first
      needs_confirm      counts disagree with the paperwork, line by line
      needs_reason       short, and no reason from the fixed list was given
      submitted          stamped on the order AND every line receipt; the
                         receipts' stamp is what the approval gate reads
    """
    summary = truck_summary(db, order)
    if order.forklift_submitted_at:
        return {"status": "already_submitted", "message": "This truck was already finished.", "truck": summary}
    if not summary["checked_in"]:
        return {
            "status": "not_checked_in",
            "message": "The office has not checked this truck in yet.",
            "truck": summary,
        }
    if summary["pending_recounts"]:
        return {
            "status": "needs_recount",
            "message": "Count these racks before finishing the truck.",
            "truck": summary,
        }

    diffs = [l for l in summary["lines"] if l["difference"] != 0]
    if diffs and not confirmed:
        return {
            "status": "needs_confirm",
            "message": "The counts do not match the paperwork. Finish anyway?",
            "lines": diffs,
            "truck": summary,
        }

    shorts = [l for l in summary["lines"] if l["difference"] < 0]
    reason_text = None
    if shorts:
        if short_reason not in TRUCK_SHORT_REASONS or (
            short_reason == "other" and not (short_note or "").strip()
        ):
            return {
                "status": "needs_reason",
                "message": "This truck is short. Pick a reason.",
                "lines": shorts,
                "truck": summary,
            }
        reason_text = SHORT_REASON_LABELS[short_reason]
        if (short_note or "").strip():
            reason_text = f"{reason_text}: {short_note.strip()}"
        by_id = {l.id: l for l in order.lots or []}
        for l in shorts:
            _add_flag(
                db, order, RECEIVING_FLAG_SHORT, line=by_id.get(l["line_id"]),
                expected=l["expected_count"], actual=l["scanned_count"],
                detail=reason_text, actor_id=user_id,
            )

    now = datetime.now(timezone.utc)
    order.forklift_submitted_at = now
    order.forklift_submitted_by = user_id
    order.short_reason = reason_text
    for line in order.lots or []:
        receipt = _line_receipt(db, line)
        if receipt and not receipt.forklift_submitted_at:
            receipt.forklift_submitted_at = now
            receipt.forklift_submitted_by = user_id
        if receipt and receipt.status in (ReceiptStatus.RECORDED, ReceiptStatus.REVIEWED):
            # Scanned stock is live now; the receipt carries the scanned count
            # from here on, not the BOL's (F9). The line keeps the paperwork
            # figure in `expected_count` for the approval card.
            book_scanned_count(db, receipt, stage="Truck finished")
    db.flush()
    return {
        "status": "submitted",
        "message": "Truck finished. The office checks it next.",
        "truck": truck_summary(db, order),
    }


def truck_approve(db: Session, *, order: IngredientIntake, current_user) -> dict:
    """Approve every line of the truck at once, then close the order.

    One transaction: the router commits once, and any line the existing
    per-receipt gate refuses raises before then, so a truck is never left
    half-approved. Each line goes through `receipt_service.approve_receipt`
    unchanged — the truck is a way in, not a second set of rules.
    """
    from app.services import receipt_service

    if not order.forklift_submitted_at:
        raise ValidationError(
            f"{order.intake_number} is still being received — the forklift has not finished it."
        )

    approved = 0
    for line in order.lots or []:
        receipt = _line_receipt(db, line)
        if receipt and receipt.status in (ReceiptStatus.RECORDED, ReceiptStatus.REVIEWED):
            receipt_service.approve_receipt(db, receipt, current_user)
            approved += 1

    if order.status in INCOMING_RECEIVABLE_STATUSES:
        close_order(
            db, order, user_id=str(current_user.id),
            reason=order.short_reason or None,
        )
    db.flush()
    return {"status": "approved", "approved_receipts": approved, "truck": truck_summary(db, order)}


def open_trucks(db: Session, *, warehouse_id: Optional[str] = None) -> list:
    """Trucks the gun can pick up: checked in (at least one line started), still
    receivable, not finished at the gun."""
    query = (
        db.query(IngredientIntake)
        .filter(
            IngredientIntake.is_incoming_order == True,  # noqa: E712
            IngredientIntake.is_deleted == False,  # noqa: E712
            IngredientIntake.status.in_(INCOMING_RECEIVABLE_STATUSES),
            IngredientIntake.forklift_submitted_at.is_(None),
            db.query(IntakeLot.id)
            .filter(IntakeLot.intake_id == IngredientIntake.id, IntakeLot.receipt_id.isnot(None))
            .exists(),
        )
    )
    if warehouse_id:
        query = query.filter(IngredientIntake.warehouse_id == warehouse_id)
    orders = query.order_by(IngredientIntake.expected_date.asc().nullslast()).limit(50).all()
    return [truck_summary(db, o) for o in orders]


def locate_truck(db: Session, code: str, *, warehouse_id: Optional[str] = None) -> dict:
    """A drum scanned on the truck list -> the open truck(s) carrying its lot."""
    lot = resolve_lot_code(db, code)
    if lot is None:
        return {"status": "unknown_lot", "message": UNKNOWN_STICKER_MESSAGE, "trucks": []}
    query = (
        db.query(IngredientIntake)
        .join(IntakeLot, IntakeLot.intake_id == IngredientIntake.id)
        .filter(
            IntakeLot.material_lot_id == lot.id,
            IntakeLot.receipt_id.isnot(None),
            IngredientIntake.is_incoming_order == True,  # noqa: E712
            IngredientIntake.is_deleted == False,  # noqa: E712
            IngredientIntake.status.in_(INCOMING_RECEIVABLE_STATUSES),
            IngredientIntake.forklift_submitted_at.is_(None),
        )
    )
    if warehouse_id:
        query = query.filter(IngredientIntake.warehouse_id == warehouse_id)
    orders = query.distinct().all()
    if not orders:
        # A sticker from a truck the gun already finished used to do nothing at
        # all on the list (browser test F7c). Say which truck, and that it is shut.
        finished = (
            db.query(IngredientIntake)
            .join(IntakeLot, IntakeLot.intake_id == IngredientIntake.id)
            .filter(
                IntakeLot.material_lot_id == lot.id,
                IntakeLot.receipt_id.isnot(None),
                IngredientIntake.is_incoming_order == True,  # noqa: E712
                IngredientIntake.is_deleted == False,  # noqa: E712
                IngredientIntake.forklift_submitted_at.isnot(None),
            )
        )
        if warehouse_id:
            finished = finished.filter(IngredientIntake.warehouse_id == warehouse_id)
        finished = finished.order_by(IngredientIntake.forklift_submitted_at.desc()).first()
        if finished:
            return {
                "status": "truck_finished",
                "message": (
                    f"That truck is already finished — {finished.intake_number} "
                    f"(lot {lot.vendor_lot_number or lot.lot_code}) was closed on the gun. "
                    "See the office to change it."
                ),
                "lot_code": lot.lot_code,
                "trucks": [],
            }
    vendors = {
        v.id: v.name
        for v in db.query(Vendor).filter(Vendor.id.in_({o.vendor_id for o in orders if o.vendor_id})).all()
    } if orders else {}
    return {
        "status": "ok" if orders else "no_truck",
        "message": (
            "" if orders
            else f"Lot {lot.vendor_lot_number or lot.lot_code} is not on any truck being received."
        ),
        "lot_code": lot.lot_code,
        "trucks": [
            {
                "order_id": o.id,
                "order_number": o.intake_number,
                "vendor_name": vendors.get(o.vendor_id),
                "bol": o.bol,
            }
            for o in orders
        ],
    }


def _set_line_expected(db: Session, line: IntakeLot, count: int) -> None:
    """Change a line's paperwork count, keeping a started line's receipt in step."""
    line.expected_count = int(count)
    receipt = _line_receipt(db, line)
    if receipt:
        receipt.container_count = int(count)
        if receipt.weight_per_container:
            receipt.quantity = round(int(count) * float(receipt.weight_per_container), 3)
        else:
            receipt.quantity = int(count)


def check_in_truck(
    db: Session,
    order: IngredientIntake,
    *,
    lines: list,
    user_id: str,
    bol: Optional[str] = None,
) -> IngredientIntake:
    """The desk checks the whole truck against the driver's BOL and opens it.

    Corrections for every line come in one go; then lines that now describe the
    same lot are merged (a truck has one line per lot — the gun could not tell
    them apart), and every line not yet started is started. All in the caller's
    one transaction.
    """
    if order.status not in INCOMING_RECEIVABLE_STATUSES:
        raise ConflictError(
            f"This order is {order.status} — only an in-transit order can be checked in"
        )
    if (bol or "").strip():
        order.bol = bol.strip()

    edits = {item["line_id"]: item for item in lines or [] if item.get("line_id")}
    for line in order.lots or []:
        item = edits.get(line.id)
        if not item or line.receipt_id:
            continue   # a started line's identity is fixed — it has a lot already
        for field, attr in (
            ("vendor_id", "vendor_id"),
            ("vendor_lot", "vendor_lot"),
            ("bbd", "bbd"),
            ("weight_per_unit", "net_weight_per_container"),
            ("weight_unit", "weight_unit"),
            ("units_per_pallet", "units_per_pallet"),
        ):
            if item.get(field) is not None:
                setattr(line, attr, item[field])
        if item.get("expected_count") is not None:
            line.expected_count = int(item["expected_count"])
        line.lot_unknown = not bool(line.vendor_lot)

    # Merge lines that are now the same lot. A started line wins (it already
    # owns the lot and the receipt); otherwise the first one listed does.
    keepers: dict = {}
    for line in sorted(order.lots or [], key=lambda l: (l.receipt_id is None,)):
        key = line_lot_key(
            line.product_id, line.vendor_id or order.vendor_id, line.vendor_lot, line.bbd
        )
        if key is None:
            continue
        keeper = keepers.get(key)
        if keeper is None:
            keepers[key] = line
            continue
        if line.receipt_id:
            continue   # two started lines on one lot predate this rule; leave them
        _set_line_expected(
            db, keeper, int(keeper.expected_count or 0) + int(line.expected_count or 0)
        )
        order.lots.remove(line)
        db.delete(line)
    db.flush()

    for line in list(order.lots or []):
        if not line.receipt_id:
            start_receiving(db, order, line, user_id=user_id)

    order.expected_count = sum(int(l.expected_count or 0) for l in order.lots or [])
    db.flush()
    return order
