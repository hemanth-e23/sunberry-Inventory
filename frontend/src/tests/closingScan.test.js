import { describe, expect, it } from 'vitest';
import { closingLabel, closingSummary } from '../utils/closingScan';

const LOT = 'MP28226L2';
const pl = (seq, status = 'pending', lot = LOT) => ({ sequence: seq, status, lot_number: lot });

describe('closingSummary', () => {
  it('shows a clean close as a match', () => {
    const fr = { lot_number: LOT, closing_scans: { [LOT]: { sequence: 9, at: '2026-10-12T13:14:00Z' } } };
    const [c] = closingSummary(fr, [1, 2, 9].map((s) => pl(s)));
    expect(c.kind).toBe('match');
    expect(closingLabel(c)).toBe('Last pallet at wrapper: #009 — matches');
  });

  it('names the numbers after the last scan', () => {
    const fr = { lot_number: LOT, closing_scans: { [LOT]: { sequence: 12 } } };
    const [c] = closingSummary(fr, [pl(8), pl(9)]);
    expect(c).toMatchObject({ kind: 'after', from: 10, to: 12 });
    expect(closingLabel(c)).toBe('Last pallet at wrapper: #012 — #010–012 not scanned');
  });

  it('ignores a cancelled misread when working out the highest scanned', () => {
    const fr = { lot_number: LOT, closing_scans: { [LOT]: { sequence: 9 } } };
    const out = closingSummary(fr, [pl(9), { sequence: 5, status: 'cancelled', lot_number: 'P28226L2' }]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('match');
  });

  it('flags skipped and auto-submitted sessions, and old sessions as none', () => {
    expect(closingSummary({ lot_number: LOT, closing_scans: { [LOT]: { skipped: true } } }, [pl(1)])[0].kind)
      .toBe('skipped');
    expect(closingSummary({ lot_number: LOT, auto_submitted_at: 'x' }, [pl(1)])[0].kind).toBe('not_closed');
    const [old] = closingSummary({ lot_number: LOT }, [pl(1)]);
    expect(old.kind).toBe('none');
    expect(closingLabel(old)).toBe('No closing scan');
  });

  it('gives one entry per lot after a midnight rollover', () => {
    const fr = { lot_number: LOT, closing_scans: { [LOT]: { sequence: 3 }, MP28326L2: { sequence: 2 } } };
    const out = closingSummary(fr, [pl(3), pl(1, 'pending', 'MP28326L2'), pl(2, 'pending', 'MP28326L2')]);
    expect(out.map((c) => [c.lot, c.kind])).toEqual([[LOT, 'match'], ['MP28326L2', 'match']]);
  });
});
