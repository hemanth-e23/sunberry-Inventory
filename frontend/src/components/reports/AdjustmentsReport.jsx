import React, { useState, useCallback } from "react";
import { formatDate } from "../../utils/dateUtils";
import SearchableSelect from "../SearchableSelect";
import { ExportButtons, ReportTable, SummaryCards, LoadingBox, ErrorBox, RunButton, QuickRange } from "./ReportSharedComponents";
import { apiFetch, apiError, formatNumber, today, monthStart } from "./reportUtils";

const adjTypeOptions = [
  { value: "all", label: "All Types" },
  { value: "production-consumption", label: "Production Consumption" },
  { value: "damage-reduction", label: "Damage Reduction" },
  { value: "donation", label: "Donation" },
  { value: "trash-disposal", label: "Trash Disposal" },
  { value: "quality-rejection", label: "Quality Rejection" },
  { value: "stock-correction", label: "Stock Correction" },
];

const AdjustmentsReport = ({ productOptions }) => {
  const [adjStart, setAdjStart] = useState(monthStart());
  const [adjEnd, setAdjEnd] = useState(today());
  const [adjType, setAdjType] = useState("all");
  const [adjProduct, setAdjProduct] = useState("");
  const [adjData, setAdjData] = useState(null);
  const [adjLoading, setAdjLoading] = useState(false);
  const [adjError, setAdjError] = useState(null);

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

  return (
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
  );
};

export default AdjustmentsReport;
