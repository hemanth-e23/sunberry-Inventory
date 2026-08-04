// Ingredient intake + row API surface (SPEC §8 receiving, §8.3 row resolution).
//
// Plain functions over the shared axios instance (`src/api/client.js`, whose
// baseURL already ends in `/api`). Deliberately NOT wired into AppDataContext:
// containers and intakes are high-cardinality and per-truck, so eager-loading
// them into the global store is the exact shape audit D11 flagged. Screens
// fetch what they are looking at, when they open it.
//
// Trailing slashes on the collection paths are load-bearing: the routers
// declare `@router.get("/")`, so `/api/ingredient-intakes` answers a 307 to the
// slashed form, and a redirect replay is a request we would rather not make on
// a gun with two bars of signal.

import apiClient from './client';

const unwrap = (promise) => promise.then((response) => response.data);

// ─── /api/ingredient-intakes ─────────────────────────────────────────────────

/** `{ items, total, truncated }` — `truncated` must always be surfaced. */
export const listIntakes = (params = {}) =>
  unwrap(apiClient.get('/ingredient-intakes/', { params }));

/** Full intake: lots, count_unit, minted/scanned counts, row_breakdown. */
export const getIntake = (intakeId) =>
  unwrap(apiClient.get(`/ingredient-intakes/${intakeId}`));

/**
 * Path of the container-scan endpoint.
 *
 * Exported rather than inlined because it is used twice for the same call: as
 * `scanQueue`'s `endpoint` field (offline replay) and by `scanContainer`
 * (direct). One definition means the queued path and the live path cannot
 * drift apart.
 */
export const intakeScanEndpoint = (intakeId) => `/ingredient-intakes/${intakeId}/scan`;

/**
 * Receive one drum onto one row.
 *
 * Prefer routing scans through `scanQueue.enqueueScan({ endpoint })` so they
 * survive a dead spot; this direct form exists for callers that already know
 * they are online and need the response inline.
 */
export const scanContainer = (intakeId, payload) =>
  unwrap(apiClient.post(intakeScanEndpoint(intakeId), payload));

/** Record that fewer drums arrived than the paperwork claimed. Reason required.
 *  Unapplied serials stay unapplied — a late-found drum still scans (§18.1 I-2). */
export const closeIntakeShort = (intakeId, shortReason) =>
  unwrap(apiClient.post(`/ingredient-intakes/${intakeId}/close-short`, {
    short_reason: shortReason,
  }));

/** `recorded` → `submitted`. The single approval gate follows at the desk. */
export const submitIntake = (intakeId) =>
  unwrap(apiClient.post(`/ingredient-intakes/${intakeId}/submit`, {}));

// ─── /api/ingredient-rows ────────────────────────────────────────────────────

/** Rows for labelling / manual selection. Capacity-0 rows are included by
 *  design — an ingredient rack legitimately has `pallet_capacity = 0`. */
export const listIngredientRows = (params = {}) =>
  unwrap(apiClient.get('/ingredient-rows/', { params }));

/**
 * Scanned code → exactly one row.
 *
 * Resolution is SERVER-side on purpose: barcode first, then exact name inside
 * the caller's warehouse, and a 400 naming both candidates when two rows share
 * a name. Never re-implement any part of that client-side — guessing a rack is
 * the bug class §6.4 exists to kill.
 */
export const resolveIngredientRow = (code) =>
  unwrap(apiClient.get('/ingredient-rows/resolve', { params: { code } }));

// ─── /api/ingredient-containers (one call) ───────────────────────────────────

/**
 * Flag a drum damaged, optionally moving it to a quarantine row.
 *
 * Lives on the container router, but the receiving gun is the only screen in
 * this area that calls it (§18.2 R-8: a leak found the day after the truck left
 * is the normal case, and the forklift finds it). Declared here so the
 * receiving flow has no import edge into another area's module.
 */
export const damageContainer = ({ serial, reason, quarantineRowId = null }) =>
  unwrap(apiClient.post('/ingredient-containers/damage', {
    serial,
    reason,
    quarantine_row_id: quarantineRowId || null,
  }));
