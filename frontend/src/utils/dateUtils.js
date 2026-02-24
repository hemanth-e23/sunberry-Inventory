// All times displayed in Detroit (Eastern) timezone
const TIMEZONE = 'America/Detroit';

const ensureUtc = (value) => {
  if (!value) return value;
  const str = String(value);
  if (str.includes('T') && !str.endsWith('Z') && !/[+-]\d{2}:\d{2}$/.test(str)) {
    return str + 'Z';
  }
  return str;
};

export const formatDateTime = (value) => {
  if (!value) return "—";
  const date = new Date(ensureUtc(value)); 
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-US', { timeZone: TIMEZONE });
};

export const formatDate = (value) => {
  if (!value) return "—";
  const date = new Date(ensureUtc(value));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { timeZone: TIMEZONE });
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

export const toDateKey = (value) => {
  if (!value) return "";
  const date = new Date(ensureUtc(value));
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
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

export const getTodayDateKey = () => {
  return new Date().toISOString().slice(0, 10);
};
