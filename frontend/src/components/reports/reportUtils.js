import apiClient from "../../api/client";
import { toDateKey as tzToDateKey, getTodayDateKey } from "../../utils/dateUtils";

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
