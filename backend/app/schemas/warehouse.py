from typing import Optional
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
    timezone: str = "America/Los_Angeles"


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
    reference_number: Optional[str] = None
    expected_arrival_date: Optional[datetime] = None
    notes: Optional[str] = None


class InterWarehouseTransferAction(BaseSchema):
    notes: Optional[str] = None


class InterWarehouseTransferDisputeAction(BaseSchema):
    dispute_reason: str


class WarehouseInfo(BaseSchema):
    id: str
    name: str
    code: str
    type: str


class ProductBasic(BaseSchema):
    id: str
    name: str
    fcc_code: Optional[str] = None


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
    from_warehouse: Optional[WarehouseInfo] = None
    to_warehouse: Optional[WarehouseInfo] = None
    product: Optional[ProductBasic] = None
