"""
Regression test — Phase 3 Task 3.2.

Receipt creation now flushes (not commits) the bare receipt, so the whole
create — receipt + occupancy + allocations + pallet licences — commits in one
transaction. A failure during pallet generation must leave NO receipt row
(previously the committed-first receipt was orphaned and the client's retry
duplicated it).
"""
import pytest
from app.models import (
    Category, CategoryGroup, Product, Location, SubLocation,
    StorageArea, StorageRow, Receipt, PalletLicence,
)


@pytest.mark.integration
def test_receipt_create_rolls_back_fully_on_pallet_collision(
    client, auth_headers, db_session
):
    db_session.add(CategoryGroup(id="g", name="G"))
    db_session.add(Category(id="c-fg", name="FG", type="finished", parent_id="g"))
    db_session.add(Product(id="p-fg", name="Boxed", category_id="c-fg", short_code="PROD"))
    db_session.add(Location(id="loc", name="L"))
    db_session.add(SubLocation(id="sub", name="S", location_id="loc"))
    db_session.add(StorageArea(id="area", name="A", location_id="loc", sub_location_id="sub"))
    db_session.add(StorageRow(id="row", name="R", sub_location_id="sub", storage_area_id="area",
                              pallet_capacity=10))
    # Pre-existing licence that the new receipt (lot LOT1) will collide with.
    # Different lot so it does NOT bump the LOT1 sequence — forcing the clash.
    db_session.add(PalletLicence(
        id="pl-existing", licence_number="LOT1-PROD-001", lot_number="ZZZ",
        product_id="p-fg", cases=40, status="in_stock",
    ))
    db_session.commit()

    payload = {
        "product_id": "p-fg", "category_id": "c-fg",
        "quantity": 40, "unit": "cases", "lot_number": "LOT1",
        "location_id": "loc", "sub_location_id": "sub",
        "full_pallets": 1, "cases_per_pallet": 40,
        "allocation": {
            "success": True,
            "plan": [{"rowId": "row", "areaId": "area", "pallets": 1, "cases": 40}],
            "totalCases": 40, "totalPallets": 1,
        },
    }
    resp = client.post("/api/receipts/", json=payload, headers=auth_headers)
    assert resp.status_code == 400, resp.text  # collision rejected

    # The receipt must NOT have been persisted (no orphan from a first commit).
    db_session.expire_all()
    assert db_session.query(Receipt).filter(Receipt.lot_number == "LOT1").count() == 0
    # And no partial pallets for the failed lot.
    assert db_session.query(PalletLicence).filter(
        PalletLicence.lot_number == "LOT1"
    ).count() == 0
