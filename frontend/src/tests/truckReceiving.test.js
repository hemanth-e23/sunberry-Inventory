import { describe, expect, it } from 'vitest';
import {
  attentionFlags, createDoubleFireGuard, describeFlag, formatUnitTotals, groupReceiptsByTruck,
} from '../utils/truckReceiving';

describe('createDoubleFireGuard', () => {
  it('ignores an identical read inside the window — a trigger bounce', () => {
    const isBounce = createDoubleFireGuard(1000);
    expect(isBounce('SB2|L1|A|20270101', 0)).toBe(false);
    expect(isBounce('SB2|L1|A|20270101', 300)).toBe(true);
  });

  it('accepts the same sticker again once the window has passed — the next drum', () => {
    const isBounce = createDoubleFireGuard(1000);
    isBounce('SB2|L1', 0);
    expect(isBounce('SB2|L1', 1500)).toBe(false);
  });

  it('never treats a different code as a bounce', () => {
    const isBounce = createDoubleFireGuard(1000);
    isBounce('SB2|L1', 0);
    expect(isBounce('SB2|L2', 100)).toBe(false);
    expect(isBounce('SB2|L1', 200)).toBe(false);
  });

  it('measures the window from the LAST read, so a bounce cannot extend itself forever', () => {
    const isBounce = createDoubleFireGuard(1000);
    isBounce('X', 0);
    expect(isBounce('X', 900)).toBe(true);
    expect(isBounce('X', 2000)).toBe(false);
  });
});

describe('groupReceiptsByTruck', () => {
  it('puts a truck\'s lines on one card and leaves walk-ins alone', () => {
    const { trucks, singles } = groupReceiptsByTruck([
      { id: 'r1', incomingOrderId: 'o1', incomingOrderNumber: 'IN-1' },
      { id: 'w1' },
      { id: 'r2', incomingOrderId: 'o1', incomingOrderNumber: 'IN-1' },
      { id: 'r3', incomingOrderId: 'o2', incomingOrderNumber: 'IN-2' },
    ]);
    expect(trucks.map((t) => [t.orderNumber, t.receipts.map((r) => r.id)])).toEqual([
      ['IN-1', ['r1', 'r2']],
      ['IN-2', ['r3']],
    ]);
    expect(singles.map((r) => r.id)).toEqual(['w1']);
  });
});

describe('formatUnitTotals', () => {
  it('reports each kind of material on its own — never drums plus bottles', () => {
    expect(formatUnitTotals([
      { unit: 'drum', expected: 40, scanned: 18 },
      { unit: 'unit', expected: 12672, scanned: 0 },
    ])).toBe('18 of 40 drums · 0 of 12,672 units');
  });
});

describe('flags', () => {
  it('a recount that agreed is not something the approver needs to read', () => {
    const flags = [{ kind: 'recount_ok' }, { kind: 'short', lot_code: 'L1', expected: 3, actual: 2, detail: 'Damaged' }];
    expect(attentionFlags(flags)).toHaveLength(1);
    expect(describeFlag(flags[1])).toContain('2 of 3');
  });
});
