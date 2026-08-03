"""
Models package — re-exports all SQLAlchemy models so existing imports stay unchanged.

Import order matters: models with FK dependencies must be imported after their targets.
All models register themselves on the shared `Base` from database.py.
"""

# 1. No-FK base models
from app.models.user import Warehouse, User

# 1b. Shipping master data (no FK deps) — must precede product (Product FKs to
# package_sizes) and inventory (InventoryTransfer FKs to ship_to_locations,
# pallet_types).
from app.models.shipping import PackageSize, PalletType, ShipToLocation, Carrier

from app.models.product import CategoryGroup, Category, Vendor, Product, WarehouseCategoryAccess

# 2. Location models (FK: warehouses, locations, sub_locations, storage_areas, products)
from app.models.location import (
    Location, SubLocation, StorageArea, StorageRow,
    ProductionShift, ProductionLine,
)

# 3. Receipt (FK: products, categories, vendors, locations, storage_rows, users, warehouses)
from app.models.receipt import Receipt, ReceiptAllocation

# 4. Inventory transfers (FK: receipts, locations, users, warehouses)
from app.models.inventory import (
    InventoryTransfer, InventoryTransferLine, TransferPalletSwap,
    ShipOutLotReservation,
    InventoryAdjustment, InventoryHoldAction,
    CycleCount, StagingItem,
)

# 5. Scanner models (FK: products, receipts, storage_areas, storage_rows, inventory_transfers, users)
from app.models.scanner import ForkliftRequest, PalletLicence, TransferScanEvent

# 6. Staging requests (FK: products)
# NOTE: StagingLineContainer FKs containers, which is defined in section 11 —
# SQLAlchemy resolves relationship targets lazily by name, so the string
# reference is fine, but the TABLE must exist before its FK is created. The
# migration handles ordering; create_all sorts by dependency automatically.
from app.models.staging import StagingRequest, StagingRequestItem, StagingLineContainer

# 7. Inter-warehouse transfers (FK: warehouses, products, receipts, users)
from app.models.warehouse_transfer import InterWarehouseTransfer

# 8. Notifications (FK: warehouses, users)
from app.models.notifications import Notification

# 9. Audit log (FK: users)
from app.models.audit import AuditLog

# 10. Active line production (FK: production_lines, products, users)
from app.models.active_production import ActiveLineProduction

# 11. Ingredient serialization (FK: warehouses, vendors, products, categories,
#     storage_rows, users) — must follow location (storage_rows) and product.
from app.models.ingredient import (
    IngredientIntake, IntakeLot, Container, ContainerEvent,
)

__all__ = [
    "Warehouse", "User",
    "CategoryGroup", "Category", "Vendor", "Product", "WarehouseCategoryAccess",
    "Location", "SubLocation", "StorageArea", "StorageRow",
    "ProductionShift", "ProductionLine",
    "Receipt", "ReceiptAllocation",
    "InventoryTransfer", "InventoryTransferLine", "TransferPalletSwap",
    "InventoryAdjustment", "InventoryHoldAction",
    "CycleCount", "StagingItem",
    "ForkliftRequest", "PalletLicence", "TransferScanEvent",
    "StagingRequest", "StagingRequestItem", "StagingLineContainer",
    "InterWarehouseTransfer",
    "Notification",
    "AuditLog",
    "ActiveLineProduction",
    "IngredientIntake", "IntakeLot", "Container", "ContainerEvent",
]
