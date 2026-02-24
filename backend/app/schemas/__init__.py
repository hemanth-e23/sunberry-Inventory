from __future__ import annotations

from pydantic import BaseModel, EmailStr, Field
from typing import Optional, List
from datetime import datetime

# Base schemas
class BaseSchema(BaseModel):
    class Config:
        from_attributes = True

# User schemas
class UserBase(BaseSchema):
    username: str = Field(..., min_length=3, max_length=50, description="Username (3-50 characters)")
    name: str = Field(..., min_length=1, max_length=100, description="Full name (1-100 characters)")
    email: EmailStr = Field(..., max_length=100, description="Email address")
    role: str = Field(..., max_length=20, description="User role")

class UserCreate(UserBase):
    password: str = Field(..., min_length=8, max_length=128, description="Password (minimum 8 characters)")
    badge_id: Optional[str] = Field(None, max_length=50, description="Badge ID for forklift users")

class UserUpdate(BaseSchema):
    username: Optional[str] = Field(None, min_length=3, max_length=50)
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    email: Optional[EmailStr] = Field(None, max_length=100)
    role: Optional[str] = Field(None, max_length=20)
    is_active: Optional[bool] = None
    password: Optional[str] = Field(None, min_length=8, max_length=128)
    badge_id: Optional[str] = Field(None, max_length=50)

class User(UserBase):
    id: str
    is_active: bool
    badge_id: Optional[str] = None
    created_at: datetime

# Auth schemas
class Token(BaseSchema):
    access_token: str
    token_type: str

class TokenData(BaseSchema):
    username: Optional[str] = None

class LoginRequest(BaseSchema):
    username: str = Field(..., min_length=1, max_length=50)
    password: str = Field(..., min_length=1, max_length=128)


class BadgeLoginRequest(BaseSchema):
    badge_id: str = Field(..., min_length=1, max_length=50)


class ScanPalletRequest(BaseSchema):
    licence_number: str = Field(..., min_length=1, max_length=100)
    storage_row_id: str = Field(..., min_length=1, max_length=50)
    is_partial: bool = False
    partial_cases: Optional[int] = Field(None, ge=0)


class MarkMissingRequest(BaseSchema):
    licence_numbers: List[str] = Field(..., min_length=1)


# Pallet Licence schemas
class PalletLicenceBase(BaseSchema):
    licence_number: str
    product_id: str
    lot_number: str
    storage_area_id: Optional[str] = None
    storage_row_id: Optional[str] = None
    cases: int
    is_partial: bool = False
    sequence: int
    status: str = "pending"


class PalletLicenceCreate(PalletLicenceBase):
    receipt_id: Optional[str] = None
    forklift_request_id: Optional[str] = None


class PalletLicence(PalletLicenceBase):
    id: str
    receipt_id: Optional[str] = None
    forklift_request_id: Optional[str] = None
    transfer_id: Optional[str] = None
    scanned_by: Optional[str] = None
    scanned_at: Optional[datetime] = None
    created_at: datetime
    updated_at: Optional[datetime] = None


# Forklift Request schemas
class ForkliftRequestBase(BaseSchema):
    product_id: str
    lot_number: str
    production_date: Optional[datetime] = None
    expiration_date: Optional[datetime] = None
    shift_id: Optional[str] = None
    line_id: Optional[str] = None
    cases_per_pallet: int
    total_full_pallets: int = 0
    total_partial_pallets: int = 0
    total_cases: float = 0
    status: str = "scanning"


class ForkliftRequestCreate(BaseSchema):
    licence_number: str = Field(..., min_length=1, max_length=100)  # First scanned licence to derive product/lot


class ForkliftRequestProductRef(BaseSchema):
    id: str
    name: str
    fcc_code: Optional[str] = None
    short_code: Optional[str] = None


class ForkliftRequest(ForkliftRequestBase):
    id: str
    receipt_id: Optional[str] = None
    scanned_by: Optional[str] = None
    approved_by: Optional[str] = None
    approved_at: Optional[datetime] = None
    submitted_at: Optional[datetime] = None
    created_at: datetime
    pallet_licences: List[PalletLicence] = []
    product: Optional[ForkliftRequestProductRef] = None


