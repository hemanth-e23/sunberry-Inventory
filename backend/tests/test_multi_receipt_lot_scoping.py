"""Multi-receipt lots and the 2026-09-29 audit fixes.

One physical lot can arrive as several receipts (two trucks, two receiving
sessions — DTFOAMP/040526 landed as 80 + 40 drums). The racks track the LOT;
the paper tracks each DELIVERY. Everything here pins the seam between them:

- availability and reservation measured across the lot's receipts, not one;
- paper deductions spilling across siblings instead of clamping at zero;
- the projection landing on a receipt the forms can still see;
- box lots keeping their per-pallet packing ("boxes" != "boxe");
- held lots refusing counts, undo-scans and legacy ship-outs.
"""

import uuid
from datetime import datetime, timezone

import pytest

from app.constants import pluralize_unit
from app.enums import ReceiptStatus, TransferStatus
from app.exceptions import ValidationError
from app.models import (
    Category,
    InventoryTransfer,
    Location,
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
from app.services import (
    lot_cutover_service,
    lot_placement_service as lps,
    lot_receiving_service as lrs,
    receipt_service,
    transfer_service,
)

WH = "wh-mrl-1"
PRODUCT = "prod-mrl-mango"
VENDOR = "vendor-mrl"
ROW_A = "row-mrl-a"
ROW_B = "row-mrl-b"
BBD = datetime(2028, 5, 3, tzinfo=timezone.utc)


class _Approver:
    id = "u-mrl-approve"
    role = "admin"
    name = "Ada"


@pytest.fixture
def seed(db_session):
    db_session.add(Warehouse(id=WH, name="Plant M", code="PM", type="owned", is_active=True))
    db_session.add(Category(id="cat-mrl-raw", name="Raw", type="raw"))
    db_session.add(Product(id=PRODUCT, name="Mango Puree M", category_id="cat-mrl-raw"))
    db_session.add(Vendor(id=VENDOR, name="Vendor M"))
    db_session.add(Location(id="loc-mrl", name="Plant M", warehouse_id=WH))
    db_session.add(SubLocation(
        id="sub-mrl", name="Drum Room", location_id="loc-mrl",
        storage_unit="drum", unit_capacity=500,
    ))
    db_session.add(StorageArea(id="area-mrl", name="Room", location_id="loc-mrl"))
    db_session.add_all([
        StorageRow(id=ROW_A, name="M-01", sub_location_id="sub-mrl",
                   storage_area_id="area-mrl", pallet_capacity=0),
        StorageRow(id=ROW_B, name="M-02", sub_location_id="sub-mrl",
                   storage_area_id="area-mrl", pallet_capacity=0),
    ])
    db_session.add_all([
        User(id="u-mrl-submit", username="mia", name="Mia", email="mia@x.test",
             hashed_password="x", role="warehouse", is_active=True),
        User(id="u-mrl-approve", username="ada2", name="Ada", email="ada2@x.test",
             hashed_password="x", role="admin", is_active=True),
    ])
    db_session.commit()


def _delivery(db, *, drums, lot_number="DTFOAMP/040526", row=ROW_A, per_drum=474.0):
    """One truck of the lot: a receipt approved onto a rack."""
    receipt = Receipt(
        id=f"rcpt-mrl-{uuid.uuid4().hex[:10]}",
        product_id=PRODUCT, category_id="cat-mrl-raw", vendor_id=VENDOR,
        lot_number=lot_number, expiration_date=BBD,
        quantity=drums * per_drum, unit="lbs",
        container_count=drums, container_unit="drums",
        weight_per_container=per_drum, weight_unit="lbs",
        warehouse_id=WH, status=ReceiptStatus.RECORDED,
        submitted_by="u-mrl-submit",
        raw_material_row_allocations=[{"rowId": row, "units": drums}],
    )
    db.add(receipt)
    db.flush()
    receipt_service.approve_receipt(db, receipt, _Approver())
    db.flush()
    return receipt


def _pending_transfer(db, receipt, *, lbs, to_row=ROW_B):
    tr = InventoryTransfer(
        id=f"transfer-mrl-{uuid.uuid4().hex[:8]}",
        receipt_id=receipt.id, quantity=lbs, unit="lbs",
        transfer_type="warehouse-transfer",
        source_breakdown=[{"id": f"row-{ROW_A}", "quantity": lbs}],
        destination_breakdown=[{"id": f"row-{to_row}", "quantity": lbs}],
        requested_by="u-mrl-submit", warehouse_id=WH,
        status=TransferStatus.PENDING,
    )
    db.add(tr)
    db.flush()
    return tr


# ---------------------------------------------------------------------------
# Lot-scoped availability (the DTFOAMP rejection)
# ---------------------------------------------------------------------------

class TestLotScopedAvailability:
    def test_pool_spans_the_siblings(self, db_session, seed):
        """80 + 40 drums on two receipts is one 120-drum pool."""
        r1 = _delivery(db_session, drums=80)
        _delivery(db_session, drums=40)
        pool = transfer_service.lot_scoped_availability(db_session, r1)
        assert pool["total"] == pytest.approx(120 * 474.0)
        assert pool["available"] == pytest.approx(120 * 474.0)

    def test_the_reported_rejection_now_passes(self, db_session, seed):
        """60 pending + 40 more = 100 of the lot's 120 — refused before,
        because the carrier receipt only held 80."""
        r1 = _delivery(db_session, drums=80)
        _delivery(db_session, drums=40)
        _pending_transfer(db_session, r1, lbs=60 * 474.0)
        pool = transfer_service.lot_scoped_availability(db_session, r1)
        assert pool["reserved"] == pytest.approx(60 * 474.0)
        assert pool["available"] == pytest.approx(60 * 474.0)  # 40 fits

    def test_sibling_reservations_are_visible_to_each_other(self, db_session, seed):
        """Two pending transfers booked against DIFFERENT sibling receipts
        used to be invisible to each other (finding 9)."""
        r1 = _delivery(db_session, drums=80)
        r2 = _delivery(db_session, drums=40)
        _pending_transfer(db_session, r1, lbs=80 * 474.0)
        _pending_transfer(db_session, r2, lbs=30 * 474.0)
        pool = transfer_service.lot_scoped_availability(db_session, r1)
        assert pool["reserved"] == pytest.approx(110 * 474.0)
        assert pool["available"] == pytest.approx(10 * 474.0)

    def test_approve_coverage_measures_the_lot(self, db_session, seed):
        """_require_unreserved_coverage says "lot" — the number is one too."""
        r1 = _delivery(db_session, drums=80)
        _delivery(db_session, drums=40)
        tr = _pending_transfer(db_session, r1, lbs=100 * 474.0)
        # 100 drums of a 120-drum lot: covered, despite the 80-drum receipt.
        transfer_service._require_unreserved_coverage(db_session, tr, r1)


# ---------------------------------------------------------------------------
# Paper spill (deduction and credit)
# ---------------------------------------------------------------------------

class TestReceiptSpill:
    def test_deduction_spills_to_the_sibling(self, db_session, seed):
        r1 = _delivery(db_session, drums=80)
        r2 = _delivery(db_session, drums=40)
        transfer_service.spill_receipt_deduction(db_session, r1, 100 * 474.0)
        assert r1.quantity == pytest.approx(0)
        assert r1.status == ReceiptStatus.DEPLETED
        assert r2.quantity == pytest.approx(20 * 474.0)

    def test_credit_unspills_up_to_the_delivered_cap(self, db_session, seed):
        r1 = _delivery(db_session, drums=80)
        r2 = _delivery(db_session, drums=40)
        transfer_service.spill_receipt_deduction(db_session, r1, 100 * 474.0)
        transfer_service.spill_receipt_credit(db_session, r1, 100 * 474.0)
        # Back where it started: neither receipt above its own delivery.
        assert r1.quantity == pytest.approx(80 * 474.0)
        assert r1.status == ReceiptStatus.APPROVED
        assert r2.quantity == pytest.approx(40 * 474.0)


# ---------------------------------------------------------------------------
# Projection carrier stays visible
# ---------------------------------------------------------------------------

class TestProjectionCarrier:
    def test_projection_moves_off_a_depleted_receipt(self, db_session, seed):
        """The newest receipt depleting used to take the whole lot off the
        transfer/adjustment screens while drums stood on the racks
        (finding 2 — the steady state for consumed multi-receipt lots)."""
        r1 = _delivery(db_session, drums=80)
        r2 = _delivery(db_session, drums=40)  # newest → initial carrier
        r2.quantity = 0
        r2.status = ReceiptStatus.DEPLETED
        lot = db_session.get(MaterialLot, r1.material_lot_id)
        lps.project_lot(db_session, lot)
        assert (r1.raw_material_row_allocations or []) != []
        assert (r2.raw_material_row_allocations or []) == []


# ---------------------------------------------------------------------------
# Boxes and plurals
# ---------------------------------------------------------------------------

class TestBoxStemming:
    def test_boxes_singularizes_to_box(self, db_session, seed):
        receipt = Receipt(
            id=f"rcpt-mrl-{uuid.uuid4().hex[:10]}",
            product_id=PRODUCT, category_id="cat-mrl-raw", vendor_id=VENDOR,
            lot_number="BOXLOT-1", expiration_date=BBD,
            quantity=500 * 10.0, unit="lbs",
            container_count=500, container_unit="boxes",
            weight_per_container=10.0, weight_unit="lbs",
            units_per_pallet=50,
            warehouse_id=WH, status=ReceiptStatus.RECORDED,
            submitted_by="u-mrl-submit",
            raw_material_row_allocations=[{"rowId": ROW_A, "units": 500}],
        )
        db_session.add(receipt)
        db_session.flush()
        receipt_service.approve_receipt(db_session, receipt, _Approver())
        db_session.flush()
        lot = db_session.get(MaterialLot, receipt.material_lot_id)
        # "boxes" -> "box" (not "boxe"), so the palletised check holds and
        # units_per_pallet survives onto the lot (finding 6).
        assert lot.unit_label == "box"
        assert lot.units_per_pallet == 50

    def test_pluralize_unit(self):
        assert pluralize_unit("box") == "boxes"
        assert pluralize_unit("drum") == "drums"
        assert pluralize_unit("bags") == "bags"


# ---------------------------------------------------------------------------
# Hold escape routes
# ---------------------------------------------------------------------------

class TestHoldEscapeRoutes:
    def test_count_refuses_a_held_lot(self, db_session, seed):
        r1 = _delivery(db_session, drums=40)
        lot = db_session.get(MaterialLot, r1.material_lot_id)
        lot.is_held = True
        db_session.flush()
        with pytest.raises(ValidationError):
            lot_cutover_service.count_row(
                db_session, material_lot_id=lot.id, storage_row_id=ROW_A,
                full_units=0, user_id="u-mrl-approve",
            )

    def test_undo_scan_refuses_a_held_lot(self, db_session, seed):
        r1 = _delivery(db_session, drums=40)
        lot = db_session.get(MaterialLot, r1.material_lot_id)
        lot.is_held = True
        db_session.flush()
        result = lrs.undo_last_scan(db_session, receipt_id=r1.id,
                                    user_id="u-mrl-approve")
        assert result["status"] in ("lot_held", "nothing_to_undo")
        # Whatever the path, no drum left the rack.
        assert lps.units_on_hand(db_session, lot.id)["full_units"] == 40

    def test_transfer_approval_refuses_a_held_lot(self, db_session, seed):
        r1 = _delivery(db_session, drums=40)
        tr = _pending_transfer(db_session, r1, lbs=10 * 474.0)
        lot = db_session.get(MaterialLot, r1.material_lot_id)
        lot.is_held = True
        db_session.flush()
        with pytest.raises(ValidationError):
            transfer_service.approve_transfer(db_session, tr, _Approver())
