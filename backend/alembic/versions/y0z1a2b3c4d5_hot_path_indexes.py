"""Index the columns the hot read paths filter on

The API became unresponsive on 2026-08-10 and again on 2026-08-12, both times
needing a manual restart. The proximate failure was connection-pool exhaustion,
but the reason a burst of traffic could exhaust the pool at all is that several
routinely-called queries were sequential scans.

PostgreSQL does not create indexes on foreign keys automatically, and none of
these columns declared `index=True` on the model. Every one of them is filtered
on in a request path that runs constantly:

  * transfer_scan_events.transfer_id — the worst of them. /scan-progress is
    polled every 3-5s by three different screens for the whole duration of a
    ship-out, and each call scanned the entire scan-events table, which only
    ever grows.
  * pallet_licences.* — the pallet-tag print screen and the adjustments and
    transfers tabs all filter here.
  * inventory_transfers.(status, transfer_type) — the pending-approvals queue.
  * receipts.(product_id, warehouse_id, status) — receipt lookups throughout.

These are pure additions: no column, constraint or data changes, so the only
risk is the build itself. CONCURRENTLY avoids taking a write lock, so this runs
safely against a live warehouse.

Revision ID: y0z1a2b3c4d5
Revises: x9y0z1a2b3c4
"""
from alembic import op


revision = 'y0z1a2b3c4d5'
down_revision = 'x9y0z1a2b3c4'
branch_labels = None
depends_on = None


# (index name, table, column list). Composite indexes are ordered so the
# leading column is the more selective one for the queries that use them.
INDEXES = [
    ('ix_tse_transfer_id', 'transfer_scan_events', 'transfer_id'),
    ('ix_pallet_licences_status', 'pallet_licences', 'status'),
    ('ix_pallet_licences_receipt_id', 'pallet_licences', 'receipt_id'),
    ('ix_pallet_licences_product_status', 'pallet_licences', 'product_id, status'),
    ('ix_pallet_licences_forklift_request_id', 'pallet_licences', 'forklift_request_id'),
    ('ix_pallet_licences_warehouse_id', 'pallet_licences', 'warehouse_id'),
    ('ix_inventory_transfers_status_type', 'inventory_transfers', 'status, transfer_type'),
    ('ix_receipts_product_id', 'receipts', 'product_id'),
    ('ix_receipts_warehouse_id', 'receipts', 'warehouse_id'),
    ('ix_receipts_status', 'receipts', 'status'),
]


def upgrade():
    # CONCURRENTLY cannot run inside a transaction, and Alembic wraps each
    # migration in one by default. autocommit_block suspends that.
    #
    # The tradeoff: a failed concurrent build leaves an INVALID index behind
    # rather than rolling back. IF NOT EXISTS makes a re-run safe, but an
    # invalid index must be dropped by hand before it will be rebuilt --
    #   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
    with op.get_context().autocommit_block():
        for name, table, columns in INDEXES:
            op.execute(
                f'CREATE INDEX CONCURRENTLY IF NOT EXISTS {name} '
                f'ON {table} ({columns})'
            )


def downgrade():
    with op.get_context().autocommit_block():
        for name, _table, _columns in INDEXES:
            op.execute(f'DROP INDEX CONCURRENTLY IF EXISTS {name}')
