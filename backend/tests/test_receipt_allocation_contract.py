"""
Contract regression test — Phase 1 Task 1.7.

The receipt-create payload key for multi-row allocations is camelCase
`rawMaterialRowAllocations` (the router pops exactly that). The frontend used
to send snake_case, which Pydantic silently dropped, so multi-row receipts were
created with no allocation JSON and no row-occupancy increments. This test
locks the camelCase contract so the mismatch can't regress.
"""
import pytest
from app.models import Receipt, StorageRow


@pytest.mark.integration
def test_create_receipt_persists_camelcase_row_allocations(
    client, auth_headers, seed_data, db_session
):
    payload = {
        "product_id": "product-1",
        "category_id": "raw-sunberry",
        "quantity": 100,
        "unit": "lbs",
        "location_id": "loc-paw-paw",
        "sub_location_id": "subloc-warehouse-a",
        "cases_per_pallet": 50,
        "rawMaterialRowAllocations": [
            {"rowId": "row-1", "cases": 100, "pallets": 2},
        ],
    }
    resp = client.post("/api/receipts/", json=payload, headers=auth_headers)
    assert resp.status_code == 200, resp.text
    receipt_id = resp.json()["id"]

    receipt = db_session.query(Receipt).filter(Receipt.id == receipt_id).first()
    assert receipt.raw_material_row_allocations == [
        {"rowId": "row-1", "cases": 100, "pallets": 2}
    ]

    # Row occupancy was incremented from the allocation (proves the key flowed
    # all the way through, not just got stored as dead JSON). The RM create path
    # tracks occupied_pallets here (occupied_cases denorm is handled elsewhere).
    row = db_session.query(StorageRow).filter(StorageRow.id == "row-1").first()
    assert row.occupied_pallets == 2
    assert row.product_id == "product-1"


@pytest.mark.integration
def test_snake_case_key_is_ignored(client, auth_headers, seed_data, db_session):
    """Documents that the OLD snake_case key does NOT persist (the bug)."""
    payload = {
        "product_id": "product-1",
        "category_id": "raw-sunberry",
        "quantity": 100,
        "unit": "lbs",
        "location_id": "loc-paw-paw",
        "sub_location_id": "subloc-warehouse-a",
        "raw_material_row_allocations": [{"rowId": "row-1", "cases": 100, "pallets": 2}],
    }
    resp = client.post("/api/receipts/", json=payload, headers=auth_headers)
    assert resp.status_code == 200, resp.text
    receipt = db_session.query(Receipt).filter(Receipt.id == resp.json()["id"]).first()
    assert receipt.raw_material_row_allocations is None  # snake_case dropped
