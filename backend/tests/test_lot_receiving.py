"""Phase 2 — receiving under lot-level identity.

Two paths, one ending. Corporate creates an incoming order and the plant receives
against it; or material walks in with no order and the worker logs a receipt off
the driver's BOL. Both end in a Receipt + a MaterialLot + LotPlacements, which is
what makes one approval surface and one availability story possible.

The properties that matter, each replacing something that was wrong or missing:

* **Printing is not receiving.** Stock exists when a unit is scanned into a rack,
  never when a sticker comes off the printer.
* **No soft answer is a 4xx.** A full rack, an unknown sticker, a held lot — all
  200s. A 4xx makes the offline queue mark the scan permanently failed and the
  driver silently loses it.
* **A replayed scan counts once**, and the replay check runs before every gate,
  so a scan that succeeded and lost its response still replays correctly after
  the session closed.
* **Undo exists.** Identical stickers make client-side dedupe impossible, so "I
  think that double-counted" needs a real answer.
"""
from datetime import datetime, timezone

import pytest

from app.enums import IncomingOrderStatus, ReceiptStatus
from app.exceptions import ConflictError, ValidationError
from app.models import (
    Category,
    IngredientIntake,
    IntakeLot,
    Location,
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
from app.services import lot_placement_service as lps
from app.services import lot_receiving_service as lrs

WH = "wh-recv-1"
PRODUCT = "prod-mango"
OTHER_PRODUCT = "prod-guava"
VENDOR = "vendor-recv"
ROW_1 = "row-recv-1"
ROW_2 = "row-recv-2"
USER = "user-recv-1"

BBD = datetime(2027, 3, 1, tzinfo=timezone.utc)


@pytest.fixture
def recv_seed(db_session):
    db_session.add(Warehouse(id=WH, name="Plant A", code="PA", type="owned", is_active=True))
    db_session.add(Category(id="cat-ingredient", name="Ingredients", type="ingredient"))
    db_session.add_all([
        Product(id=PRODUCT, name="Mango Puree", category_id="cat-ingredient", sid="SID-1"),
        Product(id=OTHER_PRODUCT, name="Guava Puree", category_id="cat-ingredient", sid="SID-2"),
    ])
    db_session.add(Vendor(id=VENDOR, name="Acme Juice"))
    db_session.add(Location(id="loc-recv", name="Plant A", warehouse_id=WH))
    db_session.add(SubLocation(
        id="sub-drums", name="Drum Barn", location_id="loc-recv",
        storage_unit="drum", unit_capacity=22,
    ))
    db_session.add_all([
        StorageRow(id=ROW_1, name="A-01", sub_location_id="sub-drums",
                   barcode="PA-A01", pallet_capacity=0, is_active=True),
        StorageRow(id=ROW_2, name="A-02", sub_location_id="sub-drums",
                   barcode="PA-A02", pallet_capacity=0, is_active=True),
    ])
    db_session.add(User(
        id=USER, username="recvworker", name="Recv Worker",
        email="recv@sunberry.com", hashed_password="x", role="warehouse", is_active=True,
    ))
    db_session.commit()


def _order(db, *, lines=None, released=True):
    order = lrs.create_incoming_order(
        db,
        {
            "vendor_id": VENDOR,
            "bol": "BOL-1",
            "purchase_order": "PO-1",
            "origin_name": "Chicago 3PL",
            "expected_date": datetime(2026, 8, 20, tzinfo=timezone.utc),
            "lines": lines or [{
                "product_id": PRODUCT,
                "category_id": "cat-ingredient",
                "vendor_lot": "MG-77",
                "bbd": BBD,
                "expected_count": 80,
                "unit_label": "drum",
                "weight_per_unit": 500.0,
                "weight_unit": "lbs",
            }],
        },
        user_id=USER,
        warehouse_id=WH,
    )
    if released:
        lrs.release_order(db, order, user_id=USER)
    return order


def _walkin_receipt(db, *, count=40, lot_number="WI-11"):
    receipt = Receipt(
        id="rcpt-walkin",
        product_id=PRODUCT,
        category_id="cat-ingredient",
        lot_number=lot_number,
        expiration_date=BBD,
        quantity=count * 500.0,
        unit="lbs",
        container_count=count,
        container_unit="drums",
        weight_per_container=500.0,
        weight_unit="lbs",
        vendor_id=VENDOR,
        warehouse_id=WH,
        status=ReceiptStatus.RECORDED,
        submitted_by=USER,
        receipt_date=datetime(2026, 8, 17, tzinfo=timezone.utc),
    )
    db.add(receipt)
    db.flush()
    return receipt


# ---------------------------------------------------------------------------
# Incoming orders
# ---------------------------------------------------------------------------

class TestIncomingOrder:
    def test_one_order_per_destination_carries_many_products(self, db_session, recv_seed):
        """A truck carries mango and guava; the order has to as well."""
        order = _order(db_session, lines=[
            {"product_id": PRODUCT, "vendor_lot": "MG-1", "expected_count": 20,
             "unit_label": "drum", "weight_per_unit": 500.0, "weight_unit": "lbs"},
            {"product_id": OTHER_PRODUCT, "vendor_lot": "GV-1", "expected_count": 20,
             "unit_label": "drum", "weight_per_unit": 450.0, "weight_unit": "lbs"},
        ])
        assert len(order.lots) == 2
        assert order.expected_count == 40
        assert order.warehouse_id == WH
        assert order.is_incoming_order is True

    def test_creating_an_order_creates_no_stock(self, db_session, recv_seed):
        """Mirrors the ship-out precedent: planning reserves nothing."""
        _order(db_session)
        db_session.commit()
        assert db_session.query(MaterialLot).count() == 0
        assert db_session.query(Receipt).count() == 0

    def test_an_order_needs_at_least_one_line(self, db_session, recv_seed):
        with pytest.raises(ValidationError):
            lrs.create_incoming_order(
                db_session, {"lines": []}, user_id=USER, warehouse_id=WH
            )

    def test_release_moves_it_in_transit(self, db_session, recv_seed):
        order = _order(db_session, released=False)
        assert order.status == IncomingOrderStatus.DRAFT.value
        lrs.release_order(db_session, order, user_id=USER)
        assert order.status == IncomingOrderStatus.IN_TRANSIT.value
        assert order.released_at is not None

    def test_a_draft_cannot_be_received_against(self, db_session, recv_seed):
        """Corporate has not finished the paperwork, so there is nothing to
        reconcile the count against yet."""
        order = _order(db_session, released=False)
        with pytest.raises(ConflictError):
            lrs.start_receiving(db_session, order, order.lots[0], user_id=USER)

    def test_closing_short_requires_a_reason(self, db_session, recv_seed):
        """Otherwise the difference is an unexplained hole nobody can answer for."""
        order = _order(db_session)
        receipt = lrs.start_receiving(db_session, order, order.lots[0], user_id=USER)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        for _ in range(70):
            lrs.scan_unit(
                db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                storage_row_id=ROW_1, allow_overfill=True,
            )
        with pytest.raises(ValidationError):
            lrs.close_order(db_session, order, user_id=USER)

        lrs.close_order(db_session, order, user_id=USER, reason="Truck was 10 short")
        assert order.status == IncomingOrderStatus.CLOSED_SHORT.value
        assert order.short_count == 10
        assert order.received_count == 70

    def test_a_complete_close_needs_no_reason(self, db_session, recv_seed):
        order = _order(db_session, lines=[{
            "product_id": PRODUCT, "vendor_lot": "MG-77", "expected_count": 3,
            "unit_label": "drum", "weight_per_unit": 500.0, "weight_unit": "lbs",
        }])
        receipt = lrs.start_receiving(db_session, order, order.lots[0], user_id=USER)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        for _ in range(3):
            lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                          storage_row_id=ROW_1)
        lrs.close_order(db_session, order, user_id=USER)
        assert order.status == IncomingOrderStatus.RECEIVED.value
        assert order.short_count == 0

    def test_a_partly_received_order_cannot_be_cancelled(self, db_session, recv_seed):
        order = _order(db_session)
        receipt = lrs.start_receiving(db_session, order, order.lots[0], user_id=USER)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                      storage_row_id=ROW_1)
        with pytest.raises(ConflictError):
            lrs.cancel_order(db_session, order, user_id=USER)

    def test_start_receiving_creates_receipt_and_lot(self, db_session, recv_seed):
        order = _order(db_session)
        receipt = lrs.start_receiving(db_session, order, order.lots[0], user_id=USER)

        assert receipt.material_lot_id
        assert receipt.container_count == 80
        assert receipt.container_unit == "drum"
        assert receipt.weight_per_container == 500.0
        # Weight, derived — matching what routers/receipts.py writes on create.
        assert receipt.quantity == 40000.0
        assert receipt.unit == "lbs"
        assert order.lots[0].receipt_id == receipt.id
        assert order.status == IncomingOrderStatus.RECEIVING.value

    def test_start_receiving_resumes_rather_than_restarting(self, db_session, recv_seed):
        """A worker who backs out and comes in again must not open a second
        session against the same drums."""
        order = _order(db_session)
        first = lrs.start_receiving(db_session, order, order.lots[0], user_id=USER)
        second = lrs.start_receiving(db_session, order, order.lots[0], user_id=USER)
        assert first.id == second.id
        assert db_session.query(Receipt).count() == 1

    def test_the_worker_can_correct_what_corporate_typed(self, db_session, recv_seed):
        """Corporate fills 99%. This is the 1%, and it is why receiving is not
        just a button that says 'yes, all of it arrived'."""
        order = _order(db_session)
        receipt = lrs.start_receiving(
            db_session, order, order.lots[0], user_id=USER,
            overrides={"vendor_lot": "MG-77-B", "expected_count": 78,
                       "weight_per_unit": 550.0, "bol": "BOL-REAL"},
        )
        assert receipt.lot_number == "MG-77-B"
        assert receipt.container_count == 78
        assert receipt.weight_per_container == 550.0
        assert receipt.bol == "BOL-REAL"
        assert order.lots[0].vendor_lot == "MG-77-B"
        lot = db_session.query(MaterialLot).filter(
            MaterialLot.id == receipt.material_lot_id
        ).first()
        assert lot.vendor_lot_number == "MG-77-B"
        assert lot.weight_per_unit == 550.0


