import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../context/AppDataContext';
import {
  TrendingUp,
  Package,
  Database,
  FileText,
  Eye,
  Zap,
  CheckCircle,
  Printer,
  Layers,
  ClipboardList,
  BarChart3
} from 'lucide-react';
import './SupervisorDashboard.css';

const SupervisorDashboard = () => {
  const navigate = useNavigate();
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

  return (
    <div className="supervisor-page">
      <header className="supervisor-header">
        <div>
          <h1>Supervisor Tools</h1>
          <p>Manage products, monitor inventory, and review warehouse activity.</p>
        </div>
      </header>

      <section className="supervisor-metrics">
        {/* Finished Goods Rack Utilization */}
        <article className="supervisor-metric-card card">
          <div className="metric-icon-wrapper">
            <TrendingUp className="metric-icon" size={24} />
          </div>
          <div className="metric-content">
            <h3 className="metric-label">Rack Utilization for FG</h3>
            <div className="metric-value-section">
              <span className={`metric-value status-${fgUtilizationStatus}`}>{fgUtilizationLabel}</span>
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
              <div className="metric-alert">
                <strong>Warning:</strong> Rack utilization at {fgUtilizationLabel}. Consider expanding storage.
              </div>
            )}
          </div>
        </article>

        {/* Finished Goods Floor Staging */}
        <article className="supervisor-metric-card card">
          <div className="metric-icon-wrapper secondary">
            <Layers className="metric-icon" size={24} />
          </div>
          <div className="metric-content">
            <h3 className="metric-label">Floor Pallets Count for FG</h3>
            <div className="metric-value-section">
              <span className="metric-value">{fgFloorStagingPallets ?? 0}</span>
              <span className="metric-unit">pallets</span>
            </div>
            <p className="metric-subtext">
              Pallets currently staged on the warehouse floor awaiting rack space.
            </p>
          </div>
        </article>

        {/* Raw Materials Rack Utilization */}
        <article className="supervisor-metric-card card">
          <div className="metric-icon-wrapper">
            <TrendingUp className="metric-icon" size={24} />
          </div>
          <div className="metric-content">
            <h3 className="metric-label">Raw Materials Rack Utilization</h3>
            <div className="metric-value-section">
              <span className={`metric-value status-${rmUtilizationStatus}`}>{rmUtilizationLabel}</span>
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
              <div className="metric-alert">
                <strong>Warning:</strong> Rack utilization at {rmUtilizationLabel}. Consider expanding storage.
              </div>
            )}
          </div>
        </article>

        {/* Raw Materials Floor Staging */}
        <article className="supervisor-metric-card card">
          <div className="metric-icon-wrapper secondary">
            <Layers className="metric-icon" size={24} />
          </div>
          <div className="metric-content">
            <h3 className="metric-label">Raw Materials Floor Pallets Count</h3>
            <div className="metric-value-section">
              <span className="metric-value">{rmFloorStagingPallets ?? 0}</span>
              <span className="metric-unit">pallets</span>
            </div>
            <p className="metric-subtext">
              Raw materials pallets currently staged on the warehouse floor awaiting rack space.
            </p>
          </div>
        </article>
      </section>

      <section className="supervisor-dashboard-grid">
        <div className="supervisor-dashboard-card card-gradient">
          <div className="card-icon">
            <Database size={28} />
          </div>
          <div className="card-content">
            <h3 className="card-title">Catalog & Master Data</h3>
            <p className="card-description">
              Keep product, category, vendor, and location information current.
            </p>
          </div>
          <div className="button-stack">
            <button className="nav-button" onClick={() => navigate('/supervisor/products')}>
              <Package size={18} />
              <span>Products</span>
            </button>
            <button className="nav-button" onClick={() => navigate('/supervisor/master-data')}>
              <Database size={18} />
              <span>Master Data</span>
            </button>
          </div>
        </div>

        <div className="supervisor-dashboard-card card-gradient">
          <div className="card-icon">
            <Zap size={28} />
          </div>
          <div className="card-content">
            <h3 className="card-title">Warehouse Operations</h3>
            <p className="card-description">
              Record receipts, track inventory, and manage approvals.
            </p>
          </div>
          <div className="button-stack">
            <button className="nav-button" onClick={() => navigate('/supervisor/receipt')}>
              <FileText size={18} />
              <span>Log Receipt</span>
            </button>
            <button className="nav-button" onClick={() => navigate('/supervisor/inventory')}>
              <Eye size={18} />
              <span>Inventory Overview</span>
            </button>
            <button className="nav-button" onClick={() => navigate('/supervisor/inventory-actions')}>
              <Zap size={18} />
              <span>Inventory Actions</span>
            </button>
            <button className="nav-button" onClick={() => navigate('/supervisor/approvals')}>
              <CheckCircle size={18} />
              <span>Pending Approvals</span>
              {totalPendingCount > 0 && (
                <span className="pending-badge">{totalPendingCount}</span>
              )}
            </button>
            <button className="nav-button" onClick={() => navigate('/supervisor/pallet-tags')}>
              <Printer size={18} />
              <span>Print Pallet Tags</span>
            </button>
            <button className="nav-button" onClick={() => navigate('/supervisor/cycle-counting')}>
              <ClipboardList size={18} />
              <span>Cycle Counting</span>
            </button>
          </div>
        </div>

        <div className="supervisor-dashboard-card card-gradient">
          <div className="card-icon">
            <BarChart3 size={28} />
          </div>
          <div className="card-content">
            <h3 className="card-title">Analytics & Reporting</h3>
            <p className="card-description">
              BOL report — batch output vs logged finished goods.
            </p>
          </div>
          <div className="button-stack">
            <button className="nav-button" onClick={() => navigate('/supervisor/bol')}>
              <BarChart3 size={18} />
              <span>BOL</span>
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};

export default SupervisorDashboard;
