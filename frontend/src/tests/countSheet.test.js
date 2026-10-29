// Count sheet by rack row (2026-10-29): history, submit payload, print sheet.
import { describe, it, expect } from 'vitest';
import {
  classifyExtra, countItemStats, groupCountHistory, naturalCompare, parseCount, parseLicences, sheetDraftStats,
  sheetPrintHtml, sheetRowsInOrder, sheetSubmitPayload, sortCountItems, submitConfirmLines,
} from '../utils/cycleCheck';

const at = (min) => new Date(Date.parse('2026-10-29T13:00:00Z') + min * 60000).toISOString().replace('Z', '');

const fgSheet = {
  id: 'sheet-1',
  summary: {
    kind: 'count_sheet', status: 'open', sheet_no: 'CC-7F3A21', sheet_type: 'fg', scope: 'Finished goods',
    generated_at: '2026-10-29T13:00:00Z', generated_by: 'Clerk',
    sheet: {
      rows: [
        { row_id: 'row-1', row_name: 'FG-01', area_name: 'FG', lines: [{
          key: 'p|L1', product_name: 'Mango <64oz>', lot_number: 'L1', count: 2,
          pallets: [{ id: 'pl-1', licence_number: 'L1-MANGO-001', sequence: 1, is_held: false },
            { id: 'pl-2', licence_number: 'L1-MANGO-002', sequence: 2, is_held: true }],
        }] },
        { row_id: 'row-2', row_name: 'FG-02', area_name: 'FG', lines: [{
          key: 'p|L1', product_name: 'Mango', lot_number: 'L1', count: 1,
          pallets: [{ id: 'pl-3', licence_number: 'L1-MANGO-003', sequence: 3, is_held: false }],
        }] },
      ],
      legacy: [],
    },
  },
};

const rmSheet = {
  id: 'sheet-2',
  summary: {
    kind: 'count_sheet', status: 'open', sheet_no: 'CC-000001', sheet_type: 'rm', scope: 'Raw + ingredients',
    sheet: {
      rows: [{ row_id: 'r-a', row_name: 'A-01', area_name: 'Barn', lines: [
        { placement_id: 'lp-1', product_name: 'Puree', vendor_lot_number: 'MG-1', bbd: '2027-01-15', unit_label: 'drum',
          full_units: 10, open_units: 1, open_remaining_qty: 200, held_units: 2, lot_is_held: false },
        { placement_id: 'lp-2', product_name: 'Puree', vendor_lot_number: 'MG-2', bbd: null, unit_label: 'drum',
          full_units: 4, open_units: 0, open_remaining_qty: 0, held_units: 0, lot_is_held: false },
      ] }],
      legacy: [{ receipt_id: 'rc-1', product_name: 'Old', lot_number: 'X', quantity: 500, unit: 'lbs' }],
    },
  },
};

describe('groupCountHistory with count sheets', () => {
  it('hides open sheets, lists a submitted one with its number, and does not repeat its gun rows', () => {
    const counts = [
      { id: 'open', performedById: 'clerk', countDate: '2026-10-29', createdAt: at(0), items: [],
        summary: { kind: 'count_sheet', status: 'open', sheet_no: 'CC-AAAAAA' } },
      { id: 'done', performedById: 'clerk', countDate: '2026-10-29', createdAt: at(-60), items: [{ status: 'ok' }],
        summary: { kind: 'count_sheet', status: 'submitted', sheet_no: 'CC-BBBBBB', submitted_at: `${at(30)}Z` } },
      { id: 'g1', performedById: 'clerk', countDate: '2026-10-29', createdAt: at(30), items: [],
        summary: { kind: 'gun_row_check', session_id: 'cs-aaaaaaaaaaaa', source: 'sheet', sheet_no: 'CC-BBBBBB' } },
      { id: 'g2', performedById: 'fk', countDate: '2026-10-29', createdAt: at(10), items: [],
        summary: { kind: 'gun_row_check', session_id: 'cs-bbbbbbbbbbbb', row_name: 'FG-09' } },
    ];
    const h = groupCountHistory(counts, 60);
    expect(h.map((e) => e.key)).toEqual(['done', 'fk|cs-bbbbbbbbbbbb']);
    expect(h[0]).toMatchObject({ type: 'count', sheetNo: 'CC-BBBBBB' });
  });
});

