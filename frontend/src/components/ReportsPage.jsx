import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppData } from "../context/AppDataContext";
import { useAuth } from "../context/AuthContext";
import { getDashboardPath } from "../App";
import { TABS } from "./reports/reportUtils";
import {
  SnapshotReport,
  LedgerReport,
  ShipmentsReport,
  FinishedGoodsReport,
  ExpiryReport,
  HoldsReport,
  AdjustmentsReport,
  VendorReceiptsReport,
  LotTraceReport,
  CycleCountsReport,
} from "./reports";
import "./Shared.css";
import "./ReportsPage.css";

const ReportsPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { products, productCategories, vendors } = useAppData();

  const [activeTab, setActiveTab] = useState("snapshot");

  // ── Derived option lists (shared across multiple tabs) ──
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

      {/* Tab content */}
      {activeTab === "snapshot" && <SnapshotReport productOptions={productOptions} categoryOptions={categoryOptions} />}
      {activeTab === "ledger" && <LedgerReport productOptions={productOptions} />}
      {activeTab === "shipments" && <ShipmentsReport productOptions={productOptions} />}
      {activeTab === "finished-goods" && <FinishedGoodsReport productOptions={productOptions} />}
      {activeTab === "expiry" && <ExpiryReport />}
      {activeTab === "holds" && <HoldsReport />}
      {activeTab === "adjustments" && <AdjustmentsReport productOptions={productOptions} />}
      {activeTab === "vendors" && <VendorReceiptsReport vendorOptions={vendorOptions} />}
      {activeTab === "lot-trace" && <LotTraceReport />}
      {activeTab === "cycle-counts" && <CycleCountsReport />}
    </div>
  );
};

export default ReportsPage;
