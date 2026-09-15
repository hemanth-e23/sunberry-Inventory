"""Which rack a delivery was put away on — from BOTH receiving paths.

Material arrives two ways, and they stamp different refs on the ledger:

  * a typed Log Receipt writes  ref_type="receipt"    (place_logged_rows)
  * a drum scanned on the gun writes ref_type="receiving" (REF_TYPE_RECEIVING)

`received_into_by_receipt` filtered on the first alone, so it matched nothing a
forklift had ever scanned. Every scanned delivery showed no rack in the
inventory modal — an em dash on exactly the receipts that knew their rack most
precisely, because the gun records it per drum.

The bug is invisible from either side on its own: the writer is correct, the
reader is correct, and only the pair disagrees. So the test asserts both paths
come back, which is the only place the disagreement shows.
"""
import pytest

from app.models import MaterialLot, Receipt
from app.services import lot_placement_service as lps


DRUM_LBS = 485.0


def _lot(db, seed_data, suffix):
    lot = MaterialLot(
        id=f"mlot-{suffix}",
        lot_code=f"S9.VENDOR-9.{suffix}.20280623",
        lot_key=f"key-{suffix}",
        product_id=seed_data["product"].id,
        unit_label="drum",
        weight_per_unit=DRUM_LBS,
        weight_unit="lbs",
    )
    db.add(lot)
    db.commit()
    return lot


def _receipt(db, seed_data, lot, *, suffix, drums):
    r = Receipt(
        id=f"rcpt-{suffix}",
        product_id=seed_data["product"].id,
        category_id=seed_data["category"].id,
        quantity=drums * DRUM_LBS,
        unit="lbs",
        container_count=drums,
        container_unit="drums",
        weight_per_container=DRUM_LBS,
        lot_number="826/26",
        status="approved",
        material_lot_id=lot.id,
    )
    db.add(r)
    db.commit()
    return r


