"""Production consumption guards (2026-09 audit S3/S4/S5).

Consumption is where material leaves the books. Three ways it silently lied:
excess clamped at zero on multi-receipt lots (S5), a retried webhook deducting
twice and "PB-12" matching "PB-123" (S4), and used-more-than-staged discarded
outright (S3).
"""
import json
import uuid
from datetime import datetime, timezone

import pytest

from app.enums import AdjustmentStatus, ReceiptStatus
from app.models import (
    Category,
    InventoryAdjustment,
    Location,
    Product,
    Receipt,
    StagingItem,
    StagingRequest,
    StagingRequestItem,
    StorageArea,
    StorageRow,
    SubLocation,
    User,
    Vendor,
    Warehouse,
)
from app.services import receipt_service, staging_request_service

WH = "wh-cons-1"
PRODUCT = "prod-cons"
VENDOR = "vendor-cons"
ROW_1 = "row-cons-1"
SUB = "sub-cons"
BBD = datetime(2027, 10, 1, tzinfo=timezone.utc)
WEIGHT = 500.0


@pytest.fixture
def cons_seed(db_session):
    db_session.add(Warehouse(id=WH, name="Plant C", code="PC", type="owned", is_active=True))
    db_session.add(Category(id="cat-cons-ing", name="Ingredients", type="ingredient"))
    db_session.add(Product(id=PRODUCT, name="Cons Mango", category_id="cat-cons-ing",
                           sid="SID-CONS"))
    db_session.add(Vendor(id=VENDOR, name="Cons Vendor"))
    db_session.add(Location(id="loc-cons", name="Plant C", warehouse_id=WH))
    db_session.add(SubLocation(id=SUB, name="Drum Barn", location_id="loc-cons",
                               storage_unit="drum"))
    db_session.add(StorageArea(id="area-cons", name="Barn", location_id="loc-cons"))
    db_session.add(StorageRow(id=ROW_1, name="C-01", sub_location_id=SUB,
                              storage_area_id="area-cons", pallet_capacity=0))
    db_session.add(User(id="u-cons", username="cu", name="Cons User",
                        email="cu@x.test", hashed_password="x", role="admin",
                        is_active=True))
    db_session.commit()


class _Approver:
    id = "u-cons"
    role = "admin"
    name = "Cons User"
    warehouse_id = WH


def _gated_receipt(db, *, units, lot_number):
    receipt = Receipt(
        id=f"rcpt-cons-{uuid.uuid4().hex[:10]}",
        product_id=PRODUCT,
        category_id="cat-cons-ing",
        vendor_id=VENDOR,
        lot_number=lot_number,
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
        submitted_by="u-cons",
    )
    db.add(receipt)
    db.flush()
    receipt_service.approve_receipt(db, receipt, _Approver())
    db.flush()
    return receipt


class TestConsumeSpills:
    def test_excess_spills_to_the_lots_other_receipts(self, db_session, cons_seed):
        """Lot has receipts A (10 drums) and B (4 drums, same lot). Consuming
        9 drums through B used to clamp B at 0 and lose 5 drums of paper —
        Σ receipt.quantity overstated forever."""
        a = _gated_receipt(db_session, units=10, lot_number="CONS-1")
        b = _gated_receipt(db_session, units=4, lot_number="CONS-1")
        assert a.material_lot_id == b.material_lot_id

        staging_request_service.consume_receipt_quantity(db_session, b, 9 * WEIGHT)
        db_session.commit()
        assert float(b.quantity) == 0
        assert b.status == ReceiptStatus.DEPLETED
        assert float(a.quantity) == 5 * WEIGHT, "the excess lands on the sibling"

    def test_no_spill_needed_when_the_receipt_covers_it(self, db_session, cons_seed):
        a = _gated_receipt(db_session, units=10, lot_number="CONS-2")
        staging_request_service.consume_receipt_quantity(db_session, a, 3 * WEIGHT)
        assert float(a.quantity) == 7 * WEIGHT
        assert a.status == ReceiptStatus.APPROVED


