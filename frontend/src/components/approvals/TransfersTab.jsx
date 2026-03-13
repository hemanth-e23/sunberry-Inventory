import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { useAppData } from "../../context/AppDataContext";
import { useConfirm } from "../../context/ConfirmContext";
import { formatDateTime, formatTime, formatTimeAgo, getDaysAgo } from "../../utils/dateUtils";

const getPriorityLevel = (days) => {
  if (days === 0) return { level: 'low', label: 'New', color: '#10b981' };
  if (days < 3) return { level: 'low', label: 'Recent', color: '#10b981' };
  if (days < 7) return { level: 'medium', label: 'Moderate', color: '#f59e0b' };
  return { level: 'high', label: 'Urgent', color: '#ef4444' };
};

const TransfersTab = ({ pendingTransfers, receiptLookup, productLookup, rowLookup, locationLookupMap, userNameMap }) => {
  const { user } = useAuth();
  const { approveTransfer, rejectTransfer, fetchTransferScanProgress } = useAppData();
  const { confirm } = useConfirm();

  const [transferScanProgress, setTransferScanProgress] = useState({});

  // Poll scan progress for pending ship-out transfers (live update)
  useEffect(() => {
    const shipOuts = pendingTransfers.filter(
      (t) => t.transferType === 'shipped-out' && (t.palletLicenceIds || t.pallet_licence_ids || []).length > 0
    );
    if (shipOuts.length === 0) {
      setTransferScanProgress({});
      return;
    }
    const load = async () => {
      const next = {};
      for (const t of shipOuts) {
        try {
          const data = await fetchTransferScanProgress(t.id);
          if (data) next[t.id] = data;
        } catch (_) { // ignore
        }
      }
      setTransferScanProgress((prev) => ({ ...prev, ...next }));
    };
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [pendingTransfers, fetchTransferScanProgress]);

  if (pendingTransfers.length === 0) {
    return (
      <div className="empty-state" style={{ padding: '48px', textAlign: 'center' }}>
        <p>No pending transfers.</p>
      </div>
    );
  }

  const formatBreakdownRows = (breakdown) => {
    if (!breakdown || !Array.isArray(breakdown)) return [];
    return breakdown.map((item) => {
      const id = item?.id || '';
      if (id.startsWith('row-')) {
        const rowId = id.replace('row-', '');
        return { label: rowLookup[rowId] || rowId, cases: item?.quantity || 0 };
      }
      return { label: id === 'floor' ? 'Floor Staging' : id, cases: item?.quantity || 0 };
    });
  };

  const manualRefreshProgress = async (transferId) => {
    try {
      const data = await fetchTransferScanProgress(transferId);
      if (data) setTransferScanProgress((prev) => ({ ...prev, [transferId]: data }));
    } catch (_) { // ignore
    }
  };

  return (
    <div className="card-grid">
      {pendingTransfers.map((transfer) => {
        const receipt = receiptLookup[transfer.receiptId];
        const product = productLookup[receipt?.productId];
        const days = getDaysAgo(transfer.submittedAt);
        const priority = getPriorityLevel(days);
        const sourceRows = formatBreakdownRows(transfer.sourceBreakdown);
        const destRows = formatBreakdownRows(transfer.destinationBreakdown);
        const isShipOut = transfer.transferType === 'shipped-out' || transfer.transfer_type === 'shipped-out';
        const hasPallets = (transfer.palletLicenceIds || transfer.pallet_licence_ids || []).length > 0;
        const progress = transferScanProgress[transfer.id];
        const pickList = progress?.pick_list || [];
        const scannedCount = pickList.filter(p => p.is_scanned).length;
        const skippedCount = pickList.filter(p => p.is_skipped).length;
        const totalPallets = pickList.length || progress?.total_pallets || 0;
        const forkliftDone = !!(progress?.forklift_submitted_at || transfer.forklift_submitted_at);
        const lastScan = progress?.last_scan;
        const exceptions = progress?.exceptions || [];

        return (
          <article key={transfer.id} className="approval-card" style={{ maxWidth: '720px' }}>
            <header>
              <div>
                <h3>{product?.name || "Unknown Product"}</h3>
                <span className="badge">{isShipOut ? 'Shipped Out' : (transfer.reason || 'Transfer')}</span>
                {isShipOut && forkliftDone && (
                  <span style={{ marginLeft: '8px', background: '#22c55e', color: 'white', borderRadius: '999px', padding: '2px 10px', fontSize: '12px', fontWeight: 600 }}>
                    ✓ Forklift Done
                  </span>
                )}
                {isShipOut && !forkliftDone && hasPallets && (
                  <span style={{ marginLeft: '8px', background: '#f59e0b', color: 'white', borderRadius: '999px', padding: '2px 10px', fontSize: '12px', fontWeight: 600 }}>
                    Picking in progress
                  </span>
                )}
              </div>
              <div className="meta">
                <button
                  type="button"
                  onClick={() => manualRefreshProgress(transfer.id)}
                  style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: '6px', padding: '4px 8px', cursor: 'pointer', fontSize: '12px', color: '#6b7280', marginRight: '6px' }}
                  title="Refresh progress"
                >
                  ↻ Refresh
                </button>
                <span className="priority-badge" style={{ background: priority.color, color: 'white' }}>
                  {priority.label}
                </span>
              </div>
            </header>

            <dl className="summary-grid">
              <div>
                <dt>Quantity</dt>
                <dd>{transfer.quantity} cases</dd>
              </div>
              {isShipOut && (transfer.orderNumber || transfer.order_number) && (
                <div>
                  <dt>Order #</dt>
                  <dd>{transfer.orderNumber || transfer.order_number}</dd>
                </div>
              )}
              <div>
                <dt>Created</dt>
                <dd>{formatDateTime(transfer.submittedAt || transfer.submitted_at)}</dd>
              </div>
              {forkliftDone && (
                <div>
                  <dt>Forklift submitted</dt>
                  <dd style={{ color: '#22c55e', fontWeight: 600 }}>
                    {formatDateTime(progress?.forklift_submitted_at || transfer.forklift_submitted_at)}
                  </dd>
                </div>
              )}
            </dl>

            {/* Forklift notes */}
            {forkliftDone && (progress?.forklift_notes || transfer.forklift_notes) && (
              <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '8px', padding: '10px 14px', marginBottom: '10px', fontSize: '13px', color: '#166534' }}>
                <strong>Forklift note:</strong> {progress?.forklift_notes || transfer.forklift_notes}
              </div>
            )}

            {/* Pallet warehouse transfer: show clear FROM → TO with pallet table */}
            {hasPallets && !isShipOut && (() => {
              const palletDetails = transfer.palletLicenceDetails || [];
              const fromLocations = [...new Set(palletDetails.map(p => p.location).filter(Boolean))];
              const toLabel = destRows[0]?.label || locationLookupMap[transfer.toLocation] || '—';
              const palletCount = (transfer.palletLicenceIds || transfer.pallet_licence_ids || []).length;
              return (
                <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '8px', padding: '12px 14px', marginBottom: '10px', fontSize: '13px' }}>
                  {/* Movement summary row */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: palletDetails.length ? '10px' : 0, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: '100px' }}>
                      <div style={{ fontSize: '11px', fontWeight: 600, color: '#0369a1', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' }}>Moving from</div>
                      {fromLocations.length > 0
                        ? fromLocations.map((loc, i) => (
                            <div key={i} style={{ fontWeight: 600, color: '#1e3a5f' }}>{loc}</div>
                          ))
                        : <div style={{ color: '#6b7280' }}>—</div>
                      }
                    </div>
                    <div style={{ fontSize: '22px', color: '#6366f1', paddingTop: '14px', flexShrink: 0 }}>→</div>
                    <div style={{ flex: 1, minWidth: '100px' }}>
                      <div style={{ fontSize: '11px', fontWeight: 600, color: '#0369a1', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' }}>Moving to</div>
                      <div style={{ fontWeight: 600, color: '#1e3a5f' }}>{toLabel}</div>
                    </div>
                    <div style={{ marginLeft: 'auto', textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: '11px', fontWeight: 600, color: '#0369a1', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' }}>Pallets</div>
                      <div style={{ fontWeight: 700, color: '#1e3a5f' }}>{palletCount} pallets · {(transfer.quantity || 0).toLocaleString()} cs</div>
                    </div>
                  </div>

                  {/* Per-pallet details */}
                  {palletDetails.length > 0 && (
                    <div style={{ maxHeight: '200px', overflowY: 'auto', borderRadius: '6px', border: '1px solid #bae6fd', overflow: 'hidden' }}>
                      <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ background: '#e0f2fe' }}>
                            <th style={{ textAlign: 'left', padding: '5px 8px', color: '#0369a1', fontWeight: 600 }}>Licence #</th>
                            <th style={{ textAlign: 'left', padding: '5px 8px', color: '#0369a1', fontWeight: 600 }}>Current Location</th>
                            <th style={{ textAlign: 'right', padding: '5px 8px', color: '#0369a1', fontWeight: 600 }}>Cases</th>
                          </tr>
                        </thead>
                        <tbody>
                          {palletDetails.map((p, i) => (
                            <tr key={p.id} style={{ borderBottom: '1px solid #e0f2fe', background: i % 2 === 0 ? '#f0f9ff' : 'white' }}>
                              <td style={{ padding: '5px 8px', fontFamily: 'monospace', fontWeight: 700, color: '#1e40af' }}>{p.licence_number}</td>
                              <td style={{ padding: '5px 8px', color: '#374151' }}>{p.location || '—'}</td>
                              <td style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 600 }}>{(p.cases || 0).toLocaleString()} cs</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* RM / non-pallet transfer: show source → dest rows */}
            {!hasPallets && (sourceRows.length > 0 || destRows.length > 0) && (
              <div style={{ background: '#f9fafb', borderRadius: '8px', padding: '10px 14px', marginBottom: '10px', fontSize: '13px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div>
                    <div style={{ fontWeight: 600, color: '#6b7280', marginBottom: '4px' }}>From</div>
                    {sourceRows.length > 0 ? (
                      <ul style={{ margin: 0, paddingLeft: '18px' }}>
                        {sourceRows.map((r, i) => <li key={i}>{r.label} — {r.cases} cases</li>)}
                      </ul>
                    ) : (
                      <div>{locationLookupMap[transfer.fromLocation] || transfer.fromLocation || '—'}</div>
                    )}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, color: '#6b7280', marginBottom: '4px' }}>To</div>
                    {destRows.length > 0 ? (
                      <ul style={{ margin: 0, paddingLeft: '18px' }}>
                        {destRows.map((r, i) => <li key={i}>{r.label} — {r.cases} cases</li>)}
                      </ul>
                    ) : (
                      <div>{locationLookupMap[transfer.toLocation] || transfer.toLocation || '—'}</div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Ship-out pallet pick list with scan status */}
            {isShipOut && hasPallets && (
              <div style={{ marginBottom: '10px' }}>
                {/* Progress header */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div style={{ fontWeight: 600, fontSize: '13px', color: '#374151' }}>
                    Pallet Pick List
                  </div>
                  <div style={{ fontSize: '13px', color: '#6b7280' }}>
                    <span style={{ color: '#22c55e', fontWeight: 700 }}>{scannedCount}</span>
                    {skippedCount > 0 && <span style={{ color: '#f59e0b', fontWeight: 700 }}> + {skippedCount} skipped</span>}
                    <span> / {totalPallets} pallets</span>
                  </div>
                </div>

                {/* Progress bar */}
                {totalPallets > 0 && (
                  <div style={{ height: '6px', background: '#e5e7eb', borderRadius: '999px', overflow: 'hidden', marginBottom: '8px' }}>
                    <div style={{ height: '100%', width: `${(scannedCount / totalPallets) * 100}%`, background: 'linear-gradient(90deg, #22c55e, #16a34a)', borderRadius: '999px', transition: 'width 0.4s' }} />
                  </div>
                )}

                {/* Per-pallet checklist */}
                {pickList.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '220px', overflowY: 'auto' }}>
                    {pickList.map((pallet) => (
                      <div
                        key={pallet.pallet_id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          padding: '6px 10px',
                          borderRadius: '8px',
                          fontSize: '12px',
                          background: pallet.is_scanned ? '#f0fdf4' : pallet.is_skipped ? '#fffbeb' : '#f9fafb',
                          border: `1.5px solid ${pallet.is_scanned ? '#86efac' : pallet.is_skipped ? '#fde68a' : '#e5e7eb'}`,
                        }}
                      >
                        <span style={{ fontSize: '16px', lineHeight: 1 }}>
                          {pallet.is_scanned ? '✅' : pallet.is_skipped ? '⏭' : '⬜'}
                        </span>
                        <span style={{ fontFamily: 'monospace', fontWeight: 600, color: '#1e40af' }}>{pallet.licence_number}</span>
                        <span style={{ color: '#6b7280' }}>{pallet.location}</span>
                        <span style={{ color: '#6b7280' }}>· {pallet.cases} cs</span>
                        {pallet.is_scanned && pallet.scanned_at && (
                          <span style={{ marginLeft: 'auto', color: '#22c55e', fontSize: '11px' }}>
                            {formatTime(pallet.scanned_at)}
                          </span>
                        )}
                        {pallet.is_skipped && (
                          <span style={{ marginLeft: 'auto', color: '#f59e0b', fontSize: '11px', fontWeight: 600 }}>Skipped</span>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: '12px', color: '#9ca3af', padding: '8px 0' }}>
                    Waiting for forklift to start scanning…
                  </div>
                )}

                {/* Last scan indicator */}
                {lastScan && (
                  <div style={{ marginTop: '8px', padding: '6px 10px', background: '#eff6ff', borderRadius: '6px', fontSize: '12px', color: '#1e40af' }}>
                    <strong>Last scan:</strong> {lastScan.licence_number}
                    {lastScan.scanned_by && ` · by ${lastScan.scanned_by}`}
                    {lastScan.scanned_at && ` · ${formatTime(lastScan.scanned_at)}`}
                  </div>
                )}

                {/* Exceptions */}
                {exceptions.length > 0 && (
                  <div style={{ marginTop: '8px', padding: '8px 12px', background: '#fef3c7', borderRadius: '8px', fontSize: '12px', color: '#92400e' }}>
                    <div style={{ fontWeight: 600, marginBottom: '4px' }}>⚠ {exceptions.length} exception{exceptions.length !== 1 ? 's' : ''} — pallets not on pick list:</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                      {exceptions.map((ex, i) => (
                        <span key={i} style={{ background: '#fde68a', padding: '2px 8px', borderRadius: '999px', fontFamily: 'monospace', fontSize: '11px' }}>
                          {ex.licence_number}{ex.scanned_by ? ` (${ex.scanned_by})` : ''}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="requester-row">
              <span className="requester-avatar">
                {(userNameMap[transfer.requestedBy || transfer.requested_by] || '?')[0].toUpperCase()}
              </span>
              <span className="requester-label">
                <strong>{userNameMap[transfer.requestedBy || transfer.requested_by] || 'Unknown'}</strong> requested this · {formatTimeAgo(transfer.submittedAt || transfer.submitted_at)}
              </span>
            </div>

            <footer>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  const msg = forkliftDone
                    ? `Approve ship-out order ${transfer.orderNumber || transfer.order_number}?\n\n${scannedCount}/${totalPallets} pallets scanned${skippedCount > 0 ? `, ${skippedCount} skipped` : ''}.\n\nThis will subtract ${transfer.quantity} cases from inventory.`
                    : 'Approve this transfer?';
                  confirm(msg).then(ok => {
                    if (ok) approveTransfer(transfer.id, user?.id || user?.username);
                  });
                }}
                style={{ marginRight: '8px' }}
              >
                {isShipOut ? '✓ Approve & Deduct Inventory' : 'Approve'}
              </button>
              <button
                type="button"
                className="secondary-button danger"
                onClick={() => {
                  confirm('Reject this transfer?').then(ok => {
                    if (ok) rejectTransfer(transfer.id, user?.id || user?.username);
                  });
                }}
              >
                Reject
              </button>
            </footer>
          </article>
        );
      })}
    </div>
  );
};

export default TransfersTab;
