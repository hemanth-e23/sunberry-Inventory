"""Gun cycle check — count sessions + Find Pallet explanations (2026-10-12).

Production, Oct 12: one checker did 21 row checks in 11 minutes → 21 separate
Count History lines, all labelled with the warehouse name. And Find Pallet
said only "not in system" for an end-of-lot pallet never scanned, a gap in a
lot, and a lot with nothing in the system at all.

- every row save carries a server-minted session id (summary.session_id);
  a foreign / malformed / stale id starts a new session
- old checks without a session id group by person + day + no gap > 60 min
- the Cycle Count report carries the sessions and labels each line with one
- Find Pallet says WHY: end of lot / gap / lot not in system (create needs an
  explicit confirm), missing / not produced / cancelled with who-when-why and
  a fallback for old data, shipped order + who, in stock elsewhere row + lot
"""
from datetime import date, datetime, timedelta, timezone

import pytest

from app.enums import PalletEventType, PalletStatus
from app.exceptions import ValidationError
from app.models import CycleCount
from app.services import cycle_check_service as svc
from app.services import pallet_lifecycle_service as plc
from app.services import ship_out_service
from app.services.report_builders import build_cycle_count_report
from tests.test_fg_pallet_lifecycle import (  # noqa: F401  (fixtures)
    LOT, _h, _pallet, _receipt, _scheduled, fg,
)


def _check(db, user, row="row-1", session_id=None, scanned=(), not_here=()):
    out = svc.submit_row_check(
        db, row_id=row, scanned=list(scanned), not_here_pallet_ids=list(not_here),
        confirmed=True, user=user, warehouse_id="wh-a", session_id=session_id,
    )
    db.commit()
    return out


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

def test_first_row_mints_a_session_and_later_rows_continue_it(db_session, fg):
    db = db_session
    _receipt(db, qty=80)
    _pallet(db, 1)
    _pallet(db, 2, row="row-2")
    db.commit()
    first = _check(db, fg["fk-1"], "row-1", scanned=[f"{LOT}-MANGO-001"])
    sid = first["session_id"]
    assert sid.startswith("cs-") and first["summary"]["session_id"] == sid
    assert first["summary"]["session_started_at"] == first["session_started_at"]
    second = _check(db, fg["fk-1"], "row-2", session_id=sid, not_here=[f"pl-{LOT}-2"])
    assert second["session_id"] == sid
    assert second["summary"]["session_started_at"] == first["session_started_at"]
    stored = {c.summary["row_name"]: c.summary["session_id"] for c in db.query(CycleCount).all()}
    assert stored == {"FG-01": sid, "FG-02": sid}


def test_foreign_malformed_or_stale_session_ids_start_a_new_session(db_session, fg):
    db = db_session
    sid = _check(db, fg["fk-1"], "row-1")["session_id"]
    # Another checker cannot append rows to fk-1's session.
    assert _check(db, fg["fk-2"], "row-1", session_id=sid)["session_id"] != sid
    # Garbage is ignored.
    assert _check(db, fg["fk-1"], "row-1", session_id="x' OR 1=1")["session_id"].startswith("cs-")
    # Idle longer than the window → new session.
    for c in db.query(CycleCount).all():
        c.created_at = datetime.now(timezone.utc) - timedelta(minutes=61)
    db.commit()
    assert _check(db, fg["fk-1"], "row-1", session_id=sid)["session_id"] != sid


def _cc(db, cid, who, at, *, session_id=None, kind="gun_row_check", row="FG-01", not_here=0,
        day=None):
    summary = {"kind": kind, "row_name": row, "row_id": "row-1", "expected_pallets": 2,
               "not_here": not_here, "moved_in": 0, "found": 0, "created": 0,
               "variancesCount": 1 if not_here else 0, "totalItems": 1}
    if session_id:
        summary["session_id"] = session_id
    if kind != "gun_row_check":
        summary.pop("kind")
    db.add(CycleCount(
        id=cid, location_id="loc-1", count_date=day or at.date(), items=[], summary=summary,
        performed_by=who.upper(), performed_by_id=who, warehouse_id="wh-a", created_at=at,
    ))


