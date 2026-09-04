"""Finishing the raw-material lot conversion.

Three ways material enters — barrels already on racks, a corporate order, a
walk-in — and all three must end in the same record: a placement saying N units
of lot X are on rack Y. And once it is there, the operations that MOVE it —
staging, adjustments, transfers — have to speak the same language.

Before this, only the corporate order wrote placements, and the other eight
write paths still edited the legacy allocation JSON that placements overwrite.
That JSON is now a projection, so those writes were refused outright rather than
being allowed to vanish. Tolerable while old-style receipts still existed to take
the old path; not tolerable once every raw receipt carries a lot, which is what
clearing the data and re-entering it produces.

These tests pin the two halves: that logging a receipt places it, and that
everything downstream can then move it.
"""

import uuid
from datetime import datetime, timezone

import pytest

from app.enums import ReceiptStatus
from app.models import (
    Category,
    InventoryAdjustment,
    InventoryHoldAction,
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
    adjustment_service,
    availability,
    hold_service,
    lot_placement_service as lps,
    lot_receiving_service as lrs,
    receipt_service,
    staging_service,
    transfer_service,
)

WH = "wh-conv-1"
PRODUCT = "prod-conv-mango"
VENDOR = "vendor-conv"
ROW_1 = "row-conv-1"
ROW_2 = "row-conv-2"
BBD = datetime(2027, 6, 1, tzinfo=timezone.utc)


@pytest.fixture
def seed(db_session):
    db_session.add(Warehouse(id=WH, name="Plant A", code="PA", type="owned", is_active=True))
    db_session.add(Category(id="cat-conv-raw", name="Raw", type="raw"))
    db_session.add(Category(id="cat-conv-fg", name="Finished", type="finished"))
    db_session.add(Product(id=PRODUCT, name="Mango Puree", category_id="cat-conv-raw"))
    db_session.add(Vendor(id=VENDOR, name="Vendor Conv"))
    db_session.add(Location(id="loc-conv", name="Plant A", warehouse_id=WH))
    db_session.add(SubLocation(
        id="sub-conv", name="Drum Barn", location_id="loc-conv",
        storage_unit="drum", unit_capacity=22,
    ))
    db_session.add(StorageArea(id="area-conv", name="Barn", location_id="loc-conv"))
    db_session.add_all([
        StorageRow(id=ROW_1, name="A-01", sub_location_id="sub-conv",
                   storage_area_id="area-conv", pallet_capacity=0),
        StorageRow(id=ROW_2, name="A-02", sub_location_id="sub-conv",
                   storage_area_id="area-conv", pallet_capacity=0),
    ])
    db_session.add_all([
        User(id="u-submit", username="sam", name="Sam", email="sam@x.test",
             hashed_password="x", role="warehouse", is_active=True),
        # A different user from the submitter: a warehouse worker may not
        # approve their own receipt, and the check is on submitted_by.
        User(id="u-approve", username="ada", name="Ada", email="ada@x.test",
             hashed_password="x", role="admin", is_active=True),
    ])
    db_session.commit()


class _Approver:
    id = "u-approve"
    role = "admin"
    name = "Ada"
    warehouse_id = WH


def _receipt(db, *, units=40, allocs=None, lot_number="MG-2411", category="cat-conv-raw"):
    """A Log Receipt entry: what somebody with a clipboard types."""
    receipt = Receipt(
        id=f"rcpt-conv-{uuid.uuid4().hex[:10]}",
        product_id=PRODUCT,
        category_id=category,
        vendor_id=VENDOR,
        lot_number=lot_number,
        expiration_date=BBD,
        quantity=units * 500.0,
        unit="lbs",
        container_count=units,
        container_unit="drums",
        weight_per_container=500.0,
        weight_unit="lbs",
        warehouse_id=WH,
        status=ReceiptStatus.RECORDED,
        submitted_by="u-submit",
        raw_material_row_allocations=allocs,
    )
    db.add(receipt)
    db.flush()
    return receipt


def _approve(db, receipt):
    receipt_service.approve_receipt(db, receipt, _Approver())
    db.flush()
    return receipt


def _on_hand(db, lot_id):
    return lps.units_on_hand(db, lot_id)["full_units"]


def _by_row(db, lot_id):
    return {p.storage_row_id: p.full_units for p in lps.placements_for_lot(db, lot_id)}


# ---------------------------------------------------------------------------
# Change 1 — logging a receipt records the rack
# ---------------------------------------------------------------------------

