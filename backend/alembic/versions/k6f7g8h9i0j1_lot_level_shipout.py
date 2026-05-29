"""lot-level ship-out: lot allocations, picks, reservations, partial-pallet row

Revision ID: k6f7g8h9i0j1
Revises: j5e6f7g8h9i0
Create Date: 2026-05-26

Switches FG ship-out picking from pallet-level allocation to lot-level
allocation. Warehouse worker now reserves (lot_number, cases) on each line;
the forklift commits specific pallets at scan time. Supports partial pulls
on the last pallet of a line (remainder moves to a designated "Partials"
storage row).

Schema changes:
- inventory_transfer_lines: + lot_allocations, picks, lot_swap_history (JSON)
- ship_out_lot_reservations: new table — soft capacity lock per (product, lot)
- storage_rows: + is_partial_pallet_location (Boolean)

Backfill:
- For every existing line with pallet_licence_ids, derive lot_allocations by
  grouping pallets by lot_number. For lines on orders already in
  forklift_submitted/approved status, also populate picks (cases_consumed =
  pallet.cases, was_partial=False, no scan timestamp since we can't
  reconstruct it). Pending/submitted orders keep picks empty since they
  haven't been scanned yet under either flow.
- No ShipOutLotReservation rows are created for legacy orders — their
  pallets are already in RESERVED status, so capacity is effectively held
  by the pallet itself, not the reservation row. New orders submitted
  after this migration will use reservations.
"""
import json
from typing import Union, Sequence

from alembic import op
import sqlalchemy as sa


revision: str = 'k6f7g8h9i0j1'
down_revision: Union[str, Sequence[str], None] = 'j5e6f7g8h9i0'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── inventory_transfer_lines: new JSON columns ──────────────────────────
    op.add_column(
        'inventory_transfer_lines',
        sa.Column('lot_allocations', sa.JSON(), nullable=True),
    )
    op.add_column(
        'inventory_transfer_lines',
        sa.Column('picks', sa.JSON(), nullable=True),
    )
    op.add_column(
        'inventory_transfer_lines',
        sa.Column('lot_swap_history', sa.JSON(), nullable=True),
    )

    # ── ship_out_lot_reservations: soft capacity lock per (product, lot) ────
    op.create_table(
        'ship_out_lot_reservations',
        sa.Column('id', sa.String(length=50), primary_key=True),
        sa.Column(
            'transfer_line_id',
            sa.String(length=50),
            sa.ForeignKey('inventory_transfer_lines.id', ondelete='CASCADE'),
            nullable=False,
        ),
        sa.Column(
            'product_id',
            sa.String(length=50),
            sa.ForeignKey('products.id'),
            nullable=False,
        ),
        sa.Column('lot_number', sa.String(length=100), nullable=False),
        sa.Column('cases_reserved', sa.Float(), nullable=False),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
        ),
        sa.Column('released_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        'ix_ship_out_lot_reservations_transfer_line_id',
        'ship_out_lot_reservations',
        ['transfer_line_id'],
    )
    # Partial index: only the *active* reservations matter for the capacity
    # check (sum of cases_reserved per product+lot must stay ≤ available).
    op.create_index(
        'ix_ship_out_lot_reservations_active',
        'ship_out_lot_reservations',
        ['product_id', 'lot_number'],
        postgresql_where=sa.text('released_at IS NULL'),
    )

    # ── storage_rows: mark partial-pallet locations ─────────────────────────
    # One row per warehouse is the operational convention; not enforced in
    # schema (a warehouse may want to migrate to a new partial row later
    # without dropping the flag from the old one until empty).
    op.add_column(
        'storage_rows',
        sa.Column(
            'is_partial_pallet_location',
            sa.Boolean(),
            nullable=False,
            server_default='false',
        ),
    )

    # ── backfill ────────────────────────────────────────────────────────────
    _backfill_lot_allocations_and_picks()


def _backfill_lot_allocations_and_picks() -> None:
    """Derive lot_allocations + picks for existing transfer lines.

    Group pallets by lot_number to fill lot_allocations. For lines on orders
    that have been picked (forklift_submitted/approved), also fill picks
    treating each scanned pallet as a full (non-partial) pull. Pending /
    submitted orders are left with picks=[] (forklift hasn't started yet)
    but still get lot_allocations so the new UI can render them.
    """
    conn = op.get_bind()

    rows = conn.execute(sa.text("""
        SELECT itl.id, itl.pallet_licence_ids, it.status
        FROM inventory_transfer_lines itl
        JOIN inventory_transfers it ON it.id = itl.transfer_id
        WHERE itl.pallet_licence_ids IS NOT NULL
    """)).fetchall()

    picked_statuses = {'forklift_submitted', 'approved'}

    for line_id, pl_ids, status in rows:
        if not pl_ids:
            continue

        pallets = conn.execute(
            sa.text("""
                SELECT id, lot_number, cases
                FROM pallet_licences
                WHERE id = ANY(:ids)
            """),
            {'ids': list(pl_ids)},
        ).fetchall()

        by_lot: dict[str, float] = {}
        picks: list[dict] = []
        for pid, lot, cases in pallets:
            lot_key = lot or ''
            by_lot[lot_key] = by_lot.get(lot_key, 0.0) + float(cases or 0)
            picks.append({
                'pallet_licence_id': pid,
                'cases_consumed': float(cases or 0),
                'was_partial': False,
                'scanned_at': None,
                'scanned_by': None,
            })

        already_picked = status in picked_statuses
        lot_allocations = [
            {
                'lot_number': lot,
                'cases_requested': cases,
                'cases_picked': cases if already_picked else 0.0,
            }
            for lot, cases in by_lot.items()
        ]
        picks_to_write = picks if already_picked else []

        conn.execute(
            sa.text("""
                UPDATE inventory_transfer_lines
                SET lot_allocations = CAST(:la AS json),
                    picks = CAST(:pk AS json),
                    lot_swap_history = CAST(:lh AS json)
                WHERE id = :id
            """),
            {
                'la': json.dumps(lot_allocations),
                'pk': json.dumps(picks_to_write),
                'lh': json.dumps([]),
                'id': line_id,
            },
        )


def downgrade() -> None:
    op.drop_column('storage_rows', 'is_partial_pallet_location')

    op.drop_index(
        'ix_ship_out_lot_reservations_active',
        table_name='ship_out_lot_reservations',
    )
    op.drop_index(
        'ix_ship_out_lot_reservations_transfer_line_id',
        table_name='ship_out_lot_reservations',
    )
    op.drop_table('ship_out_lot_reservations')

    op.drop_column('inventory_transfer_lines', 'lot_swap_history')
    op.drop_column('inventory_transfer_lines', 'picks')
    op.drop_column('inventory_transfer_lines', 'lot_allocations')
