// Pure helpers for the desk's incoming-order / walk-in / check-in forms
// (2026-10-01 browser test, F14 + F17). Pure so they are testable without
// rendering the tab.

import { pluralizeUnit, singularUnit } from './rowSources';

/**
 * Plant rule: a delivery with no vendor lot, no best-by or no weight per unit is
 * NOT accepted. Returns what a form line still lacks, in the words the refusal
 * uses ([] when complete). Mirrors `_missing_line_details` on the server.
 */
export const missingLineDetails = (line = {}) => {
  const missing = [];
  if (!String(line.vendor_lot || '').trim()) missing.push('vendor lot');
  if (!line.bbd) missing.push('best-by date');
  if (!(Number(line.weight_per_unit) > 0)) missing.push(`weight per ${line.unit_label || 'unit'}`);
  return missing;
};

/** Same lot as the server's key: product + vendor + lot (spaces out, upper) + best-by day. */
export const lotLookupKey = ({ product_id, vendor_id, vendor_lot, bbd } = {}) => {
  const lot = String(vendor_lot || '').replace(/\s+/g, '').toUpperCase();
  if (!product_id || !lot) return null;
  return [product_id, vendor_id || '', lot, String(bbd || '').slice(0, 10)].join('|');
};

const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

/**
 * "Earlier delivery of A-0925 was 502 lb/drum — this one says 474. Correct?"
 *
 * `known` is the `/lots/known-weights` answer. Returns null when nothing is known,
 * nothing is typed yet, or an earlier delivery weighed the same as this one.
 * Never blocks anything: mixed weights are legal and tracked per delivery; the
 * warning exists because a second truck at a different weight is usually a typo.
 */
export const weightMismatchWarning = (known, typed, { vendorLot, unit } = {}) => {
  const now = Number(typed);
  if (!(now > 0)) return null;
  const earlier = [];
  (known?.lots || []).forEach((lot) => {
    (lot.weights || []).forEach((w) => {
      const value = Number(w.weight_per_unit);
      if (value > 0 && !earlier.includes(value)) earlier.push(value);
    });
  });
  // Matching ANY earlier delivery is a weight this lot is known to come in.
  if (!earlier.length || earlier.some((w) => Math.abs(w - now) < 0.005)) return null;
  const lotName = vendorLot || known?.lots?.[0]?.vendor_lot || 'this lot';
  const word = singularUnit(String(unit || known?.lots?.[0]?.unit_label || 'unit'));
  const list = earlier.map(fmt);
  const said = list.length === 1
    ? `Earlier delivery of ${lotName} was ${list[0]} lb/${word}`
    : `Earlier deliveries of ${lotName} were ${list.slice(0, -1).join(', ')} and ${list[list.length - 1]} lb/${word}`;
  return `${said} — this one says ${fmt(now)}. Correct?`;
};

/**
 * The gun has finished this truck and it is waiting for an approver. The order's
 * status stays `receiving` until approval, so the card read RECEIVING long after
 * the forklift was done (F15). Older trucks were finished line by line, so a
 * truck whose every line was submitted counts too.
 */
export const isAwaitingApproval = (order = {}) => {
  if (!['in_transit', 'receiving'].includes(order.status)) return false;
  if (order.forklift_submitted_at) return true;
  const lines = order.lines || [];
  return lines.length > 0 && lines.every((l) => l.receipt_id && l.forklift_submitted);
};

/**
 * What "Approve truck" will book differently from the paperwork, one sentence per
 * line (F15): "B-0910: 13 of 14 — will be booked short (Damaged on arrival)".
 * Approval books what was SCANNED, so the approver is told before, not after.
 */
export const approvalBookingNotes = (truck = {}) => {
  const shortReason = (line) => {
    const flag = (truck.flags || []).find((f) => f.kind === 'short' && f.line_id === line.line_id);
    return flag?.detail || truck.short_reason || '';
  };
  return (truck.lines || []).flatMap((line) => {
    const scanned = Number(line.scanned_count || 0);
    const expected = Number(line.expected_count || 0);
    if (scanned === expected) return [];
    const name = line.vendor_lot || line.lot_code || line.product_name || 'A line';
    if (expected === 0) return [`${name}: ${scanned} not on the paperwork — will be booked as extra`];
    if (scanned < expected) {
      const reason = shortReason(line);
      return [`${name}: ${scanned} of ${expected} — will be booked short${reason ? ` (${reason})` : ''}`];
    }
    return [`${name}: ${scanned} of ${expected} — will be booked over`];
  });
};

/** "1 sticker", "13 stickers", "1 lot" — a count with its noun, never "1 stickers". */
export const countOf = (n, noun) => `${n} ${Number(n) === 1 ? noun : pluralizeUnit(noun)}`;
