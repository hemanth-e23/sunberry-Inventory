import { describe, expect, it } from 'vitest';
import {
  attentionFlags, createDoubleFireGuard, describeFlag, describeRecountDiff, formatUnitTotals,
  groupReceiptsByTruck, lineMismatchNote, matchTypedLot, needsPalletCheck, offlineMessage, shouldAskPallet,
  overScanTitle, palletCheckKey, parseLooseQty, queuedScanLabel, rackFillLabel, rackFillMap,
  scanUnitsBadge, truckUnitWords, unitCount,
} from '../utils/truckReceiving';
import { readCached, saveCached } from '../utils/gunCache';

describe('gunCache (U1)', () => {
  it('keeps what the gun last saw, and drops a copy older than a day', () => {
    window.localStorage.clear();
    saveCached('truck:o1', { order_id: 'o1' }, 1000);
    expect(readCached('truck:o1', 2000)).toEqual({ savedAt: 1000, data: { order_id: 'o1' } });
    expect(readCached('truck:o1', 1000 + 25 * 60 * 60 * 1000)).toBeNull();
    expect(readCached('truck:nope')).toBeNull();
  });

  it('survives junk in storage', () => {
    window.localStorage.setItem('sunberry-gun-cache-v1:bad', '{not json');
    expect(readCached('bad')).toBeNull();
  });
});

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

// ── Browser test PART 1 (2026-10-01) ────────────────────────────────────────

describe('unitCount', () => {
  it('pluralises properly — never "1 drums" or "boxs"', () => {
    expect(unitCount(1, 'drums')).toBe('1 drum');
    expect(unitCount(12, 'drum')).toBe('12 drums');
    expect(unitCount(3, 'box')).toBe('3 boxes');
    expect(unitCount(1, 'boxes')).toBe('1 box');
    expect(unitCount(0, 'bag')).toBe('0 bags');
  });
});

describe('truckUnitWords', () => {
  it('uses the truck\'s own units — a bag and box truck is never told about drums', () => {
    expect(truckUnitWords([{ unit_label: 'bag' }, { unit_label: 'box' }, { unit_label: 'bag' }]))
      .toEqual({ one: 'bag or box', many: 'bags and boxes' });
    expect(truckUnitWords([{ unit_label: 'drum' }])).toEqual({ one: 'drum', many: 'drums' });
    expect(truckUnitWords([{ count_unit: 'boxes' }])).toEqual({ one: 'box', many: 'boxes' });
  });

  it('falls back to a neutral word before the truck has loaded', () => {
    expect(truckUnitWords([])).toEqual({ one: 'unit', many: 'units' });
  });
});

describe('lineMismatchNote', () => {
  it('flags a total that hides one lot over and another short (22 of 22)', () => {
    const lines = [
      { expected_count: 8, scanned_count: 9 },
      { expected_count: 14, scanned_count: 13 },
    ];
    expect(lineMismatchNote(lines)).toBe('1 line over, 1 short');
  });

  it('stays quiet while lines are only short — the total already shows that', () => {
    expect(lineMismatchNote([{ expected_count: 8, scanned_count: 3 }])).toBe('');
    expect(lineMismatchNote([{ expected_count: 8, scanned_count: 8 }])).toBe('');
  });

  it('reads the live count when asked (queued scans included)', () => {
    expect(lineMismatchNote([{ expected_count: 2, scanned_count: 2, shown: 3 }], { countKey: 'shown' }))
      .toBe('1 line over');
  });
});

describe('describeRecountDiff', () => {
  it('asks before a lower count takes stock off the rack', () => {
    expect(describeRecountDiff({ scanned: 12, actual: 11, unitLabel: 'drums' }))
      .toBe('You scanned 12, you counted 11 — 1 drum missing?');
  });

  it('asks before a higher count adds stock', () => {
    expect(describeRecountDiff({ scanned: 3, actual: 5, unitLabel: 'boxes' }))
      .toBe('You scanned 3, you counted 5 — 2 boxes more than scanned?');
  });

  it('has nothing to ask when they agree', () => {
    expect(describeRecountDiff({ scanned: 4, actual: 4, unitLabel: 'drums' })).toBeNull();
  });
});

describe('overScanTitle', () => {
  it('names the line\'s own unit for a single', () => {
    expect(overScanTitle({ units: 1, countUnit: 'bags' })).toBe('Stop — check this bag');
  });

  it('says how much a pallet scan would add', () => {
    expect(overScanTitle({ units: 40, countUnit: 'bags' })).toBe('Stop — this scan adds 40 bags');
  });
});

describe('scanUnitsBadge', () => {
  it('makes a pallet scan look different from a single', () => {
    expect(scanUnitsBadge(40, 'box')).toEqual({ text: '+40 boxes · pallet', pallet: true });
    expect(scanUnitsBadge(1, 'boxes')).toEqual({ text: '+1 box', pallet: false });
  });
});

describe('parseLooseQty', () => {
  it('takes a whole number of loose units', () => {
    expect(parseLooseQty('30')).toEqual({ qty: 30, error: '' });
    expect(parseLooseQty(' 7 ')).toEqual({ qty: 7, error: '' });
  });

  it('refuses nothing, zero, fractions and silly amounts', () => {
    expect(parseLooseQty('').error).toBeTruthy();
    expect(parseLooseQty('0').error).toBeTruthy();
    expect(parseLooseQty('2.5').error).toBeTruthy();
    expect(parseLooseQty('-3').error).toBeTruthy();
    expect(parseLooseQty('501').error).toBeTruthy();
  });
});