class TestLoggedReceiptIsPlaced:
    def test_approval_places_the_material(self, db_session, seed):
        """The gap this closes: the lot was known, the rack was not."""
        receipt = _receipt(db_session, units=40, allocs=[{"rowId": ROW_1, "pallets": 4}])
        assert receipt.material_lot_id is None

        _approve(db_session, receipt)

        assert receipt.material_lot_id is not None
        assert _by_row(db_session, receipt.material_lot_id) == {ROW_1: 40}

    def test_nothing_is_placed_before_approval(self, db_session, seed):
        """Entering a receipt is a claim; approving it is the confirmation."""
        receipt = _receipt(db_session, units=40, allocs=[{"rowId": ROW_1, "pallets": 4}])
        assert lps.is_counted_lot(db_session, receipt.material_lot_id) is False

    def test_a_second_delivery_of_the_same_lot_adds_rather_than_replaces(
        self, db_session, seed
    ):
        """THE bug an absolute set_count would have introduced.

        The form states a total, but the total is the DELIVERY's, not the rack's.
        Two trucks of the same vendor lot onto the same row is 80 drums; setting
        the count to 40 twice leaves 40 and quietly loses a truckload.
        """
        first = _approve(db_session, _receipt(
            db_session, units=40, allocs=[{"rowId": ROW_1, "pallets": 4}]))
        second = _approve(db_session, _receipt(
            db_session, units=25, allocs=[{"rowId": ROW_1, "pallets": 3}]))

        assert first.material_lot_id == second.material_lot_id
        assert _on_hand(db_session, first.material_lot_id) == 65

    def test_multi_row_split_is_taken_exactly_as_typed(self, db_session, seed):
        receipt = _approve(db_session, _receipt(db_session, units=50, allocs=[
            {"rowId": ROW_1, "pallets": 3, "units": 30},
            {"rowId": ROW_2, "pallets": 2, "units": 20},
        ]))
        assert _by_row(db_session, receipt.material_lot_id) == {ROW_1: 30, ROW_2: 20}

    def test_multi_row_without_counts_places_nothing(self, db_session, seed):
        """Refusing to guess.

        Splitting 50 drums across two racks by their pallet share invents a
        per-rack number nobody counted, and afterwards it is indistinguishable
        from one somebody did. Unplaced is visible and fixable; fabricated is
        neither.
        """
        receipt = _approve(db_session, _receipt(db_session, units=50, allocs=[
            {"rowId": ROW_1, "pallets": 3},
            {"rowId": ROW_2, "pallets": 2},
        ]))
        assert receipt.material_lot_id is None

    def test_single_row_needs_no_typed_count(self, db_session, seed):
        """One row holds everything, so container_count is exact, not a guess."""
        receipt = _approve(db_session, _receipt(
            db_session, units=40, allocs=[{"rowId": ROW_1, "pallets": 4}]))
        assert _by_row(db_session, receipt.material_lot_id) == {ROW_1: 40}

    def test_finished_goods_are_left_alone(self, db_session, seed):
        """FG locates itself through pallet licences and must not be given a lot."""
        receipt = _receipt(db_session, units=10, category="cat-conv-fg",
                           allocs=[{"rowId": ROW_1, "pallets": 1}])
        _approve(db_session, receipt)
        assert receipt.material_lot_id is None

    def test_the_legacy_json_is_rewritten_to_agree(self, db_session, seed):
        """Every existing reader keeps working, off a projection of the truth."""
        receipt = _approve(db_session, _receipt(
            db_session, units=40, allocs=[{"rowId": ROW_1, "pallets": 4}]))
        db_session.refresh(receipt)
        entries = receipt.raw_material_row_allocations
        assert [e["rowId"] for e in entries] == [ROW_1]
        assert entries[0]["units"] == 40
        assert entries[0]["cases"] == pytest.approx(20000.0)


# ---------------------------------------------------------------------------
# Change 4 — the operations that move it afterwards
# ---------------------------------------------------------------------------

@pytest.fixture
def placed(db_session, seed):
    """40 drums of one lot on ROW_1, the state everything below starts from."""
    receipt = _approve(db_session, _receipt(
        db_session, units=40, allocs=[{"rowId": ROW_1, "pallets": 4}]))
    return receipt


