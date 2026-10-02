"""Forklift staging-pull — scanning drums OFF racks against a production
staging request.

The desk flow (QuickStageModal) types a weight; this flow scans what the
forklift physically touches: scan a rack, scan the lot sticker on each
container pulled, submit when the cart is loaded. Placements are
decremented AT SCAN TIME (the rack frees the moment the drum leaves it);
submit only converts the accumulated scan events into the paperwork —
InventoryTransfer + StagingItem + request fulfilment — in ONE transaction,
which retires the two-call orphan risk the desk flow carries.

Ledger bookkeeping: every pull writes a LotPlacementEvent with
ref_type="staging_pull" and ref_id=<request item id>. `reason_code` is the
event's lifecycle stamp:

    NULL        pulled, still on the cart (undoable, counted as pending)
    'undone'    reversed by the worker (a compensating staging_pull_undo
                event restored the rack)
    'submitted' converted into a StagingItem by submit

Suggestions (FEFO lot, fullest-first rack, opened-first) are ADVISORY. A
worker pulling a different lot of the right product gets a needs_confirm
prompt, never a refusal — the suggested rack might be blocked by a truck.
Wrong PRODUCT is the one hard soft-stop with no override: that mistake is
what this flow exists to prevent.
"""
import json
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from app.enums import ReceiptStatus
from app.exceptions import NotFoundError, ValidationError
from app.models import (
    InventoryTransfer,
    LotPlacement,
    LotPlacementEvent,
    MaterialLot,
    Product,
    Receipt,
    StagingItem,
    StagingRequest,
    StagingRequestItem,
    StorageRow,
)
from app.services import lot_placement_service as lps
from app.services import staging_service
from app.services.lot_receiving_service import resolve_lot_code
from app.services.staging_request_service import (
    _parse_staging_item_ids,
    _update_parent_request_status,
)
from app.utils.calendar_dates import calendar_day

REF_TYPE_PULL = "staging_pull"
REF_TYPE_PULL_UNDO = "staging_pull_undo"

OPEN_REQUEST_STATUSES = ("pending", "partially_fulfilled", "in_progress")


def _mint_id(prefix: str) -> str:
    return f"{prefix}-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"


# ─── progress from the ledger ─────────────────────────────────────────────────

def _pending_events(db: Session, item_ids: List[str]):
    """Un-submitted, un-undone pull events for these request items."""
    if not item_ids:
        return []
    return (
        db.query(LotPlacementEvent)
        .filter(
            LotPlacementEvent.ref_type == REF_TYPE_PULL,
            LotPlacementEvent.ref_id.in_(item_ids),
            LotPlacementEvent.reason_code.is_(None),
        )
        .order_by(LotPlacementEvent.seq)
        .all()
    )


def _pinned_receipt(db: Session, lot_id: str):
    """The receipt this lot's staging paperwork books against: the newest LIVE
    receipt (approved, quantity left), falling back to the newest overall.
    Matches the projection-carrier rule in `project_lot`, so the receipt the
    gun consumes is the one the forms can still see."""
    base = (
        db.query(Receipt)
        .filter(Receipt.material_lot_id == lot_id, Receipt.is_deleted == False)  # noqa: E712
        .order_by(Receipt.receipt_date.desc(), Receipt.created_at.desc())
    )
    live = base.filter(
        Receipt.status == ReceiptStatus.APPROVED, Receipt.quantity > 0
    ).first()
    return live or base.first()


def _per_unit_weight(db: Session, lot, receipt=None) -> float:
    """Per-container weight for pricing: the RECEIPT's own figure first, the
    lot's first-delivery figure only as a fallback. One vendor lot genuinely
    arrives at 474/502/559 lbs/drum across deliveries (policy, 2026-09-18) and
    `lot.weight_per_unit` is frozen at the first one."""
    if receipt is None:
        receipt = _pinned_receipt(db, lot.id) if lot else None
    per = float(getattr(receipt, "weight_per_container", 0) or 0) if receipt else 0.0
    return per or float(lot.weight_per_unit or 0)


def _event_quantity(db: Session, event: LotPlacementEvent, _lot_cache: dict) -> float:
    """Weight one pull event represents: sealed units × weight + open qty."""
    cached = _lot_cache.get(event.material_lot_id)
    if cached is None:
        lot = db.query(MaterialLot).filter(
            MaterialLot.id == event.material_lot_id
        ).first()
        cached = (lot, _per_unit_weight(db, lot) if lot else 0.0)
        _lot_cache[event.material_lot_id] = cached
    lot, per_unit = cached
    units = -int(event.full_units_delta or 0)
    open_qty = -float(event.qty_delta or 0)
    # The drums this pull took weigh what THEIR deliveries say (a rack can
    # hold 502s and 474s of one lot); the pinned receipt's figure is only the
    # fallback when the ledger cannot say (2026-10-01).
    sealed = lps.event_taken_weight(db, lot, event.id) if (lot and units > 0) else None
    if sealed is None:
        sealed = max(0.0, units * per_unit)
    return sealed + max(0.0, open_qty)


