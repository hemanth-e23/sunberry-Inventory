"""
Regression tests for the gaps found in the independent verification pass
(FIX-PLAN.md "INDEPENDENT VERIFICATION" section): 3.4 server-side pallet
coverage on FG IWT, and 3.5 check-availability full-hold + warehouse scoping.
"""
import pytest
from app.models import (
    Warehouse, Location, SubLocation, StorageArea, StorageRow,
    Product, Category, CategoryGroup, Receipt, PalletLicence, InterWarehouseTransfer, User,
)
from app.utils.auth import get_password_hash
from app.services import inter_warehouse_transfer_service as iwt
from fastapi import HTTPException


@pytest.mark.integration
def test_fg_iwt_rejects_insufficient_pallet_coverage(db_session):
    db_session.add(Warehouse(id="wh-A", name="A", code="A", type="plant"))
    db_session.add(Warehouse(id="wh-B", name="B", code="B", type="plant"))
    db_session.add(CategoryGroup(id="g", name="G"))
    db_session.add(Category(id="c", name="FG", type="finished", parent_id="g"))
    db_session.add(Product(id="p", name="Boxed", category_id="c"))
    db_session.add(User(id="u", username="u", name="U", email="u@s.com",
                        hashed_password=get_password_hash("password123"), role="warehouse", is_active=True))
    db_session.add(Receipt(id="rec", product_id="p", category_id="c", quantity=500,
                           unit="cases", status="approved", warehouse_id="wh-A"))
    db_session.add(PalletLicence(id="pl1", licence_number="L1", receipt_id="rec",
                                 product_id="p", cases=50, status="in_stock", warehouse_id="wh-A"))
    transfer = InterWarehouseTransfer(
        id="iwt1", from_warehouse_id="wh-A", to_warehouse_id="wh-B", product_id="p",
        quantity=500, unit="cases", source_receipt_id="rec",
        pallet_licence_ids=["pl1"],  # only 50 cases selected for a 500-case transfer
        initiated_by="u", status="confirmed_by_sender",
    )
    db_session.add(transfer)
    db_session.commit()

    with pytest.raises(HTTPException) as exc:
        iwt.deduct_source_inventory(db_session, transfer)
    assert exc.value.status_code == 400
    assert "cover" in exc.value.detail.lower() or "Selected pallets" in exc.value.detail

    # Nothing shipped, nothing deducted.
    db_session.rollback()
    assert db_session.query(Receipt).filter(Receipt.id == "rec").first().quantity == 500
    assert db_session.query(PalletLicence).filter(PalletLicence.id == "pl1").first().status == "in_stock"


@pytest.mark.integration
def test_check_availability_excludes_full_holds_and_scopes_warehouse(client, auth_headers, db_session):
    db_session.add(Warehouse(id="wh-A", name="A", code="A", type="plant"))
    db_session.add(Warehouse(id="wh-B", name="B", code="B", type="plant"))
    db_session.add(CategoryGroup(id="g", name="G"))
    db_session.add(Category(id="c", name="Raw", type="raw", parent_id="g"))
    db_session.add(Product(id="p", name="Conc", category_id="c", sid="SID-1", inventory_tracked=True))
    # wh-A: 1000 free + a fully-held lot (hold=True, no held_quantity) of 400.
    db_session.add(Receipt(id="r1", product_id="p", category_id="c", quantity=1000,
                           unit="lbs", status="approved", warehouse_id="wh-A"))
    db_session.add(Receipt(id="r2", product_id="p", category_id="c", quantity=400,
                           unit="lbs", status="approved", warehouse_id="wh-A",
                           hold=True, held_quantity=0))
    # wh-B: 700 free.
    db_session.add(Receipt(id="r3", product_id="p", category_id="c", quantity=700,
                           unit="lbs", status="approved", warehouse_id="wh-B"))
    db_session.commit()

    # Unscoped: counts both warehouses' free stock, NOT the fully-held lot.
    resp = client.post("/api/service/check-availability", headers=auth_headers, json={
        "items": [{"sid": "SID-1", "quantity_needed": 100}],
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["items"][0]["on_hand"] == 1700  # 1000 + 700, hold excluded

    # Scoped to wh-A: only that plant's free stock.
    resp = client.post("/api/service/check-availability", headers=auth_headers, json={
        "items": [{"sid": "SID-1", "quantity_needed": 100}],
        "warehouse_id": "wh-A",
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["items"][0]["on_hand"] == 1000
