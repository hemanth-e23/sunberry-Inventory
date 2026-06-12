"""adjustment unit

Adds a nullable `unit` column to inventory_adjustments. The unit of an
adjustment's quantity is copied from the receipt at create time so historical
adjustments stay interpretable even if the receipt's unit later changes, and
so reports can group adjustment quantities by unit instead of summing
cases + lbs + units together.

Revision ID: m8h9i0j1k2l3
Revises: l7g8h9i0j1k2
Create Date: 2026-06-12
"""
from typing import Union, Sequence
from alembic import op
import sqlalchemy as sa

revision: str = 'm8h9i0j1k2l3'
down_revision: Union[str, Sequence[str], None] = 'l7g8h9i0j1k2'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'inventory_adjustments',
        sa.Column('unit', sa.String(length=20), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('inventory_adjustments', 'unit')
