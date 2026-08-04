// Lot-wide hold / release — SPEC §14, §18.6 (H-1 recall trace, H-2 partial
// release), IMPL-COMMENT 11 / audit D3.
//
// Three rules this screen exists to enforce:
//   1. A vendor lot is an ATTRIBUTE, not a key — vendors reuse lot numbers. The
//      preview is scoped by product and vendor, and says so loudly when it is not.
//   2. There is no blind "hold everything matching". The preview resolves to a
//      concrete list, the human ticks boxes, and POST /bulk-hold receives exactly
//      those serials.
//   3. Consumed and shipped containers cannot be held — but WHICH batch each one
//      went into is the entire point of serializing. That list is the recall trace.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppData } from '../../context/AppDataContext';
import { useToast } from '../../context/ToastContext';
import SearchableSelect from '../SearchableSelect';
import { formatCalendarDate, decodeContainerPayload } from '../../utils/labelPayload';
import { containerUnitLabel, isIngredientType } from '../../constants';
import {
  apiErrorMessage,
  bulkSetHold,
  getContainer,
  previewLotHold,
} from '../../api/ingredientContainerApi';
import './ContainersPage.css';

const MODE = { HOLD: 'hold', RELEASE: 'release' };

const unitFor = (containers, count) => {
  const types = new Set((containers || []).map((c) => c.container_type).filter(Boolean));
  return containerUnitLabel(types.size === 1 ? [...types][0] : null, count);
};

const humanize = (value) =>
  String(value || '').split('_').filter(Boolean).join(' ');

