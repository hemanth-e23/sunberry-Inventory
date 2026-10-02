"""Lot count requests — counts by warehouse users wait for a supervisor

Counts restated stock the moment anyone entered them (browser test PART 4,
2026-10-02). A warehouse user's recount / "found" entry is now stored here as
pending until a supervisor approves it; a supervisor's count applies at once.

Revision ID: a1b2c3d4e5f6
Revises: f7a8b9c0d1e2
"""
from alembic import op
import sqlalchemy as sa


revision = 'a1b2c3d4e5f6'
down_revision = 'f7a8b9c0d1e2'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'lot_count_requests',
        sa.Column('id', sa.String(length=50), primary_key=True),
        sa.Column('kind', sa.String(length=20), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False, server_default='pending'),
        sa.Column('warehouse_id', sa.String(length=50), sa.ForeignKey('warehouses.id'), nullable=True),
        sa.Column('material_lot_id', sa.String(length=50), sa.ForeignKey('material_lots.id'), nullable=True),
        sa.Column('storage_row_id', sa.String(length=50), sa.ForeignKey('storage_rows.id'), nullable=False),
        sa.Column('product_id', sa.String(length=50), sa.ForeignKey('products.id'), nullable=True),
        sa.Column('vendor_id', sa.String(length=50), nullable=True),
        sa.Column('vendor_lot', sa.String(length=100), nullable=True),
        sa.Column('bbd', sa.DateTime(timezone=True), nullable=True),
        sa.Column('unit_label', sa.String(length=20), nullable=True),
        sa.Column('weight_per_unit', sa.Float(), nullable=True),
        sa.Column('weight_unit', sa.String(length=10), nullable=True),
        sa.Column('full_units', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('open_units', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('open_remaining_qty', sa.Float(), nullable=False, server_default='0'),
        sa.Column('system_full_units', sa.Integer(), nullable=True),
        sa.Column('system_open_units', sa.Integer(), nullable=True),
        sa.Column('system_open_qty', sa.Float(), nullable=True),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('submitted_by', sa.String(length=50), nullable=True),
        sa.Column('submitted_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('approved_by', sa.String(length=50), nullable=True),
        sa.Column('approved_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('rejection_reason', sa.Text(), nullable=True),
    )
    op.create_index('ix_lot_count_requests_warehouse_id', 'lot_count_requests', ['warehouse_id'])
    op.create_index('ix_lot_count_requests_material_lot_id', 'lot_count_requests', ['material_lot_id'])


def downgrade():
    op.drop_index('ix_lot_count_requests_material_lot_id', table_name='lot_count_requests')
    op.drop_index('ix_lot_count_requests_warehouse_id', table_name='lot_count_requests')
    op.drop_table('lot_count_requests')
