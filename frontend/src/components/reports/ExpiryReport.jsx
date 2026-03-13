import React, { useState, useCallback, useEffect } from "react";
import { formatDate } from "../../utils/dateUtils";
import SearchableSelect from "../SearchableSelect";
import { ExportButtons, ReportTable, LoadingBox, ErrorBox, RunButton } from "./ReportSharedComponents";
import { apiFetch, apiError, formatNumber } from "./reportUtils";

const catTypeOptions = [
  { value: "", label: "All Categories" },
  { value: "raw", label: "Raw Materials" },
  { value: "packaging", label: "Packaging" },
  { value: "finished", label: "Finished Goods" },
];

const ExpiryReport = () => {
  const [expiryDays, setExpiryDays] = useState("90");
  const [expiryCatType, setExpiryCatType] = useState("");
  const [expiryIncExp, setExpiryIncExp] = useState(true);
  const [expiryData, setExpiryData] = useState(null);
  const [expiryLoading, setExpiryLoading] = useState(false);
  const [expiryError, setExpiryError] = useState(null);

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

  // Auto-fetch on mount
  useEffect(() => {
    if (!expiryData && !expiryLoading) {
      fetchExpiry();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  return (
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
  );
};

export default ExpiryReport;
