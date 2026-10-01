import { beforeAll, describe, expect, it } from 'vitest';
import { formatDate, formatDateKey, setAppTimezone } from '../utils/dateUtils';

/**
 * A DAY is not a MOMENT.
 *
 * `new Date('2026-08-21')` parses as midnight UTC. Rendered in an America/
 * New_York warehouse that is 8/20/2026 — so the day navigator showed
 * "Today · 8/20/2026" while its own date input said 08/21. The label was a day
 * behind the thing it described, on both Shipping tabs.
 *
 * This is the third place the same trap has appeared: the label payload warned
 * about it for best-by dates, the API was serializing calendar fields as
 * offset instants, and then the day navigator. Anything that is a day belongs
 * on formatDateKey.
 */
describe('formatDateKey', () => {
  beforeAll(() => setAppTimezone('America/New_York'));

  it('renders the day that was asked for, west of UTC', () => {
    expect(formatDateKey('2026-08-21')).toBe('8/21/2026');
  });

  it('does not drift on a month boundary', () => {
    expect(formatDateKey('2026-09-01')).toBe('9/1/2026');
    expect(formatDateKey('2027-01-01')).toBe('1/1/2027');
  });

  it('ignores anything after the day', () => {
    expect(formatDateKey('2026-08-21T00:00:00Z')).toBe('8/21/2026');
  });

  it('handles empty input', () => {
    expect(formatDateKey('')).toBe('—');
    expect(formatDateKey(null)).toBe('—');
  });

  it('formatDate no longer shifts a bare day key either (2026-10-01)', () => {
    // Most best-by render sites still called formatDate, so every screen
    // showed the best-by a day early. A bare `YYYY-MM-DD` is never an
    // instant, so formatDate now reads it lexically too; timestamps still
    // go through the timezone.
    expect(formatDate('2026-08-21')).toBe('8/21/2026');
    expect(formatDateKey('2026-08-21')).toBe('8/21/2026');
    expect(formatDate('2026-08-21T00:00:00Z')).not.toBe('8/21/2026');
  });
});
