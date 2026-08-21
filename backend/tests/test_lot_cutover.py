"""Phase 3 — the cutover onto the lot model.

The owner's plan, which is much lighter than a stickering weekend: zero the old
receipts out (keeping the records), enter today's stock by hand, and let the
warehouse sticker itself over the following weeks as material is naturally used.

The properties worth guarding:

* **Records survive the zero-out.** Past batches were consumed from these
  receipts. Deleting them would empty the recall trace for every pre-cutover
  batch.
* **Nothing is derived from the old numbers.** Pallets have no fixed ratio to
  drums, and `container_count` is the AS-RECEIVED figure — using it as an opening
  balance would restore stock production already consumed.
* **A count can increase stock.** No code path anywhere could do that before.
* **Only ingredients are touched.** Raw material and packaging keep their
  receipts, their quantities and their allocation JSON.
"""
from datetime import datetime, timezone

import pytest

from app.enums import ReceiptStatus
from app.exceptions import ValidationError
from app.models import (
    Category,
    Location,
    LotPlacement,
    LotPlacementEvent,
    MaterialLot,
    Product,
    Receipt,
    StorageRow,
    SubLocation,
    User,
    Vendor,
    Warehouse,
)
from app.services import lot_cutover_service as lcs
from app.services import lot_placement_service as lps

WH = "wh-cut-1"
OTHER_WH = "wh-cut-2"
ING_PRODUCT = "prod-cut-mango"
RAW_PRODUCT = "prod-cut-raw"
PKG_PRODUCT = "prod-cut-pkg"
VENDOR = "vendor-cut"
ROW_1 = "row-cut-1"
COOLER = "row-cut-cooler"

BBD = datetime(2027, 5, 1, tzinfo=timezone.utc)


@pytest.fixture
def cutover_seed(db_session):
    db_session.add_all([
        Warehouse(id=WH, name="Plant A", code="PA", type="owned", is_active=True),
        Warehouse(id=OTHER_WH, name="Plant B", code="PB", type="owned", is_active=True),
    ])
    db_session.add_all([
        Category(id="cat-ing", name="Ingredients", type="ingredient"),
        Category(id="cat-raw", name="Raw", type="raw"),
        Category(id="cat-pkg", name="Packaging", type="packaging"),
    ])
    db_session.add_all([
        Product(id=ING_PRODUCT, name="Mango Puree", category_id="cat-ing", sid="SID-M"),
        Product(id=RAW_PRODUCT, name="Sugar", category_id="cat-raw"),
        Product(id=PKG_PRODUCT, name="Cartons", category_id="cat-pkg"),
    ])
    db_session.add(Vendor(id=VENDOR, name="Acme Juice"))
    # Placement events FK the actor, so a counter has to exist for any test that
    # passes user_id — which is every test that records a real count.
    db_session.add(User(
        id="u-1", username="cutworker", name="Cutover Worker",
        email="cutover@sunberry.com", hashed_password="x",
        role="warehouse", is_active=True,
    ))
    db_session.add(Location(id="loc-cut", name="Plant A", warehouse_id=WH))
    db_session.add(SubLocation(
        id="sub-cut", name="Drum Barn", location_id="loc-cut",
        storage_unit="drum", unit_capacity=22,
    ))
    db_session.add_all([
        StorageRow(id=ROW_1, name="A-01", sub_location_id="sub-cut", pallet_capacity=0),
        StorageRow(id=COOLER, name="Cooler-1", sub_location_id="sub-cut", pallet_capacity=0),
    ])
    db_session.commit()


def _legacy(db, *, rid, product, category, qty=20000.0, units=40, wh=WH):
    receipt = Receipt(
        id=rid, product_id=product, category_id=category,
        lot_number="OLD-1", quantity=qty, unit="lbs",
        container_count=units, container_unit="drums",
        weight_per_container=500.0, weight_unit="lbs",
        vendor_id=VENDOR, warehouse_id=wh,
        status=ReceiptStatus.APPROVED,
        raw_material_row_allocations=[{"rowId": ROW_1, "pallets": 40, "cases": qty}],
        receipt_date=datetime(2026, 5, 1, tzinfo=timezone.utc),
        note="Original note",
    )
    db.add(receipt)
    db.flush()
    return receipt


