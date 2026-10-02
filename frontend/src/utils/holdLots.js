/**
 * Hold form helpers (browser test PART 3, 2026-10-02).
 */

const ts = (r) => {
  const v = r?.receiptDate || r?.submittedAt || r?.createdAt || 0;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
};

/**
 * One receipt per material lot, for the lot picker (U4): A-0925 arrived on
 * four trucks and was listed four times, yet a hold always covers the whole
 * lot. The newest delivery speaks for the lot (the server's projection
 * carrier). Receipts without a lot (legacy) pass through, in input order.
 */
export const onePerLot = (receipts = []) => {
  const best = new Map();
  for (const r of receipts || []) {
    const key = r?.materialLotId;
    if (!key) continue;
    const cur = best.get(key);
    if (!cur || ts(r) > ts(cur)) best.set(key, r);
  }
  return (receipts || []).filter((r) => !r?.materialLotId || best.get(r.materialLotId) === r);
};

const plural = (word, n) => {
  const w = String(word || 'unit');
  return n === 1 || w.endsWith('s') ? w : `${w}s`;
};

const fmt = (n) => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString();

/**
 * "1 drum on a gun cart (502 lbs); 502 lbs in staging" — containers of the
 * lot already OFF the racks (B3: the drum on the cart was never mentioned).
 * Null when nothing is off the racks.
 */
export const offRackText = (status) => {
  if (!status) return null;
  const unit = status.unit || 'lbs';
  const word = status.unit_label || 'unit';
  const parts = [];
  const cartUnits = Number(status.on_cart_units) || 0;
  const cartQty = Number(status.on_cart_qty) || 0;
  if (cartUnits > 0 || cartQty > 0) {
    parts.push(
      cartUnits > 0
        ? `${cartUnits} ${plural(word, cartUnits)} on a gun cart (${fmt(cartQty)} ${unit})`
        : `${fmt(cartQty)} ${unit} on a gun cart`
    );
  }
  const stagedQty = Number(status.in_staging_qty) || 0;
  if (stagedQty > 0.001) {
    const stagedUnits = Number(status.in_staging_units) || 0;
    parts.push(
      stagedUnits > 0
        ? `${fmt(stagedQty)} ${unit} in staging (≈ ${fmt(stagedUnits)} ${plural(word, stagedUnits)})`
        : `${fmt(stagedQty)} ${unit} in staging`
    );
  }
  return parts.length ? parts.join('; ') : null;
};
