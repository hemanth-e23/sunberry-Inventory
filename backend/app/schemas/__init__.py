from pydantic import BaseModel, EmailStr
from typing import Optional, List
from datetime import datetime

# Base schemas
class BaseSchema(BaseModel):
    class Config:
        from_attributes = True

# User schemas
class UserBase(BaseSchema):
    username: str
    name: str
    email: EmailStr
    role: str

class UserCreate(UserBase):
    password: str

class UserUpdate(BaseSchema):
    username: Optional[str] = None
    name: Optional[str] = None
    email: Optional[EmailStr] = None
    role: Optional[str] = None
    is_active: Optional[bool] = None
    password: Optional[str] = None

class User(UserBase):
    id: str
    is_active: bool
    created_at: datetime

# Auth schemas
class Token(BaseSchema):
    access_token: str
    token_type: str

class TokenData(BaseSchema):
    username: Optional[str] = None

class LoginRequest(BaseSchema):
    username: str
    password: str

# Category schemas
class CategoryGroupBase(BaseSchema):
    id: str
    name: str
    description: Optional[str] = None

class CategoryGroupCreate(CategoryGroupBase):
    pass

class CategoryGroupUpdate(BaseSchema):
    name: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None

class CategoryGroup(CategoryGroupBase):
    is_active: bool
    created_at: datetime

class CategoryBase(BaseSchema):
    id: str
    name: str
    type: str
    parent_id: Optional[str] = None

class CategoryCreate(CategoryBase):
    pass

class CategoryUpdate(BaseSchema):
    name: Optional[str] = None
    type: Optional[str] = None
    parent_id: Optional[str] = None
    is_active: Optional[bool] = None

class Category(CategoryBase):
    is_active: bool
    created_at: datetime

# Vendor schemas
class VendorBase(BaseSchema):
    id: str
    name: str
    contact_person: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None

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
    fcc_code: Optional[str] = None
    sid: Optional[str] = None
    brix: Optional[float] = None
    category_id: str
    vendor_id: Optional[str] = None
    description: Optional[str] = None
    default_cases_per_pallet: Optional[int] = None
    expire_years: Optional[int] = None
    quantity_uom: Optional[str] = None

class ProductCreate(ProductBase):
    pass

class ProductUpdate(BaseSchema):
    name: Optional[str] = None
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

class Product(ProductBase):
    is_active: bool
    created_at: datetime

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
    hold_location: Optional[str] = None  # Row/location name on hold
    allocation: Optional[dict] = None
    note: Optional[str] = None

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
    reason: Optional[str] = None
    transfer_type: str = "warehouse-transfer"  # warehouse-transfer, shipped-out
    order_number: Optional[str] = None
    source_breakdown: Optional[List[dict]] = None
    destination_breakdown: Optional[List[dict]] = None

class InventoryTransferCreate(InventoryTransferBase):
    pass

class InventoryTransferUpdate(BaseSchema):
    status: Optional[str] = None
    reason: Optional[str] = None

class InventoryTransfer(InventoryTransferBase):
    id: str
    status: str
    requested_by: Optional[str] = None
    approved_by: Optional[str] = None
    approved_at: Optional[datetime] = None
    submitted_at: datetime
    created_at: datetime

# Adjustment schemas
class InventoryAdjustmentBase(BaseSchema):
    receipt_id: str
    category_id: Optional[str] = None
    product_id: Optional[str] = None
    adjustment_type: str
    quantity: float
    reason: str
    recipient: Optional[str] = None
    source_breakdown: Optional[List[dict]] = None

class InventoryAdjustmentCreate(InventoryAdjustmentBase):
    pass

class InventoryAdjustmentUpdate(BaseSchema):
    status: Optional[str] = None
    reason: Optional[str] = None

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
    reason: str
    hold_items: Optional[List[HoldItem]] = None  # For partial holds by location
    total_quantity: Optional[float] = None  # Total quantity being held

class InventoryHoldActionCreate(InventoryHoldActionBase):
    pass

class InventoryHoldActionUpdate(BaseSchema):
    status: Optional[str] = None
    reason: Optional[str] = None

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
