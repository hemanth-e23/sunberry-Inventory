"""expected_time on incoming orders

Revision ID: z3c4d5e6f7g8
Revises: z2b3c4d5e6f7
Create Date: 2026-08-21

One nullable column. The arrival slot is agreed with the carrier AFTER the
order is raised, so it is set at release rather than at creation, and it is
split date/time to mirror InventoryTransfer.scheduled_date + appointment_time
on the outbound side — both halves of the Shipping screen then sort and filter
the same way.

Inspector-guarded like its siblings: `create_all` runs at app import, so the
column may already exist, and `entrypoint.sh` runs `alembic upgrade head` under
`set -e` before the app starts — an unguarded ALTER crash-loops the container.
"""
from alembic import op
import sqlalchemy as sa


revision = "z3c4d5e6f7g8"
down_revision = "z2b3c4d5e6f7"
branch_labels = None
depends_on = None


def _columns(bind, table):
    return {c["name"] for c in sa.inspect(bind).get_columns(table)}


def upgrade():
    bind = op.get_bind()
    if "ingredient_intakes" in set(sa.inspect(bind).get_table_names()):
        if "expected_time" not in _columns(bind, "ingredient_intakes"):
            op.add_column(
                "ingredient_intakes",
                sa.Column("expected_time", sa.String(20), nullable=True),
            )


def downgrade():
    bind = op.get_bind()
    if "ingredient_intakes" in set(sa.inspect(bind).get_table_names()):
        if "expected_time" in _columns(bind, "ingredient_intakes"):
            op.drop_column("ingredient_intakes", "expected_time")
