from typing import Optional, List, Literal
from datetime import datetime, date
from pydantic import Field
from app.schemas.base import BaseSchema


# Transfer schemas
class InventoryTransferBase(BaseSchema):
    receipt_id: Optional[str] = None
    from_location_id: Optional[str] = None
    from_sub_location_id: Optional[str] = None
    to_location_id: Optional[str] = None
    to_sub_location_id: Optional[str] = None
    quantity: float
    unit: str = "cases"
    reason: Optional[str] = Field(None, max_length=1000)
    transfer_type: str = "warehouse-transfer"
    order_number: Optional[str] = Field(None, max_length=100)
    source_breakdown: Optional[List[dict]] = None
    destination_breakdown: Optional[List[dict]] = None
    pallet_licence_ids: Optional[List[str]] = None

class InventoryTransferCreate(InventoryTransferBase):
    pass

class InventoryTransferUpdate(BaseSchema):
    # `status` is intentionally NOT editable here — status changes only through
    # the dedicated /approve and /reject endpoints (prevents approval bypass).
    reason: Optional[str] = Field(None, max_length=1000)

class PalletLicenceTransferRef(BaseSchema):
    id: str
    licence_number: str
    cases: int = 0

class InventoryTransfer(InventoryTransferBase):
    id: str
    status: str
    requested_by: Optional[str] = None
    approved_by: Optional[str] = None
    approved_at: Optional[datetime] = None
    submitted_at: datetime
    created_at: datetime
    pallet_licence_details: Optional[List[PalletLicenceTransferRef]] = None


class ShipOutPalletPick(BaseSchema):
    """A pallet selection from a single receipt within one ship-out line."""
    receipt_id: str = Field(..., min_length=1)
    pallet_licence_ids: List[str] = Field(..., min_length=1)


class ShipOutLineCreate(BaseSchema):
    """One product line within a ship-out order (can span multiple receipts)."""
    product_id: str = Field(..., min_length=1)
    cases_requested: float = Field(..., gt=0)
    picks: List[ShipOutPalletPick] = Field(..., min_length=1)


class ShipOutPickListCreate(BaseSchema):
    """Create a multi-product ship-out order. Each line is one product; picks within
    a line span the receipts FIFO is pulling from."""
    order_number: str = Field(..., min_length=1, max_length=100)
    lines: List[ShipOutLineCreate] = Field(..., min_length=1)


class TransferEditLineUpdate(BaseSchema):
    """Update an existing line on a ship-out (after forklift submit, pre-approval)."""
    line_id: str = Field(..., min_length=1)
    cases_requested: Optional[float] = Field(None, gt=0)
    pallet_licence_ids: Optional[List[str]] = None  # full replacement set if provided


class TransferEditRequest(BaseSchema):
    """Warehouse user edits to a forklift-submitted ship-out before approval."""
    line_updates: List[TransferEditLineUpdate] = Field(default_factory=list)
    add_lines: List[ShipOutLineCreate] = Field(default_factory=list)
    remove_line_ids: List[str] = Field(default_factory=list)


class TransferVoidRequest(BaseSchema):
    """Void a ship-out order (any non-approved/voided status)."""
    reason: Optional[str] = Field(None, max_length=1000)


class ScanPickRequest(BaseSchema):
    """Forklift scan for ship-out picking"""
    licence_number: Optional[str] = Field(None, max_length=100)
    licence_id: Optional[str] = Field(None, max_length=50)


class ForkliftSubmitRequest(BaseSchema):
    """Forklift submits a ship-out pick as done (full or partial)"""
    notes: Optional[str] = Field(None, max_length=1000)
    skipped_pallet_ids: Optional[List[str]] = Field(default_factory=list)


# ───────────────────────────────────────────────────────────────────────────
# Lot-level ship-out v2
# Phase 1 (warehouse worker) reserves capacity by (lot, cases); Phase 2
# (forklift) commits specific pallets at scan time.
# ───────────────────────────────────────────────────────────────────────────


# --- Persisted JSON shapes (stored on InventoryTransferLine) ----------------

class LotAllocation(BaseSchema):
    """One lot's slice of a ship-out line's requested cases."""
    lot_number: str = Field(..., min_length=1)
    cases_requested: float = Field(..., ge=0)
    cases_picked: float = 0


class Pick(BaseSchema):
    """A single pallet scan that contributed cases to a line."""
    pallet_licence_id: str
    cases_consumed: float = Field(..., gt=0)
    was_partial: bool = False
    scanned_at: Optional[datetime] = None
    scanned_by: Optional[str] = None


