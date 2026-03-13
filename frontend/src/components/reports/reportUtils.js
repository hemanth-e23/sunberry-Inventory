import apiClient from "../../api/client";

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

export const toDateKey = (value) => {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
};

export const formatNumber = (value, fractionDigits = 0) =>
  Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });

export const sanitizeFileName = (name) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "report";

export const today = () => toDateKey(new Date());

export const monthStart = () => {
  const d = new Date();
  return toDateKey(new Date(d.getFullYear(), d.getMonth(), 1));
};

export const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toDateKey(d);
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
