import React, { memo, useState, useEffect, useCallback } from 'react';
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

// ---- Initiate Transfer Modal ----
function InitiateModal({ onClose, onCreated }) {
  const [warehouses, setWarehouses] = useState([]);
  const [products, setProducts] = useState([]);
  const [form, setForm] = useState({
    from_warehouse_id: '', to_warehouse_id: '', product_id: '',
    lot_number: '', quantity: '', unit: 'cases',
    reference_number: '', expected_arrival_date: '', notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      apiClient.get('/master-data/warehouses'),
      apiClient.get('/products/products', { params: { limit: 500 } }),
    ]).then(([wh, pr]) => {
      setWarehouses(wh.data);
      setProducts(pr.data.items || pr.data);
    }).catch(() => {});
  }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

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
    setSaving(true);
    try {
      const payload = {
        ...form,
        quantity: parseFloat(form.quantity),
        lot_number: form.lot_number || null,
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
              <select style={inputStyle} value={form.from_warehouse_id} onChange={e => set('from_warehouse_id', e.target.value)} required>
                <option value="">Select source...</option>
                {warehouses.map(w => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>To Warehouse *</label>
              <select style={inputStyle} value={form.to_warehouse_id} onChange={e => set('to_warehouse_id', e.target.value)} required>
                <option value="">Select destination...</option>
                {warehouses.map(w => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}
              </select>
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Product *</label>
            <select style={inputStyle} value={form.product_id} onChange={e => set('product_id', e.target.value)} required>
              <option value="">Select product...</option>
              {products.map(p => <option key={p.id} value={p.id}>{p.name}{p.fcc_code ? ` (${p.fcc_code})` : ''}</option>)}
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div>
              <label style={labelStyle}>Quantity *</label>
              <input style={inputStyle} type="number" min="0.01" step="0.01" value={form.quantity} onChange={e => set('quantity', e.target.value)} required />
            </div>
            <div>
              <label style={labelStyle}>Unit</label>
              <select style={inputStyle} value={form.unit} onChange={e => set('unit', e.target.value)}>
                <option value="cases">Cases</option>
                <option value="pallets">Pallets</option>
                <option value="lbs">Lbs</option>
                <option value="kg">Kg</option>
                <option value="gallons">Gallons</option>
              </select>
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

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} style={{
              padding: '9px 20px', borderRadius: 6, border: '1px solid #d1d5db',
              background: '#fff', cursor: 'pointer', fontSize: 14,
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

// ---- Transfer Card ----
const TransferCard = memo(function TransferCard({ transfer, currentUser, onAction }) {
  const { addToast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [actionModal, setActionModal] = useState(null);

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
      actions.push({ label: 'Confirm Shipment', color: '#f59e0b', endpoint: 'confirm', modal: 'Confirm you are ready to ship' });
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
            <span style={{ marginLeft: 8 }}>{transfer.quantity} {transfer.unit}</span>
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, marginBottom: 14 }}>
            {[
              ['Reference', transfer.reference_number],
              ['Expected Arrival', fmt(transfer.expected_arrival_date)],
              ['Actual Arrival', fmt(transfer.actual_arrival_date)],
              ['Initiated', fmtDt(transfer.initiated_at)],
              ['Confirmed', fmtDt(transfer.confirmed_at)],
              ['Shipped', fmtDt(transfer.shipped_at)],
              ['Received', fmtDt(transfer.received_at)],
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
        </div>
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
