"""Gun cycle check + Find Pallet (FG-PALLET-LIFECYCLE-SPEC §4.1).

Any row, any time. The checker scans a row, sees what the system says is in it
grouped by product + lot, scans the FRONT pallet of each group that is there
and taps "Not here" on what isn't. Submit:

- "not here" pallets become MISSING immediately (no approval) — row freed,
  receipt deducted, a PalletEvent per pallet. MISSING is not a write-off: any
  later scan anywhere finds the pallet again.
- a scanned pallet the system had elsewhere is moved to this row;
  a MISSING / NOT_PRODUCED / cancelled one is put back in stock here;
  a sticker that never existed is created in stock here.
- one CycleCount record per submit, so the check shows on the Cycle Count
  page and report with row, who, when, expected vs seen and the pallet numbers.

Find Pallet is the same toolkit for one licence: show its status and history,
and offer the action that fits it.

Callers own commit/rollback.
"""
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Iterable, List, Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.constants import (
    CYCLE_CHECK_CONFIRM_OVER, CYCLE_CHECK_SESSION_IDLE_MINUTES, DEFAULT_CASES_PER_PALLET,
)
from app.enums import ForkliftRequestStatus, PalletEventType, PalletStatus, ReceiptStatus
from app.exceptions import NotFoundError, ValidationError
from app.models import (
    CycleCount, ForkliftRequest, Location, PalletEvent, PalletLicence, Product, Receipt,
    StorageArea, StorageRow, SubLocation,
)
from app.services import pallet_lifecycle_service as plc
from app.services.ship_out_service import _add_to_row, _release_row_capacity
from app.services.transfer_service import _rebuild_receipt_allocation_from_licences
from app.utils.warehouse_time import warehouse_timezone, zone

KIND_GUN_ROW_CHECK = "gun_row_check"
# Server-minted count-session ids. Anything else the client sends is ignored
# and a fresh session is started.
SESSION_ID_RE = re.compile(r"^cs-[0-9a-f]{12}$")
_SESSION_IDLE = timedelta(minutes=CYCLE_CHECK_SESSION_IDLE_MINUTES)


def _row_location_id(db: Session, row: StorageRow) -> Optional[str]:
    if row.storage_area_id:
        a = db.query(StorageArea).filter(StorageArea.id == row.storage_area_id).first()
        if a and a.location_id:
            return a.location_id
    if row.sub_location_id:
        s = db.query(SubLocation).filter(SubLocation.id == row.sub_location_id).first()
        if s:
            return s.location_id
    return None


def _row_warehouse_id(db: Session, row: StorageRow) -> Optional[str]:
    loc_id = _row_location_id(db, row)
    if not loc_id:
        return None
    loc = db.query(Location).filter(Location.id == loc_id).first()
    return loc.warehouse_id if loc else None


def _other_warehouse(pl: Optional[PalletLicence], warehouse_id: Optional[str]) -> bool:
    """A pallet that belongs to a different warehouse than the checker's.
    Legacy pallets with no warehouse are not refused (nothing to compare)."""
    return bool(pl is not None and warehouse_id and pl.warehouse_id and pl.warehouse_id != warehouse_id)


def list_rows(db: Session, warehouse_id: Optional[str]) -> list:
    """Every active row in the warehouse — including floor and dock rows,
    which the receipt picker hides (it only lists rows with a capacity)."""
    locs = {
        l.id: l.warehouse_id for l in db.query(Location).all()
    }
    areas = {a.id: (a.name, a.location_id) for a in db.query(StorageArea).all()}
    subs = {s.id: (s.name, s.location_id) for s in db.query(SubLocation).all()}
    out = []
    for r in db.query(StorageRow).filter(StorageRow.is_active == True).all():  # noqa: E712
        parent_name, loc_id = (None, None)
        if r.storage_area_id in areas:
            parent_name, loc_id = areas[r.storage_area_id]
        elif r.sub_location_id in subs:
            parent_name, loc_id = subs[r.sub_location_id]
        if warehouse_id and locs.get(loc_id) != warehouse_id:
            continue
        out.append({"id": r.id, "name": r.name, "area_name": parent_name or "", "barcode": r.barcode})
    out.sort(key=lambda x: (x["area_name"], x["name"]))
    return out


