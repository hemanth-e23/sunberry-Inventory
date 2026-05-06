import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layers, Play, Square, Repeat } from 'lucide-react';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../context/ConfirmContext';
import { getDashboardPath } from '../../App';
import SearchableSelect from '../SearchableSelect';
import { formatDateTime } from '../../utils/dateUtils';
import { CATEGORY_TYPES } from '../../constants';
import {
  getActiveProductionLines,
  setActiveProduction,
  clearActiveProduction,
} from '../../api/palletizerService';
import './ActiveProductionPage.css';

const ActiveProductionPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const { products, categories } = useAppData();

  const [linesWithActive, setLinesWithActive] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pickedProductByLine, setPickedProductByLine] = useState({});
  const [busyLineId, setBusyLineId] = useState(null);

  const finishedProductOptions = useMemo(() => {
    const finishedCategoryIds = new Set(
      (categories || [])
        .filter(c => c.type === CATEGORY_TYPES.FINISHED)
        .map(c => c.id),
    );
    return (products || [])
      .filter(p => finishedCategoryIds.has(p.categoryId) && p.is_active !== false)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [products, categories]);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const { data } = await getActiveProductionLines();
      setLinesWithActive(data || []);
    } catch (err) {
      const msg = err?.response?.data?.detail || 'Failed to load production lines';
      addToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSet = async (lineId) => {
    const productId = pickedProductByLine[lineId];
    if (!productId) {
      addToast('Pick a product first', 'warning');
      return;
    }
    try {
      setBusyLineId(lineId);
      await setActiveProduction(lineId, productId);
      addToast('Active production set', 'success');
      setPickedProductByLine(prev => ({ ...prev, [lineId]: '' }));
      await refresh();
    } catch (err) {
      addToast(err?.response?.data?.detail || 'Failed to set active production', 'error');
    } finally {
      setBusyLineId(null);
    }
  };

  const handleSwitch = async (lineId, lineLabel, currentProductName) => {
    const productId = pickedProductByLine[lineId];
    if (!productId) {
      addToast('Pick a product first', 'warning');
      return;
    }
    const newProduct = finishedProductOptions.find(p => p.id === productId);
    const newName = newProduct?.name || 'the new product';
    const ok = await confirm(
      `Switch ${lineLabel} from "${currentProductName}" to "${newName}"? The pallet counter will reset to 001 (lot number stays the same).`,
      { title: 'Switch product?', confirmLabel: 'Switch' },
    );
    if (!ok) return;
    try {
      setBusyLineId(lineId);
      await setActiveProduction(lineId, productId);
      addToast(`Switched to ${newName}`, 'success');
      setPickedProductByLine(prev => ({ ...prev, [lineId]: '' }));
      await refresh();
    } catch (err) {
      addToast(err?.response?.data?.detail || 'Failed to switch product', 'error');
    } finally {
      setBusyLineId(null);
    }
  };

  const handleClear = async (lineId, label) => {
    const ok = await confirm(
      `Stop production on ${label}? The palletizer will refuse to print until production is set again.`,
      { title: 'Stop active production?', confirmLabel: 'Stop' },
    );
    if (!ok) return;
    try {
      setBusyLineId(lineId);
      await clearActiveProduction(lineId);
      addToast('Active production cleared', 'success');
      await refresh();
    } catch (err) {
      addToast(err?.response?.data?.detail || 'Failed to clear', 'error');
    } finally {
      setBusyLineId(null);
    }
  };

  return (
    <div className="active-production-page">
      <div className="page-header">
        <button className="back-button" onClick={() => navigate(getDashboardPath(user?.role))}>
          ← Back to Dashboard
        </button>
        <div className="header-content">
          <h2><Layers size={22} style={{ verticalAlign: '-3px' }} /> Active Production</h2>
          <p className="muted">Tell the palletizer what each line is producing right now. Resets every day at midnight (plant-local).</p>
        </div>
      </div>

      {loading && <div className="active-production-empty">Loading…</div>}

      {!loading && linesWithActive.length === 0 && (
        <div className="active-production-empty">
          No production lines configured for this plant. Add them in master data.
        </div>
      )}

      <div className="active-production-grid">
        {linesWithActive.map(({ line, active }) => {
          const isBusy = busyLineId === line.id;
          const lastSeq = active?.last_printed_seq ?? 0;
          const nextSeq = String(lastSeq + 1).padStart(3, '0');
          const productLabel = active?.product
            ? `${active.product.name}${active.product.short_code ? ` (${active.product.short_code})` : ''}`
            : null;
          const pickedProductId = pickedProductByLine[line.id] || '';
          const isSamePickedProduct = active && pickedProductId === active.product_id;

          return (
            <div key={line.id} className="line-card">
              <div className="line-card__header">
                <h3>{line.name}</h3>
                {active ? <span className="badge badge--running">Running</span> : <span className="badge badge--idle">Idle</span>}
              </div>

              {active ? (
                <>
                  <div className="line-card__row"><span className="line-card__label">Product</span><span className="line-card__value">{productLabel}</span></div>
                  <div className="line-card__row"><span className="line-card__label">Lot</span><span className="line-card__value">{active.lot_number}</span></div>
                  <div className="line-card__row"><span className="line-card__label">Last printed</span><span className="line-card__value">{lastSeq.toString().padStart(3, '0')}</span></div>
                  <div className="line-card__row"><span className="line-card__label">Next pallet</span><span className="line-card__value line-card__value--strong">{nextSeq}</span></div>
                  <div className="line-card__row"><span className="line-card__label">Set at</span><span className="line-card__value">{formatDateTime(active.set_at)}</span></div>

                  <div className="line-card__switch">
                    <span className="line-card__hint">Switch to a different product (resets counter):</span>
                    <SearchableSelect
                      options={finishedProductOptions
                        .filter(p => p.id !== active.product_id)
                        .map(p => ({
                          value: p.id,
                          label: `${p.name}${p.short_code ? ` (${p.short_code})` : ''}`,
                        }))}
                      value={pickedProductId}
                      onChange={(v) => setPickedProductByLine(prev => ({ ...prev, [line.id]: v }))}
                      placeholder="Select a different product…"
                      searchPlaceholder="Type to search…"
                      emptyLabel="Select a different product…"
                      disabled={isBusy}
                    />
                    <button
                      className="line-card__action line-card__action--primary"
                      onClick={() => handleSwitch(line.id, line.name, active.product?.name)}
                      disabled={isBusy || !pickedProductId || isSamePickedProduct}
                    >
                      <Repeat size={16} />
                      {isBusy ? 'Working…' : 'Switch Product'}
                    </button>
                  </div>

                  <button
                    className="line-card__action line-card__action--danger"
                    onClick={() => handleClear(line.id, line.name)}
                    disabled={isBusy}
                  >
                    <Square size={16} />
                    {isBusy ? 'Working…' : 'Stop Production'}
                  </button>
                </>
              ) : (
                <>
                  <p className="line-card__hint">Pick a finished-goods product to start production.</p>
                  <SearchableSelect
                    options={finishedProductOptions.map(p => ({
                      value: p.id,
                      label: `${p.name}${p.short_code ? ` (${p.short_code})` : ''}`,
                    }))}
                    value={pickedProductByLine[line.id] || ''}
                    onChange={(v) => setPickedProductByLine(prev => ({ ...prev, [line.id]: v }))}
                    placeholder="Select product…"
                    searchPlaceholder="Type to search…"
                    emptyLabel="Select product…"
                    disabled={isBusy}
                  />
                  <button
                    className="line-card__action line-card__action--primary"
                    onClick={() => handleSet(line.id)}
                    disabled={isBusy || !pickedProductByLine[line.id]}
                  >
                    <Play size={16} />
                    {isBusy ? 'Working…' : 'Set as Current'}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ActiveProductionPage;
