from enum import Enum


class ReceiptStatus(str, Enum):
    PENDING = "pending"
    RECORDED = "recorded"
    REVIEWED = "reviewed"
    APPROVED = "approved"
    REJECTED = "rejected"
    SENT_BACK = "sent_back"
    DEPLETED = "depleted"


class TransferStatus(str, Enum):
    PENDING = "pending"
    SUBMITTED = "submitted"
    FORKLIFT_SUBMITTED = "forklift_submitted"
    APPROVED = "approved"
    REJECTED = "rejected"
    VOIDED = "voided"


class ShipOutLifecycle(str, Enum):
    """Lifecycle statuses for the scheduled ship-out flow (transfer_type=shipped-out).

    Stored in the SAME `InventoryTransfer.status` column as TransferStatus — one
    source of truth (see SHIP-OUT-SCHEDULING-SPEC.md §3). A scheduled order walks:
    SCHEDULED -> CHECKED_IN -> SCANNING -> RECONCILED -> COMPLETE -> DOCS_GENERATED.
    CANCELLED is terminal. Legacy TransferStatus values are not used by new orders
    (clean cutover, 2026-07-04).
    """
    SCHEDULED = "scheduled"          # corporate created it; NOT on the gun yet
    CHECKED_IN = "checked_in"        # truck arrived, yard check-in done; released to gun
    SCANNING = "scanning"            # forklift is picking/scanning
    RECONCILED = "reconciled"        # ordered-vs-shipped gap closed
    COMPLETE = "complete"            # sealed, time-out entered
    DOCS_GENERATED = "docs_generated"  # packing slip + BOL generated; order LOCKED
    CANCELLED = "cancelled"          # terminal


# Statuses at which a scheduled ship-out order is visible on the forklift gun:
# the truck is physically in the yard and not yet finished. Date-independent by
# design (§5.6) — check-in itself proves the truck is here.
SHIP_OUT_ON_GUN_STATUSES = (
    ShipOutLifecycle.CHECKED_IN.value,
    ShipOutLifecycle.SCANNING.value,
)


class AdjustmentStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class AdjustmentType(str, Enum):
    """Every value ever written to `InventoryAdjustment.adjustment_type`.

    Promoted out of a bare frozenset in adjustment_service.py (2026-08-03) because
    the sign of a new member was previously implicit: a type that wasn't listed in
    DEDUCTION_TYPES produced an APPROVED adjustment that looked correct in every UI
    while leaving `receipt.quantity` untouched. Adding a member here forces the
    author to also place it in — or deliberately out of — DEDUCTION_TYPES below.
    """
    REDUCE = "reduce"
    STOCK_CORRECTION = "stock-correction"
    DAMAGE_REDUCTION = "damage-reduction"
    DONATION = "donation"
    TRASH_DISPOSAL = "trash-disposal"
    QUALITY_REJECTION = "quality-rejection"
    USED_IN_PRODUCTION = "used-in-production"
    # Written by staging_service.py:270 and filtered by report_builders.py:419.
    # NOT a DEDUCTION_TYPE — it never was, and approve_adjustment has never
    # decremented on it. Preserved as-is; changing it is a separate decision.
    PRODUCTION_CONSUMPTION = "production-consumption"
    FOUND = "found"
    # Ingredient serialization cutover (SPEC §15.3). Deliberately NOT a
    # DEDUCTION_TYPE: the conversion runs in its own transaction and does its own
    # `receipt.quantity -= container.net_weight` decrement, then writes this
    # adjustment already-APPROVED for KPI/report continuity only. Routing it
    # through approve_adjustment would double-decrement.
    SERIALIZATION_CONVERSION = "serialization-conversion"


# Adjustment types that reduce inventory quantity when approved.
# Derived from AdjustmentType so a new member cannot be added without a
# deliberate sign decision. Membership is intentionally byte-identical to the
# frozenset this replaced (adjustment_service.py, pre-2026-08-03).
DEDUCTION_TYPES = frozenset({
    AdjustmentType.REDUCE.value,
    AdjustmentType.STOCK_CORRECTION.value,
    AdjustmentType.DAMAGE_REDUCTION.value,
    AdjustmentType.DONATION.value,
    AdjustmentType.TRASH_DISPOSAL.value,
    AdjustmentType.QUALITY_REJECTION.value,
    AdjustmentType.USED_IN_PRODUCTION.value,
})


class HoldStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class InterWarehouseStatus(str, Enum):
    INITIATED = "initiated"
    CONFIRMED_BY_SENDER = "confirmed_by_sender"
    IN_TRANSIT = "in_transit"
    RECEIVED = "received"
    COMPLETED = "completed"
    DISPUTED = "disputed"
    CANCELLED = "cancelled"


class ForkliftRequestStatus(str, Enum):
    SCANNING = "scanning"
    SUBMITTED = "submitted"
    APPROVED = "approved"
    REJECTED = "rejected"
    CANCELLED = "cancelled"


class PalletStatus(str, Enum):
    PENDING = "pending"
    MISSING_STICKER = "missing_sticker"
    IN_STOCK = "in_stock"
    RESERVED = "reserved"
    PLACED = "placed"
    TRANSFERRED = "transferred"
    SHIPPED = "shipped"
    MISSING = "missing"
    CANCELLED = "cancelled"
    # NOT_PRODUCED: supervisor confirmed during approval that the
    # gap in the sticker sequence was a pallet that the production
    # line never actually produced (skipped sticker number). Excluded
    # from missing-pallet lists in this AND other forklift sessions.
    NOT_PRODUCED = "not_produced"


