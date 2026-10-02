// Small pure helpers for truck receiving (2026-10), shared by the gun, the desk
// and the approvals page. Pure so they can be tested without rendering anything.

import { pluralizeUnit, singularUnit } from './rowSources';

/**
 * A scanner trigger that bounces reads the same sticker twice within a few
 * hundred milliseconds. A real second drum never comes that fast — the worker
 * has to move the gun to it. Returns a function `(raw, now) => true` when the
 * read should be IGNORED as a double fire.
 *
 * Only an IDENTICAL raw string inside the window counts. Identical stickers are
 * normal (every drum of a lot wears the same one), so this must never stretch
 * into a general "same lot again" rule.
 */
export const createDoubleFireGuard = (windowMs = 1000) => {
  let lastRaw = null;
  let lastAt = -Infinity;
  return (raw, now = Date.now()) => {
    const isBounce = raw === lastRaw && now - lastAt < windowMs;
    lastRaw = raw;
    lastAt = now;
    return isBounce;
  };
};

/**
 * Split pending receipts into trucks (receipts that are lines of one incoming
 * order) and everything else, keeping first-seen order for both.
 */
export const groupReceiptsByTruck = (receipts = []) => {
  const trucks = [];
  const byOrder = new Map();
  const singles = [];
  receipts.forEach((receipt) => {
    const orderId = receipt?.incomingOrderId;
    if (!orderId) {
      singles.push(receipt);
      return;
    }
    let group = byOrder.get(orderId);
    if (!group) {
      group = { orderId, orderNumber: receipt.incomingOrderNumber, receipts: [] };
      byOrder.set(orderId, group);
      trucks.push(group);
    }
    group.receipts.push(receipt);
  });
  return { trucks, singles };
};

const number = (n) => Number(n || 0).toLocaleString('en-US');

/**
 * "18 of 40 drums · 0 of 12,672 units" — one figure per kind of material.
 * Adding drums to bottles gives a number that means nothing.
 */
export const formatUnitTotals = (totals = [], { scannedKey = 'scanned' } = {}) =>
  (totals || [])
    .map((t) => `${number(t[scannedKey])} of ${number(t.expected)} ${pluralizeUnit(t.unit || 'unit')}`)
    .join(' · ');

/** "1 drum", "12 drums", "3 boxes" — never "1 drums" or "boxs". */
export const unitCount = (n, label = 'unit') => {
  const one = singularUnit(label || 'unit') || 'unit';
  return `${number(n)} ${Number(n) === 1 ? one : pluralizeUnit(one)}`;
};

const joinWords = (words, conjunction) => {
  if (words.length <= 1) return words[0] || '';
  return `${words.slice(0, -1).join(', ')} ${conjunction} ${words[words.length - 1]}`;
};

/**
 * The truck's own unit words, for every "scan a drum" the gun says. A truck of
 * bags and boxes was told "drums are blocked" and "Scan any drum" (browser test
 * F15). `{ one: 'bag or box', many: 'bags and boxes' }`.
 */
export const truckUnitWords = (lines = []) => {
  const seen = [];
  (lines || []).forEach((line) => {
    const word = singularUnit(line?.unit_label || line?.count_unit || '');
    if (word && !seen.includes(word)) seen.push(word);
  });
  if (!seen.length) return { one: 'unit', many: 'units' };
  return {
    one: joinWords(seen, 'or'),
    many: joinWords(seen.map(pluralizeUnit), 'and'),
  };
};

/**
 * Per-line mismatch the truck total hides. "22 of 22 drums" while lot A is 9 of
 * 8 and lot B 13 of 14 reads as done (browser test F15). The sum can only hide
 * a difference when some line is OVER, so that is when this speaks.
 * `countKey` picks the live count ('shown' on the gun, with queued scans).
 */
export const lineMismatchNote = (lines = [], { countKey = 'scanned_count' } = {}) => {
  let over = 0;
  let short = 0;
  (lines || []).forEach((line) => {
    const got = Number(line?.[countKey] ?? line?.scanned_count) || 0;
    const want = Number(line?.expected_count) || 0;
    if (got > want) over += 1;
    else if (got < want) short += 1;
  });
  if (!over) return '';
  const parts = [`${over} ${over === 1 ? 'line' : 'lines'} over`];
  if (short) parts.push(`${short} short`);
  return parts.join(', ');
};