# ---------------------------------------------------------------------------
# Stickers
# ---------------------------------------------------------------------------

class TestLabels:
    def test_every_sticker_of_a_lot_is_identical(self, db_session, recv_seed):
        """There is no per-sticker identity, so no serial and no '17 of 80'."""
        receipt = _walkin_receipt(db_session)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        sheet = lrs.label_sheet_for_lot(db_session, lot, 40, receipt=receipt)

        assert sheet["count"] == 40
        assert len(sheet["labels"]) == 40
        assert all(label == sheet["labels"][0] for label in sheet["labels"])
        assert sheet["labels"][0]["lot_code"] == lot.lot_code
        assert "serial" not in sheet["labels"][0]
        assert "sequence" not in sheet["labels"][0]

    def test_a_sticker_carries_the_sid_and_the_vendor_lot(self, db_session, recv_seed):
        """The production app checks SID, so it has to be derivable."""
        receipt = _walkin_receipt(db_session)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        label = lrs.label_sheet_for_lot(db_session, lot, 1)["labels"][0]
        assert label["product_sid"] == "SID-1"
        assert label["vendor_lot"] == "WI-11"
        assert label["vendor_name"] == "Acme Juice"
        assert label["unit_label"] == "drum"

    def test_the_sticker_carries_the_CURRENT_bbd(self, db_session, recv_seed):
        """An approved extension is the one case where stickers are reprinted and
        reapplied, and the new date is the whole reason."""
        receipt = _walkin_receipt(db_session)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        extended = datetime(2027, 9, 1, tzinfo=timezone.utc)
        lot.bbd_current = extended
        db_session.flush()
        assert lrs.label_sheet_for_lot(db_session, lot, 1)["labels"][0]["bbd"] == extended

    def test_no_sticker_prints_for_a_lot_under_review(self, db_session, recv_seed):
        """An identical sticker on the wrong material cannot be found later —
        every drum on the pile is wearing it."""
        receipt = _walkin_receipt(db_session)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        lot.needs_review = True
        lot.review_reason = "Two receipts disagree on drum weight"
        db_session.flush()
        with pytest.raises(ConflictError):
            lrs.label_sheet_for_lot(db_session, lot, 10)

    def test_printing_is_not_receiving(self, db_session, recv_seed):
        """The single most important line in the module."""
        receipt = _walkin_receipt(db_session)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        lrs.label_sheet_for_lot(db_session, lot, 40)
        assert lps.units_on_hand(db_session, lot.id)["full_units"] == 0
        assert lrs.session_counts(db_session, receipt)["total"] == 0

    def test_pressing_print_twice_cannot_fork_the_lot(self, db_session, recv_seed):
        receipt = _walkin_receipt(db_session)
        first = lrs.ensure_lot_for_receipt(db_session, receipt)
        second = lrs.ensure_lot_for_receipt(db_session, receipt)
        assert first.id == second.id
        assert db_session.query(MaterialLot).count() == 1


