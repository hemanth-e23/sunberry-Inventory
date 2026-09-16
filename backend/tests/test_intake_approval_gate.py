"""The approval gate: paper enters the books only when the racks agree.

Approving a receipt is what puts its quantity into every product total, so
approval is the moment the placement ledger must match the paperwork. Two
intake modes, detected by whether the gun touched the receipt:

* scan mode — the forklift's submitted scans ARE the placement; approval books
  the scanned count and corrects the paperwork to it.
* logged mode — drums were racked before the system heard of them; the typed
  rows become placements at approval, which refuses unless they cover the
  stated container count.

Born from the 2026-09-14 incident: ~170 drums approved with zero placements.
"""
from datetime import datetime, timezone

import pytest

from app.enums import ReceiptStatus
from app.exceptions import ValidationError
from app.models import (
    Category,
    Location,
    LotPlacement,
    Product,
    Receipt,
    StorageRow,
    SubLocation,
    User,
    Vendor,
    Warehouse,
)
from app.services import lot_receiving_service as lrs
from app.services import receipt_service

WH = "wh-gate-1"
PRODUCT = "prod-gate-mango"
FG_PRODUCT = "prod-gate-fg"
VENDOR = "vendor-gate"
SUB_TWO_ROWS = "sub-gate-two"
SUB_ONE_ROW = "sub-gate-one"
ROW_A = "row-gate-a"
ROW_B = "row-gate-b"
ROW_SOLO = "row-gate-solo"
SUBMITTER = "user-gate-worker"
BBD = datetime(2027, 5, 1, tzinfo=timezone.utc)


@pytest.fixture
def gate_seed(db_session):
    db_session.add(Warehouse(id=WH, name="Plant G", code="PG", type="owned", is_active=True))
    db_session.add_all([
        Category(id="cat-gate-ing", name="Ingredients", type="ingredient"),
        Category(id="cat-gate-fin", name="Finished", type="finished"),
    ])
    db_session.add_all([
        Product(id=PRODUCT, name="Gate Mango Puree", category_id="cat-gate-ing"),
        Product(id=FG_PRODUCT, name="Gate Juice 12pk", category_id="cat-gate-fin"),
    ])
    db_session.add(Vendor(id=VENDOR, name="Gate Vendor"))
    db_session.add(Location(id="loc-gate", name="Plant G", warehouse_id=WH))
    db_session.add_all([
        SubLocation(id=SUB_TWO_ROWS, name="Two-Row Room", location_id="loc-gate",
                    storage_unit="drum"),
        SubLocation(id=SUB_ONE_ROW, name="One-Row Room", location_id="loc-gate",
                    storage_unit="drum"),
    ])
    db_session.add_all([
        StorageRow(id=ROW_A, name="G-01", sub_location_id=SUB_TWO_ROWS,
                   pallet_capacity=0, is_active=True),
        StorageRow(id=ROW_B, name="G-02", sub_location_id=SUB_TWO_ROWS,
                   pallet_capacity=0, is_active=True),
        StorageRow(id=ROW_SOLO, name="G-SOLO", sub_location_id=SUB_ONE_ROW,
                   pallet_capacity=0, is_active=True),
    ])
    db_session.add_all([
        User(id=SUBMITTER, username="gateworker", name="Gate Worker",
             email="gate-w@sunberry.com", hashed_password="x", role="warehouse",
             is_active=True),
        User(id="user-gate-super", username="gatesuper", name="Gate Supervisor",
             email="gate-s@sunberry.com", hashed_password="x", role="supervisor",
             is_active=True),
    ])
    db_session.commit()
    return db_session.query(User).filter(User.id == "user-gate-super").first()


def _receipt(db, *, rid, count=None, weight=500.0, sub_location=None, row=None,
             unit="lbs", quantity=None, category="cat-gate-ing", product=PRODUCT,
             lot_number="GATE-77"):
    if quantity is None:
        quantity = (count or 0) * (weight or 0) or 100
    receipt = Receipt(
        id=rid,
        product_id=product,
        category_id=category,
        lot_number=lot_number,
        expiration_date=BBD,
        quantity=quantity,
        unit=unit,
        container_count=count,
        container_unit="drums" if count else None,
        weight_per_container=weight if count else None,
        weight_unit="lbs" if count else None,
        vendor_id=VENDOR,
        warehouse_id=WH,
        sub_location_id=sub_location,
        storage_row_id=row,
        status=ReceiptStatus.RECORDED,
        submitted_by=SUBMITTER,
        receipt_date=datetime(2026, 9, 10, tzinfo=timezone.utc),
    )
    db.add(receipt)
    db.flush()
    return receipt


def _placed_units(db, lot_id):
    rows = db.query(LotPlacement).filter(LotPlacement.material_lot_id == lot_id).all()
    return {p.storage_row_id: p.full_units for p in rows}


