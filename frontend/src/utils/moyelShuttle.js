// Moyel Shuttle helpers (FG pallet lifecycle §1.1).

// Totals for the trailer: every selected pallet or ticked missing number.
export const shuttleSelectionTotals = (rows) => ({
  pallets: rows.length,
  cases: rows.reduce((s, r) => s + (Number(r.cases) || 0), 0),
});

// Shift-click range: the rows between the last click and this one, inclusive.
export const selectRange = (rows, fromIndex, toIndex) => {
  const lo = Math.min(fromIndex, toIndex);
  const hi = Math.max(fromIndex, toIndex);
  return rows.slice(lo, hi + 1);
};
