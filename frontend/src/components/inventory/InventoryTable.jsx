import React, { useState, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

const InventoryTable = ({
  inventoryRows,
  onProductClick,
  onPrintClick,
}) => {
  const [visibleColumns, setVisibleColumns] = useState({
    product: true,
    category: true,
    type: true,
    locations: true,
    holdStatus: true,
    availableQty: true,
    lotsTracked: true,
    pendingReceipts: true,
    lastReceipt: true,
    lastApproval: true,
    description: true
  });

  const tableParentRef = useRef(null);

  const rowVirtualizer = useVirtualizer({
    count: inventoryRows.length,
    getScrollElement: () => tableParentRef.current,
    estimateSize: () => 52,
    overscan: 10,
  });

  return (
    <section className="panel">
      {/* Column Visibility Toggle */}
      <div className="column-controls">
        <span>Columns:</span>
        <div className="column-checkboxes">
          {Object.entries(visibleColumns).map(([key, visible]) => (
            <label key={key} className="checkbox-label small">
              <input
                type="checkbox"
                checked={visible}
                onChange={(e) => setVisibleColumns(prev => ({
                  ...prev,
                  [key]: e.target.checked
                }))}
              />
              <span>{key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1')}</span>
            </label>
          ))}
        </div>
        <button
          onClick={onPrintClick}
          className="print-btn"
        >
          Print Report
        </button>
      </div>

      <div ref={tableParentRef} className="table-wrapper virtual-table-container">
        <table className="simple-table enhanced-table">
          <thead>
            <tr>
              {visibleColumns.product && <th>Product</th>}
              {visibleColumns.category && <th className="hide-tablet">Category</th>}
              {visibleColumns.type && <th>Type</th>}
              {visibleColumns.locations && <th className="hide-tablet">Location(s)</th>}
              {visibleColumns.holdStatus && <th>Hold Status</th>}
              {visibleColumns.availableQty && <th>Available Qty</th>}
              {visibleColumns.lotsTracked && <th className="hide-tablet">Lots Tracked</th>}
              {visibleColumns.pendingReceipts && <th className="hide-tablet">Pending Receipts</th>}
              {visibleColumns.lastReceipt && <th className="hide-mobile">Last Receipt</th>}
              {visibleColumns.lastApproval && <th className="hide-mobile">Last Approval</th>}
              {visibleColumns.description && <th className="hide-mobile">Description</th>}
            </tr>
          </thead>
          <tbody>
            {inventoryRows.length === 0 ? (
              <tr>
                <td colSpan={11} className="empty">
                  No inventory found with the current filters.
                </td>
              </tr>
            ) : (() => {
              const virtualItems = rowVirtualizer.getVirtualItems();
              const totalSize = rowVirtualizer.getTotalSize();
              const firstItem = virtualItems[0];
              const lastItem = virtualItems[virtualItems.length - 1];
              const paddingTop = firstItem ? firstItem.start : 0;
              const paddingBottom = lastItem ? totalSize - lastItem.end : 0;
              const colCount = Object.values(visibleColumns).filter(Boolean).length;

              return (
                <>
                  {paddingTop > 0 && (
                    <tr><td colSpan={colCount} style={{ height: paddingTop, padding: 0 }} /></tr>
                  )}
                  {virtualItems.map(vRow => {
                    const row = inventoryRows[vRow.index];
                    const getRowClass = () => {
                      const classes = [];
                      if (row.quantity === 0) classes.push('zero-inventory');
                      if (row.holdActive) classes.push('on-hold');
                      if (row.pendingCount > 0) classes.push('has-pending');
                      if (row.quantity < 100) classes.push('low-stock');
                      return classes.join(' ');
                    };
                    const getQuantityClass = () => {
                      if (row.quantity === 0) return 'qty-zero';
                      if (row.quantity < 100) return 'qty-low';
                      if (row.quantity > 1000) return 'qty-high';
                      return 'qty-normal';
                    };
                    return (
                      <tr key={row.id} className={getRowClass()}>
                        {visibleColumns.product && <td>
                          <div className="product-cell">
                            <button
                              type="button"
                              className="link-plain"
                              onClick={() => onProductClick(row.id)}
                              title="View details"
                            >
                              <strong>{row.name}</strong>
                            </button>
                            {row.pendingCount > 0 && <span className="pending-badge">{row.pendingCount}</span>}
                          </div>
                        </td>}
                        {visibleColumns.category && <td className="hide-tablet">{row.category}</td>}
                        {visibleColumns.type && <td className="capitalize">{row.type}</td>}
                        {visibleColumns.locations && <td className="hide-tablet">
                          {row.locations.length ? (
                            <ul className="location-list compact">
                              {row.locations.map((loc, index) => (
                                <li key={`${row.id}-loc-${index}`}>
                                  <strong>{loc.label}</strong>
                                  {loc.detail && <span>{loc.detail}</span>}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>}
                        {visibleColumns.holdStatus && <td>
                          <span className={`chip ${row.holdActive ? "chip-hold" : "chip-clear"}`}>
                            {row.holdLabel}
                          </span>
                        </td>}
                        {visibleColumns.availableQty && <td>
                          <span className={`quantity-cell ${getQuantityClass()}`}>
                            {row.quantity.toLocaleString()} {row.unitLabel ? row.unitLabel : ''}
                          </span>
                          {row.containerInfo && (
                            <div style={{ fontSize: '0.75rem', color: '#666', marginTop: '2px' }}>
                              {row.containerInfo}
                            </div>
                          )}
                        </td>}
                        {visibleColumns.lotsTracked && <td className="hide-tablet">{row.lotCount}</td>}
                        {visibleColumns.pendingReceipts && <td className="hide-tablet">
                          {row.pendingCount > 0 ? (
                            <span className="pending-count">{row.pendingCount}</span>
                          ) : (
                            <span className="muted">0</span>
                          )}
                        </td>}
                        {visibleColumns.lastReceipt && <td className="hide-mobile">
                          <div className="cell-stack">
                            <span className="cell-main">{row.lastSubmittedBy}</span>
                            <span className="cell-sub">{row.lastSubmittedAt}</span>
                          </div>
                        </td>}
                        {visibleColumns.lastApproval && <td className="hide-mobile">
                          <div className="cell-stack">
                            <span className="cell-main">{row.lastApprovedBy}</span>
                            <span className="cell-sub">{row.lastApprovedAt}</span>
                          </div>
                        </td>}
                        {visibleColumns.description && <td className="hide-mobile">
                          <span className="muted">{row.description}</span>
                        </td>}
                      </tr>
                    );
                  })}
                  {paddingBottom > 0 && (
                    <tr><td colSpan={colCount} style={{ height: paddingBottom, padding: 0 }} /></tr>
                  )}
                </>
              );
            })()}
          </tbody>
        </table>
      </div>
    </section>
  );
};

export default InventoryTable;