def _get_row(db: Session, row_id: str, warehouse_id: Optional[str] = None) -> StorageRow:
    """The row, if it is in the checker's warehouse. A row of another warehouse
    reads as not found: a Paw Paw gun could read, mark missing and move stock
    in another plant's racks by row id (security review 2026-10-08)."""
    row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
    if row is None:
        raise NotFoundError("Storage row")
    if warehouse_id:
        row_wh = _row_warehouse_id(db, row)
        if row_wh and row_wh != warehouse_id:
            raise NotFoundError("Storage row")
    return row


def row_contents(db: Session, row_id: str, warehouse_id: Optional[str] = None) -> dict:
    """What the system says is in a row, grouped by product + lot."""
    row = _get_row(db, row_id, warehouse_id)
    pallets = (
        db.query(PalletLicence)
        .filter(
            PalletLicence.storage_row_id == row.id,
            PalletLicence.status == PalletStatus.IN_STOCK.value,
            PalletLicence.is_deleted == False,  # noqa: E712
        )
        .order_by(PalletLicence.lot_number, PalletLicence.sequence)
        .all()
    )
    pids = {p.product_id for p in pallets}
    products = {p.id: p for p in db.query(Product).filter(Product.id.in_(pids)).all()} if pids else {}
    groups: dict = {}
    for p in pallets:
        key = (p.product_id, p.lot_number or "")
        prod = products.get(p.product_id)
        g = groups.setdefault(key, {
            "key": f"{p.product_id}|{p.lot_number or ''}",
            "product_id": p.product_id,
            "product_name": prod.name if prod else p.product_id,
            "short_code": prod.short_code if prod else None,
            "lot_number": p.lot_number,
            "count": 0, "cases": 0, "pallets": [],
        })
        g["count"] += 1
        g["cases"] += int(p.cases or 0)
        g["pallets"].append({
            "id": p.id, "licence_number": p.licence_number, "sequence": p.sequence,
            "cases": p.cases, "is_held": bool(p.is_held),
        })
    return {
        "row": {"id": row.id, "name": row.name},
        "groups": sorted(groups.values(), key=lambda g: (g["product_name"] or "", g["lot_number"] or "")),
        "total_pallets": len(pallets),
    }


# ---------------------------------------------------------------------------
# Single-pallet actions (shared by submit and Find Pallet)
# ---------------------------------------------------------------------------

def _move_here(db: Session, pl: PalletLicence, row: StorageRow, user) -> None:
    from_row = pl.storage_row_id
    from_row_obj = db.query(StorageRow).filter(StorageRow.id == from_row).first() if from_row else None
    from_label = (from_row_obj.name if from_row_obj else from_row) if from_row else None
    _release_row_capacity(db, pl, float(pl.cases or 0))
    pl.storage_row_id = row.id
    pl.storage_area_id = row.storage_area_id
    _add_to_row(row, pl, float(pl.cases or 0))
    plc.record_event(
        db, pl, PalletEventType.MOVED, user=user,
        from_status=pl.status, to_status=pl.status, storage_row_id=row.id,
        reason=f"Cycle check found it in {row.name}" + (f" (system had it in {from_label})" if from_label else ""),
        ref_type="storage_row", ref_id=from_row,
    )
    if pl.receipt_id:
        r = db.query(Receipt).filter(Receipt.id == pl.receipt_id).first()
        if r is not None:
            _rebuild_receipt_allocation_from_licences(db, r)


def _create_from_sticker(db: Session, licence: str, row: StorageRow, user, warehouse_id) -> PalletLicence:
    from app.services.scanner_service import (
        find_product_by_code, normalize_scanned_licence, parse_licence_number,
    )
    licence = normalize_scanned_licence(licence, "")
    lot, code, seq = parse_licence_number(licence)
    if not lot or seq is None:
        raise ValidationError(f"{licence} is not a pallet sticker")
    product = find_product_by_code(db, code)
    if product is None:
        raise ValidationError(f"Unknown product code in {licence}")
    if not plc.is_finished_good(db, product.id):
        raise ValidationError(f"{licence} is not a finished-goods pallet")
    cases = product.default_cases_per_pallet or DEFAULT_CASES_PER_PALLET
    # A superadmin without a selected warehouse has none of their own: the
    # pallet belongs where it physically is. A NULL warehouse hides it from
    # every ship-out picker.
    warehouse_id = warehouse_id or _row_warehouse_id(db, row)
    pl = PalletLicence(
        id=f"pl-{uuid.uuid4().hex[:12]}", licence_number=licence,
        product_id=product.id, lot_number=lot, sequence=seq, cases=cases, is_partial=False,
        status=PalletStatus.NOT_PRODUCED.value,  # flipped by restore_to_stock below
        warehouse_id=warehouse_id, scanned_by=str(user.id), scanned_at=datetime.now(timezone.utc),
        storage_row_id=row.id, storage_area_id=row.storage_area_id,
    )
    db.add(pl)
    db.flush()
    # restore_to_stock does the receipt + row bookkeeping for a pallet that
    # was never counted; its event is re-labelled for what really happened.
    ev = plc.restore_to_stock(db, pl, row=row, user=user, reason="Created from its sticker by a cycle check")
    ev.event_type = PalletEventType.CREATED_FROM_STICKER.value
    ev.from_status = None
    return pl