class ForkliftRequestUpdate(BaseSchema):
    shift_id: Optional[str] = None
    line_id: Optional[str] = None
    production_date: Optional[datetime] = None
    expiration_date: Optional[datetime] = None
    cases_per_pallet: Optional[int] = None
    lot_number: Optional[str] = None


class PalletLicenceUpdate(BaseSchema):
    cases: Optional[int] = None
    is_partial: Optional[bool] = None


# Category schemas
class CategoryGroupBase(BaseSchema):
    id: str = Field(..., max_length=50)
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)

class CategoryGroupCreate(CategoryGroupBase):
    pass

class CategoryGroupUpdate(BaseSchema):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    is_active: Optional[bool] = None

class CategoryGroup(CategoryGroupBase):
    is_active: bool
    created_at: datetime

class CategoryBase(BaseSchema):
    id: str = Field(..., max_length=50)
    name: str = Field(..., min_length=1, max_length=100)
    type: str = Field(..., max_length=50)
    parent_id: Optional[str] = Field(None, max_length=50)

class CategoryCreate(CategoryBase):
    pass

class CategoryUpdate(BaseSchema):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    type: Optional[str] = Field(None, max_length=50)
    parent_id: Optional[str] = Field(None, max_length=50)
    is_active: Optional[bool] = None

class Category(CategoryBase):
    is_active: bool
    created_at: datetime

# Vendor schemas
class VendorBase(BaseSchema):
    id: str = Field(..., max_length=50)
    name: str = Field(..., min_length=1, max_length=100)
    contact_person: Optional[str] = Field(None, max_length=100)
    email: Optional[str] = Field(None, max_length=100)
    phone: Optional[str] = Field(None, max_length=20)
    address: Optional[str] = Field(None, max_length=500)

class VendorCreate(VendorBase):
    pass

class VendorUpdate(BaseSchema):
    name: Optional[str] = None
    contact_person: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    is_active: Optional[bool] = None

class Vendor(VendorBase):
    is_active: bool
    created_at: datetime

# Product schemas
class ProductBase(BaseSchema):
    id: str
    name: str
    short_code: Optional[str] = None
    fcc_code: Optional[str] = None
    sid: Optional[str] = None
    brix: Optional[float] = None
    category_id: str
    vendor_id: Optional[str] = None
    description: Optional[str] = None
    default_cases_per_pallet: Optional[int] = None
    expire_years: Optional[int] = None
    quantity_uom: Optional[str] = None
    inventory_tracked: bool = True
    gal_per_case: Optional[float] = None

class ProductCreate(ProductBase):
    pass

class ProductUpdate(BaseSchema):
    name: Optional[str] = None
    short_code: Optional[str] = None
    fcc_code: Optional[str] = None
    sid: Optional[str] = None
    brix: Optional[float] = None
    category_id: Optional[str] = None
    vendor_id: Optional[str] = None
    description: Optional[str] = None
    default_cases_per_pallet: Optional[int] = None
    expire_years: Optional[int] = None
    quantity_uom: Optional[str] = None
    is_active: Optional[bool] = None
    inventory_tracked: Optional[bool] = None
    gal_per_case: Optional[float] = None

class Product(ProductBase):
    is_active: bool
    created_at: datetime


class ProductListResponse(BaseSchema):
    """Paginated product list: items for current page and total count."""
    items: List[Product]
    total: int


# Location schemas
class LocationBase(BaseSchema):
    id: str
    name: str
    description: Optional[str] = None

class LocationCreate(LocationBase):
    pass

class LocationUpdate(BaseSchema):
    name: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None

class Location(LocationBase):
    is_active: bool
    created_at: datetime

class SubLocationBase(BaseSchema):
    id: str
    name: str
    location_id: str

class SubLocationCreate(SubLocationBase):
    pass

class SubLocationUpdate(BaseSchema):
    name: Optional[str] = None
    location_id: Optional[str] = None
    is_active: Optional[bool] = None

class SubLocation(SubLocationBase):
    is_active: bool
    created_at: datetime
    rows: List['StorageRow'] = []

