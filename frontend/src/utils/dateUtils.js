// Module-level timezone — set by AuthContext after login from warehouse.timezone.
// null = fall back to browser's local timezone.
let APP_TIMEZONE = null;

export const setAppTimezone = (tz) => {
  APP_TIMEZONE = tz || null;
};

export const getAppTimezone = () => APP_TIMEZONE;

const ensureUtc = (value) => {
  if (!value) return value;
  const str = String(value);
  // If datetime string has 'T' but no timezone indicator, treat as UTC
  if (str.includes('T') && !str.endsWith('Z') && !/[+-]\d{2}:\d{2}$/.test(str)) {
    return str + 'Z';
  }
  return str;
};

export const formatDateTime = (value) => {
  if (!value) return "—";
  const date = new Date(ensureUtc(value));
  if (Number.isNaN(date.getTime())) return value;
  const opts = APP_TIMEZONE ? { timeZone: APP_TIMEZONE } : undefined;
  return date.toLocaleString('en-US', opts);
};

export const formatTime = (value) => {
  if (!value) return "—";
  const date = new Date(ensureUtc(value));
  if (Number.isNaN(date.getTime())) return value;
  const opts = APP_TIMEZONE
    ? { timeZone: APP_TIMEZONE, hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' };
  return date.toLocaleTimeString('en-US', opts);
};

export const formatDate = (value) => {
  if (!value) return "—";
  const date = new Date(ensureUtc(value));
  if (Number.isNaN(date.getTime())) return value;
  const opts = APP_TIMEZONE ? { timeZone: APP_TIMEZONE } : undefined;
  return date.toLocaleDateString('en-US', opts);
};

/**
 * Display a `YYYY-MM-DD` CALENDAR KEY. Lexical — no timezone maths.
 *
 * `formatDate` is for INSTANTS and is correct for them, but it is wrong for a
 * day key: `new Date('2026-08-21')` parses as midnight UTC, and rendering that
 * in an America/New_York warehouse gives 8/20/2026. The day navigator showed
 * "Today · 8/20/2026" while its own date input said 08/21 — the label was a day
 * behind the thing it described.
 *
 * Anything that is a DAY rather than a moment — a scheduled arrival, a best-by,
 * a day-view key — belongs here. Same rule the label payload has carried since
 * the per-drum work: a best-by printed one day early is a food-safety defect.
 */
export const formatDateKey = (key) => {
  if (!key) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key));
  if (!m) return formatDate(key);
  const [, y, mo, d] = m;
  return `${Number(mo)}/${Number(d)}/${y}`;
};

export const formatTimeAgo = (dateValue) => {
  if (!dateValue) return 'Unknown';
  const date = new Date(ensureUtc(dateValue));
  if (Number.isNaN(date.getTime())) return 'Invalid date';

  const days = getDaysAgo(dateValue);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
};

export const getDaysAgo = (dateValue) => {
  if (!dateValue) return 0;
  const dateKey = toDateKey(dateValue);
  if (!dateKey) return 0;
  const todayKey = getTodayDateKey();
  // Compare calendar dates in warehouse timezone
  const dateMs = new Date(dateKey + 'T00:00:00').getTime();
  const todayMs = new Date(todayKey + 'T00:00:00').getTime();
  const diffDays = Math.round((todayMs - dateMs) / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
};

// Returns YYYY-MM-DD in the warehouse timezone (or browser local if not set)
// en-CA locale natively produces YYYY-MM-DD format
export const toDateKey = (value) => {
  if (!value) return "";
  const date = new Date(ensureUtc(value));
  if (Number.isNaN(date.getTime())) return "";
  const opts = APP_TIMEZONE ? { timeZone: APP_TIMEZONE } : undefined;
  return date.toLocaleDateString('en-CA', opts);
};

export const getTodayDateKey = () => {
  const now = new Date();
  const opts = APP_TIMEZONE ? { timeZone: APP_TIMEZONE } : undefined;
  return now.toLocaleDateString('en-CA', opts);
};

export const isDateInPast = (dateValue) => {
  if (!dateValue) return false;
  // Compare calendar-day keys in the warehouse timezone. The old version mixed
  // a UTC-parsed date with local midnight, falsely rejecting same-day dates
  // (e.g. a same-day expiration entered from a US-timezone browser).
  const key = toDateKey(dateValue);
  if (!key) return false;
  return key < getTodayDateKey();
};

export const isDateValid = (dateValue) => {
  if (!dateValue) return false;
  const date = new Date(ensureUtc(dateValue));
  return !Number.isNaN(date.getTime());
};

/**
 * Escape a value for safe HTML insertion in print windows.
 * Use on ALL server-supplied strings interpolated into document.write() HTML.
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