def _pending_by_item(db: Session, item_ids: List[str]) -> Dict[str, float]:
    cache: dict = {}
    out: Dict[str, float] = {}
    for ev in _pending_events(db, item_ids):
        out[ev.ref_id] = out.get(ev.ref_id, 0.0) + _event_quantity(db, ev, cache)
    return out


def _lot_name(lot) -> str:
    """What a worker calls a lot: the vendor's lot number off the drum, never
    our internal lot code (browser test PART 3, B9/U1)."""
    if not lot:
        return "—"
    return lot.vendor_lot_number or lot.lot_code or "—"


def _unit_word(label: Optional[str], n: float) -> str:
    """'1 drum', '10 bags', '6 boxes' — plural that reads right on the gun
    ("6 boxs pulled." was the PART 3 typo)."""
    word = (label or "unit").strip() or "unit"
    count = int(n) if float(n).is_integer() else n
    if count == 1:
        return f"{count} {word}"
    if word.endswith("s"):
        return f"{count} {word}"
    if word.endswith(("x", "ch", "sh")):
        return f"{count} {word}es"
    return f"{count} {word}s"


def _show_day(value) -> Optional[str]:
    """MM/DD/YYYY for a CALENDAR field. Calendar fields arrive as plain
    'YYYY-MM-DD' strings now (calendar_day), so never call strftime on them —
    that crashed every non-FEFO pull (PART 3, B1)."""
    day = calendar_day(value)
    if not day or len(day) != 10:
        return None
    y, m, d = day.split("-")
    return f"{m}/{d}/{y}"


def _cart_lines(db: Session, item_ids: List[str]) -> Dict[str, Dict[str, dict]]:
    """What is on the cart, per request item and lot: units, open units, lbs,
    racks — so the gun can say "2 drums of lot A-0801" and not just pounds."""
    out: Dict[str, Dict[str, dict]] = {}
    cache: dict = {}
    lots: dict = {}
    for ev in _pending_events(db, item_ids):
        lot = lots.get(ev.material_lot_id)
        if lot is None:
            lot = db.query(MaterialLot).filter(MaterialLot.id == ev.material_lot_id).first()
            lots[ev.material_lot_id] = lot
        entry = out.setdefault(ev.ref_id, {}).setdefault(ev.material_lot_id, {
            "material_lot_id": ev.material_lot_id,
            "lot_code": lot.lot_code if lot else None,
            "vendor_lot": lot.vendor_lot_number if lot else None,
            "lot_name": _lot_name(lot),
            "unit_label": (lot.unit_label if lot else None) or "unit",
            "units": 0,
            "open_units": 0,
            "quantity": 0.0,
            "is_held": bool(lot.is_held) if lot else False,
            "hold_reason": lot.hold_reason if lot else None,
            "row_ids": [],
        })
        entry["units"] += -int(ev.full_units_delta or 0)
        entry["open_units"] += -int(ev.open_units_delta or 0)
        entry["quantity"] += _event_quantity(db, ev, cache)
        if ev.storage_row_id and ev.storage_row_id not in entry["row_ids"]:
            entry["row_ids"].append(ev.storage_row_id)
    for per_lot in out.values():
        for entry in per_lot.values():
            entry["quantity"] = round(entry["quantity"], 3)
    return out


def _units_summary(lines) -> List[dict]:
    """[{unit_label, units, open_units}] summed per unit word."""
    by_unit: Dict[str, dict] = {}
    for line in lines:
        label = line.get("unit_label") or "unit"
        e = by_unit.setdefault(label, {"unit_label": label, "units": 0, "open_units": 0})
        e["units"] += int(line.get("units") or 0)
        e["open_units"] += int(line.get("open_units") or 0)
    return list(by_unit.values())


def _row_names(db: Session, row_ids) -> Dict[str, str]:
    ids = [r for r in set(row_ids or []) if r]
    if not ids:
        return {}
    return {r.id: r.name for r in db.query(StorageRow).filter(StorageRow.id.in_(ids)).all()}


def on_cart_quantity_for_lot(db: Session, material_lot_id: str) -> float:
    """Weight pulled off this lot's racks onto a cart and not yet submitted.

    Between scan and submit the drums are on no rack and in no StagingItem,
    yet still on the receipt's paper — availability and the reconciliation
    check must count them somewhere or the lot looks over-stocked."""
    if not material_lot_id:
        return 0.0
    events = (
        db.query(LotPlacementEvent)
        .filter(
            LotPlacementEvent.ref_type == REF_TYPE_PULL,
            LotPlacementEvent.material_lot_id == material_lot_id,
            LotPlacementEvent.reason_code.is_(None),
        )
        .all()
    )
    cache: dict = {}
    return sum(_event_quantity(db, ev, cache) for ev in events)

