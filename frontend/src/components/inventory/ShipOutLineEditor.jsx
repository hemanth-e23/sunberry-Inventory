import React, { useEffect, useMemo, useState } from 'react';
import { useAppData } from '../../context/AppDataContext';
import SearchableSelect from '../SearchableSelect';
import { formatDate } from '../../utils/dateUtils';
import { CATEGORY_TYPES, RECEIPT_STATUS } from '../../constants';

/**
 * One product line within a multi-product ship-out order.
 *
 * Controlled by parent via `value` / `onChange` props:
 *   value = {
 *     productId: string,
 *     casesRequested: number|string,
 *     selectedPalletIds: string[],
 *     // selectedPalletInfo is a lookup [id -> { id, receipt_id, cases, licence_number, lot_number }]
 *     // maintained by this component so the parent can group by receipt at submit time.
 *     selectedPalletInfo: Record<string, object>,
 *   }
 *   onChange(next)
 *
 * Loads pallet licences for the chosen product, suggests FIFO selection, and lets
 * the user adjust the selection. Multiple receipts per line are allowed (FIFO
 * naturally crosses receipts) — picks are grouped by receipt when the parent
 * submits.
 */
const ShipOutLineEditor = ({ value, onChange, onRemove, canRemove, lineIndex, takenPalletIds }) => {
  const { products, categories, receipts, fetchPalletLicences } = useAppData();
  const [licences, setLicences] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const approvedReceipts = useMemo(
    () => receipts.filter((r) => r.status === RECEIPT_STATUS.APPROVED),
    [receipts]
  );

  const finishedGoodsProducts = useMemo(() => {
    const productIdsWithStock = new Set(
      approvedReceipts.filter((r) => r.quantity > 0).map((r) => r.productId)
    );
    return products
      .filter((p) => {
        const cat = categories.find((c) => c.id === p.categoryId);
        return cat?.type === CATEGORY_TYPES.FINISHED && productIdsWithStock.has(p.id);
      })
      .map((p) => ({ value: p.id, label: String(p.name || 'Unknown') }));
  }, [products, categories, approvedReceipts]);

  const loadLicences = async (productId) => {
    if (!productId) {
      setLicences([]);
      return;
    }
    setIsLoading(true);
    setLoadError('');
    try {
      const list = await fetchPalletLicences({ product_id: productId, status: 'in_stock', is_held: false });
      const sorted = (list || []).sort((a, b) => {
        const dateA = a.expiration_date || a.lot_number || '';
        const dateB = b.expiration_date || b.lot_number || '';
        if (dateA < dateB) return -1;
        if (dateA > dateB) return 1;
        return (a.sequence || 0) - (b.sequence || 0);
      });
      setLicences(sorted);
      if (!sorted.length) {
        setLoadError('No pallets in stock for this product.');
      }
    } catch (e) {
      console.error(e);
      setLoadError('Failed to load pallet licences.');
    } finally {
      setIsLoading(false);
    }
  };

  // Auto-load pallets when the product changes
  useEffect(() => {
    if (value.productId) {
      loadLicences(value.productId);
    } else {
      setLicences([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.productId]);

  const cases = Number(value.casesRequested) || 0;

  const palletInfoFromList = (palletId) => {
    const pl = licences.find((l) => l.id === palletId);
    if (!pl) return null;
    return {
      id: pl.id,
      receipt_id: pl.receipt_id,
      cases: pl.cases || 0,
      licence_number: pl.licence_number,
      lot_number: pl.lot_number,
    };
  };

  // FIFO auto-suggest when cases change
  const autoSelect = () => {
    if (!cases || !licences.length) return;
    const blocked = new Set(takenPalletIds || []);
    let remaining = cases;
    const pickedIds = [];
    const pickedInfo = {};
    for (const pl of licences) {
      if (remaining <= 0) break;
      if (blocked.has(pl.id)) continue;
      pickedIds.push(pl.id);
      pickedInfo[pl.id] = palletInfoFromList(pl.id);
      remaining -= pl.cases || 0;
    }
    onChange({ ...value, selectedPalletIds: pickedIds, selectedPalletInfo: pickedInfo });
  };

  const togglePallet = (palletId, checked) => {
    let nextIds;
    const nextInfo = { ...(value.selectedPalletInfo || {}) };
    if (checked) {
      nextIds = [...value.selectedPalletIds, palletId];
      nextInfo[palletId] = palletInfoFromList(palletId);
    } else {
      nextIds = value.selectedPalletIds.filter((id) => id !== palletId);
      delete nextInfo[palletId];
    }
    onChange({ ...value, selectedPalletIds: nextIds, selectedPalletInfo: nextInfo });
  };

  const selectedPallets = value.selectedPalletIds
    .map((id) => licences.find((l) => l.id === id))
    .filter(Boolean);
  const selectedCases = selectedPallets.reduce((s, p) => s + (p.cases || 0), 0);
  const palletsInLineByReceipt = useMemo(() => {
    const grouped = {};
    selectedPallets.forEach((pl) => {
      if (!grouped[pl.receipt_id]) grouped[pl.receipt_id] = [];
      grouped[pl.receipt_id].push(pl);
    });
    return grouped;
  }, [selectedPallets]);

  const shortage = cases > 0 ? Math.max(0, cases - selectedCases) : 0;

  return (
    <div
      style={{
        border: '1.5px solid #e5e7eb',
        borderRadius: '10px',
        padding: '12px',
        marginBottom: '12px',
        background: '#fafbfc',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <strong style={{ color: '#1e40af' }}>Line {lineIndex + 1}</strong>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            style={{ background: 'none', border: '1px solid #fca5a5', color: '#dc2626', padding: '2px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' }}
          >
            Remove
          </button>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '10px', marginBottom: '10px' }}>
        <label>
          <span>Product <span className="required">*</span></span>
          <SearchableSelect
            options={finishedGoodsProducts}
            value={value.productId}
            onChange={(productId) => onChange({ ...value, productId, selectedPalletIds: [], selectedPalletInfo: {} })}
            placeholder="Select finished goods product"
            searchPlaceholder="Search products..."
          />
        </label>
        <label>
          <span>Cases Needed <span className="required">*</span></span>
          <input
            type="number"
            min="1"
            value={value.casesRequested}
            onChange={(e) => onChange({ ...value, casesRequested: e.target.value })}
            placeholder="0"
          />
        </label>
      </div>

      {value.productId && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
            <div style={{ fontSize: '13px', color: '#6b7280', fontWeight: 600 }}>
              Selected: {selectedPallets.length} pallets · {selectedCases.toLocaleString()} cases
              {shortage > 0 && (
                <span style={{ color: '#dc2626', marginLeft: '8px' }}>
                  short {shortage.toLocaleString()} cs
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                type="button"
                onClick={() => loadLicences(value.productId)}
                disabled={isLoading}
                style={{ background: 'none', border: '1px solid #cbd5e1', color: '#475569', padding: '3px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' }}
              >
                {isLoading ? 'Loading…' : 'Reload'}
              </button>
              <button
                type="button"
                onClick={autoSelect}
                disabled={!licences.length || !cases}
                style={{ background: '#eff6ff', border: '1px solid #93c5fd', color: '#1e40af', padding: '3px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}
              >
                FIFO suggest
              </button>
            </div>
          </div>

          {loadError && <div className="alert error" style={{ marginBottom: '6px' }}>{loadError}</div>}

          {selectedPallets.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: '160px', overflow: 'auto', marginBottom: '6px' }}>
              {Object.entries(palletsInLineByReceipt).map(([receiptId, pls]) => {
                const rcpt = receipts.find((r) => r.id === receiptId);
                return (
                  <div key={receiptId}>
                    <div style={{ fontSize: '11px', color: '#6b7280', padding: '2px 4px', fontWeight: 600 }}>
                      Lot: {rcpt?.lotNo || '—'} ({pls.length} pallets)
                    </div>
                    {pls.map((pl) => (
                      <div
                        key={pl.id}
                        style={{
                          display: 'flex',
                          gap: '6px',
                          alignItems: 'center',
                          padding: '4px 8px',
                          background: '#f0fdf4',
                          border: '1px solid #86efac',
                          borderRadius: '6px',
                          fontSize: '12px',
                          marginBottom: '2px',
                        }}
                      >
                        <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#1e40af', flex: 1 }}>
                          {pl.licence_number}
                        </span>
                        <span style={{ color: '#6b7280' }}>{pl.location || pl.storage_row_id || 'Floor'}</span>
                        <span style={{ color: '#6b7280' }}>· {pl.cases} cs</span>
                        <button
                          type="button"
                          onClick={() => togglePallet(pl.id, false)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: '0 4px', fontSize: '14px' }}
                          title="Remove"
                        >×</button>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}

          {licences.length > 0 && (
            <details>
              <summary style={{ cursor: 'pointer', fontSize: '12px', color: '#6b7280', fontWeight: 600 }}>
                Available pallets ({licences.length}) — expand to add
              </summary>
              <div style={{ maxHeight: '160px', overflow: 'auto', paddingTop: '6px' }}>
                {licences.map((pl) => {
                  const checked = value.selectedPalletIds.includes(pl.id);
                  const blocked = (takenPalletIds || []).includes(pl.id) && !checked;
                  return (
                    <label
                      key={pl.id}
                      style={{
                        display: 'flex',
                        gap: '8px',
                        alignItems: 'center',
                        padding: '4px 8px',
                        borderRadius: '6px',
                        cursor: blocked ? 'not-allowed' : 'pointer',
                        opacity: blocked ? 0.5 : 1,
                        background: checked ? '#f0fdf4' : 'transparent',
                        fontSize: '12px',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={blocked}
                        onChange={(e) => togglePallet(pl.id, e.target.checked)}
                      />
                      <span style={{ fontFamily: 'monospace', fontWeight: 600, color: '#1e40af' }}>{pl.licence_number}</span>
                      <span style={{ color: '#6b7280' }}>{pl.location || pl.storage_row_id || 'Floor'}</span>
                      <span style={{ color: '#6b7280', marginLeft: 'auto' }}>{pl.cases} cs</span>
                      {pl.lot_number && <span style={{ color: '#9ca3af', fontSize: '11px' }}>Lot: {pl.lot_number}</span>}
                      {pl.expiration_date && (
                        <span style={{ color: '#9ca3af', fontSize: '11px' }}>Exp: {formatDate(pl.expiration_date)}</span>
                      )}
                      {blocked && <span style={{ color: '#dc2626', fontSize: '11px' }}>(used elsewhere)</span>}
                    </label>
                  );
                })}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Build the payload shape the backend expects: groups selected pallets by receipt_id.
 * Returns null if the line is incomplete.
 */
export const buildLinePayload = (line) => {
  if (!line.productId || !Number(line.casesRequested) || line.casesRequested <= 0) return null;
  if (!line.selectedPalletIds || line.selectedPalletIds.length === 0) return null;

  const info = line.selectedPalletInfo || {};
  const picksByReceipt = {};
  for (const pid of line.selectedPalletIds) {
    const pl = info[pid];
    if (!pl?.receipt_id) return null;
    if (!picksByReceipt[pl.receipt_id]) picksByReceipt[pl.receipt_id] = [];
    picksByReceipt[pl.receipt_id].push(pid);
  }
  return {
    productId: line.productId,
    casesRequested: Number(line.casesRequested),
    picks: Object.entries(picksByReceipt).map(([receiptId, palletLicenceIds]) => ({
      receiptId,
      palletLicenceIds,
    })),
  };
};

export const emptyShipOutLine = () => ({
  productId: '',
  casesRequested: '',
  selectedPalletIds: [],
  selectedPalletInfo: {},
});

export default ShipOutLineEditor;
