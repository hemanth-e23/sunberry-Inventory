"""FG pallet lifecycle — pallet events, closing scans, shuttle destinations

FG-PALLET-LIFECYCLE-SPEC.md (2026-10-08). Every correction to a finished-goods
pallet becomes a status on that pallet plus a row here saying who / when / why,
never a bare number:

- pallet_events: append-only ledger (missing, found, not_produced with its
  reason, a not_produced pallet scanned later, Moyel shuttle, case
  adjustments, cycle-check moves).
- forklift_requests.closing_scans: the "scan the last pallet at the wrapper"
  answer per lot, or that the driver skipped it.
- ship_to_locations.is_shuttle_destination: the Moyel shuttle's saved
  destination list, seeded with RMI WAREHOUSE.

Additive only.

Revision ID: f9c8b7a6d5e4
Revises: a1b2c3d4e5f6
"""
from alembic import op
import sqlalchemy as sa


revision = 'f9c8b7a6d5e4'
down_revision = 'a1b2c3d4e5f6'
branch_labels = None
depends_on = None


def upgrade():
    # main.py runs Base.metadata.create_all at import, so a server started on
    # this code before the migration ran has already created pallet_events
    # (and its indexes). Only create what is not there yet.
    insp = sa.inspect(op.get_bind())
    if 'pallet_events' not in insp.get_table_names():
        _create_pallet_events()
    else:
        existing = {ix['name'] for ix in insp.get_indexes('pallet_events')}
        if 'ix_pallet_events_pallet_licence_id' not in existing:
            op.create_index('ix_pallet_events_pallet_licence_id', 'pallet_events', ['pallet_licence_id'])
        if 'ix_pallet_events_licence_number' not in existing:
            op.create_index('ix_pallet_events_licence_number', 'pallet_events', ['licence_number'])

    fr_cols = {c['name'] for c in insp.get_columns('forklift_requests')}
    if 'closing_scans' not in fr_cols:
        op.add_column('forklift_requests', sa.Column('closing_scans', sa.JSON(), nullable=True))

    st_cols = {c['name'] for c in insp.get_columns('ship_to_locations')}
    if 'is_shuttle_destination' not in st_cols:
        op.add_column(
            'ship_to_locations',
            sa.Column('is_shuttle_destination', sa.Boolean(), nullable=False, server_default='false'),
        )
    op.execute(
        "INSERT INTO ship_to_locations (id, customer_name, location_name, address_line1, "
        "city, state, zip_code, is_active, is_shuttle_destination) "
        "SELECT 'shipto-rmi-warehouse', 'RMI WAREHOUSE', 'RMI WAREHOUSE', "
        "'39269 W Red Arrow Hwy', 'Paw Paw', 'MI', '49079', true, true "
        "WHERE NOT EXISTS (SELECT 1 FROM ship_to_locations WHERE id = 'shipto-rmi-warehouse')"
    )


def _create_pallet_events():
    op.create_table(
        'pallet_events',
        sa.Column('id', sa.String(length=50), primary_key=True),
        sa.Column('pallet_licence_id', sa.String(length=50), sa.ForeignKey('pallet_licences.id', ondelete='SET NULL'), nullable=True),
        sa.Column('licence_number', sa.String(length=100), nullable=True),
        sa.Column('event_type', sa.String(length=30), nullable=False),
        sa.Column('from_status', sa.String(length=20), nullable=True),
        sa.Column('to_status', sa.String(length=20), nullable=True),
        sa.Column('reason_code', sa.String(length=40), nullable=True),
        sa.Column('reason', sa.Text(), nullable=True),
        sa.Column('cases_before', sa.Integer(), nullable=True),
        sa.Column('cases_after', sa.Integer(), nullable=True),
        sa.Column('storage_row_id', sa.String(length=50), sa.ForeignKey('storage_rows.id'), nullable=True),
        sa.Column('ref_type', sa.String(length=30), nullable=True),
        sa.Column('ref_id', sa.String(length=50), nullable=True),
        sa.Column('user_id', sa.String(length=50), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('warehouse_id', sa.String(length=50), sa.ForeignKey('warehouses.id'), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index('ix_pallet_events_pallet_licence_id', 'pallet_events', ['pallet_licence_id'])
    op.create_index('ix_pallet_events_licence_number', 'pallet_events', ['licence_number'])


def downgrade():
    op.execute("DELETE FROM ship_to_locations WHERE id = 'shipto-rmi-warehouse'")
    op.drop_column('ship_to_locations', 'is_shuttle_destination')
    op.drop_column('forklift_requests', 'closing_scans')
    op.drop_index('ix_pallet_events_licence_number', table_name='pallet_events')
    op.drop_index('ix_pallet_events_pallet_licence_id', table_name='pallet_events')
    op.drop_table('pallet_events')
