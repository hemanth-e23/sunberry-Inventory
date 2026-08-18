// Container label 2D payload — encode + decode, and the print ordering helper.
//
// SPEC §5 / IMPL-COMMENT 7 (audit D12). The wire format is FIXED. Do not
// redesign it: every sticker printed from Phase 2 onward carries it, and
// Phase 4 production scanning parses it as the offline fallback. There is
// exactly one implementation of the format — this file — so encoder and
// decoder cannot drift apart.
//
//     SB1|<serial>|<vendor_lot>|<bbd YYYYMMDD>
//
// Why a version prefix: fields are ADDITIVE later. A future `SB2` appends
// segments; positions 1..3 never move. That is what lets `decodeContainerPayload`
// read an unknown future version well enough to recover the serial instead of
// rejecting the scan.
//
// Why a bare serial (no `|`) also parses: hand-keying a serial off a scuffed
// drum, and §5's X-3 relabel path where only the serial is known. A bare token
// decodes to `{ bare: true }` with empty lot/BBD — the caller must fall back to
// lookup for everything else.
//
// Why `|` inside vendor_lot is REJECTED at build time instead of escaped
// (audit D12): escaping needs an unescaper on every future reader, including
// non-JS ones (thermal firmware, a handheld's built-in parser). Vendor lots are
// alphanumeric in practice; the backend rejects `|` in `intake_lots.vendor_lot`
// at intake, and this throws if one ever slips through, so a malformed payload
// is never printed onto a drum.
//
// ── Dates ────────────────────────────────────────────────────────────────────
// BBD is a CALENDAR DATE, not an instant, so it is read lexically off the
// leading `YYYY-MM-DD` of the value and never passed through a timezone
// conversion. `dateUtils.toDateKey()` would shift a `2027-02-15T00:00:00Z` BBD
// to `2027-02-14` in any US warehouse timezone and print the wrong best-by date
// on a food-safety label. The existing FG sticker does the same lexical read for
// exactly this reason (`PalletStickerLayout.jsx:35-40`). Timestamps that really
// are instants (the RCV date) still go through `dateUtils`.
// This also makes `encodeContainerPayload` deterministic: the same container
// encodes byte-identically regardless of which browser or timezone prints it.

export const PAYLOAD_VERSION = 'SB1';
export const PAYLOAD_DELIMITER = '|';

// Any `SB<digits>` envelope is structurally recognisable, not just our own.
const VERSION_RE = /^SB\d+$/;
const ISO_DATE_HEAD = /^(\d{4})-(\d{2})-(\d{2})/;
const COMPACT_DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;

const isRealCalendarDate = (y, m, d) =>
  m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1000 && y <= 9999;

/**
 * Calendar day of a BBD-like value as `YYYY-MM-DD`, or `''`.
 *
 * Accepts an ISO string (`2027-02-15`, `2027-02-15T00:00:00Z`) or a `Date`.
 * Strings are read lexically — no timezone math. A `Date` has no calendar day
 * of its own, so its LOCAL day is used (matches what the operator sees on
 * screen); in practice the API always sends strings.
 */
export const toCalendarKey = (value) => {
  if (value === null || value === undefined || value === '') return '';

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const y = value.getFullYear();
    const m = value.getMonth() + 1;
    const d = value.getDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  const match = ISO_DATE_HEAD.exec(String(value).trim());
  if (!match) return '';
  const [, y, m, d] = match;
  if (!isRealCalendarDate(Number(y), Number(m), Number(d))) return '';
  return `${y}-${m}-${d}`;
};

/** `YYYYMMDD` for the payload's 4th segment, or `''` when there is no BBD. */
export const toBbdCompact = (value) => toCalendarKey(value).replace(/-/g, '');

/** `YYYYMMDD` → `YYYY-MM-DD`. `''` for anything that is not a real date. */
export const fromBbdCompact = (value) => {
  if (!value) return '';
  const match = COMPACT_DATE_RE.exec(String(value).trim());
  if (!match) return '';
  const [, y, m, d] = match;
  if (!isRealCalendarDate(Number(y), Number(m), Number(d))) return '';
  return `${y}-${m}-${d}`;
};

/** `MM/DD/YYYY` for label text. Unparseable values echo through unchanged so a
 *  bad date is visible to the human rather than silently blanked. */
export const formatCalendarDate = (value) => {
  const key = toCalendarKey(value);
  if (!key) return value ? String(value) : '';
  const [y, m, d] = key.split('-');
  return `${m}/${d}/${y}`;
};

