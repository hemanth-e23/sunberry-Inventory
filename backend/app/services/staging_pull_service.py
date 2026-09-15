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
)
from app.services import lot_placement_service as lps
from app.services import staging_service
from app.services.lot_receiving_service import resolve_lot_code
from app.services.staging_request_service import (
    _parse_staging_item_ids,
    _update_parent_request_status,
)

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


def _event_quantity(db: Session, event: LotPlacementEvent, _lot_cache: dict) -> float:
    """Weight one pull event represents: sealed units × weight + open qty."""
    lot = _lot_cache.get(event.material_lot_id)
    if lot is None:
        lot = db.query(MaterialLot).filter(
            MaterialLot.id == event.material_lot_id
        ).first()
        _lot_cache[event.material_lot_id] = lot
    per_unit = float(lot.weight_per_unit or 0) if lot else 0.0
    units = -int(event.full_units_delta or 0)
    open_qty = -float(event.qty_delta or 0)
    return max(0.0, units * per_unit) + max(0.0, open_qty)


def _pending_by_item(db: Session, item_ids: List[str]) -> Dict[str, float]:
    cache: dict = {}
    out: Dict[str, float] = {}
    for ev in _pending_events(db, item_ids):
        out[ev.ref_id] = out.get(ev.ref_id, 0.0) + _event_quantity(db, ev, cache)
    return out


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
        out.append({
            "id": sr.id,
            "production_batch_uid": sr.production_batch_uid,
            "product_name": sr.product_name,
            "formula_name": sr.formula_name,
            "production_date": sr.production_date.isoformat() if sr.production_date else None,
            "status": sr.status,
            "item_count": len(sr.items),
            "needed_qty": round(needed, 3),
            "fulfilled_qty": round(fulfilled, 3),
            "pending_qty": round(sum(pending.values()), 3),
        })
    return out


def request_detail(db: Session, request_id: str) -> dict:
    sr = db.query(StagingRequest).filter(StagingRequest.id == request_id).first()
    if not sr:
        raise NotFoundError("Staging request", request_id)

    item_ids = [i.id for i in sr.items]
    pending = _pending_by_item(db, item_ids)

    items = []
    for item in sr.items:
        needed = float(item.quantity_needed or 0)
        fulfilled = float(item.quantity_fulfilled or 0)
        item_pending = pending.get(item.id, 0.0)
        remaining = max(0.0, needed - fulfilled - item_pending)

        product_id = item.product_id
        if not product_id and item.sid:
            product = db.query(Product).filter(Product.sid == item.sid).first()
            product_id = product.id if product else None

        # FEFO suggestion, racks fullest-first — advisory for the gun.
        suggestion = None
        if product_id and remaining > 0:
            suggestions = staging_service.suggest_lots_for_staging(
                db, product_id, remaining, None
            )
            if suggestions:
                s = suggestions[0]
                suggestion = {
                    "receipt_id": s.get("receipt_id"),
                    "lot_number": s.get("lot_number"),
                    "expiration_date": (
                        s["expiration_date"].isoformat()
                        if s.get("expiration_date") else None
                    ),
                    "available_quantity": s.get("available_quantity"),
                    "is_counted": s.get("is_counted"),
                    "unit_label": s.get("unit_label"),
                    "available_units": s.get("available_units"),
                    "racks": s.get("racks", []),
                }

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
        })

    return {
        "id": sr.id,
        "production_batch_uid": sr.production_batch_uid,
        "product_name": sr.product_name,
        "formula_name": sr.formula_name,
        "production_date": sr.production_date.isoformat() if sr.production_date else None,
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
                return _scan_payload(
                    db, sr, status="needs_confirm", item=item, lot=lot,
                    message=(
                        f"FEFO suggests lot {first.get('lot_number') or '—'} first"
                        f"{' (expires ' + first['expiration_date'].strftime('%Y-%m-%d') + ')' if first.get('expiration_date') else ''}."
                        " Pull this one anyway?"
                    ),
                    warning="not_fefo_lot",
                )

    # Apply — placements are the rack truth, so the rack empties NOW.
    placement = (
        db.query(LotPlacement)
        .filter(
            LotPlacement.material_lot_id == lot.id,
            LotPlacement.storage_row_id == body.storage_row_id,
        )
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
            message=f"Open {lot.unit_label or 'unit'} pulled — about {round(share, 1)} {lot.weight_unit or 'lbs'}.",
        )

    free = 0
    if placement:
        free = max(0, int(placement.full_units or 0) - int(placement.held_units or 0))
    if body.units > free:
        return _scan_payload(
            db, sr, status="not_enough", item=item, lot=lot,
            message=(
                f"Only {free} sealed {lot.unit_label or 'unit'}"
                f"{'' if free == 1 else 's'} of this lot on that rack. "
                "Check the rack, or scan the rack you are actually pulling from."
            ),
        )
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
    qty = int(body.units) * float(lot.weight_per_unit or 0)
    return _scan_payload(
        db, sr, status="ok", item=item, lot=lot,
        units=int(body.units), quantity=qty,
        message=f"{body.units} {lot.unit_label or 'unit'}{'' if body.units == 1 else 's'} pulled.",
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

    # Aggregate per (item, lot): sealed units, open qty, and the rows drawn
    # from (most-drawn row becomes the StagingItem's original row).
    agg: Dict[tuple, dict] = {}
    lot_cache: dict = {}
    for ev in events:
        key = (ev.ref_id, ev.material_lot_id)
        entry = agg.setdefault(key, {"units": 0, "open_qty": 0.0, "rows": {}})
        u = -int(ev.full_units_delta or 0)
        entry["units"] += u
        entry["open_qty"] += -float(ev.qty_delta or 0)
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
        receipt = (
            db.query(Receipt)
            .filter(Receipt.material_lot_id == lot_id, Receipt.is_deleted == False)  # noqa: E712
            .order_by(Receipt.receipt_date.desc(), Receipt.created_at.desc())
            .first()
        )
        if not receipt:
            raise ValidationError(
                f"Lot {lot.lot_code} has no receipt on file — it cannot be staged "
                "until receiving paperwork exists."
            )

        qty = entry["units"] * float(lot.weight_per_unit or 0) + entry["open_qty"]
        if qty <= 0:
            continue
        original_row = max(entry["rows"], key=entry["rows"].get) if entry["rows"] else None
        unit = lot.weight_unit or receipt.unit or "lbs"

        transfer = InventoryTransfer(
            id=_mint_id("transfer"),
            receipt_id=receipt.id,
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