# ---------------------------------------------------------------------------
# Scanning
# ---------------------------------------------------------------------------

class TestScanning:
    def _session(self, db):
        receipt = _walkin_receipt(db, count=40)
        lot = lrs.ensure_lot_for_receipt(db, receipt)
        return receipt, lot

    def test_the_same_sticker_scanned_n_times_counts_n(self, db_session, recv_seed):
        """The heart of it: identical stickers, and the count is what a person
        physically did forty times."""
        receipt, lot = self._session(db_session)
        for i in range(1, 21):
            result = lrs.scan_unit(
                db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                storage_row_id=ROW_1, idempotency_key=f"scan-{i:04d}",
            )
            assert result["status"] == "ok"
            assert result["row_scanned_count"] == i
            assert result["session_scanned_count"] == i

        assert result["session_expected_count"] == 40
        assert result["count_unit"] == "drums"
        assert lps.units_on_hand(db_session, lot.id)["full_units"] == 20

    def test_the_envelope_and_the_bare_code_both_resolve(self, db_session, recv_seed):
        receipt, lot = self._session(db_session)
        bare = lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                             storage_row_id=ROW_1)
        wrapped = lrs.scan_unit(
            db_session, receipt_id=receipt.id,
            lot_code=f"SB2|{lot.lot_code}|WI-11|20270301", storage_row_id=ROW_1,
        )
        assert bare["status"] == "ok" and wrapped["status"] == "ok"
        assert wrapped["session_scanned_count"] == 2

    def test_an_unknown_sticker_is_a_200_not_a_4xx(self, db_session, recv_seed):
        """A 4xx makes the offline queue park the scan as permanently failed."""
        receipt, _lot = self._session(db_session)
        result = lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code="L9999999",
                               storage_row_id=ROW_1)
        assert result["status"] == "unknown_lot"
        assert result["session_scanned_count"] == 0

    def test_a_held_lot_is_a_200_too(self, db_session, recv_seed):
        receipt, lot = self._session(db_session)
        lot.is_held = True
        db_session.flush()
        result = lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                               storage_row_id=ROW_1)
        assert result["status"] == "lot_held"
        assert lps.units_on_hand(db_session, lot.id)["full_units"] == 0

    def test_an_unknown_row_is_a_200_too(self, db_session, recv_seed):
        receipt, lot = self._session(db_session)
        result = lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                               storage_row_id="row-nope")
        assert result["status"] == "unknown_row"

    def test_a_full_rack_asks_rather_than_refuses(self, db_session, recv_seed):
        """22 drums per row is a prompt. Refusing would strand a driver holding a
        drum with nowhere the system will accept."""
        receipt, lot = self._session(db_session)
        for i in range(22):
            lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                          storage_row_id=ROW_1, idempotency_key=f"fill-{i:03d}")

        asked = lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                              storage_row_id=ROW_1, idempotency_key="over-1")
        assert asked["status"] == "needs_confirm"
        assert asked["warning"] == "row_full"
        assert asked["session_scanned_count"] == 22   # nothing was written

        # The same key replays with allow_overfill, exactly as the gun does — so a
        # lost first response cannot become a second drum.
        confirmed = lrs.scan_unit(
            db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
            storage_row_id=ROW_1, idempotency_key="over-1", allow_overfill=True,
        )
        assert confirmed["status"] == "ok"
        assert confirmed["session_scanned_count"] == 23

    def test_a_pallet_room_never_warns(self, db_session, recv_seed):
        """`pallet_capacity = 0` means 'no opinion'. Reading it as 'capacity zero'
        would warn on every single scan."""
        db_session.add(SubLocation(id="sub-plain", name="Dry Store", location_id="loc-recv"))
        db_session.add(StorageRow(id="row-plain", name="P-01",
                                  sub_location_id="sub-plain", pallet_capacity=0))
        db_session.commit()
        receipt, lot = self._session(db_session)
        for i in range(30):
            result = lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                                   storage_row_id="row-plain", idempotency_key=f"p-{i:03d}")
            assert result["status"] == "ok"

    def test_a_replayed_scan_counts_once(self, db_session, recv_seed):
        receipt, lot = self._session(db_session)
        for _ in range(4):
            result = lrs.scan_unit(
                db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                storage_row_id=ROW_1, idempotency_key="dup-key-12345678",
            )
        assert result["session_scanned_count"] == 1
        assert lps.units_on_hand(db_session, lot.id)["full_units"] == 1

    def test_a_replay_still_works_after_the_receipt_is_approved(self, db_session, recv_seed):
        """The write already landed. Gating the replay behind a status check is
        how scanner_service turns a successful scan into a lost one."""
        receipt, lot = self._session(db_session)
        lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                      storage_row_id=ROW_1, idempotency_key="late-replay-key")
        receipt.status = ReceiptStatus.APPROVED
        db_session.flush()

        replay = lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                               storage_row_id=ROW_1, idempotency_key="late-replay-key")
        assert replay["status"] == "ok"
        assert replay["session_scanned_count"] == 1

    def test_scanning_across_two_rows_keeps_per_row_counts(self, db_session, recv_seed):
        """Scan a rack, fill it, scan the next rack, carry on."""
        receipt, lot = self._session(db_session)
        for i in range(10):
            lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                          storage_row_id=ROW_1, idempotency_key=f"r1-{i:03d}")
        for i in range(6):
            result = lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                                   storage_row_id=ROW_2, idempotency_key=f"r2-{i:03d}")
        assert result["row_scanned_count"] == 6
        assert result["session_scanned_count"] == 16

    def test_a_sticker_from_another_lot_is_recorded_and_flagged(self, db_session, recv_seed):
        """One truck legitimately carries several lots, so this is not an error —
        but the usual cause is the wrong sticker stack, so the worker is told."""
        receipt, _lot = self._session(db_session)
        other = lps.find_or_create_lot(
            db_session, product_id=OTHER_PRODUCT, vendor_id=VENDOR,
            vendor_lot_number="GV-9", bbd=BBD, unit_label="drum",
            weight_per_unit=450.0, weight_unit="lbs", warehouse_id=WH,
        )
        result = lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=other.lot_code,
                               storage_row_id=ROW_1)
        assert result["status"] == "ok"
        assert result["lot_mismatch"] is True
        assert lps.units_on_hand(db_session, other.id)["full_units"] == 1

    def test_over_receiving_is_allowed_and_visible(self, db_session, recv_seed):
        """82 arrived against an expected 80 is a real thing that happens."""
        receipt, lot = self._session(db_session)
        for i in range(42):
            result = lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                                   storage_row_id=ROW_1, idempotency_key=f"o-{i:03d}",
                                   allow_overfill=True)
        assert result["session_scanned_count"] == 42
        assert result["session_expected_count"] == 40
        assert lrs.receiving_summary(db_session, receipt)["difference"] == 2

    def test_scanning_projects_into_the_legacy_json(self, db_session, recv_seed):
        """The whole point of Phase 1's projection: every existing reader keeps
        working without knowing lots exist."""
        receipt, lot = self._session(db_session)
        for i in range(10):
            lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                          storage_row_id=ROW_1, idempotency_key=f"pj-{i:03d}")

        entries = receipt.raw_material_row_allocations
        assert len(entries) == 1
        assert entries[0]["rowId"] == ROW_1
        assert entries[0]["cases"] == 5000.0       # a REAL weight, not pallets x 40
        assert entries[0]["units"] == 10