class ShipOutScanReason(str, Enum):
    """Reason code returned when a forklift scan during ship-out picking is rejected."""
    WRONG_PRODUCT = "wrong_product"
    LINE_COMPLETE = "line_complete"
    PALLET_UNAVAILABLE = "pallet_unavailable"
    PALLET_NOT_FOUND = "pallet_not_found"
    # Lot-level ship-out v2: scanned pallet is the right product but its lot
    # isn't on any open line allocation. Response includes swap_suggestion so
    # the UI can offer the escape hatch.
    WRONG_LOT_NEEDS_SWAP = "wrong_lot_needs_swap"
    # Live-load (SPEC §5.7): scanned pallet is PENDING (fresh off the palletizer,
    # receipt not yet approved). Not an error — the UI shows a one-tap confirm and
    # re-sends with allow_live_load=true.
    LIVE_LOAD_NEEDS_CONFIRM = "live_load_needs_confirm"
    # Re-scan of a pallet ALREADY loaded onto THIS order. Not a real error — the
    # forklift just scanned it twice; the UI shows a gentle "already on this load"
    # instead of a red rejection.
    ALREADY_ON_THIS_ORDER = "already_on_this_order"


class StagingItemStatus(str, Enum):
    STAGED = "staged"
    PENDING = "pending"
    FULFILLED = "fulfilled"
    PARTIALLY_FULFILLED = "partially_fulfilled"
    USED = "used"
    PARTIALLY_USED = "partially_used"
    RETURNED = "returned"
    PARTIALLY_RETURNED = "partially_returned"


class StagingRequestStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    FULFILLED = "fulfilled"
    PARTIAL = "partial"
    CLOSED = "closed"
    CANCELLED = "cancelled"


# ─── Ingredient serialization (INGREDIENT-SERIALIZATION-SPEC.md) ──────────────
# Columns holding these are String(24), not the repo-standard String(20):
# "returned_to_vendor" is 18 chars and String(20) leaves no headroom.
#
# WARNING: IN_STOCK / SHIPPED collide by *value* with PalletStatus above. They are
# different domains (containers vs. pallet licences) and must never be compared
# across enums — such a comparison type-checks and is silently wrong. Always
# qualify: ContainerStatus.IN_STOCK, never a bare "in_stock" literal.

class IntakeStatus(str, Enum):
    """Lifecycle of an ingredient intake (one truck/delivery).

    ONE approval gate, mirroring approve_forklift_request (scanner_service.py:1067)
    where the session gate REPLACES the receipt gate — new intakes create no legacy
    Receipt at all (SPEC IMPL-COMMENT 13).
    """
    RECORDED = "recorded"
    SUBMITTED = "submitted"
    APPROVED = "approved"
    REJECTED = "rejected"
    VOIDED = "voided"


class ContainerStatus(str, Enum):
    """State of one physical barrel/bag. See SPEC §7.

    This column is authoritative state, NOT a cache recomputed from
    container_events — see SPEC IMPL-COMMENT 1. The ledger is an audit trail
    written in the same transaction, serialized by SELECT ... FOR UPDATE on the
    container row.
    """
    PRINTED_UNAPPLIED = "printed_unapplied"  # serial minted, sticker not yet on a drum
    RECEIVED = "received"                    # scanned at the dock, intake not yet approved
    IN_STOCK = "in_stock"
    STAGED = "staged"
    OPENED = "opened"                        # partial; remaining_qty is live
    EMPTY = "empty"                          # consumed; consumed_by_batch_uid recorded
    SHIPPED = "shipped"                      # serial survives; re-receive restores it
    DAMAGED = "damaged"
    DISPOSED = "disposed"
    RETURNED_TO_VENDOR = "returned_to_vendor"
    VOIDED = "voided"                        # serial burned (I-5 reject, I-6 duplicate intake)
    MISSING = "missing"                      # S-4: FEFO-suggested drum not physically found


class ContainerEventType(str, Enum):
    """Append-only ledger event types. See SPEC §6.

    APPROVED/REJECTED/VOIDED/RETURNED_TO_VENDOR/COUNTED were absent from the
    original spec list; without them the event->status mapping is not a function
    and half the §18 edge-case catalog has nowhere to be recorded.
    """
    PRINTED = "printed"
    RECEIVED = "received"
    APPROVED = "approved"
    REJECTED = "rejected"
    MOVED = "moved"
    STAGED = "staged"
    STAGING_RETURNED = "staging_returned"
    OPENED = "opened"
    CONSUMED = "consumed"
    SHIPPED = "shipped"
    RETURNED_TO_STOCK = "returned_to_stock"
    RETURNED_TO_VENDOR = "returned_to_vendor"
    ADJUSTED = "adjusted"
    SAMPLED = "sampled"
    DAMAGED = "damaged"
    DISPOSED = "disposed"
    RELABELED = "relabeled"
    HELD = "held"
    RELEASED = "released"
    REGROUPED = "regrouped"
    VOIDED = "voided"
    COUNTED = "counted"


class ContainerType(str, Enum):
    BARREL = "barrel"
    BAG = "bag"


class DisposalReason(str, Enum):
    """Reason codes for disposal/destruction (SPEC §13).

    Stored in container_events.reason_code alongside free-text `reason`, so the
    disposal report §13 asks for is groupable. Appending a value later is safe.
    """
    DAMAGED = "damaged"
    EXPIRED = "expired"
    QA_REJECT = "qa_reject"
    SPILL = "spill"
    CONTAMINATION = "contamination"
    OTHER = "other"


class IntakeSource(str, Enum):
    """How an intake came into being. `legacy_sweep` covers SPEC §15.4, where
    received_date is honestly unknown rather than fabricated."""
    TRUCK = "truck"
    LEGACY_SWEEP = "legacy_sweep"
