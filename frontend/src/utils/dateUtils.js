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
  const date = new Date(ensureUtc(dateValue));
  if (Number.isNaN(date.getTime())) return 0;
  const now = new Date();
  const diffTime = Math.abs(now - date);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays;
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
  const date = new Date(ensureUtc(dateValue));
  if (Number.isNaN(date.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return date < today;
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