// ─── PART 2 (G3, U10, U2, U1) ────────────────────────────────────────────────

const L = (id, lot_code, vendor_lot) => ({ line_id: id, lot_code, vendor_lot });

describe('matchTypedLot (G3)', () => {
  const lines = [L('a', 'SB-LONG-CODE-A', 'A-0925'), L('b', 'SB-LONG-CODE-B', 'B-0910')];

  it('our own sticker code wins', () => {
    expect(matchTypedLot(lines, 'sb-long-code-b')).toEqual({ kind: 'sticker', lines: [lines[1]] });
  });

  it('the vendor lot printed on the drum resolves to its one line, any case and spacing', () => {
    expect(matchTypedLot(lines, '  a-0925 ')).toEqual({ kind: 'vendor', lines: [lines[0]] });
  });

  it('a vendor lot on two lines is ambiguous — never picked', () => {
    const two = [...lines, L('c', 'SB-LONG-CODE-C', 'A-0925')];
    const out = matchTypedLot(two, 'A-0925');
    expect(out.kind).toBe('ambiguous');
    expect(out.lines.map((l) => l.line_id)).toEqual(['a', 'c']);
  });

  it('nothing on the truck, or nothing typed', () => {
    expect(matchTypedLot(lines, 'Z-1').kind).toBe('none');
    expect(matchTypedLot(lines, '  ').kind).toBe('none');
    expect(matchTypedLot(undefined, 'A-0925').kind).toBe('none');
  });
});

describe('rackFillLabel / rackFillMap (U10)', () => {
  const drumRack = { storage_unit: 'drum', unit_capacity: 12 };

  it('says how full, not only how big', () => {
    expect(rackFillLabel(drumRack, 11)).toEqual({ text: '11/12 drums', full: false });
    expect(rackFillLabel(drumRack, 12)).toEqual({ text: '12/12 drums', full: true });
    expect(rackFillLabel(drumRack, 0)).toEqual({ text: '0/12 drums', full: false });
  });

  it('a rack with no stated capacity still shows what is on it', () => {
    expect(rackFillLabel({ storage_unit: 'bag' }, 3).text).toBe('3 bags here');
    expect(rackFillLabel({}, 0).text).toBe('');
  });

  it('maps the server answer', () => {
    expect(rackFillMap({ rows: [{ storage_row_id: 'r1', units: 4 }, { units: 9 }] })).toEqual({ r1: 4 });
    expect(rackFillMap(null)).toEqual({});
  });
});

describe('needsPalletCheck (U2)', () => {
  it('asks only for a multi-unit scan, once per lot per rack', () => {
    const confirmed = new Set();
    const ask = { unitsPerScan: 40, confirmed, lineId: 'l1', rowId: 'r1' };
    expect(needsPalletCheck(ask)).toBe(true);
    confirmed.add(palletCheckKey('l1', 'r1'));
    expect(needsPalletCheck(ask)).toBe(false);
    expect(needsPalletCheck({ ...ask, rowId: 'r2' })).toBe(true);   // a new rack asks again
    expect(needsPalletCheck({ ...ask, unitsPerScan: 1, rowId: 'r2' })).toBe(false); // drums never
  });
});

describe('queuedScanLabel / offlineMessage (U1)', () => {
  it('names product, vendor lot and rack — never an order id', () => {
    expect(queuedScanLabel({
      productName: 'QA Mango Puree', vendorLot: 'A-0925', lotCode: 'SB-X', rowName: 'QA-D4',
    })).toBe('QA Mango Puree · Lot A-0925 → QA-D4');
    expect(queuedScanLabel({
      productName: 'Ascorbic', lotCode: 'SB-C', rowName: 'QA-P1', units: 40, unit: 'bag',
    })).toBe('40 bags of Ascorbic · Lot SB-C → QA-P1');
  });

  it('offline wording says nothing changed and scans are safe — no status codes', () => {
    const text = offlineMessage('Not removed');
    expect(text).toMatch(/Nothing was changed/);
    expect(text).toMatch(/saved on this gun/);
    expect(text).not.toMatch(/\d{3}/);
  });
});

describe('shouldAskPallet (N2)', () => {
  const base = { unitsPerScan: 40, lineId: 'l1', rowId: 'r1' };
  it('asks on a fresh rack, not once confirmed or once the lot is there', () => {
    const confirmed = new Set();
    expect(shouldAskPallet({ ...base, confirmed })).toBe(true);
    expect(shouldAskPallet({ ...base, confirmed, alreadyThere: true })).toBe(false);
    confirmed.add(palletCheckKey('l1', 'r1'));
    expect(shouldAskPallet({ ...base, confirmed })).toBe(false);
  });
  it('always asks where the worker said "one bag", even with the lot already there', () => {
    const saidOne = new Set([palletCheckKey('l1', 'r1')]);
    expect(shouldAskPallet({ ...base, saidOne, alreadyThere: true })).toBe(true);
    expect(shouldAskPallet({ ...base, saidOne, rowId: 'r2', alreadyThere: true })).toBe(false);
    expect(shouldAskPallet({ ...base, saidOne, unitsPerScan: 1 })).toBe(false);
  });
});
