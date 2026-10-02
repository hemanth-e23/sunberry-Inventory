import React from "react";
import { useAuth } from "../../context/AuthContext";
import { useAppData } from "../../context/AppDataContext";
import { useConfirm } from "../../context/ConfirmContext";
import { useToast } from "../../context/ToastContext";
import { formatTimeAgo, getDaysAgo } from "../../utils/dateUtils";
import { lotTotalText, lotHeldText, lotLocationText } from "../../utils/lotStatus";

const getPriorityLevel = (days) => {
  if (days === 0) return { level: 'low', label: 'New', color: '#10b981' };
  if (days < 3) return { level: 'low', label: 'Recent', color: '#10b981' };
  if (days < 7) return { level: 'medium', label: 'Moderate', color: '#f59e0b' };
  return { level: 'high', label: 'Urgent', color: '#ef4444' };
};

const HoldsTab = ({ pendingHolds, receiptLookup, productLookup, categoryLookup, locationLookupMap, userNameMap }) => {
  const { user } = useAuth();
  const { approveHoldAction, rejectHoldAction } = useAppData();
  const { confirm } = useConfirm();
  const { addToast } = useToast();
  const [actingId, setActingId] = React.useState(null);

  if (pendingHolds.length === 0) {
    return (
      <div className="empty-state" style={{ padding: '48px', textAlign: 'center' }}>
        <p>No pending hold requests.</p>
      </div>
    );
  }

  return (
    <div className="card-grid">
      {pendingHolds.map((hold) => {
        const isPalletHold = hold.palletLicenceIds?.length > 0;
        const receipt = receiptLookup[hold.receiptId];
        const palletProductId = isPalletHold ? hold.palletLicenceDetails?.[0]?.product_id : null;
        const product = productLookup[receipt?.productId] || (palletProductId ? productLookup[palletProductId] : null);
        const category = categoryLookup[receipt?.categoryId];
        const days = getDaysAgo(hold.submittedAt);
        const priority = getPriorityLevel(days);
        const isPlacingHold = hold.action === 'hold';

        return (
          <article key={hold.id} className="approval-card">
            <header>
              <div>
                <h3>{product?.name || (isPalletHold ? 'Pallet Hold' : 'Unknown Product')}</h3>
                <span className="badge" style={{ background: isPlacingHold ? '#fef3c7' : '#dcfce7', color: isPlacingHold ? '#92400e' : '#166534' }}>
                  {isPlacingHold ? '🔒 Place on Hold' : '🔓 Release Hold'}
                </span>
                {isPalletHold
                  ? <span className="badge" style={{ marginLeft: '6px', background: '#eff6ff', color: '#1d4ed8' }}>Finished Goods · Pallets</span>
                  : category && <span className="badge" style={{ marginLeft: '6px' }}>{category.name}</span>
                }
              </div>
              <div className="meta">
                <span className="priority-badge" style={{ background: priority.color, color: 'white' }}>
                  {priority.label}
                </span>
              </div>
            </header>

            {/* Hold action summary */}
            <div style={{ background: isPlacingHold ? '#fffbeb' : '#f0fdf4', border: `1px solid ${isPlacingHold ? '#fde68a' : '#bbf7d0'}`, borderRadius: '8px', padding: '12px 16px', marginBottom: '12px' }}>
              <div style={{ fontSize: '13px', color: '#374151', fontWeight: 600, marginBottom: '6px' }}>
                {isPlacingHold ? 'Requesting to place inventory on hold' : 'Requesting to release inventory from hold'}
              </div>

              {isPalletHold ? (
                /* Pallet hold summary */
                <div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', fontSize: '13px', marginBottom: '10px' }}>
                    <div>
                      <span style={{ color: '#6b7280' }}>Pallets</span>
                      <div style={{ fontWeight: 600, marginTop: '2px' }}>{hold.palletLicenceIds.length} pallet{hold.palletLicenceIds.length !== 1 ? 's' : ''}</div>
                    </div>
                    <div>
                      <span style={{ color: '#6b7280' }}>Total Cases</span>
                      <div style={{ fontWeight: 600, marginTop: '2px' }}>{(hold.totalQuantity ?? 0).toLocaleString()} cases</div>
                    </div>
                  </div>
                  {hold.palletLicenceDetails?.length > 0 && (
                    <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                          <th style={{ textAlign: 'left', padding: '4px 6px', color: '#6b7280', fontWeight: 500 }}>Licence #</th>
                          <th style={{ textAlign: 'left', padding: '4px 6px', color: '#6b7280', fontWeight: 500 }}>Location</th>
                          <th style={{ textAlign: 'right', padding: '4px 6px', color: '#6b7280', fontWeight: 500 }}>Cases</th>
                        </tr>
                      </thead>
                      <tbody>
                        {hold.palletLicenceDetails.map(p => (
                          <tr key={p.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                            <td style={{ padding: '4px 6px', fontFamily: 'monospace', fontWeight: 600 }}>{p.licence_number}</td>
                            <td style={{ padding: '4px 6px', color: '#374151' }}>{p.location}</td>
                            <td style={{ padding: '4px 6px', textAlign: 'right', fontWeight: 600 }}>{p.cases}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </div>
                  )}
                </div>
              ) : (
                /* Lot hold summary */
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', fontSize: '13px' }}>
                  <div>
                    <span style={{ color: '#6b7280' }}>Lot Number</span>
                    <div style={{ fontWeight: 600, marginTop: '2px' }}>{receipt?.lotNo || '—'}</div>
                  </div>
                  {/* The LOT now (every delivery, every rack) — not the named
                      receipt's paperwork or its last-transfer location, which
                      read "5,688 lbs" and "QA Quarantine" for a 13-drum lot on
                      the Drum Room racks (2026-10-01, B4/B5). */}
                  <div>
                    <span style={{ color: '#6b7280' }}>Lot Quantity</span>
                    <div style={{ fontWeight: 600, marginTop: '2px' }}>
                      {lotTotalText(hold.lotStatus)
                        || `${(receipt?.quantity ?? 0).toLocaleString()} ${receipt?.quantityUnits || 'cases'}`}
                    </div>
                  </div>
                  {lotHeldText(hold.lotStatus) && (
                    <div>
                      <span style={{ color: '#6b7280' }}>Currently on Hold</span>
                      <div style={{ fontWeight: 600, color: '#d97706', marginTop: '2px' }}>{lotHeldText(hold.lotStatus)}</div>
                    </div>
                  )}
                  {(() => {
                    const where = lotLocationText(hold.lotStatus)
                      || (!hold.lotStatus && (receipt?.locationId || receipt?.location)
                        ? locationLookupMap[receipt.subLocationId || receipt.subLocation || receipt.locationId || receipt.location]
                        : null);
                    return where ? (
                      <div>
                        <span style={{ color: '#6b7280' }}>Location</span>
                        <div style={{ fontWeight: 600, marginTop: '2px' }}>{where}</div>
                      </div>
                    ) : null;
                  })()}
                </div>
              )}
            </div>

            <dl className="summary-grid">
              <div style={{ gridColumn: '1 / -1' }}>
                <dt>Reason</dt>
                <dd style={{ fontStyle: hold.reason ? 'normal' : 'italic', color: hold.reason ? 'inherit' : '#9ca3af' }}>{hold.reason || 'No reason provided'}</dd>
              </div>
            </dl>

            <div className="requester-row">
              <span className="requester-avatar">
                {(userNameMap[hold.submittedBy] || '?')[0].toUpperCase()}
              </span>
              <span className="requester-label">
                <strong>{userNameMap[hold.submittedBy] || 'Unknown'}</strong> requested this · {formatTimeAgo(hold.submittedAt)}
              </span>
            </div>

            <footer>
              <button
                type="button"
                className="secondary-button"
                disabled={actingId === hold.id}
                onClick={() => {
                  confirm(`Approve ${isPlacingHold ? 'placing on hold' : 'releasing from hold'}?`).then(async ok => {
                    if (!ok) return;
                    setActingId(hold.id);
                    const res = await approveHoldAction(hold.id, user?.id || user?.username);
                    setActingId(null);
                    if (!res?.success) addToast(res?.error || 'Failed to approve hold', 'error');
                  });
                }}
                style={{ marginRight: '8px' }}
              >
                Approve
              </button>
              <button
                type="button"
                className="secondary-button danger"
                disabled={actingId === hold.id}
                onClick={() => {
                  confirm('Reject this hold request?').then(async ok => {
                    if (!ok) return;
                    setActingId(hold.id);
                    const res = await rejectHoldAction(hold.id, '', user?.id || user?.username);
                    setActingId(null);
                    if (!res?.success) addToast(res?.error || 'Failed to reject hold', 'error');
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

export default HoldsTab;