class StorageRowBase(BaseSchema):
    id: str
    name: str
    template: Optional[str] = None
    pallet_capacity: int = 0
    default_cases_per_pallet: int = 0
    occupied_pallets: float = 0
    occupied_cases: float = 0
    product_id: Optional[str] = None
    hold: bool = False
    notes: Optional[str] = None

class StorageRowCreate(StorageRowBase):
    storage_area_id: Optional[str] = None
    sub_location_id: Optional[str] = None

class StorageRowUpdate(BaseSchema):
    name: Optional[str] = None
    template: Optional[str] = None
    pallet_capacity: Optional[int] = None
    default_cases_per_pallet: Optional[int] = None
    occupied_pallets: Optional[float] = None
    occupied_cases: Optional[float] = None
    product_id: Optional[str] = None
    hold: Optional[bool] = None
    notes: Optional[str] = None
    is_active: Optional[bool] = None

class StorageRow(StorageRowBase):
    storage_area_id: Optional[str] = None
    sub_location_id: Optional[str] = None
    is_active: bool
    created_at: datetime

class StorageAreaBase(BaseSchema):
    id: str
    name: str
    location_id: str
    sub_location_id: Optional[str] = None
    allow_floor_storage: bool = False

class StorageAreaCreate(StorageAreaBase):
    rows: List[StorageRowCreate] = []

class StorageAreaUpdate(BaseSchema):
    name: Optional[str] = None
    location_id: Optional[str] = None
    sub_location_id: Optional[str] = None
    allow_floor_storage: Optional[bool] = None
    is_active: Optional[bool] = None

class StorageArea(StorageAreaBase):
    is_active: bool
    created_at: datetime
    rows: List[StorageRow] = []

# Production schemas
class ProductionShiftBase(BaseSchema):
    id: str
    name: str
    start_time: Optional[str] = None
    end_time: Optional[str] = None

class ProductionShiftCreate(ProductionShiftBase):
    pass

class ProductionShiftUpdate(BaseSchema):
    name: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    is_active: Optional[bool] = None

class ProductionShift(ProductionShiftBase):
    is_active: bool
    created_at: datetime

class ProductionLineBase(BaseSchema):
    id: str
    name: str
    description: Optional[str] = None

class ProductionLineCreate(ProductionLineBase):
    pass

class ProductionLineUpdate(BaseSchema):
    name: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None

class ProductionLine(ProductionLineBase):
    is_active: bool
    created_at: datetime

# Receipt schemas
class ReceiptAllocationBase(BaseSchema):
    storage_area_id: str
    pallet_quantity: float
    cases_quantity: float

class ReceiptAllocationCreate(ReceiptAllocationBase):
    pass

class ReceiptAllocation(ReceiptAllocationBase):
    id: int
    created_at: datetime

class ReceiptBase(BaseSchema):
    product_id: str
    category_id: Optional[str] = None
    lot_number: Optional[str] = None
    quantity: float
    unit: str = "cases"
    container_count: Optional[float] = None        # How many containers (barrels, bags, etc.)
    container_unit: Optional[str] = None            # Container type: barrels, bags, cases, etc.
    weight_per_container: Optional[float] = None    # Weight of each container
    weight_unit: Optional[str] = None               # Weight unit: lbs, kg, g, oz, etc.
    receipt_date: Optional[datetime] = None
    production_date: Optional[datetime] = None
    expiration_date: Optional[datetime] = None
    cases_per_pallet: Optional[int] = None
    full_pallets: Optional[int] = None
    partial_cases: int = 0
    loose_cases: int = 0
    quantity_produced: Optional[float] = None
    shift_id: Optional[str] = None
    line_id: Optional[str] = None
    bol: Optional[str] = None
    purchase_order: Optional[str] = None
    vendor_id: Optional[str] = None
    location_id: Optional[str] = None
    sub_location_id: Optional[str] = None
    storage_row_id: Optional[str] = None
    pallets: Optional[float] = None  # Pallet count for raw materials/packaging row occupancy
    hold: bool = False
    held_quantity: float = 0  # Quantity currently on hold
    hold_location: Optional[str] = Field(None, max_length=100)  # Row/location name on hold
    allocation: Optional[dict] = None
    note: Optional[str] = Field(None, max_length=5000)  # Max 5000 characters for notes

