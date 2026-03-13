from typing import Optional, List
from datetime import datetime
from pydantic import Field
from app.schemas.base import BaseSchema


class WarehouseFull(BaseSchema):
    id: str
    name: str
    code: str
    type: str
    address: Optional[str] = None
    contact_person: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    timezone: str
    is_active: bool
    allow_product_creation: bool = False
    created_at: datetime


class WarehouseCreate(BaseSchema):
    id: str = Field(..., min_length=3, max_length=50, description="Unique warehouse ID, e.g. wh-plant-b")
    name: str = Field(..., min_length=1, max_length=100)
    code: str = Field(..., min_length=1, max_length=20, description="Short code, e.g. PLT-B")
    type: str = Field(..., description="owned, partner, or corporate")
    address: Optional[str] = None
    contact_person: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    timezone: str = "America/New_York"


class WarehouseUpdate(BaseSchema):
    name: Optional[str] = None
    code: Optional[str] = Field(None, max_length=20)
    type: Optional[str] = None
    address: Optional[str] = None
    contact_person: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    timezone: Optional[str] = None
    is_active: Optional[bool] = None
    allow_product_creation: Optional[bool] = None


class WarehouseCategoryAccessOut(BaseSchema):
    id: int
    warehouse_id: str
    category_group_id: str
    created_at: datetime


class WarehouseCategoryAccessCreate(BaseSchema):
    category_group_id: str


class InterWarehouseTransferCreate(BaseSchema):
    from_warehouse_id: str
    to_warehouse_id: str
    product_id: str
    lot_number: Optional[str] = None
    quantity: float
    unit: str = "cases"
    source_receipt_id: Optional[str] = None
    reference_number: Optional[str] = None
    expected_arrival_date: Optional[datetime] = None
    notes: Optional[str] = None


class InterWarehouseTransferAction(BaseSchema):
    notes: Optional[str] = None


class InterWarehouseTransferConfirmAction(BaseSchema):
    source_receipt_id: Optional[str] = None
    source_breakdown: Optional[List[dict]] = None
    pallet_licence_ids: Optional[List[str]] = None
    notes: Optional[str] = None


class InterWarehouseTransferDisputeAction(BaseSchema):
    dispute_reason: str


class ReceiptSummary(BaseSchema):
    id: str
    lot_number: Optional[str] = None
    quantity: float
    unit: str
    status: str
    receipt_date: Optional[datetime] = None
    container_count: Optional[float] = None
    container_unit: Optional[str] = None
    weight_per_container: Optional[float] = None
    category_id: Optional[str] = None
    storage_row_id: Optional[str] = None
    pallets: Optional[float] = None
    cases_per_pallet: Optional[float] = None
    raw_material_row_allocations: Optional[List[dict]] = None
    allocation: Optional[dict] = None


class WarehouseInfo(BaseSchema):
    id: str
    name: str
    code: str
    type: str


class ProductBasic(BaseSchema):
    id: str
    name: str
    fcc_code: Optional[str] = None


class InitiatorInfo(BaseSchema):
    id: str
    name: str
    username: str


class SourceReceiptInfo(BaseSchema):
    id: str
    container_count: Optional[float] = None
    container_unit: Optional[str] = None
    weight_per_container: Optional[float] = None


class InterWarehouseTransferOut(BaseSchema):
    id: str
    from_warehouse_id: str
    to_warehouse_id: str
    product_id: str
    lot_number: Optional[str] = None
    quantity: float
    unit: str
    status: str
    source_receipt_id: Optional[str] = None
    destination_receipt_id: Optional[str] = None
    reference_number: Optional[str] = None
    expected_arrival_date: Optional[datetime] = None
    actual_arrival_date: Optional[datetime] = None
    notes: Optional[str] = None
    dispute_reason: Optional[str] = None
    initiated_by: str
    confirmed_by: Optional[str] = None
    received_by: Optional[str] = None
    initiated_at: datetime
    confirmed_at: Optional[datetime] = None
    shipped_at: Optional[datetime] = None
    received_at: Optional[datetime] = None
    inventory_deducted: bool = False
    source_breakdown: Optional[List[dict]] = None
    pallet_licence_ids: Optional[List[str]] = None
    from_warehouse: Optional[WarehouseInfo] = None
    to_warehouse: Optional[WarehouseInfo] = None
    product: Optional[ProductBasic] = None
    initiator: Optional[InitiatorInfo] = None
    source_receipt: Optional[SourceReceiptInfo] = None
