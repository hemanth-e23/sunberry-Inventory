import React, { useState, useCallback } from "react";
import { formatDate } from "../../utils/dateUtils";
import SearchableSelect from "../SearchableSelect";
import { ExportButtons, ReportTable, SummaryCards, LoadingBox, ErrorBox, RunButton, QuickRange } from "./ReportSharedComponents";
import { apiFetch, apiError, formatNumber, today, monthStart } from "./reportUtils";

const holdActionOptions = [
  { value: "all", label: "Hold & Release" },
  { value: "hold", label: "Holds Only" },
  { value: "release", label: "Releases Only" },
];

const HoldsReport = () => {
  const [holdsStart, setHoldsStart] = useState(monthStart());
  const [holdsEnd, setHoldsEnd] = useState(today());
  const [holdsAction, setHoldsAction] = useState("all");
  const [holdsData, setHoldsData] = useState(null);
  const [holdsLoading, setHoldsLoading] = useState(false);
  const [holdsError, setHoldsError] = useState(null);

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

  return (
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
  );
};

export default HoldsReport;
