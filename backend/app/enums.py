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
