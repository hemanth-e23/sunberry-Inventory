"""Phase 1 of the lot-level ingredient model — lot identity, unit counts, and the
projection into the legacy allocation JSON.

Four properties are worth having tests for, because each replaces something that
was demonstrably wrong before:

1. **Lot identity merges the same vendor lot and separates different ones.**
   The lot is what a sticker names, and every drum of a lot wears an identical
   one. A wrong merge is a traceability failure a recall cannot untangle.
2. **The count is an integer somebody counted; pounds are derived.**
   Cycle Counting used to derive drums as `quantity / weight_per_container` and
   produce "98.82 drums", a variance nobody can act on.
3. **The projection writes a REAL `cases` value.** Without it
   `row_allocation._entry_cases` falls through to `pallets * 40`, so a
   20,000 lb / 40-drum lot reads back as 1,600 "cases".
4. **The allocation JSON has exactly one writer.** A counted lot's JSON is
   derived, so a second writer editing it is refused rather than silently
   reverted by the next projection.
"""
from datetime import datetime, timezone

import pytest

from app.exceptions import ConflictError
from app.models import (
    Category,
    LotPlacement,
    LotPlacementEvent,
    Location,
    MaterialLot,
    Product,
    Receipt,
    StorageArea,
    StorageRow,
    SubLocation,
    Vendor,
    Warehouse,
)
from app.services import lot_placement_service as lps
from app.services import row_allocation

WH = "wh-lot-1"
PRODUCT = "prod-mango-puree"
OTHER_PRODUCT = "prod-guava-puree"
VENDOR_A = "vendor-a"
VENDOR_B = "vendor-b"
ROW_1 = "row-drum-1"
ROW_2 = "row-drum-2"

BBD = datetime(2027, 1, 15, tzinfo=timezone.utc)
LATER_BBD = datetime(2027, 6, 30, tzinfo=timezone.utc)


@pytest.fixture
def lot_seed(db_session):
    """A drum room with two rows, two products, two vendors."""
    db_session.add(Warehouse(id=WH, name="Plant A", code="PA", type="owned", is_active=True))
    db_session.add(Category(id="cat-ingredient", name="Ingredients", type="ingredient"))
    db_session.add(Category(id="cat-raw", name="Raw", type="raw"))
    db_session.add_all([
        Product(id=PRODUCT, name="Mango Puree", category_id="cat-ingredient"),
        Product(id=OTHER_PRODUCT, name="Guava Puree", category_id="cat-ingredient"),
    ])
    db_session.add_all([
        Vendor(id=VENDOR_A, name="Vendor A"),
        Vendor(id=VENDOR_B, name="Vendor B"),
    ])
    db_session.add(Location(id="loc-1", name="Plant A", warehouse_id=WH))
    db_session.add(
        SubLocation(
            id="sub-drums", name="Drum Barn", location_id="loc-1",
            # A unit-typed room: 22 drums per row, deliberately NOT a
            # pallet_capacity — see models/location.py.
            storage_unit="drum", unit_capacity=22,
        )
    )
    db_session.add(StorageArea(id="area-1", name="Barn", location_id="loc-1"))
    db_session.add_all([
        StorageRow(
            id=ROW_1, name="A-01", sub_location_id="sub-drums",
            storage_area_id="area-1", pallet_capacity=0,
        ),
        StorageRow(
            id=ROW_2, name="A-02", sub_location_id="sub-drums",
            storage_area_id="area-1", pallet_capacity=0,
        ),
    ])
    db_session.commit()


def _lot(db, *, vendor=VENDOR_A, lot_number="MG-2411", bbd=BBD, weight=500.0,
         product=PRODUCT):
    return lps.find_or_create_lot(
        db,
        product_id=product,
        vendor_id=vendor,
        vendor_lot_number=lot_number,
        bbd=bbd,
        unit_label="drum",
        weight_per_unit=weight,
        weight_unit="lbs",
        warehouse_id=WH,
    )


# ---------------------------------------------------------------------------
# Lot identity
# ---------------------------------------------------------------------------