/**
 * Build the 2D payload for a container.
 *
 * @param {object} container `{ serial, vendor_lot, bbd }` (camelCase aliases
 *        accepted) — i.e. a `Container` row straight off the API.
 * @returns {string} `SB1|serial|vendor_lot|YYYYMMDD`
 *
 * Always four segments. Empty trailing segments are KEPT so field positions are
 * fixed and a future `SB2` can append without ambiguity.
 *
 * Throws when the payload would be structurally corrupt (no serial, or a `|`
 * inside a field). It does NOT throw on a missing or unreadable BBD — that
 * segment goes out empty. The payload is explicitly a fallback; lookup is the
 * source of truth, and one drum with a bad BBD must not abort an 80-label
 * batch print. The BBD is also printed as text, so the human still sees it.
 */
export const encodeContainerPayload = (container = {}) => {
  const source = container || {};

  const serial = String(source.serial ?? '').trim();
  if (!serial) {
    throw new Error('encodeContainerPayload: serial is required');
  }
  if (serial.includes(PAYLOAD_DELIMITER)) {
    throw new Error(`encodeContainerPayload: serial may not contain "${PAYLOAD_DELIMITER}"`);
  }

  const vendorLot = String(source.vendor_lot ?? source.vendorLot ?? '').trim();
  if (vendorLot.includes(PAYLOAD_DELIMITER)) {
    throw new Error(
      `encodeContainerPayload: vendor lot may not contain "${PAYLOAD_DELIMITER}" `
      + '(reject it at intake — the payload does not escape)',
    );
  }

  const bbd = toBbdCompact(source.bbd ?? source.best_by_date ?? source.bbdDate);

  return [PAYLOAD_VERSION, serial, vendorLot, bbd].join(PAYLOAD_DELIMITER);
};

/**
 * Parse a scanned label payload.
 *
 * @param {string} raw scanner output.
 * @returns {null | {
 *   version: string|null, serial: string, vendorLot: string,
 *   bbd: string, bare: boolean, unknownVersion: boolean
 * }}  `bbd` comes back as `YYYY-MM-DD` (or `''`), not compact.
 *      `null` means "this is not one of our labels" — never a partial guess.
 *
 * Three accepted shapes:
 *   `SB1|serial|lot|20270215`  → full parse
 *   `SB9|serial|…`             → `unknownVersion: true`; serial still recovered,
 *                                because fields are additive and never reordered
 *   `B-260803-0042-017`        → `bare: true`, lot/BBD empty (hand-keyed, X-3 relabel)
 */
export const decodeContainerPayload = (raw) => {
  if (raw === null || raw === undefined) return null;

  const text = String(raw).trim();
  if (!text) return null;

  if (!text.includes(PAYLOAD_DELIMITER)) {
    return {
      version: null,
      serial: text,
      vendorLot: '',
      bbd: '',
      bare: true,
      unknownVersion: false,
    };
  }

  const parts = text.split(PAYLOAD_DELIMITER);
  const version = parts[0].trim().toUpperCase();
  if (!VERSION_RE.test(version)) return null;

  const serial = (parts[1] ?? '').trim();
  if (!serial) return null;

  return {
    version,
    serial,
    vendorLot: (parts[2] ?? '').trim(),
    bbd: fromBbdCompact(parts[3]),
    bare: false,
    unknownVersion: version !== PAYLOAD_VERSION,
  };
};

// ─── Print ordering ──────────────────────────────────────────────────────────
// SPEC §5: "print in lot order, per-lot stacks with divider". Every reprint
// scope (one / selection / lot line / whole intake) prints a stack, and a stack
// that interleaves lots gets misapplied on the dock.

const lotKeyOf = (container) => String(container?.intake_lot_id ?? container?.intakeLotId ?? '');

const sequenceOf = (container) => {
  const raw = container?.sequence;
  const n = Number(raw);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
};

/**
 * Group containers into per-lot stacks, each stack ordered by `sequence`
 * (equivalent to `ORDER BY intake_lot_id, sequence`).
 *
 * Lots are ordered by `intake_lot_id`. The ids are opaque, so the order
 * BETWEEN lots is arbitrary either way — what matters, and what this
 * guarantees, is that a lot's drums come off the printer contiguous and in
 * sequence, and that the same input always yields the same stack. Containers
 * with no lot id sort into a trailing group rather than leading it.
 *
 * @returns {Array<{ intakeLotId: string, vendorLot: string, containers: object[] }>}
 */