# ---------------------------------------------------------------------------
# Step 1 — zero out
# ---------------------------------------------------------------------------

class TestZeroOut:
    def test_preview_reports_without_changing_anything(self, db_session, cutover_seed):
        """A zero-out is reversible only by hand, so it is reviewed every time."""
        _legacy(db_session, rid="r-1", product=ING_PRODUCT, category="cat-ing")
        _legacy(db_session, rid="r-2", product=ING_PRODUCT, category="cat-ing", qty=5000.0, units=10)
        db_session.commit()

        preview = lcs.preview_zero_out(db_session, WH)
        assert preview["receipt_count"] == 2
        assert preview["total_quantity"] == 25000.0
        assert preview["products"][0]["product_name"] == "Mango Puree"
        assert preview["products"][0]["as_received_units_hint"] == 50

        assert db_session.query(Receipt).filter(Receipt.quantity > 0).count() == 2

    def test_it_zeroes_quantity_and_keeps_the_record(self, db_session, cutover_seed):
        """Past batches were consumed from these receipts. Deleting them would
        empty the recall trace for every pre-cutover batch."""
        receipt = _legacy(db_session, rid="r-1", product=ING_PRODUCT, category="cat-ing")
        db_session.commit()

        result = lcs.execute_zero_out(db_session, warehouse_id=WH, user_id="u-1")
        db_session.commit()

        assert result["zeroed"] == 1
        db_session.refresh(receipt)
        assert receipt.quantity == 0
        assert receipt.status == ReceiptStatus.DEPLETED
        assert receipt.is_deleted is False
        assert receipt.lot_number == "OLD-1"          # traceability intact
        assert receipt.container_count == 40
        assert "Original note" in receipt.note        # and its history

    def test_it_clears_the_allocation_json(self, db_session, cutover_seed):
        """Leaving it populated would keep the row cards claiming stock that is
        now zero."""
        receipt = _legacy(db_session, rid="r-1", product=ING_PRODUCT, category="cat-ing")
        db_session.commit()
        lcs.execute_zero_out(db_session, warehouse_id=WH, user_id="u-1")
        assert receipt.raw_material_row_allocations == []

    def test_raw_material_is_INCLUDED_and_packaging_is_not(self, db_session, cutover_seed):
        """Raw is in scope, and that is the whole point.

        There is no category typed `ingredient` in production — every puree and
        concentrate is typed `raw` — so a cutover scoped to `ingredient` alone
        would silently do nothing. Packaging stays out: it is counted in cases,
        not in drums.
        """
        raw = _legacy(db_session, rid="r-raw", product=RAW_PRODUCT, category="cat-raw")
        pkg = _legacy(db_session, rid="r-pkg", product=PKG_PRODUCT, category="cat-pkg")
        ing = _legacy(db_session, rid="r-ing", product=ING_PRODUCT, category="cat-ing")
        db_session.commit()

        assert lcs.preview_zero_out(db_session, WH)["receipt_count"] == 2
        lcs.execute_zero_out(db_session, warehouse_id=WH, user_id="u-1")

        assert raw.quantity == 0
        assert raw.status == ReceiptStatus.DEPLETED
        assert ing.quantity == 0
        # Packaging is untouched, quantity and allocation JSON alike.
        assert pkg.quantity == 20000.0
        assert pkg.status == ReceiptStatus.APPROVED
        assert pkg.raw_material_row_allocations

    def test_another_warehouse_is_untouched(self, db_session, cutover_seed):
        """One plant converts at a time."""
        mine = _legacy(db_session, rid="r-a", product=ING_PRODUCT, category="cat-ing")
        theirs = _legacy(db_session, rid="r-b", product=ING_PRODUCT, category="cat-ing", wh=OTHER_WH)
        db_session.commit()

        lcs.execute_zero_out(db_session, warehouse_id=WH, user_id="u-1")
        assert mine.quantity == 0
        assert theirs.quantity == 20000.0

    def test_running_it_twice_is_harmless(self, db_session, cutover_seed):
        _legacy(db_session, rid="r-1", product=ING_PRODUCT, category="cat-ing")
        db_session.commit()
        assert lcs.execute_zero_out(db_session, warehouse_id=WH, user_id="u-1")["zeroed"] == 1
        assert lcs.execute_zero_out(db_session, warehouse_id=WH, user_id="u-1")["zeroed"] == 0

    def test_it_removes_the_material_from_availability(self, db_session, cutover_seed):
        """The whole point: nothing double-counts once the stock is re-entered."""
        from app.services.availability import on_hand_for_product

        _legacy(db_session, rid="r-1", product=ING_PRODUCT, category="cat-ing")
        db_session.commit()
        assert on_hand_for_product(db_session, ING_PRODUCT)["total"] == 20000.0

        lcs.execute_zero_out(db_session, warehouse_id=WH, user_id="u-1")
        db_session.commit()
        assert on_hand_for_product(db_session, ING_PRODUCT)["total"] == 0.0


