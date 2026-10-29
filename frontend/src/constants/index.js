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

// True for ingredients specifically (the serialized tier: barrels + bags).
// Deliberately separate from isRawMaterialType — raw materials keep the legacy
// receipt/allocation flow, ingredients do not.
export const isIngredientType = (type) => type === CATEGORY_TYPES.INGREDIENT;

// True for anything measured by weight rather than counted in cases: raw
// materials AND ingredients. Use this for UI that applies to both (SID, vendor,
// expiration, lbs display). `isRawMaterialType` alone silently EXCLUDES
// ingredients, which is how an "isIngredient" flag ended up false for every
// actual ingredient (approvals/ReceiptsTab.jsx).
export const isWeighedMaterialType = (type) =>
  isRawMaterialType(type) || isIngredientType(type);

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
  NOT_PRODUCED: 'not_produced',
  // Case-adjusted to 0 cases. Stays at 0: scans are refused, never revived.
  EMPTIED: 'emptied',
};

// Why a gap was skipped as Not Produced at forklift review (FG pallet
// lifecycle §2.1). Mirrors backend enums.NotProducedReason; OTHER needs a note.
export const NOT_PRODUCED_REASON = {
  STICKER_DAMAGED: 'sticker_damaged',
  QA_REJECTED: 'qa_rejected',
  OTHER: 'other',
};

export const NOT_PRODUCED_REASON_LABELS = {
  [NOT_PRODUCED_REASON.STICKER_DAMAGED]: 'Sticker damaged / misprinted',
  [NOT_PRODUCED_REASON.QA_REJECTED]: 'Pallet rejected / destroyed by QA',
  [NOT_PRODUCED_REASON.OTHER]: 'Other',
};

// ±N cases on one FG pallet (§4.2). Mirrors backend enums.CaseAdjustmentReason.
export const CASE_ADJUSTMENT_REASON = {
  LEAKER_DAMAGED: 'leaker_damaged',
  QA_SAMPLE: 'qa_sample',
  REPACK: 'repack',
  COUNT_CORRECTION: 'count_correction',
};

export const CASE_ADJUSTMENT_REASON_LABELS = {
  [CASE_ADJUSTMENT_REASON.LEAKER_DAMAGED]: 'Leaker / damaged',
  [CASE_ADJUSTMENT_REASON.QA_SAMPLE]: 'QA sample',
  [CASE_ADJUSTMENT_REASON.REPACK]: 'Repack',
  [CASE_ADJUSTMENT_REASON.COUNT_CORRECTION]: 'Count correction',
};

export const ADJUSTMENT_TYPE = {
  MISSING: 'missing',
  CASE_ADJUSTMENT: 'case-adjustment',
};

export const TRANSFER_TYPE = {
  SHIPPED_OUT: 'shipped-out',
  MOYEL_SHUTTLE: 'moyel-shuttle',
};

// Gun cycle check: confirm once before marking more than this many pallets
// missing in one submit. Mirrors backend constants.CYCLE_CHECK_CONFIRM_OVER.
export const CYCLE_CHECK_CONFIRM_OVER = 5;
// A count session ends after Finish or this long without a row saved.
// Mirrors backend constants.CYCLE_CHECK_SESSION_IDLE_MINUTES.
export const CYCLE_CHECK_SESSION_IDLE_MINUTES = 60;

// Count sheet by rack row (Cycle Counting page). Mirrors backend
// constants.COUNT_SHEET_* / CYCLE_CHECK_SOURCE_SHEET.
export const COUNT_SHEET = {
  KIND: 'count_sheet',
  STATUS_OPEN: 'open',
  STATUS_SUBMITTED: 'submitted',
  TYPE_FG: 'fg',
  TYPE_RM: 'rm',
  TYPE_PACKAGING: 'packaging',
  // summary.source on a gun row check written by a sheet submit
  SOURCE_SHEET: 'sheet',
};
export const COUNT_SHEET_TYPE_LABELS = {
  fg: 'Finished goods',
  rm: 'Raw + ingredients',
  packaging: 'Packaging',
};

// The closing scan's Skip button appears after this many seconds (§3.3).
export const CLOSING_SCAN_SKIP_SECONDS = 10;

