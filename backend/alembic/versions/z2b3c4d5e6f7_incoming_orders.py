"""incoming orders on ingredient_intakes + lot/receipt links on intake_lots

Revision ID: z2b3c4d5e6f7
Revises: z1a2b3c4d5e6
Create Date: 2026-08-17

Phase 2 of the lot-level ingredient model. Purely additive: eleven nullable
columns across two existing tables, and no data is touched.

WHY THE EXISTING TABLES ARE REUSED. `ingredient_intakes` already had everything a
corporate incoming order needs — a vendor, a BOL, a PO, multi-product lot lines
with expected counts, a short count with its reason, and an approval trail.
Building a second table would have reproduced those columns and their bugs.
`status` now carries IncomingOrderStatus for rows with is_incoming_order set and
IntakeStatus for rows from the retired per-drum flow; the two vocabularies do not
overlap, so old rows keep reading correctly.

WHY THE GUARDS. `Base.metadata.create_all` runs at app import (backend/main.py),
so on any box where the app has started since these models landed the columns
already exist. `entrypoint.sh` then runs `alembic upgrade head` under `set -e`
BEFORE the app starts, so an unguarded ALTER against an existing column raises
DuplicateColumn, fails the entrypoint and crash-loops the container mid-shift.
"""
from alembic import op
import sqlalchemy as sa


revision = "z2b3c4d5e6f7"
down_revision = "z1a2b3c4d5e6"
branch_labels = None
depends_on = None


def _tables(bind):
    return set(sa.inspect(bind).get_table_names())


def _columns(bind, table):
    return {c["name"] for c in sa.inspect(bind).get_columns(table)}


def _index_names(bind, table):
    return {i["name"] for i in sa.inspect(bind).get_indexes(table)}


def _fk_names_on(bind, table, column):
    """FK constraint names touching `column`, whatever they happen to be called.

    Applying this migration names them `fk_*`; letting create_all build the schema
    instead has SQLAlchemy name them `<table>_<column>_fkey`. Both states exist in
    the wild for the reason in the module docstring, so downgrade looks the name
    up rather than assuming one.
    """
    return {
        fk["name"]
        for fk in sa.inspect(bind).get_foreign_keys(table)
        if fk.get("name") and column in (fk.get("constrained_columns") or [])
    }


