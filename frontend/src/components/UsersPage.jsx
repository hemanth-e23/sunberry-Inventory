import React, { useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../context/AppDataContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { getDashboardPath } from '../App';
import { ChevronLeft, Users as UsersIcon, Plus, Filter, Edit2, Power } from 'lucide-react';
import apiClient from '../api/client';
import './Shared.css';
import './UsersPage.css';
import { ROLES } from '../constants';

const roleLabels = {
  superadmin: 'Superadmin',
  corporate_admin: 'Corporate Admin',
  corporate_viewer: 'Corporate Viewer',
  admin: 'Admin',
  supervisor: 'Supervisor',
  warehouse: 'Warehouse',
  forklift: 'Forklift',
};

const PLANT_ROLES = ['admin', 'supervisor', 'warehouse', 'forklift'];
const CORPORATE_ROLES_LIST = ['superadmin', 'corporate_admin', 'corporate_viewer'];

const UsersPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { users, addUser, updateUser, toggleUserStatus } = useAppData();
  const { addToast } = useToast();
  const [filter, setFilter] = useState('all');
  const [showForm, setShowForm] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [warehouses, setWarehouses] = useState([]);
  const [formData, setFormData] = useState({
    name: '',
    username: '',
    email: '',
    role: 'warehouse',
    password: '',
    badgeId: '',
    warehouse_id: '',
  });

  const isSuperadmin = user?.role === 'superadmin';
  const needsWarehouse = (role) => PLANT_ROLES.includes(role);

  useEffect(() => {
    apiClient.get('/master-data/warehouses')
      .then(r => setWarehouses(r.data))
      .catch(() => {});
  }, []);

  const filteredUsers = useMemo(() => {
    if (filter === 'all') return users;
    return users.filter(user => user.role === filter);
  }, [users, filter]);

  const resetForm = () => {
    setFormData({ name: '', username: '', email: '', role: 'warehouse', password: '', badgeId: '', warehouse_id: '' });
    setEditingUser(null);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!formData.name.trim() || !formData.username.trim()) return;
    const isForklift = formData.role === ROLES.FORKLIFT;
    const isCorporateRole = CORPORATE_ROLES_LIST.includes(formData.role);

    if (isForklift && !formData.badgeId?.trim()) {
      addToast('Badge ID is required for forklift users (used for badge scan login).', 'error');
      return;
    }
    if (!isForklift && !formData.email.trim()) {
      addToast('Email is required for this role.', 'error');
      return;
    }
    if (!isCorporateRole && !formData.warehouse_id && !editingUser) {
      addToast('Please assign this user to a warehouse.', 'error');
      return;
    }

    const payload = {
      name: formData.name.trim(),
      username: formData.username.trim(),
      email: isForklift && !editingUser
        ? `${formData.username.trim()}@forklift.sunberry.com`
        : (formData.email?.trim() || editingUser?.email || ''),
      role: formData.role,
      warehouse_id: isCorporateRole ? null : (formData.warehouse_id || null),
    };

    if (formData.password.trim()) {
      payload.password = formData.password.trim();
    } else if (isForklift && !editingUser) {
      payload.password = 'ChangeMe123!';
    } else if (!isForklift && !editingUser) {
      addToast('Password is required for new users.', 'error');
      return;
    }
    if (isForklift && formData.badgeId?.trim()) {
      payload.badgeId = formData.badgeId.trim();
    }

    try {
      if (editingUser) {
        await updateUser(editingUser.id, payload);
      } else {
        await addUser({ ...payload, password: payload.password || 'ChangeMe123!' });
      }
      resetForm();
      setShowForm(false);
    } catch (error) {
      const msg = (error?.message && String(error.message) !== '[object Object]') ? error.message : 'Failed to save user. Please try again.';
      addToast(msg, 'error');
    }
  };

  const handleEdit = (u) => {
    setEditingUser(u);
    setFormData({
      name: u.name,
      username: u.username,
      email: u.email || '',
      role: u.role,
      password: '',
      badgeId: u.badgeId || u.badge_id || '',
      warehouse_id: u.warehouse_id || '',
    });
    setShowForm(true);
  };

  return (
    <div className="users-page animate-fade-in">
      <div className="page-header">
        <div>
          <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
            <ChevronLeft size={18} />
            <span>Back to Dashboard</span>
          </button>
        </div>
      </div>

      <div className="page-content">
        <section className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <UsersIcon size={24} style={{ color: 'var(--color-primary)' }} />
              <h2>User Management</h2>
            </div>
            <div className="panel-actions">
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <Filter size={16} style={{ position: 'absolute', left: '12px', color: 'var(--color-text-muted)', pointerEvents: 'none' }} />
                <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ paddingLeft: '36px' }}>
                  <option value="all">All Roles</option>
                  {isSuperadmin && <>
                    <option value="superadmin">Superadmin</option>
                    <option value="corporate_admin">Corporate Admin</option>
                    <option value="corporate_viewer">Corporate Viewer</option>
                  </>}
                  <option value="admin">Admin</option>
                  <option value="supervisor">Supervisor</option>
                  <option value="warehouse">Warehouse</option>
                  <option value="forklift">Forklift</option>
                </select>
              </div>
              <button className="primary-button" onClick={() => {
                resetForm();
                setShowForm(prev => !prev);
              }}>
                {showForm ? 'Close Form' : (
                  <>
                    <Plus size={18} />
                    <span>Add User</span>
                  </>
                )}
              </button>
            </div>
          </div>
          <p className="muted">Create and manage users for the warehouse platform.</p>
        </section>

        {showForm && (
          <section className="panel">
            <form onSubmit={handleSubmit} className="simple-form">
              <div className="form-grid">
                <label>
                  <span>Full Name</span>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    required
                  />
                </label>

                <label>
                  <span>Username</span>
                  <input
                    type="text"
                    value={formData.username}
                    onChange={(e) => setFormData(prev => ({ ...prev, username: e.target.value }))}
                    required
                  />
                </label>

                {formData.role !== ROLES.FORKLIFT && (
                  <label>
                    <span>Email</span>
                    <input
                      type="email"
                      value={formData.email}
                      onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                      required
                    />
                  </label>
                )}

                {formData.role !== ROLES.FORKLIFT && (
                  <label>
                    <span>Password</span>
                    <input
                      type="password"
                      value={formData.password}
                      onChange={(e) => setFormData(prev => ({ ...prev, password: e.target.value }))}
                      placeholder={editingUser ? 'Leave blank to keep current password' : 'Set initial password'}
                      {...(editingUser ? {} : { required: true })}
                    />
                  </label>
                )}

                <label>
                  <span>Role</span>
                  <select
                    value={formData.role}
                    onChange={(e) => setFormData(prev => ({ ...prev, role: e.target.value, warehouse_id: CORPORATE_ROLES_LIST.includes(e.target.value) ? '' : prev.warehouse_id }))}
                    required
                  >
                    {isSuperadmin ? (
                      <>
                        <optgroup label="Corporate">
                          <option value="superadmin">Superadmin</option>
                          <option value="corporate_admin">Corporate Admin</option>
                          <option value="corporate_viewer">Corporate Viewer</option>
                        </optgroup>
                        <optgroup label="Plant">
                          <option value="admin">Admin</option>
                          <option value="supervisor">Supervisor</option>
                          <option value="warehouse">Warehouse</option>
                          <option value="forklift">Forklift</option>
                        </optgroup>
                      </>
                    ) : (
                      <>
                        <option value="admin">Admin</option>
                        <option value="supervisor">Supervisor</option>
                        <option value="warehouse">Warehouse</option>
                        <option value="forklift">Forklift</option>
                      </>
                    )}
                  </select>
                </label>

                {needsWarehouse(formData.role) && (
                  <label>
                    <span>Warehouse *</span>
                    <select
                      value={formData.warehouse_id}
                      onChange={(e) => setFormData(prev => ({ ...prev, warehouse_id: e.target.value }))}
                      required
                    >
                      <option value="">Select warehouse...</option>
                      {warehouses.map(w => (
                        <option key={w.id} value={w.id}>{w.name} ({w.code})</option>
                      ))}
                    </select>
                  </label>
                )}

                {formData.role === ROLES.FORKLIFT && (
                  <label>
                    <span>Badge ID</span>
                    <input
                      type="text"
                      value={formData.badgeId}
                      onChange={(e) => setFormData(prev => ({ ...prev, badgeId: e.target.value }))}
                      placeholder="e.g. FK-001 (for badge scan login)"
                    />
                  </label>
                )}
              </div>

              <div className="form-actions">
                <button type="submit" className="primary-button">
                  {editingUser ? 'Update User' : 'Create User'}
                </button>
                {editingUser && (
                  <button type="button" className="secondary-button" onClick={() => {
                    resetForm();
                    setShowForm(false);
                  }}>
                    Cancel
                  </button>
                )}
              </div>
            </form>
          </section>
        )}

        <section className="panel">
          <div className="table-wrapper">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Username</th>
                  <th>Role</th>
                  <th>Warehouse</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map(u => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td>{u.username}</td>
                    <td>{roleLabels[u.role] || u.role}</td>
                    <td>{u.warehouse_id ? (warehouses.find(w => w.id === u.warehouse_id)?.name || u.warehouse_id) : <span style={{ color: '#9ca3af' }}>Corporate</span>}</td>
                    <td>
                      <span className={`chip status-${u.status}`}>{u.status}</span>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button type="button" onClick={() => handleEdit(u)}>
                          <Edit2 size={14} />
                          <span>Edit</span>
                        </button>
                        <button type="button" onClick={async () => {
                          try {
                            await toggleUserStatus(u.id);
                          } catch (error) {
                            const msg = (error?.message && String(error.message) !== '[object Object]') ? error.message : 'Failed to toggle user status. Please try again.';
                            addToast(msg, 'error');
                          }
                        }}>
                          <Power size={14} />
                          <span>{u.status === 'active' ? 'Deactivate' : 'Activate'}</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
};

export default UsersPage;
