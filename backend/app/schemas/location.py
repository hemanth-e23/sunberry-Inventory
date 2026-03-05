from __future__ import annotations

from typing import Optional, List
from datetime import datetime
from app.schemas.base import BaseSchema


class LocationBase(BaseSchema):
    id: str
    name: str
    description: Optional[str] = None

class LocationCreate(LocationBase):
    pass

class LocationUpdate(BaseSchema):
    name: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None

class Location(LocationBase):
    is_active: bool
    created_at: datetime


class StorageRowBase(BaseSchema):
    id: str
    name: str
    template: Optional[str] = None
    pallet_capacity: int = 0
    default_cases_per_pallet: int = 0
    occupied_pallets: float = 0
    occupied_cases: float = 0
    product_id: Optional[str] = None
    hold: bool = False
    notes: Optional[str] = None

class StorageRowCreate(StorageRowBase):
    storage_area_id: Optional[str] = None
    sub_location_id: Optional[str] = None

class StorageRowUpdate(BaseSchema):
    name: Optional[str] = None
    template: Optional[str] = None
    pallet_capacity: Optional[int] = None
    default_cases_per_pallet: Optional[int] = None
    occupied_pallets: Optional[float] = None
    occupied_cases: Optional[float] = None
    product_id: Optional[str] = None
    hold: Optional[bool] = None
    notes: Optional[str] = None
    is_active: Optional[bool] = None

class StorageRow(StorageRowBase):
    storage_area_id: Optional[str] = None
    sub_location_id: Optional[str] = None
    is_active: bool
    created_at: datetime


class SubLocationBase(BaseSchema):
    id: str
    name: str
    location_id: str

class SubLocationCreate(SubLocationBase):
    pass

class SubLocationUpdate(BaseSchema):
    name: Optional[str] = None
    location_id: Optional[str] = None
    is_active: Optional[bool] = None

class SubLocation(SubLocationBase):
    is_active: bool
    created_at: datetime
    rows: List[StorageRow] = []


class StorageAreaBase(BaseSchema):
    id: str
    name: str
    location_id: str
    sub_location_id: Optional[str] = None
    allow_floor_storage: bool = False

class StorageAreaCreate(StorageAreaBase):
    rows: List[StorageRowCreate] = []

class StorageAreaUpdate(BaseSchema):
    name: Optional[str] = None
    location_id: Optional[str] = None
    sub_location_id: Optional[str] = None
    allow_floor_storage: Optional[bool] = None
    is_active: Optional[bool] = None

class StorageArea(StorageAreaBase):
    is_active: bool
    created_at: datetime
    rows: List[StorageRow] = []


class ProductionShiftBase(BaseSchema):
    id: str
    name: str
    start_time: Optional[str] = None
    end_time: Optional[str] = None

class ProductionShiftCreate(ProductionShiftBase):
    pass

class ProductionShiftUpdate(BaseSchema):
    name: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    is_active: Optional[bool] = None

class ProductionShift(ProductionShiftBase):
    is_active: bool
    created_at: datetime


class ProductionLineBase(BaseSchema):
    id: str
    name: str
    description: Optional[str] = None

class ProductionLineCreate(ProductionLineBase):
    pass

class ProductionLineUpdate(BaseSchema):
    name: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None

class ProductionLine(ProductionLineBase):
    is_active: bool
    created_at: datetime


SubLocation.model_rebuild()
