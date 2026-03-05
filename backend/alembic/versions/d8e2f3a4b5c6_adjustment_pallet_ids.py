"""add pallet_licence_ids to inventory_adjustments

Revision ID: d8e2f3a4b5c6
Revises: c7f1a2b3d4e5
Create Date: 2026-02-27

"""
from typing import Union, Sequence
from alembic import op
import sqlalchemy as sa

revision: str = 'd8e2f3a4b5c6'
down_revision: Union[str, Sequence[str], None] = 'c7f1a2b3d4e5'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('inventory_adjustments', sa.Column('pallet_licence_ids', sa.JSON(), nullable=True))
    # Also make receipt_id nullable so pallet-based adjustments don't require a receipt
    op.alter_column('inventory_adjustments', 'receipt_id', nullable=True)


def downgrade() -> None:
    op.alter_column('inventory_adjustments', 'receipt_id', nullable=False)
    op.drop_column('inventory_adjustments', 'pallet_licence_ids')