def _apply_scan(db: Session, licence: str, row: StorageRow, user, warehouse_id) -> dict:
    """One scanned sticker in a row → what happened to it."""
    from app.services.scanner_service import normalize_scanned_licence
    licence = normalize_scanned_licence((licence or "").strip(), "")
    pl = db.query(PalletLicence).filter(PalletLicence.licence_number == licence).with_for_update().first()
    if pl is None:
        _create_from_sticker(db, licence, row, user, warehouse_id)
        return {"licence_number": licence, "result": "created", "message": f"{licence} was never in the system — created in {row.name}"}
    if _other_warehouse(pl, warehouse_id):
        return {"licence_number": licence, "result": "other_warehouse",
                "message": f"{licence} belongs to another warehouse — not changed"}
    if pl.status == PalletStatus.IN_STOCK.value:
        if pl.storage_row_id == row.id:
            return {"licence_number": licence, "result": "seen", "pallet_id": pl.id}
        _move_here(db, pl, row, user)
        return {"licence_number": licence, "result": "moved", "pallet_id": pl.id, "message": f"{licence} moved to {row.name}"}
    if pl.status == PalletStatus.EMPTIED.value:
        return {"licence_number": licence, "result": "emptied", "pallet_id": pl.id,
                "message": plc.emptied_detail(db, pl)}
    if pl.status in plc.FOUNDABLE_STATUSES:
        prev = pl.status
        plc.restore_to_stock(db, pl, row=row, user=user, reason=f"Cycle check of {row.name}",
                             ref_type="storage_row", ref_id=row.id)
        return {"licence_number": licence, "result": "found", "previous_status": prev,
                "pallet_id": pl.id, "message": plc.found_message(db, pl, prev)}
    if pl.status == PalletStatus.SHIPPED.value:
        return {"licence_number": licence, "result": "shipped", "message": plc.shipped_detail(db, pl)}
    if pl.status in (PalletStatus.PENDING.value, PalletStatus.MISSING_STICKER.value):
        return {"licence_number": licence, "result": "pending",
                "forklift_request_id": pl.forklift_request_id,
                "message": f"{licence} is waiting in a forklift request — not changed"}
    return {"licence_number": licence, "result": "unchanged", "message": f"{licence} is {pl.status} — not changed"}


def _mark_missing(db: Session, pl: PalletLicence, row: StorageRow, user, ref_id: str) -> None:
    _release_row_capacity(db, pl, float(pl.cases or 0))
    prev = pl.status
    pl.status = PalletStatus.MISSING.value
    plc.record_event(
        db, pl, PalletEventType.MISSING, user=user, from_status=prev,
        to_status=PalletStatus.MISSING.value, storage_row_id=row.id,
        reason=f"Not here — cycle check of {row.name}", cases_before=pl.cases,
        ref_type="cycle_count", ref_id=ref_id,
    )
    if pl.receipt_id:
        r = db.query(Receipt).filter(Receipt.id == pl.receipt_id).with_for_update().first()
        if r is not None:
            r.quantity = max(0.0, float(r.quantity or 0) - float(pl.cases or 0))
            _rebuild_receipt_allocation_from_licences(db, r)
            if r.quantity <= 0:
                r.status = ReceiptStatus.DEPLETED.value


# ---------------------------------------------------------------------------
# Count sessions — one walk of rows (Next row … Finish)
# ---------------------------------------------------------------------------

