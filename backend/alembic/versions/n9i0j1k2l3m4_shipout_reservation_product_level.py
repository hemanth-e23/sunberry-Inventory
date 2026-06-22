"""ship-out reservations pool at product level

Phase D of the ship-out soft-totals work: ship_out_lot_reservations move from a
per-(product, lot) soft lock to a per-PRODUCT pool. The actual lot is chosen
live at scan time, so a reservation no longer pins a lot — new rows carry
lot_number = NULL. Existing per-lot rows from in-flight orders stay valid; the
capacity sums ignore lot_number, so they still count toward the product pool.

Only change needed: make lot_number nullable. The existing partial index
ix_ship_out_lot_reservations_active (product_id, lot_number) WHERE
released_at IS NULL still serves product_id lookups (leading column), so it is
left in place.

Revision ID: n9i0j1k2l3m4
Revises: m8h9i0j1k2l3
Create Date: 2026-06-19
"""
from typing import Union, Sequence
from alembic import op
import sqlalchemy as sa

revision: str = 'n9i0j1k2l3m4'
down_revision: Union[str, Sequence[str], None] = 'm8h9i0j1k2l3'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        'ship_out_lot_reservations',
        'lot_number',
        existing_type=sa.String(length=100),
        nullable=True,
    )


def downgrade() -> None:
    # Backfill any NULLs before restoring NOT NULL so the downgrade can't fail.
    op.execute(
        "UPDATE ship_out_lot_reservations SET lot_number = '' "
        "WHERE lot_number IS NULL"
    )
    op.alter_column(
        'ship_out_lot_reservations',
        'lot_number',
        existing_type=sa.String(length=100),
        nullable=False,
    )
