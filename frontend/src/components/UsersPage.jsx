import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../context/AppDataContext';
import { useAuth } from '../context/AuthContext';
import { getDashboardPath } from '../App';
import { ChevronLeft, Users as UsersIcon, Plus, Filter, Edit2, Power } from 'lucide-react';
import './Shared.css';
import './UsersPage.css';
import './UsersPageEnhanced.css';

const roleLabels = {
  admin: 'Admin',
  supervisor: 'Supervisor',
  warehouse: 'Warehouse',
  forklift: 'Forklift'
};

const UsersPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { users, addUser, updateUser, toggleUserStatus } = useAppData();
  const [filter, setFilter] = useState('all');
  const [showForm, setShowForm] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    username: '',
    email: '',
    role: 'warehouse',
    password: '',
    badgeId: ''
  });

  const filteredUsers = useMemo(() => {
    if (filter === 'all') return users;
    return users.filter(user => user.role === filter);
  }, [users, filter]);

  const resetForm = () => {
    setFormData({ name: '', username: '', email: '', role: 'warehouse', password: '', badgeId: '' });
    setEditingUser(null);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!formData.name.trim() || !formData.username.trim()) return;
    const isForklift = formData.role === 'forklift';

    // Forklift users need badge ID; others need email
    if (isForklift && !formData.badgeId?.trim()) {
      alert('Badge ID is required for forklift users (used for badge scan login).');
      return;
    }
    if (!isForklift && !formData.email.trim()) {
      alert('Email is required for this role.');
      return;
    }

    const payload = {
      name: formData.name.trim(),
      username: formData.username.trim(),
      email: isForklift && !editingUser
        ? `${formData.username.trim()}@forklift.sunberry.com`
        : (formData.email?.trim() || editingUser?.email || ''),
      role: formData.role
    };

    if (formData.password.trim()) {
      payload.password = formData.password.trim();
    } else if (isForklift && !editingUser) {
      payload.password = 'ChangeMe123!'; // Placeholder; forklift uses badge login
    } else if (!isForklift && !editingUser) {
      alert('Password is required for new users.');
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
      alert(msg);
    }
  };

  const handleEdit = (user) => {
    setEditingUser(user);
    setFormData({
      name: user.name,
      username: user.username,
      email: user.email || '',
      role: user.role,
      password: '',
      badgeId: user.badgeId || user.badge_id || ''
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
                  <option value="admin">Admins</option>
                  <option value="supervisor">Supervisors</option>
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

                {formData.role !== 'forklift' && (
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

                {formData.role !== 'forklift' && (
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
                    onChange={(e) => setFormData(prev => ({ ...prev, role: e.target.value }))}
                    required
                  >
                    <option value="admin">Admin</option>
                    <option value="supervisor">Supervisor</option>
                    <option value="warehouse">Warehouse</option>
                    <option value="forklift">Forklift</option>
                  </select>
                </label>

                {formData.role === 'forklift' && (
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
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map(user => (
                  <tr key={user.id}>
                    <td>{user.name}</td>
                    <td>{user.username}</td>
                    <td>{roleLabels[user.role] || user.role}</td>
                    <td>
                      <span className={`chip status-${user.status}`}>{user.status}</span>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button type="button" onClick={() => handleEdit(user)}>
                          <Edit2 size={14} />
                          <span>Edit</span>
                        </button>
                        <button type="button" onClick={async () => {
                          try {
                            await toggleUserStatus(user.id);
                          } catch (error) {
                            const msg = (error?.message && String(error.message) !== '[object Object]') ? error.message : 'Failed to toggle user status. Please try again.';
                            alert(msg);
                          }
                        }}>
                          <Power size={14} />
                          <span>{user.status === 'active' ? 'Deactivate' : 'Activate'}</span>
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
