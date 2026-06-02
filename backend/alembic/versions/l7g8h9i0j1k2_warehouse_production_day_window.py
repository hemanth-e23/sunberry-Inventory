"""warehouse production day window

Adds production_day_start and production_day_end (TIME) columns to warehouses.
KPI / live-production endpoints use these to bucket scans into a 24h
production day. Default 05:30 → 05:30 (next day) — the operating window
runs 05:30 AM through ~03:00 AM, so a 24h block starting at 05:30 catches
all scans with no dead-zone ambiguity.

Revision ID: l7g8h9i0j1k2
Revises: k6f7g8h9i0j1
Create Date: 2026-06-01
"""
from typing import Union, Sequence
from alembic import op
import sqlalchemy as sa

revision: str = 'l7g8h9i0j1k2'
down_revision: Union[str, Sequence[str], None] = 'k6f7g8h9i0j1'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'warehouses',
        sa.Column('production_day_start', sa.Time(), nullable=False, server_default='05:30'),
    )
    op.add_column(
        'warehouses',
        sa.Column('production_day_end', sa.Time(), nullable=False, server_default='05:30'),
    )


def downgrade() -> None:
    op.drop_column('warehouses', 'production_day_end')
    op.drop_column('warehouses', 'production_day_start')
