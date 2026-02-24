"""
Integration tests for inventory adjustments API.
"""
import pytest
from app.models import InventoryAdjustment, Receipt


@pytest.mark.integration
def test_create_adjustment_stores_all_fields(
    client, auth_headers, approved_receipt, db_session
):
    """Adjustment with all optional fields must be stored correctly."""
    payload = {
        "receipt_id": approved_receipt.id,
        "category_id": "raw-sunberry",
        "product_id": "product-1",
        "adjustment_type": "damage-reduction",
        "quantity": 10,
        "reason": "Damaged during handling",
        "recipient": None,
    }

    response = client.post(
        "/api/inventory/adjustments",
        json=payload,
        headers=auth_headers,
    )
    assert response.status_code == 200

    data = response.json()
    assert data["adjustment_type"] == "damage-reduction"
    assert data["quantity"] == 10
    assert data["reason"] == "Damaged during handling"
    assert data["status"] == "pending"

    db_adj = db_session.query(InventoryAdjustment).filter(
        InventoryAdjustment.id == data["id"]
    ).first()
    assert db_adj is not None
    assert db_adj.adjustment_type == "damage-reduction"
    assert db_adj.reason == "Damaged during handling"


@pytest.mark.integration
def test_create_adjustment_exceeds_quantity(client, auth_headers, approved_receipt):
    """Adjustment quantity cannot exceed receipt quantity."""
    payload = {
        "receipt_id": approved_receipt.id,
        "adjustment_type": "damage-reduction",
        "quantity": 9999,
        "reason": "Test",
    }

    response = client.post(
        "/api/inventory/adjustments",
        json=payload,
        headers=auth_headers,
    )
    assert response.status_code == 400


@pytest.mark.integration
def test_create_adjustment_invalid_receipt(client, auth_headers):
    """Non-existent receipt returns 404."""
    response = client.post(
        "/api/inventory/adjustments",
        json={
            "receipt_id": "nonexistent-receipt",
            "adjustment_type": "damage-reduction",
            "quantity": 10,
            "reason": "Test",
        },
        headers=auth_headers,
    )
    assert response.status_code == 404


@pytest.mark.integration
def test_warehouse_cannot_approve_own_adjustment(
    client, auth_headers, approved_receipt
):
    """Warehouse cannot approve own adjustment."""
    payload = {
        "receipt_id": approved_receipt.id,
        "adjustment_type": "damage-reduction",
        "quantity": 10,
        "reason": "Test",
    }
    create_resp = client.post(
        "/api/inventory/adjustments",
        json=payload,
        headers=auth_headers,
    )
    assert create_resp.status_code == 200
    adj_id = create_resp.json()["id"]

    approve_resp = client.post(
        f"/api/inventory/adjustments/{adj_id}/approve",
        headers=auth_headers,
    )
    assert approve_resp.status_code == 403


@pytest.mark.integration
def test_admin_approve_adjustment_reduces_receipt_quantity(
    client, auth_headers, admin_auth_headers, approved_receipt, db_session
):
    """Approving adjustment reduces receipt quantity."""
    payload = {
        "receipt_id": approved_receipt.id,
        "adjustment_type": "damage-reduction",
        "quantity": 20,
        "reason": "Damaged containers",
    }
    create_resp = client.post(
        "/api/inventory/adjustments",
        json=payload,
        headers=auth_headers,
    )
    assert create_resp.status_code == 200
    adj_id = create_resp.json()["id"]

    approve_resp = client.post(
        f"/api/inventory/adjustments/{adj_id}/approve",
        headers=admin_auth_headers,
    )
    assert approve_resp.status_code == 200

    receipt = db_session.query(Receipt).filter(
        Receipt.id == approved_receipt.id
    ).first()
    assert receipt.quantity == 80  # 100 - 20


@pytest.mark.integration
def test_create_adjustment_without_auth(approved_receipt, client):
    """Unauthenticated request rejected."""
    response = client.post(
        "/api/inventory/adjustments",
        json={
            "receipt_id": approved_receipt.id,
            "adjustment_type": "damage-reduction",
            "quantity": 10,
            "reason": "Test",
        },
    )
    assert response.status_code == 403
