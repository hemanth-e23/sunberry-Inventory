"""Footprint in a room that counts containers.

A 68-drum move into Apple Barn ROW 17 recorded NO footprint: the row showed
"ROW 17" with nothing beside it and its occupancy never moved. The chain was

  * the source rack's stored footprint was 0
  * the transfer form scales its destination suggestion from the source, so it
    suggested 0
  * 0 was sent explicitly, and an explicit figure was respected

Every link behaved as written. The mistake was treating footprint in a drum room
as something a person supplies at all. One drum takes one slot, so it follows
from the content — 35,972 lbs at 529 lbs a drum is 68 drums, whatever the form
says.
"""
import pytest

from app.models import Receipt
from app.services.row_allocation import add_rm_rows, deduct_rm_rows, container_footprint


DRUM_LBS = 529.0


def _receipt(db, seed_data, *, lbs, per_container=DRUM_LBS, allocations=None):
    r = Receipt(
        id=f"rcpt-fp-{int(lbs)}-{int(per_container)}",
        product_id=seed_data["product"].id,
        category_id=seed_data["category"].id,
        quantity=lbs,
        unit="lbs",
        container_count=int(lbs / per_container) if per_container else 0,
        container_unit="drums",
        weight_per_container=per_container,
        lot_number="8CPB350398",
        status="approved",
        raw_material_row_allocations=allocations,
    )
    db.add(r)
    db.commit()
    return r


@pytest.mark.unit
class TestContainerFootprint:

    def _drum_room(self, db, seed_data):
        sub = seed_data["sub_location"]
        sub.storage_unit = "drum"
        sub.unit_capacity = 88
        db.commit()
        return sub

    def test_a_move_into_a_drum_room_records_the_drums(self, db_session, seed_data):
        """The case that was broken: 0 supplied, 68 drums actually landed."""
        self._drum_room(db_session, seed_data)
        receipt = _receipt(db_session, seed_data, lbs=35972.0)

        add_rm_rows(
            db_session, receipt, {"row-1": 35972.0},
            pallets_by_row={"row-1": 0},          # what the form sent
        )
        db_session.commit()

        entry = receipt.raw_material_row_allocations[0]
        assert entry["pallets"] == pytest.approx(68.0), "68 drums, not the supplied 0"

        from app.models.location import StorageRow
        row = db_session.query(StorageRow).filter(StorageRow.id == "row-1").first()
        assert float(row.occupied_pallets) == pytest.approx(68.0)

    def test_a_pallet_room_still_respects_the_handler(self, db_session, seed_data):
        """Where footprint IS a judgement, the number the handler gave stands.

        A single barrel can occupy a whole pallet and consolidation frees a
        pallet without moving any content — no arithmetic recovers that.
        """
        receipt = _receipt(db_session, seed_data, lbs=35972.0)

        add_rm_rows(
            db_session, receipt, {"row-1": 35972.0},
            pallets_by_row={"row-1": 7},
        )
        db_session.commit()

        assert receipt.raw_material_row_allocations[0]["pallets"] == pytest.approx(7.0)

    def test_taking_drums_out_recomputes_what_is_left(self, db_session, seed_data):
        """Recomputed from the remaining content, not old-footprint-minus-delta,
        so one wrong figure does not survive every move that touches it."""
        self._drum_room(db_session, seed_data)
        receipt = _receipt(
            db_session, seed_data, lbs=46552.0,
            allocations=[{
                "rowId": "row-1", "rowName": "ROW 14", "areaId": None,
                "areaName": "", "cases": 46552.0, "pallets": 0.0,   # wrong on disk
            }],
        )

        deduct_rm_rows(db_session, receipt, {"row-1": 10580.0})   # 20 drums out
        db_session.commit()

        entry = receipt.raw_material_row_allocations[0]
        assert entry["cases"] == pytest.approx(35972.0)
        assert entry["pallets"] == pytest.approx(68.0), "68 left, corrected in passing"

    def test_it_declines_when_the_receipt_cannot_say(self, db_session, seed_data):
        """No weight-per-container means no honest container count."""
        self._drum_room(db_session, seed_data)
        receipt = _receipt(db_session, seed_data, lbs=1000.0, per_container=0)

        assert container_footprint(db_session, "row-1", receipt, 1000.0) is None

    def test_a_pallet_room_declines(self, db_session, seed_data):
        receipt = _receipt(db_session, seed_data, lbs=1000.0)
        assert container_footprint(db_session, "row-1", receipt, 1000.0) is None
