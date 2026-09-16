"""Approval guards on RM warehouse transfers (2026-09 audit T2/T5/I3).

Approving a transfer must move on the racks exactly what the paper says, or
refuse loudly. The five 09-15 prod transfers approved while moving nothing —
every guard here exists so that shape can never recur:

* destination gets the same resolve-or-refuse the source got in the 09-15 fix
* either half missing (source or destination) refuses
* a lot nobody counted onto a rack cannot be transferred at all
* a counted approval that would move zero units refuses
* per-rack quantities that disagree with the transfer's quantity refuse
"""
import uuid
from datetime import datetime, timezone

import pytest

from app.enums import ReceiptStatus, TransferStatus
from app.exceptions import ValidationError
from app.models import (
    Category,
    InventoryTransfer,
    Location,
    LotPlacement,
    Product,
    Receipt,
    StorageArea,
    StorageRow,
    SubLocation,
    User,
    Vendor,
    Warehouse,
)
from app.services import receipt_service, transfer_service

WH = "wh-guard-1"
PRODUCT = "prod-guard-mango"
VENDOR = "vendor-guard"
ROW_1 = "row-guard-1"
ROW_2 = "row-guard-2"
SUB = "sub-guard"
SUB_EMPTY = "sub-guard-empty"
BBD = datetime(2027, 7, 1, tzinfo=timezone.utc)
WEIGHT = 500.0


@pytest.fixture
def guard_seed(db_session):
    db_session.add(Warehouse(id=WH, name="Plant T", code="PT", type="owned", is_active=True))
    db_session.add(Category(id="cat-guard-raw", name="Raw", type="raw"))
    db_session.add(Product(id=PRODUCT, name="Guard Mango", category_id="cat-guard-raw"))
    db_session.add(Vendor(id=VENDOR, name="Guard Vendor"))
    db_session.add(Location(id="loc-guard", name="Plant T", warehouse_id=WH))
    db_session.add_all([
        SubLocation(id=SUB, name="Drum Barn", location_id="loc-guard", storage_unit="drum"),
        SubLocation(id=SUB_EMPTY, name="Rackless Room", location_id="loc-guard",
                    storage_unit="drum"),
    ])
    db_session.add(StorageArea(id="area-guard", name="Barn", location_id="loc-guard"))
    db_session.add_all([
        StorageRow(id=ROW_1, name="T-01", sub_location_id=SUB,
                   storage_area_id="area-guard", pallet_capacity=0),
        StorageRow(id=ROW_2, name="T-02", sub_location_id=SUB,
                   storage_area_id="area-guard", pallet_capacity=0),
    ])
    db_session.add_all([
        User(id="u-guard-submit", username="gsam", name="Sam", email="gsam@x.test",
             hashed_password="x", role="warehouse", is_active=True),
        User(id="u-guard-approve", username="gada", name="Ada", email="gada@x.test",
             hashed_password="x", role="admin", is_active=True),
    ])
    db_session.commit()


class _Approver:
    id = "u-guard-approve"
    role = "admin"
    name = "Ada"
    warehouse_id = WH


def _counted_receipt(db, *, units=20):
    """A receipt approved through the intake gate: places `units` on ROW_1."""
    receipt = Receipt(
        id=f"rcpt-guard-{uuid.uuid4().hex[:10]}",
        product_id=PRODUCT,
        category_id="cat-guard-raw",
        vendor_id=VENDOR,
        lot_number=f"GRD-{uuid.uuid4().hex[:6]}",
        expiration_date=BBD,
        quantity=units * WEIGHT,
        unit="lbs",
        container_count=units,
        container_unit="drums",
        weight_per_container=WEIGHT,
        weight_unit="lbs",
        warehouse_id=WH,
        sub_location_id=SUB,
        storage_row_id=ROW_1,
        status=ReceiptStatus.RECORDED,
        submitted_by="u-guard-submit",
    )
    db.add(receipt)
    db.flush()
    receipt_service.approve_receipt(db, receipt, _Approver())
    db.flush()
    return receipt


def _transfer(db, receipt, *, qty, src=None, dest=None):
    transfer = InventoryTransfer(
        id=f"transfer-guard-{uuid.uuid4().hex[:10]}",
        receipt_id=receipt.id,
        quantity=qty,
        unit="lbs",
        transfer_type="warehouse-transfer",
        to_location_id="loc-guard",
        to_sub_location_id=SUB,
        source_breakdown=src,
        destination_breakdown=dest,
        status=TransferStatus.PENDING,
        requested_by="u-guard-submit",
        warehouse_id=WH,
    )
    db.add(transfer)
    db.flush()
    return transfer


def _by_row(db, lot_id):
    rows = db.query(LotPlacement).filter(LotPlacement.material_lot_id == lot_id).all()
    return {p.storage_row_id: p.full_units for p in rows if p.full_units}


