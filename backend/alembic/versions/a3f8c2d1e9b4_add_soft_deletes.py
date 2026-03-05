"""add soft deletes to receipts, adjustments, hold_actions, pallet_licences

Revision ID: a3f8c2d1e9b4
Revises: 6178999f0cff
Create Date: 2026-02-26

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision: str = "a3f8c2d1e9b4"
down_revision: Union[str, Sequence[str], None] = "6178999f0cff"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # receipts
    op.add_column("receipts", sa.Column("is_deleted", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("receipts", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("receipts", sa.Column("deleted_by_id", sa.String(50), sa.ForeignKey("users.id"), nullable=True))

    # inventory_adjustments
    op.add_column("inventory_adjustments", sa.Column("is_deleted", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("inventory_adjustments", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("inventory_adjustments", sa.Column("deleted_by_id", sa.String(50), sa.ForeignKey("users.id"), nullable=True))

    # inventory_hold_actions
    op.add_column("inventory_hold_actions", sa.Column("is_deleted", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("inventory_hold_actions", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("inventory_hold_actions", sa.Column("deleted_by_id", sa.String(50), sa.ForeignKey("users.id"), nullable=True))

    # pallet_licences
    op.add_column("pallet_licences", sa.Column("is_deleted", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("pallet_licences", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("pallet_licences", sa.Column("deleted_by_id", sa.String(50), sa.ForeignKey("users.id"), nullable=True))


def downgrade() -> None:
    # pallet_licences
    op.drop_column("pallet_licences", "deleted_by_id")
    op.drop_column("pallet_licences", "deleted_at")
    op.drop_column("pallet_licences", "is_deleted")

    # inventory_hold_actions
    op.drop_column("inventory_hold_actions", "deleted_by_id")
    op.drop_column("inventory_hold_actions", "deleted_at")
    op.drop_column("inventory_hold_actions", "is_deleted")

    # inventory_adjustments
    op.drop_column("inventory_adjustments", "deleted_by_id")
    op.drop_column("inventory_adjustments", "deleted_at")
    op.drop_column("inventory_adjustments", "is_deleted")

    # receipts
    op.drop_column("receipts", "deleted_by_id")
    op.drop_column("receipts", "deleted_at")
    op.drop_column("receipts", "is_deleted")
