from typing import Optional, List
from datetime import datetime
from pydantic import Field
from app.schemas.base import BaseSchema


class ScanPalletRequest(BaseSchema):
    licence_number: str = Field(..., min_length=1, max_length=100)
    storage_row_id: str = Field(..., min_length=1, max_length=50)
    is_partial: bool = False
    partial_cases: Optional[int] = Field(None, ge=0)
    # Idempotency key set by the offline-resilient scan queue: when the
    # client retries a request after a network drop, the server returns
    # the original pallet instead of creating a duplicate.
    idempotency_key: Optional[str] = Field(None, min_length=8, max_length=64)


class MarkMissingRequest(BaseSchema):
    licence_numbers: List[str] = Field(..., min_length=1)


class PalletLicenceBase(BaseSchema):
    licence_number: str
    product_id: str
    lot_number: str
    storage_area_id: Optional[str] = None
    storage_row_id: Optional[str] = None
    cases: int
    is_partial: bool = False
    is_held: bool = False
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
    storage_area_name: Optional[str] = None
    storage_row_name: Optional[str] = None
    location: Optional[str] = None
    expiration_date: Optional[datetime] = None

class PalletLicenceUpdate(BaseSchema):
    cases: Optional[int] = None
    is_partial: Optional[bool] = None
    # Below fields enable the "Fix" flow for missing-sticker placeholders:
    # warehouse worker replaces the guessed licence with the real sticker's
    # number, assigns a storage row, and flips status pending → in-stock-eligible.
    licence_number: Optional[str] = None
    storage_row_id: Optional[str] = None
    status: Optional[str] = None


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
    licence_number: str = Field(..., min_length=1, max_length=100)

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
    last_activity_at: Optional[datetime] = None
    auto_submitted_at: Optional[datetime] = None
    cancelled_at: Optional[datetime] = None
    cancelled_by: Optional[str] = None
    cancelled_reason: Optional[str] = None
    rejected_at: Optional[datetime] = None
    rejected_by: Optional[str] = None
    pallet_licences: List[PalletLicence] = []
    product: Optional[ForkliftRequestProductRef] = None

class ForkliftRequestUpdate(BaseSchema):
    shift_id: Optional[str] = None
    line_id: Optional[str] = None
    production_date: Optional[datetime] = None
    expiration_date: Optional[datetime] = None
    cases_per_pallet: Optional[int] = None
    lot_number: Optional[str] = None
