"""Give every unit-typed room a default row

A drum can only be received into a ROW — `lot_placements.storage_row_id` is NOT
NULL, because staging directs a forklift to a rack, the full/over-capacity
prompt counts per rack, and a recall trace has to answer "which rack".

Marking a room as holding drums did not create one, so the room stayed
unscannable with nothing on screen to explain it: the rack picker lists rows,
and a room with none simply never appears in the list. Reefer 557 had to have
its row inserted by hand before receiving could start.

`update_sub_location` now creates this row when a room is first typed. This
migration is the same thing for rooms typed before that existed — Cage, In
Front of dock, staging, Grater Room and any others.

Only ever ADDS, and only to rooms with NO rows at all. A room somebody has
already described with real rows is left alone; a default row there would be a
phantom location competing with the real ones.

Barcodes are deliberately NOT minted here. `{LOC3}-{NAME}` collision handling
lives in ingredient_row_service.assign_barcodes, which needs the whole table to
pick a non-colliding suffix, and duplicating that logic in SQL is how the two
drift apart. Run it after upgrading:

    POST /api/ingredient-rows/assign-barcodes

Revision ID: c8d9e0f1a2b3
Revises: b7c8d9e0f1a2
"""
import uuid

from alembic import op
import sqlalchemy as sa


revision = 'c8d9e0f1a2b3'
down_revision = 'b7c8d9e0f1a2'
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()

    rooms = conn.execute(sa.text("""
        SELECT sl.id, sl.name
        FROM sub_locations sl
        WHERE sl.storage_unit IS NOT NULL
          AND sl.is_active IS NOT FALSE
          AND NOT EXISTS (
              SELECT 1 FROM storage_rows sr WHERE sr.sub_location_id = sl.id
          )
        ORDER BY sl.name
    """)).fetchall()

    for room_id, room_name in rooms:
        conn.execute(sa.text("""
            INSERT INTO storage_rows (
                id, name, sub_location_id, storage_area_id,
                pallet_capacity, default_cases_per_pallet,
                occupied_pallets, occupied_cases,
                hold, is_active, is_partial_pallet_location, created_at
            ) VALUES (
                :id, :name, :sub_location_id, NULL,
                0, 0,
                0, 0,
                false, true, false, NOW()
            )
        """), {
            "id": f"row-{uuid.uuid4().hex[:12]}",
            "name": room_name,
            "sub_location_id": room_id,
        })

    print(f"[migration] default row created for {len(rooms)} unit-typed room(s)")


def downgrade():
    # Deliberately NOT deleting rows. By the time anyone runs this a forklift may
    # have put drums on one, and `lot_placements.storage_row_id` is NOT NULL —
    # removing the row would either fail on the constraint or orphan real stock.
    # An unused extra row is harmless; deleted inventory is not.
    pass
