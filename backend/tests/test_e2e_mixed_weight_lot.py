"""One lot, two drum weights — rack pounds follow each delivery (2026-10-01).

A-0925 arrived on truck 1 at 502 lb/drum and on truck 2 at 474. Lot totals were
always exact (each receipt keeps its own weight); racks priced every drum at the
first delivery's 502, so a rack of nine 474s read 4,518 lb instead of 4,266 and
the forms converted typed drums with the wrong figure.

The chosen rule: each rack follows its deliveries (rebuilt from the placement
ledger); anything that removes drums without naming them takes the OLDEST
delivery first; a return brings back what was just pulled. After every step:
racks priced exactly, and Σ receipt lbs == racked lbs + staged lbs.
"""
import uuid

import pytest

from app.models import LotPlacement, MaterialLot, Receipt, StagingItem
from app.services import lot_placement_service as lps
from tests.test_e2e_barrel_lifecycle import (  # noqa: F401  (fixtures)
    FK_H, LOC, LOC_PROD, PRODUCT, ROW1, ROW2, ROW3, SID, SUB, SUB_STAGING,
    SUP_H, WH, WH_H, Story, build_entries_for_product, plant,
)

A, B = 502.0, 474.0
VL = "A-0925"
BBD = "2027-03-01"


def _lot(db, s):
    db.expire_all()
    return db.query(MaterialLot).filter(MaterialLot.id == s.lots["A"]["lot_id"]).one()


def _rack_lbs(db, s):
    lot = _lot(db, s)
    return {
        p.storage_row_id: round(lps.derived_weight(lot, p), 2)
        for p in lps.placements_for_lot(db, lot.id)
    }


def _paper(db, s):
    return round(sum(
        float(r.quantity or 0)
        for r in db.query(Receipt).filter(Receipt.material_lot_id == s.lots["A"]["lot_id"]).all()
    ), 2)


def _staged(db):
    return round(sum(
        float(i.quantity_staged or 0) - float(i.quantity_used or 0) - float(i.quantity_returned or 0)
        for i in db.query(StagingItem).filter(
            StagingItem.status.in_(("staged", "partially_used", "partially_returned"))
        ).all()
    ), 2)


def _balanced(db, s, step):
    racks = sum(_rack_lbs(db, s).values())
    assert abs(_paper(db, s) - (racks + _staged(db))) < 0.05, (
        f"{step}: paper {_paper(db, s)} != racks {racks} + staged {_staged(db)}")


def _entry(s, row):
    found = [e for e in s.form_entries() if e["lotNumber"] == VL and e["rowId"] == row]
    assert len(found) == 1, found
    return found[0]


