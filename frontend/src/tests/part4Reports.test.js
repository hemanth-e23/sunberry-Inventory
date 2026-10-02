import { describe, expect, it } from 'vitest';
import {
  countCell, cycleCountColumns, isOnHandReceiptRow, receivedCell, signedQty, stockFigure,
  varianceCards,
} from '../components/reports/reportUtils';
import { orderTruckList, truckProgress } from '../utils/truckReceiving';

// Browser test PART 4 (2026-10-02): P4 snapshot, P5 cycle counts, P6
// adjustment before/after, P7 vendor receipts, P8 truck list order.

describe('Adjustments report before/after (P6)', () => {
  it('shows a lot figure, and "—" for a missing or negative one', () => {
    expect(stockFigure(9328)).toBe((9328).toLocaleString());
    expect(stockFigure(0)).toBe('0');
    expect(stockFigure(-202)).toBe('—');
    expect(stockFigure(null)).toBe('—');
    expect(stockFigure(undefined)).toBe('—');
  });
});

describe('Cycle Counts report (P5)', () => {
  const rmRow = {
    count_kind: 'Recount', product_name: 'QA Mango Puree', lot_number: 'A-0925', location: 'QA-D4',
    system_count: 6, actual_count: 7, system_detail: '6 drums + 1 open (210 lbs)',
    actual_detail: '7 drums + 1 open (210 lbs)', variance: 1, unit: 'drums', counted_by: 'QA Sup',
  };
  const col = (label) => cycleCountColumns.find((c) => c.label === label).value;

  it('shows the rack wording for a raw-material count and the plain number for FG', () => {
    expect(countCell(rmRow, 'system')).toBe('6 drums + 1 open (210 lbs)');
    expect(countCell(rmRow, 'actual')).toBe('7 drums + 1 open (210 lbs)');
    expect(countCell({ system_count: 40, actual_count: 38 }, 'system')).toBe('40');
    expect(countCell({}, 'actual')).toBe('—');
  });

  it('signs the variance with its unit and shows the lot and who counted', () => {
    expect(col('Variance')(rmRow)).toBe('+1 drums');
    expect(col('Variance')({ ...rmRow, variance: -1, unit: 'bags' })).toBe('−1 bags');
    expect(col('Lot')(rmRow)).toBe('A-0925');
    expect(col('Kind')(rmRow)).toBe('Recount');
    expect(col('Kind')({})).toBe('Cycle count');
    expect(col('Counted By')(rmRow)).toBe('QA Sup');
    expect(signedQty(0, 'cases')).toBe('0 cases');
  });

  it('never adds drums to bags in the summary cards', () => {
    const cards = varianceCards({ variance_by_unit: { drums: 2, bags: -1 }, total_variance: 1 });
    expect(cards.map((c) => c.label)).toEqual(['Variance (drums)', 'Variance (bags)']);
    expect(cards.map((c) => c.value)).toEqual(['+2 drums', '−1 bags']);
    expect(varianceCards({ total_variance: 0 })[0].label).toBe('Total Variance');
  });
});

describe('Vendor Receipts (P7)', () => {
  it('shows what the truck brought, with its containers', () => {
    expect(receivedCell({
      quantity: 1422, quantity_received: 1422, quantity_remaining: 0, unit: 'lbs',
      containers: 3, container_unit: 'drums',
    })).toBe('1,422 lbs (3 drums)');
    expect(receivedCell({ quantity: 40, unit: 'cases' })).toBe('40 cases');
  });
});

describe('Inventory Snapshot current on-hand (P4)', () => {
  it('counts approved deliveries only — never a rejected or unapproved one', () => {
    expect(isOnHandReceiptRow({ status: 'approved', quantity: 600 })).toBe(true);
    expect(isOnHandReceiptRow({ status: 'rejected', quantity: 150 })).toBe(false);
    expect(isOnHandReceiptRow({ status: 'recorded', quantity: 150 })).toBe(false);
    expect(isOnHandReceiptRow({ status: 'approved', quantity: 0 })).toBe(false);
  });

  it('D-0801: 1,850 + 600 approved and a rejected 150 sum to 2,450', () => {
    const rows = [
      { status: 'approved', quantity: 1850 },
      { status: 'approved', quantity: 600 },
      { status: 'rejected', quantity: 150 },
    ];
    expect(rows.filter(isOnHandReceiptRow).reduce((s, r) => s + r.quantity, 0)).toBe(2450);
  });
});

describe('Receiving list order (P8)', () => {
  const t = (id, date, scanned, expected) => ({
    order_id: id, expected_date: date, lines: [{ scanned_count: scanned, expected_count: expected }],
  });

  it('classifies a truck by what has been scanned', () => {
    expect(truckProgress(t('a', null, 0, 10))).toBe('not_started');
    expect(truckProgress(t('a', null, 4, 10))).toBe('in_progress');
    expect(truckProgress(t('a', null, 10, 10))).toBe('all_scanned');
    expect(truckProgress({})).toBe('not_started');
  });

  it('puts unloading trucks first, newest first, and all-scanned ones apart', () => {
    const { open, done } = orderTruckList([
      t('old-untouched', '2026-08-01', 0, 70),
      t('finished', '2026-09-30', 10, 10),
      t('new-untouched', '2026-09-20', 0, 5),
      t('unloading', '2026-09-01', 2, 5),
    ]);
    expect(open.map((x) => x.order_id)).toEqual(['unloading', 'new-untouched', 'old-untouched']);
    expect(done.map((x) => x.order_id)).toEqual(['finished']);
  });
});
