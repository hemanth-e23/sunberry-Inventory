"""cycle_counts: count_date String -> Date

Revision ID: g2b3c4d5e6f7
Revises: f1a2b3c4d5e6
Create Date: 2026-03-03

"""
from typing import Union, Sequence
from alembic import op
import sqlalchemy as sa

revision: str = 'g2b3c4d5e6f7'
down_revision: Union[str, Sequence[str], None] = 'f1a2b3c4d5e6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # All existing values are YYYY-MM-DD strings; PostgreSQL casts them directly
    op.alter_column(
        'cycle_counts', 'count_date',
        type_=sa.Date(),
        postgresql_using='count_date::date',
    )


def downgrade() -> None:
    op.alter_column(
        'cycle_counts', 'count_date',
        type_=sa.String(20),
        postgresql_using='count_date::text',
    )