class TestUndo:
    def test_undo_takes_one_back_off(self, db_session, recv_seed):
        receipt = _walkin_receipt(db_session)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        for i in range(5):
            lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                          storage_row_id=ROW_1, idempotency_key=f"u-{i:03d}")

        result = lrs.undo_last_scan(db_session, receipt_id=receipt.id, user_id=USER)
        assert result["status"] == "undone"
        assert result["session_scanned_count"] == 4
        assert lps.units_on_hand(db_session, lot.id)["full_units"] == 4

    def test_undo_compensates_rather_than_deletes(self, db_session, recv_seed):
        """A ledger you can delete from is not a ledger."""
        receipt = _walkin_receipt(db_session)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                      storage_row_id=ROW_1, idempotency_key="keep-me")
        lrs.undo_last_scan(db_session, receipt_id=receipt.id, user_id=USER)

        events = db_session.query(LotPlacementEvent).filter(
            LotPlacementEvent.material_lot_id == lot.id
        ).order_by(LotPlacementEvent.seq).all()
        assert len(events) == 2
        assert [e.full_units_delta for e in events] == [1, -1]
        assert events[0].idempotency_key == "keep-me"
        assert lps.reconcile_lot(db_session, lot.id)["drifted"] == 0

    def test_undo_with_nothing_to_undo_is_not_an_error(self, db_session, recv_seed):
        receipt = _walkin_receipt(db_session)
        result = lrs.undo_last_scan(db_session, receipt_id=receipt.id, user_id=USER)
        assert result["status"] == "nothing_to_undo"

    def test_undo_walks_back_across_rows(self, db_session, recv_seed):
        receipt = _walkin_receipt(db_session)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                      storage_row_id=ROW_1, idempotency_key="w-1")
        lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                      storage_row_id=ROW_2, idempotency_key="w-2")

        lrs.undo_last_scan(db_session, receipt_id=receipt.id, user_id=USER)
        counts = lrs.session_counts(db_session, receipt)
        assert counts["by_row"].get(ROW_2, 0) == 0
        assert counts["by_row"][ROW_1] == 1