def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _is_gun(c) -> bool:
    return isinstance(c.summary, dict) and c.summary.get("kind") == KIND_GUN_ROW_CHECK


def _resolve_session(db: Session, user, session_id: Optional[str]) -> tuple:
    """(session_id, session_started_at ISO) for a row about to be saved.

    The id is minted here on the walk's first row and the gun sends it back
    with every later row. A sent id is only continued when THIS user saved a
    row under it within the idle window — an unknown, foreign, malformed or
    stale id silently starts a new session, so nobody can append rows to
    someone else's count."""
    now = datetime.now(timezone.utc)
    if session_id and SESSION_ID_RE.match(session_id):
        recent = (
            db.query(CycleCount)
            .filter(
                CycleCount.performed_by_id == str(user.id),
                CycleCount.created_at >= now - timedelta(hours=24),
            )
            .all()
        )
        mine = [c for c in recent if _is_gun(c) and c.summary.get("session_id") == session_id]
        if mine:
            last = max(_aware(c.created_at) or now for c in mine)
            if now - last <= _SESSION_IDLE:
                started = min(
                    (c.summary.get("session_started_at") for c in mine if c.summary.get("session_started_at")),
                    default=None,
                ) or min(_aware(c.created_at) or now for c in mine).isoformat()
                return session_id, started
    return f"cs-{uuid.uuid4().hex[:12]}", now.isoformat()


def row_has_difference(summary: dict) -> bool:
    """A row check found something to fix: a count off, or any pallet marked
    not here, moved in, found again or created."""
    return bool(
        (summary.get("variancesCount") or 0)
        or (summary.get("not_here") or 0)
        or (summary.get("moved_in") or 0)
        or (summary.get("found") or 0)
        or (summary.get("created") or 0)
    )


def group_sessions(counts: Iterable) -> List[list]:
    """Gun row checks grouped into count sessions, newest session first.

    Checks saved with a session id group by (who, session id). Older checks
    without one (everything before sessions existed) group by the same person
    on the same day with no gap longer than the idle window between
    consecutive checks. Non-gun counts are ignored."""
    epoch = datetime.min.replace(tzinfo=timezone.utc)
    gun = sorted(
        (c for c in counts if _is_gun(c)),
        key=lambda c: (str(c.performed_by_id), _aware(c.created_at) or epoch, c.id),
    )
    groups: dict = {}
    chain: dict = {}   # who -> (key, last created_at, count_date) of the open untagged run
    for c in gun:
        who = str(c.performed_by_id)
        sid = c.summary.get("session_id")
        if sid:
            key = (who, sid)
        else:
            dt = _aware(c.created_at)
            cur = chain.get(who)
            if cur and cur[2] == c.count_date and dt and cur[1] and dt - cur[1] <= _SESSION_IDLE:
                key = cur[0]
            else:
                key = (who, f"auto-{c.id}")
            chain[who] = (key, dt, c.count_date)
        groups.setdefault(key, []).append(c)
    out = list(groups.values())
    out.sort(key=lambda g: max(_aware(c.created_at) or epoch for c in g), reverse=True)
    return out


def session_rollup(records: list) -> dict:
    """Totals + per-row detail of one count session (records = one group
    from group_sessions, any order)."""
    epoch = datetime.min.replace(tzinfo=timezone.utc)
    recs = sorted(records, key=lambda c: (_aware(c.created_at) or epoch, c.id))
    first = recs[0]
    sid = first.summary.get("session_id")
    rows = []
    for c in recs:
        sm = c.summary
        rows.append({
            "cycle_count_id": c.id,
            "row_id": sm.get("row_id"),
            "row_name": sm.get("row_name"),
            "checked_at": _aware(c.created_at),
            "ok": not row_has_difference(sm),
            "expected_pallets": sm.get("expected_pallets") or 0,
            "not_here": sm.get("not_here") or 0,
            "found": sm.get("found") or 0,
            "moved_in": sm.get("moved_in") or 0,
            "created": sm.get("created") or 0,
            "items": c.items if isinstance(c.items, list) else [],
        })
    return {
        "session_key": f"{first.performed_by_id}|{sid or 'auto-' + first.id}",
        "session_id": sid,
        "inferred": not sid,
        "performed_by": first.performed_by,
        "performed_by_id": first.performed_by_id,
        "count_date": first.count_date,
        "started_at": _aware(first.created_at),
        "ended_at": _aware(recs[-1].created_at),
        "rows_checked": len(rows),
        "rows_ok": sum(1 for r in rows if r["ok"]),
        "rows_with_differences": sum(1 for r in rows if not r["ok"]),
        "not_here": sum(r["not_here"] for r in rows),
        "found": sum(r["found"] for r in rows),
        "moved_in": sum(r["moved_in"] for r in rows),
        "created": sum(r["created"] for r in rows),
        "rows": rows,
    }