# ---------------------------------------------------------------------------
# Step 2 — opening balances
# ---------------------------------------------------------------------------

class TestOpeningBalance:
    def test_it_creates_the_lot_and_the_placement_together(self, db_session, cutover_seed):
        result = lcs.create_opening_balance(
            db_session,
            product_id=ING_PRODUCT, storage_row_id=ROW_1, full_units=31,
            vendor_id=VENDOR, vendor_lot="MG-2024-A", bbd=BBD,
            unit_label="drum", weight_per_unit=500.0, weight_unit="lbs",
            warehouse_id=WH, user_id="u-1",
        )
        assert result["full_units"] == 31
        assert result["derived_weight"] == 15500.0
        assert result["unit_label"] == "drum"
        assert result["needs_labels"] is True
        assert result["lot_code"].startswith("L")

        lot = db_session.query(MaterialLot).filter(
            MaterialLot.id == result["material_lot_id"]
        ).first()
        assert lot.vendor_lot_number == "MG-2024-A"
        assert lot.bbd_original == BBD and lot.bbd_current == BBD

    def test_a_second_entry_for_the_same_rack_adds(self, db_session, cutover_seed):
        """A rack holding one lot in two spots, or a correction after a miscount,
        both mean 'there is more here than I recorded'. Replacing would silently
        discard the first count."""
        common = dict(
            product_id=ING_PRODUCT, storage_row_id=ROW_1, vendor_id=VENDOR,
            vendor_lot="MG-1", bbd=BBD, unit_label="drum",
            weight_per_unit=500.0, weight_unit="lbs", warehouse_id=WH, user_id="u-1",
        )
        lcs.create_opening_balance(db_session, full_units=10, **common)
        second = lcs.create_opening_balance(db_session, full_units=6, **common)
        assert second["full_units"] == 16

    def test_two_lots_of_one_product_stay_separate(self, db_session, cutover_seed):
        """'I have each row, lot and vendor' — which is exactly what makes the
        by-hand entry possible without bringing drums out."""
        common = dict(
            product_id=ING_PRODUCT, storage_row_id=ROW_1, vendor_id=VENDOR,
            unit_label="drum", weight_per_unit=500.0, weight_unit="lbs",
            warehouse_id=WH, user_id="u-1",
        )
        a = lcs.create_opening_balance(db_session, vendor_lot="MG-1", bbd=BBD, full_units=10, **common)
        b = lcs.create_opening_balance(db_session, vendor_lot="MG-2", bbd=BBD, full_units=7, **common)
        assert a["material_lot_id"] != b["material_lot_id"]
        assert db_session.query(LotPlacement).filter(
            LotPlacement.storage_row_id == ROW_1
        ).count() == 2

    def test_partials_go_in_the_cooler_with_their_remaining_weight(
        self, db_session, cutover_seed
    ):
        """Opened drums are tagged and moved to a cooler, not back on the rack."""
        result = lcs.create_opening_balance(
            db_session, product_id=ING_PRODUCT, storage_row_id=COOLER,
            full_units=0, open_units=2, open_remaining_qty=310.0,
            vendor_id=VENDOR, vendor_lot="MG-1", bbd=BBD,
            unit_label="drum", weight_per_unit=500.0, weight_unit="lbs",
            warehouse_id=WH, user_id="u-1",
        )
        assert result["open_units"] == 2
        assert result["derived_weight"] == 310.0

    def test_it_refuses_an_empty_or_impossible_entry(self, db_session, cutover_seed):
        base = dict(product_id=ING_PRODUCT, storage_row_id=ROW_1, warehouse_id=WH)
        with pytest.raises(ValidationError):
            lcs.create_opening_balance(db_session, full_units=0, **base)
        with pytest.raises(ValidationError):
            lcs.create_opening_balance(db_session, full_units=-3, **base)
        with pytest.raises(ValidationError):
            # remaining weight with no opened drum to hold it
            lcs.create_opening_balance(
                db_session, full_units=1, open_units=0, open_remaining_qty=90.0, **base
            )

    def test_the_entry_is_marked_as_a_cutover_entry_in_the_ledger(
        self, db_session, cutover_seed
    ):
        """So it is never mistaken for a real receipt or a real count later."""
        result = lcs.create_opening_balance(
            db_session, product_id=ING_PRODUCT, storage_row_id=ROW_1,
            full_units=12, vendor_lot="MG-1", warehouse_id=WH, user_id="u-1",
        )
        event = db_session.query(LotPlacementEvent).filter(
            LotPlacementEvent.material_lot_id == result["material_lot_id"]
        ).one()
        assert event.event_type == lps.EVENT_OPENING_BALANCE
        assert event.ref_type == lcs.REF_TYPE_CUTOVER
        assert event.full_units_delta == 12

    def test_stock_entered_by_hand_is_immediately_available(self, db_session, cutover_seed):
        from app.services.availability import on_hand_for_product

        lcs.create_opening_balance(
            db_session, product_id=ING_PRODUCT, storage_row_id=ROW_1, full_units=31,
            vendor_id=VENDOR, vendor_lot="MG-1", bbd=BBD, unit_label="drum",
            weight_per_unit=500.0, weight_unit="lbs", warehouse_id=WH, user_id="u-1",
        )
        db_session.commit()
        result = on_hand_for_product(db_session, ING_PRODUCT)
        assert result["unit_count"] == 31
        assert result["total"] == 15500.0

    def test_zero_out_then_re_enter_does_not_double_count(self, db_session, cutover_seed):
        """The end-to-end property the whole cutover exists to produce."""
        from app.services.availability import on_hand_for_product

        _legacy(db_session, rid="r-1", product=ING_PRODUCT, category="cat-ing",
                qty=20000.0, units=40)
        db_session.commit()

        lcs.execute_zero_out(db_session, warehouse_id=WH, user_id="u-1")
        # The counter walks the rack and finds 31, not the 40 that arrived —
        # production used nine of them.
        lcs.create_opening_balance(
            db_session, product_id=ING_PRODUCT, storage_row_id=ROW_1, full_units=31,
            vendor_id=VENDOR, vendor_lot="OLD-1", bbd=BBD, unit_label="drum",
            weight_per_unit=500.0, weight_unit="lbs", warehouse_id=WH, user_id="u-1",
        )
        db_session.commit()

        result = on_hand_for_product(db_session, ING_PRODUCT)
        assert result["unit_count"] == 31
        assert result["total"] == 15500.0      # not 35,500


