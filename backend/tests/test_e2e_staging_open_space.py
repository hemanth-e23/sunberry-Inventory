"""The plant's temporary staging (2026-10-01 PART 2, G1) and per-rack asks (B1).

Way 2 of staging, as the warehouse does it today: drums go by TRANSFER to a
staging room that has no racks, and next day an adjustment "Used in
Production" writes them off from that staging area. The room has no rack, so
the transfer used to submit fine and could never be approved (no destination
rack), while it reserved the stock.
"""
import pytest

from app.models import StorageRow
from tests.test_e2e_barrel_lifecycle import (  # noqa: F401  (fixtures)
    LOC, LOC_PROD, PRODUCT, ROW1, ROW2, SUB, SUB_STAGING, SUP_H, W, WH_H,
    Story, plant,
)

VL = "A-0925"


def _transfer_to_staging(s, carrier_id, row, drums):
    lbs = drums * W
    return s.post("/api/inventory/transfers", WH_H, ok=False, json={
        "receipt_id": carrier_id, "to_location_id": LOC_PROD,
        "to_sub_location_id": SUB_STAGING, "quantity": lbs,
        "reason": "to staging for tomorrow", "transfer_type": "warehouse-transfer",
        "source_breakdown": [{"id": f"row-{row}", "quantity": lbs}],
    })


def test_staging_floor_then_next_day_used_in_production(client, plant, db_session):
    s = Story(client, db_session)
    s.receive_truck("A", VL, "2027-03-01", 10, ROW1)
    carrier = s.lot_receipts("A")[-1]

    r = _transfer_to_staging(s, carrier.id, ROW1, 4)
    assert r.status_code == 200, r.text
    s.post(f"/api/inventory/transfers/{r.json()['id']}/approve", SUP_H)

    # The staging room now has its one open-space row, holding the 4 drums.
    db_session.expire_all()
    (floor,) = db_session.query(StorageRow).filter(
        StorageRow.sub_location_id == SUB_STAGING, StorageRow.is_active.isnot(False)).all()
    entries = {e["rowId"]: e for e in s.form_entries() if e["lotNumber"] == VL}
    assert entries[floor.id]["available"] == pytest.approx(4 * W)
    assert entries[ROW1]["available"] == pytest.approx(6 * W)

    # A second move to staging reuses that row — no second "rack".
    r = _transfer_to_staging(s, carrier.id, ROW1, 1)
    assert r.status_code == 200, r.text
    s.post(f"/api/inventory/transfers/{r.json()['id']}/approve", SUP_H)
    db_session.expire_all()
    assert db_session.query(StorageRow).filter(
        StorageRow.sub_location_id == SUB_STAGING).count() == 1

    # Next day: Used in Production, picked from the staging area.
    adj = s.post("/api/inventory/adjustments", WH_H, json={
        "receipt_id": entries[floor.id]["receiptId"], "product_id": PRODUCT,
        "category_id": "cat-e2e-raw", "adjustment_type": "used-in-production",
        "quantity": 5 * W, "reason": "batch 1",
        "source_breakdown": [{"id": f"row-{floor.id}", "quantity": 5 * W}],
    }).json()
    s.post(f"/api/inventory/adjustments/{adj['id']}/approve", SUP_H)
    db_session.expire_all()
    left = {e["rowId"]: e["available"] for e in s.form_entries() if e["lotNumber"] == VL}
    assert floor.id not in left            # staging area emptied
    assert left[ROW1] == pytest.approx(5 * W)
    paper = sum(float(x.quantity or 0) for x in s.lot_receipts("A"))
    assert paper == pytest.approx(5 * W)   # books follow the racks


def test_room_with_racks_but_none_picked_is_refused_at_submit(client, plant, db_session):
    s = Story(client, db_session)
    s.receive_truck("A", VL, "2027-03-01", 4, ROW1)
    carrier = s.lot_receipts("A")[-1]
    r = s.post("/api/inventory/transfers", WH_H, ok=False, json={
        "receipt_id": carrier.id, "to_location_id": LOC, "to_sub_location_id": SUB,
        "quantity": W, "reason": "x", "transfer_type": "warehouse-transfer",
        "source_breakdown": [{"id": f"row-{ROW1}", "quantity": W}],
    })
    assert r.status_code == 400
    assert "pick the rack" in r.json()["detail"].lower()


def test_asking_a_rack_for_more_than_it_has_free_is_refused(client, plant, db_session):
    """B1: 4 free on ROW1 (3 more promised to a pending transfer) — 5 is refused
    with the rack, the count and why, even though the LOT has plenty."""
    s = Story(client, db_session)
    s.receive_truck("A", VL, "2027-03-01", 7, ROW1)
    s.receive_truck("A", VL, "2027-03-01", 10, ROW2)
    s.submit_transfer("A", ROW1, ROW2, 3)            # pending: 3 of ROW1's 7
    r = s.submit_transfer("A", ROW1, ROW2, 5, ok=False)
    assert r.status_code == 400, r.text
    detail = r.json()["detail"]
    assert "4 free" in detail and "5" in detail and "pending" in detail, detail
    ok = s.submit_transfer("A", ROW1, ROW2, 4, ok=False)
    assert ok.status_code == 200, ok.text
