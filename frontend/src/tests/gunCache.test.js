import { describe, expect, it } from 'vitest';
import { findCachedRack } from '../utils/gunCache';

// N6: the gun's saved rack list must resolve a rack the way the server does.
describe('findCachedRack', () => {
  const rows = [
    { id: 'p1', name: 'QA-P1', barcode: 'PAW-QA-P1' },
    { id: 'd1', name: 'QA-D1', barcode: 'QA-D1' },
    { id: 'a', name: 'A-12', barcode: 'B1-A-12' },
    { id: 'b', name: 'A-12', barcode: 'B2-A-12' },
    { id: 'old', name: 'OLD-1', barcode: 'OLD-1', is_active: false },
  ];
  it('matches the barcode first, case-insensitively', () => {
    expect(findCachedRack(rows, 'paw-qa-p1').row.id).toBe('p1');
    expect(findCachedRack(rows, 'B2-A-12').row.id).toBe('b');
  });
  it('falls back to a unique exact name', () => {
    expect(findCachedRack(rows, 'QA-P1').row.id).toBe('p1');
    expect(findCachedRack(rows, ' qa-p1 ').row.id).toBe('p1');
  });
  it('refuses a shared name instead of picking one', () => {
    const out = findCachedRack(rows, 'A-12');
    expect(out.row).toBeNull();
    expect(out.ambiguous.map((r) => r.id)).toEqual(['a', 'b']);
  });
  it('ignores inactive racks and unknown codes', () => {
    expect(findCachedRack(rows, 'OLD-1').row).toBeNull();
    expect(findCachedRack(rows, 'NOPE')).toEqual({ row: null, ambiguous: [] });
    expect(findCachedRack(null, 'QA-P1').row).toBeNull();
  });
});
