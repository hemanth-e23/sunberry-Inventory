// ±N cases on ONE finished-goods pallet (FG pallet lifecycle §4.2).
//
// Builds the adjustment the server expects: type "case-adjustment", the one
// pallet, and the signed delta + reason code in source_breakdown. The server
// stores quantity as −delta (positive = cases removed), like every other
// adjustment report row.
export const caseAdjustmentPayload = ({ pallet, sign, count, reasonCode, reason }) => {
  if (!pallet) return { error: 'Pick the pallet.' };
  const n = Number(count);
  if (!Number.isInteger(n) || n <= 0) return { error: 'Enter a whole number of cases.' };
  const delta = sign === '+' ? n : -n;
  if ((Number(pallet.cases) || 0) + delta < 0) {
    return { error: `That pallet has ${pallet.cases} cases — can't remove ${n}.` };
  }
  if (!reasonCode) return { error: 'Pick a reason.' };
  if (!String(reason || '').trim()) return { error: 'Reason is required.' };
  return {
    adjustment: {
      palletLicenceIds: [pallet.id],
      adjustmentType: 'case-adjustment',
      reason: String(reason).trim(),
      sourceBreakdown: [{ case_delta: delta, reason_code: reasonCode }],
    },
  };
};
