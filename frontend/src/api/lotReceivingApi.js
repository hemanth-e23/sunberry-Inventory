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

/**
 * Draft -> in transit, WITH the arrival slot.
 *
 * A separate step from creating: corporate raises the order when they have the
 * PO, and agrees the day with the carrier afterwards. The server requires a
 * date, because the plant's screen is organised by day and an order without one
 * would sit outside every day view.
 */
export const releaseIncomingOrder = (orderId, { expected_date, expected_time } = {}) =>
  unwrap(apiClient.post(`/lot-receiving/orders/${orderId}/release`, {
    expected_date: expected_date || null,
    expected_time: expected_time || null,
  }));

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

/**
 * Per-receipt sessions the gun can pick up. `walkInOnly` drops receipts that
 * belong to an incoming order — those are received a TRUCK at a time now.
 */
export const listReceivingSessions = ({ walkInOnly = false } = {}) =>
  unwrap(apiClient.get('/lot-receiving/sessions', {
    params: walkInOnly ? { walk_in_only: true } : undefined,
  }));

/** Paperwork vs scanned, per row. Also what the gun resumes from. */
export const getReceivingSession = (receiptId) =>
  unwrap(apiClient.get(`/lot-receiving/sessions/${receiptId}`));

/**
 * Finish a line and take it off the gun.
 *
 * Returns `needs_confirm` with the difference in words when the count disagrees
 * with the paperwork — call again with `confirmed` to go through. Short and over
 * are both legal; the confirm exists so the difference is said out loud, not to
 * block it.
 */
export const submitReceivingSession = (receiptId, { confirmed = false } = {}) =>
  unwrap(apiClient.post(
    `/lot-receiving/sessions/${receiptId}/submit`,
    null,
    { params: { confirmed } },
  ));

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

/**
 * `count` IDENTICAL stickers for this session's lot. Printing is NOT receiving.
 *
 * `scope` is 'unit' (one per drum/bag/box) or 'pallet' (one per wrapped pallet,
 * for material nobody destacks at the dock). Same sticker either way — same lot,
 * same code, same QR — with one word different in the middle band.
 */
export const printSessionLabels = (receiptId, count, { scope = 'unit' } = {}) =>
  unwrap(apiClient.post(`/lot-receiving/sessions/${receiptId}/print-labels`, { count, scope }));

/** Stickers for a lot on demand, with no receiving session — the lazy cutover path. */
export const printLotLabels = (lotId, count, { scope = 'unit' } = {}) =>
  unwrap(apiClient.post(`/lot-receiving/lots/${lotId}/print-labels`, { count, scope }));

/** A scanned rack label -> exactly one row. Refuses an ambiguous name. */
/** Which rack each DELIVERY of a product was put away on, from the ledger.
  * The projection cannot answer this — placements belong to the lot, not to
  * one truck. See `received_into_by_receipt`. */
export const receivedInto = (productId) =>
  unwrap(apiClient.get('/lot-receiving/received-into', { params: { product_id: productId } }));

/** Units on each rack right now, for the gun's rack picker ("11/12 drums"). */
export const getRackFill = () => unwrap(apiClient.get('/lot-receiving/rack-fill'));

export const resolveRow = (code) =>
  unwrap(apiClient.get('/lot-receiving/resolve-row', { params: { code } }));

/** What a sticker says, without recording anything. */
export const lookupLot = (code) =>
  unwrap(apiClient.get('/lot-receiving/lots/lookup', { params: { code } }));

// Weight per unit of earlier deliveries of the same lot (product + vendor +
// vendor lot + best-by) — read only, for the "different weight, correct?" hint.
export const knownLotWeights = ({ product_id, vendor_id, vendor_lot, bbd }) =>
  unwrap(apiClient.get('/lot-receiving/lots/known-weights', {
    params: { product_id, vendor_lot, vendor_id: vendor_id || undefined, bbd: bbd || undefined },
  }));

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

// ─── trucks: one gun session per incoming order (2026-10) ───────────────────
//
// The worker scans a rack, then ANY drum on the trailer; the server routes it to
// its own line by the lot on the sticker. Every scan-path answer is a 200 with a
// `status` and the whole truck attached, so the gun redraws from server truth.

/** The desk checks the whole truck in against the driver's BOL. */
export const checkInTruck = (orderId, payload) =>
  unwrap(apiClient.post(`/lot-receiving/orders/${orderId}/check-in`, payload));

/** Trucks the gun can pick up: checked in and not finished. */
export const listTrucks = () => unwrap(apiClient.get('/lot-receiving/trucks'));

export const getTruck = (orderId) => unwrap(apiClient.get(`/lot-receiving/trucks/${orderId}`));

/** A drum scanned on the truck list -> the open truck(s) carrying its lot. */
export const locateTruck = (code) =>
  unwrap(apiClient.get('/lot-receiving/trucks/locate', { params: { code } }));

/** Queue endpoint for a truck scan — one definition for the queued and live paths. */
export const truckScanEndpoint = (orderId) => `/lot-receiving/trucks/${orderId}/scan`;

export const orderIdFromTruckEndpoint = (endpoint) => {
  const match = /\/lot-receiving\/trucks\/([^/]+)\/scan$/.exec(endpoint || '');
  return match ? match[1] : null;
};

/** One scan's worth of a SPECIFIC lot off a SPECIFIC rack. Idempotent by key. */
export const truckRemove = (orderId, payload) =>
  unwrap(apiClient.post(`/lot-receiving/trucks/${orderId}/remove`, payload));

/** The worker counted a rack by eye; the count wins and differences are flagged. */
export const truckRecount = (orderId, payload) =>
  unwrap(apiClient.post(`/lot-receiving/trucks/${orderId}/recount`, payload));

/** Finish the whole truck. Soft answers: needs_recount / needs_confirm / needs_reason. */
export const truckFinish = (orderId, payload = {}) =>
  unwrap(apiClient.post(`/lot-receiving/trucks/${orderId}/finish`, payload));

/** Approve every line of a finished truck in one go, then close the order. */
export const approveTruck = (orderId) =>
  unwrap(apiClient.post(`/lot-receiving/trucks/${orderId}/approve`));

// ─── count approvals: a warehouse user's count waits for a supervisor ────────
export const listCountRequests = (status = 'pending') =>
  unwrap(apiClient.get('/lot-cutover/count-requests', { params: { status } }));
export const approveCountRequest = (id) =>
  unwrap(apiClient.post(`/lot-cutover/count-requests/${id}/approve`));
export const rejectCountRequest = (id, reason) =>
  unwrap(apiClient.post(`/lot-cutover/count-requests/${id}/reject`, null, { params: { reason } }));
