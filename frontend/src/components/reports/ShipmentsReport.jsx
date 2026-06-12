import React, { useState, useCallback } from "react";
import { formatDate } from "../../utils/dateUtils";
import SearchableSelect from "../SearchableSelect";
import { ExportButtons, ReportTable, SummaryCards, LoadingBox, ErrorBox, RunButton, QuickRange } from "./ReportSharedComponents";
import { apiFetch, apiError, formatNumber, today, monthStart } from "./reportUtils";

const ShipmentsReport = ({ productOptions }) => {
  const [shipStart, setShipStart] = useState(monthStart());
  const [shipEnd, setShipEnd] = useState(today());
  const [shipProduct, setShipProduct] = useState("");
  const [shipData, setShipData] = useState(null);
  const [shipLoading, setShipLoading] = useState(false);
  const [shipError, setShipError] = useState(null);

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

  const shipmentCols = [
    { label: "Ship Date", value: (r) => formatDate(r.ship_date) },
    { label: "Order #", value: (r) => r.order_number || "—" },
    { label: "Product", value: (r) => r.product_name },
    { label: "Code", value: (r) => r.product_code },
    { label: "Lot #", value: (r) => r.lot_number || "—" },
    { label: "Cases", value: (r) => formatNumber(r.cases) },
    { label: "Approved By", value: (r) => r.approved_by || "—" },
  ];

  return (
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
  );
};

export default ShipmentsReport;
