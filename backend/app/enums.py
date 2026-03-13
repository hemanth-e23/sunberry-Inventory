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
    APPROVED = "approved"
    REJECTED = "rejected"


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
    PLACED = "placed"
    TRANSFERRED = "transferred"
    MISSING = "missing"
    CANCELLED = "cancelled"


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
