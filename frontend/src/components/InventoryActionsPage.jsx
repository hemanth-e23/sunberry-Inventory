import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getDashboardPath } from '../App';
import TransfersTab from './inventory/TransfersTab';
import HoldsTab from './inventory/HoldsTab';
import AdjustmentsTab from './inventory/AdjustmentsTab';
import ShipOutTab from './inventory/ShipOutTab';
import './Shared.css';
import './InventoryActionsPage.css';

const TAB_OPTIONS = ['transfers', 'holds', 'adjustments', 'shipout'];

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
            {tab === 'shipout' ? 'Ship Out' : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {activeTab === 'transfers' && <TransfersTab />}
      {activeTab === 'holds' && <HoldsTab />}
      {activeTab === 'adjustments' && <AdjustmentsTab />}
      {activeTab === 'shipout' && <ShipOutTab />}
    </div>
  );
};

export default InventoryActionsPage;