# ---------------------------------------------------------------------------
# Counting — the first flow that can raise stock
# ---------------------------------------------------------------------------

class TestPhysicalCount:
    def _lot(self, db, units=40):
        result = lcs.create_opening_balance(
            db, product_id=ING_PRODUCT, storage_row_id=ROW_1, full_units=units,
            vendor_id=VENDOR, vendor_lot="MG-1", bbd=BBD, unit_label="drum",
            weight_per_unit=500.0, weight_unit="lbs", warehouse_id=WH, user_id="u-1",
        )
        return result["material_lot_id"]

    def test_a_count_can_increase_stock(self, db_session, cutover_seed):
        """No code path anywhere could do this before."""
        lot_id = self._lot(db_session, units=40)
        result = lcs.count_row(
            db_session, material_lot_id=lot_id, storage_row_id=ROW_1,
            full_units=42, user_id="u-1",
        )
        assert result["system_units"] == 40
        assert result["counted_units"] == 42
        assert result["variance"] == 2

    def test_a_count_can_decrease_stock(self, db_session, cutover_seed):
        lot_id = self._lot(db_session, units=40)
        result = lcs.count_row(
            db_session, material_lot_id=lot_id, storage_row_id=ROW_1,
            full_units=38, user_id="u-1",
        )
        assert result["variance"] == -2
        assert result["derived_weight"] == 19000.0

    def test_the_variance_is_a_whole_number_of_drums(self, db_session, cutover_seed):
        """The defect this replaces: cycle counting derived drums as
        quantity / weight_per_container and produced '98.82 drums'."""
        lot_id = self._lot(db_session, units=99)
        result = lcs.count_row(
            db_session, material_lot_id=lot_id, storage_row_id=ROW_1,
            full_units=98, user_id="u-1",
        )
        assert result["variance"] == -1
        assert isinstance(result["variance"], int)
        assert result["unit_label"] == "drum"

    def test_the_variance_survives_in_the_ledger(self, db_session, cutover_seed):
        """The new figure does not quietly overwrite the old one."""
        lot_id = self._lot(db_session, units=40)
        lcs.count_row(db_session, material_lot_id=lot_id, storage_row_id=ROW_1,
                      full_units=38, user_id="u-1", note="Month end")

        counted = db_session.query(LotPlacementEvent).filter(
            LotPlacementEvent.material_lot_id == lot_id,
            LotPlacementEvent.event_type == lps.EVENT_COUNTED,
        ).one()
        assert counted.full_units_delta == -2
        assert counted.reason == "Month end"
        assert lps.reconcile_lot(db_session, lot_id)["drifted"] == 0