# ─── list / detail ────────────────────────────────────────────────────────────

def open_requests(db: Session) -> list:
    """Staging requests a forklift can work: open status, tracked items."""
    requests = (
        db.query(StagingRequest)
        .filter(StagingRequest.status.in_(OPEN_REQUEST_STATUSES))
        .order_by(StagingRequest.production_date.asc().nullslast(),
                  StagingRequest.created_at.asc())
        .all()
    )
    out = []
    for sr in requests:
        item_ids = [i.id for i in sr.items]
        pending = _pending_by_item(db, item_ids)
        needed = sum(float(i.quantity_needed or 0) for i in sr.items)
        fulfilled = sum(float(i.quantity_fulfilled or 0) for i in sr.items)
        # The totals add pounds across products; say WHICH unit they are in
        # when every line agrees, so the gun can print "22,776 of 89,754.66
        # lbs" instead of bare numbers (PART 3, U1).
        units = {(i.unit or "").strip().lower() for i in sr.items if i.unit}
        out.append({
            "id": sr.id,
            "production_batch_uid": sr.production_batch_uid,
            "product_name": sr.product_name,
            "formula_name": sr.formula_name,
            "production_date": calendar_day(sr.production_date),
            "unit": next(iter(units)) if len(units) == 1 else None,
            "status": sr.status,
            "item_count": len(sr.items),
            "needed_qty": round(needed, 3),
            "fulfilled_qty": round(fulfilled, 3),
            "pending_qty": round(sum(pending.values()), 3),
        })
    return out


def _product_id_for(db: Session, item) -> Optional[str]:
    if item.product_id:
        return item.product_id
    if item.sid:
        product = db.query(Product).filter(Product.sid == item.sid).first()
        return product.id if product else None
    return None


def _product_lots(db: Session, product_id: Optional[str]) -> List[tuple]:
    """(lot, units on racks) for every lot of this product that still has
    something on a rack — the gun's offline map from a sticker's lot code to a
    request line, and the source of the line's ON HOLD note."""
    if not product_id:
        return []
    lots = (
        db.query(MaterialLot)
        .filter(MaterialLot.product_id == product_id,
                MaterialLot.is_deleted == False)  # noqa: E712
        .order_by(MaterialLot.bbd_current.asc().nullslast(), MaterialLot.created_at.asc())
        .limit(100)
        .all()
    )
    out = []
    for lot in lots:
        units = sum(
            int(p.full_units or 0) + int(p.open_units or 0)
            for p in lps.placements_for_lot(db, lot.id)
        )
        if units > 0:
            out.append((lot, units))
    return out


def _staged_units(db: Session, item) -> List[dict]:
    """Containers already handed to staging for this line (gun pulls record
    them on the StagingItem; a desk stage that typed pounds has none)."""
    ids = _parse_staging_item_ids(item.staging_item_ids)
    if not ids:
        return []
    lines = []
    for si in db.query(StagingItem).filter(StagingItem.id.in_(ids)).all():
        units = int(round(float(si.pallets_staged or 0)))
        if units <= 0:
            continue
        receipt = db.query(Receipt).filter(Receipt.id == si.receipt_id).first()
        lot = None
        if receipt and receipt.material_lot_id:
            lot = db.query(MaterialLot).filter(MaterialLot.id == receipt.material_lot_id).first()
        label = (lot.unit_label if lot else None) or (receipt.container_unit if receipt else None)
        if not label:
            continue
        lines.append({"unit_label": label, "units": units, "open_units": 0})
    return _units_summary(lines)


