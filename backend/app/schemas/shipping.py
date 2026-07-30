from typing import Optional, List
from datetime import datetime, date
from app.schemas.base import BaseSchema


class PackageSizeBase(BaseSchema):
    label: str
    case_weight: Optional[float] = None
    sort_order: int = 0
    is_active: bool = True


class PackageSizeCreate(PackageSizeBase):
    pass


class PackageSizeUpdate(BaseSchema):
    label: Optional[str] = None
    case_weight: Optional[float] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None


class PackageSize(PackageSizeBase):
    id: str
    created_at: Optional[datetime] = None


# ---- Ship-to locations & carriers (self-populating master data) ----

class ShipToLocationOut(BaseSchema):
    id: str
    customer_name: str
    location_name: str
    address_line1: Optional[str] = None
    address_line2: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    zip_code: Optional[str] = None
    is_active: bool = True


class ShipToLocationInput(BaseSchema):
    """Either an existing id, or fields for a new self-populated location."""
    id: Optional[str] = None
    customer_name: Optional[str] = None
    location_name: Optional[str] = None
    address_line1: Optional[str] = None
    address_line2: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    zip_code: Optional[str] = None


class CarrierOut(BaseSchema):
    id: str
    name: str
    is_active: bool = True


class PalletTypeOut(BaseSchema):
    id: str
    code: str
    name: str
    pallet_weight: float
    is_default: bool = False
    is_active: bool = True


# ---- Scheduled ship-out order create (SPEC Task 2) ----

class ScheduledOrderLine(BaseSchema):
    product_id: str
    cases_requested: float


class ScheduledOrderCreate(BaseSchema):
    order_number: str
    scheduled_date: date
    appointment_time: Optional[str] = None
    po_number: Optional[str] = None
    carrier: Optional[str] = None          # name; find-or-create
    pallet_type_id: Optional[str] = None
    ship_to: Optional[ShipToLocationInput] = None
    lines: List[ScheduledOrderLine]


class RescheduleRequest(BaseSchema):
    scheduled_date: Optional[date] = None
    appointment_time: Optional[str] = None


class CheckInRequest(BaseSchema):
    """Yard check-in (Task 4). All optional here; required at doc generation.
    `carrier` is pre-filled from the corporate schedule but can change at the
    yard (a different carrier shows up), so it's editable here too."""
    carrier: Optional[str] = None
    driver_name: Optional[str] = None
    driver_license: Optional[str] = None
    truck_number: Optional[str] = None
    truck_license: Optional[str] = None
    trailer_number: Optional[str] = None
    trailer_license: Optional[str] = None
    time_in: Optional[datetime] = None


class SelectPalletRequest(BaseSchema):
    licence_number: str


class AdjustPalletCasesRequest(BaseSchema):
    """Trim a fully-scanned pallet to a partial: ship `cases`, return the rest."""
    pallet_licence_id: str
    cases: int


class ManualAttributionRequest(BaseSchema):
    product_id: str
    lot_number: str
    cases: float
    reason: Optional[str] = None


class RemoveManualAttributionRequest(BaseSchema):
    line_id: str
    index: int


class ReconcileRequest(BaseSchema):
    confirm_short: bool = False
    confirm_over: bool = False


class GenerateDocsRequest(BaseSchema):
    seal_number: Optional[str] = None
    time_out: Optional[datetime] = None
    pallet_count_override: Optional[int] = None


class VoidDocsRequest(BaseSchema):
    reason: str
