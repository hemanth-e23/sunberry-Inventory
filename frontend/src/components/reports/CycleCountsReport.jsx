import React, { useState, useCallback } from "react";
import { ExportButtons, ReportTable, SummaryCards, LoadingBox, ErrorBox, RunButton, QuickRange } from "./ReportSharedComponents";
import {
  apiFetch, apiError, cycleCountColumns, formatNumber, today, monthStart, varianceCards,
} from "./reportUtils";

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

  const ccCols = cycleCountColumns;

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
            { label: "Counts", value: formatNumber(ccData.totals?.count_events) },
            { label: "Items Counted", value: formatNumber(ccData.totals?.item_rows) },
            ...varianceCards(ccData.totals),
            { label: "Items with Discrepancy", value: formatNumber(ccData.totals?.rows_with_discrepancy) },
          ]} />
          <div className="reports-section">
            <div className="reports-section-header">
              <div><h3>Cycle Count Variance</h3><p>System vs physical count — finished-goods cycle counts and raw-material rack counts.</p></div>
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
