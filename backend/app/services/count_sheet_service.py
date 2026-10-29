"""Count sheet by rack row — the web Cycle Counting page's sheet.

The sheet follows the walk: row → product → lot → pallet licences (FG) or
units on the rack (raw material, ingredients, packaging). It is built from live
data and saved as an OPEN sheet (a CycleCount with summary.kind = count_sheet)
so it can be printed, walked on paper and typed back in later. That saved copy
is the "system" side of the count.

Submit applies at once, the same way the gun does:

- FG: each counted row goes through cycle_check_service.submit_row_check, so
  ✗ (not here) → MISSING and an extra licence → moved here / found / created.
  All rows share one count session.
- RM / packaging: a line whose count differs is set with
  lot_placement_service.set_count (the only writer of placements), which logs
  a COUNTED event with the difference.
- A line is skipped with a reason — and the rest still apply — when its rack
  changed since the sheet was made, or the count is below what is held there.
- "Not on a rack" legacy receipts are listed and their count is recorded, but
  nothing is applied to them.

Callers own commit/rollback.
"""
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy.orm import Session

from app.constants import (
    CATEGORY_FINISHED, CATEGORY_INGREDIENT, CATEGORY_PACKAGING, COUNT_SHEET_KIND,
    COUNT_SHEET_STATUS_OPEN, COUNT_SHEET_STATUS_SUBMITTED, COUNT_SHEET_TYPE_FG,
    COUNT_SHEET_TYPE_PACKAGING, COUNT_SHEET_TYPE_RM, COUNT_SHEET_TYPES, CYCLE_CHECK_SOURCE_SHEET,
    pluralize_unit,
)
from app.enums import PalletStatus, ReceiptStatus
from app.exceptions import NotFoundError, ValidationError
from app.models import (
    Category, CategoryGroup, CycleCount, LotPlacement, MaterialLot, PalletLicence, Product,
    Receipt, StorageArea, SubLocation,
)
from app.services import cycle_check_service as ccs
from app.services import lot_placement_service as lps
from app.utils.calendar_dates import calendar_day
from app.utils.category_rules import RAW_MATERIAL_TYPES
from app.utils.warehouse_time import warehouse_timezone, zone

SKIP_CHANGED = "changed since printed — recount"


def _category_types(kind: str) -> set:
    if kind == COUNT_SHEET_TYPE_FG:
        return {CATEGORY_FINISHED}
    if kind == COUNT_SHEET_TYPE_RM:
        return set(RAW_MATERIAL_TYPES) | {CATEGORY_INGREDIENT}
    return {CATEGORY_PACKAGING}


def _product_ids(db: Session, kind: str, client_id: Optional[str]) -> set:
    """Products of the sheet's type, optionally of one client (category group)."""
    q = db.query(Product.id).join(Category, Category.id == Product.category_id).filter(
        Category.type.in_(_category_types(kind))
    )
    if client_id:
        q = q.filter(Category.parent_id == client_id)
    return {pid for (pid,) in q.all()}


def _scope_label(db: Session, kind: str, client_id, sub_location_id, storage_area_id) -> str:
    parts = [{COUNT_SHEET_TYPE_FG: "Finished goods", COUNT_SHEET_TYPE_RM: "Raw + ingredients",
              COUNT_SHEET_TYPE_PACKAGING: "Packaging"}[kind]]
    if client_id:
        g = db.query(CategoryGroup).filter(CategoryGroup.id == client_id).first()
        parts.append(g.name if g else client_id)
    if storage_area_id:
        a = db.query(StorageArea).filter(StorageArea.id == storage_area_id).first()
        parts.append(a.name if a else storage_area_id)
    elif sub_location_id:
        s = db.query(SubLocation).filter(SubLocation.id == sub_location_id).first()
        parts.append(s.name if s else sub_location_id)
    return " · ".join(parts)


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

