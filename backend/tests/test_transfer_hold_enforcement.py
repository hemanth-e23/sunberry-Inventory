"""
Regression test — Phase 1 Task 1.5.

The legacy transfer path (the live path for raw-material ship-outs) only checked
quantity against receipt.quantity and never against on-hold inventory, so held
raw material could be shipped. These tests lock in the available-excluding-held
check at both create and approve time.
"""
import pytest
from app.models import Receipt


def _make_receipt(db, *, quantity, held_quantity, status="approved"):
    db.add(Receipt(
        id="rec-h", product_id="product-1", category_id="raw-sunberry",
        quantity=quantity, unit="lbs", status=status, held_quantity=held_quantity,
        location_id="loc-paw-paw", sub_location_id="subloc-warehouse-a",
    ))
    db.commit()


@pytest.mark.integration
def test_create_transfer_fully_held_rejected(client, auth_headers, seed_data, db_session):
    _make_receipt(db_session, quantity=1000, held_quantity=1000)
    resp = client.post(
        "/api/inventory/transfers",
        json={"receipt_id": "rec-h", "quantity": 100, "unit": "lbs"},
        headers=auth_headers,
    )
    assert resp.status_code == 400
    assert "on-hold" in resp.json()["detail"].lower()


@pytest.mark.integration
def test_create_transfer_partial_hold_boundary(client, auth_headers, seed_data, db_session):
    """1000 lbs, 400 held → 600 transfers OK, 601 rejected."""
    _make_receipt(db_session, quantity=1000, held_quantity=400)

    ok = client.post(
        "/api/inventory/transfers",
        json={"receipt_id": "rec-h", "quantity": 600, "unit": "lbs"},
        headers=auth_headers,
    )
    assert ok.status_code == 200, ok.text

    too_much = client.post(
        "/api/inventory/transfers",
        json={"receipt_id": "rec-h", "quantity": 601, "unit": "lbs"},
        headers=auth_headers,
    )
    assert too_much.status_code == 400


@pytest.mark.integration
def test_approve_shipout_blocks_when_held_increased(
    client, auth_headers, admin_auth_headers, seed_data, db_session
):
    """A hold applied after creation must block the ship-out at approve time."""
    _make_receipt(db_session, quantity=1000, held_quantity=0)

    create = client.post(
        "/api/inventory/transfers",
        json={
            "receipt_id": "rec-h", "quantity": 600, "unit": "lbs",
            "transfer_type": "shipped-out", "order_number": "SO-1",
        },
        headers=auth_headers,
    )
    assert create.status_code == 200, create.text
    transfer_id = create.json()["id"]

    # A QA hold of 500 lands before approval — only 500 is now shippable.
    receipt = db_session.query(Receipt).filter(Receipt.id == "rec-h").first()
    receipt.held_quantity = 500
    db_session.commit()

    approve = client.post(
        f"/api/inventory/transfers/{transfer_id}/approve", headers=admin_auth_headers
    )
    assert approve.status_code == 400
    assert "on-hold" in approve.json()["detail"].lower()