# ---------------------------------------------------------------------------
# The approval view
# ---------------------------------------------------------------------------

class TestReceivingSummary:
    def test_it_shows_paperwork_against_scanned_per_row(self, db_session, recv_seed):
        order = _order(db_session)
        receipt = lrs.start_receiving(db_session, order, order.lots[0], user_id=USER)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        for i in range(50):
            lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                          storage_row_id=ROW_1, idempotency_key=f"s1-{i:03d}",
                          allow_overfill=True)
        for i in range(28):
            lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                          storage_row_id=ROW_2, idempotency_key=f"s2-{i:03d}",
                          allow_overfill=True)

        summary = lrs.receiving_summary(db_session, receipt)
        assert summary["expected_count"] == 80
        assert summary["scanned_count"] == 78
        assert summary["difference"] == -2
        assert summary["count_unit"] == "drums"
        assert summary["derived_weight"] == 39000.0
        assert summary["source"] == "incoming_order"
        assert summary["order_number"] == order.intake_number
        assert {r["storage_row_name"]: r["count"] for r in summary["rows"]} == {
            "A-01": 50, "A-02": 28,
        }

    def test_a_walk_in_reads_as_a_walk_in(self, db_session, recv_seed):
        receipt = _walkin_receipt(db_session, count=12)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        for i in range(12):
            lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                          storage_row_id=ROW_1, idempotency_key=f"wi-{i:03d}")

        summary = lrs.receiving_summary(db_session, receipt)
        assert summary["source"] == "walk_in"
        assert summary["order_number"] is None
        assert summary["difference"] == 0

    def test_session_counts_ignore_stock_this_session_did_not_put_there(
        self, db_session, recv_seed
    ):
        """Placements are shared with every earlier truck and every move. Reading
        them would show a worker a number that includes drums they never touched.
        """
        receipt = _walkin_receipt(db_session)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        # An earlier truck put 30 of this lot in the same rack.
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED,
                        full_units_delta=30)

        result = lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                               storage_row_id=ROW_1, allow_overfill=True)
        assert result["session_scanned_count"] == 1     # this session
        assert result["row_on_hand"] == 31              # the rack


