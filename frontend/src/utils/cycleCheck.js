// Gun cycle check helpers (FG pallet lifecycle §4.1).

// Same matching as ScannerReceiptFlow.handleRowScan: the row name with or
// without its "FG-" prefix, the row id, or the printed rack barcode.
const stripFg = (s) => s.replace(/^FG[- ]?/, '');

export const matchRow = (rows, raw) => {
  const scanned = String(raw || '').trim().toUpperCase();
  if (!scanned) return null;
  // The prefix may be on either side: a row stored as "FG-AJ11" scanned as
  // "AJ11", or a row stored as "AJ11" whose sticker reads "FG-AJ11".
  const scannedBare = stripFg(scanned);
  return rows.find((r) => {
    const rowName = (r.name || '').toUpperCase();
    const nameOnly = stripFg(rowName);
    return nameOnly === scanned || rowName === scanned || (scannedBare && nameOnly === scannedBare)
      || r.id === String(raw).trim()
      || (r.barcode && r.barcode.toUpperCase() === scanned);
  }) || null;
};

// Pallets the checker says are NOT in the row: every pallet of a group tapped
// "Not here", plus single pallets tapped, minus any pallet actually scanned.
export const notHereIds = (groups, groupNotHere, palletNotHere, scanned) => {
  const ids = new Set();
  for (const g of groups) {
    for (const p of g.pallets) {
      if (scanned.has(p.licence_number)) continue;
      if (groupNotHere.has(g.key) || palletNotHere.has(p.id)) ids.add(p.id);
    }
  }
  return [...ids];
};

// ─── Count sessions (one walk of rows: Next row … Finish) ────────────────────

const SESSION_KEY = (userId) => `sb.cycleCheck.session.${userId || 'anon'}`;
const IDLE_MS = (minutes) => minutes * 60 * 1000;

// The gun's session, or null. Storage can be unavailable (private window,
// blocked site data) — then the session just lives in memory.
export const loadCycleSession = (userId, idleMinutes, now = Date.now()) => {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY(userId));
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return null;
    // Idle too long → a new walk. A row still in progress keeps it alive.
    if (!s.draft && s.lastAt && now - s.lastAt > IDLE_MS(idleMinutes)) return null;
    return { rows: [], ...s };
  } catch {
    return null;
  }
};

export const saveCycleSession = (userId, session) => {
  try {
    if (session) window.localStorage.setItem(SESSION_KEY(userId), JSON.stringify(session));
    else window.localStorage.removeItem(SESSION_KEY(userId));
  } catch {
    // Storage unavailable — the session is only lost on reload.
  }
};

// What the gun keeps per saved row (from the submit response summary).
export const sessionRowFromResult = (summary) => ({
  row_name: summary.row_name,
  ok: !rowHasDifference(summary),
  expected: summary.expected_pallets || 0,
  not_here: summary.not_here || 0,
  found: summary.found || 0,
  moved_in: summary.moved_in || 0,
  created: summary.created || 0,
  messages: (summary.scans || []).filter((x) => x.message).map((x) => x.message),
});

export const sessionTotals = (rows = []) => ({
  rows: rows.length,
  ok: rows.filter((r) => r.ok).length,
  differences: rows.filter((r) => !r.ok).length,
  not_here: rows.reduce((n, r) => n + (r.not_here || 0), 0),
  found: rows.reduce((n, r) => n + (r.found || 0), 0),
  moved_in: rows.reduce((n, r) => n + (r.moved_in || 0), 0),
  created: rows.reduce((n, r) => n + (r.created || 0), 0),
});

// Mirrors backend cycle_check_service.row_has_difference.
export const rowHasDifference = (s = {}) => Boolean(
  (s.variancesCount || 0) || (s.not_here || 0) || (s.moved_in || 0) || (s.found || 0) || (s.created || 0),
);

// ─── Count History grouping (web Cycle Counting page) ────────────────────────

const GUN_KIND = 'gun_row_check';
const ts = (v) => {
  if (!v) return 0;
  const s = String(v);
  // Server timestamps without a zone are UTC.
  const t = Date.parse(/T/.test(s) && !/(Z|[+-]\d{2}:\d{2})$/.test(s) ? `${s}Z` : s);
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Count History entries, newest first: one per gun count session, one per
 * other (count-sheet) record. Mirrors backend cycle_check_service.group_sessions:
 * checks with a session id group by (who, session id); older ones without one
 * group by the same person on the same day with no gap > idleMinutes.
 */
export const groupCountHistory = (counts = [], idleMinutes = 60) => {
  const gun = counts.filter((c) => c.summary?.kind === GUN_KIND)
    .sort((a, b) => String(a.performedById).localeCompare(String(b.performedById))
      || ts(a.createdAt) - ts(b.createdAt) || String(a.id).localeCompare(String(b.id)));
  const groups = new Map();
  const chain = new Map();
  for (const c of gun) {
    const who = String(c.performedById);
    const sid = c.summary.session_id;
    let key;
    if (sid) {
      key = `${who}|${sid}`;
    } else {
      const t = ts(c.createdAt);
      const cur = chain.get(who);
      key = cur && cur.day === c.countDate && t && cur.last && t - cur.last <= IDLE_MS(idleMinutes)
        ? cur.key : `${who}|auto-${c.id}`;
      chain.set(who, { key, last: t, day: c.countDate });
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const sessions = [...groups.entries()].map(([key, recs]) => {
    const rows = recs.map((c) => ({
      id: c.id,
      rowName: c.summary.row_name || '—',
      checkedAt: c.createdAt,
      ok: !rowHasDifference(c.summary),
      expected: c.summary.expected_pallets || 0,
      notHere: c.summary.not_here || 0,
      found: c.summary.found || 0,
      movedIn: c.summary.moved_in || 0,
      created: c.summary.created || 0,
      items: Array.isArray(c.items) ? c.items : [],
    }));
    const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
    return {
      type: 'session',
      key,
      sessionId: recs[0].summary.session_id || null,
      inferred: !recs[0].summary.session_id,
      performedBy: recs[0].performedBy,
      performedById: recs[0].performedById,
      countDate: recs[0].countDate,
      startedAt: recs[0].createdAt,
      endedAt: recs[recs.length - 1].createdAt,
      sortAt: ts(recs[recs.length - 1].createdAt),
      rows,
      rowsChecked: rows.length,
      rowsOk: rows.filter((r) => r.ok).length,
      rowsWithDifferences: rows.filter((r) => !r.ok).length,
      notHere: sum('notHere'),
      found: sum('found'),
      movedIn: sum('movedIn'),
      created: sum('created'),
    };
  });
  const others = counts.filter((c) => c.summary?.kind !== GUN_KIND).map((c) => ({
    type: 'count', key: c.id, count: c, sortAt: ts(c.createdAt) || ts(c.countDate),
  }));
  return [...sessions, ...others].sort((a, b) => b.sortAt - a.sortAt);
};
