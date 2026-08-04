"""Pydantic schemas for ingredient container serialization.

See INGREDIENT-SERIALIZATION-SPEC.md. Two conventions worth stating up front:

* Counts are always reported with an explicit container unit ("80 barrels"),
  never a bare number that a caller might label "cases". The word "cases" must
  be impossible for a serialized ingredient on every surface (spec §6.3/§19.1).
* A scan response carries everything the receiving screen needs to redraw
  itself — current row, count into that row, count into the intake, expected
  total — so the client never has to re-fetch mid-unload, and the offline queue
  can replay a scan and get an identical payload back.
"""

from datetime import datetime
from typing import List, Optional

from app.schemas.base import BaseSchema


# ─── Intake lot lines ─────────────────────────────────────────────────────────

class IntakeLotBase(BaseSchema):
    product_id: str
    category_id: Optional[str] = None
    container_type: str
    vendor_lot: Optional[str] = None
    lot_unknown: bool = False
    bbd: Optional[datetime] = None
    expected_count: int = 0
    brix: Optional[float] = None
    net_weight_per_container: Optional[float] = None
    weight_unit: Optional[str] = None


class IntakeLotCreate(IntakeLotBase):
    pass


class IntakeLotUpdate(BaseSchema):
    vendor_lot: Optional[str] = None
    lot_unknown: Optional[bool] = None
    bbd: Optional[datetime] = None
    expected_count: Optional[int] = None
    brix: Optional[float] = None
    net_weight_per_container: Optional[float] = None
    weight_unit: Optional[str] = None


class IntakeLot(IntakeLotBase):
    id: str
    intake_id: str
    created_at: Optional[datetime] = None
    # Live counts, computed — not stored. minted vs. scanned is the difference
    # between "labels exist" and "drums are physically on a rack".
    minted_count: int = 0
    scanned_count: int = 0
    product_name: Optional[str] = None
    product_sid: Optional[str] = None


# ─── Intakes ──────────────────────────────────────────────────────────────────

class IngredientIntakeCreate(BaseSchema):
    vendor_id: Optional[str] = None
    bol: Optional[str] = None
    purchase_order: Optional[str] = None
    receipt_date: Optional[datetime] = None
    warehouse_id: Optional[str] = None
    notes: Optional[str] = None
    # 'legacy_sweep' for cutover-created intakes, where the received date is
    # genuinely unknown and must not be fabricated.
    source: str = "truck"
    lots: List[IntakeLotCreate] = []


class IngredientIntakeUpdate(BaseSchema):
    vendor_id: Optional[str] = None
    bol: Optional[str] = None
    purchase_order: Optional[str] = None
    receipt_date: Optional[datetime] = None
    notes: Optional[str] = None


class IntakeRowBreakdown(BaseSchema):
    """Where the drums on this intake actually went."""
    storage_row_id: str
    storage_row_name: Optional[str] = None
    location_path: Optional[str] = None
    count: int


class IngredientIntake(BaseSchema):
    id: str
    intake_number: Optional[str] = None
    vendor_id: Optional[str] = None
    vendor_name: Optional[str] = None
    bol: Optional[str] = None
    purchase_order: Optional[str] = None
    receipt_date: Optional[datetime] = None
    warehouse_id: Optional[str] = None
    status: str
    source: str = "truck"

    expected_count: int = 0
    received_count: int = 0
    short_count: int = 0
    short_reason: Optional[str] = None
    over_received: bool = False
    over_reason: Optional[str] = None
    damaged_count: int = 0

    submitted_by: Optional[str] = None
    submitted_at: Optional[datetime] = None
    approved_by: Optional[str] = None
    approved_at: Optional[datetime] = None
    rejected_at: Optional[datetime] = None
    rejection_reason: Optional[str] = None
    rejection_disposition: Optional[str] = None
    voided_at: Optional[datetime] = None
    void_reason: Optional[str] = None
    notes: Optional[str] = None
    created_at: Optional[datetime] = None

    lots: List[IntakeLot] = []
    # "80 barrels", never "80 cases" — derived from container_type, never from a
    # column default (spec §6.3).
    count_unit: str = "containers"
    minted_count: int = 0
    scanned_count: int = 0
    row_breakdown: List[IntakeRowBreakdown] = []


