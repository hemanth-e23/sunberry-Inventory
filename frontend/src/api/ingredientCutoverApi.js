// Cutover sweep + ingredient audit dashboards — the read/write surface for
// SPEC §15 (dual-mode cutover), §6.1 (cache-vs-ledger drift), §8.1 (row drift),
// §10.3 (bag reconciliation) and §10.5 (weigh-out variance).
//
// Deliberately NOT in AppDataContext (audit D11): every endpoint here is either
// high-cardinality (containers, variance rows) or an on-demand audit a
// supervisor runs by hand. Eager-loading any of it into the global store would
// put a full container scan on every login.
//
// Thin wrappers over the shared axios instance, returning the axios response so
// callers read `.data` — same shape as receiptService.js / palletizerService.js.

import apiClient from './client';

// ─── Cutover (§15) ───────────────────────────────────────────────────────────

/** Can this legacy receipt be swept, and if not, exactly why not. */
export const getSweepEligibility = (receiptId) =>
  apiClient.get(`/ingredient-cutover/eligibility/${receiptId}`);

/**
 * Convert ONE physical drum off a legacy receipt.
 *
 * NOT queued through utils/scanQueue.js, and that is deliberate: the queue's
 * whole safety property is idempotent replay, and `POST /convert` carries no
 * idempotency key — it mints the NEXT serial every time it is called. A replayed
 * convert would create a phantom drum and decrement the receipt twice, which is
 * the exact class of bug §15's in-transaction invariant exists to prevent. The
 * sweep is a desk/floor workstation on plant wifi; a failed convert is retried
 * by a human who can see whether the drum already has a sticker on it (§18.8 C-2).
 *
 * @param {{receipt_id: string, storage_row_id: string, lot_number_override?: string,
 *          bbd_override?: string, damaged?: boolean, opened_remaining?: number}} payload
 */
export const convertLegacyDrum = (payload) =>
  apiClient.post('/ingredient-cutover/convert', payload);

/** Per-lot `legacy remaining + serialized = combined`. Reported, never healed. */
export const getCutoverReconciliation = () =>
  apiClient.get('/ingredient-cutover/reconciliation');

// ─── Row resolution (§8.3, §18.2 R-3) ────────────────────────────────────────

/**
 * Scanned code -> exactly one row, server-side. A 4xx here is a REFUSAL to
 * guess (ambiguous name, deactivated row) and its `detail` is written for the
 * operator — surface it verbatim, never re-word it and never fall back to a
 * client-side fuzzy match.
 */
export const resolveIngredientRow = (code) =>
  apiClient.get('/ingredient-rows/resolve', { params: { code } });

/** Rows for the manual picker (capacity-0 rows included by design). */
export const listIngredientRows = (params) =>
  apiClient.get('/ingredient-rows/', { params });

// ─── Audits ──────────────────────────────────────────────────────────────────

/**
 * Container state vs. its own event ledger (§6.1 / IMPL-COMMENT 1).
 * APPROVAL_ROLES only — a 403 is expected for warehouse-rank callers.
 * A non-empty `rows` means a write path is buggy, not routine drift.
 */
export const getCacheDrift = (limit = 500) =>
  apiClient.get('/ingredient-containers/audit/cache-drift', { params: { limit } });

/** Rows holding more than their stated capacity — the weekly walk-list (§8.1). */
export const getRowDrift = () =>
  apiClient.get('/ingredient-containers/audit/row-drift');

/** Per-container weigh-out variance, already sorted by |variance| (§10.5). */
export const getWeighOutVariance = (productId) =>
  apiClient.get('/ingredient-containers/audit/variance', {
    params: productId ? { product_id: productId } : undefined,
  });

/** unapplied + activated == minted, per bag lot line (§10.3). */
export const getBagReconciliation = (intakeId) =>
  apiClient.get('/ingredient-containers/bags/reconciliation', {
    params: intakeId ? { intake_id: intakeId } : undefined,
  });

// ─── Shared error reader ─────────────────────────────────────────────────────

/**
 * The message a human should see for a failed request.
 *
 * FastAPI's `detail` is written for the operator on every endpoint in this area
 * (row disambiguation, sweep refusal reasons, the balance assertion), so it is
 * preferred over anything invented here. Validation errors arrive as a list of
 * dicts; those get flattened rather than rendered as "[object Object]".
 */
export const apiErrorMessage = (err, fallback = 'Request failed.') => {
  const detail = err?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail) && detail.length) {
    return detail
      .map((d) => (typeof d === 'string' ? d : d?.msg || JSON.stringify(d)))
      .join('; ');
  }
  if (detail && typeof detail === 'object') return JSON.stringify(detail);
  return err?.message || fallback;
};