class TestDestinationGuards:
    def test_rackless_destination_room_is_refused(self, db_session, guard_seed):
        """The mirrored half of the Grater Room incident: a destination that
        resolves to no rack must refuse, not credit nothing."""
        receipt = _counted_receipt(db_session, units=20)
        transfer = _transfer(
            db_session, receipt, qty=10 * WEIGHT,
            src=[{"id": f"row-{ROW_1}", "quantity": 10 * WEIGHT}],
            dest=[{"id": SUB_EMPTY, "quantity": 10 * WEIGHT}],
        )
        with pytest.raises(ValidationError, match="not a single rack"):
            transfer_service.approve_transfer(db_session, transfer, _Approver())
        assert transfer.status == TransferStatus.PENDING

    def test_source_without_destination_is_refused(self, db_session, guard_seed):
        receipt = _counted_receipt(db_session, units=20)
        transfer = _transfer(
            db_session, receipt, qty=10 * WEIGHT,
            src=[{"id": f"row-{ROW_1}", "quantity": 10 * WEIGHT}],
            dest=None,
        )
        with pytest.raises(ValidationError, match="no destination rack"):
            transfer_service.approve_transfer(db_session, transfer, _Approver())


class TestNoOpGuards:
    def test_empty_breakdowns_refuse_instead_of_paper_approving(self, db_session, guard_seed):
        """The exact shape of the five 09-15 no-ops: no breakdowns at all used
        to approve while moving nothing physical."""
        receipt = _counted_receipt(db_session, units=20)
        transfer = _transfer(db_session, receipt, qty=10 * WEIGHT, src=None, dest=None)
        with pytest.raises(ValidationError, match="move nothing"):
            transfer_service.approve_transfer(db_session, transfer, _Approver())
        assert transfer.status == TransferStatus.PENDING

    def test_uncounted_lot_is_refused(self, db_session, guard_seed):
        """A receipt with no lot on any rack (legacy/phantom shape) cannot be
        transferred — there is nothing physical to move."""
        receipt = Receipt(
            id=f"rcpt-guard-legacy-{uuid.uuid4().hex[:8]}",
            product_id=PRODUCT,
            category_id="cat-guard-raw",
            vendor_id=VENDOR,
            lot_number="GRD-LEGACY",
            quantity=5000,
            unit="lbs",
            warehouse_id=WH,
            status=ReceiptStatus.APPROVED,
            submitted_by="u-guard-submit",
        )
        db_session.add(receipt)
        db_session.flush()
        transfer = _transfer(
            db_session, receipt, qty=5000,
            src=[{"id": f"row-{ROW_1}", "quantity": 5000}],
            dest=[{"id": f"row-{ROW_2}", "quantity": 5000}],
        )
        with pytest.raises(ValidationError, match="not counted on any"):
            transfer_service.approve_transfer(db_session, transfer, _Approver())

    def test_mismatched_per_rack_quantities_are_refused(self, db_session, guard_seed):
        """Paper says 10 drums; the racks named would move 6 — refuse, don't
        drift (audit T5/T8 family)."""
        receipt = _counted_receipt(db_session, units=20)
        transfer = _transfer(
            db_session, receipt, qty=10 * WEIGHT,
            src=[{"id": f"row-{ROW_1}", "quantity": 6 * WEIGHT}],
            dest=[{"id": f"row-{ROW_2}", "quantity": 6 * WEIGHT}],
        )
        with pytest.raises(ValidationError, match="works out to 10"):
            transfer_service.approve_transfer(db_session, transfer, _Approver())


class TestHappyPath:
    def test_valid_transfer_moves_exactly_what_it_says(self, db_session, guard_seed):
        receipt = _counted_receipt(db_session, units=20)
        transfer = _transfer(
            db_session, receipt, qty=10 * WEIGHT,
            src=[{"id": f"row-{ROW_1}", "quantity": 10 * WEIGHT}],
            dest=[{"id": f"row-{ROW_2}", "quantity": 10 * WEIGHT}],
        )
        transfer_service.approve_transfer(db_session, transfer, _Approver())
        db_session.commit()
        assert transfer.status == TransferStatus.APPROVED
        assert _by_row(db_session, receipt.material_lot_id) == {ROW_1: 10, ROW_2: 10}

    def test_room_level_destination_with_single_row_resolves(self, db_session, guard_seed):
        """A destination named at room level lands on the room's only rack —
        same resolution the source side got in the 09-15 fix."""
        db_session.add(SubLocation(id="sub-guard-one", name="One-Rack Room",
                                   location_id="loc-guard", storage_unit="drum"))
        db_session.add(StorageRow(id="row-guard-solo", name="T-SOLO",
                                  sub_location_id="sub-guard-one",
                                  storage_area_id="area-guard", pallet_capacity=0))
        db_session.commit()
        receipt = _counted_receipt(db_session, units=20)
        transfer = _transfer(
            db_session, receipt, qty=5 * WEIGHT,
            src=[{"id": f"row-{ROW_1}", "quantity": 5 * WEIGHT}],
            dest=[{"id": "sub-guard-one", "quantity": 5 * WEIGHT}],
        )
        transfer_service.approve_transfer(db_session, transfer, _Approver())
        db_session.commit()
        assert transfer.status == TransferStatus.APPROVED
        assert _by_row(db_session, receipt.material_lot_id) == {
            ROW_1: 15, "row-guard-solo": 5,
        }