class IngredientIntakeList(BaseSchema):
    """Bounded list. `truncated` is explicit because a list that silently caps
    reads as "that's everything" when it isn't (spec §18.9)."""
    items: List[IngredientIntake]
    total: int
    truncated: bool = False


# ─── Minting & labels ─────────────────────────────────────────────────────────

class MintSerialsRequest(BaseSchema):
    intake_lot_id: str
    count: int


class ContainerLabel(BaseSchema):
    """Everything the sticker prints. The 2D payload is built client-side from
    these fields using the fixed SB1 envelope — see frontend labelPayload.js."""
    serial: str
    sequence: int
    intake_total: int
    product_name: Optional[str] = None
    product_sid: Optional[str] = None
    vendor_name: Optional[str] = None
    vendor_lot: Optional[str] = None
    # Drives the label's "LOT UNKNOWN" line. A cutover drum whose original label
    # is unreadable is QA-flagged and used first (§15.4), so the sticker has to
    # SAY so — printing an em-dash makes it indistinguishable from a lot line
    # nobody has filled in yet.
    lot_unknown: bool = False
    bbd: Optional[datetime] = None
    net_weight: Optional[float] = None
    weight_unit: Optional[str] = None
    receipt_date: Optional[datetime] = None
    container_type: str
    intake_lot_id: str


class LabelSheet(BaseSchema):
    """Labels ordered into per-lot stacks, so the printed pile matches the
    physical order of application and a lot boundary is a visible divider."""
    intake_id: str
    intake_number: Optional[str] = None
    labels: List[ContainerLabel]
    lot_boundaries: List[int] = []


# ─── Containers ───────────────────────────────────────────────────────────────

class Container(BaseSchema):
    id: str
    serial: str
    sequence: int
    intake_id: str
    intake_lot_id: str
    product_id: str
    product_name: Optional[str] = None
    warehouse_id: Optional[str] = None
    container_type: str
    status: str
    remaining_qty: Optional[float] = None
    net_weight: Optional[float] = None
    qty_unit: Optional[str] = None
    vendor_lot: Optional[str] = None
    bbd: Optional[datetime] = None
    storage_row_id: Optional[str] = None
    storage_row_name: Optional[str] = None
    location_path: Optional[str] = None
    pallet_group_id: Optional[str] = None
    is_held: bool = False
    hold_reason: Optional[str] = None
    staged_for_request_id: Optional[str] = None
    consumed_by_batch_uid: Optional[str] = None
    opened_at: Optional[datetime] = None
    scanned_at: Optional[datetime] = None
    created_at: Optional[datetime] = None


class ContainerList(BaseSchema):
    items: List[Container]
    total: int
    truncated: bool = False


class ContainerEvent(BaseSchema):
    id: str
    seq: int
    container_id: str
    event_type: str
    from_status: Optional[str] = None
    to_status: str
    from_row_id: Optional[str] = None
    to_row_id: Optional[str] = None
    qty_delta: Optional[float] = None
    actor_id: Optional[str] = None
    actor_name: Optional[str] = None
    ref_type: Optional[str] = None
    ref_id: Optional[str] = None
    reason: Optional[str] = None
    reason_code: Optional[str] = None
    verified: bool = True
    occurred_at: datetime


# ─── Scanning ─────────────────────────────────────────────────────────────────

class ContainerScanRequest(BaseSchema):
    serial: str
    # Required. There is deliberately no fallback to a last-known row: guessing
    # a location is the bug class §6.4/§19.2 exists to kill. A scan with no row
    # is rejected with "scan a row first", never silently placed.
    storage_row_id: str
    idempotency_key: Optional[str] = None
    # R-2: the drum is already received into a DIFFERENT row. The client must
    # confirm explicitly; the server never moves it silently.
    confirm_move: bool = False


class ContainerScanResponse(BaseSchema):
    status: str          # 'ok' | 'already_received' | 'moved' | 'needs_confirm'
    message: str
    container: Optional[Container] = None
    # Live counters so the unload screen redraws without re-fetching.
    row_scanned_count: int = 0
    intake_scanned_count: int = 0
    intake_expected_count: int = 0
    count_unit: str = "containers"
    # Soft signals. `warning` never accompanies a failure — a full row still
    # accepts the drum (spec §8.1); it just says so.
    warning: Optional[str] = None
    warning_detail: Optional[str] = None


