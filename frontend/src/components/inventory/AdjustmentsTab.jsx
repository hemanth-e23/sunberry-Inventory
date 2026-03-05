import React, { useMemo, useState } from 'react';
import { useAppData } from '../../context/AppDataContext';
import { useToast } from '../../context/ToastContext';
import SearchableSelect from '../SearchableSelect';
import PalletPicker from './PalletPicker';
import { formatDateTime } from '../../utils/dateUtils';
import '../InventoryActionsPage.css';
import { CATEGORY_TYPES, RECEIPT_STATUS } from '../../constants';

const ADJUSTMENT_TYPES = [
  { value: 'stock-correction', label: 'Stock Correction' },
  { value: 'damage-reduction', label: 'Damage Reduction' },
  { value: 'donation', label: 'Donation' },
  { value: 'trash-disposal', label: 'Trash / Disposal' },
  { value: 'quality-rejection', label: 'Quality Rejection' },
];

const AdjustmentsTab = () => {
  const { addToast } = useToast();
  const {
    products,
    categories,
    categoryGroups,
    productCategories,
    receipts,
    inventoryAdjustments,
    submitAdjustment,
    fetchPalletLicences,
  } = useAppData();

  const [activeSubTab, setActiveSubTab] = useState('fg');

  // ─── Finished Goods (pallet-based) state ────────────────────────────────────
  const [fgProductId, setFgProductId] = useState('');
  const [fgPallets, setFgPallets] = useState([]);
  const [fgSelectedIds, setFgSelectedIds] = useState([]);
  const [fgAdjustmentType, setFgAdjustmentType] = useState('stock-correction');
  const [fgReason, setFgReason] = useState('');
  const [fgRecipient, setFgRecipient] = useState('');
  const [fgError, setFgError] = useState('');
  const [fgLoadError, setFgLoadError] = useState('');
  const [isLoadingFg, setIsLoadingFg] = useState(false);
  const [isSubmittingFg, setIsSubmittingFg] = useState(false);

  // ─── RM / Packaging (lot-based) state ───────────────────────────────────────
  const [rmForm, setRmForm] = useState({
    categoryGroupId: '',
    categoryId: '',
    productId: '',
    receiptId: '',
    adjustmentType: 'stock-correction',
    quantity: '',
    reason: '',
    recipient: '',
  });
  const [rmError, setRmError] = useState('');
  const [isSubmittingRm, setIsSubmittingRm] = useState(false);

  const approvedReceipts = useMemo(
    () => receipts.filter(r => r.status === RECEIPT_STATUS.APPROVED),
    [receipts]
  );

  const categoryLookup = useMemo(() => {
    const map = {};
    categories.forEach(c => { map[c.id] = c; });
    return map;
  }, [categories]);

  const productLookup = useMemo(() => {
    const map = {};
    products.forEach(p => { map[p.id] = p; });
    return map;
  }, [products]);

  // Finished goods products that have stock
  const fgProducts = useMemo(() => {
    const stockIds = new Set(approvedReceipts.filter(r => r.quantity > 0).map(r => r.productId));
    return products
      .filter(p => {
        const cat = categoryLookup[p.categoryId];
        return cat?.type === CATEGORY_TYPES.FINISHED && stockIds.has(p.id);
      })
      .map(p => ({ value: p.id, label: p.name }));
  }, [products, categoryLookup, approvedReceipts]);

  // Non-FG category groups for RM tab
  const rmCategoryGroups = useMemo(() =>
    categoryGroups.filter(g => {
      const subCats = productCategories.filter(c => c.parentId === g.id);
      return subCats.some(c => c.type !== CATEGORY_TYPES.FINISHED);
    }),
    [categoryGroups, productCategories]
  );

  const rmAvailableCategories = productCategories.filter(cat => {
    if (!rmForm.categoryGroupId) return false;
    return cat.parentId === rmForm.categoryGroupId && cat.type !== CATEGORY_TYPES.FINISHED;
  });

  const rmAvailableProducts = products.filter(p => p.categoryId === rmForm.categoryId);

  // ─── FG: load pallets ────────────────────────────────────────────────────────
  const loadFgPallets = async (productId) => {
    if (!productId) return;
    setIsLoadingFg(true);
    setFgPallets([]);
    setFgSelectedIds([]);
    setFgLoadError('');
    try {
      const data = await fetchPalletLicences({ product_id: productId, status: 'in_stock' });
      const sorted = (data || []).sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
      setFgPallets(sorted);
      if (!sorted.length) setFgLoadError('No pallets in stock for this product.');
    } catch {
      setFgLoadError('Failed to load pallets. Check connection and try again.');
    } finally {
      setIsLoadingFg(false);
    }
  };

  const selectedFgCases = fgPallets
    .filter(p => fgSelectedIds.includes(p.id))
    .reduce((s, p) => s + (p.cases || 0), 0);

  // ─── FG submit ───────────────────────────────────────────────────────────────
  const handleFgSubmit = async (e) => {
    e.preventDefault();
    if (!fgProductId) { setFgError('Select a product.'); return; }
    if (fgSelectedIds.length === 0) { setFgError('Select at least one pallet.'); return; }
    if (!fgReason.trim()) { setFgError('Reason is required.'); return; }

    const product = productLookup[fgProductId];
    setIsSubmittingFg(true);
    setFgError('');
    const result = await submitAdjustment({
      productId: fgProductId,
      categoryId: product?.categoryId || null,
      palletLicenceIds: fgSelectedIds,
      adjustmentType: fgAdjustmentType,
      reason: fgReason.trim(),
      recipient: fgRecipient.trim() || null,
    });
    setIsSubmittingFg(false);
    if (result.success) {
      setFgProductId('');
      setFgPallets([]);
      setFgSelectedIds([]);
      setFgReason('');
      setFgRecipient('');
      addToast('Adjustment submitted successfully.', 'success');
    } else {
      setFgError(result.error || 'Failed to submit adjustment.');
      addToast(result.error || 'Failed to submit adjustment.', 'error');
    }
  };

  // ─── RM submit ───────────────────────────────────────────────────────────────
  const handleRmSubmit = async (e) => {
    e.preventDefault();
    if (!rmForm.productId || !rmForm.receiptId) { setRmError('Select a product and lot.'); return; }
    if (!rmForm.quantity || Number(rmForm.quantity) <= 0) { setRmError('Enter a valid quantity.'); return; }
    if (!rmForm.reason.trim()) { setRmError('Reason is required.'); return; }

    setIsSubmittingRm(true);
    setRmError('');
    const result = await submitAdjustment({
      productId: rmForm.productId,
      categoryId: rmForm.categoryId,
      receiptId: rmForm.receiptId,
      adjustmentType: rmForm.adjustmentType,
      quantity: Number(rmForm.quantity),
      reason: rmForm.reason.trim(),
      recipient: rmForm.recipient.trim() || null,
    });
    setIsSubmittingRm(false);
    if (result.success) {
      setRmForm({ categoryGroupId: '', categoryId: '', productId: '', receiptId: '', adjustmentType: 'stock-correction', quantity: '', reason: '', recipient: '' });
      addToast('Adjustment submitted successfully.', 'success');
    } else {
      setRmError(result.error || 'Failed to submit adjustment.');
      addToast(result.error || 'Failed to submit adjustment.', 'error');
    }
  };

  const reasonPlaceholder = (type) => {
    switch (type) {
      case 'damage-reduction': return 'Describe the damage and cause...';
      case 'donation': return 'Describe the donation purpose and recipient...';
      case 'trash-disposal': return 'Describe why items need to be disposed...';
      case 'quality-rejection': return 'Describe the quality issue and rejection reason...';
      default: return 'Describe the stock discrepancy found...';
    }
  };

  // ─── Recent adjustments list ─────────────────────────────────────────────────
  const recentAdjustments = inventoryAdjustments.slice().reverse().slice(0, 5);

  return (
    <div className="tab-panel">
      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '1.25rem', borderBottom: '2px solid var(--color-border)', paddingBottom: '0' }}>
        {[
          { key: 'fg', label: 'Finished Goods' },
          { key: 'rm', label: 'Raw Materials & Packaging' },
        ].map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActiveSubTab(t.key)}
            style={{
              padding: '8px 20px',
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              fontWeight: activeSubTab === t.key ? 700 : 500,
              color: activeSubTab === t.key ? 'var(--color-primary)' : 'var(--color-text-muted)',
              borderBottom: activeSubTab === t.key ? '2px solid var(--color-primary)' : '2px solid transparent',
              marginBottom: '-2px',
              fontSize: '14px',
              transition: 'all 0.15s',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="split">
        {/* ── Left: form ── */}
        {activeSubTab === 'fg' ? (
          <form onSubmit={handleFgSubmit} className="action-form">
            <h3>Finished Goods Adjustment</h3>
            <p className="muted small">Select specific pallets to remove from inventory.</p>

            <label>
              <span>Product <span className="required">*</span></span>
              <SearchableSelect
                options={fgProducts}
                value={fgProductId}
                onChange={(id) => {
                  setFgProductId(id);
                  setFgPallets([]);
                  setFgSelectedIds([]);
                  setFgLoadError('');
                  if (id) loadFgPallets(id);
                }}
                placeholder="Select finished goods product"
                searchPlaceholder="Search products..."
              />
            </label>

            {fgLoadError && <div className="alert error">{fgLoadError}</div>}

            {(isLoadingFg || fgPallets.length > 0 || fgProductId) && (
              <div>
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-muted)' }}>
                  Select pallets to adjust
                </span>
                <PalletPicker
                  pallets={fgPallets}
                  selectedIds={fgSelectedIds}
                  onChange={setFgSelectedIds}
                  loading={isLoadingFg}
                  emptyMessage="No pallets in stock for this product."
                />
              </div>
            )}

            <label>
              <span>Adjustment Type <span className="required">*</span></span>
              <select value={fgAdjustmentType} onChange={e => setFgAdjustmentType(e.target.value)}>
                {ADJUSTMENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>

            {fgAdjustmentType === 'donation' && (
              <label>
                <span>Recipient (Optional)</span>
                <input
                  type="text"
                  value={fgRecipient}
                  onChange={e => setFgRecipient(e.target.value)}
                  placeholder="e.g., Community Food Bank"
                />
              </label>
            )}

            <label className="full-width">
              <span>Reason <span className="required">*</span></span>
              <textarea
                value={fgReason}
                onChange={e => setFgReason(e.target.value)}
                rows={3}
                placeholder={reasonPlaceholder(fgAdjustmentType)}
                required
              />
            </label>

            {fgError && <div className="alert error">{fgError}</div>}

            <div className="form-actions">
              <button
                type="submit"
                className="primary-button"
                disabled={isSubmittingFg || fgSelectedIds.length === 0}
              >
                {isSubmittingFg
                  ? 'Submitting...'
                  : fgSelectedIds.length > 0
                    ? `Submit Adjustment (${fgSelectedIds.length} pallets · ${selectedFgCases} cases)`
                    : 'Submit Adjustment'}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleRmSubmit} className="action-form">
            <h3>Raw Materials & Packaging Adjustment</h3>
            <p className="muted small">Select a lot and enter the quantity to remove.</p>

            <label>
              <span>Category</span>
              <select
                value={rmForm.categoryGroupId}
                onChange={e => setRmForm(prev => ({ ...prev, categoryGroupId: e.target.value, categoryId: '', productId: '', receiptId: '' }))}
              >
                <option value="">Select category</option>
                {rmCategoryGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>

            {rmAvailableCategories.length > 0 && (
              <label>
                <span>Sub-Category</span>
                <select
                  value={rmForm.categoryId}
                  onChange={e => setRmForm(prev => ({ ...prev, categoryId: e.target.value, productId: '', receiptId: '' }))}
                >
                  <option value="">Select sub-category</option>
                  {rmAvailableCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )}

            {rmAvailableProducts.length > 0 && (
              <label>
                <span>Product <span className="required">*</span></span>
                <SearchableSelect
                  options={rmAvailableProducts.map(p => ({ value: p.id, label: p.name }))}
                  value={rmForm.productId}
                  onChange={id => setRmForm(prev => ({ ...prev, productId: id, receiptId: '' }))}
                  placeholder="Select product"
                  searchPlaceholder="Search products..."
                />
              </label>
            )}

            {rmForm.productId && (() => {
              const lots = approvedReceipts.filter(r => r.productId === rmForm.productId && r.quantity > 0);
              return (
                <label>
                  <span>Inventory Lot <span className="required">*</span></span>
                  <SearchableSelect
                    options={lots.map(r => ({
                      value: r.id,
                      label: `Lot ${r.lotNo || '-'} · ${r.quantity.toLocaleString()} ${r.quantityUnits || 'cases'}`
                    }))}
                    value={rmForm.receiptId}
                    onChange={id => {
                      const r = lots.find(x => x.id === id);
                      setRmForm(prev => ({ ...prev, receiptId: id, availableQuantity: r?.quantity || 0 }));
                    }}
                    placeholder="Select lot"
                    searchPlaceholder="Search lots..."
                  />
                </label>
              );
            })()}

            {rmForm.receiptId && (
              <label>
                <span>Quantity to Adjust <span className="required">*</span></span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={rmForm.quantity}
                  onChange={e => setRmForm(prev => ({ ...prev, quantity: e.target.value }))}
                  placeholder="Enter quantity"
                />
              </label>
            )}

            <label>
              <span>Adjustment Type <span className="required">*</span></span>
              <select
                value={rmForm.adjustmentType}
                onChange={e => setRmForm(prev => ({ ...prev, adjustmentType: e.target.value }))}
              >
                {ADJUSTMENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>

            {rmForm.adjustmentType === 'donation' && (
              <label>
                <span>Recipient (Optional)</span>
                <input
                  type="text"
                  value={rmForm.recipient}
                  onChange={e => setRmForm(prev => ({ ...prev, recipient: e.target.value }))}
                  placeholder="e.g., Community Food Bank"
                />
              </label>
            )}

            <label className="full-width">
              <span>Reason <span className="required">*</span></span>
              <textarea
                value={rmForm.reason}
                onChange={e => setRmForm(prev => ({ ...prev, reason: e.target.value }))}
                rows={3}
                placeholder={reasonPlaceholder(rmForm.adjustmentType)}
                required
              />
            </label>

            {rmError && <div className="alert error">{rmError}</div>}

            <div className="form-actions">
              <button type="submit" className="primary-button" disabled={isSubmittingRm}>
                {isSubmittingRm ? 'Submitting...' : 'Submit Adjustment Request'}
              </button>
            </div>
          </form>
        )}

        {/* ── Right: recent adjustments ── */}
        <div className="action-list">
          <h3>Recent Adjustments</h3>
          <ul>
            {recentAdjustments.map(adj => {
              const product = productLookup[adj.productId];
              const isPallet = adj.palletLicenceIds?.length > 0;
              const typeLabel = ADJUSTMENT_TYPES.find(t => t.value === adj.adjustmentType)?.label || adj.adjustmentType;
              return (
                <li key={adj.id}>
                  <div className="item-main">
                    <strong>{product?.name || 'Unknown Product'}</strong>
                    <span className={`status-badge status-${adj.status}`}>{adj.status}</span>
                  </div>
                  <div className="item-meta">
                    <span><strong>Type:</strong> {typeLabel}</span>
                    {isPallet
                      ? <span><strong>Pallets:</strong> {adj.palletLicenceIds.length} · {adj.quantity} cases</span>
                      : <span><strong>Qty:</strong> {adj.quantity}</span>
                    }
                    <span>Submitted: {formatDateTime(adj.submittedAt)}</span>
                    {adj.reason && <span><strong>Reason:</strong> {adj.reason}</span>}
                  </div>
                </li>
              );
            })}
            {!inventoryAdjustments.length && <li className="empty">No adjustments submitted yet.</li>}
          </ul>
        </div>
      </div>
    </div>
  );
};

export default AdjustmentsTab;
