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