class TestLotIdentity:
    def test_same_vendor_lot_on_a_second_truck_is_the_same_lot(self, db_session, lot_seed):
        """The whole reason identity cannot live on Receipt."""
        first = _lot(db_session)
        second = _lot(db_session)
        assert first.id == second.id
        assert first.lot_code == second.lot_code

    def test_lot_number_normalization_is_case_and_whitespace_insensitive(self, db_session, lot_seed):
        first = _lot(db_session, lot_number="MG-2411")
        second = _lot(db_session, lot_number="  mg-2411  ")
        assert first.id == second.id

    def test_normalization_stops_there(self, db_session, lot_seed):
        """Punctuation and leading zeros are NOT stripped.

        Under-normalizing costs an extra sticker design. Over-normalizing merges
        two real lots, and every drum of both is then wearing the same label.
        """
        assert _lot(db_session, lot_number="MG-2411").id != _lot(
            db_session, lot_number="MG2411"
        ).id
        assert _lot(db_session, lot_number="0042").id != _lot(
            db_session, lot_number="42"
        ).id

    def test_different_vendor_same_lot_number_stays_separate(self, db_session, lot_seed):
        """Two vendors both call a lot "001". They are not the same material."""
        assert _lot(db_session, vendor=VENDOR_A).id != _lot(db_session, vendor=VENDOR_B).id

    def test_different_bbd_stays_separate(self, db_session, lot_seed):
        assert _lot(db_session, bbd=BBD).id != _lot(db_session, bbd=LATER_BBD).id

    def test_different_product_stays_separate(self, db_session, lot_seed):
        assert _lot(db_session, product=PRODUCT).id != _lot(
            db_session, product=OTHER_PRODUCT
        ).id

    def test_null_vendor_and_null_bbd_still_collapse_to_one_key(self, db_session, lot_seed):
        """A UNIQUE index on the four columns would not constrain these at all —
        Postgres treats NULLs as distinct — which is why lot_key is one string."""
        first = _lot(db_session, vendor=None, bbd=None)
        second = _lot(db_session, vendor=None, bbd=None)
        assert first.id == second.id
        assert first.lot_key == f"{PRODUCT}||MG-2411|"

    def test_bbd_extension_does_not_re_key_the_lot(self, db_session, lot_seed):
        """The load-bearing BBD split. Stickers already on drums stay valid."""
        lot = _lot(db_session)
        original_key = lot.lot_key

        lot.bbd_current = LATER_BBD
        db_session.flush()

        again = _lot(db_session)  # arrives with the ORIGINAL printed BBD
        assert again.id == lot.id
        assert again.lot_key == original_key
        assert again.bbd_current == LATER_BBD
        assert again.bbd_original == BBD

    def test_conflicting_weight_flags_review_and_keeps_the_original(self, db_session, lot_seed):
        """Silently adopting the new figure would restate every pound already
        derived from this lot."""
        lot = _lot(db_session, weight=500.0)
        again = _lot(db_session, weight=550.0)

        assert again.id == lot.id
        assert again.weight_per_unit == 500.0
        assert again.needs_review is True
        assert "550" in again.review_reason

    def test_no_sticker_prints_for_a_lot_under_review(self, db_session, lot_seed):
        lot = _lot(db_session, weight=500.0)
        assert lps.can_print_labels(lot)[0] is True
        _lot(db_session, weight=550.0)
        allowed, reason = lps.can_print_labels(lot)
        assert allowed is False
        assert reason

    def test_missing_weight_is_filled_in_rather_than_flagged(self, db_session, lot_seed):
        lot = _lot(db_session, weight=None)
        assert lot.weight_per_unit is None
        again = _lot(db_session, weight=500.0)
        assert again.weight_per_unit == 500.0
        assert again.needs_review is False

    def test_lot_codes_are_unique_and_carry_nothing(self, db_session, lot_seed):
        """The QR payload is an opaque pointer, so nothing printed can go stale."""
        codes = {
            _lot(db_session, lot_number=f"LOT-{i}").lot_code for i in range(5)
        }
        assert len(codes) == 5
        for code in codes:
            assert code.startswith("L")
            assert PRODUCT not in code and VENDOR_A not in code


# ---------------------------------------------------------------------------
# Counting
# ---------------------------------------------------------------------------

