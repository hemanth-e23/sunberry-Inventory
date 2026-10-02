// Words and numbers for the gun's staging-pull screens (browser test PART 3).
//
// The tester saw "22776 of 89754.66 staged", "IN_PROGRESS", "Formula unknown",
// pounds with no drum counts, "Each scan is 1" with no unit, the raw code
// "short_pull", "Submit 3360 on cart" adding pounds across three products, and
// a rack picker that said "15 units here" for drums and bags together. Every
// such phrase is built here, from server data, so it can be tested without a
// gun in hand.

import { pluralizeUnit, singularUnit } from './rowSources';
import { unitCount } from './truckReceiving';

const number = (n, maxDigits = 2) => Number(n || 0).toLocaleString('en-US', {
  maximumFractionDigits: maxDigits,
});

/** "22,776", "89,754.66" — never a raw float. */
export const formatQty = (n) => number(n, 2);

const STATUS_WORDS = {
  pending: 'Not started',
  in_progress: 'In progress',
  partially_fulfilled: 'Partly staged',
  partial: 'Partly staged',
  fulfilled: 'All staged',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

/** Plain words for a request/line status — never "IN_PROGRESS". */
export const pullStatusLabel = (status) => {
  const key = String(status || '').toLowerCase();
  if (STATUS_WORDS[key]) return STATUS_WORDS[key];
  if (!key) return '';
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * The status word for a request card (N8). A request whose stored status
 * still says "pending" but has stock staged is NOT "Not started" — old
 * requests, and ones whose staging came in by a path that never re-rated
 * the request, read that way with 474 lbs on the floor.
 */
export const requestStatusLabel = (request = {}) => {
  const key = String(request?.status || '').toLowerCase();
  const done = Number(request?.fulfilled_qty) || 0;
  const needed = Number(request?.needed_qty) || 0;
  if (key === 'pending' && done > 0.001) {
    return needed > 0 && done >= needed - 0.001 ? STATUS_WORDS.fulfilled : STATUS_WORDS.partial;
  }
  return pullStatusLabel(request?.status);
};

/** "22,776 of 89,754.66 lbs staged" (unit only when the server knows it). */
export const progressLine = ({ fulfilled_qty: done, needed_qty: needed, unit } = {}) => (
  `${formatQty(done)} of ${formatQty(needed)}${unit ? ` ${unit}` : ''} staged`
);

/** "2 drums + 1 open drum" from [{unit_label, units, open_units}]. */
export const unitsWords = (list = []) => {
  const parts = [];
  (list || []).forEach((u) => {
    const label = u?.unit_label || 'unit';
    if (Number(u?.units) > 0) parts.push(unitCount(u.units, label));
    if (Number(u?.open_units) > 0) parts.push(`${unitCount(u.open_units, `open ${singularUnit(label) || label}`)}`);
  });
  return parts.join(' + ');
};

/** The word after "Each scan is N": "bag" / "bags", or "unit(s)" when unknown. */
export const perScanUnit = (n, label) => {
  const one = singularUnit(label || '') || 'unit';
  return Number(n) === 1 ? one : pluralizeUnit(one);
};

const DRUM_LIKE = ['drum', 'barrel', 'tote', 'pail', 'keg', 'ibc', 'bucket', 'jug'];

/** Only a container that can be part-used gets a "Pull open …" button. */
export const isDrumLike = (label) => DRUM_LIKE.includes(
  (singularUnit(String(label || '').toLowerCase()) || '').trim(),
);

/**
 * The container word to offer "Pull open …" for, or null when nothing on this
 * request comes in drums (a bag rack never sees the button — PART 3, U1).
 */
export const openPullUnit = (items = []) => {
  for (const it of items || []) {
    const labels = [it?.unit_label, it?.suggestion?.unit_label, ...(it?.unit_labels || [])];
    const hit = labels.find((l) => isDrumLike(l));
    if (hit) return singularUnit(hit) || hit;
    if (Number(it?.suggestion?.open_units) > 0) return singularUnit(it.unit_label || '') || 'unit';
  }
  return null;
};

const sameCode = (a, b) => !!a && !!b && String(a).toUpperCase() === String(b).toUpperCase();

/**
 * Which request line a queued sticker belongs to, from the lot lists the
 * server sent (works offline). `null` when the gun cannot tell — the server
 * decides when the scan goes through.
 */
export const itemForLot = (items = [], { lotCode, vendorLot } = {}) => {
  for (const it of items || []) {
    const lots = it?.lots || [];
    if (lots.some((l) => sameCode(l.lot_code, lotCode))) return it;
    if (vendorLot && lots.some((l) => sameCode(l.vendor_lot, vendorLot))) return it;
  }
  return null;
};

/**
 * Queued (not yet on the server) pulls per line: `{ byItem: {id: [{unit_label,
 * units, open_units}]}, unmatched: n }`. "On cart" counts these too (B9).
 */
export const queuedByItem = (items = [], queued = []) => {
  const byItem = {};
  let unmatched = 0;
  (queued || []).forEach((q) => {
    const p = q?.payload || {};
    const it = itemForLot(items, { lotCode: p.lot_code_hint || p.code, vendorLot: p.vendor_lot_hint });
    const units = Number(p.units) || 1;
    if (!it) { unmatched += p.pull_open ? 1 : units; return; }
    const lot = (it.lots || []).find((l) => sameCode(l.lot_code, p.lot_code_hint || p.code)
      || sameCode(l.vendor_lot, p.vendor_lot_hint));
    const label = lot?.unit_label || it.unit_label || 'unit';
    const list = byItem[it.id] || (byItem[it.id] = []);
    let entry = list.find((e) => e.unit_label === label);
    if (!entry) { entry = { unit_label: label, units: 0, open_units: 0 }; list.push(entry); }
    if (p.pull_open) entry.open_units += 1; else entry.units += units;
  });
  return { byItem, unmatched };
};

/**
 * One line per product for the submit panel: "Mango Puree — 5 drums (2,510
 * lbs)". Never one pound figure added across products (PART 3, U1).
 */
export const cartSummary = (items = []) => (items || [])
  .filter((it) => Number(it?.pending_qty) > 0 || (it?.pending_units || []).some((u) => u.units || u.open_units))
  .map((it) => {
    const words = unitsWords(it.pending_units);
    const lbs = Number(it.pending_qty) > 0 ? `${formatQty(it.pending_qty)} ${it.unit || 'lbs'}` : '';
    return {
      id: it.id,
      name: it.ingredient_name || it.sid || 'Item',
      text: words ? `${words}${lbs ? ` (${lbs})` : ''}` : lbs,
    };
  });

/** `{ rowId: [{unit_label, units}] }` from the server's rack-fill answer. */
export const rackFillUnitsMap = (fill) => {
  const out = {};
  (Array.isArray(fill) ? fill : fill?.rows || []).forEach((r) => {
    if (r?.storage_row_id && Array.isArray(r.by_unit)) out[r.storage_row_id] = r.by_unit;
  });
  return out;
};

/**
 * The rack picker's fill, per container word: "3/12 drums · 12 bags", never
 * "15 units here" for drums and bags together (PART 3, B9). `queuedOff` is
 * what this gun has pulled off the rack but not yet sent.
 */
export const rackFillText = (row, byUnit, total = 0, queuedOff = 0) => {
  const list = (byUnit || []).filter((u) => Number(u.units) > 0).map((u) => ({ ...u }));
  if (queuedOff > 0 && list.length === 1) {
    list[0].units = Math.max(0, list[0].units - queuedOff);
  }
  const cap = Number(row?.unit_capacity) || 0;
  const capUnit = singularUnit(row?.storage_unit || '');
  if (list.length === 0) {
    const n = Math.max(0, (Number(total) || 0) - queuedOff);
    if (cap > 0 && capUnit) return { text: `${number(n)}/${number(cap)} ${pluralizeUnit(capUnit)}`, full: n >= cap };
    if (n > 0) return { text: `${unitCount(n, capUnit || 'unit')} here`, full: false };
    return { text: capUnit ? 'empty' : '', full: false };
  }
  let full = false;
  const text = list.map((u) => {
    const label = singularUnit(u.unit_label || 'unit') || 'unit';
    if (cap > 0 && capUnit && label === capUnit) {
      full = u.units >= cap;
      return `${number(u.units)}/${number(cap)} ${pluralizeUnit(label)}`;
    }
    return unitCount(u.units, label);
  }).join(' · ');
  return { text, full };
};

/**
 * Why "Submit to staging" cannot be pressed right now, in the worker's words —
 * a greyed button with no reason was B9. `null` when it can.
 */
export const submitBlockReason = ({
  online = true, queuedCount = 0, attentionCount = 0, panelOpen = false,
  locationId = '', busy = false,
} = {}) => {
  if (busy) return 'Working…';
  if (attentionCount > 0) {
    return `${attentionCount} scan${attentionCount === 1 ? ' needs' : 's need'} attention first — Retry or Discard ${attentionCount === 1 ? 'it' : 'them'} above.`;
  }
  if (!online && queuedCount > 0) {
    return `Offline — ${queuedCount} scan${queuedCount === 1 ? ' is' : 's are'} saved on this gun. Submit once they have sent (by themselves, when the wifi is back).`;
  }
  if (!online) return 'Offline — submitting needs the server. It is back by itself when the wifi is.';
  if (queuedCount > 0) {
    return `Sending ${queuedCount} scan${queuedCount === 1 ? '' : 's'}… submit once ${queuedCount === 1 ? 'it has' : 'they have'} gone through.`;
  }
  if (panelOpen && !locationId) return 'Pick where the cart is staged.';
  return null;
};

/**
 * A history row's lot: the vendor's lot number off the drum, never our lot
 * code ("QAING-A.VENDOR-….A-0925.20270301" — B9).
 */
export const lotDisplayName = ({ vendorLot, lotCode } = {}) => {
  if (vendorLot) return `Lot ${vendorLot}`;
  if (lotCode) return `Lot ${lotCode}`;
  return 'Lot ?';
};

/** What a not-yet-confirmed row says: plain, and different offline. */
export const queuedRowMessage = (online) => (
  online ? 'Sending…' : 'Saved on this gun — sends by itself when the wifi is back'
);
