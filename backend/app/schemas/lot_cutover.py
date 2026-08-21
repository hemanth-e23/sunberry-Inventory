"""Wire shapes for the cutover onto the lot model."""

from datetime import datetime
from typing import List, Optional

from pydantic import Field

from app.schemas.base import BaseSchema, CalendarDateOut, CalendarDateTime


class ZeroOutProduct(BaseSchema):
    product_id: str
    product_name: str = ""
    receipts: int = 0
    quantity: float = 0
    unit: Optional[str] = None
    # The AS-RECEIVED count, frozen at delivery. A sanity hint for whoever is
    # about to walk the rack and nothing more — using it as an opening balance
    # would restore stock production already consumed.
    as_received_units_hint: int = 0


class ZeroOutPreview(BaseSchema):
    warehouse_id: Optional[str] = None
    receipt_count: int = 0
    total_quantity: float = 0
    products: List[ZeroOutProduct] = []
    already_counted_lots: int = 0


class ZeroOutRequest(BaseSchema):
    # Required in the body rather than inferred: this is the one call in the
    # cutover that cannot be undone by pressing something else.
    confirm: bool = False
    note: Optional[str] = None


class ZeroOutResult(BaseSchema):
    zeroed: int = 0
    warehouse_id: Optional[str] = None
    at: Optional[datetime] = None


class OpeningBalanceRequest(BaseSchema):
    product_id: str
    storage_row_id: str
    full_units: int = Field(..., ge=0)
    vendor_id: Optional[str] = None
    vendor_lot: Optional[str] = Field(None, max_length=100)
    # Accepts a bare YYYY-MM-DD from <input type="date"> — see schemas/base.py.
    bbd: CalendarDateTime = None
    unit_label: str = Field("drum", max_length=20)
    weight_per_unit: Optional[float] = Field(None, ge=0)
    weight_unit: Optional[str] = Field(None, max_length=10)
    # Partials live in a cooler, not back on the rack — so an opening balance for
    # a cooler row carries opened units and their remaining weight.
    open_units: int = Field(0, ge=0)
    open_remaining_qty: float = Field(0, ge=0)
    note: Optional[str] = None
    # NO warehouse_id. It is resolved server-side from the caller. Accepting one
    # here let any warehouse user mint stock into another plant's inventory by
    # naming it in the request body — the client does not get to choose whose
    # books it is writing to.


class OpeningBalanceResult(BaseSchema):
    material_lot_id: str
    lot_code: str
    product_id: str
    product_name: str = ""
    storage_row_id: str
    storage_row_name: str = ""
    full_units: int = 0
    open_units: int = 0
    unit_label: Optional[str] = None
    derived_weight: float = 0
    weight_unit: Optional[str] = None
    needs_labels: bool = True


class CountRowRequest(BaseSchema):
    material_lot_id: str
    storage_row_id: str
    full_units: int = Field(..., ge=0)
    open_units: int = Field(0, ge=0)
    open_remaining_qty: float = Field(0, ge=0)
    note: Optional[str] = None


class CountRowResult(BaseSchema):
    material_lot_id: str
    lot_code: str
    storage_row_id: str
    storage_row_name: str = ""
    system_units: int = 0
    counted_units: int = 0
    # Signed and in WHOLE UNITS. Positive is found, negative is missing.
    variance: int = 0
    unit_label: Optional[str] = None
    derived_weight: float = 0


class UnlabelledLot(BaseSchema):
    material_lot_id: str
    lot_code: str
    product_id: str
    product_name: str = ""
    vendor_name: str = ""
    vendor_lot: Optional[str] = None
    lot_unknown: bool = False
    bbd: CalendarDateOut = None
    unit_label: Optional[str] = None
    full_units: int = 0
    open_units: int = 0
    row_count: int = 0
    needs_review: bool = False
    # Non-null when stickers cannot be printed for this lot yet — a missing lot
    # number or best-by, or a flagged review.
    blocked_reason: Optional[str] = None


class CutoverStatus(BaseSchema):
    warehouse_id: Optional[str] = None
    legacy_receipts_with_stock: int = 0
    counted_lots: int = 0
    lots_awaiting_labels: int = 0
    # 'zero_out' | 'opening_balances' | 'labelling' | 'complete'
    step: str = "zero_out"
