"""
Regression test — Phase 1 Task 1.3.

Approving an FG pallet-based deduction adjustment used to subtract the cases
from the receipt but leave the pallets IN_STOCK and the storage row occupied,
so the same pallets could be picked again at ship-out (double deduction).

This locks in that the pallets are cancelled, the row is freed, and the receipt
allocation is rebuilt — exactly once.
"""
import pytest
from app.models import (
    Category, CategoryGroup, Product, Location, SubLocation,
    StorageArea, StorageRow, Receipt, PalletLicence,
)


@pytest.fixture
def fg_with_pallets(db_session):
    """A finished-goods receipt with 3 in-stock pallets (40 cases each) in one row."""
    db_session.add(CategoryGroup(id="grp", name="Group"))
    db_session.add(Category(id="cat-fg", name="Finished", type="finished", parent_id="grp"))
    db_session.add(Product(id="prod-fg", name="Boxed Goods", category_id="cat-fg"))
    db_session.add(Location(id="loc-1", name="Plant"))
    db_session.add(SubLocation(id="sub-1", name="WH", location_id="loc-1"))
    db_session.add(StorageArea(id="area-1", name="Area", location_id="loc-1", sub_location_id="sub-1"))
    db_session.add(StorageRow(
        id="row-1", name="Row A", sub_location_id="sub-1", storage_area_id="area-1",
        pallet_capacity=10, occupied_pallets=3, occupied_cases=120, product_id="prod-fg",
    ))
    db_session.add(Receipt(
        id="rec-fg", product_id="prod-fg", category_id="cat-fg",
        quantity=120, unit="cases", status="approved", cases_per_pallet=40,
    ))
    for i in range(1, 4):
        db_session.add(PalletLicence(
            id=f"pl-{i}", licence_number=f"LIC-{i}", receipt_id="rec-fg",
            product_id="prod-fg", storage_area_id="area-1", storage_row_id="row-1",
            cases=40, status="in_stock",
        ))
    db_session.commit()
    return db_session


@pytest.mark.integration
def test_fg_pallet_adjustment_cancels_pallets_and_frees_row(
    client, auth_headers, admin_auth_headers, fg_with_pallets, db_session
):
    # Adjust off 2 of the 3 pallets (80 cases) as damage.
    create = client.post(
        "/api/inventory/adjustments",
        json={
            "product_id": "prod-fg",
            "adjustment_type": "damage-reduction",
            "reason": "Forklift damage",
            "pallet_licence_ids": ["pl-1", "pl-2"],
        },
        headers=auth_headers,
    )
    assert create.status_code == 200, create.text
    adj_id = create.json()["id"]
    assert create.json()["quantity"] == 80  # 2 × 40, computed from pallets

    approve = client.post(
        f"/api/inventory/adjustments/{adj_id}/approve", headers=admin_auth_headers
    )
    assert approve.status_code == 200, approve.text

    # Pallets removed from stock.
    for pid in ("pl-1", "pl-2"):
        pl = db_session.query(PalletLicence).filter(PalletLicence.id == pid).first()
        assert pl.status == "cancelled", f"{pid} should be cancelled, was {pl.status}"
    # Untouched pallet still in stock.
    assert db_session.query(PalletLicence).filter(PalletLicence.id == "pl-3").first().status == "in_stock"

    # Row occupancy freed by exactly 2 pallets / 80 cases.
    row = db_session.query(StorageRow).filter(StorageRow.id == "row-1").first()
    assert row.occupied_pallets == 1
    assert row.occupied_cases == 40

    # Receipt decremented exactly once.
    receipt = db_session.query(Receipt).filter(Receipt.id == "rec-fg").first()
    assert receipt.quantity == 40  # 120 - 80

    # Allocation rebuilt from the single remaining in-stock pallet.
    assert receipt.allocation["totalPallets"] == 1
    assert receipt.allocation["totalCases"] == 40


@pytest.mark.integration
def test_fg_pallet_adjustment_all_pallets_depletes_receipt(
    client, auth_headers, admin_auth_headers, fg_with_pallets, db_session
):
    create = client.post(
        "/api/inventory/adjustments",
        json={
            "product_id": "prod-fg",
            "adjustment_type": "trash-disposal",
            "reason": "Spoiled",
            "pallet_licence_ids": ["pl-1", "pl-2", "pl-3"],
        },
        headers=auth_headers,
    )
    assert create.status_code == 200, create.text
    adj_id = create.json()["id"]

    approve = client.post(
        f"/api/inventory/adjustments/{adj_id}/approve", headers=admin_auth_headers
    )
    assert approve.status_code == 200, approve.text

    row = db_session.query(StorageRow).filter(StorageRow.id == "row-1").first()
    assert row.occupied_pallets == 0
    assert row.occupied_cases == 0
    assert row.product_id is None  # row emptied → product cleared

    receipt = db_session.query(Receipt).filter(Receipt.id == "rec-fg").first()
    assert receipt.quantity == 0
    assert receipt.status == "depleted"
    assert receipt.allocation["totalPallets"] == 0