class TestUnitCounts:
    def test_units_are_integers_and_pounds_are_derived(self, db_session, lot_seed):
        """The defect this model exists to remove: 40 drums, not 39.994 drums."""
        lot = _lot(db_session, weight=500.0)
        lps.apply_delta(
            db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=40
        )
        placement = lps._lock_placement(db_session, lot.id, ROW_1)

        assert placement.full_units == 40
        assert isinstance(placement.full_units, int)
        assert lps.derived_weight(lot, placement) == 20000.0

    def test_correcting_the_weight_fixes_every_derived_pound_at_once(self, db_session, lot_seed):
        lot = _lot(db_session, weight=500.0)
        lps.apply_delta(
            db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=40
        )
        lot.weight_per_unit = 550.0
        db_session.flush()

        placement = lps._lock_placement(db_session, lot.id, ROW_1)
        assert placement.full_units == 40          # the count did not move
        assert lps.derived_weight(lot, placement) == 22000.0

    def test_one_placement_per_lot_and_row(self, db_session, lot_seed):
        lot = _lot(db_session)
        for _ in range(3):
            lps.apply_delta(
                db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=10
            )
        placements = db_session.query(LotPlacement).filter(
            LotPlacement.material_lot_id == lot.id
        ).all()
        assert len(placements) == 1
        assert placements[0].full_units == 30

    def test_a_row_holds_several_lots_and_several_products(self, db_session, lot_seed):
        """Explicitly supported: the owner confirmed rows are mixed."""
        mango = _lot(db_session, product=PRODUCT, lot_number="MG-1")
        guava = _lot(db_session, product=OTHER_PRODUCT, lot_number="GV-1")
        lps.apply_delta(db_session, mango, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=10)
        lps.apply_delta(db_session, guava, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=5)

        rows = db_session.query(LotPlacement).filter(LotPlacement.storage_row_id == ROW_1).all()
        assert len(rows) == 2
        assert {r.product_id for r in rows} == {PRODUCT, OTHER_PRODUCT}

    def test_a_count_below_zero_is_refused_not_clamped(self, db_session, lot_seed):
        """A clamp hides the discrepancy behind a plausible number."""
        lot = _lot(db_session)
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=10)

        with pytest.raises(ConflictError):
            lps.apply_delta(
                db_session, lot, ROW_1, event_type=lps.EVENT_CONSUMED, full_units_delta=-11
            )
        assert lps._lock_placement(db_session, lot.id, ROW_1).full_units == 10

    def test_capacity_is_a_prompt_not_a_gate(self, db_session, lot_seed):
        """22 drums per row is a hint. Over-filling is accepted, because a hard
        4xx here parks an offline scan as permanently failed."""
        lot = _lot(db_session)
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=30)
        assert lps._lock_placement(db_session, lot.id, ROW_1).full_units == 30

    def test_open_units_are_a_count_not_a_flag(self, db_session, lot_seed):
        """Two rooms can each hold a partial of the same lot."""
        lot = _lot(db_session, weight=500.0)
        lps.apply_delta(
            db_session, lot, ROW_1, event_type=lps.EVENT_OPENED,
            open_units_delta=1, open_qty_delta=180.0,
        )
        lps.apply_delta(
            db_session, lot, ROW_2, event_type=lps.EVENT_OPENED,
            open_units_delta=1, open_qty_delta=90.0,
        )
        totals = lps.units_on_hand(db_session, lot.id)
        assert totals["open_units"] == 2
        assert totals["open_remaining_qty"] == 270.0

    def test_derived_weight_adds_the_open_remainder(self, db_session, lot_seed):
        lot = _lot(db_session, weight=500.0)
        lps.apply_delta(
            db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED,
            full_units_delta=3, open_units_delta=1, open_qty_delta=120.0,
        )
        placement = lps._lock_placement(db_session, lot.id, ROW_1)
        assert lps.derived_weight(lot, placement) == 1620.0

    def test_a_depleted_placement_survives_at_zero(self, db_session, lot_seed):
        """The deliberate inverse of deduct_rm_rows, which prunes at zero and
        destroys "this lot was in Cooler 2 last month"."""
        lot = _lot(db_session)
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=5)
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_CONSUMED, full_units_delta=-5)

        assert lps.placements_for_lot(db_session, lot.id) == []
        kept = lps.placements_for_lot(db_session, lot.id, include_empty=True)
        assert len(kept) == 1 and kept[0].full_units == 0
        # And it is still a counted lot, so nothing falls back to legacy mode.
        assert lps.is_counted_lot(db_session, lot.id) is True


