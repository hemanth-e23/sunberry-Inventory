"""
Integration tests for inventory hold actions API.
"""
import pytest
from app.models import InventoryHoldAction, Receipt


@pytest.mark.integration
def test_create_hold_action_stores_fields(
    client, auth_headers, approved_receipt, db_session
):
    """Hold action must be stored correctly."""
    payload = {
        "receipt_id": approved_receipt.id,
        "action": "hold",
        "reason": "Quality inspection pending",
    }

    response = client.post(
        "/api/inventory/hold-actions",
        json=payload,
        headers=auth_headers,
    )
    assert response.status_code == 200

    data = response.json()
    assert data["action"] == "hold"
    assert data["reason"] == "Quality inspection pending"
    assert data["status"] == "pending"
    assert data["receipt_id"] == approved_receipt.id

    db_hold = db_session.query(InventoryHoldAction).filter(
        InventoryHoldAction.id == data["id"]
    ).first()
    assert db_hold is not None
    assert db_hold.reason == "Quality inspection pending"


@pytest.mark.integration
def test_create_hold_action_invalid_receipt(client, auth_headers):
    """Non-existent receipt returns 404."""
    response = client.post(
        "/api/inventory/hold-actions",
        json={
            "receipt_id": "nonexistent",
            "action": "hold",
            "reason": "Test",
        },
        headers=auth_headers,
    )
    assert response.status_code == 404


@pytest.mark.integration
def test_create_hold_action_invalid_action(client, auth_headers, approved_receipt):
    """Invalid action returns 400."""
    response = client.post(
        "/api/inventory/hold-actions",
        json={
            "receipt_id": approved_receipt.id,
            "action": "invalid",
            "reason": "Test",
        },
        headers=auth_headers,
    )
    assert response.status_code == 400


@pytest.mark.integration
def test_warehouse_cannot_approve_own_hold_action(
    client, auth_headers, approved_receipt
):
    """Warehouse cannot approve own hold action."""
    payload = {
        "receipt_id": approved_receipt.id,
        "action": "hold",
        "reason": "Test hold",
    }
    create_resp = client.post(
        "/api/inventory/hold-actions",
        json=payload,
        headers=auth_headers,
    )
    assert create_resp.status_code == 200
    hold_id = create_resp.json()["id"]

    approve_resp = client.post(
        f"/api/inventory/hold-actions/{hold_id}/approve",
        headers=auth_headers,
    )
    assert approve_resp.status_code == 403


@pytest.mark.integration
def test_admin_can_approve_hold_action(
    client, auth_headers, admin_auth_headers, approved_receipt, db_session
):
    """Admin can approve hold action and receipt gets marked on hold."""
    payload = {
        "receipt_id": approved_receipt.id,
        "action": "hold",
        "reason": "Quality check",
    }
    create_resp = client.post(
        "/api/inventory/hold-actions",
        json=payload,
        headers=auth_headers,
    )
    assert create_resp.status_code == 200
    hold_id = create_resp.json()["id"]

    approve_resp = client.post(
        f"/api/inventory/hold-actions/{hold_id}/approve",
        headers=admin_auth_headers,
    )
    assert approve_resp.status_code == 200

    receipt = db_session.query(Receipt).filter(
        Receipt.id == approved_receipt.id
    ).first()
    assert receipt.hold is True


@pytest.mark.integration
def test_create_hold_without_auth(approved_receipt, client):
    """Unauthenticated request rejected."""
    response = client.post(
        "/api/inventory/hold-actions",
        json={
            "receipt_id": approved_receipt.id,
            "action": "hold",
            "reason": "Test",
        },
    )
    assert response.status_code == 403
