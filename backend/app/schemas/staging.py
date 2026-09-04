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


class StagingRack(BaseSchema):
    """One rack holding some of a lot, and how much of it can be pulled."""
    storage_row_id: str
    storage_row_name: str = ""
    available_units: int = 0
    held_units: int = 0


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

    # ── counted lots ────────────────────────────────────────────────────────
    # Set when this lot's location is tracked as placements. `is_counted` is
    # what the screen switches on: a counted lot is pulled as whole containers
    # off named racks, so asking for a weight and a pallet count describes
    # something nobody does. Absent on legacy receipts, where the old weight
    # entry is still the only thing that can be answered.
    is_counted: bool = False
    unit_label: Optional[str] = None
    # Containers free to pull — quarantined ones are excluded, so this is what
    # can actually be taken rather than what is standing there.
    available_units: int = 0
    held_units: int = 0
    racks: List[StagingRack] = []


class StagingLotRequest(BaseSchema):
    receipt_id: str
    quantity: float
    # Explicit pallets emptied from the rack when staging this lot (worker-entered).
    # None falls back to a proportional estimate from the lot's real pallets.
    pallets: Optional[float] = None

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
    # Explicit pallets returned to the rack (worker-entered). None falls back to
    # a proportional estimate from the staged pallets.
    pallets: Optional[float] = None
