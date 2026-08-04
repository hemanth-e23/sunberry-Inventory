// Ingredient container / intake-approval API surface.
//
// Deliberately NOT in AppDataContext: containers are high-cardinality (one row
// per physical drum, tens of thousands within a season) and every screen that
// reads them is filtered and paginated server-side. Eager-loading them into the
// global store is audit D11.
//
// Intake *approval* calls live here too rather than in a second module, because
// the approvals queue is the only consumer in this area and a duplicate
// `ingredientIntakeApi.js` would collide with the intake-creation screens.

import apiClient from './client';

const CONTAINERS = '/ingredient-containers';
const INTAKES = '/ingredient-intakes';
const ROWS = '/ingredient-rows';

/** Server-side cap on GET /ingredient-containers (`limit: Query(100, le=500)`). */
export const CONTAINER_PAGE_MAX = 500;
export const CONTAINER_PAGE_SIZE = 100;

/** Client-minted key so a retried mutation is deduped server-side. */
export const newIdempotencyKey = () => {
  if (typeof window !== 'undefined' && window.crypto?.randomUUID) {
    return window.crypto.randomUUID().replace(/-/g, '');
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 18)}`;
};

/**
 * Human-readable message out of an axios failure.
 *
 * FastAPI puts the message in `detail`, but a 422 sends `detail` as an array of
 * validation objects — rendering that raw prints "[object Object]" in a toast.
 */
export const apiErrorMessage = (error, fallback = 'Something went wrong') => {
  const detail = error?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail) && detail.length) {
    const first = detail[0];
    if (typeof first === 'string') return first;
    if (first?.msg) return first.msg;
  }
  if (typeof error?.response?.data?.message === 'string') return error.response.data.message;
  if (error?.message) return error.message;
  return fallback;
};

// ─── containers ───────────────────────────────────────────────────────────────

/**
 * @param {object} params intake_id, intake_lot_id, product_id, status,
 *   storage_row_id, vendor_lot, is_held, q, skip, limit
 * @returns {Promise} `{ items, total, truncated }`
 */
export const listContainers = (params = {}) =>
  apiClient.get(`${CONTAINERS}/`, { params });

export const getContainer = (serial) =>
  apiClient.get(`${CONTAINERS}/${encodeURIComponent(serial)}`);

export const moveContainer = ({ serial, to_row_id, reason, idempotency_key }) =>
  apiClient.post(`${CONTAINERS}/move`, { serial, to_row_id, reason, idempotency_key });

export const setContainerHold = ({ serial, held, reason }) =>
  apiClient.post(`${CONTAINERS}/hold`, { serial, held, reason });

/** Scoped to (product, vendor, lot) — a bare lot number is reused by vendors. */
export const previewLotHold = ({ vendor_lot, product_id, vendor_id, intake_id }) =>
  apiClient.get(`${CONTAINERS}/lot/preview`, {
    params: { vendor_lot, product_id, vendor_id, intake_id },
  });

/** Explicit serials only — the UI resolves the lot and sends what was checked. */
export const bulkSetHold = ({ serials, held, reason }) =>
  apiClient.post(`${CONTAINERS}/bulk-hold`, { serials, held, reason });

export const damageContainer = ({ serial, reason, quarantine_row_id }) =>
  apiClient.post(`${CONTAINERS}/damage`, { serial, reason, quarantine_row_id });

/** APPROVAL_ROLES only server-side; the UI hides the action for everyone else. */
export const disposeContainer = ({ serial, reason_code, reason }) =>
  apiClient.post(`${CONTAINERS}/dispose`, { serial, reason_code, reason });

export const markContainerMissing = ({ serial, reason }) =>
  apiClient.post(`${CONTAINERS}/missing`, { serial, reason });

// ─── rows ─────────────────────────────────────────────────────────────────────

/** Rows for pickers. No capacity filter — ingredient rows legitimately have 0. */
export const listIngredientRows = (params = {}) =>
  apiClient.get(`${ROWS}/`, { params });

// ─── intakes (approvals queue) ────────────────────────────────────────────────

export const listIntakes = (params = {}) =>
  apiClient.get(`${INTAKES}/`, { params });

export const getIntake = (intakeId) =>
  apiClient.get(`${INTAKES}/${intakeId}`);

export const approveIntake = (intakeId) =>
  apiClient.post(`${INTAKES}/${intakeId}/approve`);

/** `disposition` is REQUIRED: 'fix_and_resubmit' | 'return_to_vendor'. */
export const rejectIntake = (intakeId, { reason, disposition }) =>
  apiClient.post(`${INTAKES}/${intakeId}/reject`, { reason, disposition });
