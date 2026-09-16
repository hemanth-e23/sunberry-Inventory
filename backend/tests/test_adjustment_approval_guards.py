"""Approval guards on lot-based adjustments (2026-09 audit A5/A6).

An adjustment approved days after submission can be stale — staging consumed
the lot meanwhile — and the old ``max(0, …)`` clamp silently swallowed the
difference. And a held lot could be written off around its hold. Approval now
re-validates against current stock and refuses held lots, instead of clamping.
"""
import uuid
from datetime import datetime, timezone

import pytest

from app.enums import AdjustmentStatus, AdjustmentType, ReceiptStatus
from app.exceptions import ValidationError
from app.models import (
    Category,
    InventoryAdjustment,
    Location,
    LotPlacement,
    MaterialLot,
    Product,
    Receipt,
    StorageArea,
    StorageRow,
    SubLocation,
    User,
    Vendor,
    Warehouse,
)
from app.services import adjustment_service, receipt_service

WH = "wh-adjg-1"
PRODUCT = "prod-adjg-mango"
VENDOR = "vendor-adjg"
ROW_1 = "row-adjg-1"
SUB = "sub-adjg"
BBD = datetime(2027, 8, 1, tzinfo=timezone.utc)
WEIGHT = 500.0


@pytest.fixture
def adjg_seed(db_session):
    db_session.add(Warehouse(id=WH, name="Plant J", code="PJ", type="owned", is_active=True))
    db_session.add(Category(id="cat-adjg-raw", name="Raw", type="raw"))
    db_session.add(Product(id=PRODUCT, name="Adj Mango", category_id="cat-adjg-raw"))
    db_session.add(Vendor(id=VENDOR, name="Adj Vendor"))
    db_session.add(Location(id="loc-adjg", name="Plant J", warehouse_id=WH))
    db_session.add(SubLocation(id=SUB, name="Drum Barn", location_id="loc-adjg",
                               storage_unit="drum"))
    db_session.add(StorageArea(id="area-adjg", name="Barn", location_id="loc-adjg"))
    db_session.add(StorageRow(id=ROW_1, name="J-01", sub_location_id=SUB,
                              storage_area_id="area-adjg", pallet_capacity=0))
    db_session.add_all([
        User(id="u-adjg-submit", username="jsam", name="Sam", email="jsam@x.test",
             hashed_password="x", role="warehouse", is_active=True),
        User(id="u-adjg-approve", username="jada", name="Ada", email="jada@x.test",
             hashed_password="x", role="admin", is_active=True),
    ])
    db_session.commit()


class _Approver:
    id = "u-adjg-approve"
    role = "admin"
    name = "Ada"
    warehouse_id = WH


def _counted_receipt(db, *, units=20):
    receipt = Receipt(
        id=f"rcpt-adjg-{uuid.uuid4().hex[:10]}",
        product_id=PRODUCT,
        category_id="cat-adjg-raw",
        vendor_id=VENDOR,
        lot_number=f"ADJ-{uuid.uuid4().hex[:6]}",
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
        submitted_by="u-adjg-submit",
    )
    db.add(receipt)
    db.flush()
    receipt_service.approve_receipt(db, receipt, _Approver())
    db.flush()
    return receipt


def _adjustment(db, receipt, *, qty, adj_type=AdjustmentType.DAMAGE_REDUCTION.value):
    adjustment = InventoryAdjustment(
        id=f"adj-guard-{uuid.uuid4().hex[:10]}",
        receipt_id=receipt.id,
        product_id=PRODUCT,
        adjustment_type=adj_type,
        quantity=qty,
        unit="lbs",
        reason="guard test",
        status=AdjustmentStatus.PENDING,
        submitted_by="u-adjg-submit",
    )
    db.add(adjustment)
    db.flush()
    return adjustment