class TestLoggedMode:
    def test_no_container_count_is_refused(self, db_session, gate_seed):
        """A weight-only RM receipt states no drum count — nothing defensible
        to verify placements against, so approval refuses instead of guessing."""
        receipt = _receipt(db_session, rid="r-gate-nocount", count=None,
                           unit="lbs", quantity=32706)
        with pytest.raises(ValidationError, match="how many containers"):
            receipt_service.approve_receipt(db_session, receipt, gate_seed)
        assert receipt.status == ReceiptStatus.RECORDED

    def test_rows_that_place_nothing_are_refused(self, db_session, gate_seed):
        """The Grater-trio shape: a room with SEVERAL rows and no per-row
        counts places nothing — and must now refuse instead of approving
        phantom stock."""
        receipt = _receipt(db_session, rid="r-gate-phantom", count=10,
                           sub_location=SUB_TWO_ROWS)
        with pytest.raises(ValidationError, match="place 0 of 10"):
            receipt_service.approve_receipt(db_session, receipt, gate_seed)
        assert receipt.status == ReceiptStatus.RECORDED

    def test_single_row_room_resolves_and_places(self, db_session, gate_seed):
        """A room-level receipt in a one-row room means that row — the same
        resolution transfers apply to their sources."""
        receipt = _receipt(db_session, rid="r-gate-solo", count=10,
                           sub_location=SUB_ONE_ROW)
        receipt_service.approve_receipt(db_session, receipt, gate_seed)
        db_session.commit()
        assert receipt.status == ReceiptStatus.APPROVED
        assert receipt.material_lot_id is not None
        assert _placed_units(db_session, receipt.material_lot_id) == {ROW_SOLO: 10}

    def test_typed_row_places_exactly(self, db_session, gate_seed):
        receipt = _receipt(db_session, rid="r-gate-typed", count=8, row=ROW_A,
                           sub_location=SUB_TWO_ROWS)
        receipt_service.approve_receipt(db_session, receipt, gate_seed)
        db_session.commit()
        assert receipt.status == ReceiptStatus.APPROVED
        assert _placed_units(db_session, receipt.material_lot_id) == {ROW_A: 8}


class TestScanMode:
    def _scanned_receipt(self, db, *, expected=5, scans=3):
        receipt = _receipt(db, rid="r-gate-scan", count=expected,
                           sub_location=SUB_TWO_ROWS)
        lot = lrs.ensure_lot_for_receipt(db, receipt)
        for _ in range(scans):
            result = lrs.scan_unit(
                db, receipt_id=receipt.id, lot_code=lot.lot_code,
                storage_row_id=ROW_A, allow_overfill=True,
            )
            assert result.get("status") in ("ok", "counted", "success", None) or result
        return receipt

    def test_unsubmitted_session_blocks_approval(self, db_session, gate_seed):
        receipt = self._scanned_receipt(db_session, expected=5, scans=3)
        with pytest.raises(ValidationError, match="has not submitted"):
            receipt_service.approve_receipt(db_session, receipt, gate_seed)
        assert receipt.status == ReceiptStatus.RECORDED

    def test_short_scan_books_the_scanned_count(self, db_session, gate_seed):
        """Paper said 5 drums, the forklift scanned and submitted 3 — the books
        get 3, and the correction is written into the note as the audit trail."""
        receipt = self._scanned_receipt(db_session, expected=5, scans=3)
        receipt.forklift_submitted_at = datetime.now(timezone.utc)
        receipt_service.approve_receipt(db_session, receipt, gate_seed)
        db_session.commit()
        assert receipt.status == ReceiptStatus.APPROVED
        assert int(receipt.container_count) == 3
        assert float(receipt.quantity) == 3 * 500.0
        assert "Approval correction" in (receipt.note or "")
        assert _placed_units(db_session, receipt.material_lot_id) == {ROW_A: 3}

    def test_exact_scan_needs_no_correction(self, db_session, gate_seed):
        receipt = self._scanned_receipt(db_session, expected=3, scans=3)
        receipt.forklift_submitted_at = datetime.now(timezone.utc)
        receipt_service.approve_receipt(db_session, receipt, gate_seed)
        db_session.commit()
        assert receipt.status == ReceiptStatus.APPROVED
        assert float(receipt.quantity) == 3 * 500.0
        assert "Approval correction" not in (receipt.note or "")


class TestFinishedGoodsUntouched:
    def test_fg_receipt_approves_without_counts(self, db_session, gate_seed):
        """FG locates itself through pallet licences; the gate must not apply."""
        receipt = _receipt(db_session, rid="r-gate-fg", count=None, unit="cases",
                           quantity=240, category="cat-gate-fin",
                           product=FG_PRODUCT, lot_number="FG-1")
        receipt_service.approve_receipt(db_session, receipt, gate_seed)
        db_session.commit()
        assert receipt.status == ReceiptStatus.APPROVED
        assert receipt.material_lot_id is None
