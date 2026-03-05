"""pallet_hold

Revision ID: c7f1a2b3d4e5
Revises: b5e4cbc753b3
Create Date: 2026-02-27 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c7f1a2b3d4e5'
down_revision: Union[str, Sequence[str], None] = 'b5e4cbc753b3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('pallet_licences', sa.Column('is_held', sa.Boolean(), server_default='false', nullable=False))
    op.add_column('inventory_hold_actions', sa.Column('pallet_licence_ids', sa.JSON(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('inventory_hold_actions', 'pallet_licence_ids')
    op.drop_column('pallet_licences', 'is_held')
