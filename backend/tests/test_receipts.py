"""
Integration tests for receipts API.

These tests verify that the backend stores data correctly in the database,
including the critical sub_location_id field that was previously not being saved.
"""
import pytest
from app.models import Receipt


# ---------------------------------------------------------------------------
# Create Receipt — Field Storage (catches sub_location bug)
# ---------------------------------------------------------------------------

@pytest.mark.integration
def test_create_raw_material_receipt_stores_all_optional_fields(
    client, auth_headers, seed_data, db_session
):
    """
    Raw materials: all optional fields must be stored in database when provided.
    Catches bugs where optional fields (lot_number, bol, vendor, etc.) are dropped.
    """
    payload = {
        "product_id": "product-1",
        "category_id": "raw-sunberry",
        "quantity": 20000,
        "unit": "lbs",
        "container_count": 40,
        "container_unit": "barrels",
        "weight_per_container": 500,
        "weight_unit": "lbs",
        "location_id": "loc-paw-paw",
        "sub_location_id": "subloc-warehouse-a",
        "storage_row_id": "row-1",
        "pallets": 2,
        "lot_number": "RM-2026-001",
        "bol": "BOL-12345",
        "purchase_order": "PO-67890",
        "vendor_id": "vendor-1",
        "expiration_date": "2027-12-31T23:59:59.000Z",
        "receipt_date": "2026-02-13T00:00:00.000Z",
        "hold": True,
        "note": "Test note for optional fields",
    }

    response = client.post("/api/receipts/", json=payload, headers=auth_headers)
    assert response.status_code == 200

    receipt_id = response.json()["id"]
    db_receipt = db_session.query(Receipt).filter(Receipt.id == receipt_id).first()

    assert db_receipt is not None
    # Required / core
    assert db_receipt.sub_location_id == "subloc-warehouse-a"
    assert db_receipt.location_id == "loc-paw-paw"
    assert db_receipt.quantity == 20000.0
    assert db_receipt.product_id == "product-1"
    assert db_receipt.category_id == "raw-sunberry"
    # Optional fields
    assert db_receipt.lot_number == "RM-2026-001"
    assert db_receipt.bol == "BOL-12345"
    assert db_receipt.purchase_order == "PO-67890"
    assert db_receipt.vendor_id == "vendor-1"
    assert db_receipt.storage_row_id == "row-1"
    assert db_receipt.pallets == 2.0
    assert db_receipt.container_count == 40.0
    assert db_receipt.container_unit == "barrels"
    assert db_receipt.weight_per_container == 500.0
    assert db_receipt.weight_unit == "lbs"
    assert db_receipt.hold is True
    assert db_receipt.note == "Test note for optional fields"
    assert db_receipt.expiration_date is not None
    assert db_receipt.receipt_date is not None


@pytest.mark.integration
def test_create_raw_material_receipt_stores_sub_location(
    client, auth_headers, seed_data, db_session
):
    """
    Raw materials receipt: sub_location_id must be stored in database.
    This test would have caught the sub_location bug.
    """
    payload = {
        "product_id": "product-1",
        "category_id": "raw-sunberry",
        "quantity": 20000,
        "unit": "lbs",
        "container_count": 40,
        "container_unit": "barrels",
        "weight_per_container": 500,
        "weight_unit": "lbs",
        "location_id": "loc-paw-paw",
        "sub_location_id": "subloc-warehouse-a",
    }

    response = client.post("/api/receipts/", json=payload, headers=auth_headers)
    assert response.status_code == 200

    receipt_id = response.json()["id"]
    db_receipt = db_session.query(Receipt).filter(Receipt.id == receipt_id).first()

    assert db_receipt is not None
    assert db_receipt.sub_location_id == "subloc-warehouse-a"
    assert db_receipt.location_id == "loc-paw-paw"
    assert db_receipt.quantity == 20000.0