# ---------------------------------------------------------------------------
# Step 3 — lazy stickering
# ---------------------------------------------------------------------------

class TestLazyLabelling:
    def test_stock_entered_by_hand_starts_unstickered(self, db_session, cutover_seed):
        """The owner cannot ask a crew to bring every drum out, sticker it, scan
        it and put it back. Stock sits with a known count and no sticker."""
        lcs.create_opening_balance(
            db_session, product_id=ING_PRODUCT, storage_row_id=ROW_1, full_units=31,
            vendor_id=VENDOR, vendor_lot="MG-1", bbd=BBD, unit_label="drum",
            weight_per_unit=500.0, weight_unit="lbs", warehouse_id=WH, user_id="u-1",
        )
        pending = lcs.unlabelled_lots(db_session, WH)
        assert len(pending) == 1
        assert pending[0]["full_units"] == 31
        assert pending[0]["vendor_lot"] == "MG-1"

    def test_printing_takes_a_lot_off_the_working_list(self, db_session, cutover_seed):
        from app.services import lot_receiving_service as lrs

        result = lcs.create_opening_balance(
            db_session, product_id=ING_PRODUCT, storage_row_id=ROW_1, full_units=31,
            vendor_id=VENDOR, vendor_lot="MG-1", bbd=BBD, unit_label="drum",
            weight_per_unit=500.0, weight_unit="lbs", warehouse_id=WH, user_id="u-1",
        )
        lot = db_session.query(MaterialLot).filter(
            MaterialLot.id == result["material_lot_id"]
        ).first()
        lrs.label_sheet_for_lot(db_session, lot, 31)
        assert lcs.unlabelled_lots(db_session, WH) == []

    def test_a_depleted_lot_is_not_on_the_list(self, db_session, cutover_seed):
        """Nobody needs stickers for drums that are gone."""
        result = lcs.create_opening_balance(
            db_session, product_id=ING_PRODUCT, storage_row_id=ROW_1, full_units=5,
            vendor_lot="MG-1", warehouse_id=WH, user_id="u-1",
        )
        lot = db_session.query(MaterialLot).filter(
            MaterialLot.id == result["material_lot_id"]
        ).first()
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_CONSUMED,
                        full_units_delta=-5)
        assert lcs.unlabelled_lots(db_session, WH) == []


