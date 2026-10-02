"""Where a lot is NOW and how much of it is held — for screens and reports.

A read-only view over the lot's placements (the one truth for counted lots,
see lot_placement_service) used by the hold screens, the approval cards and
the Holds / Lot Trace reports. It exists because those screens read the
RECEIPT, and a receipt is the wrong place to ask either question:

  * `receipt.held_quantity` is stamped from that one receipt's quantity at
    hold time. A drum received into a held lot, or a second truck of it, never
    reaches it — B-0910 read "5,688 lbs held" while 13 drums (6,162 lb) were
    held (browser test 2026-10-01, B4).
  * `receipt.location_id / sub_location_id` follow whichever transfer was
    approved last — moving 2 drums to quarantine relabelled the whole lot
    "QA Quarantine" while 11 sat in the Drum Room (B5).

Nothing here writes.
"""
from collections import OrderedDict
from typing import Dict, Iterable, List, Optional

from sqlalchemy.orm import Session

from app.enums import ReceiptStatus, TransferStatus
from app.models import (
    Location, LotPlacement, MaterialLot, Receipt, StorageArea, StorageRow, SubLocation,
)
from app.services import lot_placement_service as lps

# Receipts that are stock on the books. A rejected (or sent-back) delivery
# keeps its paperwork quantity for the record but holds nothing.
LIVE_RECEIPT_STATUSES = (ReceiptStatus.APPROVED.value, ReceiptStatus.DEPLETED.value)
OPEN_TRANSFER_STATUSES = (TransferStatus.PENDING.value, TransferStatus.FORKLIFT_SUBMITTED.value)


def _plural(word: str, n: float) -> str:
    word = word or "unit"
    if n == 1:
        return word
    if word.endswith(("s", "x", "ch", "sh", "z")):
        return word + "es"
    return word + "s"


def _row_places(db: Session, row_ids: Iterable[str]) -> Dict[str, dict]:
    """`{row_id: {row_name, room_name, location_name}}` — the room a rack is IN.

    A raw-material rack hangs off a sub-location (the room); a finished-goods
    one off a storage area. Both are walked so a label never falls back to the
    receipt's own, stale, location."""
    row_ids = [r for r in set(row_ids) if r]
    if not row_ids:
        return {}
    rows = db.query(StorageRow).filter(StorageRow.id.in_(row_ids)).all()
    sub_ids = {r.sub_location_id for r in rows if r.sub_location_id}
    area_ids = {r.storage_area_id for r in rows if r.storage_area_id}
    subs = {s.id: s for s in db.query(SubLocation).filter(SubLocation.id.in_(sub_ids)).all()} if sub_ids else {}
    areas = {a.id: a for a in db.query(StorageArea).filter(StorageArea.id.in_(area_ids)).all()} if area_ids else {}
    loc_ids = {s.location_id for s in subs.values() if s.location_id} | {
        a.location_id for a in areas.values() if a.location_id
    }
    locs = {l.id: l for l in db.query(Location).filter(Location.id.in_(loc_ids)).all()} if loc_ids else {}
    out = {}
    for r in rows:
        room = subs.get(r.sub_location_id) if r.sub_location_id else None
        if room is None and r.storage_area_id:
            room = areas.get(r.storage_area_id)
        loc = locs.get(getattr(room, "location_id", None)) if room is not None else None
        out[r.id] = {
            "row_name": r.name,
            "room_name": room.name if room is not None else None,
            "location_name": loc.name if loc is not None else None,
        }
    return out


def room_label_for_rows(db: Session, row_ids: Iterable[str]) -> Optional[str]:
    """"QA Barn › QA Drum Room" for the room(s) these racks are in, or None.

    Several rooms are joined with " + " in first-seen order."""
    places = _row_places(db, row_ids)
    labels: List[str] = []
    for rid in row_ids:
        p = places.get(rid)
        if not p:
            continue
        parts = [x for x in (p["location_name"], p["room_name"]) if x]
        label = " › ".join(parts)
        if label and label not in labels:
            labels.append(label)
    return " + ".join(labels) if labels else None


