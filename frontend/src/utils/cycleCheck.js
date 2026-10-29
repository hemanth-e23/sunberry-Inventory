// Gun cycle check helpers (FG pallet lifecycle §4.1) and the web count sheet
// by rack row.
import { COUNT_SHEET, COUNT_SHEET_TYPE_LABELS } from '../constants';
import { escapeHtml, formatDateKey, formatDateTime } from './dateUtils';

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

const isSheet = (c) => c.summary?.kind === COUNT_SHEET.KIND;

/**
 * Count History entries, newest first: one per gun count session, one per
 * other (count-sheet) record. Mirrors backend cycle_check_service.group_sessions:
 * checks with a session id group by (who, session id); older ones without one
 * group by the same person on the same day with no gap > idleMinutes.
 *
 * Count sheets: an open sheet is not history yet (it is listed under "Open
 * sheets"); a submitted one is a single entry carrying its sheet number. The
 * gun row checks a sheet's FG rows were applied through are already in that
 * sheet's items, so they are not listed a second time as a gun session.
 */
export const groupCountHistory = (counts = [], idleMinutes = 60) => {
  const gun = counts.filter((c) => c.summary?.kind === GUN_KIND && c.summary.source !== COUNT_SHEET.SOURCE_SHEET)
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
  const others = counts
    .filter((c) => c.summary?.kind !== GUN_KIND)
    .filter((c) => !isSheet(c) || c.summary.status === COUNT_SHEET.STATUS_SUBMITTED)
    .map((c) => ({
      type: 'count',
      key: c.id,
      count: c,
      sheetNo: isSheet(c) ? c.summary.sheet_no || null : null,
      // A sheet is dated by its submit, not by when it was printed.
      sortAt: ts(isSheet(c) ? c.summary.submitted_at : null) || ts(c.createdAt) || ts(c.countDate),
    }));
  return [...sessions, ...others].sort((a, b) => b.sortAt - a.sortAt);
};

// ─── Count sheet by rack row (web Cycle Counting page) ───────────────────────

// Licence numbers typed or scanned into "Extra found": any whitespace, comma
// or semicolon separates them. Stickers are upper case; a hand-typed lower
// case one would otherwise be created as a new pallet.
export const parseLicences = (text) => [
  ...new Set(String(text || '').split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean)),
];

export const emptySheetDraft = () => ({ rowCounted: {}, notHere: [], extras: {}, counts: {}, legacy: {} });

const SHEET_DRAFT_KEY = (sheetId) => `sb.countSheet.draft.${sheetId}`;

// What was typed into an open sheet, so a reload doesn't lose it. Storage can
// be unavailable — then the draft just lives in memory.
export const loadSheetDraft = (sheetId) => {
  try {
    const raw = window.localStorage.getItem(SHEET_DRAFT_KEY(sheetId));
    const d = raw ? JSON.parse(raw) : null;
    return d && typeof d === 'object' ? { ...emptySheetDraft(), ...d } : emptySheetDraft();
  } catch {
    return emptySheetDraft();
  }
};

export const saveSheetDraft = (sheetId, draft) => {
  try {
    if (draft) window.localStorage.setItem(SHEET_DRAFT_KEY(sheetId), JSON.stringify(draft));
    else window.localStorage.removeItem(SHEET_DRAFT_KEY(sheetId));
  } catch {
    // Storage unavailable — the draft is only lost on reload.
  }
};

// A whole, non-negative count, or null for "not counted". Blank is not zero.
export const parseCount = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

const isFgSheet = (sheet) => sheet?.summary?.sheet_type === COUNT_SHEET.TYPE_FG;
const sheetSnapshot = (sheet) => sheet?.summary?.sheet || { rows: [], legacy: [] };

/** The submit body for an open sheet. Only rows marked "Row counted" go. */
export const sheetSubmitPayload = (sheet, draft) => {
  const snap = sheetSnapshot(sheet);
  const fg = isFgSheet(sheet);
  const notHere = new Set(draft.notHere || []);
  const rows = (snap.rows || []).filter((r) => draft.rowCounted?.[r.row_id]).map((r) => (fg
    ? {
      row_id: r.row_id,
      counted: true,
      not_here_pallet_ids: r.lines.flatMap((g) => g.pallets).filter((p) => notHere.has(p.id)).map((p) => p.id),
      extra_licences: parseLicences(draft.extras?.[r.row_id]),
    }
    : {
      row_id: r.row_id,
      counted: true,
      lines: r.lines
        .map((l) => ({ placement_id: l.placement_id, counted_units: parseCount(draft.counts?.[l.placement_id]) }))
        .filter((l) => l.counted_units !== null),
    }));
  const legacy = (snap.legacy || [])
    .map((r) => ({ receipt_id: r.receipt_id, counted: parseCount(draft.legacy?.[r.receipt_id]) }))
    .filter((r) => r.counted !== null);
  return { rows, legacy };
};

