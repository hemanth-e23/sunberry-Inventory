from typing import Optional, List
from datetime import datetime
from pydantic import Field
from app.schemas.base import BaseSchema


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
    container_count: Optional[float] = None
    container_unit: Optional[str] = None
    weight_per_container: Optional[float] = None
    weight_unit: Optional[str] = None
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
    pallets: Optional[float] = None
    hold: bool = False
    held_quantity: float = 0
    hold_location: Optional[str] = Field(None, max_length=100)
    allocation: Optional[dict] = None
    note: Optional[str] = Field(None, max_length=5000)

class ReceiptCreate(ReceiptBase):
    id: Optional[str] = None
    allocations: List[ReceiptAllocationCreate] = []
    rawMaterialRowAllocations: Optional[List[dict]] = None

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
    pallets: Optional[float] = None
    submitted_by: Optional[str] = None
    approved_by: Optional[str] = None
    approved_at: Optional[datetime] = None
    submitted_at: datetime
    created_at: datetime
    updated_at: Optional[datetime] = None
    allocations: List[ReceiptAllocation] = []
