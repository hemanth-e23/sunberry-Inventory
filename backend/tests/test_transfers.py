"""
Integration tests for inventory transfers API.
"""
import pytest
from app.models import InventoryTransfer


@pytest.mark.integration
def test_create_transfer_stores_all_fields(
    client, auth_headers, approved_receipt, db_session
):
    """Transfer with from/to sub_locations must be stored correctly."""
    payload = {
        "receipt_id": approved_receipt.id,
        "from_location_id": "loc-paw-paw",
        "from_sub_location_id": "subloc-warehouse-a",
        "to_location_id": "loc-paw-paw",
        "to_sub_location_id": "subloc-warehouse-a",
        "quantity": 50,
        "unit": "cases",
        "reason": "Relocating to different row",
        "transfer_type": "warehouse-transfer",
    }

    response = client.post(
        "/api/inventory/transfers",
        json=payload,
        headers=auth_headers,
    )
    assert response.status_code == 200

    data = response.json()
    assert data["from_sub_location_id"] == "subloc-warehouse-a"
    assert data["to_sub_location_id"] == "subloc-warehouse-a"
    assert data["quantity"] == 50
    assert data["status"] == "pending"

    db_transfer = db_session.query(InventoryTransfer).filter(
        InventoryTransfer.id == data["id"]
    ).first()
    assert db_transfer is not None
    assert db_transfer.from_sub_location_id == "subloc-warehouse-a"
    assert db_transfer.to_sub_location_id == "subloc-warehouse-a"


@pytest.mark.integration
def test_create_transfer_exceeds_quantity(client, auth_headers, approved_receipt):
    """Transfer quantity cannot exceed receipt quantity."""
    payload = {
        "receipt_id": approved_receipt.id,
        "quantity": 9999,
        "unit": "cases",
    }

    response = client.post(
        "/api/inventory/transfers",
        json=payload,
        headers=auth_headers,
    )
    assert response.status_code == 400


@pytest.mark.integration
def test_create_transfer_invalid_receipt(client, auth_headers):
    """Non-existent receipt returns 404."""
    response = client.post(
        "/api/inventory/transfers",
        json={
            "receipt_id": "nonexistent-receipt",
            "quantity": 10,
            "unit": "cases",
        },
        headers=auth_headers,
    )
    assert response.status_code == 404


@pytest.mark.integration
def test_warehouse_cannot_approve_own_transfer(
    client, auth_headers, admin_auth_headers, approved_receipt
):
    """Warehouse worker cannot approve own transfer."""
    payload = {
        "receipt_id": approved_receipt.id,
        "quantity": 50,
        "unit": "cases",
    }
    create_resp = client.post(
        "/api/inventory/transfers",
        json=payload,
        headers=auth_headers,
    )
    assert create_resp.status_code == 200
    transfer_id = create_resp.json()["id"]

    approve_resp = client.post(
        f"/api/inventory/transfers/{transfer_id}/approve",
        headers=auth_headers,
    )
    assert approve_resp.status_code == 403


@pytest.mark.integration
def test_admin_can_approve_transfer(
    client, auth_headers, admin_auth_headers, approved_receipt
):
    """Admin can approve transfer submitted by warehouse."""
    payload = {
        "receipt_id": approved_receipt.id,
        "quantity": 50,
        "unit": "cases",
    }
    create_resp = client.post(
        "/api/inventory/transfers",
        json=payload,
        headers=auth_headers,
    )
    assert create_resp.status_code == 200
    transfer_id = create_resp.json()["id"]

    approve_resp = client.post(
        f"/api/inventory/transfers/{transfer_id}/approve",
        headers=admin_auth_headers,
    )
    assert approve_resp.status_code == 200
    assert approve_resp.json()["transfer"]["status"] == "approved"


@pytest.mark.integration
def test_create_transfer_without_auth(approved_receipt, client):
    """Unauthenticated request rejected."""
    response = client.post(
        "/api/inventory/transfers",
        json={
            "receipt_id": approved_receipt.id,
            "quantity": 50,
            "unit": "cases",
        },
    )
    assert response.status_code == 403
