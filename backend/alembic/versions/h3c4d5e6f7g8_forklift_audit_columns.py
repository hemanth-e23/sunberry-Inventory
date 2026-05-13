"""forklift_requests: audit + activity tracking columns

Revision ID: h3c4d5e6f7g8
Revises: g2b3c4d5e6f7
Create Date: 2026-05-13

Adds columns so that no forklift scan session can be silently lost:
- last_activity_at: drives the 3h auto-submit window
- auto_submitted_at: flags when the system auto-submitted (vs user submitted)
- cancelled_at / cancelled_by / cancelled_reason: audit for empty-session auto-cancel
- rejected_at / rejected_by: audit for supervisor rejection
"""
from typing import Union, Sequence
from alembic import op
import sqlalchemy as sa


revision: str = 'h3c4d5e6f7g8'
down_revision: Union[str, Sequence[str], None] = 'g2b3c4d5e6f7'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('forklift_requests', sa.Column('last_activity_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('forklift_requests', sa.Column('auto_submitted_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('forklift_requests', sa.Column('cancelled_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('forklift_requests', sa.Column('cancelled_by', sa.String(length=50), nullable=True))
    op.add_column('forklift_requests', sa.Column('cancelled_reason', sa.String(length=100), nullable=True))
    op.add_column('forklift_requests', sa.Column('rejected_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('forklift_requests', sa.Column('rejected_by', sa.String(length=50), nullable=True))

    op.create_foreign_key(
        'fk_forklift_requests_cancelled_by_users',
        'forklift_requests', 'users',
        ['cancelled_by'], ['id'],
    )
    op.create_foreign_key(
        'fk_forklift_requests_rejected_by_users',
        'forklift_requests', 'users',
        ['rejected_by'], ['id'],
    )

    # Backfill last_activity_at so existing rows have a sane value for the auto-submit sweep.
    # Use submitted_at if present, otherwise approved_at, otherwise created_at.
    op.execute("""
        UPDATE forklift_requests
        SET last_activity_at = COALESCE(submitted_at, approved_at, created_at)
        WHERE last_activity_at IS NULL
    """)


def downgrade() -> None:
    op.drop_constraint('fk_forklift_requests_rejected_by_users', 'forklift_requests', type_='foreignkey')
    op.drop_constraint('fk_forklift_requests_cancelled_by_users', 'forklift_requests', type_='foreignkey')
    op.drop_column('forklift_requests', 'rejected_by')
    op.drop_column('forklift_requests', 'rejected_at')
    op.drop_column('forklift_requests', 'cancelled_reason')
    op.drop_column('forklift_requests', 'cancelled_by')
    op.drop_column('forklift_requests', 'cancelled_at')
    op.drop_column('forklift_requests', 'auto_submitted_at')
    op.drop_column('forklift_requests', 'last_activity_at')