class TestCutoverStatus:
    def test_it_walks_through_the_three_steps(self, db_session, cutover_seed):
        from app.services import lot_receiving_service as lrs

        _legacy(db_session, rid="r-1", product=ING_PRODUCT, category="cat-ing")
        db_session.commit()
        assert lcs.cutover_status(db_session, WH)["step"] == "zero_out"

        lcs.execute_zero_out(db_session, warehouse_id=WH, user_id="u-1")
        assert lcs.cutover_status(db_session, WH)["step"] == "opening_balances"

        result = lcs.create_opening_balance(
            db_session, product_id=ING_PRODUCT, storage_row_id=ROW_1, full_units=31,
            vendor_lot="MG-1", bbd=BBD, weight_per_unit=500.0, weight_unit="lbs",
            warehouse_id=WH, user_id="u-1",
        )
        status = lcs.cutover_status(db_session, WH)
        assert status["step"] == "labelling"
        assert status["counted_lots"] == 1
        assert status["lots_awaiting_labels"] == 1

        lot = db_session.query(MaterialLot).filter(
            MaterialLot.id == result["material_lot_id"]
        ).first()
        lrs.label_sheet_for_lot(db_session, lot, 31)
        assert lcs.cutover_status(db_session, WH)["step"] == "complete"


class TestMissingWeightIsRefused:
    """A lot with no weight per unit derives ZERO pounds.

    That is not a cosmetic gap. Because a counted lot's receipt steps aside from
    the legacy availability sum — the double-count rule — scanning such material
    IN makes it vanish from availability entirely: eighty drums in the barn read
    as nothing at all to the production scheduling gate.

    The lot is flagged instead, which stops stickers printing, and since nothing
    can be scanned in without a sticker the number has to exist before any of it
    becomes stock.
    """

    def test_a_weightless_lot_is_flagged_on_creation(self, db_session, cutover_seed):
        result = lcs.create_opening_balance(
            db_session, product_id=ING_PRODUCT, storage_row_id=ROW_1, full_units=10,
            vendor_lot="NO-WEIGHT", warehouse_id=WH, user_id="u-1",
        )
        lot = db_session.query(MaterialLot).filter(
            MaterialLot.id == result["material_lot_id"]
        ).first()
        assert lot.needs_review is True
        assert "weight per unit" in lot.review_reason

    def test_no_stickers_print_for_it(self, db_session, cutover_seed):
        from app.exceptions import ConflictError
        from app.services import lot_receiving_service as lrs

        result = lcs.create_opening_balance(
            db_session, product_id=ING_PRODUCT, storage_row_id=ROW_1, full_units=10,
            vendor_lot="NO-WEIGHT", warehouse_id=WH, user_id="u-1",
        )
        lot = db_session.query(MaterialLot).filter(
            MaterialLot.id == result["material_lot_id"]
        ).first()
        with pytest.raises(ConflictError):
            lrs.label_sheet_for_lot(db_session, lot, 10)

    def test_supplying_the_weight_later_clears_the_flag(self, db_session, cutover_seed):
        from app.services import lot_placement_service as lps_

        lcs.create_opening_balance(
            db_session, product_id=ING_PRODUCT, storage_row_id=ROW_1, full_units=10,
            vendor_lot="LATE-WEIGHT", bbd=BBD, warehouse_id=WH, user_id="u-1",
        )
        # The second arrival of the same lot brings the number with it.
        lot = lps_.find_or_create_lot(
            db_session, product_id=ING_PRODUCT, vendor_id=None,
            vendor_lot_number="LATE-WEIGHT", bbd=BBD, unit_label="drum",
            weight_per_unit=500.0, weight_unit="lbs", warehouse_id=WH,
        )
        assert lot.weight_per_unit == 500.0
        assert lot.needs_review is False

    def test_a_conflicting_weight_flag_is_NOT_cleared_by_a_later_fill(
        self, db_session, cutover_seed
    ):
        """Only the flag this rule raised gets cleared. A conflicting-weight
        review is somebody else's to resolve."""
        from app.services import lot_placement_service as lps_

        lot = lps_.find_or_create_lot(
            db_session, product_id=ING_PRODUCT, vendor_id=None,
            vendor_lot_number="CONFLICT", bbd=BBD, unit_label="drum",
            weight_per_unit=500.0, weight_unit="lbs", warehouse_id=WH,
        )
        lps_.find_or_create_lot(
            db_session, product_id=ING_PRODUCT, vendor_id=None,
            vendor_lot_number="CONFLICT", bbd=BBD, unit_label="drum",
            weight_per_unit=550.0, weight_unit="lbs", warehouse_id=WH,
        )
        assert lot.needs_review is True
        again = lps_.find_or_create_lot(
            db_session, product_id=ING_PRODUCT, vendor_id=None,
            vendor_lot_number="CONFLICT", bbd=BBD, unit_label="drum",
            weight_per_unit=500.0, weight_unit="lbs", warehouse_id=WH,
        )
        assert again.needs_review is True


