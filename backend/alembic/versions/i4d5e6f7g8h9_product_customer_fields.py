"""products: customer fields for pallet stickers (BJ's, etc.)

Revision ID: i4d5e6f7g8h9
Revises: h3c4d5e6f7g8
Create Date: 2026-05-14

Adds optional per-product customer identification used when the product is
sold to a wholesale retailer (e.g. BJ's). When all three are populated, the
pallet sticker renderer emits the customer block (BJ'S ITEM #, UPC barcode).
- customer_name: short label like "BJ's", "Costco"
- customer_item_number: retailer's item number
- customer_upc: UPC digits used to render the barcode
"""
from typing import Union, Sequence
from alembic import op
import sqlalchemy as sa


revision: str = 'i4d5e6f7g8h9'
down_revision: Union[str, Sequence[str], None] = 'h3c4d5e6f7g8'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('products', sa.Column('customer_name', sa.String(length=50), nullable=True))
    op.add_column('products', sa.Column('customer_item_number', sa.String(length=30), nullable=True))
    op.add_column('products', sa.Column('customer_upc', sa.String(length=20), nullable=True))


def downgrade() -> None:
    op.drop_column('products', 'customer_upc')
    op.drop_column('products', 'customer_item_number')
    op.drop_column('products', 'customer_name')