class TestQuantityBecomesACount:
    def test_pulling_rounds_up_because_drums_are_indivisible(self, db_session, placed):
        lot = db_session.get(MaterialLot, placed.material_lot_id)
        assert lps.units_for_quantity(lot, 1000.0) == 2
        # 600 lbs of a 500 lb drum is two drums off the rack, not one and a bit.
        assert lps.units_for_quantity(lot, 600.0) == 2
        assert lps.units_for_quantity(lot, 500.0) == 1

    def test_a_lot_with_no_weight_per_unit_refuses_rather_than_guessing(
        self, db_session, seed
    ):
        lot = lps.find_or_create_lot(
            db_session, product_id=PRODUCT, vendor_id=VENDOR,
            vendor_lot_number="NO-WEIGHT", bbd=BBD, unit_label="drum",
            weight_per_unit=None, warehouse_id=WH,
        )
        with pytest.raises(Exception) as excinfo:
            lps.units_for_quantity(lot, 500.0)
        assert "weight per" in str(excinfo.value)


class TestStaging:
    def test_staging_a_counted_lot_no_longer_raises(self, db_session, placed):
        """This is the regression. It used to raise ConflictError, every time."""
        freed = staging_service._stage_free_rack(db_session, placed, 2500.0, None)
        assert freed == 5
        assert _by_row(db_session, placed.material_lot_id) == {ROW_1: 35}

    def test_racks_drain_fullest_first(self, db_session, seed):
        """A pull instruction a person can follow, rather than a bit from each."""
        receipt = _approve(db_session, _receipt(db_session, units=50, allocs=[
            {"rowId": ROW_1, "pallets": 3, "units": 30},
            {"rowId": ROW_2, "pallets": 2, "units": 20},
        ]))
        staging_service._stage_free_rack(db_session, receipt, 5000.0, None)
        # 10 drums, all from the fuller rack — ROW_2 is untouched.
        assert _by_row(db_session, receipt.material_lot_id) == {ROW_1: 20, ROW_2: 20}

    def test_pulling_more_than_exists_refuses(self, db_session, placed):
        with pytest.raises(Exception) as excinfo:
            staging_service._stage_free_rack(db_session, placed, 100000.0, None)
        assert "asked for" in str(excinfo.value)

    def test_returning_rounds_down_so_stock_is_not_invented(self, db_session, placed):
        """The opposite rounding to the pull, and deliberately so.

        600 lbs coming back against 500 lb drums is ONE full drum on the shelf
        plus a partial still in production. Counting the partial as a whole drum
        would put a drum in the system that is not on the rack to be found.
        """
        lot = db_session.get(MaterialLot, placed.material_lot_id)
        lps.put_units(db_session, lot, units=int(600.0 / 500.0), to_row_id=ROW_2,
                      event_type=lps.EVENT_RETURNED)
        assert _by_row(db_session, placed.material_lot_id) == {ROW_1: 40, ROW_2: 1}

    def test_returning_needs_a_named_rack(self, db_session, placed):
        lot = db_session.get(MaterialLot, placed.material_lot_id)
        with pytest.raises(Exception) as excinfo:
            lps.put_units(db_session, lot, units=2, to_row_id=None,
                          event_type=lps.EVENT_RETURNED)
        assert "needs a rack" in str(excinfo.value)


class TestAdjustments:
    def test_a_plain_quantity_writeoff_comes_off_the_racks(self, db_session, placed):
        adjustment = InventoryAdjustment(
            id="adj-conv-1", receipt_id=placed.id, product_id=PRODUCT,
            adjustment_type="damage", quantity=1000.0, reason="Two drums leaking",
            submitted_by="u-approve", status="pending",
        )
        db_session.add(adjustment)
        db_session.flush()

        adjustment_service._apply_row_breakdown(db_session, placed, adjustment)
        assert _by_row(db_session, placed.material_lot_id) == {ROW_1: 38}

    def test_a_per_rack_writeoff_honours_the_racks_named(self, db_session, seed):
        receipt = _approve(db_session, _receipt(db_session, units=50, allocs=[
            {"rowId": ROW_1, "pallets": 3, "units": 30},
            {"rowId": ROW_2, "pallets": 2, "units": 20},
        ]))
        adjustment = InventoryAdjustment(
            id="adj-conv-2", receipt_id=receipt.id, product_id=PRODUCT,
            adjustment_type="damage", quantity=1000.0, reason="Forklift damage",
            submitted_by="u-approve", status="pending",
            # The operator pointed at the emptier rack. Take it from there, not
            # from wherever the system would have preferred.
            source_breakdown=[{"id": f"row-{ROW_2}", "quantity": 1000.0}],
        )
        db_session.add(adjustment)
        db_session.flush()

        adjustment_service._apply_row_breakdown(db_session, receipt, adjustment)
        assert _by_row(db_session, receipt.material_lot_id) == {ROW_1: 30, ROW_2: 18}


