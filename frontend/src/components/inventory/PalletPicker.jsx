import React, { useState, useMemo } from 'react';

/**
 * Dual-panel pallet picker.
 * Left  — all available pallets with search bar
 * Right — confirmed/selected pallets with remove button
 *
 * Props:
 *   pallets      — array of pallet objects from API
 *   selectedIds  — array of selected pallet IDs
 *   onChange     — (newIdsArray) => void
 *   loading      — bool
 *   emptyMessage — string shown when no pallets available
 */
const PalletPicker = ({ pallets = [], selectedIds = [], onChange, loading = false, emptyMessage = 'No pallets available.' }) => {
  const [search, setSearch] = useState('');

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const filteredLeft = useMemo(() => {
    const q = search.trim().toLowerCase();
    return pallets.filter(p => {
      if (selectedSet.has(p.id)) return false;
      if (!q) return true;
      return (
        (p.licence_number || '').toLowerCase().includes(q) ||
        (p.lot_number || '').toLowerCase().includes(q) ||
        (p.storage_row_id || '').toLowerCase().includes(q)
      );
    });
  }, [pallets, selectedSet, search]);

  const selectedPallets = useMemo(
    () => pallets.filter(p => selectedSet.has(p.id)),
    [pallets, selectedSet]
  );

  const totalCases = useMemo(
    () => selectedPallets.reduce((sum, p) => sum + (p.cases || 0), 0),
    [selectedPallets]
  );

  const add = (id) => onChange([...selectedIds, id]);
  const remove = (id) => onChange(selectedIds.filter(x => x !== id));
  const addAll = () => onChange([...selectedIds, ...filteredLeft.map(p => p.id)]);
  const clearAll = () => onChange([]);

  const panelStyle = {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    border: '1px solid #e5e7eb',
    borderRadius: '8px',
    overflow: 'hidden',
    minWidth: 0,
  };

  const panelHeaderStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 10px',
    background: '#f8fafc',
    borderBottom: '1px solid #e5e7eb',
    fontSize: '12px',
    fontWeight: 600,
    color: '#374151',
    flexShrink: 0,
  };

  const listStyle = {
    overflowY: 'auto',
    flex: 1,
    minHeight: '200px',
    maxHeight: '300px',
  };

  // Card-style row — licence number on its own line so it never truncates
  const PalletRow = ({ p, onAction, actionEl }) => (
    <div
      onClick={onAction}
      style={{
        padding: '8px 10px',
        borderBottom: '1px solid #f1f5f9',
        cursor: 'pointer',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: '8px',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = '#f0fdf4'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        {/* Full licence number — always visible, wraps if needed */}
        <div style={{ fontFamily: 'monospace', fontWeight: 700, color: '#1e40af', fontSize: '13px', wordBreak: 'break-all' }}>
          {p.licence_number || p.id}
        </div>
        {/* Secondary info */}
        <div style={{ fontSize: '11.5px', color: '#6b7280', marginTop: '2px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {p.lot_number && <span>Lot: {p.lot_number}</span>}
          {p.storage_row_id && <span>Row: {p.storage_row_id}</span>}
          <span style={{ fontWeight: 600, color: '#374151' }}>{(p.cases || 0).toLocaleString()} cs</span>
        </div>
      </div>
      {actionEl}
    </div>
  );

  return (
    <div>
      {/* Panels */}
      <div style={{ display: 'flex', gap: '10px', marginTop: '6px', flexWrap: 'wrap' }}>
        {/* ── Left: available ── */}
        <div style={{ ...panelStyle, minWidth: '240px' }}>
          <div style={panelHeaderStyle}>
            <span>Available ({filteredLeft.length})</span>
            {filteredLeft.length > 0 && (
              <button type="button" onClick={addAll} style={{ fontSize: '11px', color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600 }}>
                Add all
              </button>
            )}
          </div>

          {/* Search */}
          <div style={{ padding: '6px 8px', borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search licence, lot, row..."
              style={{ width: '100%', border: '1px solid #d1d5db', borderRadius: '5px', padding: '5px 8px', fontSize: '12px', boxSizing: 'border-box', outline: 'none' }}
            />
          </div>

          <div style={listStyle}>
            {loading && (
              <div style={{ padding: '16px', color: '#9ca3af', fontSize: '13px', textAlign: 'center' }}>Loading pallets…</div>
            )}
            {!loading && filteredLeft.length === 0 && (
              <div style={{ padding: '16px', color: '#9ca3af', fontSize: '13px', textAlign: 'center' }}>
                {pallets.length === 0 ? emptyMessage : 'No results match your search.'}
              </div>
            )}
            {!loading && filteredLeft.map(p => (
              <PalletRow
                key={p.id}
                p={p}
                onAction={() => add(p.id)}
                actionEl={
                  <span style={{ fontSize: '18px', color: '#9ca3af', lineHeight: 1, flexShrink: 0, paddingTop: '2px' }}>+</span>
                }
              />
            ))}
          </div>
        </div>

        {/* ── Right: selected ── */}
        <div style={{ ...panelStyle, minWidth: '240px' }}>
          <div style={panelHeaderStyle}>
            <span>Selected ({selectedPallets.length})</span>
            {selectedPallets.length > 0 && (
              <button type="button" onClick={clearAll} style={{ fontSize: '11px', color: '#ef4444', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600 }}>
                Clear all
              </button>
            )}
          </div>

          <div style={listStyle}>
            {selectedPallets.length === 0 && (
              <div style={{ padding: '16px', color: '#9ca3af', fontSize: '13px', textAlign: 'center' }}>
                Click pallets on the left to add them here.
              </div>
            )}
            {selectedPallets.map(p => (
              <PalletRow
                key={p.id}
                p={p}
                onAction={() => remove(p.id)}
                actionEl={
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); remove(p.id); }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: '18px', padding: 0, lineHeight: 1, flexShrink: 0 }}
                    title="Remove"
                  >
                    ×
                  </button>
                }
              />
            ))}
          </div>
        </div>
      </div>

      {/* Summary */}
      {selectedPallets.length > 0 && (
        <div style={{ marginTop: '8px', fontSize: '13px', color: '#374151' }}>
          <strong>{selectedPallets.length}</strong> pallet{selectedPallets.length !== 1 ? 's' : ''} selected ·{' '}
          <strong>{totalCases.toLocaleString()}</strong> cases total
        </div>
      )}
    </div>
  );
};

export default PalletPicker;
