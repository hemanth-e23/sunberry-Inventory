// Lot-level receiving + cutover API surface.
//
// Plain functions over the shared axios instance (`src/api/client.js`, whose
// baseURL already ends in `/api`). Deliberately NOT wired into AppDataContext:
// incoming orders are per-truck and high-cardinality, so eager-loading them into
// the global store is the shape audit D11 flagged. Screens fetch what they are
// looking at, when they open it.

import apiClient from './client';
import { apiErrorMessage, newIdempotencyKey } from './ingredientContainerApi';

const unwrap = (promise) => promise.then((response) => response.data);

export { apiErrorMessage, newIdempotencyKey };

// ─── incoming orders ─────────────────────────────────────────────────────────

/** Open orders headed for the warehouse in view. Pass includeClosed for history. */
export const listIncomingOrders = (params = {}) =>
  unwrap(apiClient.get('/lot-receiving/orders', { params }));

export const getIncomingOrder = (orderId) =>
  unwrap(apiClient.get(`/lot-receiving/orders/${orderId}`));

/** Corporate plans a delivery into ONE destination site. Creates no stock. */
export const createIncomingOrder = (payload) =>
  unwrap(apiClient.post('/lot-receiving/orders', payload));

/** Draft -> in transit. Corporate says it has left. */
export const releaseIncomingOrder = (orderId) =>
  unwrap(apiClient.post(`/lot-receiving/orders/${orderId}/release`));

/** Close it, short or complete. A short close REQUIRES a reason. */
export const closeIncomingOrder = (orderId, reason) =>
  unwrap(apiClient.post(`/lot-receiving/orders/${orderId}/close`, { reason }));

export const cancelIncomingOrder = (orderId, reason) =>
  unwrap(apiClient.post(`/lot-receiving/orders/${orderId}/cancel`, { reason }));

/**
 * Open one line and begin receiving it. Creates the receipt and resolves the lot.
 *
 * Idempotent: a line already being received returns its existing session, so a
 * worker who backs out and comes in again resumes rather than opening a second
 * session against the same drums.
 */
export const startReceiving = (orderId, payload) =>
  unwrap(apiClient.post(`/lot-receiving/orders/${orderId}/start-receiving`, payload));

// ─── the receiving session ───────────────────────────────────────────────────

/** Everything the gun can pick up, from BOTH paths, in one list. */
export const listReceivingSessions = () => unwrap(apiClient.get('/lot-receiving/sessions'));

/** Paperwork vs scanned, per row. Also what the gun resumes from. */
export const getReceivingSession = (receiptId) =>
  unwrap(apiClient.get(`/lot-receiving/sessions/${receiptId}`));

/**
 * Path of the lot-scan endpoint.
 *
 * Exported rather than inlined because it is used twice for the same call: as
 * `scanQueue`'s `endpoint` field (offline replay) and by `scanLotUnit` (direct).
 * One definition means the queued path and the live path cannot drift apart.
 */
export const lotScanEndpoint = (receiptId) => `/lot-receiving/sessions/${receiptId}/scan`;

/** Recover the receipt id from a queued item's endpoint, to scope drain results. */
export const receiptIdFromEndpoint = (endpoint) => {
  const match = /\/lot-receiving\/sessions\/([^/]+)\/scan$/.exec(endpoint || '');
  return match ? match[1] : null;
};

/**
 * +1 unit of a lot into a rack.
 *
 * Prefer routing scans through `scanQueue.enqueueScan({ endpoint })` so they
 * survive a dead spot. Every outcome is a 200 with a `status` discriminator —
 * a 4xx would make the queue park the scan as permanently failed.
 */
export const scanLotUnit = (receiptId, payload) =>
  unwrap(apiClient.post(lotScanEndpoint(receiptId), payload));

/** Take the last unit back off. Writes a compensating event, never a delete. */
export const undoLastScan = (receiptId) =>
  unwrap(apiClient.post(`/lot-receiving/sessions/${receiptId}/undo`));

/** `count` IDENTICAL stickers for this session's lot. Printing is NOT receiving. */
export const printSessionLabels = (receiptId, count) =>
  unwrap(apiClient.post(`/lot-receiving/sessions/${receiptId}/print-labels`, { count }));

/** Stickers for a lot on demand, with no receiving session — the lazy cutover path. */
export const printLotLabels = (lotId, count) =>
  unwrap(apiClient.post(`/lot-receiving/lots/${lotId}/print-labels`, { count }));

/** A scanned rack label -> exactly one row. Refuses an ambiguous name. */
export const resolveRow = (code) =>
  unwrap(apiClient.get('/lot-receiving/resolve-row', { params: { code } }));

/** What a sticker says, without recording anything. */
export const lookupLot = (code) =>
  unwrap(apiClient.get('/lot-receiving/lots/lookup', { params: { code } }));

// ─── cutover ─────────────────────────────────────────────────────────────────

export const getCutoverStatus = () => unwrap(apiClient.get('/lot-cutover/status'));

/** What the zero-out would do. Reviewed before it runs, every time. */
export const previewZeroOut = () => unwrap(apiClient.get('/lot-cutover/zero-out/preview'));

/** Run step 1. `confirm` is required in the body — this one cannot be undone. */
export const runZeroOut = (note) =>
  unwrap(apiClient.post('/lot-cutover/zero-out', { confirm: true, note }));

/** One (lot, rack) counted by hand. Creates the lot and its placement together. */
export const createOpeningBalance = (payload) =>
  unwrap(apiClient.post('/lot-cutover/opening-balance', payload));

/** A physical count with its variance — the first flow that can raise stock. */
export const countRow = (payload) => unwrap(apiClient.post('/lot-cutover/count', payload));

/** Lots holding stock that have never had a sticker printed. */
export const listUnlabelledLots = () => unwrap(apiClient.get('/lot-cutover/unlabelled-lots'));

/** Every lot physically holding stock — what a recount picks from. */
export const listLotsOnHand = () => unwrap(apiClient.get('/lot-cutover/lots-on-hand'));
