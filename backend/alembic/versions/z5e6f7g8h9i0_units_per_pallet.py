"""units_per_pallet on lots and order lines

Revision ID: z5e6f7g8h9i0
Revises: z4d5e6f7g8h9
Create Date: 2026-08-25

Bags and boxes arrive 40-70 to a wrapped pallet, and nobody is going to
destack one at the dock to sticker every bag. So receiving scans ONE sticker on
the pallet and tells the gun how many are under it; this column is the prefill
for that question.

NULL for drums and totes — they are stickered individually, one scan is one
unit, and there is no multiplier.

A PACKING fact, not a stock figure: what is actually on hand lives in
lot_placements, counted in bags. A half-broken pallet does not make this wrong.

Inspector-guarded like its siblings: create_all runs at app import, so the
columns may already exist, and entrypoint.sh runs `alembic upgrade head` under
`set -e` before the app starts.
"""
from alembic import op
import sqlalchemy as sa


revision = "z5e6f7g8h9i0"
down_revision = "z4d5e6f7g8h9"
branch_labels = None
depends_on = None


def _columns(bind, table):
    return {c["name"] for c in sa.inspect(bind).get_columns(table)}


def upgrade():
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    for table in ("material_lots", "intake_lots"):
        if table in tables and "units_per_pallet" not in _columns(bind, table):
            op.add_column(table, sa.Column("units_per_pallet", sa.Integer(), nullable=True))


def downgrade():
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    for table in ("intake_lots", "material_lots"):
        if table in tables and "units_per_pallet" in _columns(bind, table):
            op.drop_column(table, "units_per_pallet")
