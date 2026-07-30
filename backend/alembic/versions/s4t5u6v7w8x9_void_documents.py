"""void & regenerate documents: archive voided snapshots

Revision ID: s4t5u6v7w8x9
Revises: r3s4t5u6v7w8
Create Date: 2026-07-05

SPEC §5.4: changes after doc generation require an explicit void + regenerate.
Voided snapshots (with their burned BOL numbers) are archived on the order.
"""
from typing import Union, Sequence
from alembic import op
import sqlalchemy as sa


revision: str = 's4t5u6v7w8x9'
down_revision: Union[str, Sequence[str], None] = 'r3s4t5u6v7w8'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('inventory_transfers', sa.Column('voided_documents', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('inventory_transfers', 'voided_documents')
