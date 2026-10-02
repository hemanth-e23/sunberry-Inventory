"""Browser test PART 4 (2026-10-02): counts.

- a supervisor's count applies at once and the books follow it (Lot Trace,
  Activity Ledger, Snapshot read the receipts' paper — a −1 bag recount was
  invisible to them)
- a warehouse user's count waits for a supervisor (owner's decision)
- "found" stock with no receipt becomes a receipt so the forms and reports
  see it (B-FOUND was invisible)
- an opened container cannot hold more than a full one
"""
import pytest

from app.models import InventoryAdjustment, LotPlacement, MaterialLot, Receipt
from tests.test_e2e_barrel_lifecycle import (  # noqa: F401  (fixtures)
    PRODUCT, ROW1, ROW2, ROW3, SUP_H, VENDOR, WH_H, Story, plant,
)

A = 502.0
VL = "A-0925"


def _setup(client, db):
    s = Story(client, db)
    s.receive_truck("A", VL, "2027-03-01", 6, ROW1, weight=A)
    return s


def _paper(s):
    s.db.expire_all()
    return round(sum(float(r.quantity or 0) for r in s.lot_receipts("A")), 3)


def _units(s, row):
    s.db.expire_all()
    p = s.db.query(LotPlacement).filter(
        LotPlacement.material_lot_id == s.lots["A"]["lot_id"],
        LotPlacement.storage_row_id == row).first()
    return int(p.full_units) if p else 0


def test_supervisor_recount_applies_and_the_books_follow(client, plant, db_session):
    s = _setup(client, db_session)
    r = s.post("/api/lot-cutover/count", SUP_H, json={
        "material_lot_id": s.lots["A"]["lot_id"], "storage_row_id": ROW1, "full_units": 5,
    }).json()
    assert r["variance"] == -1 and not r.get("pending")
    assert _units(s, ROW1) == 5
    assert _paper(s) == pytest.approx(5 * A)
    adj = db_session.query(InventoryAdjustment).filter(
        InventoryAdjustment.reason.like("Count on%")).one()
    assert adj.quantity == pytest.approx(A) and adj.status == "approved"
    trace = s.get("/api/reports/lot-trace", SUP_H, params={"lot_number": VL})
    assert sum(e["current_quantity"] for e in trace["receipts"]) == pytest.approx(5 * A)

    # Found one more: credited back.
    s.post("/api/lot-cutover/count", SUP_H, json={
        "material_lot_id": s.lots["A"]["lot_id"], "storage_row_id": ROW1, "full_units": 7,
    })
    assert _paper(s) == pytest.approx(7 * A)


def test_warehouse_count_waits_for_a_supervisor(client, plant, db_session):
    s = _setup(client, db_session)
    r = s.post("/api/lot-cutover/count", WH_H, json={
        "material_lot_id": s.lots["A"]["lot_id"], "storage_row_id": ROW1, "full_units": 4,
    }).json()
    assert r["pending"] is True and r["variance"] == -2
    assert _units(s, ROW1) == 6 and _paper(s) == pytest.approx(6 * A)   # nothing moved yet

    pending = s.get("/api/lot-cutover/count-requests", SUP_H)
    assert [p["id"] for p in pending] == [r["request_id"]]
    # Warehouse users cannot approve.
    assert s.post(f"/api/lot-cutover/count-requests/{r['request_id']}/approve", WH_H,
                  ok=False).status_code == 403
    s.post(f"/api/lot-cutover/count-requests/{r['request_id']}/approve", SUP_H)
    assert _units(s, ROW1) == 4 and _paper(s) == pytest.approx(4 * A)
    assert s.get("/api/lot-cutover/count-requests", SUP_H) == []


def test_found_stock_becomes_a_receipt_the_forms_can_see(client, plant, db_session):
    s = Story(client, db_session)
    r = s.post("/api/lot-cutover/opening-balance", SUP_H, json={
        "product_id": PRODUCT, "storage_row_id": ROW3, "full_units": 1,
        "vendor_id": VENDOR, "vendor_lot": "B-FOUND", "bbd": "2027-05-01",
        "unit_label": "drum", "weight_per_unit": 474, "weight_unit": "lbs",
    }).json()
    db_session.expire_all()
    rec = db_session.query(Receipt).filter(Receipt.material_lot_id == r["material_lot_id"]).one()
    assert rec.status == "approved" and rec.quantity == pytest.approx(474)
    entries = [e for e in s.form_entries() if e["lotNumber"] == "B-FOUND"]
    assert len(entries) == 1 and entries[0]["rowId"] == ROW3
    assert entries[0]["available"] == pytest.approx(474)


def test_an_open_container_cannot_hold_more_than_a_full_one(client, plant, db_session):
    s = _setup(client, db_session)
    r = s.post("/api/lot-cutover/count", SUP_H, ok=False, json={
        "material_lot_id": s.lots["A"]["lot_id"], "storage_row_id": ROW1,
        "full_units": 5, "open_units": 1, "open_remaining_qty": 610,
    })
    assert r.status_code == 400 and "more than full" in r.json()["detail"]