@pytest.mark.integration
def test_create_receipt_without_sub_location_still_works(
    client, auth_headers, seed_data
):
    """Receipts without sub_location should be accepted (field is optional)."""
    payload = {
        "product_id": "product-1",
        "quantity": 100,
        "unit": "cases",
        "location_id": "loc-paw-paw",
    }

    response = client.post("/api/receipts/", json=payload, headers=auth_headers)
    assert response.status_code == 200
    assert response.json()["sub_location_id"] is None


@pytest.mark.integration
def test_create_receipt_computes_total_weight_from_containers(
    client, auth_headers, seed_data
):
    """40 barrels × 500 lbs = 20,000 lbs (backend auto-computes quantity)."""
    payload = {
        "product_id": "product-1",
        "quantity": 0,
        "unit": "lbs",
        "container_count": 40,
        "weight_per_container": 500,
        "weight_unit": "lbs",
        "location_id": "loc-paw-paw",
    }

    response = client.post("/api/receipts/", json=payload, headers=auth_headers)
    assert response.status_code == 200
    assert response.json()["quantity"] == 20000.0


@pytest.mark.integration
def test_create_receipt_sub_location_derived_from_storage_row(
    client, auth_headers, seed_data, db_session
):
    """When sub_location_id is missing but storage_row_id given, derive from row."""
    payload = {
        "product_id": "product-1",
        "quantity": 100,
        "unit": "cases",
        "location_id": "loc-paw-paw",
        "storage_row_id": "row-1",
        "pallets": 2,
        # no sub_location_id — backend should derive from storage row
    }

    response = client.post("/api/receipts/", json=payload, headers=auth_headers)
    assert response.status_code == 200

    receipt_id = response.json()["id"]
    db_receipt = db_session.query(Receipt).filter(Receipt.id == receipt_id).first()

    assert db_receipt is not None
    assert db_receipt.sub_location_id == "subloc-warehouse-a"


# ---------------------------------------------------------------------------
# Round-trip: GET returns stored data
# ---------------------------------------------------------------------------

@pytest.mark.integration
def test_get_receipt_returns_sub_location(client, auth_headers, seed_data):
    """After POST, GET must return sub_location_id in the response."""
    payload = {
        "product_id": "product-1",
        "quantity": 100,
        "unit": "cases",
        "location_id": "loc-paw-paw",
        "sub_location_id": "subloc-warehouse-a",
    }

    create_response = client.post(
        "/api/receipts/", json=payload, headers=auth_headers
    )
    receipt_id = create_response.json()["id"]

    get_response = client.get(
        f"/api/receipts/{receipt_id}", headers=auth_headers
    )
    assert get_response.status_code == 200
    assert get_response.json()["sub_location_id"] == "subloc-warehouse-a"


@pytest.mark.integration
def test_get_receipt_not_found_returns_404(client, auth_headers):
    """Non-existent receipt ID returns 404."""
    response = client.get(
        "/api/receipts/nonexistent-id-123",
        headers=auth_headers,
    )
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Auth & Permissions
# ---------------------------------------------------------------------------

@pytest.mark.integration
def test_create_receipt_without_auth_returns_403(client, seed_data):
    """Requests without a token must be rejected."""
    payload = {
        "product_id": "product-1",
        "quantity": 100,
        "unit": "cases",
    }
    response = client.post("/api/receipts/", json=payload)
    assert response.status_code == 403


@pytest.mark.integration
def test_warehouse_cannot_approve_own_receipt(
    client, auth_headers, seed_data
):
    """Warehouse workers cannot approve receipts they submitted."""
    payload = {
        "product_id": "product-1",
        "quantity": 100,
        "unit": "cases",
        "location_id": "loc-paw-paw",
    }

    create_response = client.post(
        "/api/receipts/", json=payload, headers=auth_headers
    )
    receipt_id = create_response.json()["id"]

    approve_response = client.post(
        f"/api/receipts/{receipt_id}/approve",
        headers=auth_headers,
    )
    assert approve_response.status_code == 403
