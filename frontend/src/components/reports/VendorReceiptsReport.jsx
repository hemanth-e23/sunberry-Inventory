import React, { useState, useCallback } from "react";
import { formatDate } from "../../utils/dateUtils";
import SearchableSelect from "../SearchableSelect";
import { ExportButtons, ReportTable, LoadingBox, ErrorBox, RunButton, QuickRange } from "./ReportSharedComponents";
import { apiFetch, apiError, formatNumber, today, monthStart } from "./reportUtils";

const VendorReceiptsReport = ({ vendorOptions }) => {
  const [vendorStart, setVendorStart] = useState(monthStart());
  const [vendorEnd, setVendorEnd] = useState(today());
  const [vendorFilter, setVendorFilter] = useState("");
  const [vendorData, setVendorData] = useState(null);
  const [vendorLoading, setVendorLoading] = useState(false);
  const [vendorError, setVendorError] = useState(null);

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

  return (
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
  );
};

export default VendorReceiptsReport;
