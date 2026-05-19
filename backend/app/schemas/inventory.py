from typing import Optional, List
from datetime import datetime, date
from pydantic import Field
from app.schemas.base import BaseSchema


# Transfer schemas
class InventoryTransferBase(BaseSchema):
    receipt_id: Optional[str] = None
    from_location_id: Optional[str] = None
    from_sub_location_id: Optional[str] = None
    to_location_id: Optional[str] = None
    to_sub_location_id: Optional[str] = None
    quantity: float
    unit: str = "cases"
    reason: Optional[str] = Field(None, max_length=1000)
    transfer_type: str = "warehouse-transfer"
    order_number: Optional[str] = Field(None, max_length=100)
    source_breakdown: Optional[List[dict]] = None
    destination_breakdown: Optional[List[dict]] = None
    pallet_licence_ids: Optional[List[str]] = None

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
    pallet_licence_details: Optional[List[PalletLicenceTransferRef]] = None


class ShipOutPalletPick(BaseSchema):
    """A pallet selection from a single receipt within one ship-out line."""
    receipt_id: str = Field(..., min_length=1)
    pallet_licence_ids: List[str] = Field(..., min_length=1)


class ShipOutLineCreate(BaseSchema):
    """One product line within a ship-out order (can span multiple receipts)."""
    product_id: str = Field(..., min_length=1)
    cases_requested: float = Field(..., gt=0)
    picks: List[ShipOutPalletPick] = Field(..., min_length=1)


class ShipOutPickListCreate(BaseSchema):
    """Create a multi-product ship-out order. Each line is one product; picks within
    a line span the receipts FIFO is pulling from."""
    order_number: str = Field(..., min_length=1, max_length=100)
    lines: List[ShipOutLineCreate] = Field(..., min_length=1)


class TransferEditLineUpdate(BaseSchema):
    """Update an existing line on a ship-out (after forklift submit, pre-approval)."""
    line_id: str = Field(..., min_length=1)
    cases_requested: Optional[float] = Field(None, gt=0)
    pallet_licence_ids: Optional[List[str]] = None  # full replacement set if provided


class TransferEditRequest(BaseSchema):
    """Warehouse user edits to a forklift-submitted ship-out before approval."""
    line_updates: List[TransferEditLineUpdate] = Field(default_factory=list)
    add_lines: List[ShipOutLineCreate] = Field(default_factory=list)
    remove_line_ids: List[str] = Field(default_factory=list)


class TransferVoidRequest(BaseSchema):
    """Void a ship-out order (any non-approved/voided status)."""
    reason: Optional[str] = Field(None, max_length=1000)


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
    receipt_id: Optional[str] = None
    category_id: Optional[str] = None
    product_id: Optional[str] = None
    adjustment_type: str
    quantity: float = 0
    reason: str = Field(..., max_length=1000)
    recipient: Optional[str] = Field(None, max_length=100)
    source_breakdown: Optional[List[dict]] = None
    pallet_licence_ids: Optional[List[str]] = None

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
    receipt_id: Optional[str] = None
    action: str  # hold, release
    reason: str = Field(..., max_length=1000)
    hold_items: Optional[List[HoldItem]] = None
    total_quantity: Optional[float] = None
    pallet_licence_ids: Optional[List[str]] = None

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
    location_id: Optional[str] = None
    category_id: Optional[str] = None
    count_date: date
    items: List[dict]
    summary: dict
    performed_by: str
    performed_by_id: str

class CycleCountCreate(CycleCountBase):
    pass

class CycleCount(CycleCountBase):
    id: str
    created_at: datetime