def build_sheet(
    db: Session, warehouse_id: Optional[str], kind: str, client_id: Optional[str] = None,
    sub_location_id: Optional[str] = None, storage_area_id: Optional[str] = None,
) -> dict:
    """The sheet from live data: rows in walk order (area, then row name), each
    with its lines. Nothing is saved."""
    if kind not in COUNT_SHEET_TYPES:
        raise ValidationError("Pick finished goods, raw + ingredients or packaging")
    # Rows that hold stock may since have been switched off; still count them.
    rows = ccs.row_index(db, warehouse_id, active_only=False)
    if storage_area_id:
        rows = {k: r for k, r in rows.items() if r["storage_area_id"] == storage_area_id}
    elif sub_location_id:
        rows = {k: r for k, r in rows.items() if r["sub_location_id"] == sub_location_id}
    pids = _product_ids(db, kind, client_id)
    lines_by_row: dict = {}
    if rows and pids:
        if kind == COUNT_SHEET_TYPE_FG:
            pallets = (
                db.query(PalletLicence)
                .filter(
                    PalletLicence.storage_row_id.in_(list(rows)),
                    PalletLicence.product_id.in_(pids),
                    PalletLicence.status == PalletStatus.IN_STOCK.value,
                    PalletLicence.is_deleted == False,  # noqa: E712
                )
                .order_by(PalletLicence.lot_number, PalletLicence.sequence)
                .all()
            )
            per_row: dict = {}
            for p in pallets:
                per_row.setdefault(p.storage_row_id, []).append(p)
            for row_id, pls in per_row.items():
                lines_by_row[row_id] = ccs.group_pallets(db, pls)
        else:
            q = (
                db.query(LotPlacement, MaterialLot)
                .join(MaterialLot, MaterialLot.id == LotPlacement.material_lot_id)
                .filter(
                    LotPlacement.storage_row_id.in_(list(rows)),
                    LotPlacement.product_id.in_(pids),
                    (LotPlacement.full_units + LotPlacement.open_units) > 0,
                    MaterialLot.is_deleted == False,  # noqa: E712
                )
            )
            if warehouse_id:
                q = q.filter(LotPlacement.warehouse_id == warehouse_id)
            found = q.all()
            names = {p.id: p.name for p in db.query(Product).filter(
                Product.id.in_({pl.product_id for pl, _ in found})).all()} if found else {}
            for pl, lot in found:
                lines_by_row.setdefault(pl.storage_row_id, []).append({
                    "placement_id": pl.id,
                    "lot_id": lot.id,
                    "product_id": pl.product_id,
                    "product_name": names.get(pl.product_id, pl.product_id),
                    "lot_code": lot.lot_code,
                    "vendor_lot_number": lot.vendor_lot_number,
                    # A calendar day, not a moment (utils/calendar_dates.py).
                    "bbd": calendar_day(lot.bbd_current),
                    "unit_label": lot.unit_label or "unit",
                    "weight_unit": lot.weight_unit,
                    "full_units": int(pl.full_units or 0),
                    "open_units": int(pl.open_units or 0),
                    "open_remaining_qty": float(pl.open_remaining_qty or 0),
                    "held_units": int(pl.held_units or 0),
                    "lot_is_held": bool(lot.is_held),
                })
            for lines in lines_by_row.values():
                lines.sort(key=lambda x: (x["product_name"] or "", x["vendor_lot_number"] or x["lot_code"] or ""))

    out_rows = [
        {
            "row_id": rid, "row_name": rows[rid]["name"], "area_name": rows[rid]["area_name"],
            "lines": lines,
        }
        for rid, lines in lines_by_row.items() if lines
    ]
    out_rows.sort(key=lambda r: (r["area_name"], r["row_name"]))
    legacy = (
        _legacy_receipts(db, warehouse_id, pids)
        if kind != COUNT_SHEET_TYPE_FG and not (sub_location_id or storage_area_id) else []
    )
    return {
        "kind": kind,
        "scope": _scope_label(db, kind, client_id, sub_location_id, storage_area_id),
        "rows": out_rows,
        "legacy": legacy,
    }


