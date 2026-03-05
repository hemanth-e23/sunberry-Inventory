import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppData } from "../context/AppDataContext";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { useConfirm } from "../context/ConfirmContext";
import { getDashboardPath } from "../App";
import { formatDateTime, formatDate, formatTime, formatTimeAgo, getDaysAgo, toDateKey, getTodayDateKey } from "../utils/dateUtils";
import apiClient from "../api/client";
import "./Shared.css";
import "./ApprovalsPage.css";
import { ROLES, CATEGORY_TYPES, RECEIPT_STATUS, TRANSFER_STATUS, ADJUSTMENT_STATUS, HOLD_STATUS, FORKLIFT_REQUEST_STATUS, PALLET_STATUS } from '../constants';

const STATUS_PENDING = new Set([RECEIPT_STATUS.RECORDED, RECEIPT_STATUS.REVIEWED]);

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
    inventoryTransfers,
    approveTransfer,
    rejectTransfer,
    fetchTransferScanProgress,
    inventoryHoldActions,
    approveHoldAction,
    rejectHoldAction,
    inventoryAdjustments,
    approveAdjustment,
    rejectAdjustment,
    userNameMap,
    forkliftRequests,
    fetchForkliftRequests,
    approveForkliftRequest,
    rejectForkliftRequest,
    updateForkliftRequest,
    removePalletLicence,
    updatePalletLicence,
    addPalletToForkliftRequest,
  } = useAppData();

  const { addToast } = useToast();
  const { confirm } = useConfirm();
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

  const receiptLookup = useMemo(() => {
    const map = {};
    if (receipts && Array.isArray(receipts)) {
      receipts.forEach((receipt) => {
        map[receipt.id] = receipt;
      });
    }
    return map;
  }, [receipts]);

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
  }, [receipts, rowLookup, rowNameCache, fetchRowName]);

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

  const [transferScanProgress, setTransferScanProgress] = useState({});

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
        .filter((receipt) => receipt.status === RECEIPT_STATUS.APPROVED)
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
          transfer.status === TRANSFER_STATUS.PENDING &&
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
          hold.status === HOLD_STATUS.PENDING &&
          (user?.role !== 'warehouse' || (hold.submittedBy !== currentUserId && hold.submitted_by !== currentUserId))
        )
        .sort(
          (a, b) =>
            new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0),
        ),
    [inventoryHoldActions, user, currentUserId],
  );

  const pendingForkliftRequests = useMemo(
    () =>
      (forkliftRequests || []).filter((fr) => fr.status === FORKLIFT_REQUEST_STATUS.SUBMITTED),
    [forkliftRequests],
  );

  const pendingAdjustments = useMemo(
    () =>
      inventoryAdjustments
        .filter((adjustment) =>
          adjustment.status === ADJUSTMENT_STATUS.PENDING &&
          (user?.role !== 'warehouse' || (adjustment.submittedBy !== currentUserId && adjustment.submitted_by !== currentUserId))
        )
        .sort(
          (a, b) =>
            new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0),
        ),
    [inventoryAdjustments, user, currentUserId],
  );

  // Poll scan progress for pending ship-out transfers (live update)
  useEffect(() => {
    const shipOuts = pendingTransfers.filter(
      (t) => t.transferType === 'shipped-out' && (t.palletLicenceIds || t.pallet_licence_ids || []).length > 0
    );
    if (shipOuts.length === 0) {
      setTransferScanProgress({});
      return;
    }
    const load = async () => {
      const next = {};
      for (const t of shipOuts) {
        try {
          const data = await fetchTransferScanProgress(t.id);
          if (data) next[t.id] = data;
        } catch (_) { // ignore
        }
      }
      setTransferScanProgress((prev) => ({ ...prev, ...next }));
    };
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [pendingTransfers, fetchTransferScanProgress]);

  // Summary statistics
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

  // Filtered lists
  const filteredTodaysPending = useMemo(() => {
    return todaysPending.filter(receipt => {
      const product = productLookup[receipt.productId];

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
  }, [todaysPending, searchQuery, categoryFilter, productLookup]);

  const filteredBacklogPending = useMemo(() => {
    return backlogPending.filter(receipt => {
      const product = productLookup[receipt.productId];

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
  }, [backlogPending, searchQuery, categoryFilter, dateRangeFilter, productLookup]);

  const selectedReceipt = useMemo(
    () => receiptLookup[selectedReceiptId] || null,
    [receiptLookup, selectedReceiptId],
  );

  useEffect(() => {
    if (!selectedReceipt) {
      setDraft(null);
      return;
    }
    const { quantityTouched: _quantityTouched, ...rest } = selectedReceipt;
    const product = productLookup[selectedReceipt.productId];

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
  }, [selectedReceipt, productLookup]);

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

      if (category?.type !== CATEGORY_TYPES.FINISHED &&
        ["productionDate", "fccCode", "shift", "lineNumber", "hold"].includes(field)) {
        return;
      }
      if (category?.type !== CATEGORY_TYPES.INGREDIENT) {
        if (["vendorId", "brix", "sid"].includes(field)) return;
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
      const result = await approveReceipt(selectedReceipt.id, user?.id || user?.username);
      if (!result.success) {
        addToast(result.message || 'Failed to approve receipt', 'error');
        setIsApproving(false);
        return;
      }
      closeDetail();
    } catch (error) {
      console.error('Error approving receipt:', error);
      addToast('Failed to approve receipt. Please try again.', 'error');
    } finally {
      setIsApproving(false);
    }
  };

  const handleSendBack = async () => {
    if (!selectedReceipt) return;
    if (!sendBackReason.trim()) {
      addToast('Please provide a reason for sending back.', 'error');
      return;
    }
    setIsSendingBack(true);
    try {
      const result = await sendBackReceipt(selectedReceipt.id, sendBackReason, user?.id || user?.username);
      if (!result.success) {
        addToast(result.message || 'Failed to send back receipt', 'error');
        setIsSendingBack(false);
        return;
      }
      setSendBackReason('');
      setShowSendBackModal(false);
      closeDetail();
    } catch (error) {
      console.error('Error sending back receipt:', error);
      addToast('Failed to send back receipt. Please try again.', 'error');
    } finally {
      setIsSendingBack(false);
    }
  };

  const handleReject = async () => {
    if (!selectedReceipt) return;
    if (!rejectionReason.trim()) {
      addToast('Please provide a reason for rejection.', 'error');
      return;
    }
    setIsRejecting(true);
    try {
      const result = await rejectReceipt(selectedReceipt.id, rejectionReason, user?.id || user?.username);
      if (!result.success) {
        addToast(result.message || 'Failed to reject receipt', 'error');
        setIsRejecting(false);
        return;
      }
      setRejectionReason('');
      setShowRejectModal(false);
      closeDetail();
    } catch (error) {
      console.error('Error rejecting receipt:', error);
      addToast('Failed to reject receipt. Please try again.', 'error');
    } finally {
      setIsRejecting(false);
    }
  };

  const approveAllToday = async () => {
    if (filteredTodaysPending.length === 0) return;
    const confirmMessage = `Approve ${filteredTodaysPending.length} receipt${filteredTodaysPending.length > 1 ? "s" : ""} from today?`;
    const ok = await confirm(confirmMessage);
    if (!ok) return;

    try {
      const results = await Promise.all(
        filteredTodaysPending.map((receipt) => approveReceipt(receipt.id, user?.id || user?.username))
      );
      const failed = results.filter(r => !r.success);
      if (failed.length > 0) {
        addToast(`Failed to approve ${failed.length} receipt(s). Please try again.`, 'error');
      }
    } catch (error) {
      console.error('Error approving receipts:', error);
      addToast('Error approving receipts. Please try again.', 'error');
    }
  };

  const renderCard = (receipt) => {
    const product = productLookup[receipt.productId];
    const category = categoryLookup[receipt.categoryId];
    const _statusLabel = receipt.status === "reviewed" ? "Reviewed" : "Pending";
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
          {category?.type !== CATEGORY_TYPES.FINISHED && (
            <>
              <div>
                <dt>Vendor</dt>
                <dd>{receipt.vendorId ? vendorLookup[receipt.vendorId] || receipt.vendorId : "—"}</dd>
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
          {category?.type === CATEGORY_TYPES.FINISHED && (
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
                if (category?.type === CATEGORY_TYPES.FINISHED) {
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
                  const rowName = rowLookup[rowId];
                  const pallets = receipt.pallets || 0;
                  // rowLookup is pre-populated by the useEffect above; show rowId as fallback while loading
                  rowInfo.push(`${rowName || rowId}${pallets > 0 ? ` (${pallets} pallets)` : ''}`);
                }
                
                if (rowInfo.length > 0) {
                  return `${locationLabel} — Row${rowInfo.length > 1 ? 's' : ''}: ${rowInfo.join(', ')}`;
                }
                
                return locationLabel;
              })()}
            </dd>
          </div>
        </dl>
        <div className="requester-row">
          <span className="requester-avatar">
            {(userNameMap[receipt.submittedBy || receipt.submitted_by] || '?')[0].toUpperCase()}
          </span>
          <span className="requester-label">
            <strong>{userNameMap[receipt.submittedBy || receipt.submitted_by] || 'Unknown'}</strong> submitted this receipt
          </span>
        </div>
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
        <div className="requester-row">
          <span className="requester-avatar">
            {(userNameMap[receipt.submittedBy || receipt.submitted_by] || '?')[0].toUpperCase()}
          </span>
          <span className="requester-label">
            <strong>{userNameMap[receipt.submittedBy || receipt.submitted_by] || 'Unknown'}</strong> submitted this receipt
          </span>
        </div>
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
          <td className="hide-tablet">{category?.name || "—"}</td>
          <td>{receipt.quantity} {receipt.quantityUnits}</td>
          <td className="hide-mobile">{receipt.lotNo || "—"}</td>
          <td className="hide-mobile">{formatDateTime(receipt.approvedAt)}</td>
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
                    {category?.type === CATEGORY_TYPES.FINISHED ? (
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
                {category?.type !== CATEGORY_TYPES.FINISHED && (
                  <>
                    <div>
                      <strong style={{ fontSize: '12px', color: '#64748b' }}>VENDOR</strong>
                      <p style={{ margin: '4px 0 0', fontWeight: 500 }}>
                        {receipt.vendorId ? vendorLookup[receipt.vendorId] || receipt.vendorId : "—"}
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
                {category?.type === CATEGORY_TYPES.FINISHED && (
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
  const isIngredient = category?.type === CATEGORY_TYPES.INGREDIENT;
  const isPackaging = category?.type === CATEGORY_TYPES.PACKAGING;
  const isFinished = category?.type === CATEGORY_TYPES.FINISHED;

  // Render functions for other tabs
  const renderTransfersTab = () => {
    if (pendingTransfers.length === 0) {
      return (
        <div className="empty-state" style={{ padding: '48px', textAlign: 'center' }}>
          <p>No pending transfers.</p>
        </div>
      );
    }

    const formatBreakdownRows = (breakdown) => {
      if (!breakdown || !Array.isArray(breakdown)) return [];
      return breakdown.map((item) => {
        const id = item?.id || '';
        if (id.startsWith('row-')) {
          const rowId = id.replace('row-', '');
          return { label: rowLookup[rowId] || rowId, cases: item?.quantity || 0 };
        }
        return { label: id === 'floor' ? 'Floor Staging' : id, cases: item?.quantity || 0 };
      });
    };

    const manualRefreshProgress = async (transferId) => {
      try {
        const data = await fetchTransferScanProgress(transferId);
        if (data) setTransferScanProgress((prev) => ({ ...prev, [transferId]: data }));
      } catch (_) { // ignore
      }
    };

    return (
      <div className="card-grid">
        {pendingTransfers.map((transfer) => {
          const receipt = receiptLookup[transfer.receiptId];
          const product = productLookup[receipt?.productId];
          const days = getDaysAgo(transfer.submittedAt);
          const priority = getPriorityLevel(days);
          const sourceRows = formatBreakdownRows(transfer.sourceBreakdown);
          const destRows = formatBreakdownRows(transfer.destinationBreakdown);
          const isShipOut = transfer.transferType === 'shipped-out' || transfer.transfer_type === 'shipped-out';
          const hasPallets = (transfer.palletLicenceIds || transfer.pallet_licence_ids || []).length > 0;
          const progress = transferScanProgress[transfer.id];
          const pickList = progress?.pick_list || [];
          const scannedCount = pickList.filter(p => p.is_scanned).length;
          const skippedCount = pickList.filter(p => p.is_skipped).length;
          const totalPallets = pickList.length || progress?.total_pallets || 0;
          const forkliftDone = !!(progress?.forklift_submitted_at || transfer.forklift_submitted_at);
          const lastScan = progress?.last_scan;
          const exceptions = progress?.exceptions || [];

          return (
            <article key={transfer.id} className="approval-card" style={{ maxWidth: '720px' }}>
              <header>
                <div>
                  <h3>{product?.name || "Unknown Product"}</h3>
                  <span className="badge">{isShipOut ? 'Shipped Out' : (transfer.reason || 'Transfer')}</span>
                  {isShipOut && forkliftDone && (
                    <span style={{ marginLeft: '8px', background: '#22c55e', color: 'white', borderRadius: '999px', padding: '2px 10px', fontSize: '12px', fontWeight: 600 }}>
                      ✓ Forklift Done
                    </span>
                  )}
                  {isShipOut && !forkliftDone && hasPallets && (
                    <span style={{ marginLeft: '8px', background: '#f59e0b', color: 'white', borderRadius: '999px', padding: '2px 10px', fontSize: '12px', fontWeight: 600 }}>
                      Picking in progress
                    </span>
                  )}
                </div>
                <div className="meta">
                  <button
                    type="button"
                    onClick={() => manualRefreshProgress(transfer.id)}
                    style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: '6px', padding: '4px 8px', cursor: 'pointer', fontSize: '12px', color: '#6b7280', marginRight: '6px' }}
                    title="Refresh progress"
                  >
                    ↻ Refresh
                  </button>
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
                {isShipOut && (transfer.orderNumber || transfer.order_number) && (
                  <div>
                    <dt>Order #</dt>
                    <dd>{transfer.orderNumber || transfer.order_number}</dd>
                  </div>
                )}
                <div>
                  <dt>Created</dt>
                  <dd>{formatDateTime(transfer.submittedAt || transfer.submitted_at)}</dd>
                </div>
                {forkliftDone && (
                  <div>
                    <dt>Forklift submitted</dt>
                    <dd style={{ color: '#22c55e', fontWeight: 600 }}>
                      {formatDateTime(progress?.forklift_submitted_at || transfer.forklift_submitted_at)}
                    </dd>
                  </div>
                )}
              </dl>

              {/* Forklift notes */}
              {forkliftDone && (progress?.forklift_notes || transfer.forklift_notes) && (
                <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '8px', padding: '10px 14px', marginBottom: '10px', fontSize: '13px', color: '#166534' }}>
                  <strong>Forklift note:</strong> {progress?.forklift_notes || transfer.forklift_notes}
                </div>
              )}

              {/* Pallet warehouse transfer: show clear FROM → TO with pallet table */}
              {hasPallets && !isShipOut && (() => {
                const palletDetails = transfer.palletLicenceDetails || [];
                const fromLocations = [...new Set(palletDetails.map(p => p.location).filter(Boolean))];
                const toLabel = destRows[0]?.label || locationLookupMap[transfer.toLocation] || '—';
                const palletCount = (transfer.palletLicenceIds || transfer.pallet_licence_ids || []).length;
                return (
                  <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '8px', padding: '12px 14px', marginBottom: '10px', fontSize: '13px' }}>
                    {/* Movement summary row */}
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: palletDetails.length ? '10px' : 0, flexWrap: 'wrap' }}>
                      <div style={{ flex: 1, minWidth: '100px' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, color: '#0369a1', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' }}>Moving from</div>
                        {fromLocations.length > 0
                          ? fromLocations.map((loc, i) => (
                              <div key={i} style={{ fontWeight: 600, color: '#1e3a5f' }}>{loc}</div>
                            ))
                          : <div style={{ color: '#6b7280' }}>—</div>
                        }
                      </div>
                      <div style={{ fontSize: '22px', color: '#6366f1', paddingTop: '14px', flexShrink: 0 }}>→</div>
                      <div style={{ flex: 1, minWidth: '100px' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, color: '#0369a1', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' }}>Moving to</div>
                        <div style={{ fontWeight: 600, color: '#1e3a5f' }}>{toLabel}</div>
                      </div>
                      <div style={{ marginLeft: 'auto', textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, color: '#0369a1', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' }}>Pallets</div>
                        <div style={{ fontWeight: 700, color: '#1e3a5f' }}>{palletCount} pallets · {(transfer.quantity || 0).toLocaleString()} cs</div>
                      </div>
                    </div>

                    {/* Per-pallet details */}
                    {palletDetails.length > 0 && (
                      <div style={{ maxHeight: '200px', overflowY: 'auto', borderRadius: '6px', border: '1px solid #bae6fd', overflow: 'hidden' }}>
                        <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
                          <thead>
                            <tr style={{ background: '#e0f2fe' }}>
                              <th style={{ textAlign: 'left', padding: '5px 8px', color: '#0369a1', fontWeight: 600 }}>Licence #</th>
                              <th style={{ textAlign: 'left', padding: '5px 8px', color: '#0369a1', fontWeight: 600 }}>Current Location</th>
                              <th style={{ textAlign: 'right', padding: '5px 8px', color: '#0369a1', fontWeight: 600 }}>Cases</th>
                            </tr>
                          </thead>
                          <tbody>
                            {palletDetails.map((p, i) => (
                              <tr key={p.id} style={{ borderBottom: '1px solid #e0f2fe', background: i % 2 === 0 ? '#f0f9ff' : 'white' }}>
                                <td style={{ padding: '5px 8px', fontFamily: 'monospace', fontWeight: 700, color: '#1e40af' }}>{p.licence_number}</td>
                                <td style={{ padding: '5px 8px', color: '#374151' }}>{p.location || '—'}</td>
                                <td style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 600 }}>{(p.cases || 0).toLocaleString()} cs</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* RM / non-pallet transfer: show source → dest rows */}
              {!hasPallets && (sourceRows.length > 0 || destRows.length > 0) && (
                <div style={{ background: '#f9fafb', borderRadius: '8px', padding: '10px 14px', marginBottom: '10px', fontSize: '13px' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div>
                      <div style={{ fontWeight: 600, color: '#6b7280', marginBottom: '4px' }}>From</div>
                      {sourceRows.length > 0 ? (
                        <ul style={{ margin: 0, paddingLeft: '18px' }}>
                          {sourceRows.map((r, i) => <li key={i}>{r.label} — {r.cases} cases</li>)}
                        </ul>
                      ) : (
                        <div>{locationLookupMap[transfer.fromLocation] || transfer.fromLocation || '—'}</div>
                      )}
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, color: '#6b7280', marginBottom: '4px' }}>To</div>
                      {destRows.length > 0 ? (
                        <ul style={{ margin: 0, paddingLeft: '18px' }}>
                          {destRows.map((r, i) => <li key={i}>{r.label} — {r.cases} cases</li>)}
                        </ul>
                      ) : (
                        <div>{locationLookupMap[transfer.toLocation] || transfer.toLocation || '—'}</div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Ship-out pallet pick list with scan status */}
              {isShipOut && hasPallets && (
                <div style={{ marginBottom: '10px' }}>
                  {/* Progress header */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <div style={{ fontWeight: 600, fontSize: '13px', color: '#374151' }}>
                      Pallet Pick List
                    </div>
                    <div style={{ fontSize: '13px', color: '#6b7280' }}>
                      <span style={{ color: '#22c55e', fontWeight: 700 }}>{scannedCount}</span>
                      {skippedCount > 0 && <span style={{ color: '#f59e0b', fontWeight: 700 }}> + {skippedCount} skipped</span>}
                      <span> / {totalPallets} pallets</span>
                    </div>
                  </div>

                  {/* Progress bar */}
                  {totalPallets > 0 && (
                    <div style={{ height: '6px', background: '#e5e7eb', borderRadius: '999px', overflow: 'hidden', marginBottom: '8px' }}>
                      <div style={{ height: '100%', width: `${(scannedCount / totalPallets) * 100}%`, background: 'linear-gradient(90deg, #22c55e, #16a34a)', borderRadius: '999px', transition: 'width 0.4s' }} />
                    </div>
                  )}

                  {/* Per-pallet checklist */}
                  {pickList.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '220px', overflowY: 'auto' }}>
                      {pickList.map((pallet) => (
                        <div
                          key={pallet.pallet_id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            padding: '6px 10px',
                            borderRadius: '8px',
                            fontSize: '12px',
                            background: pallet.is_scanned ? '#f0fdf4' : pallet.is_skipped ? '#fffbeb' : '#f9fafb',
                            border: `1.5px solid ${pallet.is_scanned ? '#86efac' : pallet.is_skipped ? '#fde68a' : '#e5e7eb'}`,
                          }}
                        >
                          <span style={{ fontSize: '16px', lineHeight: 1 }}>
                            {pallet.is_scanned ? '✅' : pallet.is_skipped ? '⏭' : '⬜'}
                          </span>
                          <span style={{ fontFamily: 'monospace', fontWeight: 600, color: '#1e40af' }}>{pallet.licence_number}</span>
                          <span style={{ color: '#6b7280' }}>{pallet.location}</span>
                          <span style={{ color: '#6b7280' }}>· {pallet.cases} cs</span>
                          {pallet.is_scanned && pallet.scanned_at && (
                            <span style={{ marginLeft: 'auto', color: '#22c55e', fontSize: '11px' }}>
                              {formatTime(pallet.scanned_at)}
                            </span>
                          )}
                          {pallet.is_skipped && (
                            <span style={{ marginLeft: 'auto', color: '#f59e0b', fontSize: '11px', fontWeight: 600 }}>Skipped</span>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: '12px', color: '#9ca3af', padding: '8px 0' }}>
                      Waiting for forklift to start scanning…
                    </div>
                  )}

                  {/* Last scan indicator */}
                  {lastScan && (
                    <div style={{ marginTop: '8px', padding: '6px 10px', background: '#eff6ff', borderRadius: '6px', fontSize: '12px', color: '#1e40af' }}>
                      <strong>Last scan:</strong> {lastScan.licence_number}
                      {lastScan.scanned_by && ` · by ${lastScan.scanned_by}`}
                      {lastScan.scanned_at && ` · ${formatTime(lastScan.scanned_at)}`}
                    </div>
                  )}

                  {/* Exceptions */}
                  {exceptions.length > 0 && (
                    <div style={{ marginTop: '8px', padding: '8px 12px', background: '#fef3c7', borderRadius: '8px', fontSize: '12px', color: '#92400e' }}>
                      <div style={{ fontWeight: 600, marginBottom: '4px' }}>⚠ {exceptions.length} exception{exceptions.length !== 1 ? 's' : ''} — pallets not on pick list:</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                        {exceptions.map((ex, i) => (
                          <span key={i} style={{ background: '#fde68a', padding: '2px 8px', borderRadius: '999px', fontFamily: 'monospace', fontSize: '11px' }}>
                            {ex.licence_number}{ex.scanned_by ? ` (${ex.scanned_by})` : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="requester-row">
                <span className="requester-avatar">
                  {(userNameMap[transfer.requestedBy || transfer.requested_by] || '?')[0].toUpperCase()}
                </span>
                <span className="requester-label">
                  <strong>{userNameMap[transfer.requestedBy || transfer.requested_by] || 'Unknown'}</strong> requested this · {formatTimeAgo(transfer.submittedAt || transfer.submitted_at)}
                </span>
              </div>

              <footer>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    const msg = forkliftDone
                      ? `Approve ship-out order ${transfer.orderNumber || transfer.order_number}?\n\n${scannedCount}/${totalPallets} pallets scanned${skippedCount > 0 ? `, ${skippedCount} skipped` : ''}.\n\nThis will subtract ${transfer.quantity} cases from inventory.`
                      : 'Approve this transfer?';
                    confirm(msg).then(ok => {
                      if (ok) approveTransfer(transfer.id, user?.id || user?.username);
                    });
                  }}
                  style={{ marginRight: '8px' }}
                >
                  {isShipOut ? '✓ Approve & Deduct Inventory' : 'Approve'}
                </button>
                <button
                  type="button"
                  className="secondary-button danger"
                  onClick={() => {
                    confirm('Reject this transfer?').then(ok => {
                      if (ok) rejectTransfer(transfer.id, user?.id || user?.username);
                    });
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
          const isPalletHold = hold.palletLicenceIds?.length > 0;
          const receipt = receiptLookup[hold.receiptId];
          const palletProductId = isPalletHold ? hold.palletLicenceDetails?.[0]?.product_id : null;
          const product = productLookup[receipt?.productId] || (palletProductId ? productLookup[palletProductId] : null);
          const category = categoryLookup[receipt?.categoryId];
          const days = getDaysAgo(hold.submittedAt);
          const priority = getPriorityLevel(days);
          const isPlacingHold = hold.action === 'hold';

          return (
            <article key={hold.id} className="approval-card">
              <header>
                <div>
                  <h3>{product?.name || (isPalletHold ? 'Pallet Hold' : 'Unknown Product')}</h3>
                  <span className="badge" style={{ background: isPlacingHold ? '#fef3c7' : '#dcfce7', color: isPlacingHold ? '#92400e' : '#166534' }}>
                    {isPlacingHold ? '🔒 Place on Hold' : '🔓 Release Hold'}
                  </span>
                  {isPalletHold
                    ? <span className="badge" style={{ marginLeft: '6px', background: '#eff6ff', color: '#1d4ed8' }}>Finished Goods · Pallets</span>
                    : category && <span className="badge" style={{ marginLeft: '6px' }}>{category.name}</span>
                  }
                </div>
                <div className="meta">
                  <span className="priority-badge" style={{ background: priority.color, color: 'white' }}>
                    {priority.label}
                  </span>
                </div>
              </header>

              {/* Hold action summary */}
              <div style={{ background: isPlacingHold ? '#fffbeb' : '#f0fdf4', border: `1px solid ${isPlacingHold ? '#fde68a' : '#bbf7d0'}`, borderRadius: '8px', padding: '12px 16px', marginBottom: '12px' }}>
                <div style={{ fontSize: '13px', color: '#374151', fontWeight: 600, marginBottom: '6px' }}>
                  {isPlacingHold ? 'Requesting to place inventory on hold' : 'Requesting to release inventory from hold'}
                </div>

                {isPalletHold ? (
                  /* Pallet hold summary */
                  <div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '13px', marginBottom: '10px' }}>
                      <div>
                        <span style={{ color: '#6b7280' }}>Pallets</span>
                        <div style={{ fontWeight: 600, marginTop: '2px' }}>{hold.palletLicenceIds.length} pallet{hold.palletLicenceIds.length !== 1 ? 's' : ''}</div>
                      </div>
                      <div>
                        <span style={{ color: '#6b7280' }}>Total Cases</span>
                        <div style={{ fontWeight: 600, marginTop: '2px' }}>{(hold.totalQuantity ?? 0).toLocaleString()} cases</div>
                      </div>
                    </div>
                    {hold.palletLicenceDetails?.length > 0 && (
                      <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                            <th style={{ textAlign: 'left', padding: '4px 6px', color: '#6b7280', fontWeight: 500 }}>Licence #</th>
                            <th style={{ textAlign: 'left', padding: '4px 6px', color: '#6b7280', fontWeight: 500 }}>Location</th>
                            <th style={{ textAlign: 'right', padding: '4px 6px', color: '#6b7280', fontWeight: 500 }}>Cases</th>
                          </tr>
                        </thead>
                        <tbody>
                          {hold.palletLicenceDetails.map(p => (
                            <tr key={p.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                              <td style={{ padding: '4px 6px', fontFamily: 'monospace', fontWeight: 600 }}>{p.licence_number}</td>
                              <td style={{ padding: '4px 6px', color: '#374151' }}>{p.location}</td>
                              <td style={{ padding: '4px 6px', textAlign: 'right', fontWeight: 600 }}>{p.cases}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                ) : (
                  /* Lot hold summary */
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '13px' }}>
                    <div>
                      <span style={{ color: '#6b7280' }}>Lot Number</span>
                      <div style={{ fontWeight: 600, marginTop: '2px' }}>{receipt?.lotNo || '—'}</div>
                    </div>
                    <div>
                      <span style={{ color: '#6b7280' }}>Lot Quantity</span>
                      <div style={{ fontWeight: 600, marginTop: '2px' }}>{(receipt?.quantity ?? 0).toLocaleString()} {receipt?.quantityUnits || 'cases'}</div>
                    </div>
                    {receipt?.heldQuantity > 0 && (
                      <div>
                        <span style={{ color: '#6b7280' }}>Currently on Hold</span>
                        <div style={{ fontWeight: 600, color: '#d97706', marginTop: '2px' }}>{receipt.heldQuantity} cases</div>
                      </div>
                    )}
                    {(receipt?.locationId || receipt?.location) && (
                      <div>
                        <span style={{ color: '#6b7280' }}>Location</span>
                        <div style={{ fontWeight: 600, marginTop: '2px' }}>{locationLookupMap[receipt.subLocationId || receipt.subLocation || receipt.locationId || receipt.location] || '—'}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <dl className="summary-grid">
                <div style={{ gridColumn: '1 / -1' }}>
                  <dt>Reason</dt>
                  <dd style={{ fontStyle: hold.reason ? 'normal' : 'italic', color: hold.reason ? 'inherit' : '#9ca3af' }}>{hold.reason || 'No reason provided'}</dd>
                </div>
              </dl>

              <div className="requester-row">
                <span className="requester-avatar">
                  {(userNameMap[hold.submittedBy] || '?')[0].toUpperCase()}
                </span>
                <span className="requester-label">
                  <strong>{userNameMap[hold.submittedBy] || 'Unknown'}</strong> requested this · {formatTimeAgo(hold.submittedAt)}
                </span>
              </div>

              <footer>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    confirm(`Approve ${isPlacingHold ? 'placing on hold' : 'releasing from hold'}?`).then(ok => {
                      if (ok) approveHoldAction(hold.id, user?.id || user?.username);
                    });
                  }}
                  style={{ marginRight: '8px' }}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="secondary-button danger"
                  onClick={() => {
                    confirm('Reject this hold request?').then(ok => {
                      if (ok) rejectHoldAction(hold.id, user?.id || user?.username);
                    });
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

    const adjustmentTypeColors = {
      'stock-correction': { bg: '#eff6ff', color: '#1d4ed8' },
      'damage-reduction': { bg: '#fef3c7', color: '#92400e' },
      'donation': { bg: '#f0fdf4', color: '#166534' },
      'trash-disposal': { bg: '#fee2e2', color: '#991b1b' },
      'quality-rejection': { bg: '#fef3c7', color: '#92400e' },
      'shipped-out': { bg: '#f5f3ff', color: '#5b21b6' },
    };

    return (
      <div className="card-grid">
        {pendingAdjustments.map((adjustment) => {
          const receipt = receiptLookup[adjustment.receiptId];
          const product = productLookup[receipt?.productId];
          const category = categoryLookup[receipt?.categoryId || adjustment.categoryId];
          const days = getDaysAgo(adjustment.submittedAt);
          const priority = getPriorityLevel(days);
          const typeStyle = adjustmentTypeColors[adjustment.adjustmentType] || { bg: '#f3f4f6', color: '#374151' };
          const currentQty = receipt?.quantity ?? 0;
          const adjQty = Number(adjustment.quantity) || 0;
          const afterQty = Math.max(0, currentQty - adjQty);
          const isIncrease = adjustment.adjustmentType === 'stock-correction' && adjQty > 0;

          return (
            <article key={adjustment.id} className="approval-card">
              <header>
                <div>
                  <h3>{product?.name || "Unknown Product"}</h3>
                  <span className="badge" style={{ background: typeStyle.bg, color: typeStyle.color }}>
                    {getAdjustmentTypeLabel(adjustment.adjustmentType)}
                  </span>
                  {category && <span className="badge" style={{ marginLeft: '6px' }}>{category.name}</span>}
                </div>
                <div className="meta">
                  <span className="priority-badge" style={{ background: priority.color, color: 'white' }}>
                    {priority.label}
                  </span>
                </div>
              </header>

              {/* Before / After quantity panel */}
              {receipt && (
                <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px 16px', marginBottom: '12px' }}>
                  <div style={{ fontSize: '12px', color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '10px' }}>Quantity Impact</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '15px' }}>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '2px' }}>Current</div>
                      <div style={{ fontWeight: 700, fontSize: '18px', color: '#111827' }}>{currentQty}</div>
                      <div style={{ fontSize: '11px', color: '#6b7280' }}>{receipt.quantityUnits || 'cases'}</div>
                    </div>
                    <div style={{ fontSize: '20px', color: '#9ca3af', flex: 1, textAlign: 'center' }}>
                      {isIncrease ? '↑' : '→'}
                    </div>
                    <div style={{ textAlign: 'center', padding: '6px 12px', background: '#fee2e2', borderRadius: '8px' }}>
                      <div style={{ fontSize: '11px', color: '#991b1b', marginBottom: '2px' }}>Adjusting by</div>
                      <div style={{ fontWeight: 700, fontSize: '18px', color: '#dc2626' }}>−{adjQty}</div>
                      <div style={{ fontSize: '11px', color: '#991b1b' }}>{receipt.quantityUnits || 'cases'}</div>
                    </div>
                    <div style={{ fontSize: '20px', color: '#9ca3af', flex: 1, textAlign: 'center' }}>→</div>
                    <div style={{ textAlign: 'center', padding: '6px 12px', background: afterQty === 0 ? '#fee2e2' : '#f0fdf4', borderRadius: '8px' }}>
                      <div style={{ fontSize: '11px', color: afterQty === 0 ? '#991b1b' : '#166534', marginBottom: '2px' }}>After</div>
                      <div style={{ fontWeight: 700, fontSize: '18px', color: afterQty === 0 ? '#dc2626' : '#16a34a' }}>{afterQty}</div>
                      <div style={{ fontSize: '11px', color: afterQty === 0 ? '#991b1b' : '#166534' }}>{receipt.quantityUnits || 'cases'}</div>
                    </div>
                  </div>
                </div>
              )}

              <dl className="summary-grid">
                <div>
                  <dt>Lot Number</dt>
                  <dd>{receipt?.lotNo || '—'}</dd>
                </div>
                {adjustment.recipient && (
                  <div>
                    <dt>Recipient</dt>
                    <dd>{adjustment.recipient}</dd>
                  </div>
                )}
                <div style={{ gridColumn: adjustment.recipient ? 'auto' : '1 / -1' }}>
                  <dt>Reason</dt>
                  <dd style={{ fontStyle: adjustment.reason ? 'normal' : 'italic', color: adjustment.reason ? 'inherit' : '#9ca3af' }}>{adjustment.reason || 'No reason provided'}</dd>
                </div>
              </dl>

              <div className="requester-row">
                <span className="requester-avatar">
                  {(userNameMap[adjustment.submittedBy] || '?')[0].toUpperCase()}
                </span>
                <span className="requester-label">
                  <strong>{userNameMap[adjustment.submittedBy] || 'Unknown'}</strong> requested this · {formatTimeAgo(adjustment.submittedAt)}
                </span>
              </div>

              <footer>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    confirm(`Approve this ${getAdjustmentTypeLabel(adjustment.adjustmentType).toLowerCase()} of ${adjQty} cases?`).then(ok => {
                      if (ok) approveAdjustment(adjustment.id, user?.id || user?.username);
                    });
                  }}
                  style={{ marginRight: '8px' }}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="secondary-button danger"
                  onClick={() => {
                    confirm('Reject this adjustment?').then(ok => {
                      if (ok) rejectAdjustment(adjustment.id, user?.id || user?.username);
                    });
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

  const [editingForkliftId, setEditingForkliftId] = useState(null);
  const [forkliftProcessingId, setForkliftProcessingId] = useState(null);
  const [forkliftRejectingId, setForkliftRejectingId] = useState(null);
  const [editingPalletId, setEditingPalletId] = useState(null);
  const [editPalletCases, setEditPalletCases] = useState('');
  const [addPalletForm, setAddPalletForm] = useState({ licence_number: '', storage_row_id: '', is_partial: false, partial_cases: '' });
  const [isAddingPallet, setIsAddingPallet] = useState(false);

  const allStorageRows = useMemo(() => {
    const rows = [];
    if (storageAreas && Array.isArray(storageAreas)) {
      storageAreas.forEach((area) => {
        (area.rows || []).forEach((row) => {
          if (row.is_active !== false) {
            rows.push({ id: row.id, name: row.name, areaName: area.name });
          }
        });
      });
    }
    return rows;
  }, [storageAreas]);

  const renderForkliftTab = () => {
    if (pendingForkliftRequests.length === 0) {
      return (
        <div className="empty-state" style={{ padding: '48px', textAlign: 'center' }}>
          <p>No pending forklift requests.</p>
        </div>
      );
    }

    return (
      <div className="card-grid">
        {pendingForkliftRequests.map((fr) => {
          const productName = fr.product?.name || productLookup[fr.product_id]?.name || 'Unknown';
          const fccCode = fr.product?.fcc_code || productLookup[fr.product_id]?.fcc_code || '';
          const shortCode = fr.product?.short_code || productLookup[fr.product_id]?.short_code || '';
          const licences = (fr.pallet_licences || []).filter(pl => pl.status !== FORKLIFT_REQUEST_STATUS.CANCELLED);
          const isEditing = editingForkliftId === fr.id;

          return (
            <article key={fr.id} className="approval-card" style={{ maxWidth: '720px' }}>
              <header>
                <div style={{ flex: 1 }}>
                  <h3 style={{ margin: 0 }}>{productName}</h3>
                  <div style={{ display: 'flex', gap: '6px', marginTop: '4px', flexWrap: 'wrap' }}>
                    <span className="badge">{fr.lot_number || '—'}</span>
                    {fccCode && <span className="badge" style={{ background: '#e0e7ff', color: '#3730a3' }}>FCC: {fccCode}</span>}
                    {shortCode && <span className="badge" style={{ background: '#d1fae5', color: '#065f46' }}>{shortCode}</span>}
                  </div>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  style={{ fontSize: '13px', padding: '4px 12px' }}
                  onClick={() => setEditingForkliftId(isEditing ? null : fr.id)}
                >
                  {isEditing ? 'Done Editing' : 'Edit'}
                </button>
              </header>

              {/* Summary row */}
              <dl className="summary-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                <div><dt>Pallets</dt><dd>{licences.length}</dd></div>
                <div><dt>Total Cases</dt><dd>{fr.total_cases ?? 0}</dd></div>
                <div><dt>Cases/Pallet</dt><dd>{fr.cases_per_pallet ?? '—'}</dd></div>
                <div><dt>Scanned By</dt><dd>{userNameMap[fr.scanned_by] || '—'}</dd></div>
              </dl>

              {/* Full details section */}
              <div style={{ background: '#f9fafb', borderRadius: '8px', padding: '12px 16px', marginBottom: '12px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '14px' }}>
                  <div>
                    <span style={{ color: '#6b7280', fontWeight: 500 }}>Lot Number</span>
                    <div style={{ fontWeight: 600, marginTop: '2px' }}>{fr.lot_number || '—'}</div>
                  </div>
                  <div>
                    <span style={{ color: '#6b7280', fontWeight: 500 }}>Submitted</span>
                    <div style={{ marginTop: '2px' }}>{formatDateTime(fr.submitted_at || fr.created_at)}</div>
                  </div>
                  <div>
                    <span style={{ color: '#6b7280', fontWeight: 500 }}>Production Date</span>
                    {isEditing ? (
                      <input
                        type="date"
                        value={fr.production_date ? toDateKey(fr.production_date) : ''}
                        onChange={(e) => {
                          const val = e.target.value ? new Date(e.target.value + 'T00:00:00').toISOString() : null;
                          updateForkliftRequest(fr.id, { production_date: val });
                        }}
                        style={{ display: 'block', marginTop: '2px', padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: '4px', width: '100%', boxSizing: 'border-box' }}
                      />
                    ) : (
                      <div style={{ marginTop: '2px', fontWeight: 600 }}>
                        {fr.production_date ? formatDate(fr.production_date) : '—'}
                      </div>
                    )}
                  </div>
                  <div>
                    <span style={{ color: '#6b7280', fontWeight: 500 }}>Expiration Date</span>
                    {isEditing ? (
                      <input
                        type="date"
                        value={fr.expiration_date ? toDateKey(fr.expiration_date) : ''}
                        onChange={(e) => {
                          const val = e.target.value ? new Date(e.target.value + 'T00:00:00').toISOString() : null;
                          updateForkliftRequest(fr.id, { expiration_date: val });
                        }}
                        style={{ display: 'block', marginTop: '2px', padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: '4px', width: '100%', boxSizing: 'border-box' }}
                      />
                    ) : (
                      <div style={{ marginTop: '2px', fontWeight: 600 }}>
                        {formatDate(fr.expiration_date)}
                      </div>
                    )}
                  </div>
                  <div>
                    <span style={{ color: '#6b7280', fontWeight: 500 }}>Cases Per Pallet</span>
                    {isEditing ? (
                      <input
                        type="number"
                        min="1"
                        value={fr.cases_per_pallet ?? ''}
                        onChange={(e) => {
                          const val = parseInt(e.target.value);
                          if (val > 0) updateForkliftRequest(fr.id, { cases_per_pallet: val });
                        }}
                        style={{ display: 'block', marginTop: '2px', padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: '4px', width: '100%', boxSizing: 'border-box' }}
                      />
                    ) : (
                      <div style={{ marginTop: '2px', fontWeight: 600 }}>{fr.cases_per_pallet ?? '—'}</div>
                    )}
                  </div>
                  <div>
                    <span style={{ color: '#6b7280', fontWeight: 500 }}>Line</span>
                    {isEditing ? (
                      <select
                        value={fr.line_id || ''}
                        onChange={(e) => updateForkliftRequest(fr.id, { line_id: e.target.value || null })}
                        style={{ display: 'block', marginTop: '2px', padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: '4px', width: '100%', boxSizing: 'border-box' }}
                      >
                        <option value="">No line</option>
                        {(productionLines || []).map((l) => (
                          <option key={l.id} value={l.id}>{l.name}</option>
                        ))}
                      </select>
                    ) : (
                      <div style={{ marginTop: '2px', fontWeight: 600 }}>
                        {fr.line_id ? (lineLookup[fr.line_id] || fr.line_id) : '—'}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Shift selector */}
              <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <strong style={{ fontSize: '14px' }}>Shift</strong>
                <select
                  value={fr.shift_id || ''}
                  onChange={(e) => updateForkliftRequest(fr.id, { shift_id: e.target.value || null })}
                  style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px' }}
                >
                  <option value="">Select shift</option>
                  {(productionShifts || []).map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                {!fr.shift_id && <span style={{ color: '#ef4444', fontSize: '12px' }}>Required before approval</span>}
              </div>

              {/* Pallet licences - always visible */}
              <div style={{ marginBottom: '12px' }}>
                <h4 style={{ margin: '0 0 8px 0', fontSize: '14px', fontWeight: 600 }}>
                  Pallet Licences ({licences.length})
                </h4>
                <div style={{ maxHeight: '300px', overflow: 'auto', border: '1px solid #e5e7eb', borderRadius: '8px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ background: '#f3f4f6', position: 'sticky', top: 0 }}>
                        <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600 }}>Licence #</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600 }}>Row</th>
                        <th style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 600 }}>Cases</th>
                        <th style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 600 }}>Type</th>
                        <th style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 600 }}>Status</th>
                        {isEditing && <th style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 600 }}>Actions</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {licences.map((pl) => (
                        <tr key={pl.id} style={{ borderTop: '1px solid #e5e7eb' }}>
                          <td style={{ padding: '8px 10px', fontFamily: 'monospace', fontSize: '12px' }}>{pl.licence_number}</td>
                          <td style={{ padding: '8px 10px' }}>{rowLookup[pl.storage_row_id] || pl.storage_row_id || '—'}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                            {isEditing && editingPalletId === pl.id ? (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                                <input
                                  type="number"
                                  min="1"
                                  value={editPalletCases}
                                  onChange={(e) => setEditPalletCases(e.target.value)}
                                  style={{ width: '60px', padding: '2px 6px', border: '1px solid #d1d5db', borderRadius: '4px', textAlign: 'center' }}
                                  autoFocus
                                />
                                <button
                                  type="button"
                                  style={{ padding: '2px 6px', fontSize: '12px', background: '#10b981', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                                  onClick={async () => {
                                    const val = parseInt(editPalletCases);
                                    if (val > 0) {
                                      await updatePalletLicence(fr.id, pl.id, { cases: val, is_partial: val !== fr.cases_per_pallet });
                                    }
                                    setEditingPalletId(null);
                                    setEditPalletCases('');
                                  }}
                                >Save</button>
                                <button
                                  type="button"
                                  style={{ padding: '2px 6px', fontSize: '12px', background: '#9ca3af', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                                  onClick={() => { setEditingPalletId(null); setEditPalletCases(''); }}
                                >Cancel</button>
                              </span>
                            ) : (
                              <span
                                style={isEditing ? { cursor: 'pointer', borderBottom: '1px dashed #6b7280' } : {}}
                                onClick={() => {
                                  if (isEditing) {
                                    setEditingPalletId(pl.id);
                                    setEditPalletCases(String(pl.cases));
                                  }
                                }}
                                title={isEditing ? 'Click to edit cases' : ''}
                              >
                                {pl.cases}
                              </span>
                            )}
                          </td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                            {pl.is_partial ? (
                              <span style={{ background: '#fef3c7', color: '#92400e', padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600 }}>Partial</span>
                            ) : (
                              <span style={{ background: '#d1fae5', color: '#065f46', padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600 }}>Full</span>
                            )}
                          </td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                            {pl.status === PALLET_STATUS.MISSING_STICKER ? (
                              <span style={{ background: '#fee2e2', color: '#991b1b', padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600 }}>Missing Sticker</span>
                            ) : (
                              <span style={{ background: '#e0e7ff', color: '#3730a3', padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600 }}>Pending</span>
                            )}
                          </td>
                          {isEditing && (
                            <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                              <button
                                type="button"
                                style={{ padding: '2px 8px', fontSize: '12px', background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: '4px', cursor: 'pointer' }}
                                onClick={async () => {
                                  const ok = await confirm(`Remove pallet ${pl.licence_number}?`);
                                  if (ok) {
                                    const result = await removePalletLicence(fr.id, pl.id);
                                    if (!result?.success) addToast(result?.error || 'Remove failed', 'error');
                                  }
                                }}
                              >Remove</button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Add Pallet form - only in edit mode */}
              {isEditing && (
                <div style={{ marginBottom: '12px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '8px', padding: '12px' }}>
                  <h4 style={{ margin: '0 0 8px 0', fontSize: '14px', fontWeight: 600 }}>Add Missing Pallet</h4>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                    <div>
                      <label style={{ fontSize: '12px', color: '#6b7280', display: 'block', marginBottom: '2px' }}>Licence Number</label>
                      <input
                        type="text"
                        placeholder="e.g. MP04926L1-PFN640-002"
                        value={addPalletForm.licence_number}
                        onChange={(e) => setAddPalletForm(prev => ({ ...prev, licence_number: e.target.value }))}
                        style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '13px', boxSizing: 'border-box' }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: '12px', color: '#6b7280', display: 'block', marginBottom: '2px' }}>Storage Row</label>
                      <select
                        value={addPalletForm.storage_row_id}
                        onChange={(e) => setAddPalletForm(prev => ({ ...prev, storage_row_id: e.target.value }))}
                        style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '13px', boxSizing: 'border-box' }}
                      >
                        <option value="">Select row...</option>
                        {allStorageRows.map((r) => (
                          <option key={r.id} value={r.id}>{r.areaName} - {r.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px' }}>
                    <label style={{ fontSize: '13px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <input
                        type="checkbox"
                        checked={addPalletForm.is_partial}
                        onChange={(e) => setAddPalletForm(prev => ({ ...prev, is_partial: e.target.checked }))}
                      />
                      Partial pallet
                    </label>
                    {addPalletForm.is_partial && (
                      <input
                        type="number"
                        min="1"
                        placeholder="Cases"
                        value={addPalletForm.partial_cases}
                        onChange={(e) => setAddPalletForm(prev => ({ ...prev, partial_cases: e.target.value }))}
                        style={{ width: '80px', padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '13px' }}
                      />
                    )}
                    <button
                      type="button"
                      disabled={!addPalletForm.licence_number || !addPalletForm.storage_row_id || isAddingPallet}
                      style={{
                        marginLeft: 'auto', padding: '6px 16px', fontSize: '13px', fontWeight: 600,
                        background: (!addPalletForm.licence_number || !addPalletForm.storage_row_id) ? '#d1d5db' : '#10b981',
                        color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer'
                      }}
                      onClick={async () => {
                        setIsAddingPallet(true);
                        const payload = {
                          licence_number: addPalletForm.licence_number.trim(),
                          storage_row_id: addPalletForm.storage_row_id,
                          is_partial: addPalletForm.is_partial,
                          partial_cases: addPalletForm.is_partial ? parseInt(addPalletForm.partial_cases) || null : null,
                        };
                        const result = await addPalletToForkliftRequest(fr.id, payload);
                        setIsAddingPallet(false);
                        if (result?.success) {
                          setAddPalletForm({ licence_number: '', storage_row_id: '', is_partial: false, partial_cases: '' });
                        } else {
                          addToast(result?.error || 'Failed to add pallet', 'error');
                        }
                      }}
                    >
                      {isAddingPallet ? 'Adding...' : 'Add Pallet'}
                    </button>
                  </div>
                </div>
              )}

              <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!fr.shift_id || forkliftProcessingId === fr.id}
                  onClick={async () => {
                    if (!fr.shift_id) {
                      addToast('Please select a shift before approving.', 'error');
                      return;
                    }
                    setForkliftProcessingId(fr.id);
                    const result = await approveForkliftRequest(fr.id);
                    setForkliftProcessingId(null);
                    if (result?.success) {
                      fetchForkliftRequests();
                    } else {
                      addToast(result?.error || 'Approval failed', 'error');
                    }
                  }}
                >
                  {forkliftProcessingId === fr.id ? 'Approving...' : 'Approve'}
                </button>
                <button
                  type="button"
                  className="secondary-button danger"
                  disabled={forkliftRejectingId === fr.id}
                  onClick={() => {
                    confirm('Reject this forklift request? All pallet licences will be cancelled.').then(async (ok) => {
                      if (!ok) return;
                      setForkliftRejectingId(fr.id);
                      const result = await rejectForkliftRequest(fr.id);
                      setForkliftRejectingId(null);
                      if (result?.success) {
                        fetchForkliftRequests();
                      } else {
                        addToast(result?.error || 'Reject failed', 'error');
                      }
                    });
                  }}
                >
                  {forkliftRejectingId === fr.id ? 'Rejecting...' : 'Reject'}
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
                  <h2>Today's Submissions</h2>
                  <p className="muted">
                    {filteredTodaysPending.length} receipt{filteredTodaysPending.length === 1 ? "" : "s"} {filteredTodaysPending.length !== todaysPending.length ? 'found' : 'awaiting approval today'}
                  </p>
                </div>
                <button
                  type="button"
                  className="primary-button"
                  disabled={filteredTodaysPending.length === 0}
                  onClick={approveAllToday}
                >
                  Approve All Today
                </button>
              </div>

              {filteredTodaysPending.length === 0 ? (
                <div className="empty-state">
                  {searchQuery || categoryFilter ? 'No receipts match your filters.' : "All of today's receipts are approved."}
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

        {activeTab === 'forklift' && (
          <section className="panel">
            <div className="panel-header">
              <h2>Forklift Requests</h2>
              <p className="muted">{pendingForkliftRequests.length} request{pendingForkliftRequests.length === 1 ? '' : 's'} awaiting approval</p>
            </div>
            {renderForkliftTab()}
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
                      <th className="hide-tablet">Category</th>
                      <th>Quantity</th>
                      <th className="hide-mobile">Lot</th>
                      <th className="hide-mobile">Approved At</th>
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
                    <label>Product Code</label>
                    <span className="info-value">{productLookup[selectedReceipt.productId]?.short_code || productLookup[selectedReceipt.productId]?.sid || "—"}</span>
                  </div>
                  <div className="info-item">
                    <label>Description</label>
                    <span className="info-value">{productLookup[selectedReceipt.productId]?.description || "—"}</span>
                  </div>
                  <div className="info-item">
                    <label>Vendor</label>
                    <span className="info-value">
                      {selectedReceipt.vendorId ? vendorLookup[selectedReceipt.vendorId] || selectedReceipt.vendorId : "—"}
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
                  {/* Only admin and supervisor can send back - warehouse workers can only approve/reject */}
                  {(user?.role === ROLES.ADMIN || user?.role === ROLES.SUPERVISOR) && (
                    <button className="secondary-button" onClick={() => setShowSendBackModal(true)}>
                      Send Back
                    </button>
                  )}
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



