import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAppData } from '../context/AppDataContext';
import { hasFeature } from '../utils/warehouseFeatures';
import {
  LogOut, Bell, X, ArrowRightLeft, Building2,
  Home, FileText, Eye, Zap, CheckCircle, ClipboardList,
  Printer, BarChart3, Package, Database, Users,
  Layers, AlertCircle, Menu, FileSpreadsheet,
  Shield, ChevronLeft,
} from 'lucide-react';
import * as notificationService from '../api/notificationService';
import apiClient from '../api/client';
import { setAppTimezone } from '../utils/dateUtils';
import { RECEIPT_STATUS, TRANSFER_STATUS, ADJUSTMENT_STATUS, HOLD_STATUS } from '../constants';
import './Layout.css';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function timeAgo(dateStr) {
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const ADMIN_ROLES = ['admin', 'superadmin', 'corporate_admin', 'corporate_viewer'];

function getRolePrefix(role) {
  if (role === 'warehouse') return '/warehouse';
  if (role === 'supervisor') return '/supervisor';
  if (ADMIN_ROLES.includes(role)) return '/admin';
  return '/warehouse';
}

// ---------------------------------------------------------------------------
// NotificationBell
// ---------------------------------------------------------------------------

function NotificationBell() {
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef(null);

  const fetchCount = useCallback(async () => {
    try {
      const res = await notificationService.getUnreadCount();
      setUnread(res.data.count || 0);
    } catch { /* silent */ }
  }, []);

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const res = await notificationService.getNotifications();
      setNotifications(res.data);
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchCount();
    const interval = setInterval(fetchCount, 30000);
    return () => clearInterval(interval);
  }, [fetchCount]);

  useEffect(() => {
    if (open) fetchNotifications();
  }, [open, fetchNotifications]);

  useEffect(() => {
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const markAllRead = async () => {
    await notificationService.markAllRead();
    setNotifications(n => n.map(x => ({ ...x, is_read: true })));
    setUnread(0);
  };

  const markRead = async (id) => {
    await notificationService.markRead(id);
    setNotifications(n => n.map(x => x.id === id ? { ...x, is_read: true } : x));
    setUnread(c => Math.max(0, c - 1));
  };

  return (
    <div ref={panelRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="header-icon-btn"
        aria-label="Notifications"
      >
        <Bell size={20} />
        {unread > 0 && (
          <span className="notif-dot">{unread > 99 ? '99+' : unread}</span>
        )}
      </button>

      {open && (
        <div className="notif-panel">
          <div className="notif-panel-header">
            <span className="notif-panel-title">Notifications</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {unread > 0 && (
                <button onClick={markAllRead} className="notif-mark-all">Mark all read</button>
              )}
              <button onClick={() => setOpen(false)} className="notif-close-btn">
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="notif-list">
            {loading ? (
              <div className="notif-empty">Loading...</div>
            ) : notifications.length === 0 ? (
              <div className="notif-empty">
                <Bell size={24} style={{ opacity: 0.3, marginBottom: 6 }} />
                <p style={{ margin: 0 }}>No notifications</p>
              </div>
            ) : notifications.map(n => (
              <div
                key={n.id}
                onClick={() => !n.is_read && markRead(n.id)}
                className={`notif-item ${n.is_read ? '' : 'notif-item--unread'}`}
              >
                <div style={{ flexShrink: 0, marginTop: 2 }}>
                  <ArrowRightLeft size={14} color="#2563eb" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className={`notif-item-title ${n.is_read ? '' : 'notif-item-title--unread'}`}>
                    {n.title}
                  </div>
                  <div className="notif-item-msg">{n.message}</div>
                  <div className="notif-item-time">{timeAgo(n.created_at)}</div>
                </div>
                {!n.is_read && <div className="notif-unread-dot" />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WarehouseSelector (corporate users only)
// ---------------------------------------------------------------------------

function WarehouseSelector() {
  const { selectedWarehouse, setSelectedWarehouse } = useAuth();
  const [warehouses, setWarehouses] = useState([]);

  useEffect(() => {
    apiClient.get('/master-data/warehouses')
      .then(r => setWarehouses(r.data.filter(w => w.is_active)))
      .catch(() => {});
  }, []);

  return (
    <div className="warehouse-selector">
      <Building2 size={15} className="warehouse-selector-icon" />
      <select
        value={selectedWarehouse || ''}
        onChange={(e) => {
          const warehouseId = e.target.value || null;
          setSelectedWarehouse(warehouseId);
          const wh = warehouses.find(w => w.id === warehouseId);
          setAppTimezone(wh?.timezone || null);
        }}
        className="warehouse-selector-select"
      >
        <option value="">All Warehouses</option>
        {warehouses.map(w => (
          <option key={w.id} value={w.id}>{w.name}</option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function Sidebar({ isOpen, isCollapsed, onToggleCollapse, onClose }) {
  const { user } = useAuth();
  const { receipts, inventoryHoldActions, inventoryAdjustments, inventoryTransfers } = useAppData();
  const location = useLocation();
  const navigate = useNavigate();

  const role = user?.role;
  const prefix = getRolePrefix(role);
  const isAdmin = ADMIN_ROLES.includes(role);
  const isSuperadmin = role === 'superadmin';
  const isCorporate = ['corporate_admin', 'corporate_viewer'].includes(role);

  // Pending count — warehouse excludes own submissions
  const pendingCount = useMemo(() => {
    const uid = user?.id || user?.username;
    const isWarehouse = role === 'warehouse';

    const filter = (arr, statusCheck, byFields) =>
      arr?.filter(item =>
        statusCheck(item) &&
        (!isWarehouse || byFields.every(f => item[f] !== uid))
      )?.length || 0;

    return (
      filter(receipts,
        r => r.status === RECEIPT_STATUS.RECORDED || r.status === RECEIPT_STATUS.REVIEWED,
        ['submittedBy', 'submitted_by']
      ) +
      filter(inventoryHoldActions,
        h => h.status === HOLD_STATUS.PENDING,
        ['submittedBy', 'submitted_by']
      ) +
      filter(inventoryAdjustments,
        a => a.status === ADJUSTMENT_STATUS.PENDING,
        ['submittedBy', 'submitted_by']
      ) +
      filter(inventoryTransfers,
        t => t.status === TRANSFER_STATUS.PENDING,
        ['requestedBy', 'requested_by']
      )
    );
  }, [receipts, inventoryHoldActions, inventoryAdjustments, inventoryTransfers, user, role]);

  const navSections = useMemo(() => {
    const sections = [];
    const warehouseType = user?.warehouse_type;

    // --- Operations ---
    const opsItems = [
      { label: 'Dashboard', icon: Home, to: prefix, exact: true },
      { label: 'Log Receipt', icon: FileText, to: `${prefix}/receipt` },
    ];
    if (role === 'warehouse') {
      opsItems.push({ label: 'Receipt Corrections', icon: AlertCircle, to: `${prefix}/receipt-corrections` });
    }
    opsItems.push(
      { label: 'Inventory', icon: Eye, to: `${prefix}/inventory` },
      { label: 'Inventory Actions', icon: Zap, to: `${prefix}/inventory-actions` },
    );
    sections.push({ group: 'Operations', items: opsItems });

    // --- Approvals ---
    sections.push({
      group: 'Approvals',
      items: [{ label: 'Pending Approvals', icon: CheckCircle, to: `${prefix}/approvals`, badge: pendingCount }],
    });

    // --- Counting ---
    sections.push({
      group: 'Counting',
      items: [
        { label: 'Cycle Counting', icon: ClipboardList, to: `${prefix}/cycle-counting` },
        { label: 'Pallet Tags', icon: Printer, to: `${prefix}/pallet-tags` },
      ],
    });

    // --- Production (feature-gated) ---
    const hasStaging = hasFeature(warehouseType, 'staging');
    const hasProdReqs = hasFeature(warehouseType, 'productionRequests');
    if (hasStaging || hasProdReqs) {
      const prodItems = [];
      if (isAdmin && hasStaging) {
        prodItems.push({ label: 'Staging Overview', icon: Layers, to: `${prefix}/staging` });
      }
      if (hasProdReqs) {
        prodItems.push({ label: 'Production Requests', icon: Layers, to: `${prefix}/production-requests` });
      }
      if (prodItems.length > 0) {
        sections.push({ group: 'Production', items: prodItems });
      }
    }

    // --- Transfers (admin+) ---
    if (isAdmin) {
      sections.push({
        group: 'Transfers',
        items: [{ label: 'Inter-Warehouse', icon: ArrowRightLeft, to: `${prefix}/inter-warehouse-transfers` }],
      });
    }

    // --- Catalog (supervisor+) ---
    if (role !== 'warehouse') {
      sections.push({
        group: 'Catalog',
        items: [
          { label: 'Products', icon: Package, to: `${prefix}/products` },
          { label: 'Master Data', icon: Database, to: `${prefix}/master-data` },
        ],
      });
    }

    // --- Reports ---
    const reportItems = [];
    if (isAdmin) {
      reportItems.push({ label: 'Reports', icon: BarChart3, to: `${prefix}/reports` });
      reportItems.push({ label: 'BOL Report', icon: FileSpreadsheet, to: `${prefix}/bol` });
    }
    if (reportItems.length > 0) {
      sections.push({ group: 'Reports', items: reportItems });
    }

    // --- Admin (superadmin / corporate) ---
    if (isSuperadmin || isCorporate) {
      const adminItems = [];
      if (isSuperadmin) {
        adminItems.push({ label: 'Users', icon: Users, to: '/admin/users' });
      }
      adminItems.push({ label: 'Warehouses', icon: Shield, to: '/admin/warehouses' });
      sections.push({ group: 'Admin', items: adminItems });
    }

    return sections;
  }, [role, prefix, pendingCount, user?.warehouse_type, isAdmin, isSuperadmin, isCorporate]);

  const handleNavClick = (to) => {
    navigate(to);
    onClose();
  };

  const isActive = (item) =>
    item.exact
      ? location.pathname === item.to
      : location.pathname.startsWith(item.to);

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          className="sidebar-backdrop"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <nav
        className={`sidebar${isCollapsed ? ' sidebar--collapsed' : ''}${isOpen ? ' sidebar--open' : ''}`}
        aria-label="Main navigation"
      >
        {/* Sidebar top bar — collapse/close controls only, brand lives in main header */}
        <div className="sidebar-header">
          {/* Collapse toggle — desktop only */}
          <button
            className="sidebar-collapse-btn"
            onClick={onToggleCollapse}
            aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <ChevronLeft size={16} />
          </button>

          {/* Close button — mobile only */}
          <button
            className="sidebar-close-btn"
            onClick={onClose}
            aria-label="Close menu"
          >
            <X size={20} />
          </button>
        </div>

        {/* Scrollable nav */}
        <div className="sidebar-nav">
          {navSections.map((section) => (
            <div key={section.group} className="sidebar-section">
              {!isCollapsed && (
                <span className="sidebar-section-label">{section.group}</span>
              )}
              {section.items.map((item) => {
                const Icon = item.icon;
                const active = isActive(item);
                return (
                  <button
                    key={item.to}
                    className={`sidebar-link${active ? ' sidebar-link--active' : ''}`}
                    onClick={() => handleNavClick(item.to)}
                    title={isCollapsed ? item.label : undefined}
                    aria-current={active ? 'page' : undefined}
                  >
                    <span className="sidebar-link-icon">
                      <Icon size={18} />
                    </span>
                    {!isCollapsed && (
                      <>
                        <span className="sidebar-link-label">{item.label}</span>
                        {item.badge > 0 && (
                          <span className="sidebar-badge">
                            {item.badge > 99 ? '99+' : item.badge}
                          </span>
                        )}
                      </>
                    )}
                    {isCollapsed && item.badge > 0 && (
                      <span className="sidebar-badge-dot" aria-hidden="true" />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </nav>
    </>
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const Layout = ({ children }) => {
  const { user, logout, isCorporateUser } = useAuth();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('sunberry-sidebar-collapsed') === 'true'
  );

  const toggleCollapse = () => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      localStorage.setItem('sunberry-sidebar-collapsed', String(next));
      return next;
    });
  };

  // Auto-close mobile drawer when viewport goes above breakpoint
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 769px)');
    const handler = (e) => { if (e.matches) setSidebarOpen(false); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return (
    <div className={`layout${sidebarCollapsed ? ' layout--sidebar-collapsed' : ''}`}>
      <Sidebar
        isOpen={sidebarOpen}
        isCollapsed={sidebarCollapsed}
        onToggleCollapse={toggleCollapse}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="layout-body">
        <header className="header">
          <div className="header-content">
            {/* Hamburger — mobile only */}
            <button
              className="header-hamburger"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open navigation"
            >
              <Menu size={22} />
            </button>

            {/* Brand — always visible in header */}
            <span className="header-brand">Sunberry Farms</span>

            <div className="header-actions">
              {isCorporateUser && <WarehouseSelector />}
              <span className="username">Hello {user?.username || 'User'}!</span>
              <NotificationBell />
              <button
                type="button"
                className="logout-button"
                onClick={logout}
                aria-label="Sign out"
              >
                <LogOut size={18} />
                <span>Sign Out</span>
              </button>
            </div>
          </div>
        </header>

        <main className="main-content">
          {children}
        </main>
      </div>
    </div>
  );
};

export default Layout;
