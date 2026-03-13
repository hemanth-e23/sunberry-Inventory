import React, { memo, useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { getDashboardPath } from '../App';
import { formatDate, formatDateTime } from '../utils/dateUtils';
import {
  ArrowRightLeft, Plus, RefreshCw, ChevronDown, ChevronUp, X
} from 'lucide-react';

const STATUS_CONFIG = {
  initiated:           { label: 'Initiated',            color: '#3b82f6', bg: '#eff6ff' },
  confirmed_by_sender: { label: 'Confirmed by Sender',  color: '#f59e0b', bg: '#fffbeb' },
  in_transit:          { label: 'In Transit',           color: '#8b5cf6', bg: '#f5f3ff' },
  received:            { label: 'Received',             color: '#0891b2', bg: '#ecfeff' },
  completed:           { label: 'Completed',            color: '#16a34a', bg: '#f0fdf4' },
  cancelled:           { label: 'Cancelled',            color: '#6b7280', bg: '#f9fafb' },
  disputed:            { label: 'Disputed',             color: '#dc2626', bg: '#fef2f2' },
};

const CORPORATE_ROLES = ['superadmin', 'corporate_admin', 'corporate_viewer'];

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || { label: status, color: '#6b7280', bg: '#f9fafb' };
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 12,
      fontSize: 12, fontWeight: 600,
      color: cfg.color, background: cfg.bg, border: `1px solid ${cfg.color}33`,
    }}>
      {cfg.label}
    </span>
  );
}

