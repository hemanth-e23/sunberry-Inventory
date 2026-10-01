// Small pure helpers for truck receiving (2026-10), shared by the gun, the desk
// and the approvals page. Pure so they can be tested without rendering anything.

import { pluralizeUnit } from './rowSources';

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