# ---------------------------------------------------------------------------
# Submit a row check
# ---------------------------------------------------------------------------

def submit_row_check(
    db: Session, *, row_id: str, scanned: Iterable[str], not_here_pallet_ids: Iterable[str],
    confirmed: bool, user, warehouse_id: Optional[str], session_id: Optional[str] = None,
) -> dict:
    row = _get_row(db, row_id, warehouse_id)
    before = row_contents(db, row.id, warehouse_id)
    expected_by_id = {p["id"]: g for g in before["groups"] for p in g["pallets"]}
    scanned = [s for s in dict.fromkeys((x or "").strip() for x in (scanned or [])) if s]
    scanned_set = set(scanned)
    not_here_ids = [i for i in dict.fromkeys(not_here_pallet_ids or []) if i in expected_by_id]
    # A pallet both scanned and ticked "not here" is here.
    not_here = [
        p for p in db.query(PalletLicence).filter(PalletLicence.id.in_(not_here_ids)).with_for_update().all()
        if p.licence_number not in scanned_set and p.status == PalletStatus.IN_STOCK.value
    ] if not_here_ids else []
    if len(not_here) > CYCLE_CHECK_CONFIRM_OVER and not confirmed:
        return {
            "status": "needs_confirm",
            "not_here_count": len(not_here),
            "message": f"{len(not_here)} pallets not here — sure?",
        }

    cc_id = f"cycle-{uuid.uuid4().hex[:12]}"
    session_id, session_started_at = _resolve_session(db, user, session_id)
    results = [_apply_scan(db, lic, row, user, warehouse_id) for lic in scanned]
    for p in not_here:
        _mark_missing(db, p, row, user, cc_id)
    db.flush()

    # Expected vs seen per product + lot. A group with one front pallet
    # scanned is present; its unticked pallets are taken as seen.
    not_here_by_group: dict = {}
    for p in not_here:
        not_here_by_group.setdefault(expected_by_id[p.id]["key"], []).append(p.licence_number)
    arrived: dict = {}
    for r in results:
        if r["result"] in ("moved", "found", "created"):
            pl = db.query(PalletLicence).filter(PalletLicence.licence_number == r["licence_number"]).first()
            if pl is not None:
                arrived.setdefault(f"{pl.product_id}|{pl.lot_number or ''}", []).append(
                    (r["licence_number"], r["result"], pl)
                )
    items = []
    keys = [g["key"] for g in before["groups"]] + [k for k in arrived if k not in {g["key"] for g in before["groups"]}]
    by_key = {g["key"]: g for g in before["groups"]}
    for key in keys:
        g = by_key.get(key)
        missing_here = not_here_by_group.get(key, [])
        extra = arrived.get(key, [])
        expected = g["count"] if g else 0
        actual = expected - len(missing_here) + len(extra)
        pl0 = extra[0][2] if extra else None
        product_id = g["product_id"] if g else pl0.product_id
        product = db.query(Product).filter(Product.id == product_id).first()
        variance = actual - expected
        items.append({
            "productId": product_id,
            "productName": product.name if product else product_id,
            "lotNo": (g["lot_number"] if g else pl0.lot_number) or "—",
            "location": row.name,
            "storageRowId": row.id,
            "expectedQuantity": expected,
            "actualQuantity": actual,
            "unit": "pallets",
            "variance": variance,
            "status": "ok" if variance == 0 else ("shortage" if variance < 0 else "overage"),
            "notHere": missing_here,
            "arrived": [{"licence_number": lic, "result": res} for lic, res, _ in extra],
        })

    tz = zone(warehouse_timezone(db, warehouse_id))
    summary = {
        "kind": KIND_GUN_ROW_CHECK,
        "session_id": session_id,
        "session_started_at": session_started_at,
        "row_id": row.id,
        "row_name": row.name,
        "expected_pallets": before["total_pallets"],
        "not_here": len(not_here),
        "moved_in": sum(1 for r in results if r["result"] == "moved"),
        "found": sum(1 for r in results if r["result"] == "found"),
        "created": sum(1 for r in results if r["result"] == "created"),
        "totalItems": len(items),
        "variancesCount": sum(1 for i in items if i["status"] != "ok"),
        "shortages": sum(1 for i in items if i["status"] == "shortage"),
        "overages": sum(1 for i in items if i["status"] == "overage"),
        "scans": results,
    }
    cc = CycleCount(
        id=cc_id,
        location_id=_row_location_id(db, row),
        count_date=datetime.now(tz).date(),
        items=items,
        summary=summary,
        performed_by=user.name or user.username,
        performed_by_id=str(user.id),
        warehouse_id=warehouse_id,
    )
    db.add(cc)
    db.flush()
    return {
        "status": "recorded", "cycle_count_id": cc.id, "session_id": session_id,
        "session_started_at": session_started_at, "summary": summary, "items": items,
    }


