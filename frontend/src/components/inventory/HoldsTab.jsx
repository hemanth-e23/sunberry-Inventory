import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import { useToast } from '../../context/ToastContext';
import SearchableSelect from '../SearchableSelect';
import PalletPicker from './PalletPicker';
import apiClient from '../../api/client';
import { formatDateTime } from '../../utils/dateUtils';
import { formatUserName } from '../../utils/userDisplay';
import { sortHoldsNewestFirst } from '../../utils/holdHistory';
import '../InventoryActionsPage.css';
import { CATEGORY_TYPES, HOLD_STATUS, RECEIPT_STATUS } from '../../constants';
import { lotTotalText, lotHeldText, lotLocationText } from '../../utils/lotStatus';
import { onePerLot, offRackText } from '../../utils/holdLots';
import { pluralizeUnit, singularUnit } from '../../utils/rowSources';

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
  // Lot-hold only (2026-09-16): a hold always covers the whole lot. The old
  // per-rack "hold 8 of 20" scope was removed — suspect drums are physically
  // transferred to the QUARANTINE rack instead, and the lot stays free.

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
  // ONE entry per lot: a hold covers the whole lot, so a lot that came on
  // four trucks was listed four times (browser test PART 3, U4).
  const rmReceipts = useMemo(() =>
    onePerLot(receipts.filter(r =>
      ['approved', 'recorded', 'reviewed'].includes(r.status) &&
      r.quantity > 0 &&
      categoryLookup[r.categoryId]?.type !== CATEGORY_TYPES.FINISHED &&
      categoryLookup[r.categoryId]?.type !== 'group'
    )),
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
    // `hold` alone is NOT a QA hold: it doubles as the transient review lock
    // every pending transfer sets. Counting it here offered "Release" on a
    // lot nobody held, and approving that release swept the lot's real hold
    // state (2026-09-29 audit, GAP 5). A QA hold carries heldQuantity.
    if (receipt.hold && Number(receipt.heldQuantity || 0) > 0) return true;
    return (receipt.rawMaterialRowAllocations || [])
      .some((a) => Number(a?.heldUnits) > 0);
  };

  const selectedRmReceipt = useMemo(
    () => rmReceipts.find(r => r.id === rmReceiptId),
    [rmReceipts, rmReceiptId]
  );

  // The LOT's current racks, totals and held amount, lot-wide, from the
  // server. The receipt's own quantity / heldQuantity is one delivery's
  // paperwork: B-0910 read "5,688 lbs" on hold with 13 drums (6,162 lb) held
  // after a drum arrived while it was held (2026-10-01, B4).
  const [rmLotStatus, setRmLotStatus] = useState(null);
  const lotStatusSeq = useRef(0);
  useEffect(() => {
    const seq = ++lotStatusSeq.current;
    if (!rmReceiptId) { setRmLotStatus(null); return; }
    apiClient.get(`/inventory/hold-actions/lot-status/${rmReceiptId}`)
      .then((res) => { if (seq === lotStatusSeq.current) setRmLotStatus(res.data || null); })
      .catch(() => { if (seq === lotStatusSeq.current) setRmLotStatus(null); });
  }, [rmReceiptId, inventoryHoldActions]);

  // The server's lot-wide answer wins: a delivery that arrived while the lot
  // was held carries no heldQuantity of its own, yet the lot is held.
  const selectedIsHeld = rmLotStatus && rmLotStatus.receipt_id === rmReceiptId
    ? Boolean(rmLotStatus.is_held)
    : isReceiptHeld(selectedRmReceipt);

  // Lots on hold NOW, one card per LOT (not per receipt — and not every
  // receipt with the transient review flag a pending transfer sets).
  const [heldLots, setHeldLots] = useState([]);
  useEffect(() => {
    let cancelled = false;
    apiClient.get('/inventory/hold-actions/held-lots')
      .then((res) => { if (!cancelled) setHeldLots(Array.isArray(res.data) ? res.data : []); })
      .catch(() => { if (!cancelled) setHeldLots([]); });
    return () => { cancelled = true; };
  }, [inventoryHoldActions, selectedWarehouse]);

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
    if (rmLotStatus?.source === 'racks' && Array.isArray(rmLotStatus.racks)) {
      return rmLotStatus.racks
        .filter(r => r.row_id && Number(r.units) > 0)
        .map(r => ({
          rowId: r.row_id,
          rowName: r.room_name ? `${r.row_name} (${r.room_name})` : (r.row_name || r.row_id),
          units: Number(r.units),
          unitLabel: rmLotStatus.unit_label || 'unit',
        }));
    }
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
  }, [selectedRmReceipt, rmLotStatus]);


  const formatReceiptLabel = (receipt) => {
    const product = productLookup[receipt.productId];
    // The VENDOR, not the category. Two suppliers shipping the same lot number
    // are two different lots that print different stickers, and the category
    // was the same word on every row — three identical entries to choose from.
    const vendor = vendors?.find((v) => v.id === receipt.vendorId)?.name;
    const held = (receipt.rawMaterialRowAllocations || [])
      .reduce((sum, a) => sum + (Number(a?.heldUnits) || 0), 0);
    // Same QA-hold-vs-transient-lock distinction as isReceiptHeld: a pending
    // transfer must not stamp [ON HOLD] on the picker.
    const holdLabel = (receipt.hold && Number(receipt.heldQuantity || 0) > 0)
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

    const action = selectedIsHeld ? 'release' : 'hold';

    // Lot-hold only: no rack items ever — the hold is the whole lot.
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
  // Newest first BY TIME. The list mixes orders — the server sends newest
  // first, a new submission is appended at the end — so reversing it showed
  // the four OLDEST actions after a reload, and the B-0910 lot hold and its
  // release never appeared (browser test PART 2, U11).
  const recentHolds = useMemo(
    () => sortHoldsNewestFirst(inventoryHoldActions).slice(0, 6),
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
                  {selectedIsHeld
                    ? '🔒 On hold — submit to release'
                    : '✅ Lot is available — submit to place on hold'}
                </div>
                <div style={{ fontSize: '13px', color: '#6b7280' }}>
                  Lot {selectedRmReceipt.lotNo || '—'} · {lotTotalText(rmLotStatus)
                    || `${(selectedRmReceipt.quantity || 0).toLocaleString()} ${selectedRmReceipt.quantityUnits || 'cases'}`}
                </div>
                {lotHeldText(rmLotStatus) && (
                  <div style={{ fontSize: '13px', color: '#92400e', marginTop: '2px' }}>
                    Held now: {lotHeldText(rmLotStatus)}
                  </div>
                )}
                {lotLocationText(rmLotStatus) && (
                  <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '2px' }}>
                    Where: {lotLocationText(rmLotStatus)}
                  </div>
                )}
                {offRackText(rmLotStatus) && (
                  <div style={{ fontSize: '13px', color: '#92400e', marginTop: '4px', fontWeight: 600 }}>
                    Off the racks now: {offRackText(rmLotStatus)}.
                    {!selectedIsHeld && ' A hold also stops these being used in production.'}
                  </div>
                )}
              </div>
            )}

            {/* Lot-hold only: the hold always covers every container of the
                lot, on every rack. The racks are listed as context so QA can
                see where the material sits — and route a few suspect drums to
                the QUARANTINE rack by transfer instead of freezing the lot. */}
            {selectedRmReceipt && !selectedIsHeld && (
              <div style={{ marginTop: '12px' }}>
                <div style={{ fontSize: '12px', color: '#6b7280' }}>
                  A hold covers every container of this lot, on every rack —
                  including any that arrived on another truck. If only a few
                  containers are suspect (water damage, a dropped drum),
                  transfer those to the QUARANTINE rack instead and leave the
                  lot free.
                </div>
                {rmRacks.length > 0 && (
                  <div style={{ marginTop: '10px', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '10px 12px' }}>
                    {rmRacks.map(rack => (
                      <div
                        key={rack.rowId}
                        style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '4px 0' }}
                      >
                        <span style={{ minWidth: '110px', fontWeight: 500 }}>{rack.rowName}</span>
                        <span style={{ color: '#6b7280', fontSize: '13px', flex: 1 }}>
                          {rack.units} {rack.units === 1 ? singularUnit(rack.unitLabel) : pluralizeUnit(singularUnit(rack.unitLabel))} here
                        </span>
                      </div>
                    ))}
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
                  : selectedIsHeld ? 'Submit Release Request' : 'Submit Hold Request'}
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
          {heldLots.map(lot => {
            const ids = new Set(lot.receipt_ids || [lot.receipt_id]);
            const lastHold = inventoryHoldActions
              .filter(a => ids.has(a.receiptId) && a.status === HOLD_STATUS.APPROVED && a.action === 'hold')
              .sort((a, b) => new Date(b.approvedAt || b.submittedAt || 0) - new Date(a.approvedAt || a.submittedAt || 0))[0];
            const receipt = receipts.find(r => r.id === lot.receipt_id);
            const product = productLookup[lot.product_id];
            return (
              <div key={lot.material_lot_id || lot.receipt_id} className="hold-card">
                <span className="title">
                  {receipt ? formatReceiptLabel(receipt) : `${product?.name || 'Unknown'} · Lot ${lot.lot_number || '-'}`}
                </span>
                <span className="meta">Since: {lastHold ? formatDateTime(lastHold.approvedAt || lastHold.submittedAt) : (lot.held_at ? formatDateTime(lot.held_at) : '-')}</span>
                <span className="meta">Placed By: {lastHold ? formatUserName(lastHold.submittedBy, userLookup) : (lot.held_by ? formatUserName(lot.held_by, userLookup) : '-')}</span>
                <span className="meta">Held: {lotHeldText(lot)}</span>
                {lotLocationText(lot) && <span className="meta">Where: {lotLocationText(lot)}</span>}
              </div>
            );
          })}
          {heldLots.length === 0 && (
            <div className="empty">No inventory currently on hold.</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default HoldsTab;
