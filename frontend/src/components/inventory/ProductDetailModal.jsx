import React, { useState } from "react";
import { formatDateTime as formatDate } from "../../utils/dateUtils";

const ProductDetailModal = ({
  productId,
  productsById,
  categoriesById,
  receipts,
  rowLookup,
  rowNameCache,
  getReceiptLocations,
  onClose,
}) => {
  const [modalExpiryStartDate, setModalExpiryStartDate] = useState("");
  const [modalExpiryEndDate, setModalExpiryEndDate] = useState("");
  const [modalExpiryFilter, setModalExpiryFilter] = useState("all");
  const [expirySortDirection, setExpirySortDirection] = useState("desc");

  const product = productsById[productId];

  // Filter to only show approved and pending receipts (exclude rejected)
  let detailReceipts = receipts.filter(r =>
    r.productId === productId && r.status !== "rejected"
  );

  // Apply expiration date filters
  if (modalExpiryFilter === "expiring-soon") {
    const sixMonthsFromNow = new Date();
    sixMonthsFromNow.setMonth(sixMonthsFromNow.getMonth() + 6);
    detailReceipts = detailReceipts.filter(r => {
      const expiry = r.expiration || r.expirationDate;
      if (!expiry) return false;
      const expiryDate = new Date(expiry);
      return expiryDate <= sixMonthsFromNow && expiryDate >= new Date();
    });
  } else if (modalExpiryFilter === "expired") {
    detailReceipts = detailReceipts.filter(r => {
      const expiry = r.expiration || r.expirationDate;
      if (!expiry) return false;
      return new Date(expiry) < new Date();
    });
  } else if (modalExpiryFilter === "custom" && (modalExpiryStartDate || modalExpiryEndDate)) {
    detailReceipts = detailReceipts.filter(r => {
      const expiry = r.expiration || r.expirationDate;
      if (!expiry) return false;
      const expiryDate = new Date(expiry);
      const startDate = modalExpiryStartDate ? new Date(modalExpiryStartDate) : null;
      const endDate = modalExpiryEndDate ? new Date(modalExpiryEndDate) : null;

      if (startDate && endDate) {
        return expiryDate >= startDate && expiryDate <= endDate;
      } else if (startDate) {
        return expiryDate >= startDate;
      } else if (endDate) {
        return expiryDate <= endDate;
      }
      return true;
    });
  }

  // Sort by expiration date
  detailReceipts = [...detailReceipts].sort((a, b) => {
    const expiryA = a.expiration || a.expirationDate;
    const expiryB = b.expiration || b.expirationDate;

    if (!expiryA && !expiryB) return 0;
    if (!expiryA) return 1;
    if (!expiryB) return -1;

    const dateA = new Date(expiryA).getTime();
    const dateB = new Date(expiryB).getTime();

    if (expirySortDirection === "desc") {
      return dateB - dateA;
    } else {
      return dateA - dateB;
    }
  });

  const lots = Array.from(new Set(detailReceipts.map(r => r.lotNo).filter(Boolean)));
  const locationTotals = {};
  detailReceipts.forEach(r => {
    const locs = getReceiptLocations(r);
    const qty = Number(r.quantity) || 0;
    locs.forEach(l => {
      locationTotals[l.label] = (locationTotals[l.label] || 0) + qty;
    });
  });

  const allProductReceipts = receipts.filter(r => r.productId === productId);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal panel" onClick={e => e.stopPropagation()}>
        <header className="modal-header">
          <h3>{product?.name || 'Product Details'}</h3>
        </header>
        <div className="modal-body">
          <div className="detail-grid">
            <div><strong>Category:</strong> {categoriesById[product?.categoryId]?.name || '—'}</div>
            <div><strong>Type:</strong> {categoriesById[product?.categoryId]?.type || '—'}</div>
            <div><strong>Lots Tracked:</strong> {lots.length}</div>
          </div>
          <h4>Locations</h4>
          {Object.keys(locationTotals).length ? (
            <ul className="location-list">
              {Object.entries(locationTotals).map(([label, qty]) => (
                <li key={label}><strong>{label}</strong> — {qty.toLocaleString()}</li>
              ))}
            </ul>
          ) : <span className="muted">No locations recorded</span>}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h4 style={{ margin: 0 }}>Lots</h4>
            {modalExpiryFilter !== "all" && (
              <span style={{ fontSize: '14px', color: '#666' }}>
                Showing {detailReceipts.length} of {allProductReceipts.length} lots
              </span>
            )}
          </div>

          {/* Expiration Date Filters */}
          <div style={{ marginBottom: '16px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '14px', fontWeight: '500' }}>Filter by Expiration:</span>
              <select
                value={modalExpiryFilter}
                onChange={(e) => {
                  setModalExpiryFilter(e.target.value);
                  if (e.target.value !== "custom") {
                    setModalExpiryStartDate("");
                    setModalExpiryEndDate("");
                  }
                }}
                style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '14px' }}
              >
                <option value="all">All</option>
                <option value="expiring-soon">Expiring Soon (Next 6 Months)</option>
                <option value="expired">Expired</option>
                <option value="custom">Custom Date Range</option>
              </select>
            </label>

            {modalExpiryFilter === "custom" && (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input
                  type="date"
                  value={modalExpiryStartDate}
                  onChange={(e) => setModalExpiryStartDate(e.target.value)}
                  placeholder="From"
                  style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '14px' }}
                />
                <span style={{ color: '#666' }}>to</span>
                <input
                  type="date"
                  value={modalExpiryEndDate}
                  onChange={(e) => setModalExpiryEndDate(e.target.value)}
                  placeholder="To"
                  style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '14px' }}
                />
                {(modalExpiryStartDate || modalExpiryEndDate) && (
                  <button
                    onClick={() => {
                      setModalExpiryStartDate("");
                      setModalExpiryEndDate("");
                    }}
                    style={{
                      padding: '6px 12px',
                      background: '#f5f5f5',
                      border: '1px solid #ddd',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '14px'
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
            )}
          </div>

          {lots.length ? (
            <table className="simple-table compact">
              <thead>
                <tr>
                  <th className="hide-mobile">Lot</th>
                  <th className="hide-tablet">Location</th>
                  <th className="hide-tablet">Row</th>
                  <th>Quantity</th>
                  <th>Status</th>
                  <th className="hide-mobile">Hold</th>
                  <th className="hide-mobile">Receipt Date</th>
                  <th
                    className="hide-mobile"
                    style={{ cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => setExpirySortDirection(prev => prev === "desc" ? "asc" : "desc")}
                    title={`Click to sort ${expirySortDirection === "desc" ? "ascending" : "descending"}`}
                  >
                    Expiration Date
                    <span style={{ marginLeft: '6px', fontSize: '12px' }}>
                      {expirySortDirection === "desc" ? "▼" : "▲"}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {detailReceipts.map(r => {
                  const locations = getReceiptLocations(r);
                  const locationLabel = locations[0]?.label || '—';
                  const rowDetail = locations[0]?.detail || '';

                  let rowDisplay = '—';
                  if (rowDetail) {
                    rowDisplay = rowDetail.replace('Rows: ', '').replace('Row: ', '');
                  } else if (r.storageRowId || r.storage_row_id) {
                    const rowId = r.storageRowId || r.storage_row_id;
                    const rowName = rowLookup[rowId] || rowNameCache[rowId];
                    const pallets = r.pallets || 0;

                    if (rowName) {
                      rowDisplay = `${rowName}${pallets > 0 ? ` (${pallets} pallets)` : ''}`;
                    } else {
                      rowDisplay = `${rowId}${pallets > 0 ? ` (${pallets} pallets)` : ''}`;
                    }
                  }

                  return (
                    <tr key={r.id}>
                      <td className="hide-mobile">{r.lotNo || '—'}</td>
                      <td className="hide-tablet">{locationLabel}</td>
                      <td className="hide-tablet">{rowDisplay}</td>
                      <td>
                        {Number(r.quantity || 0).toLocaleString()} {r.quantityUnits || ''}
                        {r.containerCount && r.containerUnit && r.weightPerContainer && r.weightUnit && (
                          <div style={{ fontSize: '0.75rem', color: '#666' }}>
                            {(() => {
                              const wpc = Number(r.weightPerContainer);
                              const currentContainers = wpc > 0
                                ? Math.round((Number(r.quantity || 0) / wpc) * 100) / 100
                                : null;
                              if (currentContainers != null && currentContainers !== Number(r.containerCount)) {
                                return `(~${currentContainers} ${r.containerUnit} remaining (${r.containerCount} received) × ${r.weightPerContainer} ${r.weightUnit})`;
                              }
                              return `(${r.containerCount} ${r.containerUnit} × ${r.weightPerContainer} ${r.weightUnit})`;
                            })()}
                          </div>
                        )}
                      </td>
                      <td className="capitalize">{r.status}</td>
                      <td className="hide-mobile">
                        {(() => {
                          const heldQty = Number(r.heldQuantity || r.held_quantity || 0);
                          const holdLoc = r.holdLocation || r.hold_location || null;
                          if (heldQty > 0) {
                            const locLabel = holdLoc ? ` (${holdLoc})` : '';
                            return <span className="chip chip-hold">{heldQty.toLocaleString()} on Hold{locLabel}</span>;
                          } else if (r.hold) {
                            return <span className="chip chip-hold">Hold</span>;
                          } else {
                            return <span className="chip chip-clear">Clear</span>;
                          }
                        })()}
                      </td>
                      <td className="hide-mobile">{formatDate(r.approvedAt) || formatDate(r.submittedAt) || formatDate(r.receiptDate)}</td>
                      <td className="hide-mobile">{formatDate(r.expiration) || formatDate(r.expirationDate) || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <span className="muted">No lots recorded</span>}
        </div>
        <footer className="modal-footer">
          <button
            className="secondary-button"
            onClick={onClose}
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
};

export default ProductDetailModal;
