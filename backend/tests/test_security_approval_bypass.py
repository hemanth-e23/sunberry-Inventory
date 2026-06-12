"""
Security regression tests — Phase 1 Task 1.1.

The generic PUT update endpoints used to accept `status` (and receipts also
`quantity`) and apply them blindly, which allowed:
  - setting status="approved" directly (skipping the inventory mutation), and
  - resetting an approved record to "pending" then re-approving it
    (double-deducting inventory).

These tests lock in that status/quantity are no longer editable via PUT and
that only pending (or sent-back, for receipts) records can be edited at all.
"""
import pytest
from app.models import InventoryAdjustment, Receipt


def _create_pending_adjustment(client, auth_headers, receipt_id, quantity=10):
    payload = {
        "receipt_id": receipt_id,
        "adjustment_type": "damage-reduction",
        "quantity": quantity,
        "reason": "Initial reason",
    }
    resp = client.post("/api/inventory/adjustments", json=payload, headers=auth_headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


@pytest.mark.integration
def test_put_adjustment_cannot_set_status(client, auth_headers, approved_receipt):
    """PUT with status="approved" must be ignored — the record stays pending."""
    adj_id = _create_pending_adjustment(client, auth_headers, approved_receipt.id)

    resp = client.put(
        f"/api/inventory/adjustments/{adj_id}",
        json={"status": "approved", "reason": "edited reason"},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "pending"        # status NOT changed
    assert body["reason"] == "edited reason"   # reason WAS changed


@pytest.mark.integration
def test_put_approved_adjustment_rejected(
    client, auth_headers, admin_auth_headers, approved_receipt
):
    """Once approved, an adjustment is final and cannot be edited via PUT."""
    adj_id = _create_pending_adjustment(client, auth_headers, approved_receipt.id)

    approve = client.post(
        f"/api/inventory/adjustments/{adj_id}/approve", headers=admin_auth_headers
    )
    assert approve.status_code == 200, approve.text

    resp = client.put(
        f"/api/inventory/adjustments/{adj_id}",
        json={"reason": "tampered"},
        headers=admin_auth_headers,
    )
    assert resp.status_code == 400


@pytest.mark.integration
def test_cannot_double_approve_adjustment(
    client, auth_headers, admin_auth_headers, approved_receipt, db_session
):
    """Approving an already-approved adjustment must not deduct inventory twice."""
    adj_id = _create_pending_adjustment(
        client, auth_headers, approved_receipt.id, quantity=20
    )

    first = client.post(
        f"/api/inventory/adjustments/{adj_id}/approve", headers=admin_auth_headers
    )
    assert first.status_code == 200, first.text

    second = client.post(
        f"/api/inventory/adjustments/{adj_id}/approve", headers=admin_auth_headers
    )
    assert second.status_code == 400  # already approved

    receipt = db_session.query(Receipt).filter(Receipt.id == approved_receipt.id).first()
    assert receipt.quantity == 80  # 100 - 20, deducted exactly once


@pytest.mark.integration
def test_put_receipt_cannot_set_status_or_quantity(
    client, auth_headers, seed_data, db_session
):
    """PUT on a receipt must ignore status and quantity (they desync inventory)."""
    create = client.post(
        "/api/receipts/",
        json={
            "product_id": "product-1",
            "category_id": "raw-sunberry",
            "quantity": 100,
            "unit": "lbs",
            "location_id": "loc-paw-paw",
            "sub_location_id": "subloc-warehouse-a",
        },
        headers=auth_headers,
    )
    assert create.status_code == 200, create.text
    receipt_id = create.json()["id"]

    resp = client.put(
        f"/api/receipts/{receipt_id}",
        json={"status": "approved", "quantity": 5, "note": "edited note"},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "recorded"   # status NOT changed by PUT
    assert body["quantity"] == 100         # quantity NOT changed by PUT
    assert body["note"] == "edited note"   # benign field WAS changed


@pytest.mark.integration
def test_resubmit_recorded_receipt_sets_reviewed(
    client, auth_headers, seed_data, db_session
):
    """The corrections resubmit endpoint moves a receipt into the approval queue."""
    create = client.post(
        "/api/receipts/",
        json={
            "product_id": "product-1",
            "category_id": "raw-sunberry",
            "quantity": 100,
            "unit": "lbs",
            "location_id": "loc-paw-paw",
            "sub_location_id": "subloc-warehouse-a",
        },
        headers=auth_headers,
    )
    assert create.status_code == 200, create.text
    receipt_id = create.json()["id"]

    resp = client.post(f"/api/receipts/{receipt_id}/resubmit", headers=auth_headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["receipt"]["status"] == "reviewed"


@pytest.mark.integration
def test_resubmit_approved_receipt_rejected(
    client, auth_headers, admin_auth_headers, approved_receipt
):
    """An approved receipt cannot be pulled back into the queue via resubmit."""
    resp = client.post(
        f"/api/receipts/{approved_receipt.id}/resubmit", headers=auth_headers
    )
    assert resp.status_code == 400


@pytest.mark.integration
def test_put_hold_action_cannot_set_status(
    client, auth_headers, approved_receipt
):
    """PUT on a hold action must ignore status."""
    create = client.post(
        "/api/inventory/hold-actions",
        json={
            "receipt_id": approved_receipt.id,
            "action": "hold",
            "reason": "QA hold",
            "total_quantity": 10,
        },
        headers=auth_headers,
    )
    assert create.status_code == 200, create.text
    hold_id = create.json()["id"]

    resp = client.put(
        f"/api/inventory/hold-actions/{hold_id}",
        json={"status": "approved", "reason": "edited"},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "pending"