/**
 * The question asked before a rack count that disagrees with the scans is
 * booked — a wrong recount silently removed stock (browser test F11).
 * Null when they agree.
 */
export const describeRecountDiff = ({ scanned, actual, unitLabel }) => {
  const s = Number(scanned) || 0;
  const a = Number(actual) || 0;
  if (s === a) return null;
  const diff = Math.abs(s - a);
  const what = unitCount(diff, unitLabel);
  return a < s
    ? `You scanned ${s}, you counted ${a} — ${what} missing?`
    : `You scanned ${s}, you counted ${a} — ${what} more than scanned?`;
};

/** Title of the over-the-paperwork stop: the line's own unit, and what it adds. */
export const overScanTitle = ({ units, countUnit }) => {
  const n = Number(units) || 1;
  if (n > 1) return `Stop — this scan adds ${unitCount(n, countUnit)}`;
  return `Stop — check this ${singularUnit(countUnit || 'unit') || 'unit'}`;
};

/**
 * "+40 bags · pallet" vs "+1 bag". A box sticker scanned in pallet mode must
 * look different from a single at a glance (browser test F12).
 */
export const scanUnitsBadge = (units, label) => {
  const n = Math.max(1, Number(units) || 1);
  return { text: `+${unitCount(n, label)}${n > 1 ? ' · pallet' : ''}`, pallet: n > 1 };
};

export const MAX_LOOSE_UNITS = 500;

/**
 * Parse the "loose units" quantity. Whole numbers 1..MAX only — each one is
 * booked as its own single scan with its own idempotency key.
 */
export const parseLooseQty = (raw) => {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) return { qty: 0, error: 'Type how many loose ones (a whole number).' };
  const qty = parseInt(text, 10);
  if (qty < 1) return { qty: 0, error: 'Type at least 1.' };
  if (qty > MAX_LOOSE_UNITS) return { qty: 0, error: `At most ${MAX_LOOSE_UNITS} at a time.` };
  return { qty, error: '' };
};

/** What the approval card says for one flag. */
export const describeFlag = (flag) => {
  // Product + the VENDOR's lot number: what is printed big on the drum. Our
  // sticker code is a long machine string nobody on the floor reads.
  const lotNumber = flag.vendor_lot || flag.lot_code;
  const lot = [flag.product_name, lotNumber && `lot ${lotNumber}`].filter(Boolean).join(' ') || 'A lot';
  const rack = flag.storage_row_name ? ` in ${flag.storage_row_name}` : '';
  switch (flag.kind) {
    case 'not_on_truck':
      return `${lot} was not on this truck's paperwork — received as extra`;
    case 'other_truck':
      return `${lot} was received here but is on another truck (${flag.detail || 'see order'})`;
    case 'over_paperwork':
      return `${lot}: more scanned than the paperwork (expected ${flag.expected})`;
    case 'lot_held':
      return `${lot} was on QA hold when it arrived — it stays held`;
    case 'rack_full':
      return `${lot}: loaded${rack} past its capacity`;
    case 'recount_corrected':
      return `${lot}${rack}: recount changed ${flag.expected} scanned → ${flag.actual} counted`;
    case 'short':
      return `${lot}: short — ${flag.actual} of ${flag.expected} (${flag.detail || 'no reason'})`;
    default:
      return flag.detail || flag.kind;
  }
};

/** Flags worth an approver's attention — a recount that agreed is not one. */
export const attentionFlags = (flags = []) => (flags || []).filter((f) => f.kind !== 'recount_ok');

const upperTrim = (v) => String(v ?? '').trim().toUpperCase();

