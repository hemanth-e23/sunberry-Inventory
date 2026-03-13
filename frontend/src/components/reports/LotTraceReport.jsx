import React, { useState, useCallback } from "react";
import { formatDate, formatDateTime } from "../../utils/dateUtils";
import { LoadingBox, ErrorBox, RunButton } from "./ReportSharedComponents";
import { apiFetch, apiError, formatNumber } from "./reportUtils";

const LotTraceReport = () => {
  const [lotNumber, setLotNumber] = useState("");
  const [lotData, setLotData] = useState(null);
  const [lotLoading, setLotLoading] = useState(false);
  const [lotError, setLotError] = useState(null);

  const fetchLotTrace = useCallback(async () => {
    if (!lotNumber.trim()) return;
    setLotLoading(true);
    setLotError(null);
    try {
      const data = await apiFetch("/reports/lot-trace", { lot_number: lotNumber.trim() });
      setLotData(data);
    } catch (e) {
      setLotError(apiError(e));
    } finally {
      setLotLoading(false);
    }
  }, [lotNumber]);

  return (
    <section className="reports-panel">
      <div className="reports-section report-filter-section">
        <h3>Lot Traceability Search</h3>
        <div className="filter-row lot-trace-row">
          <label style={{ flex: "1 1 300px" }}>
            <span>Lot Number</span>
            <input
              type="text"
              className="lot-search-input"
              placeholder="Enter lot number or partial match…"
              value={lotNumber}
              onChange={(e) => setLotNumber(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && fetchLotTrace()}
            />
          </label>
          <RunButton onClick={fetchLotTrace} loading={lotLoading} />
        </div>
      </div>

      {lotLoading && <LoadingBox />}
      {lotError && <ErrorBox message={lotError} />}
      {!lotLoading && !lotError && !lotData && (
        <div className="report-empty-prompt">Enter a lot number and click <strong>Run Report</strong> to trace its full history.</div>
      )}
      {lotData && (lotData.receipts || []).length === 0 && (
        <div className="report-error">No receipts found matching lot number "{lotData.lot_number}".</div>
      )}
      {lotData && (lotData.receipts || []).map((receipt) => (
        <div key={receipt.receipt_id} className="reports-section lot-trace-receipt">
          {/* Receipt Header */}
          <div className="lot-trace-header">
            <div className="lot-trace-header-main">
              <h3>
                {receipt.product_name}
                {receipt.product_code && <span className="lot-code-badge">{receipt.product_code}</span>}
                <span className="lot-badge">Lot {receipt.lot_number}</span>
                <span className={`lot-status lot-status--${receipt.status}`}>{receipt.status}</span>
                {receipt.on_hold && <span className="lot-status lot-status--hold">On Hold</span>}
              </h3>
              <div className="lot-trace-meta">
                <span>Category: <strong>{receipt.category_name}</strong></span>
                {receipt.vendor_name && <span>Vendor: <strong>{receipt.vendor_name}</strong></span>}
                <span>Received: <strong>{formatDate(receipt.receipt_date)}</strong></span>
                {receipt.production_date && <span>Production: <strong>{formatDate(receipt.production_date)}</strong></span>}
                {receipt.expiration_date && <span>Expires: <strong>{formatDate(receipt.expiration_date)}</strong></span>}
                <span>Initial Qty: <strong>{formatNumber(receipt.initial_quantity)} {receipt.unit}</strong></span>
              </div>
              {/* Approval / submission trail */}
              <div className="lot-trace-trail">
                {receipt.submitted_by && (
                  <span className="trail-item trail-submitted">
                    <span className="trail-icon">✏</span>
                    Submitted by <strong>{receipt.submitted_by}</strong>
                    {receipt.submitted_at && <span className="trail-time">{formatDateTime(receipt.submitted_at)}</span>}
                  </span>
                )}
                {receipt.approved_by && (
                  <span className="trail-item trail-approved">
                    <span className="trail-icon">✓</span>
                    Approved by <strong>{receipt.approved_by}</strong>
                    {receipt.approved_at && <span className="trail-time">{formatDateTime(receipt.approved_at)}</span>}
                  </span>
                )}
                {receipt.purchase_order && (
                  <span className="trail-item trail-po">
                    <span className="trail-icon">📋</span>
                    PO# <strong>{receipt.purchase_order}</strong>
                  </span>
                )}
                {receipt.bol && (
                  <span className="trail-item trail-bol">
                    <span className="trail-icon">📄</span>
                    BOL# <strong>{receipt.bol}</strong>
                  </span>
                )}
              </div>
            </div>
            <div className="lot-trace-summary">
              <div className="summary-card">
                <h4>Current On Hand</h4>
                <span className="summary-value">{formatNumber(receipt.current_quantity)}</span>
                <span className="summary-unit">{receipt.unit}</span>
              </div>
              <div className="summary-card summary-card--secondary">
                <h4>Initial Qty</h4>
                <span className="summary-value summary-value--sm">{formatNumber(receipt.initial_quantity)}</span>
                <span className="summary-unit">{receipt.unit}</span>
              </div>
            </div>
          </div>

          {/* Timeline */}
          <div className="lot-timeline">
            <h4>Full Activity Timeline</h4>
            <div className="timeline-list">
              {(receipt.timeline || []).map((event, idx) => {
                const isReceived = event.event_type === "received";
                const isShipped = event.event_type === "shipped-out";
                const isTransfer = event.event_type === "warehouse-transfer" || event.event_type === "staging";
                const isHold = event.event_type?.startsWith("hold-");
                const dotClass = isReceived ? "timeline-dot--received"
                  : isShipped ? "timeline-dot--shipped"
                  : isTransfer ? "timeline-dot--transfer"
                  : isHold ? "timeline-dot--hold"
                  : "timeline-dot--adj";
                return (
                  <div key={idx} className="timeline-event">
                    <div className={`timeline-dot ${dotClass}`} />
                    <div className="timeline-content">
                      {/* Row 1: event name + qty + date */}
                      <div className="timeline-event-header">
                        <strong className={`timeline-event-name ${dotClass}`}>{event.event}</strong>
                        {event.qty > 0 && (
                          <span className={`timeline-qty-badge ${isReceived ? "tqb--in" : "tqb--out"}`}>
                            {isReceived ? "+" : "-"}{formatNumber(event.qty)} {receipt.unit}
                          </span>
                        )}
                        <span className="timeline-date">{formatDateTime(event.date)}</span>
                      </div>

                      {/* Row 2: location movement with row details */}
                      {(event.from_location || event.to_location) && (
                        <div className="timeline-location-block">
                          {event.from_location && (
                            <div className="timeline-loc-side">
                              <span className="loc-direction-label">From</span>
                              <span className="loc-chip loc-chip--from">{event.from_location}</span>
                              {(event.from_rows || []).length > 0 && (
                                <div className="loc-rows">
                                  {event.from_rows.map((r, i) => (
                                    <span key={i} className="row-chip row-chip--from">
                                      <span className="row-chip-name">{r.row}</span>
                                      <span className="row-chip-qty">{formatNumber(r.qty)} {r.unit}</span>
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                          {event.from_location && event.to_location && (
                            <span className="loc-arrow">→</span>
                          )}
                          {event.to_location && (
                            <div className="timeline-loc-side">
                              <span className="loc-direction-label">To</span>
                              <span className="loc-chip loc-chip--to">{event.to_location}</span>
                              {(event.to_rows || []).length > 0 && (
                                <div className="loc-rows">
                                  {event.to_rows.map((r, i) => (
                                    <span key={i} className="row-chip row-chip--to">
                                      <span className="row-chip-name">{r.row}</span>
                                      <span className="row-chip-qty">{formatNumber(r.qty)} {r.unit}</span>
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Row 3: order number (ship-outs) */}
                      {event.order_number && (
                        <div className="timeline-detail-row">
                          <span className="detail-label">Order #</span>
                          <span className="detail-value detail-value--order">{event.order_number}</span>
                        </div>
                      )}

                      {/* Row 4: PO / BOL (received) */}
                      {(event.purchase_order || event.bol) && (
                        <div className="timeline-detail-row">
                          {event.purchase_order && <><span className="detail-label">PO#</span><span className="detail-value">{event.purchase_order}</span></>}
                          {event.bol && <><span className="detail-label" style={{marginLeft: event.purchase_order ? 14 : 0}}>BOL#</span><span className="detail-value">{event.bol}</span></>}
                        </div>
                      )}

                      {/* Row 5: donation recipient */}
                      {event.recipient && (
                        <div className="timeline-detail-row">
                          <span className="detail-label">Recipient</span>
                          <span className="detail-value">{event.recipient}</span>
                        </div>
                      )}

                      {/* Row 6: notes / reason */}
                      {event.notes && <div className="timeline-notes">{event.notes}</div>}

                      {/* Row 7: submitted by / approved by */}
                      <div className="timeline-people-row">
                        {event.submitted_by && (
                          <span className="people-chip people-chip--submitted">
                            ✏ {event.submitted_by}
                            {event.submitted_at && <span className="people-time">{formatDateTime(event.submitted_at)}</span>}
                          </span>
                        )}
                        {event.approved_by && (
                          <span className="people-chip people-chip--approved">
                            ✓ {event.approved_by}
                            {event.approved_at && <span className="people-time">{formatDateTime(event.approved_at)}</span>}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ))}
    </section>
  );
};

export default LotTraceReport;