export const groupContainersByLot = (containers = []) => {
  const groups = new Map();

  (containers || []).filter(Boolean).forEach((container) => {
    const key = lotKeyOf(container);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(container);
  });

  return [...groups.entries()]
    .sort(([a], [b]) => {
      // Unknown-lot containers are the anomaly; print them last.
      if (!a) return b ? 1 : 0;
      if (!b) return -1;
      if (a === b) return 0;
      return a < b ? -1 : 1;
    })
    .map(([intakeLotId, items]) => {
      const ordered = [...items].sort((x, y) => {
        const bySeq = sequenceOf(x) - sequenceOf(y);
        if (bySeq) return bySeq;
        // Deterministic tiebreak when sequence is missing on both.
        const sx = String(x?.serial ?? '');
        const sy = String(y?.serial ?? '');
        if (sx === sy) return 0;
        return sx < sy ? -1 : 1;
      });
      const withLot = ordered.find((c) => c?.vendor_lot ?? c?.vendorLot);
      return {
        intakeLotId,
        vendorLot: String(withLot?.vendor_lot ?? withLot?.vendorLot ?? ''),
        containers: ordered,
      };
    });
};

/** Flat version of {@link groupContainersByLot} — the stacks, concatenated. */
export const orderContainersForPrint = (containers = []) =>
  groupContainersByLot(containers).flatMap((group) => group.containers);

// ─── SB2 — the lot-level envelope ────────────────────────────────────────────
//
//     SB2|<lot_code>|<vendor_lot>|<bbd YYYYMMDD>
//
// Positions are IDENTICAL to SB1; only the meaning of segment 2 changes, from a
// per-drum serial to a lot code. That is not a coincidence — the SB1 header
// above promised fields would be additive and positions 1..3 would never move,
// and `decodeContainerPayload` already recovers segment 2 from any unknown
// `SB<digits>` version. So a gun still running old code reads an SB2 sticker and
// gets the lot code where it expected a serial, rather than rejecting the scan.
// This is the migration path that was designed in; SB1 is not redefined.
//
// EVERY UNIT OF A LOT WEARS AN IDENTICAL STICKER. There is no per-drum identity
// to encode, which is the whole point: a serial minted at our plant is
// meaningless at a third-party warehouse, and a physical count that disagrees by
// one drum has no answer to "which serial do I remove?".
//
// The QR carries `lot_code` and NOTHING ELSE that matters. Segments 3 and 4 are
// human-convenience duplicates of what is printed as text; a reader must always
// prefer the lookup. That is what keeps a printed sticker from ever going stale:
// a BBD extension moves `bbd_current`, and the lot code still points at the
// right lot.

export const LOT_PAYLOAD_VERSION = 'SB2';

/**
 * Build the 2D payload for a lot sticker.
 *
 * @param {object} lot `{ lot_code, vendor_lot, bbd }` (camelCase accepted).
 * @returns {string} `SB2|lot_code|vendor_lot|YYYYMMDD`
 *
 * Throws when the payload would be structurally corrupt. Does NOT throw on a
 * missing BBD — that segment goes out empty, because one lot with an unreadable
 * date must not abort an 80-sticker print run and the date is printed as text
 * anyway.
 */
export const encodeLotPayload = (lot = {}) => {
  const source = lot || {};

  const lotCode = String(source.lot_code ?? source.lotCode ?? '').trim();
  if (!lotCode) {
    throw new Error('encodeLotPayload: lot_code is required');
  }
  if (lotCode.includes(PAYLOAD_DELIMITER)) {
    throw new Error(`encodeLotPayload: lot code may not contain "${PAYLOAD_DELIMITER}"`);
  }

  const vendorLot = String(source.vendor_lot ?? source.vendorLot ?? '').trim();
  if (vendorLot.includes(PAYLOAD_DELIMITER)) {
    throw new Error(
      `encodeLotPayload: vendor lot may not contain "${PAYLOAD_DELIMITER}" `
      + '(reject it at entry — the payload does not escape)',
    );
  }

  const bbd = toBbdCompact(source.bbd ?? source.best_by_date ?? source.bbdDate);

  return [LOT_PAYLOAD_VERSION, lotCode, vendorLot, bbd].join(PAYLOAD_DELIMITER);
};

/**
 * Parse a scanned lot sticker.
 *
 * @returns {null | { version, lotCode, vendorLot, bbd, bare, unknownVersion }}
 *
 * Accepts the same three shapes as {@link decodeContainerPayload}, including a
 * bare token with no delimiter — a lot code hand-keyed off a scuffed drum, which
 * is the only recovery available when a sticker is unreadable and there is no
 * second copy to compare against.
 *
 * The server accepts either form, so the gun never has to decide: it can post
 * the raw scan text and let one implementation unwrap it.
 */
export const decodeLotPayload = (raw) => {
  const parsed = decodeContainerPayload(raw);
  if (!parsed) return null;
  return {
    version: parsed.version,
    // Segment 2 — a serial under SB1, a lot code under SB2. Same position.
    lotCode: parsed.serial,
    vendorLot: parsed.vendorLot,
    bbd: parsed.bbd,
    bare: parsed.bare,
    unknownVersion: parsed.version !== null && parsed.version !== LOT_PAYLOAD_VERSION,
  };
};
