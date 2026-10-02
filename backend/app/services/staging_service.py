import json
from datetime import datetime, timezone
from typing import Optional
import uuid
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import (
    MaterialLot, Receipt, StagingItem, Product, Location, SubLocation, StorageRow,
    InventoryTransfer, InventoryAdjustment, LotPlacementEvent, StorageArea,
)
from app.enums import ReceiptStatus, AdjustmentStatus, StagingItemStatus
from app.exceptions import ValidationError, NotFoundError
from app.services import lot_placement_service as lps
from app.services.row_allocation import deduct_rm_total, deduct_rm_rows, add_rm_rows
from app.utils.calendar_dates import calendar_day

# Statuses of a staging item that still has (or may have) material out.
ACTIVE_STAGING_STATUSES = ("staged", "partially_used", "partially_returned")

# The gun's pull ledger stamps (staging_pull_service owns them; read-only here).
_GUN_PULL_REF = "staging_pull"
_DESK_REF = "staging"


# ─── shared staging rules ─────────────────────────────────────────────────────

def mint_id(prefix: str) -> str:
    return f"{prefix}-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"


def settle_status(staging_item: StagingItem) -> str:
    """The one rule for a staging item's status, from its three quantities.

    Every writer (desk mark-used / return / undo, request-flow twins) sets the
    status through here, so "partially_returned" can no longer mean "closed"
    in one place and "still out" in another (browser test PART 3, U3/B8)."""
    staged = float(staging_item.quantity_staged or 0)
    used = float(staging_item.quantity_used or 0)
    returned = float(staging_item.quantity_returned or 0)
    remaining = staged - used - returned
    if remaining <= 0.001:
        if used <= 0.001:
            status = StagingItemStatus.RETURNED.value
        elif returned <= 0.001:
            status = StagingItemStatus.USED.value
        else:
            status = StagingItemStatus.COMPLETED.value
    elif returned > 0.001:
        status = StagingItemStatus.PARTIALLY_RETURNED.value
    elif used > 0.001:
        status = StagingItemStatus.PARTIALLY_USED.value
    else:
        status = StagingItemStatus.STAGED.value
    staging_item.status = status
    return status


def staged_unit_weight(staging_item: StagingItem, receipt: Optional[Receipt] = None) -> float:
    """What one container of THIS staging item weighs: staged lbs ÷ containers.

    A return splits its weight into full drums + a weighed remainder at this
    figure. The receipt's weight was wrong for mixed-weight lots — a 474 lb
    drum pulled for a request pinned to the 502 truck came back as
    "does not add up" (browser test PART 3, follow-up). Falls back to the
    receipt's own figure when the container count is unknown (legacy)."""
    units = float(staging_item.pallets_staged or 0)
    staged = float(staging_item.quantity_staged or 0)
    if units > 0 and staged > 0 and float(units).is_integer():
        return staged / units
    return float(getattr(receipt, "weight_per_container", 0) or 0)


def return_split_unit_weight(
    db: Session,
    lot: MaterialLot,
    staging_item: StagingItem,
    receipt: Optional[Receipt],
    *,
    quantity: float,
    full_units: Optional[int] = None,
    weighed_partial_qty: Optional[float] = None,
) -> float:
    """Per-drum weight a return's full/weighed split is checked at.

    No split given: the staged drums' own weight (`staged_unit_weight`).
    Split given: the weight that makes it add up, provided that is a weight a
    drum of THIS lot really has — between its lightest and heaviest delivery.
    One staging item can hold a 502 and a 474 (average 488); returning the
    474 whole is "1 full = 474" and must be accepted, while "1 full = 900"
    is still refused by `return_units`' own arithmetic check."""
    default = staged_unit_weight(staging_item, receipt) or float(lot.weight_per_unit or 0)
    full = int(full_units or 0)
    if full_units is None or full <= 0:
        return default
    implied = (float(quantity) - float(weighed_partial_qty or 0)) / full
    weights = [
        float(w) for (w,) in db.query(Receipt.weight_per_container).filter(
            Receipt.material_lot_id == lot.id,
            Receipt.weight_per_container.isnot(None),
        ).all() if w and float(w) > 0
    ]
    if lot.weight_per_unit:
        weights.append(float(lot.weight_per_unit))
    if default:
        weights.append(default)
    if weights and min(weights) - 0.01 <= implied <= max(weights) + 0.01:
        return implied
    return default


def held_lot_message(db: Session, receipt: Receipt, *, verb: str = "used in production") -> Optional[str]:
    """Why this receipt's material may not be consumed, or None.

    A QA hold lives on the LOT for lot-tracked material (`MaterialLot.is_held`)
    and on the receipt (`hold` + `held_quantity`) for legacy material — the
    bare `receipt.hold` flag is also the transient lock a pending transfer
    sets, so on its own it is not a hold. Material already in staging is off
    every rack, so per-rack held units do not apply to it (browser test PART
    3, B3: 292 lb of a held lot was marked used with no warning)."""
    if receipt is None:
        return None
    lot = None
    if receipt.material_lot_id:
        lot = db.query(MaterialLot).filter(MaterialLot.id == receipt.material_lot_id).first()
    if lot is not None:
        if not lot.is_held:
            return None
        name = lot.vendor_lot_number or receipt.lot_number or lot.lot_code
        reason = f" — {lot.hold_reason}" if lot.hold_reason else ""
        return (
            f"Lot {name} is ON HOLD{reason}. Held material cannot be {verb}. "
            "Release the hold first, or return the material to a rack."
        )
    if receipt.hold and float(receipt.held_quantity or 0) > 0:
        return (
            f"Lot {receipt.lot_number or receipt.id} is ON HOLD. Held material "
            f"cannot be {verb}. Release the hold first, or return the material to a rack."
        )
    return None