// ---- Searchable Product Picker ----
function ProductSearchSelect({ products, value, onChange, inputStyle, labelStyle }) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const selected = products.find(p => p.id === value);

  useEffect(() => {
    const handleClick = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const filtered = search.trim()
    ? products.filter(p => {
        const q = search.toLowerCase();
        return p.name.toLowerCase().includes(q) || (p.fcc_code && p.fcc_code.toLowerCase().includes(q));
      })
    : products;

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      <label style={labelStyle}>Product *</label>
      <input
        style={inputStyle}
        type="text"
        placeholder="Type to search products..."
        value={open ? search : (selected ? `${selected.name}${selected.fcc_code ? ` (${selected.fcc_code})` : ''}` : '')}
        onFocus={() => { setOpen(true); setSearch(''); }}
        onChange={e => { setSearch(e.target.value); setOpen(true); }}
      />
      {value && !open && (
        <button type="button" onClick={() => { onChange(''); setSearch(''); }} style={{
          position: 'absolute', right: 8, top: 28, background: 'none', border: 'none',
          cursor: 'pointer', color: '#9ca3af', fontSize: 16, lineHeight: 1, padding: 2,
        }}>&times;</button>
      )}
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
          background: '#fff', border: '1px solid #d1d5db', borderRadius: 6,
          maxHeight: 200, overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
        }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '10px 12px', fontSize: 13, color: '#9ca3af' }}>No products found</div>
          ) : filtered.slice(0, 50).map(p => (
            <div key={p.id} onClick={() => { onChange(p.id); setSearch(''); setOpen(false); }}
              style={{
                padding: '8px 12px', fontSize: 14, cursor: 'pointer',
                background: p.id === value ? '#eff6ff' : '#fff',
              }}
              onMouseEnter={e => e.currentTarget.style.background = '#f3f4f6'}
              onMouseLeave={e => e.currentTarget.style.background = p.id === value ? '#eff6ff' : '#fff'}
            >
              {p.name}{p.fcc_code ? <span style={{ color: '#6b7280', marginLeft: 6 }}>({p.fcc_code})</span> : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Initiate Transfer Modal ----
function InitiateModal({ onClose, onCreated }) {
  const [warehouses, setWarehouses] = useState([]);
  const [products, setProducts] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [availableReceipts, setAvailableReceipts] = useState([]);
  const [loadingReceipts, setLoadingReceipts] = useState(false);
  const [unitLocked, setUnitLocked] = useState(false);
  const [containerEntry, setContainerEntry] = useState(''); // barrel count entry
  const [selectedReceipt, setSelectedReceipt] = useState(null);
  const [form, setForm] = useState({
    from_warehouse_id: '', to_warehouse_id: '', product_id: '',
    lot_number: '', quantity: '', unit: 'cases',
    source_receipt_id: '',
    reference_number: '', expected_arrival_date: '', notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    apiClient.get('/master-data/warehouses')
      .then(res => setWarehouses(res.data))
      .catch(() => {});
  }, []);

  // Fetch available products when source warehouse is selected
  useEffect(() => {
    if (!form.from_warehouse_id) {
      setProducts([]);
      return;
    }
    setLoadingProducts(true);
    apiClient.get('/inter-warehouse-transfers/available-products', {
      params: { warehouse_id: form.from_warehouse_id },
    }).then(res => {
      setProducts(res.data);
    }).catch(() => {
      setProducts([]);
    }).finally(() => setLoadingProducts(false));
  }, [form.from_warehouse_id]);

  // Fetch available receipts when warehouse + product are selected
  useEffect(() => {
    if (!form.from_warehouse_id || !form.product_id) {
      setAvailableReceipts([]);
      return;
    }
    setLoadingReceipts(true);
    apiClient.get('/inter-warehouse-transfers/available-receipts', {
      params: { warehouse_id: form.from_warehouse_id, product_id: form.product_id },
    }).then(res => {
      setAvailableReceipts(res.data);
    }).catch(() => {
      setAvailableReceipts([]);
    }).finally(() => setLoadingReceipts(false));
  }, [form.from_warehouse_id, form.product_id]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleReceiptSelect = (receiptId) => {
    const rcpt = availableReceipts.find(r => r.id === receiptId);
    if (rcpt) {
      setForm(f => ({
        ...f,
        source_receipt_id: rcpt.id,
        lot_number: rcpt.lot_number || '',
        unit: rcpt.unit || f.unit,
      }));
      setSelectedReceipt(rcpt);
      setUnitLocked(true);
      setContainerEntry('');
    } else {
      setForm(f => ({ ...f, source_receipt_id: '' }));
      setSelectedReceipt(null);
      setUnitLocked(false);
      setContainerEntry('');
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!form.from_warehouse_id || !form.to_warehouse_id || !form.product_id || !form.quantity) {
      setError('Please fill in all required fields.');
      return;
    }
    if (form.from_warehouse_id === form.to_warehouse_id) {
      setError('Source and destination must be different warehouses.');
      return;
    }
    // Validate quantity against selected receipt
    if (form.source_receipt_id) {
      const rcpt = availableReceipts.find(r => r.id === form.source_receipt_id);
      if (rcpt && parseFloat(form.quantity) > rcpt.quantity) {
        setError(`Quantity exceeds available in selected lot (${rcpt.quantity} ${rcpt.unit}).`);
        return;
      }
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        quantity: parseFloat(form.quantity),
        lot_number: form.lot_number || null,
        source_receipt_id: form.source_receipt_id || null,
        reference_number: form.reference_number || null,
        expected_arrival_date: form.expected_arrival_date || null,
        notes: form.notes || null,
      };
      const res = await apiClient.post('/inter-warehouse-transfers/', payload);
      onCreated(res.data);
      onClose();
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to initiate transfer.');
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = {
    width: '100%', padding: '8px 10px', borderRadius: 6,
    border: '1px solid #d1d5db', fontSize: 14, boxSizing: 'border-box',
  };
  const labelStyle = { display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4, color: '#374151' };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '20px',
    }}>
      <div style={{
        background: '#fff', borderRadius: 12, padding: 28, width: 520,
        maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Initiate Transfer</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}>
            <X size={20} />
          </button>
        </div>

        {error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '8px 12px', marginBottom: 16, color: '#dc2626', fontSize: 14 }}>
            {error}
          </div>
        )}

        <form onSubmit={submit}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div>
              <label style={labelStyle}>From Warehouse *</label>
              <select style={inputStyle} value={form.from_warehouse_id} onChange={e => {
                const val = e.target.value;
                setForm(f => ({
                  ...f,
                  from_warehouse_id: val,
                  to_warehouse_id: f.to_warehouse_id === val ? '' : f.to_warehouse_id,
                  product_id: '',
                  source_receipt_id: '',
                  lot_number: '',
                }));
                setSelectedReceipt(null);
                setUnitLocked(false);
                setContainerEntry('');
              }} required>
                <option value="">Select source...</option>
                {warehouses.map(w => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>To Warehouse *</label>
              <select style={inputStyle} value={form.to_warehouse_id} onChange={e => set('to_warehouse_id', e.target.value)} required>
                <option value="">Select destination...</option>
                {warehouses.filter(w => w.id !== form.from_warehouse_id).map(w => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}
              </select>
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            {!form.from_warehouse_id ? (
              <div>
                <label style={labelStyle}>Product *</label>
                <div style={{ ...inputStyle, background: '#f3f4f6', color: '#9ca3af' }}>Select a source warehouse first</div>
              </div>
            ) : loadingProducts ? (
              <div>
                <label style={labelStyle}>Product *</label>
                <div style={{ ...inputStyle, background: '#f3f4f6', color: '#6b7280' }}>Loading available products...</div>
              </div>
            ) : products.length === 0 ? (
              <div>
                <label style={labelStyle}>Product *</label>
                <div style={{ ...inputStyle, background: '#fef2f2', color: '#dc2626', border: '1px solid #fca5a5' }}>No products with available inventory at this warehouse</div>
              </div>
            ) : (
            <ProductSearchSelect
              products={products}
              value={form.product_id}
              onChange={v => {
                set('product_id', v);
                if (!v) {
                  setForm(f => ({ ...f, product_id: '', source_receipt_id: '', lot_number: '' }));
                  setUnitLocked(false);
                }
              }}
              inputStyle={inputStyle}
              labelStyle={labelStyle}
            />
            )}
          </div>

          {/* Source Lot picker — shown when warehouse + product are selected */}
          {form.from_warehouse_id && form.product_id && (
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Source Lot (optional)</label>
              {loadingReceipts ? (
                <div style={{ fontSize: 13, color: '#6b7280', padding: '8px 0' }}>Loading available lots...</div>
              ) : availableReceipts.length === 0 ? (
                <div style={{ fontSize: 13, color: '#f59e0b', padding: '8px 0' }}>No available receipts found at this warehouse for this product.</div>
              ) : (
                <select style={inputStyle} value={form.source_receipt_id} onChange={e => handleReceiptSelect(e.target.value)}>
                  <option value="">Auto-select (FIFO)</option>
                  {availableReceipts.map(r => (
                    <option key={r.id} value={r.id}>
                      {r.lot_number ? `Lot: ${r.lot_number}` : 'No lot'} | Qty: {r.quantity} {r.unit} | {r.status}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* Container helper — shown when receipt has barrel/container data */}
          {selectedReceipt?.weight_per_container && selectedReceipt?.container_unit && (
            <div style={{ marginBottom: 14, background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: '10px 14px' }}>
              <div style={{ fontSize: 12, color: '#0369a1', fontWeight: 600, marginBottom: 6 }}>
                1 {selectedReceipt.container_unit} = {selectedReceipt.weight_per_container} {form.unit}
                {selectedReceipt.container_count && (
                  <span style={{ fontWeight: 400, marginLeft: 8 }}>
                    ({Math.round(selectedReceipt.container_count)} {selectedReceipt.container_unit}s available in this lot)
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' }}>
                  # of {selectedReceipt.container_unit}s:
                </label>
                <input
                  style={{ ...inputStyle, width: 100 }}
                  type="number" min="0.01" step="0.01"
                  value={containerEntry}
                  placeholder="e.g. 10"
                  onChange={e => {
                    const count = e.target.value;
                    setContainerEntry(count);
                    if (count && !isNaN(parseFloat(count))) {
                      const totalWeight = parseFloat(count) * selectedReceipt.weight_per_container;
                      set('quantity', String(Math.round(totalWeight * 100) / 100));
                    }
                  }}
                />
                <span style={{ fontSize: 13, color: '#6b7280' }}>
                  {containerEntry && !isNaN(parseFloat(containerEntry))
                    ? `= ${Math.round(parseFloat(containerEntry) * selectedReceipt.weight_per_container)} ${form.unit}`
                    : ''}
                </span>
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div>
              <label style={labelStyle}>Quantity ({form.unit}) *</label>
              <input style={inputStyle} type="number" min="0.01" step="0.01" value={form.quantity} onChange={e => { set('quantity', e.target.value); setContainerEntry(''); }} required />
            </div>
            <div>
              <label style={labelStyle}>Unit</label>
              {unitLocked ? (
                <input style={{ ...inputStyle, background: '#f3f4f6', color: '#6b7280' }} type="text" value={form.unit} readOnly />
              ) : (
                <select style={inputStyle} value={form.unit} onChange={e => set('unit', e.target.value)}>
                  <option value="cases">Cases</option>
                  <option value="pallets">Pallets</option>
                  <option value="lbs">Lbs</option>
                  <option value="kg">Kg</option>
                  <option value="gallons">Gallons</option>
                </select>
              )}
            </div>
            <div>
              <label style={labelStyle}>Lot Number</label>
              <input style={inputStyle} type="text" value={form.lot_number} onChange={e => set('lot_number', e.target.value)} placeholder="Optional" />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div>
              <label style={labelStyle}>Reference / BOL / PO</label>
              <input style={inputStyle} type="text" value={form.reference_number} onChange={e => set('reference_number', e.target.value)} placeholder="Optional" />
            </div>
            <div>
              <label style={labelStyle}>Expected Arrival</label>
              <input style={inputStyle} type="date" value={form.expected_arrival_date} onChange={e => set('expected_arrival_date', e.target.value)} />
            </div>
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={labelStyle}>Notes</label>
            <textarea style={{ ...inputStyle, height: 70, resize: 'vertical' }} value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Optional instructions..." />
          </div>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingBottom: 4 }}>
            <button type="button" onClick={onClose} style={{
              padding: '9px 20px', borderRadius: 6, border: '1px solid #d1d5db',
              background: '#fff', cursor: 'pointer', fontSize: 14, color: '#374151',
            }}>Cancel</button>
            <button type="submit" disabled={saving} style={{
              padding: '9px 20px', borderRadius: 6, border: 'none',
              background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 600,
            }}>
              {saving ? 'Initiating...' : 'Initiate Transfer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---- Action Note Modal ----
function ActionModal({ title, onClose, onConfirm, requireNote = false, noteLabel = 'Notes (optional)' }) {
  const [notes, setNotes] = useState('');
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 10, padding: 24, width: 400, boxShadow: '0 10px 30px rgba(0,0,0,0.2)' }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 16 }}>{title}</h3>
        <textarea
          value={notes} onChange={e => setNotes(e.target.value)}
          placeholder={requireNote ? 'Required...' : 'Optional...'}
          style={{ width: '100%', height: 80, padding: 8, borderRadius: 6, border: '1px solid #d1d5db', fontSize: 14, resize: 'vertical', boxSizing: 'border-box' }}
        />
        <p style={{ fontSize: 12, color: '#6b7280', margin: '4px 0 16px' }}>{noteLabel}</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => { if (requireNote && !notes.trim()) return; onConfirm(notes); }}
            style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Confirm Shipment Modal (with receipt picker + row/pallet selection) ----
function ConfirmShipmentModal({ transfer, onClose, onConfirm }) {
  const [receipts, setReceipts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedReceipt, setSelectedReceipt] = useState('');
  const [notes, setNotes] = useState('');

  // Category detection
  const [categories, setCategories] = useState([]);
  const [isFG, setIsFG] = useState(null); // null = not yet determined

  // RM row picker state
  const [rowSelections, setRowSelections] = useState({});

  // FG pallet picker state
  const [pallets, setPallets] = useState([]);
  const [loadingPallets, setLoadingPallets] = useState(false);
  const [selectedPalletIds, setSelectedPalletIds] = useState([]);

  useEffect(() => {
    apiClient.get('/products/categories')
      .then(res => setCategories(res.data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    apiClient.get('/inter-warehouse-transfers/available-receipts', {
      params: {
        warehouse_id: transfer.from_warehouse_id,
        product_id: transfer.product_id,
        ...(transfer.lot_number ? { lot_number: transfer.lot_number } : {}),
      },
    }).then(res => {
      let list = res.data;
      // Ensure the pre-linked receipt is in the list even if quantity dropped
      if (transfer.source_receipt_id && !list.find(r => r.id === transfer.source_receipt_id)) {
        apiClient.get('/inter-warehouse-transfers/available-receipts', {
          params: { warehouse_id: transfer.from_warehouse_id, product_id: transfer.product_id },
        }).then(res2 => {
          const linked = res2.data.find(r => r.id === transfer.source_receipt_id);
          if (linked) setReceipts([linked, ...list]);
          else setReceipts(list);
        }).catch(() => setReceipts(list));
      } else {
        setReceipts(list);
      }
    }).catch(() => setReceipts([]))
      .finally(() => setLoading(false));
  }, [transfer]);

  // Determine FG vs RM when receipt is selected and categories are loaded
  // When transfer already has source_receipt_id, prefer that receipt
  const effectiveReceiptId = selectedReceipt || transfer.source_receipt_id || '';
  const activeReceipt = receipts.find(r => r.id === effectiveReceiptId) || (receipts.length > 0 ? receipts[0] : null);

  useEffect(() => {
    if (!activeReceipt || categories.length === 0) {
      setIsFG(null);
      return;
    }
    const cat = categories.find(c => c.id === activeReceipt.category_id);
    const finished = cat && (cat.parent_id === 'group-finished' || cat.type === 'finished');
    setIsFG(!!finished);

    // Load pallets for FG
    if (finished && activeReceipt.id) {
      setLoadingPallets(true);
      apiClient.get('/pallet-licences/', {
        params: { receipt_id: activeReceipt.id, status: 'in_stock' },
      }).then(res => {
        const available = res.data.filter(pl => !pl.is_held);
        setPallets(available);
        // Auto-select FIFO pallets to meet transfer quantity
        const needed = transfer.quantity;
        let accumulated = 0;
        const autoSelected = [];
        for (const pl of available) {
          if (accumulated >= needed) break;
          autoSelected.push(pl.id);
          accumulated += (pl.cases || 0);
        }
        setSelectedPalletIds(autoSelected);
      }).catch(() => setPallets([]))
        .finally(() => setLoadingPallets(false));
    } else {
      setPallets([]);
      setSelectedPalletIds([]);
    }

    // Initialize row selections for RM
    if (!finished) {
      setRowSelections({});
    }
  }, [activeReceipt?.id, categories.length]);

  // Build available sources for RM from receipt data
  const availableSources = [];
  if (isFG === false && activeReceipt) {
    if (activeReceipt.raw_material_row_allocations && Array.isArray(activeReceipt.raw_material_row_allocations)) {
      for (const alloc of activeReceipt.raw_material_row_allocations) {
        const palletCount = alloc.pallets || 0;
        const cpp = activeReceipt.cases_per_pallet || 40;
        availableSources.push({
          id: alloc.rowId,
          label: `${alloc.areaName || ''} / ${alloc.rowName || alloc.rowId}`.trim(),
          available: palletCount * cpp,
          pallets: palletCount,
        });
      }
    } else if (activeReceipt.storage_row_id && activeReceipt.pallets) {
      availableSources.push({
        id: activeReceipt.storage_row_id,
        label: `Row ${activeReceipt.storage_row_id}`,
        available: (activeReceipt.pallets || 0) * (activeReceipt.cases_per_pallet || 40),
        pallets: activeReceipt.pallets,
      });
    }
  }

  const selectedRmQty = Object.values(rowSelections).reduce((s, v) => s + (Number(v) || 0), 0);
  const selectedPalletCases = pallets
    .filter(pl => selectedPalletIds.includes(pl.id))
    .reduce((s, pl) => s + (pl.cases || 0), 0);

  const inputStyle = {
    width: '100%', padding: '8px 10px', borderRadius: 6,
    border: '1px solid #d1d5db', fontSize: 14, boxSizing: 'border-box',
  };
  const labelStyle = { display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4, color: '#374151' };

  const canConfirm = (() => {
    if (isFG === true) return selectedPalletIds.length > 0 || pallets.length === 0; // allow legacy FG without pallet licences
    if (isFG === false && availableSources.length > 0) return Math.abs(selectedRmQty - transfer.quantity) <= 0.01;
    return true; // legacy / no category detection
  })();

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 10, padding: 24, width: 580, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 10px 30px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Confirm Shipment Preparation</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}>
            <X size={18} />
          </button>
        </div>

        {/* Transfer summary */}
        <div style={{ marginBottom: 14, padding: '10px 14px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}>
          <strong>{transfer.product?.name || transfer.product_id}</strong>
          <span style={{ color: '#6b7280', marginLeft: 8 }}>{transfer.quantity.toLocaleString()} {transfer.unit}</span>
        </div>

        {/* Receipt picker (if not pre-linked) */}
        {!transfer.source_receipt_id && (
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Select Source Receipt *</label>
            {loading ? (
              <div style={{ fontSize: 13, color: '#6b7280' }}>Loading receipts...</div>
            ) : receipts.length === 0 ? (
              <div style={{ fontSize: 13, color: '#dc2626' }}>No available receipts with enough quantity.</div>
            ) : (
              <select style={inputStyle} value={selectedReceipt} onChange={e => setSelectedReceipt(e.target.value)}>
                <option value="">Auto-select (FIFO)</option>
                {receipts.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.lot_number ? `Lot: ${r.lot_number}` : 'No lot'} | Qty: {r.quantity} {r.unit} | {r.status}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {/* RM Row Picker */}
        {isFG === false && availableSources.length > 0 && (
          <div style={{ marginBottom: 14, padding: '12px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#92400e' }}>Select Source Rows</span>
              <span style={{ fontSize: 12, color: Math.abs(selectedRmQty - transfer.quantity) <= 0.01 ? '#16a34a' : '#dc2626' }}>
                {selectedRmQty.toLocaleString()} / {transfer.quantity.toLocaleString()} {transfer.unit}
              </span>
            </div>
            {availableSources.map(src => (
              <div key={src.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 13, flex: 1 }}>
                  {src.label} — <span style={{ color: '#6b7280' }}>{src.available.toLocaleString()} avail ({src.pallets} pallets)</span>
                </span>
                <input
                  type="number"
                  min="0"
                  max={src.available}
                  step="1"
                  value={rowSelections[src.id] ?? ''}
                  onChange={e => setRowSelections(prev => ({ ...prev, [src.id]: e.target.value }))}
                  placeholder="0"
                  style={{ ...inputStyle, width: 100 }}
                />
              </div>
            ))}
            {availableSources.length === 1 && (
              <div style={{ marginTop: 4 }}>
                <button type="button" onClick={() => setRowSelections({ [availableSources[0].id]: String(transfer.quantity) })}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#2563eb', textDecoration: 'underline', padding: 0 }}>
                  Use all from this row
                </button>
              </div>
            )}
          </div>
        )}

        {/* FG Pallet Picker — only show when pallets exist */}
        {isFG === true && !loadingPallets && pallets.length > 0 && (
          <div style={{ marginBottom: 14, padding: '12px 14px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#166534' }}>Select Pallets to Ship</span>
              <span style={{ fontSize: 12, color: '#6b7280' }}>
                {selectedPalletIds.length} pallets &middot; {selectedPalletCases} cases
              </span>
            </div>
            {selectedPalletIds.length > 0 && (
              <div style={{ marginBottom: 8, fontSize: 12, color: '#166534' }}>
                {selectedPalletIds.length} pallets selected ({selectedPalletCases} cases)
              </div>
            )}
            <div style={{ maxHeight: 200, overflowY: 'auto' }}>
              {pallets.map(pl => {
                const isSelected = selectedPalletIds.includes(pl.id);
                return (
                  <label key={pl.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '5px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                    background: isSelected ? '#dcfce7' : 'transparent', marginBottom: 2,
                  }}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={e => {
                        if (e.target.checked) {
                          setSelectedPalletIds(prev => [...prev, pl.id]);
                        } else {
                          setSelectedPalletIds(prev => prev.filter(x => x !== pl.id));
                        }
                      }}
                    />
                    <span style={{ fontFamily: 'monospace', fontWeight: 600, color: '#1e40af' }}>
                      {pl.licence_number}
                    </span>
                    <span style={{ color: '#6b7280' }}>
                      {pl.location || pl.storage_row_id || 'Floor'}
                    </span>
                    <span style={{ color: '#6b7280', marginLeft: 'auto' }}>{pl.cases} cases</span>
                    {pl.lot_number && <span style={{ color: '#9ca3af', fontSize: 11 }}>Lot: {pl.lot_number}</span>}
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {/* FG loading state */}
        {isFG === true && loadingPallets && (
          <div style={{ marginBottom: 14, padding: '10px 14px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, color: '#6b7280' }}>
            Loading available pallets...
          </div>
        )}

        {/* FG without pallet licences — inventory will be deducted proportionally */}
        {isFG === true && !loadingPallets && pallets.length === 0 && (
          <div style={{ marginBottom: 14, padding: '10px 14px', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, fontSize: 13, color: '#0369a1' }}>
            No scanned pallets found for this receipt. Inventory will be deducted proportionally from storage rows at shipment.
          </div>
        )}

        <textarea
          value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="Optional notes..."
          style={{ width: '100%', height: 70, padding: 8, borderRadius: 6, border: '1px solid #d1d5db', fontSize: 14, resize: 'vertical', boxSizing: 'border-box' }}
        />
        <p style={{ fontSize: 12, color: '#6b7280', margin: '4px 0 16px' }}>Notes (optional)</p>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>Cancel</button>
          <button
            disabled={!canConfirm}
            onClick={() => {
              const payload = {};
              if (selectedReceipt) payload.source_receipt_id = selectedReceipt;
              if (notes) payload.notes = notes;

              // FG: send pallet IDs
              if (isFG === true && selectedPalletIds.length > 0) {
                payload.pallet_licence_ids = selectedPalletIds;
              }

              // RM: send source breakdown
              if (isFG === false && availableSources.length > 0) {
                payload.source_breakdown = Object.entries(rowSelections)
                  .filter(([, qty]) => Number(qty) > 0)
                  .map(([rowId, qty]) => ({ id: `row-${rowId}`, quantity: Number(qty) }));
              }

              onConfirm(payload);
            }}
            style={{
              padding: '8px 16px', borderRadius: 6, border: 'none',
              background: canConfirm ? '#f59e0b' : '#d1d5db', color: '#fff',
              cursor: canConfirm ? 'pointer' : 'not-allowed', fontWeight: 600,
            }}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Place in Storage Modal (for destination receipts without storage) ----
function PlaceInStorageModal({ receiptId, warehouseId, productName, quantity, unit, onClose, onSaved }) {
  const { addToast } = useToast();
  const [locations, setLocations] = useState([]);
  const [subLocations, setSubLocations] = useState([]);
  const [rows, setRows] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState('');
  const [selectedSubLocation, setSelectedSubLocation] = useState('');
  const [palletCount, setPalletCount] = useState('');
  const [casesPerPallet, setCasesPerPallet] = useState('');
  const [rowAllocations, setRowAllocations] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Load locations for this warehouse
  useEffect(() => {
    apiClient.get('/master-data/locations', { params: { warehouse_id: warehouseId } })
      .then(res => setLocations(res.data))
      .catch(() => {});
  }, [warehouseId]);

  // Load sub-locations when location selected
  useEffect(() => {
    if (!selectedLocation) { setSubLocations([]); return; }
    apiClient.get('/master-data/sub-locations', { params: { location_id: selectedLocation } })
      .then(res => setSubLocations(res.data))
      .catch(() => setSubLocations([]));
  }, [selectedLocation]);

  // Get rows from sub-location data (rows are nested in the sub-locations response)
  useEffect(() => {
    if (!selectedSubLocation) { setRows([]); setRowAllocations([]); return; }
    const sl = subLocations.find(s => s.id === selectedSubLocation);
    const active = (sl?.rows || []).filter(r => r.is_active !== false);
    setRows(active);
    setRowAllocations([]);
  }, [selectedSubLocation, subLocations]);

  const totalAllocated = rowAllocations.reduce((s, a) => s + (Number(a.pallets) || 0), 0);
  const canSave = palletCount && Number(palletCount) > 0 && totalAllocated === Number(palletCount);

  const handleSave = async () => {
    setError('');
    setSaving(true);
    try {
      const payload = {
        location_id: selectedLocation || null,
        sub_location_id: selectedSubLocation || null,
        pallets: Number(palletCount),
        cases_per_pallet: casesPerPallet ? Number(casesPerPallet) : null,
      };
      if (rowAllocations.length === 1) {
        payload.storage_row_id = rowAllocations[0].rowId;
      }
      if (rowAllocations.length > 0) {
        payload.raw_material_row_allocations = rowAllocations.map(a => ({
          rowId: a.rowId,
          rowName: a.rowName,
          areaName: a.areaName || '',
          pallets: Number(a.pallets),
        }));
      }
      await apiClient.post(`/receipts/${receiptId}/assign-storage`, payload);
      addToast('Storage location assigned successfully.', 'success');
      onSaved();
      onClose();
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to assign storage.');
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = {
    width: '100%', padding: '8px 10px', borderRadius: 6,
    border: '1px solid #d1d5db', fontSize: 14, boxSizing: 'border-box',
  };
  const labelStyle = { display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4, color: '#374151' };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 10, padding: 24, width: 520, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 10px 30px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Place in Storage</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ marginBottom: 14, padding: '10px 14px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}>
          <strong>{productName}</strong>
          <span style={{ color: '#6b7280', marginLeft: 8 }}>{quantity?.toLocaleString()} {unit}</span>
        </div>

        {error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '8px 12px', marginBottom: 14, color: '#dc2626', fontSize: 13 }}>
            {error}
          </div>
        )}

        {/* Location */}
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Location *</label>
          <select style={inputStyle} value={selectedLocation} onChange={e => { setSelectedLocation(e.target.value); setSelectedSubLocation(''); }}>
            <option value="">Select location...</option>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>

        {/* Sub-Location */}
        {selectedLocation && (
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Sub-Location *</label>
            <select style={inputStyle} value={selectedSubLocation} onChange={e => setSelectedSubLocation(e.target.value)}>
              <option value="">Select sub-location...</option>
              {subLocations.map(sl => <option key={sl.id} value={sl.id}>{sl.name}</option>)}
            </select>
          </div>
        )}

        {/* Pallet count + cases per pallet */}
        {selectedSubLocation && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={labelStyle}>Total Pallets *</label>
              <input style={inputStyle} type="number" min="1" step="1" value={palletCount}
                onChange={e => { setPalletCount(e.target.value); setRowAllocations([]); }}
                placeholder="e.g. 10" />
            </div>
            <div>
              <label style={labelStyle}>Cases per Pallet</label>
              <input style={inputStyle} type="number" min="1" step="1" value={casesPerPallet}
                onChange={e => setCasesPerPallet(e.target.value)}
                placeholder="Optional" />
            </div>
          </div>
        )}

        {/* Row selection */}
        {selectedSubLocation && palletCount && Number(palletCount) > 0 && rows.length > 0 && (
          <div style={{ marginBottom: 14, padding: '12px 14px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Select Row(s)</span>
              <span style={{ fontSize: 12, color: totalAllocated === Number(palletCount) ? '#16a34a' : '#dc2626' }}>
                {totalAllocated} / {palletCount} pallets allocated
              </span>
            </div>
            <div style={{ maxHeight: 200, overflowY: 'auto' }}>
              {rows.map(row => {
                const available = (row.pallet_capacity || 0) - (row.occupied_pallets || 0);
                const isSelected = rowAllocations.some(a => a.rowId === row.id);
                const alloc = rowAllocations.find(a => a.rowId === row.id);
                return (
                  <div key={row.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
                    borderRadius: 6, marginBottom: 4,
                    background: isSelected ? '#f0fdf4' : 'transparent',
                    border: isSelected ? '1px solid #bbf7d0' : '1px solid transparent',
                  }}>
                    <input type="checkbox" checked={isSelected} onChange={e => {
                      if (e.target.checked) {
                        const remaining = Math.max(0, Number(palletCount) - totalAllocated);
                        const palletsForRow = row.pallet_capacity > 0 ? Math.min(remaining, available) : remaining;
                        setRowAllocations(prev => [...prev, {
                          rowId: row.id, rowName: row.name, areaName: row.storage_area_name || '',
                          pallets: palletsForRow, available,
                        }]);
                      } else {
                        setRowAllocations(prev => prev.filter(a => a.rowId !== row.id));
                      }
                    }} />
                    <span style={{ fontSize: 13, flex: 1 }}>
                      {row.name}
                      {row.pallet_capacity > 0 && (
                        <span style={{ color: '#6b7280', marginLeft: 6 }}>
                          ({available} of {row.pallet_capacity} avail)
                        </span>
                      )}
                    </span>
                    {isSelected && (
                      <input type="number" min="1" max={available || undefined} step="1"
                        value={alloc?.pallets ?? ''}
                        onChange={e => setRowAllocations(prev => prev.map(a =>
                          a.rowId === row.id ? { ...a, pallets: Number(e.target.value) || 0 } : a
                        ))}
                        style={{ ...inputStyle, width: 70, textAlign: 'center' }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* No rows available — unlimited storage */}
        {selectedSubLocation && palletCount && Number(palletCount) > 0 && rows.length === 0 && (
          <div style={{ marginBottom: 14, padding: '10px 14px', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, fontSize: 13, color: '#0369a1' }}>
            No storage rows configured for this sub-location. Pallets will be stored without specific row assignment.
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>Cancel</button>
          <button
            disabled={!canSave && rows.length > 0 || saving || !palletCount}
            onClick={handleSave}
            style={{
              padding: '8px 16px', borderRadius: 6, border: 'none',
              background: '#2563eb', color: '#fff', cursor: 'pointer', fontWeight: 600,
              opacity: (!canSave && rows.length > 0) || saving || !palletCount ? 0.5 : 1,
            }}
          >
            {saving ? 'Saving...' : 'Assign Storage'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Transfer Card ----
const TransferCard = memo(function TransferCard({ transfer, currentUser, onAction }) {
  const { addToast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [actionModal, setActionModal] = useState(null);
  const [showConfirmShipment, setShowConfirmShipment] = useState(false);
  const [showPlaceInStorage, setShowPlaceInStorage] = useState(false);

  const isCorporate = CORPORATE_ROLES.includes(currentUser?.role);
  const isFromWarehouse = currentUser?.warehouse_id === transfer.from_warehouse_id;
  const isToWarehouse = currentUser?.warehouse_id === transfer.to_warehouse_id;
  const canAct = isCorporate || isFromWarehouse || isToWarehouse;

  const doAction = async (endpoint, payload = {}) => {
    try {
      const res = await apiClient.post(
        `/inter-warehouse-transfers/${transfer.id}/${endpoint}`,
        payload
      );
      onAction(res.data);
    } catch (err) {
      addToast(err.response?.data?.detail || 'Action failed.', 'error');
    }
  };

  const actions = [];
  const { status } = transfer;

  if (status === 'initiated') {
    if (isCorporate || isFromWarehouse)
      actions.push({ label: 'Confirm Shipment', color: '#f59e0b', endpoint: 'confirm', customModal: true });
    if (isCorporate)
      actions.push({ label: 'Cancel', color: '#dc2626', endpoint: 'cancel', modal: 'Cancel this transfer' });
  }
  if (status === 'confirmed_by_sender') {
    if (isCorporate || isFromWarehouse)
      actions.push({ label: 'Mark Shipped', color: '#8b5cf6', endpoint: 'ship', modal: 'Confirm goods have been dispatched' });
    if (isCorporate)
      actions.push({ label: 'Cancel', color: '#dc2626', endpoint: 'cancel', modal: 'Cancel this transfer' });
  }
  if (status === 'in_transit') {
    if (isCorporate || isToWarehouse)
      actions.push({ label: 'Confirm Receipt', color: '#0891b2', endpoint: 'receive', modal: 'Confirm goods have arrived' });
    if (isToWarehouse || isCorporate)
      actions.push({ label: 'Dispute', color: '#dc2626', endpoint: 'dispute', modal: 'Raise a dispute', requireNote: true, noteLabel: 'Describe the issue (required)' });
  }
  if (status === 'received') {
    if (isCorporate || isFromWarehouse || isToWarehouse)
      actions.push({ label: 'Mark Complete', color: '#16a34a', endpoint: 'complete', direct: true });
  }

  const fmt = (d) => formatDate(d);
  const fmtDt = (d) => formatDateTime(d);

  return (
    <div style={{ background: '#fff', borderRadius: 10, border: '1px solid #e5e7eb', marginBottom: 12, overflow: 'hidden' }}>
      {/* Header row */}
      <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <ArrowRightLeft size={18} color="#6b7280" style={{ flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>
            {transfer.product?.name || transfer.product_id}
            {transfer.lot_number && <span style={{ fontSize: 13, color: '#6b7280', marginLeft: 6 }}>Lot: {transfer.lot_number}</span>}
          </div>
          <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>
            <strong>{transfer.from_warehouse?.name || transfer.from_warehouse_id}</strong>
            {' → '}
            <strong>{transfer.to_warehouse?.name || transfer.to_warehouse_id}</strong>
            <span style={{ marginLeft: 8 }}>
              {transfer.quantity.toLocaleString()} {transfer.unit}
              {transfer.source_receipt?.weight_per_container && transfer.source_receipt?.container_unit && (
                <span style={{ color: '#9ca3af', marginLeft: 4 }}>
                  (~{Math.round(transfer.quantity / transfer.source_receipt.weight_per_container)} {transfer.source_receipt.container_unit}s)
                </span>
              )}
            </span>
          </div>
        </div>
        <StatusBadge status={transfer.status} />
        <button onClick={() => setExpanded(e => !e)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4 }}>
          {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div style={{ borderTop: '1px solid #f3f4f6', padding: '14px 18px', background: '#fafafa' }}>
          {/* Requested by banner */}
          {transfer.initiator && (
            <div style={{ marginBottom: 12, padding: '8px 12px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, fontSize: 13, color: '#1e40af' }}>
              Requested by <strong>{transfer.initiator.name}</strong> ({transfer.initiator.username})
            </div>
          )}

          {/* Action guidance for plant users */}
          {!isCorporate && (isFromWarehouse || isToWarehouse) && (() => {
            let msg = null;
            const s = transfer.status;
            const sr = transfer.source_receipt;
            const barrelHint = sr?.weight_per_container && sr?.container_unit
              ? ` (~${Math.round(transfer.quantity / sr.weight_per_container)} ${sr.container_unit}s)`
              : '';
            const qty = `${transfer.quantity.toLocaleString()} ${transfer.unit}${barrelHint}`;
            const prod = transfer.product?.name || transfer.product_id;
            if (s === 'initiated' && isFromWarehouse) {
              msg = { bg: '#fffbeb', border: '#fde68a', color: '#92400e',
                text: `Action needed: Confirm you are ready to ship ${qty} of ${prod} to ${transfer.to_warehouse?.name || transfer.to_warehouse_id}. Click "Confirm Shipment" below to select the source lot and confirm.` };
            } else if (s === 'confirmed_by_sender' && isFromWarehouse) {
              msg = { bg: '#f5f3ff', border: '#c4b5fd', color: '#5b21b6',
                text: `Ready to dispatch: Once the truck is loaded with ${qty} of ${prod}, click "Mark Shipped". Inventory will be automatically deducted from your warehouse.` };
            } else if (s === 'in_transit' && isToWarehouse) {
              msg = { bg: '#ecfeff', border: '#a5f3fc', color: '#155e75',
                text: `Incoming shipment: ${qty} of ${prod} from ${transfer.from_warehouse?.name || transfer.from_warehouse_id} is on its way. When the truck arrives, click "Confirm Receipt" — a receipt will be auto-created in your inventory.` };
            } else if (s === 'received' && (isFromWarehouse || isToWarehouse)) {
              msg = { bg: '#f0fdf4', border: '#bbf7d0', color: '#166534',
                text: `Transfer received. Click "Mark Complete" to close this transfer.` };
            }
            return msg ? (
              <div style={{ marginBottom: 12, padding: '10px 14px', background: msg.bg, border: `1px solid ${msg.border}`, borderRadius: 6, fontSize: 13, color: msg.color, lineHeight: 1.5 }}>
                {msg.text}
              </div>
            ) : null;
          })()}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, marginBottom: 14 }}>
            {[
              ['Reference', transfer.reference_number],
              ['Expected Arrival', fmt(transfer.expected_arrival_date)],
              ['Actual Arrival', fmt(transfer.actual_arrival_date)],
              ['Initiated', fmtDt(transfer.initiated_at)],
              ['Confirmed', fmtDt(transfer.confirmed_at)],
              ['Shipped', fmtDt(transfer.shipped_at)],
              ['Received', fmtDt(transfer.received_at)],
              ['Source Receipt', transfer.source_receipt_id],
              ['Destination Receipt', transfer.destination_receipt_id],
            ].map(([k, v]) => v && v !== '—' ? (
              <div key={k}>
                <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', marginBottom: 2 }}>{k}</div>
                <div style={{ fontSize: 13, color: '#111827' }}>{v}</div>
              </div>
            ) : null)}
          </div>

          {transfer.notes && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', marginBottom: 2 }}>Notes</div>
              <div style={{ fontSize: 13, color: '#374151', whiteSpace: 'pre-line' }}>{transfer.notes}</div>
            </div>
          )}

          {transfer.dispute_reason && (
            <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '8px 12px', marginBottom: 12, fontSize: 13, color: '#dc2626' }}>
              <strong>Dispute:</strong> {transfer.dispute_reason}
            </div>
          )}

          {/* Action buttons */}
          {canAct && actions.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {actions.map(act => (
                <button key={act.endpoint} onClick={() => {
                  if (act.direct) { doAction(act.endpoint); }
                  else if (act.customModal) { setShowConfirmShipment(true); }
                  else { setActionModal(act); }
                }} style={{
                  padding: '7px 16px', borderRadius: 6, border: `1px solid ${act.color}`,
                  background: '#fff', color: act.color, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                }}>
                  {act.label}
                </button>
              ))}
            </div>
          )}

          {/* Place in Storage button — shown for destination warehouse on received/completed transfers */}
          {(isToWarehouse || isCorporate) && transfer.destination_receipt_id &&
            (status === 'received' || status === 'completed') && (
            <div style={{ marginTop: actions.length > 0 ? 10 : 0 }}>
              <button onClick={() => setShowPlaceInStorage(true)} style={{
                padding: '7px 16px', borderRadius: 6, border: '1px solid #2563eb',
                background: '#eff6ff', color: '#2563eb', cursor: 'pointer', fontSize: 13, fontWeight: 600,
              }}>
                Place in Storage
              </button>
              <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 8 }}>
                Assign warehouse storage location for received goods
              </span>
            </div>
          )}
        </div>
      )}

      {/* Confirm shipment modal */}
      {showConfirmShipment && (
        <ConfirmShipmentModal
          transfer={transfer}
          onClose={() => setShowConfirmShipment(false)}
          onConfirm={(payload) => {
            doAction('confirm', payload);
            setShowConfirmShipment(false);
          }}
        />
      )}

      {/* Action modal */}
      {actionModal && (
        <ActionModal
          title={actionModal.modal}
          requireNote={actionModal.requireNote}
          noteLabel={actionModal.noteLabel}
          onClose={() => setActionModal(null)}
          onConfirm={(notes) => {
            const payload = actionModal.endpoint === 'dispute'
              ? { dispute_reason: notes }
              : { notes: notes || undefined };
            doAction(actionModal.endpoint, payload);
            setActionModal(null);
          }}
        />
      )}

      {/* Place in Storage modal */}
      {showPlaceInStorage && (
        <PlaceInStorageModal
          receiptId={transfer.destination_receipt_id}
          warehouseId={transfer.to_warehouse_id}
          productName={transfer.product?.name || transfer.product_id}
          quantity={transfer.quantity}
          unit={transfer.unit}
          onClose={() => setShowPlaceInStorage(false)}
          onSaved={() => setShowPlaceInStorage(false)}
        />
      )}
    </div>
  );
});

// ---- Main Page ----
export default function InterWarehouseTransfersPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [transfers, setTransfers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [showInitiate, setShowInitiate] = useState(false);

  const canInitiate = ['superadmin', 'corporate_admin'].includes(user?.role);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get('/inter-warehouse-transfers/', {
        params: { status: statusFilter || undefined },
      });
      setTransfers(res.data);
    } catch (err) {
      console.error('Failed to load transfers', err);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  const handleAction = (updated) => {
    setTransfers(ts => ts.map(t => t.id === updated.id ? updated : t));
  };

  const selectStyle = {
    padding: '7px 12px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 14, background: '#fff',
  };

  return (
    <div style={{ padding: '24px', maxWidth: 900, margin: '0 auto' }}>
      {/* Back button */}
      <div className="page-header">
        <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
          ← Back to Dashboard
        </button>
      </div>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
            <ArrowRightLeft size={22} /> Inter-Warehouse Transfers
          </h1>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 14 }}>
            Track inventory shipments between warehouse locations
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px',
            borderRadius: 6, border: '1px solid #d1d5db', background: '#fff',
            color: '#374151', cursor: 'pointer', fontSize: 14,
          }}>
            <RefreshCw size={16} color="#374151" /> Refresh
          </button>
          {canInitiate && (
            <button onClick={() => setShowInitiate(true)} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px',
              borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 14,
            }}>
              <Plus size={16} /> Initiate Transfer
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <select style={selectStyle} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All Statuses</option>
          {Object.entries(STATUS_CONFIG).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
      </div>

      {/* List */}
      {loading ? (
        <div style={{ textAlign: 'center', color: '#6b7280', padding: 40 }}>Loading transfers...</div>
      ) : transfers.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#6b7280', padding: 40, background: '#f9fafb', borderRadius: 10, border: '1px dashed #d1d5db' }}>
          <ArrowRightLeft size={32} style={{ marginBottom: 8, opacity: 0.4 }} />
          <p style={{ margin: 0 }}>No transfers found.</p>
          {canInitiate && <p style={{ margin: '4px 0 0', fontSize: 13 }}>Click "Initiate Transfer" to create one.</p>}
        </div>
      ) : (
        transfers.map(t => (
          <TransferCard key={t.id} transfer={t} currentUser={user} onAction={handleAction} />
        ))
      )}

      {showInitiate && (
        <InitiateModal
          onClose={() => setShowInitiate(false)}
          onCreated={(t) => setTransfers(ts => [t, ...ts])}
        />
      )}
    </div>
  );
}
