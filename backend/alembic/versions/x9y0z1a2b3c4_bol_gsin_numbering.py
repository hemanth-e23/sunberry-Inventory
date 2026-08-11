"""BOL numbers become GSINs: reseed the sequence and enforce uniqueness

The BOL number was rendered as a bare counter ("001", "002"). It is actually a
GSIN — a GS1 shipment identifier that carriers and customers read — and the
legacy SQL Server system had been issuing them in that format for years.

Two changes here:

1. Reseed `bol_number_seq` to 6000. The legacy system was at serial 3615 on
   2026-08-07 and stays live for a few more days while it is retired; starting
   at 6000 leaves a gap so the two systems cannot hand the same GSIN to two
   different shipments. At ~50 BOLs/day that gap is roughly four weeks of the
   legacy system's output, which is well past its planned shutdown.

2. A unique index on `bol_number`. Nothing previously stopped two shipments
   carrying the same number — the sequence was the only thing keeping them
   apart, and a sequence can be reseeded wrongly, re-run, or restored from a
   backup. A duplicate shipment identifier on a signed bill of lading is not
   recoverable after the fact, so the database now refuses it.

The handful of already-issued short numbers ("001"...) are left alone: they are
on documents that have already shipped, and rewriting history on a legal record
is worse than an inconsistent-looking series.

Revision ID: x9y0z1a2b3c4
Revises: w8x9y0z1a2b3
"""
from alembic import op
import sqlalchemy as sa


revision = 'x9y0z1a2b3c4'
down_revision = 'w8x9y0z1a2b3'
branch_labels = None
depends_on = None

# One clear of the legacy system's high-water mark (3615 on 2026-08-07).
BOL_SEQUENCE_START = 6000


def upgrade():
    conn = op.get_bind()

    # Fail with a readable message rather than a raw constraint violation if the
    # data cannot support the index. A crash-looping container over a cryptic
    # error is a worse morning than a sentence explaining what to fix.
    dupes = conn.execute(sa.text("""
        SELECT bol_number, COUNT(*) AS n
        FROM inventory_transfers
        WHERE bol_number IS NOT NULL
        GROUP BY bol_number HAVING COUNT(*) > 1
    """)).fetchall()
    if dupes:
        listed = ", ".join(f"{r[0]} x{r[1]}" for r in dupes)
        raise RuntimeError(
            "Cannot add the unique BOL index — these numbers are already "
            f"duplicated and must be corrected first: {listed}"
        )

    op.create_index(
        'uq_inventory_transfers_bol_number',
        'inventory_transfers', ['bol_number'],
        unique=True,
        postgresql_where=sa.text('bol_number IS NOT NULL'),
    )

    # is_called=false so the NEXT nextval() returns exactly BOL_SEQUENCE_START.
    # GREATEST guards a re-run (or a restore that already advanced past it) from
    # walking the sequence backwards and re-issuing numbers.
    conn.execute(sa.text("""
        SELECT setval(
            'bol_number_seq',
            GREATEST(:start, (SELECT last_value FROM bol_number_seq)),
            false
        )
    """), {"start": BOL_SEQUENCE_START})


def downgrade():
    op.drop_index('uq_inventory_transfers_bol_number', table_name='inventory_transfers')
    # The sequence is deliberately NOT rewound: numbers it has already issued
    # are on printed documents and must never be handed out a second time.
