import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { getDashboardPath } from '../App';
import apiClient from '../api/client';
import {
  Building2, Plus, Edit2, ChevronLeft, CheckCircle, XCircle, X,
  Shield, Tag, ToggleLeft, ToggleRight, Trash2,
} from 'lucide-react';

const TIMEZONES = [
  'America/New_York',      // Eastern US - Detroit
  'America/Toronto',       // Eastern Canada
  'America/Chicago',       // Central US
  'America/Winnipeg',      // Central Canada
  'America/Denver',        // Mountain US
  'America/Edmonton',      // Mountain Canada
  'America/Los_Angeles',   // Pacific US
  'America/Vancouver',     // Pacific Canada
  'America/Halifax',       // Atlantic Canada
  'America/Phoenix',       // Arizona - no DST
  'Pacific/Honolulu',      // Hawaii
];
const TYPE_OPTIONS = [
  { value: 'owned', label: 'Owned Plant', desc: 'Full features — staging, forklift, production integration' },
  { value: 'partner', label: 'Partner Plant', desc: 'Core warehouse ops — no staging or forklift features' },
  { value: 'corporate', label: 'Corporate', desc: 'Oversight only — read-only access across all warehouses' },
];

const EMPTY_FORM = {
  id: '', name: '', code: '', type: 'owned',
  address: '', contact_person: '', email: '', phone: '',
  timezone: 'America/New_York',
};

