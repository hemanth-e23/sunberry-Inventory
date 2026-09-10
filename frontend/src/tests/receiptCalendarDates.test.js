// A receipt's expiry, receipt date and production date are CALENDAR DAYS.
//
// An expiry typed as 12/02 came back 12/01 on the approvals screen. The day was
// lost in ReceiptContext's mapper, before any component formatted it: the value
// is stored at midnight UTC, and `toDateKey` is timezone-aware, so in a
// warehouse behind UTC it resolves to 7pm the PREVIOUS day and returns that.
//
// Every screen downstream inherited the shift, which is why it looked like a
// display bug in one place and was actually one line in the context.
//
// The rule, which this file pins: a calendar day is read LEXICALLY at every
// hop — typed, stored, mapped, rendered — and never through a timezone-aware
// helper. A best-by printed one day early is a food-safety defect.

import { describe, it, expect, afterEach } from 'vitest';
import { toCalendarKey } from '../utils/labelPayload';
import { formatDateKey, formatDate, toDateKey, setAppTimezone } from '../utils/dateUtils';

// The warehouse that exposed it. Anything behind UTC reproduces the bug.
const WAREHOUSE_TZ = 'America/New_York';

afterEach(() => setAppTimezone(null));

describe('a calendar day survives the round trip', () => {
  // Mirrors ReceiptContext.calendarIso — what the form sends.
  const calendarIso = (value) => {
    const key = toCalendarKey(value);
    return key ? `${key}T00:00:00.000Z` : null;
  };

  it('12/02 typed is 12/02 stored', () => {
    expect(calendarIso('2026-12-02')).toBe('2026-12-02T00:00:00.000Z');
  });

  it('12/02 stored is 12/02 read back', () => {
    setAppTimezone(WAREHOUSE_TZ);
    expect(toCalendarKey('2026-12-02T00:00:00.000Z')).toBe('2026-12-02');
  });

  it('and 12/02 on screen', () => {
    setAppTimezone(WAREHOUSE_TZ);
    expect(formatDateKey(toCalendarKey('2026-12-02T00:00:00.000Z'))).toBe('12/2/2026');
  });

  // The regression, stated as the thing that was wrong.
  it('the timezone-aware reader loses the day — this is the bug', () => {
    setAppTimezone(WAREHOUSE_TZ);
    expect(toDateKey('2026-12-02T00:00:00.000Z')).toBe('2026-12-01');
    expect(toCalendarKey('2026-12-02T00:00:00.000Z')).toBe('2026-12-02');
  });

  // Fixing the mapper alone is not enough: a bare key put back through the
  // timezone-aware formatter shifts again, which is why the render sites moved
  // to formatDateKey too.
  it('formatDate shifts a bare key as well; formatDateKey does not', () => {
    setAppTimezone(WAREHOUSE_TZ);
    expect(formatDate('2026-12-02')).toBe('12/1/2026');
    expect(formatDateKey('2026-12-02')).toBe('12/2/2026');
  });

  it('holds for a timezone ahead of UTC too', () => {
    setAppTimezone('Asia/Kolkata');
    expect(toCalendarKey('2026-12-02T00:00:00.000Z')).toBe('2026-12-02');
    expect(formatDateKey('2026-12-02T00:00:00.000Z')).toBe('12/2/2026');
  });

  it('survives being mapped and submitted repeatedly', () => {
    setAppTimezone(WAREHOUSE_TZ);
    let wire = calendarIso('2026-12-02');
    for (let i = 0; i < 5; i += 1) {
      wire = calendarIso(toCalendarKey(wire));   // read, edit, resubmit
    }
    expect(toCalendarKey(wire)).toBe('2026-12-02');
  });
});

describe('formatDateKey accepts what the API actually sends', () => {
  // Some screens read `expiration_date` straight off the API rather than through
  // the context mapper, so the formatter has to cope with a full instant.
  it.each([
    ['2026-12-02', '12/2/2026'],
    ['2026-12-02T00:00:00Z', '12/2/2026'],
    ['2026-12-02T00:00:00.000Z', '12/2/2026'],
  ])('%s renders %s', (input, expected) => {
    setAppTimezone(WAREHOUSE_TZ);
    expect(formatDateKey(input)).toBe(expected);
  });

  it('is blank for nothing, rather than todays date', () => {
    expect(formatDateKey(null)).toBe('—');
    expect(formatDateKey('')).toBe('—');
  });
});
