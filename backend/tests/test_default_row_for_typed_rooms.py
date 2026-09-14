"""A unit-typed room must end up with somewhere to put a drum.

`lot_placements.storage_row_id` is NOT NULL, so a drum can only be received into
a ROW. Marking a room as holding drums did not create one, and the rack picker
lists rows — so the room stayed invisible at the gun with nothing on screen
explaining why. Reefer 557 needed its row inserted by hand before receiving
could begin.

These tests pin the two halves of the rule: a typed room gains exactly one row
named after itself, and a room that already has rows is never touched.
"""
import pytest

from app.models import StorageRow, SubLocation
from app.services import ingredient_row_service


def _room(db, *, name, storage_unit=None, location_id="loc-paw-paw"):
    sub = SubLocation(
        id=f"subloc-{name.lower().replace(' ', '-')}",
        name=name,
        location_id=location_id,
        storage_unit=storage_unit,
    )
    db.add(sub)
    db.commit()
    return sub


def _rows_in(db, sub):
    return db.query(StorageRow).filter(StorageRow.sub_location_id == sub.id).all()


@pytest.mark.unit
class TestDefaultRowForTypedRooms:

    def test_typed_room_gains_one_row_named_after_itself(
        self, db_session, seed_data, admin_user
    ):
        sub = _room(db_session, name="Reefer 557", storage_unit="drum")

        ingredient_row_service.ensure_default_row(db_session, sub, admin_user)
        db_session.commit()

        rows = _rows_in(db_session, sub)
        assert len(rows) == 1
        row = rows[0]
        assert row.name == "Reefer 557"
        assert row.sub_location_id == sub.id
        # Hangs off the sub-location, not an area — a typed room has no area
        # between it and its rows, and _rows_query resolves either parent.
        assert row.storage_area_id is None
        # Capacity for these rooms is sub_location.unit_capacity in drums, not
        # pallets. Zero is correct here, not a placeholder.
        assert row.pallet_capacity == 0
        assert row.is_active is True

    def test_pallet_room_is_left_alone(self, db_session, seed_data, admin_user):
        """An untyped room keeps today's behaviour: rows are made by hand."""
        sub = _room(db_session, name="Dry Store", storage_unit=None)

        created = ingredient_row_service.ensure_default_row(db_session, sub, admin_user)
        db_session.commit()

        assert created is None
        assert _rows_in(db_session, sub) == []

    def test_room_with_existing_rows_is_not_given_another(
        self, db_session, seed_data, admin_user
    ):
        """Somebody described this space deliberately; a default row would be a
        phantom location competing with the real ones."""
        sub = _room(db_session, name="Drum Room", storage_unit="drum")
        db_session.add(StorageRow(
            id="row-real-1", name="ROW 1", sub_location_id=sub.id,
            pallet_capacity=0, is_active=True,
        ))
        db_session.commit()

        created = ingredient_row_service.ensure_default_row(db_session, sub, admin_user)
        db_session.commit()

        assert created is None
        names = sorted(r.name for r in _rows_in(db_session, sub))
        assert names == ["ROW 1"]

    def test_running_twice_does_not_duplicate(self, db_session, seed_data, admin_user):
        """The endpoint calls this on every sub-location update, not just the
        one that sets storage_unit."""
        sub = _room(db_session, name="Cage", storage_unit="drum")

        ingredient_row_service.ensure_default_row(db_session, sub, admin_user)
        db_session.commit()
        ingredient_row_service.ensure_default_row(db_session, sub, admin_user)
        db_session.commit()

        assert len(_rows_in(db_session, sub)) == 1

    def test_the_new_row_is_visible_to_the_rack_picker(
        self, db_session, seed_data, admin_user
    ):
        """The whole point. list_rows is what the gun's picker reads, and a row
        it cannot see is the same as no row at all."""
        sub = _room(db_session, name="Reefer 557", storage_unit="drum")
        ingredient_row_service.ensure_default_row(db_session, sub, admin_user)
        db_session.commit()

        listed = ingredient_row_service.list_rows(db_session, admin_user)
        assert "Reefer 557" in [r["name"] for r in listed]
