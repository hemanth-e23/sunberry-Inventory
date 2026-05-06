"""active_line_production + production_lines.warehouse_id

Revision ID: 4a1c8e2b9d77
Revises: 33f4ab41ca55
Create Date: 2026-05-05

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4a1c8e2b9d77'
down_revision: Union[str, Sequence[str], None] = '33f4ab41ca55'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add warehouse_id to production_lines + create active_line_production."""

    # 1. Add warehouse_id column to production_lines (nullable for backfill)
    op.add_column(
        'production_lines',
        sa.Column('warehouse_id', sa.String(length=50), nullable=True),
    )
    op.create_index(
        'ix_production_lines_warehouse_id',
        'production_lines',
        ['warehouse_id'],
    )
    op.create_foreign_key(
        'fk_production_lines_warehouse_id',
        'production_lines',
        'warehouses',
        ['warehouse_id'],
        ['id'],
    )

    # 2. Backfill: assign every existing production_line to the first existing warehouse.
    #    Single-plant install today; multi-plant deployments will reassign manually.
    op.execute(
        """
        UPDATE production_lines
        SET warehouse_id = (SELECT id FROM warehouses ORDER BY created_at LIMIT 1)
        WHERE warehouse_id IS NULL
        """
    )

    # 3. Unique (warehouse_id, name) so line names can repeat across plants
    op.create_unique_constraint(
        'uq_production_line_warehouse_name',
        'production_lines',
        ['warehouse_id', 'name'],
    )

    # 4. Create active_line_production table
    op.create_table(
        'active_line_production',
        sa.Column('id', sa.String(length=50), primary_key=True),
        sa.Column('line_id', sa.String(length=50), nullable=False),
        sa.Column('product_id', sa.String(length=50), nullable=False),
        sa.Column('lot_number', sa.String(length=100), nullable=False),
        sa.Column('last_printed_seq', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('set_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('set_by_user_id', sa.String(length=50), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(['line_id'], ['production_lines.id']),
        sa.ForeignKeyConstraint(['product_id'], ['products.id']),
        sa.ForeignKeyConstraint(['set_by_user_id'], ['users.id']),
    )
    op.create_index(
        'ix_active_line_production_line_id',
        'active_line_production',
        ['line_id'],
    )

    # 5. Unique partial index — at most one active row per line
    op.create_index(
        'uq_active_line_production_one_active',
        'active_line_production',
        ['line_id'],
        unique=True,
        postgresql_where=sa.text('is_active = true'),
    )


def downgrade() -> None:
    """Reverse the upgrade."""
    op.drop_index('uq_active_line_production_one_active', table_name='active_line_production')
    op.drop_index('ix_active_line_production_line_id', table_name='active_line_production')
    op.drop_table('active_line_production')

    op.drop_constraint(
        'uq_production_line_warehouse_name',
        'production_lines',
        type_='unique',
    )
    op.drop_constraint(
        'fk_production_lines_warehouse_id',
        'production_lines',
        type_='foreignkey',
    )
    op.drop_index('ix_production_lines_warehouse_id', table_name='production_lines')
    op.drop_column('production_lines', 'warehouse_id')
