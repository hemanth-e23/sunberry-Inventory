"""reconcile + documents: manual attribution, BOL number & snapshot

Revision ID: r3s4t5u6v7w8
Revises: q2r3s4t5u6v7
Create Date: 2026-07-05

Tasks 7 & 8 of SHIP-OUT-SCHEDULING-SPEC.md.
- inventory_transfer_lines.manual_attributions (JSON) — cases loaded without a
  scan (paperwork only, no inventory deduct).
- inventory_transfers.bol_number + document_snapshot — assigned BOL number and
  the frozen values a reprint reproduces.
- bol_number_seq — atomic BOL number source, starts at 1 (rendered "001").
"""
from typing import Union, Sequence
from alembic import op
import sqlalchemy as sa


revision: str = 'r3s4t5u6v7w8'
down_revision: Union[str, Sequence[str], None] = 'q2r3s4t5u6v7'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('inventory_transfer_lines', sa.Column('manual_attributions', sa.JSON(), nullable=True))
    op.add_column('inventory_transfers', sa.Column('bol_number', sa.String(length=30), nullable=True))
    op.add_column('inventory_transfers', sa.Column('document_snapshot', sa.JSON(), nullable=True))
    # Atomic BOL counter. Rendered zero-padded ("001") at generation time.
    op.execute("CREATE SEQUENCE IF NOT EXISTS bol_number_seq START WITH 1 INCREMENT BY 1")


def downgrade() -> None:
    op.execute("DROP SEQUENCE IF EXISTS bol_number_seq")
    op.drop_column('inventory_transfers', 'document_snapshot')
    op.drop_column('inventory_transfers', 'bol_number')
    op.drop_column('inventory_transfer_lines', 'manual_attributions')
