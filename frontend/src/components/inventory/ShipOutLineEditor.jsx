import React, { useEffect, useMemo, useState } from 'react';
import { useAppData } from '../../context/AppDataContext';
import SearchableSelect from '../SearchableSelect';
import { formatDate } from '../../utils/dateUtils';
import { CATEGORY_TYPES, RECEIPT_STATUS } from '../../constants';

/**
 * One product line within a multi-product ship-out order.
 *
 * Controlled by parent via `value` / `onChange`:
 *   value = {
 *     productId: string,
 *     casesRequested: number|string,
 *     lotAllocations: [
 *       {
 *         lotNumber: string,
 *         casesRequested: number,      // what this line draws from this lot
 *         casesAvailable: number,      // live snapshot from /available-lots
 *         palletsAvailable: number,
 *         oldestAt: string|null,
 *         rows: [{row_id, row_name, cases, pallets}],
 *       },
 *       ...
 *     ],
 *   }
 *
 * The user picks a product + total cases; the component loads the list of
 * available lots (FIFO order from the backend) and lets them split the order
 * across one or more lots. Forklift commits specific pallets at scan time.
 */
const ShipOutLineEditor = ({ value, onChange, onRemove, canRemove, lineIndex }) => {
  const { products, categories, fetchAvailableLots } = useAppData();
  const [availableLots, setAvailableLots] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // FG products that still have stock somewhere (best-effort filter — the
  // available-lots endpoint is authoritative once a product is picked).
  const finishedGoodsProducts = useMemo(() => {
    return products
      .filter((p) => {
        const cat = categories.find((c) => c.id === p.categoryId);
        return cat?.type === CATEGORY_TYPES.FINISHED;
      })
      .map((p) => ({ value: p.id, label: String(p.name || 'Unknown') }));
  }, [products, categories]);

  const loadLots = async (productId) => {
    if (!productId) {
      setAvailableLots([]);
      return;
    }
    setIsLoading(true);
    setLoadError('');
    try {
      const lots = await fetchAvailableLots(productId);
      setAvailableLots(lots || []);
      if (!lots || lots.length === 0) {
        setLoadError('No lots available for this product.');
      }
    } catch (e) {
      console.error(e);
      setLoadError('Failed to load lot availability.');
    } finally {
      setIsLoading(false);
    }
  };

  // Reload lots whenever product changes. Also reset the lot allocations so
  // a stale allocation from the previous product doesn't survive.
  useEffect(() => {
    if (value.productId) {
      loadLots(value.productId);
    } else {
      setAvailableLots([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.productId]);

  const cases = Number(value.casesRequested) || 0;

  const allocatedCases = (value.lotAllocations || []).reduce(
    (s, la) => s + (Number(la.casesRequested) || 0),
    0
  );
  const shortage = Math.max(0, cases - allocatedCases);
  const overage = Math.max(0, allocatedCases - cases);

  // FIFO auto-fill — distribute `casesRequested` across lots oldest-first,
  // taking whole-lot bites until the total is satisfied.
  const fifoFill = () => {
    if (!cases || availableLots.length === 0) return;
    let remaining = cases;
    const allocs = [];
    for (const lot of availableLots) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, lot.cases_available);
      if (take <= 0) continue;
      allocs.push({
        lotNumber: lot.lot_number,
        casesRequested: take,
        casesAvailable: lot.cases_available,
        palletsAvailable: lot.pallets_available,
        oldestAt: lot.oldest_at,
        rows: lot.rows || [],
      });
      remaining -= take;
    }
    onChange({ ...value, lotAllocations: allocs });
  };

  const updateLotCases = (lotNumber, casesStr) => {
    // Preserve empty string so the input renders blank (with placeholder "0")
    // rather than a real "0" — otherwise typing 500 with the cursor before
    // the 0 produces 5000.
    let nextVal;
    if (casesStr === '' || casesStr === null || casesStr === undefined) {
      nextVal = '';
    } else {
      const n = Number(casesStr);
      nextVal = isNaN(n) || n < 0 ? 0 : n;
    }
    const next = (value.lotAllocations || []).map((la) =>
      la.lotNumber === lotNumber ? { ...la, casesRequested: nextVal } : la
    );
    onChange({ ...value, lotAllocations: next });
  };

  const addLotToAllocation = (lot) => {
    if ((value.lotAllocations || []).some((la) => la.lotNumber === lot.lot_number)) return;
    const next = [
      ...(value.lotAllocations || []),
      {
        lotNumber: lot.lot_number,
        // Start empty so the input shows the placeholder, not a real "0".
        casesRequested: '',
        casesAvailable: lot.cases_available,
        palletsAvailable: lot.pallets_available,
        oldestAt: lot.oldest_at,
        rows: lot.rows || [],
      },
    ];
    onChange({ ...value, lotAllocations: next });
  };

  const removeLotFromAllocation = (lotNumber) => {
    const next = (value.lotAllocations || []).filter((la) => la.lotNumber !== lotNumber);
    onChange({ ...value, lotAllocations: next });
  };

  const lotsNotYetAllocated = useMemo(() => {
    const picked = new Set((value.lotAllocations || []).map((la) => la.lotNumber));
    return availableLots.filter((l) => !picked.has(l.lot_number));
  }, [availableLots, value.lotAllocations]);

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
            onChange={(productId) => onChange({ ...value, productId, lotAllocations: [] })}
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
              Allocated: {allocatedCases.toLocaleString()} / {cases.toLocaleString()} cases
              {shortage > 0 && (
                <span style={{ color: '#dc2626', marginLeft: '8px' }}>
                  short {shortage.toLocaleString()} cs
                </span>
              )}
              {overage > 0 && (
                <span style={{ color: '#dc2626', marginLeft: '8px' }}>
                  over {overage.toLocaleString()} cs
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                type="button"
                onClick={() => loadLots(value.productId)}
                disabled={isLoading}
                style={{ background: 'none', border: '1px solid #cbd5e1', color: '#475569', padding: '3px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' }}
              >
                {isLoading ? 'Loading…' : 'Reload'}
              </button>
              <button
                type="button"
                onClick={fifoFill}
                disabled={!availableLots.length || !cases}
                style={{ background: '#eff6ff', border: '1px solid #93c5fd', color: '#1e40af', padding: '3px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}
              >
                FIFO fill
              </button>
            </div>
          </div>

          {loadError && <div className="alert error" style={{ marginBottom: '6px' }}>{loadError}</div>}

          {/* Selected lot allocations (with editable case counts) */}
          {(value.lotAllocations || []).length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
              {(value.lotAllocations || []).map((la) => {
                const overshoot = la.casesRequested > la.casesAvailable;
                return (
                  <div
                    key={la.lotNumber}
                    style={{
                      display: 'flex',
                      gap: '8px',
                      alignItems: 'center',
                      padding: '6px 8px',
                      background: overshoot ? '#fef2f2' : '#f0fdf4',
                      border: `1px solid ${overshoot ? '#fca5a5' : '#86efac'}`,
                      borderRadius: '6px',
                      fontSize: '12px',
                    }}
                  >
                    <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#1e40af', flex: 1 }}>
                      {la.lotNumber}
                    </span>
                    <span style={{ color: '#6b7280' }}>
                      avail {la.casesAvailable?.toLocaleString()} cs ({la.palletsAvailable} pl)
                    </span>
                    {la.oldestAt && (
                      <span style={{ color: '#9ca3af', fontSize: '11px' }}>
                        oldest: {formatDate(la.oldestAt)}
                      </span>
                    )}
                    <input
                      type="number"
                      min="0"
                      max={la.casesAvailable}
                      value={la.casesRequested}
                      placeholder="0"
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => updateLotCases(la.lotNumber, e.target.value)}
                      style={{
                        width: '110px',
                        padding: '3px 6px',
                        border: `1px solid ${overshoot ? '#fca5a5' : '#cbd5e1'}`,
                        borderRadius: '4px',
                        textAlign: 'right',
                      }}
                    />
                    <span style={{ color: '#6b7280' }}>cs</span>
                    <button
                      type="button"
                      onClick={() => removeLotFromAllocation(la.lotNumber)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: '0 4px', fontSize: '14px' }}
                      title="Remove this lot"
                    >×</button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Available lots (FIFO ordered) to add */}
          {lotsNotYetAllocated.length > 0 && (
            <details>
              <summary style={{ cursor: 'pointer', fontSize: '12px', color: '#6b7280', fontWeight: 600 }}>
                Available lots ({lotsNotYetAllocated.length}) — oldest first
              </summary>
              <div style={{ maxHeight: '200px', overflow: 'auto', paddingTop: '6px' }}>
                {lotsNotYetAllocated.map((lot) => (
                  <button
                    key={lot.lot_number}
                    type="button"
                    onClick={() => addLotToAllocation(lot)}
                    style={{
                      display: 'flex',
                      gap: '8px',
                      alignItems: 'center',
                      padding: '5px 8px',
                      width: '100%',
                      background: '#ffffff',
                      border: '1px solid #e5e7eb',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      marginBottom: '3px',
                      fontSize: '12px',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#1e40af', flex: 1 }}>
                      {lot.lot_number}
                    </span>
                    <span style={{ color: '#6b7280' }}>
                      {lot.cases_available.toLocaleString()} cs · {lot.pallets_available} pallets
                    </span>
                    {lot.oldest_at && (
                      <span style={{ color: '#9ca3af', fontSize: '11px' }}>
                        {formatDate(lot.oldest_at)}
                      </span>
                    )}
                    <span style={{ color: '#1e40af', fontWeight: 600 }}>+ Add</span>
                  </button>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Build the v2 backend payload for a single line.
 *
 * Returns null if the line is incomplete (no product, no cases, no
 * allocations, or sum mismatch).
 */
export const buildLinePayload = (line) => {
  const cases = Number(line.casesRequested);
  if (!line.productId || !cases || cases <= 0) return null;
  if (!line.lotAllocations || line.lotAllocations.length === 0) return null;

  const sum = line.lotAllocations.reduce((s, la) => s + (Number(la.casesRequested) || 0), 0);
  // tolerance for float math
  if (Math.abs(sum - cases) > 0.001) return null;
  if (line.lotAllocations.some((la) => Number(la.casesRequested) <= 0)) return null;
  if (line.lotAllocations.some((la) => Number(la.casesRequested) > la.casesAvailable + 0.001)) return null;

  return {
    productId: line.productId,
    casesRequested: cases,
    lotAllocations: line.lotAllocations.map((la) => ({
      lotNumber: la.lotNumber,
      casesRequested: Number(la.casesRequested),
    })),
  };
};

export const emptyShipOutLine = () => ({
  productId: '',
  casesRequested: '',
  lotAllocations: [],
});

export default ShipOutLineEditor;
