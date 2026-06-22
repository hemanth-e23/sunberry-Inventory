import React, { useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { useAppData } from "../../context/AppDataContext";
import { useConfirm } from "../../context/ConfirmContext";
import { useToast } from "../../context/ToastContext";
import { formatDateTime, formatTime, formatTimeAgo, getDaysAgo } from "../../utils/dateUtils";

const getPriorityLevel = (days) => {
  if (days === 0) return { level: 'low', label: 'New', color: '#10b981' };
  if (days < 3) return { level: 'low', label: 'Recent', color: '#10b981' };
  if (days < 7) return { level: 'medium', label: 'Moderate', color: '#f59e0b' };
  return { level: 'high', label: 'Urgent', color: '#ef4444' };
};

const TransfersTab = ({ pendingTransfers, receiptLookup, productLookup, rowLookup, locationLookupMap, userNameMap }) => {
  const { user } = useAuth();
  const { approveTransfer, rejectTransfer, fetchTransferScanProgress, voidShipOutTransfer } = useAppData();
  const { confirm } = useConfirm();
  const { addToast } = useToast();

  const [transferScanProgress, setTransferScanProgress] = useState({});
  // Transfer id currently being approved/rejected — disables its buttons so a
  // slow request can't be double-submitted.
  const [actingId, setActingId] = useState(null);

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
      const pallets = (item?.pallets === undefined || item?.pallets === null) ? null : Number(item.pallets);
      if (id.startsWith('row-')) {
        const rowId = id.replace('row-', '');
        return { label: rowLookup[rowId] || rowId, cases: item?.quantity || 0, pallets };
      }
      return { label: id === 'floor' ? 'Floor Staging' : id, cases: item?.quantity || 0, pallets };
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
        // Quantity unit comes from the lot itself (lbs/barrels/units for raw
        // materials & packaging, cases for finished goods) — never hardcode "cases".
        const unit = receipt?.quantityUnits || 'cases';
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

        const transferLines = transfer.lines || null;
        const isMultiProduct = Array.isArray(transferLines) && transferLines.length > 0;

        // Aggregate DB sub-lines by (product, lot) for display. A single UI
        // line can fan out to multiple DB rows (one per receipt) under v2 —
        // and drift sub-lines can add extra rows for the same lot. The
        // approver thinks in lots, so we collapse the receipt-level split.
        const aggregatedLines = (() => {
          if (!isMultiProduct) return [];
          const map = new Map();
          for (const ln of transferLines) {
            const palletCount = (ln.pallet_licence_ids || []).length;
            const allocs = ln.lot_allocations || [];

            if (allocs.length === 0) {
              // Legacy / v1 lines with no lot_allocations — keyed by line's
              // own lot_number (derived from receipt on the backend).
              const key = `${ln.product_id}__${ln.lot_number || '—'}`;
              const e = map.get(key) || {
                id: key,
                product_name: ln.product_name,
                product_fcc_code: ln.product_fcc_code,
                lot_number: ln.lot_number || '—',
                cases_requested: 0,
                cases_picked: 0,
                pallet_licence_ids: [],
              };
              e.cases_requested += Number(ln.cases_requested) || 0;
              e.cases_picked += Number(ln.cases_picked) || 0;
              e.pallet_licence_ids = e.pallet_licence_ids.concat(ln.pallet_licence_ids || []);
              map.set(key, e);
              continue;
            }

            const totalPicked = allocs.reduce((s, a) => s + (Number(a.cases_picked) || 0), 0);
            allocs.forEach((alloc, idx) => {
              const lot = alloc.lot_number || '—';
              const key = `${ln.product_id}__${lot}`;
              const e = map.get(key) || {
                id: key,
                product_name: ln.product_name,
                product_fcc_code: ln.product_fcc_code,
                lot_number: lot,
                cases_requested: 0,
                cases_picked: 0,
                pallet_licence_ids: [],
              };
              e.cases_requested += Number(alloc.cases_requested) || 0;
              e.cases_picked += Number(alloc.cases_picked) || 0;
              // Pallet attribution: in the common case a sub-line has one
              // lot allocation, so all of its pallets belong here. With
              // multiple lot allocations on a sub-line (rare — drift or
              // escape hatch), split proportionally to cases_picked.
              if (allocs.length === 1) {
                if (idx === 0) {
                  e.pallet_licence_ids = e.pallet_licence_ids.concat(ln.pallet_licence_ids || []);
                }
              } else if (totalPicked > 0 && (Number(alloc.cases_picked) || 0) > 0) {
                const share = Math.round(
                  palletCount * ((Number(alloc.cases_picked) || 0) / totalPicked)
                );
                // Approximate — exact pallet→lot resolution would need
                // pallet enrichment, which we skip for the approver view.
                e.pallet_licence_ids = e.pallet_licence_ids.concat(
                  (ln.pallet_licence_ids || []).slice(0, share)
                );
              }
              map.set(key, e);
            });
          }
          return Array.from(map.values()).sort((a, b) =>
            String(a.lot_number).localeCompare(String(b.lot_number))
          );
        })();
        const allSwaps = transfer.swaps || progress?.swaps || [];
        // A removal (unscan) is recorded as a one-sided swap: removed pallet,
        // no added pallet. Real swaps have both sides.
        const swaps = allSwaps.filter((s) => s.added_pallet_id);
        const removals = allSwaps.filter((s) => !s.added_pallet_id && s.removed_pallet_id);
        const headerTitle = isMultiProduct
          ? (transfer.orderNumber || transfer.order_number || `Order ${transfer.id.slice(-8)}`)
          : (product?.name || 'Unknown Product');
        const productSummary = isMultiProduct
          ? (() => {
              const names = Array.from(new Set(transferLines.map(l => l.product_name).filter(Boolean)));
              if (names.length <= 2) return names.join(' + ');
              return `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;
            })()
          : null;

        return (
          <article key={transfer.id} className="approval-card" style={{ maxWidth: '720px' }}>
            <header>
              <div>
                <h3>{headerTitle}</h3>
                {productSummary && (
                  <div style={{ fontSize: '13px', color: '#475569', marginTop: '2px' }}>
                    {transferLines.length} product line{transferLines.length !== 1 ? 's' : ''}: {productSummary}
                  </div>
                )}
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
                <dd>{transfer.quantity} {unit}</dd>
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

            {/* Multi-product line breakdown */}
            {isMultiProduct && (
              <div style={{ marginBottom: '10px', borderRadius: '8px', overflowX: 'auto', border: '1px solid #e5e7eb' }}>
                <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f1f5f9' }}>
                      <th style={{ textAlign: 'left', padding: '6px 10px', color: '#1e293b', fontWeight: 600 }}>Product</th>
                      <th style={{ textAlign: 'left', padding: '6px 10px', color: '#1e293b', fontWeight: 600 }}>FCC</th>
                      <th style={{ textAlign: 'left', padding: '6px 10px', color: '#1e293b', fontWeight: 600 }}>Lot #</th>
                      <th style={{ textAlign: 'right', padding: '6px 10px', color: '#1e293b', fontWeight: 600 }}>Requested</th>
                      <th style={{ textAlign: 'right', padding: '6px 10px', color: '#1e293b', fontWeight: 600 }}>Picked</th>
                      <th style={{ textAlign: 'right', padding: '6px 10px', color: '#1e293b', fontWeight: 600 }}>Pallets</th>
                    </tr>
                  </thead>
                  <tbody>
                    {aggregatedLines.map((ln, i) => (
                      <tr key={ln.id} style={{ borderTop: i ? '1px solid #e5e7eb' : 'none', background: i % 2 === 0 ? '#fafbfc' : 'white' }}>
                        <td style={{ padding: '6px 10px' }}>{ln.product_name || ln.product_id}</td>
                        <td style={{ padding: '6px 10px', color: '#64748b' }}>{ln.product_fcc_code || '—'}</td>
                        <td style={{ padding: '6px 10px', color: '#64748b' }}>{ln.lot_number || '—'}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right' }}>{(ln.cases_requested || 0).toLocaleString()}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 600 }}>
                          {(ln.cases_picked || 0).toLocaleString()}
                          {(ln.cases_picked || 0) > (ln.cases_requested || 0) && (
                            <span style={{ marginLeft: '6px', background: '#fef3c7', color: '#92400e', borderRadius: '4px', padding: '1px 5px', fontSize: '10px', fontWeight: 700 }}>
                              +{((ln.cases_picked || 0) - (ln.cases_requested || 0)).toLocaleString()} over
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '6px 10px', textAlign: 'right' }}>{(ln.pallet_licence_ids || []).length}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Swap log */}
            {swaps.length > 0 && (
              <div style={{ background: '#fefce8', border: '1px solid #fde68a', borderRadius: '8px', padding: '8px 12px', marginBottom: '10px', fontSize: '12px', color: '#713f12' }}>
                <div style={{ fontWeight: 600, marginBottom: '4px' }}>
                  🔁 {swaps.length} pallet swap{swaps.length !== 1 ? 's' : ''}
                </div>
                {swaps.map((s) => (
                  <div key={s.id || `${s.removed_pallet_id}-${s.added_pallet_id}`}>
                    <span style={{ fontFamily: 'monospace' }}>{s.removed_licence_number || '?'}</span>
                    {' → '}
                    <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{s.added_licence_number || '?'}</span>
                    {s.swapped_by_name || s.swapped_by ? ` · by ${s.swapped_by_name || s.swapped_by}` : ''}
                    {s.source ? ` (${s.source === 'forklift' ? 'forklift' : 'warehouse edit'})` : ''}
                  </div>
                ))}
              </div>
            )}

            {/* Removals: pallets the forklift took back off the order */}
            {removals.length > 0 && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', padding: '8px 12px', marginBottom: '10px', fontSize: '12px', color: '#991b1b' }}>
                <div style={{ fontWeight: 600, marginBottom: '4px' }}>
                  ⚠ {removals.length} pallet{removals.length !== 1 ? 's' : ''} removed during picking
                </div>
                {removals.map((s) => (
                  <div key={s.id || s.removed_pallet_id}>
                    <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{s.removed_licence_number || '?'}</span>
                    {' — '}
                    {s.reason === 'leaker_damaged'
                      ? 'damaged / leaker (placed on hold)'
                      : s.reason === 'wrong_pallet'
                        ? 'wrong pallet (returned to stock)'
                        : (s.reason || 'removed')}
                    {s.swapped_by_name || s.swapped_by ? ` · by ${s.swapped_by_name || s.swapped_by}` : ''}
                  </div>
                ))}
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
                    <div style={{ maxHeight: '200px', overflowY: 'auto', overflowX: 'auto', borderRadius: '6px', border: '1px solid #bae6fd' }}>
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
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px' }}>
                  <div>
                    <div style={{ fontWeight: 600, color: '#6b7280', marginBottom: '4px' }}>From</div>
                    {sourceRows.length > 0 ? (
                      <ul style={{ margin: 0, paddingLeft: '18px' }}>
                        {sourceRows.map((r, i) => <li key={i}>{r.label} — {r.cases} {unit}{r.pallets !== null ? `, ${r.pallets} pallet${r.pallets === 1 ? '' : 's'}` : ''}</li>)}
                      </ul>
                    ) : (
                      <div>{locationLookupMap[transfer.fromLocation] || transfer.fromLocation || '—'}</div>
                    )}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, color: '#6b7280', marginBottom: '4px' }}>To</div>
                    {destRows.length > 0 ? (
                      <ul style={{ margin: 0, paddingLeft: '18px' }}>
                        {destRows.map((r, i) => <li key={i}>{r.label} — {r.cases} {unit}{r.pallets !== null ? `, ${r.pallets} pallet${r.pallets === 1 ? '' : 's'}` : ''}</li>)}
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
                {(userNameMap[transfer.submittedBy] || '?')[0].toUpperCase()}
              </span>
              <span className="requester-label">
                <strong>{userNameMap[transfer.submittedBy] || 'Unknown'}</strong> requested this · {formatTimeAgo(transfer.submittedAt || transfer.submitted_at)}
              </span>
            </div>

            <footer>
              <button
                type="button"
                className="secondary-button"
                disabled={actingId === transfer.id}
                onClick={() => {
                  const msg = forkliftDone
                    ? `Approve ship-out order ${transfer.orderNumber || transfer.order_number}?\n\n${scannedCount}/${totalPallets} pallets scanned${skippedCount > 0 ? `, ${skippedCount} skipped` : ''}.\n\nThis will subtract ${transfer.quantity} cases from inventory.`
                    : 'Approve this transfer?';
                  confirm(msg).then(async ok => {
                    if (!ok) return;
                    setActingId(transfer.id);
                    const res = await approveTransfer(transfer.id, user?.id || user?.username);
                    setActingId(null);
                    if (!res?.success) addToast(res?.error || 'Failed to approve transfer', 'error');
                  });
                }}
                style={{ marginRight: '8px' }}
              >
                {isShipOut ? '✓ Approve & Deduct Inventory' : 'Approve'}
              </button>
              {isShipOut ? (
                <button
                  type="button"
                  className="secondary-button danger"
                  onClick={() => {
                    confirm(
                      `Void this ship-out order (${transfer.orderNumber || transfer.order_number || transfer.id.slice(-8)})? All reserved pallets will go back to in-stock.`
                    ).then(async (ok) => {
                      if (!ok) return;
                      const result = await voidShipOutTransfer(transfer.id);
                      if (result.success) {
                        addToast('Order voided. Pallets released.', 'success');
                      } else {
                        addToast(result.error || 'Void failed', 'error');
                      }
                    });
                  }}
                >
                  Void Order
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary-button danger"
                  disabled={actingId === transfer.id}
                  onClick={() => {
                    confirm('Reject this transfer?').then(async ok => {
                      if (!ok) return;
                      setActingId(transfer.id);
                      // NOTE: rejectTransfer is (id, reason, approverId) — the old
                      // call passed the user id as the reason.
                      const res = await rejectTransfer(transfer.id, '', user?.id || user?.username);
                      setActingId(null);
                      if (!res?.success) addToast(res?.error || 'Failed to reject transfer', 'error');
                    });
                  }}
                >
                  Reject
                </button>
              )}
            </footer>
          </article>
        );
      })}
    </div>
  );
};

export default TransfersTab;