def location_label(racks: List[dict]) -> Optional[str]:
    """"QA Drum Room: QA-D3, QA-D4" — racks grouped under their room."""
    by_room: "OrderedDict[str, List[str]]" = OrderedDict()
    for r in racks:
        room = r.get("room_name") or r.get("location_name") or ""
        by_room.setdefault(room, [])
        if r.get("row_name") and r["row_name"] not in by_room[room]:
            by_room[room].append(r["row_name"])
    parts = []
    for room, rows in by_room.items():
        if room and rows:
            parts.append(f"{room}: {', '.join(rows)}")
        elif rows:
            parts.append(", ".join(rows))
        elif room:
            parts.append(room)
    return "; ".join(parts) if parts else None


def lot_family(db: Session, receipt: Receipt, *, live_only: bool = True) -> List[Receipt]:
    """Every receipt of the receipt's lot (just the receipt when it has none)."""
    if not receipt.material_lot_id:
        return [receipt]
    q = db.query(Receipt).filter(
        Receipt.material_lot_id == receipt.material_lot_id,
        Receipt.is_deleted == False,  # noqa: E712
    )
    if live_only:
        q = q.filter(Receipt.status.in_(LIVE_RECEIPT_STATUSES))
    family = q.all()
    return family or [receipt]


def lot_status(db: Session, receipt: Optional[Receipt]) -> Optional[dict]:
    """The lot's current racks, totals and hold, lot-wide.

    `quantity` / `units` are what sits on the racks now (placements) for a
    counted lot; for a legacy receipt with no placements they come from the
    live receipts' paper. `held_*` is the lot-wide held amount: the whole lot
    when `MaterialLot.is_held`, else any per-rack held units, else the legacy
    `receipt.held_quantity` of the family.
    """
    if receipt is None:
        return None
    lot = None
    if receipt.material_lot_id:
        lot = db.query(MaterialLot).filter(MaterialLot.id == receipt.material_lot_id).first()

    unit = receipt.unit or (lot.weight_unit if lot is not None else None) or "units"
    unit_label = (
        (lot.unit_label if lot is not None and lot.unit_label and lot.unit_label != "unit" else None)
        or receipt.container_unit
        or (lot.unit_label if lot is not None else None)
        or "unit"
    )
    family = lot_family(db, receipt)

    placements: List[LotPlacement] = (
        lps.placements_for_lot(db, lot.id) if lot is not None else []
    )
    racks: List[dict] = []
    lot_is_held = bool(lot is not None and lot.is_held)

    if placements:
        places = _row_places(db, [p.storage_row_id for p in placements])
        for p in placements:
            units = int(p.full_units or 0) + int(p.open_units or 0)
            weight = float(lps.derived_weight(lot, p))
            per = lps.row_unit_weight(db, lot, p.storage_row_id)
            held_units = units if lot_is_held else min(units, int(p.held_units or 0))
            place = places.get(p.storage_row_id, {})
            racks.append({
                "row_id": p.storage_row_id,
                "row_name": place.get("row_name") or p.storage_row_id,
                "room_name": place.get("room_name"),
                "location_name": place.get("location_name"),
                "units": units,
                "quantity": round(weight, 3),
                "weight_per_unit": round(per, 3) if per else None,
                "held_units": held_units,
                "held_quantity": round(
                    weight if held_units >= units else held_units * (per or 0), 3
                ),
            })
        units_total = sum(r["units"] for r in racks)
        qty_total = sum(r["quantity"] for r in racks)
        held_units = sum(r["held_units"] for r in racks)
        held_qty = sum(r["held_quantity"] for r in racks)
        source = "racks"
    else:
        # Legacy / uncounted: the paper is all there is.
        qty_total = sum(float(r.quantity or 0) for r in family)
        per = float(receipt.weight_per_container or 0) or (
            float(lot.weight_per_unit or 0) if lot is not None else 0.0
        )
        units_total = round(qty_total / per, 2) if per > 0 else None
        legacy_held = sum(
            float(r.held_quantity or 0) for r in family if r.hold and float(r.held_quantity or 0) > 0
        )
        held_qty = qty_total if lot_is_held else legacy_held
        held_units = round(held_qty / per, 2) if per > 0 else None
        loc = receipt.location
        sub = receipt.sub_location
        if loc is not None or sub is not None:
            racks.append({
                "row_id": None,
                "row_name": None,
                "room_name": sub.name if sub is not None else None,
                "location_name": loc.name if loc is not None else None,
                "units": units_total,
                "quantity": round(qty_total, 3),
                "weight_per_unit": per or None,
                "held_units": held_units,
                "held_quantity": round(held_qty, 3),
            })
        source = "receipts"

    is_held = lot_is_held or held_qty > 0 or bool(held_units)

    def _describe(qty, n):
        text = f"{qty:,.0f} {unit}" if abs(qty - round(qty)) < 1e-6 else f"{qty:,.2f} {unit}"
        if n not in (None, 0) and float(n) == int(float(n)):
            n = int(float(n))
            text = f"{n} {_plural(unit_label, n)} · {text}"
        return text

    return {
        "receipt_id": receipt.id,
        "receipt_ids": [r.id for r in family],
        "material_lot_id": lot.id if lot is not None else None,
        "lot_number": receipt.lot_number or (lot.vendor_lot_number if lot is not None else None),
        "product_id": receipt.product_id,
        "unit": unit,
        "unit_label": unit_label,
        "source": source,
        "quantity": round(qty_total, 3),
        "units": units_total,
        "is_held": is_held,
        "lot_is_held": lot_is_held,
        "held_quantity": round(held_qty, 3),
        "held_units": held_units,
        "racks": racks,
        "location_label": location_label(racks),
        "summary": _describe(qty_total, units_total),
        "held_summary": _describe(held_qty, held_units) if is_held else None,
    }


