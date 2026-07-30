"""ship-out scheduling foundation: master data + order lifecycle fields

Revision ID: p1q2r3s4t5u6
Revises: n9i0j1k2l3m4
Create Date: 2026-07-04

Task 1 of SHIP-OUT-SCHEDULING-SPEC.md. Additive/non-breaking schema for the
scheduled ship-out flow:
- package_sizes (16/32/64/128 oz, seeded with case weights) + products.package_size_id
  — case weight is set once per SIZE, not per product (SPEC §7.1)
- pallet_types  (seeded with PECO; SPEC §5.10)
- ship_to_locations, carriers  (self-populating master data; SPEC §7.2)
- inventory_transfers: scheduling + yard check-in + departure + reconcile/lock fields

Existing finished-good products are auto-assigned a size by parsing "64OZ"/"128OZ"
etc. from their names. Clean cutover means no in-flight orders need migrating.
"""
from typing import Union, Sequence
from alembic import op
import sqlalchemy as sa


revision: str = 'p1q2r3s4t5u6'
down_revision: Union[str, Sequence[str], None] = 'n9i0j1k2l3m4'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # --- package_sizes: case weight set once per size (SPEC §7.1) ---
    op.create_table(
        'package_sizes',
        sa.Column('id', sa.String(length=50), nullable=False),
        sa.Column('label', sa.String(length=50), nullable=False),
        sa.Column('case_weight', sa.Float(), nullable=True),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('label', name='uq_package_sizes_label'),
    )
    # Seed the four sizes with confirmed case weights (stacking sheet + sample BOL).
    op.execute(
        "INSERT INTO package_sizes (id, label, case_weight, sort_order, is_active) VALUES "
        "('pkgsize-16oz',  '16 oz',               14.65, 1, true),"
        "('pkgsize-32oz',  '32 oz',               30.0,  2, true),"
        "('pkgsize-64oz',  '64 oz',               38.0,  3, true),"
        "('pkgsize-128oz', '1 Gallon (128 oz)',   37.5,  4, true)"
    )

    # --- products.package_size_id + auto-assign existing FG by name ---
    op.add_column('products', sa.Column('package_size_id', sa.String(length=50), nullable=True))
    op.create_foreign_key(
        'fk_products_package_size', 'products', 'package_sizes',
        ['package_size_id'], ['id'],
    )
    # Order matters: 128 before 16/64 so a "128OZ" name isn't caught by a looser
    # rule. (?<![0-9]) avoids matching "64" inside "164". \s*OZ tolerates a space.
    op.execute(r"UPDATE products SET package_size_id='pkgsize-128oz' WHERE name ~* '(?<![0-9])128\s*OZ'")
    op.execute(r"UPDATE products SET package_size_id='pkgsize-64oz'  WHERE package_size_id IS NULL AND name ~* '(?<![0-9])64\s*OZ'")
    op.execute(r"UPDATE products SET package_size_id='pkgsize-32oz'  WHERE package_size_id IS NULL AND name ~* '(?<![0-9])32\s*OZ'")
    op.execute(r"UPDATE products SET package_size_id='pkgsize-16oz'  WHERE package_size_id IS NULL AND name ~* '(?<![0-9])16\s*OZ'")

    # --- pallet_types (seeded via SQL; PECO default) ---
    op.create_table(
        'pallet_types',
        sa.Column('id', sa.String(length=50), nullable=False),
        sa.Column('code', sa.String(length=30), nullable=False),
        sa.Column('name', sa.String(length=100), nullable=False),
        sa.Column('item_code', sa.String(length=50), nullable=True),
        sa.Column('description', sa.String(length=200), nullable=True),
        sa.Column('pallet_weight', sa.Float(), nullable=False, server_default='60'),
        sa.Column('is_default', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('code', name='uq_pallet_types_code'),
    )

    # --- ship_to_locations (self-populating) ---
    op.create_table(
        'ship_to_locations',
        sa.Column('id', sa.String(length=50), nullable=False),
        sa.Column('customer_name', sa.String(length=100), nullable=False),
        sa.Column('location_name', sa.String(length=200), nullable=False),
        sa.Column('address_line1', sa.String(length=200), nullable=True),
        sa.Column('address_line2', sa.String(length=200), nullable=True),
        sa.Column('city', sa.String(length=100), nullable=True),
        sa.Column('state', sa.String(length=20), nullable=True),
        sa.Column('zip_code', sa.String(length=20), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_ship_to_locations_customer_name', 'ship_to_locations', ['customer_name'])

    # --- carriers (self-populating) ---
    op.create_table(
        'carriers',
        sa.Column('id', sa.String(length=50), nullable=False),
        sa.Column('name', sa.String(length=100), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('name', name='uq_carriers_name'),
    )
    op.create_index('ix_carriers_name', 'carriers', ['name'])

    # --- inventory_transfers lifecycle fields (all nullable / defaulted) ---
    add = lambda *a, **k: op.add_column('inventory_transfers', sa.Column(*a, **k))
    add('scheduled_date', sa.Date(), nullable=True)
    add('appointment_time', sa.String(length=20), nullable=True)
    add('ship_to_location_id', sa.String(length=50), nullable=True)
    add('po_number', sa.String(length=100), nullable=True)
    add('carrier', sa.String(length=100), nullable=True)
    add('pallet_type_id', sa.String(length=50), nullable=True)
    add('driver_name', sa.String(length=100), nullable=True)
    add('driver_license', sa.String(length=50), nullable=True)
    add('truck_number', sa.String(length=50), nullable=True)
    add('trailer_number', sa.String(length=50), nullable=True)
    add('trailer_license', sa.String(length=50), nullable=True)
    add('time_in', sa.DateTime(timezone=True), nullable=True)
    add('checked_in_at', sa.DateTime(timezone=True), nullable=True)
    add('checked_in_by', sa.String(length=50), nullable=True)
    add('seal_number', sa.String(length=50), nullable=True)
    add('time_out', sa.DateTime(timezone=True), nullable=True)
    add('reconciled_at', sa.DateTime(timezone=True), nullable=True)
    add('reconciled_by', sa.String(length=50), nullable=True)
    add('ship_short', sa.Boolean(), nullable=False, server_default=sa.false())
    add('docs_generated_at', sa.DateTime(timezone=True), nullable=True)
    add('docs_generated_by', sa.String(length=50), nullable=True)
    add('is_locked', sa.Boolean(), nullable=False, server_default=sa.false())
    add('pallet_count_override', sa.Integer(), nullable=True)
    add('scheduled_by', sa.String(length=50), nullable=True)

    op.create_foreign_key(
        'fk_transfers_ship_to_location', 'inventory_transfers', 'ship_to_locations',
        ['ship_to_location_id'], ['id'],
    )
    op.create_foreign_key(
        'fk_transfers_pallet_type', 'inventory_transfers', 'pallet_types',
        ['pallet_type_id'], ['id'],
    )

    # --- seed default pallet type: PECO ---
    op.execute(
        "INSERT INTO pallet_types (id, code, name, item_code, description, "
        "pallet_weight, is_default, is_active) VALUES "
        "('pallet-type-peco', 'PECO', 'PECO Pallet', 'SPECOSUN', "
        "'PECO PALLET SUNBERRY', 60, true, true)"
    )


def downgrade() -> None:
    op.drop_constraint('fk_transfers_pallet_type', 'inventory_transfers', type_='foreignkey')
    op.drop_constraint('fk_transfers_ship_to_location', 'inventory_transfers', type_='foreignkey')
    for col in [
        'scheduled_by', 'pallet_count_override', 'is_locked', 'docs_generated_by',
        'docs_generated_at', 'ship_short', 'reconciled_by', 'reconciled_at', 'time_out',
        'seal_number', 'checked_in_by', 'checked_in_at', 'time_in', 'trailer_license',
        'trailer_number', 'truck_number', 'driver_license', 'driver_name', 'pallet_type_id',
        'carrier', 'po_number', 'ship_to_location_id', 'appointment_time', 'scheduled_date',
    ]:
        op.drop_column('inventory_transfers', col)
    op.drop_index('ix_carriers_name', table_name='carriers')
    op.drop_table('carriers')
    op.drop_index('ix_ship_to_locations_customer_name', table_name='ship_to_locations')
    op.drop_table('ship_to_locations')
    op.drop_table('pallet_types')
    op.drop_constraint('fk_products_package_size', 'products', type_='foreignkey')
    op.drop_column('products', 'package_size_id')
    op.drop_table('package_sizes')