class TestStaleQuantity:
    def test_stale_adjustment_refuses_instead_of_clamping(self, db_session, adjg_seed):
        """Submitted against 10,000 lbs; staging took the lot down to 4,000
        before approval. The old code clamped to zero and lost 2,000 lbs
        silently — now it refuses and names the current number."""
        receipt = _counted_receipt(db_session, units=20)  # 10,000 lbs
        adjustment = _adjustment(db_session, receipt, qty=6000)
        receipt.quantity = 4000  # stock moved on while the adjustment sat pending
        with pytest.raises(ValidationError, match="Only 4000"):
            adjustment_service.approve_adjustment(db_session, adjustment, _Approver())
        assert adjustment.status == AdjustmentStatus.PENDING

    def test_current_stock_still_covers_it_approves(self, db_session, adjg_seed):
        receipt = _counted_receipt(db_session, units=20)
        adjustment = _adjustment(db_session, receipt, qty=5 * WEIGHT)
        adjustment_service.approve_adjustment(db_session, adjustment, _Approver())
        db_session.commit()
        assert adjustment.status == AdjustmentStatus.APPROVED
        assert float(receipt.quantity) == 15 * WEIGHT
        placement = (
            db_session.query(LotPlacement)
            .filter(LotPlacement.material_lot_id == receipt.material_lot_id)
            .one()
        )
        assert placement.full_units == 15


class TestHeldStock:
    def test_held_receipt_cannot_be_written_off(self, db_session, adjg_seed):
        receipt = _counted_receipt(db_session, units=20)
        receipt.hold = True
        adjustment = _adjustment(db_session, receipt, qty=1000)
        with pytest.raises(ValidationError, match="on hold"):
            adjustment_service.approve_adjustment(db_session, adjustment, _Approver())

    def test_held_lot_cannot_be_written_off(self, db_session, adjg_seed):
        receipt = _counted_receipt(db_session, units=20)
        lot = (
            db_session.query(MaterialLot)
            .filter(MaterialLot.id == receipt.material_lot_id)
            .one()
        )
        lot.is_held = True
        db_session.flush()
        adjustment = _adjustment(db_session, receipt, qty=1000)
        with pytest.raises(ValidationError, match="on hold"):
            adjustment_service.approve_adjustment(db_session, adjustment, _Approver())
        assert adjustment.status == AdjustmentStatus.PENDING


class TestPalletAdjustmentGuard:
    def test_shipped_pallet_is_not_cancelled_or_double_deducted(
        self, db_session, adjg_seed
    ):
        """FG scope (audit A3): adjustment submitted Monday, one pallet ships
        Tuesday, adjustment approved Wednesday — the shipped pallet must be
        skipped, not cancelled and deducted a second time."""
        from app.enums import PalletStatus
        from app.models import PalletLicence

        db_session.add(Category(id="cat-adjg-fin", name="Finished", type="finished"))
        db_session.add(Product(id="prod-adjg-fg", name="Adj Juice",
                               category_id="cat-adjg-fin"))
        receipt = Receipt(
            id="rcpt-adjg-fg",
            product_id="prod-adjg-fg",
            category_id="cat-adjg-fin",
            quantity=80,
            unit="cases",
            lot_number="FG-ADJ-1",
            warehouse_id=WH,
            status=ReceiptStatus.APPROVED,
            submitted_by="u-adjg-submit",
        )
        db_session.add(receipt)
        db_session.add_all([
            PalletLicence(id="pl-adjg-1", licence_number="PL-ADJG-1",
                          receipt_id=receipt.id, product_id="prod-adjg-fg",
                          cases=40, status=PalletStatus.IN_STOCK),
            PalletLicence(id="pl-adjg-2", licence_number="PL-ADJG-2",
                          receipt_id=receipt.id, product_id="prod-adjg-fg",
                          cases=40, status="shipped"),
        ])
        db_session.flush()

        adjustment = InventoryAdjustment(
            id="adj-guard-fg",
            receipt_id=receipt.id,
            product_id="prod-adjg-fg",
            adjustment_type=AdjustmentType.DAMAGE_REDUCTION.value,
            quantity=80,
            unit="cases",
            reason="both pallets damaged (one shipped meanwhile)",
            pallet_licence_ids=["pl-adjg-1", "pl-adjg-2"],
            status=AdjustmentStatus.PENDING,
            submitted_by="u-adjg-submit",
        )
        db_session.add(adjustment)
        db_session.flush()

        adjustment_service.approve_adjustment(db_session, adjustment, _Approver())
        db_session.commit()

        in_stock = db_session.query(PalletLicence).filter_by(id="pl-adjg-1").one()
        shipped = db_session.query(PalletLicence).filter_by(id="pl-adjg-2").one()
        assert in_stock.status == PalletStatus.CANCELLED
        assert shipped.status == "shipped", "a shipped pallet must not be cancelled"
        assert float(receipt.quantity) == 40, "only the in-stock pallet's cases deduct"