def request_detail(db: Session, request_id: str) -> dict:
    sr = db.query(StagingRequest).filter(StagingRequest.id == request_id).first()
    if not sr:
        raise NotFoundError("Staging request", request_id)

    item_ids = [i.id for i in sr.items]
    pending = _pending_by_item(db, item_ids)
    cart = _cart_lines(db, item_ids)

    items = []
    for item in sr.items:
        needed = float(item.quantity_needed or 0)
        fulfilled = float(item.quantity_fulfilled or 0)
        item_pending = pending.get(item.id, 0.0)
        remaining = max(0.0, needed - fulfilled - item_pending)

        product_id = _product_id_for(db, item)
        lots = _product_lots(db, product_id)

        # FEFO suggestion, racks fullest-first — advisory for the gun.
        suggestion = None
        if product_id and remaining > 0:
            suggestions = staging_service.suggest_lots_for_staging(
                db, product_id, remaining, None
            )
            if suggestions:
                s = suggestions[0]
                first_receipt = db.query(Receipt).filter(
                    Receipt.id == s.get("receipt_id")
                ).first()
                first_lot = None
                if first_receipt and first_receipt.material_lot_id:
                    first_lot = db.query(MaterialLot).filter(
                        MaterialLot.id == first_receipt.material_lot_id
                    ).first()
                suggestion = {
                    "receipt_id": s.get("receipt_id"),
                    "lot_number": s.get("lot_number"),
                    "lot_code": first_lot.lot_code if first_lot else None,
                    "expiration_date": calendar_day(s.get("expiration_date")),
                    "available_quantity": s.get("available_quantity"),
                    "is_counted": s.get("is_counted"),
                    "unit_label": s.get("unit_label"),
                    "available_units": s.get("available_units"),
                    "open_units": s.get("open_units") or 0,
                    "open_remaining_qty": s.get("open_remaining_qty") or 0.0,
                    "racks": s.get("racks", []),
                }

        # A lot that went ON HOLD is not offered — say so on the line, or it
        # just looks like the FEFO hint vanished (PART 3, U1).
        held_lots = [
            {
                "lot_code": lot.lot_code,
                "vendor_lot": lot.vendor_lot_number,
                "lot_name": _lot_name(lot),
                "hold_reason": lot.hold_reason,
                "unit_label": lot.unit_label,
                "units": units,
            }
            for lot, units in lots if lot.is_held
        ]
        cart_lines = list(cart.get(item.id, {}).values())
        for line in cart_lines:
            line.pop("row_ids", None)
        unit_labels = [lot.unit_label for lot, _u in lots if lot.unit_label]
        unit_label = (
            (suggestion or {}).get("unit_label")
            or (cart_lines[0]["unit_label"] if cart_lines else None)
            or (unit_labels[0] if unit_labels else None)
        )

        items.append({
            "id": item.id,
            "ingredient_name": item.ingredient_name,
            "sid": item.sid,
            "unit": item.unit,
            "product_id": product_id,
            "quantity_needed": needed,
            "quantity_fulfilled": fulfilled,
            "pending_qty": round(item_pending, 3),
            "remaining_qty": round(remaining, 3),
            "status": item.status,
            "suggestion": suggestion,
            # Containers, not just pounds (PART 3, U1).
            "unit_label": unit_label,
            "unit_labels": sorted(set(unit_labels)),
            "cart_lots": cart_lines,
            "pending_units": _units_summary(cart_lines),
            "staged_units": _staged_units(db, item),
            "held_lots": held_lots,
            # Lot codes of this product, so an OFFLINE gun can put a queued
            # sticker on the right line before the server answers (B9).
            "lots": [
                {"lot_code": lot.lot_code, "vendor_lot": lot.vendor_lot_number,
                 "unit_label": lot.unit_label, "is_held": bool(lot.is_held)}
                for lot, _u in lots
            ],
        })

    return {
        "id": sr.id,
        "production_batch_uid": sr.production_batch_uid,
        "product_name": sr.product_name,
        "formula_name": sr.formula_name,
        "production_date": calendar_day(sr.production_date),
        "status": sr.status,
        "items": items,
    }


# ─── scan ─────────────────────────────────────────────────────────────────────

def _scan_payload(
    db: Session, sr: StagingRequest, *,
    status: str, message: str = "", warning: Optional[str] = None,
    item: Optional[StagingRequestItem] = None,
    lot: Optional[MaterialLot] = None,
    units: int = 0, quantity: float = 0.0,
) -> dict:
    item_ids = [i.id for i in sr.items]
    pending = _pending_by_item(db, item_ids)
    return {
        "status": status,
        "message": message,
        "warning": warning,
        "item_id": item.id if item else None,
        "ingredient_name": item.ingredient_name if item else None,
        "lot_code": lot.lot_code if lot else None,
        "vendor_lot": lot.vendor_lot_number if lot else None,
        # Lets the gun seed its per-scan multiplier from the lot's own
        # packing — pulling a wrapped 50-bag pallet booked 1 bag unless the
        # worker remembered to key 50 by hand (2026-09-29 audit, finding 12).
        "units_per_pallet": int(lot.units_per_pallet or 0) if lot else 0,
        "unit_label": lot.unit_label if lot else None,
        "units": units,
        "quantity": round(quantity, 3),
        "item_pending_qty": round(pending.get(item.id, 0.0), 3) if item else 0.0,
        "item_fulfilled_qty": float(item.quantity_fulfilled or 0) if item else 0.0,
        "item_needed_qty": float(item.quantity_needed or 0) if item else 0.0,
        "request_pending_qty": round(sum(pending.values()), 3),
    }