# ---------------------------------------------------------------------------
# Availability
# ---------------------------------------------------------------------------

class TestReceivingFeedsAvailability:
    def test_scanned_stock_is_live_immediately(self, db_session, recv_seed):
        """The dock is never blocked. Approval is a paperwork check afterwards,
        not a gate the drums wait behind."""
        from app.services.availability import on_hand_for_product

        receipt = _walkin_receipt(db_session, count=40)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        for i in range(40):
            lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                          storage_row_id=ROW_1, idempotency_key=f"av-{i:03d}",
                          allow_overfill=True)
        db_session.commit()

        result = on_hand_for_product(db_session, PRODUCT)
        assert result["unit_count"] == 40
        assert result["available_to_stage"] == 20000.0
        # The receipt is still `recorded`, so its legacy quantity contributes 0
        # AND its lot is counted — either way it cannot double up.
        assert result["total"] == 20000.0


class TestUndoIsRepeatable:
    """Undo has to behave the way the button reads: press it twice, two scans
    come off, most recent first.

    Taking "the newest positive event" looks equivalent and is not. A
    compensating event is NEGATIVE, so it is invisible to a `> 0` filter, and the
    ledger is immutable by design — there is no flag marking the original spent.
    So the second undo re-picks the SAME event: it decrements a rack that has
    already been corrected, silently eating a drum that was there before the
    session started, while the scan it should have undone stays counted.
    """

    def test_two_undos_remove_two_different_scans(self, db_session, recv_seed):
        receipt = _walkin_receipt(db_session)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                      storage_row_id=ROW_1, idempotency_key="two-1")
        lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                      storage_row_id=ROW_2, idempotency_key="two-2")

        lrs.undo_last_scan(db_session, receipt_id=receipt.id, user_id=USER)
        lrs.undo_last_scan(db_session, receipt_id=receipt.id, user_id=USER)

        counts = lrs.session_counts(db_session, receipt)
        assert counts["total"] == 0
        assert counts["by_row"].get(ROW_1, 0) == 0
        assert counts["by_row"].get(ROW_2, 0) == 0
        assert lps.units_on_hand(db_session, lot.id)["full_units"] == 0

    def test_undo_never_eats_stock_that_predates_the_session(self, db_session, recv_seed):
        """The concrete corruption. ROW_2 already holds 10 drums from an earlier
        truck; two undos of a two-rack session must not take one of them."""
        receipt = _walkin_receipt(db_session)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        lps.apply_delta(db_session, lot, ROW_2, event_type=lps.EVENT_RECEIVED,
                        full_units_delta=10)

        lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                      storage_row_id=ROW_1, idempotency_key="pre-1")
        lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                      storage_row_id=ROW_2, allow_overfill=True, idempotency_key="pre-2")

        lrs.undo_last_scan(db_session, receipt_id=receipt.id, user_id=USER)
        lrs.undo_last_scan(db_session, receipt_id=receipt.id, user_id=USER)

        # The earlier truck's ten drums are untouched.
        assert lps._lock_placement(db_session, lot.id, ROW_2).full_units == 10
        assert lps._lock_placement(db_session, lot.id, ROW_1).full_units == 0

    def test_undoing_past_the_start_reports_nothing_to_undo(self, db_session, recv_seed):
        """Rather than driving a placement negative and 409ing, which would kill
        the button for the rest of the session."""
        receipt = _walkin_receipt(db_session)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                      storage_row_id=ROW_1, idempotency_key="only-1")

        assert lrs.undo_last_scan(
            db_session, receipt_id=receipt.id, user_id=USER
        )["status"] == "undone"
        assert lrs.undo_last_scan(
            db_session, receipt_id=receipt.id, user_id=USER
        )["status"] == "nothing_to_undo"

    def test_scan_undo_scan_undo_stays_consistent(self, db_session, recv_seed):
        receipt = _walkin_receipt(db_session)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        for i in range(3):
            lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                          storage_row_id=ROW_1, idempotency_key=f"mix-{i}")
            lrs.undo_last_scan(db_session, receipt_id=receipt.id, user_id=USER)
        assert lrs.session_counts(db_session, receipt)["total"] == 0
        assert lps.reconcile_lot(db_session, lot.id)["drifted"] == 0


