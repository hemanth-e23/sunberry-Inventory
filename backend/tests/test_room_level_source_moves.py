"""Moving raw material that sits at ROOM level, not on a rack.

On 2026-09-15 a move of 20 drums out of 88 (lot 8CPB350398, Grater Room to
Apple Barn ROW 14) left three things wrong at once:

  * the source was never deducted — the form sent the ROOM's id, and
    `parse_breakdown` kept only ids shaped `row-<id>`, so it silently matched
    nothing
  * the destination was credited anyway, so the content briefly existed twice
  * `receipt.storage_row_id` jumped to ROW 14, which made Inventory Overview
    show all 88 drums there

Room-level material is legitimate: that receipt was taken in when the Grater
Room had no rows at all. The bug was treating "I cannot place this" as "there is
nothing to place".

The load-bearing assertion in all of these is the last one — allocations must
still total `receipt.quantity`. That single invariant would have caught the
original bug the day it shipped.
"""
import pytest

from app.exceptions import ValidationError
from app.models import InventoryTransfer, Receipt, StorageRow, SubLocation
from app.services import transfer_service
from app.services.row_allocation import resolve_breakdown


DRUM_LBS = 529.0


def _room(db, *, name, room_id, with_row=True, rows=1):
    db.add(SubLocation(id=room_id, name=name, location_id="loc-paw-paw",
                       storage_unit="drum"))
    made = []
    if with_row:
        for i in range(rows):
            rid = f"row-{room_id}-{i}"
            db.add(StorageRow(id=rid, name=f"{name}" if rows == 1 else f"{name} {i}",
                              sub_location_id=room_id, pallet_capacity=0,
                              is_active=True))
            made.append(rid)
    db.commit()
    return made


class _Approver:
    id = "u-room-approver"
    role = "admin"
    name = "Approver"
    warehouse_id = None


def _receipt(db, seed_data, *, drums, allocations=None, row_id=None, legacy=False):
    """A drum receipt. By default approved THROUGH the intake gate, so the lot
    is counted onto its rack — the only shape a transfer may move since the
    2026-09 audit. ``legacy=True`` inserts the outlawed approved-with-no-
    placements shape directly, for tests that assert how it is refused."""
    from app.models import User
    from app.services import receipt_service

    if not db.query(User).filter(User.id == "u-room-approver").first():
        db.add(User(id="u-room-approver", username="roomapprover", name="Approver",
                    email="room@x.test", hashed_password="x", role="admin",
                    is_active=True))
        db.flush()

    r = Receipt(
        id="rcpt-room-level",
        product_id=seed_data["product"].id,
        category_id=seed_data["category"].id,
        quantity=drums * DRUM_LBS,
        unit="lbs",
        container_count=drums,
        container_unit="drums",
        weight_per_container=DRUM_LBS,
        lot_number="8CPB350398",
        status="approved" if legacy else "recorded",
        storage_row_id=row_id,
        raw_material_row_allocations=allocations or [],
    )
    db.add(r)
    db.flush()
    if not legacy:
        receipt_service.approve_receipt(db, r, _Approver())
    db.commit()
    return r


def _transfer(db, receipt, *, source_id, dest_row_id, lbs):
    t = InventoryTransfer(
        id="transfer-room-level",
        receipt_id=receipt.id,
        transfer_type="warehouse-transfer",
        status="pending",
        quantity=lbs,
        unit="lbs",
        source_breakdown=[{"id": source_id, "quantity": lbs}],
        destination_breakdown=[{"id": f"row-{dest_row_id}", "quantity": lbs}],
    )
    db.add(t)
    db.commit()
    return t


@pytest.mark.unit
class TestResolveBreakdown:

    def test_room_id_resolves_to_that_rooms_single_row(self, db_session, seed_data):
        [row_id] = _room(db_session, name="Grater Room", room_id="sub-grater")

        resolved, unresolved = resolve_breakdown(
            db_session, [{"id": "sub-grater", "quantity": 10580}]
        )

        assert resolved == {row_id: 10580.0}
        assert unresolved == []

    def test_row_ids_still_work_unchanged(self, db_session, seed_data):
        resolved, unresolved = resolve_breakdown(
            db_session, [{"id": "row-abc", "quantity": 500}]
        )
        assert resolved == {"abc": 500.0}
        assert unresolved == []

    def test_room_with_several_rows_is_reported_not_guessed(self, db_session, seed_data):
        """Picking one of them would invent a rack nobody pulled from, and
        afterwards it would be indistinguishable from one somebody did."""
        _room(db_session, name="Big Room", room_id="sub-big", rows=3)

        resolved, unresolved = resolve_breakdown(
            db_session, [{"id": "sub-big", "quantity": 900}]
        )

        assert resolved == {}
        assert unresolved == ["sub-big"]

    def test_room_with_no_rows_is_reported(self, db_session, seed_data):
        _room(db_session, name="Cage", room_id="sub-cage", with_row=False)

        resolved, unresolved = resolve_breakdown(
            db_session, [{"id": "sub-cage", "quantity": 100}]
        )

        assert resolved == {}
        assert unresolved == ["sub-cage"]