@pytest.mark.unit
class TestReceivedIntoByReceipt:

    def test_a_scanned_delivery_reports_its_rack(self, db_session, seed_data):
        """The case that was broken: the gun stamps `receiving`, not `receipt`."""
        lot = _lot(db_session, seed_data, "scan")
        receipt = _receipt(db_session, seed_data, lot, suffix="scan", drums=60)

        for _ in range(60):
            lps.apply_delta(
                db_session, lot, "row-1",
                event_type=lps.EVENT_RECEIVED,
                full_units_delta=1,
                actor_id=None,
                ref_type="receiving",          # what ScannerLotReceiveFlow writes
                ref_id=receipt.id,
            )
        db_session.commit()

        result = lps.received_into_by_receipt(db_session, seed_data["product"].id)

        assert receipt.id in result, "a scanned delivery must report its rack"
        assert result[receipt.id][0]["units"] == 60
        assert result[receipt.id][0]["storage_row_name"] == "Row A"

    def test_a_typed_log_receipt_still_reports_its_rack(self, db_session, seed_data):
        """The path that already worked must keep working."""
        lot = _lot(db_session, seed_data, "typed")
        receipt = _receipt(db_session, seed_data, lot, suffix="typed", drums=40)

        lps.apply_delta(
            db_session, lot, "row-1",
            event_type=lps.EVENT_RECEIVED,
            full_units_delta=40,
            actor_id=None,
            ref_type="receipt",                # what place_logged_rows writes
            ref_id=receipt.id,
        )
        db_session.commit()

        result = lps.received_into_by_receipt(db_session, seed_data["product"].id)

        assert receipt.id in result
        assert result[receipt.id][0]["units"] == 40

    def test_a_later_move_does_not_rewrite_where_it_arrived(self, db_session, seed_data):
        """"It is where it WENT, not where it is." A rack-to-rack move writes its
        own events; this answer stays pinned to the delivery."""
        from app.models import StorageRow
        db_session.add(StorageRow(
            id="row-2", name="Row B",
            sub_location_id=seed_data["sub_location"].id,
            storage_area_id="area-1", pallet_capacity=10, is_active=True,
        ))
        db_session.commit()

        lot = _lot(db_session, seed_data, "moved")
        receipt = _receipt(db_session, seed_data, lot, suffix="moved", drums=10)

        lps.apply_delta(
            db_session, lot, "row-1",
            event_type=lps.EVENT_RECEIVED, full_units_delta=10,
            actor_id=None, ref_type="receiving", ref_id=receipt.id,
        )
        db_session.commit()

        lps.move_units(
            db_session, lot,
            from_row_id="row-1", to_row_id="row-2",
            full_units=4, reason="Warehouse transfer", ref_id="tr-x",
        )
        db_session.commit()

        result = lps.received_into_by_receipt(db_session, seed_data["product"].id)

        # Still the rack it ARRIVED on, with the count that arrived.
        assert result[receipt.id][0]["storage_row_name"] == "Row A"
        assert result[receipt.id][0]["units"] == 10

    def test_it_reports_the_room_and_its_unit_word(self, db_session, seed_data):
        """A lot-counted receipt carries no location of its own.

        `receipts.location` and `receipts.storage_row_id` are both NULL on one —
        its placement lives in the ledger — so the Location column had nothing to
        read and showed an em dash on material whose position is known drum by
        drum. The room travels with the rack now, and it names its own unit:
        Apple Barn shelves drums, so 60 there is 60 drums, not 60 pallets.
        """
        sub = seed_data["sub_location"]
        sub.storage_unit = "drum"
        sub.unit_capacity = 88
        db_session.commit()

        lot = _lot(db_session, seed_data, "room")
        receipt = _receipt(db_session, seed_data, lot, suffix="room", drums=60)

        lps.apply_delta(
            db_session, lot, "row-1",
            event_type=lps.EVENT_RECEIVED, full_units_delta=60,
            actor_id=None, ref_type="receiving", ref_id=receipt.id,
        )
        db_session.commit()

        entry = lps.received_into_by_receipt(
            db_session, seed_data["product"].id)[receipt.id][0]

        assert entry["unit_label"] == "drums"
        assert entry["sub_location_id"] == sub.id
        assert sub.name in entry["location_label"]

    def test_a_pallet_room_still_says_pallets(self, db_session, seed_data):
        lot = _lot(db_session, seed_data, "pal")
        receipt = _receipt(db_session, seed_data, lot, suffix="pal", drums=5)

        lps.apply_delta(
            db_session, lot, "row-1",
            event_type=lps.EVENT_RECEIVED, full_units_delta=5,
            actor_id=None, ref_type="receipt", ref_id=receipt.id,
        )
        db_session.commit()

        entry = lps.received_into_by_receipt(
            db_session, seed_data["product"].id)[receipt.id][0]
        assert entry["unit_label"] == "pallets"

    def test_an_undone_scan_is_not_reported(self, db_session, seed_data):
        """The per-rack counts must add up to the receipt.

        A real 60-drum delivery read "ROW 5 (4 drums), ROW 4 (57 drums)" — 61.
        The extra drum was scanned and then undone, and undo writes a
        COMPENSATING event rather than deleting the scan, so counting only
        positive `received` events still reported it.
        """
        lot = _lot(db_session, seed_data, "undo")
        receipt = _receipt(db_session, seed_data, lot, suffix="undo", drums=3)

        for _ in range(4):
            lps.apply_delta(
                db_session, lot, "row-1",
                event_type=lps.EVENT_RECEIVED, full_units_delta=1,
                actor_id=None, ref_type="receiving", ref_id=receipt.id,
            )
        # The worker says "that double-counted".
        lps.apply_delta(
            db_session, lot, "row-1",
            event_type=lps.EVENT_ADJUSTED, full_units_delta=-1,
            actor_id=None, ref_type="receiving", ref_id=receipt.id,
            reason="Undo last scan", reason_code="undo",
        )
        db_session.commit()

        result = lps.received_into_by_receipt(db_session, seed_data["product"].id)
        assert result[receipt.id][0]["units"] == 3, "the undone drum must come off"

    def test_a_fully_undone_rack_is_dropped(self, db_session, seed_data):
        """"ROW 5 (0 drums)" reports a put-away that was taken back."""
        from app.models import StorageRow
        db_session.add(StorageRow(
            id="row-3", name="Row C",
            sub_location_id=seed_data["sub_location"].id,
            storage_area_id="area-1", pallet_capacity=10, is_active=True,
        ))
        db_session.commit()

        lot = _lot(db_session, seed_data, "wipe")
        receipt = _receipt(db_session, seed_data, lot, suffix="wipe", drums=2)

        lps.apply_delta(
            db_session, lot, "row-1",
            event_type=lps.EVENT_RECEIVED, full_units_delta=2,
            actor_id=None, ref_type="receiving", ref_id=receipt.id,
        )
        # One drum onto the wrong rack, then taken straight back off.
        lps.apply_delta(
            db_session, lot, "row-3",
            event_type=lps.EVENT_RECEIVED, full_units_delta=1,
            actor_id=None, ref_type="receiving", ref_id=receipt.id,
        )
        lps.apply_delta(
            db_session, lot, "row-3",
            event_type=lps.EVENT_ADJUSTED, full_units_delta=-1,
            actor_id=None, ref_type="receiving", ref_id=receipt.id,
            reason="Undo last scan", reason_code="undo",
        )
        db_session.commit()

        entries = lps.received_into_by_receipt(
            db_session, seed_data["product"].id)[receipt.id]

        assert [e["storage_row_name"] for e in entries] == ["Row A"]
        assert entries[0]["units"] == 2
