"""Browser re-check of PART 2/3 (2026-10-02) — server side.

N5  Close Out without the Production app: close-out-data on local figures
    (`skip_production`), and a supervisor-only close-out flagged and recorded
    as closed without Production data.
N7  Staging Overview Return uses the Production Requests dialog: the desk
    return endpoint takes the full/weighed split, any active rack, and a
    details endpoint gives the dialog what it needs.
N8  "1 drum was on the cart" (not "were"); Lot Trace hold titles are not
    "Hold Hold".
"""
import pytest

from app.models import StagingItem, StagingRequest
from app.services import lot_placement_service as lps
from app.services import report_builders
from app.services import staging_pull_service as sps
from app.services import staging_request_service
from tests.test_browser_part3_staging_fixes import (  # noqa: F401  (fixtures)
    A, B, _gun_pull, _gun_submit, _item_id, _lot, _request, story,
)
from tests.test_e2e_barrel_lifecycle import (  # noqa: F401  (fixtures)
    LOC, ROW1, ROW3, SUP_H, WH_H, plant,
)


def _staged_and_used(s, db_session, used):
    sr = _request(s, needed=2 * A)
    _gun_pull(s, sr["id"], ROW1, 2)
    sub = _gun_submit(s, sr["id"])
    item_id = _item_id(db_session, sr["id"])
    (si_id,) = sub["staging_item_ids"]
    if used:
        s.post(f"/api/service/staging-requests/{sr['id']}/items/{item_id}/mark-used", SUP_H,
               json={"staging_item_id": si_id, "quantity": used})
    return sr, item_id, si_id


# ── N5 ────────────────────────────────────────────────────────────────────────

def test_close_out_data_on_local_figures_when_production_is_skipped(story, db_session):
    s = story
    sr, _item, _si = _staged_and_used(s, db_session, used=A)
    data = s.get(f"/api/service/staging-requests/{sr['id']}/close-out-data", SUP_H,
                 params={"skip_production": True})
    assert data["production_skipped"] is True
    assert data["production_reachable"] is None
    (row,) = data["items"]
    assert row["quantity_staged"] == pytest.approx(2 * A)
    assert row["quantity_used"] == pytest.approx(A)
    assert row["leftover"] == pytest.approx(A)


def test_close_out_data_says_when_production_did_not_answer(story, db_session, monkeypatch):
    s = story
    sr, _item, _si = _staged_and_used(s, db_session, used=A)
    # Nothing listens on port 9: the call fails fast, as when the app is down.
    monkeypatch.setattr(staging_request_service, "PRODUCTION_API_URL", "http://127.0.0.1:9")
    data = s.get(f"/api/service/staging-requests/{sr['id']}/close-out-data", SUP_H)
    assert data["production_reachable"] is False
    assert data["items"][0]["quantity_used"] == pytest.approx(A)


def test_close_out_without_production_is_supervisor_only_and_recorded(story, db_session):
    s = story
    sr, _item, _si = _staged_and_used(s, db_session, used=2 * A)
    url = f"/api/service/staging-requests/{sr['id']}/close-out"

    r = s.post(url, WH_H, ok=False, json={"without_production": True})
    assert r.status_code == 403, r.text
    db_session.expire_all()
    assert db_session.query(StagingRequest).filter(StagingRequest.id == sr["id"]).one().status != "closed"

    res = s.post(url, SUP_H, json={"without_production": True}).json()
    assert res["status"] == "ok" and res["without_production"] is True
    db_session.expire_all()
    req = db_session.query(StagingRequest).filter(StagingRequest.id == sr["id"]).one()
    assert req.status == "closed"
    assert "Closed WITHOUT Production data" in (req.notes or "")
    assert "e2e_sup" in req.notes


def test_close_out_without_production_still_needs_leftovers_cleared(story, db_session):
    s = story
    sr, _item, _si = _staged_and_used(s, db_session, used=A)
    r = s.post(f"/api/service/staging-requests/{sr['id']}/close-out", SUP_H, ok=False,
               json={"without_production": True})
    assert r.status_code == 400 and "Leftover" in r.json()["detail"]


