import React, { useState, useCallback } from "react";
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
import { formatDate } from "../../utils/dateUtils";
import SearchableSelect from "../SearchableSelect";
import { ExportButtons, ReportTable, SummaryCards, LoadingBox, ErrorBox, RunButton, QuickRange } from "./ReportSharedComponents";
import { apiFetch, apiError, formatNumber, today, monthStart } from "./reportUtils";

const FinishedGoodsReport = ({ productOptions }) => {
  const [fgStart, setFgStart] = useState(monthStart());
  const [fgEnd, setFgEnd] = useState(today());
  const [fgProduct, setFgProduct] = useState("");
  const [fgData, setFgData] = useState(null);
  const [fgLoading, setFgLoading] = useState(false);
  const [fgError, setFgError] = useState(null);

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

  return (
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
  );
};

export default FinishedGoodsReport;