/**
 * A code typed (or scanned bare) on a truck -> which line it means, without the
 * server (browser test G3). Workers read the VENDOR lot off the drum — "A-0925"
 * — and the gun refused it as "not expected on this truck" because only our
 * 44-character sticker code matched.
 *
 *   { kind: 'sticker',   lines: [line] }  our own lot code
 *   { kind: 'vendor',    lines: [line] }  the vendor lot, one line on this truck
 *   { kind: 'ambiguous', lines: [...] }   the vendor lot is on several lines —
 *                                         ASK which, never pick
 *   { kind: 'none',      lines: [] }
 */
export const matchTypedLot = (lines = [], code) => {
  const want = upperTrim(code);
  if (!want) return { kind: 'none', lines: [] };
  const all = lines || [];
  const bySticker = all.filter((l) => l?.lot_code && upperTrim(l.lot_code) === want);
  if (bySticker.length) return { kind: 'sticker', lines: bySticker.slice(0, 1) };
  const byVendor = all.filter((l) => l?.vendor_lot && upperTrim(l.vendor_lot) === want);
  if (byVendor.length === 1) return { kind: 'vendor', lines: byVendor };
  if (byVendor.length > 1) return { kind: 'ambiguous', lines: byVendor };
  return { kind: 'none', lines: [] };
};

/**
 * "11/12 drums" for the rack picker (browser test U10) — how FULL a rack is,
 * not just how big. `onHand` is what the server last said plus anything queued
 * on this gun. Capacity is a soft hint: `full` only colours the row.
 */
export const rackFillLabel = (row, onHand) => {
  const n = Math.max(0, Number(onHand) || 0);
  const unit = row?.storage_unit;
  const cap = Number(row?.unit_capacity) || 0;
  if (unit && cap > 0) {
    return { text: `${number(n)}/${number(cap)} ${pluralizeUnit(singularUnit(unit) || unit)}`, full: n >= cap };
  }
  if (n > 0) return { text: `${unitCount(n, unit || 'unit')} here`, full: false };
  if (unit) return { text: 'empty · no capacity set', full: false };
  return { text: '', full: false };
};

/** `{ rowId: units }` from the server's rack-fill answer. */
export const rackFillMap = (fill) => {
  const out = {};
  (Array.isArray(fill) ? fill : fill?.rows || []).forEach((r) => {
    if (r?.storage_row_id) out[r.storage_row_id] = Number(r.units) || 0;
  });
  return out;
};

/**
 * The pallet-or-bag guard (browser test U2). A pallet and a single bag of the
 * same lot wear the SAME code — one word differs in the printed band — so the
 * gun cannot tell them apart, and a bag sticker read in pallet mode books 40.
 * When the paperwork still had room for 40 nothing stopped it.
 *
 * The least annoying check that still catches it: ask ONCE per lot per rack,
 * on the first pallet-mode scan of that lot onto that rack. The answer is
 * remembered, so a run of pallets onto one rack is one question, not one per
 * pallet; and a bag sticker on a fresh rack — where the mix-up happens, at a
 * broken pallet — is caught before anything is booked.
 */
export const palletCheckKey = (lineId, rowId) => `${lineId || '?'}|${rowId || '?'}`;

export const needsPalletCheck = ({ unitsPerScan, confirmed, lineId, rowId }) => (
  (Number(unitsPerScan) || 1) > 1
  && !(confirmed && confirmed.has(palletCheckKey(lineId, rowId)))
);

/**
 * What a worker is told when the gun could not reach the server for something
 * that is not queued (finish, remove, load). Plain words; never a status code.
 */
export const offlineMessage = (what) => (
  `${what} — the gun cannot reach the server right now. Nothing was changed. `
  + 'Scans are saved on this gun and send by themselves when it is back.'
);

/** "QA Mango Puree · Lot A-0925 → QA-D4" for a queued scan, never an order id. */
export const queuedScanLabel = ({ productName, vendorLot, lotCode, rowName, units, unit }) => {
  const lot = vendorLot || lotCode;
  const what = [productName, lot && `Lot ${lot}`].filter(Boolean).join(' · ') || 'Scan';
  const qty = Number(units) > 1 ? `${unitCount(units, unit || 'unit')} of ` : '';
  return `${qty}${what}${rowName ? ` → ${rowName}` : ''}`;
};
