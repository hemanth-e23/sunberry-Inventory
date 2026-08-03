"""staging line claims + serialized container pulls

Revision ID: w8x9y0z1a2b3
Revises: v7w8x9y0z1a2
Create Date: 2026-08-03

Two changes for INGREDIENT-SERIALIZATION-SPEC.md §11:

1. staging_request_items gains claimed_by / claimed_at, so three workers can
   split one request without double-pulling.
2. staging_line_containers records which serialized containers were pulled
   against which line, replacing the staging_item_ids Text blob for serialized
   ingredients. A comma-joined string cannot be joined, filtered or counted,
   which is how "which drum went into which batch" became unanswerable.

GUARDS ARE NOT OPTIONAL HERE. `staging_request_items` has NO alembic history at
all — `grep -rn "staging_request" backend/alembic/` returns nothing — because it
was only ever created by Base.metadata.create_all at app import
(backend/main.py:29). So on every existing environment the table is present but
alembic has never touched it, and on a developer box the new column may ALSO
already exist for the same reason. entrypoint.sh runs `alembic upgrade head`
under `set -e` before the app starts, so an unguarded ALTER or CREATE here would
crash-loop the container rather than fail politely.
"""
from alembic import op
import sqlalchemy as sa


revision = "w8x9y0z1a2b3"
down_revision = "v7w8x9y0z1a2"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "staging_request_items" in tables:
        columns = {c["name"] for c in inspector.get_columns("staging_request_items")}
        if "claimed_by" not in columns:
            op.add_column(
                "staging_request_items",
                sa.Column("claimed_by", sa.String(length=50), nullable=True),
            )
            op.create_foreign_key(
                "fk_staging_request_items_claimed_by",
                "staging_request_items", "users",
                ["claimed_by"], ["id"],
            )
            op.create_index(
                "ix_staging_request_items_claimed_by",
                "staging_request_items", ["claimed_by"],
            )
        if "claimed_at" not in columns:
            op.add_column(
                "staging_request_items",
                sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
            )

    if "staging_line_containers" not in tables:
        op.create_table(
            "staging_line_containers",
            sa.Column("id", sa.String(length=50), nullable=False),
            sa.Column("request_item_id", sa.String(length=50), nullable=False),
            sa.Column("container_id", sa.String(length=50), nullable=False),
            sa.Column("serial", sa.String(length=100), nullable=False),
            sa.Column("qty_pulled", sa.Float(), nullable=True),
            sa.Column("qty_unit", sa.String(length=20), nullable=True),
            sa.Column("status", sa.String(length=20), server_default="staged", nullable=False),
            sa.Column("returned_to_row_id", sa.String(length=50), nullable=True),
            sa.Column("returned_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("returned_by", sa.String(length=50), nullable=True),
            sa.Column("off_list", sa.Boolean(), server_default="false", nullable=False),
            sa.Column("off_list_reason", sa.Text(), nullable=True),
            sa.Column("scanned_by", sa.String(length=50), nullable=True),
            sa.Column("scanned_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
            sa.ForeignKeyConstraint(["request_item_id"], ["staging_request_items.id"]),
            sa.ForeignKeyConstraint(["container_id"], ["containers.id"]),
            sa.ForeignKeyConstraint(["returned_to_row_id"], ["storage_rows.id"]),
            sa.ForeignKeyConstraint(["returned_by"], ["users.id"]),
            sa.ForeignKeyConstraint(["scanned_by"], ["users.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_staging_line_containers_request_item_id", "staging_line_containers", ["request_item_id"])
        op.create_index("ix_staging_line_containers_container_id", "staging_line_containers", ["container_id"])
        op.create_index("ix_staging_line_containers_serial", "staging_line_containers", ["serial"])


def downgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "staging_line_containers" in tables:
        op.drop_table("staging_line_containers")

    if "staging_request_items" in tables:
        columns = {c["name"] for c in inspector.get_columns("staging_request_items")}
        if "claimed_at" in columns:
            op.drop_column("staging_request_items", "claimed_at")
        if "claimed_by" in columns:
            op.drop_constraint(
                "fk_staging_request_items_claimed_by",
                "staging_request_items", type_="foreignkey",
            )
            op.drop_index("ix_staging_request_items_claimed_by", table_name="staging_request_items")
            op.drop_column("staging_request_items", "claimed_by")