def scan(db: Session, request_id: str, body, user_id: Optional[str]) -> dict:
    sr = db.query(StagingRequest).filter(StagingRequest.id == request_id).first()
    if not sr:
        raise NotFoundError("Staging request", request_id)

    # THE IDEMPOTENCY CHECK RUNS FIRST — a replayed offline scan whose write
    # already landed must get its original answer back, whatever has
    # happened to the request since.
    if body.idempotency_key:
        prior = (
            db.query(LotPlacementEvent)
            .filter(LotPlacementEvent.idempotency_key == body.idempotency_key)
            .first()
        )
        if prior and not body.allow_mismatch:
            lot = db.query(MaterialLot).filter(
                MaterialLot.id == prior.material_lot_id
            ).first()
            item = next((i for i in sr.items if i.id == prior.ref_id), None)
            return _scan_payload(
                db, sr, status="ok", message="Already recorded.",
                item=item, lot=lot,
                units=-int(prior.full_units_delta or 0),
                quantity=_event_quantity(db, prior, {}),
            )

    lot = resolve_lot_code(db, body.code)
    if not lot:
        return _scan_payload(
            db, sr, status="unknown_lot",
            message="That sticker is not a known material lot. Try again or hand-key the code.",
        )

    if lot.is_held:
        return _scan_payload(
            db, sr, status="lot_held", lot=lot,
            message=(
                f"Lot {lot.vendor_lot_number or lot.lot_code} is ON HOLD"
                f"{f' — {lot.hold_reason}' if lot.hold_reason else ''}. It cannot be pulled."
            ),
        )

    # Product gate — the one hard stop. The request names what production
    # needs; a scan of anything else is the mistake this flow exists to catch.
    matching = [
        i for i in sr.items
        if (i.product_id and i.product_id == lot.product_id)
    ]
    if not matching and lot.product_id:
        product = db.query(Product).filter(Product.id == lot.product_id).first()
        if product and product.sid:
            matching = [
                i for i in sr.items
                if (i.sid or "").strip().upper() == product.sid.strip().upper()
            ]
    if not matching:
        return _scan_payload(
            db, sr, status="wrong_product", lot=lot,
            message="This material is not on this staging request.",
        )

    def _remaining(i):
        return float(i.quantity_needed or 0) - float(i.quantity_fulfilled or 0)
    item = next((i for i in matching if _remaining(i) > 0), matching[0])

    # FEFO advisory — a prompt, never a gate. Only raised when an EARLIER-
    # expiring lot of the same product still has stock to offer.
    if not body.allow_mismatch:
        suggestions = staging_service.suggest_lots_for_staging(
            db, item.product_id or lot.product_id, max(_remaining(item), 1.0), None
        )
        if suggestions:
            first = suggestions[0]
            first_receipt = db.query(Receipt).filter(
                Receipt.id == first.get("receipt_id")
            ).first()
            if first_receipt and first_receipt.material_lot_id and \
                    first_receipt.material_lot_id != lot.id:
                # `expiration_date` is a plain 'YYYY-MM-DD' calendar string
                # now — formatting it with strftime crashed EVERY non-FEFO
                # pull with a 500 (PART 3, B1).
                best_by = _show_day(first.get("expiration_date"))
                racks = [r.get("storage_row_name") for r in (first.get("racks") or [])
                         if r.get("storage_row_name")]
                return _scan_payload(
                    db, sr, status="needs_confirm", item=item, lot=lot,
                    message=(
                        f"Lot {first.get('lot_number') or '—'} is older"
                        f"{' (best by ' + best_by + ')' if best_by else ''}"
                        f"{' on ' + ', '.join(racks[:2]) if racks else ''}"
                        f" and should go first. Pull lot {_lot_name(lot)} anyway?"
                    ),
                    warning="not_fefo_lot",
                )

    # Apply — placements are the rack truth, so the rack empties NOW.
    # Locked: the free-units check below and the apply_delta are two steps,
    # and two guns on one rack could both pass the unlocked check and pull
    # into the held count between them (2026-09-29 audit, hold GAP 8).
    placement = (
        db.query(LotPlacement)
        .filter(
            LotPlacement.material_lot_id == lot.id,
            LotPlacement.storage_row_id == body.storage_row_id,
        )
        .with_for_update()
        .first()
    )
    if body.pull_open:
        open_units = int(placement.open_units or 0) if placement else 0
        if open_units <= 0:
            return _scan_payload(
                db, sr, status="not_enough", item=item, lot=lot,
                message="No opened container of this lot on that rack.",
            )
        open_qty = float(placement.open_remaining_qty or 0)
        # Content is tracked as a SUM across open units, deliberately not
        # per drum — one open drum takes the whole remainder, several take
        # an equal share (documented approximation).
        share = open_qty if open_units == 1 else open_qty / open_units
        lps.apply_delta(
            db, lot, body.storage_row_id,
            event_type=lps.EVENT_STAGED,
            open_units_delta=-1,
            open_qty_delta=-share,
            actor_id=user_id,
            ref_type=REF_TYPE_PULL,
            ref_id=item.id,
            reason="Pulled for production staging (gun)",
            idempotency_key=body.idempotency_key,
        )
        db.flush()
        return _scan_payload(
            db, sr, status="ok", item=item, lot=lot, units=0, quantity=share,
            message=f"Open {lot.unit_label or 'unit'} of lot {_lot_name(lot)} pulled — about {round(share, 1)} {lot.weight_unit or 'lbs'}.",
        )

    free = 0
    if placement:
        free = max(0, int(placement.full_units or 0) - int(placement.held_units or 0))
    if body.units > free:
        return _scan_payload(
            db, sr, status="not_enough", item=item, lot=lot,
            message=(
                f"Only {_unit_word(lot.unit_label, free)} (sealed) of lot "
                f"{_lot_name(lot)} on that rack. "
                "Check the rack, or scan the rack you are actually pulling from."
            ),
        )
    # Priced BEFORE the drums leave: the oldest deliveries on that rack.
    pulled_lbs = lps.fifo_units_weight(db, lot, body.storage_row_id, int(body.units))
    lps.apply_delta(
        db, lot, body.storage_row_id,
        event_type=lps.EVENT_STAGED,
        full_units_delta=-int(body.units),
        actor_id=user_id,
        ref_type=REF_TYPE_PULL,
        ref_id=item.id,
        reason="Pulled for production staging (gun)",
        idempotency_key=body.idempotency_key,
    )
    db.flush()
    # Priced by the deliveries the pulled drums came from (2026-10-01) — the
    # pinned receipt's figure booked phantom lbs when the rack held another
    # truck's drums (2026-09-29 audit, weight finding 6).
    qty = pulled_lbs
    return _scan_payload(
        db, sr, status="ok", item=item, lot=lot,
        units=int(body.units), quantity=qty,
        message=f"{_unit_word(lot.unit_label, int(body.units))} of lot {_lot_name(lot)} pulled.",
    )


