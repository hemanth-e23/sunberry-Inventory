import React, { useMemo, useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import apiClient from "../api/client";
import { formatDate, formatDateTime } from "../utils/dateUtils";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from "recharts";
import jsPDF from "jspdf";
import "jspdf-autotable";
import ExcelJS from "exceljs";
import { useAppData } from "../context/AppDataContext";
import { useAuth } from "../context/AuthContext";
import { getDashboardPath } from "../App";
import SearchableSelect from "./SearchableSelect";
import "./Shared.css";
import "./ReportsPage.css";

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────────────────────

const apiFetch = async (path, params = {}) => {
  const cleanParams = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  );
  const response = await apiClient.get(path, { params: cleanParams });
  return response.data;
};

const apiError = (e) => {
  if (e?.response?.status === 401) return "Session expired. Please log out and log back in.";
  if (e?.response?.status === 403) return "You don't have permission to view this report.";
  if (e?.response?.data?.detail) return e.response.data.detail;
  return e.message || "An unexpected error occurred.";
};

const toDateKey = (value) => {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
};

const formatNumber = (value, fractionDigits = 0) =>
  Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });


const sanitizeFileName = (name) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "report";

const today = () => toDateKey(new Date());
const monthStart = () => {
  const d = new Date();
  return toDateKey(new Date(d.getFullYear(), d.getMonth(), 1));
};
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toDateKey(d);
};

// ─────────────────────────────────────────────────────────────────────────────
// Export buttons
// ─────────────────────────────────────────────────────────────────────────────