class TestTransfers:
    def test_rack_to_rack_moves_whole_drums(self, db_session, placed):
        transfer = InventoryTransfer(
            id="tr-conv-1", receipt_id=placed.id, quantity=1500.0, unit="lbs",
            transfer_type="warehouse-transfer", requested_by="u-approve",
            status="completed",
            source_breakdown=[{"id": f"row-{ROW_1}", "quantity": 1500.0, "pallets": 1}],
            destination_breakdown=[{"id": f"row-{ROW_2}", "quantity": 1500.0, "pallets": 1}],
        )
        db_session.add(transfer)
        db_session.flush()

        transfer_service._apply_raw_material_internal_transfer(db_session, transfer, placed)
        assert _by_row(db_session, placed.material_lot_id) == {ROW_1: 37, ROW_2: 3}

    def test_a_move_conserves_the_total(self, db_session, placed):
        """Nothing is created or destroyed by walking it across the barn."""
        before = _on_hand(db_session, placed.material_lot_id)
        transfer = InventoryTransfer(
            id="tr-conv-2", receipt_id=placed.id, quantity=2500.0, unit="lbs",
            transfer_type="warehouse-transfer", requested_by="u-approve",
            status="completed",
            source_breakdown=[{"id": f"row-{ROW_1}", "quantity": 2500.0}],
            destination_breakdown=[{"id": f"row-{ROW_2}", "quantity": 2500.0}],
        )
        db_session.add(transfer)
        db_session.flush()

        transfer_service._apply_raw_material_internal_transfer(db_session, transfer, placed)
        assert _on_hand(db_session, placed.material_lot_id) == before

    def test_ship_out_takes_from_the_racks_named(self, db_session, placed):
        transfer = InventoryTransfer(
            id="tr-conv-3", receipt_id=placed.id, quantity=2000.0, unit="lbs",
            transfer_type="ship-out", requested_by="u-approve", status="completed",
            source_breakdown=[{"id": f"row-{ROW_1}", "quantity": 2000.0}],
        )
        db_session.add(transfer)
        db_session.flush()

        transfer_service._apply_raw_material_ship_out(db_session, transfer, placed)
        assert _by_row(db_session, placed.material_lot_id) == {ROW_1: 36}