def _legacy_receipts(db: Session, warehouse_id: Optional[str], pids: set) -> list:
    """Approved / held receipts of the sheet's type that are on no rack: no lot,
    so no placement. Listed so the counter can write a figure; nothing is
    applied to them."""
    if not pids:
        return []
    q = db.query(Receipt).filter(
        Receipt.product_id.in_(pids),
        Receipt.material_lot_id.is_(None),
        (Receipt.status == ReceiptStatus.APPROVED.value) | (Receipt.hold == True),  # noqa: E712
    )
    if warehouse_id:
        q = q.filter(Receipt.warehouse_id == warehouse_id)
    recs = q.all()
    names = {p.id: p.name for p in db.query(Product).filter(
        Product.id.in_({r.product_id for r in recs})).all()} if recs else {}
    out = [{
        "receipt_id": r.id,
        "product_id": r.product_id,
        "product_name": names.get(r.product_id, r.product_id),
        "lot_number": r.lot_number,
        "quantity": float(r.quantity or 0),
        "unit": r.unit,
        "container_count": r.container_count,
        "container_unit": r.container_unit,
        "is_held": bool(r.hold),
    } for r in recs]
    out.sort(key=lambda x: (x["product_name"] or "", x["lot_number"] or ""))
    return out


# ---------------------------------------------------------------------------
# Open sheets
# ---------------------------------------------------------------------------

def _is_sheet(c) -> bool:
    return isinstance(c.summary, dict) and c.summary.get("kind") == COUNT_SHEET_KIND


def _sheet_out(c: CycleCount) -> dict:
    return {
        "id": c.id, "count_date": c.count_date, "created_at": c.created_at,
        "performed_by": c.performed_by, "performed_by_id": c.performed_by_id,
        "warehouse_id": c.warehouse_id, "summary": c.summary, "items": c.items,
    }


def create_open_sheet(
    db: Session, *, user, warehouse_id: Optional[str], kind: str, client_id: Optional[str] = None,
    sub_location_id: Optional[str] = None, storage_area_id: Optional[str] = None,
) -> dict:
    sheet = build_sheet(db, warehouse_id, kind, client_id, sub_location_id, storage_area_id)
    hexid = uuid.uuid4().hex[:12]
    sheet_no = f"CC-{hexid[:6].upper()}"
    tz = zone(warehouse_timezone(db, warehouse_id))
    summary = {
        "kind": COUNT_SHEET_KIND,
        "status": COUNT_SHEET_STATUS_OPEN,
        "sheet_no": sheet_no,
        "sheet_type": kind,
        "scope": sheet["scope"],
        "client_id": client_id,
        "sub_location_id": sub_location_id,
        "storage_area_id": storage_area_id,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "generated_by": user.name or user.username,
        "rows_total": len(sheet["rows"]),
        "lines_total": sum(len(r["lines"]) for r in sheet["rows"]),
        # The system side of the count, as it was when the sheet was made.
        "sheet": {"rows": sheet["rows"], "legacy": sheet["legacy"]},
    }
    cc = CycleCount(
        id=f"sheet-{hexid}",
        count_date=datetime.now(tz).date(),
        # Empty until submit, so history / reports reading items never show an
        # open sheet's snapshot as counted lines.
        items=[],
        summary=summary,
        performed_by=user.name or user.username,
        performed_by_id=str(user.id),
        warehouse_id=warehouse_id,
    )
    db.add(cc)
    db.flush()
    return _sheet_out(cc)


def _get_sheet(db: Session, sheet_id: str, warehouse_id: Optional[str], lock: bool = False) -> CycleCount:
    """The sheet, if it is in the caller's warehouse. Another warehouse's sheet
    reads as not found."""
    q = db.query(CycleCount).filter(CycleCount.id == sheet_id)
    if lock:
        q = q.with_for_update()
    c = q.first()
    if c is None or not _is_sheet(c) or (warehouse_id and c.warehouse_id != warehouse_id):
        raise NotFoundError("Count sheet")
    return c


def get_sheet(db: Session, sheet_id: str, warehouse_id: Optional[str]) -> dict:
    return _sheet_out(_get_sheet(db, sheet_id, warehouse_id))


def list_sheets(db: Session, warehouse_id: Optional[str], status: Optional[str] = None) -> list:
    """Sheets newest first, without the snapshot (the list only needs the header)."""
    q = db.query(CycleCount)
    if warehouse_id:
        q = q.filter(CycleCount.warehouse_id == warehouse_id)
    out = []
    for c in q.order_by(CycleCount.created_at.desc()).all():
        if not _is_sheet(c) or (status and c.summary.get("status") != status):
            continue
        d = _sheet_out(c)
        d["summary"] = {k: v for k, v in c.summary.items() if k != "sheet"}
        d["items"] = []
        out.append(d)
    return out


# ---------------------------------------------------------------------------
# Submit
# ---------------------------------------------------------------------------

