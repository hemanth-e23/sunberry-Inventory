"""Schemas for active line production + palletizer mint/reprint endpoints."""
from datetime import datetime
from typing import List, Optional
from pydantic import Field

from app.schemas.base import BaseSchema


class ProductMini(BaseSchema):
    id: str
    name: str
    short_code: Optional[str] = None
    fcc_code: Optional[str] = None
    default_cases_per_pallet: Optional[int] = None
    expire_years: Optional[int] = None
    customer_name: Optional[str] = None
    customer_item_number: Optional[str] = None
    customer_upc: Optional[str] = None


class ProductionLineMini(BaseSchema):
    id: str
    name: str
    warehouse_id: Optional[str] = None


class ActiveLineProductionRead(BaseSchema):
    id: str
    line_id: str
    product_id: str
    lot_number: str
    last_printed_seq: int
    set_at: datetime
    set_by_user_id: str
    is_active: bool
    product: Optional[ProductMini] = None


class ProductionLineWithActive(BaseSchema):
    line: ProductionLineMini
    active: Optional[ActiveLineProductionRead] = None


class SetActiveProductionRequest(BaseSchema):
    product_id: str


class MintPalletsRequest(BaseSchema):
    count: int = Field(..., ge=1, le=200)


class MintedPallet(BaseSchema):
    sequence: int
    licence_number: str


class MintPalletsResponse(BaseSchema):
    pallets: List[MintedPallet]
    lot_number: str
    product: ProductMini
    bbd: Optional[str] = None  # ISO date YYYY-MM-DD plant-local; None if no expire_years


class RecentPalletsResponse(BaseSchema):
    lot_number: str
    last_printed_seq: int
    pallets: List[MintedPallet]
