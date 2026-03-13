import React, { useState, useCallback } from "react";
import { formatDate } from "../../utils/dateUtils";
import SearchableSelect from "../SearchableSelect";
import { ExportButtons, ReportTable, SummaryCards, LoadingBox, ErrorBox, RunButton, QuickRange } from "./ReportSharedComponents";
import { apiFetch, apiError, formatNumber, today, monthStart } from "./reportUtils";

const catTypeOptions = [
  { value: "", label: "All Categories" },
  { value: "raw", label: "Raw Materials" },
  { value: "packaging", label: "Packaging" },
  { value: "finished", label: "Finished Goods" },
];

const LedgerReport = ({ productOptions }) => {
  const [ledgerStart, setLedgerStart] = useState(monthStart());
  const [ledgerEnd, setLedgerEnd] = useState(today());
  const [ledgerProduct, setLedgerProduct] = useState("");
  const [ledgerCatType, setLedgerCatType] = useState("");
  const [ledgerData, setLedgerData] = useState(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState(null);

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

  return (
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
  );
};

export default LedgerReport;
