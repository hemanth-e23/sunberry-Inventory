import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAppData } from '../context/AppDataContext';
import {
  Package,
  Database,
  ClipboardList,
  Eye,
  GitBranch,
  CheckCircle2,
  ListChecks,
  Printer,
  BarChart3,
  Users,
  TrendingUp,
  AlertCircle
} from 'lucide-react';
import './AdminDashboard.css';

const AdminDashboard = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { finishedGoodsCapacitySummary, rawMaterialsCapacitySummary, receipts, inventoryHoldActions, inventoryAdjustments, inventoryTransfers } = useAppData();

  // Calculate pending approvals count with useMemo for reactivity
  // Receipts use 'recorded' or 'reviewed' as pending statuses, not 'pending'
  const totalPendingCount = React.useMemo(() => {
    const pendingReceiptsCount = receipts?.filter(r => r.status === 'recorded' || r.status === 'reviewed')?.length || 0;
    const pendingHoldsCount = inventoryHoldActions?.filter(h => h.status === 'pending')?.length || 0;
    const pendingAdjustmentsCount = inventoryAdjustments?.filter(a => a.status === 'pending')?.length || 0;
    const pendingTransfersCount = inventoryTransfers?.filter(t => t.status === 'pending')?.length || 0;
    return pendingReceiptsCount + pendingHoldsCount + pendingAdjustmentsCount + pendingTransfersCount;
  }, [receipts, inventoryHoldActions, inventoryAdjustments, inventoryTransfers]);

  const {
    totalPalletCapacity: fgTotalPalletCapacity,
    occupiedPallets: fgOccupiedPallets,
    availablePallets: fgAvailablePallets,
    heldPallets: fgHeldPallets,
    utilization: fgUtilization,
    floorStagingPallets: fgFloorStagingPallets,
  } = finishedGoodsCapacitySummary || {};

  const {
    totalPalletCapacity: rmTotalPalletCapacity,
    occupiedPallets: rmOccupiedPallets,
    availablePallets: rmAvailablePallets,
    heldPallets: rmHeldPallets,
    utilization: rmUtilization,
    floorStagingPallets: rmFloorStagingPallets,
  } = rawMaterialsCapacitySummary || {};

  const fgUtilizationLabel = Number.isFinite(fgUtilization)
    ? `${Math.round(fgUtilization)}%`
    : '0%';

  const fgUtilizationStatus = fgUtilization >= 90 ? 'critical' : fgUtilization >= 70 ? 'warning' : 'ok';

  const rmUtilizationLabel = Number.isFinite(rmUtilization)
    ? `${Math.round(rmUtilization)}%`
    : '0%';

  const rmUtilizationStatus = rmUtilization >= 90 ? 'critical' : rmUtilization >= 70 ? 'warning' : 'ok';

  // Get time-based greeting
  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good Morning';
    if (hour < 18) return 'Good Afternoon';
    return 'Good Evening';
  };

  return (
    <div className="admin-dashboard">
      {/* Welcome Header */}
      <header className="dashboard-welcome animate-fade-in">
        <div className="welcome-text">
          <h1 className="heading heading-lg">
            {getGreeting()}, <span className="text-gradient">{user?.username || 'Admin'}</span>
          </h1>
          <p>Manage your inventory operations and monitor warehouse activity</p>
        </div>
      </header>

      {/* Metrics Section */}
      <section className="dashboard-metrics animate-fade-in">
        {/* Finished Goods Rack Utilization */}
        <article className="metric-card card">
          <div className="metric-icon-wrapper">
            <TrendingUp className="metric-icon" size={34} />
          </div>
          <div className="metric-content">
            <h3 className="metric-label">Rack Utilization for FG</h3>
            <div className="metric-value-section">
              <span className={`metric-value status-${fgUtilizationStatus}`}>{fgUtilizationLabel}</span>
              {fgUtilizationStatus === 'critical' && (
                <AlertCircle className="metric-alert-icon" size={20} />
              )}
            </div>
            <div className="progress-bar" role="progressbar" aria-valuenow={Math.min(100, Math.max(0, fgUtilization || 0))} aria-valuemin={0} aria-valuemax={100}>
              <div
                className={`progress-bar__fill status-${fgUtilizationStatus}`}
                style={{ width: `${Math.min(100, Math.max(0, fgUtilization || 0))}%` }}
              />
            </div>
            <ul className="metric-breakdown">
              <li><strong>{fgOccupiedPallets ?? 0}</strong> occupied</li>
              <li><strong>{fgAvailablePallets ?? 0}</strong> available</li>
              <li><strong>{fgHeldPallets ?? 0}</strong> on hold</li>
              <li><strong>{fgTotalPalletCapacity ?? 0}</strong> total</li>
            </ul>
            {fgUtilizationStatus === 'critical' && (
              <p className="metric-alert">
                <AlertCircle size={16} />
                <span>Rack space above 90%. Consider dispatch or expansion.</span>
              </p>
            )}
          </div>
        </article>

        {/* Finished Goods Floor Staging */}
        <article className="metric-card card">
          <div className="metric-icon-wrapper secondary">
            <Package className="metric-icon" size={24} />
          </div>
          <div className="metric-content">
            <h3 className="metric-label">Floor Pallets Count for FG</h3>
            <span className="metric-value">{fgFloorStagingPallets ?? 0}</span>
            <p className="metric-subtext">Pallets awaiting rack space</p>
          </div>
        </article>

        {/* Raw Materials Rack Utilization */}
        <article className="metric-card card">
          <div className="metric-icon-wrapper">
            <TrendingUp className="metric-icon" size={34} />
          </div>
          <div className="metric-content">
            <h3 className="metric-label">Raw Materials Rack Utilization</h3>
            <div className="metric-value-section">
              <span className={`metric-value status-${rmUtilizationStatus}`}>{rmUtilizationLabel}</span>
              {rmUtilizationStatus === 'critical' && (
                <AlertCircle className="metric-alert-icon" size={20} />
              )}
            </div>
            <div className="progress-bar" role="progressbar" aria-valuenow={Math.min(100, Math.max(0, rmUtilization || 0))} aria-valuemin={0} aria-valuemax={100}>
              <div
                className={`progress-bar__fill status-${rmUtilizationStatus}`}
                style={{ width: `${Math.min(100, Math.max(0, rmUtilization || 0))}%` }}
              />
            </div>
            <ul className="metric-breakdown">
              <li><strong>{rmOccupiedPallets ?? 0}</strong> occupied</li>
              <li><strong>{rmAvailablePallets ?? 0}</strong> available</li>
              <li><strong>{rmHeldPallets ?? 0}</strong> on hold</li>
              <li><strong>{rmTotalPalletCapacity ?? 0}</strong> total</li>
            </ul>
            {rmUtilizationStatus === 'critical' && (
              <p className="metric-alert">
                <AlertCircle size={16} />
                <span>Rack space above 90%. Consider dispatch or expansion.</span>
              </p>
            )}
          </div>
        </article>

        {/* Raw Materials Floor Staging */}
        <article className="metric-card card">
          <div className="metric-icon-wrapper secondary">
            <Package className="metric-icon" size={24} />
          </div>
          <div className="metric-content">
            <h3 className="metric-label">Raw Materials Floor Pallets Count</h3>
            <span className="metric-value">{rmFloorStagingPallets ?? 0}</span>
            <p className="metric-subtext">Raw materials pallets awaiting rack space</p>
          </div>
        </article>
      </section>

      {/* Dashboard Cards Grid */}
      <div className="dashboard-grid stagger-children">
        {/* Catalog & Master Data */}
        <section className="dashboard-card card-gradient hover-lift">
          <div className="card-icon">
            <Database size={32} />
          </div>
          <div className="card-content">
            <h2 className="card-title">Catalog & Master Data</h2>
            <p className="card-description">Manage products, categories, vendors, and locations</p>
          </div>
          <div className="button-stack">
            <button className="nav-button" onClick={() => navigate('/admin/products')}>
              <Package size={18} />
              <span>Products</span>
            </button>
            <button className="nav-button" onClick={() => navigate('/admin/master-data')}>
              <Database size={18} />
              <span>Master Data</span>
            </button>
          </div>
        </section>

        {/* Warehouse Operations */}
        <section className="dashboard-card card-gradient hover-lift">
          <div className="card-icon">
            <ClipboardList size={32} />
          </div>
          <div className="card-content">
            <h2 className="card-title">Warehouse Operations</h2>
            <p className="card-description">Record receipts, track inventory, and manage workflow</p>
          </div>
          <div className="button-stack">
            <button className="nav-button" onClick={() => navigate('/admin/receipt')}>
              <ClipboardList size={18} />
              <span>Log Receipt</span>
            </button>
            <button className="nav-button" onClick={() => navigate('/admin/inventory')}>
              <Eye size={18} />
              <span>Inventory Overview</span>
            </button>
            <button className="nav-button" onClick={() => navigate('/admin/inventory-actions')}>
              <GitBranch size={18} />
              <span>Inventory Actions</span>
            </button>
            <button className="nav-button" onClick={() => navigate('/admin/approvals')}>
              <CheckCircle2 size={18} />
              <span>Pending Approvals</span>
              {totalPendingCount > 0 && (
                <span className="pending-badge">{totalPendingCount}</span>
              )}
            </button>
            <button className="nav-button" onClick={() => navigate('/admin/cycle-counting')}>
              <ListChecks size={18} />
              <span>Cycle Counting</span>
            </button>
            <button className="nav-button" onClick={() => navigate('/admin/pallet-tags')}>
              <Printer size={18} />
              <span>Print Pallet Tags</span>
            </button>
          </div>
        </section>

        {/* Analytics & Reporting */}
        <section className="dashboard-card card-gradient hover-lift">
          <div className="card-icon">
            <BarChart3 size={32} />
          </div>
          <div className="card-content">
            <h2 className="card-title">Analytics & Reporting</h2>
            <p className="card-description">Generate insights with inventory and production reports</p>
          </div>
          <div className="button-stack">
            <button className="nav-button" onClick={() => navigate('/admin/reports')}>
              <BarChart3 size={18} />
              <span>Reports</span>
            </button>
          </div>
        </section>

        {/* People */}
        <section className="dashboard-card card-gradient hover-lift">
          <div className="card-icon">
            <Users size={32} />
          </div>
          <div className="card-content">
            <h2 className="card-title">People</h2>
            <p className="card-description">Manage user access and permissions</p>
          </div>
          <div className="button-stack">
            <button className="nav-button" onClick={() => navigate('/admin/users')}>
              <Users size={18} />
              <span>User Management</span>
            </button>
          </div>
        </section>
      </div>
    </div>
  );
};

export default AdminDashboard;