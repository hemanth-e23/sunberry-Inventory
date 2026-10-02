"""Browser test PART 3 (2026-10-01): adjustments and container-stated requests.

B4  a part of a drum can be written off (opens a sealed drum if needed)
B5  requests stated in drums are priced at what THOSE drums weigh, so a rack
    mixing 474s and 502s approves, and approver and books see the same lbs
B6  an adjustment asking a rack for more than it has is refused at submit;
    a product that doesn't match the receipt is refused
B10 a pending adjustment holds its drums back from other requests
"""
import pytest

from app.models import LotPlacement, MaterialLot, Receipt
from app.services import lot_placement_service as lps
from tests.test_e2e_barrel_lifecycle import (  # noqa: F401  (fixtures)
    LOC, PRODUCT, ROW1, ROW2, ROW3, SUB, SUP_H, WH_H, Story, plant,
)

A, B = 502.0, 474.0
VL = "A-0925"
CAT = "cat-e2e-raw"


def _mixed_rack(client, db):
    """ROW3 holds 2×502 (truck 1, oldest) and 3×474 (truck 2)."""
    s = Story(client, db)
    s.receive_truck("A", VL, "2027-03-01", 2, ROW3, weight=A)
    s.receive_truck("A", VL, "2027-03-01", 3, ROW3, weight=B)
    carrier = next(r for r in s.lot_receipts("A") if r.raw_material_row_allocations)
    return s, carrier


def _paper(s):
    s.db.expire_all()
    return round(sum(float(r.quantity or 0) for r in s.lot_receipts("A")), 3)


def _rack(s, row):
    s.db.expire_all()
    lot = s.db.query(MaterialLot).filter(MaterialLot.id == s.lots["A"]["lot_id"]).one()
    p = s.db.query(LotPlacement).filter(
        LotPlacement.material_lot_id == lot.id, LotPlacement.storage_row_id == row).one()
    return int(p.full_units), int(p.open_units), round(float(p.open_remaining_qty), 3), \
        round(lps.derived_weight(lot, p), 3)


def test_transfer_stated_in_drums_on_a_mixed_rack_approves_at_exact_lbs(client, plant, db_session):
    s, carrier = _mixed_rack(client, db_session)
    r = s.post("/api/inventory/transfers", WH_H, json={
        "receipt_id": carrier.id, "to_location_id": LOC, "to_sub_location_id": SUB,
        "quantity": 3 * 485.2, "reason": "x", "transfer_type": "warehouse-transfer",
        "source_breakdown": [{"id": f"row-{ROW3}", "quantity": 3 * 485.2, "units": 3}],
        "destination_breakdown": [{"id": f"row-{ROW1}", "quantity": 3 * 485.2}],
    }).json()
    # Oldest delivery first: 2×502 + 1×474.
    assert r["quantity"] == pytest.approx(2 * A + B)
    s.post(f"/api/inventory/transfers/{r['id']}/approve", SUP_H)
    assert _rack(s, ROW1)[0] == 3 and _rack(s, ROW1)[3] == pytest.approx(2 * A + B)
    assert _rack(s, ROW3)[3] == pytest.approx(2 * B)


def test_writeoff_stated_in_drums_books_what_was_approved(client, plant, db_session):
    s, carrier = _mixed_rack(client, db_session)
    before = _paper(s)
    adj = s.post("/api/inventory/adjustments", WH_H, json={
        "receipt_id": carrier.id, "product_id": PRODUCT, "category_id": CAT,
        "adjustment_type": "damage-reduction", "quantity": 3 * 485.2, "reason": "leak",
        "source_breakdown": [{"id": f"row-{ROW3}", "quantity": 3 * 485.2, "units": 3}],
    }).json()
    assert adj["quantity"] == pytest.approx(2 * A + B)   # what the approver sees
    s.post(f"/api/inventory/adjustments/{adj['id']}/approve", SUP_H)
    assert _paper(s) == pytest.approx(before - (2 * A + B))   # what the books lose
    assert _rack(s, ROW3)[:1] == (2,)


