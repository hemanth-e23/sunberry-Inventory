// How many containers (drums, bags, boxes) a product has on hand, for the All
// Inventory table (2026-10-01 browser test, F10).
//
// The table used to divide the product's pounds by ONE receipt's weight per
// container: a lot that arrived as 14 drums at 502 lb and 9 at 474 lb read
// "≈ 22.5 drum @ 502 lbs ea." when 23 drums stood on the racks. Two better
// sources exist, used in this order:
//
//   1. The rack projection on a lot's carrier receipt
//      (rawMaterialRowAllocations[].units / fullUnits / openUnits, written by
//      lot_placement_service.project_lot) — real counted containers.
//   2. For receipts of no projected lot (legacy / non-lot), each receipt's own
//      quantity ÷ its own weight per container — never one receipt's weight
//      applied to everybody's pounds.

import { pluralizeUnit, singularUnit } from './rowSources';
import { RECEIPT_STATUS } from '../constants';

const APPROVED = RECEIPT_STATUS.APPROVED;

const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

/**
 * -> { count, open, unit, weights: [lb...], weightUnit, exact } or null.
 * `exact` is false when any part came from pounds ÷ weight (an estimate).
 */
export const summarizeContainers = (receipts = []) => {
  const approved = (receipts || []).filter((r) => r?.status === APPROVED);
  let count = 0;
  let open = 0;
  let unit = null;
  let exact = true;
  let seen = false;
  const weights = new Set();
  let weightUnit = null;
  const coveredLots = new Set();

  approved.forEach((r) => {
    const entries = (r.rawMaterialRowAllocations || []).filter(
      (a) => a && (a.units != null || a.fullUnits != null),
    );
    if (!entries.length) return;
    if (r.materialLotId) coveredLots.add(r.materialLotId);
    entries.forEach((a) => {
      const full = a.fullUnits != null ? Number(a.fullUnits) || 0 : Number(a.units) || 0;
      const part = a.fullUnits != null ? Number(a.openUnits) || 0 : 0;
      count += full + part;
      open += part;
      unit = unit || a.unitLabel || r.containerUnit || null;
      seen = true;
    });
  });

  approved.forEach((r) => {
    const w = Number(r.weightPerContainer) || 0;
    if (w > 0 && Number(r.quantity) > 0) {
      weights.add(w);
      weightUnit = weightUnit || r.weightUnit || null;
    }
    const projected = (r.rawMaterialRowAllocations || []).some(
      (a) => a && (a.units != null || a.fullUnits != null),
    );
    if (projected || (r.materialLotId && coveredLots.has(r.materialLotId))) return;
    if (!(w > 0) || !r.containerUnit) return;
    const qty = Number(r.quantity) || 0;
    if (qty <= 0) return;
    count += qty / w;
    unit = unit || r.containerUnit;
    exact = false;
    seen = true;
  });

  if (!seen || !unit) return null;
  return {
    count: Math.round(count * 100) / 100,
    open,
    unit,
    weights: [...weights].sort((a, b) => b - a),
    weightUnit: weightUnit || 'lbs',
    exact,
  };
};

/** "23 drums (1 open) @ 474–502 lbs ea." — or null when nothing is known. */
export const formatContainers = (summary) => {
  if (!summary) return null;
  const { count, open, unit, weights, weightUnit, exact } = summary;
  const noun = count === 1 ? singularUnit(unit) : pluralizeUnit(unit);
  const head = `${exact ? '' : '≈ '}${fmt(count)} ${noun}${open > 0 ? ` (${open} open)` : ''}`;
  if (!weights.length) return head;
  const each = weights.length === 1
    ? fmt(weights[0])
    : `${fmt(weights[weights.length - 1])}–${fmt(weights[0])}`;
  return `${head} @ ${each} ${weightUnit} ea.`;
};