class TestMoves:
    def test_a_move_writes_two_events_sharing_a_ref(self, db_session, lot_seed):
        lot = _lot(db_session)
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=20)
        result = lps.move_units(db_session, lot, from_row_id=ROW_1, to_row_id=ROW_2, full_units=8)

        assert lps._lock_placement(db_session, lot.id, ROW_1).full_units == 12
        assert lps._lock_placement(db_session, lot.id, ROW_2).full_units == 8

        events = db_session.query(LotPlacementEvent).filter(
            LotPlacementEvent.ref_id == result["ref_id"]
        ).all()
        assert len(events) == 2
        assert sorted(e.full_units_delta for e in events) == [-8, 8]
        assert {e.counterpart_row_id for e in events} == {ROW_1, ROW_2}

    def test_a_move_conserves_the_total(self, db_session, lot_seed):
        lot = _lot(db_session)
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=20)
        lps.move_units(db_session, lot, from_row_id=ROW_1, to_row_id=ROW_2, full_units=8)
        assert lps.units_on_hand(db_session, lot.id)["full_units"] == 20

    def test_moving_more_than_the_row_holds_is_refused(self, db_session, lot_seed):
        lot = _lot(db_session)
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=5)
        with pytest.raises(ConflictError):
            lps.move_units(db_session, lot, from_row_id=ROW_1, to_row_id=ROW_2, full_units=6)


class TestIdempotency:
    def test_a_replayed_offline_scan_counts_once(self, db_session, lot_seed):
        """Identical stickers make client-side dedupe impossible, so the server
        does it."""
        lot = _lot(db_session)
        for _ in range(3):
            lps.apply_delta(
                db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED,
                full_units_delta=1, idempotency_key="scan-abc-123",
            )
        assert lps._lock_placement(db_session, lot.id, ROW_1).full_units == 1
        assert db_session.query(LotPlacementEvent).filter(
            LotPlacementEvent.material_lot_id == lot.id
        ).count() == 1

    def test_distinct_keys_each_count(self, db_session, lot_seed):
        lot = _lot(db_session)
        for i in range(3):
            lps.apply_delta(
                db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED,
                full_units_delta=1, idempotency_key=f"scan-{i}",
            )
        assert lps._lock_placement(db_session, lot.id, ROW_1).full_units == 3


class TestPhysicalCount:
    def test_set_count_records_the_variance_as_a_delta(self, db_session, lot_seed):
        """Month end. The system said 40, the counter says 38 — and the ledger
        keeps the -2 rather than the count overwriting history silently."""
        lot = _lot(db_session)
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=40)
        lps.set_count(db_session, lot, ROW_1, full_units=38, actor_id=None)

        assert lps._lock_placement(db_session, lot.id, ROW_1).full_units == 38
        counted = db_session.query(LotPlacementEvent).filter(
            LotPlacementEvent.event_type == lps.EVENT_COUNTED
        ).one()
        assert counted.full_units_delta == -2

    def test_a_count_can_increase_stock(self, db_session, lot_seed):
        """The FOUND case. No code path anywhere could do this before."""
        lot = _lot(db_session)
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=40)
        lps.set_count(db_session, lot, ROW_1, full_units=42)
        assert lps._lock_placement(db_session, lot.id, ROW_1).full_units == 42

    def test_a_count_stamps_who_counted_and_when(self, db_session, lot_seed):
        lot = _lot(db_session)
        lps.set_count(db_session, lot, ROW_1, full_units=12, actor_id=None)
        placement = lps._lock_placement(db_session, lot.id, ROW_1)
        assert placement.last_counted_at is not None

    def test_negative_counts_and_orphan_remainders_are_rejected(self, db_session, lot_seed):
        from app.exceptions import ValidationError

        lot = _lot(db_session)
        with pytest.raises(ValidationError):
            lps.set_count(db_session, lot, ROW_1, full_units=-1)
        with pytest.raises(ValidationError):
            lps.set_count(db_session, lot, ROW_1, full_units=1, open_units=0,
                          open_remaining_qty=50.0)


