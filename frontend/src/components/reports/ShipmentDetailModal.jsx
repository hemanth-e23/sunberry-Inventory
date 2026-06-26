import React from "react";
import { FileText, FileSpreadsheet, FileDown } from "lucide-react";
import Modal from "../Modal";
import { formatDateTime } from "../../utils/dateUtils";
import { LoadingBox, ErrorBox } from "./ReportSharedComponents";
import { formatNumber } from "./reportUtils";
import { exportOrderPDF, exportOrderExcel, exportOrderCSV } from "./shipmentDocExport";

const MetaItem = ({ label, value }) => (
  <div className="ship-meta-item">
    <span className="ship-meta-label">{label}</span>
    <span className="ship-meta-value">{value}</span>
  </div>
);

const ShipmentDetailModal = ({ isOpen, onClose, loading, error, data }) => {
  const title = data ? `Order ${data.order_number || "—"}` : "Order Details";
  const offList = (data?.scan_events || []).filter((e) => !e.on_list);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="xl">
      {loading && <LoadingBox />}
      {error && <ErrorBox message={error} />}
      {!loading && !error && data && (
        <div className="ship-detail">
          {/* Summary card */}
          <div className="ship-summary">
            <div className="ship-summary-meta">
              <MetaItem label="Created By" value={data.created_by || "—"} />
              <MetaItem label="Created" value={data.created_at ? formatDateTime(data.created_at) : "—"} />
              <MetaItem label="Approved By" value={data.approved_by || "—"} />
              <MetaItem label="Approved" value={data.approved_at ? formatDateTime(data.approved_at) : "—"} />
            </div>
            <div className="ship-summary-stats">
              <div className="ship-stat"><span className="ship-stat-value">{formatNumber(data.totals?.cases_picked)}</span><span className="ship-stat-label">Cases</span></div>
              <div className="ship-stat"><span className="ship-stat-value">{formatNumber(data.totals?.pallet_count)}</span><span className="ship-stat-label">Pallets</span></div>
              <div className="ship-stat"><span className="ship-stat-value">{formatNumber(data.totals?.line_count)}</span><span className="ship-stat-label">Products</span></div>
            </div>
          </div>

          {/* Export bar */}
          <div className="ship-export-bar">
            <span className="ship-export-label">Download this order</span>
            <div className="ship-export-buttons">
              <button type="button" onClick={() => exportOrderPDF(data)}><FileDown size={15} /> PDF</button>
              <button type="button" onClick={() => exportOrderExcel(data)}><FileSpreadsheet size={15} /> Excel</button>
              <button type="button" onClick={() => exportOrderCSV(data)}><FileText size={15} /> CSV</button>
            </div>
          </div>

          {/* One section per product line */}
          {(data.lines || []).map((line) => (
            <div key={line.line_id} className="ship-line">
              <div className="ship-line-head">
                <div className="ship-line-title">
                  <h4>{line.product_name}</h4>
                  <span className="ship-line-code">{line.product_code}</span>
                </div>
                <div className="ship-line-tags">
                  {line.lot_number && <span className="ship-tag ship-tag--lot">Lot {line.lot_number}</span>}
                  <span className="ship-tag">{formatNumber(line.cases_picked)} cases</span>
                  <span className="ship-tag">{(line.picks || []).length} pallets</span>
                </div>
              </div>
              <div className="table-wrapper">
                <table className="report-table report-subtable">
                  <thead>
                    <tr>
                      <th>Licence #</th>
                      <th>Lot #</th>
                      <th>Rack</th>
                      <th className="num">Cases</th>
                      <th>Partial</th>
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
                          <td className="mono">{pick.licence_number || "—"}</td>
                          <td>{pick.lot_number || line.lot_number || "—"}</td>
                          <td>{pick.rack || "—"}</td>
                          <td className="num">{formatNumber(pick.cases)}</td>
                          <td>{pick.was_partial ? <span className="ship-tag ship-tag--warn">Partial</span> : "—"}</td>
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

          {offList.length > 0 && (
            <div className="ship-line">
              <div className="ship-line-head">
                <div className="ship-line-title">
                  <h4>Off-List Scans</h4>
                </div>
                <span className="ship-line-note">Pallets scanned that were not on the original order</span>
              </div>
              <div className="table-wrapper">
                <table className="report-table report-subtable">
                  <thead>
                    <tr><th>Licence #</th><th>Scanned By</th><th>Scanned At</th></tr>
                  </thead>
                  <tbody>
                    {offList.map((e, i) => (
                      <tr key={`${e.licence_number}-${i}`}>
                        <td className="mono">{e.licence_number || "—"}</td>
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
