"""
Schema package — re-exports all Pydantic schemas so existing imports stay unchanged.

All schemas live in domain-specific modules:
  auth.py, user.py, product.py, receipt.py, location.py,
  inventory.py, staging.py, scanner.py, warehouse.py, notifications.py
"""

from app.schemas.base import BaseSchema
from app.schemas.auth import Token, TokenData, LoginRequest, BadgeLoginRequest
from app.schemas.user import WarehouseBasic, UserBase, UserCreate, UserUpdate, User
from app.schemas.product import (
    CategoryGroupBase, CategoryGroupCreate, CategoryGroupUpdate, CategoryGroup,
    CategoryBase, CategoryCreate, CategoryUpdate, Category,
    VendorBase, VendorCreate, VendorUpdate, Vendor,
    ProductBase, ProductCreate, ProductUpdate, Product, ProductListResponse,
)
from app.schemas.receipt import (
    ReceiptAllocationBase, ReceiptAllocationCreate, ReceiptAllocation,
    ReceiptBase, ReceiptCreate, ReceiptUpdate, Receipt,
)
from app.schemas.location import (
    LocationBase, LocationCreate, LocationUpdate, Location,
    SubLocationBase, SubLocationCreate, SubLocationUpdate, SubLocation,
    StorageRowBase, StorageRowCreate, StorageRowUpdate, StorageRow,
    StorageAreaBase, StorageAreaCreate, StorageAreaUpdate, StorageArea,
    ProductionShiftBase, ProductionShiftCreate, ProductionShiftUpdate, ProductionShift,
    ProductionLineBase, ProductionLineCreate, ProductionLineUpdate, ProductionLine,
)
from app.schemas.inventory import (
    InventoryTransferBase, InventoryTransferCreate, InventoryTransferUpdate,
    PalletLicenceTransferRef, InventoryTransfer,
    ShipOutPickListCreate, ScanPickRequest, ForkliftSubmitRequest,
    InventoryAdjustmentBase, InventoryAdjustmentCreate, InventoryAdjustmentUpdate, InventoryAdjustment,
    HoldItem, InventoryHoldActionBase, InventoryHoldActionCreate, InventoryHoldActionUpdate, InventoryHoldAction,
    CycleCountBase, CycleCountCreate, CycleCount,
)
from app.schemas.staging import (
    StagingItemBase, StagingItemCreate, StagingItemUpdate, StagingItem,
    StagingLotSuggestion, StagingLotRequest, StagingItemRequest,
    CreateStagingRequest, MarkStagingUsedRequest, ReturnStagingRequest,
)
from app.schemas.scanner import (
    ScanPalletRequest, MarkMissingRequest,
    PalletLicenceBase, PalletLicenceCreate, PalletLicence, PalletLicenceUpdate,
    ForkliftRequestBase, ForkliftRequestCreate, ForkliftRequestProductRef,
    ForkliftRequest, ForkliftRequestUpdate,
)
from app.schemas.warehouse import (
    WarehouseFull, WarehouseCreate, WarehouseUpdate,
    WarehouseCategoryAccessOut, WarehouseCategoryAccessCreate,
    InterWarehouseTransferCreate, InterWarehouseTransferAction,
    InterWarehouseTransferDisputeAction, WarehouseInfo, ProductBasic,
    InterWarehouseTransferOut,
)
from app.schemas.notifications import NotificationOut

__all__ = [
    "BaseSchema",
    # Auth
    "Token", "TokenData", "LoginRequest", "BadgeLoginRequest",
    # User
    "WarehouseBasic", "UserBase", "UserCreate", "UserUpdate", "User",
    # Product
    "CategoryGroupBase", "CategoryGroupCreate", "CategoryGroupUpdate", "CategoryGroup",
    "CategoryBase", "CategoryCreate", "CategoryUpdate", "Category",
    "VendorBase", "VendorCreate", "VendorUpdate", "Vendor",
    "ProductBase", "ProductCreate", "ProductUpdate", "Product", "ProductListResponse",
    # Receipt
    "ReceiptAllocationBase", "ReceiptAllocationCreate", "ReceiptAllocation",
    "ReceiptBase", "ReceiptCreate", "ReceiptUpdate", "Receipt",
    # Location
    "LocationBase", "LocationCreate", "LocationUpdate", "Location",
    "SubLocationBase", "SubLocationCreate", "SubLocationUpdate", "SubLocation",
    "StorageRowBase", "StorageRowCreate", "StorageRowUpdate", "StorageRow",
    "StorageAreaBase", "StorageAreaCreate", "StorageAreaUpdate", "StorageArea",
    "ProductionShiftBase", "ProductionShiftCreate", "ProductionShiftUpdate", "ProductionShift",
    "ProductionLineBase", "ProductionLineCreate", "ProductionLineUpdate", "ProductionLine",
    # Inventory
    "InventoryTransferBase", "InventoryTransferCreate", "InventoryTransferUpdate",
    "PalletLicenceTransferRef", "InventoryTransfer",
    "ShipOutPickListCreate", "ScanPickRequest", "ForkliftSubmitRequest",
    "InventoryAdjustmentBase", "InventoryAdjustmentCreate", "InventoryAdjustmentUpdate", "InventoryAdjustment",
    "HoldItem", "InventoryHoldActionBase", "InventoryHoldActionCreate", "InventoryHoldActionUpdate", "InventoryHoldAction",
    "CycleCountBase", "CycleCountCreate", "CycleCount",
    # Staging
    "StagingItemBase", "StagingItemCreate", "StagingItemUpdate", "StagingItem",
    "StagingLotSuggestion", "StagingLotRequest", "StagingItemRequest",
    "CreateStagingRequest", "MarkStagingUsedRequest", "ReturnStagingRequest",
    # Scanner
    "ScanPalletRequest", "MarkMissingRequest",
    "PalletLicenceBase", "PalletLicenceCreate", "PalletLicence", "PalletLicenceUpdate",
    "ForkliftRequestBase", "ForkliftRequestCreate", "ForkliftRequestProductRef",
    "ForkliftRequest", "ForkliftRequestUpdate",
    # Warehouse
    "WarehouseFull", "WarehouseCreate", "WarehouseUpdate",
    "WarehouseCategoryAccessOut", "WarehouseCategoryAccessCreate",
    "InterWarehouseTransferCreate", "InterWarehouseTransferAction",
    "InterWarehouseTransferDisputeAction", "WarehouseInfo", "ProductBasic",
    "InterWarehouseTransferOut",
    # Notifications
    "NotificationOut",
]