class TestUnknownLotsStaySeparate:
    def test_two_unreadable_arrivals_are_two_lots(self, db_session, cutover_seed):
        """The model forbids one giant "unknown" bucket. Two trucks whose drum
        markings could not be read are two deliveries, and since every drum of a
        lot wears the same sticker, merging them is unrecoverable."""
        first = lcs.create_opening_balance(
            db_session, product_id=ING_PRODUCT, storage_row_id=ROW_1, full_units=5,
            vendor_lot=None, weight_per_unit=500.0, warehouse_id=WH, user_id="u-1",
        )
        second = lcs.create_opening_balance(
            db_session, product_id=ING_PRODUCT, storage_row_id=COOLER, full_units=7,
            vendor_lot=None, weight_per_unit=500.0, warehouse_id=WH, user_id="u-1",
        )
        assert first["material_lot_id"] != second["material_lot_id"]
        assert first["lot_code"] != second["lot_code"]

    def test_a_known_lot_still_merges(self, db_session, cutover_seed):
        """The separation applies ONLY to unknown lots."""
        first = lcs.create_opening_balance(
            db_session, product_id=ING_PRODUCT, storage_row_id=ROW_1, full_units=5,
            vendor_lot="KNOWN-1", bbd=BBD, weight_per_unit=500.0,
            warehouse_id=WH, user_id="u-1",
        )
        second = lcs.create_opening_balance(
            db_session, product_id=ING_PRODUCT, storage_row_id=COOLER, full_units=7,
            vendor_lot="KNOWN-1", bbd=BBD, weight_per_unit=500.0,
            warehouse_id=WH, user_id="u-1",
        )
        assert first["material_lot_id"] == second["material_lot_id"]


class TestZeroOutScoping:
    def test_it_refuses_to_run_without_a_warehouse(self, db_session, cutover_seed):
        """A None scope means EVERY warehouse. A company-wide admin has
        warehouse_id = None, and that is exactly the account somebody would use
        to run a cutover."""
        _legacy(db_session, rid="r-1", product=ING_PRODUCT, category="cat-ing")
        db_session.commit()
        with pytest.raises(ValidationError):
            lcs.execute_zero_out(db_session, warehouse_id=None, user_id="u-1")

    def test_a_receipt_already_on_the_lot_model_is_left_alone(
        self, db_session, cutover_seed
    ):
        """Otherwise the cutover never reads complete, and a re-run would destroy
        live stock that is mid-receiving."""
        legacy = _legacy(db_session, rid="r-legacy", product=ING_PRODUCT, category="cat-ing")
        live = _legacy(db_session, rid="r-live", product=ING_PRODUCT, category="cat-ing")
        lot = lps.find_or_create_lot(
            db_session, product_id=ING_PRODUCT, vendor_id=VENDOR,
            vendor_lot_number="LIVE-1", bbd=BBD, unit_label="drum",
            weight_per_unit=500.0, weight_unit="lbs", warehouse_id=WH,
        )
        live.material_lot_id = lot.id
        db_session.commit()

        preview = lcs.preview_zero_out(db_session, WH)
        assert preview["receipt_count"] == 1

        lcs.execute_zero_out(db_session, warehouse_id=WH, user_id="u-1")
        assert legacy.quantity == 0
        assert live.quantity == 20000.0
        assert lcs.cutover_status(db_session, WH)["legacy_receipts_with_stock"] == 0