describe('count sheet payload', () => {
  it('parses licences and counts', () => {
    expect(parseLicences(' l1-mango-004, L1-MANGO-004;\nL1-MANGO-005 ')).toEqual(['L1-MANGO-004', 'L1-MANGO-005']);
    expect([parseCount(''), parseCount('3'), parseCount('0'), parseCount('2.5'), parseCount('-1')]).toEqual([null, 3, 0, null, null]);
  });

  it('FG: only rows marked counted, with ✗ pallets of that row and its extra licences', () => {
    const draft = {
      rowCounted: { 'row-1': true }, notHere: ['pl-2', 'pl-3'],
      extras: { 'row-1': 'L1-MANGO-009', 'row-2': 'L1-MANGO-010' }, counts: {}, legacy: {},
    };
    expect(sheetSubmitPayload(fgSheet, draft)).toEqual({
      rows: [{ row_id: 'row-1', counted: true, not_here_pallet_ids: ['pl-2'], extra_licences: ['L1-MANGO-009'] }],
      legacy: [],
    });
  });

  it('RM: blank lines are left out (not zero), legacy counts ride along, stats flag bad input', () => {
    const draft = { rowCounted: { 'r-a': true }, notHere: [], extras: {}, counts: { 'lp-1': '8' }, legacy: { 'rc-1': '480' } };
    expect(sheetSubmitPayload(rmSheet, draft)).toEqual({
      rows: [{ row_id: 'r-a', counted: true, lines: [{ placement_id: 'lp-1', counted_units: 8 }] }],
      legacy: [{ receipt_id: 'rc-1', counted: 480 }],
    });
    expect(sheetDraftStats(rmSheet, draft)).toEqual({
      rowsTotal: 1, rowsCounted: 1, emptyConfirmed: 0, emptyWithFinds: 0, blankLines: 1, badLines: 0,
    });
    expect(sheetDraftStats(rmSheet, { ...draft, counts: { 'lp-1': '8', 'lp-2': '1.5' } }).badLines).toBe(1);
  });
});

