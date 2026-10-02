import apiClient from "../../api/client";
import { RECEIPT_STATUS } from "../../constants";
import { formatDate, toDateKey as tzToDateKey, getTodayDateKey } from "../../utils/dateUtils";

export const apiFetch = async (path, params = {}) => {
  const cleanParams = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  );
  const response = await apiClient.get(path, { params: cleanParams });
  return response.data;
};

export const apiError = (e) => {
  if (e?.response?.status === 401) return "Session expired. Please log out and log back in.";
  if (e?.response?.status === 403) return "You don't have permission to view this report.";
  if (e?.response?.data?.detail) return e.response.data.detail;
  return e.message || "An unexpected error occurred.";
};

// Delegates to the warehouse-timezone helper — the old local version used UTC
// (toISOString), so evening users west of UTC got tomorrow's date in the
// default report ranges.
export const toDateKey = (value) => (value ? tzToDateKey(value) : null);

export const formatNumber = (value, fractionDigits = 0) =>
  Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });

// Shipped quantities are in each line's own unit — lbs for drummed material,
// cases for finished goods. A column called "Total Cases" over lbs (N8) was
// wrong; these say the unit.
export const addByUnit = (byUnit, unit, qty) => {
  const key = String(unit || "cases").trim() || "cases";
  byUnit[key] = (byUnit[key] || 0) + Number(qty || 0);
  return byUnit;
};

/** "1,422 lbs" or "1,422 lbs + 40 cases". */
export const formatByUnit = (byUnit = {}, fractionDigits = 0) => {
  const parts = Object.entries(byUnit)
    .filter(([, qty]) => Math.abs(qty) > 0)
    .map(([unit, qty]) => `${formatNumber(qty, fractionDigits)} ${unit}`);
  return parts.length ? parts.join(" + ") : "0";
};

/** The one unit every row shares, or null when they differ (or no rows). */
export const singleUnit = (rows = []) => {
  const units = new Set(rows.map((r) => String(r.unit || "cases").trim() || "cases"));
  return units.size === 1 ? [...units][0] : null;
};

/** "Total Lbs", "Total Cases", or "Total" when units are mixed. */
export const totalLabel = (unit) => (
  unit ? `Total ${unit.charAt(0).toUpperCase()}${unit.slice(1)}` : "Total"
);

export const sanitizeFileName = (name) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "report";

export const today = () => getTodayDateKey();

export const monthStart = () => `${getTodayDateKey().slice(0, 8)}01`;

export const daysAgo = (n) => {
  // Anchor at warehouse-tz noon today, then step back n days — stays on the
  // right calendar day in every timezone.
  const d = new Date(`${getTodayDateKey()}T12:00:00`);
  d.setDate(d.getDate() - n);
  return tzToDateKey(d);
};

export const GROUP_ORDER = [
  { groupId: "finished",   label: "Finished Goods",      color: "#f97316" },
  { groupId: "raw",        label: "Raw Materials",        color: "#6366f1" },
  { groupId: "packaging",  label: "Packaging Materials",  color: "#22c55e" },
];

export const TABS = [
  { id: "snapshot", label: "Inventory Snapshot" },
  { id: "ledger", label: "Activity Ledger" },
  { id: "shipments", label: "Shipments" },
  { id: "finished-goods", label: "Finished Goods" },
  { id: "expiry", label: "Expiry Alerts" },
  { id: "holds", label: "Quality & Holds" },
  { id: "adjustments", label: "Adjustments" },
  { id: "vendors", label: "Vendor Receipts" },
  { id: "lot-trace", label: "Lot Traceability" },
  { id: "cycle-counts", label: "Cycle Counts" },
];

// ─── Row formatters shared by the audit reports (browser test PART 4) ─────

/** A before/after stock figure, or "—" when there is none to show. A
 *  negative figure is never a stock level — old staging rows recorded one
 *  delivery's paper ("0 → −202") — so it reads as unknown, not as a number. */
export const stockFigure = (value) => {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "—";
  return formatNumber(n);
};

/** "+1 drums", "−1 bags", "0 cases". */
export const signedQty = (value, unit) => {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${formatNumber(Math.abs(n))}${unit ? ` ${unit}` : ""}`;
};

/** A count's system / counted cell: the rack wording for a raw-material
 *  count ("6 drums + 1 open (210 lbs)"), else the plain number. */
export const countCell = (row, which) => {
  const detail = which === "system" ? row.system_detail : row.actual_detail;
  if (detail) return detail;
  const value = which === "system" ? row.system_count : row.actual_count;
  return value !== null && value !== undefined ? formatNumber(value) : "—";
};

/** One summary card per unit — 3 drums and 2 cases are not 5 of anything. */
export const varianceCards = (totals = {}) => {
  const entries = Object.entries(totals.variance_by_unit || {});
  if (!entries.length) {
    const v = Number(totals.total_variance || 0);
    return [{ label: "Total Variance", value: formatNumber(v), highlight: Math.abs(v) > 0 }];
  }
  return entries.map(([unit, v]) => ({
    label: `Variance (${unit})`,
    value: signedQty(v, unit),
    highlight: Math.abs(v) > 0,
  }));
};

/** Cycle Counts report columns: finished-goods cycle counts and raw-material
 *  rack counts side by side (browser test PART 4, P5). */
export const cycleCountColumns = [
  { label: "Count Date", value: (r) => formatDate(r.count_date) },
  { label: "Kind", value: (r) => r.count_kind || "Cycle count" },
  { label: "Product", value: (r) => r.product_name },
  { label: "Lot", value: (r) => r.lot_number || "—" },
  { label: "Location", value: (r) => r.location || "—" },
  { label: "System Count", value: (r) => countCell(r, "system") },
  { label: "Physical Count", value: (r) => countCell(r, "actual") },
  { label: "Variance", value: (r) => (r.variance != null ? signedQty(r.variance, r.unit) : "—") },
  { label: "Variance %", value: (r) => (r.variance_pct != null ? `${r.variance_pct}%` : "—") },
  { label: "Counted By", value: (r) => r.counted_by || "—" },
  { label: "Notes", value: (r) => r.notes || "—" },
];

/** Is this receipt row stock on hand? Only an APPROVED delivery is: a
 *  rejected one keeps its paperwork quantity (D-0801's rejected 150 lb line
 *  made the snapshot read Citric 2,600 for 2,450 on the racks, PART 4 P4),
 *  and a recorded / reviewed / sent-back one has not entered stock yet. */
export const isOnHandReceiptRow = (row) => (
  row?.status === RECEIPT_STATUS.APPROVED && Number(row?.quantity || 0) > 0
);

/** What a delivery brought, e.g. "1,422 lbs (3 drums)". */
export const receivedCell = (row) => {
  const qty = row.quantity_received ?? row.quantity;
  const base = `${formatNumber(qty)} ${row.unit || ""}`.trim();
  return row.containers && row.container_unit
    ? `${base} (${formatNumber(row.containers)} ${row.container_unit})`
    : base;
};
