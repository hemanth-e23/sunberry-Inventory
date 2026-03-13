import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppData } from "../context/AppDataContext";
import { useAuth } from "../context/AuthContext";
import { getDashboardPath } from "../App";
import { getDaysAgo, toDateKey, getTodayDateKey } from "../utils/dateUtils";
import apiClient from "../api/client";
import "./Shared.css";
import "./ApprovalsPage.css";
import { RECEIPT_STATUS, TRANSFER_STATUS, ADJUSTMENT_STATUS, HOLD_STATUS, FORKLIFT_REQUEST_STATUS } from '../constants';

import ReceiptsTab from "./approvals/ReceiptsTab";
import TransfersTab from "./approvals/TransfersTab";
import HoldsTab from "./approvals/HoldsTab";
import AdjustmentsTab from "./approvals/AdjustmentsTab";
import ForkliftTab from "./approvals/ForkliftTab";

const STATUS_PENDING = new Set([RECEIPT_STATUS.RECORDED, RECEIPT_STATUS.REVIEWED]);

const ApprovalsPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const currentUserId = user?.id || user?.username;
  const {
    receipts,
    products,
    productCategories,
    vendors,
    locations,
    subLocationMap,
    subLocationsUnifiedMap,
    productionShifts,
    productionLines,
    storageAreas,
    inventoryTransfers,
    inventoryHoldActions,
    inventoryAdjustments,
    userNameMap,
    forkliftRequests,
  } = useAppData();

  const todayKey = useMemo(() => getTodayDateKey(), []);

  // ── Shared lookup maps ──

  const productLookup = useMemo(() => {
    const map = {};
    if (products && Array.isArray(products)) {
      products.forEach((product) => { map[product.id] = product; });
    }
    return map;
  }, [products]);

  const categoryLookup = useMemo(() => {
    const map = {};
    if (productCategories && Array.isArray(productCategories)) {
      productCategories.forEach((category) => { map[category.id] = category; });
    }
    return map;
  }, [productCategories]);

  const vendorLookup = useMemo(() => {
    const map = {};
    if (vendors && Array.isArray(vendors)) {
      vendors.forEach((vendor) => { map[vendor.id] = vendor.name; });
    }
    return map;
  }, [vendors]);

  const locationLookupMap = useMemo(() => {
    const map = {};
    if (locations && Array.isArray(locations)) {
      locations.forEach((location) => {
        map[location.id] = location.name;
        ((subLocationsUnifiedMap && subLocationsUnifiedMap[location.id]) || (subLocationMap[location.id] || [])).forEach((sub) => {
          map[sub.id] = sub.name;
        });
      });
    }
    return map;
  }, [locations, subLocationMap, subLocationsUnifiedMap]);

  const receiptLookup = useMemo(() => {
    const map = {};
    if (receipts && Array.isArray(receipts)) {
      receipts.forEach((receipt) => { map[receipt.id] = receipt; });
    }
    return map;
  }, [receipts]);

  // Row lookup: get row name from storageRowId
  const [rowNameCache, setRowNameCache] = useState({});
  const rowLookup = useMemo(() => {
    const map = { ...rowNameCache };
    if (locations && Array.isArray(locations)) {
      locations.forEach((location) => {
        location.subLocations?.forEach((subLoc) => {
          subLoc.rows?.forEach((row) => {
            if (row.id && row.name) map[row.id] = row.name;
          });
        });
      });
    }
    if (subLocationMap && typeof subLocationMap === 'object') {
      Object.values(subLocationMap).forEach((subLocs) => {
        if (Array.isArray(subLocs)) {
          subLocs.forEach((subLoc) => {
            subLoc.rows?.forEach((row) => {
              if (row.id && row.name) map[row.id] = row.name;
            });
          });
        }
      });
    }
    if (subLocationsUnifiedMap && typeof subLocationsUnifiedMap === 'object') {
      Object.values(subLocationsUnifiedMap).forEach((subLocs) => {
        if (Array.isArray(subLocs)) {
          subLocs.forEach((subLoc) => {
            subLoc.rows?.forEach((row) => {
              if (row.id && row.name) map[row.id] = row.name;
            });
          });
        }
      });
    }
    if (storageAreas && Array.isArray(storageAreas)) {
      storageAreas.forEach((area) => {
        area.rows?.forEach((row) => {
          if (row.id && row.name) map[row.id] = row.name;
        });
      });
    }
    return map;
  }, [locations, subLocationMap, subLocationsUnifiedMap, storageAreas, rowNameCache]);

  const fetchRowName = useCallback(async (rowId) => {
    if (!rowId || rowNameCache[rowId]) return rowNameCache[rowId];
    try {
      const response = await apiClient.get(`/master-data/storage-rows/${rowId}`);
      if (response.data?.name) {
        setRowNameCache(prev => ({ ...prev, [rowId]: response.data.name }));
        return response.data.name;
      }
    } catch (error) {
      console.warn(`Failed to fetch row name for ${rowId}:`, error);
    }
    return null;
  }, [rowNameCache]);

  useEffect(() => {
    const missingRowIds = new Set();
    receipts.forEach(receipt => {
      if (receipt.storageRowId || receipt.storage_row_id) {
        const rowId = receipt.storageRowId || receipt.storage_row_id;
        if (rowId && !rowLookup[rowId] && !rowNameCache[rowId]) missingRowIds.add(rowId);
      }
      if (receipt.rawMaterialRowAllocations && Array.isArray(receipt.rawMaterialRowAllocations)) {
        receipt.rawMaterialRowAllocations.forEach(alloc => {
          if (alloc.rowId && !rowLookup[alloc.rowId] && !rowNameCache[alloc.rowId]) missingRowIds.add(alloc.rowId);
        });
      }
    });
    if (missingRowIds.size > 0) {
      missingRowIds.forEach(rowId => { fetchRowName(rowId); });
    }
  }, [receipts, rowLookup, rowNameCache, fetchRowName]);

  const shiftLookup = useMemo(() => {
    const map = {};
    if (productionShifts && Array.isArray(productionShifts)) {
      productionShifts.forEach((shift) => { map[shift.id] = shift.name; });
    }
    return map;
  }, [productionShifts]);

  const lineLookup = useMemo(() => {
    const map = {};
    if (productionLines && Array.isArray(productionLines)) {
      productionLines.forEach((line) => { map[line.id] = line.name; });
    }
    return map;
  }, [productionLines]);

  // Helper to get location display for finished goods receipts
  const getFinishedGoodsLocation = (receipt) => {
    const plan = receipt.allocation?.plan || receipt.pendingAllocation?.plan || [];
    if (plan && plan.length > 0) {
      const areaGroups = {};
      plan.forEach((item) => {
        if (item.areaName) {
          if (!areaGroups[item.areaName]) areaGroups[item.areaName] = [];
          if (item.rowName && item.pallets) {
            areaGroups[item.areaName].push({ rowName: item.rowName, pallets: item.pallets });
          }
        }
      });
      const formatted = Object.keys(areaGroups).map(areaName => {
        const rows = areaGroups[areaName];
        if (rows.length > 0) {
          const rowStrings = rows.map(r => {
            const palletCount = Number(r.pallets) || 0;
            const palletDisplay = palletCount % 1 === 0 ? palletCount : palletCount.toFixed(2);
            return `${r.rowName} (${palletDisplay} pallets)`;
          });
          return `${areaName}: ${rowStrings.join(', ')}`;
        }
        return areaName;
      });
      if (formatted.length > 0) return formatted.join('; ');
    }
    if (receipt.subLocationId || receipt.subLocation) {
      return locationLookupMap[receipt.subLocationId || receipt.subLocation] || null;
    }
    if (receipt.locationId || receipt.location) {
      return locationLookupMap[receipt.locationId || receipt.location] || null;
    }
    return null;
  };

  // ── Tab state ──
  const [activeTab, setActiveTab] = useState('receipts');
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [dateRangeFilter, setDateRangeFilter] = useState('all');

  // ── Pending lists (shared for summary stats + passed to tabs) ──

  const todaysPending = useMemo(
    () =>
      receipts
        .filter((receipt) =>
          STATUS_PENDING.has(receipt.status) &&
          toDateKey(receipt.submittedAt || receipt.receiptDate) === todayKey &&
          (user?.role !== 'warehouse' || (receipt.submittedBy !== currentUserId && receipt.submitted_by !== currentUserId))
        )
        .sort((a, b) => new Date(b.submittedAt || b.receiptDate || 0) - new Date(a.submittedAt || a.receiptDate || 0)),
    [receipts, todayKey, user, currentUserId],
  );

  const backlogPending = useMemo(
    () =>
      receipts
        .filter((receipt) =>
          STATUS_PENDING.has(receipt.status) &&
          toDateKey(receipt.submittedAt || receipt.receiptDate) !== todayKey &&
          (user?.role !== 'warehouse' || (receipt.submittedBy !== currentUserId && receipt.submitted_by !== currentUserId))
        )
        .sort((a, b) => new Date(a.submittedAt || a.receiptDate || 0) - new Date(b.submittedAt || b.receiptDate || 0)),
    [receipts, todayKey, user, currentUserId],
  );

  const approvedHistory = useMemo(
    () =>
      receipts
        .filter((receipt) => receipt.status === RECEIPT_STATUS.APPROVED)
        .sort((a, b) => new Date(b.approvedAt || 0) - new Date(a.approvedAt || 0))
        .slice(0, 20),
    [receipts],
  );

  const pendingTransfers = useMemo(
    () =>
      inventoryTransfers
        .filter((transfer) =>
          transfer.status === TRANSFER_STATUS.PENDING &&
          (user?.role !== 'warehouse' || (transfer.requestedBy !== currentUserId && transfer.requested_by !== currentUserId))
        )
        .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0)),
    [inventoryTransfers, user, currentUserId],
  );

  const pendingHolds = useMemo(
    () =>
      inventoryHoldActions
        .filter((hold) =>
          hold.status === HOLD_STATUS.PENDING &&
          (user?.role !== 'warehouse' || (hold.submittedBy !== currentUserId && hold.submitted_by !== currentUserId))
        )
        .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0)),
    [inventoryHoldActions, user, currentUserId],
  );

  const pendingForkliftRequests = useMemo(
    () => (forkliftRequests || []).filter((fr) => fr.status === FORKLIFT_REQUEST_STATUS.SUBMITTED),
    [forkliftRequests],
  );

  const pendingAdjustments = useMemo(
    () =>
      inventoryAdjustments
        .filter((adjustment) =>
          adjustment.status === ADJUSTMENT_STATUS.PENDING &&
          (user?.role !== 'warehouse' || (adjustment.submittedBy !== currentUserId && adjustment.submitted_by !== currentUserId))
        )
        .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0)),
    [inventoryAdjustments, user, currentUserId],
  );

  // ── Summary statistics ──

  const summaryStats = useMemo(() => {
    const todayApproved = approvedHistory.filter(r => toDateKey(r.approvedAt) === todayKey).length;
    const urgentCount = backlogPending.filter(r => getDaysAgo(r.submittedAt || r.receiptDate) >= 7).length;
    const totalPendingReceipts = todaysPending.length + backlogPending.length;
    const totalPendingItems = totalPendingReceipts + pendingTransfers.length + pendingHolds.length + pendingAdjustments.length + pendingForkliftRequests.length;
    return {
      totalPending: totalPendingItems,
      receiptsPending: totalPendingReceipts,
      transfersPending: pendingTransfers.length,
      forkliftRequestsPending: pendingForkliftRequests.length,
      holdsPending: pendingHolds.length,
      adjustmentsPending: pendingAdjustments.length,
      todayApproved,
      urgentCount,
      todayCount: todaysPending.length,
    };
  }, [todaysPending, backlogPending, approvedHistory, todayKey, pendingTransfers, pendingHolds, pendingAdjustments, pendingForkliftRequests]);

  return (
    <div className="approvals-page">
      <div className="page-header">
        <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
          ← Back to Dashboard
        </button>
      </div>

      <div className="page-content">
        {/* Summary Statistics Dashboard */}
        <div className="summary-dashboard">
          <div className="stat-card stat-card-pending">
            <div className="stat-icon">📋</div>
            <div>
              <div className="stat-value">{summaryStats.totalPending}</div>
              <div className="stat-label">Total Pending</div>
            </div>
          </div>
          <div className="stat-card stat-card-urgent" style={{ borderLeftColor: summaryStats.urgentCount > 0 ? '#ef4444' : 'transparent' }}>
            <div className="stat-icon">⚠️</div>
            <div>
              <div className="stat-value">{summaryStats.urgentCount}</div>
              <div className="stat-label">Urgent Items</div>
            </div>
          </div>
          <div className="stat-card stat-card-today">
            <div className="stat-icon">📅</div>
            <div>
              <div className="stat-value">{summaryStats.todayCount}</div>
              <div className="stat-label">From Today</div>
            </div>
          </div>
          <div className="stat-card stat-card-approved">
            <div className="stat-icon">✅</div>
            <div>
              <div className="stat-value">{summaryStats.todayApproved}</div>
              <div className="stat-label">Approved Today</div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="tabs">
          {[
            { key: 'receipts', label: 'Receipts', count: summaryStats.receiptsPending },
            { key: 'transfers', label: 'Transfers', count: summaryStats.transfersPending },
            { key: 'forklift', label: 'Forklift Requests', count: summaryStats.forkliftRequestsPending },
            { key: 'holds', label: 'Holds', count: summaryStats.holdsPending },
            { key: 'adjustments', label: 'Adjustments', count: summaryStats.adjustmentsPending },
          ].map(({ key, label, count }) => (
            <button
              key={key}
              className={`tab-button${activeTab === key ? ' active' : ''}${count > 0 ? ' has-pending' : ''}`}
              onClick={() => setActiveTab(key)}
            >
              {label} ({count})
              {count > 0 && <span className="tab-badge-dot" />}
            </button>
          ))}
        </div>

        {/* Content based on active tab */}
        {activeTab === 'receipts' && (
          <ReceiptsTab
            productLookup={productLookup}
            categoryLookup={categoryLookup}
            vendorLookup={vendorLookup}
            locationLookupMap={locationLookupMap}
            receiptLookup={receiptLookup}
            rowLookup={rowLookup}
            shiftLookup={shiftLookup}
            lineLookup={lineLookup}
            userNameMap={userNameMap}
            getFinishedGoodsLocation={getFinishedGoodsLocation}
            todaysPending={todaysPending}
            backlogPending={backlogPending}
            approvedHistory={approvedHistory}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            categoryFilter={categoryFilter}
            setCategoryFilter={setCategoryFilter}
            dateRangeFilter={dateRangeFilter}
            setDateRangeFilter={setDateRangeFilter}
          />
        )}

        {activeTab === 'transfers' && (
          <section className="panel">
            <div className="panel-header">
              <h2>Pending Transfers</h2>
              <p className="muted">{pendingTransfers.length} transfer{pendingTransfers.length === 1 ? '' : 's'} awaiting approval</p>
            </div>
            <TransfersTab
              pendingTransfers={pendingTransfers}
              receiptLookup={receiptLookup}
              productLookup={productLookup}
              rowLookup={rowLookup}
              locationLookupMap={locationLookupMap}
              userNameMap={userNameMap}
            />
          </section>
        )}

        {activeTab === 'forklift' && (
          <section className="panel">
            <div className="panel-header">
              <h2>Forklift Requests</h2>
              <p className="muted">{pendingForkliftRequests.length} request{pendingForkliftRequests.length === 1 ? '' : 's'} awaiting approval</p>
            </div>
            <ForkliftTab
              pendingForkliftRequests={pendingForkliftRequests}
              productLookup={productLookup}
              rowLookup={rowLookup}
              lineLookup={lineLookup}
              userNameMap={userNameMap}
            />
          </section>
        )}

        {activeTab === 'holds' && (
          <section className="panel">
            <div className="panel-header">
              <h2>Pending Hold Requests</h2>
              <p className="muted">{pendingHolds.length} hold request{pendingHolds.length === 1 ? '' : 's'} awaiting approval</p>
            </div>
            <HoldsTab
              pendingHolds={pendingHolds}
              receiptLookup={receiptLookup}
              productLookup={productLookup}
              categoryLookup={categoryLookup}
              locationLookupMap={locationLookupMap}
              userNameMap={userNameMap}
            />
          </section>
        )}

        {activeTab === 'adjustments' && (
          <section className="panel">
            <div className="panel-header">
              <h2>Pending Adjustments</h2>
              <p className="muted">{pendingAdjustments.length} adjustment{pendingAdjustments.length === 1 ? '' : 's'} awaiting approval</p>
            </div>
            <AdjustmentsTab
              pendingAdjustments={pendingAdjustments}
              receiptLookup={receiptLookup}
              productLookup={productLookup}
              categoryLookup={categoryLookup}
              userNameMap={userNameMap}
            />
          </section>
        )}
      </div>
    </div>
  );
};

export default ApprovalsPage;