class TestHoldsActuallyHold:
    """A QA hold used to do nothing at all.

    `hold_service` wrote `receipt.hold`, and a counted lot's receipt is
    deliberately excluded from the availability sum so its drums are not counted
    twice. So QA could quarantine a lot for a positive swab and production could
    still stage every drum of it — no error, no warning, no trace.
    """

    def _hold(self, db, receipt, action="hold", items=None, reason="Positive swab"):
        hold = InventoryHoldAction(
            id=f"hold-{uuid.uuid4().hex[:8]}", receipt_id=receipt.id, action=action,
            reason=reason, status="pending", submitted_by="u-submit", hold_items=items,
        )
        db.add(hold)
        db.flush()
        hold_service.approve_hold_action(db, hold, _Approver())
        db.flush()
        return hold

    def _available(self, db):
        return availability.on_hand_for_product(db, PRODUCT)["available_to_stage"]

    def test_a_whole_lot_hold_removes_it_from_availability(self, db_session, placed):
        assert self._available(db_session) == 20000.0
        self._hold(db_session, placed)
        assert self._available(db_session) == 0.0

    def test_a_held_lot_is_still_physically_there(self, db_session, placed):
        """Availability and presence are different questions.

        Quarantined drums have not left the building — they are on the rack,
        they are counted, and a stock report that hid them would send somebody
        looking for material that is sitting in front of them.
        """
        self._hold(db_session, placed)
        snapshot = availability.on_hand_for_product(db_session, PRODUCT)
        assert snapshot["available_to_stage"] == 0.0
        assert snapshot["physically_present"] == 20000.0

    def test_staging_a_held_lot_is_refused_with_the_reason(self, db_session, placed):
        self._hold(db_session, placed, reason="Positive swab")
        with pytest.raises(Exception) as excinfo:
            staging_service._stage_free_rack(db_session, placed, 500.0, None)
        assert "on hold" in str(excinfo.value)
        assert "Positive swab" in str(excinfo.value)

    def test_a_held_lot_cannot_be_moved_to_another_rack(self, db_session, placed):
        """Quarantine is quarantine IN PLACE, or it is not quarantine."""
        lot = db_session.get(MaterialLot, placed.material_lot_id)
        self._hold(db_session, placed)
        with pytest.raises(Exception) as excinfo:
            lps.move_units(db_session, lot, from_row_id=ROW_1, to_row_id=ROW_2,
                           full_units=2)
        assert "on hold" in str(excinfo.value)

    def test_releasing_puts_it_back(self, db_session, placed):
        self._hold(db_session, placed)
        self._hold(db_session, placed, action="release")
        assert self._available(db_session) == 20000.0

    # ── partial: the lot is fine, these eight drums are not ──────────────────

    def _rack_items(self, receipt, row_id, units):
        return [{"receipt_id": receipt.id, "location_id": row_id,
                 "quantity": units * 500.0, "units": units}]

    def test_holding_eight_of_forty_leaves_thirty_two_available(self, db_session, placed):
        self._hold(db_session, placed, items=self._rack_items(placed, ROW_1, 8),
                   reason="Water damage")
        assert self._available(db_session) == 16000.0

    def test_the_placement_records_which_rack_and_how_many(self, db_session, placed):
        self._hold(db_session, placed, items=self._rack_items(placed, ROW_1, 8))
        placement = lps.placements_for_lot(db_session, placed.material_lot_id)[0]
        assert placement.full_units == 40
        assert placement.held_units == 8

    def test_staging_can_take_the_free_ones_but_not_the_held_ones(self, db_session, placed):
        self._hold(db_session, placed, items=self._rack_items(placed, ROW_1, 8))

        # 32 free: taking all of them is fine.
        staging_service._stage_free_rack(db_session, placed, 16000.0, None)
        assert _by_row(db_session, placed.material_lot_id) == {ROW_1: 8}

        # The 9th drum does not exist as far as staging is concerned.
        with pytest.raises(Exception) as excinfo:
            staging_service._stage_free_rack(db_session, placed, 500.0, None)
        assert "on hold" in str(excinfo.value)

    def test_the_refusal_says_how_many_are_on_hold(self, db_session, placed):
        """"There is not enough" and "it is quarantined" are different problems
        and only one of them is the asker's to solve."""
        self._hold(db_session, placed, items=self._rack_items(placed, ROW_1, 35))
        with pytest.raises(Exception) as excinfo:
            staging_service._stage_free_rack(db_session, placed, 10000.0, None)
        assert "35 on hold" in str(excinfo.value)

    def test_a_partial_hold_does_not_hide_the_whole_lot_from_staging(
        self, db_session, placed
    ):
        """Eight wet drums must not make the other thirty-two unstageable.

        `suggest_lots_for_staging` filters on `Receipt.hold`, which is a
        whole-receipt flag. A partial hold lives on the placements instead, so
        the lot stays offerable and availability reports what is actually free.
        """
        self._hold(db_session, placed, items=self._rack_items(placed, ROW_1, 8))
        assert placed.hold is False

        suggestions = staging_service.suggest_lots_for_staging(
            db_session, PRODUCT, 1000.0, WH
        )
        assert [s["receipt_id"] for s in suggestions] == [placed.id]

    def test_a_whole_lot_hold_does_hide_it_from_staging(self, db_session, placed):
        self._hold(db_session, placed)
        assert placed.hold is True
        assert staging_service.suggest_lots_for_staging(
            db_session, PRODUCT, 1000.0, WH
        ) == []

    def test_you_cannot_hold_more_than_is_on_the_rack(self, db_session, placed):
        self._hold(db_session, placed, items=self._rack_items(placed, ROW_1, 999))
        placement = lps.placements_for_lot(db_session, placed.material_lot_id)[0]
        assert placement.held_units == 40

    def test_a_partially_held_lot_can_be_released(self, db_session, placed):
        """The bug a partial hold created: it could not be undone.

        `validate_and_build_hold_dict` gated on `receipt.hold`, and a partial
        hold deliberately leaves that False so the un-held containers stay
        stageable. So the screen offered Release and the server answered
        "Cannot release a lot that is not on hold" — a quarantine with no way
        out except editing the database.
        """
        self._hold(db_session, placed, items=self._rack_items(placed, ROW_1, 8))
        assert placed.hold is False
        assert hold_service.is_receipt_held(db_session, placed) is True

        self._hold(db_session, placed, action="release")
        placement = lps.placements_for_lot(db_session, placed.material_lot_id)[0]
        assert placement.held_units == 0
        assert hold_service.is_receipt_held(db_session, placed) is False

    def test_the_projection_carries_the_hold(self, db_session, placed):
        """So every reader of the allocation JSON can see a quarantine without
        querying the lot — which is how the Holds screen knows to offer Release."""
        self._hold(db_session, placed, items=self._rack_items(placed, ROW_1, 8))
        db_session.refresh(placed)
        entry = placed.raw_material_row_allocations[0]
        assert entry["units"] == 40
        assert entry["heldUnits"] == 8

    def test_a_whole_lot_hold_projects_every_container_as_held(self, db_session, placed):
        """`is_held` lives on the LOT and the placements know nothing about it,
        so the projection has to resolve it — otherwise a wholly-held lot reads
        as completely un-held to anything looking at the JSON."""
        self._hold(db_session, placed)
        db_session.refresh(placed)
        entry = placed.raw_material_row_allocations[0]
        assert entry["heldUnits"] == entry["units"] == 40

    def test_a_rack_scoped_release_clears_only_that_rack(self, db_session, seed):
        receipt = _approve(db_session, _receipt(db_session, units=50, allocs=[
            {"rowId": ROW_1, "pallets": 3, "units": 30},
            {"rowId": ROW_2, "pallets": 2, "units": 20},
        ]))
        self._hold(db_session, receipt, items=[
            {"receipt_id": receipt.id, "location_id": ROW_1, "quantity": 0, "units": 10},
            {"receipt_id": receipt.id, "location_id": ROW_2, "quantity": 0, "units": 5},
        ])
        self._hold(db_session, receipt, action="release", items=[
            {"receipt_id": receipt.id, "location_id": ROW_1, "quantity": 0},
        ])
        held = {
            p.storage_row_id: p.held_units
            for p in lps.placements_for_lot(db_session, receipt.material_lot_id)
        }
        assert held == {ROW_1: 0, ROW_2: 5}


