"""
Regression tests — Phase 2 Task 2.1 (backend portions).

  - IWT destination receipts inherit the source lot's unit + barrel/lbs
    conversion fields instead of defaulting to "cases".
  - Receipt unit is editable so a mislabeled lot can be repaired.
  - Editing container/weight fields recomputes quantity and unit server-side.
"""
import pytest
from app.models import (
    Category, CategoryGroup, Product, Warehouse, User, Receipt, InterWarehouseTransfer,
)
from app.utils.auth import get_password_hash
from app.services import inter_warehouse_transfer_service as iwt


@pytest.mark.integration
def test_iwt_destination_receipt_inherits_unit_and_container_fields(db_session):
    db_session.add(Warehouse(id="wh-A", name="A", code="A", type="plant"))
    db_session.add(Warehouse(id="wh-B", name="B", code="B", type="plant"))
    db_session.add(CategoryGroup(id="grp", name="G"))
    db_session.add(Category(id="cat-raw", name="Raw", type="raw", parent_id="grp"))
    db_session.add(Product(id="prod-1", name="Concentrate", category_id="cat-raw"))
    db_session.add(User(
        id="u-1", username="u1", name="U1", email="u1@s.com",
        hashed_password=get_password_hash("password123"), role="warehouse", is_active=True,
    ))
    # Source: 40 barrels × 500 lbs = 20000 lbs.
    db_session.add(Receipt(
        id="rec-src", product_id="prod-1", category_id="cat-raw",
        quantity=20000, unit="lbs", status="approved",
        container_count=40, container_unit="barrels",
        weight_per_container=500, weight_unit="lbs",
    ))
    transfer = InterWarehouseTransfer(
        id="iwt-1", from_warehouse_id="wh-A", to_warehouse_id="wh-B",
        product_id="prod-1", quantity=20000, unit="cases",  # transfer default is cases
        source_receipt_id="rec-src", initiated_by="u-1", status="in_transit",
    )
    db_session.add(transfer)
    db_session.commit()

    dest = iwt.create_destination_receipt(db_session, transfer, "u-1")

    assert dest.unit == "lbs"             # inherited from source, NOT "cases"
    assert dest.container_count == 40
    assert dest.container_unit == "barrels"
    assert dest.weight_per_container == 500
    assert dest.weight_unit == "lbs"


@pytest.mark.integration
def test_receipt_update_persists_unit(client, auth_headers, seed_data, db_session):
    create = client.post(
        "/api/receipts/",
        json={
            "product_id": "product-1", "category_id": "raw-sunberry",
            "quantity": 100, "unit": "cases",  # mislabeled
            "location_id": "loc-paw-paw", "sub_location_id": "subloc-warehouse-a",
        },
        headers=auth_headers,
    )
    assert create.status_code == 200, create.text
    rid = create.json()["id"]

    resp = client.put(f"/api/receipts/{rid}", json={"unit": "lbs"}, headers=auth_headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["unit"] == "lbs"


@pytest.mark.integration
def test_receipt_update_recomputes_quantity_from_containers(
    client, auth_headers, seed_data, db_session
):
    create = client.post(
        "/api/receipts/",
        json={
            "product_id": "product-1", "category_id": "raw-sunberry",
            "quantity": 100, "unit": "lbs",
            "location_id": "loc-paw-paw", "sub_location_id": "subloc-warehouse-a",
        },
        headers=auth_headers,
    )
    assert create.status_code == 200, create.text
    rid = create.json()["id"]

    # Correct to 40 barrels × 500 lbs → quantity recomputed to 20000 lbs.
    resp = client.put(
        f"/api/receipts/{rid}",
        json={
            "container_count": 40, "container_unit": "barrels",
            "weight_per_container": 500, "weight_unit": "lbs",
        },
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["quantity"] == 20000
    assert body["unit"] == "lbs"
