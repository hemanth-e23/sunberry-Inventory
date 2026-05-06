"""pallet_licences: add idempotency_key for offline-resilient scanning

Revision ID: 5b2c9d3e0fa1
Revises: 4a1c8e2b9d77
Create Date: 2026-05-06

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '5b2c9d3e0fa1'
down_revision: Union[str, Sequence[str], None] = '4a1c8e2b9d77'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add idempotency_key column + unique index for forklift scan retry safety."""
    op.add_column(
        'pallet_licences',
        sa.Column('idempotency_key', sa.String(length=64), nullable=True),
    )
    op.create_index(
        'ix_pallet_licences_idempotency_key',
        'pallet_licences',
        ['idempotency_key'],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index('ix_pallet_licences_idempotency_key', table_name='pallet_licences')
    op.drop_column('pallet_licences', 'idempotency_key')
