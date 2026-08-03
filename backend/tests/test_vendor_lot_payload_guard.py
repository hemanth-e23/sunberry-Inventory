"""Every path that writes IntakeLot.vendor_lot must reject the payload delimiter.

The container label encodes `SB1|<serial>|<vendor_lot>|<bbd YYYYMMDD>`. A pipe
inside the lot shifts every field after it, so a scanner reads the wrong BBD off
the drum. That sticker goes onto a frozen barrel and may not be scanned for a
year, by which time the only fix is finding the physical drum.

The guard originally lived in ONE of four write paths, which is exactly the kind
of "invariant" that reads as enforced and is not. This file pins all four.
"""

from datetime import datetime, timezone, timedelta

import pytest

from app.exceptions import ValidationError
from app.models import (
    Category,
    IngredientIntake,
    IntakeLot,
    Product,
    Receipt,
    StorageRow,
    SubLocation,
    Location,
    User,
    Vendor,
    Warehouse,
)
from app.schemas.ingredient import IngredientIntakeCreate, IntakeLotCreate, IntakeLotUpdate
from app.services import ingredient_cutover_service as cut
from app.services import ingredient_intake_service as svc

BAD_LOT = "3896|41"


@pytest.fixture
def seed(db_session):
    db_session.add(Warehouse(id="wh-vl", name="Paw Paw", code="PVL", type="plant",
                             timezone="America/New_York"))
    db_session.add(Location(id="loc-vl", name="Barn", warehouse_id="wh-vl"))
    db_session.add(SubLocation(id="sub-vl", name="Cooler", location_id="loc-vl"))
    db_session.add(StorageRow(id="row-vl", name="A-1", sub_location_id="sub-vl"))
    db_session.add(Category(id="cat-vl", name="Ingredients", type="ingredient"))
    db_session.add(Product(id="prod-vl", name="Guava Puree", sid="GUAP", category_id="cat-vl"))
    db_session.add(Vendor(id="ven-vl", name="SunOpta"))
    db_session.add(User(id="user-vl", username="sweeper-vl", name="Sweeper",
                        email="vl@example.com", hashed_password="x",
                        role="supervisor", warehouse_id="wh-vl"))
    db_session.commit()
    return db_session.query(User).filter(User.id == "user-vl").first()


def _good_intake(db, user):
    payload = IngredientIntakeCreate(
        vendor_id="ven-vl", warehouse_id="wh-vl",
        lots=[IntakeLotCreate(product_id="prod-vl", container_type="barrel",
                              vendor_lot="389641", expected_count=2,
                              net_weight_per_container=500, weight_unit="lbs")],
    )
    intake = svc.create_intake(db, payload, user)
    db.commit()
    return intake


def test_helper_rejects_and_passes_through(db_session):
    with pytest.raises(ValidationError):
        svc.validate_vendor_lot(BAD_LOT)
    # Clean values pass through unchanged so callers can assign the result.
    assert svc.validate_vendor_lot("389641") == "389641"
    assert svc.validate_vendor_lot(None) is None


def test_path1_intake_creation_rejects(db_session, seed):
    payload = IngredientIntakeCreate(
        vendor_id="ven-vl", warehouse_id="wh-vl",
        lots=[IntakeLotCreate(product_id="prod-vl", container_type="barrel",
                              vendor_lot=BAD_LOT, expected_count=1)],
    )
    with pytest.raises(ValidationError):
        svc.create_intake(db_session, payload, seed)


def test_path2_lot_line_patch_rejects(db_session, seed):
    """The lot-line PATCH used a setattr loop and bypassed the guard entirely —
    a lot could be corrupted AFTER labels had already been minted."""
    intake = _good_intake(db_session, seed)
    lot = intake.lots[0]

    changes = IntakeLotUpdate(vendor_lot=BAD_LOT).dict(exclude_unset=True)
    with pytest.raises(ValidationError):
        svc.validate_vendor_lot(changes["vendor_lot"])

    db_session.refresh(lot)
    assert lot.vendor_lot == "389641", "the bad lot must not have been written"


def test_path3_cutover_sweep_rejects_bad_legacy_lot(db_session, seed):
    """Historical receipts can hold anything; refuse rather than sweep a drum we
    cannot label correctly."""
    receipt = Receipt(
        id="rcpt-vl", product_id="prod-vl", category_id="cat-vl",
        lot_number=BAD_LOT, quantity=1000, unit="lbs",
        container_count=2, weight_per_container=500, weight_unit="lbs",
        expiration_date=datetime.now(timezone.utc) + timedelta(days=200),
        warehouse_id="wh-vl", vendor_id="ven-vl", status="approved",
        storage_row_id="row-vl",
    )
    db_session.add(receipt)
    db_session.commit()

    with pytest.raises(ValidationError):
        cut.convert_one(db_session, receipt, "row-vl", seed)


def test_path4_cutover_lot_override_rejects(db_session, seed):
    receipt = Receipt(
        id="rcpt-vl2", product_id="prod-vl", category_id="cat-vl",
        lot_number="389641", quantity=1000, unit="lbs",
        container_count=2, weight_per_container=500, weight_unit="lbs",
        expiration_date=datetime.now(timezone.utc) + timedelta(days=200),
        warehouse_id="wh-vl", vendor_id="ven-vl", status="approved",
        storage_row_id="row-vl",
    )
    db_session.add(receipt)
    db_session.commit()

    with pytest.raises(ValidationError):
        cut.convert_one(db_session, receipt, "row-vl", seed,
                        lot_number_override=BAD_LOT)


def test_clean_lot_still_converts(db_session, seed):
    """The guard must not block the normal path."""
    receipt = Receipt(
        id="rcpt-vl3", product_id="prod-vl", category_id="cat-vl",
        lot_number="389641", quantity=1000, unit="lbs",
        container_count=2, weight_per_container=500, weight_unit="lbs",
        expiration_date=datetime.now(timezone.utc) + timedelta(days=200),
        warehouse_id="wh-vl", vendor_id="ven-vl", status="approved",
        storage_row_id="row-vl",
        raw_material_row_allocations=[{"rowId": "row-vl", "cases": 1000, "pallets": 2}],
    )
    db_session.add(receipt)
    db_session.commit()

    result = cut.convert_one(db_session, receipt, "row-vl", seed)
    db_session.commit()
    assert "|" not in result["serial"].replace("-", "")
    assert result["receipt_quantity_after"] == 500.0
