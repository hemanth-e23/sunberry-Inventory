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


class LiveRowProduct(BaseSchema):
    product_id: str
    lot_number: Optional[str] = None
    pallets: int = 0
    cases: float = 0


class LiveRowLot(BaseSchema):
    """One lot sitting in one row, counted in whole units.

    The unit-room analogue of LiveRowProduct. `units` is the counted integer and
    `weight` is derived from it — never the other way round, because different
    vendors ship different weights per drum.
    """
    material_lot_id: str
    lot_code: str
    product_id: str
    vendor_lot_number: Optional[str] = None
    units: int = 0
    open_units: int = 0
    weight: float = 0
    weight_unit: Optional[str] = None
    bbd: Optional[datetime] = None
    is_held: bool = False


class StorageRowBase(BaseSchema):
    id: str
    name: str
    # The scannable rack label. Present on the model since alembic u6v7w8x9y0z1
    # but never exposed here, so master data could neither read nor set the field
    # the ingredient scanner resolves rows on.
    barcode: Optional[str] = None
    template: Optional[str] = None
    pallet_capacity: int = 0
    default_cases_per_pallet: int = 0
    occupied_pallets: float = 0
    occupied_cases: float = 0
    product_id: Optional[str] = None
    hold: bool = False
    notes: Optional[str] = None
    # Live aggregates computed from pallet_licences at read time.
    # Only populated for FG rows by the storage-areas endpoint; absent on RM rows
    # (which don't use pallet_licences). When present, clients should prefer
    # these over occupied_pallets / occupied_cases / product_id.
    live_pallets: Optional[float] = None
    live_cases: Optional[float] = None
    live_products: Optional[List[LiveRowProduct]] = None
    # Live aggregates computed from lot_placements. Populated for rows in a
    # unit-typed room (sub_location.storage_unit set); None everywhere else, so a
    # client can tell "no drums here" (0) from "this is a pallet room" (None).
    # What `occupied_cases` is measured in for this row — 'lbs' when it holds
    # lot-tracked material (the column stores derived weight there), None when
    # it keeps its legacy case meaning. Must be on the RESPONSE schema.
    content_unit: Optional[str] = None
    live_units: Optional[int] = None
    live_open_units: Optional[int] = None
    live_lots: Optional[List[LiveRowLot]] = None

class StorageRowCreate(StorageRowBase):
    storage_area_id: Optional[str] = None
    sub_location_id: Optional[str] = None

class StorageRowUpdate(BaseSchema):
    name: Optional[str] = None
    barcode: Optional[str] = None
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
    # What one stored unit IS in this room, and how many fit in one of its rows.
    # NULL means pallets — today's behaviour, so every existing room is unchanged.
    # Set once per room and inherited by its rows; see models/location.py for why
    # this is not StorageRow.pallet_capacity.
    storage_unit: Optional[str] = None
    unit_capacity: Optional[int] = None

class SubLocationCreate(SubLocationBase):
    pass

class SubLocationUpdate(BaseSchema):
    name: Optional[str] = None
    location_id: Optional[str] = None
    storage_unit: Optional[str] = None
    unit_capacity: Optional[int] = None
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
