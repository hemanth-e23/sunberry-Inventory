"""Truck receiving — one gun session per incoming order, not per lot line

A truck carries several lots, mixed on the trailer. Receiving it one line at a
time meant the worker picked a lot and walked round the trailer hunting for that
lot's drums; a drum from another lot was booked against the wrong receipt.

The truck is now the unit of work: the worker scans a rack and then any drum on
the trailer, and the server routes each drum to its own line by the lot on the
sticker. Each line still keeps its own receipt and lot underneath.

  * ingredient_intakes.forklift_submitted_at / _by — the worker finishing the
    whole truck. Takes it off the gun.
  * ingredient_intakes.short_reason (existing column, from the per-drum
    intake flow) now also carries why a truck was finished short.
  * receiving_flags — what the office should look at before approving: drums
    from lots not on the truck, over the paperwork, held lots, over-full racks,
    rack recount results, short reasons. Append-only.

Backfill is deliberately empty: no existing truck has flags, and every open one
is treated as still being received.

Revision ID: e0f1a2b3c4d5
Revises: d9e0f1a2b3c4
"""
from alembic import op
import sqlalchemy as sa


revision = 'e0f1a2b3c4d5'
down_revision = 'd9e0f1a2b3c4'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('ingredient_intakes', sa.Column('forklift_submitted_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('ingredient_intakes', sa.Column('forklift_submitted_by', sa.String(length=50), nullable=True))
    op.create_foreign_key(
        'fk_ingredient_intakes_forklift_submitted_by_users',
        'ingredient_intakes', 'users',
        ['forklift_submitted_by'], ['id'],
    )

    op.create_table(
        'receiving_flags',
        sa.Column('id', sa.String(length=50), primary_key=True),
        sa.Column('order_id', sa.String(length=50), sa.ForeignKey('ingredient_intakes.id'), nullable=False),
        sa.Column('line_id', sa.String(length=50), sa.ForeignKey('intake_lots.id'), nullable=True),
        sa.Column('receipt_id', sa.String(length=50), sa.ForeignKey('receipts.id'), nullable=True),
        sa.Column('material_lot_id', sa.String(length=50), sa.ForeignKey('material_lots.id'), nullable=True),
        sa.Column('storage_row_id', sa.String(length=50), sa.ForeignKey('storage_rows.id'), nullable=True),
        sa.Column('kind', sa.String(length=30), nullable=False),
        sa.Column('expected', sa.Integer(), nullable=True),
        sa.Column('actual', sa.Integer(), nullable=True),
        sa.Column('detail', sa.Text(), nullable=True),
        sa.Column('event_seq', sa.BigInteger(), nullable=True),
        sa.Column('actor_id', sa.String(length=50), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index('ix_receiving_flags_order_id', 'receiving_flags', ['order_id'])
    op.create_index('ix_receiving_flags_receipt_id', 'receiving_flags', ['receipt_id'])


def downgrade():
    op.drop_index('ix_receiving_flags_receipt_id', table_name='receiving_flags')
    op.drop_index('ix_receiving_flags_order_id', table_name='receiving_flags')
    op.drop_table('receiving_flags')
    op.drop_constraint('fk_ingredient_intakes_forklift_submitted_by_users', 'ingredient_intakes', type_='foreignkey')
    op.drop_column('ingredient_intakes', 'forklift_submitted_by')
    op.drop_column('ingredient_intakes', 'forklift_submitted_at')
