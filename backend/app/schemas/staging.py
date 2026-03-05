from typing import Optional, List
from datetime import datetime
from app.schemas.base import BaseSchema


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
    lots: List[StagingLotRequest]

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
    to_storage_row_id: Optional[str] = None
