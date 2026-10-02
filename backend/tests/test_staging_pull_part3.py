"""Gun staging pull — browser test PART 3 findings (2026-10-02).

B1  a non-FEFO pull crashed with a 500 (strftime on a 'YYYY-MM-DD' string), so
    the "pull this one anyway?" prompt could never appear.
B3  a lot that went ON HOLD while its drums were on the cart was staged with
    no warning; submit must stop for those units, and one press puts them back.
U1  the gun shows containers (drums/bags), not just pounds; held lots say so.
"""
import uuid

from app.models import LotPlacement, MaterialLot, Receipt, StagingItem
from app.services import staging_pull_service as sps
from tests.test_e2e_barrel_lifecycle import (  # noqa: F401  (fixtures)
    BBD_A, BBD_B, FK_H, LOC_PROD, LOT_A_VENDOR_LOT, LOT_B_VENDOR_LOT, ROW1,
    ROW2, SID, SUB_STAGING, SUP_H, Story, plant,
)


def _setup(client, db):
    s = Story(client, db)
    s.receive_truck("A", LOT_A_VENDOR_LOT, BBD_A, 4, ROW1)   # FEFO lot
    s.receive_truck("B", LOT_B_VENDOR_LOT, BBD_B, 3, ROW2)   # later BBD
    sr = s.post("/api/service/staging-requests", SUP_H, json={
        "production_batch_uid": "PB-P3-1", "product_name": "Nectar",
        "production_date": "2026-10-03",
        "items": [{"sid": SID, "ingredient_name": "Mango Puree",
                   "quantity_needed": 3000, "unit": "lbs"}],
    }).json()
    return s, sr["id"]


def _scan(s, req_id, code, row, key=None, **extra):
    return s.post(f"/api/staging-pull/requests/{req_id}/scan", FK_H, json={
        "code": code, "storage_row_id": row, "units": extra.pop("units", 1),
        "idempotency_key": key or f"pull-{uuid.uuid4().hex}", **extra,
    }).json()


def _units_on(db, lot_id, row):
    db.expire_all()
    p = db.query(LotPlacement).filter(
        LotPlacement.material_lot_id == lot_id, LotPlacement.storage_row_id == row,
    ).first()
    return int(p.full_units or 0) if p else 0


def test_non_fefo_pull_asks_then_pulls_with_the_same_key(client, plant, db_session):
    s, req_id = _setup(client, db_session)
    code_b = s.lots["B"]["lot_code"]

    key = f"pull-{uuid.uuid4().hex}"
    first = _scan(s, req_id, code_b, ROW2, key=key)
    # Used to be a 500 — AttributeError: 'str' object has no attribute 'strftime'.
    assert first["status"] == "needs_confirm", first
    assert first["warning"] == "not_fefo_lot"
    assert LOT_A_VENDOR_LOT in first["message"]
    assert "03/01/2027" in first["message"]            # plain MM/DD/YYYY
    assert "ROW 1" in first["message"]                  # where the older lot is
    assert f"Pull lot {LOT_B_VENDOR_LOT} anyway?" in first["message"]
    assert _units_on(db_session, s.lots["B"]["lot_id"], ROW2) == 3   # nothing written

    yes = _scan(s, req_id, code_b, ROW2, key=key, allow_mismatch=True)
    assert yes["status"] == "ok", yes
    assert yes["message"] == f"1 drum of lot {LOT_B_VENDOR_LOT} pulled."
    assert yes["unit_label"] == "drum"
    assert _units_on(db_session, s.lots["B"]["lot_id"], ROW2) == 2

    # A replay of the same key is the original answer, not a second drum.
    again = _scan(s, req_id, code_b, ROW2, key=key, allow_mismatch=True)
    assert again["status"] == "ok"
    assert _units_on(db_session, s.lots["B"]["lot_id"], ROW2) == 2


def test_detail_speaks_in_containers(client, plant, db_session):
    s, req_id = _setup(client, db_session)
    ok = _scan(s, req_id, s.lots["A"]["lot_code"], ROW1, units=2)
    assert ok["status"] == "ok", ok
    assert ok["message"] == f"2 drums of lot {LOT_A_VENDOR_LOT} pulled."

    detail = s.get(f"/api/staging-pull/requests/{req_id}", FK_H)
    assert detail["production_date"] == "2026-10-03"
    (item,) = detail["items"]
    assert item["unit_label"] == "drum"
    assert item["pending_units"] == [{"unit_label": "drum", "units": 2, "open_units": 0}]
    (line,) = item["cart_lots"]
    assert line["lot_name"] == LOT_A_VENDOR_LOT and line["units"] == 2
    assert {lot["lot_code"] for lot in item["lots"]} == {
        s.lots["A"]["lot_code"], s.lots["B"]["lot_code"]}
    assert item["held_lots"] == []
    assert item["suggestion"]["lot_code"] == s.lots["A"]["lot_code"]

    # The rack picker's fill names its containers (B9: "15 units here").
    fill = {r["storage_row_id"]: r for r in s.get("/api/lot-receiving/rack-fill", FK_H)["rows"]}
    assert fill[ROW1]["units"] == 2
    assert fill[ROW1]["by_unit"] == [{"unit_label": "drum", "units": 2}]

    listed = {r["id"]: r for r in s.get("/api/staging-pull/requests", FK_H)}
    assert listed[req_id]["unit"] == "lbs"
    assert listed[req_id]["production_date"] == "2026-10-03"


