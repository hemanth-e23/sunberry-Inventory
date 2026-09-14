"""receipts.forklift_submitted_at / _by — letting a worker close a receiving line

A receiving session stays on the gun while its receipt is `recorded` or
`reviewed` and its order is open. There is deliberately NO "scanned >= expected"
filter: over-receiving is legal, and hiding a line the moment it hit the
paperwork count would strand the 81st drum of an expected 80.

The consequence was that a fully-received line never left the gun. A worker who
had counted in all 13 drums still saw the card, with nothing to press to say so,
and no way to tell it apart from a line still waiting for a truck.

These two columns let the worker say it explicitly — the same shape ship-out
already uses (`InventoryTransfer.forklift_submitted_at`). Completion becomes an
action, never an inference, so over- and under-receipts both stay possible and
both get confirmed out loud.

NOT reusing `status`: pending-approval is status in (recorded, reviewed), so
moving the status to clear the gun would also remove the receipt from the office
approvals queue — the check that has to happen next.

NOT reusing `submitted_at`/`submitted_by`: those already mean "who started
receiving", stamped by start_receiving.

Backfill is deliberately empty. Every existing open session is treated as still
in progress, which is the safe reading: a worker seeing a card that should have
gone costs one tap, while auto-closing a line that was never finished loses
drums quietly.

Revision ID: d9e0f1a2b3c4
Revises: c8d9e0f1a2b3
"""
from alembic import op
import sqlalchemy as sa


revision = 'd9e0f1a2b3c4'
down_revision = 'c8d9e0f1a2b3'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('receipts', sa.Column('forklift_submitted_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('receipts', sa.Column('forklift_submitted_by', sa.String(length=50), nullable=True))
    op.create_foreign_key(
        'fk_receipts_forklift_submitted_by_users',
        'receipts', 'users',
        ['forklift_submitted_by'], ['id'],
    )
    # open_sessions filters on this being NULL on every gun poll.
    op.create_index(
        'ix_receipts_forklift_submitted_at',
        'receipts', ['forklift_submitted_at'],
    )


def downgrade():
    op.drop_index('ix_receipts_forklift_submitted_at', table_name='receipts')
    op.drop_constraint('fk_receipts_forklift_submitted_by_users', 'receipts', type_='foreignkey')
    op.drop_column('receipts', 'forklift_submitted_by')
    op.drop_column('receipts', 'forklift_submitted_at')
