import React from "react";
import { useAuth } from "../../context/AuthContext";
import { useAppData } from "../../context/AppDataContext";
import { useConfirm } from "../../context/ConfirmContext";
import { useToast } from "../../context/ToastContext";
import { formatTimeAgo, getDaysAgo } from "../../utils/dateUtils";
import { pluralizeUnit, singularUnit } from "../../utils/rowSources";

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
    'used-in-production': 'Used in Production',
    'production-consumption': 'Production Consumption',
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
  const { addToast } = useToast();
  const [actingId, setActingId] = React.useState(null);
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
        // Finished Goods adjustments are pallet-based and carry no receiptId —
        // the form sends pallet_licence_ids instead. Everything here was
        // resolved through the receipt, so those cards rendered "Unknown
        // Product", an em-dash lot, and no quantity panel at all: an approval
        // screen that never said what was being approved. The adjustment itself
        // carries the product and the cases, so read them from it directly.
        const palletCount = adjustment.palletLicenceIds?.length || 0;
        const isPalletBased = palletCount > 0;
        const product = productLookup[receipt?.productId || adjustment.productId];
        const category = categoryLookup[receipt?.categoryId || adjustment.categoryId];
        const days = getDaysAgo(adjustment.submittedAt);
        const priority = getPriorityLevel(days);
        const typeStyle = adjustmentTypeColors[adjustment.adjustmentType] || { bg: '#f3f4f6', color: '#374151' };
        // A lot received on several trucks is several receipts; "current" is
        // the LOT, not the one delivery this adjustment is filed under — that
        // read "656 → −1004 → 0" (2026-10-01 PART 3, B7).
        const lotReceipts = receipt?.materialLotId
          ? Object.values(receiptLookup).filter((r) => r.materialLotId === receipt.materialLotId
            && ['approved', 'depleted'].includes(String(r.status)))
          : (receipt ? [receipt] : []);
        const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
        const currentQty = round2(lotReceipts.reduce((t, r) => t + (Number(r.quantity) || 0), 0));
        const adjQty = round2(adjustment.quantity);
        const afterQty = round2(Math.max(0, currentQty - adjQty));
        // Which rack, how many containers, what they weigh — as submitted.
        const rackNames = {};
        lotReceipts.forEach((r) => (r.rawMaterialRowAllocations || []).forEach((a) => {
          if (a?.rowId) rackNames[a.rowId] = a.rowName || rackNames[a.rowId];
        }));
        const containerWord = receipt?.containerUnit || 'unit';
        const rackLines = (adjustment.sourceBreakdown || []).map((b) => {
          const rowId = String(b?.id || '').replace(/^row-/, '');
          const units = b?.units != null ? Number(b.units) : null;
          const part = Number(b?.open_qty) || 0;
          const bits = [];
          if (units) bits.push(`${units} ${units === 1 ? singularUnit(containerWord) : pluralizeUnit(singularUnit(containerWord))}`);
          if (part) bits.push(`${round2(part).toLocaleString()} ${receipt?.quantityUnits || 'lbs'} of a part ${singularUnit(containerWord)}`);
          return `${rackNames[rowId] || rowId}: ${bits.join(' + ') || ''}${bits.length ? ' — ' : ''}${round2(b?.quantity).toLocaleString()} ${receipt?.quantityUnits || 'lbs'}`;
        });
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

            {/* Pallet-based adjustments have no receipt to read a before/after
                from, so state the removal on its own rather than hiding the
                panel and leaving the approver with no quantity at all. */}
            {!receipt && isPalletBased && (
              <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px 16px', marginBottom: '12px' }}>
                <div style={{ fontSize: '12px', color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '10px' }}>Quantity Impact</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '15px' }}>
                  <div style={{ textAlign: 'center', padding: '6px 12px', background: '#fee2e2', borderRadius: '8px' }}>
                    <div style={{ fontSize: '11px', color: '#991b1b', marginBottom: '2px' }}>Removing</div>
                    <div style={{ fontWeight: 700, fontSize: '18px', color: '#dc2626' }}>−{adjQty}</div>
                    <div style={{ fontSize: '11px', color: '#991b1b' }}>cases</div>
                  </div>
                  <div style={{ fontSize: '13px', color: '#6b7280' }}>
                    from {palletCount} {palletCount === 1 ? 'pallet' : 'pallets'}
                  </div>
                </div>
              </div>
            )}

            {rackLines.length > 0 && (
              <ul style={{ margin: '0 0 8px', paddingLeft: '18px', fontSize: '13px', color: '#374151' }}>
                {rackLines.map((line) => <li key={line}>{line}</li>)}
              </ul>
            )}

            {/* Before / After quantity panel */}
            {receipt && (
              <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px 16px', marginBottom: '12px' }}>
                <div style={{ fontSize: '12px', color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '10px' }}>Quantity Impact</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '15px' }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '2px' }}>Current</div>
                    <div style={{ fontWeight: 700, fontSize: '18px', color: '#111827' }}>{currentQty.toLocaleString()}</div>
                    <div style={{ fontSize: '11px', color: '#6b7280' }}>{receipt.quantityUnits || 'cases'}</div>
                  </div>
                  <div style={{ fontSize: '20px', color: '#9ca3af', flex: 1, textAlign: 'center' }}>
                    {isIncrease ? '↑' : '→'}
                  </div>
                  <div style={{ textAlign: 'center', padding: '6px 12px', background: '#fee2e2', borderRadius: '8px' }}>
                    <div style={{ fontSize: '11px', color: '#991b1b', marginBottom: '2px' }}>Adjusting by</div>
                    <div style={{ fontWeight: 700, fontSize: '18px', color: '#dc2626' }}>−{adjQty.toLocaleString()}</div>
                    <div style={{ fontSize: '11px', color: '#991b1b' }}>{receipt.quantityUnits || 'cases'}</div>
                  </div>
                  <div style={{ fontSize: '20px', color: '#9ca3af', flex: 1, textAlign: 'center' }}>→</div>
                  <div style={{ textAlign: 'center', padding: '6px 12px', background: afterQty === 0 ? '#fee2e2' : '#f0fdf4', borderRadius: '8px' }}>
                    <div style={{ fontSize: '11px', color: afterQty === 0 ? '#991b1b' : '#166534', marginBottom: '2px' }}>After</div>
                    <div style={{ fontWeight: 700, fontSize: '18px', color: afterQty === 0 ? '#dc2626' : '#16a34a' }}>{afterQty.toLocaleString()}</div>
                    <div style={{ fontSize: '11px', color: afterQty === 0 ? '#991b1b' : '#166534' }}>{receipt.quantityUnits || 'cases'}</div>
                  </div>
                </div>
              </div>
            )}

            <dl className="summary-grid">
              {/* A pallet-based adjustment has no single lot to name — the lot
                  lives on each pallet, which this view does not load. The
                  pallet count is what actually identifies it, and beats the
                  em-dash that was here. */}
              <div>
                <dt>{isPalletBased ? 'Pallets' : 'Lot Number'}</dt>
                <dd>{isPalletBased ? palletCount : (receipt?.lotNo || '—')}</dd>
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
                disabled={actingId === adjustment.id}
                onClick={() => {
                  // 'cases' rather than 'units' as the fallback: the only time
                  // there is no receipt is a pallet-based FG adjustment, which
                  // is always measured in cases (adjustments.py:79).
                  confirm(`Approve this ${getAdjustmentTypeLabel(adjustment.adjustmentType).toLowerCase()} of ${adjQty} ${receipt?.quantityUnits || 'cases'}?`).then(async ok => {
                    if (!ok) return;
                    setActingId(adjustment.id);
                    const res = await approveAdjustment(adjustment.id, user?.id || user?.username);
                    setActingId(null);
                    if (!res?.success) addToast(res?.error || 'Failed to approve adjustment', 'error');
                  });
                }}
                style={{ marginRight: '8px' }}
              >
                Approve
              </button>
              <button
                type="button"
                className="secondary-button danger"
                disabled={actingId === adjustment.id}
                onClick={() => {
                  confirm('Reject this adjustment?').then(async ok => {
                    if (!ok) return;
                    setActingId(adjustment.id);
                    const res = await rejectAdjustment(adjustment.id, '', user?.id || user?.username);
                    setActingId(null);
                    if (!res?.success) addToast(res?.error || 'Failed to reject adjustment', 'error');
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