def resolve_return_rack(
    db: Session,
    receipt: Receipt,
    to_storage_row_id: Optional[str],
    to_location_id: Optional[str] = None,
    to_sub_location_id: Optional[str] = None,
):
    """Validate a return rack and say where it is: `(row_id, loc_id, sub_id)`.

    A return may go to ANY active rack of the material's warehouse, not only
    the one it came off (browser test PART 3, G2). The rack is the truth about
    the room, so its own location/sub-location win over whatever the form sent.
    No rack named: the caller's location fields pass through unchanged."""
    if not to_storage_row_id:
        return None, to_location_id, to_sub_location_id
    row = db.query(StorageRow).filter(StorageRow.id == to_storage_row_id).first()
    if row is None:
        raise ValidationError("That rack does not exist. Pick the rack the material went back onto.")
    if row.is_active is False:
        raise ValidationError(f"Rack {row.name} is not active. Pick an active rack.")
    sub = row.sub_location if row.sub_location_id else None
    area = None
    if sub is None and row.storage_area_id:
        area = db.query(StorageArea).filter(StorageArea.id == row.storage_area_id).first()
        sub = area.sub_location if area is not None and area.sub_location_id else None
    if sub is not None and getattr(sub, "is_active", True) is False:
        raise ValidationError(f"Rack {row.name} is in an inactive room ({sub.name}).")
    row_wh = lps.warehouse_for_row(db, row.id)
    if receipt is not None and receipt.warehouse_id and row_wh and row_wh != receipt.warehouse_id:
        raise ValidationError(
            f"Rack {row.name} is in a different warehouse from this material. "
            "Return it to a rack in its own warehouse."
        )
    loc_id = sub.location_id if sub is not None else (area.location_id if area is not None else None)
    return row.id, (loc_id or to_location_id), (sub.id if sub is not None else to_sub_location_id)


def _row_names(db: Session, row_ids) -> dict:
    ids = [r for r in set(row_ids) if r]
    if not ids:
        return {}
    return {r.id: r.name for r in db.query(StorageRow).filter(StorageRow.id.in_(ids)).all()}


def _events_to_rows(db: Session, lot: Optional[MaterialLot], events) -> list:
    """Per-rack `{storage_row_id, units, qty}` a set of pull events took."""
    by_row: dict = {}
    for ev in events:
        units = -int(ev.full_units_delta or 0)
        open_qty = -float(ev.qty_delta or 0)
        if units <= 0 and open_qty <= 0:
            continue
        sealed = lps.event_taken_weight(db, lot, ev.id) if (lot is not None and units > 0) else None
        if sealed is None:
            sealed = units * float(getattr(lot, "weight_per_unit", 0) or 0)
        entry = by_row.setdefault(ev.storage_row_id, {"units": 0, "open_units": 0, "qty": 0.0})
        entry["units"] += max(0, units)
        entry["open_units"] += max(0, -int(ev.open_units_delta or 0))
        entry["qty"] += sealed + max(0.0, open_qty)
    names = _row_names(db, by_row.keys())
    return [
        {
            "storage_row_id": rid,
            "storage_row_name": names.get(rid, rid),
            "units": v["units"],
            "open_units": v["open_units"],
            "qty": round(v["qty"], 3),
        }
        for rid, v in by_row.items()
    ]


def staging_item_origin_rows(db: Session, staging_item: StagingItem) -> list:
    """Every rack a staging item's containers came off: `[{storage_row_id,
    storage_row_name, units, open_units, qty}]`.

    `StagingItem.original_storage_row_id` holds ONE rack, so 4 drums pulled
    2 + 2 off QA Staging and QA-D1 read "QA-D1" for all four (PART 3, U2).
    The placement ledger knows the truth:
      - desk pulls stamp their events with the staging item's id;
      - gun pulls stamp the REQUEST ITEM id, and are converted at submit, so
        the item's events between the previous submit of the same lot and
        this one are its pulls.
    Falls back to the transfer's source breakdown, then the single rack."""
    receipt = db.query(Receipt).filter(Receipt.id == staging_item.receipt_id).first()
    lot = None
    if receipt is not None and receipt.material_lot_id:
        lot = db.query(MaterialLot).filter(MaterialLot.id == receipt.material_lot_id).first()

    if lot is not None:
        desk = db.query(LotPlacementEvent).filter(
            LotPlacementEvent.material_lot_id == lot.id,
            LotPlacementEvent.ref_type == _DESK_REF,
            LotPlacementEvent.ref_id == staging_item.id,
            LotPlacementEvent.event_type == lps.EVENT_STAGED,
        ).order_by(LotPlacementEvent.seq).all()
        rows = _events_to_rows(db, lot, desk)
        if rows:
            return rows
        gun = _gun_pull_events(db, staging_item, lot)
        rows = _events_to_rows(db, lot, gun)
        if rows:
            return rows

    transfer = (
        db.query(InventoryTransfer).filter(InventoryTransfer.id == staging_item.transfer_id).first()
        if staging_item.transfer_id else None
    )
    breakdown = [b for b in (getattr(transfer, "source_breakdown", None) or []) if isinstance(b, dict)]
    if breakdown:
        ids = [str(b.get("id") or "").replace("row-", "", 1) for b in breakdown]
        names = _row_names(db, ids)
        return [
            {"storage_row_id": rid, "storage_row_name": names.get(rid, rid),
             "units": None, "open_units": 0, "qty": round(float(b.get("quantity") or 0), 3)}
            for rid, b in zip(ids, breakdown)
        ]
    if staging_item.original_storage_row_id:
        names = _row_names(db, [staging_item.original_storage_row_id])
        units = staging_item.pallets_staged
        return [{
            "storage_row_id": staging_item.original_storage_row_id,
            "storage_row_name": names.get(staging_item.original_storage_row_id,
                                          staging_item.original_storage_row_id),
            "units": int(units) if units is not None and float(units).is_integer() else units,
            "open_units": 0,
            "qty": round(float(staging_item.quantity_staged or 0), 3),
        }]
    return []


def _gun_pull_events(db: Session, staging_item: StagingItem, lot: MaterialLot) -> list:
    """The submitted gun-pull events that became this staging item."""
    from app.models import StagingRequestItem

    if not (staging_item.staging_batch_id or "").startswith("gunpull"):
        return []
    req_items = db.query(StagingRequestItem).filter(
        StagingRequestItem.staging_item_ids.contains(staging_item.id)
    ).all()
    if not req_items:
        return []
    item_ids = [i.id for i in req_items]
    upper = staging_item.staged_at
    # The previous gun submit of the same lot against the same request item(s)
    # bounds the window from below.
    sibling_ids = set()
    for ri in req_items:
        try:
            sibling_ids.update(x for x in (json.loads(ri.staging_item_ids or "[]") or []) if x)
        except (ValueError, TypeError):
            pass
    sibling_ids.discard(staging_item.id)
    lower = None
    if sibling_ids and upper is not None:
        prev = db.query(StagingItem).filter(
            StagingItem.id.in_(sibling_ids),
            StagingItem.receipt_id.in_(
                db.query(Receipt.id).filter(Receipt.material_lot_id == lot.id)
            ),
            StagingItem.staging_batch_id.like("gunpull%"),
            StagingItem.staged_at < upper,
        ).order_by(StagingItem.staged_at.desc()).first()
        lower = prev.staged_at if prev else None
    q = db.query(LotPlacementEvent).filter(
        LotPlacementEvent.material_lot_id == lot.id,
        LotPlacementEvent.ref_type == _GUN_PULL_REF,
        LotPlacementEvent.ref_id.in_(item_ids),
        LotPlacementEvent.reason_code == "submitted",
    )
    if upper is not None:
        q = q.filter(LotPlacementEvent.occurred_at <= upper)
    if lower is not None:
        q = q.filter(LotPlacementEvent.occurred_at > lower)
    return q.order_by(LotPlacementEvent.seq).all()


