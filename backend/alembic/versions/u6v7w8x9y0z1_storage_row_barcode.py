"""add barcode to storage_rows (ingredient scan-to-location)

Revision ID: u6v7w8x9y0z1
Revises: t5u6v7w8x9y0
Create Date: 2026-08-03

INGREDIENT-SERIALIZATION-SPEC.md §8.3 has the forklift scan a ROW barcode to set
the sticky location context before any drum is scanned (§18.2 R-3 blocks every
drum scan until row resolution succeeds). No such column existed: row resolution
was a client-side fuzzy name match (ScannerReceiptFlow.jsx:321-332) against names
carrying no uniqueness constraint, so two barns each holding a row named "A-12"
would silently bind a drum to whichever one the client array hit first.

Backfill is `{LOC3}-{ROW NAME}`, uppercased and stripped to [A-Z0-9-], truncated
to 34 chars, with collisions disambiguated by an ordinal suffix so the UNIQUE
index below cannot fail on deploy. Rows keep a NULL barcode only if they somehow
resolve to an empty code; those get one when their label is printed.

Note the CREATE TABLE guard idiom used by later revisions in this series: alembic
does not own this schema (Base.metadata.create_all runs at app import,
backend/main.py:29) and entrypoint.sh runs `alembic upgrade head` under `set -e`,
so an unguarded DDL statement against an object create_all already made will
crash-loop the container.
"""
from alembic import op
import sqlalchemy as sa


revision = "u6v7w8x9y0z1"
down_revision = "t5u6v7w8x9y0"
branch_labels = None
depends_on = None


BACKFILL_SQL = """
WITH resolved AS (
    SELECT sr.id,
           COALESCE(l_sub.name, l_area.name, 'ROW') AS loc_name,
           sr.name                                  AS row_name
    FROM storage_rows sr
    LEFT JOIN sub_locations sl     ON sl.id = sr.sub_location_id
    LEFT JOIN locations     l_sub  ON l_sub.id = sl.location_id
    LEFT JOIN storage_areas sa     ON sa.id = sr.storage_area_id
    LEFT JOIN locations     l_area ON l_area.id = sa.location_id
),
candidate AS (
    SELECT id,
           REGEXP_REPLACE(UPPER(LEFT(COALESCE(loc_name, 'ROW'), 3)), '[^A-Z0-9]', '', 'g') AS loc_code,
           REGEXP_REPLACE(UPPER(COALESCE(row_name, '')), '[^A-Z0-9-]', '', 'g')            AS row_code
    FROM resolved
),
usable AS (
    -- A row with no usable name gets no auto-barcode: "BLU-" is not a label
    -- anyone can act on, and every unnamed row in a barn would generate the
    -- same one. Those keep barcode NULL until a label is printed for them.
    SELECT id, LEFT(loc_code || '-' || row_code, 34) AS code
    FROM candidate
    WHERE row_code <> '' AND loc_code <> ''
),
numbered AS (
    SELECT id, code, ROW_NUMBER() OVER (PARTITION BY code ORDER BY id) AS rn
    FROM usable
)
UPDATE storage_rows sr
SET barcode = CASE WHEN n.rn = 1 THEN n.code ELSE n.code || '-' || n.rn END
FROM numbered n
WHERE sr.id = n.id
  AND sr.barcode IS NULL
"""


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    existing = {c["name"] for c in inspector.get_columns("storage_rows")}
    if "barcode" not in existing:
        op.add_column(
            "storage_rows",
            sa.Column("barcode", sa.String(length=40), nullable=True),
        )

    op.execute(BACKFILL_SQL)

    existing_indexes = {i["name"] for i in inspector.get_indexes("storage_rows")}
    if "ix_storage_rows_barcode" not in existing_indexes:
        op.create_index(
            "ix_storage_rows_barcode",
            "storage_rows",
            ["barcode"],
            unique=True,
        )


def downgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    existing_indexes = {i["name"] for i in inspector.get_indexes("storage_rows")}
    if "ix_storage_rows_barcode" in existing_indexes:
        op.drop_index("ix_storage_rows_barcode", table_name="storage_rows")

    existing = {c["name"] for c in inspector.get_columns("storage_rows")}
    if "barcode" in existing:
        op.drop_column("storage_rows", "barcode")
