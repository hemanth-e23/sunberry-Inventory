"""
Regression test — Phase 3 Task 3.4.

A finished-goods inter-warehouse transfer must recreate the shipped pallets at
the destination so they can be picked there. Previously the destination receipt
was quantity-only with no pallet licences — a functional dead-end.
"""
import pytest
from app.models import (
    Warehouse, Location, SubLocation, StorageArea, StorageRow,
    Product, Category, CategoryGroup, Receipt, PalletLicence, InterWarehouseTransfer, User,
)
from app.utils.auth import get_password_hash
from app.services import inter_warehouse_transfer_service as iwt
from app.services import ship_out_service


@pytest.mark.integration
def test_fg_iwt_creates_pickable_destination_pallets(db_session):
    db_session.add(Warehouse(id="wh-A", name="A", code="A", type="plant"))
    db_session.add(Warehouse(id="wh-B", name="B", code="B", type="plant"))
    db_session.add(Location(id="locA", name="LA", warehouse_id="wh-A"))
    db_session.add(SubLocation(id="subA", name="SA", location_id="locA"))
    db_session.add(StorageArea(id="areaA", name="AA", location_id="locA", sub_location_id="subA"))
    db_session.add(StorageRow(id="rowA", name="RA", sub_location_id="subA", storage_area_id="areaA",
                              pallet_capacity=10, occupied_pallets=2, occupied_cases=100, product_id="p"))
    db_session.add(CategoryGroup(id="g", name="G"))
    db_session.add(Category(id="c", name="FG", type="finished", parent_id="g"))
    db_session.add(Product(id="p", name="Boxed", category_id="c"))
    db_session.add(User(id="u", username="u", name="U", email="u@s.com",
                        hashed_password=get_password_hash("password123"), role="warehouse", is_active=True))
    db_session.add(Receipt(id="rec-src", product_id="p", category_id="c", quantity=100,
                           unit="cases", status="approved", cases_per_pallet=50, warehouse_id="wh-A"))
    for i in (1, 2):
        db_session.add(PalletLicence(id=f"pl{i}", licence_number=f"SRC-{i}", receipt_id="rec-src",
                                     product_id="p", lot_number="LOT", cases=50, status="in_stock",
                                     storage_row_id="rowA", storage_area_id="areaA", warehouse_id="wh-A"))
    transfer = InterWarehouseTransfer(
        id="iwt1", from_warehouse_id="wh-A", to_warehouse_id="wh-B", product_id="p",
        lot_number="LOT", quantity=100, unit="cases", source_receipt_id="rec-src",
        pallet_licence_ids=["pl1", "pl2"], initiated_by="u", status="in_transit",
    )
    db_session.add(transfer)
    db_session.commit()

    iwt.deduct_source_inventory(db_session, transfer)
    dest = iwt.create_destination_receipt(db_session, transfer, "u")
    db_session.commit()

    # Source pallets shipped, source receipt depleted.
    assert db_session.query(Receipt).filter(Receipt.id == "rec-src").first().quantity == 0
    for pid in ("pl1", "pl2"):
        assert db_session.query(PalletLicence).filter(PalletLicence.id == pid).first().status == "shipped"

    # Destination has 2 in-stock pallets in wh-B.
    dest_pallets = db_session.query(PalletLicence).filter(
        PalletLicence.receipt_id == dest.id, PalletLicence.status == "in_stock"
    ).all()
    assert len(dest_pallets) == 2
    assert all(pl.warehouse_id == "wh-B" for pl in dest_pallets)
    assert dest.quantity == 100

    # And they are pickable by the destination's ship-out pool.
    pool = ship_out_service._pallet_pool_for_product(db_session, "p", "wh-B")
    assert len(pool) == 2
