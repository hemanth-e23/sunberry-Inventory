import React, { useMemo, useState } from 'react';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import { useToast } from '../../context/ToastContext';
import SearchableSelect from '../SearchableSelect';
import PalletPicker from './PalletPicker';
import { formatDateTime } from '../../utils/dateUtils';
import '../InventoryActionsPage.css';
import { CATEGORY_TYPES, RECEIPT_STATUS } from '../../constants';

const TransfersTab = () => {
  const { addToast } = useToast();
  const { isCorporateUser, selectedWarehouse, selectedWarehouseName } = useAuth();
  const { confirm } = useConfirm();
  const {
    products,
    categories,
    receipts,
    locations,
    subLocationMap,
    storageAreas,
    inventoryTransfers,
    submitTransfer,
    fetchPalletLicences,
  } = useAppData();

  const [activeSubTab, setActiveSubTab] = useState('fg');

  // ─── Finished Goods state ────────────────────────────────────────────────────
  const [fgProductId, setFgProductId] = useState('');
  const [fgPallets, setFgPallets] = useState([]);
  const [fgPalletsLoading, setFgPalletsLoading] = useState(false);
  const [fgSelectedIds, setFgSelectedIds] = useState([]);
  const [fgToLocationId, setFgToLocationId] = useState('');
  const [fgToRowId, setFgToRowId] = useState('');
  const [fgReason, setFgReason] = useState('');
  const [fgError, setFgError] = useState('');
  const [isSubmittingFg, setIsSubmittingFg] = useState(false);

  // ─── RM / Packaging state ────────────────────────────────────────────────────
  const [rmForm, setRmForm] = useState({
    receiptId: '',
    quantity: '',
    toLocation: '',
    toSubLocation: '',
    reason: '',
    availableQuantity: 0,
    transferType: 'warehouse-transfer',
    orderNumber: '',
  });
  const [availableSources, setAvailableSources] = useState([]);
  const [sourceSelections, setSourceSelections] = useState({});
  const [rmError, setRmError] = useState('');
  const [isSubmittingRm, setIsSubmittingRm] = useState(false);

  // ─── Lookups ─────────────────────────────────────────────────────────────────
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

  const approvedReceipts = useMemo(
    () => receipts.filter(r => r.status === RECEIPT_STATUS.APPROVED),
    [receipts]
  );

  const formatReceiptLabel = (receipt) => {
    const product = productLookup[receipt.productId];
    const category = categoryLookup[receipt.categoryId];
    return `${String(product?.name || 'Unknown')} · Lot ${String(receipt.lotNo || '-')} · ${String(category?.name || '')}`;
  };

  // ─── FG products (finished goods with stock) ─────────────────────────────────
  const fgProducts = useMemo(() => {
    const stockIds = new Set(approvedReceipts.filter(r => r.quantity > 0).map(r => r.productId));
    return products
      .filter(p => categoryLookup[p.categoryId]?.type === CATEGORY_TYPES.FINISHED && stockIds.has(p.id))
      .map(p => ({ value: p.id, label: p.name }));
  }, [products, categoryLookup, approvedReceipts]);

  // FG destination rows for selected location
  const fgDestRows = useMemo(() => {
    if (!fgToLocationId) return [];
    return storageAreas
      .filter(a => a.locationId === fgToLocationId)
      .flatMap(a =>
        (a.rows || []).map(r => ({
          id: r.id,
          label: `${a.name} / ${r.name}`,
          available: Math.max(0, (r.palletCapacity || 0) * (r.defaultCasesPerPallet || 0) - (r.occupiedCases || 0)),
        }))
      );
  }, [fgToLocationId, storageAreas]);

  // ─── FG: load pallets ────────────────────────────────────────────────────────
  const loadFgPallets = async (productId) => {
    setFgPallets([]);
    setFgSelectedIds([]);
    setFgError('');
    if (!productId) return;
    setFgPalletsLoading(true);
    try {
      const data = await fetchPalletLicences({ product_id: productId, status: 'in_stock', is_held: false });
      setFgPallets((data || []).sort((a, b) => (a.sequence || 0) - (b.sequence || 0)));
    } catch {
      setFgError('Failed to load pallets. Please try again.');
    } finally {
      setFgPalletsLoading(false);
    }
  };

  const selectedFgPallets = useMemo(
    () => fgPallets.filter(p => fgSelectedIds.includes(p.id)),
    [fgPallets, fgSelectedIds]
  );

  const selectedFgCases = useMemo(
    () => selectedFgPallets.reduce((s, p) => s + (p.cases || 0), 0),
    [selectedFgPallets]
  );

  // ─── FG: submit ──────────────────────────────────────────────────────────────
  const handleFgSubmit = async (e) => {
    e.preventDefault();
    if (!fgProductId) { setFgError('Select a product.'); return; }
    if (fgSelectedIds.length === 0) { setFgError('Select at least one pallet.'); return; }
    if (!fgToRowId) { setFgError('Select a destination row.'); return; }

    if (isCorporateUser && selectedWarehouse) {
      const ok = await confirm(`You are about to log this transfer to "${selectedWarehouseName || 'Selected Warehouse'}". Is this the correct location?`);
      if (!ok) return;
    }

    setIsSubmittingFg(true);
    setFgError('');

    // Group selected pallets by receipt_id (pallets may span multiple lots)
    const groups = {};
    for (const pl of selectedFgPallets) {
      if (pl.receipt_id) {
        if (!groups[pl.receipt_id]) groups[pl.receipt_id] = [];
        groups[pl.receipt_id].push(pl);
      }
    }

    const results = [];
    for (const [receiptId, pallets] of Object.entries(groups)) {
      const quantity = pallets.reduce((s, p) => s + (p.cases || 0), 0);
      const pIds = pallets.map(p => p.id);
      const result = await submitTransfer({
        receiptId,
        quantity,
        toLocation: fgToLocationId || null,
        palletLicenceIds: pIds,
        destinationBreakdown: [{ id: `row-${fgToRowId}`, quantity, pallet_licence_ids: pIds }],
        reason: fgReason.trim(),
        transferType: 'warehouse-transfer',
      });
      results.push(result);
    }

    setIsSubmittingFg(false);

    const failed = results.filter(r => !r.success);
    if (failed.length === 0) {
      setFgProductId('');
      setFgPallets([]);
      setFgSelectedIds([]);
      setFgToLocationId('');
      setFgToRowId('');
      setFgReason('');
      addToast(`Transfer submitted (${results.length} lot${results.length !== 1 ? 's' : ''}).`, 'success');
    } else {
      const msg = failed.map(r => r.message || r.error).join('; ');
      setFgError(msg || 'Transfer failed. Please try again.');
      addToast('Transfer submission failed.', 'error');
    }
  };

  // ─── RM receipts (non-finished) ──────────────────────────────────────────────
  const rmReceipts = useMemo(() =>
    approvedReceipts.filter(r => {
      const cat = categoryLookup[r.categoryId];
      return cat && cat.type !== CATEGORY_TYPES.FINISHED && cat.type !== 'group' && r.quantity > 0;
    }),
    [approvedReceipts, categoryLookup]
  );

  // ─── RM: submit ──────────────────────────────────────────────────────────────
  const handleRmSubmit = async (event) => {
    event.preventDefault();
    if (!rmForm.receiptId) { setRmError('Select an inventory lot.'); return; }
    if (!rmForm.quantity || Number(rmForm.quantity) <= 0) { setRmError('Enter a valid quantity.'); return; }
    if (rmForm.transferType !== 'shipped-out' && !rmForm.toLocation) { setRmError('Select a destination location.'); return; }
    if (rmForm.transferType === 'shipped-out' && !rmForm.orderNumber.trim()) { setRmError('Order number is required.'); return; }

    const requested = Number(rmForm.quantity);
    let picked = Object.values(sourceSelections).reduce((sum, v) => sum + (Number(v) || 0), 0);

    // Auto-fill source if quantity matches total available
    if (picked === 0 && requested > 0 && availableSources.length > 0) {
      const totalAvailable = availableSources.reduce((sum, src) => sum + src.available, 0);
      if (Math.abs(requested - totalAvailable) < 0.01) {
        const autoSel = {};
        availableSources.forEach(src => { autoSel[src.id] = src.available.toString(); });
        setSourceSelections(autoSel);
        picked = totalAvailable;
      }
    }

    if (Math.abs(picked - requested) > 0.01) {
      setRmError(`Selection must equal requested. Picked ${picked.toLocaleString()} of ${requested.toLocaleString()}.`);
      return;
    }

    if (rmForm.transferType !== 'shipped-out' && !rmForm.toSubLocation) {
      setRmError('Choose a destination sub location.');
      return;
    }

    if (isCorporateUser && selectedWarehouse) {
      const ok = await confirm(`You are about to log this transfer to "${selectedWarehouseName || 'Selected Warehouse'}". Is this the correct location?`);
      if (!ok) return;
    }

    setIsSubmittingRm(true);
    try {
      const result = await submitTransfer({
        receiptId: rmForm.receiptId,
        quantity: Number(rmForm.quantity),
        toLocation: rmForm.transferType === 'shipped-out' ? null : rmForm.toLocation,
        toSubLocation: rmForm.transferType === 'shipped-out' ? null : (rmForm.toSubLocation || null),
        reason: rmForm.reason.trim(),
        transferType: rmForm.transferType,
        orderNumber: rmForm.transferType === 'shipped-out' ? rmForm.orderNumber.trim() : null,
        sourceBreakdown: Object.entries(sourceSelections)
          .filter(([, qty]) => Number(qty) > 0)
          .map(([id, qty]) => ({ id, quantity: Number(qty) })),
      });

      if (result.success) {
        setRmForm({ receiptId: '', quantity: '', toLocation: '', toSubLocation: '', reason: '', availableQuantity: 0, transferType: 'warehouse-transfer', orderNumber: '' });
        setRmError('');
        setAvailableSources([]);
        setSourceSelections({});
        addToast('Transfer submitted successfully.', 'success');
      } else {
        setRmError(result.message || result.error || 'Failed to submit transfer.');
      }
    } catch {
      setRmError('An unexpected error occurred.');
    } finally {
      setIsSubmittingRm(false);
    }
  };

  const recentTransfers = inventoryTransfers.slice().reverse().slice(0, 4);

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
        {activeSubTab === 'fg' ? (
          // ── Finished Goods: pallet-based transfer ─────────────────────────────
          <form onSubmit={handleFgSubmit} className="action-form">
            <h3>Finished Goods Transfer</h3>
            <p className="muted small">Select specific pallets to move to a different storage row.</p>

            <label>
              <span>Product <span className="required">*</span></span>
              <SearchableSelect
                options={fgProducts}
                value={fgProductId}
                onChange={(id) => {
                  setFgProductId(id);
                  setFgToLocationId('');
                  setFgToRowId('');
                  loadFgPallets(id);
                }}
                placeholder="Select finished goods product"
                searchPlaceholder="Search products..."
              />
            </label>

            {(fgPalletsLoading || fgPallets.length > 0 || fgProductId) && (
              <div>
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-muted)' }}>
                  Select pallets to transfer
                </span>
                <PalletPicker
                  pallets={fgPallets}
                  selectedIds={fgSelectedIds}
                  onChange={setFgSelectedIds}
                  loading={fgPalletsLoading}
                  emptyMessage="No available pallets for this product."
                />
              </div>
            )}

            <label>
              <span>To Location <span className="required">*</span></span>
              <select
                value={fgToLocationId}
                onChange={(e) => { setFgToLocationId(e.target.value); setFgToRowId(''); }}
              >
                <option value="">Select destination location</option>
                {locations
                  .filter(l => storageAreas.some(a => a.locationId === l.id))
                  .map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>

            {fgToLocationId && (
              <label>
                <span>To Row <span className="required">*</span></span>
                <select value={fgToRowId} onChange={(e) => setFgToRowId(e.target.value)}>
                  <option value="">Select storage row</option>
                  {fgDestRows.map(r => (
                    <option key={r.id} value={r.id}>
                      {r.label} — {r.available.toLocaleString()} cases available
                    </option>
                  ))}
                  {fgDestRows.length === 0 && (
                    <option disabled>No rows found for this location</option>
                  )}
                </select>
              </label>
            )}

            <label className="full-width">
              <span>Notes</span>
              <textarea
                value={fgReason}
                onChange={e => setFgReason(e.target.value)}
                rows={2}
                placeholder="Reason for transfer (optional)"
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
                    ? `Submit Transfer (${fgSelectedIds.length} pallets · ${selectedFgCases} cases)`
                    : 'Submit Transfer'}
              </button>
            </div>
          </form>
        ) : (
          // ── RM / Packaging: lot-based (existing flow) ─────────────────────────
          <form onSubmit={handleRmSubmit} className="action-form">
            <h3>Raw Materials & Packaging Transfer</h3>
            <p className="muted small">Select a lot and quantity to move or ship out.</p>

            <label>
              <span>Transfer Type</span>
              <select
                value={rmForm.transferType}
                onChange={(e) => setRmForm(prev => ({ ...prev, transferType: e.target.value, orderNumber: '', toLocation: '', toSubLocation: '' }))}
              >
                <option value="warehouse-transfer">Warehouse Transfer</option>
                <option value="shipped-out">Shipped Out</option>
              </select>
            </label>

            {rmForm.transferType === 'shipped-out' && (
              <label>
                <span>Order Number <span className="required">*</span></span>
                <input
                  type="text"
                  value={rmForm.orderNumber}
                  onChange={(e) => setRmForm(prev => ({ ...prev, orderNumber: e.target.value }))}
                  placeholder="Enter order number"
                />
              </label>
            )}

            <label>
              <span>Inventory Lot <span className="required">*</span></span>
              <SearchableSelect
                options={rmReceipts.map(r => ({ value: r.id, label: formatReceiptLabel(r) }))}
                value={rmForm.receiptId}
                onChange={(receiptId) => {
                  const sel = approvedReceipts.find(r => r.id === receiptId);
                  const sources = [];
                  if (sel) {
                    const locId = sel.location || null;
                    const subId = sel.subLocation || null;
                    const locName = locations.find(l => l.id === locId)?.name || 'Location';
                    const subName = (subLocationMap[locId] || []).find(s => s.id === subId)?.name || '';
                    sources.push({
                      id: subId || locId || 'unknown',
                      label: `${locName}${subName ? ' / ' + subName : ''}`,
                      available: Number(sel.quantity || 0),
                      type: 'standard',
                    });
                  }
                  setRmForm(prev => ({ ...prev, receiptId, availableQuantity: sel?.quantity || 0 }));
                  setAvailableSources(sources);
                  setSourceSelections({});
                }}
                placeholder="Select inventory lot"
                searchPlaceholder="Type to search lots..."
              />
            </label>

            <label>
              <span>Quantity to Move <span className="required">*</span></span>
              <div className="quantity-input-container">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={rmForm.quantity}
                  onChange={(e) => setRmForm(prev => ({ ...prev, quantity: e.target.value }))}
                />
                {rmForm.availableQuantity > 0 && (
                  <div className="quantity-helpers">
                    <button type="button" className="link-button small" onClick={() => setRmForm(prev => ({ ...prev, quantity: prev.availableQuantity }))}>
                      Move all ({rmForm.availableQuantity})
                    </button>
                    <button type="button" className="link-button small" onClick={() => setRmForm(prev => ({ ...prev, quantity: prev.availableQuantity / 2 }))}>
                      Move half
                    </button>
                  </div>
                )}
              </div>
            </label>

            {availableSources.length > 0 && Number(rmForm.quantity || 0) > 0 && (() => {
              const requestedQty = Number(rmForm.quantity || 0);
              const selectedQty = Object.values(sourceSelections).reduce((s, v) => s + (Number(v) || 0), 0);
              return (
                <div className="panel" style={{ marginTop: 8 }}>
                  <div className="panel-header horizontal">
                    <strong>Source Location</strong>
                    <span className="muted small">{selectedQty.toLocaleString()} / {requestedQty.toLocaleString()} cases</span>
                  </div>
                  <div className="form-grid">
                    {availableSources.map(src => (
                      <label key={src.id}>
                        <span>{src.label} — {src.available.toLocaleString()} avail</span>
                        <input
                          type="number"
                          min="0"
                          max={src.available}
                          step="1"
                          value={sourceSelections[src.id] ?? ''}
                          onChange={(e) => setSourceSelections(prev => ({ ...prev, [src.id]: e.target.value }))}
                          placeholder="0"
                        />
                      </label>
                    ))}
                  </div>
                </div>
              );
            })()}

            {rmForm.transferType !== 'shipped-out' && (
              <div className="two-col">
                <label>
                  <span>To Location <span className="required">*</span></span>
                  <select
                    value={rmForm.toLocation}
                    onChange={(e) => setRmForm(prev => ({ ...prev, toLocation: e.target.value, toSubLocation: '' }))}
                  >
                    <option value="">Select location</option>
                    {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </label>
                <label>
                  <span>To Sub Location</span>
                  <select
                    value={rmForm.toSubLocation}
                    onChange={(e) => setRmForm(prev => ({ ...prev, toSubLocation: e.target.value }))}
                    disabled={!rmForm.toLocation}
                  >
                    <option value="">Select</option>
                    {(subLocationMap[rmForm.toLocation] || []).map(sub => (
                      <option key={sub.id} value={sub.id}>{sub.name}</option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            <label className="full-width">
              <span>{rmForm.transferType === 'shipped-out' ? 'Shipping Notes' : 'Reason / Notes'}</span>
              <textarea
                value={rmForm.reason}
                onChange={(e) => setRmForm(prev => ({ ...prev, reason: e.target.value }))}
                rows={3}
                placeholder={rmForm.transferType === 'shipped-out' ? 'Additional shipping details (customer, carrier, etc.)' : ''}
              />
            </label>

            {rmError && <div className="form-error">{rmError}</div>}

            <div className="form-actions">
              <button type="submit" className="primary-button" disabled={isSubmittingRm}>
                {isSubmittingRm ? 'Submitting...' : rmForm.transferType === 'shipped-out' ? 'Submit Shipment' : 'Submit Transfer'}
              </button>
            </div>
          </form>
        )}

        {/* Recent transfers */}
        <div className="action-list">
          <h3>Recent Transfer Requests</h3>
          <ul>
            {recentTransfers.map(transfer => {
              const receipt = receipts.find(r => r.id === transfer.receiptId);
              const isPallet = transfer.palletLicenceIds?.length > 0;
              const product = receipt ? productLookup[receipt.productId] : null;
              return (
                <li key={transfer.id}>
                  <div className="item-main">
                    <strong>{product?.name || formatReceiptLabel(receipt || {})}</strong>
                    <span className={`status-badge status-${transfer.status}`}>{transfer.status}</span>
                  </div>
                  <div className="item-meta">
                    <span><strong>Type:</strong> {transfer.transferType === 'shipped-out' ? 'Shipped Out' : 'Warehouse Transfer'}</span>
                    {isPallet
                      ? <span>{transfer.palletLicenceIds.length} pallets · {transfer.quantity} cases</span>
                      : <span>Qty: {(transfer.quantity || 0).toLocaleString()}</span>
                    }
                    {transfer.orderNumber && <span><strong>Order #:</strong> {transfer.orderNumber}</span>}
                    <span>Requested: {formatDateTime(transfer.submittedAt)}</span>
                  </div>
                </li>
              );
            })}
            {!inventoryTransfers.length && <li className="empty">No transfers submitted yet.</li>}
          </ul>
        </div>
      </div>
    </div>
  );
};

export default TransfersTab;
