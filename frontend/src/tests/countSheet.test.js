// Count sheet by rack row (2026-10-29): history, submit payload, print sheet.
import { describe, it, expect } from 'vitest';
import {
  groupCountHistory, parseCount, parseLicences, sheetDraftStats, sheetPrintHtml, sheetSubmitPayload,
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
    expect(sheetDraftStats(rmSheet, draft)).toEqual({ rowsTotal: 1, rowsCounted: 1, blankLines: 1, badLines: 0 });
    expect(sheetDraftStats(rmSheet, { ...draft, counts: { 'lp-1': '8', 'lp-2': '1.5' } }).badLines).toBe(1);
  });
});

describe('sheetPrintHtml', () => {
  it('FG: sheet number, counted-by line, a box per licence, held marked, extra line, escaped', () => {
    const html = sheetPrintHtml(fgSheet);
    expect(html).toContain('CC-7F3A21');
    expect(html).toContain('Counted by');
    expect(html).toContain('size: A4 landscape');
    expect(html.match(/class="lic"/g)).toHaveLength(3);
    expect(html).toContain('002 <b>HELD</b>');
    expect(html.match(/Extra found \(licence #\)/g)).toHaveLength(2);
    expect(html).toContain('Mango &lt;64oz&gt;');
    expect(html).not.toContain('<64oz>');
  });

  it('RM: blank count box per line, held + open shown, BBD as a calendar day, not-on-a-rack section', () => {
    const html = sheetPrintHtml(rmSheet);
    expect(html.match(/class="count-box"/g)).toHaveLength(3);
    expect(html).toContain('1 open');
    expect(html).toContain('<b>2 held</b>');
    expect(html).toContain('1/15/2027');
    expect(html).toContain('Not on a rack');
  });
});
