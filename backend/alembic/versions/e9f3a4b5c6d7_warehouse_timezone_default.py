"""warehouse timezone server default

Revision ID: e9f3a4b5c6d7
Revises: d8e2f3a4b5c6
Create Date: 2026-02-27

"""
from typing import Union, Sequence
from alembic import op
import sqlalchemy as sa

revision: str = 'e9f3a4b5c6d7'
down_revision: Union[str, Sequence[str], None] = 'd8e2f3a4b5c6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Set a server_default so new warehouses always have a timezone
    op.alter_column(
        'warehouses', 'timezone',
        existing_type=sa.String(50),
        server_default='America/Los_Angeles',
        nullable=True,
    )
    # Update any existing warehouses that have NULL timezone
    op.execute("UPDATE warehouses SET timezone = 'America/Los_Angeles' WHERE timezone IS NULL")


def downgrade() -> None:
    op.alter_column(
        'warehouses', 'timezone',
        existing_type=sa.String(50),
        server_default=None,
        nullable=True,
    )
