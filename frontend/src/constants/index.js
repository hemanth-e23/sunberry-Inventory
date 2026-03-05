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
  APPROVED: 'approved',
  REJECTED: 'rejected',
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
  PLACED: 'placed',
  TRANSFERRED: 'transferred',
  MISSING: 'missing',
  CANCELLED: 'cancelled',
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
