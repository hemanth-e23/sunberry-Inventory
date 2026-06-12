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
