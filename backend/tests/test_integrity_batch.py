"""
Regression tests — Phase 3 Task 3.5 (batch of focused integrity fixes).
"""
import pytest
from app.models import (
    Category, CategoryGroup, Product, Receipt, PalletLicence,
    InventoryHoldAction, User, Warehouse,
)
from app.utils.auth import get_password_hash, create_access_token
from app.services import hold_service


@pytest.mark.integration
def test_send_back_sets_enum_status(client, auth_headers, admin_auth_headers, seed_data, db_session):
    create = client.post("/api/receipts/", json={
        "product_id": "product-1", "category_id": "raw-sunberry",
        "quantity": 50, "unit": "lbs", "location_id": "loc-paw-paw",
        "sub_location_id": "subloc-warehouse-a",
    }, headers=auth_headers)
    assert create.status_code == 200, create.text
    rid = create.json()["id"]

    resp = client.post(f"/api/receipts/{rid}/send-back?reason=fix+lot", headers=admin_auth_headers)
    assert resp.status_code == 200, resp.text
    rec = db_session.query(Receipt).filter(Receipt.id == rid).first()
    assert rec.status == "sent_back"  # enum value, not legacy "sent-back"


@pytest.mark.integration
def test_unsupported_adjustment_type_rejected(client, auth_headers, approved_receipt):
    resp = client.post("/api/inventory/adjustments", json={
        "receipt_id": approved_receipt.id, "adjustment_type": "found-stock",  # not a deduction type
        "quantity": 10, "reason": "x",
    }, headers=auth_headers)
    assert resp.status_code == 400


@pytest.mark.integration
def test_assign_storage_is_idempotent(client, auth_headers, seed_data, db_session):
    create = client.post("/api/receipts/", json={
        "product_id": "product-1", "category_id": "raw-sunberry",
        "quantity": 100, "unit": "lbs", "location_id": "loc-paw-paw",
        "sub_location_id": "subloc-warehouse-a", "cases_per_pallet": 50,
    }, headers=auth_headers)
    assert create.status_code == 200, create.text
    rid = create.json()["id"]

    body = {"raw_material_row_allocations": [{"rowId": "row-1", "cases": 100, "pallets": 2}]}
    first = client.post(f"/api/receipts/{rid}/assign-storage", json=body, headers=auth_headers)
    assert first.status_code == 200, first.text
    second = client.post(f"/api/receipts/{rid}/assign-storage", json=body, headers=auth_headers)
    assert second.status_code == 400  # already assigned — no double-booking


@pytest.mark.integration
def test_hold_approval_skips_shipped_pallet_and_handles_null_cases(db_session):
    db_session.add(CategoryGroup(id="g", name="G"))
    db_session.add(Category(id="c", name="FG", type="finished", parent_id="g"))
    db_session.add(Product(id="p", name="Boxed", category_id="c"))
    db_session.add(User(id="sup", username="sup", name="Sup", email="s@s.com",
                        hashed_password=get_password_hash("password123"), role="supervisor", is_active=True))
    db_session.add(Receipt(id="rec", product_id="p", category_id="c", quantity=100,
                           unit="cases", status="approved"))
    # One in-stock pallet (cases NULL — must not crash), one already shipped.
    db_session.add(PalletLicence(id="pl-in", licence_number="L1", receipt_id="rec",
                                 product_id="p", cases=None, status="in_stock"))
    db_session.add(PalletLicence(id="pl-shipped", licence_number="L2", receipt_id="rec",
                                 product_id="p", cases=40, status="shipped"))
    hold = InventoryHoldAction(id="h1", receipt_id="rec", action="hold", reason="QA",
                               pallet_licence_ids=["pl-in", "pl-shipped"], status="pending",
                               submitted_by="sup")
    db_session.add(hold)
    db_session.commit()

    sup = db_session.query(User).filter(User.id == "sup").first()
    hold_service.approve_hold_action(db_session, hold, sup)
    db_session.commit()

    # Shipped pallet not held; in-stock pallet held; no crash on NULL cases.
    assert db_session.query(PalletLicence).filter(PalletLicence.id == "pl-shipped").first().is_held is not True
    assert db_session.query(PalletLicence).filter(PalletLicence.id == "pl-in").first().is_held is True