class TestNotifySafety:
    def _linked_request(self, db, receipt, *, batch_uid="PB-123", staged=5 * WEIGHT):
        request = StagingRequest(
            id=f"sreq-{uuid.uuid4().hex[:8]}",
            production_batch_uid=batch_uid,
            status="in_progress",
        )
        db.add(request)
        staging_item = StagingItem(
            id=f"stag-{uuid.uuid4().hex[:8]}",
            transfer_id=None,
            receipt_id=receipt.id,
            product_id=PRODUCT,
            quantity_staged=staged,
            pallets_staged=0,
        )
        db.add(staging_item)
        db.flush()
        item = StagingRequestItem(
            id=f"sri-{uuid.uuid4().hex[:8]}",
            request_id=request.id,
            product_id=PRODUCT,
            sid="SID-CONS",
            ingredient_name="Cons Mango",
            quantity_needed=staged,
            quantity_fulfilled=staged,
            staging_item_ids=json.dumps([staging_item.id]),
        )
        db.add(item)
        db.flush()
        return request, staging_item

    def test_batch_uid_matches_exactly_not_by_substring(self, db_session, cons_seed):
        """A scan for batch PB-12 must NOT deduct the request holding PB-123."""
        receipt = _gated_receipt(db_session, units=10, lot_number="CONS-3")
        self._linked_request(db_session, receipt, batch_uid="PB-123")
        db_session.commit()

        result = staging_request_service.notify_ingredient_used(
            db_session, "PB-12", "SID-CONS", 2 * WEIGHT,
        )
        assert result["marked_count"] == 0 if "marked_count" in result else True
        db_session.refresh(receipt)
        assert float(receipt.quantity) == 10 * WEIGHT, "nothing deducted"

    def test_retried_event_deducts_once(self, db_session, cons_seed):
        """The same production scan delivered twice (webhook retry) must not
        double-deduct — the event id is the dedupe key."""
        receipt = _gated_receipt(db_session, units=10, lot_number="CONS-4")
        self._linked_request(db_session, receipt, batch_uid="PB-777")
        db_session.commit()

        for _ in range(2):
            staging_request_service.notify_ingredient_used(
                db_session, "PB-777", "SID-CONS", 2 * WEIGHT,
                event_id="scan-evt-1",
            )
        db_session.refresh(receipt)
        assert float(receipt.quantity) == 8 * WEIGHT, "deducted exactly once"

    def test_unresolvable_lot_barcode_deducts_nothing(self, db_session, cons_seed):
        """The worker scanned a lot the system doesn't know — refuse to guess
        (the old FIFO fallback deducted whatever was oldest)."""
        receipt = _gated_receipt(db_session, units=10, lot_number="CONS-5")
        self._linked_request(db_session, receipt, batch_uid="PB-888")
        db_session.commit()

        result = staging_request_service.notify_ingredient_used(
            db_session, "PB-888", "SID-CONS", 2 * WEIGHT,
            lot_barcode="L0000000-NOT-A-LOT",
        )
        assert result["status"] == "unmatched_lot"
        db_session.refresh(receipt)
        assert float(receipt.quantity) == 10 * WEIGHT


class TestRackSweep:
    """Post-consumption invariant (2026-09-17): racks may never claim more
    units than the paper says still exist."""

    def test_consumption_without_a_pull_sweeps_the_rack(self, db_session, cons_seed):
        """The ROW 4 (18) case: paper consumption with no staging pull used to
        leave the rack ledger stale forever."""
        from app.models import LotPlacement, LotPlacementEvent

        receipt = _gated_receipt(db_session, units=10, lot_number="SWEEP-1")
        staging_request_service.consume_receipt_quantity(db_session, receipt, 3 * WEIGHT)
        db_session.commit()

        placement = (
            db_session.query(LotPlacement)
            .filter(LotPlacement.material_lot_id == receipt.material_lot_id)
            .one()
        )
        assert placement.full_units == 7, "rack follows the paper down"
        sweep = (
            db_session.query(LotPlacementEvent)
            .filter(
                LotPlacementEvent.material_lot_id == receipt.material_lot_id,
                LotPlacementEvent.ref_type == "consumption-sweep",
            )
            .all()
        )
        assert sum(e.full_units_delta for e in sweep) == -3

    def test_properly_staged_lots_are_not_double_deducted(self, db_session, cons_seed):
        """A pull already freed the rack; consuming the staged material must
        not take the drums off a second time."""
        from app.models import LotPlacement
        from app.services import staging_service

        receipt = _gated_receipt(db_session, units=10, lot_number="SWEEP-2")
        # Proper pull: 4 drums leave the rack for staging.
        staging_service._stage_free_rack(db_session, receipt, 4 * WEIGHT, None,
                                         source_row_id=ROW_1)
        db_session.flush()
        # Production consumes those 4 staged drums (paper 10 → 8... → 6).
        staging_request_service.consume_receipt_quantity(db_session, receipt, 4 * WEIGHT)
        db_session.commit()

        placement = (
            db_session.query(LotPlacement)
            .filter(LotPlacement.material_lot_id == receipt.material_lot_id)
            .one()
        )
        assert placement.full_units == 6, "rack already freed at pull — no sweep"