class TestReconciliation:
    def test_ledger_and_placements_agree_after_a_full_day(self, db_session, lot_seed):
        lot = _lot(db_session)
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=40)
        lps.move_units(db_session, lot, from_row_id=ROW_1, to_row_id=ROW_2, full_units=15)
        lps.apply_delta(db_session, lot, ROW_2, event_type=lps.EVENT_CONSUMED, full_units_delta=-3)
        lps.set_count(db_session, lot, ROW_1, full_units=24)

        report = lps.reconcile_lot(db_session, lot.id)
        assert report["drifted"] == 0, report["rows"]

    def test_drift_is_reported_never_auto_healed(self, db_session, lot_seed):
        """Silently correcting drift is how the earlier denormalisation bugs
        stayed invisible for months."""
        lot = _lot(db_session)
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=10)

        placement = lps._lock_placement(db_session, lot.id, ROW_1)
        placement.full_units = 99          # simulate a rogue writer
        db_session.flush()

        report = lps.reconcile_lot(db_session, lot.id)
        assert report["drifted"] == 1
        assert report["rows"][0]["placement_full_units"] == 99
        assert report["rows"][0]["ledger_full_units"] == 10
        # Still 99 — the report does not fix it.
        assert lps._lock_placement(db_session, lot.id, ROW_1).full_units == 99


# ---------------------------------------------------------------------------
# Projection into the legacy JSON
# ---------------------------------------------------------------------------

def _receipt(db, lot, *, receipt_id="rcpt-1", quantity=20000.0):
    receipt = Receipt(
        id=receipt_id,
        product_id=lot.product_id,
        category_id="cat-ingredient",
        material_lot_id=lot.id,
        lot_number=lot.vendor_lot_number,
        quantity=quantity,
        unit="lbs",
        container_count=40,
        container_unit="drum",
        weight_per_container=500.0,
        weight_unit="lbs",
        vendor_id=lot.vendor_id,
        warehouse_id=WH,
        status="approved",
        receipt_date=datetime(2026, 8, 1, tzinfo=timezone.utc),
    )
    db.add(receipt)
    db.flush()
    return receipt


