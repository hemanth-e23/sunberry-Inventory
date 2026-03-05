import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import apiClient from '../api/client';
import {
  Building2, Users, ArrowRightLeft, BarChart3,
  Settings, Shield, CheckCircle, XCircle, Database
} from 'lucide-react';

const TYPE_LABELS = { owned: 'Owned Plant', partner: 'Partner Plant', corporate: 'Corporate' };
const TYPE_COLORS = { owned: '#16a34a', partner: '#2563eb', corporate: '#7c3aed' };

export default function SuperadminDashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [warehouses, setWarehouses] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      apiClient.get('/master-data/warehouses'),
      apiClient.get('/users/'),
    ]).then(([wh, us]) => {
      setWarehouses(wh.data);
      setUsers(us.data);
    }).catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const getGreeting = () => {
    const h = new Date().getHours();
    if (h < 12) return 'Good Morning';
    if (h < 18) return 'Good Afternoon';
    return 'Good Evening';
  };

  const activeWarehouses = warehouses.filter(w => w.is_active);
  const activeUsers = users.filter(u => u.is_active !== false && u.status !== 'inactive');

  const usersPerWarehouse = (warehouseId) =>
    users.filter(u => u.warehouse_id === warehouseId).length;

  const cardStyle = {
    background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb',
    padding: 20, cursor: 'pointer', transition: 'box-shadow 0.15s',
  };

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      {/* Welcome */}
      <header style={{ marginBottom: 28 }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>
          {getGreeting()}, <span style={{ color: '#2563eb' }}>{user?.username}</span>
        </h1>
        <p style={{ margin: '4px 0 0', color: '#6b7280' }}>
          System overview — manage warehouses, users, and cross-location operations
        </p>
      </header>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 16, marginBottom: 32 }}>
        {[
          { label: 'Active Warehouses', value: loading ? '…' : activeWarehouses.length, icon: Building2, color: '#2563eb' },
          { label: 'Total Users', value: loading ? '…' : users.length, icon: Users, color: '#7c3aed' },
          { label: 'Active Users', value: loading ? '…' : activeUsers.length, icon: CheckCircle, color: '#16a34a' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} style={{ background: '#fff', borderRadius: 10, border: '1px solid #e5e7eb', padding: '16px 20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 28, fontWeight: 700, color }}>{value}</div>
                <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>{label}</div>
              </div>
              <Icon size={22} color={color} style={{ opacity: 0.6 }} />
            </div>
          </div>
        ))}
      </div>

      {/* Warehouses section */}
      <section style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Building2 size={18} /> Warehouses
          </h2>
          <button onClick={() => navigate('/admin/warehouses')} style={{
            padding: '7px 14px', borderRadius: 6, border: '1px solid #2563eb',
            color: '#2563eb', background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600,
          }}>
            Manage Warehouses
          </button>
        </div>

        {loading ? (
          <p style={{ color: '#6b7280' }}>Loading...</p>
        ) : warehouses.length === 0 ? (
          <p style={{ color: '#6b7280' }}>No warehouses found.</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
            {warehouses.map(wh => (
              <div key={wh.id} style={{
                ...cardStyle,
                borderLeft: `4px solid ${TYPE_COLORS[wh.type] || '#6b7280'}`,
                opacity: wh.is_active ? 1 : 0.6,
              }}
                onMouseEnter={e => e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.08)'}
                onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}
                onClick={() => navigate('/admin/warehouses')}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{wh.name}</div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{wh.code}</div>
                  </div>
                  {wh.is_active
                    ? <CheckCircle size={16} color="#16a34a" />
                    : <XCircle size={16} color="#dc2626" />}
                </div>
                <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
                    background: `${TYPE_COLORS[wh.type]}18`, color: TYPE_COLORS[wh.type] || '#6b7280',
                    border: `1px solid ${TYPE_COLORS[wh.type]}33`,
                  }}>
                    {TYPE_LABELS[wh.type] || wh.type}
                  </span>
                  <span style={{ fontSize: 12, color: '#6b7280' }}>
                    {usersPerWarehouse(wh.id)} user{usersPerWarehouse(wh.id) !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Management actions */}
      <section>
        <h2 style={{ margin: '0 0 14px', fontSize: 17, fontWeight: 700 }}>Management</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
          {[
            { label: 'Warehouses', desc: 'Create and manage warehouse locations', icon: Building2, path: '/admin/warehouses', color: '#2563eb' },
            { label: 'Users', desc: 'Create users and assign to warehouses', icon: Users, path: '/admin/users', color: '#7c3aed' },
            { label: 'Master Data', desc: 'Manage companies, categories, vendors and locations', icon: Database, path: '/admin/master-data', color: '#0891b2' },
            { label: 'Inter-Warehouse Transfers', desc: 'Track cross-location inventory transfers', icon: ArrowRightLeft, path: '/admin/inter-warehouse-transfers', color: '#16a34a' },
            { label: 'Reports', desc: 'Consolidated reports across all locations', icon: BarChart3, path: '/admin/reports', color: '#d97706' },
          ].map(({ label, desc, icon: Icon, path, color }) => (
            <div key={label} style={{ ...cardStyle }}
              onMouseEnter={e => e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.08)'}
              onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}
              onClick={() => navigate(path)}
            >
              <div style={{ width: 40, height: 40, borderRadius: 10, background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
                <Icon size={20} color={color} />
              </div>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>{desc}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