def test_half_a_drum_used_opens_a_sealed_drum(client, plant, db_session):
    s = Story(client, db_session)
    s.receive_truck("A", VL, "2027-03-01", 4, ROW1, weight=A)
    carrier = s.lot_receipts("A")[-1]
    before = _paper(s)
    adj = s.post("/api/inventory/adjustments", WH_H, json={
        "receipt_id": carrier.id, "product_id": PRODUCT, "category_id": CAT,
        "adjustment_type": "used-in-production", "quantity": 250, "reason": "half a drum",
        "source_breakdown": [{"id": f"row-{ROW1}", "quantity": 250, "units": 0, "open_qty": 250}],
    }).json()
    assert adj["quantity"] == pytest.approx(250)
    s.post(f"/api/inventory/adjustments/{adj['id']}/approve", SUP_H)
    full, opened, open_lbs, lbs = _rack(s, ROW1)
    assert (full, opened, open_lbs) == (3, 1, A - 250)
    assert lbs == pytest.approx(4 * A - 250)
    assert _paper(s) == pytest.approx(before - 250)

    # And the rest of that open drum next.
    adj = s.post("/api/inventory/adjustments", WH_H, json={
        "receipt_id": carrier.id, "product_id": PRODUCT, "category_id": CAT,
        "adjustment_type": "used-in-production", "quantity": A - 250, "reason": "rest",
        "source_breakdown": [{"id": f"row-{ROW1}", "quantity": A - 250, "units": 0,
                              "open_qty": A - 250}],
    }).json()
    s.post(f"/api/inventory/adjustments/{adj['id']}/approve", SUP_H)
    assert _rack(s, ROW1)[:3] == (3, 0, 0.0)


def test_partial_cannot_move_between_racks(client, plant, db_session):
    s = Story(client, db_session)
    s.receive_truck("A", VL, "2027-03-01", 4, ROW1, weight=A)
    carrier = s.lot_receipts("A")[-1]
    r = s.post("/api/inventory/transfers", WH_H, ok=False, json={
        "receipt_id": carrier.id, "to_location_id": LOC, "to_sub_location_id": SUB,
        "quantity": 250, "reason": "x", "transfer_type": "warehouse-transfer",
        "source_breakdown": [{"id": f"row-{ROW1}", "quantity": 250, "units": 0, "open_qty": 250}],
        "destination_breakdown": [{"id": f"row-{ROW2}", "quantity": 250}],
    })
    assert r.status_code == 400 and "whole" in r.json()["detail"]


def test_adjustment_over_ask_and_wrong_product_refused_at_submit(client, plant, db_session):
    s = Story(client, db_session)
    s.receive_truck("A", VL, "2027-03-01", 4, ROW1, weight=A)
    s.receive_truck("A", VL, "2027-03-01", 6, ROW2, weight=A)
    carrier = next(r for r in s.lot_receipts("A") if r.raw_material_row_allocations)
    r = s.post("/api/inventory/adjustments", WH_H, ok=False, json={
        "receipt_id": carrier.id, "product_id": PRODUCT, "category_id": CAT,
        "adjustment_type": "damage-reduction", "quantity": 9 * A, "reason": "x",
        "source_breakdown": [{"id": f"row-{ROW1}", "quantity": 9 * A, "units": 9}],
    })
    assert r.status_code == 400
    assert "4 free" in r.json()["detail"] and VL in r.json()["detail"]
    r = s.post("/api/inventory/adjustments", WH_H, ok=False, json={
        "receipt_id": carrier.id, "product_id": "some-other-product", "category_id": CAT,
        "adjustment_type": "damage-reduction", "quantity": A, "reason": "x",
        "source_breakdown": [{"id": f"row-{ROW1}", "quantity": A, "units": 1}],
    })
    assert r.status_code == 400 and "product" in r.json()["detail"].lower()