# ---------------------------------------------------------------------------
# Find Pallet
# ---------------------------------------------------------------------------

def _seq_ranges(seqs: List[int], limit: int = 6) -> str:
    """[1,2,3,5,7,8] → '#1–3, 5, 7–8' (first `limit` runs, then '…')."""
    runs = []
    for n in seqs:
        if runs and n == runs[-1][1] + 1:
            runs[-1][1] = n
        else:
            runs.append([n, n])
    parts = [f"{a}" if a == b else f"{a}–{b}" for a, b in runs[:limit]]
    return "#" + ", ".join(parts) + (", …" if len(runs) > limit else "")


def _lot_sequences(db: Session, lot: str, product_id: str, warehouse_id: Optional[str]) -> List[int]:
    """Every pallet number recorded for this lot + product (any status) in the
    checker's warehouse (legacy pallets with no warehouse count too)."""
    q = db.query(PalletLicence.sequence).filter(
        PalletLicence.lot_number == lot,
        PalletLicence.product_id == product_id,
        PalletLicence.sequence.isnot(None),
    )
    if warehouse_id:
        q = q.filter(or_(PalletLicence.warehouse_id == warehouse_id, PalletLicence.warehouse_id.is_(None)))
    return sorted({int(s) for (s,) in q.all()})


def _parse_sticker(db: Session, licence: str):
    """(lot, product, sequence) of a sticker, or Nones."""
    from app.services.scanner_service import find_product_by_code, parse_licence_number
    lot, code, seq = parse_licence_number(licence)
    if not lot or seq is None:
        return None, None, None, code
    product = find_product_by_code(db, code)
    if product is not None and not plc.is_finished_good(db, product.id):
        product = None
    return lot, product, seq, code


def explain_never_scanned(db: Session, licence: str, warehouse_id: Optional[str]) -> dict:
    """Why a sticker is not in the system, from the rest of its lot."""
    lot, product, seq, code = _parse_sticker(db, licence)
    if not lot:
        return {"kind": "not_a_sticker", "actions": [],
                "message": f"{licence} is not a pallet sticker (LOT-PRODUCT-###) — check what was scanned."}
    if product is None:
        return {"kind": "unknown_product", "actions": [], "lot_number": lot, "sequence": seq,
                "message": f"Not in the system — product code {code} is not a known finished good. Check the sticker."}
    base = {"lot_number": lot, "sequence": seq, "product_name": product.name, "actions": ["create_here"]}
    seqs = _lot_sequences(db, lot, product.id, warehouse_id)
    num = f"#{seq:03d}"
    if not seqs:
        return {**base, "kind": "lot_not_in_system", "confirm_create": True,
                "message": (f"No pallet of this lot is in the system ({product.name}, lot {lot}) — "
                            "check the product and lot on the sticker before creating.")}
    recorded = f"lot {lot} has {_seq_ranges(seqs)} recorded"
    hi, lo = seqs[-1], seqs[0]
    if seq > hi:
        kind = "end_of_lot"
        where = "right after" if seq == hi + 1 else "after"
        msg = f"Never scanned — {recorded}; this is {num}, {where} the last scanned pallet #{hi:03d} (end of lot)."
    elif seq < lo:
        kind = "before_first"
        msg = f"Never scanned — {recorded}; this is {num}, before the first scanned pallet #{lo:03d}."
    elif seq in seqs:
        # Same lot + number under another sticker spelling (product code alias).
        kind = "number_taken"
        base = {**base, "actions": []}
        msg = (f"{recorded}, including {num} under a different sticker — "
               "check the product code on this sticker; do not create it.")
    else:
        kind = "gap"
        prev = max(n for n in seqs if n < seq)
        nxt = min(n for n in seqs if n > seq)
        msg = f"Never scanned — a gap between #{prev:03d} and #{nxt:03d} in lot {lot} ({_seq_ranges(seqs)} recorded)."
    return {**base, "kind": kind, "message": msg, "highest": hi}


