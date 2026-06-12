"""
Regression tests — Phase 3 Task 3.3.

warehouse_id must stay consistent with where a pallet physically sits, so it
remains visible to the right warehouse's ship-out picker.
"""
import pytest
from app.models import (
    Warehouse, Location, SubLocation, StorageArea, StorageRow,
    Product, Category, CategoryGroup, PalletLicence, InventoryTransfer, User,
)
from app.utils.auth import get_password_hash
from app.utils.locations import warehouse_id_for_row
from app.services.transfer_service import _apply_pallet_licence_internal_transfer
from app.services import ship_out_service


@pytest.fixture
def two_warehouses(db_session):
    db_session.add(Warehouse(id="wh-A", name="A", code="A", type="plant"))
    db_session.add(Warehouse(id="wh-B", name="B", code="B", type="plant"))
    db_session.add(Location(id="locA", name="LA", warehouse_id="wh-A"))
    db_session.add(Location(id="locB", name="LB", warehouse_id="wh-B"))
    db_session.add(SubLocation(id="subA", name="SA", location_id="locA"))
    db_session.add(SubLocation(id="subB", name="SB", location_id="locB"))
    db_session.add(StorageArea(id="areaA", name="AA", location_id="locA", sub_location_id="subA"))
    db_session.add(StorageArea(id="areaB", name="AB", location_id="locB", sub_location_id="subB"))
    db_session.add(StorageRow(id="rowA", name="RA", sub_location_id="subA", storage_area_id="areaA", pallet_capacity=10))
    db_session.add(StorageRow(id="rowB", name="RB", sub_location_id="subB", storage_area_id="areaB", pallet_capacity=10))
    db_session.add(CategoryGroup(id="g", name="G"))
    db_session.add(Category(id="c", name="FG", type="finished", parent_id="g"))
    db_session.add(Product(id="p", name="Boxed", category_id="c"))
    db_session.commit()
    return db_session


def test_warehouse_id_for_row(two_warehouses):
    assert warehouse_id_for_row(two_warehouses, "rowA") == "wh-A"
    assert warehouse_id_for_row(two_warehouses, "rowB") == "wh-B"
    assert warehouse_id_for_row(two_warehouses, "nope") is None


def test_partial_pallet_row_filters_by_warehouse(two_warehouses):
    # Make both rows partial-pallet destinations.
    for rid in ("rowA", "rowB"):
        row = two_warehouses.query(StorageRow).filter(StorageRow.id == rid).first()
        row.is_partial_pallet_location = True
    two_warehouses.commit()

    assert ship_out_service._partial_pallet_row(two_warehouses, "wh-A").id == "rowA"
    assert ship_out_service._partial_pallet_row(two_warehouses, "wh-B").id == "rowB"


def test_internal_transfer_updates_pallet_warehouse(two_warehouses):
    # Pallet sits in rowA (wh-A); transfer moves it to rowB (wh-B).
    pl = PalletLicence(id="pl1", licence_number="L1", product_id="p", cases=40,
                       status="in_stock", storage_row_id="rowA", storage_area_id="areaA",
                       warehouse_id="wh-A")
    two_warehouses.add(pl)
    two_warehouses.commit()

    transfer = InventoryTransfer(
        id="t1", quantity=40, transfer_type="warehouse-transfer", status="pending",
        destination_breakdown=[{"id": "row-rowB", "pallet_licence_ids": ["pl1"]}],
    )
    _apply_pallet_licence_internal_transfer(two_warehouses, transfer, [pl])

    assert pl.storage_row_id == "rowB"
    assert pl.warehouse_id == "wh-B"  # warehouse follows the row
