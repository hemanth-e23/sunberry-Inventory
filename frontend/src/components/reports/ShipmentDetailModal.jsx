import React from "react";
import Modal from "../Modal";
import { formatDateTime } from "../../utils/dateUtils";
import { ExportButtons, LoadingBox, ErrorBox } from "./ReportSharedComponents";
import { formatNumber } from "./reportUtils";

// Flatten an order's lines/picks into one row per scanned pallet, so the whole
// order's provenance can be exported with the shared ExportButtons.
const exportColumns = [
  { label: "Order #", value: (r) => r.order_number },
  { label: "Product", value: (r) => r.product_name },
  { label: "Code", value: (r) => r.product_code },
  { label: "Lot #", value: (r) => r.lot_number || "—" },
  { label: "Licence #", value: (r) => r.licence_number || "—" },
  { label: "Rack", value: (r) => r.rack || "—" },
  { label: "Cases", value: (r) => formatNumber(r.cases) },
  { label: "Partial", value: (r) => (r.was_partial ? "Yes" : "No") },
  { label: "Scanned By", value: (r) => r.scanned_by || "—" },
  { label: "Scanned At", value: (r) => (r.scanned_at ? formatDateTime(r.scanned_at) : "—") },
  { label: "Created By", value: (r) => r.created_by || "—" },
  { label: "Approved By", value: (r) => r.approved_by || "—" },
];

const buildExportRows = (data) =>
  (data.lines || []).flatMap((line) =>
    (line.picks || []).map((pick) => ({
      order_number: data.order_number,
      product_name: line.product_name,
      product_code: line.product_code,
      lot_number: pick.lot_number || line.lot_number,
      licence_number: pick.licence_number,
      rack: pick.rack,
      cases: pick.cases,
      was_partial: pick.was_partial,
      scanned_by: pick.scanned_by,
      scanned_at: pick.scanned_at,
      created_by: data.created_by,
      approved_by: data.approved_by,
    })),
  );

const ShipmentDetailModal = ({ isOpen, onClose, loading, error, data }) => {
  const title = data ? `Order ${data.order_number || "—"}` : "Order Details";

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="xl">
      {loading && <LoadingBox />}
      {error && <ErrorBox message={error} />}
      {!loading && !error && data && (
        <div className="shipment-detail">
          <div className="shipment-detail-header">
            <div className="shipment-detail-meta">
              <div><span className="meta-label">Created By</span><span className="meta-value">{data.created_by || "—"}</span></div>
              <div><span className="meta-label">Created</span><span className="meta-value">{data.created_at ? formatDateTime(data.created_at) : "—"}</span></div>
              <div><span className="meta-label">Approved By</span><span className="meta-value">{data.approved_by || "—"}</span></div>
              <div><span className="meta-label">Approved</span><span className="meta-value">{data.approved_at ? formatDateTime(data.approved_at) : "—"}</span></div>
              <div><span className="meta-label">Total Cases</span><span className="meta-value">{formatNumber(data.totals?.cases_picked)}</span></div>
              <div><span className="meta-label">Pallets</span><span className="meta-value">{formatNumber(data.totals?.pallet_count)}</span></div>
              <div><span className="meta-label">Products</span><span className="meta-value">{formatNumber(data.totals?.line_count)}</span></div>
            </div>
            <ExportButtons
              columns={exportColumns}
              rows={buildExportRows(data)}
              fileBaseName={`order-${data.order_number || "shipment"}`}
            />
          </div>

          {(data.lines || []).map((line) => (
            <div key={line.line_id} className="shipment-detail-line">
              <div className="shipment-detail-line-head">
                <h4>{line.product_name} <span className="line-code">{line.product_code}</span></h4>
                <span className="line-cases">{formatNumber(line.cases_picked)} cases{line.lot_number ? ` · Lot ${line.lot_number}` : ""}</span>
              </div>
              <div className="table-wrapper">
                <table className="report-table report-subtable">
                  <thead>
                    <tr>
                      <th>Licence #</th>
                      <th>Lot #</th>
                      <th>Rack</th>
                      <th>Cases</th>
                      <th>Partial?</th>
                      <th>Scanned By</th>
                      <th>Scanned At</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(line.picks || []).length === 0 ? (
                      <tr><td colSpan={7} className="empty-state">No pallet scans recorded.</td></tr>
                    ) : (
                      line.picks.map((pick, i) => (
                        <tr key={pick.licence_number || i}>
                          <td>{pick.licence_number || "—"}</td>
                          <td>{pick.lot_number || line.lot_number || "—"}</td>
                          <td>{pick.rack || "—"}</td>
                          <td>{formatNumber(pick.cases)}</td>
                          <td>{pick.was_partial ? "Yes" : "—"}</td>
                          <td>{pick.scanned_by || "—"}</td>
                          <td>{pick.scanned_at ? formatDateTime(pick.scanned_at) : "—"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {(data.scan_events || []).some((e) => !e.on_list) && (
            <div className="shipment-detail-line">
              <div className="shipment-detail-line-head">
                <h4>Off-List Scans</h4>
                <span className="line-cases">Pallets scanned that were not on the original order</span>
              </div>
              <div className="table-wrapper">
                <table className="report-table report-subtable">
                  <thead>
                    <tr><th>Licence #</th><th>Scanned By</th><th>Scanned At</th></tr>
                  </thead>
                  <tbody>
                    {data.scan_events.filter((e) => !e.on_list).map((e, i) => (
                      <tr key={`${e.licence_number}-${i}`}>
                        <td>{e.licence_number || "—"}</td>
                        <td>{e.scanned_by || "—"}</td>
                        <td>{e.scanned_at ? formatDateTime(e.scanned_at) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};

export default ShipmentDetailModal;