class LotSwapHistoryEntry(BaseSchema):
    """Audit entry for a line's lot being swapped via the escape hatch."""
    from_lot: str
    to_lot: Optional[str] = None  # null when no replacement lot was found
    reason: Optional[str] = None
    at: datetime
    by: Optional[str] = None
    blocked_row_ids: List[str] = Field(default_factory=list)


# --- Phase 1: warehouse worker views & inputs ------------------------------

class AvailableLotRow(BaseSchema):
    """Where a given lot's pallets currently sit."""
    row_id: Optional[str] = None  # None = floor
    row_name: str
    cases: float
    pallets: int


class AvailableLot(BaseSchema):
    """A lot offered to the warehouse worker, sorted oldest-first by caller."""
    lot_number: str
    cases_available: float
    pallets_available: int
    oldest_at: Optional[datetime] = None
    rows: List[AvailableLotRow] = Field(default_factory=list)


class ShipOutLineInputV2(BaseSchema):
    """A single product line submitted under the lot-level flow.

    `sum(lot_allocations[*].cases_requested)` must equal `cases_requested`.
    Validated server-side.
    """
    product_id: str = Field(..., min_length=1)
    cases_requested: float = Field(..., gt=0)
    lot_allocations: List[LotAllocation] = Field(..., min_length=1)


class ShipOutPickListCreateV2(BaseSchema):
    """Phase 1 submission: per-product lines, each with per-lot case splits."""
    order_number: str = Field(..., min_length=1, max_length=100)
    lines: List[ShipOutLineInputV2] = Field(..., min_length=1)


# --- Phase 2: scanner views -------------------------------------------------

class ScannerPallet(BaseSchema):
    pallet_licence_id: str
    licence_number: str
    sequence: int = 0
    cases: float
    lot_number: str  # always present — 001 sequences collide across lots
    is_picked: bool = False
    cases_consumed: Optional[float] = None  # set when is_picked
    was_partial: bool = False


class ScannerRow(BaseSchema):
    row_id: Optional[str] = None
    row_name: str
    pallets: List[ScannerPallet] = Field(default_factory=list)
    cases_total: float = 0
    pallets_total: int = 0
    is_blocked: bool = False


class ScannerLotView(BaseSchema):
    lot_number: str
    cases_remaining: float
    rows: List[ScannerRow] = Field(default_factory=list)
    is_suggested_swap: bool = False


class ScannerLineView(BaseSchema):
    line_id: str
    product_id: str
    product_name: Optional[str] = None
    product_short_code: Optional[str] = None
    cases_requested: float
    cases_remaining: float
    lots: List[ScannerLotView] = Field(default_factory=list)


class ScannerTransferView(BaseSchema):
    """What the forklift sees for a single ship-out order in the v2 flow."""
    transfer_id: str
    order_number: str
    lines: List[ScannerLineView] = Field(default_factory=list)
    partial_pallet_row: Optional[AvailableLotRow] = None  # destination for remainders


# --- Phase 2: scan-pick request & response ---------------------------------

class ScanPickRequestV2(BaseSchema):
    """A forklift scan in the v2 lot-level flow.

    `cases_to_consume` is only sent on the partial-pull confirmation step:
    the client first scans normally, gets a "would overshoot, pull only X"
    response from a previous scan-pick attempt, then re-submits with
    `cases_to_consume = X` to confirm the partial pull.
    """
    licence_number: str = Field(..., min_length=1, max_length=100)
    cases_to_consume: Optional[float] = Field(None, gt=0)
    # Live-load (SPEC §5.7): re-sent as true to confirm loading a PENDING
    # (fresh-off-the-line) pallet straight onto the truck.
    allow_live_load: bool = False


class ScanPickResponseV2(BaseSchema):
    """Response shape for v2 scan-pick. `ok=False` → check `reject_reason`."""
    ok: bool
    pick: Optional[Pick] = None
    line_id: Optional[str] = None
    line_remaining: Optional[float] = None
    lot_remaining: Optional[float] = None
    row_emptied: Optional[str] = None  # row_id that just hit zero
    partial_pallet_remaining: Optional[float] = None  # cases left on the pallet
    needs_partial_confirm: bool = False
    suggested_partial_cases: Optional[float] = None
    reject_reason: Optional[str] = None
    swap_suggestion: Optional[ScannerLotView] = None
    # Soft-total flow: scan accepted but worth a non-blocking heads-up.
    is_overage: bool = False  # pulled more than the line/lot planned
    lot_hint: Optional[ScannerLotView] = None  # scanned an off-plan (non-FIFO) lot
    message: Optional[str] = None


# --- Phase 2: remove a scanned pallet (unscan) ------------------------------

