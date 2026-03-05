import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../context/AppDataContext';
import { useAuth } from '../context/AuthContext';
import { hasFeature } from '../utils/warehouseFeatures';
import {
  TrendingUp,
  FileText,
  AlertCircle,
  Eye,
  Zap,
  Printer,
  Layers,
  ClipboardList,
  CheckCircle
} from 'lucide-react';
import './WarehouseDashboard.css';

const WarehouseDashboard = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { receipts, finishedGoodsCapacitySummary, rawMaterialsCapacitySummary, inventoryHoldActions, inventoryAdjustments, inventoryTransfers } = useAppData();

  // Count sent-back receipts
  const sentBackCount = useMemo(() => {
    return receipts.filter(receipt => {
      if (receipt.status !== 'recorded') return false;
      return receipt.note && receipt.note.includes('[Sent Back by Supervisor]');
    }).length;
  }, [receipts]);

  // Calculate pending approvals count for warehouse workers
  // Warehouse workers can only approve items submitted by OTHER users (not their own)
  const totalPendingCount = useMemo(() => {
    const currentUserId = user?.id || user?.username;
    
    // Pending receipts submitted by others
    const pendingReceiptsCount = receipts?.filter(r => 
      (r.status === 'recorded' || r.status === 'reviewed') && 
      r.submittedBy !== currentUserId && 
      r.submitted_by !== currentUserId
    )?.length || 0;
    
    // Pending holds submitted by others
    const pendingHoldsCount = inventoryHoldActions?.filter(h => 
      h.status === 'pending' && 
      h.submittedBy !== currentUserId && 
      h.submitted_by !== currentUserId
    )?.length || 0;
    
    // Pending adjustments submitted by others
    const pendingAdjustmentsCount = inventoryAdjustments?.filter(a => 
      a.status === 'pending' && 
      a.submittedBy !== currentUserId && 
      a.submitted_by !== currentUserId
    )?.length || 0;
    
    // Pending transfers submitted by others
    const pendingTransfersCount = inventoryTransfers?.filter(t => 
      t.status === 'pending' && 
      t.requestedBy !== currentUserId && 
      t.requested_by !== currentUserId
    )?.length || 0;
    
    return pendingReceiptsCount + pendingHoldsCount + pendingAdjustmentsCount + pendingTransfersCount;
  }, [receipts, inventoryHoldActions, inventoryAdjustments, inventoryTransfers, user]);

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
    <div className="warehouse-page">
      <header className="warehouse-header">
        <div>
          <h1>Warehouse Tools</h1>
          <p>Quick access to daily tasks for warehouse staff.</p>
        </div>
      </header>

      {/* Metrics Section */}
      <section className="warehouse-metrics">
        {/* Finished Goods Rack Utilization */}
        <article className="warehouse-metric-card card">
          <div className="metric-icon-wrapper">
            <TrendingUp className="metric-icon" size={24} />
          </div>
          <div className="metric-content">
            <h3 className="metric-label">Rack Utilization for FG</h3>
            <div className="metric-value-section">
              <span className={`metric-value status-${fgUtilizationStatus}`}>{fgUtilizationLabel}</span>
            </div>
            <div className="progress-bar" role="progressbar" aria-valuenow={Math.min(100, Math.max(0, fgUtilization || 0))}>
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
          </div>
        </article>

        {/* Finished Goods Floor Staging */}
        <article className="warehouse-metric-card card">
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
        <article className="warehouse-metric-card card">
          <div className="metric-icon-wrapper">
            <TrendingUp className="metric-icon" size={24} />
          </div>
          <div className="metric-content">
            <h3 className="metric-label">Raw Materials Rack Utilization</h3>
            <div className="metric-value-section">
              <span className={`metric-value status-${rmUtilizationStatus}`}>{rmUtilizationLabel}</span>
            </div>
            <div className="progress-bar" role="progressbar" aria-valuenow={Math.min(100, Math.max(0, rmUtilization || 0))}>
              <div
                className={`progress-bar__fill status-${rmUtilizationStatus}`}
                style={{ width: `${Math.min(100, Math.max(0, rmUtilization || 0))}%` }}
              />
            </div>
            <ul className="metric-breakdown">
              <li><strong>{rmOccupiedPallets != null ? Number(rmOccupiedPallets).toFixed(2) : 0}</strong> occupied</li>
              <li><strong>{rmAvailablePallets != null ? Number(rmAvailablePallets).toFixed(2) : 0}</strong> available</li>
              <li><strong>{rmHeldPallets ?? 0}</strong> on hold</li>
              <li><strong>{rmTotalPalletCapacity ?? 0}</strong> total</li>
            </ul>
          </div>
        </article>

        {/* Raw Materials Floor Staging */}
        <article className="warehouse-metric-card card">
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

      {/* Quick Actions */}
      <section className="warehouse-quick-actions">
        <button className="action-button primary" onClick={() => navigate('/warehouse/receipt')}>
          <div className="action-icon">
            <FileText size={24} />
          </div>
          <div className="action-content">
            <h3>Log New Receipt</h3>
            <p>Submit raw materials or finished goods</p>
          </div>
        </button>

        <button
          className={`action-button ${sentBackCount > 0 ? 'warning' : ''}`}
          onClick={() => navigate('/warehouse/receipt-corrections')}
        >
          <div className="action-icon">
            <AlertCircle size={24} />
          </div>
          <div className="action-content">
            <h3>Receipt Corrections</h3>
            <p>Review and fix sent-back receipts</p>
          </div>
          {sentBackCount > 0 && (
            <span className="notification-badge">{sentBackCount}</span>
          )}
        </button>

        <button className="action-button" onClick={() => navigate('/warehouse/inventory')}>
          <div className="action-icon">
            <Eye size={24} />
          </div>
          <div className="action-content">
            <h3>View Inventory</h3>
            <p>Check available stock and lots</p>
          </div>
        </button>

        <button className="action-button" onClick={() => navigate('/warehouse/inventory-actions')}>
          <div className="action-icon">
            <Zap size={24} />
          </div>
          <div className="action-content">
            <h3>Inventory Actions</h3>
            <p>Transfers, holds, and adjustments</p>
          </div>
        </button>

        <button 
          className={`action-button ${totalPendingCount > 0 ? 'warning' : ''}`}
          onClick={() => navigate('/warehouse/approvals')}
        >
          <div className="action-icon">
            <CheckCircle size={24} />
          </div>
          <div className="action-content">
            <h3>Pending Approvals</h3>
            <p>Review and approve submissions from others</p>
          </div>
          {totalPendingCount > 0 && (
            <span className="notification-badge">{totalPendingCount}</span>
          )}
        </button>

        <button className="action-button" onClick={() => navigate('/warehouse/pallet-tags')}>
          <div className="action-icon">
            <Printer size={24} />
          </div>
          <div className="action-content">
            <h3>Print Pallet Tags</h3>
            <p>Generate and print pallet labels</p>
          </div>
        </button>

        <button className="action-button" onClick={() => navigate('/warehouse/cycle-counting')}>
          <div className="action-icon">
            <ClipboardList size={24} />
          </div>
          <div className="action-content">
            <h3>Cycle Counting</h3>
            <p>Physical inventory counts</p>
          </div>
        </button>


        {hasFeature(user?.warehouse_type, 'productionRequests') && (
          <button className="action-button" onClick={() => navigate('/warehouse/production-requests')} style={{ borderLeft: '3px solid #007bff' }}>
            <div className="action-icon">
              <Layers size={24} />
            </div>
            <div className="action-content">
              <h3>Production Staging Requests</h3>
              <p>View batch staging requests from Production</p>
            </div>
          </button>
        )}
      </section>

      {/* Helpful Reminders */}
      <section className="warehouse-reminders card">
        <h2>Helpful Reminders</h2>
        <ul>
          <li>All receipts must be approved before stock counts update.</li>
          <li>Attach lot numbers when available to help traceability.</li>
          <li>Use the notes field for quality checks or delivery issues.</li>
        </ul>
      </section>
    </div>
  );
};

export default WarehouseDashboard;
