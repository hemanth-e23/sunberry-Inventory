"""
Regression tests — Phase 2 Task 2.5.

Adjustments now persist a unit (copied from the receipt server-side) and the
create endpoint validates that any source_breakdown sums to the quantity.
"""
import pytest
from app.models import InventoryAdjustment


@pytest.mark.integration
def test_adjustment_inherits_receipt_unit(client, auth_headers, seed_data, db_session):
    create_receipt = client.post(
        "/api/receipts/",
        json={
            "product_id": "product-1", "category_id": "raw-sunberry",
            "quantity": 5000, "unit": "lbs",
            "location_id": "loc-paw-paw", "sub_location_id": "subloc-warehouse-a",
        },
        headers=auth_headers,
    )
    assert create_receipt.status_code == 200, create_receipt.text
    receipt_id = create_receipt.json()["id"]

    resp = client.post(
        "/api/inventory/adjustments",
        json={
            "receipt_id": receipt_id, "adjustment_type": "damage-reduction",
            "quantity": 100, "reason": "spill",
        },
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["unit"] == "lbs"
    adj = db_session.query(InventoryAdjustment).filter(
        InventoryAdjustment.id == resp.json()["id"]
    ).first()
    assert adj.unit == "lbs"


@pytest.mark.integration
def test_adjustment_rejects_mismatched_breakdown(client, auth_headers, approved_receipt):
    resp = client.post(
        "/api/inventory/adjustments",
        json={
            "receipt_id": approved_receipt.id, "adjustment_type": "damage-reduction",
            "quantity": 100, "reason": "x",
            "source_breakdown": [{"id": "row-1", "quantity": 60}],  # sums to 60, not 100
        },
        headers=auth_headers,
    )
    assert resp.status_code == 400


@pytest.mark.integration
def test_adjustment_accepts_matching_breakdown(client, auth_headers, approved_receipt):
    resp = client.post(
        "/api/inventory/adjustments",
        json={
            "receipt_id": approved_receipt.id, "adjustment_type": "damage-reduction",
            "quantity": 100, "reason": "x",
            "source_breakdown": [
                {"id": "row-1", "quantity": 60},
                {"id": "row-2", "quantity": 40},
            ],
        },
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