def test_lot_held_while_on_cart_is_not_staged(client, plant, db_session):
    s, req_id = _setup(client, db_session)
    ok = _scan(s, req_id, s.lots["A"]["lot_code"], ROW1, units=2)
    assert ok["status"] == "ok", ok
    assert _units_on(db_session, s.lots["A"]["lot_id"], ROW1) == 2

    # QA holds lot A with two of its drums on the cart.
    lot = db_session.query(MaterialLot).filter(MaterialLot.id == s.lots["A"]["lot_id"]).one()
    lot.is_held = True
    lot.hold_reason = "foreign matter"
    for r in db_session.query(Receipt).filter(Receipt.material_lot_id == lot.id).all():
        r.hold = True
    db_session.commit()

    # The line says ON HOLD rather than just losing its FEFO hint.
    (item,) = s.get(f"/api/staging-pull/requests/{req_id}", FK_H)["items"]
    assert [h["lot_name"] for h in item["held_lots"]] == [LOT_A_VENDOR_LOT]
    assert item["held_lots"][0]["hold_reason"] == "foreign matter"
    assert item["cart_lots"][0]["is_held"] is True

    sub = s.post(f"/api/staging-pull/requests/{req_id}/submit", FK_H, json={
        "staging_location_id": LOC_PROD, "staging_sub_location_id": SUB_STAGING,
    }, params={"confirmed": True}).json()
    assert sub["status"] == "lot_held", sub
    assert "ON HOLD (foreign matter)" in sub["message"]
    assert "2 drums" in sub["message"] and "ROW 1" in sub["message"]
    assert sub["held_lots"][0]["units"] == 2
    db_session.expire_all()
    assert db_session.query(StagingItem).count() == 0

    back = s.post(f"/api/staging-pull/requests/{req_id}/return-held", FK_H).json()
    assert back["status"] == "returned", back
    assert "2 drums of lot" in back["message"] and "still on hold" in back["message"]
    assert _units_on(db_session, s.lots["A"]["lot_id"], ROW1) == 4

    again = s.post(f"/api/staging-pull/requests/{req_id}/return-held", FK_H).json()
    assert again["status"] == "nothing_held"
    sub = s.post(f"/api/staging-pull/requests/{req_id}/submit", FK_H, json={
        "staging_location_id": LOC_PROD,
    }, params={"confirmed": True}).json()
    assert sub["status"] == "nothing_to_submit", sub


def test_held_lot_does_not_block_the_rest_of_the_cart(client, plant, db_session):
    s, req_id = _setup(client, db_session)
    assert _scan(s, req_id, s.lots["A"]["lot_code"], ROW1, units=4)["status"] == "ok"
    b = _scan(s, req_id, s.lots["B"]["lot_code"], ROW2, allow_mismatch=True)
    assert b["status"] == "ok", b

    lot = db_session.query(MaterialLot).filter(MaterialLot.id == s.lots["B"]["lot_id"]).one()
    lot.is_held = True
    db_session.commit()

    sub = s.post(f"/api/staging-pull/requests/{req_id}/submit", FK_H, json={
        "staging_location_id": LOC_PROD}, params={"confirmed": True}).json()
    assert sub["status"] == "lot_held"
    assert [h["lot_name"] for h in sub["held_lots"]] == [LOT_B_VENDOR_LOT]

    s.post(f"/api/staging-pull/requests/{req_id}/return-held", FK_H)
    sub = s.post(f"/api/staging-pull/requests/{req_id}/submit", FK_H, json={
        "staging_location_id": LOC_PROD}, params={"confirmed": True}).json()
    assert sub["status"] == "ok", sub
    db_session.expire_all()
    (si,) = db_session.query(StagingItem).all()
    assert si.pallets_staged == 4
    assert _units_on(db_session, s.lots["B"]["lot_id"], ROW2) == 3

    # The staged drums show on the line as containers too.
    (item,) = s.get(f"/api/staging-pull/requests/{req_id}", FK_H)["items"]
    assert item["staged_units"] == [{"unit_label": "drum", "units": 4, "open_units": 0}]


def test_unit_words():
    assert sps._unit_word("box", 6) == "6 boxes"
    assert sps._unit_word("bag", 1) == "1 bag"
    assert sps._unit_word("drum", 2) == "2 drums"
    assert sps._unit_word("bags", 3) == "3 bags"
    assert sps._show_day("2027-03-01") == "03/01/2027"
    assert sps._show_day(None) is None