class TestWhatTheStagingScreenIsTold:
    """The screen used to ask for pounds and a pallet count.

    Nobody removes 62% of a pound from a rack; they carry two drums off ROW 3.
    So the suggestion now carries containers and the racks they sit on, and the
    screen switches on `is_counted`.
    """

    def test_a_counted_lot_reports_containers_and_racks(self, db_session, seed):
        receipt = _approve(db_session, _receipt(db_session, units=50, allocs=[
            {"rowId": ROW_1, "pallets": 3, "units": 30},
            {"rowId": ROW_2, "pallets": 2, "units": 20},
        ]))
        suggestion = staging_service.suggest_lots_for_staging(
            db_session, PRODUCT, 1000.0, WH
        )[0]

        assert suggestion["receipt_id"] == receipt.id
        assert suggestion["is_counted"] is True
        assert suggestion["unit_label"] == "drum"
        assert suggestion["available_units"] == 50
        # Fullest first — the order `take_units` drains them, so the screen
        # lists racks in the order a picker walks them.
        assert [r["storage_row_name"] for r in suggestion["racks"]] == ["A-01", "A-02"]
        assert [r["available_units"] for r in suggestion["racks"]] == [30, 20]

    def test_quarantined_containers_are_shown_but_not_offered(self, db_session, placed):
        hold = InventoryHoldAction(
            id="hold-stage-1", receipt_id=placed.id, action="hold",
            reason="Water damage", status="pending", submitted_by="u-submit",
            hold_items=[{"receipt_id": placed.id, "location_id": ROW_1,
                         "quantity": 0, "units": 8}],
        )
        db_session.add(hold)
        db_session.flush()
        hold_service.approve_hold_action(db_session, hold, _Approver())
        db_session.flush()

        suggestion = staging_service.suggest_lots_for_staging(
            db_session, PRODUCT, 1000.0, WH
        )[0]
        # Visible, because they ARE on the rack and somebody counting would find
        # them. Not offered, because `take_units` will refuse them.
        assert suggestion["held_units"] == 8
        assert suggestion["available_units"] == 32
        # And the weight agrees with the count rather than with receipt.quantity,
        # which knows nothing about holds.
        assert suggestion["available_quantity"] == 16000.0

    def test_a_legacy_receipt_is_not_marked_counted(self, db_session, seed):
        """No placements, so containers is not a question it can answer — the
        screen keeps the old weight-and-pallets entry for these."""
        receipt = _receipt(db_session, units=40, allocs=None)
        receipt.status = ReceiptStatus.APPROVED
        db_session.flush()

        suggestion = staging_service.suggest_lots_for_staging(
            db_session, PRODUCT, 1000.0, WH
        )[0]
        assert suggestion["is_counted"] is False
        assert suggestion["racks"] == []

    def test_the_screens_pull_plan_matches_what_the_service_does(self, db_session, seed):
        """The screen computes the plan locally to show it before submitting.

        If that ever diverged from `take_units`, the ticket would send somebody
        to the wrong rack. This pins the rule both sides implement: fullest
        first.
        """
        receipt = _approve(db_session, _receipt(db_session, units=50, allocs=[
            {"rowId": ROW_1, "pallets": 3, "units": 30},
            {"rowId": ROW_2, "pallets": 2, "units": 20},
        ]))
        # What the screen would draw for a 35-drum pull.
        racks = sorted(
            staging_service.suggest_lots_for_staging(db_session, PRODUCT, 1.0, WH)[0]["racks"],
            key=lambda r: -r["available_units"],
        )
        planned, left = [], 35
        for rack in racks:
            if left <= 0:
                break
            take = min(rack["available_units"], left)
            planned.append((rack["storage_row_id"], take))
            left -= take

        staging_service._stage_free_rack(db_session, receipt, 35 * 500.0, None)
        # A rack drained to zero drops out of `placements_for_lot` entirely —
        # there is nothing on it to report — so read defensively.
        after = _by_row(db_session, receipt.material_lot_id)

        for row_id, take in planned:
            started_with = 30 if row_id == ROW_1 else 20
            assert after.get(row_id, 0) == started_with - take
        assert planned == [(ROW_1, 30), (ROW_2, 5)]


