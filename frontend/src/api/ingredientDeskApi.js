/**
 * Desk-side ingredient intake API — SPEC §8.1-8.2 (check-in, lot lines,
 * lifecycle) and §5 (mint + reprint scopes).
 *
 * Deliberately NOT wired into AppDataContext (audit D11). That store is eager:
 * everything in it is fetched for every logged-in user on every page load.
 * Intakes are fine, but the container lists these screens page through are
 * high-cardinality (one row per physical drum, hundreds per truck), so they are
 * fetched per-screen, bounded, and the server's `truncated` flag is surfaced
 * rather than swallowed (§18.9: a bounded list must say what it dropped).
 *
 * Thin wrappers only — no response reshaping. The routers already return
 * display-ready payloads including `count_unit` ("80 barrels", never "cases"),
 * and a mapper here would be one more place for that to drift.
 */
import apiClient from './client';

const INTAKES = '/ingredient-intakes';
const CONTAINERS = '/ingredient-containers';

/** Server caps the container page at 500 (`MAX_CONTAINER_PAGE`). */
export const MAX_CONTAINER_PAGE = 500;

/** Reprint scopes accepted by GET /{id}/labels. */
export const LABEL_SCOPE = {
  INTAKE: 'intake',
  LOT: 'lot',
  SELECTION: 'selection',
};

// ─── intakes ─────────────────────────────────────────────────────────────────

export const listIntakes = ({ status, skip = 0, limit = 50 } = {}) =>
  apiClient.get(`${INTAKES}/`, {
    params: { status: status || undefined, skip, limit },
  });

export const getIntake = (intakeId) => apiClient.get(`${INTAKES}/${intakeId}`);

export const createIntake = (payload) => apiClient.post(`${INTAKES}/`, payload);

/** Header edits while the intake is open. Send only the changed keys — the
 *  router applies `exclude_unset`, so an untouched field is left alone rather
 *  than rewritten with whatever the form happened to be holding. */
export const updateIntake = (intakeId, payload) =>
  apiClient.patch(`${INTAKES}/${intakeId}`, payload);

// ─── lot lines ───────────────────────────────────────────────────────────────

export const addIntakeLot = (intakeId, payload) =>
  apiClient.post(`${INTAKES}/${intakeId}/lots`, payload);

/** I-8: editing `vendor_lot`/`bbd` fans the change out to this lot's container
 *  records server-side. Already-printed stickers are NOT reprinted by this —
 *  lookup is truth and the record self-corrects at scan. */
export const updateIntakeLot = (intakeId, lotId, payload) =>
  apiClient.patch(`${INTAKES}/${intakeId}/lots/${lotId}`, payload);

// ─── minting & labels ────────────────────────────────────────────────────────

/** Returns a LabelSheet — feed it straight to `IntakeLabelPrint`. */
export const mintSerials = (intakeId, intakeLotId, count) =>
  apiClient.post(`${INTAKES}/${intakeId}/mint`, {
    intake_lot_id: intakeLotId,
    count,
  });

/**
 * Reprint at any scope, always the SAME serials (§5).
 * `lot_id` / `serials` are only sent for the scope that uses them so a stale
 * bit of component state cannot leak into an unrelated request.
 */
export const getLabelSheet = (
  intakeId,
  { scope = LABEL_SCOPE.INTAKE, lotId, serials } = {},
) =>
  apiClient.get(`${INTAKES}/${intakeId}/labels`, {
    params: {
      scope,
      lot_id: scope === LABEL_SCOPE.LOT ? lotId : undefined,
      serials:
        scope === LABEL_SCOPE.SELECTION && serials && serials.length
          ? serials.join(',')
          : undefined,
    },
  });

// ─── lifecycle ───────────────────────────────────────────────────────────────

/** I-1: unapplied serials stay unapplied. A short receipt never burns identity,
 *  so drums found in the trailer corner tomorrow still scan normally. */
export const closeShort = (intakeId, shortReason) =>
  apiClient.post(`${INTAKES}/${intakeId}/close-short`, {
    short_reason: shortReason,
  });

export const submitIntake = (intakeId) =>
  apiClient.post(`${INTAKES}/${intakeId}/submit`);

/** I-5/I-6/I-10. Serials are burned. Zero-scan intakes are free to void; one
 *  with scans is refused for non-approval roles by the server. */
export const voidIntake = (intakeId, reason) =>
  apiClient.post(`${INTAKES}/${intakeId}/void`, { reason });

// ─── containers (for the serial multi-picker) ────────────────────────────────

export const listIntakeContainers = ({
  intakeId,
  intakeLotId,
  q,
  skip = 0,
  limit = MAX_CONTAINER_PAGE,
} = {}) =>
  apiClient.get(`${CONTAINERS}/`, {
    params: {
      intake_id: intakeId,
      intake_lot_id: intakeLotId || undefined,
      q: q || undefined,
      skip,
      limit,
    },
  });

// ─── errors ──────────────────────────────────────────────────────────────────

/**
 * Best human-readable message out of an axios failure.
 *
 * FastAPI sends `detail` as a string for our own raised errors but as a LIST of
 * `{loc, msg, type}` objects for request-validation failures. Rendering the raw
 * value gives the user "[object Object]", which is how a fixable typo turns
 * into a support call.
 */
export const apiErrorMessage = (err, fallback = 'Request failed.') => {
  const detail = err?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail) && detail.length > 0) {
    const first = detail[0];
    if (typeof first === 'string') return first;
    if (first?.msg) return String(first.msg);
  }
  const message = err?.response?.data?.message;
  if (typeof message === 'string' && message.trim()) return message;
  return err?.message || fallback;
};