def upgrade():
    bind = op.get_bind()
    existing = _tables(bind)

    # ── ingredient_intakes -> also the corporate incoming order ──────────────
    if "ingredient_intakes" in existing:
        cols = _columns(bind, "ingredient_intakes")

        if "is_incoming_order" not in cols:
            op.add_column(
                "ingredient_intakes",
                sa.Column(
                    "is_incoming_order", sa.Boolean(),
                    nullable=False, server_default="false",
                ),
            )
            op.create_index(
                "ix_ingredient_intakes_is_incoming_order",
                "ingredient_intakes", ["is_incoming_order"],
            )
        if "origin_name" not in cols:
            op.add_column(
                "ingredient_intakes", sa.Column("origin_name", sa.String(120), nullable=True)
            )
        if "origin_warehouse_id" not in cols:
            op.add_column(
                "ingredient_intakes",
                sa.Column("origin_warehouse_id", sa.String(50), nullable=True),
            )
            op.create_foreign_key(
                "fk_ingredient_intakes_origin_warehouse_id",
                "ingredient_intakes", "warehouses",
                ["origin_warehouse_id"], ["id"],
            )
        if "expected_date" not in cols:
            op.add_column(
                "ingredient_intakes",
                sa.Column("expected_date", sa.DateTime(timezone=True), nullable=True),
            )
            op.create_index(
                "ix_ingredient_intakes_expected_date",
                "ingredient_intakes", ["expected_date"],
            )
        if "released_at" not in cols:
            op.add_column(
                "ingredient_intakes",
                sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
            )
        if "released_by" not in cols:
            op.add_column(
                "ingredient_intakes", sa.Column("released_by", sa.String(50), nullable=True)
            )
            op.create_foreign_key(
                "fk_ingredient_intakes_released_by",
                "ingredient_intakes", "users", ["released_by"], ["id"],
            )
        if "closed_at" not in cols:
            op.add_column(
                "ingredient_intakes",
                sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
            )
        if "closed_by" not in cols:
            op.add_column(
                "ingredient_intakes", sa.Column("closed_by", sa.String(50), nullable=True)
            )
            op.create_foreign_key(
                "fk_ingredient_intakes_closed_by",
                "ingredient_intakes", "users", ["closed_by"], ["id"],
            )
        if "close_reason" not in cols:
            op.add_column(
                "ingredient_intakes", sa.Column("close_reason", sa.Text(), nullable=True)
            )

    # ── intake_lots -> also the incoming order line ──────────────────────────
    if "intake_lots" in existing:
        cols = _columns(bind, "intake_lots")

        if "material_lot_id" not in cols:
            op.add_column(
                "intake_lots", sa.Column("material_lot_id", sa.String(50), nullable=True)
            )
            op.create_index(
                "ix_intake_lots_material_lot_id", "intake_lots", ["material_lot_id"]
            )
            op.create_foreign_key(
                "fk_intake_lots_material_lot_id",
                "intake_lots", "material_lots", ["material_lot_id"], ["id"],
            )
        if "receipt_id" not in cols:
            op.add_column(
                "intake_lots", sa.Column("receipt_id", sa.String(50), nullable=True)
            )
            op.create_index("ix_intake_lots_receipt_id", "intake_lots", ["receipt_id"])
            op.create_foreign_key(
                "fk_intake_lots_receipt_id",
                "intake_lots", "receipts", ["receipt_id"], ["id"],
            )
        if "vendor_id" not in cols:
            op.add_column(
                "intake_lots", sa.Column("vendor_id", sa.String(50), nullable=True)
            )
            op.create_foreign_key(
                "fk_intake_lots_vendor_id", "intake_lots", "vendors", ["vendor_id"], ["id"],
            )

    # Order numbers come from a sequence rather than MAX()+1, which races exactly
    # when two people are creating orders at once.
    op.execute("CREATE SEQUENCE IF NOT EXISTS incoming_order_seq")
    # Minted by lot_placement_service._next_lot_code. Created here too so a fresh
    # deploy does not depend on the first print to create it.
    op.execute("CREATE SEQUENCE IF NOT EXISTS material_lot_code_seq")


def downgrade():
    bind = op.get_bind()
    existing = _tables(bind)

    if "intake_lots" in existing:
        cols = _columns(bind, "intake_lots")
        for column, index in (
            ("vendor_id", None),
            ("receipt_id", "ix_intake_lots_receipt_id"),
            ("material_lot_id", "ix_intake_lots_material_lot_id"),
        ):
            if column not in cols:
                continue
            if index and index in _index_names(bind, "intake_lots"):
                op.drop_index(index, table_name="intake_lots")
            for name in _fk_names_on(bind, "intake_lots", column):
                op.drop_constraint(name, "intake_lots", type_="foreignkey")
            op.drop_column("intake_lots", column)

    if "ingredient_intakes" in existing:
        cols = _columns(bind, "ingredient_intakes")
        for column, index in (
            ("close_reason", None),
            ("closed_by", None),
            ("closed_at", None),
            ("released_by", None),
            ("released_at", None),
            ("expected_date", "ix_ingredient_intakes_expected_date"),
            ("origin_warehouse_id", None),
            ("origin_name", None),
            ("is_incoming_order", "ix_ingredient_intakes_is_incoming_order"),
        ):
            if column not in cols:
                continue
            if index and index in _index_names(bind, "ingredient_intakes"):
                op.drop_index(index, table_name="ingredient_intakes")
            for name in _fk_names_on(bind, "ingredient_intakes", column):
                op.drop_constraint(name, "ingredient_intakes", type_="foreignkey")
            op.drop_column("ingredient_intakes", column)

    # NEITHER sequence is dropped, for the same reason.
    #
    # The downgrade removes columns; it deletes no rows. So the IN-###### numbers
    # already minted stay behind in `ingredient_intakes.intake_number`, which is
    # UNIQUE. Dropping the sequence restarts it at 1, and the first order created
    # after a re-upgrade collides — and keeps colliding until the counter walks
    # past every number ever issued. Lot codes are worse still: they are printed
    # on drums sitting in the barn, so a restarted counter would mint a code that
    # is already on a physical sticker.