def _whole(ratio: float) -> Optional[int]:
    n = int(round(ratio))
    return n if n > 0 and abs(ratio - n) <= 0.01 else None


def _units_on_rack(db: Session, lot: MaterialLot, receipt: Receipt, row_id: str,
                   quantity: float, delivery_weights: List[float]) -> Optional[int]:
    """How many whole containers `quantity` is when taken off `row_id`.

    Tries, in order: the rack's own average weight per unit (what the forms
    use), the drums that would leave the rack next (oldest delivery first),
    then each delivery's weight. None when no reading is a whole count."""
    try:
        n = lps.row_units_for_quantity(db, lot, row_id, quantity, receipt=receipt, exact=True)
        if n and n > 0:
            return int(n)
    except Exception:  # noqa: BLE001 — a non-whole reading is an answer, not an error
        pass
    smallest = min([w for w in delivery_weights if w > 0] or [0])
    on_rack = (
        db.query(LotPlacement.full_units)
        .filter(LotPlacement.material_lot_id == lot.id, LotPlacement.storage_row_id == row_id)
        .scalar()
    ) or 0
    if smallest > 0 and on_rack > 0:
        upper = min(int(quantity / smallest) + 1, int(on_rack))
        for n in range(1, upper + 1):
            try:
                if abs(lps.fifo_units_weight(db, lot, row_id, n) - quantity) <= 0.01 * max(1.0, smallest):
                    return n
            except Exception:  # noqa: BLE001
                break
    for w in delivery_weights:
        if w > 0:
            n = _whole(quantity / w)
            if n:
                return n
    return None