class TestProjection:
    def test_cases_is_a_real_weight_not_a_x40_guess(self, db_session, lot_seed):
        """The live defect. `_entry_cases` falls back to pallets * 40 when the
        entry has no `cases`, so 40 drums used to read back as 1,600 "cases"."""
        lot = _lot(db_session, weight=500.0)
        receipt = _receipt(db_session, lot)
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=40)

        entries = receipt.raw_material_row_allocations
        assert len(entries) == 1
        assert entries[0]["cases"] == 20000.0
        assert entries[0]["pallets"] == 40      # units, not a pallet estimate
        assert entries[0]["units"] == 40
        assert entries[0]["unitLabel"] == "drum"

        # And the shared reader now agrees with the placement instead of guessing.
        assert row_allocation._entry_cases(entries[0], 40.0) == 20000.0

    def test_the_projected_entry_matches_add_rm_rows_key_for_key(self, db_session, lot_seed):
        lot = _lot(db_session)
        receipt = _receipt(db_session, lot)
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=10)

        entry = receipt.raw_material_row_allocations[0]
        for key in ("rowId", "rowName", "areaId", "areaName", "cases", "pallets"):
            assert key in entry
        assert entry["rowId"] == ROW_1
        assert entry["rowName"] == "A-01"
        assert entry["areaId"] == "area-1"
        assert entry["areaName"] == "Barn"

    def test_the_projection_is_idempotent(self, db_session, lot_seed):
        """Recompute-from-source, never a delta: running it twice equals once,
        so a missed run self-heals instead of compounding."""
        lot = _lot(db_session)
        receipt = _receipt(db_session, lot)
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=10)
        once = list(receipt.raw_material_row_allocations)

        lps.project_lot(db_session, lot)
        lps.project_lot(db_session, lot)
        assert receipt.raw_material_row_allocations == once

    def test_an_emptied_row_leaves_the_json(self, db_session, lot_seed):
        lot = _lot(db_session)
        receipt = _receipt(db_session, lot)
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=10)
        lps.move_units(db_session, lot, from_row_id=ROW_1, to_row_id=ROW_2, full_units=10)

        rows = {e["rowId"] for e in receipt.raw_material_row_allocations}
        assert rows == {ROW_2}

    def test_row_counters_are_recomputed_from_every_lot_in_the_row(self, db_session, lot_seed):
        """Recomputing only this lot's share would leave the other lots behind as
        a permanent overcount."""
        mango = _lot(db_session, product=PRODUCT, lot_number="MG-1", weight=500.0)
        guava = _lot(db_session, product=OTHER_PRODUCT, lot_number="GV-1", weight=400.0)
        lps.apply_delta(db_session, mango, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=10)
        lps.apply_delta(db_session, guava, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=5)

        row = db_session.query(StorageRow).filter(StorageRow.id == ROW_1).first()
        assert row.occupied_pallets == 15                 # 10 + 5 drums
        assert row.occupied_cases == 7000.0               # 10*500 + 5*400

        # Removing one lot must not zero the row that still holds the other.
        # No refresh() here: conftest runs with autoflush=False, so a refresh
        # would reload from the database and discard the pending projection.
        lps.apply_delta(db_session, mango, ROW_1, event_type=lps.EVENT_CONSUMED, full_units_delta=-10)
        assert row.occupied_pallets == 5
        assert row.occupied_cases == 2000.0

    def test_the_projection_does_not_pin_a_product_to_the_row(self, db_session, lot_seed):
        """row.product_id encodes one-product-per-row, which contradicts a mixed
        row outright."""
        mango = _lot(db_session, product=PRODUCT, lot_number="MG-1")
        lps.apply_delta(db_session, mango, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=10)
        row = db_session.query(StorageRow).filter(StorageRow.id == ROW_1).first()
        assert row.product_id is None

    def test_the_newest_receipt_carries_the_picture_older_ones_are_emptied(self, db_session, lot_seed):
        """One lot, several trucks. Counting the same drums once per receipt is
        exactly the double-count the lot grain exists to prevent."""
        lot = _lot(db_session)
        older = _receipt(db_session, lot, receipt_id="rcpt-old")
        older.receipt_date = datetime(2026, 7, 1, tzinfo=timezone.utc)
        older.raw_material_row_allocations = [{"rowId": ROW_1, "cases": 9999, "pallets": 1}]
        newer = _receipt(db_session, lot, receipt_id="rcpt-new")
        db_session.flush()

        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=10)

        assert older.raw_material_row_allocations == []
        assert len(newer.raw_material_row_allocations) == 1

    def test_a_lot_with_no_receipt_still_updates_the_row(self, db_session, lot_seed):
        """The Phase 3 opening balance: stock entered by hand, no receipt yet."""
        lot = _lot(db_session, weight=500.0)
        lps.set_count(db_session, lot, ROW_1, full_units=12,
                      event_type=lps.EVENT_OPENING_BALANCE)
        row = db_session.query(StorageRow).filter(StorageRow.id == ROW_1).first()
        assert row.occupied_pallets == 12
        assert row.occupied_cases == 6000.0


# ---------------------------------------------------------------------------
# The single-writer guard
# ---------------------------------------------------------------------------

class TestSingleWriterGuard:
    def test_editing_a_counted_lot_by_hand_is_refused(self, db_session, lot_seed):
        """Not a no-op: a silent no-op leaves the caller believing its deduction
        landed."""
        lot = _lot(db_session)
        receipt = _receipt(db_session, lot)
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=40)

        with pytest.raises(ConflictError):
            row_allocation.deduct_rm_rows(db_session, receipt, {ROW_1: 500.0})
        with pytest.raises(ConflictError):
            row_allocation.add_rm_rows(db_session, receipt, {ROW_2: 500.0})
        with pytest.raises(ConflictError):
            row_allocation.deduct_rm_total(db_session, receipt, 500.0)

    def test_raw_material_and_packaging_are_untouched(self, db_session, lot_seed):
        """The guard must not follow RM or packaging anywhere."""
        receipt = Receipt(
            id="rcpt-raw", product_id=PRODUCT, category_id="cat-raw",
            quantity=1000.0, unit="lbs", warehouse_id=WH, status="approved",
            cases_per_pallet=40,
            raw_material_row_allocations=[
                {"rowId": ROW_1, "rowName": "A-01", "cases": 1000.0, "pallets": 4}
            ],
        )
        db_session.add(receipt)
        db_session.flush()

        row_allocation.deduct_rm_rows(db_session, receipt, {ROW_1: 250.0},
                                      pallets_by_row={ROW_1: 1})
        assert receipt.raw_material_row_allocations[0]["cases"] == 750.0

    def test_an_ingredient_lot_with_no_placements_stays_in_legacy_mode(self, db_session, lot_seed):
        """Mode is per lot. Before its first count, everything works unchanged."""
        lot = _lot(db_session)
        receipt = _receipt(db_session, lot)
        receipt.cases_per_pallet = 40
        receipt.raw_material_row_allocations = [
            {"rowId": ROW_1, "rowName": "A-01", "cases": 20000.0, "pallets": 40}
        ]
        db_session.flush()
        assert lps.is_counted_lot(db_session, lot.id) is False

        row_allocation.deduct_rm_rows(db_session, receipt, {ROW_1: 500.0})
        assert receipt.raw_material_row_allocations[0]["cases"] == 19500.0


