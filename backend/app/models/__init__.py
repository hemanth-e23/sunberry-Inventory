"""
Models package — re-exports all SQLAlchemy models so existing imports stay unchanged.

Import order matters: models with FK dependencies must be imported after their targets.
All models register themselves on the shared `Base` from database.py.
"""

# 1. No-FK base models
from app.models.user import Warehouse, User
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
    InventoryTransfer, InventoryAdjustment, InventoryHoldAction,
    CycleCount, StagingItem,
)

# 5. Scanner models (FK: products, receipts, storage_areas, storage_rows, inventory_transfers, users)
from app.models.scanner import ForkliftRequest, PalletLicence, TransferScanEvent

# 6. Staging requests (FK: products)
from app.models.staging import StagingRequest, StagingRequestItem

# 7. Inter-warehouse transfers (FK: warehouses, products, receipts, users)
from app.models.warehouse_transfer import InterWarehouseTransfer

# 8. Notifications (FK: warehouses, users)
from app.models.notifications import Notification

# 9. Audit log (FK: users)
from app.models.audit import AuditLog

__all__ = [
    "Warehouse", "User",
    "CategoryGroup", "Category", "Vendor", "Product", "WarehouseCategoryAccess",
    "Location", "SubLocation", "StorageArea", "StorageRow",
    "ProductionShift", "ProductionLine",
    "Receipt", "ReceiptAllocation",
    "InventoryTransfer", "InventoryAdjustment", "InventoryHoldAction",
    "CycleCount", "StagingItem",
    "ForkliftRequest", "PalletLicence", "TransferScanEvent",
    "StagingRequest", "StagingRequestItem",
    "InterWarehouseTransfer",
    "Notification",
    "AuditLog",
]
