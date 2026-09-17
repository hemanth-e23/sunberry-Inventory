import React, { useEffect, useState } from "react";
import { receivedInto } from "../../api/lotReceivingApi";
import { formatDateTime as formatDate, formatDateKey } from "../../utils/dateUtils";

const ProductDetailModal = ({
  productId,
  productsById,
  categoriesById,
  receipts,
  vendorNameById,
  rowLookup,
  rowUnitLookup = {},
  rowNameCache,
  getReceiptLocations,
  onClose,
}) => {
  const [modalExpiryStartDate, setModalExpiryStartDate] = useState("");
  const [modalExpiryEndDate, setModalExpiryEndDate] = useState("");
  const [modalExpiryFilter, setModalExpiryFilter] = useState("all");
  const [expirySortDirection, setExpirySortDirection] = useState("desc");
  // receiptId -> the racks THAT delivery was put away on, replayed from the
  // event ledger. One request for the product, not one per row.
  const [receivedRows, setReceivedRows] = useState({});

  useEffect(() => {
    if (!productId) return undefined;
    let cancelled = false;
    receivedInto(productId)
      .then((data) => { if (!cancelled) setReceivedRows(data || {}); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [productId]);

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

  // A lot-counted receipt has no location of its own — `receipts.location` and
  // `storage_row_id` are both null on one, because its placement lives in the
  // ledger. So getReceiptLocations, which reads those two columns, returns
  // nothing and both columns fall to an em dash on exactly the deliveries whose
  // position is known best: the gun records them drum by drum.
  //
  // Ask the ledger first, and only fall back to the receipt's own columns.
  const ledgerLocations = (r) => {
    const putAway = receivedRows[r.id];
    if (!putAway?.length) return null;
    const labels = Array.from(
      new Set(putAway.map((x) => x.location_label).filter(Boolean)),
    );
    return labels.length ? labels : null;
  };

  const lots = Array.from(new Set(detailReceipts.map(r => r.lotNo).filter(Boolean)));
  const locationTotals = {};
  detailReceipts.forEach(r => {
    const qty = Number(r.quantity) || 0;
    const fromLedger = ledgerLocations(r);
    const labels = fromLedger || getReceiptLocations(r).map(l => l.label);
    labels.forEach(label => {
      locationTotals[label] = (locationTotals[label] || 0) + qty;
    });
  });

  const allProductReceipts = receipts.filter(r => r.productId === productId);

  // WHERE THE LOT'S CONTAINERS ARE *NOW* (2026-09-17). The projection JSON is
  // rewritten from the placement ledger on every mutation, so its entries are
  // the live per-rack truth. `project_lot` writes the whole lot's picture on
  // the lot's NEWEST receipt and blanks older ones — so collect per LOT here
  // and show the same live answer on every receipt row of that lot.
  const lotCurrentRows = {};
  allProductReceipts.forEach((r) => {
    if (!r.materialLotId) return;
    const entries = (r.rawMaterialRowAllocations || []).filter(
      (a) => a && a.rowName
        && (Number(a.units) > 0 || Number(a.openUnits) > 0),
    );
    if (entries.length) lotCurrentRows[r.materialLotId] = entries;
  });

  // ONE ROW PER LOT (2026-09-17). The table is titled "Lots", but it used to
  // render one row per RECEIPT — so a lot with three deliveries appeared three
  // times, each row pairing that delivery's remaining lbs with the WHOLE
  // lot's rack picture. The numbers could never agree read row-by-row.
  // Grouped, every column describes the same thing: the lot. Deliveries fold
  // into a count, and quantity Σ vs racks must now match by construction.
  const displayGroups = [];
  {
    const byLot = {};
    detailReceipts.forEach((r) => {
      if (r.materialLotId) {
        if (byLot[r.materialLotId]) {
          byLot[r.materialLotId].receipts.push(r);
          return;
        }
        const group = { key: r.materialLotId, receipts: [r] };
        byLot[r.materialLotId] = group;
        displayGroups.push(group);
      } else {
        displayGroups.push({ key: r.id, receipts: [r] });
      }
    });
  }

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
                Showing {displayGroups.length} lots ({detailReceipts.length} of {allProductReceipts.length} deliveries)
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
            <div style={{ overflowX: 'auto' }}>
            <table className="simple-table compact">
              <thead>
                <tr>
                  <th className="hide-mobile">Lot</th>
                  {/* Beside the lot, not on the product row outside. The
                      vendor is part of the lot key, so every lot has exactly
                      ONE — which makes it a fact with a quantity attached
                      here, where "Davaraj, ITC, +2" on the product row was
                      just a list you could not do anything with. */}
                  <th className="hide-mobile">Vendor</th>
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
                {displayGroups.map(group => {
                  // The first delivery stands in for lot-constant fields
                  // (vendor, unit, expiration); sums cover the rest.
                  const r = group.receipts[0];
                  const deliveries = group.receipts.length;
                  const totalQty = group.receipts.reduce(
                    (s, x) => s + (Number(x.quantity) || 0), 0);
                  const totalReceived = group.receipts.reduce(
                    (s, x) => s + (Number(x.containerCount) || 0), 0);
                  // Drums remaining, each delivery priced at ITS OWN weight
                  // (the 14×200 + 12×210 rule) — null when any delivery
                  // can't answer.
                  let drumsRemaining = 0;
                  let drumsKnown = true;
                  group.receipts.forEach((x) => {
                    const wpc = Number(x.weightPerContainer) || 0;
                    if (wpc > 0) {
                      drumsRemaining += (Number(x.quantity) || 0) / wpc;
                    } else if (Number(x.quantity) > 0) {
                      drumsKnown = false;
                    }
                  });
                  drumsRemaining = Math.round(drumsRemaining * 100) / 100;
                  const weightSet = Array.from(new Set(
                    group.receipts
                      .map((x) => Number(x.weightPerContainer) || 0)
                      .filter((w) => w > 0),
                  ));
                  const anyHold = group.receipts.some((x) => x.hold);
                  const totalHeld = group.receipts.reduce(
                    (s, x) => s + (Number(x.heldQuantity || x.held_quantity) || 0), 0);
                  const statuses = Array.from(new Set(
                    group.receipts.map((x) => x.status).filter(Boolean)));
                  const latestReceiptDate = group.receipts
                    .map((x) => x.approvedAt || x.submittedAt || x.receiptDate)
                    .filter(Boolean)
                    .sort()
                    .pop() || null;

                  const locations = getReceiptLocations(r);
                  const rowDetail = locations[0]?.detail || '';
                  const locationLabel =
                    ledgerLocations(r)?.join(', ') || locations[0]?.label || '—';

                  let rowDisplay = '—';
                  // WHERE THE CONTAINERS ARE NOW, from the live projection of
                  // the placement ledger (2026-09-17). This column used to
                  // show the intake put-away — "where it WENT" — which read
                  // "ROW 4 (18 drums)" forever while 13 of them were long
                  // inside a batch and the rest had moved to the Aisle.
                  // Current place and count is the question the reader is
                  // actually asking; "(N received)" in the quantity column
                  // already carries the history.
                  const current = r.materialLotId
                    ? lotCurrentRows[r.materialLotId]
                    : null;
                  const putAway = receivedRows[r.id];
                  if (current?.length) {
                    rowDisplay = current
                      .map((x) => {
                        const units = Number(x.units) || 0;
                        const opens = Number(x.openUnits) || 0;
                        const unit = x.unitLabel
                          || rowUnitLookup[x.rowId]
                          || 'unit';
                        const openNote = opens > 0 ? ` +${opens} open` : '';
                        return `${x.rowName} (${units} ${unit}${units === 1 ? '' : 's'}${openNote})`;
                      })
                      .join(', ');
                  } else if (r.materialLotId && (putAway?.length || rowDetail)) {
                    // A counted lot with zero on any rack: consumed or pulled
                    // to production. Honest, and distinct from "unknown".
                    rowDisplay = 'none on racks';
                  } else if (putAway?.length) {
                    // "(68)" alone leaves the reader to guess the unit beside a
                    // quantity given in lbs. The room names it: Apple Barn
                    // shelves drums, so 68 there is 68 drums.
                    rowDisplay = putAway
                      .map((x) => {
                        const unit = x.unit_label
                          || rowUnitLookup[x.storage_row_id]
                          || 'pallets';
                        return `${x.storage_row_name} (${x.units} ${unit})`;
                      })
                      .join(', ');
                  } else if (rowDetail) {
                    rowDisplay = rowDetail.replace('Rows: ', '').replace('Row: ', '');
                  } else if (r.materialLotId) {
                    rowDisplay = '—';
                  } else if (r.storageRowId || r.storage_row_id) {
                    const rowId = r.storageRowId || r.storage_row_id;
                    const rowName = rowLookup[rowId] || rowNameCache[rowId];
                    const pallets = r.pallets || 0;

                    // The room's own word — a drum rack holds drums, not
                    // pallets, and saying otherwise names a unit it never uses.
                    const footprint = rowUnitLookup[rowId] || 'pallets';
                    const suffix = pallets > 0 ? ` (${pallets} ${footprint})` : '';
                    rowDisplay = `${rowName || rowId}${suffix}`;
                  }

                  return (
                    <tr key={group.key}>
                      <td className="hide-mobile">
                        {r.lotNo || '—'}
                        {deliveries > 1 && (
                          <div style={{ fontSize: '0.72rem', color: '#666' }}>
                            {deliveries} deliveries
                          </div>
                        )}
                      </td>
                      <td className="hide-mobile">
                        {vendorNameById?.[r.vendorId] || <span className="muted">—</span>}
                      </td>
                      <td className="hide-tablet">{locationLabel}</td>
                      <td className="hide-tablet">{rowDisplay}</td>
                      <td>
                        {totalQty.toLocaleString()} {r.quantityUnits || ''}
                        {totalReceived > 0 && drumsKnown && (
                          <div style={{ fontSize: '0.75rem', color: '#666' }}>
                            {(() => {
                              const unit = r.containerUnit || 'drums';
                              const weightNote = weightSet.length === 1
                                ? ` × ${weightSet[0]} ${r.weightUnit || 'lbs'}`
                                : '';
                              if (drumsRemaining !== totalReceived) {
                                return `(~${drumsRemaining} ${unit} remaining (${totalReceived} received)${weightNote})`;
                              }
                              return `(${totalReceived} ${unit}${weightNote})`;
                            })()}
                          </div>
                        )}
                      </td>
                      <td className="capitalize">{statuses.join(', ')}</td>
                      <td className="hide-mobile">
                        {(() => {
                          const holdLoc = r.holdLocation || r.hold_location || null;
                          if (totalHeld > 0) {
                            const locLabel = holdLoc ? ` (${holdLoc})` : '';
                            return <span className="chip chip-hold">{totalHeld.toLocaleString()} on Hold{locLabel}</span>;
                          } else if (anyHold) {
                            return <span className="chip chip-hold">Hold</span>;
                          } else {
                            return <span className="chip chip-clear">Clear</span>;
                          }
                        })()}
                      </td>
                      <td className="hide-mobile">
                        {formatDate(latestReceiptDate) || '—'}
                        {deliveries > 1 && (
                          <div style={{ fontSize: '0.72rem', color: '#666' }}>
                            latest of {deliveries}
                          </div>
                        )}
                      </td>
                      <td className="hide-mobile">{formatDateKey(r.expiration) || formatDateKey(r.expirationDate) || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
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