/** Progress + what will be left out, for the submit button and its confirm. */
export const sheetDraftStats = (sheet, draft) => {
  const snap = sheetSnapshot(sheet);
  const rows = snap.rows || [];
  const counted = rows.filter((r) => draft.rowCounted?.[r.row_id]);
  let blankLines = 0;
  let badLines = 0;
  if (!isFgSheet(sheet)) {
    for (const r of counted) {
      for (const l of r.lines) {
        const raw = draft.counts?.[l.placement_id];
        if (raw === undefined || raw === null || String(raw).trim() === '') blankLines += 1;
        else if (parseCount(raw) === null) badLines += 1;
      }
    }
  }
  return { rowsTotal: rows.length, rowsCounted: counted.length, blankLines, badLines };
};

const seqLabel = (p) => (p.sequence != null ? String(p.sequence).padStart(3, '0') : p.licence_number);

/**
 * Printable sheet (A4 landscape): sheet number + "Counted by / date" on top,
 * then per row a header bar with a "Row counted" box, a box per licence
 * (FG) or a blank count box per lot (RM / packaging), and "Extra found".
 * Every server string goes through escapeHtml.
 */
export const sheetPrintHtml = (sheet) => {
  const e = escapeHtml;
  const sm = sheet.summary || {};
  const snap = sheetSnapshot(sheet);
  const fg = isFgSheet(sheet);
  const box = '<span class="box"></span>';
  const rowsHtml = (snap.rows || []).map((r) => {
    let body;
    if (fg) {
      body = `<table><thead><tr><th style="width:22%">Product</th><th style="width:13%">Lot</th>
        <th class="num" style="width:7%">System</th><th>Pallets — ✓ seen · ✗ not here</th>
        <th style="width:11%">Pallets counted</th></tr></thead><tbody>${r.lines.map((g) => `<tr>
        <td><b>${e(g.product_name)}</b></td><td class="mono">${e(g.lot_number || '—')}</td>
        <td class="num">${g.count}</td>
        <td>${g.pallets.map((p) => `<span class="lic">${box}${e(seqLabel(p))}${p.is_held ? ' <b>HELD</b>' : ''}</span>`).join('')}</td>
        <td><span class="count-box"></span></td></tr>`).join('')}</tbody></table>
        <div class="extra">Extra found (licence #): <span class="line"></span></div>`;
    } else {
      body = `<table><thead><tr><th style="width:24%">Product</th><th style="width:14%">Vendor lot</th>
        <th style="width:9%">BBD</th><th class="num" style="width:10%">System sealed</th>
        <th style="width:14%">Open / held</th><th style="width:13%">Counted sealed</th><th>Notes</th></tr></thead>
        <tbody>${r.lines.map((l) => `<tr>
        <td><b>${e(l.product_name)}</b></td><td class="mono">${e(l.vendor_lot_number || l.lot_code || '—')}</td>
        <td>${l.bbd ? e(formatDateKey(l.bbd)) : '—'}</td>
        <td class="num"><b>${l.full_units}</b> ${e(l.unit_label)}</td>
        <td>${l.open_units ? `${l.open_units} open` : ''}${l.open_units && (l.held_units || l.lot_is_held) ? ' · ' : ''}${l.held_units ? `<b>${l.held_units} held</b>` : (l.lot_is_held ? '<b>lot held</b>' : '')}${!l.open_units && !l.held_units && !l.lot_is_held ? '—' : ''}</td>
        <td><span class="count-box"></span></td><td></td></tr>`).join('')}</tbody></table>
        <div class="extra">Extra found (product · lot · count): <span class="line"></span></div>`;
    }
    return `<section class="row">
      <div class="row-bar"><div><span class="row-name">${e(r.row_name)}</span><span class="row-area">${e(r.area_name)}</span></div>
      <div class="row-done">${box} Row counted <span class="sheet-tag">${e(sm.sheet_no)}</span></div></div>
      ${body}</section>`;
  }).join('');
  const legacy = snap.legacy || [];
  const legacyHtml = legacy.length ? `<section class="row">
      <div class="row-bar"><div><span class="row-name">Not on a rack</span>
      <span class="row-area">count is recorded, nothing is changed</span></div>
      <div class="row-done"><span class="sheet-tag">${e(sm.sheet_no)}</span></div></div>
      <table><thead><tr><th style="width:30%">Product</th><th style="width:16%">Lot</th><th class="num" style="width:16%">System</th>
      <th style="width:14%">Counted</th><th>Notes</th></tr></thead><tbody>${legacy.map((r) => `<tr>
      <td><b>${e(r.product_name)}</b>${r.is_held ? ' <b>HELD</b>' : ''}</td><td class="mono">${e(r.lot_number || '—')}</td>
      <td class="num">${Number(r.quantity || 0).toLocaleString()} ${e(r.unit || '')}${r.container_count ? ` (${r.container_count} ${e(r.container_unit || '')})` : ''}</td>
      <td><span class="count-box"></span></td><td></td></tr>`).join('')}</tbody></table></section>` : '';
  const how = fg
    ? 'Walk each row. Tick ✓ every pallet you see; cross ✗ the ones that are not there. Write any other licence you find under "Extra found". Tick "Row counted" when done.'
    : 'Walk each row. Write the number of SEALED units you count. Open and held units are for information. Tick "Row counted" when done.';
  return `<!DOCTYPE html>
<html>
<head>
  <title>Count Sheet ${e(sm.sheet_no)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; font-size: 11pt; color: #000; background: #fff; padding: 8mm; }
    .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 8mm;
      border-bottom: 2px solid #000; padding-bottom: 3mm; margin-bottom: 3mm; }
    .sheet-no { font-family: monospace; font-size: 22pt; font-weight: 700; }
    .scope { font-size: 12pt; font-weight: 700; margin-top: 1mm; }
    .meta { font-size: 9pt; margin-top: 1mm; }
    .sign { font-size: 12pt; white-space: nowrap; }
    .sign .line { display: inline-block; border-bottom: 1px solid #000; width: 55mm; margin: 0 5mm 0 2mm; }
    .how { font-size: 9.5pt; margin-bottom: 4mm; }
    .row { border: 1.5px solid #000; margin-bottom: 4mm; break-inside: avoid; page-break-inside: avoid; }
    .row-bar { display: flex; justify-content: space-between; align-items: center; padding: 2mm 3mm;
      background: #e6e6e6; border-bottom: 1.5px solid #000;
      -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .row-name { font-size: 15pt; font-weight: 700; }
    .row-area { font-size: 10pt; margin-left: 4mm; }
    .row-done { font-size: 11pt; font-weight: 700; white-space: nowrap; }
    .sheet-tag { font-family: monospace; font-weight: 400; font-size: 9pt; margin-left: 4mm; }
    table { width: 100%; border-collapse: collapse; }
    th { font-size: 8.5pt; text-transform: uppercase; text-align: left; padding: 1.5mm 2mm; border-bottom: 1px solid #000; }
    td { padding: 2mm; border-top: 1px solid #aaa; vertical-align: top; }
    .num { text-align: right; }
    .mono { font-family: monospace; font-size: 11pt; }
    .lic { display: inline-block; min-width: 16mm; margin: 0.6mm 3mm 0.6mm 0; font-family: monospace; font-size: 12pt; white-space: nowrap; }
    .box { display: inline-block; width: 4.5mm; height: 4.5mm; border: 1.3px solid #000; margin-right: 1.2mm; vertical-align: -0.8mm; }
    .count-box { display: inline-block; width: 24mm; height: 9mm; border: 1.5px solid #000; }
    .extra { padding: 2.5mm 3mm; border-top: 1px solid #aaa; font-size: 10pt; display: flex; gap: 2mm; }
    .extra .line { flex: 1; border-bottom: 1px solid #000; }
    @media print { body { padding: 0; } @page { size: A4 landscape; margin: 8mm; } }
  </style>
</head>
<body>
  <div class="top">
    <div>
      <div class="sheet-no">${e(sm.sheet_no)}</div>
      <div class="scope">${e(sm.scope || COUNT_SHEET_TYPE_LABELS[sm.sheet_type] || '')}</div>
      <div class="meta">Printed from system ${e(formatDateTime(sm.generated_at))}${sm.generated_by ? ` by ${e(sm.generated_by)}` : ''}
        · ${(snap.rows || []).length} rows</div>
    </div>
    <div class="sign">Counted by<span class="line"></span>Date<span class="line" style="width:35mm"></span></div>
  </div>
  <div class="how">${how}</div>
  ${rowsHtml || '<p>Nothing on a rack for this selection.</p>'}
  ${legacyHtml}
</body>
</html>`;
};