def test_plain_close_out_keeps_working_without_a_body(story, db_session):
    s = story
    sr, _item, _si = _staged_and_used(s, db_session, used=2 * A)
    res = s.post(f"/api/service/staging-requests/{sr['id']}/close-out", SUP_H).json()
    assert res["status"] == "ok" and res["without_production"] is False
    db_session.expire_all()
    req = db_session.query(StagingRequest).filter(StagingRequest.id == sr["id"]).one()
    assert "WITHOUT Production" not in (req.notes or "")


# ── N7 ────────────────────────────────────────────────────────────────────────

def test_staging_overview_return_details_and_split_return_to_any_rack(story, db_session):
    s = story
    _sr, _item, si_id = _staged_and_used(s, db_session, used=A + 292)

    detail = s.get(f"/api/inventory/staging/{si_id}/return-details", SUP_H)
    assert detail["staging_item_id"] == si_id
    assert detail["is_counted"] is True
    assert detail["weight_per_unit"] == pytest.approx(A)
    assert detail["unit_label"] == "drum"
    assert detail["original_storage_row_id"] == ROW1
    assert detail["available"] == pytest.approx(210.0)

    # The weighed 210 lb back as an open drum on ROW3 — not the rack it came
    # off, and no location sent: the rack names its own room.
    s.post(f"/api/inventory/staging/{si_id}/return", SUP_H, json={
        "quantity": 210.0, "to_storage_row_id": ROW3,
        "full_units": 0, "weighed_partial_qty": 210.0,
    })
    lot = _lot(db_session, s)
    p3 = [p for p in lps.placements_for_lot(db_session, lot.id) if p.storage_row_id == ROW3]
    assert p3 and p3[0].open_units == 1 and p3[0].open_remaining_qty == pytest.approx(210.0)
    si = db_session.query(StagingItem).filter(StagingItem.id == si_id).one()
    assert si.quantity_returned == pytest.approx(210.0)


def test_staging_overview_return_of_whole_drums(story, db_session):
    s = story
    _sr, _item, si_id = _staged_and_used(s, db_session, used=0)
    before = {p.storage_row_id: int(p.full_units)
              for p in lps.placements_for_lot(db_session, _lot(db_session, s).id)}
    s.post(f"/api/inventory/staging/{si_id}/return", SUP_H, json={
        "quantity": A, "to_storage_row_id": ROW1, "full_units": 1, "weighed_partial_qty": 0,
    })
    after = {p.storage_row_id: int(p.full_units)
             for p in lps.placements_for_lot(db_session, _lot(db_session, s).id)}
    assert after[ROW1] == before.get(ROW1, 0) + 1


def test_staging_overview_return_needs_a_rack_or_location(story, db_session):
    s = story
    _sr, _item, si_id = _staged_and_used(s, db_session, used=0)
    r = s.post(f"/api/inventory/staging/{si_id}/return", SUP_H, ok=False, json={"quantity": A})
    assert r.status_code == 400


# ── N8 ────────────────────────────────────────────────────────────────────────

def test_held_message_agrees_with_one_container():
    one = sps._held_message([{
        "lot_name": "D-0801", "hold_reason": None, "racks": ["QA-P2"],
        "units": 1, "open_units": 0, "unit_label": "box",
    }])
    assert "1 box was on the cart" in one
    assert "It cannot be staged — put it back on QA-P2" in one
    two = sps._held_message([{
        "lot_name": "A-0925", "hold_reason": None, "racks": [],
        "units": 2, "open_units": 0, "unit_label": "drum",
    }])
    assert "2 drums were on the cart" in two
    assert "put them back on the rack they came from" in two


def test_lot_trace_hold_titles_are_plain():
    assert report_builders.HOLD_EVENT_TITLES["hold"] == "Put on Hold"
    assert report_builders.HOLD_EVENT_TITLES["release"] == "Hold Released"