def lot_staging_exposure(db: Session, material_lot_id: Optional[str]) -> dict:
    """Units of a lot that are OFF the racks right now: on a gun cart (pulled,
    not yet submitted) and out in staging. A hold freezes the racks, but these
    containers are already gone from them — the hold form has to say so
    (browser test PART 3, B3)."""
    out = {"on_cart_units": 0, "on_cart_qty": 0.0, "in_staging_qty": 0.0, "in_staging_units": 0.0}
    if not material_lot_id:
        return out
    lot = db.query(MaterialLot).filter(MaterialLot.id == material_lot_id).first()
    pending = db.query(LotPlacementEvent).filter(
        LotPlacementEvent.material_lot_id == material_lot_id,
        LotPlacementEvent.ref_type == _GUN_PULL_REF,
        LotPlacementEvent.reason_code.is_(None),
    ).all()
    for row in _events_to_rows(db, lot, pending):
        out["on_cart_units"] += int(row["units"] or 0) + int(row["open_units"] or 0)
        out["on_cart_qty"] += float(row["qty"] or 0)
    receipt_ids = [rid for (rid,) in db.query(Receipt.id).filter(
        Receipt.material_lot_id == material_lot_id).all()]
    if receipt_ids:
        for si in db.query(StagingItem).filter(
            StagingItem.receipt_id.in_(receipt_ids),
            StagingItem.status.in_(ACTIVE_STAGING_STATUSES),
        ).all():
            left = float(si.quantity_staged or 0) - float(si.quantity_used or 0) - float(si.quantity_returned or 0)
            if left <= 0.001:
                continue
            out["in_staging_qty"] += left
            per = (float(si.quantity_staged or 0) / float(si.pallets_staged)) if si.pallets_staged else 0
            out["in_staging_units"] += (left / per) if per > 0 else 0
    out["on_cart_qty"] = round(out["on_cart_qty"], 3)
    out["in_staging_qty"] = round(out["in_staging_qty"], 3)
    out["in_staging_units"] = round(out["in_staging_units"], 2)
    return out


def _lot_row_footprint(receipt: Receipt) -> dict:
    """Current per-row ``{cases, pallets}`` footprint of an RM lot, from its
    allocation JSON (multi-row) or its single ``storage_row_id``."""
    footprint: dict = {}
    allocs = receipt.raw_material_row_allocations
    if allocs and isinstance(allocs, list):
        for a in allocs:
            rid = a.get("rowId")
            if not rid:
                continue
            footprint[rid] = {
                "cases": float(a.get("cases", 0) or 0),
                "pallets": float(a.get("pallets", 0) or 0),
            }
    elif receipt.storage_row_id:
        footprint[receipt.storage_row_id] = {
            "cases": float(receipt.quantity or 0),
            "pallets": float(receipt.pallets or 0),
        }
    return footprint


def _stage_free_rack(
    db: Session, receipt: Receipt, staged_qty: float, staged_pallets: float,
    source_row_id=None,
) -> float:
    """Free a lot's rack footprint when material is pulled for staging.

    Two languages, one meaning. A COUNTED lot — one with placements — comes off
    the rack as whole containers off named racks, because that is what a person
    physically carries and what they can be told to go and fetch. Everything else
    keeps the original behaviour: remove ``staged_qty`` content and
    ``staged_pallets`` pallets spread across the lot's rows by their share.

    Returns the pallet count actually freed.
    """
    if lps.is_counted_lot(db, receipt.material_lot_id):
        return _stage_free_counted(db, receipt, staged_qty, source_row_id)["freed"]

    footprint = _lot_row_footprint(receipt)
    total_cases = sum(r["cases"] for r in footprint.values())
    total_pallets = sum(r["pallets"] for r in footprint.values())

    if staged_pallets is None:
        # No explicit count — estimate proportionally from the lot's real pallets.
        staged_pallets = (
            (staged_qty / float(receipt.quantity) * total_pallets)
            if receipt.quantity and total_pallets > 0 else 0.0
        )

    content_by_row: dict = {}
    pallets_by_row: dict = {}
    for rid, r in footprint.items():
        c = (staged_qty * r["cases"] / total_cases) if total_cases > 0 else 0.0
        p = (staged_pallets * r["pallets"] / total_pallets) if total_pallets > 0 else 0.0
        if c > 0 or p > 0:
            content_by_row[rid] = c
            pallets_by_row[rid] = p
    if content_by_row:
        deduct_rm_rows(db, receipt, content_by_row, pallets_by_row=pallets_by_row, update_rows=True)
    return float(staged_pallets or 0)