def _status_event(db: Session, pl: PalletLicence, status: str) -> Optional[PalletEvent]:
    return (
        db.query(PalletEvent)
        .filter(PalletEvent.pallet_licence_id == pl.id, PalletEvent.to_status == status)
        .order_by(PalletEvent.created_at.desc())
        .first()
    )


def _who_when_why(db: Session, pl: PalletLicence, ev: Optional[PalletEvent]) -> Optional[str]:
    """'by Ann on 10/12/2026 9:14 AM — Not here — cycle check of FG-01'."""
    if ev is None:
        return None
    who = plc._user_name(db, ev.user_id) or "someone"
    why = ev.reason or (ev.reason_code or "").replace("_", " ")
    return f"by {who} on {plc.fmt_local(db, ev.created_at, pl.warehouse_id)}" + (f" — {why}" if why else "")


_NO_RECORD = "no record of who or when (older data)"


def find_pallet(db: Session, licence: str, warehouse_id: Optional[str] = None) -> dict:
    from app.services.scanner_service import normalize_scanned_licence
    licence = normalize_scanned_licence((licence or "").strip(), "")[:100]
    pl = db.query(PalletLicence).filter(PalletLicence.licence_number == licence).first()
    if _other_warehouse(pl, warehouse_id):
        # Say it exists (so nobody tries to create it) but nothing about it.
        return {
            "licence_number": licence, "exists": True, "status": "other_warehouse",
            "actions": [], "history": [],
            "message": "This pallet belongs to another warehouse.",
        }
    if pl is None:
        why = explain_never_scanned(db, licence, warehouse_id)
        return {
            "licence_number": licence, "exists": False, "status": None,
            "actions": why.pop("actions"), "message": why.pop("message"),
            "explanation": why, "confirm_create": bool(why.get("confirm_create")),
            "product_name": why.get("product_name"), "lot_number": why.get("lot_number"),
            "sequence": why.get("sequence"), "history": [],
        }
    row = db.query(StorageRow).filter(StorageRow.id == pl.storage_row_id).first() if pl.storage_row_id else None
    product = db.query(Product).filter(Product.id == pl.product_id).first()
    fr = (
        db.query(ForkliftRequest).filter(ForkliftRequest.id == pl.forklift_request_id).first()
        if pl.forklift_request_id else None
    )
    out = {
        "licence_number": pl.licence_number, "exists": True, "pallet_id": pl.id,
        "status": pl.status, "product_name": product.name if product else None,
        "lot_number": pl.lot_number, "sequence": pl.sequence, "cases": pl.cases,
        "row_name": row.name if row else None, "storage_row_id": pl.storage_row_id,
        "is_held": bool(pl.is_held),
        "forklift_request": (
            {"id": fr.id, "status": fr.status, "submitted_at": fr.submitted_at} if fr else None
        ),
        "shipped": None, "actions": [], "message": None,
    }
    num = f"#{int(pl.sequence):03d}" if pl.sequence is not None else pl.licence_number
    if pl.status == PalletStatus.IN_STOCK.value:
        out["actions"] = ["move_here"]
        out["message"] = (
            f"In stock in {row.name if row else 'no row'} · lot {pl.lot_number or '—'}"
            + (" · ON HOLD" if pl.is_held else "") + "."
        )
    elif pl.status == PalletStatus.MISSING.value:
        out["actions"] = ["found_here"]
        www = _who_when_why(db, pl, _status_event(db, pl, PalletStatus.MISSING.value))
        out["message"] = f"Marked missing {www or '— ' + _NO_RECORD}. Mark it found, in stock here."
    elif pl.status == PalletStatus.NOT_PRODUCED.value:
        out["actions"] = ["restore_here"]
        ev = (_status_event(db, pl, PalletStatus.NOT_PRODUCED.value)
              or plc.last_event(db, pl, PalletEventType.NOT_PRODUCED.value))
        www = _who_when_why(db, pl, ev)
        out["message"] = f"{num} was marked Not Produced {www or '— ' + _NO_RECORD}. Put it back in stock here (flagged)."
    elif pl.status == PalletStatus.CANCELLED.value:
        out["actions"] = ["restore_here"]
        www = _who_when_why(db, pl, _status_event(db, pl, PalletStatus.CANCELLED.value))
        if www is None and fr is not None:
            www = f"— its forklift request {fr.id} is {fr.status}"
        out["message"] = f"Written off (cancelled) {www or '— ' + _NO_RECORD}. Put it back in stock here (flagged)."
    elif pl.status == PalletStatus.EMPTIED.value:
        # Stays at 0: history only, no actions (nothing a scan can do to it).
        out["message"] = plc.emptied_detail(db, pl)
    elif pl.status in (PalletStatus.PENDING.value, PalletStatus.MISSING_STICKER.value):
        st = fr.status if fr else None
        out["message"] = (
            "Being scanned right now" if st == ForkliftRequestStatus.SCANNING.value
            else "Waiting in a forklift request for review"
        )
    elif pl.status == PalletStatus.SHIPPED.value:
        info = plc.shipped_info(db, pl)
        out["shipped"] = {**info, "at": info["at"].isoformat() if info["at"] else None}
        out["message"] = plc.shipped_detail(db, pl)
    events = (
        db.query(PalletEvent).filter(PalletEvent.pallet_licence_id == pl.id)
        .order_by(PalletEvent.created_at.desc()).limit(20).all()
    )
    out["history"] = [{
        "event_type": e.event_type, "from_status": e.from_status, "to_status": e.to_status,
        "reason_code": e.reason_code, "reason": e.reason,
        "by": plc._user_name(db, e.user_id), "at": e.created_at,
    } for e in events]
    out["scanned_by"] = plc._user_name(db, pl.scanned_by)
    out["scanned_at"] = pl.scanned_at
    return out