# ─── undo ─────────────────────────────────────────────────────────────────────

def undo(db: Session, request_id: str, user_id: Optional[str]) -> dict:
    sr = db.query(StagingRequest).filter(StagingRequest.id == request_id).first()
    if not sr:
        raise NotFoundError("Staging request", request_id)
    item_ids = [i.id for i in sr.items]

    ev = None
    if item_ids:
        ev = (
            db.query(LotPlacementEvent)
            .filter(
                LotPlacementEvent.ref_type == REF_TYPE_PULL,
                LotPlacementEvent.ref_id.in_(item_ids),
                LotPlacementEvent.reason_code.is_(None),
            )
            .order_by(LotPlacementEvent.seq.desc())
            .first()
        )
    if not ev:
        return _scan_payload(
            db, sr, status="nothing_to_undo",
            message="Nothing left to undo for this request.",
        )

    lot = db.query(MaterialLot).filter(MaterialLot.id == ev.material_lot_id).first()
    # Compensating event with its own deterministic key — undoing twice is
    # a no-op, not a double-credit.
    lps.apply_delta(
        db, lot, ev.storage_row_id,
        event_type=lps.EVENT_STAGED,
        full_units_delta=-int(ev.full_units_delta or 0),
        open_units_delta=-int(ev.open_units_delta or 0),
        open_qty_delta=-float(ev.qty_delta or 0),
        actor_id=user_id,
        ref_type=REF_TYPE_PULL_UNDO,
        ref_id=ev.ref_id,
        reason="Undo staging pull scan",
        idempotency_key=f"undo:{ev.id}",
    )
    ev.reason_code = "undone"
    db.flush()

    item = next((i for i in sr.items if i.id == ev.ref_id), None)
    return _scan_payload(
        db, sr, status="undone", item=item, lot=lot,
        units=-int(ev.full_units_delta or 0),
        message="Last scan undone — the rack has it back.",
    )


# ─── held while on the cart ───────────────────────────────────────────────────

def _held_on_cart(db: Session, item_ids: List[str]) -> List[dict]:
    """Cart lines whose lot is ON HOLD right now, with the racks they came
    from — what the worker is told to carry back."""
    cart = _cart_lines(db, item_ids)
    held = []
    for per_lot in cart.values():
        for line in per_lot.values():
            if not line["is_held"]:
                continue
            names = _row_names(db, line["row_ids"])
            held.append({
                "material_lot_id": line["material_lot_id"],
                "lot_code": line["lot_code"],
                "vendor_lot": line["vendor_lot"],
                "lot_name": line["lot_name"],
                "hold_reason": line["hold_reason"],
                "unit_label": line["unit_label"],
                "units": line["units"],
                "open_units": line["open_units"],
                "quantity": line["quantity"],
                "racks": [names.get(r, r) for r in line["row_ids"]],
            })
    return held