def _stage_free_counted(
    db: Session, receipt: Receipt, staged_qty: float, source_row_id=None, *,
    full_units: Optional[int] = None,
    open_units: Optional[int] = None,
    ref_id: Optional[str] = None,
) -> dict:
    """Pull whole containers off named racks for a counted lot.

    Returns ``{"freed": containers, "qty": lbs actually taken, "rows": [...]}``
    — the weight is what the containers that left really hold (each drum at
    its own delivery's weight), not the typed figure: 2 drums for "992 lbs"
    are 1,004 lbs on the cart (browser test PART 3, B5).

    Two ways to ask:
      * ``full_units`` / ``open_units`` (the desk Stage dialog): exactly that
        many sealed and opened containers, off ``source_row_id`` when named.
      * a weight only (older callers): opened containers first, then sealed
        ones rounded UP, as before.

    The pallet argument is deliberately ignored here. For a counted lot the
    footprint is DERIVED from the unit count (`_project_rows` recomputes
    `occupied_pallets` from placements), so accepting a separate pallet figure
    would let two numbers disagree about the same shelf — the exact drift the
    lot model exists to remove. The count is the input; the footprint follows.
    """
    lot = db.query(MaterialLot).filter(MaterialLot.id == receipt.material_lot_id).first()
    if not lot:
        return {"freed": 0.0, "qty": float(staged_qty or 0), "rows": []}
    ref = ref_id or receipt.id
    seq_before = db.query(func.max(LotPlacementEvent.seq)).filter(
        LotPlacementEvent.material_lot_id == lot.id
    ).scalar() or 0

    if full_units is not None or open_units is not None:
        _take_exact_containers(
            db, receipt, lot,
            full_units=int(full_units or 0), open_units=int(open_units or 0),
            source_row_id=source_row_id, ref=ref,
        )
        return _pulled_summary(db, lot, ref, seq_before)

    # OPENED-FIRST: a part-used drum on the rack is exactly what a worker
    # would grab before breaking a new seal, and pulling it here is what
    # keeps a returned partial from stranding (availability counts its
    # content, so refusing to pull it would offer weight take_units cannot
    # deliver).
    remaining = float(staged_qty)
    if not lot.is_held:
        # When the worker named the rack they pulled from (audit S8), stay on
        # it — draining fullest-first swapped drums between rows on paper.
        placements = lps.placements_for_lot(db, lot.id)
        if source_row_id:
            placements = [p for p in placements if p.storage_row_id == source_row_id]
        for placement in placements:
            while remaining > 1e-6 and int(placement.open_units or 0) > 0:
                open_units = int(placement.open_units)
                open_qty = float(placement.open_remaining_qty or 0)
                share = open_qty if open_units == 1 else open_qty / open_units
                if share <= 1e-6:
                    break
                if share <= remaining + 1e-6:
                    # The whole opened container goes to staging.
                    lps.apply_delta(
                        db, lot, placement.storage_row_id,
                        event_type=lps.EVENT_STAGED,
                        open_units_delta=-1,
                        open_qty_delta=-share,
                        ref_type="staging",
                        ref_id=ref,
                        reason="Pulled for production staging (open container)",
                    )
                    remaining -= share
                else:
                    # Less than one open container needed: pour from it — the
                    # drum stays on the rack with the rest of its content.
                    lps.apply_delta(
                        db, lot, placement.storage_row_id,
                        event_type=lps.EVENT_STAGED,
                        open_qty_delta=-remaining,
                        ref_type="staging",
                        ref_id=ref,
                        reason="Pulled for production staging (from open container)",
                    )
                    remaining = 0.0
                    break

    if remaining > 1e-6:
        if source_row_id:
            # THAT rack's drums decide how many make the weight: the carrier
            # receipt's figure took 3 × 502 for "992 lbs" (PART 3, B5).
            units = lps.row_units_for_quantity(
                db, lot, source_row_id, remaining, receipt=receipt, exact=False,
            )
        else:
            units = lps.receipt_units_for_quantity(receipt, lot, remaining, exact=False)
        lps.take_units(
            db, lot,
            units=units,
            event_type=lps.EVENT_STAGED,
            from_row_id=source_row_id,
            ref_type="staging",
            ref_id=ref,
            reason="Pulled for production staging",
        )

    return _pulled_summary(db, lot, ref, seq_before)


def _take_exact_containers(
    db: Session, receipt: Receipt, lot: MaterialLot, *,
    full_units: int, open_units: int, source_row_id: Optional[str], ref: str,
) -> None:
    """Take exactly `open_units` opened and `full_units` sealed containers."""
    if lot.is_held:
        raise ValidationError(held_lot_message(db, receipt, verb="staged") or "This lot is on hold.")
    if full_units < 0 or open_units < 0:
        raise ValidationError("A staging pull cannot take a negative number of containers.")
    want_open = open_units
    if want_open:
        placements = lps.placements_for_lot(db, lot.id)
        if source_row_id:
            placements = [p for p in placements if p.storage_row_id == source_row_id]
        for placement in placements:
            while want_open > 0 and int(placement.open_units or 0) > 0:
                n_open = int(placement.open_units)
                open_qty = float(placement.open_remaining_qty or 0)
                share = open_qty if n_open == 1 else open_qty / n_open
                lps.apply_delta(
                    db, lot, placement.storage_row_id,
                    event_type=lps.EVENT_STAGED,
                    open_units_delta=-1,
                    open_qty_delta=-share,
                    ref_type="staging",
                    ref_id=ref,
                    reason="Pulled for production staging (open container)",
                )
                want_open -= 1
        if want_open > 0:
            word = lot.unit_label or "unit"
            raise ValidationError(
                f"There are not enough opened {word}s of this lot "
                f"{'on that rack' if source_row_id else 'on the racks'}. "
                "Refresh the lot list and try again."
            )
    if full_units:
        lps.take_units(
            db, lot,
            units=full_units,
            event_type=lps.EVENT_STAGED,
            from_row_id=source_row_id,
            ref_type="staging",
            ref_id=ref,
            reason="Pulled for production staging",
        )


def _pulled_summary(db: Session, lot: MaterialLot, ref: str, seq_before: int) -> dict:
    """What a pull just took, from its own ledger events."""
    db.flush()
    events = db.query(LotPlacementEvent).filter(
        LotPlacementEvent.material_lot_id == lot.id,
        LotPlacementEvent.seq > seq_before,
        LotPlacementEvent.ref_type == "staging",
        LotPlacementEvent.ref_id == ref,
        LotPlacementEvent.event_type == lps.EVENT_STAGED,
    ).order_by(LotPlacementEvent.seq).all()
    rows = _events_to_rows(db, lot, events)
    # The footprint freed IS the container count — see `_project_rows`.
    freed = float(sum(int(r["units"] or 0) + int(r["open_units"] or 0) for r in rows))
    qty = round(sum(float(r["qty"] or 0) for r in rows), 3)
    return {"freed": freed, "qty": qty, "rows": rows}