class TestPalletisedMaterial:
    """Bags and boxes arrive wrapped fifty to a pallet; barrels do not.

    `units_per_pallet` is the one number that separates them, and only the
    corporate check-in path ever collected it. Without it a Log Receipt of 500
    bags produced 500 individual stickers, a rack claiming 500 pallets, and a
    gun with no multiplier.
    """

    def _bags(self, db, *, count=500, per_pallet=50, lot_number="SUGAR-88"):
        receipt = Receipt(
            id=f"rcpt-bag-{uuid.uuid4().hex[:8]}", product_id=PRODUCT,
            category_id="cat-conv-raw", vendor_id=VENDOR, lot_number=lot_number,
            expiration_date=BBD, quantity=count * 25.0, unit="lbs",
            container_count=count, container_unit="bags",
            weight_per_container=25.0, weight_unit="lbs",
            units_per_pallet=per_pallet, warehouse_id=WH,
            status=ReceiptStatus.RECORDED, submitted_by="u-submit",
            raw_material_row_allocations=[{"rowId": ROW_1, "units": count}],
        )
        db.add(receipt)
        db.flush()
        return _approve(db, receipt)

    def test_the_lot_learns_how_many_ride_a_pallet(self, db_session, seed):
        receipt = self._bags(db_session)
        lot = db_session.get(MaterialLot, receipt.material_lot_id)
        assert lot.units_per_pallet == 50

    def test_the_rack_reports_pallets_not_bags(self, db_session, seed):
        """500 bags are ten wrapped pallets. A rack saying 500 is telling the
        warehouse something untrue about its own shelf."""
        self._bags(db_session)
        assert db_session.get(StorageRow, ROW_1).occupied_pallets == 10

    def test_barrels_are_untouched(self, db_session, seed):
        """One barrel is one sticker, one scan, one slot — every branch
        collapses to the same answer, so the missing number costs nothing."""
        receipt = _approve(db_session, _receipt(
            db_session, units=40, allocs=[{"rowId": ROW_1, "units": 40}]))
        lot = db_session.get(MaterialLot, receipt.material_lot_id)
        assert lot.units_per_pallet is None
        assert db_session.get(StorageRow, ROW_1).occupied_pallets == 40

    def test_a_part_pallet_still_occupies_a_whole_one(self, db_session, seed):
        """Twenty-five bags of a fifty-bag pallet is one part-used pallet on the
        shelf, not half of one."""
        self._bags(db_session, count=25)
        assert db_session.get(StorageRow, ROW_1).occupied_pallets == 1

    def test_two_lots_do_not_share_a_wrap(self, db_session, seed):
        """Ceilings are summed PER LOT. Two lots of 25 bags are two part-used
        pallets, because different lots are not wrapped together — so the total
        is 2, not ceil(50/50) = 1."""
        self._bags(db_session, count=25, lot_number="SUGAR-88")
        self._bags(db_session, count=25, lot_number="SALT-1")
        assert db_session.get(StorageRow, ROW_1).occupied_pallets == 2

    def test_both_stickers_are_the_same_sticker(self, db_session, seed):
        """A bag does not become different material by coming off a pallet, so
        scanning either resolves to the same lot. Only the middle band differs."""
        receipt = self._bags(db_session)
        lot = db_session.get(MaterialLot, receipt.material_lot_id)

        pallets = lrs.label_sheet_for_lot(db_session, lot, 10, receipt=receipt,
                                          scope="pallet")
        bags = lrs.label_sheet_for_lot(db_session, lot, 50, receipt=receipt,
                                       scope="unit")

        assert pallets["count"] == 10 and bags["count"] == 50
        assert pallets["labels"][0]["lot_code"] == bags["labels"][0]["lot_code"]
        assert pallets["labels"][0]["pack_scope"] == "pallet"
        assert bags["labels"][0]["pack_scope"] == "unit"
        # The pallet sticker carries NO count — "PALLET · 50 BAGS" would start
        # lying the moment somebody took one.
        assert "count" not in pallets["labels"][0]

    def test_the_number_is_filled_when_missing_and_never_overwritten(
        self, db_session, seed
    ):
        """A lot can be minted at approval before anybody fills the figure in,
        so a later print supplies it. But pallets already received were counted
        under the old figure, and restating it would restate their footprint."""
        receipt = self._bags(db_session, per_pallet=None)
        lot = db_session.get(MaterialLot, receipt.material_lot_id)
        assert lot.units_per_pallet is None

        receipt.units_per_pallet = 25
        db_session.flush()
        lrs.ensure_lot_for_receipt(db_session, receipt, units_per_pallet=25)
        assert lot.units_per_pallet == 25

        lrs.ensure_lot_for_receipt(db_session, receipt, units_per_pallet=99)
        assert lot.units_per_pallet == 25

    def test_the_scanner_gets_the_multiplier_from_the_lot(self, db_session, seed):
        """`receiving_summary` reads it off the LOT, not the order line, so the
        gun offers "scan once = 50 bags" for a Log Receipt lot too."""
        receipt = self._bags(db_session)
        summary = lrs.receiving_summary(db_session, receipt)
        assert summary["units_per_pallet"] == 50