def _held_words(h: dict) -> str:
    parts = []
    if h["units"]:
        parts.append(_unit_word(h["unit_label"], h["units"]))
    if h["open_units"]:
        parts.append(f"{_unit_word(h['unit_label'], h['open_units'])} (open)")
    return " + ".join(parts) or _unit_word(h["unit_label"], 0)


def _held_message(held: List[dict]) -> str:
    lines = []
    for h in held:
        reason = f" ({h['hold_reason']})" if h.get("hold_reason") else ""
        where = ", ".join(h["racks"]) if h.get("racks") else "the rack they came from"
        lines.append(
            f"Lot {h['lot_name']} went ON HOLD{reason} while {_held_words(h)} "
            f"were on the cart. They cannot be staged — put them back on {where}."
        )
    return " ".join(lines) + " Nothing was submitted."


def return_held(db: Session, request_id: str, user_id: Optional[str]) -> dict:
    """Put every on-cart unit of a HELD lot back on the rack it came from.

    Each pending pull of a held lot gets the same compensating event an undo
    writes, so the racks have the units back (still held — the hold is on the
    lot, wherever its drums sit) and the cart no longer carries them."""
    sr = db.query(StagingRequest).filter(StagingRequest.id == request_id).first()
    if not sr:
        raise NotFoundError("Staging request", request_id)
    item_ids = [i.id for i in sr.items]
    held = _held_on_cart(db, item_ids)
    if not held:
        return {
            "status": "nothing_held",
            "message": "Nothing on the cart is on hold.",
            "short_items": [], "staging_item_ids": [],
            "request_status": sr.status, "held_lots": [],
        }
    held_ids = {h["material_lot_id"] for h in held}
    lots = {
        lot.id: lot
        for lot in db.query(MaterialLot).filter(MaterialLot.id.in_(held_ids)).all()
    }
    for ev in _pending_events(db, item_ids):
        if ev.material_lot_id not in held_ids:
            continue
        lps.apply_delta(
            db, lots[ev.material_lot_id], ev.storage_row_id,
            event_type=lps.EVENT_STAGED,
            full_units_delta=-int(ev.full_units_delta or 0),
            open_units_delta=-int(ev.open_units_delta or 0),
            open_qty_delta=-float(ev.qty_delta or 0),
            actor_id=user_id,
            ref_type=REF_TYPE_PULL_UNDO,
            ref_id=ev.ref_id,
            reason="Put back: lot went on hold while on the cart",
            idempotency_key=f"undo:{ev.id}",
        )
        ev.reason_code = "undone"
    db.commit()
    message = " ".join(
        f"{_held_words(h)} of lot {h['lot_name']} back on "
        f"{', '.join(h['racks']) or 'the rack it came from'} (still on hold)."
        for h in held
    )
    return {
        "status": "returned",
        "message": message,
        "short_items": [], "staging_item_ids": [],
        "request_status": sr.status,
        "held_lots": held,
    }


# ─── submit ───────────────────────────────────────────────────────────────────