def test_legacy_checks_group_by_person_day_and_gap(db_session, fg):
    db = db_session
    t0 = datetime(2026, 10, 12, 13, 0, tzinfo=timezone.utc)
    # fk-1: 21 checks in 11 minutes (the production case) → one session …
    for i in range(21):
        _cc(db, f"c-{i:02d}", "fk-1", t0 + timedelta(seconds=31 * i), not_here=1 if i == 3 else 0)
    # … then 80 minutes later another walk → a second session.
    _cc(db, "c-late", "fk-1", t0 + timedelta(minutes=91))
    # fk-2 at the same time is somebody else's session.
    _cc(db, "c-other", "fk-2", t0 + timedelta(minutes=2))
    # Tagged checks group by their id, not by time.
    _cc(db, "c-tag1", "fk-1", t0 + timedelta(minutes=200), session_id="cs-aaaaaaaaaaaa")
    _cc(db, "c-tag2", "fk-1", t0 + timedelta(minutes=230), session_id="cs-aaaaaaaaaaaa")
    # A per-receipt count sheet is not a gun session.
    _cc(db, "c-sheet", "clerk", t0, kind="sheet")
    db.commit()
    groups = svc.group_sessions(db.query(CycleCount).all())
    rolled = [svc.session_rollup(g) for g in groups]
    by_size = sorted(r["rows_checked"] for r in rolled)
    assert by_size == [1, 1, 2, 21]
    big = next(r for r in rolled if r["rows_checked"] == 21)
    assert big["inferred"] is True and big["rows_ok"] == 20 and big["rows_with_differences"] == 1
    assert big["not_here"] == 1 and big["performed_by"] == "FK-1"
    assert big["ended_at"] - big["started_at"] == timedelta(seconds=31 * 20)
    tagged = next(r for r in rolled if r["session_id"] == "cs-aaaaaaaaaaaa")
    assert tagged["inferred"] is False and [r["cycle_count_id"] for r in tagged["rows"]] == ["c-tag1", "c-tag2"]
    # Newest session first.
    assert rolled[0]["session_id"] == "cs-aaaaaaaaaaaa"


def test_legacy_grouping_splits_at_the_day(db_session, fg):
    db = db_session
    t0 = datetime(2026, 10, 12, 3, 50, tzinfo=timezone.utc)
    _cc(db, "d1", "fk-1", t0, day=date(2026, 10, 11))
    _cc(db, "d2", "fk-1", t0 + timedelta(minutes=20), day=date(2026, 10, 12))
    db.commit()
    assert len(svc.group_sessions(db.query(CycleCount).all())) == 2


def test_report_carries_sessions_and_labels_lines(db_session, fg):
    db = db_session
    _receipt(db, qty=80)
    _pallet(db, 1)
    _pallet(db, 2, row="row-2")
    db.commit()
    sid = _check(db, fg["fk-1"], "row-1", scanned=[f"{LOT}-MANGO-001"])["session_id"]
    _check(db, fg["fk-1"], "row-2", session_id=sid, not_here=[f"pl-{LOT}-2"])
    rep = build_cycle_count_report(db, warehouse_id="wh-a")
    assert rep["totals"]["gun_sessions"] == 1
    s = rep["sessions"][0]
    assert s["rows_checked"] == 2 and s["rows_ok"] == 1 and s["not_here"] == 1
    assert "FK-1" in s["label"] and "2 rows" in s["label"]
    gun_rows = [r for r in rep["rows"] if r["count_kind"] == "Gun row check"]
    assert {r["location"] for r in gun_rows} == {"FG-01", "FG-02"}
    assert all(r["session"] == s["label"] for r in gun_rows)


def test_submit_api_passes_the_session_through(client, db_session, fg):
    _receipt(db_session)
    _pallet(db_session, 1)
    db_session.commit()
    h = _h("fk-1")
    a = client.post("/api/scanner/cycle-check/submit", headers=h,
                    json={"row_id": "row-1", "scanned": [f"{LOT}-MANGO-001"]}).json()
    b = client.post("/api/scanner/cycle-check/submit", headers=h,
                    json={"row_id": "row-2", "session_id": a["session_id"]}).json()
    assert b["session_id"] == a["session_id"]
    too_long = client.post("/api/scanner/cycle-check/submit", headers=h,
                           json={"row_id": "row-2", "session_id": "x" * 41})
    assert too_long.status_code == 422


# ---------------------------------------------------------------------------
# Find Pallet — why
# ---------------------------------------------------------------------------

def test_never_scanned_end_of_lot(db_session, fg):
    db = db_session
    _receipt(db, qty=440)
    for s in range(1, 12):
        _pallet(db, s)
    db.commit()
    info = svc.find_pallet(db, f"{LOT}-MANGO-016", "wh-a")
    assert info["exists"] is False and info["explanation"]["kind"] == "end_of_lot"
    assert info["message"] == (
        f"Never scanned — lot {LOT} has #1–11 recorded; this is #016, after the last scanned pallet #011 (end of lot)."
    )
    assert info["actions"] == ["create_here"] and info["confirm_create"] is False
    nxt = svc.find_pallet(db, f"{LOT}-MANGO-012", "wh-a")
    assert "right after the last scanned pallet #011" in nxt["message"]