describe('sheetPrintHtml', () => {
  it('FG: sheet number, counted-by line, a box per licence, held marked, extra line, escaped', () => {
    const html = sheetPrintHtml(fgSheet);
    expect(html).toContain('CC-7F3A21');
    expect(html).toContain('Counted by');
    expect(html).toContain('size: A4 landscape');
    expect(html.match(/class="lic( held)?"/g)).toHaveLength(3);
    expect(html).toContain('002 <b class="held-tag">ON HOLD</b>');
    expect(html).toContain('class="lic held"');
    expect(html.match(/Extra found \(licence #\)/g)).toHaveLength(2);
    expect(html).toContain('Mango &lt;64oz&gt;');
    expect(html).not.toContain('<64oz>');
  });

  it('RM: blank count box per line, held + open shown, BBD as a calendar day, not-on-a-rack section', () => {
    const html = sheetPrintHtml(rmSheet);
    expect(html.match(/class="count-box"/g)).toHaveLength(3);
    expect(html).toContain('1 open');
    expect(html).toContain('<b class="held-tag">2 ON HOLD</b>');
    expect(sheetPrintHtml({ ...rmSheet, summary: { ...rmSheet.summary, sheet: { rows: [{ ...rmSheet.summary.sheet.rows[0],
      lines: [{ ...rmSheet.summary.sheet.rows[0].lines[1], lot_is_held: true }] }], legacy: [] } } }))
      .toContain('LOT ON HOLD');
    expect(html).toContain('1/15/2027');
    expect(html).toContain('Not on a rack');
  });
});

// ─── Round 2 (2026-10-29) ────────────────────────────────────────────────────

const withEmpty = (sheet, row) => ({
  ...sheet, summary: { ...sheet.summary, sheet: { ...sheet.summary.sheet, rows: [...sheet.summary.sheet.rows, row] } },
});

describe('empty rows', () => {
  const fgE = withEmpty(fgSheet, { row_id: 'dock-1', row_name: 'DOCK 1', area_name: 'FG', area_label: 'Sub / FG', lines: [], empty: true });
  const rmE = withEmpty(rmSheet, { row_id: 'r-c', row_name: 'A-03', area_name: 'Barn', lines: [], empty: true });

  it('FG: confirmed empty sends found licences through the gun; RM: a note, recorded only', () => {
    const d = { rowCounted: { 'dock-1': true }, notHere: [], extras: { 'dock-1': 'l1-mango-015' }, counts: {}, legacy: {} };
    expect(sheetSubmitPayload(fgE, d).rows).toEqual([
      { row_id: 'dock-1', counted: true, not_here_pallet_ids: [], extra_licences: ['L1-MANGO-015'] },
    ]);
    const r = { rowCounted: { 'r-c': true }, notHere: [], extras: { 'r-c': ' 2 drums MG-9 ' }, counts: {}, legacy: {} };
    expect(sheetSubmitPayload(rmE, r).rows).toEqual([{ row_id: 'r-c', counted: true, lines: [], found_note: '2 drums MG-9' }]);
    expect(sheetSubmitPayload(rmE, { ...r, extras: {} }).rows).toEqual([{ row_id: 'r-c', counted: true, lines: [] }]);
    // Something written under "Found here" means the row was not empty.
    expect(sheetDraftStats(rmE, r)).toMatchObject({ emptyConfirmed: 0, emptyWithFinds: 1 });
    expect(sheetDraftStats(rmE, { ...r, extras: {} })).toMatchObject({ emptyConfirmed: 1, emptyWithFinds: 0 });
  });

  it('the submit confirm does not call a row with finds "confirmed empty"', () => {
    const d = { rowCounted: { 'dock-1': true }, notHere: [], extras: { 'dock-1': 'l1-mango-015' }, counts: {}, legacy: {} };
    const lines = submitConfirmLines({ stats: sheetDraftStats(fgE, d), payload: sheetSubmitPayload(fgE, d), extras: [], fg: true });
    expect(lines.join(' ')).not.toContain('confirmed empty');
    expect(lines.join(' ')).toContain('had pallets found in it');
  });

  it('prints "Empty — system shows nothing here" with a Confirmed empty box and a Found here line', () => {
    const html = sheetPrintHtml(fgE);
    expect(html).toContain('Empty — system shows nothing here.');
    expect(html).toContain('Confirmed empty');
    expect(html).toContain('Found here (licence #)');
    expect(sheetPrintHtml(rmE)).toContain('Found here (product · lot · count)');
  });
});

describe('natural row order', () => {
  it('reads numbers as numbers on the sheet and in history', () => {
    expect(['AA101', 'AA31', 'ROW 10', 'ROW 2'].sort(naturalCompare)).toEqual(['AA31', 'AA101', 'ROW 2', 'ROW 10']);
    const rows = sheetRowsInOrder([
      { row_name: 'ROW 10', area_label: 'Sub / FG' }, { row_name: 'ROW 2', area_label: 'Sub / FG' },
      { row_name: 'A1', area_label: 'Cage' },
    ]);
    expect(rows.map((r) => r.row_name)).toEqual(['A1', 'ROW 2', 'ROW 10']);
    // Print follows the same order.
    const html = sheetPrintHtml({ ...fgSheet, summary: { ...fgSheet.summary, sheet: { legacy: [], rows: [
      { row_id: 'b', row_name: 'AA101', area_name: 'FG', lines: [] , empty: true },
      { row_id: 'a', row_name: 'AA31', area_name: 'FG', lines: [], empty: true },
    ] } } });
    expect(html.indexOf('AA31')).toBeLessThan(html.indexOf('AA101'));
    expect(sortCountItems([{ location: 'AA101' }, { location: 'AA31' }]).map((i) => i.location)).toEqual(['AA31', 'AA101']);
  });
});

describe('history of a submitted sheet', () => {
  const items = [
    { status: 'ok', notHere: [], arrived: [] },
    { status: 'shortage', notHere: ['L1-001', 'L1-002'], arrived: [] },
    { status: 'overage', notHere: [], arrived: [
      { licence_number: 'L1-009', result: 'moved' }, { licence_number: 'L1-010', result: 'found' },
      { licence_number: 'L1-015', result: 'created' }] },
    { status: 'skipped', skipReason: 'changed since printed — recount' },
    { status: 'recorded' },
  ];

  it('skipped lines are not OK; not here / found / moved / created are counted', () => {
    expect(countItemStats(items)).toEqual({
      total: 5, ok: 1, differences: 2, skipped: 1, recorded: 1, notHere: 2, found: 1, movedIn: 1, created: 1,
    });
  });

  it('is timed by its submit, not when it was generated, and carries its warnings', () => {
    const [e] = groupCountHistory([{
      id: 's', performedById: 'c', countDate: '2026-10-29', createdAt: at(-600), items,
      summary: { kind: 'count_sheet', status: 'submitted', sheet_no: 'CC-1', submitted_at: '2026-10-29T15:30:00+00:00',
        warnings: [{ message: 'x' }] },
    }]);
    expect(e.at).toBe('2026-10-29T15:30:00+00:00');
    expect(e).toMatchObject({ ok: 1, skipped: 1, notHere: 2, found: 1, movedIn: 1, created: 1, warnings: 1 });
  });

  it('FG licence skips kept only in the summary still count as skipped, so the sheet is not OK', () => {
    const [e] = groupCountHistory([{
      id: 'f', performedById: 'c', countDate: '2026-10-29', createdAt: at(0), items: [{ status: 'ok', notHere: [], arrived: [] }],
      summary: { kind: 'count_sheet', status: 'submitted', sheet_no: 'CC-3', submitted_at: '2026-10-29T15:30:00+00:00',
        skipped: [{ row_name: 'AA111', licence_number: 'L-008', reason: 'shipped' }] },
    }]);
    expect(e.skipped).toBe(1);
  });

  it('a discarded sheet never shows', () => {
    expect(groupCountHistory([{ id: 'd', performedById: 'c', countDate: '2026-10-29', createdAt: at(0), items: [],
      summary: { kind: 'count_sheet', status: 'discarded', sheet_no: 'CC-2' } }])).toEqual([]);
  });
});

describe('extra licences on submit', () => {
  it('classifies each licence like the gun will apply it', () => {
    expect(classifyExtra({ exists: true, status: 'in_stock', storage_row_id: 'row-2' }, 'row-1')).toBe('moved');
    expect(classifyExtra({ exists: true, status: 'in_stock', storage_row_id: 'row-1' }, 'row-1')).toBe('here');
    expect(classifyExtra({ exists: true, status: 'missing' }, 'row-1')).toBe('found');
    expect(classifyExtra({ exists: true, status: 'not_produced' }, 'row-1')).toBe('found');
    expect(classifyExtra({ exists: false, explanation: { kind: 'gap' } }, 'row-1')).toBe('created');
    expect(classifyExtra({ exists: false, explanation: { kind: 'not_a_sticker' } }, 'row-1')).toBe('invalid');
    expect(classifyExtra({ exists: true, status: 'shipped' }, 'row-1')).toBe('unchanged');
    expect(classifyExtra({ exists: true, status: 'other_warehouse' }, 'row-1')).toBe('unchanged');
  });

  it('the confirm names what will be moved, found and created — one pallet each — and says no approval', () => {
    const payload = { rows: [{ row_id: 'row-1', not_here_pallet_ids: ['pl-1'], extra_licences: ['A', 'B', 'C', 'D'] }], legacy: [] };
    const stats = { rowsTotal: 3, rowsCounted: 1, emptyConfirmed: 0, blankLines: 0 };
    const lines = submitConfirmLines({ stats, payload, fg: true, extras: [
      { licence: 'A', row_name: 'FG-01', outcome: 'moved' },
      { licence: 'B', row_name: 'FG-01', outcome: 'found' },
      { licence: 'C', row_name: 'FG-01', outcome: 'created' },
      { licence: 'D', row_name: 'FG-01', outcome: 'unchanged', message: 'D was shipped' },
    ] });
    expect(lines).toContain('1 pallet ticked ✗ will be marked MISSING.');
    expect(lines).toContain('Moved here from another row: A (FG-01).');
    expect(lines).toContain('Found — back in stock here: B (FG-01).');
    expect(lines.some((l) => l.startsWith('Created from the sticker') && l.includes('C (FG-01)') && l.includes('not a range'))).toBe(true);
    expect(lines).toContain('Not changed: D — D was shipped.');
    expect(lines[lines.length - 1]).toMatch(/no approval step/);
    // Lookup failed: still warns, less specifically.
    expect(submitConfirmLines({ stats, payload, fg: true, extras: null }).join(' '))
      .toContain('4 extra licences will each be moved here, found or created from its sticker');
  });
});
