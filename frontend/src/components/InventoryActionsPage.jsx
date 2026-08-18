import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getDashboardPath } from '../App';
import TransfersTab from './inventory/TransfersTab';
import HoldsTab from './inventory/HoldsTab';
import AdjustmentsTab from './inventory/AdjustmentsTab';
import ShipOutTab from './inventory/ShipOutTab';
import ScheduleShipOutTab from './inventory/ScheduleShipOutTab';
import CountsTab from './inventory/CountsTab';
import './Shared.css';
import './InventoryActionsPage.css';

// The legacy lot-based 'shipout' tab is retired (Task 9) — the scheduled flow
// replaces it. ShipOutTab.jsx is kept in the tree for reference/rollback.
// 'counts' is where a physical count of raw material is recorded — and
// during the changeover, where stock is entered onto the lot model by hand.
// Counting a rack IS an inventory action, so it belongs here rather than behind
// a nav item of its own.
const TAB_OPTIONS = ['transfers', 'holds', 'adjustments', 'counts', 'schedule'];
const TAB_LABELS = { schedule: 'Ship Out' };

const InventoryActionsPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [activeTab, setActiveTab] = useState('transfers');

  return (
    <div className="inventory-actions-page">
      <div className="page-header">
        <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
          &larr; Back to Dashboard
        </button>
        <div className="header-content">
          <h2>Inventory Actions</h2>
          <p className="muted">Request transfers, toggle holds, or submit quantity/location corrections.</p>
        </div>
      </div>

      <div className="tabs">
        {TAB_OPTIONS.map(tab => (
          <button
            key={tab}
            className={`tab-button ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {TAB_LABELS[tab] || (tab.charAt(0).toUpperCase() + tab.slice(1))}
          </button>
        ))}
      </div>

      {activeTab === 'transfers' && <TransfersTab />}
      {activeTab === 'holds' && <HoldsTab />}
      {activeTab === 'adjustments' && <AdjustmentsTab />}
      {activeTab === 'shipout' && <ShipOutTab />}
      {activeTab === 'counts' && <CountsTab />}
      {activeTab === 'schedule' && <ScheduleShipOutTab />}
    </div>
  );
};

export default InventoryActionsPage;