# ─── Lifecycle actions ────────────────────────────────────────────────────────

class IntakeCloseShortRequest(BaseSchema):
    short_reason: str


class IntakeRejectRequest(BaseSchema):
    reason: str
    # Required: scanned drums must never silently vanish (spec §18.2 R-9).
    disposition: str  # 'fix_and_resubmit' | 'return_to_vendor'


class IntakeVoidRequest(BaseSchema):
    reason: str


# ─── Audit ────────────────────────────────────────────────────────────────────

class CacheDriftRow(BaseSchema):
    """One container whose stored state disagrees with its own ledger.

    This is a reconciliation between two independently-written records, not a
    recompute — the container row is authoritative and the ledger is the audit
    trail (spec IMPL-COMMENT 1). A non-empty result means a bug, not routine
    drift to be auto-healed.
    """
    container_id: str
    serial: str
    cached_status: Optional[str] = None
    ledger_status: Optional[str] = None
    cached_row_id: Optional[str] = None
    ledger_row_id: Optional[str] = None
    last_event_seq: Optional[int] = None


class CacheDriftReport(BaseSchema):
    checked: int
    drifted: int
    rows: List[CacheDriftRow]
    truncated: bool = False


# ─── moves, holds, exits (Phase 2) ────────────────────────────────────────────

class ContainerMoveRequest(BaseSchema):
    serial: str
    # Required, same rule as receiving: a destination row is never inferred.
    to_row_id: str
    reason: Optional[str] = None
    idempotency_key: Optional[str] = None


class ContainerMoveGroupRequest(BaseSchema):
    serials: List[str]
    to_row_id: str
    reason: Optional[str] = None


class ContainerMoveResponse(BaseSchema):
    status: str          # 'ok' | 'already_there' | 'already_moved'
    message: str
    container: Optional[Container] = None
    row_count: int = 0
    count_unit: str = "containers"
    warning: Optional[str] = None
    warning_detail: Optional[str] = None
    # Non-blocking advisories: moved while held, moved before approval.
    notices: List[str] = []


class ContainerHoldRequest(BaseSchema):
    serial: str
    held: bool
    reason: Optional[str] = None


class ContainerBulkHoldRequest(BaseSchema):
    """Explicit serials, never a lot filter — the UI resolves the lot, shows the
    matches with per-container checkboxes, and sends back what the human agreed
    to. A server-side lot sweep has no confirmation step and cannot express the
    partial release §18.6 H-2 requires."""
    serials: List[str]
    held: bool
    reason: Optional[str] = None


class LotScope(BaseSchema):
    """Scoped to (product, vendor, lot) — never the lot number alone, which
    vendors reuse (§4.1)."""
    vendor_lot: str
    product_id: Optional[str] = None
    vendor_id: Optional[str] = None
    intake_id: Optional[str] = None


class LotHoldPreview(BaseSchema):
    total: int
    holdable: List[Container]
    already_held: List[Container]
    # These two ARE the recall trace (§18.6 H-1): consumed drums carry the batch
    # they went into, shipped drums the order they left on.
    consumed: List[Container]
    shipped: List[Container]
    intake_ids: List[str]


class ContainerDamageRequest(BaseSchema):
    serial: str
    reason: str
    quarantine_row_id: Optional[str] = None


class ContainerDisposeRequest(BaseSchema):
    serial: str
    reason_code: str
    reason: Optional[str] = None


class ContainerMissingRequest(BaseSchema):
    serial: str
    reason: str


class RowDriftRow(BaseSchema):
    storage_row_id: str
    storage_row_name: Optional[str] = None
    capacity: int
    occupied: int
    over_by: int
    count_unit: str = "containers"


class RowDriftReport(BaseSchema):
    """Rows fuller than their capacity. The deliberate counterpart to capacity
    being a soft prompt: over-fill is accepted at the point of work and surfaced
    here as a walk-list instead of stopping a forklift mid-unload."""
    rows: List[RowDriftRow]
    total: int
