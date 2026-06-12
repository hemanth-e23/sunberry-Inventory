// Lot number helpers — single source of truth for the receipt form,
// the supervisor "active production" page, and the palletizer kiosk.
//
// Format: MP{DDD}{YY}L{N}
//   DDD = day-of-year, zero-padded to 3 digits
//   YY  = last two digits of the year
//   N   = production line number (digits extracted from line.name)
//
// Mirror of backend `app/utils/lot_number.py`.

export const getDayOfYear = (date) => {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  // Compute entirely in UTC. Mixing a UTC-parsed date (e.g. "2026-01-01") with a
  // local-midnight year start shifted the day-of-year by one west of UTC, so
  // form-generated lot numbers disagreed with the backend's.
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const diff = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start;
  const oneDay = 1000 * 60 * 60 * 24;
  return Math.floor(diff / oneDay);
};

export const extractLineNumber = (lineNameOrNumber) => {
  if (lineNameOrNumber == null) return null;
  const s = String(lineNameOrNumber);
  const match = s.match(/\d+/);
  return match ? match[0] : null;
};

export const generateLotNumberFromLine = (productionDate, lineNameOrNumber) => {
  if (!productionDate || lineNameOrNumber == null) return "";
  const dayOfYear = getDayOfYear(productionDate);
  if (!dayOfYear) return "";
  const lineNum = extractLineNumber(lineNameOrNumber);
  if (!lineNum) return "";
  const date = new Date(productionDate);
  const year = date.getFullYear().toString().slice(-2);
  return `MP${String(dayOfYear).padStart(3, "0")}${year}L${lineNum}`;
};
