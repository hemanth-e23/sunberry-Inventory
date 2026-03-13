import React, { useState, useCallback } from "react";
import { formatDate } from "../../utils/dateUtils";
import { ExportButtons, ReportTable, SummaryCards, LoadingBox, ErrorBox, RunButton, QuickRange } from "./ReportSharedComponents";
import { apiFetch, apiError, formatNumber, today, monthStart } from "./reportUtils";

const CycleCountsReport = () => {
  const [ccStart, setCcStart] = useState(monthStart());
  const [ccEnd, setCcEnd] = useState(today());
  const [ccData, setCcData] = useState(null);
  const [ccLoading, setCcLoading] = useState(false);
  const [ccError, setCcError] = useState(null);

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

  return (
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
  );
};

export default CycleCountsReport;
