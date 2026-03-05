"""cycle count nullable location_id

Revision ID: f1a2b3c4d5e6
Revises: e9f3a4b5c6d7
Create Date: 2026-02-27

"""
from typing import Union, Sequence
from alembic import op
import sqlalchemy as sa

revision: str = 'f1a2b3c4d5e6'
down_revision: Union[str, Sequence[str], None] = 'e9f3a4b5c6d7'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column('cycle_counts', 'location_id', nullable=True)


def downgrade() -> None:
    # Note: rows with NULL location_id will block this — clear them first
    op.alter_column('cycle_counts', 'location_id', nullable=False)
