import React, { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { useAppData } from "../../context/AppDataContext";
import { useToast } from "../../context/ToastContext";
import { useConfirm } from "../../context/ConfirmContext";
import { formatDateTime, formatTimeAgo, getDaysAgo, toDateKey, getTodayDateKey } from "../../utils/dateUtils";
import { ROLES, CATEGORY_TYPES, RECEIPT_STATUS } from '../../constants';

const STATUS_PENDING = new Set([RECEIPT_STATUS.RECORDED, RECEIPT_STATUS.REVIEWED]);

const getPriorityLevel = (days) => {
  if (days === 0) return { level: 'low', label: 'New', color: '#10b981' };
  if (days < 3) return { level: 'low', label: 'Recent', color: '#10b981' };
  if (days < 7) return { level: 'medium', label: 'Moderate', color: '#f59e0b' };
  return { level: 'high', label: 'Urgent', color: '#ef4444' };
};

const ReceiptsTab = ({
  productLookup,
  categoryLookup,
  vendorLookup,
  locationLookupMap,
  receiptLookup,
  rowLookup,
  shiftLookup,
  lineLookup,
  userNameMap,
  getFinishedGoodsLocation,
  todaysPending,
  backlogPending,
  approvedHistory,
  searchQuery,
  setSearchQuery,
  categoryFilter,
  setCategoryFilter,
  dateRangeFilter,
  setDateRangeFilter,
}) => {
  const { user } = useAuth();
  const currentUserId = user?.id || user?.username;
  const {
    productCategories,
    vendors,
    locations,
    subLocationMap,
    productionShifts,
    productionLines,
    approveReceipt,
    rejectReceipt,
    sendBackReceipt,
    updateReceipt,
  } = useAppData();
  const { addToast } = useToast();
  const { confirm } = useConfirm();

  const [selectedReceiptId, setSelectedReceiptId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [changeSummary, setChangeSummary] = useState([]);
  const [expandedHistoryId, setExpandedHistoryId] = useState(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [sendBackReason, setSendBackReason] = useState('');
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [showSendBackModal, setShowSendBackModal] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const [isSendingBack, setIsSendingBack] = useState(false);

  // Filtered lists
  const filteredTodaysPending = useMemo(() => {
    return todaysPending.filter(receipt => {
      const product = productLookup[receipt.productId];
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesName = product?.name?.toLowerCase().includes(query);
        const matchesLot = receipt.lotNo?.toLowerCase().includes(query);
        const matchesSID = receipt.sid?.toLowerCase().includes(query);
        if (!matchesName && !matchesLot && !matchesSID) return false;
      }
      if (categoryFilter && receipt.categoryId !== categoryFilter) return false;
      return true;
    });
  }, [todaysPending, searchQuery, categoryFilter, productLookup]);

  const filteredBacklogPending = useMemo(() => {
    return backlogPending.filter(receipt => {
      const product = productLookup[receipt.productId];
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesName = product?.name?.toLowerCase().includes(query);
        const matchesLot = receipt.lotNo?.toLowerCase().includes(query);
        const matchesSID = receipt.sid?.toLowerCase().includes(query);
        if (!matchesName && !matchesLot && !matchesSID) return false;
      }
      if (categoryFilter && receipt.categoryId !== categoryFilter) return false;
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
    const receiptLocationId = selectedReceipt.locationId || selectedReceipt.location || rest.locationId || rest.location || '';
    const receiptSubLocationId = selectedReceipt.subLocationId || selectedReceipt.subLocation || rest.subLocationId || rest.subLocation || '';
    setDraft({
      ...rest,
      quantityTouched: false,
      location: receiptLocationId,
      locationId: receiptLocationId,
      subLocation: receiptSubLocationId,
      subLocationId: receiptSubLocationId,
      sid: product?.sid || rest.sid || selectedReceipt.sid || '',
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
    setDraft((prev) => ({ ...prev, [field]: value }));
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
      const normalizedOriginal = typeof original === "boolean" ? original : original ?? "";
      const normalizedUpdated = typeof updated === "boolean" ? updated : updated ?? "";
      if (normalizedOriginal === normalizedUpdated) return;
      if (field === "sid") {
        const productSID = productLookup[receipt.productId]?.sid || "";
        if (original === productSID && updated === productSID) return;
        if ((!original || original === "") && updated === productSID) return;
      }
      if (category?.type !== CATEGORY_TYPES.FINISHED &&
        ["productionDate", "fccCode", "shift", "lineNumber", "hold"].includes(field)) return;
      if (category?.type !== CATEGORY_TYPES.INGREDIENT) {
        if (["vendorId", "brix", "sid"].includes(field)) return;
      }
      summary.push({ field, label, before: original, after: updated });
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

  const isEditable = selectedReceipt && STATUS_PENDING.has(selectedReceipt.status);
  const category = selectedReceipt ? categoryLookup[selectedReceipt.categoryId] : null;
  const isIngredient = category?.type === CATEGORY_TYPES.INGREDIENT;
  const isPackaging = category?.type === CATEGORY_TYPES.PACKAGING;
  const isFinished = category?.type === CATEGORY_TYPES.FINISHED;

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
                if (category?.type === CATEGORY_TYPES.FINISHED) {
                  const location = getFinishedGoodsLocation(receipt);
                  return location || "—";
                }
                let locationLabel = "—";
                if (receipt.subLocationId || receipt.subLocation) {
                  locationLabel = locationLookupMap[receipt.subLocationId || receipt.subLocation] || "—";
                } else if (receipt.locationId || receipt.location) {
                  locationLabel = locationLookupMap[receipt.locationId || receipt.location] || "—";
                }
                const rowInfo = [];
                if (receipt.rawMaterialRowAllocations && Array.isArray(receipt.rawMaterialRowAllocations)) {
                  receipt.rawMaterialRowAllocations.forEach(alloc => {
                    const rowName = rowLookup[alloc.rowId] || alloc.rowName || alloc.rowId;
                    const pallets = alloc.pallets || 0;
                    if (rowName) {
                      rowInfo.push(`${rowName} (${pallets} pallets)`);
                    }
                  });
                } else if (receipt.storageRowId || receipt.storage_row_id) {
                  const rowId = receipt.storageRowId || receipt.storage_row_id;
                  const rowName = rowLookup[rowId];
                  const pallets = receipt.pallets || 0;
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
                      getFinishedGoodsLocation(receipt) || "—"
                    ) : receipt.subLocationId || receipt.subLocation ? (
                      locationLookupMap[receipt.subLocationId || receipt.subLocation] || "—"
                    ) : receipt.locationId || receipt.location ? (
                      locationLookupMap[receipt.locationId || receipt.location] || "—"
                    ) : "—"}
                  </p>
                </div>
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

  return (
    <>
      {/* Search and Filter Bar */}
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

      {/* Receipt Detail Drawer */}
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

      {/* Confirm Updates Modal */}
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
    </>
  );
};

export default ReceiptsTab;
