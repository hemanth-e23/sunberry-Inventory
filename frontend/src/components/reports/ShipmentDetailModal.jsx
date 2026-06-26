import React from "react";
import { FileText, FileSpreadsheet, FileDown, CheckCircle2, AlertTriangle } from "lucide-react";
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

const Stat = ({ value, label, tone }) => (
  <div className={`ship-stat${tone ? ` ship-stat--${tone}` : ""}`}>
    <span className="ship-stat-value">{value}</span>
    <span className="ship-stat-label">{label}</span>
  </div>
);

// Order- or product-level fulfilment badge.
const FulfilBadge = ({ requested, shipped, short, over }) => {
  if (short > 0) {
    return <span className="ship-badge ship-badge--short"><AlertTriangle size={13} /> Short {formatNumber(short)}</span>;
  }
  if (over > 0) {
    return <span className="ship-badge ship-badge--over"><AlertTriangle size={13} /> Over {formatNumber(over)}</span>;
  }
  if (requested > 0 && shipped >= requested) {
    return <span className="ship-badge ship-badge--ok"><CheckCircle2 size={13} /> Complete</span>;
  }
  return null;
};

const ShipmentDetailModal = ({ isOpen, onClose, loading, error, data }) => {
  const title = data ? `Order ${data.order_number || "—"}` : "Order Details";
  const t = data?.totals || {};

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
              <Stat value={formatNumber(t.cases_requested)} label="Requested" />
              <Stat value={formatNumber(t.cases_picked)} label="Shipped" tone="ship" />
              <Stat
                value={t.cases_over > 0 ? `+${formatNumber(t.cases_over)}` : formatNumber(t.cases_short)}
                label={t.cases_over > 0 ? "Over" : "Short"}
                tone={t.cases_short > 0 ? "short" : t.cases_over > 0 ? "over" : "ok"}
              />
              <Stat value={formatNumber(t.pallet_count)} label="Pallets" />
              <Stat value={formatNumber(t.product_count)} label="Products" />
            </div>
          </div>

          {/* Whole-order fulfilment line */}
          <div className="ship-fulfil-line">
            <FulfilBadge requested={t.cases_requested} shipped={t.cases_picked} short={t.cases_short} over={t.cases_over} />
            <span className="ship-fulfil-text">
              {formatNumber(t.cases_picked)} of {formatNumber(t.cases_requested)} cases shipped
            </span>
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

          {/* One section per product (FIFO sub-lines already merged server-side) */}
          {(data.lines || []).map((line) => (
            <div key={line.product_id || line.product_name} className="ship-line">
              <div className="ship-line-head">
                <div className="ship-line-title">
                  <h4>{line.product_name}</h4>
                  <span className="ship-line-code">{line.product_code}</span>
                </div>
                <div className="ship-line-tags">
                  <FulfilBadge requested={line.cases_requested} shipped={line.cases_picked} short={line.cases_short} over={line.cases_over} />
                  <span className="ship-tag">Req {formatNumber(line.cases_requested)}</span>
                  <span className="ship-tag">Shipped {formatNumber(line.cases_picked)}</span>
                  {(line.lots || []).length > 0 && (
                    <span className="ship-tag ship-tag--lot">{line.lots.length > 1 ? `Lots ${line.lots.join(", ")}` : `Lot ${line.lots[0]}`}</span>
                  )}
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
                      <tr>
                        <td colSpan={7} className="empty-state">
                          No pallets scanned for this product{line.cases_short > 0 ? ` — short by ${formatNumber(line.cases_short)} cases` : ""}.
                        </td>
                      </tr>
                    ) : (
                      line.picks.map((pick, i) => (
                        <tr key={pick.licence_number || i}>
                          <td className="mono">{pick.licence_number || "—"}</td>
                          <td>{pick.lot_number || "—"}</td>
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
        </div>
      )}
    </Modal>
  );
};

export default ShipmentDetailModal;
