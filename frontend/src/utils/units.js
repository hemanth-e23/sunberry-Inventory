// Sensible default measurement unit for a category type, used ONLY when a
// receipt/lot has no explicit unit recorded. Raw materials and ingredients are
// weighed (lbs), packaging is counted (units), finished goods are cased.
//
// Accepts both the correct DB value ('raw') and the legacy 'raw-material'
// spelling so it stays correct regardless of which constant a caller passes.
export const fallbackUnit = (categoryType) => {
  if (categoryType === 'finished') return 'cases';
  if (
    categoryType === 'raw' ||
    categoryType === 'raw-material' ||
    categoryType === 'ingredient'
  ) {
    return 'lbs';
  }
  return 'units';
};

// Resolve the unit to DISPLAY for a receipt row.
//
// Why this exists: `Receipt.unit` is a NOT-NULL-ish column defaulting to
// 'cases' (backend/app/models/receipt.py:15). The receipt mappers used to read
//   rec.unit || rec.quantity_units || rec.weight_unit || fallbackUnit(type)
// which looks like a sensible precedence chain but is not — `rec.unit` is
// essentially never empty, so every term after it was dead code and an
// 80-barrel ingredient receipt rendered as "80 cases".
//
// The fix is deliberately conservative: 'cases' on a non-finished category is
// treated as the column default leaking through rather than a real measurement
// choice, but we only override it with a unit the receipt ACTUALLY carries
// (weight_unit / container_unit). We never invent 'lbs' for a receipt that
// carries no better evidence — that would be trading one wrong label for
// another. The category fallback applies only when there is no explicit unit at
// all, which is the branch that was previously unreachable.
export const resolveReceiptUnit = (rec = {}, categoryType) => {
  const explicit = rec.unit || rec.quantity_units;
  const carried = rec.weight_unit || rec.container_unit;

  if (categoryType !== 'finished' && (!explicit || explicit === 'cases')) {
    if (carried) return carried;
    if (!explicit) return fallbackUnit(categoryType);
  }
  return explicit || carried || fallbackUnit(categoryType);
};