def _compute_available_quantity(db: Session, receipt: Receipt) -> float:
    """How much of this receipt is free to stage.

    For a COUNTED lot this is derived from the containers actually pickable —
    what is on the racks, minus anything quarantined. `receipt.quantity` cannot
    answer it: it is a running weight that knows nothing about holds, so a lot
    with five drums under a QA hold would report every pound as available and
    then be refused by `take_units` at the moment of pulling. Offering material
    that cannot be pulled is how a picker ends up standing at a rack arguing
    with the system.

    Legacy receipts keep the old arithmetic — no placements, so no better source.

    Both paths still subtract what is currently out in staging, because those
    containers have physically left the rack but the receipt has not been
    decremented yet.
    """
    staged_items = db.query(StagingItem).filter(
        StagingItem.receipt_id == receipt.id,
        StagingItem.status.in_(["staged", "partially_used", "partially_returned"]),
    ).all()
    quantity_still_in_staging = sum(
        item.quantity_staged - item.quantity_used - item.quantity_returned
        for item in staged_items
    )

    if lps.is_counted_lot(db, receipt.material_lot_id):
        lot = db.query(MaterialLot).filter(
            MaterialLot.id == receipt.material_lot_id
        ).first()
        if lot:
            if lot.is_held:
                return 0.0
            placements = lps.placements_for_lot(db, lot.id)
            # Open (part-used) drums are pickable too — their weighed content
            # is real stock a worker can carry, and staging pulls them
            # opened-first so a partial never strands on a rack.
            open_qty = sum(float(p.open_remaining_qty or 0) for p in placements)
            # Each rack's sealed drums at THEIR deliveries' weights: pricing
            # the lot at one receipt's figure showed A-0925 (mixed 474/502)
            # as 27 × 474 = 12,798 lbs instead of 13,078 (PART 3, B5).
            pickable = sum(_placement_free_weight(db, lot, p) for p in placements) + open_qty
            # The staging subtraction is already reflected in the placements —
            # staging takes the units off the rack — so it must not be applied
            # twice here.
            return max(0.0, pickable)

    return receipt.quantity - quantity_still_in_staging


def suggest_lots_for_staging(
    db: Session, product_id: str, quantity: float, wh_id: Optional[str]
) -> list:
    """Return FEFO-sorted lot suggestions for staging a product."""
    q = db.query(Receipt).filter(
        Receipt.product_id == product_id,
        Receipt.status == ReceiptStatus.APPROVED,
        Receipt.quantity > 0,
        Receipt.hold == False,
    )
    if wh_id:
        q = q.filter(Receipt.warehouse_id == wh_id)
    receipts = q.order_by(Receipt.expiration_date.asc().nullslast()).all()

    # A counted lot's drums live on racks, not in `Receipt.quantity`. Usage
    # sync decrements the paperwork weight and can zero it (status depleted)
    # while sealed drums still sit on a rack — the `quantity > 0` filter above
    # would then hide a lot a picker can walk to and touch. Rescue: any lot of
    # this product that still has placements is offered; the availability
    # check below reads the racks, so an actually-empty lot still drops out.
    seen_lot_ids = {r.material_lot_id for r in receipts if r.material_lot_id}
    seen_receipt_ids = {r.id for r in receipts}
    rescue_q = db.query(Receipt).filter(
        Receipt.product_id == product_id,
        Receipt.material_lot_id.isnot(None),
        Receipt.status.in_([ReceiptStatus.APPROVED, ReceiptStatus.DEPLETED]),
        Receipt.hold == False,  # noqa: E712
        Receipt.is_deleted == False,  # noqa: E712
    )
    if wh_id:
        rescue_q = rescue_q.filter(Receipt.warehouse_id == wh_id)
    # Newest first: `project_lot` writes the lot's picture onto the newest
    # receipt, so that is the one to speak for the lot.
    for rescued in rescue_q.order_by(
        Receipt.receipt_date.desc(), Receipt.created_at.desc()
    ).all():
        if rescued.id in seen_receipt_ids or rescued.material_lot_id in seen_lot_ids:
            continue
        seen_lot_ids.add(rescued.material_lot_id)
        receipts.append(rescued)
    # Keep FEFO across the combined list.
    receipts.sort(key=lambda r: (r.expiration_date is None, r.expiration_date or 0))

    # ONE suggestion per lot (2026-09-29 finding 9). Availability for a
    # counted lot is read from the racks, so every sibling receipt of a
    # multi-receipt lot reported the SAME lot-wide number — a 120-drum lot
    # received on two trucks was listed twice offering 240 drums. Keep the
    # newest live receipt per lot (the projection carrier); legacy receipts
    # without a lot pass through untouched.
    def _carrier_rank(r):
        live = r.status == ReceiptStatus.APPROVED and float(r.quantity or 0) > 0
        return (
            live,
            r.receipt_date.timestamp() if r.receipt_date else 0,
            r.created_at.timestamp() if r.created_at else 0,
        )

    best_by_lot: dict = {}
    for r in receipts:
        if not r.material_lot_id:
            continue
        cur = best_by_lot.get(r.material_lot_id)
        if cur is None or _carrier_rank(r) > _carrier_rank(cur):
            best_by_lot[r.material_lot_id] = r
    receipts = [
        r for r in receipts
        if not r.material_lot_id or best_by_lot[r.material_lot_id].id == r.id
    ]

    suggestions = []
    for receipt in receipts:
        available_quantity = _compute_available_quantity(db, receipt)
        detail = _counted_lot_detail(db, receipt)
        # A lot whose racks are empty but whose material sits in staging is
        # still a fact the screen must state ("already staged — add more?"),
        # not something to silently hide.
        if available_quantity <= 0.01 and float(detail.get("already_staged_qty") or 0) <= 0.01:
            continue

        location_name = sub_location_name = storage_row_name = None
        if receipt.location_id:
            loc = db.query(Location).filter(Location.id == receipt.location_id).first()
            location_name = loc.name if loc else None
        if receipt.sub_location_id:
            sub = db.query(SubLocation).filter(SubLocation.id == receipt.sub_location_id).first()
            sub_location_name = sub.name if sub else None
        if receipt.storage_row_id:
            row = db.query(StorageRow).filter(StorageRow.id == receipt.storage_row_id).first()
            storage_row_name = row.name if row else None
            if not sub_location_name and row and row.sub_location_id:
                sub = db.query(SubLocation).filter(SubLocation.id == row.sub_location_id).first()
                sub_location_name = sub.name if sub else None

        # A lot-tracked lot is WHERE ITS RACKS SAY, not where the receipt was
        # first put away: the suggestion read "ROW 3" after ROW 3 was emptied
        # (2026-10-01). Fullest rack first, the order a picker walks them.
        if detail.get("is_counted") and detail.get("racks"):
            storage_row_name = ", ".join(r["storage_row_name"] for r in detail["racks"])

        unit = receipt.unit or "cases"
        if not unit or unit == "cases":
            product = db.query(Product).filter(Product.id == receipt.product_id).first()
            if product and product.quantity_uom:
                unit = product.quantity_uom

        suggestions.append({
            "receipt_id": receipt.id,
            "lot_number": receipt.lot_number or "",
            "location_id": receipt.location_id,
            "location_name": location_name,
            "sub_location_id": receipt.sub_location_id,
            "sub_location_name": sub_location_name,
            "storage_row_name": storage_row_name,
            "expiration_date": calendar_day(receipt.expiration_date),
            "available_quantity": available_quantity,
            "unit": unit,
            "container_count": receipt.container_count,
            "container_unit": receipt.container_unit,
            "weight_per_container": receipt.weight_per_container,
            "weight_unit": receipt.weight_unit,
            **detail,
        })

    return suggestions


