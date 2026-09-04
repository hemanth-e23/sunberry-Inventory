"""receipts.units_per_pallet — what makes bags and boxes work

`MaterialLot.units_per_pallet` is the number that tells the system fifty bags
are one pallet. With it, the sticker prints "PALLET OF BAGS" rather than "BAG",
the gun offers "scan once = 50 bags", and stickers print one per pallet. All of
that was already built, and only the corporate check-in path ever collected the
number.

So 500 bags entered through Log Receipt produced a lot that did not know it was
palletised: 500 individual bag stickers, a rack reading 500 pallets against a
capacity of 100, and no scan multiplier.

The value lives on the Receipt as well as on the lot because both readers run
after the entry form is gone — `ensure_lot_for_receipt` when Print is pressed,
which may be days later, and `place_logged_receipt` at approval.

NOT reusing `receipts.cases_per_pallet`: that is a CASES figure with a fallback
of 40 that `row_allocation._cpp` reads on the legacy path, and overloading it
would silently corrupt that arithmetic.

No backfill. Bag and box data is being cleared and re-entered, so this starts
NULL everywhere — which is also the correct value for every barrel.

Revision ID: b7c8d9e0f1a2
Revises: a6b7c8d9e0f1
"""

import sqlalchemy as sa
from alembic import op

revision = "b7c8d9e0f1a2"
down_revision = "a6b7c8d9e0f1"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "receipts", sa.Column("units_per_pallet", sa.Integer(), nullable=True)
    )


def downgrade():
    op.drop_column("receipts", "units_per_pallet")
