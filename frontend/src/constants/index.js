// ─── Roles ────────────────────────────────────────────────────────────────────
export const ROLES = {
  ADMIN: 'admin',
  SUPERADMIN: 'superadmin',
  CORPORATE_ADMIN: 'corporate_admin',
  SUPERVISOR: 'supervisor',
  WAREHOUSE: 'warehouse',
  FORKLIFT: 'forklift',
};

// ─── Category Types ───────────────────────────────────────────────────────────
export const CATEGORY_TYPES = {
  FINISHED: 'finished',
  RAW_MATERIAL: 'raw-material',
  INGREDIENT: 'ingredient',
  PACKAGING: 'packaging',
};

// Production data contains BOTH 'raw' (dominant) and the legacy 'raw-material'
// spelling for raw materials / ingredients. Use this everywhere a raw-material
// check is needed instead of a single equality comparison, which silently
// misses whichever spelling it isn't testing.
export const isRawMaterialType = (type) =>
  type === 'raw' || type === CATEGORY_TYPES.RAW_MATERIAL;

// ─── Statuses ─────────────────────────────────────────────────────────────────

export const RECEIPT_STATUS = {
  PENDING: 'pending',
  RECORDED: 'recorded',
  REVIEWED: 'reviewed',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  SENT_BACK: 'sent_back',
  DEPLETED: 'depleted',
};

export const TRANSFER_STATUS = {
  PENDING: 'pending',
  SUBMITTED: 'submitted',
  FORKLIFT_SUBMITTED: 'forklift_submitted',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  VOIDED: 'voided',
};

export const TRANSFER_STATUS_LABELS = {
  pending: 'Pending',
  submitted: 'Submitted',
  forklift_submitted: 'Ready for review',
  approved: 'Approved',
  rejected: 'Rejected',
  voided: 'Voided',
};

export const ADJUSTMENT_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
};

export const HOLD_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
};

export const FORKLIFT_REQUEST_STATUS = {
  SCANNING: 'scanning',
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
};

export const PALLET_STATUS = {
  PENDING: 'pending',
  MISSING_STICKER: 'missing_sticker',
  IN_STOCK: 'in_stock',
  RESERVED: 'reserved',
  PLACED: 'placed',
  TRANSFERRED: 'transferred',
  SHIPPED: 'shipped',
  MISSING: 'missing',
  CANCELLED: 'cancelled',
};

// Scan reason codes returned by the ship-out scan-pick endpoint
export const SHIP_OUT_SCAN_REASON = {
  WRONG_PRODUCT: 'wrong_product',
  LINE_COMPLETE: 'line_complete',
  PALLET_UNAVAILABLE: 'pallet_unavailable',
  PALLET_NOT_FOUND: 'pallet_not_found',
  // v2 lot-level ship-out: same product but wrong lot, server offers swap
  WRONG_LOT_NEEDS_SWAP: 'wrong_lot_needs_swap',
};

export const STAGING_ITEM_STATUS = {
  STAGED: 'staged',
  PENDING: 'pending',
  FULFILLED: 'fulfilled',
  PARTIALLY_FULFILLED: 'partially_fulfilled',
  USED: 'used',
  PARTIALLY_USED: 'partially_used',
  RETURNED: 'returned',
  PARTIALLY_RETURNED: 'partially_returned',
};

export const STAGING_REQUEST_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  FULFILLED: 'fulfilled',
  PARTIAL: 'partial',
  CLOSED: 'closed',
  CANCELLED: 'cancelled',
};

export const INTER_WAREHOUSE_STATUS = {
  INITIATED: 'initiated',
  CONFIRMED: 'confirmed',
  IN_TRANSIT: 'in_transit',
  RECEIVED: 'received',
  DISPUTED: 'disputed',
  CANCELLED: 'cancelled',
};
