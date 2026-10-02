// Formatting for the server's lot_status payload (backend/app/services/lot_status.py):
// the LOT's current racks and held amount, lot-wide. The hold screens and the
// approval cards used to print one receipt's paperwork ("5,688 lbs") and the
// receipt's last-transfer location ("QA Quarantine") instead (2026-10-01, B4/B5).

const pluralWord = (word, n) => {
  const w = String(word || 'unit');
  if (n === 1) return w;
  if (/(s|x|ch|sh|z)$/.test(w)) return `${w}es`;
  return `${w}s`;
};

const isWhole = (n) => n != null && Number.isFinite(Number(n)) && Math.abs(Number(n) - Math.round(Number(n))) < 1e-6;

/** "13 drums · 6,162 lbs" — units only when they are a whole count. */
export const describeLotQty = (quantity, unit, units, unitLabel) => {
  const qty = Number(quantity || 0);
  const qtyText = `${qty.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit || ''}`.trim();
  if (units != null && Number(units) > 0 && isWhole(units)) {
    const n = Math.round(Number(units));
    return `${n} ${pluralWord(unitLabel, n)} · ${qtyText}`;
  }
  return qtyText;
};

/** The lot's whole current amount. */
export const lotTotalText = (status) =>
  status ? describeLotQty(status.quantity, status.unit, status.units, status.unit_label) : null;

/** The lot's current held amount, or null when nothing is held. */
export const lotHeldText = (status) =>
  status && status.is_held
    ? describeLotQty(status.held_quantity, status.unit, status.held_units, status.unit_label)
    : null;

/**
 * Share (0..1) of a rack's contents that is on QA hold.
 *
 * A raw-material hold lives on the LOT (MaterialLot.is_held), surfaced per
 * rack as `liveLots[].isHeld`; the legacy rack flag `row.hold` holds the
 * whole rack. The dashboards counted only the rack flag and said "0 on hold"
 * while B-0910 was held (2026-10-01, B6).
 */
export const rowHeldShare = (row) => {
  if (!row) return 0;
  if (row.hold) return 1;
  const lots = Array.isArray(row.liveLots) ? row.liveLots : [];
  const total = lots.reduce((s, l) => s + Number(l.units || 0), 0);
  if (total <= 0) return 0;
  const held = lots.filter(l => l.isHeld).reduce((s, l) => s + Number(l.units || 0), 0);
  return held / total;
};

/**
 * Distinct raw-material lots on QA hold: lot-tracked ones seen on any rack,
 * plus legacy receipts (no lot identity) carrying a QA hold — `hold` WITH
 * `heldQuantity`; `hold` alone is the review lock a pending transfer sets.
 */
export const countHeldLots = (locationsTree = [], receipts = []) => {
  const lots = new Set();
  (locationsTree || []).forEach((location) => {
    (location.subLocations || []).forEach((sub) => {
      (sub.rows || []).forEach((row) => {
        (row.liveLots || []).forEach((l) => {
          if (l.isHeld) lots.add(l.materialLotId || l.lotCode);
        });
      });
    });
  });
  (receipts || []).forEach((r) => {
    if (!r.materialLotId && r.hold && Number(r.heldQuantity || 0) > 0) lots.add(`receipt:${r.id}`);
  });
  return lots.size;
};

/** "QA Drum Room: QA-D3, QA-D4" — where the lot's racks are now. */
export const lotLocationText = (status) => (status && status.location_label) || null;