class ReceiptCreate(ReceiptBase):
    id: Optional[str] = None  # Allow frontend to provide ID
    allocations: List[ReceiptAllocationCreate] = []
    rawMaterialRowAllocations: Optional[List[dict]] = None  # Multiple row allocations for raw materials/packaging

class ReceiptUpdate(BaseSchema):
    lot_number: Optional[str] = None
    quantity: Optional[float] = None
    production_date: Optional[datetime] = None
    expiration_date: Optional[datetime] = None
    cases_per_pallet: Optional[int] = None
    full_pallets: Optional[int] = None
    has_partial_pallet: Optional[bool] = None
    cases_on_partial_pallet: Optional[int] = None
    quantity_produced: Optional[float] = None
    shift_id: Optional[str] = None
    line_id: Optional[str] = None
    bol: Optional[str] = None
    purchase_order: Optional[str] = None
    vendor_id: Optional[str] = None
    note: Optional[str] = None
    status: Optional[str] = None

class Receipt(ReceiptBase):
    id: str
    status: str
    pallets: Optional[float] = None  # Pallet count for raw materials/packaging row occupancy
    submitted_by: Optional[str] = None
    approved_by: Optional[str] = None
    approved_at: Optional[datetime] = None
    submitted_at: datetime
    created_at: datetime
    updated_at: Optional[datetime] = None
    allocations: List[ReceiptAllocation] = []

# Transfer schemas
class InventoryTransferBase(BaseSchema):
    receipt_id: str
    from_location_id: Optional[str] = None
    from_sub_location_id: Optional[str] = None
    to_location_id: Optional[str] = None
    to_sub_location_id: Optional[str] = None
    quantity: float
    unit: str = "cases"
    reason: Optional[str] = Field(None, max_length=1000)  # Max 1000 characters for reason
    transfer_type: str = "warehouse-transfer"  # warehouse-transfer, shipped-out
    order_number: Optional[str] = Field(None, max_length=100)
    source_breakdown: Optional[List[dict]] = None
    destination_breakdown: Optional[List[dict]] = None
    pallet_licence_ids: Optional[List[str]] = None  # Specific pallets for licence-aware transfers

class InventoryTransferCreate(InventoryTransferBase):
    pass

class InventoryTransferUpdate(BaseSchema):
    status: Optional[str] = None
    reason: Optional[str] = Field(None, max_length=1000)

class PalletLicenceTransferRef(BaseSchema):
    id: str
    licence_number: str
    cases: int = 0


class InventoryTransfer(InventoryTransferBase):
    id: str
    status: str
    requested_by: Optional[str] = None
    approved_by: Optional[str] = None
    approved_at: Optional[datetime] = None
    submitted_at: datetime
    created_at: datetime
    pallet_licence_details: Optional[List["PalletLicenceTransferRef"]] = None


class ShipOutPickListCreate(BaseSchema):
    """Create ship-out transfer with specific pallet licence IDs (pick list)"""
    receipt_id: str = Field(..., min_length=1)
    order_number: str = Field(..., min_length=1, max_length=100)
    pallet_licence_ids: List[str] = Field(..., min_length=1)


class ScanPickRequest(BaseSchema):
    """Forklift scan for ship-out picking"""
    licence_number: Optional[str] = Field(None, max_length=100)
    licence_id: Optional[str] = Field(None, max_length=50)


class ForkliftSubmitRequest(BaseSchema):
    """Forklift submits a ship-out pick as done (full or partial)"""
    notes: Optional[str] = Field(None, max_length=1000)
    skipped_pallet_ids: Optional[List[str]] = Field(default_factory=list)


# Adjustment schemas
class InventoryAdjustmentBase(BaseSchema):
    receipt_id: str
    category_id: Optional[str] = None
    product_id: Optional[str] = None
    adjustment_type: str
    quantity: float
    reason: str = Field(..., max_length=1000)  # Required, max 1000 characters
    recipient: Optional[str] = Field(None, max_length=100)
    source_breakdown: Optional[List[dict]] = None

class InventoryAdjustmentCreate(InventoryAdjustmentBase):
    pass

