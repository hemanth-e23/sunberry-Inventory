"""add truck_license (tractor license plate) to inventory_transfers

Revision ID: t5u6v7w8x9y0
Revises: s4t5u6v7w8x9
Create Date: 2026-07-10

Yard check-in captures the tractor/truck license plate alongside the trailer
plate for the BOL carrier-validation stamp.
"""
from alembic import op
import sqlalchemy as sa


revision = "t5u6v7w8x9y0"
down_revision = "s4t5u6v7w8x9"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("inventory_transfers", sa.Column("truck_license", sa.String(length=50), nullable=True))


def downgrade():
    op.drop_column("inventory_transfers", "truck_license")
