// FG pallet lifecycle (FG-PALLET-LIFECYCLE-SPEC.md) — pure helpers.
import { describe, it, expect } from 'vitest';
import { lotOfLicence } from '../utils/scannerFeedback';
import { caseAdjustmentPayload } from '../utils/caseAdjustment';
import { selectRange, shuttleSelectionTotals } from '../utils/moyelShuttle';
import { matchRow, notHereIds } from '../utils/cycleCheck';

describe('lotOfLicence (closing-scan lot rollover)', () => {
  it('takes everything before -PRODUCT-SEQ', () => {
    expect(lotOfLicence('MP28026L1-MANGO-014')).toBe('MP28026L1');
    expect(lotOfLicence('LOT20260219-L1-MANGO-001')).toBe('LOT20260219-L1');
    expect(lotOfLicence('junk')).toBe('');
  });
});

describe('caseAdjustmentPayload (±N cases on one pallet, §4.2)', () => {
  const pallet = { id: 'pl-1', cases: 40 };
  it('builds a signed delta with the reason code', () => {
    const out = caseAdjustmentPayload({ pallet, sign: '-', count: '5', reasonCode: 'leaker_damaged', reason: 'Leaker' });
    expect(out.adjustment).toEqual({
      palletLicenceIds: ['pl-1'],
      adjustmentType: 'case-adjustment',
      reason: 'Leaker',
      sourceBreakdown: [{ case_delta: -5, reason_code: 'leaker_damaged' }],
    });
    const plus = caseAdjustmentPayload({ pallet, sign: '+', count: 3, reasonCode: 'count_correction', reason: 'recount' });
    expect(plus.adjustment.sourceBreakdown[0].case_delta).toBe(3);
  });
  it('refuses removing more than the pallet has, fractions, or no reason', () => {
    expect(caseAdjustmentPayload({ pallet, sign: '-', count: 41, reasonCode: 'repack', reason: 'x' }).error).toMatch(/40 cases/);
    expect(caseAdjustmentPayload({ pallet, sign: '-', count: 1.5, reasonCode: 'repack', reason: 'x' }).error).toMatch(/whole number/);
    expect(caseAdjustmentPayload({ pallet, sign: '-', count: 1, reasonCode: 'repack', reason: ' ' }).error).toMatch(/Reason/);
    expect(caseAdjustmentPayload({ pallet: null, sign: '-', count: 1, reasonCode: 'repack', reason: 'x' }).error).toMatch(/pallet/);
  });
});

describe('Moyel shuttle selection', () => {
  const rows = [{ cases: 40 }, { cases: 40 }, { cases: 12 }, { cases: 40 }];
  it('totals pallets and real (partial) cases', () => {
    expect(shuttleSelectionTotals(rows.slice(0, 3))).toEqual({ pallets: 3, cases: 92 });
  });
  it('selects a shift-click range in either direction', () => {
    expect(selectRange(rows, 3, 1)).toEqual(rows.slice(1, 4));
    expect(selectRange(rows, 0, 0)).toEqual([rows[0]]);
  });
});

describe('gun cycle check helpers (§4.1)', () => {
  const rows = [
    { id: 'row-1', name: 'FG-AJ11', barcode: 'PAW-AJ11' },
    { id: 'row-2', name: 'DOCK 1' },
  ];
  it('matches a row like the receipt gun does (with/without FG-, id, barcode)', () => {
    expect(matchRow(rows, 'AJ11').id).toBe('row-1');
    expect(matchRow(rows, 'fg-aj11').id).toBe('row-1');
    expect(matchRow(rows, 'row-2').id).toBe('row-2');
    expect(matchRow(rows, 'PAW-AJ11').id).toBe('row-1');
    expect(matchRow(rows, 'ZZ')).toBeNull();
  });
  it('accepts an FG- prefix on the scanned sticker when the row is stored without one', () => {
    const plain = [{ id: 'row-9', name: 'AI81' }];
    expect(matchRow(plain, 'FG-AI81').id).toBe('row-9');
    expect(matchRow(plain, 'fg ai81').id).toBe('row-9');
    expect(matchRow(plain, 'AI81').id).toBe('row-9');
    expect(matchRow(plain, 'FG-')).toBeNull();
  });
  it('a group tapped Not here marks its pallets, minus any actually scanned', () => {
    const groups = [
      { key: 'g1', pallets: [{ id: 'a', licence_number: 'A' }, { id: 'b', licence_number: 'B' }] },
      { key: 'g2', pallets: [{ id: 'c', licence_number: 'C' }] },
    ];
    expect(notHereIds(groups, new Set(['g1']), new Set(), new Set(['A']))).toEqual(['b']);
    expect(notHereIds(groups, new Set(), new Set(['c']), new Set())).toEqual(['c']);
  });
});