// Scan reason codes returned by the ship-out scan-pick endpoint
export const SHIP_OUT_SCAN_REASON = {
  WRONG_PRODUCT: 'wrong_product',
  LINE_COMPLETE: 'line_complete',
  PALLET_UNAVAILABLE: 'pallet_unavailable',
  PALLET_NOT_FOUND: 'pallet_not_found',
  // v2 lot-level ship-out: same product but wrong lot, server offers swap
  WRONG_LOT_NEEDS_SWAP: 'wrong_lot_needs_swap',
};

// Why raw material / packaging left on a Shipped Out transfer (G4). Mirrors
// backend app/constants.py SHIP_OUT_REASONS; required for RM shipped-out.
export const SHIP_OUT_REASON = {
  RETURN_TO_VENDOR: 'return_to_vendor',
  SALE: 'sale',
  SAMPLE: 'sample',
  OTHER: 'other',
};

export const SHIP_OUT_REASON_LABELS = {
  [SHIP_OUT_REASON.RETURN_TO_VENDOR]: 'Return to vendor',
  [SHIP_OUT_REASON.SALE]: 'Sale',
  [SHIP_OUT_REASON.SAMPLE]: 'Sample',
  [SHIP_OUT_REASON.OTHER]: 'Other',
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

// ─── Ingredient serialization ─────────────────────────────────────────────────
// Mirrors backend/app/enums.py. Keep the two in sync — these strings are
// persisted, so a typo here is a silent filter that matches nothing.
//
// NOTE: CONTAINER_STATUS.IN_STOCK / SHIPPED share values with PALLET_STATUS.
// Different domains (containers vs. pallet licences); never compare across them.

export const CONTAINER_TYPE = {
  BARREL: 'barrel',
  BAG: 'bag',
};

export const INTAKE_STATUS = {
  RECORDED: 'recorded',
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  VOIDED: 'voided',
};

export const CONTAINER_STATUS = {
  PRINTED_UNAPPLIED: 'printed_unapplied',
  RECEIVED: 'received',
  IN_STOCK: 'in_stock',
  STAGED: 'staged',
  OPENED: 'opened',
  EMPTY: 'empty',
  SHIPPED: 'shipped',
  DAMAGED: 'damaged',
  DISPOSED: 'disposed',
  RETURNED_TO_VENDOR: 'returned_to_vendor',
  VOIDED: 'voided',
  MISSING: 'missing',
};

// Statuses that count as physically present and usable.
export const CONTAINER_AVAILABLE_STATUSES = [
  CONTAINER_STATUS.IN_STOCK,
  CONTAINER_STATUS.STAGED,
  CONTAINER_STATUS.OPENED,
];

export const CONTAINER_EVENT_TYPE = {
  PRINTED: 'printed',
  RECEIVED: 'received',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  MOVED: 'moved',
  STAGED: 'staged',
  STAGING_RETURNED: 'staging_returned',
  OPENED: 'opened',
  CONSUMED: 'consumed',
  SHIPPED: 'shipped',
  RETURNED_TO_STOCK: 'returned_to_stock',
  RETURNED_TO_VENDOR: 'returned_to_vendor',
  ADJUSTED: 'adjusted',
  SAMPLED: 'sampled',
  DAMAGED: 'damaged',
  DISPOSED: 'disposed',
  RELABELED: 'relabeled',
  HELD: 'held',
  RELEASED: 'released',
  REGROUPED: 'regrouped',
  VOIDED: 'voided',
  COUNTED: 'counted',
};

export const DISPOSAL_REASON = {
  DAMAGED: 'damaged',
  EXPIRED: 'expired',
  QA_REJECT: 'qa_reject',
  SPILL: 'spill',
  CONTAMINATION: 'contamination',
  OTHER: 'other',
};

// Display unit for a container count — never "cases" (SPEC §6.3 / §19.1).
export const containerUnitLabel = (containerType, count = 2) => {
  const plural = Number(count) === 1 ? '' : 's';
  if (containerType === CONTAINER_TYPE.BARREL) return `barrel${plural}`;
  if (containerType === CONTAINER_TYPE.BAG) return `bag${plural}`;
  return `container${plural}`;
};