def _fg_row(db, sheet_row: dict, entry: dict, *, user, warehouse_id, sheet_no, session_id):
    """One counted FG row through the gun's row check. Returns (result, skipped)."""
    on_sheet = {p["id"]: (g, p) for g in sheet_row["lines"] for p in g["pallets"]}
    not_here = [i for i in dict.fromkeys(entry.get("not_here_pallet_ids") or []) if i in on_sheet]
    # A pallet ticked ✗ that has since left the row: the gun logic ignores it,
    # so say so instead of letting it vanish silently.
    still_here = {
        p.id for p in db.query(PalletLicence).filter(
            PalletLicence.id.in_(not_here),
            PalletLicence.storage_row_id == sheet_row["row_id"],
            PalletLicence.status == PalletStatus.IN_STOCK.value,
        ).all()
    } if not_here else set()
    skipped = [{
        "row_name": sheet_row["row_name"], "product_name": on_sheet[i][0]["product_name"],
        "lot": on_sheet[i][0]["lot_number"], "licence_number": on_sheet[i][1]["licence_number"],
        "reason": SKIP_CHANGED,
    } for i in not_here if i not in still_here]
    out = ccs.submit_row_check(
        db, row_id=sheet_row["row_id"], scanned=entry.get("extra_licences") or [],
        not_here_pallet_ids=[i for i in not_here if i in still_here], confirmed=True,
        user=user, warehouse_id=warehouse_id, session_id=session_id,
        source=CYCLE_CHECK_SOURCE_SHEET, sheet_no=sheet_no,
    )
    return out, skipped


def _rm_line(db, sheet_row: dict, line: dict, counted: int, *, user, sheet_id, sheet_no):
    """One RM / packaging line. Returns (history item, skip reason or None)."""
    item = {
        "productId": line["product_id"],
        "productName": line["product_name"],
        "lotNo": line.get("vendor_lot_number") or line.get("lot_code") or "—",
        "location": sheet_row["row_name"],
        "storageRowId": sheet_row["row_id"],
        "expectedQuantity": line["full_units"],
        "actualQuantity": counted,
        "unit": pluralize_unit(line.get("unit_label") or "unit"),
        "variance": counted - line["full_units"],
        "notHere": [],
        "arrived": [],
    }
    pl = (
        db.query(LotPlacement)
        .filter(LotPlacement.id == line["placement_id"])
        .with_for_update()
        .first()
    )
    lot = db.query(MaterialLot).filter(MaterialLot.id == pl.material_lot_id).first() if pl else None
    if (
        pl is None or lot is None or lot.is_deleted
        or pl.storage_row_id != sheet_row["row_id"]
        or int(pl.full_units or 0) != line["full_units"]
        or int(pl.open_units or 0) != line["open_units"]
        or abs(float(pl.open_remaining_qty or 0) - line["open_remaining_qty"]) > 0.001
    ):
        return {**item, "status": "skipped", "skipReason": SKIP_CHANGED}, SKIP_CHANGED
    held = int(pl.held_units or 0)
    if counted < held:
        reason = f"{held} held here — release first"
        return {**item, "status": "skipped", "skipReason": reason}, reason
    if counted != int(pl.full_units or 0):
        # Open units and what is left in them are not on the sheet; keep them.
        lps.set_count(
            db, lot, pl.storage_row_id,
            full_units=counted,
            open_units=int(pl.open_units or 0),
            open_remaining_qty=float(pl.open_remaining_qty or 0),
            actor_id=str(user.id),
            reason=f"Count sheet {sheet_no}",
            ref_type="cycle_count",
            ref_id=sheet_id,
        )
    v = item["variance"]
    return {**item, "status": "ok" if v == 0 else ("shortage" if v < 0 else "overage")}, None