def test_never_scanned_gap_in_the_lot(db_session, fg):
    db = db_session
    _receipt(db, qty=400)
    for s in list(range(1, 9)) + [10, 11]:
        _pallet(db, s)
    db.commit()
    info = svc.find_pallet(db, f"{LOT}-MANGO-009", "wh-a")
    assert info["explanation"]["kind"] == "gap"
    assert info["message"] == f"Never scanned — a gap between #008 and #010 in lot {LOT} (#1–8, 10–11 recorded)."


def test_lot_not_in_system_needs_an_explicit_confirm_to_create(client, db_session, fg):
    db = db_session
    info = svc.find_pallet(db, "MP29926L1-MANGO-004", "wh-a")
    assert info["explanation"]["kind"] == "lot_not_in_system" and info["confirm_create"] is True
    assert "No pallet of this lot is in the system" in info["message"]
    assert "check the product and lot on the sticker before creating" in info["message"]
    with pytest.raises(ValidationError):
        svc.find_pallet_action(db, licence="MP29926L1-MANGO-004", action="create_here",
                               row_id="row-1", user=fg["fk-1"], warehouse_id="wh-a")
    db.rollback()
    h = _h("fk-1")
    body = {"licence_number": "MP29926L1-MANGO-004", "action": "create_here", "row_id": "row-1"}
    assert client.post("/api/scanner/cycle-check/find", headers=h, json=body).status_code == 400
    ok = client.post("/api/scanner/cycle-check/find", headers=h, json={**body, "confirmed": True})
    assert ok.status_code == 200 and ok.json()["status"] == "in_stock"


def test_unknown_product_and_not_a_sticker_offer_no_create(db_session, fg):
    db = db_session
    assert svc.find_pallet(db, f"{LOT}-NOPE-001", "wh-a")["actions"] == []
    junk = svc.find_pallet(db, "HELLO", "wh-a")
    assert junk["actions"] == [] and junk["explanation"]["kind"] == "not_a_sticker"


def test_missing_cancelled_and_not_produced_say_who_when_why(db_session, fg):
    db = db_session
    _receipt(db, qty=80)
    _pallet(db, 1)
    _pallet(db, 2, PalletStatus.MISSING)      # old data: no event
    _pallet(db, 3, PalletStatus.CANCELLED)    # old data: no event
    db.commit()
    _check(db, fg["fk-2"], "row-1", not_here=[f"pl-{LOT}-1"])
    m = svc.find_pallet(db, f"{LOT}-MANGO-001", "wh-a")
    assert m["message"].startswith("Marked missing by FK-2 on ")
    assert "Not here — cycle check of FG-01" in m["message"]
    old = svc.find_pallet(db, f"{LOT}-MANGO-002", "wh-a")
    assert "no record of who or when" in old["message"] and old["actions"] == ["found_here"]
    c = svc.find_pallet(db, f"{LOT}-MANGO-003", "wh-a")
    assert c["message"].startswith("Written off (cancelled)") and c["actions"] == ["restore_here"]

    np = _pallet(db, 4, PalletStatus.NOT_PRODUCED, row=None, cases=0)
    db.flush()
    plc.record_event(db, np, PalletEventType.NOT_PRODUCED, user=fg["sup"], from_status="pending",
                     to_status="not_produced", reason="Line jam")
    db.commit()
    n = svc.find_pallet(db, f"{LOT}-MANGO-004", "wh-a")
    assert n["message"].startswith("#004 was marked Not Produced by SUP on ") and "Line jam" in n["message"]


def test_shipped_and_in_stock_elsewhere(db_session, fg):
    db = db_session
    _receipt(db, qty=80)
    _pallet(db, 1)
    _pallet(db, 2, row="row-2")
    db.commit()
    t = _scheduled(db, fg["clerk"], "SO-77", 40)
    assert ship_out_service.scan_pick_v2(db, t, f"{LOT}-MANGO-001", None, fg["fk-1"])["ok"]
    db.commit()
    s = svc.find_pallet(db, f"{LOT}-MANGO-001", "wh-a")
    assert s["status"] == "shipped"
    assert "SO-77" in s["message"] and "FK-1" in s["message"]
    assert s["shipped"]["order_number"] == "SO-77"
    e = svc.find_pallet(db, f"{LOT}-MANGO-002", "wh-a")
    assert e["message"] == f"In stock in FG-02 · lot {LOT}." and e["actions"] == ["move_here"]


def test_find_lookup_caps_the_licence(client, db_session, fg):
    r = client.get("/api/scanner/cycle-check/find", headers=_h("fk-1"),
                   params={"licence_number": "M" * 101})
    assert r.status_code == 422