class UnscanPickRequestV2(BaseSchema):
    """Forklift removes a pallet already scanned onto this order.

    `reason` decides the pallet's fate after it comes off the order:
      - "wrong_pallet": back into shippable stock, free to re-scan
      - "leaker_damaged": a PENDING pallet hold is raised for supervisor review
    """
    pallet_licence_id: str = Field(..., min_length=1)
    reason: Literal["wrong_pallet", "leaker_damaged"]


class UnscanPickResponseV2(BaseSchema):
    ok: bool
    removed_pallet_licence_id: Optional[str] = None
    licence_number: Optional[str] = None
    reason: Optional[str] = None
    hold_created: bool = False
    line_id: Optional[str] = None
    line_remaining: Optional[float] = None
    message: Optional[str] = None


# --- Phase 2: escape hatch --------------------------------------------------

class LotEscapeHatchRequest(BaseSchema):
    """Forklift marks a lot's rows as inaccessible. Server picks next-oldest
    lot of the same product and swaps the line allocation atomically."""
    line_id: str = Field(..., min_length=1)
    blocked_lot_number: str = Field(..., min_length=1)
    blocked_row_ids: List[str] = Field(default_factory=list)
    reason: Optional[str] = Field(None, max_length=500)


class LotEscapeHatchResponse(BaseSchema):
    swapped_to_lot: Optional[str] = None  # null if no suitable lot found
    new_line_view: Optional[ScannerLineView] = None
    message: str


# --- Phase 2: reversible lot picker -----------------------------------------

class RetargetLotRequest(BaseSchema):
    """Forklift moves a line's outstanding cases from one lot to another lot it
    explicitly chose from the picker. Reversible — `to_lot` may be a lot the
    line previously moved away from."""
    line_id: str = Field(..., min_length=1)
    from_lot: str = Field(..., min_length=1)
    to_lot: str = Field(..., min_length=1)
    reason: Optional[str] = Field(None, max_length=500)


# Adjustment schemas
class InventoryAdjustmentBase(BaseSchema):
    receipt_id: Optional[str] = None
    category_id: Optional[str] = None
    product_id: Optional[str] = None
    adjustment_type: str
    quantity: float = 0
    reason: str = Field(..., max_length=1000)
    recipient: Optional[str] = Field(None, max_length=100)
    source_breakdown: Optional[List[dict]] = None
    pallet_licence_ids: Optional[List[str]] = None

class InventoryAdjustmentCreate(InventoryAdjustmentBase):
    pass

class InventoryAdjustmentUpdate(BaseSchema):
    # `status` is intentionally NOT editable here — status changes only through
    # the dedicated /approve and /reject endpoints (prevents approval bypass).
    reason: Optional[str] = Field(None, max_length=1000)

class InventoryAdjustment(InventoryAdjustmentBase):
    id: str
    status: str
    unit: Optional[str] = None
    submitted_by: Optional[str] = None
    approved_by: Optional[str] = None
    approved_at: Optional[datetime] = None
    submitted_at: datetime
    created_at: datetime


# Hold Action schemas
class HoldItem(BaseSchema):
    receipt_id: str
    location_id: str
    quantity: float
    # Containers to quarantine on this rack, when the caller counts in
    # containers rather than weight. Preferred over `quantity` when present:
    # QA counts drums, and going drums -> pounds -> back to drums is a rounding
    # round-trip with nothing to gain.
    units: Optional[int] = None

class InventoryHoldActionBase(BaseSchema):
    receipt_id: Optional[str] = None
    action: str  # hold, release
    reason: str = Field(..., max_length=1000)
    hold_items: Optional[List[HoldItem]] = None
    total_quantity: Optional[float] = None
    pallet_licence_ids: Optional[List[str]] = None

class InventoryHoldActionCreate(InventoryHoldActionBase):
    pass

class InventoryHoldActionUpdate(BaseSchema):
    # `status` is intentionally NOT editable here — status changes only through
    # the dedicated /approve and /reject endpoints (prevents approval bypass).
    reason: Optional[str] = Field(None, max_length=1000)

class InventoryHoldAction(InventoryHoldActionBase):
    id: str
    status: str
    submitted_by: Optional[str] = None
    approved_by: Optional[str] = None
    approved_at: Optional[datetime] = None
    submitted_at: datetime
    created_at: datetime


# Cycle Count schemas
class CycleCountBase(BaseSchema):
    location_id: Optional[str] = None
    category_id: Optional[str] = None
    count_date: date
    items: List[dict]
    summary: dict
    performed_by: str
    performed_by_id: str

class CycleCountCreate(CycleCountBase):
    pass

class CycleCount(CycleCountBase):
    id: str
    created_at: datetime
