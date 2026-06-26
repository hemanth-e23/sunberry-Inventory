import React, { useState, useCallback, useMemo } from "react";
import { formatDate } from "../../utils/dateUtils";
import SearchableSelect from "../SearchableSelect";
import { ExportButtons, ReportTable, SummaryCards, LoadingBox, ErrorBox, RunButton, QuickRange } from "./ReportSharedComponents";
import { apiFetch, apiError, formatNumber, today, monthStart } from "./reportUtils";
import ShipmentDetailModal from "./ShipmentDetailModal";

// Collapse the per-line API rows into one summary row per order (transfer), so
// an order with several products/lots shows up once instead of many times.
const groupByOrder = (rows) => {
  const map = new Map();
  for (const r of rows) {
    const key = r.transfer_id || r.order_number;
    if (!map.has(key)) {
      map.set(key, {
        transfer_id: r.transfer_id,
        order_number: r.order_number,
        ship_date: r.ship_date,
        requested_by: r.requested_by,
        approved_by: r.approved_by,
        products: new Set(),
        total_cases: 0,
      });
    }
    const g = map.get(key);
    if (r.product_name) g.products.add(r.product_name);
    g.total_cases += Number(r.cases || 0);
  }
  return Array.from(map.values()).map((g) => ({ ...g, product_count: g.products.size }));
};

const ShipmentsReport = ({ productOptions }) => {
  const [shipStart, setShipStart] = useState(monthStart());
  const [shipEnd, setShipEnd] = useState(today());
  const [shipProduct, setShipProduct] = useState("");
  const [shipOrder, setShipOrder] = useState("");
  const [shipData, setShipData] = useState(null);
  const [shipLoading, setShipLoading] = useState(false);
  const [shipError, setShipError] = useState(null);

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailData, setDetailData] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);

  const fetchShipments = useCallback(async () => {
    setShipLoading(true);
    setShipError(null);
    try {
      const data = await apiFetch("/reports/shipments", {
        start_date: shipStart || undefined,
        end_date: shipEnd || undefined,
        product_id: shipProduct || undefined,
        order_number: shipOrder.trim() || undefined,
      });
      setShipData(data);
    } catch (e) {
      setShipError(apiError(e));
    } finally {
      setShipLoading(false);
    }
  }, [shipStart, shipEnd, shipProduct, shipOrder]);

  const openDetail = useCallback(async (transferId) => {
    if (!transferId) return;
    setDetailOpen(true);
    setDetailData(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const data = await apiFetch(`/reports/shipments/${transferId}`);
      setDetailData(data);
    } catch (e) {
      setDetailError(apiError(e));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const orderRows = useMemo(() => groupByOrder(shipData?.rows || []), [shipData]);

  const orderCols = [
    { label: "Ship Date", value: (r) => formatDate(r.ship_date) },
    { label: "Order #", value: (r) => r.order_number || "—" },
    {
      label: "Products",
      value: (r) => `${r.product_count} ${r.product_count === 1 ? "product" : "products"}`,
    },
    { label: "Total Cases", className: "num", value: (r) => formatNumber(r.total_cases) },
    { label: "Created By", value: (r) => r.requested_by || "—" },
    { label: "Approved By", value: (r) => r.approved_by || "—" },
    { label: "", className: "row-action", value: () => "View →" },
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
          <label><span>Order #</span>
            <input
              type="text"
              value={shipOrder}
              placeholder="Search any order #"
              onChange={(e) => setShipOrder(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") fetchShipments(); }}
            />
          </label>
          <label><span>Product</span>
            <SearchableSelect options={productOptions} value={shipProduct} onChange={setShipProduct} allowEmptyOption emptyLabel="All Products" />
          </label>
          <RunButton onClick={fetchShipments} loading={shipLoading} />
        </div>
        <p className="filter-hint">Tip: enter an Order # to pull it up across all dates, then click a row for full provenance.</p>
      </div>

      {shipLoading && <LoadingBox />}
      {shipError && <ErrorBox message={shipError} />}
      {!shipLoading && !shipError && !shipData && (
        <div className="report-empty-prompt">Set filters and click <strong>Run Report</strong>.</div>
      )}
      {shipData && (
        <>
          <SummaryCards cards={[
            { label: "Orders", value: formatNumber(orderRows.length) },
            { label: "Total Cases Shipped", value: formatNumber(shipData.totals?.total_cases), highlight: true },
          ]} />
          <div className="reports-section">
            <div className="reports-section-header">
              <div><h3>Shipment History</h3><p>One row per approved order — click any order to see who created, scanned and approved it, with rack, lot and pallet detail.</p></div>
              <ExportButtons columns={orderCols.filter((c) => c.label)} rows={orderRows} fileBaseName="shipments" />
            </div>
            <ReportTable columns={orderCols} rows={orderRows} emptyMessage="No orders found." onRowClick={(row) => openDetail(row.transfer_id)} />
          </div>
        </>
      )}

      <ShipmentDetailModal
        isOpen={detailOpen}
        onClose={() => setDetailOpen(false)}
        loading={detailLoading}
        error={detailError}
        data={detailData}
      />
    </section>
  );
};

export default ShipmentsReport;
