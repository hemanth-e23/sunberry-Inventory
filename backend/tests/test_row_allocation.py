"""
Regression tests — Phase 3 Task 3.1.

The shared row-allocation helper keeps receipt.raw_material_row_allocations
consistent (cases + derived pallets) and is wired into every RM mutation path.
These tests cover the helper directly and verify an end-to-end adjustment keeps
the allocation JSON in sync with the deducted quantity.
"""
import pytest
from app.models import (
    Category, CategoryGroup, Product, Location, SubLocation,
    StorageArea, StorageRow, Receipt, InventoryAdjustment,
)
from app.services.row_allocation import (
    parse_breakdown, deduct_rm_rows, add_rm_rows, deduct_rm_total,
)


def _receipt(allocs, cpp=50):
    r = Receipt(id="r", product_id="p", quantity=sum(a["cases"] for a in allocs),
                unit="lbs", status="approved", cases_per_pallet=cpp)
    r.raw_material_row_allocations = allocs
    return r


def test_parse_breakdown_filters_and_sums():
    bd = [{"id": "row-A", "quantity": 10}, {"id": "row-A", "quantity": 5},
          {"id": "floor", "quantity": 3}, {"id": "row-B", "quantity": 0}]
    assert parse_breakdown(bd) == {"A": 15.0}


def test_deduct_rm_rows_keeps_cases_and_pallets_consistent(db_session):
    r = _receipt([{"rowId": "A", "cases": 100, "pallets": 2},
                  {"rowId": "B", "cases": 50, "pallets": 1}], cpp=50)
    deduct_rm_rows(db_session, r, {"A": 40}, update_rows=False)
    by_row = {a["rowId"]: a for a in r.raw_material_row_allocations}
    assert by_row["A"]["cases"] == 60
    assert by_row["A"]["pallets"] == 60 / 50  # derived from cases, consistent
    assert by_row["B"]["cases"] == 50  # untouched


def test_deduct_rm_rows_prunes_emptied_entries(db_session):
    r = _receipt([{"rowId": "A", "cases": 40, "pallets": 1}], cpp=40)
    deduct_rm_rows(db_session, r, {"A": 40}, update_rows=False)
    assert r.raw_material_row_allocations == []


def test_add_rm_rows_creates_and_increments(db_session):
    r = _receipt([{"rowId": "A", "cases": 100, "pallets": 2}], cpp=50)
    add_rm_rows(db_session, r, {"A": 50, "B": 25}, update_rows=False)
    by_row = {a["rowId"]: a for a in r.raw_material_row_allocations}
    assert by_row["A"]["cases"] == 150
    assert by_row["B"]["cases"] == 25
    assert by_row["B"]["pallets"] == 25 / 50


def test_deduct_rm_total_prorates(db_session):
    r = _receipt([{"rowId": "A", "cases": 100, "pallets": 2},
                  {"rowId": "B", "cases": 100, "pallets": 2}], cpp=50)
    deduct_rm_total(db_session, r, 100, update_rows=False)  # 50% of 200
    by_row = {a["rowId"]: a for a in r.raw_material_row_allocations}
    assert by_row["A"]["cases"] == 50
    assert by_row["B"]["cases"] == 50


@pytest.mark.integration
def test_adjustment_keeps_allocation_in_sync(client, auth_headers, admin_auth_headers, db_session):
    db_session.add(CategoryGroup(id="g", name="G"))
    db_session.add(Category(id="c", name="Raw", type="raw", parent_id="g"))
    db_session.add(Product(id="p1", name="Conc", category_id="c"))
    db_session.add(Location(id="loc", name="L"))
    db_session.add(SubLocation(id="sub", name="S", location_id="loc"))
    db_session.add(StorageArea(id="area", name="A", location_id="loc", sub_location_id="sub"))
    db_session.add(StorageRow(id="r1", name="R1", sub_location_id="sub", storage_area_id="area",
                              pallet_capacity=10, occupied_cases=100, occupied_pallets=2, product_id="p1"))
    rec = Receipt(id="rec1", product_id="p1", category_id="c", quantity=100, unit="lbs",
                  status="approved", cases_per_pallet=50)
    rec.raw_material_row_allocations = [{"rowId": "r1", "cases": 100, "pallets": 2}]
    db_session.add(rec)
    db_session.commit()

    create = client.post("/api/inventory/adjustments", json={
        "receipt_id": "rec1", "product_id": "p1", "adjustment_type": "damage-reduction",
        "quantity": 40, "reason": "spill", "source_breakdown": [{"id": "row-r1", "quantity": 40}],
    }, headers=auth_headers)
    assert create.status_code == 200, create.text
    approve = client.post(f"/api/inventory/adjustments/{create.json()['id']}/approve",
                          headers=admin_auth_headers)
    assert approve.status_code == 200, approve.text

    db_session.expire_all()
    rec = db_session.query(Receipt).filter(Receipt.id == "rec1").first()
    assert rec.quantity == 60
    # Allocation JSON stays in sync with the receipt quantity.
    alloc_total = sum(a["cases"] for a in rec.raw_material_row_allocations)
    assert alloc_total == 60
    row = db_session.query(StorageRow).filter(StorageRow.id == "r1").first()
    assert row.occupied_cases == 60
