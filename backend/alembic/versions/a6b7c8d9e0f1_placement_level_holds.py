"""Quarantine at rack granularity: lot_placements.held_units

A QA hold on raw material did nothing at all. `hold_service` wrote
`receipt.hold`, and for a lot-tracked receipt nothing reads that any more — the
receipt deliberately steps aside from the availability sum so its drums are not
counted twice, once as a legacy quantity and once as placements. So QA could
hold a lot for a positive swab and production could still stage every drum of
it, with no error and no warning.

`MaterialLot.is_held` already existed and availability already honoured it;
nothing had ever written it. That covers the whole-lot case — a bad vendor
certificate makes every drum suspect wherever it sits.

This adds the other real case: eight of the forty on one rack got wet. The lot
is fine, those eight are not. A COUNT rather than a flag, because every drum
wears an identical sticker and there is no way to name which eight — nor any
need to. "Eight of the forty here are quarantined" is checkable by walking to
the rack and counting, which is the entire point of counting them.

Revision ID: a6b7c8d9e0f1
Revises: z5e6f7g8h9i0
"""

import sqlalchemy as sa
from alembic import op

revision = "a6b7c8d9e0f1"
down_revision = "z5e6f7g8h9i0"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "lot_placements",
        sa.Column("held_units", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column("lot_placements", sa.Column("hold_reason", sa.Text(), nullable=True))
    op.add_column("lot_placements", sa.Column("held_by", sa.String(50), nullable=True))
    op.add_column(
        "lot_placements",
        sa.Column("held_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_lot_placements_held_by", "lot_placements", "users", ["held_by"], ["id"]
    )
    op.create_check_constraint(
        "ck_lot_placement_held_units_nonneg", "lot_placements", "held_units >= 0"
    )
    # You cannot quarantine more drums than are on the rack. Enforced in the
    # database because the alternative — trusting every future write path to
    # check — is how `occupied_pallets` reached 501 against a capacity of 22.
    op.create_check_constraint(
        "ck_lot_placement_held_within_full", "lot_placements", "held_units <= full_units"
    )


def downgrade():
    op.drop_constraint("ck_lot_placement_held_within_full", "lot_placements", type_="check")
    op.drop_constraint("ck_lot_placement_held_units_nonneg", "lot_placements", type_="check")
    op.drop_constraint("fk_lot_placements_held_by", "lot_placements", type_="foreignkey")
    op.drop_column("lot_placements", "held_at")
    op.drop_column("lot_placements", "held_by")
    op.drop_column("lot_placements", "hold_reason")
    op.drop_column("lot_placements", "held_units")
