"""Browser test PART 3 (2026-10-02) — staging on the desk and its server side.

B2  undo of a (partly) used line returns only what is still in staging and
    never resets the line to pending; a fully used line is refused.
B3  Mark Used of a held lot is refused (both desk paths); the hold form's lot
    status names the containers on a cart / in staging.
B5  desk Stage prices a mixed-weight lot rack by rack and stages whole drums
    at their exact weight.
B8  Staging Overview "All" lists every staged item.
G1  Close Out opens ON the production day (warehouse local day).
G2  a return may go to any active rack of the warehouse.
U2  lot trace: gun pull has a date and lists every rack it came off; returns
    name their rack.
U3  used + returned = staged is "completed", not "partially_returned".
G5  the adjustments report carries the donation recipient.
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.models import (
    InventoryAdjustment, MaterialLot, Location, StagingItem, StagingRequest,
    StagingRequestItem, StorageRow, SubLocation, Warehouse,
)
from app.services import lot_placement_service as lps
from app.services import staging_request_service
from app.utils.warehouse_time import zone
from tests.test_e2e_barrel_lifecycle import (  # noqa: F401  (fixtures)
    FK_H, LOC, LOC_PROD, PRODUCT, ROW1, ROW2, ROW3, SID, SUB, SUB_STAGING,
    SUP_H, WH, WH_H, Story, plant,
)

A, B = 502.0, 474.0
VL = "A-0925"
BBD = "2027-03-01"


def _today_local():
    return datetime.now(timezone.utc).astimezone(zone(None)).date()


def _request(s, needed=1500.0, production_date=None, uid=None):
    return s.post("/api/service/staging-requests", SUP_H, json={
        "production_batch_uid": uid or f"PB-{uuid.uuid4().hex[:6]}",
        "product_name": "Nectar",
        "production_date": (production_date or _today_local()).isoformat(),
        "items": [{"sid": SID, "ingredient_name": "Mango", "quantity_needed": needed,
                   "unit": "lbs"}],
    }).json()


def _gun_pull(s, sr_id, row, units):
    body = {"code": s.lots["A"]["lot_code"], "storage_row_id": row, "units": units,
            "idempotency_key": f"pull-{uuid.uuid4().hex}"}
    scan = s.post(f"/api/staging-pull/requests/{sr_id}/scan", FK_H, json=body).json()
    if scan["status"] == "needs_confirm":
        body.update(confirmed=True, idempotency_key=f"pull-{uuid.uuid4().hex}")
        scan = s.post(f"/api/staging-pull/requests/{sr_id}/scan", FK_H, json=body).json()
    assert scan["status"] == "ok", scan
    return scan


def _gun_submit(s, sr_id):
    sub = s.post(f"/api/staging-pull/requests/{sr_id}/submit", FK_H,
                 params={"confirmed": True},
                 json={"staging_location_id": LOC_PROD,
                       "staging_sub_location_id": SUB_STAGING}).json()
    assert sub["status"] == "ok", sub
    return sub


def _item_id(db, sr_id):
    db.expire_all()
    return db.query(StagingRequestItem).filter(StagingRequestItem.request_id == sr_id).one().id


def _lot(db, s):
    db.expire_all()
    return db.query(MaterialLot).filter(MaterialLot.id == s.lots["A"]["lot_id"]).one()


def _units(db, s):
    lot = _lot(db, s)
    return {p.storage_row_id: int(p.full_units) for p in lps.placements_for_lot(db, lot.id)}


@pytest.fixture
def story(client, plant, db_session):
    s = Story(client, db_session)
    # A-0925: truck 1 at 502 on ROW1, truck 2 at 474 on ROW2.
    s.receive_truck("A", VL, BBD, 4, ROW1, weight=A)
    s.receive_truck("A", VL, BBD, 6, ROW2, weight=B)
    return s


# ── B2 ────────────────────────────────────────────────────────────────────────

def test_undo_of_a_fully_used_line_is_refused_and_nothing_is_orphaned(story, db_session):
    s = story
    sr = _request(s, needed=2 * A)
    _gun_pull(s, sr["id"], ROW1, 2)
    sub = _gun_submit(s, sr["id"])
    item_id = _item_id(db_session, sr["id"])
    (si_id,) = sub["staging_item_ids"]
    s.post(f"/api/service/staging-requests/{sr['id']}/items/{item_id}/mark-used", SUP_H,
           json={"staging_item_id": si_id, "quantity": 2 * A})

    r = s.post(f"/api/service/staging-requests/{sr['id']}/items/{item_id}/undo", SUP_H,
               ok=False, json={"to_location_id": LOC})
    assert r.status_code == 400, r.text
    assert "already been used" in r.json()["detail"]

    db_session.expire_all()
    line = db_session.query(StagingRequestItem).filter(StagingRequestItem.id == item_id).one()
    assert line.quantity_fulfilled == pytest.approx(2 * A)
    assert line.status == "fulfilled"
    assert si_id in (line.staging_item_ids or "")


def test_undo_of_a_partly_used_line_returns_only_what_is_left(story, db_session):
    s = story
    sr = _request(s, needed=2 * A)
    _gun_pull(s, sr["id"], ROW1, 2)
    sub = _gun_submit(s, sr["id"])
    item_id = _item_id(db_session, sr["id"])
    (si_id,) = sub["staging_item_ids"]
    s.post(f"/api/service/staging-requests/{sr['id']}/items/{item_id}/mark-used", SUP_H,
           json={"staging_item_id": si_id, "quantity": A})
    assert _units(db_session, s)[ROW1] == 2

    res = s.post(f"/api/service/staging-requests/{sr['id']}/items/{item_id}/undo", SUP_H,
                 json={"to_location_id": LOC}).json()
    assert res["returned_items"] == 1
    # One drum back on its rack; the used one stays booked to the line.
    assert _units(db_session, s)[ROW1] == 3
    db_session.expire_all()
    line = db_session.query(StagingRequestItem).filter(StagingRequestItem.id == item_id).one()
    assert line.quantity_fulfilled == pytest.approx(A)
    assert line.status == "partially_fulfilled"
    si = db_session.query(StagingItem).filter(StagingItem.id == si_id).one()
    assert si.quantity_used == pytest.approx(A)
    assert si.quantity_returned == pytest.approx(A)
    # U3: used + returned == staged is closed.
    assert si.status == "completed"


# ── B3 ────────────────────────────────────────────────────────────────────────

def test_mark_used_of_a_held_lot_is_refused(story, db_session):
    s = story
    sr = _request(s, needed=A)
    _gun_pull(s, sr["id"], ROW1, 1)
    sub = _gun_submit(s, sr["id"])
    item_id = _item_id(db_session, sr["id"])
    (si_id,) = sub["staging_item_ids"]

    lot = _lot(db_session, s)
    lot.is_held = True
    lot.hold_reason = "foreign matter"
    db_session.commit()

    details = s.get(f"/api/service/staging-requests/{sr['id']}/items/{item_id}/staging-details", SUP_H)
    d = details["staging_items"][0]
    assert d["is_held"] is True and "foreign matter" in d["hold_message"]
    assert d["units_staged"] == 1

    r = s.post(f"/api/service/staging-requests/{sr['id']}/items/{item_id}/mark-used", SUP_H,
               ok=False, json={"staging_item_id": si_id, "quantity": 100})
    assert r.status_code == 400
    assert "ON HOLD" in r.json()["detail"] and VL in r.json()["detail"]

    # The Staging Overview twin refuses too.
    r = s.post(f"/api/inventory/staging/{si_id}/mark-used", SUP_H, ok=False,
               json={"quantity": 100})
    assert r.status_code == 400 and "ON HOLD" in r.json()["detail"]
    db_session.expire_all()
    assert db_session.query(StagingItem).filter(StagingItem.id == si_id).one().quantity_used == 0


def test_hold_form_names_containers_on_a_cart_and_in_staging(story, db_session):
    s = story
    sr = _request(s, needed=3 * A)
    _gun_pull(s, sr["id"], ROW1, 1)
    _gun_submit(s, sr["id"])
    _gun_pull(s, sr["id"], ROW1, 1)          # still on the cart

    receipt_id = s.lots["A"]["receipts"][0]
    status = s.get(f"/api/inventory/hold-actions/lot-status/{receipt_id}", WH_H)
    assert status["on_cart_units"] == 1
    assert status["on_cart_qty"] == pytest.approx(A)
    assert status["in_staging_qty"] == pytest.approx(A)


# ── B5 ────────────────────────────────────────────────────────────────────────

def test_desk_stage_prices_racks_by_delivery_and_stages_whole_drums(story, db_session):
    s = story
    lots = s.get("/api/inventory/staging/suggest-lots", WH_H,
                 params={"product_id": PRODUCT, "quantity": 1000})
    (lot,) = lots
    assert lot["available_quantity"] == pytest.approx(4 * A + 6 * B)
    racks = {r["storage_row_id"]: r for r in lot["racks"]}
    assert racks[ROW2]["available_qty"] == pytest.approx(6 * B)
    assert racks[ROW2]["unit_weights"] == [{"units": 6, "weight": B}]

    sr = _request(s, needed=1000)
    item_id = _item_id(db_session, sr["id"])
    # The dialog sends whole drums and their exact weight.
    res = s.post("/api/inventory/staging/transfer", WH_H, json={
        "staging_location_id": LOC_PROD, "staging_sub_location_id": SUB_STAGING,
        "items": [{"product_id": PRODUCT, "quantity_needed": 3 * B, "lots": [
            {"receipt_id": lot["receipt_id"], "quantity": 3 * B,
             "source_row_id": ROW2, "full_units": 3},
        ]}],
        "fulfillments": [{"request_id": sr["id"], "item_id": item_id, "quantity": 3 * B}],
    }).json()
    (si,) = res["staging_items"]
    assert si["quantity_staged"] == pytest.approx(3 * B)
    assert _units(db_session, s)[ROW2] == 3
    db_session.expire_all()
    row = db_session.query(StagingItem).filter(StagingItem.id == si["id"]).one()
    assert row.original_storage_row_id == ROW2
    assert row.pallets_staged == 3


def test_desk_stage_weight_only_books_what_the_drums_really_hold(story, db_session):
    """An old client typing 992 lbs off a 502 rack takes 2 drums: 1,004 lbs."""
    s = story
    (lot,) = s.get("/api/inventory/staging/suggest-lots", WH_H,
                   params={"product_id": PRODUCT, "quantity": 1000})
    res = s.post("/api/inventory/staging/transfer", WH_H, json={
        "staging_location_id": LOC_PROD,
        "items": [{"product_id": PRODUCT, "quantity_needed": 992, "lots": [
            {"receipt_id": lot["receipt_id"], "quantity": 992, "source_row_id": ROW1},
        ]}],
    }).json()
    assert res["staging_items"][0]["quantity_staged"] == pytest.approx(2 * A)


# ── B8 ────────────────────────────────────────────────────────────────────────

def test_staging_overview_all_lists_used_and_returned_items(story, db_session):
    s = story
    sr = _request(s, needed=2 * A)
    _gun_pull(s, sr["id"], ROW1, 2)
    sub = _gun_submit(s, sr["id"])
    item_id = _item_id(db_session, sr["id"])
    (si_id,) = sub["staging_item_ids"]
    s.post(f"/api/service/staging-requests/{sr['id']}/items/{item_id}/mark-used", SUP_H,
           json={"staging_item_id": si_id, "quantity": 2 * A})

    active = s.get("/api/inventory/staging/items", SUP_H)
    everything = s.get("/api/inventory/staging/items", SUP_H, params={"status_filter": "all"})
    assert si_id not in {i["id"] for i in active}
    assert si_id in {i["id"] for i in everything}
    used = s.get("/api/inventory/staging/items", SUP_H, params={"status_filter": "used"})
    assert [i["id"] for i in used] == [si_id]


# ── G1 ────────────────────────────────────────────────────────────────────────

def test_close_out_opens_on_the_production_day(story, db_session):
    s = story
    today = _today_local()
    sr = _request(s, needed=A, production_date=today)
    _gun_pull(s, sr["id"], ROW1, 1)
    sub = _gun_submit(s, sr["id"])
    item_id = _item_id(db_session, sr["id"])
    s.post(f"/api/service/staging-requests/{sr['id']}/items/{item_id}/mark-used", SUP_H,
           json={"staging_item_id": sub["staging_item_ids"][0], "quantity": A})
    res = s.post(f"/api/service/staging-requests/{sr['id']}/close-out", SUP_H).json()
    assert res["status"] == "ok"

    later = _request(s, needed=A, production_date=today + timedelta(days=1))
    r = s.post(f"/api/service/staging-requests/{later['id']}/close-out", SUP_H, ok=False)
    assert r.status_code == 400 and "production day" in r.json()["detail"]


def test_request_local_today_uses_the_warehouse_clock(story, db_session):
    s = story
    db_session.query(Warehouse).filter(Warehouse.id == WH).update({"timezone": "America/Los_Angeles"})
    db_session.commit()
    sr = _request(s, needed=A)
    _gun_pull(s, sr["id"], ROW1, 1)
    _gun_submit(s, sr["id"])
    db_session.expire_all()
    req = db_session.query(StagingRequest).filter(StagingRequest.id == sr["id"]).one()
    # 02:00 UTC on Oct 3 is still Oct 2 in California.
    now = datetime(2026, 10, 3, 2, 0, tzinfo=timezone.utc)
    assert staging_request_service.request_local_today(db_session, req, now=now).isoformat() == "2026-10-02"


# ── G2 / U3 ───────────────────────────────────────────────────────────────────

def test_return_goes_to_any_active_rack_of_the_warehouse(story, db_session):
    s = story
    sr = _request(s, needed=2 * A)
    _gun_pull(s, sr["id"], ROW1, 2)
    sub = _gun_submit(s, sr["id"])
    item_id = _item_id(db_session, sr["id"])
    (si_id,) = sub["staging_item_ids"]
    s.post(f"/api/service/staging-requests/{sr['id']}/items/{item_id}/mark-used", SUP_H,
           json={"staging_item_id": si_id, "quantity": A + 292})

    # Inactive rack: refused.
    db_session.add(StorageRow(id="e2e-dead", name="DEAD", sub_location_id=SUB,
                              barcode="PE2E-dead", pallet_capacity=0, is_active=False))
    # Rack in another warehouse: refused.
    db_session.add(Warehouse(id="wh-other", name="Other", code="OTH", type="owned", is_active=True))
    db_session.add(Location(id="loc-other", name="Other", warehouse_id="wh-other"))
    db_session.add(SubLocation(id="sub-other", name="Other room", location_id="loc-other"))
    db_session.add(StorageRow(id="e2e-other", name="FAR", sub_location_id="sub-other",
                              barcode="PE2E-far", pallet_capacity=0, is_active=True))
    db_session.commit()
    base = {"staging_item_id": si_id, "quantity": 210.0, "to_location_id": LOC,
            "full_units": 0, "weighed_partial_qty": 210.0}
    url = f"/api/service/staging-requests/{sr['id']}/items/{item_id}/return"
    r = s.post(url, SUP_H, ok=False, json={**base, "to_storage_row_id": "e2e-dead"})
    assert r.status_code == 400 and "not active" in r.json()["detail"]
    r = s.post(url, SUP_H, ok=False, json={**base, "to_storage_row_id": "e2e-other"})
    assert r.status_code == 400 and "different warehouse" in r.json()["detail"]

    # A different rack than the one it came off (ROW1): ROW3.
    s.post(url, SUP_H, json={**base, "to_storage_row_id": ROW3})
    lot = _lot(db_session, s)
    p3 = [p for p in lps.placements_for_lot(db_session, lot.id) if p.storage_row_id == ROW3]
    assert p3 and p3[0].open_units == 1 and p3[0].open_remaining_qty == pytest.approx(210.0)
    si = db_session.query(StagingItem).filter(StagingItem.id == si_id).one()
    assert si.status == "completed"


# ── U2 ────────────────────────────────────────────────────────────────────────

def test_lot_trace_gun_pull_has_a_date_and_every_rack(story, db_session):
    s = story
    sr = _request(s, needed=2 * A)
    _gun_pull(s, sr["id"], ROW1, 1)
    _gun_pull(s, sr["id"], ROW2, 1)
    sub = _gun_submit(s, sr["id"])
    item_id = _item_id(db_session, sr["id"])
    (si_id,) = sub["staging_item_ids"]
    s.post(f"/api/service/staging-requests/{sr['id']}/items/{item_id}/return", SUP_H, json={
        "staging_item_id": si_id, "quantity": B, "to_location_id": LOC,
        "to_storage_row_id": ROW3, "full_units": 1, "weighed_partial_qty": 0,
    })

    trace = s.get("/api/reports/lot-trace", params={"lot_number": VL})
    (entry,) = trace["receipts"]
    events = entry["timeline"]
    pull = next(e for e in events if e["event_type"] == "staging")
    assert pull["date"] is not None
    assert sorted(r["row"] for r in pull["from_rows"]) == ["ROW 1", "ROW 2"]
    assert "Drum Room" in (pull["from_location"] or "")
    # Sorted after the deliveries, not above them.
    assert events.index(pull) > max(
        i for i, e in enumerate(events) if e["event_type"] == "received")
    ret = next(e for e in events if (e.get("notes") or "").startswith("Returned from staging"))
    assert [r["row"] for r in ret["to_rows"]] == ["ROW 3"]

    # The staging details list both origins too.
    details = s.get(f"/api/service/staging-requests/{sr['id']}/items/{item_id}/staging-details", SUP_H)
    origins = {o["storage_row_id"]: o["units"] for o in details["staging_items"][0]["origin_rows"]}
    assert origins == {ROW1: 1, ROW2: 1}


# ── follow-up: whole-drum return on a mixed-weight lot ────────────────────────

def test_whole_drum_return_on_a_mixed_lot_adds_up(story, db_session):
    """A 502 drum pulled while the lot's carrier receipt is the 474 truck came
    back as "does not add up" (1 × 474 != 502). The split is now checked at the
    staged drums' own weight."""
    s = story
    sr = _request(s, needed=A)
    _gun_pull(s, sr["id"], ROW1, 1)
    sub = _gun_submit(s, sr["id"])
    item_id = _item_id(db_session, sr["id"])
    (si_id,) = sub["staging_item_ids"]
    details = s.get(f"/api/service/staging-requests/{sr['id']}/items/{item_id}/staging-details", SUP_H)
    assert details["staging_items"][0]["weight_per_unit"] == pytest.approx(A)
    before = _units(db_session, s).get(ROW1, 0)
    s.post(f"/api/service/staging-requests/{sr['id']}/items/{item_id}/return", SUP_H, json={
        "staging_item_id": si_id, "quantity": A, "to_storage_row_id": ROW1,
        "full_units": 1, "weighed_partial_qty": 0,
    })
    assert _units(db_session, s)[ROW1] == before + 1


# ── G5 ────────────────────────────────────────────────────────────────────────

def test_adjustments_report_has_the_recipient(story, db_session):
    s = story
    receipt_id = s.lots["A"]["receipts"][0]
    db_session.add(InventoryAdjustment(
        id="adj-don-1", receipt_id=receipt_id, product_id=PRODUCT, warehouse_id=WH,
        adjustment_type="donation", quantity=A, reason="gift", recipient="QA Food Bank",
        status="approved", approved_at=datetime.now(timezone.utc),
    ))
    db_session.commit()
    rep = s.get("/api/reports/adjustments", params={"adjustment_type": "donation"})
    assert [r["recipient"] for r in rep["rows"]] == ["QA Food Bank"]
