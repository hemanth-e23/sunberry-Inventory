// What the gun last saw from the server, kept on the device (browser test U1).
//
// Reloading the truck screen while the wifi was down showed only "Request
// failed with status code 500" — no truck, no lines, no way to keep scanning,
// even though every queued scan was safe in localStorage (P08). The screen now
// falls back to the last copy it saw, clearly marked as such. It is a DISPLAY
// cache only: nothing is ever booked from it, the server stays the truth, and
// the next good answer replaces it.

const PREFIX = 'sunberry-gun-cache-v1:';
// A copy older than this is not shown — a truck from yesterday's shift is not
// "what the gun last saw" in any useful sense.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const storage = () => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
};

export const saveCached = (key, data, now = Date.now()) => {
  const ls = storage();
  if (!ls || data == null) return;
  try {
    ls.setItem(PREFIX + key, JSON.stringify({ savedAt: now, data }));
  } catch {
    // Quota or disabled storage: the cache is a convenience, never required.
  }
};

/** `{ data, savedAt }` or null when there is no usable copy. */
export const readCached = (key, now = Date.now()) => {
  const ls = storage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.savedAt !== 'number') return null;
    if (now - parsed.savedAt > MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const truckCacheKey = (orderId) => `truck:${orderId}`;
export const TRUCK_LIST_CACHE_KEY = 'trucks';
export const RACKS_CACHE_KEY = 'racks';
export const RACK_FILL_CACHE_KEY = 'rack-fill';
export const RACK_FILL_UNITS_CACHE_KEY = 'rack-fill-units';
export const sessionCacheKey = (receiptId) => `session:${receiptId}`;
// Staging pull (browser test PART 3, B9): the open-pull list, one request as
// the gun last saw it, and that request's Recent pulls (which used to vanish
// on every reload).
export const PULL_LIST_CACHE_KEY = 'pulls';
export const pullRequestCacheKey = (requestId) => `pull:${requestId}`;
export const pullHistoryCacheKey = (requestId) => `pull-history:${requestId}`;

/**
 * A scanned rack code → a rack from the list saved on this gun, the way the
 * server resolves it (N6): BARCODE first (unique), then the exact rack NAME —
 * but only when exactly one active rack has that name. The saved list is the
 * caller's own warehouse, the same scope the server's name match uses.
 *
 * Returns `{ row, ambiguous }`: `row` is the hit or null; `ambiguous` lists the
 * racks sharing that name when there is more than one (never a silent pick —
 * row names are not unique, and a wrong rack cannot be untangled later).
 */
export const findCachedRack = (rows, code) => {
  const upper = String(code || '').trim().toUpperCase();
  const list = Array.isArray(rows) ? rows.filter((r) => r && r.is_active !== false) : [];
  if (!upper) return { row: null, ambiguous: [] };
  const byBarcode = list.find((r) => (r.barcode || '').toUpperCase() === upper);
  if (byBarcode) return { row: byBarcode, ambiguous: [] };
  const byName = list.filter((r) => (r.name || '').trim().toUpperCase() === upper);
  if (byName.length === 1) return { row: byName[0], ambiguous: [] };
  return { row: null, ambiguous: byName.length > 1 ? byName : [] };
};