const LotHoldModal = ({ open, onClose, onCompleted, initialVendorLot = '' }) => {
  const { addToast } = useToast();
  const { products, productCategories, vendors } = useAppData();

  const [mode, setMode] = useState(MODE.HOLD);
  const [vendorLot, setVendorLot] = useState(initialVendorLot);
  const [productId, setProductId] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [scanInput, setScanInput] = useState('');
  const [scanBusy, setScanBusy] = useState(false);

  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);

  const [selected, setSelected] = useState(() => new Set());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const categoryTypeById = useMemo(() => {
    const map = {};
    (productCategories || []).forEach((category) => { map[category.id] = category.type; });
    return map;
  }, [productCategories]);

  const productOptions = useMemo(() => {
    const ingredients = (products || []).filter(
      (product) => isIngredientType(categoryTypeById[product.categoryId]),
    );
    const source = ingredients.length > 0 ? ingredients : (products || []);
    return [...source]
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
      .map((product) => ({
        value: product.id,
        label: product.sid ? `${product.name} · ${product.sid}` : product.name,
      }));
  }, [products, categoryTypeById]);

  const vendorOptions = useMemo(
    () => [...(vendors || [])]
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
      .map((vendor) => ({ value: vendor.id, label: vendor.name })),
    [vendors],
  );

  const resetPreview = useCallback(() => {
    setPreview(null);
    setPreviewError(null);
    setSelected(new Set());
  }, []);

  useEffect(() => {
    if (!open) return;
    setMode(MODE.HOLD);
    setVendorLot(initialVendorLot);
    setProductId('');
    setVendorId('');
    setScanInput('');
    setReason('');
    resetPreview();
  }, [open, initialVendorLot, resetPreview]);

  // The list a mode operates on. Hold acts on holdable, release on already-held.
  const targetList = useMemo(() => {
    if (!preview) return [];
    return mode === MODE.HOLD ? (preview.holdable || []) : (preview.already_held || []);
  }, [preview, mode]);

  const selectAllTargets = useCallback((list) => {
    setSelected(new Set((list || []).map((container) => container.serial)));
  }, []);

  const runPreview = async () => {
    const lot = vendorLot.trim();
    if (!lot) {
      addToast('Enter or scan a vendor lot first.', 'error');
      return;
    }
    setPreviewLoading(true);
    try {
      const response = await previewLotHold({
        vendor_lot: lot,
        product_id: productId || undefined,
        vendor_id: vendorId || undefined,
      });
      const data = response?.data || null;
      setPreview(data);
      setPreviewError(null);
      selectAllTargets(mode === MODE.HOLD ? data?.holdable : data?.already_held);
    } catch (error) {
      setPreview(null);
      setSelected(new Set());
      setPreviewError(apiErrorMessage(error, 'Failed to preview this lot'));
    } finally {
      setPreviewLoading(false);
    }
  };

  const switchMode = (nextMode) => {
    setMode(nextMode);
    if (!preview) return;
    selectAllTargets(nextMode === MODE.HOLD ? preview.holdable : preview.already_held);
  };

  // Scanning a drum label is the fastest way to scope correctly: the payload
  // carries the lot, and the container lookup supplies the product the lot must
  // be scoped to.
  const resolveScan = async () => {
    const raw = scanInput.trim();
    if (!raw) return;
    const decoded = decodeContainerPayload(raw);
    if (!decoded) {
      addToast('That is not a container label.', 'error');
      return;
    }
    setScanBusy(true);
    try {
      const response = await getContainer(decoded.serial);
      const container = response?.data;
      if (!container) {
        addToast(`No container found for ${decoded.serial}`, 'error');
        return;
      }
      setVendorLot(container.vendor_lot || decoded.vendorLot || '');
      setProductId(container.product_id || '');
      setScanInput('');
      resetPreview();
      if (!container.vendor_lot) {
        addToast(`${container.serial} has no vendor lot recorded — scope it another way.`, 'warning');
      } else {
        addToast(`Scoped to ${container.product_name || 'product'} · lot ${container.vendor_lot}`, 'info');
      }
    } catch (error) {
      // Fall back to whatever the payload itself carried.
      if (decoded.vendorLot) {
        setVendorLot(decoded.vendorLot);
        setScanInput('');
        resetPreview();
        addToast('Container lookup failed — used the lot printed on the label.', 'warning');
      } else {
        addToast(apiErrorMessage(error, 'Container lookup failed'), 'error');
      }
    } finally {
      setScanBusy(false);
    }
  };

  const toggleSerial = (serial) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(serial)) next.delete(serial);
      else next.add(serial);
      return next;
    });
  };

  const confirm = async () => {
    const serials = targetList
      .map((container) => container.serial)
      .filter((serial) => selected.has(serial));

    if (serials.length === 0) {
      addToast('Tick at least one container.', 'error');
      return;
    }
    if (mode === MODE.HOLD && !reason.trim()) {
      addToast('A hold needs a reason.', 'error');
      return;
    }

    setBusy(true);
    try {
      const response = await bulkSetHold({
        serials,
        held: mode === MODE.HOLD,
        reason: reason.trim() || undefined,
      });
      const data = response?.data || {};
      const changed = Array.isArray(data.changed) ? data.changed : [];
      const skipped = Array.isArray(data.skipped) ? data.skipped : [];
      addToast(
        `${changed.length} ${unitFor(targetList, changed.length)} `
        + `${mode === MODE.HOLD ? 'placed on hold' : 'released'}`,
        'success',
      );
      if (skipped.length > 0) {
        const head = skipped.slice(0, 3).map((entry) => `${entry.serial}: ${entry.reason}`).join('; ');
        addToast(
          `${skipped.length} skipped — ${head}${skipped.length > 3 ? '…' : ''}`,
          'warning',
        );
      }
      onCompleted?.();
      await runPreview();
      setReason('');
    } catch (error) {
      addToast(apiErrorMessage(error, 'Bulk hold failed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const unscoped = !productId && !vendorId;
  const selectedCount = targetList.filter((c) => selected.has(c.serial)).length;

  const renderSelectableList = (list) => {
    if (list.length === 0) {
      return (
        <p className="muted small">
          {mode === MODE.HOLD
            ? 'Nothing in this lot can be held.'
            : 'Nothing in this lot is currently on hold.'}
        </p>
      );
    }
    return (
      <>
        <div className="lot-hold-list-actions">
          <button type="button" className="link-button" onClick={() => selectAllTargets(list)}>
            Select all
          </button>
          <button type="button" className="link-button" onClick={() => setSelected(new Set())}>
            Select none
          </button>
          <span className="muted small">{selectedCount} of {list.length} ticked</span>
        </div>
        <ul className="lot-hold-list">
          {list.map((container) => (
            <li key={container.serial}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.has(container.serial)}
                  onChange={() => toggleSerial(container.serial)}
                />
                <span className="containers-mono">{container.serial}</span>
                <span className="muted small">
                  {container.product_name || '—'}
                  {container.storage_row_name ? ` · ${container.storage_row_name}` : ''}
                  {container.bbd ? ` · BBD ${formatCalendarDate(container.bbd)}` : ''}
                  {` · ${humanize(container.status)}`}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </>
    );
  };

  const renderReadOnlyList = (list, describe) => {
    if (list.length === 0) return <p className="muted small">None.</p>;
    return (
      <ul className="lot-hold-list lot-hold-list--readonly">
        {list.map((container) => (
          <li key={container.serial}>
            <span className="containers-mono">{container.serial}</span>
            <span className="muted small">{describe(container)}</span>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div className="lot-hold-overlay" role="dialog" aria-modal="true" aria-label="Lot hold">
      <div className="lot-hold-modal">
        <header className="lot-hold-header">
          <h3>Lot-wide hold / release</h3>
          <button type="button" className="containers-icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="lot-hold-body">
          <div className="lot-hold-mode">
            <button
              type="button"
              className={`containers-chip${mode === MODE.HOLD ? ' is-active' : ''}`}
              onClick={() => switchMode(MODE.HOLD)}
            >
              Hold
            </button>
            <button
              type="button"
              className={`containers-chip${mode === MODE.RELEASE ? ' is-active' : ''}`}
              onClick={() => switchMode(MODE.RELEASE)}
            >
              Release
            </button>
          </div>

          <div className="lot-hold-scope">
            <label className="containers-field">
              <span>Vendor lot</span>
              <input
                type="text"
                value={vendorLot}
                onChange={(event) => { setVendorLot(event.target.value); resetPreview(); }}
                onKeyDown={(event) => { if (event.key === 'Enter') runPreview(); }}
                placeholder="Type the lot number"
              />
            </label>
            <label className="containers-field">
              <span>Product</span>
              <SearchableSelect
                options={productOptions}
                value={productId}
                onChange={(value) => { setProductId(value); resetPreview(); }}
                placeholder="Any product"
                emptyLabel="Any product"
              />
            </label>
            <label className="containers-field">
              <span>Vendor</span>
              <SearchableSelect
                options={vendorOptions}
                value={vendorId}
                onChange={(value) => { setVendorId(value); resetPreview(); }}
                placeholder="Any vendor"
                emptyLabel="Any vendor"
              />
            </label>
            <label className="containers-field">
              <span>…or scan a container label</span>
              <input
                type="text"
                value={scanInput}
                onChange={(event) => setScanInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); resolveScan(); } }}
                placeholder="Scan to fill lot + product"
                disabled={scanBusy}
              />
            </label>
          </div>

          {unscoped && (
            <div className="containers-callout containers-callout--warn">
              <strong>No product or vendor scope</strong>
              <div>
                Vendors reuse lot numbers. Without a product or vendor this preview can pull in
                unrelated material — check every serial before you confirm.
              </div>
            </div>
          )}

          <div className="lot-hold-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={runPreview}
              disabled={previewLoading || !vendorLot.trim()}
            >
              {previewLoading ? 'Looking…' : 'Preview lot'}
            </button>
          </div>

          {previewError && <p className="containers-error">{previewError}</p>}

          {preview && (
            <>
              <p className="muted small">
                {preview.total} {unitFor(
                  [
                    ...(preview.holdable || []),
                    ...(preview.already_held || []),
                    ...(preview.consumed || []),
                    ...(preview.shipped || []),
                  ],
                  preview.total,
                )} matched
                {preview.intake_ids?.length
                  ? ` across ${preview.intake_ids.length} intake${preview.intake_ids.length === 1 ? '' : 's'}`
                  : ''}
                .
              </p>

              <section className="lot-hold-section">
                <h4>
                  {mode === MODE.HOLD
                    ? `Holdable (${(preview.holdable || []).length})`
                    : `Currently held (${(preview.already_held || []).length})`}
                </h4>
                <p className="muted small">
                  {mode === MODE.HOLD
                    ? 'Ticked containers get the hold. Untick anything that should stay usable.'
                    : 'Untick anything that must STAY on hold — a partial release is normal.'}
                </p>
                {renderSelectableList(targetList)}
              </section>

              {mode === MODE.HOLD && (
                <section className="lot-hold-section">
                  <h4>Already held ({(preview.already_held || []).length})</h4>
                  {renderReadOnlyList(
                    preview.already_held || [],
                    (container) => container.hold_reason || 'No reason recorded',
                  )}
                </section>
              )}

              {mode === MODE.RELEASE && (
                <section className="lot-hold-section">
                  <h4>Not held ({(preview.holdable || []).length})</h4>
                  {renderReadOnlyList(
                    preview.holdable || [],
                    (container) => container.storage_row_name || 'Not placed',
                  )}
                </section>
              )}

              <section className="lot-hold-section lot-hold-section--trace">
                <h4>Consumed ({(preview.consumed || []).length})</h4>
                <p className="lot-hold-trace-note">
                  This is the recall trace. These containers are already inside product — they
                  cannot be held, but here is exactly which batch each one went into.
                </p>
                {renderReadOnlyList(
                  preview.consumed || [],
                  (container) => (container.consumed_by_batch_uid
                    ? `batch ${container.consumed_by_batch_uid}`
                    : 'batch not recorded'),
                )}
              </section>

              <section className="lot-hold-section lot-hold-section--trace">
                <h4>Shipped ({(preview.shipped || []).length})</h4>
                <p className="lot-hold-trace-note">
                  These left the building. They cannot be held from here — chase them through the
                  outbound order.
                </p>
                {renderReadOnlyList(
                  preview.shipped || [],
                  (container) => (container.product_name || 'Unknown product'),
                )}
              </section>

              <label className="containers-field">
                <span>
                  Reason{mode === MODE.HOLD ? <span className="containers-required"> *</span> : ' (optional)'}
                </span>
                <textarea
                  rows={3}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder={mode === MODE.HOLD ? 'Why is this lot being held?' : 'Why is it being released?'}
                />
              </label>
            </>
          )}
        </div>

        <footer className="lot-hold-footer">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
            Close
          </button>
          <button
            type="button"
            className={`secondary-button${mode === MODE.HOLD ? ' danger' : ''}`}
            onClick={confirm}
            disabled={busy || !preview || selectedCount === 0}
          >
            {busy
              ? 'Working…'
              : `${mode === MODE.HOLD ? 'Hold' : 'Release'} ${selectedCount} `
                + `${unitFor(targetList, selectedCount)}`}
          </button>
        </footer>
      </div>
    </div>
  );
};

export default LotHoldModal;
