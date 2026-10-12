// Count History grouping + gun session storage (cycle check sessions, 2026-10-12).
// Production Oct 12: 21 row checks in 11 minutes showed as 21 history lines.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  groupCountHistory, loadCycleSession, rowHasDifference, saveCycleSession, sessionRowFromResult, sessionTotals,
} from '../utils/cycleCheck';

const T0 = Date.parse('2026-10-12T13:00:00Z');
const iso = (ms) => new Date(ms).toISOString().replace('Z', '');   // server sends naive UTC
const gun = (id, who, at, extra = {}) => ({
  id, performedById: who, performedBy: who.toUpperCase(), countDate: '2026-10-12', createdAt: iso(at),
  items: [], summary: { kind: 'gun_row_check', row_name: `ROW-${id}`, expected_pallets: 2, not_here: 0,
    moved_in: 0, found: 0, created: 0, variancesCount: 0, ...extra },
});

describe('groupCountHistory', () => {
  it('groups old checks by person + day + no gap over 60 min, newest first', () => {
    const counts = [
      ...Array.from({ length: 21 }, (_, i) => gun(`c${i}`, 'fk-1', T0 + i * 31000, i === 3 ? { not_here: 2, variancesCount: 1 } : {})),
      gun('late', 'fk-1', T0 + 91 * 60000),
      gun('other', 'fk-2', T0 + 2 * 60000),
      { id: 'sheet', performedById: 'clerk', countDate: '2026-10-11', createdAt: iso(T0 - 86400000), items: [], summary: { totalItems: 3, variancesCount: 1 } },
    ];
    const h = groupCountHistory(counts, 60);
    expect(h.map((e) => (e.type === 'session' ? e.rowsChecked : 'sheet'))).toEqual([1, 21, 1, 'sheet']);
    const big = h.find((e) => e.rowsChecked === 21);
    expect(big).toMatchObject({ inferred: true, rowsOk: 20, rowsWithDifferences: 1, notHere: 2, performedBy: 'FK-1' });
    expect(big.rows[0].rowName).toBe('ROW-c0');
    expect(h.at(-1).count.id).toBe('sheet');
  });

  it('groups tagged checks by session id even across a long gap, and splits by person', () => {
    const counts = [
      gun('a', 'fk-1', T0, { session_id: 'cs-aaaaaaaaaaaa' }),
      gun('b', 'fk-1', T0 + 90 * 60000, { session_id: 'cs-aaaaaaaaaaaa', moved_in: 1 }),
      gun('c', 'fk-2', T0 + 60000, { session_id: 'cs-aaaaaaaaaaaa' }),
    ];
    const h = groupCountHistory(counts, 60);
    expect(h).toHaveLength(2);
    const mine = h.find((e) => e.performedById === 'fk-1');
    expect(mine).toMatchObject({ inferred: false, rowsChecked: 2, movedIn: 1, rowsWithDifferences: 1 });
  });

  it('splits old checks at the day boundary', () => {
    const counts = [gun('x', 'fk-1', T0), { ...gun('y', 'fk-1', T0 + 60000), countDate: '2026-10-13' }];
    expect(groupCountHistory(counts, 60)).toHaveLength(2);
  });
});

describe('gun session storage', () => {
  beforeEach(() => window.localStorage.clear());

  it('round-trips, expires after the idle gap unless a row is in progress', () => {
    const now = Date.now();
    saveCycleSession('u1', { id: 'cs-1', lastAt: now - 61 * 60000, rows: [], draft: null });
    expect(loadCycleSession('u1', 60, now)).toBeNull();
    saveCycleSession('u1', { id: 'cs-1', lastAt: now - 61 * 60000, rows: [], draft: { row: { id: 'r' } } });
    expect(loadCycleSession('u1', 60, now).id).toBe('cs-1');
    expect(loadCycleSession('u2', 60, now)).toBeNull();          // per user
    saveCycleSession('u1', null);
    expect(loadCycleSession('u1', 60, now)).toBeNull();
  });

  it('ignores broken storage', () => {
    window.localStorage.setItem('sb.cycleCheck.session.u1', '{nope');
    expect(loadCycleSession('u1', 60)).toBeNull();
  });

  it('totals rows: OK vs differences and pallet counts', () => {
    const rows = [
      sessionRowFromResult({ row_name: 'A', not_here: 0, variancesCount: 0, scans: [] }),
      sessionRowFromResult({ row_name: 'B', not_here: 2, variancesCount: 1, scans: [{ message: 'x shipped' }] }),
      sessionRowFromResult({ row_name: 'C', created: 1, variancesCount: 1, scans: [] }),
    ];
    expect(rows[1].messages).toEqual(['x shipped']);
    expect(sessionTotals(rows)).toEqual({ rows: 3, ok: 1, differences: 2, not_here: 2, found: 0, moved_in: 0, created: 1 });
    expect(rowHasDifference({ found: 1 })).toBe(true);
    expect(rowHasDifference({})).toBe(false);
  });
});