def _counted_lot_detail(db: Session, receipt: Receipt) -> dict:
    """Containers and racks, for a lot whose location is tracked as placements.

    What the staging screen needs to stop speaking in pounds. A worker does not
    remove 62% of a pound from a rack — they carry two drums off ROW 3 — so the
    screen has to be able to say how many containers there are and which racks
    they are on.

    Quarantined containers are reported but EXCLUDED from `available_units`.
    They are physically on the rack, so hiding them entirely would contradict
    what somebody sees standing there; they cannot be pulled, so counting them
    as available would offer material `take_units` will refuse.
    """
    empty = {"is_counted": False, "unit_label": None, "available_units": 0,
             "held_units": 0, "open_units": 0, "open_remaining_qty": 0.0,
             "already_staged_qty": 0.0, "racks": []}
    if not lps.is_counted_lot(db, receipt.material_lot_id):
        return empty

    lot = db.query(MaterialLot).filter(MaterialLot.id == receipt.material_lot_id).first()
    if not lot:
        return empty
    # A wholly-held lot offers nothing, but still says so rather than vanishing:
    # the row is filtered out upstream by `Receipt.hold`, and if it ever reaches
    # here the honest answer is zero available with the hold visible.
    placements = lps.placements_for_lot(db, lot.id)
    rows = _rows_by_id(db, [p.storage_row_id for p in placements])

    racks = []
    for placement in placements:
        held = int(placement.held_units or 0)
        free = 0 if lot.is_held else max(0, int(placement.full_units or 0) - held)
        open_units = 0 if lot.is_held else int(placement.open_units or 0)
        open_qty = 0.0 if lot.is_held else float(placement.open_remaining_qty or 0)
        if free <= 0 and held <= 0 and open_units <= 0:
            continue
        row = rows.get(placement.storage_row_id)
        racks.append({
            "storage_row_id": placement.storage_row_id,
            "storage_row_name": row.name if row else placement.storage_row_id,
            "available_units": free,
            "held_units": int(placement.full_units or 0) if lot.is_held else held,
            # Opened containers — shown so a picker uses them up first.
            "open_units": open_units,
            "open_remaining_qty": round(open_qty, 3),
            # The free sealed drums' real weight, and what each next drum
            # off this rack weighs (oldest delivery first — the order a pull
            # takes them), so the dialog allocates whole drums at exact lbs.
            "available_qty": round(_placement_free_weight(db, lot, placement), 3) if free else 0.0,
            "unit_weight": round(lps.row_unit_weight(db, lot, placement.storage_row_id), 3),
            "unit_weights": _fifo_weight_layers(db, lot, placement.storage_row_id, free),
        })
    # Fullest first — the same order `take_units` drains them in, so the screen
    # shows the racks in the order a picker will actually walk them.
    racks.sort(key=lambda r: r["available_units"], reverse=True)

    # What is already out in staging for this lot's receipt, so the screen can
    # say "1,200 lbs already staged — add more?" instead of silently hiding.
    staged_items = db.query(StagingItem).filter(
        StagingItem.receipt_id == receipt.id,
        StagingItem.status.in_(["staged", "partially_used", "partially_returned"]),
    ).all()
    already_staged = sum(
        max(0.0, float(i.quantity_staged or 0) - float(i.quantity_used or 0)
            - float(i.quantity_returned or 0))
        for i in staged_items
    )

    return {
        "is_counted": True,
        "unit_label": lot.unit_label,
        "available_units": sum(r["available_units"] for r in racks),
        "held_units": sum(r["held_units"] for r in racks),
        "open_units": sum(r["open_units"] for r in racks),
        "open_remaining_qty": round(sum(r["open_remaining_qty"] for r in racks), 3),
        "already_staged_qty": round(already_staged, 3),
        "racks": racks,
    }


def _placement_free_weight(db: Session, lot: MaterialLot, placement) -> float:
    """Lbs of the sealed, un-quarantined containers on one placement, priced by
    the deliveries actually on that rack (`derived_weight`)."""
    full = int(placement.full_units or 0)
    free = max(0, full - int(placement.held_units or 0))
    if lot.is_held or full <= 0 or free <= 0:
        return 0.0
    sealed = lps.derived_weight(lot, placement) - float(placement.open_remaining_qty or 0)
    return max(0.0, sealed) * free / full


_MAX_WEIGHT_STEPS = 200


def _fifo_weight_layers(db: Session, lot: MaterialLot, row_id: str, units: int) -> list:
    """`[{units, weight}]` — the next `units` sealed containers off a rack, in
    the order a pull takes them, grouped by weight. Built from the public
    `fifo_units_weight`; a very large rack falls back to its average."""
    units = int(units or 0)
    if units <= 0:
        return []
    if units > _MAX_WEIGHT_STEPS:
        return [{"units": units, "weight": round(lps.row_unit_weight(db, lot, row_id), 3)}]
    first = lps.fifo_units_weight(db, lot, row_id, 1)
    whole = lps.fifo_units_weight(db, lot, row_id, units)
    if abs(whole - first * units) < 0.001 * units:
        # One delivery weight on the rack — the common case, two lookups.
        return [{"units": units, "weight": round(first, 3)}]
    layers: list = []
    prev = 0.0
    for k in range(1, units + 1):
        total = lps.fifo_units_weight(db, lot, row_id, k)
        w = round(total - prev, 3)
        prev = total
        if layers and abs(layers[-1]["weight"] - w) < 0.001:
            layers[-1]["units"] += 1
        else:
            layers.append({"units": 1, "weight": w})
    return layers


def _rows_by_id(db: Session, row_ids) -> dict:
    ids = [r for r in set(row_ids) if r]
    if not ids:
        return {}
    return {r.id: r for r in db.query(StorageRow).filter(StorageRow.id.in_(ids)).all()}


