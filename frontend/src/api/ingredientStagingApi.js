// Serialized-container staging API (SPEC §11, Phase 3).
//
// Plain functions over the shared axios instance (`src/api/client.js`, whose
// baseURL already ends in `/api`). Same shape as the other ingredient modules —
// deliberately outside AppDataContext, because staging lines change under you
// while three workers pull against them and an eager global copy would be stale
// the moment it loaded.
//
// The line endpoints live at /api/ingredient-staging; the REQUEST list they hang
// off is the pre-existing /api/service/staging-requests (that router accepts a
// Bearer JWT as well as a service key, which is why a browser can call it).

import apiClient from './client';

const unwrap = (promise) => promise.then((response) => response.data);

// ─── requests (existing service router) ──────────────────────────────────────

/**
 * Open staging requests with their line items.
 *
 * Returns the raw service-router shape: `[{ id, production_batch_uid,
 * product_name, formula_name, status, production_date, items: [{ id, product_id,
 * sid, ingredient_name, quantity_needed, quantity_fulfilled, unit, status }] }]`.
 * Line-level serialized detail is NOT in here — fetch `getLine` per line.
 */
export const listStagingRequests = (params = {}) =>
  unwrap(apiClient.get('/service/staging-requests', { params }));

// ─── lines (/api/ingredient-staging) ─────────────────────────────────────────

/**
 * Serialized state of one staging line.
 *
 * `{ line_id, line_status, quantity_needed, quantity_fulfilled, remaining,
 *    over_pulled, container_count, count_unit, serials, claimed_by }`
 *
 * `remaining` is already floored at zero server-side and `over_pulled` carries
 * the excess separately — so an over-pulled line reads "0 remaining, +500 over"
 * rather than a negative that a progress bar would render as a stuck counter.
 * `claimed_by` is a USER ID, not a name; resolve it against the caller's user
 * map for display.
 */
export const getLine = (itemId) =>
  unwrap(apiClient.get(`/ingredient-staging/lines/${itemId}`));

/**
 * Claim a line for this worker.
 *
 * Atomic server-side (conditional UPDATE + rowcount). On loss the server sends a
 * 409 whose detail already names the holder — surface `detail` verbatim rather
 * than inventing a message, because it is the only place the holder's NAME is
 * available (the line payload carries only the id).
 */
export const claimLine = (itemId) =>
  unwrap(apiClient.post(`/ingredient-staging/lines/${itemId}/claim`, {}));

/** Release a claim. `force` is the supervisor reassigning an absent worker's
 *  line. Scans already made keep their attribution either way (§18.4 S-2). */
export const unclaimLine = (itemId, { force = false } = {}) =>
  unwrap(apiClient.post(`/ingredient-staging/lines/${itemId}/unclaim`, { force }));

/**
 * Advisory pull list, first-expiry-first-out.
 *
 * Opened containers come FIRST, ahead of BBD order — a part-used drum should be
 * finished before a sealed one is broken into (§18.4 S-8). The list is a
 * SUGGESTION: pulling something not on it is allowed with a reason, never
 * blocked (§11.4).
 */
export const getFefoSuggestions = (itemId, params = {}) =>
  unwrap(apiClient.get(`/ingredient-staging/lines/${itemId}/fefo`, { params }));

/** Path of the staging scan endpoint. Exported so the offline queue and the
 *  direct call cannot drift apart — same reasoning as `intakeScanEndpoint`. */
export const stagingScanEndpoint = (itemId) =>
  `/ingredient-staging/lines/${itemId}/scan`;

/**
 * Pull one drum onto this line.
 *
 * `off_list_reason` is required only when the drum was not on the FEFO list —
 * the server records it and allows the pull. Holds are re-checked on EVERY scan,
 * so a hold placed mid-pull rejects the next drum immediately (§18.4 S-3).
 */
export const stageContainer = (itemId, payload) =>
  unwrap(apiClient.post(stagingScanEndpoint(itemId), payload));

/**
 * Return a staged drum to stock.
 *
 * `to_row_id` is REQUIRED and there is no default: without a destination there
 * is nothing to re-credit, and a return that does not re-credit the rack is how
 * occupancy silently drifts down every staging round (the live bug this closes).
 */
export const returnContainer = (itemId, { serial, toRowId, reason = null }) =>
  unwrap(apiClient.post(`/ingredient-staging/lines/${itemId}/return`, {
    serial,
    to_row_id: toRowId,
    reason,
  }));
