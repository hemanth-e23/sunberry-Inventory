// Hold History ordering (browser test PART 2, U11).
//
// `inventoryHoldActions` is newest-first from the server, but a submission made
// on this page is appended at the END. Reversing the list therefore surfaced
// the oldest actions after a reload. Sort by time instead: the latest of the
// approval and request times.

const ts = (value) => {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
};

export const holdActionTime = (action = {}) =>
  Math.max(ts(action.approvedAt), ts(action.submittedAt), ts(action.createdAt));

export const sortHoldsNewestFirst = (actions = []) =>
  [...(actions || [])].sort((a, b) => holdActionTime(b) - holdActionTime(a));
