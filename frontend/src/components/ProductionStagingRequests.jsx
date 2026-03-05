import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAppData } from '../context/AppDataContext';
import { getDashboardPath } from '../App';
import apiClient from '../api/client';
import { formatDate, formatDateTime, escapeHtml } from '../utils/dateUtils';
import './StagingOverview.css'; // Re-use staging styles
import { STAGING_ITEM_STATUS, STAGING_REQUEST_STATUS } from '../constants';
import QuickStageModal from './staging/QuickStageModal';
import MarkUsedModal from './staging/MarkUsedModal';
import ReturnModal from './staging/ReturnModal';
import CloseOutModal from './staging/CloseOutModal';

const ProductionStagingRequests = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { products } = useAppData();

  // ── List / filter state ────────────────────────────────────────────────────
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const [expandedId, setExpandedId] = useState(null);

  // ── Print sheet state ──────────────────────────────────────────────────────
  const [printingSheetId, setPrintingSheetId] = useState(null);

  // ── Sync with Production state ─────────────────────────────────────────────
  const [syncingId, setSyncingId] = useState(null);
  const [syncResult, setSyncResult] = useState(null);

  // ── Overdue action state ───────────────────────────────────────────────────
  const [submittingDismiss, setSubmittingDismiss] = useState(false);

  // ── Reconciliation state ───────────────────────────────────────────────────
  const [showReconciliation, setShowReconciliation] = useState(false);
  const [reconData, setReconData] = useState([]);
  const [loadingRecon, setLoadingRecon] = useState(false);

  // ── Modal visibility state (each holds the props needed to open the modal) ─
  const [quickStageProps, setQuickStageProps] = useState(null);  // { requestId, item, requestBatchUid, underlyingItems }
  const [markUsedProps, setMarkUsedProps] = useState(null);      // { requestId, item, details }
  const [returnProps, setReturnProps] = useState(null);          // { requestId, item, details }
  const [closeOutProps, setCloseOutProps] = useState(null);      // { requestId, data, loading, error }

  useEffect(() => {
    fetchRequests();
  }, [statusFilter]);

  // ===========================================================================
  // Data fetching
  // ===========================================================================

  const fetchRequests = async () => {
    try {
      setLoading(true);
      setError('');
      const response = await apiClient.get('/service/staging-requests', {
        params: statusFilter ? { status_filter: statusFilter } : undefined,
      });
      setRequests(Array.isArray(response.data) ? response.data : []);
    } catch (err) {
      console.error('Error fetching staging requests:', err);
      const detail = err.response?.data?.detail;
      setError(
        typeof detail === 'string'
          ? detail
          : Array.isArray(detail)
          ? detail.map((e) => e.msg || JSON.stringify(e)).join('; ')
          : 'Failed to load staging requests.'
      );
      setRequests([]);
    } finally {
      setLoading(false);
    }
  };

  const fetchReconciliation = async () => {
    try {
      setLoadingRecon(true);
      const resp = await apiClient.get('/service/staging-requests/reconciliation');
      setReconData(Array.isArray(resp.data) ? resp.data : []);
      setShowReconciliation(true);
    } catch (err) {
      console.error('Error fetching reconciliation:', err);
      setError('Failed to load reconciliation data.');
    } finally {
      setLoadingRecon(false);
    }
  };

  // Fetch staging details for a consolidated group (shared by mark-used and return openers)
  const fetchStagingDetailsForGroup = async (requestId, itemOrGroup) => {
    const items =
      itemOrGroup.itemsWithStaging?.length > 0
        ? itemOrGroup.itemsWithStaging
        : itemOrGroup.anyStagingItems && itemOrGroup.allItems?.length > 0
        ? itemOrGroup.allItems
        : itemOrGroup.underlyingItems || (itemOrGroup.id ? [itemOrGroup] : []);

    const detailsBySiId = new Map();
    for (const it of items) {
      try {
        const resp = await apiClient.get(
          `/service/staging-requests/${requestId}/items/${it.id}/staging-details`
        );
        const stagingItems = resp.data?.staging_items || [];
        for (const d of stagingItems) {
          if (d.available > 0) {
            const existing = detailsBySiId.get(d.staging_item_id);
            if (!existing || d.available > existing.available) {
              detailsBySiId.set(d.staging_item_id, { ...d, _itemId: it.id });
            }
          }
        }
      } catch (err) {
        console.error('Error fetching staging details:', err);
      }
    }
    return Array.from(detailsBySiId.values());
  };

  // ===========================================================================
  // Consolidation helper (same as before — keep in parent for print sheet too)
  // ===========================================================================

  const consolidateItemsBySid = (items) => {
    const groups = {};
    for (const item of items) {
      const sid =
        (item.sid || item.ingredient_name || item.id || '').toString().trim() ||
        'unknown';
      if (!groups[sid]) {
        groups[sid] = {
          sid,
          ingredient_name: item.ingredient_name,
          product_id: item.product_id,
          unit: item.unit || '',
          inventory_tracked: item.inventory_tracked !== false,
          quantity_needed: 0,
          quantity_fulfilled: 0,
          itemCount: 0,
          anyFulfilled: false,
          allFulfilled: true,
          anyStagingItems: false,
          underlyingItems: [],
          allItems: [],
        };
      }
      const g = groups[sid];
      if (!g.product_id && item.product_id) g.product_id = item.product_id;
      g.quantity_needed += Number(item.quantity_needed) || 0;
      g.quantity_fulfilled += Number(item.quantity_fulfilled) || 0;
      g.itemCount += 1;
      if (item.status === STAGING_ITEM_STATUS.FULFILLED) g.anyFulfilled = true;
      else g.allFulfilled = false;
      const ids = item.staging_item_ids;
      const hasStaging =
        ids &&
        (Array.isArray(ids)
          ? ids.length > 0
          : typeof ids === 'string' &&
            ids.trim() &&
            !['[]', 'null'].includes(ids.trim()));
      if (hasStaging) g.anyStagingItems = true;
      if (item.status !== STAGING_ITEM_STATUS.FULFILLED) g.underlyingItems.push(item);
      g.allItems.push(item);
      if (hasStaging && item.id)
        (g.itemsWithStaging = g.itemsWithStaging || []).push(item);
    }
    return Object.values(groups);
  };

  // ===========================================================================
  // Modal openers
  // ===========================================================================

  const openStageModal = (requestId, itemOrGroup, requestBatchUid) => {
    const resolved = Array.isArray(itemOrGroup.underlyingItems)
      ? {
          ...itemOrGroup,
          quantity_needed: itemOrGroup.quantity_needed,
          quantity_fulfilled: itemOrGroup.quantity_fulfilled || 0,
          product_id:
            itemOrGroup.product_id ||
            itemOrGroup.underlyingItems[0]?.product_id,
          sid: itemOrGroup.sid,
          ingredient_name: itemOrGroup.ingredient_name,
          unit: itemOrGroup.unit,
        }
      : itemOrGroup;

    let resolvedItem = resolved;
    if (!resolvedItem.product_id && resolvedItem.sid) {
      const match = products.find(
        (p) =>
          p.sid === resolvedItem.sid ||
          (p.sid && p.sid.toString() === resolvedItem.sid)
      );
      if (match) resolvedItem = { ...resolvedItem, product_id: match.id };
    }

    setQuickStageProps({
      requestId,
      item: resolvedItem,
      requestBatchUid,
      underlyingItems: itemOrGroup.underlyingItems,
    });
  };

  const openMarkUsedModal = async (requestId, itemOrGroup) => {
    const allDetails = await fetchStagingDetailsForGroup(requestId, itemOrGroup);
    if (allDetails.length === 0) {
      setError(
        'No staged items available to mark as used. Items may already be fully used or returned.'
      );
      return;
    }
    setMarkUsedProps({ requestId, item: itemOrGroup, details: allDetails });
  };

  const openReturnModal = async (requestId, itemOrGroup) => {
    const allDetails = await fetchStagingDetailsForGroup(requestId, itemOrGroup);
    if (allDetails.length === 0) {
      setError(
        'No staged items available to return. Items may already be fully used or returned.'
      );
      return;
    }
    setReturnProps({ requestId, item: itemOrGroup, details: allDetails });
  };

  const openCloseOutModal = async (sr) => {
    setCloseOutProps({ requestId: sr.id, data: null, loading: true, error: null });
    try {
      await apiClient.post(`/service/staging-requests/${sr.id}/sync`, {});
      const resp = await apiClient.get(
        `/service/staging-requests/${sr.id}/close-out-data`
      );
      setCloseOutProps({ requestId: sr.id, data: resp.data, loading: false, error: null });
    } catch (err) {
      setCloseOutProps((prev) =>
        prev
          ? {
              ...prev,
              loading: false,
              error: err.response?.data?.detail || 'Failed to load',
            }
          : null
      );
    }
  };

  // ===========================================================================
  // Batch actions (dismiss / sync)
  // ===========================================================================

  const handleDismiss = async (requestId) => {
    if (
      !window.confirm(
        'Dismiss this staging request? Nothing was staged. This cannot be undone.'
      )
    )
      return;
    setSubmittingDismiss(true);
    try {
      await apiClient.post(`/service/staging-requests/${requestId}/dismiss`, {});
      fetchRequests();
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to dismiss.');
    } finally {
      setSubmittingDismiss(false);
    }
  };

  const handleSync = async (requestId) => {
    setSyncingId(requestId);
    setSyncResult(null);
    try {
      const resp = await apiClient.post(
        `/service/staging-requests/${requestId}/sync`,
        {}
      );
      setSyncResult({ requestId, ...resp.data });
      fetchRequests();
    } catch (err) {
      console.error('Error syncing with Production:', err);
      setSyncResult({
        requestId,
        error:
          err.response?.data?.detail ||
          'Could not reach Production app. Please try again.',
      });
    } finally {
      setSyncingId(null);
    }
  };

  // ===========================================================================
  // Print full staging sheet (per request, with lot data)
  // ===========================================================================

  const printFullStagingSheet = async (sr) => {
    try {
      setPrintingSheetId(sr.id);
      const containerUnits = [
        'barrels', 'bags', 'drums', 'totes', 'pails',
        'bottles', 'cases', 'pallets', 'gallons', 'liters',
      ];

      // Group items by SID
      const groupsBySid = {};
      for (const item of sr.items) {
        const sid =
          (item.sid || item.ingredient_name || item.id || '').toString().trim() ||
          'unknown';
        if (!groupsBySid[sid]) {
          groupsBySid[sid] = {
            sid,
            ingredient_name: item.ingredient_name,
            product_id: item.product_id,
            unit: item.unit || '',
            inventory_tracked: item.inventory_tracked !== false,
            quantity_needed: 0,
            quantity_fulfilled: 0,
            itemCount: 0,
            anyFulfilled: false,
            allFulfilled: true,
          };
        }
        const g = groupsBySid[sid];
        if (!g.product_id && item.product_id) g.product_id = item.product_id;
        g.quantity_needed += Number(item.quantity_needed) || 0;
        g.quantity_fulfilled += Number(item.quantity_fulfilled) || 0;
        g.itemCount += 1;
        if (item.status === STAGING_ITEM_STATUS.FULFILLED) g.anyFulfilled = true;
        else g.allFulfilled = false;
      }

      // Fetch lots per SID
      const groupsWithLots = [];
      for (const key of Object.keys(groupsBySid)) {
        const g = groupsBySid[key];
        if (g.inventory_tracked === false) {
          groupsWithLots.push({ ...g, lots: [], notTracked: true });
          continue;
        }
        let productId = g.product_id;
        if (!productId && g.sid) {
          const match = products.find(
            (p) => p.sid === g.sid || (p.sid && p.sid.toString() === g.sid)
          );
          if (match) productId = match.id;
        }
        let lots = [];
        if (productId && g.quantity_needed > 0) {
          try {
            const resp = await apiClient.get('/inventory/staging/suggest-lots', {
              params: { product_id: productId, quantity: g.quantity_needed },
            });
            lots = Array.isArray(resp.data) ? resp.data : [];
          } catch (e) {
            console.warn(`Could not fetch lots for ${g.sid}:`, e);
          }
        }
        groupsWithLots.push({ ...g, lots });
      }

      // Build HTML rows
      const rows = [];
      for (const g of groupsWithLots) {
        const rem = g.quantity_needed - g.quantity_fulfilled;
        const statusLabel = g.allFulfilled
          ? '✓ Fulfilled'
          : g.anyFulfilled
          ? '◐ Partial'
          : '○ Pending';
        const bgStyle = g.allFulfilled ? ' style="background:#f0fff0"' : '';

        if (g.notTracked) {
          const nameSuffix =
            g.itemCount > 1
              ? ` <span style="color:#888;font-size:11px">(×${g.itemCount})</span>`
              : '';
          rows.push(
            `<tr style="background:#f8f9fa;opacity:0.7"><td>${escapeHtml(g.ingredient_name) || '—'}${nameSuffix}</td><td style="font-family:monospace">${escapeHtml(g.sid) || '—'}</td><td style="text-align:right;font-weight:600">${g.quantity_needed.toLocaleString()} ${escapeHtml(g.unit) || ''}</td><td style="color:#6c757d;font-style:italic">Not inventory tracked — no staging needed</td><td style="text-align:center;color:#6c757d">N/A</td><td></td></tr>`
          );
          continue;
        }

        if (g.lots.length > 0 && !g.allFulfilled) {
          const needed = rem > 0 ? rem : g.quantity_needed;
          const allocatedLots = [];
          let remaining = needed;
          for (const lot of g.lots) {
            if (remaining <= 0) break;
            const take = Math.min(lot.available_quantity, remaining);
            allocatedLots.push({ ...lot, allocated: parseFloat(take.toFixed(3)) });
            remaining -= take;
          }
          const lotsToShow =
            allocatedLots.length > 0 ? allocatedLots : g.lots.slice(0, 1);

          const lotLines = lotsToShow
            .map((lot) => {
              const locParts = [
                lot.location_name,
                lot.sub_location_name,
                lot.storage_row_name,
              ].filter(Boolean);
              const locName = locParts.length > 0 ? locParts.map(escapeHtml).join(' → ') : '—';
              const expDate = lot.expiration_date
                ? formatDate(lot.expiration_date)
                : '—';
              const qtyToShow = lot.allocated || lot.available_quantity;
              const lotUnit = lot.unit || '';
              let qtyLabel = `${qtyToShow.toLocaleString()} ${escapeHtml(lotUnit)}`;
              if (
                lot.weight_per_container &&
                lot.container_unit &&
                lot.weight_per_container > 0
              ) {
                const containerCount = Math.ceil(
                  qtyToShow / lot.weight_per_container
                );
                qtyLabel = `<strong style="font-size:14px">${containerCount} ${escapeHtml(lot.container_unit)}</strong> <span style="color:#555;font-weight:normal">(${qtyToShow.toLocaleString()} ${escapeHtml(lotUnit)})</span>`;
              } else if (
                containerUnits.includes((lotUnit || '').toLowerCase())
              ) {
                qtyLabel = `<strong style="font-size:14px">${Math.ceil(qtyToShow)} ${escapeHtml(lotUnit)}</strong>`;
              } else {
                qtyLabel = `<strong>${qtyToShow.toLocaleString()} ${escapeHtml(lotUnit)}</strong>`;
              }
              return `<div style="margin-bottom:4px">${qtyLabel}<br><span style="color:#555">Lot: </span><span style="font-family:monospace">${escapeHtml(lot.lot_number) || '—'}</span> <span style="color:#555">| Location: </span>${locName} <span style="color:#999">(exp: ${expDate})</span></div>`;
            })
            .join('');

          let qtyDisplay = `${g.quantity_needed.toLocaleString()} ${g.unit || ''}`;
          const refLot = g.lots[0];
          if (
            refLot &&
            refLot.weight_per_container &&
            refLot.container_unit &&
            refLot.weight_per_container > 0
          ) {
            const totalContainers = Math.ceil(
              g.quantity_needed / refLot.weight_per_container
            );
            qtyDisplay = `<strong style="font-size:14px">${totalContainers} ${escapeHtml(refLot.container_unit)}</strong><div style="font-size:10px;color:#555;margin-top:2px">(${g.quantity_needed.toLocaleString()} ${escapeHtml(g.unit) || ''})</div>`;
          } else if (
            refLot &&
            containerUnits.includes((refLot.unit || '').toLowerCase())
          ) {
            qtyDisplay = `${g.quantity_needed.toLocaleString()} ${escapeHtml(g.unit) || ''}<div style="font-size:10px;color:#c00;margin-top:2px">⚠ Lots stored in ${escapeHtml(refLot.unit)}</div>`;
          }
          const nameSuffix =
            g.itemCount > 1
              ? ` <span style="color:#888;font-size:11px">(×${g.itemCount} batches)</span>`
              : '';
          rows.push(
            `<tr${bgStyle}><td>${escapeHtml(g.ingredient_name) || '—'}${nameSuffix}</td><td style="font-family:monospace">${escapeHtml(g.sid) || '—'}</td><td style="text-align:right;font-weight:600">${qtyDisplay}</td><td style="font-size:11px;line-height:1.5">${lotLines}</td><td style="text-align:center">${statusLabel}</td><td></td></tr>`
          );
        } else {
          const nameSuffix =
            g.itemCount > 1
              ? ` <span style="color:#888;font-size:11px">(×${g.itemCount})</span>`
              : '';
          rows.push(
            `<tr${bgStyle}><td>${escapeHtml(g.ingredient_name) || '—'}${nameSuffix}</td><td style="font-family:monospace">${escapeHtml(g.sid) || '—'}</td><td style="text-align:right;font-weight:600">${g.quantity_needed.toLocaleString()} ${escapeHtml(g.unit) || ''}</td><td style="color:#999;font-size:11px">${g.allFulfilled ? 'Already staged (' + g.quantity_fulfilled.toLocaleString() + ' ' + escapeHtml(g.unit || '') + ')' : 'No lots available'}</td><td style="text-align:center">${statusLabel}</td><td></td></tr>`
          );
        }
      }

      const trackedItems = sr.items.filter((i) => i.inventory_tracked !== false);
      const fulfilledCount = trackedItems.filter((i) => i.status === STAGING_ITEM_STATUS.FULFILLED).length;
      const totalCount = trackedItems.length;
      const pendingItems = trackedItems.filter((i) => i.status !== STAGING_ITEM_STATUS.FULFILLED);
      const html = `<html><head><title>Staging Sheet — ${escapeHtml(sr.production_batch_uid)}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;padding:24px;color:#222}h1{font-size:22px;margin-bottom:4px}h2{font-size:16px;margin-top:20px;margin-bottom:8px;color:#333;border-bottom:2px solid #333;padding-bottom:4px}.meta{font-size:13px;color:#555;margin-bottom:8px;line-height:1.6}.summary{font-size:13px;margin-bottom:16px;padding:8px 12px;background:#f9f9f9;border:1px solid #ddd;border-radius:4px}table{width:100%;border-collapse:collapse;margin-top:8px}th{background:#f0f0f0;text-align:left;padding:6px 10px;border:1px solid #ccc;font-size:12px}td{padding:6px 10px;border:1px solid #ccc;font-size:12px}.footer{margin-top:32px;font-size:11px;color:#888;border-top:1px solid #ccc;padding-top:8px}.notes-area{margin-top:24px}.notes-area h3{font-size:14px;margin-bottom:6px}.notes-line{border-bottom:1px solid #ccc;height:28px}@media print{body{padding:12px}button{display:none!important}}</style></head><body><h1>Staging Pick Sheet</h1><div class="meta"><strong>Batch:</strong> ${escapeHtml(sr.production_batch_uid)}<br><strong>Product:</strong> ${escapeHtml(sr.product_name) || 'Unknown'}${sr.formula_name ? ` — ${escapeHtml(sr.formula_name)}` : ''}${sr.number_of_batches > 1 ? ` (×${sr.number_of_batches} batches)` : ''}<br><strong>Date:</strong> ${formatDate(sr.created_at)}<br><strong>Printed:</strong> ${formatDateTime(new Date().toISOString())}</div><div class="summary">Progress: ${fulfilledCount} / ${totalCount} items staged | Status: <strong>${sr.status === STAGING_REQUEST_STATUS.FULFILLED ? 'Complete' : sr.status === STAGING_REQUEST_STATUS.IN_PROGRESS ? 'In Progress' : 'Pending'}</strong>${pendingItems.length > 0 ? ` | <strong>${pendingItems.length}</strong> item(s) still to pick` : ''}</div><h2>Materials to Pick</h2><table><thead><tr><th>Ingredient</th><th>SID</th><th style="text-align:right">Qty Needed</th><th>Lot / Location / Qty to Pick</th><th style="text-align:center">Status</th><th style="width:70px;text-align:center">Picked ✓</th></tr></thead><tbody>${rows.join('')}</tbody></table><div class="notes-area"><h3>Notes</h3><div class="notes-line"></div><div class="notes-line"></div><div class="notes-line"></div></div><div class="footer">Sunberry Farms — Staging Pick Sheet | ${escapeHtml(sr.production_batch_uid)}</div></body></html>`;

      const w = window.open('', '_blank', 'width=900,height=700');
      w.document.write(html);
      w.document.close();
      w.focus();
      w.print();
    } catch (err) {
      console.error('Error generating staging sheet:', err);
      setError('Failed to generate staging sheet. Please try again.');
    } finally {
      setPrintingSheetId(null);
    }
  };

  // ===========================================================================
  // Badge helpers
  // ===========================================================================

  const getStatusBadge = (status) => {
    const map = {
      pending: { label: 'Pending', bg: '#fff3cd', color: '#856404', border: '#ffc107' },
      in_progress: { label: 'In Progress', bg: '#cce5ff', color: '#004085', border: '#b8daff' },
      fulfilled: { label: 'Fulfilled', bg: '#d4edda', color: '#155724', border: '#c3e6cb' },
      cancelled: { label: 'Dismissed', bg: '#f8d7da', color: '#721c24', border: '#f5c6cb' },
      closed: { label: 'Closed', bg: '#e2e3e5', color: '#383d41', border: '#d6d8db' },
    };
    const s = map[status] || { label: status, bg: '#e2e3e5', color: '#383d41', border: '#d6d8db' };
    return (
      <span style={{ display: 'inline-block', padding: '3px 10px', borderRadius: '12px', fontSize: '0.8rem', fontWeight: 600, backgroundColor: s.bg, color: s.color, border: `1px solid ${s.border}` }}>
        {s.label}
      </span>
    );
  };

  const getItemStatusBadge = (status) => {
    if (status === STAGING_ITEM_STATUS.FULFILLED) return <span style={{ color: '#155724', fontWeight: 600, fontSize: '0.85rem' }}>Fulfilled</span>;
    if (status === STAGING_ITEM_STATUS.PARTIALLY_FULFILLED) return <span style={{ color: '#856404', fontWeight: 600, fontSize: '0.85rem' }}>Partial</span>;
    return <span style={{ color: '#6c757d', fontWeight: 600, fontSize: '0.85rem' }}>Pending</span>;
  };


  const hasStagingIds = (obj) => {
    if (!obj || !obj.staging_item_ids) return false;
    const ids = obj.staging_item_ids;
    if (Array.isArray(ids)) return ids.length > 0;
    const s = String(ids).trim();
    return s.length > 0 && s !== '[]' && s !== 'null';
  };

  // ===========================================================================
  // Item action buttons
  // ===========================================================================

  const renderItemActions = (sr, g) => {
    const hasStagingItems = g.anyStagingItems || hasStagingIds(g);
    const isNotTracked = g.inventory_tracked === false;
    const isFullyFulfilled = g.allFulfilled || g.status === STAGING_ITEM_STATUS.FULFILLED;

    if (isNotTracked) {
      return (
        <span style={{ fontSize: '0.75rem', color: '#6c757d', fontStyle: 'italic' }}>
          No staging needed
        </span>
      );
    }

    return (
      <div style={{ display: 'flex', gap: '4px', justifyContent: 'center', flexWrap: 'wrap' }}>
        {!isFullyFulfilled && (
          <button
            onClick={() => openStageModal(sr.id, g, sr.production_batch_uid)}
            style={{ padding: '3px 10px', borderRadius: '4px', border: '1px solid #007bff', backgroundColor: '#007bff', color: 'white', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 500 }}
          >
            Stage
          </button>
        )}
        {hasStagingItems && (
          <>
            <button onClick={() => openMarkUsedModal(sr.id, g)} style={{ padding: '3px 10px', borderRadius: '4px', border: '1px solid #28a745', backgroundColor: '#28a745', color: 'white', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 500 }}>Mark Used</button>
            <button onClick={() => openReturnModal(sr.id, g)} style={{ padding: '3px 10px', borderRadius: '4px', border: '1px solid #fd7e14', backgroundColor: '#fd7e14', color: 'white', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 500 }}>Return</button>
          </>
        )}
      </div>
    );
  };

  // ===========================================================================
  // Loading screen
  // ===========================================================================

  if (loading) {
    return (
      <div className="staging-overview">
        <div className="page-header">
          <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">← Back to Dashboard</button>
          <div className="header-content"><h2>Production Staging Requests</h2></div>
        </div>
        <div style={{ padding: '2rem', textAlign: 'center' }}>Loading staging requests...</div>
      </div>
    );
  }

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div className="staging-overview">
      <div className="page-header">
        <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">← Back to Dashboard</button>
        <div className="header-content">
          <h2>Production Staging Requests</h2>
          <p className="muted">Requests from Production — stage the listed materials for each batch</p>
        </div>
      </div>

      {/* Filters */}
      <div style={{ marginBottom: '1.5rem', padding: '1rem', backgroundColor: '#f5f5f5', borderRadius: '4px', display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <label>
          <span style={{ marginRight: '0.5rem', fontWeight: 500 }}>Status:</span>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ padding: '0.4rem 0.6rem', borderRadius: '4px', border: '1px solid #ccc' }}>
            <option value="active">Active (excl. closed/dismissed)</option>
            <option value="pending">Pending</option>
            <option value="in_progress">In Progress</option>
            <option value="fulfilled">Fulfilled</option>
            <option value="closed">Closed</option>
            <option value="cancelled">Dismissed</option>
            <option value="all">All</option>
          </select>
        </label>
        <button onClick={fetchRequests} style={{ padding: '0.4rem 1rem', borderRadius: '6px', border: '1px solid #007bff', backgroundColor: '#007bff', color: 'white', cursor: 'pointer', fontWeight: 500 }}>
          Refresh
        </button>
        <button
          onClick={fetchReconciliation}
          disabled={loadingRecon}
          style={{ padding: '0.4rem 1rem', borderRadius: '6px', border: '1px solid #17a2b8', backgroundColor: '#17a2b8', color: 'white', cursor: 'pointer', fontWeight: 500, marginLeft: 'auto' }}
        >
          {loadingRecon ? 'Loading...' : 'End of Day Summary'}
        </button>
      </div>

      {error && (
        <div style={{ padding: '0.75rem 1rem', backgroundColor: '#f8d7da', color: '#721c24', borderRadius: '4px', marginBottom: '1rem', border: '1px solid #f5c6cb' }}>
          {error}
          <button onClick={() => setError('')} style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700 }}>×</button>
        </div>
      )}

      {/* Reconciliation Summary */}
      {showReconciliation && (
        <div style={{ marginBottom: '1.5rem', padding: '1rem 1.25rem', backgroundColor: '#e8f4fd', borderRadius: '8px', border: '1px solid #b8daff' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <h3 style={{ margin: 0, color: '#004085', fontSize: '1.1rem' }}>End of Day — Staging Reconciliation</h3>
            <button onClick={() => setShowReconciliation(false)} style={{ background: 'none', border: 'none', fontSize: '1.3rem', cursor: 'pointer', color: '#004085' }}>×</button>
          </div>
          {reconData.length === 0 ? (
            <p style={{ color: '#6c757d' }}>No active staging requests to reconcile.</p>
          ) : (
            reconData.map((sr) => (
              <div key={sr.id} style={{ marginBottom: '1rem', padding: '0.75rem', backgroundColor: 'white', borderRadius: '6px', border: '1px solid #dee2e6' }}>
                <div style={{ fontWeight: 700, fontSize: '0.9rem', marginBottom: '0.25rem' }}>{sr.production_batch_uid}</div>
                <div style={{ fontSize: '0.8rem', color: '#6c757d', marginBottom: '0.5rem' }}>
                  {sr.product_name} {sr.formula_name ? `— ${sr.formula_name}` : ''} · {getStatusBadge(sr.status)}
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #dee2e6', backgroundColor: '#f6f7fb' }}>
                      <th style={{ padding: '4px 8px', textAlign: 'left' }}>Ingredient</th>
                      <th style={{ padding: '4px 8px', textAlign: 'right' }}>Needed</th>
                      <th style={{ padding: '4px 8px', textAlign: 'right' }}>Staged</th>
                      <th style={{ padding: '4px 8px', textAlign: 'right' }}>Used</th>
                      <th style={{ padding: '4px 8px', textAlign: 'right' }}>Returned</th>
                      <th style={{ padding: '4px 8px', textAlign: 'right', color: '#dc3545' }}>To Return</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sr.items.map((item) => {
                      const totalStaged = item.staging_details.reduce((s, d) => s + d.quantity_staged, 0);
                      const totalUsed = item.staging_details.reduce((s, d) => s + d.quantity_used, 0);
                      const totalReturned = item.staging_details.reduce((s, d) => s + d.quantity_returned, 0);
                      const toReturn = item.staging_details.reduce((s, d) => s + d.available, 0);
                      return (
                        <tr key={item.id} style={{ borderBottom: '1px solid #dee2e6' }}>
                          <td style={{ padding: '4px 8px' }}>{item.ingredient_name}</td>
                          <td style={{ padding: '4px 8px', textAlign: 'right' }}>{item.quantity_needed} {item.unit || ''}</td>
                          <td style={{ padding: '4px 8px', textAlign: 'right', fontWeight: 600 }}>{totalStaged.toFixed(1)}</td>
                          <td style={{ padding: '4px 8px', textAlign: 'right', color: '#155724', fontWeight: 600 }}>{totalUsed.toFixed(1)}</td>
                          <td style={{ padding: '4px 8px', textAlign: 'right', color: '#6c757d' }}>{totalReturned.toFixed(1)}</td>
                          <td style={{ padding: '4px 8px', textAlign: 'right', color: toReturn > 0 ? '#dc3545' : '#6c757d', fontWeight: toReturn > 0 ? 700 : 400 }}>
                            {toReturn > 0 ? toReturn.toFixed(1) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </div>
      )}

      {/* Request list */}
      {requests.length === 0 ? (
        <div style={{ padding: '3rem', textAlign: 'center', color: '#6c757d', backgroundColor: 'white', borderRadius: '8px', border: '1px solid #dee2e6' }}>
          <p style={{ fontSize: '1.1rem', marginBottom: '0.5rem' }}>No {statusFilter === 'active' ? 'active' : statusFilter !== 'all' ? statusFilter : ''} staging requests</p>
          <p style={{ fontSize: '0.9rem' }}>Requests appear here when QA creates batches in the Production system</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {requests.map((sr) => {
            const isExpanded = expandedId === sr.id;
            const consolidated = consolidateItemsBySid(sr.items);
            const trackedGroups = consolidated.filter((g) => g.inventory_tracked !== false);
            const fulfilledCount = trackedGroups.filter((g) => g.allFulfilled).length;
            const totalCount = trackedGroups.length;
            const isOverdue =
              sr.production_date &&
              new Date(sr.production_date + 'T23:59:59') < new Date() &&
              ![STAGING_REQUEST_STATUS.CLOSED, STAGING_REQUEST_STATUS.CANCELLED].includes(sr.status);
            const prodDateLabel = sr.production_date
              ? formatDate(sr.production_date + 'T12:00:00')
              : null;
            const hasAnyStaging = consolidated.some((g) => g.anyStagingItems);
            const canDismiss = isOverdue && !hasAnyStaging;
            const canCloseOut = isOverdue && hasAnyStaging;

            return (
              <div key={sr.id} style={{ backgroundColor: 'white', borderRadius: '8px', border: isOverdue ? '2px solid #dc3545' : '1px solid #dee2e6', overflow: 'hidden' }}>
                {/* Overdue banner */}
                {isOverdue && (
                  <div style={{ padding: '0.4rem 1.25rem', backgroundColor: '#f8d7da', color: '#721c24', fontSize: '0.8rem', fontWeight: 600, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <span>OVERDUE — Production date was {prodDateLabel}. {canDismiss ? 'Nothing was staged.' : 'Reconcile leftovers and close out.'}</span>
                    <span style={{ display: 'flex', gap: '0.5rem' }}>
                      {canDismiss && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDismiss(sr.id); }}
                          disabled={submittingDismiss}
                          style={{ padding: '4px 12px', borderRadius: '4px', border: '1px solid #721c24', backgroundColor: '#f8d7da', color: '#721c24', fontSize: '0.75rem', fontWeight: 600, cursor: submittingDismiss ? 'wait' : 'pointer' }}
                        >
                          {submittingDismiss ? 'Dismissing...' : 'Dismiss'}
                        </button>
                      )}
                      {canCloseOut && (
                        <button
                          onClick={(e) => { e.stopPropagation(); openCloseOutModal(sr); }}
                          style={{ padding: '4px 12px', borderRadius: '4px', border: '1px solid #0d6efd', backgroundColor: '#0d6efd', color: 'white', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer' }}
                        >
                          Close Out
                        </button>
                      )}
                    </span>
                  </div>
                )}

                {/* Card header */}
                <div
                  onClick={() => setExpandedId(expandedId === sr.id ? null : sr.id)}
                  style={{ padding: '1rem 1.25rem', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: isExpanded ? '#f8f9fa' : 'white', borderBottom: isExpanded ? '1px solid #dee2e6' : 'none', transition: 'background 0.15s' }}
                >
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: '0.25rem', color: '#212529' }}>{sr.production_batch_uid}</div>
                    <div style={{ fontSize: '0.9rem', color: '#495057' }}>
                      {sr.product_name || 'Unknown product'}{sr.formula_name ? ` — ${sr.formula_name}` : ''}{sr.number_of_batches > 1 ? ` (×${sr.number_of_batches} batches)` : ''}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: '#6c757d', marginTop: '0.25rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
                      {prodDateLabel && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                          <span style={{ fontSize: '0.9rem' }}>📅</span> {prodDateLabel}
                        </span>
                      )}
                      <span>·</span>
                      <span>{formatDate(sr.created_at)}</span>
                      <span>·</span>
                      <span>{fulfilledCount}/{totalCount} items staged</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    {getStatusBadge(sr.status)}
                    <span style={{ fontSize: '1.2rem', color: '#6c757d' }}>{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </div>

                {/* Expanded items table */}
                {isExpanded && (
                  <div style={{ padding: '1rem 1.25rem' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid #dee2e6', backgroundColor: '#f6f7fb' }}>
                          <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left' }}>Ingredient</th>
                          <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left' }}>SID</th>
                          <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>Qty Needed</th>
                          <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>Qty Staged</th>
                          <th style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>Status</th>
                          <th style={{ padding: '0.5rem 0.75rem', textAlign: 'center', minWidth: '180px' }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {consolidated.map((g) => (
                          <tr key={g.sid} style={{ borderBottom: '1px solid #dee2e6', backgroundColor: g.inventory_tracked === false ? '#f8f9fa' : g.allFulfilled ? '#f0fff0' : 'transparent', opacity: g.inventory_tracked === false ? 0.7 : 1 }}>
                            <td style={{ padding: '0.5rem 0.75rem' }}>
                              {g.ingredient_name}
                              {g.itemCount > 1 && sr.number_of_batches > 1 && (
                                <span style={{ marginLeft: '6px', fontSize: '0.7rem', color: '#6c757d' }}>(×{sr.number_of_batches} batches)</span>
                              )}
                              {g.inventory_tracked === false && (
                                <span style={{ marginLeft: '6px', fontSize: '0.65rem', color: '#6c757d', backgroundColor: '#e9ecef', padding: '1px 5px', borderRadius: '3px' }}>
                                  not tracked
                                </span>
                              )}
                            </td>
                            <td style={{ padding: '0.5rem 0.75rem', fontFamily: 'monospace', fontSize: '0.8rem', color: '#6c757d' }}>{g.sid}</td>
                            <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontWeight: 600 }}>{g.quantity_needed.toLocaleString()} {g.unit || ''}</td>
                            <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontWeight: 600, color: g.quantity_fulfilled >= g.quantity_needed ? '#155724' : g.quantity_fulfilled > 0 ? '#856404' : '#6c757d' }}>
                              {g.quantity_fulfilled.toLocaleString()} {g.unit || ''}
                            </td>
                            <td style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>
                              {g.inventory_tracked === false
                                ? <span style={{ color: '#6c757d', fontWeight: 600, fontSize: '0.85rem' }}>N/A</span>
                                : getItemStatusBadge(g.allFulfilled ? STAGING_ITEM_STATUS.FULFILLED : g.anyFulfilled ? STAGING_ITEM_STATUS.PARTIALLY_FULFILLED : STAGING_ITEM_STATUS.PENDING)
                              }
                            </td>
                            <td style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>
                              {renderItemActions(sr, g)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {/* Sync + Print row */}
                    <div style={{ marginTop: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleSync(sr.id); }}
                          disabled={syncingId === sr.id}
                          style={{ padding: '6px 16px', borderRadius: '6px', border: '1px solid #17a2b8', backgroundColor: syncingId === sr.id ? '#adb5bd' : '#17a2b8', color: 'white', fontSize: '0.85rem', cursor: syncingId === sr.id ? 'wait' : 'pointer', fontWeight: 500 }}
                        >
                          {syncingId === sr.id ? 'Syncing...' : 'Sync with Production'}
                        </button>
                        {canDismiss && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDismiss(sr.id); }}
                            disabled={submittingDismiss}
                            style={{ padding: '6px 16px', borderRadius: '6px', border: '1px solid #721c24', backgroundColor: submittingDismiss ? '#adb5bd' : '#f8d7da', color: '#721c24', fontSize: '0.85rem', cursor: submittingDismiss ? 'wait' : 'pointer', fontWeight: 500 }}
                          >
                            {submittingDismiss ? 'Dismissing...' : 'Dismiss'}
                          </button>
                        )}
                        {canCloseOut && (
                          <button
                            onClick={(e) => { e.stopPropagation(); openCloseOutModal(sr); }}
                            style={{ padding: '6px 16px', borderRadius: '6px', border: '1px solid #0d6efd', backgroundColor: '#0d6efd', color: 'white', fontSize: '0.85rem', cursor: 'pointer', fontWeight: 500 }}
                          >
                            Close Out
                          </button>
                        )}
                        {sr.last_synced_at && (
                          <span style={{ fontSize: '0.75rem', color: '#6c757d' }}>
                            Last synced: {formatDateTime(sr.last_synced_at)}
                          </span>
                        )}
                      </div>
                      {syncResult && syncResult.requestId === sr.id && (
                        <div style={{ fontSize: '0.8rem', padding: '4px 10px', borderRadius: '4px', backgroundColor: syncResult.error ? '#f8d7da' : '#d4edda', color: syncResult.error ? '#721c24' : '#155724', fontWeight: 500 }}>
                          {syncResult.error
                            ? syncResult.error
                            : `${syncResult.batches_completed}/${syncResult.total_batches} batches completed · ${syncResult.marked_count} item(s) synced`}
                        </div>
                      )}
                      <button
                        onClick={() => printFullStagingSheet(sr)}
                        disabled={printingSheetId === sr.id}
                        style={{ padding: '6px 16px', borderRadius: '6px', border: '1px solid #6c757d', backgroundColor: printingSheetId === sr.id ? '#adb5bd' : '#6c757d', color: 'white', fontSize: '0.85rem', cursor: printingSheetId === sr.id ? 'wait' : 'pointer', fontWeight: 500 }}
                      >
                        {printingSheetId === sr.id ? 'Loading lots...' : 'Print Staging Sheet'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Modals ──────────────────────────────────────────────────────────── */}

      {quickStageProps && (
        <QuickStageModal
          requestId={quickStageProps.requestId}
          item={quickStageProps.item}
          requestBatchUid={quickStageProps.requestBatchUid}
          underlyingItems={quickStageProps.underlyingItems}
          onClose={() => setQuickStageProps(null)}
          onSuccess={fetchRequests}
        />
      )}

      {markUsedProps && (
        <MarkUsedModal
          requestId={markUsedProps.requestId}
          item={markUsedProps.item}
          details={markUsedProps.details}
          onClose={() => setMarkUsedProps(null)}
          onSuccess={fetchRequests}
        />
      )}

      {returnProps && (
        <ReturnModal
          requestId={returnProps.requestId}
          item={returnProps.item}
          details={returnProps.details}
          onClose={() => setReturnProps(null)}
          onSuccess={fetchRequests}
        />
      )}

      {closeOutProps && (
        <CloseOutModal
          requestId={closeOutProps.requestId}
          data={closeOutProps.data}
          loading={closeOutProps.loading}
          error={closeOutProps.error}
          onClose={() => setCloseOutProps(null)}
          onSuccess={fetchRequests}
        />
      )}
    </div>
  );
};

export default ProductionStagingRequests;