def submit_sheet(db: Session, sheet_id: str, payload: dict, user, warehouse_id: Optional[str]) -> dict:
    """Apply a filled-in sheet. payload:
        rows:   [{row_id, counted, not_here_pallet_ids?, extra_licences?,
                  lines?: [{placement_id, counted_units}]}]
        legacy: [{receipt_id, counted}]
    Rows not marked counted are skipped (a partial walk is fine)."""
    cc = _get_sheet(db, sheet_id, warehouse_id, lock=True)
    summary = dict(cc.summary)
    if summary.get("status") != COUNT_SHEET_STATUS_OPEN:
        raise ValidationError(f"Sheet {summary.get('sheet_no')} was already submitted")
    sheet_no = summary.get("sheet_no")
    kind = summary.get("sheet_type")
    snapshot = summary.get("sheet") or {}
    sheet_rows = {r["row_id"]: r for r in snapshot.get("rows") or []}
    entries = [e for e in (payload.get("rows") or []) if e.get("counted") and e.get("row_id") in sheet_rows]

    items: List[dict] = []
    skipped: List[dict] = []
    applied = 0
    session_id = None
    # Walk order, whatever order the client sent.
    order = {rid: i for i, rid in enumerate(sheet_rows)}
    for entry in sorted(entries, key=lambda e: order[e["row_id"]]):
        srow = sheet_rows[entry["row_id"]]
        if kind == COUNT_SHEET_TYPE_FG:
            out, sk = _fg_row(db, srow, entry, user=user, warehouse_id=warehouse_id,
                              sheet_no=sheet_no, session_id=session_id)
            session_id = out["session_id"]
            items.extend(out["items"])
            skipped.extend(sk)
            s = out["summary"]
            applied += (s.get("not_here") or 0) + (s.get("moved_in") or 0) + (s.get("found") or 0) + (s.get("created") or 0)
            continue
        counts = {
            ln.get("placement_id"): ln.get("counted_units")
            for ln in (entry.get("lines") or []) if ln.get("counted_units") is not None
        }
        for line in srow["lines"]:
            if line["placement_id"] not in counts:
                continue
            try:
                counted = int(counts[line["placement_id"]])
            except (TypeError, ValueError):
                raise ValidationError(f"Count for {line['product_name']} on {srow['row_name']} is not a number")
            if counted < 0:
                raise ValidationError("A count cannot be negative")
            item, reason = _rm_line(db, srow, line, counted, user=user, sheet_id=cc.id, sheet_no=sheet_no)
            items.append(item)
            if reason:
                skipped.append({
                    "row_name": srow["row_name"], "product_name": line["product_name"],
                    "lot": item["lotNo"], "reason": reason,
                })
            elif item["variance"]:
                applied += 1

    # Legacy receipts: the figure is recorded, nothing is applied.
    legacy_by_id = {r["receipt_id"]: r for r in snapshot.get("legacy") or []}
    for e in payload.get("legacy") or []:
        r = legacy_by_id.get(e.get("receipt_id"))
        if r is None or e.get("counted") is None:
            continue
        try:
            counted = float(e["counted"])
        except (TypeError, ValueError):
            raise ValidationError(f"Count for {r['product_name']} is not a number")
        items.append({
            "productId": r["product_id"], "productName": r["product_name"],
            "lotNo": r.get("lot_number") or "—", "location": "Not on a rack", "storageRowId": None,
            "expectedQuantity": r["quantity"], "actualQuantity": counted, "unit": r.get("unit"),
            "variance": counted - r["quantity"], "status": "recorded", "notHere": [], "arrived": [],
        })

    tz = zone(warehouse_timezone(db, warehouse_id or cc.warehouse_id))
    summary.update({
        "status": COUNT_SHEET_STATUS_SUBMITTED,
        "submitted_at": datetime.now(timezone.utc).isoformat(),
        "submitted_by": user.name or user.username,
        "session_id": session_id,
        "rows_counted": len(entries),
        "applied": applied,
        "skipped": skipped,
        "totalItems": len(items),
        "variancesCount": sum(1 for i in items if i["status"] in ("shortage", "overage")),
        "shortages": sum(1 for i in items if i["status"] == "shortage"),
        "overages": sum(1 for i in items if i["status"] == "overage"),
    })
    # JSON columns: assign new objects so SQLAlchemy sees the change.
    cc.summary = summary
    cc.items = items
    cc.count_date = datetime.now(tz).date()
    cc.performed_by = user.name or user.username
    cc.performed_by_id = str(user.id)
    db.flush()
    return {
        "status": COUNT_SHEET_STATUS_SUBMITTED, "sheet_id": cc.id, "sheet_no": sheet_no,
        "session_id": session_id, "rows_counted": len(entries), "applied": applied,
        "skipped": skipped, "items": items,
    }