def test_racks_follow_each_delivery(client, plant, db_session):
    s = Story(client, db_session)
    s.receive_truck("A", VL, BBD, 10, ROW1, weight=A)
    s.receive_truck("A", VL, BBD, 9, ROW2, weight=B)
    assert _rack_lbs(db_session, s) == {ROW1: 10 * A, ROW2: 9 * B}
    _balanced(db_session, s, "received")

    # The projection carries the rack's own weight per drum for the forms.
    carrier = next(r for r in s.lot_receipts("A") if r.raw_material_row_allocations)
    per_row = {a["rowId"]: a["weightPerUnit"] for a in carrier.raw_material_row_allocations}
    assert per_row == {ROW1: A, ROW2: B}

    # Rack card (master data live rows) prices the same way.
    subs = {x["id"]: x for x in s.get("/api/master-data/sub-locations")}
    rows = {r["id"]: r for r in subs[SUB]["rows"]}
    assert round(rows[ROW2]["live_lots"][0]["weight"], 2) == 9 * B

    # Move 3 of the 474s ROW2 -> ROW3: typed as 3 drums at that rack's weight.
    tid = s.post("/api/inventory/transfers", WH_H, json={
        "receipt_id": carrier.id, "to_location_id": LOC, "to_sub_location_id": SUB,
        "quantity": 3 * B, "reason": "move", "transfer_type": "warehouse-transfer",
        "source_breakdown": [{"id": f"row-{ROW2}", "quantity": 3 * B}],
        "destination_breakdown": [{"id": f"row-{ROW3}", "quantity": 3 * B}],
    }).json()["id"]
    s.post(f"/api/inventory/transfers/{tid}/approve", SUP_H)
    assert _rack_lbs(db_session, s) == {ROW1: 10 * A, ROW2: 6 * B, ROW3: 3 * B}
    _balanced(db_session, s, "moved 474s")

    # Move 2 of the 502s onto ROW3 — now a MIXED rack (3×474 + 2×502).
    tid = s.post("/api/inventory/transfers", WH_H, json={
        "receipt_id": carrier.id, "to_location_id": LOC, "to_sub_location_id": SUB,
        "quantity": 2 * A, "reason": "move", "transfer_type": "warehouse-transfer",
        "source_breakdown": [{"id": f"row-{ROW1}", "quantity": 2 * A}],
        "destination_breakdown": [{"id": f"row-{ROW3}", "quantity": 2 * A}],
    }).json()["id"]
    s.post(f"/api/inventory/transfers/{tid}/approve", SUP_H)
    assert _rack_lbs(db_session, s) == {ROW1: 8 * A, ROW2: 6 * B, ROW3: 3 * B + 2 * A}
    _balanced(db_session, s, "mixed rack")

    # Write off 2 drums from the mixed rack, typed at the rack's average: the
    # OLDEST delivery (truck 1, 502s) leaves first, and the paper drops by the
    # real 1,004 lb, not 2 × average.
    e = _entry(s, ROW3)
    db_session.expire_all()
    carrier = next(r for r in s.lot_receipts("A") if r.raw_material_row_allocations)
    rack_w = next(a["weightPerUnit"] for a in carrier.raw_material_row_allocations
                  if a["rowId"] == ROW3)
    assert rack_w == pytest.approx((3 * B + 2 * A) / 5, abs=0.01)
    typed = round(2 * rack_w, 3)   # what the form sends for "2 drums"
    adj = s.post("/api/inventory/adjustments", WH_H, json={
        "receipt_id": e["receiptId"], "product_id": PRODUCT, "category_id": "cat-e2e-raw",
        "adjustment_type": "damage-reduction", "quantity": typed, "reason": "leak",
        "source_breakdown": [{"id": f"row-{ROW3}", "quantity": typed}],
    }).json()
    s.post(f"/api/inventory/adjustments/{adj['id']}/approve", SUP_H)
    assert _rack_lbs(db_session, s) == {ROW1: 8 * A, ROW2: 6 * B, ROW3: 3 * B}
    _balanced(db_session, s, "write-off from mixed rack")

    # Staging pull of 2 drums from ROW2 (474s): staged at 948, not 1,004.
    sr = s.post("/api/service/staging-requests", SUP_H, json={
        "production_batch_uid": "PB-MIX-1", "product_name": "Nectar",
        "production_date": "2026-10-02",
        "items": [{"sid": SID, "ingredient_name": "Mango", "quantity_needed": 900, "unit": "lbs"}],
    }).json()
    detail = s.get(f"/api/staging-pull/requests/{sr['id']}", FK_H)
    item_id = detail["items"][0]["id"]
    scan = s.post(f"/api/staging-pull/requests/{sr['id']}/scan", FK_H, json={
        "code": s.lots["A"]["lot_code"], "storage_row_id": ROW2, "units": 2,
        "idempotency_key": f"pull-{uuid.uuid4().hex}",
    }).json()
    if scan["status"] == "needs_confirm":
        scan = s.post(f"/api/staging-pull/requests/{sr['id']}/scan", FK_H, json={
            "code": s.lots["A"]["lot_code"], "storage_row_id": ROW2, "units": 2,
            "idempotency_key": f"pull-{uuid.uuid4().hex}", "confirmed": True,
        }).json()
    assert scan["status"] == "ok", scan
    assert round(scan["quantity"], 2) == 2 * B
    sub = s.post(f"/api/staging-pull/requests/{sr['id']}/submit", FK_H,
                 json={"staging_location_id": LOC_PROD,
                       "staging_sub_location_id": SUB_STAGING}).json()
    assert sub["status"] == "ok", sub
    assert _staged(db_session) == 2 * B
    assert _rack_lbs(db_session, s)[ROW2] == 4 * B
    _balanced(db_session, s, "staged")

    # Production availability prices racks the same way.
    res = s.post("/api/service/check-availability", SUP_H, json={
        "items": [{"sid": SID, "quantity_needed": 1}], "warehouse_id": WH,
    }).json()["items"][0]
    assert abs(float(res["on_hand"]) - sum(_rack_lbs(db_session, s).values())) < 0.05

    # Production uses one drum's worth; the other drum comes back to ROW1.
    # A return brings back what was just pulled — a 474 — so ROW1 becomes
    # 8×502 + 1×474, and the books still balance.
    (si,) = db_session.query(StagingItem).filter(
        StagingItem.id.in_(sub["staging_item_ids"])).all()
    s.post(f"/api/service/staging-requests/{sr['id']}/items/{item_id}/mark-used", SUP_H,
           json={"staging_item_id": si.id, "quantity": B})
    s.post(f"/api/service/staging-requests/{sr['id']}/items/{item_id}/return", SUP_H, json={
        "staging_item_id": si.id, "quantity": B,
        "to_location_id": LOC, "to_sub_location_id": SUB, "to_storage_row_id": ROW1,
        "full_units": 1, "weighed_partial_qty": 0,
    })
    assert _staged(db_session) == 0
    assert _rack_lbs(db_session, s)[ROW1] == 8 * A + B
    _balanced(db_session, s, "used + returned")