def create_staging_transfer(db: Session, staging_data, current_user) -> dict:
    """Create staging transfers for multiple products/lots."""
    staging_batch_id = f"staging-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
    created_transfers = []
    created_staging_items = []

    for item_request in staging_data.items:
        if not item_request.lots or len(item_request.lots) == 0:
            raise ValidationError(f"No lots specified for product {item_request.product_id}")

        total_lot_quantity = sum(lot.quantity for lot in item_request.lots)
        if abs(total_lot_quantity - item_request.quantity_needed) > 0.01:
            raise ValidationError(
                f"Total lot quantities ({total_lot_quantity}) must match requested quantity ({item_request.quantity_needed})"
            )

        for lot_request in item_request.lots:
            receipt = db.query(Receipt).filter(Receipt.id == lot_request.receipt_id).first()
            if not receipt:
                raise NotFoundError("Receipt", lot_request.receipt_id)

            if receipt.product_id != item_request.product_id:
                raise ValidationError(
                    f"Receipt {lot_request.receipt_id} does not belong to product {item_request.product_id}"
                )

            held = held_lot_message(db, receipt, verb="staged")
            if held:
                raise ValidationError(held)

            available_quantity = _compute_available_quantity(db, receipt)
            if lot_request.quantity > available_quantity + 0.01:
                raise ValidationError(
                    f"Insufficient quantity for lot {receipt.lot_number}. Available: {available_quantity}, Requested: {lot_request.quantity}"
                )

            unit = receipt.unit or "cases"
            if not unit or unit == "cases":
                product = db.query(Product).filter(Product.id == receipt.product_id).first()
                if product and product.quantity_uom:
                    unit = product.quantity_uom

            transfer_id = f"transfer-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
            transfer = InventoryTransfer(
                id=transfer_id,
                receipt_id=receipt.id,
                from_location_id=receipt.location_id,
                from_sub_location_id=receipt.sub_location_id,
                to_location_id=staging_data.staging_location_id,
                to_sub_location_id=staging_data.staging_sub_location_id,
                quantity=lot_request.quantity,
                unit=unit,
                reason="Staging for production",
                transfer_type="staging",
                requested_by=str(current_user.id),
                status="completed",
            )
            db.add(transfer)
            db.flush()

            original_storage_row_id = receipt.storage_row_id
            staged_qty = float(lot_request.quantity)
            # Minted first: a counted lot's pull events carry it, so the racks
            # a staging item came off are answerable later (PART 3, U2).
            staging_item_id = mint_id("staging")

            if lps.is_counted_lot(db, receipt.material_lot_id):
                # Whole containers off named racks; the staged weight is what
                # those containers really hold (PART 3, B5).
                pulled = _stage_free_counted(
                    db, receipt, staged_qty,
                    source_row_id=getattr(lot_request, "source_row_id", None),
                    full_units=getattr(lot_request, "full_units", None),
                    open_units=getattr(lot_request, "open_units", None),
                    ref_id=staging_item_id,
                )
                pallets_staged = pulled["freed"]
                if pulled["qty"] > 0:
                    staged_qty = pulled["qty"]
                if pulled["rows"]:
                    top = max(pulled["rows"], key=lambda r: (r["units"] or 0) + (r["open_units"] or 0))
                    original_storage_row_id = top["storage_row_id"]
                    transfer.source_breakdown = [
                        {"id": f"row-{r['storage_row_id']}", "quantity": r["qty"]}
                        for r in pulled["rows"]
                    ]
                transfer.quantity = staged_qty
            else:
                # Free the rack at the moment material is physically pulled, using the
                # EXPLICIT pallets the worker entered (falls back to a proportional
                # estimate from the lot's real pallets when not supplied). Content and
                # pallets come off independently — no cases/cases_per_pallet.
                pallets_staged = _stage_free_rack(
                    db, receipt, staged_qty,
                    getattr(lot_request, "pallets", None),
                    source_row_id=getattr(lot_request, "source_row_id", None),
                )

            receipt.location_id = staging_data.staging_location_id
            receipt.sub_location_id = staging_data.staging_sub_location_id

            staging_item = StagingItem(
                id=staging_item_id,
                transfer_id=transfer.id,
                receipt_id=receipt.id,
                product_id=item_request.product_id,
                quantity_staged=staged_qty,
                pallets_staged=pallets_staged,
                original_storage_row_id=original_storage_row_id,
                staging_storage_row_id=None,
                staging_batch_id=staging_batch_id,
                # The material's warehouse: a corporate user staging has none.
                warehouse_id=receipt.warehouse_id or current_user.warehouse_id,
            )

            db.add(staging_item)
            created_transfers.append(transfer)
            created_staging_items.append(staging_item)

    # Link to production request items in the SAME transaction (audit S9).
    # The old flow did this with a second HTTP call, and a crash between the
    # two left staged material linked to no request.
    for f in (getattr(staging_data, "fulfillments", None) or []):
        from app.services import staging_request_service

        staging_request_service.fulfill_staging_request_item(
            db,
            request_id=f.request_id,
            item_id=f.item_id,
            quantity_fulfilled=float(f.quantity),
            staging_item_ids=[s.id for s in created_staging_items],
            commit=False,
        )

    return {
        "staging_batch_id": staging_batch_id,
        "transfers": [{"id": t.id, "receipt_id": t.receipt_id, "quantity": t.quantity} for t in created_transfers],
        "staging_items": [{"id": s.id, "receipt_id": s.receipt_id, "quantity_staged": s.quantity_staged} for s in created_staging_items],
    }


def mark_staging_used(db: Session, staging_item: StagingItem, request, current_user) -> StagingItem:
    """Mark staged quantity as consumed: free storage rows, create auto-approved adjustment."""
    if request.quantity <= 0:
        raise ValidationError("Quantity used must be greater than zero")
    available_quantity = staging_item.quantity_staged - staging_item.quantity_used - staging_item.quantity_returned
    if request.quantity > available_quantity + 0.01:
        raise ValidationError(
            f"Cannot use more than available. Available: {available_quantity}, Requested: {request.quantity}"
        )

    receipt = db.query(Receipt).filter(Receipt.id == staging_item.receipt_id).first()
    if not receipt:
        raise NotFoundError("Receipt for staging item")
    held = held_lot_message(db, receipt)
    if held:
        raise ValidationError(held)

    # The rack was already freed when this material was pulled for staging, so
    # consumption only reduces the lot total — no storage-row changes here.
    # pallets_used is tracked for reporting (proportional to the staged pallets).
    pallets_used_now = 0.0
    if staging_item.pallets_staged and staging_item.quantity_staged > 0:
        pallets_used_now = (request.quantity / staging_item.quantity_staged) * staging_item.pallets_staged

    staging_item.quantity_used += request.quantity
    staging_item.pallets_used = (staging_item.pallets_used or 0) + pallets_used_now

    settle_status(staging_item)
    staging_item.used_at = datetime.now(timezone.utc)

    # Auto-approved adjustment for consumption
    adjustment_id = f"adjust-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
    adjustment = InventoryAdjustment(
        id=adjustment_id,
        receipt_id=staging_item.receipt_id,
        category_id=receipt.category_id,
        product_id=staging_item.product_id,
        adjustment_type="production-consumption",
        quantity=request.quantity,
        reason="Used from staging for production",
        status=AdjustmentStatus.APPROVED,
        original_quantity=receipt.quantity,
        new_quantity=receipt.quantity - request.quantity,
        submitted_by=str(current_user.id),
        approved_by=str(current_user.id),
        approved_at=datetime.now(timezone.utc),
    )
    # Rack/allocation already settled at staging time; consumption just reduces
    # the lot total.
    # Spills across the lot's receipts instead of clamping at zero (audit S5).
    from app.services.staging_request_service import consume_receipt_quantity

    consume_receipt_quantity(db, receipt, request.quantity)
    db.add(adjustment)

    return staging_item