def test_a_pending_adjustment_holds_its_drums_back(client, plant, db_session):
    s = Story(client, db_session)
    s.receive_truck("A", VL, "2027-03-01", 4, ROW1, weight=A)
    carrier = s.lot_receipts("A")[-1]
    s.post("/api/inventory/adjustments", WH_H, json={
        "receipt_id": carrier.id, "product_id": PRODUCT, "category_id": CAT,
        "adjustment_type": "donation", "quantity": 3 * A, "reason": "food bank",
        "source_breakdown": [{"id": f"row-{ROW1}", "quantity": 3 * A, "units": 3}],
    })
    r = s.post("/api/inventory/transfers", WH_H, ok=False, json={
        "receipt_id": carrier.id, "to_location_id": LOC, "to_sub_location_id": SUB,
        "quantity": 2 * A, "reason": "x", "transfer_type": "warehouse-transfer",
        "source_breakdown": [{"id": f"row-{ROW1}", "quantity": 2 * A, "units": 2}],
        "destination_breakdown": [{"id": f"row-{ROW2}", "quantity": 2 * A}],
    })
    assert r.status_code == 400, r.text
    detail = r.json()["detail"]
    # Checked rack by rack, in drums: 4 on the rack, 3 promised.
    assert "1 free drum" in detail and "pending requests" in detail, detail


def test_pending_part_drum_writeoff_reserves_the_drum_it_will_open(client, plant, db_session):
    """Re-check N4: 1 sealed drum on ROW1, a pending 252 lb write-off of part of
    it — a transfer of that drum must be refused, not accepted."""
    s = Story(client, db_session)
    s.receive_truck("A", VL, "2027-03-01", 1, ROW1, weight=A)
    carrier = s.lot_receipts("A")[-1]
    s.post("/api/inventory/adjustments", WH_H, json={
        "receipt_id": carrier.id, "product_id": PRODUCT, "category_id": CAT,
        "adjustment_type": "used-in-production", "quantity": 252, "reason": "half",
        "source_breakdown": [{"id": f"row-{ROW1}", "quantity": 252, "units": 0, "open_qty": 252}],
    })
    r = s.post("/api/inventory/transfers", WH_H, ok=False, json={
        "receipt_id": carrier.id, "to_location_id": LOC, "to_sub_location_id": SUB,
        "quantity": A, "reason": "x", "transfer_type": "warehouse-transfer",
        "source_breakdown": [{"id": f"row-{ROW1}", "quantity": A, "units": 1}],
        "destination_breakdown": [{"id": f"row-{ROW2}", "quantity": A}],
    })
    assert r.status_code == 400, r.text


def test_writeoff_approved_after_the_rack_changed_records_both_figures(client, plant, db_session):
    """Re-check N3: submitted at 2×502 + 474; a transfer then takes the 502s;
    approval books what those 3 drums weigh now and says so on the record."""
    s, carrier = _mixed_rack(client, db_session)   # ROW3: 2×502 (oldest) + 3×474
    adj = s.post("/api/inventory/adjustments", WH_H, json={
        "receipt_id": carrier.id, "product_id": PRODUCT, "category_id": CAT,
        "adjustment_type": "damage-reduction", "quantity": 1, "reason": "leak",
        "source_breakdown": [{"id": f"row-{ROW3}", "quantity": 1, "units": 3}],
    }).json()
    assert adj["quantity"] == pytest.approx(2 * A + B)
    t = s.post("/api/inventory/transfers", WH_H, json={
        "receipt_id": carrier.id, "to_location_id": LOC, "to_sub_location_id": SUB,
        "quantity": 1, "reason": "x", "transfer_type": "warehouse-transfer",
        "source_breakdown": [{"id": f"row-{ROW3}", "quantity": 1, "units": 2}],
        "destination_breakdown": [{"id": f"row-{ROW1}", "quantity": 1}],
    }).json()
    assert t["quantity"] == pytest.approx(2 * A)
    s.post(f"/api/inventory/transfers/{t['id']}/approve", SUP_H)
    before = _paper(s)
    s.post(f"/api/inventory/adjustments/{adj['id']}/approve", SUP_H)
    from app.models import InventoryAdjustment
    db_session.expire_all()
    done = db_session.query(InventoryAdjustment).filter(InventoryAdjustment.id == adj["id"]).one()
    assert done.quantity == pytest.approx(3 * B)
    assert "rack changed after submit" in done.reason
    assert _paper(s) == pytest.approx(before - 3 * B)