class TestHoldItemRowResolution:
    """Storage row ids contain the separator the parser split on.

    They look like `sub-row-1768418496176` and `fg-row-1768397469384`, so
    `location_id.split("-row-")[-1]` returned a bare timestamp matching no row.
    Every hold that named a rack silently resolved to nothing — which is why
    `receipt.hold_location` had never once been populated.
    """

    def test_a_bare_row_id_resolves_to_itself(self, db_session, seed):
        assert hold_service.resolve_row_id(db_session, ROW_1) == ROW_1

    def test_an_id_containing_the_separator_survives(self, db_session, seed):
        db_session.add(StorageRow(
            id="sub-row-1768418496176", name="B-01", sub_location_id="sub-conv",
            storage_area_id="area-conv", pallet_capacity=0,
        ))
        db_session.flush()
        # The greedy split would have returned "1768418496176".
        assert hold_service.resolve_row_id(
            db_session, "sub-row-1768418496176"
        ) == "sub-row-1768418496176"

    def test_a_prefixed_composite_id_still_resolves(self, db_session, seed):
        assert hold_service.resolve_row_id(db_session, f"loc-conv-row-{ROW_1}") == ROW_1

    def test_something_that_is_not_a_rack_resolves_to_nothing(self, db_session, seed):
        assert hold_service.resolve_row_id(db_session, "loc-conv") is None
        assert hold_service.resolve_row_id(db_session, "") is None


class TestProjectionStaysHonest:
    def test_the_legacy_json_tracks_every_movement(self, db_session, placed):
        """The whole reason the old writers were refused rather than tolerated.

        Whatever moves the placements must leave the projected JSON agreeing with
        them, or the two disagree and which one wins depends on who you ask.
        """
        staging_service._stage_free_rack(db_session, placed, 2500.0, None)
        db_session.refresh(placed)

        projected = sum(e["units"] for e in (placed.raw_material_row_allocations or []))
        assert projected == _on_hand(db_session, placed.material_lot_id) == 35

    def test_the_ledger_reconciles_after_a_full_round_trip(self, db_session, placed):
        """Received, staged, adjusted, moved — the events still add up."""
        lot = db_session.get(MaterialLot, placed.material_lot_id)
        staging_service._stage_free_rack(db_session, placed, 1000.0, None)
        lps.put_units(db_session, lot, units=1, to_row_id=ROW_2,
                      event_type=lps.EVENT_RETURNED)
        lps.move_units(db_session, lot, from_row_id=ROW_1, to_row_id=ROW_2,
                       full_units=3)

        # `reconcile_lot` replays the event ledger against the placements. A
        # non-empty `rows` means some write path moved a placement without
        # recording why, which is the failure this whole conversion could
        # plausibly have introduced.
        report = lps.reconcile_lot(db_session, lot.id)
        assert report["drifted"] == 0
        assert report["rows"] == []