# ---------------------------------------------------------------------------
# Availability — the gate the Production app consults before scheduling a batch
# ---------------------------------------------------------------------------

class TestAvailability:
    def test_a_counted_lots_receipt_is_not_counted_twice(self, db_session, lot_seed):
        """THE double-count rule. The projection rewrites the allocation JSON and
        the row counters, deliberately NOT Receipt.quantity — so a counted lot's
        receipt is already represented, in units, by its placements."""
        from app.services.availability import on_hand_for_product

        lot = _lot(db_session, weight=500.0)
        _receipt(db_session, lot, quantity=20000.0)
        db_session.commit()

        # Before any count: pure legacy, unchanged.
        before = on_hand_for_product(db_session, PRODUCT)
        assert before["legacy_qty"] == 20000.0
        assert before["total"] == 20000.0
        assert before["unit_count"] == 0

        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=40)
        db_session.commit()

        after = on_hand_for_product(db_session, PRODUCT)
        assert after["legacy_qty"] == 0.0          # the receipt stepped aside
        assert after["container_qty"] == 20000.0   # placements took over
        assert after["total"] == 20000.0           # NOT 40,000
        assert after["unit_count"] == 40

    def test_a_legacy_receipt_with_no_lot_is_untouched(self, db_session, lot_seed):
        """Behaviour preservation: a NULL material_lot_id never matches the NOT
        EXISTS, so every pre-existing receipt reads exactly as it did."""
        from app.services.availability import on_hand_for_product

        db_session.add(Receipt(
            id="rcpt-legacy", product_id=PRODUCT, category_id="cat-ingredient",
            quantity=7000.0, unit="lbs", warehouse_id=WH, status="approved",
        ))
        db_session.commit()
        assert on_hand_for_product(db_session, PRODUCT)["legacy_qty"] == 7000.0

    def test_a_held_lot_is_present_but_not_available(self, db_session, lot_seed):
        """Ingredients hold at LOT level — every unit of it, wherever it sits."""
        from app.services.availability import on_hand_for_product

        lot = _lot(db_session, weight=500.0)
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=10)
        lot.is_held = True
        db_session.commit()

        result = on_hand_for_product(db_session, PRODUCT)
        assert result["available_to_stage"] == 0.0
        assert result["physically_present"] == 5000.0
        assert result["unit_count"] == 0
        assert result["sources"]["placements"]["held"] == 5000.0

    def test_placements_are_scoped_by_warehouse_not_by_lot(self, db_session, lot_seed):
        """The same vendor lot legitimately sits in two plants; only the
        placement knows which drums are where."""
        from app.services.availability import on_hand_for_product

        other_wh = "wh-lot-2"
        db_session.add(Warehouse(id=other_wh, name="Plant B", code="PB", type="owned"))
        db_session.flush()

        lot = _lot(db_session, weight=500.0)
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=10)
        placement = lps._lock_placement(db_session, lot.id, ROW_1)
        placement.warehouse_id = other_wh
        db_session.commit()

        assert on_hand_for_product(db_session, PRODUCT, WH)["unit_count"] == 0
        assert on_hand_for_product(db_session, PRODUCT, other_wh)["unit_count"] == 10

    def test_a_depleted_lot_contributes_nothing(self, db_session, lot_seed):
        from app.services.availability import on_hand_for_product

        lot = _lot(db_session, weight=500.0)
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=10)
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_CONSUMED, full_units_delta=-10)
        db_session.commit()

        result = on_hand_for_product(db_session, PRODUCT)
        assert result["container_qty"] == 0.0
        assert result["unit_count"] == 0


