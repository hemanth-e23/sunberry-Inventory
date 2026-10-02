// Helpers for the Counts tab (Record a count / Recount a rack).
//
// Browser test PART 2, U8: the recount form used drum wording for bags, never
// showed what the system already had on the rack, and offered every
// finished-goods rack in the plant alongside the four that hold material.
import { pluralizeUnit, singularUnit } from './rowSources';

/**
 * What the system currently records for ONE lot, per rack, from the receipts'
 * projected rack picture (`rawMaterialRowAllocations` — written by
 * `project_lot` from lot_placements). Summed across the lot's receipts since
 * the picture rides on one of them and the others are blank.
 *
 * Returns `{ [rowId]: { full, open, openQty } }`.
 */
export const lotCountsByRow = (receipts = [], materialLotId) => {
  const out = {};
  if (!materialLotId) return out;
  for (const r of receipts || []) {
    if (r?.materialLotId !== materialLotId) continue;
    for (const a of r.rawMaterialRowAllocations || []) {
      if (!a?.rowId) continue;
      const cur = out[a.rowId] || { full: 0, open: 0, openQty: 0 };
      const units = Number(a.units) || 0;
      const full = a.fullUnits != null ? Number(a.fullUnits) || 0 : units;
      cur.full += full;
      cur.open += Number(a.openUnits) || 0;
      cur.openQty += Number(a.openQty) || 0;
      out[a.rowId] = cur;
    }
  }
  return out;
};

/**
 * Racks worth offering for a count of material in `unitLabel`.
 *
 * - Finished-goods racks (they sit under a storage AREA) are never offered:
 *   this tab counts weighed raw material, and FG is counted by pallet licence.
 * - A room typed for a DIFFERENT container (a drum room when counting bags) is
 *   left out — unless the lot is recorded there now, because a recount must be
 *   able to correct whatever rack the system says it is on.
 * - Racks the lot is on now come first, then racks in a room typed for this
 *   unit, then the rest, by name.
 */
export const countRackOptions = (rows = [], { unitLabel = '', currentRowIds = [] } = {}) => {
  const unit = singularUnit(String(unitLabel || '').toLowerCase());
  const current = new Set(currentRowIds);
  const rank = (r) => {
    if (current.has(r.id)) return 0;
    const roomUnit = singularUnit(String(r.storage_unit || '').toLowerCase());
    if (unit && roomUnit && roomUnit === unit) return 1;
    return 2;
  };
  return (rows || [])
    .filter((r) => {
      if (current.has(r.id)) return true;
      if (r.storage_area_id) return false;
      const roomUnit = singularUnit(String(r.storage_unit || '').toLowerCase());
      if (unit && roomUnit && roomUnit !== unit) return false;
      return true;
    })
    .sort((a, b) => rank(a) - rank(b)
      || String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true }));
};

/** Wording for the count form, in the lot's own unit. */
export const countWording = (unitLabel) => {
  const one = singularUnit(String(unitLabel || 'unit').toLowerCase()) || 'unit';
  const many = pluralizeUnit(one);
  const isDrumLike = ['drum', 'barrel', 'tote', 'pail'].includes(one);
  return {
    one,
    many,
    openedLabel: `Opened ${many}`,
    openedHint: isDrumLike ? 'partly used, often kept in a cooler' : 'partly used, still on the rack',
    leftLabel: `Left in the opened ${many}`,
  };
};

/** "18 bags" / "4 drums + 1 open (224 lbs)" for a rack's current figure. */
export const describeCount = ({ full = 0, open = 0, openQty = 0 } = {}, unitLabel, weightUnit = 'lbs') => {
  const { one, many } = countWording(unitLabel);
  const base = `${full} ${full === 1 ? one : many}`;
  if (!open) return base;
  const qty = Number(openQty) > 0 ? ` (${Number(openQty).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${weightUnit})` : '';
  return `${base} + ${open} open${qty}`;
};
