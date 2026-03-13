import React from "react";
import { useAuth } from "../../context/AuthContext";
import { useAppData } from "../../context/AppDataContext";
import { useConfirm } from "../../context/ConfirmContext";
import { formatTimeAgo, getDaysAgo } from "../../utils/dateUtils";

const getPriorityLevel = (days) => {
  if (days === 0) return { level: 'low', label: 'New', color: '#10b981' };
  if (days < 3) return { level: 'low', label: 'Recent', color: '#10b981' };
  if (days < 7) return { level: 'medium', label: 'Moderate', color: '#f59e0b' };
  return { level: 'high', label: 'Urgent', color: '#ef4444' };
};

const getAdjustmentTypeLabel = (type) => {
  const labels = {
    'stock-correction': 'Stock Correction',
    'damage-reduction': 'Damage Reduction',
    'donation': 'Donation',
    'trash-disposal': 'Trash Disposal',
    'quality-rejection': 'Quality Rejection',
    'shipped-out': 'Shipped Out',
  };
  return labels[type] || type;
};

const adjustmentTypeColors = {
  'stock-correction': { bg: '#eff6ff', color: '#1d4ed8' },
  'damage-reduction': { bg: '#fef3c7', color: '#92400e' },
  'donation': { bg: '#f0fdf4', color: '#166534' },
  'trash-disposal': { bg: '#fee2e2', color: '#991b1b' },
  'quality-rejection': { bg: '#fef3c7', color: '#92400e' },
  'shipped-out': { bg: '#f5f3ff', color: '#5b21b6' },
};

const AdjustmentsTab = ({ pendingAdjustments, receiptLookup, productLookup, categoryLookup, userNameMap }) => {
  const { user } = useAuth();
  const { approveAdjustment, rejectAdjustment } = useAppData();
  const { confirm } = useConfirm();

  if (pendingAdjustments.length === 0) {
    return (
      <div className="empty-state" style={{ padding: '48px', textAlign: 'center' }}>
        <p>No pending adjustments.</p>
      </div>
    );
  }

  return (
    <div className="card-grid">
      {pendingAdjustments.map((adjustment) => {
        const receipt = receiptLookup[adjustment.receiptId];
        const product = productLookup[receipt?.productId];
        const category = categoryLookup[receipt?.categoryId || adjustment.categoryId];
        const days = getDaysAgo(adjustment.submittedAt);
        const priority = getPriorityLevel(days);
        const typeStyle = adjustmentTypeColors[adjustment.adjustmentType] || { bg: '#f3f4f6', color: '#374151' };
        const currentQty = receipt?.quantity ?? 0;
        const adjQty = Number(adjustment.quantity) || 0;
        const afterQty = Math.max(0, currentQty - adjQty);
        const isIncrease = adjustment.adjustmentType === 'stock-correction' && adjQty > 0;

        return (
          <article key={adjustment.id} className="approval-card">
            <header>
              <div>
                <h3>{product?.name || "Unknown Product"}</h3>
                <span className="badge" style={{ background: typeStyle.bg, color: typeStyle.color }}>
                  {getAdjustmentTypeLabel(adjustment.adjustmentType)}
                </span>
                {category && <span className="badge" style={{ marginLeft: '6px' }}>{category.name}</span>}
              </div>
              <div className="meta">
                <span className="priority-badge" style={{ background: priority.color, color: 'white' }}>
                  {priority.label}
                </span>
              </div>
            </header>

            {/* Before / After quantity panel */}
            {receipt && (
              <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px 16px', marginBottom: '12px' }}>
                <div style={{ fontSize: '12px', color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '10px' }}>Quantity Impact</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '15px' }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '2px' }}>Current</div>
                    <div style={{ fontWeight: 700, fontSize: '18px', color: '#111827' }}>{currentQty}</div>
                    <div style={{ fontSize: '11px', color: '#6b7280' }}>{receipt.quantityUnits || 'cases'}</div>
                  </div>
                  <div style={{ fontSize: '20px', color: '#9ca3af', flex: 1, textAlign: 'center' }}>
                    {isIncrease ? '↑' : '→'}
                  </div>
                  <div style={{ textAlign: 'center', padding: '6px 12px', background: '#fee2e2', borderRadius: '8px' }}>
                    <div style={{ fontSize: '11px', color: '#991b1b', marginBottom: '2px' }}>Adjusting by</div>
                    <div style={{ fontWeight: 700, fontSize: '18px', color: '#dc2626' }}>−{adjQty}</div>
                    <div style={{ fontSize: '11px', color: '#991b1b' }}>{receipt.quantityUnits || 'cases'}</div>
                  </div>
                  <div style={{ fontSize: '20px', color: '#9ca3af', flex: 1, textAlign: 'center' }}>→</div>
                  <div style={{ textAlign: 'center', padding: '6px 12px', background: afterQty === 0 ? '#fee2e2' : '#f0fdf4', borderRadius: '8px' }}>
                    <div style={{ fontSize: '11px', color: afterQty === 0 ? '#991b1b' : '#166534', marginBottom: '2px' }}>After</div>
                    <div style={{ fontWeight: 700, fontSize: '18px', color: afterQty === 0 ? '#dc2626' : '#16a34a' }}>{afterQty}</div>
                    <div style={{ fontSize: '11px', color: afterQty === 0 ? '#991b1b' : '#166534' }}>{receipt.quantityUnits || 'cases'}</div>
                  </div>
                </div>
              </div>
            )}

            <dl className="summary-grid">
              <div>
                <dt>Lot Number</dt>
                <dd>{receipt?.lotNo || '—'}</dd>
              </div>
              {adjustment.recipient && (
                <div>
                  <dt>Recipient</dt>
                  <dd>{adjustment.recipient}</dd>
                </div>
              )}
              <div style={{ gridColumn: adjustment.recipient ? 'auto' : '1 / -1' }}>
                <dt>Reason</dt>
                <dd style={{ fontStyle: adjustment.reason ? 'normal' : 'italic', color: adjustment.reason ? 'inherit' : '#9ca3af' }}>{adjustment.reason || 'No reason provided'}</dd>
              </div>
            </dl>

            <div className="requester-row">
              <span className="requester-avatar">
                {(userNameMap[adjustment.submittedBy] || '?')[0].toUpperCase()}
              </span>
              <span className="requester-label">
                <strong>{userNameMap[adjustment.submittedBy] || 'Unknown'}</strong> requested this · {formatTimeAgo(adjustment.submittedAt)}
              </span>
            </div>

            <footer>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  confirm(`Approve this ${getAdjustmentTypeLabel(adjustment.adjustmentType).toLowerCase()} of ${adjQty} cases?`).then(ok => {
                    if (ok) approveAdjustment(adjustment.id, user?.id || user?.username);
                  });
                }}
                style={{ marginRight: '8px' }}
              >
                Approve
              </button>
              <button
                type="button"
                className="secondary-button danger"
                onClick={() => {
                  confirm('Reject this adjustment?').then(ok => {
                    if (ok) rejectAdjustment(adjustment.id, user?.id || user?.username);
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

export default AdjustmentsTab;