# ---------------------------------------------------------------------------
# Room display — "22 drum capacity · 15 drums in use", not "0.00/22 pallets"
# ---------------------------------------------------------------------------

class TestRoomUnitDisplay:
    def _rows(self, client, headers):
        response = client.get("/api/master-data/sub-locations", headers=headers)
        assert response.status_code == 200
        return {
            sub["id"]: sub for sub in response.json()
        }

    def test_a_drum_room_reports_live_unit_counts(
        self, client, db_session, lot_seed, admin_auth_headers
    ):
        lot = _lot(db_session, weight=500.0)
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=15)
        db_session.commit()

        sub = self._rows(client, admin_auth_headers)["sub-drums"]
        assert sub["storage_unit"] == "drum"
        assert sub["unit_capacity"] == 22

        rows = {r["id"]: r for r in sub["rows"]}
        assert rows[ROW_1]["live_units"] == 15
        assert rows[ROW_2]["live_units"] == 0
        assert rows[ROW_1]["live_lots"][0]["lot_code"] == lot.lot_code
        assert rows[ROW_1]["live_lots"][0]["units"] == 15
        assert rows[ROW_1]["live_lots"][0]["weight"] == 7500.0

    def test_a_pallet_room_gets_none_not_zero(
        self, client, db_session, lot_seed, admin_auth_headers
    ):
        """So a client can tell "a drum room holding no drums" apart from "this
        is a pallet room, the question does not apply"."""
        db_session.add(SubLocation(id="sub-pallets", name="Dry Store", location_id="loc-1"))
        db_session.add(StorageRow(
            id="row-pallet-1", name="P-01", sub_location_id="sub-pallets",
            pallet_capacity=15,
        ))
        db_session.commit()

        sub = self._rows(client, admin_auth_headers)["sub-pallets"]
        assert sub["storage_unit"] is None
        assert sub["rows"][0]["live_units"] is None

    def test_a_mixed_row_lists_every_lot(
        self, client, db_session, lot_seed, admin_auth_headers
    ):
        mango = _lot(db_session, product=PRODUCT, lot_number="MG-1", weight=500.0)
        guava = _lot(db_session, product=OTHER_PRODUCT, lot_number="GV-1", weight=400.0)
        lps.apply_delta(db_session, mango, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=10)
        lps.apply_delta(db_session, guava, ROW_1, event_type=lps.EVENT_RECEIVED, full_units_delta=5)
        db_session.commit()

        row = {
            r["id"]: r
            for r in self._rows(client, admin_auth_headers)["sub-drums"]["rows"]
        }[ROW_1]
        assert row["live_units"] == 15
        assert {l["product_id"] for l in row["live_lots"]} == {PRODUCT, OTHER_PRODUCT}

    def test_the_row_barcode_is_finally_exposed(
        self, client, db_session, lot_seed, admin_auth_headers
    ):
        """It has existed on the model since alembic u6v7w8x9y0z1 but was never
        in the schema, so master data could neither read nor set the field the
        ingredient scanner resolves rows on."""
        row = db_session.query(StorageRow).filter(StorageRow.id == ROW_1).first()
        row.barcode = "LOC-A-01"
        db_session.commit()

        rows = {
            r["id"]: r
            for r in self._rows(client, admin_auth_headers)["sub-drums"]["rows"]
        }
        assert rows[ROW_1]["barcode"] == "LOC-A-01"

    def test_a_room_can_be_typed_through_the_api(
        self, client, db_session, lot_seed, admin_auth_headers
    ):
        response = client.put(
            "/api/master-data/sub-locations/sub-drums",
            json={"storage_unit": "bag", "unit_capacity": 70},
            headers=admin_auth_headers,
        )
        assert response.status_code == 200
        assert response.json()["storage_unit"] == "bag"
        assert response.json()["unit_capacity"] == 70