const ExportButtons = ({ columns, rows, fileBaseName }) => {
  const headers = columns.map((c) => c.label);
  const body = rows.map((row) =>
    columns.map((c) => {
      const v = c.value(row);
      return v == null ? "" : String(v);
    }),
  );
  const fileName = sanitizeFileName(fileBaseName);
  const disabled = rows.length === 0;

  const handleCSV = () => {
    if (disabled) return;
    const lines = [headers.join(",")].concat(
      body.map((r) => r.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")),
    );
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${fileName}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleExcel = async () => {
    if (disabled) return;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Report");
    ws.addRow(headers);
    body.forEach((row) => ws.addRow(row));
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${fileName}.xlsx`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handlePDF = () => {
    if (disabled) return;
    const orientation = headers.length > 6 ? "landscape" : "portrait";
    const doc = new jsPDF(orientation, "pt", "a4");
    doc.setFontSize(14);
    doc.text(fileBaseName, 40, 40);
    doc.autoTable({
      startY: 60,
      head: [headers],
      body,
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [245, 124, 0] },
    });
    doc.save(`${fileName}.pdf`);
  };

  return (
    <div className="report-export-buttons">
      <button type="button" onClick={handleCSV} disabled={disabled}>Export CSV</button>
      <button type="button" onClick={handleExcel} disabled={disabled}>Export Excel</button>
      <button type="button" onClick={handlePDF} disabled={disabled}>Export PDF</button>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Reusable table
// ─────────────────────────────────────────────────────────────────────────────

const ReportTable = ({ columns, rows, emptyMessage = "No data for the selected filters." }) => (
  <div className="table-wrapper">
    <table className="report-table">
      <thead>
        <tr>{columns.map((c) => <th key={c.label} className={c.className}>{c.label}</th>)}</tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr><td colSpan={columns.length} className="empty-state">{emptyMessage}</td></tr>
        ) : (
          rows.map((row, i) => (
            <tr key={row.id || i}>
              {columns.map((c) => <td key={c.label} className={c.className}>{(c.renderValue || c.value)(row)}</td>)}
            </tr>
          ))
        )}
      </tbody>
    </table>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// Summary card grid
// ─────────────────────────────────────────────────────────────────────────────

const SummaryCards = ({ cards }) => (
  <div className="reports-summary-grid">
    {cards.map((card) => (
      <article key={card.label} className={`summary-card${card.highlight ? " summary-card--highlight" : ""}`}>
        <h4>{card.label}</h4>
        <span className="summary-value">{card.value}</span>
        {card.sub && <span className="summary-sub">{card.sub}</span>}
      </article>
    ))}
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// Loading / error states
// ─────────────────────────────────────────────────────────────────────────────

const LoadingBox = () => (
  <div className="report-loading">
    <span className="report-spinner" />
    Loading report data…
  </div>
);

const ErrorBox = ({ message }) => (
  <div className="report-error">⚠ {message}</div>
);

// ─────────────────────────────────────────────────────────────────────────────
// Run Report button
// ─────────────────────────────────────────────────────────────────────────────

const RunButton = ({ onClick, loading }) => (
  <button className="run-report-btn" onClick={onClick} disabled={loading} type="button">
    {loading ? "Loading…" : "Run Report"}
  </button>
);

// ─────────────────────────────────────────────────────────────────────────────
// Quick range buttons
// ─────────────────────────────────────────────────────────────────────────────

const QuickRange = ({ onRange }) => (
  <div className="quick-range-buttons">
    <button type="button" onClick={() => onRange(daysAgo(6), today())}>Last 7 Days</button>
    <button type="button" onClick={() => onRange(daysAgo(29), today())}>Last 30 Days</button>
    <button type="button" onClick={() => onRange(monthStart(), today())}>Month to Date</button>
    <button type="button" onClick={() => onRange("", "")}>Clear</button>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// TABS DEFINITION
// ─────────────────────────────────────────────────────────────────────────────

const TABS = [
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

const GROUP_ORDER = [
  { groupId: "finished",   label: "Finished Goods",      color: "#f97316" },
  { groupId: "raw",        label: "Raw Materials",        color: "#6366f1" },
  { groupId: "packaging",  label: "Packaging Materials",  color: "#22c55e" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Main ReportsPage
// ─────────────────────────────────────────────────────────────────────────────

const ReportsPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const {
    receiptReportingRows,
    finishedGoodsCapacitySummary,
    products,
    productCategories,
    categories,
    vendors,
  } = useAppData();

  const [activeTab, setActiveTab] = useState("snapshot");

  // ── Snapshot state ──────────────────────────────────────────────────────────
  const [snapMode, setSnapMode] = useState("current"); // "current" | "point-in-time"
  const [snapDate, setSnapDate] = useState(today());
  const [snapCatFilter, setSnapCatFilter] = useState("");
  const [snapProductFilter, setSnapProductFilter] = useState("");
  const [snapHoldFilter, setSnapHoldFilter] = useState("all");
  const [snapData, setSnapData] = useState(null);
  const [snapLoading, setSnapLoading] = useState(false);
  const [snapError, setSnapError] = useState(null);

  // ── Ledger state ────────────────────────────────────────────────────────────
  const [ledgerStart, setLedgerStart] = useState(monthStart());
  const [ledgerEnd, setLedgerEnd] = useState(today());
  const [ledgerProduct, setLedgerProduct] = useState("");
  const [ledgerCatType, setLedgerCatType] = useState("");
  const [ledgerData, setLedgerData] = useState(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState(null);

  // ── Shipments state ─────────────────────────────────────────────────────────
  const [shipStart, setShipStart] = useState(monthStart());
  const [shipEnd, setShipEnd] = useState(today());
  const [shipProduct, setShipProduct] = useState("");
  const [shipData, setShipData] = useState(null);
  const [shipLoading, setShipLoading] = useState(false);
  const [shipError, setShipError] = useState(null);

  // ── Finished goods state ────────────────────────────────────────────────────
  const [fgStart, setFgStart] = useState(monthStart());
  const [fgEnd, setFgEnd] = useState(today());
  const [fgProduct, setFgProduct] = useState("");
  const [fgData, setFgData] = useState(null);
  const [fgLoading, setFgLoading] = useState(false);
  const [fgError, setFgError] = useState(null);

  // ── Expiry state ─────────────────────────────────────────────────────────────
  const [expiryDays, setExpiryDays] = useState("90");
  const [expiryCatType, setExpiryCatType] = useState("");
  const [expiryIncExp, setExpiryIncExp] = useState(true);
  const [expiryData, setExpiryData] = useState(null);
  const [expiryLoading, setExpiryLoading] = useState(false);
  const [expiryError, setExpiryError] = useState(null);

  // ── Holds state ──────────────────────────────────────────────────────────────
  const [holdsStart, setHoldsStart] = useState(monthStart());
  const [holdsEnd, setHoldsEnd] = useState(today());
  const [holdsAction, setHoldsAction] = useState("all");
  const [holdsData, setHoldsData] = useState(null);
  const [holdsLoading, setHoldsLoading] = useState(false);
  const [holdsError, setHoldsError] = useState(null);

  // ── Adjustments state ───────────────────────────────────────────────────────
  const [adjStart, setAdjStart] = useState(monthStart());
  const [adjEnd, setAdjEnd] = useState(today());
  const [adjType, setAdjType] = useState("all");
  const [adjProduct, setAdjProduct] = useState("");
  const [adjData, setAdjData] = useState(null);
  const [adjLoading, setAdjLoading] = useState(false);
  const [adjError, setAdjError] = useState(null);

  // ── Vendor state ────────────────────────────────────────────────────────────
  const [vendorStart, setVendorStart] = useState(monthStart());
  const [vendorEnd, setVendorEnd] = useState(today());
  const [vendorFilter, setVendorFilter] = useState("");
  const [vendorData, setVendorData] = useState(null);
  const [vendorLoading, setVendorLoading] = useState(false);
  const [vendorError, setVendorError] = useState(null);

  // ── Lot trace state ──────────────────────────────────────────────────────────
  const [lotNumber, setLotNumber] = useState("");
  const [lotData, setLotData] = useState(null);
  const [lotLoading, setLotLoading] = useState(false);
  const [lotError, setLotError] = useState(null);

  // ── Cycle counts state ───────────────────────────────────────────────────────
  const [ccStart, setCcStart] = useState(monthStart());
  const [ccEnd, setCcEnd] = useState(today());
  const [ccData, setCcData] = useState(null);
  const [ccLoading, setCcLoading] = useState(false);
  const [ccError, setCcError] = useState(null);

  // ─────────────────────────────────────────────────────────────────────────────
  // Derived options
  // ─────────────────────────────────────────────────────────────────────────────

  const productOptions = useMemo(() => [
    { value: "", label: "All Products" },
    ...products.filter((p) => p.status === "active").map((p) => ({
      value: p.id,
      label: `${p.name}${p.fcc ? ` (${p.fcc})` : p.sid ? ` (${p.sid})` : ""}`,
    })),
  ], [products]);

  const categoryOptions = useMemo(() => [
    { value: "", label: "All Categories" },
    ...productCategories.map((c) => ({ value: c.id, label: c.name })),
  ], [productCategories]);

  const vendorOptions = useMemo(() => [
    { value: "", label: "All Vendors" },
    { value: "none", label: "No Vendor" },
    ...(vendors || []).filter((v) => v.active !== false).map((v) => ({
      value: v.id,
      label: v.name,
    })),
  ], [vendors]);

  const catTypeOptions = [
    { value: "", label: "All Categories" },
    { value: "raw", label: "Raw Materials" },
    { value: "packaging", label: "Packaging" },
    { value: "finished", label: "Finished Goods" },
  ];

  const adjTypeOptions = [
    { value: "all", label: "All Types" },
    { value: "production-consumption", label: "Production Consumption" },
    { value: "damage-reduction", label: "Damage Reduction" },
    { value: "donation", label: "Donation" },
    { value: "trash-disposal", label: "Trash Disposal" },
    { value: "quality-rejection", label: "Quality Rejection" },
    { value: "stock-correction", label: "Stock Correction" },
  ];

  const holdActionOptions = [
    { value: "all", label: "Hold & Release" },
    { value: "hold", label: "Holds Only" },
    { value: "release", label: "Releases Only" },
  ];

  // ─────────────────────────────────────────────────────────────────────────────
  // Current snapshot (from AppDataContext)
  // ─────────────────────────────────────────────────────────────────────────────

  // Build a lookup: categoryId → type (finished / raw / packaging)
  const categoryParentMap = useMemo(() => {
    const map = {};
    (categories || []).forEach((c) => { if (c.id && c.type) map[c.id] = c.type; });
    return map;
  }, [categories]);

  const currentSnapshotRows = useMemo(() => {
    return receiptReportingRows.filter((row) => {
      if (snapProductFilter && row.productId !== snapProductFilter) return false;
      if (snapCatFilter && row.categoryId !== snapCatFilter) return false;
      if (snapHoldFilter === "on" && !row.hold) return false;
      if (snapHoldFilter === "off" && row.hold) return false;
      return true;
    });
  }, [receiptReportingRows, snapProductFilter, snapCatFilter, snapHoldFilter]);

  // Aggregate per product, keep groupId for later sectioning
  const currentSnapshotByProduct = useMemo(() => {
    const map = new Map();
    currentSnapshotRows.forEach((row) => {
      const key = row.productId;
      if (!map.has(key)) {
        const groupId = categoryParentMap[row.categoryId] || "other";
        map.set(key, {
          productId: row.productId,
          productName: row.productName,
          productCode: row.productCode,
          categoryId: row.categoryId,
          categoryName: row.categoryName,
          groupId,
          lots: 0,
          lotNumbers: new Set(),
          casesOnHand: 0,
          palletsOnHand: 0,
          floorPallets: 0,
          holdCases: 0,
          unit: row.quantityUnits || "cases",
        });
      }
      const entry = map.get(key);
      const qty = Number(row.quantity || 0);
      const cpp = Number(row.casesPerPallet || 0);
      entry.lots += 1;
      if (row.lotNo) entry.lotNumbers.add(row.lotNo);
      entry.casesOnHand += qty;
      // Pallets only meaningful for finished goods (cases per pallet defined)
      entry.palletsOnHand += cpp > 0 ? qty / cpp : 0;
      entry.floorPallets += Number(row.floorPallets || 0);
      if (row.hold) entry.holdCases += qty;
      // Prefer a non-"cases" unit if any lot has one
      if (row.quantityUnits && row.quantityUnits !== "cases") {
        entry.unit = row.quantityUnits;
      }
    });
    return Array.from(map.values())
      .map((e) => ({ ...e, lotNumbers: Array.from(e.lotNumbers).sort() }))
      .sort((a, b) => b.casesOnHand - a.casesOnHand);
  }, [currentSnapshotRows, categoryParentMap]);

  // Group products by their parent group
  const snapshotByGroup = useMemo(() => {
    const groups = {};
    GROUP_ORDER.forEach((g) => { groups[g.groupId] = []; });
    groups["other"] = [];
    currentSnapshotByProduct.forEach((row) => {
      const bucket = groups[row.groupId] ? row.groupId : "other";
      groups[bucket].push(row);
    });
    return groups;
  }, [currentSnapshotByProduct]);

  const groupTotals = useMemo(() => {
    const totals = {};
    Object.entries(snapshotByGroup).forEach(([gid, rows]) => {
      totals[gid] = rows.reduce(
        (acc, r) => ({ cases: acc.cases + r.casesOnHand, pallets: acc.pallets + r.palletsOnHand, floor: acc.floor + r.floorPallets, hold: acc.hold + r.holdCases }),
        { cases: 0, pallets: 0, floor: 0, hold: 0 },
      );
    });
    return totals;
  }, [snapshotByGroup]);

  const _categorySummary = useMemo(() => {
    const agg = {};
    currentSnapshotRows.forEach((row) => {
      if (!agg[row.categoryName]) agg[row.categoryName] = { category: row.categoryName, cases: 0, lots: 0 };
      agg[row.categoryName].cases += Number(row.quantity || 0);
      agg[row.categoryName].lots += 1;
    });
    return Object.values(agg).sort((a, b) => b.cases - a.cases);
  }, [currentSnapshotRows]);

  // ─────────────────────────────────────────────────────────────────────────────
  // API fetchers
  // ─────────────────────────────────────────────────────────────────────────────

  const fetchSnapshot = useCallback(async () => {
    if (!snapDate) return;
    setSnapLoading(true);
    setSnapError(null);
    try {
      const data = await apiFetch("/reports/point-in-time", {
        as_of_date: snapDate,
        product_id: snapProductFilter || undefined,
        category_id: snapCatFilter || undefined,
      });
      setSnapData(data);
    } catch (e) {
      setSnapError(apiError(e));
    } finally {
      setSnapLoading(false);
    }
  }, [snapDate, snapProductFilter, snapCatFilter]);

  const fetchLedger = useCallback(async () => {
    if (!ledgerStart || !ledgerEnd) return;
    setLedgerLoading(true);
    setLedgerError(null);
    try {
      const data = await apiFetch("/reports/activity-ledger", {
        start_date: ledgerStart,
        end_date: ledgerEnd,
        product_id: ledgerProduct || undefined,
        category_type: ledgerCatType || undefined,
      });
      setLedgerData(data);
    } catch (e) {
      setLedgerError(apiError(e));
    } finally {
      setLedgerLoading(false);
    }
  }, [ledgerStart, ledgerEnd, ledgerProduct, ledgerCatType]);

  const fetchShipments = useCallback(async () => {
    setShipLoading(true);
    setShipError(null);
    try {
      const data = await apiFetch("/reports/shipments", {
        start_date: shipStart || undefined,
        end_date: shipEnd || undefined,
        product_id: shipProduct || undefined,
      });
      setShipData(data);
    } catch (e) {
      setShipError(apiError(e));
    } finally {
      setShipLoading(false);
    }
  }, [shipStart, shipEnd, shipProduct]);

  const fetchFinishedGoods = useCallback(async () => {
    setFgLoading(true);
    setFgError(null);
    try {
      const data = await apiFetch("/reports/finished-goods", {
        start_date: fgStart || undefined,
        end_date: fgEnd || undefined,
        product_id: fgProduct || undefined,
      });
      setFgData(data);
    } catch (e) {
      setFgError(apiError(e));
    } finally {
      setFgLoading(false);
    }
  }, [fgStart, fgEnd, fgProduct]);

  const fetchExpiry = useCallback(async () => {
    setExpiryLoading(true);
    setExpiryError(null);
    try {
      const data = await apiFetch("/reports/expiry-alerts", {
        days_ahead: expiryDays !== "all" ? expiryDays : undefined,
        include_expired: expiryIncExp,
        category_type: expiryCatType || undefined,
      });
      setExpiryData(data);
    } catch (e) {
      setExpiryError(apiError(e));
    } finally {
      setExpiryLoading(false);
    }
  }, [expiryDays, expiryIncExp, expiryCatType]);

  const fetchHolds = useCallback(async () => {
    setHoldsLoading(true);
    setHoldsError(null);
    try {
      const data = await apiFetch("/reports/holds", {
        start_date: holdsStart || undefined,
        end_date: holdsEnd || undefined,
        action: holdsAction !== "all" ? holdsAction : undefined,
      });
      setHoldsData(data);
    } catch (e) {
      setHoldsError(apiError(e));
    } finally {
      setHoldsLoading(false);
    }
  }, [holdsStart, holdsEnd, holdsAction]);

  const fetchAdjustments = useCallback(async () => {
    setAdjLoading(true);
    setAdjError(null);
    try {
      const data = await apiFetch("/reports/adjustments", {
        start_date: adjStart || undefined,
        end_date: adjEnd || undefined,
        adjustment_type: adjType !== "all" ? adjType : undefined,
        product_id: adjProduct || undefined,
      });
      setAdjData(data);
    } catch (e) {
      setAdjError(apiError(e));
    } finally {
      setAdjLoading(false);
    }
  }, [adjStart, adjEnd, adjType, adjProduct]);

  const fetchVendors = useCallback(async () => {
    setVendorLoading(true);
    setVendorError(null);
    try {
      const data = await apiFetch("/reports/vendor-receipts", {
        start_date: vendorStart || undefined,
        end_date: vendorEnd || undefined,
        vendor_id: vendorFilter || undefined,
      });
      setVendorData(data);
    } catch (e) {
      setVendorError(apiError(e));
    } finally {
      setVendorLoading(false);
    }
  }, [vendorStart, vendorEnd, vendorFilter]);

  const fetchLotTrace = useCallback(async () => {
    if (!lotNumber.trim()) return;
    setLotLoading(true);
    setLotError(null);
    try {
      const data = await apiFetch("/reports/lot-trace", { lot_number: lotNumber.trim() });
      setLotData(data);
    } catch (e) {
      setLotError(apiError(e));
    } finally {
      setLotLoading(false);
    }
  }, [lotNumber]);

  const fetchCycleCounts = useCallback(async () => {
    setCcLoading(true);
    setCcError(null);
    try {
      const data = await apiFetch("/reports/cycle-counts", {
        start_date: ccStart || undefined,
        end_date: ccEnd || undefined,
      });
      setCcData(data);
    } catch (e) {
      setCcError(apiError(e));
    } finally {
      setCcLoading(false);
    }
  }, [ccStart, ccEnd]);

  // Auto-fetch expiry alerts when tab first opens
  useEffect(() => {
    if (activeTab === "expiry" && !expiryData && !expiryLoading) {
      fetchExpiry();
    }
  }, [activeTab, expiryData, expiryLoading, fetchExpiry]);

  // ─────────────────────────────────────────────────────────────────────────────
  // Column definitions
  // ─────────────────────────────────────────────────────────────────────────────

  // snapCurrentCols is now defined inline per group (FG vs raw/packaging)

  const snapPitCols = [
    { label: "Product", value: (r) => r.product_name },
    { label: "Code", value: (r) => r.product_code },
    { label: "Category", value: (r) => r.category_name },
    { label: "Lot #", value: (r) => r.lot_number || "—" },
    { label: "Vendor", value: (r) => r.vendor_name || "—" },
    { label: "Receipt Date", value: (r) => formatDate(r.receipt_date) },
    { label: "Expiry Date", value: (r) => formatDate(r.expiration_date) },
    { label: "Quantity", value: (r) => `${formatNumber(r.quantity)} ${r.unit}` },
  ];

  const ledgerCols = [
    { label: "Product", value: (r) => r.product_name },
    { label: "Code", value: (r) => r.product_code },
    { label: "Category", value: (r) => r.category_name },
    {
      label: "Lot Numbers",
      value: (r) => (r.lot_numbers || []).join(", ") || "—",
      renderValue: (r) => (r.lot_numbers || []).length === 0
        ? <span style={{color:"#9ca3af"}}>—</span>
        : (
          <div style={{display:"flex", flexWrap:"wrap", gap:4}}>
            {(r.lot_numbers || []).map((ln) => (
              <span key={ln} style={{display:"inline-block", padding:"1px 7px", background:"#fff7ed", color:"#c2410c", border:"1px solid #fed7aa", borderRadius:10, fontSize:11, fontWeight:600, whiteSpace:"nowrap"}}>{ln}</span>
            ))}
          </div>
        ),
    },
    { label: "Received", value: (r) => formatNumber(r.received) },
    { label: "Consumed (Prod.)", value: (r) => formatNumber(r.consumed_in_production) },
    { label: "Shipped Out", value: (r) => formatNumber(r.shipped_out) },
    { label: "Other Adj.", value: (r) => formatNumber(r.other_adjustments) },
    { label: "On Hand Today", value: (r) => formatNumber(r.current_on_hand) },
  ];

  const shipmentCols = [
    { label: "Ship Date", value: (r) => formatDate(r.ship_date) },
    { label: "Order #", value: (r) => r.order_number || "—" },
    { label: "Product", value: (r) => r.product_name },
    { label: "Code", value: (r) => r.product_code },
    { label: "Lot #", value: (r) => r.lot_number || "—" },
    { label: "Cases", value: (r) => formatNumber(r.cases) },
    { label: "Approved By", value: (r) => r.approved_by || "—" },
  ];

  const fgCols = [
    { label: "Production Date", value: (r) => formatDate(r.production_date) },
    { label: "Product", value: (r) => r.product_name },
    { label: "Code", value: (r) => r.product_code },
    { label: "Lot #", value: (r) => r.lot_number || "—" },
    { label: "Cases Produced", value: (r) => formatNumber(r.cases_produced) },
    { label: "Cases Shipped", value: (r) => formatNumber(r.cases_shipped) },
    { label: "Cases On Hand", value: (r) => formatNumber(r.cases_on_hand) },
    { label: "Status", value: (r) => r.status },
  ];

  const expiryCols = [
    { label: "Expiry Date", value: (r) => formatDate(r.expiration_date) },
    { label: "Days Left", value: (r) => r.days_until_expiry < 0 ? `${Math.abs(r.days_until_expiry)}d overdue` : `${r.days_until_expiry}d` },
    { label: "Status", value: (r) => r.urgency_bucket },
    { label: "Product", value: (r) => r.product_name },
    { label: "Category", value: (r) => r.category_name },
    { label: "Lot #", value: (r) => r.lot_number || "—" },
    { label: "Quantity", value: (r) => `${formatNumber(r.quantity)} ${r.unit}` },
    { label: "On Hold", value: (r) => r.on_hold ? "Yes" : "No" },
  ];

  const holdsCols = [
    { label: "Date", value: (r) => formatDate(r.action_date) },
    { label: "Action", value: (r) => r.action.charAt(0).toUpperCase() + r.action.slice(1) },
    { label: "Product", value: (r) => r.product_name },
    { label: "Lot #", value: (r) => r.lot_number || "—" },
    { label: "Quantity", value: (r) => formatNumber(r.quantity) },
    { label: "Reason", value: (r) => r.reason || "—" },
    { label: "Submitted By", value: (r) => r.submitted_by || "—" },
    { label: "Approved By", value: (r) => r.approved_by || "—" },
    { label: "Location", value: (r) => r.hold_location || "—" },
  ];

  const adjCols = [
    { label: "Date", value: (r) => formatDate(r.date) },
    { label: "Type", value: (r) => r.adjustment_type?.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) },
    { label: "Product", value: (r) => r.product_name },
    { label: "Lot #", value: (r) => r.lot_number || "—" },
    { label: "Quantity", value: (r) => formatNumber(r.quantity) },
    { label: "Qty Before", value: (r) => r.qty_before != null ? formatNumber(r.qty_before) : "—" },
    { label: "Qty After", value: (r) => r.qty_after != null ? formatNumber(r.qty_after) : "—" },
    { label: "Reason", value: (r) => r.reason || "—" },
    { label: "Submitted By", value: (r) => r.submitted_by || "—" },
    { label: "Approved By", value: (r) => r.approved_by || "—" },
  ];

  const vendorCols = [
    { label: "Receipt Date", value: (r) => formatDate(r.receipt_date) },
    { label: "Vendor", value: (r) => r.vendor_name },
    { label: "Product", value: (r) => r.product_name },
    { label: "Category", value: (r) => r.category_name },
    { label: "Lot #", value: (r) => r.lot_number || "—" },
    { label: "BOL", value: (r) => r.bol || "—" },
    { label: "PO #", value: (r) => r.purchase_order || "—" },
    { label: "Quantity", value: (r) => `${formatNumber(r.quantity)} ${r.unit}` },
    { label: "Status", value: (r) => r.status },
  ];

  const ccCols = [
    { label: "Count Date", value: (r) => formatDate(r.count_date) },
    { label: "Product", value: (r) => r.product_name },
    { label: "Location", value: (r) => r.location || "—" },
    { label: "System Count", value: (r) => r.system_count != null ? formatNumber(r.system_count) : "—" },
    { label: "Physical Count", value: (r) => r.actual_count != null ? formatNumber(r.actual_count) : "—" },
    { label: "Variance", value: (r) => r.variance != null ? formatNumber(r.variance) : "—" },
    { label: "Variance %", value: (r) => r.variance_pct != null ? `${r.variance_pct}%` : "—" },
    { label: "Counted By", value: (r) => r.counted_by || "—" },
    { label: "Notes", value: (r) => r.notes || "—" },
  ];

  // ─────────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="reports-page">
      {/* Header */}
      <div className="page-header">
        <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
          ← Back to Dashboard
        </button>
        <div className="header-content">
          <h1>Reporting</h1>
          <p>Analyze inventory performance, receipts, and warehouse activity.</p>
        </div>
      </div>

      {/* Tab navigation */}
      <nav className="reports-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={activeTab === tab.id ? "active" : ""}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* ── INVENTORY SNAPSHOT ───────────────────────────────────────────────── */}
      {activeTab === "snapshot" && (
        <section className="reports-panel">
          {/* Mode toggle */}
          <div className="snap-mode-bar">
            <div className="snap-mode-toggle">
              <button
                type="button"
                className={snapMode === "current" ? "active" : ""}
                onClick={() => setSnapMode("current")}
              >
                Current On-Hand
              </button>
              <button
                type="button"
                className={snapMode === "pit" ? "active" : ""}
                onClick={() => setSnapMode("pit")}
              >
                Point-in-Time
              </button>
            </div>

            {snapMode === "pit" && (
              <div className="snap-pit-controls">
                <label>
                  <span>As of Date</span>
                  <input
                    type="date"
                    value={snapDate}
                    onChange={(e) => setSnapDate(e.target.value)}
                    max={today()}
                  />
                </label>
                <RunButton onClick={fetchSnapshot} loading={snapLoading} />
              </div>
            )}

            {snapMode === "current" && (
              <div className="snap-pit-controls">
                <label>
                  <span>Product</span>
                  <SearchableSelect options={productOptions} value={snapProductFilter} onChange={setSnapProductFilter} allowEmptyOption emptyLabel="All Products" />
                </label>
                <label>
                  <span>Category</span>
                  <SearchableSelect options={categoryOptions} value={snapCatFilter} onChange={setSnapCatFilter} allowEmptyOption emptyLabel="All Categories" />
                </label>
                <label>
                  <span>Hold Status</span>
                  <SearchableSelect
                    options={[
                      { value: "all", label: "Hold & Released" },
                      { value: "on", label: "On Hold Only" },
                      { value: "off", label: "Exclude Hold" },
                    ]}
                    value={snapHoldFilter}
                    onChange={setSnapHoldFilter}
                    allowEmptyOption={false}
                  />
                </label>
              </div>
            )}
          </div>

          {/* Current mode */}
          {snapMode === "current" && (
            <>
              {/* Per-group sections — each with its own relevant metrics */}
              {GROUP_ORDER.map(({ groupId, label, color }) => {
                const rows = snapshotByGroup[groupId] || [];
                const totals = groupTotals[groupId] || { cases: 0, pallets: 0, floor: 0, hold: 0 };
                const isFG = groupId === "finished";

                // For raw/packaging, compute unit-aware totals
                const unitTotals = {};
                if (!isFG) {
                  rows.forEach((r) => {
                    const u = r.unit || "cases";
                    unitTotals[u] = (unitTotals[u] || 0) + r.casesOnHand;
                  });
                }

                // Columns differ by group type
                const lotCol = {
                  label: "Lot Numbers",
                  value: (r) => (r.lotNumbers || []).join(", ") || "—",
                  renderValue: (r) => (r.lotNumbers || []).length === 0
                    ? <span style={{color:"#9ca3af"}}>—</span>
                    : (
                      <div style={{display:"flex", flexWrap:"wrap", gap:3}}>
                        {(r.lotNumbers || []).map((ln) => (
                          <span key={ln} style={{display:"inline-block", padding:"1px 7px", background:"#fff7ed", color:"#c2410c", border:"1px solid #fed7aa", borderRadius:10, fontSize:11, fontWeight:600, whiteSpace:"nowrap"}}>{ln}</span>
                        ))}
                      </div>
                    ),
                };

                const cols = isFG
                  ? [
                      { label: "Product", value: (r) => r.productName },
                      { label: "Code", value: (r) => r.productCode },
                      { label: "Category", value: (r) => r.categoryName },
                      lotCol,
                      { label: "Cases On Hand", value: (r) => formatNumber(r.casesOnHand) },
                      { label: "Pallets On Hand", value: (r) => formatNumber(r.palletsOnHand, 2) },
                      { label: "Floor Pallets", value: (r) => formatNumber(r.floorPallets, 2) },
                      { label: "Hold Cases", value: (r) => formatNumber(r.holdCases) },
                    ]
                  : [
                      { label: "Product", value: (r) => r.productName },
                      { label: "Code", value: (r) => r.productCode },
                      { label: "Category", value: (r) => r.categoryName },
                      lotCol,
                      { label: "Qty On Hand", value: (r) => formatNumber(r.casesOnHand) },
                      { label: "Unit", value: (r) => r.unit || "cases" },
                      { label: "Hold Qty", value: (r) => r.holdCases > 0 ? formatNumber(r.holdCases) : "—" },
                    ];

                return (
                  <div key={groupId} className="reports-section snapshot-group-section">
                    <div className="snapshot-group-header" style={{ borderLeftColor: color }}>
                      <div className="snapshot-group-title">
                        <span className="snapshot-group-dot" style={{ background: color }} />
                        <h3>{label}</h3>
                        <span className="snapshot-group-count">{rows.length} product{rows.length !== 1 ? "s" : ""}</span>
                      </div>

                      <div className="snapshot-group-totals">
                        {isFG ? (
                          <>
                            <span><strong>{formatNumber(totals.cases)}</strong> cases</span>
                            <span><strong>{formatNumber(totals.pallets, 2)}</strong> pallets</span>
                            <span><strong>{formatNumber(finishedGoodsCapacitySummary?.utilization || 0, 0)}%</strong> rack</span>
                          </>
                        ) : (
                          Object.entries(unitTotals).map(([u, qty]) => (
                            <span key={u}><strong>{formatNumber(qty)}</strong> {u}</span>
                          ))
                        )}
                        {totals.hold > 0 && (
                          <span className="hold-badge">{formatNumber(totals.hold)} held</span>
                        )}
                      </div>

                      <ExportButtons
                        columns={cols}
                        rows={rows}
                        fileBaseName={`snapshot-${label.toLowerCase().replace(/\s+/g, "-")}`}
                      />
                    </div>

                    {rows.length === 0 ? (
                      <p className="group-empty">No {label.toLowerCase()} currently in stock.</p>
                    ) : (
                      <ReportTable columns={cols} rows={rows} />
                    )}
                  </div>
                );
              })}
            </>
          )}

          {/* Point-in-time mode */}
          {snapMode === "pit" && (
            <>
              {snapLoading && <LoadingBox />}
              {snapError && <ErrorBox message={snapError} />}
              {!snapLoading && !snapError && !snapData && (
                <div className="report-empty-prompt">Select a date and click <strong>Run Report</strong> to see what was on hand on that day.</div>
              )}
              {snapData && (
                <>
                  <SummaryCards cards={[
                    { label: "As of Date", value: snapData.as_of_date },
                    { label: "Total Lots", value: formatNumber(snapData.totals?.lots) },
                    ...Object.entries(snapData.totals?.by_category || {}).map(([k, v]) => ({
                      label: `${k?.charAt(0).toUpperCase()}${k?.slice(1) || ""} Cases`,
                      value: formatNumber(v),
                    })),
                  ]} />
                  <div className="reports-section">
                    <div className="reports-section-header">
                      <div>
                        <h3>Inventory on {snapData.as_of_date}</h3>
                        <p>Reconstructed from current data by rewinding subsequent transactions.</p>
                      </div>
                      <ExportButtons columns={snapPitCols} rows={snapData.rows || []} fileBaseName={`inventory-snapshot-${snapData.as_of_date}`} />
                    </div>
                    <ReportTable columns={snapPitCols} rows={snapData.rows || []} emptyMessage="No inventory found for that date." />
                  </div>
                </>
              )}
            </>
          )}
        </section>
      )}

      {/* ── ACTIVITY LEDGER ──────────────────────────────────────────────────── */}
      {activeTab === "ledger" && (
        <section className="reports-panel">
          <div className="reports-section report-filter-section">
            <h3>Activity Ledger Filters</h3>
            <div className="filter-row">
              <label><span>Start Date</span><input type="date" value={ledgerStart} onChange={(e) => setLedgerStart(e.target.value)} /></label>
              <label><span>End Date</span><input type="date" value={ledgerEnd} onChange={(e) => setLedgerEnd(e.target.value)} /></label>
              <QuickRange onRange={(s, e) => { setLedgerStart(s); setLedgerEnd(e); }} />
            </div>
            <div className="filter-row">
              <label><span>Product</span>
                <SearchableSelect options={productOptions} value={ledgerProduct} onChange={setLedgerProduct} allowEmptyOption emptyLabel="All Products" />
              </label>
              <label><span>Category</span>
                <SearchableSelect options={catTypeOptions} value={ledgerCatType} onChange={setLedgerCatType} allowEmptyOption={false} />
              </label>
              <RunButton onClick={fetchLedger} loading={ledgerLoading} />
            </div>
          </div>

          {ledgerLoading && <LoadingBox />}
          {ledgerError && <ErrorBox message={ledgerError} />}
          {!ledgerLoading && !ledgerError && !ledgerData && (
            <div className="report-empty-prompt">Set filters and click <strong>Run Report</strong> to generate the activity ledger.</div>
          )}

          {ledgerData && (
            <>
              <SummaryCards cards={[
                { label: "Received", value: formatNumber(ledgerData.totals?.received), highlight: true },
                { label: "Consumed in Production", value: formatNumber(ledgerData.totals?.consumed_in_production) },
                { label: "Shipped Out", value: formatNumber(ledgerData.totals?.shipped_out) },
                { label: "Other Adjustments", value: formatNumber(ledgerData.totals?.other_adjustments) },
                { label: "Current On Hand", value: formatNumber(ledgerData.totals?.current_on_hand) },
              ]} />

              <div className="reports-section">
                <div className="reports-section-header">
                  <div>
                    <h3>Activity Ledger</h3>
                    <p>{ledgerData.start_date} → {ledgerData.end_date} · Per-product summary of all activity</p>
                  </div>
                  <ExportButtons columns={ledgerCols} rows={ledgerData.rows || []} fileBaseName={`activity-ledger-${ledgerData.start_date}`} />
                </div>
                <ReportTable columns={ledgerCols} rows={ledgerData.rows || []} emptyMessage="No activity found for the selected period." />
              </div>
            </>
          )}
        </section>
      )}

      {/* ── SHIPMENTS ────────────────────────────────────────────────────────── */}
      {activeTab === "shipments" && (
        <section className="reports-panel">
          <div className="reports-section report-filter-section">
            <h3>Shipment Report Filters</h3>
            <div className="filter-row">
              <label><span>Start Date</span><input type="date" value={shipStart} onChange={(e) => setShipStart(e.target.value)} /></label>
              <label><span>End Date</span><input type="date" value={shipEnd} onChange={(e) => setShipEnd(e.target.value)} /></label>
              <QuickRange onRange={(s, e) => { setShipStart(s); setShipEnd(e); }} />
            </div>
            <div className="filter-row">
              <label><span>Product</span>
                <SearchableSelect options={productOptions} value={shipProduct} onChange={setShipProduct} allowEmptyOption emptyLabel="All Products" />
              </label>
              <RunButton onClick={fetchShipments} loading={shipLoading} />
            </div>
          </div>

          {shipLoading && <LoadingBox />}
          {shipError && <ErrorBox message={shipError} />}
          {!shipLoading && !shipError && !shipData && (
            <div className="report-empty-prompt">Set filters and click <strong>Run Report</strong>.</div>
          )}
          {shipData && (
            <>
              <SummaryCards cards={[
                { label: "Total Shipments", value: formatNumber(shipData.totals?.shipment_count) },
                { label: "Total Cases Shipped", value: formatNumber(shipData.totals?.total_cases), highlight: true },
              ]} />
              <div className="reports-section">
                <div className="reports-section-header">
                  <div><h3>Shipment History</h3><p>All approved ship-outs in the selected period.</p></div>
                  <ExportButtons columns={shipmentCols} rows={shipData.rows || []} fileBaseName="shipments" />
                </div>
                <ReportTable columns={shipmentCols} rows={shipData.rows || []} emptyMessage="No shipments found." />
              </div>
            </>
          )}
        </section>
      )}

      {/* ── FINISHED GOODS ───────────────────────────────────────────────────── */}
      {activeTab === "finished-goods" && (
        <section className="reports-panel">
          <div className="reports-section report-filter-section">
            <h3>Finished Goods Production Filters</h3>
            <div className="filter-row">
              <label><span>Start Date</span><input type="date" value={fgStart} onChange={(e) => setFgStart(e.target.value)} /></label>
              <label><span>End Date</span><input type="date" value={fgEnd} onChange={(e) => setFgEnd(e.target.value)} /></label>
              <QuickRange onRange={(s, e) => { setFgStart(s); setFgEnd(e); }} />
            </div>
            <div className="filter-row">
              <label><span>Product</span>
                <SearchableSelect options={productOptions} value={fgProduct} onChange={setFgProduct} allowEmptyOption emptyLabel="All Products" />
              </label>
              <RunButton onClick={fetchFinishedGoods} loading={fgLoading} />
            </div>
          </div>

          {fgLoading && <LoadingBox />}
          {fgError && <ErrorBox message={fgError} />}
          {!fgLoading && !fgError && !fgData && (
            <div className="report-empty-prompt">Set filters and click <strong>Run Report</strong>.</div>
          )}
          {fgData && (
            <>
              <SummaryCards cards={[
                { label: "Cases Produced", value: formatNumber(fgData.totals?.total_produced), highlight: true },
                { label: "Cases Shipped", value: formatNumber(fgData.totals?.total_shipped) },
                { label: "Cases On Hand", value: formatNumber(fgData.totals?.total_on_hand) },
              ]} />

              {(fgData.daily || []).length > 0 && (
                <div className="reports-section">
                  <div className="reports-section-header">
                    <div><h3>Daily Production</h3><p>Cases produced per production date.</p></div>
                  </div>
                  <div className="chart-wrapper" style={{ padding: "16px" }}>
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={fgData.daily} margin={{ top: 10, right: 30, left: 10, bottom: 10 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                        <XAxis dataKey="date" />
                        <YAxis allowDecimals={false} />
                        <Tooltip formatter={(v) => formatNumber(v)} />
                        <Legend verticalAlign="top" height={36} />
                        <Bar dataKey="cases_produced" name="Produced" fill="#f97316" radius={[4, 4, 0, 0]} />
                        <Bar dataKey="cases_shipped" name="Shipped" fill="#6366f1" radius={[4, 4, 0, 0]} />
                        <Bar dataKey="cases_on_hand" name="On Hand" fill="#22c55e" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              <div className="reports-section">
                <div className="reports-section-header">
                  <div><h3>Lot Detail</h3><p>Produced vs shipped vs on-hand per lot.</p></div>
                  <ExportButtons columns={fgCols} rows={fgData.rows || []} fileBaseName="finished-goods-production" />
                </div>
                <ReportTable columns={fgCols} rows={fgData.rows || []} emptyMessage="No finished goods receipts found." />
              </div>
            </>
          )}
        </section>
      )}

      {/* ── EXPIRY ALERTS ────────────────────────────────────────────────────── */}
      {activeTab === "expiry" && (
        <section className="reports-panel">
          <div className="reports-section report-filter-section">
            <h3>Expiry Alert Filters</h3>
            <div className="filter-row">
              <label><span>Show items expiring within</span>
                <select className="filter-select" value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)}>
                  <option value="30">30 days</option>
                  <option value="60">60 days</option>
                  <option value="90">90 days</option>
                  <option value="180">180 days</option>
                  <option value="all">All</option>
                </select>
              </label>
              <label><span>Category</span>
                <SearchableSelect options={catTypeOptions} value={expiryCatType} onChange={setExpiryCatType} allowEmptyOption={false} />
              </label>
              <label className="checkbox-label">
                <input type="checkbox" checked={expiryIncExp} onChange={(e) => setExpiryIncExp(e.target.checked)} />
                <span>Include already expired</span>
              </label>
              <RunButton onClick={fetchExpiry} loading={expiryLoading} />
            </div>
          </div>

          {expiryLoading && <LoadingBox />}
          {expiryError && <ErrorBox message={expiryError} />}

          {expiryData && (
            <>
              <div className="expiry-buckets">
                {["expired", "0-30 days", "31-60 days", "61-90 days", "90+ days"].map((b) => {
                  const info = expiryData.buckets?.[b];
                  if (!info) return null;
                  const urgent = b === "expired" || b === "0-30 days";
                  return (
                    <article key={b} className={`summary-card${urgent ? " summary-card--danger" : ""}`}>
                      <h4>{b === "expired" ? "⚠ Expired" : b}</h4>
                      <span className="summary-value">{formatNumber(info.lots)} lots</span>
                      <span className="summary-sub">{formatNumber(info.quantity)} cases</span>
                    </article>
                  );
                })}
              </div>

              <div className="reports-section">
                <div className="reports-section-header">
                  <div><h3>Expiry Detail</h3><p>Active inventory sorted by expiry date.</p></div>
                  <ExportButtons columns={expiryCols} rows={expiryData.rows || []} fileBaseName="expiry-alerts" />
                </div>
                <ReportTable
                  columns={expiryCols}
                  rows={(expiryData.rows || []).map((r) => ({
                    ...r,
                    id: r.receipt_id,
                    _rowClass: r.days_until_expiry < 0 ? "row-danger" : r.days_until_expiry <= 30 ? "row-warning" : "",
                  }))}
                  emptyMessage="No expiry items found."
                />
              </div>
            </>
          )}
        </section>
      )}

      {/* ── QUALITY & HOLDS ──────────────────────────────────────────────────── */}
      {activeTab === "holds" && (
        <section className="reports-panel">
          <div className="reports-section report-filter-section">
            <h3>Quality & Hold Filters</h3>
            <div className="filter-row">
              <label><span>Start Date</span><input type="date" value={holdsStart} onChange={(e) => setHoldsStart(e.target.value)} /></label>
              <label><span>End Date</span><input type="date" value={holdsEnd} onChange={(e) => setHoldsEnd(e.target.value)} /></label>
              <QuickRange onRange={(s, e) => { setHoldsStart(s); setHoldsEnd(e); }} />
            </div>
            <div className="filter-row">
              <label><span>Action</span>
                <SearchableSelect options={holdActionOptions} value={holdsAction} onChange={setHoldsAction} allowEmptyOption={false} />
              </label>
              <RunButton onClick={fetchHolds} loading={holdsLoading} />
            </div>
          </div>

          {holdsLoading && <LoadingBox />}
          {holdsError && <ErrorBox message={holdsError} />}
          {!holdsLoading && !holdsError && !holdsData && (
            <div className="report-empty-prompt">Set filters and click <strong>Run Report</strong>.</div>
          )}
          {holdsData && (
            <>
              <SummaryCards cards={[
                { label: "Holds Placed", value: formatNumber(holdsData.totals?.holds), highlight: true },
                { label: "Holds Released", value: formatNumber(holdsData.totals?.releases) },
              ]} />
              <div className="reports-section">
                <div className="reports-section-header">
                  <div><h3>Hold & Release Log</h3><p>All approved hold and release actions.</p></div>
                  <ExportButtons columns={holdsCols} rows={holdsData.rows || []} fileBaseName="holds-report" />
                </div>
                <ReportTable columns={holdsCols} rows={(holdsData.rows || []).map((r, i) => ({ ...r, id: r.hold_id || i }))} emptyMessage="No holds found." />
              </div>
            </>
          )}
        </section>
      )}

      {/* ── ADJUSTMENTS ──────────────────────────────────────────────────────── */}
      {activeTab === "adjustments" && (
        <section className="reports-panel">
          <div className="reports-section report-filter-section">
            <h3>Adjustment Audit Filters</h3>
            <div className="filter-row">
              <label><span>Start Date</span><input type="date" value={adjStart} onChange={(e) => setAdjStart(e.target.value)} /></label>
              <label><span>End Date</span><input type="date" value={adjEnd} onChange={(e) => setAdjEnd(e.target.value)} /></label>
              <QuickRange onRange={(s, e) => { setAdjStart(s); setAdjEnd(e); }} />
            </div>
            <div className="filter-row">
              <label><span>Type</span>
                <SearchableSelect options={adjTypeOptions} value={adjType} onChange={setAdjType} allowEmptyOption={false} />
              </label>
              <label><span>Product</span>
                <SearchableSelect options={productOptions} value={adjProduct} onChange={setAdjProduct} allowEmptyOption emptyLabel="All Products" />
              </label>
              <RunButton onClick={fetchAdjustments} loading={adjLoading} />
            </div>
          </div>

          {adjLoading && <LoadingBox />}
          {adjError && <ErrorBox message={adjError} />}
          {!adjLoading && !adjError && !adjData && (
            <div className="report-empty-prompt">Set filters and click <strong>Run Report</strong>.</div>
          )}
          {adjData && (
            <>
              <SummaryCards cards={[
                { label: "Total Adjustments", value: formatNumber(adjData.totals?.count) },
                { label: "Total Qty Adjusted", value: formatNumber(adjData.totals?.total_quantity), highlight: true },
                ...Object.entries(adjData.totals?.by_type || {}).map(([k, v]) => ({
                  label: k.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
                  value: formatNumber(v),
                })),
              ]} />
              <div className="reports-section">
                <div className="reports-section-header">
                  <div><h3>Adjustment Audit Trail</h3><p>All approved inventory adjustments with before/after quantities.</p></div>
                  <ExportButtons columns={adjCols} rows={adjData.rows || []} fileBaseName="adjustments-audit" />
                </div>
                <ReportTable columns={adjCols} rows={(adjData.rows || []).map((r, i) => ({ ...r, id: r.adjustment_id || i }))} emptyMessage="No adjustments found." />
              </div>
            </>
          )}
        </section>
      )}

      {/* ── VENDOR RECEIPTS ──────────────────────────────────────────────────── */}
      {activeTab === "vendors" && (
        <section className="reports-panel">
          <div className="reports-section report-filter-section">
            <h3>Vendor Receipt Filters</h3>
            <div className="filter-row">
              <label><span>Start Date</span><input type="date" value={vendorStart} onChange={(e) => setVendorStart(e.target.value)} /></label>
              <label><span>End Date</span><input type="date" value={vendorEnd} onChange={(e) => setVendorEnd(e.target.value)} /></label>
              <QuickRange onRange={(s, e) => { setVendorStart(s); setVendorEnd(e); }} />
            </div>
            <div className="filter-row">
              <label><span>Vendor</span>
                <SearchableSelect options={vendorOptions} value={vendorFilter} onChange={setVendorFilter} allowEmptyOption emptyLabel="All Vendors" />
              </label>
              <RunButton onClick={fetchVendors} loading={vendorLoading} />
            </div>
          </div>

          {vendorLoading && <LoadingBox />}
          {vendorError && <ErrorBox message={vendorError} />}
          {!vendorLoading && !vendorError && !vendorData && (
            <div className="report-empty-prompt">Set filters and click <strong>Run Report</strong>.</div>
          )}
          {vendorData && (
            <>
              {Object.keys(vendorData.by_vendor || {}).length > 0 && (
                <div className="reports-section">
                  <div className="reports-section-header">
                    <div><h3>By Vendor</h3></div>
                  </div>
                  <ReportTable
                    columns={[
                      { label: "Vendor", value: (r) => r.vendor },
                      { label: "Receipts", value: (r) => r.receipts },
                      { label: "Total Qty", value: (r) => formatNumber(r.quantity) },
                    ]}
                    rows={Object.entries(vendorData.by_vendor).map(([vendor, info], i) => ({
                      id: i,
                      vendor,
                      receipts: info.receipts,
                      quantity: info.quantity,
                    }))}
                  />
                </div>
              )}
              <div className="reports-section">
                <div className="reports-section-header">
                  <div><h3>Receipt Detail</h3><p>All receipts with vendor information.</p></div>
                  <ExportButtons columns={vendorCols} rows={vendorData.rows || []} fileBaseName="vendor-receipts" />
                </div>
                <ReportTable columns={vendorCols} rows={(vendorData.rows || []).map((r, i) => ({ ...r, id: r.receipt_id || i }))} emptyMessage="No receipts found." />
              </div>
            </>
          )}
        </section>
      )}

      {/* ── LOT TRACEABILITY ─────────────────────────────────────────────────── */}
      {activeTab === "lot-trace" && (
        <section className="reports-panel">
          <div className="reports-section report-filter-section">
            <h3>Lot Traceability Search</h3>
            <div className="filter-row lot-trace-row">
              <label style={{ flex: "1 1 300px" }}>
                <span>Lot Number</span>
                <input
                  type="text"
                  className="lot-search-input"
                  placeholder="Enter lot number or partial match…"
                  value={lotNumber}
                  onChange={(e) => setLotNumber(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && fetchLotTrace()}
                />
              </label>
              <RunButton onClick={fetchLotTrace} loading={lotLoading} />
            </div>
          </div>

          {lotLoading && <LoadingBox />}
          {lotError && <ErrorBox message={lotError} />}
          {!lotLoading && !lotError && !lotData && (
            <div className="report-empty-prompt">Enter a lot number and click <strong>Run Report</strong> to trace its full history.</div>
          )}
          {lotData && (lotData.receipts || []).length === 0 && (
            <div className="report-error">No receipts found matching lot number "{lotData.lot_number}".</div>
          )}
          {lotData && (lotData.receipts || []).map((receipt) => (
            <div key={receipt.receipt_id} className="reports-section lot-trace-receipt">
              {/* ── Receipt Header ── */}
              <div className="lot-trace-header">
                <div className="lot-trace-header-main">
                  <h3>
                    {receipt.product_name}
                    {receipt.product_code && <span className="lot-code-badge">{receipt.product_code}</span>}
                    <span className="lot-badge">Lot {receipt.lot_number}</span>
                    <span className={`lot-status lot-status--${receipt.status}`}>{receipt.status}</span>
                    {receipt.on_hold && <span className="lot-status lot-status--hold">On Hold</span>}
                  </h3>
                  <div className="lot-trace-meta">
                    <span>Category: <strong>{receipt.category_name}</strong></span>
                    {receipt.vendor_name && <span>Vendor: <strong>{receipt.vendor_name}</strong></span>}
                    <span>Received: <strong>{formatDate(receipt.receipt_date)}</strong></span>
                    {receipt.production_date && <span>Production: <strong>{formatDate(receipt.production_date)}</strong></span>}
                    {receipt.expiration_date && <span>Expires: <strong>{formatDate(receipt.expiration_date)}</strong></span>}
                    <span>Initial Qty: <strong>{formatNumber(receipt.initial_quantity)} {receipt.unit}</strong></span>
                  </div>
                  {/* Approval / submission trail */}
                  <div className="lot-trace-trail">
                    {receipt.submitted_by && (
                      <span className="trail-item trail-submitted">
                        <span className="trail-icon">✏</span>
                        Submitted by <strong>{receipt.submitted_by}</strong>
                        {receipt.submitted_at && <span className="trail-time">{formatDateTime(receipt.submitted_at)}</span>}
                      </span>
                    )}
                    {receipt.approved_by && (
                      <span className="trail-item trail-approved">
                        <span className="trail-icon">✓</span>
                        Approved by <strong>{receipt.approved_by}</strong>
                        {receipt.approved_at && <span className="trail-time">{formatDateTime(receipt.approved_at)}</span>}
                      </span>
                    )}
                    {receipt.purchase_order && (
                      <span className="trail-item trail-po">
                        <span className="trail-icon">📋</span>
                        PO# <strong>{receipt.purchase_order}</strong>
                      </span>
                    )}
                    {receipt.bol && (
                      <span className="trail-item trail-bol">
                        <span className="trail-icon">📄</span>
                        BOL# <strong>{receipt.bol}</strong>
                      </span>
                    )}
                  </div>
                </div>
                <div className="lot-trace-summary">
                  <div className="summary-card">
                    <h4>Current On Hand</h4>
                    <span className="summary-value">{formatNumber(receipt.current_quantity)}</span>
                    <span className="summary-unit">{receipt.unit}</span>
                  </div>
                  <div className="summary-card summary-card--secondary">
                    <h4>Initial Qty</h4>
                    <span className="summary-value summary-value--sm">{formatNumber(receipt.initial_quantity)}</span>
                    <span className="summary-unit">{receipt.unit}</span>
                  </div>
                </div>
              </div>

              {/* ── Timeline ── */}
              <div className="lot-timeline">
                <h4>Full Activity Timeline</h4>
                <div className="timeline-list">
                  {(receipt.timeline || []).map((event, idx) => {
                    const isReceived = event.event_type === "received";
                    const isShipped = event.event_type === "shipped-out";
                    const isTransfer = event.event_type === "warehouse-transfer" || event.event_type === "staging";
                    const isHold = event.event_type?.startsWith("hold-");
                    const _isAdj = !isReceived && !isShipped && !isTransfer && !isHold;
                    const dotClass = isReceived ? "timeline-dot--received"
                      : isShipped ? "timeline-dot--shipped"
                      : isTransfer ? "timeline-dot--transfer"
                      : isHold ? "timeline-dot--hold"
                      : "timeline-dot--adj";
                    return (
                      <div key={idx} className="timeline-event">
                        <div className={`timeline-dot ${dotClass}`} />
                        <div className="timeline-content">
                          {/* Row 1: event name + qty + date */}
                          <div className="timeline-event-header">
                            <strong className={`timeline-event-name ${dotClass}`}>{event.event}</strong>
                            {event.qty > 0 && (
                              <span className={`timeline-qty-badge ${isReceived ? "tqb--in" : "tqb--out"}`}>
                                {isReceived ? "+" : "-"}{formatNumber(event.qty)} {receipt.unit}
                              </span>
                            )}
                            <span className="timeline-date">{formatDateTime(event.date)}</span>
                          </div>

                          {/* Row 2: location movement with row details */}
                          {(event.from_location || event.to_location) && (
                            <div className="timeline-location-block">
                              {event.from_location && (
                                <div className="timeline-loc-side">
                                  <span className="loc-direction-label">From</span>
                                  <span className="loc-chip loc-chip--from">{event.from_location}</span>
                                  {(event.from_rows || []).length > 0 && (
                                    <div className="loc-rows">
                                      {event.from_rows.map((r, i) => (
                                        <span key={i} className="row-chip row-chip--from">
                                          <span className="row-chip-name">{r.row}</span>
                                          <span className="row-chip-qty">{formatNumber(r.qty)} {r.unit}</span>
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                              {event.from_location && event.to_location && (
                                <span className="loc-arrow">→</span>
                              )}
                              {event.to_location && (
                                <div className="timeline-loc-side">
                                  <span className="loc-direction-label">To</span>
                                  <span className="loc-chip loc-chip--to">{event.to_location}</span>
                                  {(event.to_rows || []).length > 0 && (
                                    <div className="loc-rows">
                                      {event.to_rows.map((r, i) => (
                                        <span key={i} className="row-chip row-chip--to">
                                          <span className="row-chip-name">{r.row}</span>
                                          <span className="row-chip-qty">{formatNumber(r.qty)} {r.unit}</span>
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Row 3: order number (ship-outs) */}
                          {event.order_number && (
                            <div className="timeline-detail-row">
                              <span className="detail-label">Order #</span>
                              <span className="detail-value detail-value--order">{event.order_number}</span>
                            </div>
                          )}

                          {/* Row 4: PO / BOL (received) */}
                          {(event.purchase_order || event.bol) && (
                            <div className="timeline-detail-row">
                              {event.purchase_order && <><span className="detail-label">PO#</span><span className="detail-value">{event.purchase_order}</span></>}
                              {event.bol && <><span className="detail-label" style={{marginLeft: event.purchase_order ? 14 : 0}}>BOL#</span><span className="detail-value">{event.bol}</span></>}
                            </div>
                          )}

                          {/* Row 5: donation recipient */}
                          {event.recipient && (
                            <div className="timeline-detail-row">
                              <span className="detail-label">Recipient</span>
                              <span className="detail-value">{event.recipient}</span>
                            </div>
                          )}

                          {/* Row 6: notes / reason */}
                          {event.notes && <div className="timeline-notes">{event.notes}</div>}

                          {/* Row 7: submitted by / approved by */}
                          <div className="timeline-people-row">
                            {event.submitted_by && (
                              <span className="people-chip people-chip--submitted">
                                ✏ {event.submitted_by}
                                {event.submitted_at && <span className="people-time">{formatDateTime(event.submitted_at)}</span>}
                              </span>
                            )}
                            {event.approved_by && (
                              <span className="people-chip people-chip--approved">
                                ✓ {event.approved_by}
                                {event.approved_at && <span className="people-time">{formatDateTime(event.approved_at)}</span>}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
        </section>
      )}

      {/* ── CYCLE COUNTS ─────────────────────────────────────────────────────── */}
      {activeTab === "cycle-counts" && (
        <section className="reports-panel">
          <div className="reports-section report-filter-section">
            <h3>Cycle Count Filters</h3>
            <div className="filter-row">
              <label><span>Start Date</span><input type="date" value={ccStart} onChange={(e) => setCcStart(e.target.value)} /></label>
              <label><span>End Date</span><input type="date" value={ccEnd} onChange={(e) => setCcEnd(e.target.value)} /></label>
              <QuickRange onRange={(s, e) => { setCcStart(s); setCcEnd(e); }} />
            </div>
            <div className="filter-row">
              <RunButton onClick={fetchCycleCounts} loading={ccLoading} />
            </div>
          </div>

          {ccLoading && <LoadingBox />}
          {ccError && <ErrorBox message={ccError} />}
          {!ccLoading && !ccError && !ccData && (
            <div className="report-empty-prompt">Set filters and click <strong>Run Report</strong>.</div>
          )}
          {ccData && (
            <>
              <SummaryCards cards={[
                { label: "Count Sessions", value: formatNumber(ccData.totals?.count_events) },
                { label: "Items Counted", value: formatNumber(ccData.totals?.item_rows) },
                { label: "Total Variance", value: formatNumber(ccData.totals?.total_variance), highlight: Math.abs(ccData.totals?.total_variance || 0) > 0 },
                { label: "Items with Discrepancy", value: formatNumber(ccData.totals?.rows_with_discrepancy) },
              ]} />
              <div className="reports-section">
                <div className="reports-section-header">
                  <div><h3>Cycle Count Variance</h3><p>System vs physical count comparison.</p></div>
                  <ExportButtons columns={ccCols} rows={ccData.rows || []} fileBaseName="cycle-count-variance" />
                </div>
                <ReportTable columns={ccCols} rows={(ccData.rows || []).map((r, i) => ({ ...r, id: r.count_id || i }))} emptyMessage="No cycle counts found." />
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
};

export default ReportsPage;