_ACTION_FOR_STATUS = {
    "move_here": (PalletStatus.IN_STOCK.value,),
    "found_here": (PalletStatus.MISSING.value,),
    "restore_here": (PalletStatus.NOT_PRODUCED.value, PalletStatus.CANCELLED.value),
}


def find_pallet_action(
    db: Session, *, licence: str, action: str, row_id: str, user, warehouse_id, confirmed: bool = False,
) -> dict:
    row = _get_row(db, row_id, warehouse_id)
    from app.services.scanner_service import normalize_scanned_licence
    licence = normalize_scanned_licence((licence or "").strip(), "")
    pl = db.query(PalletLicence).filter(PalletLicence.licence_number == licence).with_for_update().first()
    if _other_warehouse(pl, warehouse_id):
        raise ValidationError("This pallet belongs to another warehouse.")
    if action == "create_here":
        if pl is not None:
            raise ValidationError(f"{licence} already exists ({pl.status})")
        why = explain_never_scanned(db, licence, warehouse_id)
        if why["kind"] == "number_taken":
            raise ValidationError(why["message"])
        # Creating the first pallet of a lot the system has never seen risks
        # counting it twice (wrong product or lot on the sticker): the checker
        # must have tapped the explicit confirm.
        if why.get("confirm_create") and not confirmed:
            raise ValidationError(
                "No pallet of this lot is in the system — check the sticker, then confirm to create it."
            )
        _create_from_sticker(db, licence, row, user, warehouse_id)
    else:
        allowed = _ACTION_FOR_STATUS.get(action)
        if allowed is None:
            raise ValidationError("Unknown action")
        if pl is not None and pl.status == PalletStatus.EMPTIED.value:
            raise ValidationError(plc.emptied_detail(db, pl))
        if pl is None or pl.status not in allowed:
            raise ValidationError(f"{licence} is {pl.status if pl else 'not in the system'} — refresh")
        if action == "move_here":
            if pl.storage_row_id != row.id:
                _move_here(db, pl, row, user)
        else:
            plc.restore_to_stock(db, pl, row=row, user=user, reason=f"Find Pallet in {row.name}",
                                 ref_type="storage_row", ref_id=row.id)
    db.flush()
    return find_pallet(db, licence, warehouse_id)
