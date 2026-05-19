"""multi-product ship-out: lines + swaps + reservations + void

Revision ID: j5e6f7g8h9i0
Revises: i4d5e6f7g8h9
Create Date: 2026-05-19

Adds support for multi-product, multi-lot ship-out orders:
- inventory_transfer_lines: one row per (product, receipt) line within an order
- transfer_pallet_swaps: audit trail for forklift swaps and warehouse edits
- inventory_transfers.receipt_id → nullable (parent no longer tied to one receipt)
- inventory_transfers.voided_at / voided_by / voided_reason: explicit void path

Legacy single-receipt ship-outs keep their receipt_id populated and have no
lines; both code paths coexist forever.
"""
from typing import Union, Sequence
from alembic import op
import sqlalchemy as sa


revision: str = 'j5e6f7g8h9i0'
down_revision: Union[str, Sequence[str], None] = 'i4d5e6f7g8h9'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Relax single-receipt constraint on the parent transfer
    op.alter_column('inventory_transfers', 'receipt_id', existing_type=sa.String(length=50), nullable=True)

    # Void columns on the parent transfer
    op.add_column('inventory_transfers', sa.Column('voided_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('inventory_transfers', sa.Column('voided_by', sa.String(length=50), nullable=True))
    op.add_column('inventory_transfers', sa.Column('voided_reason', sa.Text(), nullable=True))
    op.create_foreign_key(
        'fk_inventory_transfers_voided_by_users',
        'inventory_transfers', 'users',
        ['voided_by'], ['id'],
    )

    # Per-product/per-receipt line items within a ship-out order
    op.create_table(
        'inventory_transfer_lines',
        sa.Column('id', sa.String(length=50), primary_key=True),
        sa.Column('transfer_id', sa.String(length=50), sa.ForeignKey('inventory_transfers.id', ondelete='CASCADE'), nullable=False),
        sa.Column('product_id', sa.String(length=50), sa.ForeignKey('products.id'), nullable=False),
        sa.Column('receipt_id', sa.String(length=50), sa.ForeignKey('receipts.id'), nullable=False),
        sa.Column('cases_requested', sa.Float(), nullable=False),
        sa.Column('cases_picked', sa.Float(), nullable=False, server_default='0'),
        sa.Column('pallet_licence_ids', sa.JSON(), nullable=True),
        sa.Column('line_seq', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint('transfer_id', 'product_id', 'receipt_id', name='uq_transfer_lines_tprid'),
    )
    op.create_index('ix_inventory_transfer_lines_transfer_id', 'inventory_transfer_lines', ['transfer_id'])
    op.create_index('ix_inventory_transfer_lines_product_id', 'inventory_transfer_lines', ['product_id'])
    op.create_index('ix_inventory_transfer_lines_receipt_id', 'inventory_transfer_lines', ['receipt_id'])

    # Pallet swap audit (forklift on-the-fly OR warehouse edit)
    op.create_table(
        'transfer_pallet_swaps',
        sa.Column('id', sa.String(length=50), primary_key=True),
        sa.Column('transfer_id', sa.String(length=50), sa.ForeignKey('inventory_transfers.id', ondelete='CASCADE'), nullable=False),
        sa.Column('transfer_line_id', sa.String(length=50), sa.ForeignKey('inventory_transfer_lines.id', ondelete='CASCADE'), nullable=True),
        sa.Column('removed_pallet_id', sa.String(length=50), sa.ForeignKey('pallet_licences.id'), nullable=True),
        sa.Column('added_pallet_id', sa.String(length=50), sa.ForeignKey('pallet_licences.id'), nullable=True),
        sa.Column('swapped_by', sa.String(length=50), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('swapped_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('reason', sa.Text(), nullable=True),
        sa.Column('source', sa.String(length=20), nullable=False, server_default='forklift'),
    )
    op.create_index('ix_transfer_pallet_swaps_transfer_id', 'transfer_pallet_swaps', ['transfer_id'])
    op.create_index('ix_transfer_pallet_swaps_line_id', 'transfer_pallet_swaps', ['transfer_line_id'])


def downgrade() -> None:
    # Forward-only past the first multi-product submit. The drop will fail if any
    # inventory_transfers row has receipt_id NULL — that's intentional, so the
    # data isn't silently lost.
    op.drop_index('ix_transfer_pallet_swaps_line_id', table_name='transfer_pallet_swaps')
    op.drop_index('ix_transfer_pallet_swaps_transfer_id', table_name='transfer_pallet_swaps')
    op.drop_table('transfer_pallet_swaps')

    op.drop_index('ix_inventory_transfer_lines_receipt_id', table_name='inventory_transfer_lines')
    op.drop_index('ix_inventory_transfer_lines_product_id', table_name='inventory_transfer_lines')
    op.drop_index('ix_inventory_transfer_lines_transfer_id', table_name='inventory_transfer_lines')
    op.drop_table('inventory_transfer_lines')

    op.drop_constraint('fk_inventory_transfers_voided_by_users', 'inventory_transfers', type_='foreignkey')
    op.drop_column('inventory_transfers', 'voided_reason')
    op.drop_column('inventory_transfers', 'voided_by')
    op.drop_column('inventory_transfers', 'voided_at')

    op.alter_column('inventory_transfers', 'receipt_id', existing_type=sa.String(length=50), nullable=False)