def transfer_units(db: Session, transfer) -> dict:
    """`{"container_units", "container_unit", "source_units"}` for an RM /
    packaging transfer: the quantity as whole containers, priced per SOURCE
    RACK (a mixed lot weighs differently on each rack). Empty values when the
    transfer is not lot material or a figure is not a whole count."""
    out = {"container_units": None, "container_unit": None, "source_units": []}
    if not getattr(transfer, "receipt_id", None) or (transfer.pallet_licence_ids or []):
        return out
    # Only an open transfer is read in drums (the approval card); a closed
    # one's racks have moved on, and the history lists do not need it.
    if (transfer.status or "") not in OPEN_TRANSFER_STATUSES:
        return out
    receipt = db.query(Receipt).filter(Receipt.id == transfer.receipt_id).first()
    if receipt is None:
        return out
    lot = None
    if receipt.material_lot_id:
        lot = db.query(MaterialLot).filter(MaterialLot.id == receipt.material_lot_id).first()
    label = (
        (lot.unit_label if lot is not None and lot.unit_label and lot.unit_label != "unit" else None)
        or receipt.container_unit
    )
    weights: List[float] = []
    if lot is not None:
        for (w,) in db.query(Receipt.weight_per_container).filter(
            Receipt.material_lot_id == lot.id
        ).distinct().all():
            if w and float(w) > 0 and float(w) not in weights:
                weights.append(float(w))
        if lot.weight_per_unit and float(lot.weight_per_unit) not in weights:
            weights.append(float(lot.weight_per_unit))
    elif receipt.weight_per_container:
        weights.append(float(receipt.weight_per_container))
    if not label or not weights:
        return out
    # A receipt's own weight first, for room-level / unrouted quantities.
    own = float(receipt.weight_per_container or 0)
    ordered = ([own] if own > 0 else []) + [w for w in weights if w != own]

    total = 0
    known = True
    items = [i for i in (transfer.source_breakdown or []) if isinstance(i, dict)]
    for item in items:
        qty = float(item.get("quantity") or 0)
        if qty <= 0:
            continue
        sid = str(item.get("id") or "")
        n = None
        if sid.startswith("row-") and lot is not None:
            n = _units_on_rack(db, lot, receipt, sid[len("row-"):], qty, ordered)
        else:
            for w in ordered:
                n = _whole(qty / w)
                if n:
                    break
        out["source_units"].append({"id": sid, "quantity": qty, "units": n})
        if n is None:
            known = False
        else:
            total += n
    if not items:
        for w in ordered:
            n = _whole(float(transfer.quantity or 0) / w)
            if n:
                total = n
                break
        else:
            known = False
    if known and total > 0:
        out["container_units"] = total
        out["container_unit"] = label
    elif out["source_units"]:
        out["container_unit"] = label
    return out


def held_lots(db: Session, warehouse_id: Optional[str] = None) -> List[dict]:
    """Every raw-material / packaging lot under a QA hold now, one entry per LOT.

    A lot is held when `MaterialLot.is_held`, when any placement carries held
    units, or (legacy, no lot identity) when a live receipt has a QA hold —
    `hold` with `held_quantity > 0`. `receipt.hold` alone is the transient
    review lock a pending transfer sets and is not a hold."""
    seen_lots = set()
    out: List[dict] = []

    lot_ids = {
        lid for (lid,) in db.query(MaterialLot.id).filter(MaterialLot.is_held == True).all()  # noqa: E712
    } | {
        lid for (lid,) in db.query(LotPlacement.material_lot_id)
        .filter(LotPlacement.held_units > 0).distinct().all()
    }
    q = db.query(Receipt).filter(
        Receipt.status.in_(LIVE_RECEIPT_STATUSES + (
            ReceiptStatus.RECORDED.value, ReceiptStatus.REVIEWED.value,
        )),
        Receipt.is_deleted == False,  # noqa: E712
    )
    if warehouse_id:
        q = q.filter(Receipt.warehouse_id == warehouse_id)
    candidates = []
    if lot_ids:
        candidates += q.filter(Receipt.material_lot_id.in_(lot_ids)).all()
    candidates += q.filter(
        Receipt.material_lot_id.is_(None),
        Receipt.hold == True,  # noqa: E712
        Receipt.held_quantity > 0,
    ).all()
    # Newest receipt first so the representative is the lot's carrier.
    candidates.sort(key=lambda r: (r.receipt_date is None, r.receipt_date), reverse=True)
    for r in candidates:
        key = r.material_lot_id or r.id
        if key in seen_lots:
            continue
        seen_lots.add(key)
        status = lot_status(db, r)
        if status and status["is_held"]:
            if r.material_lot_id:
                lot = db.query(MaterialLot).filter(MaterialLot.id == r.material_lot_id).first()
                status["hold_reason"] = lot.hold_reason if lot is not None else None
                status["held_at"] = lot.held_at if lot is not None else None
                status["held_by"] = lot.held_by if lot is not None else None
            out.append(status)
    return out
