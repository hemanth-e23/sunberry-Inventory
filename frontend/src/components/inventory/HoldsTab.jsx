import React, { useMemo, useState, useCallback, useRef } from 'react';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import { useToast } from '../../context/ToastContext';
import SearchableSelect from '../SearchableSelect';
import PalletPicker from './PalletPicker';
import apiClient from '../../api/client';
import { formatDateTime } from '../../utils/dateUtils';
import { formatUserName } from '../../utils/userDisplay';
import '../InventoryActionsPage.css';
import { CATEGORY_TYPES, HOLD_STATUS, RECEIPT_STATUS } from '../../constants';

const HoldsTab = () => {
  const { addToast } = useToast();
  const { user, isCorporateUser, selectedWarehouse, selectedWarehouseName } = useAuth();
  const { confirm } = useConfirm();
  const {
    products,
    categories,
    receipts,
    vendors,
    userNameMap,
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
  // 'lot' quarantines every container wherever it sits; 'racks' quarantines a
  // stated number on named racks. See the note by the scope picker below.
  const [rmScope, setRmScope] = useState('lot');
  const [rmRackUnits, setRmRackUnits] = useState({});

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

  // Resolve names from the shared directory (loaded for every role) rather than
  // the admin-only users list — that was the "Unknown user" source on holds.
  const userLookup = userNameMap;

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

  /**
   * Is this receipt's material quarantined? Mirrors `hold_service.is_receipt_held`.
   *
   * `receipt.hold` alone is not the answer: a PARTIAL hold deliberately leaves
   * it False so the un-held containers stay stageable, and the quarantine lives
   * on the placements — surfaced here through `heldUnits` in the projected
   * allocations. Reading only the flag is what made a partly-held lot offer
   * Release and then be refused by the server.
   */
  const isReceiptHeld = (receipt) => {
    if (!receipt) return false;
    if (receipt.hold) return true;
    return (receipt.rawMaterialRowAllocations || [])
      .some((a) => Number(a?.heldUnits) > 0);
  };

  const selectedRmReceipt = useMemo(
    () => rmReceipts.find(r => r.id === rmReceiptId),
    [rmReceipts, rmReceiptId]
  );

  /**
   * The racks this lot actually sits on, with how many containers are on each.
   *
   * Read from `rawMaterialRowAllocations`, which for a lot-tracked receipt is a
   * projection of the placements — so the counts here are the same ones staging
   * and the row cards read, not a separate opinion. Only racks with a container
   * count can be partly held; a row that reports weight but no count predates
   * the lot model, and holding "some of an unknown number" is not a fact QA can
   * act on.
   */
  const rmRacks = useMemo(() => {
    const allocs = selectedRmReceipt?.rawMaterialRowAllocations;
    if (!Array.isArray(allocs)) return [];
    return allocs
      .filter(a => a?.rowId && Number(a.units) > 0)
      .map(a => ({
        rowId: a.rowId,
        rowName: a.rowName || a.rowId,
        units: Number(a.units),
        unitLabel: a.unitLabel || 'unit',
      }));
  }, [selectedRmReceipt]);

  const rmHeldTotal = useMemo(
    () => rmRacks.reduce((sum, rack) => sum + (Number(rmRackUnits[rack.rowId]) || 0), 0),
    [rmRacks, rmRackUnits]
  );

  const formatReceiptLabel = (receipt) => {
    const product = productLookup[receipt.productId];
    // The VENDOR, not the category. Two suppliers shipping the same lot number
    // are two different lots that print different stickers, and the category
    // was the same word on every row — three identical entries to choose from.
    const vendor = vendors?.find((v) => v.id === receipt.vendorId)?.name;
    const held = (receipt.rawMaterialRowAllocations || [])
      .reduce((sum, a) => sum + (Number(a?.heldUnits) || 0), 0);
    const holdLabel = receipt.hold
      ? ' [ON HOLD]'
      : held > 0 ? ` [${held} ON HOLD]` : '';
    return `${String(product?.name || 'Unknown')} · Lot ${String(receipt.lotNo || '-')}`
      + `${vendor ? ` · ${vendor}` : ''}${holdLabel}`;
  };

  // ─── Fetch pallets when FG product or mode changes ────────────────────────
  // Stale-response guard: only the LATEST fetch may apply — fast product
  // switching must not leave the previous product's pallets selectable.
  const fgFetchSeq = useRef(0);
  const fetchFgPallets = useCallback(async (productId, mode) => {
    const seq = ++fgFetchSeq.current;
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
      if (seq !== fgFetchSeq.current) return;
      setFgPallets(response.data || []);
    } catch {
      if (seq !== fgFetchSeq.current) return;
      setFgError('Failed to load pallets.');
    } finally {
      if (seq === fgFetchSeq.current) setFgPalletsLoading(false);
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

    if (isCorporateUser && selectedWarehouse) {
      const ok = await confirm(`You are about to log this hold to "${selectedWarehouseName || 'Selected Warehouse'}". Is this the correct location?`);
      if (!ok) return;
    }

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

    if (isCorporateUser && selectedWarehouse) {
      const ok = await confirm(`You are about to log this hold to "${selectedWarehouseName || 'Selected Warehouse'}". Is this the correct location?`);
      if (!ok) return;
    }

    const action = isReceiptHeld(selectedRmReceipt) ? 'release' : 'hold';

    // Naming racks is what makes this a partial hold; naming none holds the
    // whole lot. The backend reads it the same way, so the two agree by
    // construction rather than by a flag that could disagree with the items.
    const holdingRacks = action === 'hold' && rmScope === 'racks';
    if (holdingRacks && rmHeldTotal <= 0) {
      setRmError('Say how many containers to hold on at least one rack.');
      return;
    }
    const holdItems = holdingRacks
      ? rmRacks
          .filter(rack => Number(rmRackUnits[rack.rowId]) > 0)
          .map(rack => ({
            receiptId: rmReceiptId,
            locationId: rack.rowId,
            units: Number(rmRackUnits[rack.rowId]),
            // Weight is sent alongside for the older readers of this payload;
            // `units` is what the hold is actually applied from.
            quantity: Number(rmRackUnits[rack.rowId])
              * (Number(selectedRmReceipt.weightPerContainer) || 0),
          }))
      : undefined;

    setRmSubmitting(true);
    const result = await submitHoldAction({
      receiptId: rmReceiptId,
      action,
      reason: rmReason.trim(),
      submittedBy: user?.id || user?.username,
      holdItems,
    });
    setRmSubmitting(false);

    if (result.success) {
      setRmReceiptId('');
      setRmReason('');
      setRmError('');
      setRmScope('lot');
      setRmRackUnits({});
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
                  {isReceiptHeld(selectedRmReceipt)
                    ? '🔒 On hold — submit to release'
                    : '✅ Lot is available — submit to place on hold'}
                </div>
                <div style={{ fontSize: '13px', color: '#6b7280' }}>
                  Lot {selectedRmReceipt.lotNo || '—'} · {(selectedRmReceipt.quantity || 0).toLocaleString()} {selectedRmReceipt.quantityUnits || 'cases'}
                </div>
              </div>
            )}

            {/* Scope. Only offered when placing a hold and only when we know
                which racks the containers are on — a release always clears
                everything, and a lot with no per-rack counts can only be held
                whole. */}
            {selectedRmReceipt && !isReceiptHeld(selectedRmReceipt) && rmRacks.length > 0 && (
              <div style={{ marginTop: '12px' }}>
                <span style={{ fontWeight: 600, fontSize: '13px' }}>What is on hold?</span>
                <div style={{ display: 'flex', gap: '16px', margin: '8px 0' }}>
                  <label style={{ display: 'flex', gap: '6px', alignItems: 'center', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      checked={rmScope === 'lot'}
                      onChange={() => setRmScope('lot')}
                    />
                    <span>The whole lot</span>
                  </label>
                  <label style={{ display: 'flex', gap: '6px', alignItems: 'center', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      checked={rmScope === 'racks'}
                      onChange={() => setRmScope('racks')}
                    />
                    <span>Only some, on certain racks</span>
                  </label>
                </div>
                <div style={{ fontSize: '12px', color: '#6b7280' }}>
                  {rmScope === 'lot'
                    ? 'Every container of this lot, on every rack — including any that arrived on another truck. Use this when the lot itself is suspect.'
                    : 'Use this when the lot is fine but some containers are not — water damage, a dropped drum. Every container wears the same sticker, so name the rack and how many, not which ones.'}
                </div>

                {rmScope === 'racks' && (
                  <div style={{ marginTop: '10px', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '10px 12px' }}>
                    {rmRacks.map(rack => (
                      <div
                        key={rack.rowId}
                        style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '4px 0' }}
                      >
                        <span style={{ minWidth: '110px', fontWeight: 500 }}>{rack.rowName}</span>
                        <span style={{ color: '#6b7280', fontSize: '13px', flex: 1 }}>
                          {rack.units} {rack.unitLabel}{rack.units === 1 ? '' : 's'} here
                        </span>
                        <input
                          type="number"
                          min="0"
                          max={rack.units}
                          step="1"
                          value={rmRackUnits[rack.rowId] ?? ''}
                          placeholder="0"
                          onChange={(e) => {
                            const n = Math.max(0, Math.min(Number(e.target.value), rack.units));
                            setRmRackUnits(prev => ({ ...prev, [rack.rowId]: n }));
                          }}
                          style={{ width: '80px', padding: '4px 8px' }}
                        />
                        <span style={{ color: '#6b7280', fontSize: '12px' }}>on hold</span>
                      </div>
                    ))}
                    <div style={{ marginTop: '8px', fontSize: '13px', fontWeight: 600 }}>
                      {rmHeldTotal} of {rmRacks.reduce((s, r) => s + r.units, 0)} quarantined
                    </div>
                  </div>
                )}
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
                {rmSubmitting
                  ? 'Submitting…'
                  : isReceiptHeld(selectedRmReceipt) ? 'Submit Release Request' : 'Submit Hold Request'}
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
                      <span>Approved by: {formatUserName(action.approvedBy, userLookup)}</span>
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
                <span className="meta">Placed By: {lastHold ? formatUserName(lastHold.submittedBy, userLookup) : '-'}</span>
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
