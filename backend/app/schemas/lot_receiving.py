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

from pydantic import Field, field_validator

from app.schemas.base import BaseSchema, CalendarDateOut, CalendarDateTime


# ─── incoming orders ──────────────────────────────────────────────────────────

def _blank_to_none(value):
    """`""` is not an id. It is what an untouched <select> sends.

    `Optional[str]` accepts the empty string happily, so it reaches Postgres as
    a foreign key pointing at a row whose id is "" — and the insert dies with
    `Key (vendor_id)=() is not present in table "vendors"`. Every nullable FK
    a form can leave blank needs this, not just the one that broke.
    """
    if isinstance(value, str) and not value.strip():
        return None
    return value


class IncomingOrderLineCreate(BaseSchema):
    product_id: str
    category_id: Optional[str] = None
    vendor_id: Optional[str] = None
    _blank_fks = field_validator("category_id", "vendor_id", mode="before")(
        _blank_to_none
    )
    vendor_lot: Optional[str] = Field(None, max_length=100)
    # Accepts a bare YYYY-MM-DD from <input type="date"> — see schemas/base.py.
    bbd: CalendarDateTime = None
    expected_count: int = Field(0, ge=0)
    unit_label: Optional[str] = Field(None, max_length=20)
    weight_per_unit: Optional[float] = Field(None, ge=0)
    # Pounds. Accepted for completeness, but the forms do not offer a choice —
    # see find_or_create_lot for why one canonical unit matters here.
    weight_unit: Optional[str] = Field("lbs", max_length=10)
    # Bags/boxes per pallet. Leave NULL for drums and totes — they are stickered
    # individually, so one scan is one unit and there is no multiplier.
    units_per_pallet: Optional[int] = Field(None, ge=1, le=500)
    brix: Optional[float] = None


class IncomingOrderCreate(BaseSchema):
    vendor_id: Optional[str] = None
    _blank_vendor = field_validator("vendor_id", "origin_warehouse_id", mode="before")(
        _blank_to_none
    )
    bol: Optional[str] = Field(None, max_length=100)
    purchase_order: Optional[str] = Field(None, max_length=100)
    # Free text on purpose: a third-party warehouse is not in our warehouses
    # table, and creating rows for one would be master data nobody maintains.
    origin_name: Optional[str] = Field(None, max_length=120)
    origin_warehouse_id: Optional[str] = None
    expected_date: CalendarDateTime = None
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
    # YYYY-MM-DD — a calendar day, not an instant. See schemas/base.py.
    bbd: CalendarDateOut = None
    expected_count: int = 0
    received_count: int = 0
    unit_label: Optional[str] = None
    weight_per_unit: Optional[float] = None
    weight_unit: Optional[str] = None
    units_per_pallet: Optional[int] = None
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
    expected_date: CalendarDateOut = None
    expected_time: Optional[str] = None
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
    # Corporate may raise an order before knowing the supplier, and the ORDER
    # creates no lot so nothing can collide at that point. The lot is minted
    # here — so this is where the vendor has to be pinned down, by somebody
    # holding the BOL. It is a segment of the lot key, and unlike a missing
    # lot number or best-by it fails SILENTLY: `can_print_labels` does not
    # check it, so two suppliers' "LOT001" would merge with no warning at all.
    vendor_id: Optional[str] = None
    _blank_vendor = field_validator("vendor_id", mode="before")(_blank_to_none)
    vendor_lot: Optional[str] = Field(None, max_length=100)
    bbd: CalendarDateTime = None
    weight_per_unit: Optional[float] = Field(None, ge=0)
    # Pounds. No longer offered as a choice in the UI — a mixed store is worse
    # than either unit, because nothing downstream converts.
    weight_unit: Optional[str] = Field("lbs", max_length=10)
    units_per_pallet: Optional[int] = Field(None, ge=1, le=500)
    expected_count: Optional[int] = Field(None, ge=0)
    bol: Optional[str] = Field(None, max_length=100)


class CloseOrderRequest(BaseSchema):
    reason: Optional[str] = None


class ReleaseOrderRequest(BaseSchema):
    """The arrival slot, agreed with the carrier after the order was raised.

    `expected_date` is required at the server — the plant's screen is organised
    by day, so an order released without one would sit outside every day view.
    """
    expected_date: CalendarDateTime = None
    # Free text, e.g. "07:00 AM" — what a carrier quotes. Nothing computes with
    # it; it is shown so the dock knows roughly when to expect the truck.
    expected_time: Optional[str] = Field(None, max_length=20)


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
    # The date that gets PRINTED and encoded into the QR. A day's drift here is
    # a wrong best-by on a food-safety label.
    bbd: CalendarDateOut = None
    net_weight: Optional[float] = None
    weight_unit: Optional[str] = None
    unit_label: Optional[str] = None
    # 'unit' | 'pallet' — see PrintLabelsRequest.
    pack_scope: str = "unit"
    units_per_pallet: Optional[int] = None
    receipt_date: Optional[datetime] = None


class LotLabelSheet(BaseSchema):
    lot_code: str
    count: int
    scope: str = "unit"
    labels: List[LotLabel] = []


class PrintLabelsRequest(BaseSchema):
    count: int = Field(..., ge=1, le=500)
    # 'unit' — one sticker per drum/bag/box.
    # 'pallet' — one sticker per wrapped pallet, for material nobody is going to
    # destack at the dock. Identical sticker either way; only the middle band
    # differs, so a person can see whether they hold a bag or a pallet of them.
    scope: str = Field("unit", pattern="^(unit|pallet)$")


# ─── the approval view ────────────────────────────────────────────────────────

class ReceivingRowCount(BaseSchema):
    storage_row_id: str
    storage_row_name: str
    count: int = 0


class ReceivingSummary(BaseSchema):
    receipt_id: str
    product_id: Optional[str] = None
    product_name: str = ""
    lot_code: Optional[str] = None
    vendor_lot: Optional[str] = None
    bbd: CalendarDateOut = None
    unit_label: Optional[str] = None
    count_unit: str = "units"
    expected_count: int = 0
    scanned_count: int = 0
    # scanned - expected. Negative is short, positive is over. Both are legal and
    # both are shown; neither blocks anything.
    difference: int = 0
    weight_per_unit: Optional[float] = None
    # NULL for individually-stickered material (drums, totes). Set for bags and
    # boxes: what one pallet holds, and the prefill for the gun's multiplier.
    units_per_pallet: Optional[int] = None
    derived_weight: Optional[float] = None
    rows: List[ReceivingRowCount] = []
    source: str = "walk_in"
    order_number: Optional[str] = None
    order_id: Optional[str] = None
    needs_review: bool = False
    # Non-null when stickers cannot be printed yet — a missing lot number or
    # best-by, or a flagged review.
    blocked_reason: Optional[str] = None
    label_printed_at: Optional[datetime] = None
