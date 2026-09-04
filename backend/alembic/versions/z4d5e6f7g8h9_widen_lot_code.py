"""widen lot_code: the sticker code is now the whole natural key

Revision ID: z4d5e6f7g8h9
Revises: z3c4d5e6f7g8
Create Date: 2026-08-25

The printed code carried an invented sequence (`L0000004`) and needed only 30
characters. It now carries the whole natural key —
`SID.VENDOR.THEIRLOT.BBD` — so that no marker, counter or truncation is needed
to guarantee uniqueness: the four facts are unique by construction.

Length stopped mattering because nothing reads the code. A scanner is
indifferent to it, and the label's big text shows the vendor's own lot number,
which is what a person on a dock recognises.

Inspector-guarded like its siblings: `create_all` runs at app import, so the
column may already be wide, and `entrypoint.sh` runs `alembic upgrade head`
under `set -e` before the app starts.
"""
from alembic import op
import sqlalchemy as sa


revision = "z4d5e6f7g8h9"
down_revision = "z3c4d5e6f7g8"
branch_labels = None
depends_on = None


def _lot_code_width(bind):
    for c in sa.inspect(bind).get_columns("material_lots"):
        if c["name"] == "lot_code":
            return getattr(c["type"], "length", None)
    return None


def upgrade():
    bind = op.get_bind()
    if "material_lots" not in set(sa.inspect(bind).get_table_names()):
        return
    if (_lot_code_width(bind) or 0) < 160:
        op.alter_column(
            "material_lots", "lot_code",
            existing_type=sa.String(30), type_=sa.String(160),
            existing_nullable=False,
        )


def downgrade():
    # NOT narrowed back. Codes minted under the wider column are already printed
    # on drums, and truncating them to 30 characters would silently break every
    # sticker in the barn. A no-op is the honest downgrade here.
    pass
