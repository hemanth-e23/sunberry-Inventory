import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppData } from "../context/AppDataContext";
import { useAuth } from "../context/AuthContext";
import { getDashboardPath } from "../App";
import { formatDateTime, formatTimeAgo, getDaysAgo, toDateKey, getTodayDateKey } from "../utils/dateUtils";
import axios from "axios";
import "./ApprovalsPage.css";
import "./ApprovalsPageEnhanced.css";

const API_BASE_URL = `http://${window.location.hostname}:8000/api`;

const STATUS_PENDING = new Set(["recorded", "reviewed"]);

// Remove duplicate date utility functions - now imported from utils
const getPriorityLevel = (days) => {
  if (days === 0) return { level: 'low', label: 'New', color: '#10b981' };
  if (days < 3) return { level: 'low', label: 'Recent', color: '#10b981' };
  if (days < 7) return { level: 'medium', label: 'Moderate', color: '#f59e0b' };
  return { level: 'high', label: 'Urgent', color: '#ef4444' };
};

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
    approveReceipt,
    rejectReceipt,
    sendBackReceipt,
    updateReceipt,
    updateReceiptStatus,
    inventoryTransfers,
    approveTransfer,
    rejectTransfer,
    inventoryHoldActions,
    approveHoldAction,
    rejectHoldAction,
    inventoryAdjustments,
    approveAdjustment,
    rejectAdjustment,
    users,
  } = useAppData();

  const todayKey = useMemo(() => getTodayDateKey(), []);

  const productLookup = useMemo(() => {
    const map = {};
    if (products && Array.isArray(products)) {
      products.forEach((product) => {
        map[product.id] = product;
      });
    }
    return map;
  }, [products]);

  const categoryLookup = useMemo(() => {
    const map = {};
    if (productCategories && Array.isArray(productCategories)) {
      productCategories.forEach((category) => {
        map[category.id] = category;
      });
    }
    return map;
  }, [productCategories]);

  const vendorLookup = useMemo(() => {
    const map = {};
    if (vendors && Array.isArray(vendors)) {
      vendors.forEach((vendor) => {
        map[vendor.id] = vendor.name;
      });
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

  // Row lookup: get row name from storageRowId
  const [rowNameCache, setRowNameCache] = useState({});
  const rowLookup = useMemo(() => {
    const map = { ...rowNameCache }; // Start with cached names
    // Check all locations and their sub-locations for rows
    if (locations && Array.isArray(locations)) {
      locations.forEach((location) => {
        location.subLocations?.forEach((subLoc) => {
          subLoc.rows?.forEach((row) => {
            if (row.id && row.name) {
              map[row.id] = row.name;
            }
          });
        });
      });
    }
    // Also check subLocationMap (flat structure)
    if (subLocationMap && typeof subLocationMap === 'object') {
      Object.values(subLocationMap).forEach((subLocs) => {
        if (Array.isArray(subLocs)) {
          subLocs.forEach((subLoc) => {
            subLoc.rows?.forEach((row) => {
              if (row.id && row.name) {
                map[row.id] = row.name;
              }
            });
          });
        }
      });
    }
    // Also check subLocationsUnifiedMap
    if (subLocationsUnifiedMap && typeof subLocationsUnifiedMap === 'object') {
      Object.values(subLocationsUnifiedMap).forEach((subLocs) => {
        if (Array.isArray(subLocs)) {
          subLocs.forEach((subLoc) => {
            subLoc.rows?.forEach((row) => {
              if (row.id && row.name) {
                map[row.id] = row.name;
              }
            });
          });
        }
      });
    }
    // Also check storage areas (for finished goods)
    if (storageAreas && Array.isArray(storageAreas)) {
      storageAreas.forEach((area) => {
        area.rows?.forEach((row) => {
          if (row.id && row.name) {
            map[row.id] = row.name;
          }
        });
      });
    }
    return map;
  }, [locations, subLocationMap, subLocationsUnifiedMap, storageAreas, rowNameCache]);

  // Helper function to fetch row name from backend if not in lookup
  const fetchRowName = async (rowId) => {
    if (!rowId || rowNameCache[rowId]) return rowNameCache[rowId];
    
    try {
      const token = localStorage.getItem('token');
      if (!token) return null;
      
      const response = await axios.get(`${API_BASE_URL}/master-data/storage-rows/${rowId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      if (response.data?.name) {
        setRowNameCache(prev => ({ ...prev, [rowId]: response.data.name }));
        return response.data.name;
      }
    } catch (error) {
      console.warn(`Failed to fetch row name for ${rowId}:`, error);
    }
    return null;
  };

  // Pre-fetch row names for receipts that have storageRowId but no name in lookup
  useEffect(() => {
    const missingRowIds = new Set();
    
    // Check all receipts for missing row names
    receipts.forEach(receipt => {
      if (receipt.storageRowId || receipt.storage_row_id) {
        const rowId = receipt.storageRowId || receipt.storage_row_id;
        if (rowId && !rowLookup[rowId] && !rowNameCache[rowId]) {
          missingRowIds.add(rowId);
        }
      }
      // Also check rawMaterialRowAllocations
      if (receipt.rawMaterialRowAllocations && Array.isArray(receipt.rawMaterialRowAllocations)) {
        receipt.rawMaterialRowAllocations.forEach(alloc => {
          if (alloc.rowId && !rowLookup[alloc.rowId] && !rowNameCache[alloc.rowId]) {
            missingRowIds.add(alloc.rowId);
          }
        });
      }
    });
    
    // Fetch all missing row names
    if (missingRowIds.size > 0) {
      missingRowIds.forEach(rowId => {
        fetchRowName(rowId);
      });
    }
  }, [receipts, rowLookup, rowNameCache]);

  const userLookup = useMemo(() => {
    const map = {};
    if (users && Array.isArray(users)) {
      users.forEach((user) => {
        const label = user.name || user.username;
        map[user.id] = label;
        map[user.username] = label;
      });
    }
    return map;
  }, [users]);

  const shiftLookup = useMemo(() => {
    const map = {};
    if (productionShifts && Array.isArray(productionShifts)) {
      productionShifts.forEach((shift) => {
        map[shift.id] = shift.name;
      });
    }
    return map;
  }, [productionShifts]);

  const lineLookup = useMemo(() => {
    const map = {};
    if (productionLines && Array.isArray(productionLines)) {
      productionLines.forEach((line) => {
        map[line.id] = line.name;
      });
    }
    return map;
  }, [productionLines]);

  const storageAreaLookup = useMemo(() => {
    const map = {};
    if (storageAreas && Array.isArray(storageAreas)) {
      storageAreas.forEach((area) => {
        map[area.id] = area;
      });
    }
    return map;
  }, [storageAreas]);

  // Helper to get location display for finished goods receipts
  // Format: "FG: AA (10 pallets), AB (15 pallets)"
  const getFinishedGoodsLocation = (receipt) => {
    // For finished goods, check allocations to get storage area/row names with pallet counts
    // Check both allocation.plan and pendingAllocation.plan for compatibility
    const plan = receipt.allocation?.plan || receipt.pendingAllocation?.plan || [];

    if (plan && plan.length > 0) {
      // Group by storage area name
      const areaGroups = {};
      plan.forEach((item) => {
        if (item.areaName) {
          if (!areaGroups[item.areaName]) {
            areaGroups[item.areaName] = [];
          }
          if (item.rowName && item.pallets) {
            areaGroups[item.areaName].push({
              rowName: item.rowName,
              pallets: item.pallets
            });
          }
        }
      });

      // Format as "FG: AA (10 pallets), AB (15 pallets)"
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

      if (formatted.length > 0) {
        return formatted.join('; '); // In case there are multiple areas
      }
    }

    // Fallback: check if there's a sub-location
    if (receipt.subLocationId || receipt.subLocation) {
      return locationLookupMap[receipt.subLocationId || receipt.subLocation] || null;
    }

    // Fallback to main location (but shouldn't show Sunberry for finished goods)
    if (receipt.locationId || receipt.location) {
      return locationLookupMap[receipt.locationId || receipt.location] || null;
    }

    return null;
  };

  // State declarations
  const [activeTab, setActiveTab] = useState('receipts');
  const [selectedReceiptId, setSelectedReceiptId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [changeSummary, setChangeSummary] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [dateRangeFilter, setDateRangeFilter] = useState('all');
  const [expandedHistoryId, setExpandedHistoryId] = useState(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [sendBackReason, setSendBackReason] = useState('');
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [showSendBackModal, setShowSendBackModal] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const [isSendingBack, setIsSendingBack] = useState(false);

  const todaysPending = useMemo(
    () =>
      receipts
        .filter((receipt) =>
          STATUS_PENDING.has(receipt.status) &&
          toDateKey(receipt.submittedAt || receipt.receiptDate) === todayKey &&
          // Warehouse workers can only see receipts submitted by others
          (user?.role !== 'warehouse' || (receipt.submittedBy !== currentUserId && receipt.submitted_by !== currentUserId))
        )
        .sort(
          (a, b) =>
            new Date(b.submittedAt || b.receiptDate || 0) -
            new Date(a.submittedAt || a.receiptDate || 0),
        ),
    [receipts, todayKey, user, currentUserId],
  );

  const backlogPending = useMemo(
    () =>
      receipts
        .filter((receipt) =>
          STATUS_PENDING.has(receipt.status) &&
          toDateKey(receipt.submittedAt || receipt.receiptDate) !== todayKey &&
          // Warehouse workers can only see receipts submitted by others
          (user?.role !== 'warehouse' || (receipt.submittedBy !== currentUserId && receipt.submitted_by !== currentUserId))
        )
        .sort(
          (a, b) =>
            new Date(a.submittedAt || a.receiptDate || 0) -
            new Date(b.submittedAt || b.receiptDate || 0),
        ),
    [receipts, todayKey, user, currentUserId],
  );

  const approvedHistory = useMemo(
    () =>
      receipts
        .filter((receipt) => receipt.status === "approved")
        .sort(
          (a, b) =>
            new Date(b.approvedAt || 0) - new Date(a.approvedAt || 0),
        )
        .slice(0, 20),
    [receipts],
  );

  // Pending transfers, holds, and adjustments
  // Warehouse workers can only see items submitted by others
  const pendingTransfers = useMemo(
    () =>
      inventoryTransfers
        .filter((transfer) => 
          transfer.status === "pending" &&
          (user?.role !== 'warehouse' || (transfer.requestedBy !== currentUserId && transfer.requested_by !== currentUserId))
        )
        .sort(
          (a, b) =>
            new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0),
        ),
    [inventoryTransfers, user, currentUserId],
  );

  const pendingHolds = useMemo(
    () =>
      inventoryHoldActions
        .filter((hold) => 
          hold.status === "pending" &&
          (user?.role !== 'warehouse' || (hold.submittedBy !== currentUserId && hold.submitted_by !== currentUserId))
        )
        .sort(
          (a, b) =>
            new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0),
        ),
    [inventoryHoldActions, user, currentUserId],
  );

  const pendingAdjustments = useMemo(
    () =>
      inventoryAdjustments
        .filter((adjustment) => 
          adjustment.status === "pending" &&
          (user?.role !== 'warehouse' || (adjustment.submittedBy !== currentUserId && adjustment.submitted_by !== currentUserId))
        )
        .sort(
          (a, b) =>
            new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0),
        ),
    [inventoryAdjustments, user, currentUserId],
  );

  // Summary statistics
  const summaryStats = useMemo(() => {
    const todayApproved = approvedHistory.filter(r => {
      const approvedDate = r.approvedAt ? new Date(r.approvedAt).toISOString().slice(0, 10) : null;
      return approvedDate === todayKey;
    }).length;

    const urgentCount = backlogPending.filter(r => getDaysAgo(r.submittedAt || r.receiptDate) >= 7).length;

    const totalPendingReceipts = todaysPending.length + backlogPending.length;
    const totalPendingItems = totalPendingReceipts + pendingTransfers.length + pendingHolds.length + pendingAdjustments.length;

    return {
      totalPending: totalPendingItems,
      receiptsPending: totalPendingReceipts,
      transfersPending: pendingTransfers.length,
      holdsPending: pendingHolds.length,
      adjustmentsPending: pendingAdjustments.length,
      todayApproved,
      urgentCount,
      todayCount: todaysPending.length,
    };
  }, [todaysPending, backlogPending, approvedHistory, todayKey, pendingTransfers, pendingHolds, pendingAdjustments]);

  // Filtered lists
  const filteredTodaysPending = useMemo(() => {
    return todaysPending.filter(receipt => {
      const product = productLookup[receipt.productId];
      const category = categoryLookup[receipt.categoryId];

      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesName = product?.name?.toLowerCase().includes(query);
        const matchesLot = receipt.lotNo?.toLowerCase().includes(query);
        const matchesSID = receipt.sid?.toLowerCase().includes(query);
        if (!matchesName && !matchesLot && !matchesSID) return false;
      }

      // Category filter
      if (categoryFilter && receipt.categoryId !== categoryFilter) return false;

      return true;
    });
  }, [todaysPending, searchQuery, categoryFilter, productLookup, categoryLookup]);

  const filteredBacklogPending = useMemo(() => {
    return backlogPending.filter(receipt => {
      const product = productLookup[receipt.productId];
      const category = categoryLookup[receipt.categoryId];

      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesName = product?.name?.toLowerCase().includes(query);
        const matchesLot = receipt.lotNo?.toLowerCase().includes(query);
        const matchesSID = receipt.sid?.toLowerCase().includes(query);
        if (!matchesName && !matchesLot && !matchesSID) return false;
      }

      // Category filter
      if (categoryFilter && receipt.categoryId !== categoryFilter) return false;

      // Date range filter
      if (dateRangeFilter !== 'all') {
        const days = getDaysAgo(receipt.submittedAt || receipt.receiptDate);
        if (dateRangeFilter === 'week' && days > 7) return false;
        if (dateRangeFilter === 'month' && days > 30) return false;
      }

      return true;
    });
  }, [backlogPending, searchQuery, categoryFilter, dateRangeFilter, productLookup, categoryLookup]);

  const selectedReceipt = useMemo(
    () => receipts.find((receipt) => receipt.id === selectedReceiptId) || null,
    [receipts, selectedReceiptId],
  );

  useEffect(() => {
    if (!selectedReceipt) {
      setDraft(null);
      return;
    }
    const { quantityTouched, ...rest } = selectedReceipt;
    const product = productLookup[selectedReceipt.productId];
    const category = categoryLookup[selectedReceipt.categoryId];
    const isFinishedGoods = category?.parentId === 'group-finished';

    // Get location values from receipt - prioritize locationId/subLocationId
    const receiptLocationId = selectedReceipt.locationId || selectedReceipt.location || rest.locationId || rest.location || '';
    const receiptSubLocationId = selectedReceipt.subLocationId || selectedReceipt.subLocation || rest.subLocationId || rest.subLocation || '';

    setDraft({
      ...rest,
      quantityTouched: false,
      // Ensure location fields are properly set - auto-populate from receipt
      location: receiptLocationId,
      locationId: receiptLocationId,
      subLocation: receiptSubLocationId,
      subLocationId: receiptSubLocationId,
      // Auto-populate SID from product (always use product SID if available)
      sid: product?.sid || rest.sid || selectedReceipt.sid || '',
      // Ensure shift and line are set correctly (they should be IDs)
      shift: rest.shift || selectedReceipt.shift || '',
      lineNumber: rest.lineNumber || selectedReceipt.lineNumber || '',
    });
  }, [selectedReceipt, productLookup, categoryLookup]);

  const closeDetail = () => {
    setSelectedReceiptId(null);
    setDraft(null);
    setChangeSummary([]);
    setShowConfirm(false);
  };

  const handleOpenReceipt = (receiptId) => {
    setSelectedReceiptId(receiptId);
  };

  const handleDraftChange = (field, value) => {
    setDraft((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const applyDraftUpdates = (receipt, nextDraft) => {
    if (!receipt || !nextDraft) return [];

    const fieldLabels = {
      receiptDate: "Receipt Date",
      lotNo: "Lot Number",
      quantity: "Quantity",
      quantityUnits: "Quantity Units",
      expiration: "Expiration",
      sid: "SID",
      vendorId: "Vendor",
      brix: "Brix",
      note: "Notes",
      productionDate: "Production Date",
      fccCode: "FCC Code",
      shift: "Shift",
      lineNumber: "Line",
      location: "Location",
      subLocation: "Sub Location",
      hold: "Hold",
      bol: "BOL",
      purchaseOrder: "Purchase Order",
    };

    const category = categoryLookup[receipt.categoryId];
    const summary = [];

    Object.entries(fieldLabels).forEach(([field, label]) => {
      const original = receipt[field];
      const updated = nextDraft[field];
      const normalizedOriginal =
        typeof original === "boolean" ? original : original ?? "";
      const normalizedUpdated =
        typeof updated === "boolean" ? updated : updated ?? "";

      if (normalizedOriginal === normalizedUpdated) return;

      // SID should already be populated on receipt from product, so if they match, no change
      // This check is just a safety net in case receipt.sid wasn't populated
      if (field === "sid") {
        const productSID = productLookup[receipt.productId]?.sid || "";
        // If both original and updated match product SID, it's not a change
        if (original === productSID && updated === productSID) {
          return;
        }
        // If original is empty/null and updated matches product SID, it's just initialization, not a change
        if ((!original || original === "") && updated === productSID) {
          return;
        }
      }

      if (category?.type !== "finished" &&
        ["productionDate", "fccCode", "shift", "lineNumber", "hold"].includes(field)) {
        return;
      }
      if (category?.type !== "raw" || category?.subType !== "ingredient") {
        if (["vendorId", "brix", "sid"].includes(field)) return;
      }
      if (category?.type !== "raw" || category?.subType !== "packaging") {
        if (field === "note" && receipt.categoryId !== field) {
          // packaging specific note already handled, keep generic
        }
      }

      summary.push({
        field,
        label,
        before: original,
        after: updated,
      });
    });

    return summary;
  };

  const handleApproveRequest = () => {
    if (!selectedReceipt || !draft) return;
    const summary = applyDraftUpdates(selectedReceipt, draft);
    if (summary.length === 0) {
      finalizeApprove();
    } else {
      setChangeSummary(summary);
      setShowConfirm(true);
    }
  };

  const finalizeApprove = async () => {
    if (!selectedReceipt || !draft) return;
    setIsApproving(true);
    try {
      const summary = applyDraftUpdates(selectedReceipt, draft);
      if (summary.length > 0) {
        const updates = summary.reduce((acc, item) => {
          acc[item.field] = draft[item.field];
          return acc;
        }, {});
        await updateReceipt(selectedReceipt.id, updates);
      }
      const result = await approveReceipt(selectedReceipt.id, "supervisor-01");
      if (!result.success) {
        alert(result.message || 'Failed to approve receipt');
        setIsApproving(false);
        return;
      }
      closeDetail();
    } catch (error) {
      console.error('Error approving receipt:', error);
      alert('Failed to approve receipt. Please try again.');
    } finally {
      setIsApproving(false);
    }
  };

  const handleSendBack = async () => {
    if (!selectedReceipt) return;
    if (!sendBackReason.trim()) {
      alert('Please provide a reason for sending back.');
      return;
    }
    setIsSendingBack(true);
    try {
      const result = await sendBackReceipt(selectedReceipt.id, sendBackReason, "supervisor-01");
      if (!result.success) {
        alert(result.message || 'Failed to send back receipt');
        setIsSendingBack(false);
        return;
      }
      setSendBackReason('');
      setShowSendBackModal(false);
      closeDetail();
    } catch (error) {
      console.error('Error sending back receipt:', error);
      alert('Failed to send back receipt. Please try again.');
    } finally {
      setIsSendingBack(false);
    }
  };

  const handleReject = async () => {
    if (!selectedReceipt) return;
    if (!rejectionReason.trim()) {
      alert('Please provide a reason for rejection.');
      return;
    }
    setIsRejecting(true);
    try {
      const result = await rejectReceipt(selectedReceipt.id, rejectionReason, "supervisor-01");
      if (!result.success) {
        alert(result.message || 'Failed to reject receipt');
        setIsRejecting(false);
        return;
      }
      setRejectionReason('');
      setShowRejectModal(false);
      closeDetail();
    } catch (error) {
      console.error('Error rejecting receipt:', error);
      alert('Failed to reject receipt. Please try again.');
    } finally {
      setIsRejecting(false);
    }
  };

  const approveAllToday = async () => {
    if (todaysPending.length === 0) return;
    const confirmMessage = `Approve ${todaysPending.length} receipt${todaysPending.length > 1 ? "s" : ""} from today?`;
    if (!window.confirm(confirmMessage)) return;

    try {
      const results = await Promise.all(
        todaysPending.map((receipt) => approveReceipt(receipt.id, "supervisor-01"))
      );
      const failed = results.filter(r => !r.success);
      if (failed.length > 0) {
        alert(`Failed to approve ${failed.length} receipt(s). Please try again.`);
      }
    } catch (error) {
      console.error('Error approving receipts:', error);
      alert('Error approving receipts. Please try again.');
    }
  };

  const renderCard = (receipt) => {
    const product = productLookup[receipt.productId];
    const category = categoryLookup[receipt.categoryId];
    const statusLabel = receipt.status === "reviewed" ? "Reviewed" : "Pending";
    const days = getDaysAgo(receipt.submittedAt || receipt.receiptDate);
    const priority = getPriorityLevel(days);
    const timeAgo = formatTimeAgo(receipt.submittedAt || receipt.receiptDate);

    return (
      <article key={receipt.id} className="approval-card">
        <header>
          <div>
            <h3>{product?.name || "Unknown Product"}</h3>
            <span className="badge">{category?.name || "Uncategorized"}</span>
          </div>
          <div className="meta">
            <span className="priority-badge" style={{ background: priority.color, color: 'white' }}>
              {priority.label}
            </span>
            <span className="timestamp">
              {timeAgo}
            </span>
          </div>
        </header>
        <dl className="summary-grid">
          <div>
            <dt>Quantity</dt>
            <dd>
              {receipt.quantity} {receipt.quantityUnits}
            </dd>
          </div>
          <div>
            <dt>Lot</dt>
            <dd>{receipt.lotNo || "—"}</dd>
          </div>
          <div>
            <dt>Expiration</dt>
            <dd>{receipt.expiration || "—"}</dd>
          </div>
          <div>
            <dt>SID</dt>
            <dd>{product?.sid || receipt.sid || "—"}</dd>
          </div>
          {/* Vendor, BOL, and Purchase Order only for raw materials, not finished goods */}
          {category?.parentId !== 'group-finished' && (
            <>
              <div>
                <dt>Vendor</dt>
                <dd>{receipt.vendorId ? vendors.find(v => v.id === receipt.vendorId)?.name || receipt.vendorId : "—"}</dd>
              </div>
              <div>
                <dt>BOL</dt>
                <dd>{receipt.bol || "—"}</dd>
              </div>
              <div>
                <dt>Purchase Order</dt>
                <dd>{receipt.purchaseOrder || "—"}</dd>
              </div>
            </>
          )}
          {/* Shift and Line for finished goods */}
          {category?.parentId === 'group-finished' && (
            <>
              <div>
                <dt>Shift</dt>
                <dd>{receipt.shift ? (shiftLookup[receipt.shift] || receipt.shift) : "—"}</dd>
              </div>
              <div>
                <dt>Line</dt>
                <dd>{receipt.lineNumber ? (lineLookup[receipt.lineNumber] || receipt.lineNumber) : "—"}</dd>
              </div>
            </>
          )}
          <div>
            <dt>Location</dt>
            <dd>
              {(() => {
                // For finished goods, always use allocation-based display
                if (category?.parentId === 'group-finished') {
                  const location = getFinishedGoodsLocation(receipt);
                  return location || "—";
                }
                // For raw materials/packaging, show sub-location with row if available
                let locationLabel = "—";
                if (receipt.subLocationId || receipt.subLocation) {
                  locationLabel = locationLookupMap[receipt.subLocationId || receipt.subLocation] || "—";
                } else if (receipt.locationId || receipt.location) {
                  locationLabel = locationLookupMap[receipt.locationId || receipt.location] || "—";
                }
                
                // Add row information if available
                const rowInfo = [];
                
                // Check for multiple row allocations (rawMaterialRowAllocations)
                if (receipt.rawMaterialRowAllocations && Array.isArray(receipt.rawMaterialRowAllocations)) {
                  receipt.rawMaterialRowAllocations.forEach(alloc => {
                    const rowName = rowLookup[alloc.rowId] || alloc.rowName || alloc.rowId;
                    const pallets = alloc.pallets || 0;
                    if (rowName) {
                      rowInfo.push(`${rowName} (${pallets} pallets)`);
                    }
                  });
                }
                // Check for single row (storageRowId)
                else if (receipt.storageRowId || receipt.storage_row_id) {
                  const rowId = receipt.storageRowId || receipt.storage_row_id;
                  let rowName = rowLookup[rowId];
                  const pallets = receipt.pallets || 0;
                  
                  // If not found in lookup, try to fetch from backend (async, will update on next render)
                  if (!rowName) {
                    fetchRowName(rowId).then(name => {
                      if (name) {
                        setRowNameCache(prev => ({ ...prev, [rowId]: name }));
                      }
                    });
                    // For now, show ID but it will update when fetch completes
                    rowInfo.push(`${rowId}${pallets > 0 ? ` (${pallets} pallets)` : ''}`);
                  } else {
                    rowInfo.push(`${rowName}${pallets > 0 ? ` (${pallets} pallets)` : ''}`);
                  }
                }
                
                if (rowInfo.length > 0) {
                  return `${locationLabel} — Row${rowInfo.length > 1 ? 's' : ''}: ${rowInfo.join(', ')}`;
                }
                
                return locationLabel;
              })()}
            </dd>
          </div>
        </dl>
        <footer>
          <button
            type="button"
            className="secondary-button"
            onClick={() => handleOpenReceipt(receipt.id)}
          >
            Review & Approve
          </button>
        </footer>
      </article>
    );
  };

  const renderBacklogCard = (receipt) => {
    const product = productLookup[receipt.productId];
    const category = categoryLookup[receipt.categoryId];
    const days = getDaysAgo(receipt.submittedAt || receipt.receiptDate);
    const priority = getPriorityLevel(days);
    const timeAgo = formatTimeAgo(receipt.submittedAt || receipt.receiptDate);

    return (
      <article key={receipt.id} className="approval-card backlog" style={{
        borderLeftColor: priority.color,
        borderLeftWidth: '4px',
        borderLeftStyle: 'solid'
      }}>
        <header>
          <div>
            <h3>{product?.name || "Unknown Product"}</h3>
            <span className="badge">{category?.name || "Uncategorized"}</span>
          </div>
          <div className="meta">
            <span className="priority-badge" style={{ background: priority.color, color: 'white' }}>
              {priority.label} · {days} days
            </span>
            <span className="timestamp">
              {timeAgo}
            </span>
          </div>
        </header>
        <p className="muted small">
          Awaiting approval since {formatDateTime(receipt.submittedAt || receipt.receiptDate)}
        </p>
        <footer>
          <button
            type="button"
            className="secondary-button"
            onClick={() => handleOpenReceipt(receipt.id)}
          >
            Review
          </button>
        </footer>
      </article>
    );
  };

  const renderHistoryRow = (receipt) => {
    const product = productLookup[receipt.productId];
    const category = categoryLookup[receipt.categoryId];
    const isExpanded = expandedHistoryId === receipt.id;

    return (
      <React.Fragment key={receipt.id}>
        <tr onClick={() => setExpandedHistoryId(isExpanded ? null : receipt.id)} style={{ cursor: 'pointer' }}>
          <td>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '12px' }}>{isExpanded ? '▼' : '▶'}</span>
              <span>{product?.name || "Unknown"}</span>
            </div>
          </td>
          <td>{category?.name || "—"}</td>
          <td>{receipt.quantity} {receipt.quantityUnits}</td>
          <td>{receipt.lotNo || "—"}</td>
          <td>{formatDateTime(receipt.approvedAt)}</td>
        </tr>
        {isExpanded && (
          <tr className="expanded-details">
            <td colSpan="5" style={{ padding: '16px', background: '#f8fafc' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
                <div>
                  <strong style={{ fontSize: '12px', color: '#64748b' }}>EXPIRATION</strong>
                  <p style={{ margin: '4px 0 0', fontWeight: 500 }}>{receipt.expiration || "—"}</p>
                </div>
                <div>
                  <strong style={{ fontSize: '12px', color: '#64748b' }}>SID</strong>
                  <p style={{ margin: '4px 0 0', fontWeight: 500 }}>{productLookup[receipt.productId]?.sid || receipt.sid || "—"}</p>
                </div>
                <div>
                  <strong style={{ fontSize: '12px', color: '#64748b' }}>LOCATION</strong>
                  <p style={{ margin: '4px 0 0', fontWeight: 500 }}>
                    {category?.parentId === 'group-finished' ? (
                      // For finished goods, show storage area/row name from allocations
                      getFinishedGoodsLocation(receipt) || "—"
                    ) : receipt.subLocationId || receipt.subLocation ? (
                      // For raw materials, if sub-location exists, show it (it's more specific)
                      locationLookupMap[receipt.subLocationId || receipt.subLocation] || "—"
                    ) : receipt.locationId || receipt.location ? (
                      // Otherwise show main location
                      locationLookupMap[receipt.locationId || receipt.location] || "—"
                    ) : "—"}
                  </p>
                </div>
                {/* Vendor, BOL, and Purchase Order only for raw materials, not finished goods */}
                {category?.parentId !== 'group-finished' && (
                  <>
                    <div>
                      <strong style={{ fontSize: '12px', color: '#64748b' }}>VENDOR</strong>
                      <p style={{ margin: '4px 0 0', fontWeight: 500 }}>
                        {receipt.vendorId ? vendors.find(v => v.id === receipt.vendorId)?.name || receipt.vendorId : "—"}
                      </p>
                    </div>
                    <div>
                      <strong style={{ fontSize: '12px', color: '#64748b' }}>BOL</strong>
                      <p style={{ margin: '4px 0 0', fontWeight: 500 }}>{receipt.bol || "—"}</p>
                    </div>
                    <div>
                      <strong style={{ fontSize: '12px', color: '#64748b' }}>PURCHASE ORDER</strong>
                      <p style={{ margin: '4px 0 0', fontWeight: 500 }}>{receipt.purchaseOrder || "—"}</p>
                    </div>
                  </>
                )}
                {/* Shift and Line for finished goods */}
                {category?.parentId === 'group-finished' && (
                  <>
                    <div>
                      <strong style={{ fontSize: '12px', color: '#64748b' }}>SHIFT</strong>
                      <p style={{ margin: '4px 0 0', fontWeight: 500 }}>{receipt.shift ? (shiftLookup[receipt.shift] || receipt.shift) : "—"}</p>
                    </div>
                    <div>
                      <strong style={{ fontSize: '12px', color: '#64748b' }}>LINE</strong>
                      <p style={{ margin: '4px 0 0', fontWeight: 500 }}>{receipt.lineNumber ? (lineLookup[receipt.lineNumber] || receipt.lineNumber) : "—"}</p>
                    </div>
                  </>
                )}
                {receipt.note && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <strong style={{ fontSize: '12px', color: '#64748b' }}>NOTES</strong>
                    <p style={{ margin: '4px 0 0', fontWeight: 500, whiteSpace: 'pre-wrap' }}>{receipt.note}</p>
                  </div>
                )}
              </div>
            </td>
          </tr>
        )}
      </React.Fragment>
    );
  };

  const isEditable = selectedReceipt && STATUS_PENDING.has(selectedReceipt.status);

  const category = selectedReceipt ? categoryLookup[selectedReceipt.categoryId] : null;
  const isIngredient = category?.type === "raw" && category?.subType === "ingredient";
  const isPackaging = category?.type === "raw" && category?.subType === "packaging";
  const isFinished = category?.type === "finished";

  // Render functions for other tabs
  const renderTransfersTab = () => {
    if (pendingTransfers.length === 0) {
      return (
        <div className="empty-state" style={{ padding: '48px', textAlign: 'center' }}>
          <p>No pending transfers.</p>
        </div>
      );
    }

    return (
      <div className="card-grid">
        {pendingTransfers.map((transfer) => {
          const receipt = receipts.find(r => r.id === transfer.receiptId);
          const product = productLookup[receipt?.productId];
          const days = getDaysAgo(transfer.submittedAt);
          const priority = getPriorityLevel(days);

          return (
            <article key={transfer.id} className="approval-card">
              <header>
                <div>
                  <h3>{product?.name || "Unknown Product"}</h3>
                  <span className="badge">{transfer.transferType === 'shipped-out' ? 'Shipped Out' : (transfer.reason || 'Transfer')}</span>
                </div>
                <div className="meta">
                  <span className="priority-badge" style={{ background: priority.color, color: 'white' }}>
                    {priority.label}
                  </span>
                </div>
              </header>
              <dl className="summary-grid">
                <div>
                  <dt>Quantity</dt>
                  <dd>{transfer.quantity} cases</dd>
                </div>
                {transfer.transferType === 'shipped-out' && transfer.orderNumber && (
                  <div>
                    <dt>Order Number</dt>
                    <dd>{transfer.orderNumber}</dd>
                  </div>
                )}
                {transfer.transferType !== 'shipped-out' && (
                  <>
                    <div>
                      <dt>From</dt>
                      <dd>{locationLookupMap[transfer.fromLocation] || transfer.fromLocation}</dd>
                    </div>
                    <div>
                      <dt>To</dt>
                      <dd>{locationLookupMap[transfer.toLocation] || transfer.toLocation}</dd>
                    </div>
                  </>
                )}
                <div>
                  <dt>Submitted</dt>
                  <dd>{formatTimeAgo(transfer.submittedAt)}</dd>
                </div>
              </dl>
              <footer>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    if (window.confirm('Approve this transfer?')) {
                      approveTransfer(transfer.id, user?.id || user?.username);
                    }
                  }}
                  style={{ marginRight: '8px' }}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="secondary-button danger"
                  onClick={() => {
                    const reason = window.prompt('Reason for rejection:');
                    if (reason) {
                      rejectTransfer(transfer.id, user?.id || user?.username);
                    }
                  }}
                >
                  Reject
                </button>
              </footer>
            </article>
          );
        })}
      </div>
    );
  };

  const renderHoldsTab = () => {
    if (pendingHolds.length === 0) {
      return (
        <div className="empty-state" style={{ padding: '48px', textAlign: 'center' }}>
          <p>No pending hold requests.</p>
        </div>
      );
    }

    return (
      <div className="card-grid">
        {pendingHolds.map((hold) => {
          const receipt = receipts.find(r => r.id === hold.receiptId);
          const product = productLookup[receipt?.productId];
          const days = getDaysAgo(hold.submittedAt);
          const priority = getPriorityLevel(days);

          return (
            <article key={hold.id} className="approval-card">
              <header>
                <div>
                  <h3>{product?.name || "Unknown Product"}</h3>
                  <span className="badge">{hold.action === 'hold' ? 'Place on Hold' : 'Release Hold'}</span>
                </div>
                <div className="meta">
                  <span className="priority-badge" style={{ background: priority.color, color: 'white' }}>
                    {priority.label}
                  </span>
                </div>
              </header>
              <dl className="summary-grid">
                <div>
                  <dt>Lot</dt>
                  <dd>{receipt?.lotNo || '—'}</dd>
                </div>
                <div>
                  <dt>Reason</dt>
                  <dd>{hold.reason || '—'}</dd>
                </div>
                <div>
                  <dt>Submitted</dt>
                  <dd>{formatTimeAgo(hold.submittedAt)}</dd>
                </div>
                <div>
                  <dt>By</dt>
                  <dd>{userLookup[hold.submittedBy] || hold.submittedBy}</dd>
                </div>
              </dl>
              <footer>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    if (window.confirm(`Approve ${hold.action === 'hold' ? 'placing on hold' : 'releasing from hold'}?`)) {
                      approveHoldAction(hold.id, user?.id || user?.username);
                    }
                  }}
                  style={{ marginRight: '8px' }}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="secondary-button danger"
                  onClick={() => {
                    if (window.confirm('Reject this hold request?')) {
                      rejectHoldAction(hold.id, user?.id || user?.username);
                    }
                  }}
                >
                  Reject
                </button>
              </footer>
            </article>
          );
        })}
      </div>
    );
  };

  const renderAdjustmentsTab = () => {
    if (pendingAdjustments.length === 0) {
      return (
        <div className="empty-state" style={{ padding: '48px', textAlign: 'center' }}>
          <p>No pending adjustments.</p>
        </div>
      );
    }

    const getAdjustmentTypeLabel = (type) => {
      const labels = {
        'stock-correction': 'Stock Correction',
        'damage-reduction': 'Damage Reduction',
        'donation': 'Donation',
        'trash-disposal': 'Trash Disposal',
        'quality-rejection': 'Quality Rejection',
        'shipped-out': 'Shipped Out',
      };
      return labels[type] || type;
    };

    return (
      <div className="card-grid">
        {pendingAdjustments.map((adjustment) => {
          const receipt = receipts.find(r => r.id === adjustment.receiptId);
          const product = productLookup[receipt?.productId];
          const days = getDaysAgo(adjustment.submittedAt);
          const priority = getPriorityLevel(days);

          return (
            <article key={adjustment.id} className="approval-card">
              <header>
                <div>
                  <h3>{product?.name || "Unknown Product"}</h3>
                  <span className="badge">{getAdjustmentTypeLabel(adjustment.adjustmentType)}</span>
                </div>
                <div className="meta">
                  <span className="priority-badge" style={{ background: priority.color, color: 'white' }}>
                    {priority.label}
                  </span>
                </div>
              </header>
              <dl className="summary-grid">
                <div>
                  <dt>Quantity</dt>
                  <dd>{adjustment.quantity} cases</dd>
                </div>
                <div>
                  <dt>Reason</dt>
                  <dd>{adjustment.reason || '—'}</dd>
                </div>
                <div>
                  <dt>Submitted</dt>
                  <dd>{formatTimeAgo(adjustment.submittedAt)}</dd>
                </div>
                <div>
                  <dt>By</dt>
                  <dd>{userLookup[adjustment.submittedBy] || adjustment.submittedBy}</dd>
                </div>
              </dl>
              <footer>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    if (window.confirm('Approve this adjustment?')) {
                      approveAdjustment(adjustment.id, user?.id || user?.username);
                    }
                  }}
                  style={{ marginRight: '8px' }}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="secondary-button danger"
                  onClick={() => {
                    const reason = window.prompt('Reason for rejection:');
                    if (reason) {
                      rejectAdjustment(adjustment.id, user?.id || user?.username);
                    }
                  }}
                >
                  Reject
                </button>
              </footer>
            </article>
          );
        })}
      </div>
    );
  };

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
        <div className="tabs" style={{ marginBottom: '24px', borderBottom: '2px solid #e2e8f0' }}>
          <button
            className={`tab-button ${activeTab === 'receipts' ? 'active' : ''}`}
            onClick={() => setActiveTab('receipts')}
            style={{
              padding: '12px 24px',
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              borderBottom: activeTab === 'receipts' ? '2px solid #3b82f6' : '2px solid transparent',
              color: activeTab === 'receipts' ? '#3b82f6' : (summaryStats.receiptsPending > 0 ? '#dc2626' : '#64748b'),
              fontWeight: activeTab === 'receipts' ? '600' : (summaryStats.receiptsPending > 0 ? '600' : '400'),
              position: 'relative',
            }}
          >
            Receipts ({summaryStats.receiptsPending})
            {summaryStats.receiptsPending > 0 && (
              <span style={{
                position: 'absolute',
                top: '8px',
                right: '8px',
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: '#dc2626',
                border: '2px solid white',
              }} />
            )}
          </button>
          <button
            className={`tab-button ${activeTab === 'transfers' ? 'active' : ''}`}
            onClick={() => setActiveTab('transfers')}
            style={{
              padding: '12px 24px',
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              borderBottom: activeTab === 'transfers' ? '2px solid #3b82f6' : '2px solid transparent',
              color: activeTab === 'transfers' ? '#3b82f6' : (summaryStats.transfersPending > 0 ? '#dc2626' : '#64748b'),
              fontWeight: activeTab === 'transfers' ? '600' : (summaryStats.transfersPending > 0 ? '600' : '400'),
              position: 'relative',
            }}
          >
            Transfers ({summaryStats.transfersPending})
            {summaryStats.transfersPending > 0 && (
              <span style={{
                position: 'absolute',
                top: '8px',
                right: '8px',
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: '#dc2626',
                border: '2px solid white',
              }} />
            )}
          </button>
          <button
            className={`tab-button ${activeTab === 'holds' ? 'active' : ''}`}
            onClick={() => setActiveTab('holds')}
            style={{
              padding: '12px 24px',
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              borderBottom: activeTab === 'holds' ? '2px solid #3b82f6' : '2px solid transparent',
              color: activeTab === 'holds' ? '#3b82f6' : (summaryStats.holdsPending > 0 ? '#dc2626' : '#64748b'),
              fontWeight: activeTab === 'holds' ? '600' : (summaryStats.holdsPending > 0 ? '600' : '400'),
              position: 'relative',
            }}
          >
            Holds ({summaryStats.holdsPending})
            {summaryStats.holdsPending > 0 && (
              <span style={{
                position: 'absolute',
                top: '8px',
                right: '8px',
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: '#dc2626',
                border: '2px solid white',
              }} />
            )}
          </button>
          <button
            className={`tab-button ${activeTab === 'adjustments' ? 'active' : ''}`}
            onClick={() => setActiveTab('adjustments')}
            style={{
              padding: '12px 24px',
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              borderBottom: activeTab === 'adjustments' ? '2px solid #3b82f6' : '2px solid transparent',
              color: activeTab === 'adjustments' ? '#3b82f6' : (summaryStats.adjustmentsPending > 0 ? '#dc2626' : '#64748b'),
              fontWeight: activeTab === 'adjustments' ? '600' : (summaryStats.adjustmentsPending > 0 ? '600' : '400'),
              position: 'relative',
            }}
          >
            Adjustments ({summaryStats.adjustmentsPending})
            {summaryStats.adjustmentsPending > 0 && (
              <span style={{
                position: 'absolute',
                top: '8px',
                right: '8px',
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: '#dc2626',
                border: '2px solid white',
              }} />
            )}
          </button>
        </div>

        {/* Search and Filter Bar - Only show for receipts */}
        {activeTab === 'receipts' && (
          <div className="filter-bar">
            <div className="search-box">
              <input
                type="text"
                placeholder="Search by product, lot, or SID..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="search-input"
              />
            </div>
            <div className="filter-controls">
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="filter-select"
              >
                <option value="">All Categories</option>
                {productCategories && Array.isArray(productCategories) && productCategories.map(cat => (
                  <option key={cat.id} value={cat.id}>{cat.name}</option>
                ))}
              </select>
              <select
                value={dateRangeFilter}
                onChange={(e) => setDateRangeFilter(e.target.value)}
                className="filter-select"
              >
                <option value="all">All Time</option>
                <option value="week">Last 7 Days</option>
                <option value="month">Last 30 Days</option>
              </select>
            </div>
          </div>
        )}

        {/* Content based on active tab */}
        {activeTab === 'receipts' && (
          <div className="approvals-layout">
            <section className="panel">
              <div className="panel-header horizontal">
                <div>
                  <h2>Today&apos;s Submissions</h2>
                  <p className="muted">
                    {filteredTodaysPending.length} receipt{filteredTodaysPending.length === 1 ? "" : "s"} {filteredTodaysPending.length !== todaysPending.length ? 'found' : 'awaiting approval today'}
                  </p>
                </div>
                <button
                  type="button"
                  className="primary-button"
                  disabled={todaysPending.length === 0}
                  onClick={approveAllToday}
                >
                  Approve All Today
                </button>
              </div>

              {filteredTodaysPending.length === 0 ? (
                <div className="empty-state">
                  {searchQuery || categoryFilter ? 'No receipts match your filters.' : 'All of today&apos;s receipts are approved.'}
                </div>
              ) : (
                <div className="card-grid">
                  {filteredTodaysPending.map(renderCard)}
                </div>
              )}
            </section>

            <section className="panel">
              <div className="panel-header horizontal">
                <div>
                  <h2>Pending Backlog</h2>
                  <p className="muted">
                    {filteredBacklogPending.length} {filteredBacklogPending.length !== backlogPending.length ? 'found' : 'older receipt'}s {filteredBacklogPending.length !== backlogPending.length ? 'matching filters' : 'that still need attention'}
                  </p>
                </div>
              </div>
              {filteredBacklogPending.length === 0 ? (
                <div className="empty-state">
                  {searchQuery || categoryFilter || dateRangeFilter !== 'all' ? 'No receipts match your filters.' : 'Nothing waiting from prior days.'}
                </div>
              ) : (
                <div className="card-grid">
                  {filteredBacklogPending.map(renderBacklogCard)}
                </div>
              )}
            </section>
          </div>
        )}

        {activeTab === 'transfers' && (
          <section className="panel">
            <div className="panel-header">
              <h2>Pending Transfers</h2>
              <p className="muted">{pendingTransfers.length} transfer{pendingTransfers.length === 1 ? '' : 's'} awaiting approval</p>
            </div>
            {renderTransfersTab()}
          </section>
        )}

        {activeTab === 'holds' && (
          <section className="panel">
            <div className="panel-header">
              <h2>Pending Hold Requests</h2>
              <p className="muted">{pendingHolds.length} hold request{pendingHolds.length === 1 ? '' : 's'} awaiting approval</p>
            </div>
            {renderHoldsTab()}
          </section>
        )}

        {activeTab === 'adjustments' && (
          <section className="panel">
            <div className="panel-header">
              <h2>Pending Adjustments</h2>
              <p className="muted">{pendingAdjustments.length} adjustment{pendingAdjustments.length === 1 ? '' : 's'} awaiting approval</p>
            </div>
            {renderAdjustmentsTab()}
          </section>
        )}

        {activeTab === 'receipts' && (
          <section className="panel">
            <div className="panel-header horizontal">
              <div>
                <h2>Recent Approvals</h2>
                <p className="muted">Last 20 approved receipts</p>
              </div>
            </div>
            {approvedHistory.length === 0 ? (
              <div className="empty-state">No approved receipts yet.</div>
            ) : (
              <div className="table-wrapper">
                <table className="simple-table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Category</th>
                      <th>Quantity</th>
                      <th>Lot</th>
                      <th>Approved At</th>
                    </tr>
                  </thead>
                  <tbody>{approvedHistory.map(renderHistoryRow)}</tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>

      {selectedReceipt && draft && (
        <div className="drawer open">
          <div className="drawer-overlay" onClick={closeDetail} />
          <div className="drawer-content">
            <header className="drawer-header">
              <div>
                <h3>{productLookup[selectedReceipt.productId]?.name || "Receipt"}</h3>
                <p className="muted">
                  Submitted {formatDateTime(selectedReceipt.submittedAt || selectedReceipt.receiptDate)}
                </p>
              </div>
              <button className="link-button" onClick={closeDetail}>
                Close
              </button>
            </header>

            <div className="drawer-body">
              {/* Product Information Section */}
              <div className="info-section">
                <h4>Product Information</h4>
                <div className="info-grid">
                  <div className="info-item">
                    <label>Product Name</label>
                    <span className="info-value">{productLookup[selectedReceipt.productId]?.name || "Unknown Product"}</span>
                  </div>
                  <div className="info-item">
                    <label>Category</label>
                    <span className="info-value">{categoryLookup[selectedReceipt.categoryId]?.name || "Uncategorized"}</span>
                  </div>
                  <div className="info-item">
                    <label>Product ID</label>
                    <span className="info-value">{productLookup[selectedReceipt.productId]?.id || "—"}</span>
                  </div>
                  <div className="info-item">
                    <label>Description</label>
                    <span className="info-value">{productLookup[selectedReceipt.productId]?.description || "—"}</span>
                  </div>
                  <div className="info-item">
                    <label>Vendor</label>
                    <span className="info-value">
                      {selectedReceipt.vendorId ?
                        vendors.find(v => v.id === selectedReceipt.vendorId)?.name || selectedReceipt.vendorId :
                        "—"}
                    </span>
                  </div>
                </div>
              </div>

              <h4>Receipt Details</h4>
              <div className="form-grid">
                <label>
                  <span>Receipt Date</span>
                  <input
                    type="date"
                    value={draft.receiptDate || ""}
                    onChange={(event) => handleDraftChange("receiptDate", event.target.value)}
                    disabled={!isEditable}
                  />
                </label>

                <label>
                  <span>Lot Number</span>
                  <input
                    type="text"
                    value={draft.lotNo || ""}
                    onChange={(event) => handleDraftChange("lotNo", event.target.value)}
                    disabled={!isEditable}
                  />
                </label>

                <label>
                  <span>Quantity</span>
                  <input
                    type="number"
                    value={draft.quantity || ""}
                    onChange={(event) => handleDraftChange("quantity", event.target.value)}
                    disabled={!isEditable}
                  />
                </label>

                <label>
                  <span>Units</span>
                  <input
                    type="text"
                    value={draft.quantityUnits || ""}
                    onChange={(event) => handleDraftChange("quantityUnits", event.target.value)}
                    disabled={!isEditable}
                  />
                </label>

                <label>
                  <span>Expiration</span>
                  <input
                    type="date"
                    value={draft.expiration || ""}
                    onChange={(event) => handleDraftChange("expiration", event.target.value)}
                    disabled={!isEditable || (!isIngredient && !isFinished)}
                  />
                </label>

                {isIngredient && (
                  <>
                    <label>
                      <span>SID</span>
                      <input
                        type="text"
                        value={draft.sid || productLookup[selectedReceipt.productId]?.sid || ""}
                        onChange={(event) => handleDraftChange("sid", event.target.value)}
                        disabled={!isEditable}
                        placeholder={productLookup[selectedReceipt.productId]?.sid || "Product SID"}
                        readOnly={!isEditable}
                      />
                    </label>
                    <label>
                      <span>Vendor</span>
                      <select
                        value={draft.vendorId || ""}
                        onChange={(event) => handleDraftChange("vendorId", event.target.value)}
                        disabled={!isEditable}
                      >
                        <option value="">Select vendor</option>
                        {vendors.map((vendor) => (
                          <option key={vendor.id} value={vendor.id}>
                            {vendor.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Brix</span>
                      <input
                        type="text"
                        value={draft.brix || ""}
                        onChange={(event) => handleDraftChange("brix", event.target.value)}
                        disabled={!isEditable}
                      />
                    </label>
                  </>
                )}

                {isFinished && (
                  <>
                    <label>
                      <span>FCC Code</span>
                      <input
                        type="text"
                        value={draft.fccCode || productLookup[selectedReceipt.productId]?.fcc || ""}
                        onChange={(event) => handleDraftChange("fccCode", event.target.value)}
                        disabled={!isEditable}
                        placeholder={productLookup[selectedReceipt.productId]?.fcc || "Product FCC"}
                      />
                    </label>
                    <label>
                      <span>Production Date</span>
                      <input
                        type="date"
                        value={draft.productionDate || ""}
                        onChange={(event) => handleDraftChange("productionDate", event.target.value)}
                        disabled={!isEditable}
                      />
                    </label>
                    <label>
                      <span>Shift</span>
                      <select
                        value={draft.shift || ""}
                        onChange={(event) => handleDraftChange("shift", event.target.value)}
                        disabled={!isEditable}
                      >
                        <option value="">Select shift</option>
                        {productionShifts.filter(s => s.active !== false).map((shift) => (
                          <option key={shift.id} value={shift.id}>
                            {shift.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Line</span>
                      <select
                        value={draft.lineNumber || ""}
                        onChange={(event) => handleDraftChange("lineNumber", event.target.value)}
                        disabled={!isEditable}
                      >
                        <option value="">Select line</option>
                        {productionLines.filter(l => l.active !== false).map((line) => (
                          <option key={line.id} value={line.id}>
                            {line.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}

                {(isIngredient || isPackaging || isFinished) && (
                  <label className="full">
                    <span>Notes</span>
                    <textarea
                      value={draft.note || ""}
                      onChange={(event) => handleDraftChange("note", event.target.value)}
                      disabled={!isEditable}
                      rows={3}
                    />
                  </label>
                )}

                {/* Location fields - for finished goods, show formatted allocation; for others, show dropdowns */}
                {isFinished ? (
                  <label>
                    <span>Location</span>
                    <input
                      type="text"
                      value={getFinishedGoodsLocation(selectedReceipt) || "—"}
                      readOnly
                      style={{ background: '#f1f5f9', cursor: 'not-allowed' }}
                    />
                  </label>
                ) : (
                  <>
                    <label>
                      <span>Location</span>
                      <select
                        value={draft.location || draft.locationId || selectedReceipt.location || selectedReceipt.locationId || ""}
                        onChange={(event) => handleDraftChange("location", event.target.value)}
                        disabled={!isEditable}
                      >
                        <option value="">Select location</option>
                        {locations.filter(l => l.active !== false).map((location) => (
                          <option key={location.id} value={location.id}>
                            {location.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Sub Location</span>
                      <select
                        value={draft.subLocation || draft.subLocationId || selectedReceipt.subLocation || selectedReceipt.subLocationId || ""}
                        onChange={(event) => handleDraftChange("subLocation", event.target.value)}
                        disabled={!isEditable}
                      >
                        <option value="">Select sub location</option>
                        {(subLocationMap[draft.location || draft.locationId || selectedReceipt.location || selectedReceipt.locationId] || []).map((sub) => (
                          <option key={sub.id} value={sub.id}>
                            {sub.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}

                {isFinished && (
                  <label className="checkbox full">
                    <input
                      type="checkbox"
                      checked={draft.hold || false}
                      onChange={(event) => handleDraftChange("hold", event.target.checked)}
                      disabled={!isEditable}
                    />
                    <span>Set this batch on hold</span>
                  </label>
                )}

                {/* BOL and Purchase Order only for raw materials (ingredients/packaging), not finished goods */}
                {!isFinished && (
                  <>
                    <label>
                      <span>BOL</span>
                      <input
                        type="text"
                        value={draft.bol || ""}
                        onChange={(event) => handleDraftChange("bol", event.target.value)}
                        disabled={!isEditable}
                      />
                    </label>

                    <label>
                      <span>Purchase Order</span>
                      <input
                        type="text"
                        value={draft.purchaseOrder || ""}
                        onChange={(event) => handleDraftChange("purchaseOrder", event.target.value)}
                        disabled={!isEditable}
                      />
                    </label>
                  </>
                )}
              </div>
            </div>

            <footer className="drawer-footer">
              {isEditable ? (
                <>
                  <button className="secondary-button danger" onClick={() => setShowRejectModal(true)}>
                    Reject
                  </button>
                  <button className="secondary-button" onClick={() => setShowSendBackModal(true)}>
                    Send Back
                  </button>
                  <button className="primary-button" onClick={handleApproveRequest} disabled={isApproving}>
                    {isApproving ? 'Approving...' : 'Approve'}
                  </button>
                </>
              ) : (
                <span className="muted">This receipt has already been approved.</span>
              )}
            </footer>
          </div>
        </div>
      )}

      {showConfirm && changeSummary.length > 0 && (
        <div className="modal-overlay">
          <div className="modal">
            <h3>Confirm Updates</h3>
            <p className="muted">
              You are about to approve this receipt with the following changes:
            </p>
            <ul className="change-list">
              {changeSummary.map((change) => {
                const before = change.field === "vendorId"
                  ? vendorLookup[change.before] || "—"
                  : change.field === "location" || change.field === "subLocation"
                    ? locationLookupMap[change.before] || "—"
                    : change.field === "hold"
                      ? (change.before ? "On Hold" : "Clear")
                      : change.before || "—";
                const after = change.field === "vendorId"
                  ? vendorLookup[change.after] || "—"
                  : change.field === "location" || change.field === "subLocation"
                    ? locationLookupMap[change.after] || "—"
                    : change.field === "hold"
                      ? (change.after ? "On Hold" : "Clear")
                      : change.after || "—";
                return (
                  <li key={change.field}>
                    <strong>{change.label}</strong>
                    <span>{before}</span>
                    <span className="arrow">→</span>
                    <span>{after}</span>
                  </li>
                );
              })}
            </ul>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setShowConfirm(false);
                  setChangeSummary([]);
                }}
              >
                Cancel
              </button>
              <button type="button" className="primary-button" onClick={finalizeApprove} disabled={isApproving}>
                {isApproving ? 'Approving...' : 'Confirm & Approve'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rejection Modal */}
      {showRejectModal && (
        <div className="modal-overlay">
          <div className="modal">
            <h3>Reject Receipt</h3>
            <p className="muted">
              Please provide a reason for rejecting this receipt. This action cannot be undone.
            </p>
            <div className="form-group">
              <label>
                <span>Rejection Reason</span>
                <textarea
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  placeholder="Explain why this receipt is being rejected..."
                  rows={4}
                  required
                />
              </label>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setShowRejectModal(false);
                  setRejectionReason('');
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="secondary-button danger"
                onClick={handleReject}
                disabled={!rejectionReason.trim() || isRejecting}
              >
                {isRejecting ? 'Rejecting...' : 'Reject Receipt'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Send Back Modal */}
      {showSendBackModal && (
        <div className="modal-overlay">
          <div className="modal">
            <h3>Send Back for Correction</h3>
            <p className="muted">
              Please provide instructions for what needs to be corrected. The receipt will be sent back to the warehouse staff.
            </p>
            <div className="form-group">
              <label>
                <span>Correction Instructions</span>
                <textarea
                  value={sendBackReason}
                  onChange={(e) => setSendBackReason(e.target.value)}
                  placeholder="Explain what needs to be corrected or added..."
                  rows={4}
                  required
                />
              </label>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setShowSendBackModal(false);
                  setSendBackReason('');
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={handleSendBack}
                disabled={!sendBackReason.trim() || isSendingBack}
              >
                {isSendingBack ? 'Sending Back...' : 'Send Back'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ApprovalsPage;