class TestSessionCountsAreLotScoped:
    def test_a_cross_lot_scan_is_recorded_but_not_counted_here(self, db_session, recv_seed):
        """One truck carries mango and guava. The guava drums are real stock and
        are recorded against guava — but the mango session must not count them,
        or the approver's paperwork check compares two different materials and
        weighs one at the other's pounds-per-drum."""
        receipt = _walkin_receipt(db_session, count=40)
        mango = lrs.ensure_lot_for_receipt(db_session, receipt)
        guava = lps.find_or_create_lot(
            db_session, product_id=OTHER_PRODUCT, vendor_id=VENDOR,
            vendor_lot_number="GV-77", bbd=BBD, unit_label="drum",
            weight_per_unit=300.0, weight_unit="lbs", warehouse_id=WH,
        )

        for i in range(4):
            lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=mango.lot_code,
                          storage_row_id=ROW_1, idempotency_key=f"mg-{i}")
        for i in range(6):
            result = lrs.scan_unit(db_session, receipt_id=receipt.id,
                                   lot_code=guava.lot_code, storage_row_id=ROW_2,
                                   idempotency_key=f"gv-{i}")
            assert result["lot_mismatch"] is True

        # Physical stock is right for both.
        assert lps.units_on_hand(db_session, mango.id)["full_units"] == 4
        assert lps.units_on_hand(db_session, guava.id)["full_units"] == 6

        # The session counts only its own lot, and weighs only its own lot.
        summary = lrs.receiving_summary(db_session, receipt)
        assert summary["scanned_count"] == 4
        assert summary["derived_weight"] == 2000.0        # 4 x 500, not 10 x 500


