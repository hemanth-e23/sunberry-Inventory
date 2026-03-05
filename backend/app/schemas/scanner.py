from typing import Optional, List
from datetime import datetime
from pydantic import Field
from app.schemas.base import BaseSchema


class ScanPalletRequest(BaseSchema):
    licence_number: str = Field(..., min_length=1, max_length=100)
    storage_row_id: str = Field(..., min_length=1, max_length=50)
    is_partial: bool = False
    partial_cases: Optional[int] = Field(None, ge=0)


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

class PalletLicenceUpdate(BaseSchema):
    cases: Optional[int] = None
    is_partial: Optional[bool] = None


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
    pallet_licences: List[PalletLicence] = []
    product: Optional[ForkliftRequestProductRef] = None

class ForkliftRequestUpdate(BaseSchema):
    shift_id: Optional[str] = None
    line_id: Optional[str] = None
    production_date: Optional[datetime] = None
    expiration_date: Optional[datetime] = None
    cases_per_pallet: Optional[int] = None
    lot_number: Optional[str] = None
