import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getDashboardPath } from '../App';
import OutgoingDashboard from './OutgoingDashboard';
import IncomingTab from './shipping/IncomingTab';
import './OutgoingDashboard.css';

/**
 * Shipping — Incoming and Outgoing, on one screen.
 *
 * This replaces the "Outgoing" nav item rather than adding to it. NET NEW NAV
 * ITEMS: ZERO, which was an explicit requirement — the ask was to adjust the
 * screens that exist, not to grow the sidebar.
 *
 * The two directions genuinely are the same shape: corporate plans, the plant
 * executes, and the difference between what was planned and what physically
 * happened is the number worth looking at. Putting them side by side makes that
 * symmetry visible instead of splitting it across two screens that happen to
 * share a code pattern.
 *
 * ── Why the tab bar lives here and not inside the tabs ──────────────────────
 *
 * `OutgoingDashboard` early-returns its order-detail view, replacing its own
 * subtree entirely. If the tab bar were rendered inside it, opening an order
 * would make the tabs vanish. Rendering the bar in this shell means a detail
 * view swaps only the panel below it.
 *
 * The page header — the back button — is rendered ONCE here, and the tabs are
 * passed `embedded` so they do not render their own.
 */

const TABS = [
  { key: 'incoming', label: 'Incoming' },
  { key: 'outgoing', label: 'Outgoing' },
];

const ShippingPage = () => {
  const navigate = useNavigate();
  const { user, selectedWarehouseName } = useAuth();
  // Plain useState with no URL sync — the pattern every other tabbed page in
  // this codebase uses. A refresh lands on the default tab.
  const [activeTab, setActiveTab] = useState('incoming');

  return (
    <div className="inventory-actions-page">
      <div className="page-header">
        <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
          &larr; Back to Dashboard
        </button>
      </div>

      <div className="og-header">
        <div>
          <h2>Shipping</h2>
          <div className="og-sub">
            What is coming in and what is going out.
            {selectedWarehouseName ? ` Warehouse: ${selectedWarehouseName}.` : ''}
          </div>
        </div>
      </div>

      <div className="tabs">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`tab-button ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="tab-panel">
        {activeTab === 'incoming' && <IncomingTab />}
        {activeTab === 'outgoing' && <OutgoingDashboard embedded />}
      </div>
    </div>
  );
};

export default ShippingPage;
