"""Ship-out reason — why raw material / packaging left the building

A Shipped Out transfer had only free-text notes, so a return to the vendor and
a sale could not be told apart in any report (browser test 2026-10-01, G4).

  * inventory_transfers.ship_out_reason — one of return_to_vendor / sale /
    sample / other (app.constants.SHIP_OUT_REASONS). Required by the API for
    RM / packaging shipped-out transfers from now on; NULL for every existing
    row and for every other transfer type. Notes stay in `reason`.

Additive and nullable; no backfill (old rows honestly do not know).

Revision ID: f7a8b9c0d1e2
Revises: e0f1a2b3c4d5
"""
from alembic import op
import sqlalchemy as sa


revision = 'f7a8b9c0d1e2'
down_revision = 'e0f1a2b3c4d5'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        'inventory_transfers',
        sa.Column('ship_out_reason', sa.String(length=30), nullable=True),
    )


def downgrade():
    op.drop_column('inventory_transfers', 'ship_out_reason')
