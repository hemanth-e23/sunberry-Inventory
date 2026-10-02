import React, { useMemo, useState, useEffect } from 'react';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import { useToast } from '../../context/ToastContext';
import SearchableSelect from '../SearchableSelect';
import PalletPicker from './PalletPicker';
import { formatDateTime } from '../../utils/dateUtils';
import { buildEntriesForProduct, containersFreed, describeContainers, countWithUnit, overAskMessage, stockSummary, containerSplit, singularUnit } from '../../utils/rowSources';
import RmEntryQtyInput from './RmEntryQtyInput';
import '../InventoryActionsPage.css';
import { CATEGORY_TYPES, RECEIPT_STATUS } from '../../constants';
import { adjustmentTypeLabel } from '../../utils/adjustmentTypes';

const ADJUSTMENT_TYPES = [
  { value: 'stock-correction', label: 'Stock Correction' },
  { value: 'damage-reduction', label: 'Damage Reduction' },
  { value: 'donation', label: 'Donation' },
  { value: 'trash-disposal', label: 'Trash / Disposal' },
  { value: 'quality-rejection', label: 'Quality Rejection' },
  { value: 'used-in-production', label: 'Used in Production' },
];

const AdjustmentsTab = () => {
  const { addToast } = useToast();
  const { isCorporateUser, selectedWarehouse, selectedWarehouseName } = useAuth();
  const { confirm } = useConfirm();
  const {
    products,
    categories,
    categoryGroups,
    productCategories,
    receipts,
    locations,
    subLocationMap,
    storageAreas,
    inventoryAdjustments,
    inventoryTransfers,
    submitAdjustment,
    refreshReceipts,
    refreshTransfers,
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

  // ─── RM / Packaging (product-first) state ────────────────────────────────────
  const [rmForm, setRmForm] = useState({
    categoryGroupId: '',
    categoryId: '',
    productId: '',
    adjustmentType: 'stock-correction',
    quantity: '',
    reason: '',
    recipient: '',
  });
  // Map of entry.key -> qty string the operator typed
  const [rmEntrySelections, setRmEntrySelections] = useState({});
  // Pounds taken from a part-container, per (lot × rack) entry.
  const [rmPartialSelections, setRmPartialSelections] = useState({});
  // Per-source-row pallets to FREE (keyed by entry.key). Undefined = proportional
  // suggestion; explicit value (incl. '0') overrides.
  const [rmPalletSelections, setRmPalletSelections] = useState({});
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

  // Sub-categories grouped under their group heading, for one <optgroup> picker.
  const rmCategoryOptions = useMemo(() => {
    const sortByName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
    return rmCategoryGroups
      .map(g => ({
        id: g.id,
        name: g.name,
        categories: productCategories
          .filter(c => c.parentId === g.id && c.type !== CATEGORY_TYPES.FINISHED)
          .sort(sortByName),
      }))
      .filter(g => g.categories.length > 0)
      .sort(sortByName);
  }, [rmCategoryGroups, productCategories]);

  const rmAvailableProducts = products.filter(p => p.categoryId === rmForm.categoryId);

  // Fresh numbers the moment a product is picked: receipts approved and
  // transfers submitted elsewhere since this page loaded were invisible until
  // a reload, so the form offered drums that were gone or promised (2026-10-01).
  useEffect(() => {
    if (!rmForm.productId) return;
    refreshReceipts?.();
    refreshTransfers?.();
  }, [rmForm.productId, refreshReceipts, refreshTransfers]);

  // Product-wide breakdown: every place this product physically sits
  const rmEntries = useMemo(() => {
    if (!rmForm.productId) return [];
    return buildEntriesForProduct({
      productId: rmForm.productId,
      approvedReceipts,
      storageAreas,
      locations,
      subLocationMap,
      // Pending write-offs reserve too (PART 3, B10).
      pendingTransfers: [...inventoryTransfers, ...(inventoryAdjustments || [])],
      allReceipts: receipts,
    });
  }, [rmForm.productId, approvedReceipts, storageAreas, locations, subLocationMap, inventoryTransfers, inventoryAdjustments, receipts]);

  // Proportional pallets-out suggestion for one source row (editable guess).
  const suggestedPalletsOut = (entry, displayQty) => {
    const contentStorage = Number(displayQty || 0) * (entry.displayFactor || 1);
    if (!(entry.rowPallets > 0) || !(entry.available > 0) || contentStorage <= 0) return 0;
    return Math.max(0, Math.round((contentStorage / entry.available) * entry.rowPallets));
  };
  // Effective pallets-out: explicit override wins, else the suggestion.
  const resolvePalletsOut = (entry, displayQty) => {
    // Drum room holding drums: the footprint is the drum count, not a question.
    if (entry.footprintIsContent) return containersFreed(entry, displayQty);
    const v = rmPalletSelections[entry.key];
    if (v !== undefined) return Math.max(0, Number(v) || 0);
    return suggestedPalletsOut(entry, displayQty);
  };

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

    if (isCorporateUser && selectedWarehouse) {
      const ok = await confirm(`You are about to log this adjustment to "${selectedWarehouseName || 'Selected Warehouse'}". Is this the correct location?`);
      if (!ok) return;
    }

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
    if (!rmForm.productId) { setRmError('Select a product.'); return; }
    if (!rmForm.reason.trim()) { setRmError('Reason is required.'); return; }

    // The total to adjust is DERIVED from the per-lot picks, each converted
    // at its own receipt's weight. The old top-level quantity gate multiplied
    // by ONE product-wide blanket factor, so a product whose lots weigh 485
    // and 452 lbs/drum could never satisfy it — the "must equal" error with
    // no possible input (2026-09-29).
    const picks = rmEntries
      .map(entry => {
        const displayQty = Number(rmEntrySelections[entry.key] || 0);
        // "+ lbs from a part drum" (PART 3, B4): half a drum used has a way in.
        const partialLbs = Number(rmPartialSelections[entry.key] || 0);
        const storageQty = displayQty * entry.displayFactor + Math.max(0, partialLbs);
        return { entry, displayQty, partialLbs, storageQty };
      })
      .filter(p => p.storageQty > 0);

    if (picks.length === 0) {
      setRmError('Enter how much to remove from each lot/location in the breakdown below.');
      return;
    }
    // Per-receipt cap: sum of picks against a receipt mustn't exceed receipt total
    const perReceipt = new Map();
    for (const p of picks) {
      perReceipt.set(p.entry.receiptId, (perReceipt.get(p.entry.receiptId) || 0) + p.storageQty);
    }
    for (const p of picks) {
      const receiptSum = perReceipt.get(p.entry.receiptId) || 0;
      // Counted lots skip the per-receipt paper cap: `available` is lot-wide
      // rack truth while `receiptTotal` is one delivery's share, and the
      // server validates (and spills) at lot scope now.
      if (!p.entry.isCounted && receiptSum > p.entry.receiptTotal + 0.01) {
        setRmError(`Lot ${p.entry.lotNumber}: total picked ${receiptSum.toLocaleString()} > ${p.entry.receiptTotal.toLocaleString()} on the lot.`);
        return;
      }
      if (p.storageQty > p.entry.available + 0.01) {
        setRmError(`Lot ${p.entry.lotNumber}: ${overAskMessage(p.entry, p.displayQty)}`);
        return;
      }
    }

    if (isCorporateUser && selectedWarehouse) {
      const ok = await confirm(`You are about to log this adjustment to "${selectedWarehouseName || 'Selected Warehouse'}". Is this the correct location?`);
      if (!ok) return;
    }

    // Group picks by receiptId — each receipt gets its own InventoryAdjustment row
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
      // Pallets-out only for UNCOUNTED lots — a counted lot's footprint is
      // derived from the container count server-side and any figure here is
      // discarded (2026-09-29 audit, bags finding 2).
      const sourceBreakdown = items.map(({ entry, displayQty, partialLbs, storageQty }) => {
        const e = { id: entry.sourceId, quantity: storageQty };
        if (entry.rowId && !entry.isCounted) e.pallets = resolvePalletsOut(entry, displayQty);
        // Counted containers go as a COUNT plus any part-container in pounds;
        // the server prices exactly what leaves (its deliveries' weights).
        const split = containerSplit(entry, displayQty, partialLbs);
        if (split) {
          e.units = split.units;
          if (split.openQty > 0) e.open_qty = split.openQty;
        }
        return e;
      });
      const groupQty = items.reduce((s, it) => s + it.storageQty, 0);
      const result = await submitAdjustment({
        productId: rmForm.productId,
        categoryId: rmForm.categoryId,
        receiptId,
        adjustmentType: rmForm.adjustmentType,
        quantity: groupQty,
        reason: rmForm.reason.trim(),
        recipient: rmForm.recipient.trim() || null,
        sourceBreakdown,
      });
      if (!result.success) {
        failures.push(result.error || 'Submit failed');
      }
    }
    setIsSubmittingRm(false);

    if (failures.length === 0) {
      const count = groups.size;
      setRmForm({ categoryGroupId: '', categoryId: '', productId: '', adjustmentType: 'stock-correction', quantity: '', reason: '', recipient: '' });
      setRmEntrySelections({});
      setRmPartialSelections({});
      setRmPalletSelections({});
      addToast(
        count === 1
          ? 'Adjustment submitted successfully.'
          : `${count} adjustments submitted (one per lot).`,
        'success',
      );
    } else {
      const msg = failures.length === groups.size
        ? `Failed to submit: ${failures[0]}`
        : `${failures.length} of ${groups.size} adjustments failed: ${failures[0]}`;
      setRmError(msg);
      addToast(msg, 'error');
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
  // List is already newest-first (backend order + context prepends), so don't
  // reverse — that showed the oldest entries and hid just-submitted ones.
  const recentAdjustments = inventoryAdjustments.slice(0, 5);

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

            {/* ONE picker of material categories, grouped under their company
                heading. Asking for the company ("Sunberry / Arizona") first and
                the actual category second read as a category list that
                started with company names (browser test PART 2, U11). */}
            <label>
              <span>Category</span>
              <select
                value={rmForm.categoryId}
                onChange={e => {
                  const cat = productCategories.find(c => c.id === e.target.value);
                  setRmForm(prev => ({ ...prev, categoryGroupId: cat?.parentId || '', categoryId: e.target.value, productId: '', receiptId: '' }));
                  setRmEntrySelections({});
      setRmPartialSelections({});
                  setRmPalletSelections({});
                }}
              >
                <option value="">Select category</option>
                {rmCategoryOptions.map(group => (
                  <optgroup key={group.id} label={group.name}>
                    {group.categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>

            {rmAvailableProducts.length > 0 && (
              <label>
                <span>Product <span className="required">*</span></span>
                <SearchableSelect
                  options={rmAvailableProducts.map(p => ({ value: p.id, label: p.name }))}
                  value={rmForm.productId}
                  onChange={id => {
                    setRmForm(prev => ({ ...prev, productId: id, quantity: '' }));
                    setRmEntrySelections({});
      setRmPartialSelections({});
                    setRmPalletSelections({});
                  }}
                  placeholder="Select product"
                  searchPlaceholder="Search products..."
                />
              </label>
            )}

            {rmForm.productId && rmEntries.length === 0 && (
              <div className="alert info">No on-hand inventory found for this product.</div>
            )}

            {rmForm.productId && rmEntries.length > 0 && (() => {
              // The total is DERIVED from the picks (each at its own
              // receipt's weight) — no top field to reconcile against a
              // blanket per-drum factor that mixed-weight products can never
              // satisfy (2026-09-29).
              const pickedStorage = rmEntries.reduce((s, e) => s + (Number(rmEntrySelections[e.key] || 0) * e.displayFactor), 0);
              const summaryUnit = rmEntries[0]?.unit || 'units';
              const pickedUnits = rmEntries.reduce((s, e) => s + Number(rmEntrySelections[e.key] || 0), 0);
              const unitLabels = new Set(
                rmEntries
                  .filter(e => Number(rmEntrySelections[e.key] || 0) > 0)
                  .map(e => e.displayUnit)
              );
              const containerNote = unitLabels.size === 1 && [...unitLabels][0] !== summaryUnit
                ? ` (${countWithUnit(pickedUnits, [...unitLabels][0])})`
                : '';
              const summary = stockSummary(rmEntries);
              return (
                <div className="panel" style={{ marginTop: 8 }}>
                  <div className="panel-header horizontal">
                    <strong>Source Breakdown</strong>
                    <span className="muted small">
                      Removing {pickedStorage.toLocaleString()} {summaryUnit}{containerNote}
                      {' · '}{summary.text}
                    </span>
                  </div>
                  <p className="muted small" style={{ margin: '4px 0 8px' }}>
                    Type how much to remove from each lot/location (each shown in its own unit). The total above follows your picks.
                  </p>
                  <div className="form-grid">
                    {rmEntries.map(entry => {
                      const availDisp = entry.available / entry.displayFactor;
                      const showStorageHint = entry.displayUnit !== entry.unit;
                      const dispQty = rmEntrySelections[entry.key] ?? '';
                      const palletDisplay = rmPalletSelections[entry.key]
                        ?? (Number(dispQty || 0) > 0 ? String(suggestedPalletsOut(entry, dispQty)) : '');
                      return (
                        <React.Fragment key={entry.key}>
                          <label>
                            <span>
                              Lot {entry.lotNumber} · {entry.locationLabel}
                              {' — '}{describeContainers(entry)
                                ?? `${availDisp.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${entry.displayUnit}`} avail
                              {showStorageHint && ` (${entry.available.toLocaleString()} ${entry.unit})`}
                              {Number(entry.heldUnits) > 0 && (
                                <span style={{ color: 'var(--color-danger, #b91c1c)', fontWeight: 600 }}>
                                  {' '}· {countWithUnit(entry.heldUnits, entry.displayUnit)} on hold
                                </span>
                              )}
                              {Number(entry.reservedWeight) > 0 && (
                                <span style={{ color: 'var(--color-text-muted, #6b7280)', fontWeight: 600 }}>
                                  {' '}· {countWithUnit(Math.round((entry.reservedWeight / (entry.displayFactor || 1)) * 100) / 100, entry.displayUnit)} on pending requests
                                </span>
                              )}
                            </span>
                            {/* Nothing free here (all on hold or promised to
                                transfers): the label above says why. Leaving it
                                editable produced the browser's bare "Value must
                                be 0." on a held lot. */}
                            <RmEntryQtyInput
                              entry={entry}
                              value={dispQty}
                              disabled={availDisp <= 0}
                              onChange={(v) => setRmEntrySelections(prev => ({ ...prev, [entry.key]: v }))}
                            />
                            {/* Part of a drum (half a drum used the day after
                                staging): comes out of an open drum on this
                                rack, or opens a sealed one (PART 3, B4). */}
                            {entry.isCounted && Number(entry.displayFactor) > 1
                              && !(Number(entry.unitsPerPallet) > 1) && availDisp > 0 && (
                              <span style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                                <span className="muted small">+</span>
                                <input
                                  type="number"
                                  min="0"
                                  step="any"
                                  value={rmPartialSelections[entry.key] ?? ''}
                                  onChange={(e) => setRmPartialSelections(prev => ({ ...prev, [entry.key]: e.target.value }))}
                                  placeholder="0"
                                  aria-label={`${entry.unit || 'lbs'} from part of a ${singularUnit(entry.displayUnit || 'drum')}`}
                                  style={{ flex: '0 1 6rem' }}
                                />
                                <span className="muted small">
                                  {entry.unit || 'lbs'} from part of a {singularUnit(entry.displayUnit || 'drum')}
                                </span>
                              </span>
                            )}
                          </label>
                          {/* NO pallet input for a counted lot. The footprint is DERIVED
                              from the container count (`_pallet_footprint`), and
                              the service ignores any figure sent here —
                              `_move_counted_lot` and the counted adjustment path
                              both work from units alone. An input whose value is
                              silently discarded is worse than no input, and two
                              boxes per rack were also what made this grid wrap
                              mid-pair so you could not tell which pallet box
                              belonged to which rack. */}
                          {entry.rowId && !entry.isCounted && !entry.footprintIsContent && (
                            <label>
                              <span>
                                ↳ {entry.footprintUnit === 'pallets' ? 'Pallets' : entry.footprintUnit.replace(/^./, c => c.toUpperCase())} emptied from this row
                                {entry.rowPallets ? ` (row holds ${entry.rowPallets})` : ''}
                              </span>
                              <input
                                type="number"
                                min="0"
                                step="1"
                                value={palletDisplay}
                                onChange={(e) => setRmPalletSelections(prev => ({ ...prev, [entry.key]: e.target.value }))}
                                placeholder="0"
                              />
                            </label>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

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
              const typeLabel = ADJUSTMENT_TYPES.find(t => t.value === adj.adjustmentType)?.label || adjustmentTypeLabel(adj.adjustmentType);
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