@pytest.mark.unit
class TestPartialRoomLevelTransfer:

    def test_partial_move_deducts_source_and_keeps_the_total_honest(
        self, db_session, seed_data
    ):
        """The original bug: 20 of 88 drums moved, source never debited."""
        [grater_row] = _room(db_session, name="Grater Room", room_id="sub-grater")
        [dest_row] = _room(db_session, name="ROW 14", room_id="sub-apple")

        receipt = _receipt(
            db_session, seed_data, drums=88, row_id=grater_row,
            allocations=[{"rowId": grater_row, "rowName": "Grater Room",
                          "cases": 88 * DRUM_LBS, "pallets": 0}],
        )
        transfer = _transfer(db_session, receipt, source_id="sub-grater",
                             dest_row_id=dest_row, lbs=20 * DRUM_LBS)

        transfer_service._apply_raw_material_internal_transfer(
            db_session, transfer, receipt
        )
        db_session.commit()

        allocs = {a["rowId"]: a["cases"] for a in receipt.raw_material_row_allocations}
        assert allocs.get(dest_row) == pytest.approx(20 * DRUM_LBS)
        assert allocs.get(grater_row) == pytest.approx(68 * DRUM_LBS)
        # THE invariant. Content cannot appear or vanish in a move.
        assert sum(allocs.values()) == pytest.approx(receipt.quantity)

    def test_partial_move_does_not_relocate_the_whole_receipt(
        self, db_session, seed_data
    ):
        """storage_row_id is what Inventory Overview reads. Moving it on a
        partial move is what put all 88 drums in ROW 14."""
        [grater_row] = _room(db_session, name="Grater Room", room_id="sub-grater")
        [dest_row] = _room(db_session, name="ROW 14", room_id="sub-apple")

        receipt = _receipt(
            db_session, seed_data, drums=88, row_id=grater_row,
            allocations=[{"rowId": grater_row, "rowName": "Grater Room",
                          "cases": 88 * DRUM_LBS, "pallets": 0}],
        )
        transfer = _transfer(db_session, receipt, source_id="sub-grater",
                             dest_row_id=dest_row, lbs=20 * DRUM_LBS)

        transfer_service._apply_raw_material_internal_transfer(
            db_session, transfer, receipt
        )
        db_session.commit()

        assert receipt.storage_row_id == grater_row, "partial move must not relocate"

    def test_whole_receipt_move_does_relocate(self, db_session, seed_data):
        [grater_row] = _room(db_session, name="Grater Room", room_id="sub-grater")
        [dest_row] = _room(db_session, name="ROW 14", room_id="sub-apple")

        receipt = _receipt(
            db_session, seed_data, drums=88, row_id=grater_row,
            allocations=[{"rowId": grater_row, "rowName": "Grater Room",
                          "cases": 88 * DRUM_LBS, "pallets": 0}],
        )
        transfer = _transfer(db_session, receipt, source_id="sub-grater",
                             dest_row_id=dest_row, lbs=88 * DRUM_LBS)

        transfer_service._apply_raw_material_internal_transfer(
            db_session, transfer, receipt
        )
        db_session.commit()

        assert receipt.storage_row_id == dest_row

    def test_unresolvable_source_refuses_and_writes_nothing(
        self, db_session, seed_data
    ):
        """Better a refusal naming the room than a silent half-move."""
        _room(db_session, name="Cage", room_id="sub-cage", with_row=False)
        [dest_row] = _room(db_session, name="ROW 14", room_id="sub-apple")

        # legacy shape on purpose: the refusal under test fires on source
        # resolution, BEFORE the counted-lot guard would refuse this receipt.
        receipt = _receipt(db_session, seed_data, drums=88, allocations=[],
                           legacy=True)
        transfer = _transfer(db_session, receipt, source_id="sub-cage",
                             dest_row_id=dest_row, lbs=20 * DRUM_LBS)

        with pytest.raises(ValidationError) as err:
            transfer_service._apply_raw_material_internal_transfer(
                db_session, transfer, receipt
            )

        assert "Cage" in str(err.value), "the message must name the room"
        assert receipt.raw_material_row_allocations == [], "nothing may be written"
