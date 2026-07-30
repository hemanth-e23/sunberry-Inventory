"""scheduled ship-out: allow planning lines with no receipt

Revision ID: q2r3s4t5u6v7
Revises: p1q2r3s4t5u6
Create Date: 2026-07-04

Task 2 of SHIP-OUT-SCHEDULING-SPEC.md. A scheduled order is created before stock
exists, so its per-product "planning" lines have no receipt yet — lots/receipts
are resolved at scan time. Make inventory_transfer_lines.receipt_id nullable.
The unique constraint (transfer_id, product_id, receipt_id) is unaffected: NULLs
are distinct in Postgres, and there is at most one planning line per product.
"""
from typing import Union, Sequence
from alembic import op
import sqlalchemy as sa


revision: str = 'q2r3s4t5u6v7'
down_revision: Union[str, Sequence[str], None] = 'p1q2r3s4t5u6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column('inventory_transfer_lines', 'receipt_id',
                    existing_type=sa.String(length=50), nullable=True)


def downgrade() -> None:
    # Only reversible if no NULL-receipt (scheduled) lines exist.
    op.alter_column('inventory_transfer_lines', 'receipt_id',
                    existing_type=sa.String(length=50), nullable=False)