def submit(
    db: Session, request_id: str, *,
    staging_location_id: str,
    staging_sub_location_id: Optional[str] = None,
    confirmed: bool = False,
    user_id: Optional[str] = None,
) -> dict:
    """Convert this request's pending pull scans into the staging paperwork.

    ONE transaction: transfers + StagingItems + request fulfilment + event
    stamps all commit together — the desk flow's two-call orphan window
    does not exist here. Placements are NOT touched: the racks were already
    decremented scan by scan.
    """
    sr = db.query(StagingRequest).filter(StagingRequest.id == request_id).first()
    if not sr:
        raise NotFoundError("Staging request", request_id)

    items_by_id = {i.id: i for i in sr.items}
    events = _pending_events(db, list(items_by_id.keys()))
    if not events:
        return {
            "status": "nothing_to_submit",
            "message": "No scans waiting to be submitted for this request.",
            "short_items": [], "staging_item_ids": [], "request_status": sr.status,
        }

    # A lot that went ON HOLD while its units were on the cart must not be
    # staged — production would consume held stock with nobody told (PART 3,
    # B3: a drum pulled before the hold was staged, then 292 lb of it used).
    # Nothing is written; the worker puts those units back (return_held) and
    # submits the rest.
    held = _held_on_cart(db, list(items_by_id.keys()))
    if held:
        return {
            "status": "lot_held",
            "message": _held_message(held),
            "warning": None,
            "short_items": [], "staging_item_ids": [],
            "request_status": sr.status,
            "held_lots": held,
        }

    # Aggregate per (item, lot): sealed units, open qty, and the rows drawn
    # from (most-drawn row becomes the StagingItem's original row).
    agg: Dict[tuple, dict] = {}
    lot_cache: dict = {}
    price_cache: dict = {}   # _event_quantity's own (lot, per-unit) cache
    for ev in events:
        key = (ev.ref_id, ev.material_lot_id)
        entry = agg.setdefault(key, {"units": 0, "open_qty": 0.0, "rows": {}, "lbs": 0.0})
        u = -int(ev.full_units_delta or 0)
        entry["units"] += u
        entry["open_qty"] += -float(ev.qty_delta or 0)
        entry["lbs"] += _event_quantity(db, ev, price_cache)
        entry["rows"][ev.storage_row_id] = entry["rows"].get(ev.storage_row_id, 0) + max(u, 1)

    # Shortage advisory — a prompt, not a gate (over/short pulls are real).
    short = []
    pending = _pending_by_item(db, list(items_by_id.keys()))
    for item in sr.items:
        needed = float(item.quantity_needed or 0)
        fulfilled = float(item.quantity_fulfilled or 0)
        got = pending.get(item.id, 0.0)
        if got > 0 and fulfilled + got + 0.001 < needed:
            short.append(item.ingredient_name or item.sid or item.id)
    if short and not confirmed:
        return {
            "status": "needs_confirm",
            "message": (
                "Short of the request: " + ", ".join(short) +
                ". Submit what was pulled anyway?"
            ),
            "warning": "short_pull",
            "short_items": short, "staging_item_ids": [],
            "request_status": sr.status,
        }

    batch_id = _mint_id("gunpull")
    created_ids: List[str] = []
    now = datetime.now(timezone.utc)

    for (item_id, lot_id), entry in agg.items():
        item = items_by_id[item_id]
        lot = lot_cache.get(lot_id) or db.query(MaterialLot).filter(
            MaterialLot.id == lot_id
        ).first()
        lot_cache[lot_id] = lot
        if not lot:
            continue
        receipt = _pinned_receipt(db, lot_id)
        if not receipt:
            raise ValidationError(
                f"Lot {lot.lot_code} has no receipt on file — it cannot be staged "
                "until receiving paperwork exists."
            )

        # Each pull's own weight: its drums' deliveries + open qty. The pinned
        # receipt's single figure booked phantom lbs into staging when the
        # rack held another truck's drums (2026-09-29 audit, 2026-10-01).
        qty = entry["lbs"]
        if qty <= 0:
            continue
        original_row = max(entry["rows"], key=entry["rows"].get) if entry["rows"] else None
        unit = lot.weight_unit or receipt.unit or "lbs"

        transfer = InventoryTransfer(
            id=_mint_id("transfer"),
            receipt_id=receipt.id,
            warehouse_id=receipt.warehouse_id,
            from_location_id=receipt.location_id,
            from_sub_location_id=receipt.sub_location_id,
            to_location_id=staging_location_id,
            to_sub_location_id=staging_sub_location_id,
            quantity=qty,
            unit=unit,
            reason=f"Staged for production (gun pull, request {request_id})",
            transfer_type="staging",
            requested_by=user_id,
            status="completed",
        )
        db.add(transfer)
        db.flush()

        si = StagingItem(
            id=_mint_id("staging"),
            transfer_id=transfer.id,
            receipt_id=receipt.id,
            product_id=receipt.product_id,
            quantity_staged=qty,
            pallets_staged=float(entry["units"]),
            original_storage_row_id=original_row,
            status="staged",
            staging_batch_id=batch_id,
            staged_at=now,
            warehouse_id=receipt.warehouse_id,
        )
        db.add(si)
        db.flush()
        created_ids.append(si.id)

        existing_ids = _parse_staging_item_ids(item.staging_item_ids)
        existing_ids.append(si.id)
        item.staging_item_ids = json.dumps(existing_ids)
        needed = float(item.quantity_needed or 0)
        item.quantity_fulfilled = min(needed, float(item.quantity_fulfilled or 0) + qty)
        if item.quantity_fulfilled >= needed:
            item.status = "fulfilled"
        elif item.quantity_fulfilled > 0:
            item.status = "partially_fulfilled"

    # Stamp the consumed events so a second submit has nothing to convert.
    for ev in events:
        ev.reason_code = "submitted"

    _update_parent_request_status(db, request_id)
    db.commit()

    sr = db.query(StagingRequest).filter(StagingRequest.id == request_id).first()
    return {
        "status": "ok",
        "message": f"Staged {len(created_ids)} line(s) for production.",
        "short_items": short,
        "staging_item_ids": created_ids,
        "request_status": sr.status if sr else None,
    }
