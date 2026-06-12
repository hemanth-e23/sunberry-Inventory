import React, { useMemo, useState, useRef } from 'react';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import { useToast } from '../../context/ToastContext';
import SearchableSelect from '../SearchableSelect';
import PalletPicker from './PalletPicker';
import { formatDateTime } from '../../utils/dateUtils';
import { buildEntriesForProduct, dominantDisplayUnit } from '../../utils/rowSources';
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

  // ─── RM / Packaging state (product-first) ───────────────────────────────────
  const [rmForm, setRmForm] = useState({
    productId: '',
    quantity: '',
    toLocation: '',
    toSubLocation: '',
    reason: '',
    transferType: 'warehouse-transfer',
    orderNumber: '',
  });
  const [rmEntrySelections, setRmEntrySelections] = useState({});
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
  // Stale-response guard: only the LATEST fetch may apply — fast product
  // switching must not leave the previous product's pallets selectable.
  const fgFetchSeq = useRef(0);
  const loadFgPallets = async (productId) => {
    const seq = ++fgFetchSeq.current;
    setFgPallets([]);
    setFgSelectedIds([]);
    setFgError('');
    if (!productId) return;
    setFgPalletsLoading(true);
    try {
      const data = await fetchPalletLicences({ product_id: productId, status: 'in_stock', is_held: false });
      if (seq !== fgFetchSeq.current) return;
      setFgPallets((data || []).sort((a, b) => (a.sequence || 0) - (b.sequence || 0)));
    } catch {
      if (seq !== fgFetchSeq.current) return;
      setFgError('Failed to load pallets. Please try again.');
    } finally {
      if (seq === fgFetchSeq.current) setFgPalletsLoading(false);
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

  // ─── RM products (non-finished products with stock) ──────────────────────────
  const rmProducts = useMemo(() => {
    const stockByProduct = new Map();
    for (const r of approvedReceipts) {
      const cat = categoryLookup[r.categoryId];
      if (!cat || cat.type === CATEGORY_TYPES.FINISHED || cat.type === 'group') continue;
      if (!(Number(r.quantity) > 0)) continue;
      stockByProduct.set(r.productId, (stockByProduct.get(r.productId) || 0) + Number(r.quantity));
    }
    return products
      .filter(p => stockByProduct.has(p.id))
      .map(p => ({ value: p.id, label: p.name }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [approvedReceipts, categoryLookup, products]);

  // Product-wide breakdown: every place this product physically sits
  const rmEntries = useMemo(() => {
    if (!rmForm.productId) return [];
    return buildEntriesForProduct({
      productId: rmForm.productId,
      approvedReceipts,
      storageAreas,
      locations,
      subLocationMap,
    });
  }, [rmForm.productId, approvedReceipts, storageAreas, locations, subLocationMap]);

  const rmGlobal = useMemo(() => dominantDisplayUnit(rmEntries), [rmEntries]);
  // RM/packaging form — never default to "cases" (those are finished goods).
  const rmGlobalUnit = rmGlobal?.unit || 'units';
  const rmGlobalFactor = rmGlobal?.factor || 1;
  const rmEntriesAvailStorage = rmEntries.reduce((s, e) => s + e.available, 0);

  // ─── RM: submit ──────────────────────────────────────────────────────────────
  const handleRmSubmit = async (event) => {
    event.preventDefault();
    if (!rmForm.productId) { setRmError('Select a product.'); return; }
    const requestedGlobal = Number(rmForm.quantity);
    if (!requestedGlobal || requestedGlobal <= 0) { setRmError('Enter a valid total quantity.'); return; }
    if (rmForm.transferType !== 'shipped-out' && !rmForm.toLocation) { setRmError('Select a destination location.'); return; }
    if (rmForm.transferType !== 'shipped-out' && !rmForm.toSubLocation) {
      setRmError('Choose a destination sub location.');
      return;
    }
    if (rmForm.transferType === 'shipped-out' && !rmForm.orderNumber.trim()) { setRmError('Order number is required.'); return; }

    const requestedStorage = requestedGlobal * rmGlobalFactor;
    const picks = rmEntries
      .map(entry => {
        const displayQty = Number(rmEntrySelections[entry.key] || 0);
        return { entry, displayQty, storageQty: displayQty * entry.displayFactor };
      })
      .filter(p => p.storageQty > 0);
    const pickedStorage = picks.reduce((s, p) => s + p.storageQty, 0);

    if (picks.length === 0) {
      setRmError('Pick which lot/location(s) the transfer comes from in the breakdown.');
      return;
    }
    if (Math.abs(pickedStorage - requestedStorage) > 0.01) {
      const summaryUnit = rmEntries[0]?.unit || 'units';
      setRmError(`Total selection (${pickedStorage.toLocaleString()} ${summaryUnit}) must equal ${requestedStorage.toLocaleString()}.`);
      return;
    }
    const perReceipt = new Map();
    for (const p of picks) {
      perReceipt.set(p.entry.receiptId, (perReceipt.get(p.entry.receiptId) || 0) + p.storageQty);
    }
    for (const p of picks) {
      const receiptSum = perReceipt.get(p.entry.receiptId) || 0;
      if (receiptSum > p.entry.receiptTotal + 0.01) {
        setRmError(`Lot ${p.entry.lotNumber}: total picked ${receiptSum.toLocaleString()} > ${p.entry.receiptTotal.toLocaleString()} on the lot.`);
        return;
      }
      if (p.storageQty > p.entry.available + 0.01) {
        setRmError(`${p.entry.locationLabel}: ${p.displayQty.toLocaleString()} ${p.entry.displayUnit} > ${(p.entry.available / p.entry.displayFactor).toLocaleString()} avail.`);
        return;
      }
    }

    if (isCorporateUser && selectedWarehouse) {
      const ok = await confirm(`You are about to log this transfer to "${selectedWarehouseName || 'Selected Warehouse'}". Is this the correct location?`);
      if (!ok) return;
    }

    // Group picks by receiptId; one InventoryTransfer per affected receipt
    const groups = new Map();
    for (const p of picks) {
      const list = groups.get(p.entry.receiptId) || [];
      list.push(p);
      groups.set(p.entry.receiptId, list);
    }

    setIsSubmittingRm(true);
    setRmError('');
    const failures = [];
    for (const [receiptId, items] of groups.entries()) {
      const groupQty = items.reduce((s, it) => s + it.storageQty, 0);
      const sourceBreakdown = items.map(({ entry, storageQty }) => ({
        id: entry.sourceId,
        quantity: storageQty,
      }));
      const result = await submitTransfer({
        receiptId,
        quantity: groupQty,
        toLocation: rmForm.transferType === 'shipped-out' ? null : rmForm.toLocation,
        toSubLocation: rmForm.transferType === 'shipped-out' ? null : (rmForm.toSubLocation || null),
        reason: rmForm.reason.trim(),
        transferType: rmForm.transferType,
        orderNumber: rmForm.transferType === 'shipped-out' ? rmForm.orderNumber.trim() : null,
        sourceBreakdown,
      });
      if (!result.success) {
        failures.push(result.message || result.error || 'Submit failed');
      }
    }
    setIsSubmittingRm(false);

    if (failures.length === 0) {
      const count = groups.size;
      setRmForm({ productId: '', quantity: '', toLocation: '', toSubLocation: '', reason: '', transferType: 'warehouse-transfer', orderNumber: '' });
      setRmEntrySelections({});
      addToast(
        count === 1
          ? 'Transfer submitted successfully.'
          : `${count} transfers submitted (one per lot).`,
        'success',
      );
    } else {
      const msg = failures.length === groups.size
        ? `Failed to submit: ${failures[0]}`
        : `${failures.length} of ${groups.size} transfers failed: ${failures[0]}`;
      setRmError(msg);
      addToast(msg, 'error');
    }
  };

  // List is already newest-first; don't reverse (that showed the oldest).
  const recentTransfers = inventoryTransfers.slice(0, 4);

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
              <span>Product <span className="required">*</span></span>
              <SearchableSelect
                options={rmProducts}
                value={rmForm.productId}
                onChange={(id) => {
                  setRmForm(prev => ({ ...prev, productId: id, quantity: '' }));
                  setRmEntrySelections({});
                }}
                placeholder="Select raw material / packaging product"
                searchPlaceholder="Type to search products..."
              />
            </label>

            {rmForm.productId && rmEntries.length === 0 && (
              <div className="alert info">No on-hand inventory found for this product.</div>
            )}

            {rmForm.productId && rmEntries.length > 0 && (
              <label>
                <span>Quantity to Move ({rmGlobalUnit}) <span className="required">*</span></span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={rmForm.quantity}
                  onChange={(e) => setRmForm(prev => ({ ...prev, quantity: e.target.value }))}
                  placeholder={`Total ${rmGlobalUnit} to move`}
                />
                <span className="muted small">
                  {rmEntriesAvailStorage.toLocaleString()} {rmEntries[0]?.unit || 'units'} on hand across {rmEntries.length} location{rmEntries.length === 1 ? '' : 's'}.
                </span>
              </label>
            )}

            {rmForm.productId && rmEntries.length > 0 && Number(rmForm.quantity || 0) > 0 && (() => {
              const requestedStorage = Number(rmForm.quantity || 0) * rmGlobalFactor;
              const pickedStorage = rmEntries.reduce((s, e) => s + (Number(rmEntrySelections[e.key] || 0) * e.displayFactor), 0);
              const summaryUnit = rmEntries[0]?.unit || 'units';
              return (
                <div className="panel" style={{ marginTop: 8 }}>
                  <div className="panel-header horizontal">
                    <strong>Source Breakdown</strong>
                    <span className="muted small">{pickedStorage.toLocaleString()} / {requestedStorage.toLocaleString()} {summaryUnit}</span>
                  </div>
                  <p className="muted small" style={{ margin: '4px 0 8px' }}>
                    Type how much to move from each lot/location (each shown in its own unit). Total must equal the quantity above.
                  </p>
                  <div className="form-grid">
                    {rmEntries.map(entry => {
                      const availDisp = entry.available / entry.displayFactor;
                      const showStorageHint = entry.displayUnit !== entry.unit;
                      return (
                        <label key={entry.key}>
                          <span>
                            Lot {entry.lotNumber} · {entry.locationLabel}
                            {' — '}{availDisp.toLocaleString(undefined, { maximumFractionDigits: 2 })} {entry.displayUnit} avail
                            {showStorageHint && ` (${entry.available.toLocaleString()} ${entry.unit})`}
                          </span>
                          <input
                            type="number"
                            min="0"
                            max={availDisp}
                            step="any"
                            value={rmEntrySelections[entry.key] ?? ''}
                            onChange={(e) => setRmEntrySelections(prev => ({ ...prev, [entry.key]: e.target.value }))}
                            placeholder="0"
                          />
                        </label>
                      );
                    })}
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
