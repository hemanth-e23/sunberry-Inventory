"""Wire shapes for lot-level receiving.

Two conventions worth stating because both were learned the hard way elsewhere
in this codebase:

* Every scan response has ONE shape with a `status` discriminator. The finished
  goods scan endpoint returns four different shapes from one route and its client
  detects outcomes by which fields are missing.
* `count_unit` is a real word for the material — "drums", "bags" — and never
  "cases". `Receipt.unit` defaults to "cases", and that default is how an
  80-barrel receipt once rendered as 80 cases.
"""

from datetime import datetime
from typing import List, Optional

from pydantic import Field

from app.schemas.base import BaseSchema


# ─── incoming orders ──────────────────────────────────────────────────────────

class IncomingOrderLineCreate(BaseSchema):
    product_id: str
    category_id: Optional[str] = None
    vendor_id: Optional[str] = None
    vendor_lot: Optional[str] = Field(None, max_length=100)
    bbd: Optional[datetime] = None
    expected_count: int = Field(0, ge=0)
    unit_label: Optional[str] = Field(None, max_length=20)
    weight_per_unit: Optional[float] = Field(None, ge=0)
    weight_unit: Optional[str] = Field(None, max_length=10)
    brix: Optional[float] = None


class IncomingOrderCreate(BaseSchema):
    vendor_id: Optional[str] = None
    bol: Optional[str] = Field(None, max_length=100)
    purchase_order: Optional[str] = Field(None, max_length=100)
    # Free text on purpose: a third-party warehouse is not in our warehouses
    # table, and creating rows for one would be master data nobody maintains.
    origin_name: Optional[str] = Field(None, max_length=120)
    origin_warehouse_id: Optional[str] = None
    expected_date: Optional[datetime] = None
    notes: Optional[str] = None
    lines: List[IncomingOrderLineCreate] = []


class IncomingOrderLineOut(BaseSchema):
    id: str
    product_id: str
    product_name: Optional[str] = None
    product_sid: Optional[str] = None
    vendor_id: Optional[str] = None
    vendor_lot: Optional[str] = None
    lot_unknown: bool = False
    bbd: Optional[datetime] = None
    expected_count: int = 0
    received_count: int = 0
    unit_label: Optional[str] = None
    weight_per_unit: Optional[float] = None
    weight_unit: Optional[str] = None
    brix: Optional[float] = None
    material_lot_id: Optional[str] = None
    lot_code: Optional[str] = None
    receipt_id: Optional[str] = None


class IncomingOrderOut(BaseSchema):
    id: str
    order_number: Optional[str] = None
    status: str
    vendor_id: Optional[str] = None
    vendor_name: Optional[str] = None
    bol: Optional[str] = None
    purchase_order: Optional[str] = None
    origin_name: Optional[str] = None
    origin_warehouse_id: Optional[str] = None
    warehouse_id: Optional[str] = None
    expected_date: Optional[datetime] = None
    expected_count: int = 0
    received_count: int = 0
    short_count: int = 0
    over_received: bool = False
    close_reason: Optional[str] = None
    notes: Optional[str] = None
    released_at: Optional[datetime] = None
    closed_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    lines: List[IncomingOrderLineOut] = []


class StartReceivingRequest(BaseSchema):
    """What the worker corrected against the driver's BOL.

    Corporate fills 99% of an order. This is the 1% — and it is why receiving is
    not just a button that says "yes, all of it arrived".
    """
    line_id: str
    vendor_lot: Optional[str] = Field(None, max_length=100)
    bbd: Optional[datetime] = None
    weight_per_unit: Optional[float] = Field(None, ge=0)
    expected_count: Optional[int] = Field(None, ge=0)
    bol: Optional[str] = Field(None, max_length=100)


class CloseOrderRequest(BaseSchema):
    reason: Optional[str] = None


# ─── scanning ─────────────────────────────────────────────────────────────────

class LotScanRequest(BaseSchema):
    # The sticker as the gun read it: either the bare lot code or the whole
    # SB2 envelope. The server unwraps it, so the gun never parses.
    lot_code: str = Field(..., min_length=1, max_length=120)
    storage_row_id: str = Field(..., min_length=1, max_length=50)
    # min_length matches the FG scan contract. Note a 422 here is TERMINAL in the
    # offline queue, so the gun must mint a long enough key.
    idempotency_key: Optional[str] = Field(None, min_length=8, max_length=64)
    allow_overfill: bool = False
    units: int = Field(1, ge=1, le=200)


class LotScanResponse(BaseSchema):
    """ONE shape for every outcome. `status` is the discriminator.

    'ok' | 'needs_confirm' | 'unknown_lot' | 'unknown_row' | 'lot_held' |
    'undone' | 'nothing_to_undo'

    Every one of these is an HTTP 200. A 4xx makes the offline queue park the
    scan as permanently failed and the driver loses it with no way to retry.
    """
    status: str
    message: str
    lot_code: Optional[str] = None
    lot_id: Optional[str] = None
    row_id: Optional[str] = None
    row_name: Optional[str] = None
    row_scanned_count: int = 0
    row_on_hand: Optional[int] = None
    session_scanned_count: int = 0
    session_expected_count: int = 0
    count_unit: str = "units"
    warning: Optional[str] = None
    warning_detail: Optional[str] = None
    scan_id: Optional[str] = None
    lot_mismatch: bool = False


# ─── labels ───────────────────────────────────────────────────────────────────

class LotLabel(BaseSchema):
    """One sticker. Every unit of a lot wears an identical one.

    No serial and no "17 of 80": there is no per-sticker identity to print. The
    QR carries `lot_code` and nothing else, so nothing on a printed label can go
    stale — everything else here is human-readable context.
    """
    lot_code: str
    product_name: str = ""
    product_sid: Optional[str] = None
    vendor_name: str = ""
    vendor_lot: Optional[str] = None
    lot_unknown: bool = False
    bbd: Optional[datetime] = None
    net_weight: Optional[float] = None
    weight_unit: Optional[str] = None
    unit_label: Optional[str] = None
    receipt_date: Optional[datetime] = None


class LotLabelSheet(BaseSchema):
    lot_code: str
    count: int
    labels: List[LotLabel] = []


class PrintLabelsRequest(BaseSchema):
    count: int = Field(..., ge=1, le=500)


# ─── the approval view ────────────────────────────────────────────────────────

class ReceivingRowCount(BaseSchema):
    storage_row_id: str
    storage_row_name: str
    count: int = 0


class ReceivingSummary(BaseSchema):
    receipt_id: str
    lot_code: Optional[str] = None
    vendor_lot: Optional[str] = None
    bbd: Optional[datetime] = None
    unit_label: Optional[str] = None
    count_unit: str = "units"
    expected_count: int = 0
    scanned_count: int = 0
    # scanned - expected. Negative is short, positive is over. Both are legal and
    # both are shown; neither blocks anything.
    difference: int = 0
    weight_per_unit: Optional[float] = None
    derived_weight: Optional[float] = None
    rows: List[ReceivingRowCount] = []
    source: str = "walk_in"
    order_number: Optional[str] = None
    order_id: Optional[str] = None
    needs_review: bool = False
    label_printed_at: Optional[datetime] = None