class TestPlacementWarehouseComesFromTheRack:
    def test_one_vendor_lot_split_between_two_plants_files_correctly(
        self, db_session, recv_seed
    ):
        """A lot's key has no warehouse component — deliberately, since the same
        vendor lot is the same material anywhere. So the lot's own warehouse_id is
        only whichever site saw it first, and copying it onto a placement would
        file Plant B's drums under Plant A."""
        from app.models import Location, StorageRow as Row, SubLocation, Warehouse as WH_

        other = "wh-recv-2"
        db_session.add(WH_(id=other, name="Plant B", code="PB", type="owned"))
        db_session.add(Location(id="loc-b", name="Plant B", warehouse_id=other))
        db_session.add(SubLocation(id="sub-b", name="Barn B", location_id="loc-b",
                                   storage_unit="drum", unit_capacity=50))
        db_session.add(Row(id="row-b1", name="B-01", sub_location_id="sub-b",
                           pallet_capacity=0, is_active=True))
        db_session.commit()

        # Plant A sees it first, so the LOT is stamped A.
        lot = lps.find_or_create_lot(
            db_session, product_id=PRODUCT, vendor_id=VENDOR,
            vendor_lot_number="SPLIT-1", bbd=BBD, unit_label="drum",
            weight_per_unit=500.0, weight_unit="lbs", warehouse_id=WH,
        )
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_RECEIVED,
                        full_units_delta=10)
        # The same lot lands at Plant B.
        lps.apply_delta(db_session, lot, "row-b1", event_type=lps.EVENT_RECEIVED,
                        full_units_delta=20)
        db_session.commit()

        assert lot.warehouse_id == WH
        assert lps._lock_placement(db_session, lot.id, ROW_1).warehouse_id == WH
        assert lps._lock_placement(db_session, lot.id, "row-b1").warehouse_id == other

        from app.services.availability import on_hand_for_product
        assert on_hand_for_product(db_session, PRODUCT, WH)["unit_count"] == 10
        assert on_hand_for_product(db_session, PRODUCT, other)["unit_count"] == 20


class TestNoStickerWithoutIdentity:
    """A sticker reading "LOT UNKNOWN · BBD —" goes on EVERY drum of the lot.

    That is the untraceable pile this model exists to prevent — forty drums
    wearing the same label with nothing to tell them apart, and a recall with
    no way to untangle it.

    RECORDING and PRINTING are different bars on purpose. Stock whose lot number
    is unreadable still gets counted: it physically exists, and refusing to
    record it just makes the inventory wrong. It simply cannot be labelled until
    somebody supplies the detail.
    """

    def _receipt(self, db, *, lot_number, bbd):
        receipt = _walkin_receipt(db, count=10)
        receipt.lot_number = lot_number
        receipt.expiration_date = bbd
        receipt.id = f"rcpt-{lot_number or 'none'}-{'bbd' if bbd else 'nobbd'}"
        db.flush()
        return receipt

    def test_no_lot_number_refuses(self, db_session, recv_seed):
        receipt = self._receipt(db_session, lot_number=None, bbd=BBD)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        allowed, reason = lps.can_print_labels(lot)
        assert allowed is False
        assert "vendor lot number" in reason
        with pytest.raises(ConflictError):
            lrs.label_sheet_for_lot(db_session, lot, 10)

    def test_no_bbd_refuses(self, db_session, recv_seed):
        receipt = self._receipt(db_session, lot_number="HAS-LOT", bbd=None)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        allowed, reason = lps.can_print_labels(lot)
        assert allowed is False
        assert "best-by" in reason

    def test_neither_says_so_once(self, db_session, recv_seed):
        receipt = self._receipt(db_session, lot_number=None, bbd=None)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        reason = lps.can_print_labels(lot)[1]
        assert "vendor lot number" in reason and "best-by" in reason

    def test_a_blank_lot_number_counts_as_missing(self, db_session, recv_seed):
        receipt = self._receipt(db_session, lot_number="   ", bbd=BBD)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        assert lps.can_print_labels(lot)[0] is False

    def test_both_present_prints(self, db_session, recv_seed):
        receipt = self._receipt(db_session, lot_number="GOOD-1", bbd=BBD)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        assert lps.can_print_labels(lot)[0] is True
        assert len(lrs.label_sheet_for_lot(db_session, lot, 10)["labels"]) == 10

    def test_stock_with_no_lot_is_still_COUNTED(self, db_session, recv_seed):
        """The point of the split. Refusing to record it would make the
        inventory wrong; refusing to sticker it keeps the drums traceable."""
        from app.services import lot_cutover_service as lcs

        result = lcs.create_opening_balance(
            db_session, product_id=PRODUCT, storage_row_id=ROW_1, full_units=12,
            vendor_lot=None, weight_per_unit=500.0, weight_unit="lbs",
            warehouse_id=WH, user_id=USER,
        )
        assert result["full_units"] == 12          # counted
        pending = lcs.unlabelled_lots(db_session, WH)
        assert len(pending) == 1
        assert pending[0]["blocked_reason"]        # and told why it cannot print

    def test_supplying_the_bbd_later_unblocks_printing(self, db_session, recv_seed):
        receipt = self._receipt(db_session, lot_number="LATE-BBD", bbd=None)
        lot = lrs.ensure_lot_for_receipt(db_session, receipt)
        assert lps.can_print_labels(lot)[0] is False

        lot.bbd_current = BBD
        db_session.flush()
        assert lps.can_print_labels(lot)[0] is True