class InventoryAdjustmentUpdate(BaseSchema):
    status: Optional[str] = None
    reason: Optional[str] = Field(None, max_length=1000)

class InventoryAdjustment(InventoryAdjustmentBase):
    id: str
    status: str
    submitted_by: Optional[str] = None
    approved_by: Optional[str] = None
    approved_at: Optional[datetime] = None
    submitted_at: datetime
    created_at: datetime

# Hold Action schemas
class HoldItem(BaseSchema):
    receipt_id: str
    location_id: str
    quantity: float

class InventoryHoldActionBase(BaseSchema):
    receipt_id: Optional[str] = None  # For legacy full-lot holds
    action: str  # hold, release
    reason: str = Field(..., max_length=1000)  # Required, max 1000 characters
    hold_items: Optional[List[HoldItem]] = None  # For partial holds by location
    total_quantity: Optional[float] = None  # Total quantity being held

class InventoryHoldActionCreate(InventoryHoldActionBase):
    pass

class InventoryHoldActionUpdate(BaseSchema):
    status: Optional[str] = None
    reason: Optional[str] = Field(None, max_length=1000)

class InventoryHoldAction(InventoryHoldActionBase):
    id: str
    status: str
    submitted_by: Optional[str] = None
    approved_by: Optional[str] = None
    approved_at: Optional[datetime] = None
    submitted_at: datetime
    created_at: datetime

# Cycle Count schemas
class CycleCountBase(BaseSchema):
    location_id: str
    category_id: Optional[str] = None
    count_date: str  # Accept date string from frontend (e.g. "2025-12-19")
    items: List[dict]  # List of counted items with variances
    summary: dict  # Variance summary statistics
    performed_by: str
    performed_by_id: str

class CycleCountCreate(CycleCountBase):
    pass

class CycleCount(CycleCountBase):
    id: str
    created_at: datetime

# Staging schemas
class StagingItemBase(BaseSchema):
    transfer_id: str
    receipt_id: str
    product_id: str
    quantity_staged: float
    quantity_used: float = 0
    quantity_returned: float = 0
    pallets_staged: Optional[float] = None
    pallets_used: float = 0
    pallets_returned: float = 0
    original_storage_row_id: Optional[str] = None
    staging_storage_row_id: Optional[str] = None
    status: str = "staged"
    staging_batch_id: Optional[str] = None

class StagingItemCreate(StagingItemBase):
    pass

class StagingItemUpdate(BaseSchema):
    quantity_used: Optional[float] = None
    quantity_returned: Optional[float] = None
    status: Optional[str] = None

class StagingItem(StagingItemBase):
    id: str
    staged_at: datetime
    used_at: Optional[datetime] = None
    returned_at: Optional[datetime] = None

# Staging request schemas
class StagingLotSuggestion(BaseSchema):
    receipt_id: str
    lot_number: str
    location_id: Optional[str] = None
    location_name: Optional[str] = None
    sub_location_id: Optional[str] = None
    sub_location_name: Optional[str] = None
    storage_row_name: Optional[str] = None
    expiration_date: Optional[datetime] = None
    available_quantity: float
    unit: Optional[str] = "cases"
    # Container/weight info for warehouse-friendly display
    container_count: Optional[float] = None
    container_unit: Optional[str] = None
    weight_per_container: Optional[float] = None
    weight_unit: Optional[str] = None

class StagingLotRequest(BaseSchema):
    receipt_id: str
    quantity: float

class StagingItemRequest(BaseSchema):
    product_id: str
    quantity_needed: float
    lots: List[StagingLotRequest]  # Multiple lots for same product

class CreateStagingRequest(BaseSchema):
    staging_location_id: str
    staging_sub_location_id: Optional[str] = None
    items: List[StagingItemRequest]

class MarkStagingUsedRequest(BaseSchema):
    quantity: float

class ReturnStagingRequest(BaseSchema):
    quantity: float
    to_location_id: str
    to_sub_location_id: Optional[str] = None
    to_storage_row_id: Optional[str] = None  # Optional: specify which row/rack in return location

# Rebuild models to resolve forward references
SubLocation.model_rebuild()
