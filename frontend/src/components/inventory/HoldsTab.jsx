import React, { useMemo, useState, useCallback } from 'react';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import SearchableSelect from '../SearchableSelect';
import PalletPicker from './PalletPicker';
import apiClient from '../../api/client';
import { formatDateTime } from '../../utils/dateUtils';
import '../InventoryActionsPage.css';
import { CATEGORY_TYPES, HOLD_STATUS, RECEIPT_STATUS } from '../../constants';

const HoldsTab = () => {
  const { addToast } = useToast();
  const { user } = useAuth();
  const {
    products,
    categories,
    receipts,
    users,
    inventoryHoldActions,
    submitHoldAction,
  } = useAppData();

  // Which main tab is active: 'fg' or 'rm'
  const [activeTab, setActiveTab] = useState('fg');

  // ─── Finished Goods state ──────────────────────────────────────────────────
  const [fgProductId, setFgProductId] = useState('');
  const [fgMode, setFgMode] = useState('hold'); // 'hold' | 'release'
  const [fgPallets, setFgPallets] = useState([]);
  const [fgPalletsLoading, setFgPalletsLoading] = useState(false);
  const [fgSelectedIds, setFgSelectedIds] = useState([]); // array for PalletPicker
  const [fgReason, setFgReason] = useState('');
  const [fgError, setFgError] = useState('');
  const [fgSubmitting, setFgSubmitting] = useState(false);

  // ─── Raw Materials / Packaging state ─────────────────────────────────────
  const [rmReceiptId, setRmReceiptId] = useState('');
  const [rmReason, setRmReason] = useState('');
  const [rmError, setRmError] = useState('');
  const [rmSubmitting, setRmSubmitting] = useState(false);

  // ─── Lookups ──────────────────────────────────────────────────────────────
  const productLookup = useMemo(() => {
    const map = {};
    products.forEach(p => { map[p.id] = p; });
    return map;
  }, [products]);

  const categoryLookup = useMemo(() => {
    const map = {};
    categories.forEach(c => { map[c.id] = c; });
    return map;
  }, [categories]);

  const userLookup = useMemo(() => {
    const map = {};
    users.forEach(u => {
      const label = u.name || u.username;
      map[u.id] = label;
      map[u.username] = label;
    });
    return map;
  }, [users]);

  // ─── FG products (have in-stock pallets) ──────────────────────────────────
  const fgProducts = useMemo(() => {
    const fgProductIds = new Set(
      receipts
        .filter(r => r.status === RECEIPT_STATUS.APPROVED && r.quantity > 0)
        .filter(r => categoryLookup[r.categoryId]?.type === CATEGORY_TYPES.FINISHED)
        .map(r => r.productId)
    );
    return products
      .filter(p => categoryLookup[p.categoryId]?.type === CATEGORY_TYPES.FINISHED && fgProductIds.has(p.id))
      .map(p => ({ value: p.id, label: String(p.name || 'Unknown') }));
  }, [products, receipts, categoryLookup]);

  // ─── RM/PKG receipts ──────────────────────────────────────────────────────
  const rmReceipts = useMemo(() =>
    receipts.filter(r =>
      ['approved', 'recorded', 'reviewed'].includes(r.status) &&
      r.quantity > 0 &&
      categoryLookup[r.categoryId]?.type !== CATEGORY_TYPES.FINISHED &&
      categoryLookup[r.categoryId]?.type !== 'group'
    ),
    [receipts, categoryLookup]
  );

  const selectedRmReceipt = useMemo(
    () => rmReceipts.find(r => r.id === rmReceiptId),
    [rmReceipts, rmReceiptId]
  );

  const formatReceiptLabel = (receipt) => {
    const product = productLookup[receipt.productId];
    const category = categoryLookup[receipt.categoryId];
    const holdLabel = receipt.hold ? ' [ON HOLD]' : '';
    return `${String(product?.name || 'Unknown')} · Lot ${String(receipt.lotNo || '-')} · ${String(category?.name || '')}${holdLabel}`;
  };

  // ─── Fetch pallets when FG product or mode changes ────────────────────────
  const fetchFgPallets = useCallback(async (productId, mode) => {
    if (!productId) {
      setFgPallets([]);
      setFgSelectedIds([]);
      return;
    }
    setFgPalletsLoading(true);
    setFgPallets([]);
    setFgSelectedIds([]);
    setFgError('');
    try {
      const params = { product_id: productId, status: 'in_stock', is_held: mode === 'release' };
      const response = await apiClient.get('/pallet-licences/', { params });
      setFgPallets(response.data || []);
    } catch {
      setFgError('Failed to load pallets.');
    } finally {
      setFgPalletsLoading(false);
    }
  }, []);

  const handleFgProductChange = (productId) => {
    setFgProductId(productId);
    setFgError('');
    fetchFgPallets(productId, fgMode);
  };

  const handleFgModeChange = (mode) => {
    setFgMode(mode);
    setFgError('');
    fetchFgPallets(fgProductId, mode);
  };

  // ─── Submit FG hold ───────────────────────────────────────────────────────
  const handleFgSubmit = async (e) => {
    e.preventDefault();
    if (!fgProductId) { setFgError('Select a product.'); return; }
    if (fgSelectedIds.length === 0) { setFgError('Select at least one pallet.'); return; }
    if (!fgReason.trim()) { setFgError('Provide a reason.'); return; }

    setFgSubmitting(true);
    const result = await submitHoldAction({
      action: fgMode,
      reason: fgReason.trim(),
      palletLicenceIds: fgSelectedIds,
      submittedBy: user?.id || user?.username,
    });
    setFgSubmitting(false);

    if (result.success) {
      setFgProductId('');
      setFgPallets([]);
      setFgSelectedIds([]);
      setFgReason('');
      setFgError('');
      addToast('Hold request submitted successfully.', 'success');
    } else {
      const msg = typeof result.error === 'object' ? JSON.stringify(result.error) : (result.error || 'Failed to submit.');
      setFgError(msg);
      addToast(msg, 'error');
    }
  };

  // ─── Submit RM hold ───────────────────────────────────────────────────────
  const handleRmSubmit = async (e) => {
    e.preventDefault();
    if (!rmReceiptId) { setRmError('Select a lot.'); return; }
    if (!rmReason.trim()) { setRmError('Provide a reason.'); return; }
    if (!selectedRmReceipt) { setRmError('Selected lot not found.'); return; }

    const pendingHold = inventoryHoldActions.find(
      a => a.receiptId === rmReceiptId && a.status === HOLD_STATUS.PENDING
    );
    if (pendingHold) {
      setRmError(`This lot already has a pending ${pendingHold.action} request.`);
      return;
    }

    const action = selectedRmReceipt.hold ? 'release' : 'hold';
    setRmSubmitting(true);
    const result = await submitHoldAction({
      receiptId: rmReceiptId,
      action,
      reason: rmReason.trim(),
      submittedBy: user?.id || user?.username,
    });
    setRmSubmitting(false);

    if (result.success) {
      setRmReceiptId('');
      setRmReason('');
      setRmError('');
      addToast('Hold request submitted successfully.', 'success');
    } else {
      const msg = typeof result.error === 'object' ? JSON.stringify(result.error) : (result.error || 'Failed to submit.');
      setRmError(msg);
      addToast(msg, 'error');
    }
  };

  // ─── Recent hold history ──────────────────────────────────────────────────
  const recentHolds = useMemo(
    () => inventoryHoldActions.slice().reverse().slice(0, 4),
    [inventoryHoldActions]
  );

  return (
    <div className="tab-panel">
      {/* Main tab toggle */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '20px', borderBottom: '2px solid #e5e7eb' }}>
        <button
          type="button"
          onClick={() => setActiveTab('fg')}
          style={{
            padding: '8px 16px',
            border: 'none',
            borderBottom: activeTab === 'fg' ? '2px solid #2563eb' : '2px solid transparent',
            background: 'none',
            fontWeight: activeTab === 'fg' ? 700 : 400,
            color: activeTab === 'fg' ? '#2563eb' : '#6b7280',
            cursor: 'pointer',
            marginBottom: '-2px',
          }}
        >
          Finished Goods
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('rm')}
          style={{
            padding: '8px 16px',
            border: 'none',
            borderBottom: activeTab === 'rm' ? '2px solid #2563eb' : '2px solid transparent',
            background: 'none',
            fontWeight: activeTab === 'rm' ? 700 : 400,
            color: activeTab === 'rm' ? '#2563eb' : '#6b7280',
            cursor: 'pointer',
            marginBottom: '-2px',
          }}
        >
          Raw Materials &amp; Packaging
        </button>
      </div>

      <div className="split">
        {/* ── Finished Goods Tab ── */}
        {activeTab === 'fg' && (
          <form onSubmit={handleFgSubmit} className="action-form">
            <h3>Hold / Release — Finished Goods Pallets</h3>
            <p className="muted small">Select a product, then pick individual pallets to hold or release.</p>

            <label>
              <span>Product</span>
              <SearchableSelect
                options={fgProducts}
                value={fgProductId}
                onChange={handleFgProductChange}
                placeholder="Select finished goods product"
                searchPlaceholder="Search products..."
              />
            </label>

            <label>
              <span>Action</span>
              <select
                value={fgMode}
                onChange={(e) => handleFgModeChange(e.target.value)}
              >
                <option value="hold">Place on Hold</option>
                <option value="release">Release Hold</option>
              </select>
            </label>

            {fgProductId && (
              <div style={{ marginTop: '4px' }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-muted)' }}>
                  {fgMode === 'hold' ? 'Select pallets to hold' : 'Select pallets to release'}
                </span>
                <PalletPicker
                  pallets={fgPallets}
                  selectedIds={fgSelectedIds}
                  onChange={setFgSelectedIds}
                  loading={fgPalletsLoading}
                  emptyMessage={fgMode === 'hold' ? 'No in-stock pallets found for this product.' : 'No held pallets found for this product.'}
                />
              </div>
            )}

            <label className="full-width" style={{ marginTop: '12px' }}>
              <span>Reason / Notes <span className="required">*</span></span>
              <textarea
                value={fgReason}
                onChange={(e) => setFgReason(e.target.value)}
                rows={3}
                required
              />
            </label>

            {fgError && <div className="form-error">{fgError}</div>}

            <div className="form-actions">
              <button type="submit" className="primary-button" disabled={fgSubmitting || fgSelectedIds.length === 0}>
                {fgSubmitting
                  ? 'Submitting…'
                  : fgSelectedIds.length > 0
                    ? `Submit ${fgMode === 'hold' ? 'Hold' : 'Release'} (${fgSelectedIds.length} pallets)`
                    : `Submit ${fgMode === 'hold' ? 'Hold' : 'Release'} Request`}
              </button>
            </div>
          </form>
        )}

        {/* ── Raw Materials & Packaging Tab ── */}
        {activeTab === 'rm' && (
          <form onSubmit={handleRmSubmit} className="action-form">
            <h3>Hold / Release — Raw Materials &amp; Packaging Lots</h3>
            <p className="muted small">Select a lot. The action (hold or release) is determined automatically by the lot's current state.</p>

            <label>
              <span>Inventory Lot</span>
              <SearchableSelect
                options={rmReceipts.map(r => ({
                  value: r.id,
                  label: formatReceiptLabel(r),
                }))}
                value={rmReceiptId}
                onChange={(id) => {
                  setRmReceiptId(id);
                  setRmError('');
                }}
                placeholder="Select lot"
                searchPlaceholder="Type to search lots…"
              />
            </label>

            {selectedRmReceipt && (
              <div style={{ background: selectedRmReceipt.hold ? '#fffbeb' : '#f0fdf4', border: `1px solid ${selectedRmReceipt.hold ? '#fde68a' : '#bbf7d0'}`, borderRadius: '8px', padding: '12px 16px', marginTop: '8px' }}>
                <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>
                  {selectedRmReceipt.hold ? '🔒 Entire lot is on hold — submit to release' : '✅ Lot is available — submit to place on hold'}
                </div>
                <div style={{ fontSize: '13px', color: '#6b7280' }}>
                  Lot {selectedRmReceipt.lotNo || '—'} · {(selectedRmReceipt.quantity || 0).toLocaleString()} {selectedRmReceipt.quantityUnits || 'cases'}
                </div>
              </div>
            )}

            <label className="full-width" style={{ marginTop: '12px' }}>
              <span>Reason / Notes <span className="required">*</span></span>
              <textarea
                value={rmReason}
                onChange={(e) => setRmReason(e.target.value)}
                rows={3}
                required
              />
            </label>

            {rmError && <div className="form-error">{rmError}</div>}

            <div className="form-actions">
              <button type="submit" className="primary-button" disabled={rmSubmitting || !rmReceiptId}>
                {rmSubmitting ? 'Submitting…' : selectedRmReceipt?.hold ? 'Submit Release Request' : 'Submit Hold Request'}
              </button>
            </div>
          </form>
        )}

        {/* ── Hold History (right panel) ── */}
        <div className="action-list">
          <h3>Hold History</h3>
          <ul>
            {recentHolds.map(action => {
              const isPallet = action.palletLicenceIds?.length > 0;
              const receipt = receipts.find(r => r.id === action.receiptId);
              const product = productLookup[receipt?.productId];
              return (
                <li key={action.id}>
                  <div className="item-main">
                    <strong>{product?.name || (isPallet ? 'Pallet Hold' : 'Unknown')}</strong>
                    <span className={`status-badge status-${action.status}`}>{action.status}</span>
                  </div>
                  <div className="item-meta">
                    <span>{action.action === 'hold' ? 'Hold' : 'Release'}</span>
                    {isPallet
                      ? <span>{action.palletLicenceIds.length} pallet(s) · {(action.totalQuantity || 0).toLocaleString()} cases</span>
                      : receipt && <span>Lot {receipt.lotNo || '—'}</span>
                    }
                    <span>Requested: {formatDateTime(action.submittedAt)}</span>
                    {action.approvedBy && (
                      <span>Approved by: {userLookup[action.approvedBy] || action.approvedBy}</span>
                    )}
                  </div>
                </li>
              );
            })}
            {!inventoryHoldActions.length && <li className="empty">No hold requests yet.</li>}
          </ul>
        </div>
      </div>

      {/* ── Currently on hold ── */}
      <div className="on-hold-grid">
        <h3>Currently On Hold</h3>
        <div className="card-grid">
          {receipts.filter(r => r.hold).map(receipt => {
            const lastHold = inventoryHoldActions
              .filter(a => a.receiptId === receipt.id && a.status === HOLD_STATUS.APPROVED && a.action === 'hold')
              .slice(-1)[0];
            return (
              <div key={receipt.id} className="hold-card">
                <span className="title">{formatReceiptLabel(receipt)}</span>
                <span className="meta">Since: {lastHold ? formatDateTime(lastHold.approvedAt || lastHold.submittedAt) : 'Pending'}</span>
                <span className="meta">Placed By: {lastHold ? (userLookup[lastHold.submittedBy] || lastHold.submittedBy) : '-'}</span>
                {receipt.heldQuantity > 0 && (
                  <span className="meta">Held: {receipt.heldQuantity} {receipt.quantityUnits || 'cases'}</span>
                )}
              </div>
            );
          })}
          {!receipts.some(r => r.hold) && (
            <div className="empty">No inventory currently on hold.</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default HoldsTab;