def return_staging_item(db: Session, staging_item: StagingItem, request, current_user) -> StagingItem:
    """Return staged quantity to warehouse: free staging rows, reserve return row, create return transfer."""
    available_quantity = staging_item.quantity_staged - staging_item.quantity_used - staging_item.quantity_returned
    if request.quantity > available_quantity + 0.01:
        raise ValidationError(
            f"Cannot return more than available. Available: {available_quantity}, Requested: {request.quantity}"
        )

    # The rack is MANDATORY (audit S1): a return without one incremented
    # quantity_returned while re-crediting no rack — the drums were deducted
    # at pull and now existed nowhere until a physical count found them. The
    # request-flow twin has always refused this; the desk flow now matches.
    # A room named instead of a rack resolves to the room's single row, the
    # same way intake and transfers resolve.
    if not request.to_storage_row_id and getattr(request, "to_sub_location_id", None):
        row_ids = [
            rid for (rid,) in db.query(StorageRow.id).filter(
                StorageRow.sub_location_id == request.to_sub_location_id,
                StorageRow.is_active == True,  # noqa: E712
            ).all()
        ]
        if len(row_ids) == 1:
            request.to_storage_row_id = row_ids[0]
    if not request.to_storage_row_id:
        raise ValidationError(
            "Pick the rack these containers are going back onto. A return "
            "without a rack re-credits nothing, and the material vanishes "
            "from every count."
        )

    receipt = db.query(Receipt).filter(Receipt.id == staging_item.receipt_id).first()
    if not receipt:
        raise NotFoundError("Receipt for staging item")
    # Any active rack of the warehouse, not only the original (PART 3, G2);
    # the rack's own room is where the material is now.
    (
        request.to_storage_row_id, request.to_location_id, request.to_sub_location_id,
    ) = resolve_return_rack(
        db, receipt, request.to_storage_row_id,
        request.to_location_id, getattr(request, "to_sub_location_id", None),
    )

    transfer = db.query(InventoryTransfer).filter(InventoryTransfer.id == staging_item.transfer_id).first()
    if not transfer:
        raise NotFoundError("Original transfer")

    unit = receipt.unit or "cases"
    product = db.query(Product).filter(Product.id == receipt.product_id).first()
    if not unit or unit == "cases":
        if product and product.quantity_uom:
            unit = product.quantity_uom

    # Pallets returned to the rack: the EXPLICIT count the worker entered, else a
    # proportional estimate from what was staged. The source rack was already
    # freed at staging time, so a return only ADDS to the chosen return row.
    returned_pallets = (
        float(request.pallets) if getattr(request, "pallets", None) is not None
        else ((request.quantity / staging_item.quantity_staged) * (staging_item.pallets_staged or 0)
              if staging_item.quantity_staged else 0.0)
    )

    # Create return transfer (auto-completed)
    return_transfer_id = f"transfer-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
    return_transfer = InventoryTransfer(
        id=return_transfer_id,
        receipt_id=staging_item.receipt_id,
        from_location_id=transfer.to_location_id,
        from_sub_location_id=transfer.to_sub_location_id,
        to_location_id=request.to_location_id,
        to_sub_location_id=request.to_sub_location_id,
        quantity=request.quantity,
        unit=unit,
        reason="Returned from staging",
        transfer_type="warehouse-transfer",
        requested_by=str(current_user.id),
        status="completed",
        destination_breakdown=[
            {"id": f"row-{request.to_storage_row_id}", "quantity": float(request.quantity)}
        ],
    )
    db.add(return_transfer)

    # Put it back where the worker says they put it.
    if request.to_storage_row_id:
        if lps.is_counted_lot(db, receipt.material_lot_id):
            # Whole containers back whole, and the remainder as ONE open unit
            # holding the weighed leftover — 600 lbs against 500 lb drums is a
            # full drum on the shelf plus an open drum with 100 lbs in it.
            # Rounding up would invent a sealed drum; the old round-down lost
            # the partial from every rack until a count found it.
            lot = db.query(MaterialLot).filter(
                MaterialLot.id == receipt.material_lot_id
            ).first()
            if lot:
                lps.return_units(
                    db, lot,
                    quantity=float(request.quantity),
                    to_row_id=request.to_storage_row_id,
                    per_unit_weight=staged_unit_weight(staging_item, receipt),
                    ref_type="staging",
                    ref_id=staging_item.id,
                    reason="Returned from staging",
                )
        else:
            # Content + explicit pallets onto the chosen row, tracked
            # independently — no cases/cases_per_pallet.
            add_rm_rows(
                db, receipt,
                {request.to_storage_row_id: float(request.quantity)},
                pallets_by_row={request.to_storage_row_id: returned_pallets},
                update_rows=True,
            )

    # Only re-home the receipt's primary location when this return completes the
    # staged item — a partial return must not claim the whole lot moved.
    is_full_return = (
        staging_item.quantity_returned + request.quantity
        >= staging_item.quantity_staged - staging_item.quantity_used
    )
    if is_full_return:
        receipt.location_id = request.to_location_id
        receipt.sub_location_id = request.to_sub_location_id
        if request.to_storage_row_id:
            receipt.storage_row_id = request.to_storage_row_id

    staging_item.quantity_returned += request.quantity
    staging_item.pallets_returned = (staging_item.pallets_returned or 0) + returned_pallets

    settle_status(staging_item)
    staging_item.returned_at = datetime.now(timezone.utc)

    return staging_item
