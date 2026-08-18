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
    # NOTE: `quantity` and `status` are intentionally NOT editable here.
    #  - `status` changes only through the dedicated /approve, /reject,
    #    /send-back, /resubmit endpoints (prevents approval bypass).
    #  - `quantity` for raw materials is derived from container_count ×
    #    weight_per_container; edit those fields and it is recomputed
    #    server-side. Editing it directly desynced rows/pallets/allocations.
    lot_number: Optional[str] = None
    # unit + container/weight fields ARE editable so a mislabeled lot can be
    # repaired. When container_count/weight_per_container change, the router
    # recomputes quantity and unit from them (mirrors receipt creation).
    unit: Optional[str] = None
    container_count: Optional[float] = None
    container_unit: Optional[str] = None
    weight_per_container: Optional[float] = None
    weight_unit: Optional[str] = None
    receipt_date: Optional[datetime] = None
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

class ReceiptAssignStorage(BaseSchema):
    location_id: Optional[str] = None
    sub_location_id: Optional[str] = None
    storage_row_id: Optional[str] = None
    pallets: Optional[float] = None
    cases_per_pallet: Optional[int] = None
    raw_material_row_allocations: Optional[List[dict]] = None


class Receipt(ReceiptBase):
    id: str
    status: str
    pallets: Optional[float] = None
    # Set once this receipt's material has a lot identity. Must be on the
    # RESPONSE schema: the approvals card uses it to decide whether there are
    # scanned unit counts to check against the paperwork, and a field the schema
    # omits is silently dropped no matter what the ORM object carries.
    material_lot_id: Optional[str] = None
    # Per-row content/pallet breakdown for RM/packaging lots — the All-Inventory
    # and lot-trace views read this to show per-row pallets. Must be on the
    # RESPONSE schema (it was previously only on the assign-storage request),
    # otherwise the frontend never receives it and falls back to receipt.pallets.
    raw_material_row_allocations: Optional[List[dict]] = None
    submitted_by: Optional[str] = None
    approved_by: Optional[str] = None
    approved_at: Optional[datetime] = None
    submitted_at: datetime
    created_at: datetime
    updated_at: Optional[datetime] = None
    allocations: List[ReceiptAllocation] = []
    # Populated by the create endpoint when FG pallet licences are generated
    # so the UI can show the exact range (e.g. "MP14426L1-MGN128O127-141
    # through ...-150") instead of guessing 001..N.
    generated_licence_first: Optional[str] = None
    generated_licence_last: Optional[str] = None
    generated_licence_count: Optional[int] = None