// ---------------------------------------------------------------------------
// Warehouse create/edit modal
// ---------------------------------------------------------------------------
function WarehouseModal({ warehouse, onClose, onSaved }) {
  const isEdit = !!warehouse;
  const [form, setForm] = useState(isEdit ? {
    id: warehouse.id, name: warehouse.name, code: warehouse.code,
    type: warehouse.type, address: warehouse.address || '',
    contact_person: warehouse.contact_person || '', email: warehouse.email || '',
    phone: warehouse.phone || '', timezone: warehouse.timezone,
  } : { ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const payload = { ...form };
      ['address', 'contact_person', 'email', 'phone'].forEach(k => {
        if (!payload[k]) payload[k] = null;
      });
      let res;
      if (isEdit) {
        const { id: _id, ...updatePayload } = payload;
        res = await apiClient.put(`/master-data/warehouses/${warehouse.id}`, updatePayload);
      } else {
        res = await apiClient.post('/master-data/warehouses', payload);
      }
      onSaved(res.data, isEdit);
      onClose();
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to save warehouse.');
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
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 28, width: 540, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{isEdit ? 'Edit Warehouse' : 'Add Warehouse'}</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><X size={20} /></button>
        </div>

        {error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '8px 12px', marginBottom: 16, color: '#dc2626', fontSize: 14 }}>
            {error}
          </div>
        )}

        <form onSubmit={submit}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div>
              <label style={labelStyle}>Warehouse ID *</label>
              <input style={{ ...inputStyle, background: isEdit ? '#f9fafb' : '#fff' }}
                value={form.id} onChange={e => set('id', e.target.value)}
                placeholder="e.g. wh-plant-b" required disabled={isEdit} />
              {!isEdit && <p style={{ fontSize: 11, color: '#9ca3af', margin: '3px 0 0' }}>Permanent — cannot be changed later</p>}
            </div>
            <div>
              <label style={labelStyle}>Short Code *</label>
              <input style={inputStyle} value={form.code} onChange={e => set('code', e.target.value.toUpperCase())} placeholder="e.g. PLT-B" required />
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Name *</label>
            <input style={inputStyle} value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Plant B — Fresno" required />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Type *</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {TYPE_OPTIONS.map(opt => (
                <label key={opt.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 8, border: `2px solid ${form.type === opt.value ? '#2563eb' : '#e5e7eb'}`, cursor: 'pointer', background: form.type === opt.value ? '#eff6ff' : '#fff' }}>
                  <input type="radio" name="type" value={opt.value} checked={form.type === opt.value} onChange={() => set('type', opt.value)} style={{ marginTop: 2 }} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{opt.label}</div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>{opt.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Address</label>
            <textarea style={{ ...inputStyle, height: 60, resize: 'vertical' }} value={form.address} onChange={e => set('address', e.target.value)} placeholder="Full street address" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div>
              <label style={labelStyle}>Contact Person</label>
              <input style={inputStyle} value={form.contact_person} onChange={e => set('contact_person', e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>Email</label>
              <input style={inputStyle} type="email" value={form.email} onChange={e => set('email', e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>Phone</label>
              <input style={inputStyle} value={form.phone} onChange={e => set('phone', e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>Timezone</label>
              <select style={inputStyle} value={form.timezone} onChange={e => set('timezone', e.target.value)}>
                {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 8 }}>
            <button type="button" onClick={onClose} style={{ padding: '9px 20px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 14 }}>Cancel</button>
            <button type="submit" disabled={saving} style={{ padding: '9px 20px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
              {saving ? 'Saving...' : (isEdit ? 'Save Changes' : 'Create Warehouse')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Category access management modal
// ---------------------------------------------------------------------------
function CategoryAccessModal({ warehouse, onClose, onWarehouseUpdated }) {
  const { addToast } = useToast();
  const [assignments, setAssignments] = useState([]);   // WarehouseCategoryAccess rows
  const [allGroups, setAllGroups] = useState([]);       // All category groups
  const [selectedGroup, setSelectedGroup] = useState('');
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [assigning, setAssigning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [accessRes, groupsRes] = await Promise.all([
        apiClient.get(`/master-data/warehouses/${warehouse.id}/category-access`),
        apiClient.get('/products/category-groups'),
      ]);
      setAssignments(accessRes.data);
      setAllGroups(groupsRes.data);
    } catch (err) {
      addToast('Failed to load category access data.', 'error');
    } finally {
      setLoading(false);
    }
  }, [warehouse.id, addToast]);

  useEffect(() => { load(); }, [load]);

  const assignedGroupIds = new Set(assignments.map(a => a.category_group_id));
  const unassignedGroups = allGroups.filter(g => !assignedGroupIds.has(g.id));

  const handleAssign = async () => {
    if (!selectedGroup) return;
    setAssigning(true);
    try {
      const res = await apiClient.post(`/master-data/warehouses/${warehouse.id}/category-access`, {
        category_group_id: selectedGroup,
      });
      setAssignments(prev => [...prev, res.data]);
      setSelectedGroup('');
      addToast('Category group assigned.', 'success');
    } catch (err) {
      addToast(err.response?.data?.detail || 'Failed to assign category group.', 'error');
    } finally {
      setAssigning(false);
    }
  };

  const handleRemove = async (categoryGroupId, groupName) => {
    try {
      await apiClient.delete(`/master-data/warehouses/${warehouse.id}/category-access/${categoryGroupId}`);
      setAssignments(prev => prev.filter(a => a.category_group_id !== categoryGroupId));
      addToast(`"${groupName}" removed from ${warehouse.name}.`, 'success');
    } catch (err) {
      addToast(err.response?.data?.detail || 'Failed to remove assignment.', 'error');
    }
  };

  const handleToggleProductCreation = async () => {
    setToggling(true);
    try {
      const res = await apiClient.post(`/master-data/warehouses/${warehouse.id}/toggle-product-creation`);
      onWarehouseUpdated(res.data);
      addToast(
        `Product creation ${res.data.allow_product_creation ? 'enabled' : 'disabled'} for ${warehouse.name}.`,
        'success'
      );
    } catch (err) {
      addToast(err.response?.data?.detail || 'Failed to toggle setting.', 'error');
    } finally {
      setToggling(false);
    }
  };

  const groupNameById = Object.fromEntries(allGroups.map(g => [g.id, g.name]));

  const inputStyle = {
    padding: '8px 10px', borderRadius: 6,
    border: '1px solid #d1d5db', fontSize: 14, flex: 1,
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 28, width: 520, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Shield size={18} style={{ color: '#7c3aed' }} />
            Manage Access
          </h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><X size={20} /></button>
        </div>
        <p style={{ margin: '0 0 20px', fontSize: 13, color: '#6b7280' }}>{warehouse.name} — {warehouse.code}</p>

        {/* Product creation toggle */}
        <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '14px 16px', marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>Allow Product Creation</div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>
                When enabled, admins and supervisors at this warehouse can create products within their assigned categories.
              </div>
            </div>
            <button
              onClick={handleToggleProductCreation}
              disabled={toggling}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: warehouse.allow_product_creation ? '#16a34a' : '#9ca3af', flexShrink: 0, marginLeft: 16 }}
            >
              {warehouse.allow_product_creation
                ? <ToggleRight size={36} />
                : <ToggleLeft size={36} />}
            </button>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, fontWeight: 600, color: warehouse.allow_product_creation ? '#16a34a' : '#6b7280' }}>
            {warehouse.allow_product_creation ? 'Enabled' : 'Disabled'}
          </div>
        </div>

        {/* Category group assignments */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Tag size={14} /> Assigned Category Groups
          </div>
          <p style={{ margin: '0 0 12px', fontSize: 12, color: '#6b7280' }}>
            This warehouse can only see products and categories that belong to the assigned groups below.
          </p>

          {loading ? (
            <p style={{ color: '#9ca3af', fontSize: 13 }}>Loading...</p>
          ) : assignments.length === 0 ? (
            <div style={{ padding: '12px 14px', background: '#fef9c3', border: '1px solid #fde047', borderRadius: 8, fontSize: 13, color: '#854d0e' }}>
              No category groups assigned — users at this warehouse will see an empty product list.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 4 }}>
              {assignments.map(a => (
                <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#15803d' }}>
                    {groupNameById[a.category_group_id] || a.category_group_id}
                  </span>
                  <button
                    onClick={() => handleRemove(a.category_group_id, groupNameById[a.category_group_id] || a.category_group_id)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', padding: 4, display: 'flex', alignItems: 'center' }}
                    title="Remove"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Assign new group */}
        {!loading && unassignedGroups.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: '#374151' }}>Assign Category Group</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <select
                value={selectedGroup}
                onChange={e => setSelectedGroup(e.target.value)}
                style={{ ...inputStyle }}
              >
                <option value="">Select a category group…</option>
                {unassignedGroups.map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
              <button
                onClick={handleAssign}
                disabled={!selectedGroup || assigning}
                style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', cursor: selectedGroup ? 'pointer' : 'not-allowed', fontWeight: 600, fontSize: 13, flexShrink: 0, opacity: selectedGroup ? 1 : 0.5 }}
              >
                {assigning ? 'Assigning…' : 'Assign'}
              </button>
            </div>
          </div>
        )}

        {!loading && unassignedGroups.length === 0 && allGroups.length > 0 && assignments.length > 0 && (
          <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>All category groups are already assigned to this warehouse.</p>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} style={{ padding: '9px 20px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 14 }}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
const TYPE_LABELS = { owned: 'Owned Plant', partner: 'Partner Plant', corporate: 'Corporate' };
const TYPE_COLORS = { owned: '#16a34a', partner: '#2563eb', corporate: '#7c3aed' };

export default function WarehousesPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { addToast } = useToast();
  const [warehouses, setWarehouses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);           // null | 'create' | warehouseObj
  const [accessModal, setAccessModal] = useState(null); // null | warehouseObj

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get('/master-data/warehouses');
      setWarehouses(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSaved = (wh, isEdit) => {
    if (isEdit) {
      setWarehouses(ws => ws.map(w => w.id === wh.id ? wh : w));
    } else {
      setWarehouses(ws => [...ws, wh]);
    }
  };

  const handleWarehouseUpdated = (wh) => {
    setWarehouses(ws => ws.map(w => w.id === wh.id ? wh : w));
    // Also update the accessModal reference so the toggle shows correctly
    setAccessModal(wh);
  };

  const toggleActive = async (wh) => {
    try {
      const res = await apiClient.put(`/master-data/warehouses/${wh.id}`, { is_active: !wh.is_active });
      setWarehouses(ws => ws.map(w => w.id === res.data.id ? res.data : w));
    } catch (err) {
      addToast(err.response?.data?.detail || 'Failed to update warehouse.', 'error');
    }
  };

  const isSuperadmin = user?.role === 'superadmin';

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <button onClick={() => navigate(getDashboardPath(user?.role))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4, fontSize: 14, marginBottom: 12 }}>
          <ChevronLeft size={16} /> Back to Dashboard
        </button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Building2 size={22} /> Warehouses
          </h1>
          <button onClick={() => setModal('create')} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>
            <Plus size={16} /> Add Warehouse
          </button>
        </div>
      </div>

      {loading ? (
        <p style={{ color: '#6b7280' }}>Loading...</p>
      ) : warehouses.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48, background: '#f9fafb', borderRadius: 12, border: '1px dashed #d1d5db' }}>
          <Building2 size={32} style={{ opacity: 0.3, marginBottom: 8 }} />
          <p style={{ margin: 0, color: '#6b7280' }}>No warehouses yet. Click "Add Warehouse" to create one.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {warehouses.map(wh => (
            <div key={wh.id} style={{ background: '#fff', borderRadius: 10, border: '1px solid #e5e7eb', padding: '16px 20px', display: 'flex', alignItems: 'flex-start', gap: 16, borderLeft: `4px solid ${TYPE_COLORS[wh.type] || '#6b7280'}`, opacity: wh.is_active ? 1 : 0.65 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
                  <span style={{ fontWeight: 700, fontSize: 16 }}>{wh.name}</span>
                  <code style={{ fontSize: 12, background: '#f3f4f6', padding: '1px 6px', borderRadius: 4 }}>{wh.code}</code>
                  <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: `${TYPE_COLORS[wh.type]}18`, color: TYPE_COLORS[wh.type], border: `1px solid ${TYPE_COLORS[wh.type]}33` }}>
                    {TYPE_LABELS[wh.type] || wh.type}
                  </span>
                  {!wh.is_active && <span style={{ fontSize: 11, fontWeight: 600, color: '#dc2626', background: '#fef2f2', padding: '2px 8px', borderRadius: 10, border: '1px solid #fca5a5' }}>Inactive</span>}
                  {wh.allow_product_creation && (
                    <span style={{ fontSize: 11, fontWeight: 600, color: '#7c3aed', background: '#f5f3ff', padding: '2px 8px', borderRadius: 10, border: '1px solid #ddd6fe', display: 'flex', alignItems: 'center', gap: 3 }}>
                      <Shield size={10} /> Product Creation On
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: '#6b7280', display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
                  {wh.contact_person && <span>Contact: {wh.contact_person}</span>}
                  {wh.email && <span>{wh.email}</span>}
                  {wh.phone && <span>{wh.phone}</span>}
                  {wh.address && <span>{wh.address}</span>}
                  <span style={{ color: '#9ca3af' }}>{wh.timezone}</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {isSuperadmin && (
                  <button onClick={() => setAccessModal(wh)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 6, border: '1px solid #ddd6fe', background: '#f5f3ff', cursor: 'pointer', fontSize: 13, color: '#7c3aed', fontWeight: 600 }}>
                    <Shield size={14} /> Manage Access
                  </button>
                )}
                <button onClick={() => setModal(wh)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 13 }}>
                  <Edit2 size={14} /> Edit
                </button>
                <button onClick={() => toggleActive(wh)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 6, border: `1px solid ${wh.is_active ? '#fca5a5' : '#bbf7d0'}`, background: '#fff', cursor: 'pointer', fontSize: 13, color: wh.is_active ? '#dc2626' : '#16a34a' }}>
                  {wh.is_active ? <><XCircle size={14} /> Deactivate</> : <><CheckCircle size={14} /> Activate</>}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <WarehouseModal
          warehouse={modal === 'create' ? null : modal}
          onClose={() => setModal(null)}
          onSaved={handleSaved}
        />
      )}

      {accessModal && (
        <CategoryAccessModal
          warehouse={accessModal}
          onClose={() => setAccessModal(null)}
          onWarehouseUpdated={handleWarehouseUpdated}
        />
      )}
    </div>
  );
}
