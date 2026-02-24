import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAppData } from '../context/AppDataContext';
import { getDashboardPath } from '../App';
import axios from 'axios';
import './StagingOverview.css'; // Re-use staging styles

const API_BASE_URL = '/api';

const ProductionStagingRequests = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { locations, subLocationMap, products } = useAppData();

  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const [expandedId, setExpandedId] = useState(null);

  // Quick Stage modal state
  const [modal, setModal] = useState(null); // { requestId, item, requestBatchUid }
  const [modalLocation, setModalLocation] = useState('');
  const [modalSubLocation, setModalSubLocation] = useState('');
  const [lotSuggestions, setLotSuggestions] = useState([]);
  const [lotAllocations, setLotAllocations] = useState({}); // receipt_id -> quantity
  const [loadingLots, setLoadingLots] = useState(false);
  const [submittingStage, setSubmittingStage] = useState(false);
  const [modalError, setModalError] = useState('');
  const [modalSuccess, setModalSuccess] = useState('');
  const [pickSheetData, setPickSheetData] = useState(null);

  // Mark Used modal state
  const [markUsedModal, setMarkUsedModal] = useState(null); // { requestId, item }
  const [markUsedDetails, setMarkUsedDetails] = useState([]); // staging items with details
  const [markUsedQuantities, setMarkUsedQuantities] = useState({}); // staging_item_id -> qty
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [submittingMarkUsed, setSubmittingMarkUsed] = useState(false);

  // Return modal state
  const [returnModal, setReturnModal] = useState(null); // { requestId, item }
  const [returnDetails, setReturnDetails] = useState([]);
  const [returnQuantities, setReturnQuantities] = useState({});
  const [returnLocation, setReturnLocation] = useState('');
  const [returnSubLocation, setReturnSubLocation] = useState('');
  const [submittingReturn, setSubmittingReturn] = useState(false);

  // Sync with Production state
  const [syncingId, setSyncingId] = useState(null); // request ID being synced
  const [syncResult, setSyncResult] = useState(null); // { requestId, ... }

  // Reconciliation
  const [showReconciliation, setShowReconciliation] = useState(false);
  const [reconData, setReconData] = useState([]);
  const [loadingRecon, setLoadingRecon] = useState(false);

  // General modal error/success (for mark-used, return, undo)
  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');

  // Print sheet state
  const [printingSheetId, setPrintingSheetId] = useState(null);

  // Close Out modal state
  const [closeOutModal, setCloseOutModal] = useState(null); // { requestId, data, loading }
  const [loadingCloseOut, setLoadingCloseOut] = useState(false);
  const [submittingDismiss, setSubmittingDismiss] = useState(false);
  const [submittingCloseOut, setSubmittingCloseOut] = useState(false);

  useEffect(() => {
    fetchRequests();
  }, [statusFilter]);

  const getAuthHeaders = () => {
    const token = localStorage.getItem('token');
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  };

  const fetchRequests = async () => {
    try {
      setLoading(true);
      setError('');
      const params = statusFilter ? `?status_filter=${statusFilter}` : '';
      const response = await axios.get(
        `${API_BASE_URL}/service/staging-requests${params}`,
        { headers: getAuthHeaders() }
      );
      setRequests(Array.isArray(response.data) ? response.data : []);
    } catch (err) {
      console.error('Error fetching staging requests:', err);
      setError(err.response?.data?.detail || 'Failed to load staging requests.');
      setRequests([]);
    } finally {
      setLoading(false);
    }
  };

  const toggleExpand = (id) => {
    setExpandedId(expandedId === id ? null : id);
  };

  // ===========================================================================
  // Quick Stage modal helpers
  // ===========================================================================

  const subLocOptions = useMemo(() => {
    if (!modalLocation) return [];
    return subLocationMap[modalLocation] || [];
  }, [modalLocation, subLocationMap]);

  // Consolidate items by SID for display (same as print sheet)
  const consolidateItemsBySid = (items) => {
    const groups = {};
    for (const item of items) {
      const sid = (item.sid || item.ingredient_name || item.id || '').toString().trim() || 'unknown';
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
          allItems: [], // keep all items for action buttons (including fulfilled)
        };
      }
      const g = groups[sid];
      if (!g.product_id && item.product_id) g.product_id = item.product_id;
      g.quantity_needed += Number(item.quantity_needed) || 0;
      g.quantity_fulfilled += Number(item.quantity_fulfilled) || 0;
      g.itemCount += 1;
      if (item.status === 'fulfilled') g.anyFulfilled = true;
      else g.allFulfilled = false;
      const ids = item.staging_item_ids;
      const hasStaging = ids && (Array.isArray(ids) ? ids.length > 0 : (typeof ids === 'string' && ids.trim() && !['[]', 'null'].includes(ids.trim())));
      if (hasStaging) g.anyStagingItems = true;
      if (item.status !== 'fulfilled') g.underlyingItems.push(item);
      g.allItems.push(item);
      if (hasStaging && item.id) (g.itemsWithStaging = g.itemsWithStaging || []).push(item);
    }
    return Object.values(groups);
  };

  const openStageModal = (requestId, itemOrGroup, requestBatchUid) => {
    // itemOrGroup: single item { id, quantity_needed, ... } OR consolidated group { quantity_needed, quantity_fulfilled, underlyingItems: [...] }
    const resolved = Array.isArray(itemOrGroup.underlyingItems) ? {
      ...itemOrGroup,
      quantity_needed: itemOrGroup.quantity_needed,
      quantity_fulfilled: itemOrGroup.quantity_fulfilled || 0,
      product_id: itemOrGroup.product_id || itemOrGroup.underlyingItems[0]?.product_id,
      sid: itemOrGroup.sid,
      ingredient_name: itemOrGroup.ingredient_name,
      unit: itemOrGroup.unit,
    } : itemOrGroup;
    let resolvedItem = resolved;
    if (!resolvedItem.product_id && resolvedItem.sid) {
      const match = products.find((p) => p.sid === resolvedItem.sid || (p.sid && p.sid.toString() === resolvedItem.sid));
      if (match) resolvedItem = { ...resolvedItem, product_id: match.id };
    }
    setModal({ requestId, item: resolvedItem, requestBatchUid, underlyingItems: itemOrGroup.underlyingItems });
    setModalLocation('');
    setModalSubLocation('');
    setLotSuggestions([]);
    setLotAllocations({});
    setModalError('');
    setModalSuccess('');
    setPickSheetData(null);
  };

  const closeModal = () => {
    setModal(null);
    setLotSuggestions([]);
    setLotAllocations({});
    setModalError('');
    setModalSuccess('');
    setPickSheetData(null);
  };

  const fetchLotSuggestions = async () => {
    if (!modal?.item?.product_id) {
      setModalError(`No matching product found in Inventory for SID "${modal?.item?.sid || '?'}". Make sure this product exists in Inventory with the correct SID.`);
      return;
    }
    if (!modalLocation) {
      setModalError('Please select a staging location first.');
      return;
    }

    try {
      setLoadingLots(true);
      setModalError('');
      const rem = modal.item.quantity_needed - (modal.item.quantity_fulfilled || 0);
      // Fetch more than needed so warehouse can see full bags
      const fetchQty = rem * 3; // fetch extra to show full lot options
      const response = await axios.get(
        `${API_BASE_URL}/inventory/staging/suggest-lots?product_id=${modal.item.product_id}&quantity=${fetchQty}`,
        { headers: getAuthHeaders() }
      );
      const lots = Array.isArray(response.data) ? response.data : [];
      setLotSuggestions(lots);

      // Auto-allocate FEFO: fill from top until quantity met
      const allocs = {};
      let needed = rem;
      for (const lot of lots) {
        if (needed <= 0) break;
        const take = Math.min(lot.available_quantity, needed);
        allocs[lot.receipt_id] = parseFloat(take.toFixed(3));
        needed -= take;
      }
      setLotAllocations(allocs);
    } catch (err) {
      console.error('Error fetching lot suggestions:', err);
      setModalError(err.response?.data?.detail || 'Failed to fetch available lots.');
      setLotSuggestions([]);
    } finally {
      setLoadingLots(false);
    }
  };

  useEffect(() => {
    if (modal && modalLocation) {
      fetchLotSuggestions();
    }
  }, [modalLocation]);

  const totalAllocated = Object.values(lotAllocations).reduce((s, v) => s + (parseFloat(v) || 0), 0);
  const remaining = modal ? (modal.item.quantity_needed - (modal.item.quantity_fulfilled || 0)) : 0;

  const handleConfirmStage = async () => {
    if (!modalLocation) {
      setModalError('Please select a staging location.');
      return;
    }

    const lots = Object.entries(lotAllocations)
      .filter(([, qty]) => parseFloat(qty) > 0)
      .map(([receiptId, qty]) => ({
        receipt_id: receiptId,
        quantity: parseFloat(qty),
      }));

    if (lots.length === 0) {
      setModalError('Please allocate quantity to at least one lot.');
      return;
    }

    try {
      setSubmittingStage(true);
      setModalError('');

      // 1. Call staging/transfer API
      const transferPayload = {
        staging_location_id: modalLocation,
        staging_sub_location_id: modalSubLocation || null,
        items: [
          {
            product_id: modal.item.product_id,
            quantity_needed: totalAllocated,
            lots: lots,
          },
        ],
      };

      const transferResponse = await axios.post(`${API_BASE_URL}/inventory/staging/transfer`, transferPayload, {
        headers: getAuthHeaders(),
      });

      // Extract staging_item_ids from transfer response
      const stagingItemIds = (transferResponse.data?.staging_items || []).map((si) => si.id);

      // 2. Call fulfill-item API: for consolidated groups, fulfill each underlying item
      const underlyingItems = modal.underlyingItems || (modal.item.id ? [modal.item] : []);
      if (underlyingItems.length > 0) {
        let remainingToAllocate = Math.min(totalAllocated, remaining);
        for (const it of underlyingItems) {
          const itemRem = (it.quantity_needed || 0) - (it.quantity_fulfilled || 0);
          if (itemRem <= 0) continue;
          const fulfillQty = Math.min(itemRem, remainingToAllocate);
          if (fulfillQty <= 0) break;
          await axios.post(
            `${API_BASE_URL}/service/staging-requests/${modal.requestId}/fulfill-item?item_id=${it.id}&quantity_fulfilled=${fulfillQty}`,
            { staging_item_ids: stagingItemIds },
            { headers: getAuthHeaders() }
          );
          remainingToAllocate -= fulfillQty;
        }
      } else {
        const fulfillQty = Math.min(totalAllocated, remaining);
        await axios.post(
          `${API_BASE_URL}/service/staging-requests/${modal.requestId}/fulfill-item?item_id=${modal.item.id}&quantity_fulfilled=${fulfillQty}`,
          { staging_item_ids: stagingItemIds },
          { headers: getAuthHeaders() }
        );
      }

      // Build pick-sheet data
      const stagingLocationName = (locations || []).find((l) => l.id === modalLocation)?.name || '';
      const stagingSubLocName = modalSubLocation
        ? (subLocationMap[modalLocation] || []).find((s) => s.id === modalSubLocation)?.name || ''
        : '';

      const pickLines = lots.map((lot) => {
        const suggestion = lotSuggestions.find((s) => s.receipt_id === lot.receipt_id) || {};
        const locParts = [suggestion.location_name, suggestion.sub_location_name, suggestion.storage_row_name].filter(Boolean);
        // Calculate container count if weight info available
        let containerInfo = '';
        if (suggestion.weight_per_container && suggestion.container_unit && suggestion.weight_per_container > 0) {
          const containers = Math.ceil(lot.quantity / suggestion.weight_per_container);
          containerInfo = ` (≈ ${containers} ${suggestion.container_unit})`;
        }
        return {
          product_name: modal.item.ingredient_name,
          sid: modal.item.sid,
          lot_number: suggestion.lot_number || '—',
          quantity: lot.quantity,
          unit: modal.item.unit || '',
          containerInfo,
          pick_from: locParts.length > 0 ? locParts.join(' → ') : '—',
        };
      });

      setPickSheetData({
        batchUid: modal.requestBatchUid,
        stagingLocation: [stagingLocationName, stagingSubLocName].filter(Boolean).join(' / '),
        lines: pickLines,
        timestamp: new Date().toLocaleString(),
      });

      const overNote = totalAllocated > remaining ? ` (${(totalAllocated - remaining).toFixed(2)} ${modal.item.unit || ''} over — return unused after production)` : '';
      setModalSuccess(`Staged ${totalAllocated} ${modal.item.unit || 'units'} of ${modal.item.ingredient_name} successfully!${overNote}`);
      fetchRequests();
    } catch (err) {
      console.error('Error staging item:', err);
      setModalError(err.response?.data?.detail || 'Failed to stage item. Please try again.');
    } finally {
      setSubmittingStage(false);
    }
  };

  // ===========================================================================
  // Print pick-sheet (per item, after staging)
  // ===========================================================================

  const printPickSheet = () => {
    if (!pickSheetData) return;
    const rows = pickSheetData.lines
      .map((l) => `<tr><td>${l.product_name}</td><td style="font-family:monospace">${l.sid}</td><td style="font-family:monospace">${l.lot_number}</td><td style="text-align:right;font-weight:600">${l.quantity} ${l.unit}${l.containerInfo ? `<div style="font-size:11px;color:#555;font-weight:normal">${l.containerInfo}</div>` : ''}</td><td>${l.pick_from}</td></tr>`)
      .join('');
    const html = `<html><head><title>Staging Pick Sheet</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;padding:24px;color:#222}h1{font-size:20px;margin-bottom:4px}.meta{font-size:13px;color:#555;margin-bottom:16px}table{width:100%;border-collapse:collapse;margin-top:8px}th{background:#f0f0f0;text-align:left;padding:6px 10px;border:1px solid #ccc;font-size:13px}td{padding:6px 10px;border:1px solid #ccc;font-size:13px}.footer{margin-top:24px;font-size:12px;color:#888}@media print{body{padding:0}button{display:none!important}}</style></head><body><h1>Staging Pick Sheet</h1><div class="meta"><strong>Batch:</strong> ${pickSheetData.batchUid}<br><strong>Stage to:</strong> ${pickSheetData.stagingLocation}<br><strong>Printed:</strong> ${pickSheetData.timestamp}</div><table><thead><tr><th>Product Name</th><th>SID</th><th>Lot Number</th><th style="text-align:right">Quantity</th><th>Pick From Location</th></tr></thead><tbody>${rows}</tbody></table><div class="footer">Sunberry Farms — Staging Pick Sheet</div></body></html>`;
    const w = window.open('', '_blank', 'width=800,height=600');
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
  };

  // ===========================================================================
  // Print FULL staging sheet for an entire request (with lot & location data)
  // ===========================================================================

  const printFullStagingSheet = async (sr) => {
    try {
      setPrintingSheetId(sr.id);
      const containerUnits = ['barrels', 'bags', 'drums', 'totes', 'pails', 'bottles', 'cases', 'pallets', 'gallons', 'liters'];

      // -----------------------------------------------------------------------
      // 1. Group items by SID (consolidate duplicate ingredients across batches)
      // -----------------------------------------------------------------------
      const groupsBySid = {};
      for (const item of sr.items) {
        const sid = (item.sid || item.ingredient_name || item.id || '').toString().trim() || 'unknown';
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
        if (item.status === 'fulfilled') g.anyFulfilled = true;
        else g.allFulfilled = false;
      }

      // -----------------------------------------------------------------------
      // 2. Fetch suggest-lots ONCE per SID with TOTAL quantity (saves API calls)
      // -----------------------------------------------------------------------
      const groupsWithLots = [];
      for (const key of Object.keys(groupsBySid)) {
        const g = groupsBySid[key];
        if (g.inventory_tracked === false) {
          groupsWithLots.push({ ...g, lots: [], notTracked: true });
          continue;
        }
        let productId = g.product_id;
        if (!productId && g.sid) {
          const match = products.find((p) => p.sid === g.sid || (p.sid && p.sid.toString() === g.sid));
          if (match) productId = match.id;
        }
        let lots = [];
        if (productId && g.quantity_needed > 0) {
          try {
            const resp = await axios.get(
              `${API_BASE_URL}/inventory/staging/suggest-lots?product_id=${productId}&quantity=${g.quantity_needed}`,
              { headers: getAuthHeaders() }
            );
            lots = Array.isArray(resp.data) ? resp.data : [];
          } catch (e) {
            console.warn(`Could not fetch lots for ${g.sid}:`, e);
          }
        }
        groupsWithLots.push({ ...g, lots });
      }

      // -----------------------------------------------------------------------
      // 3. Build rows — one per consolidated ingredient
      // -----------------------------------------------------------------------
      const rows = [];
      for (const g of groupsWithLots) {
        const rem = g.quantity_needed - g.quantity_fulfilled;
        const statusLabel = g.allFulfilled ? '✓ Fulfilled' : g.anyFulfilled ? '◐ Partial' : '○ Pending';
        const bgStyle = g.allFulfilled ? ' style="background:#f0fff0"' : '';

        if (g.notTracked) {
          const nameSuffix = g.itemCount > 1 ? ` <span style="color:#888;font-size:11px">(×${g.itemCount})</span>` : '';
          rows.push(`<tr style="background:#f8f9fa;opacity:0.7"><td>${g.ingredient_name || '—'}${nameSuffix}</td><td style="font-family:monospace">${g.sid || '—'}</td><td style="text-align:right;font-weight:600">${g.quantity_needed.toLocaleString()} ${g.unit || ''}</td><td style="color:#6c757d;font-style:italic">Not inventory tracked — no staging needed</td><td style="text-align:center;color:#6c757d">N/A</td><td></td></tr>`);
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
          const lotsToShow = allocatedLots.length > 0 ? allocatedLots : g.lots.slice(0, 1);

          const lotLines = lotsToShow.map((lot) => {
            const locParts = [lot.location_name, lot.sub_location_name, lot.storage_row_name].filter(Boolean);
            const locName = locParts.length > 0 ? locParts.join(' → ') : '—';
            const expDate = lot.expiration_date ? new Date(lot.expiration_date).toLocaleDateString() : '—';
            const qtyToShow = lot.allocated || lot.available_quantity;
            const lotUnit = lot.unit || '';

            // Always round UP for warehouse — cannot pick partial barrels/bags
            let qtyLabel = `${qtyToShow.toLocaleString()} ${lotUnit}`;
            if (lot.weight_per_container && lot.container_unit && lot.weight_per_container > 0) {
              const containerCount = Math.ceil(qtyToShow / lot.weight_per_container);
              qtyLabel = `<strong style="font-size:14px">${containerCount} ${lot.container_unit}</strong> <span style="color:#555;font-weight:normal">(${qtyToShow.toLocaleString()} ${lotUnit})</span>`;
            } else if (containerUnits.includes((lotUnit || '').toLowerCase())) {
              qtyLabel = `<strong style="font-size:14px">${Math.ceil(qtyToShow)} ${lotUnit}</strong>`;
            } else {
              qtyLabel = `<strong>${qtyToShow.toLocaleString()} ${lotUnit}</strong>`;
            }

            return `<div style="margin-bottom:4px">${qtyLabel}<br><span style="color:#555">Lot: </span><span style="font-family:monospace">${lot.lot_number || '—'}</span> <span style="color:#555">| Location: </span>${locName} <span style="color:#999">(exp: ${expDate})</span></div>`;
          }).join('');

          // Qty Needed — always show container count (rounded up) when we have weight_per_container
          let qtyDisplay = `${g.quantity_needed.toLocaleString()} ${g.unit || ''}`;
          const refLot = g.lots[0];
          if (refLot && refLot.weight_per_container && refLot.container_unit && refLot.weight_per_container > 0) {
            const totalContainers = Math.ceil(g.quantity_needed / refLot.weight_per_container);
            qtyDisplay = `<strong style="font-size:14px">${totalContainers} ${refLot.container_unit}</strong><div style="font-size:10px;color:#555;margin-top:2px">(${g.quantity_needed.toLocaleString()} ${g.unit || ''})</div>`;
          } else if (refLot && containerUnits.includes((refLot.unit || '').toLowerCase())) {
            qtyDisplay = `${g.quantity_needed.toLocaleString()} ${g.unit || ''}<div style="font-size:10px;color:#c00;margin-top:2px">⚠ Lots stored in ${refLot.unit}</div>`;
          }
          const nameSuffix = g.itemCount > 1 ? ` <span style="color:#888;font-size:11px">(×${g.itemCount} batches)</span>` : '';
          rows.push(`<tr${bgStyle}><td>${g.ingredient_name || '—'}${nameSuffix}</td><td style="font-family:monospace">${g.sid || '—'}</td><td style="text-align:right;font-weight:600">${qtyDisplay}</td><td style="font-size:11px;line-height:1.5">${lotLines}</td><td style="text-align:center">${statusLabel}</td><td></td></tr>`);
        } else {
          const nameSuffix = g.itemCount > 1 ? ` <span style="color:#888;font-size:11px">(×${g.itemCount})</span>` : '';
          rows.push(`<tr${bgStyle}><td>${g.ingredient_name || '—'}${nameSuffix}</td><td style="font-family:monospace">${g.sid || '—'}</td><td style="text-align:right;font-weight:600">${g.quantity_needed.toLocaleString()} ${g.unit || ''}</td><td style="color:#999;font-size:11px">${g.allFulfilled ? 'Already staged (' + g.quantity_fulfilled.toLocaleString() + ' ' + (g.unit || '') + ')' : 'No lots available'}</td><td style="text-align:center">${statusLabel}</td><td></td></tr>`);
        }
      }
      const trackedItems = sr.items.filter((i) => i.inventory_tracked !== false);
      const fulfilledCount = trackedItems.filter((i) => i.status === 'fulfilled').length;
      const totalCount = trackedItems.length;
      const pendingItems = trackedItems.filter((i) => i.status !== 'fulfilled');
      const html = `<html><head><title>Staging Sheet — ${sr.production_batch_uid}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;padding:24px;color:#222}h1{font-size:22px;margin-bottom:4px}h2{font-size:16px;margin-top:20px;margin-bottom:8px;color:#333;border-bottom:2px solid #333;padding-bottom:4px}.meta{font-size:13px;color:#555;margin-bottom:8px;line-height:1.6}.summary{font-size:13px;margin-bottom:16px;padding:8px 12px;background:#f9f9f9;border:1px solid #ddd;border-radius:4px}table{width:100%;border-collapse:collapse;margin-top:8px}th{background:#f0f0f0;text-align:left;padding:6px 10px;border:1px solid #ccc;font-size:12px}td{padding:6px 10px;border:1px solid #ccc;font-size:12px}.footer{margin-top:32px;font-size:11px;color:#888;border-top:1px solid #ccc;padding-top:8px}.notes-area{margin-top:24px}.notes-area h3{font-size:14px;margin-bottom:6px}.notes-line{border-bottom:1px solid #ccc;height:28px}@media print{body{padding:12px}button{display:none!important}}</style></head><body><h1>Staging Pick Sheet</h1><div class="meta"><strong>Batch:</strong> ${sr.production_batch_uid}<br><strong>Product:</strong> ${sr.product_name || 'Unknown'}${sr.formula_name ? ` — ${sr.formula_name}` : ''}${sr.number_of_batches > 1 ? ` (×${sr.number_of_batches} batches)` : ''}<br><strong>Date:</strong> ${sr.created_at ? new Date(sr.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}<br><strong>Printed:</strong> ${new Date().toLocaleString()}</div><div class="summary">Progress: ${fulfilledCount} / ${totalCount} items staged | Status: <strong>${sr.status === 'fulfilled' ? 'Complete' : sr.status === 'in_progress' ? 'In Progress' : 'Pending'}</strong>${pendingItems.length > 0 ? ` | <strong>${pendingItems.length}</strong> item(s) still to pick` : ''}</div><h2>Materials to Pick</h2><table><thead><tr><th>Ingredient</th><th>SID</th><th style="text-align:right">Qty Needed</th><th>Lot / Location / Qty to Pick</th><th style="text-align:center">Status</th><th style="width:70px;text-align:center">Picked ✓</th></tr></thead><tbody>${rows.join('')}</tbody></table><div class="notes-area"><h3>Notes</h3><div class="notes-line"></div><div class="notes-line"></div><div class="notes-line"></div></div><div class="footer">Sunberry Farms — Staging Pick Sheet | ${sr.production_batch_uid}</div></body></html>`;
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
  // Fetch staging details for an item (shared by mark-used, return, undo)
  // ===========================================================================

  const fetchStagingDetails = async (requestId, itemId) => {
    try {
      setLoadingDetails(true);
      const resp = await axios.get(
        `${API_BASE_URL}/service/staging-requests/${requestId}/items/${itemId}/staging-details`,
        { headers: getAuthHeaders() }
      );
      return resp.data?.staging_items || [];
    } catch (err) {
      console.error('Error fetching staging details:', err);
      return [];
    } finally {
      setLoadingDetails(false);
    }
  };

  // ===========================================================================
  // Mark Used modal
  // ===========================================================================

  const openMarkUsedModal = async (requestId, itemOrGroup) => {
    setActionError('');
    setActionSuccess('');
    // Use allItems when group has staging but itemsWithStaging may miss some (e.g. different item has the staging link)
    const items = itemOrGroup.itemsWithStaging?.length > 0
      ? itemOrGroup.itemsWithStaging
      : itemOrGroup.anyStagingItems && itemOrGroup.allItems?.length > 0
        ? itemOrGroup.allItems
        : itemOrGroup.underlyingItems || (itemOrGroup.id ? [itemOrGroup] : []);
    const detailsBySiId = new Map(); // dedupe by staging_item_id
    for (const it of items) {
      const details = await fetchStagingDetails(requestId, it.id);
      for (const d of details) {
        if (d.available > 0) {
          const existing = detailsBySiId.get(d.staging_item_id);
          if (!existing || d.available > existing.available) {
            detailsBySiId.set(d.staging_item_id, { ...d, _itemId: it.id });
          }
        }
      }
    }
    const allDetails = Array.from(detailsBySiId.values());
    if (allDetails.length === 0) {
      setError('No staged items available to mark as used. Items may already be fully used or returned.');
      return;
    }
    setMarkUsedDetails(allDetails);
    const qtys = {};
    allDetails.forEach((d) => { qtys[d.staging_item_id] = d.available; });
    setMarkUsedQuantities(qtys);
    setMarkUsedModal({ requestId, item: itemOrGroup });
  };

  const handleMarkUsed = async () => {
    if (!markUsedModal) return;
    setSubmittingMarkUsed(true);
    setActionError('');
    setActionSuccess('');

    try {
      for (const detail of markUsedDetails) {
        const qty = parseFloat(markUsedQuantities[detail.staging_item_id]) || 0;
        if (qty <= 0) continue;

        const itemId = detail._itemId ?? markUsedModal.item.id;
        await axios.post(
          `${API_BASE_URL}/service/staging-requests/${markUsedModal.requestId}/items/${itemId}/mark-used`,
          { staging_item_id: detail.staging_item_id, quantity: qty },
          { headers: getAuthHeaders() }
        );
      }
      setActionSuccess('Items marked as used successfully!');
      fetchRequests();
      if (markUsedModal?.fromCloseOut && closeOutModal) {
        const resp = await axios.get(
          `${API_BASE_URL}/service/staging-requests/${closeOutModal.requestId}/close-out-data`,
          { headers: getAuthHeaders() }
        );
        setCloseOutModal((prev) => prev ? { ...prev, data: resp.data } : null);
      }
      setTimeout(() => { setMarkUsedModal(null); setActionSuccess(''); }, 1500);
    } catch (err) {
      console.error('Error marking used:', err);
      setActionError(err.response?.data?.detail || 'Failed to mark as used.');
    } finally {
      setSubmittingMarkUsed(false);
    }
  };

  // ===========================================================================
  // Return modal
  // ===========================================================================

  const returnSubLocOptions = useMemo(() => {
    if (!returnLocation) return [];
    return subLocationMap[returnLocation] || [];
  }, [returnLocation, subLocationMap]);

  const openReturnModal = async (requestId, itemOrGroup) => {
    setActionError('');
    setActionSuccess('');
    // Use allItems when group has staging but itemsWithStaging may miss some
    const items = itemOrGroup.itemsWithStaging?.length > 0
      ? itemOrGroup.itemsWithStaging
      : itemOrGroup.anyStagingItems && itemOrGroup.allItems?.length > 0
        ? itemOrGroup.allItems
        : itemOrGroup.underlyingItems || (itemOrGroup.id ? [itemOrGroup] : []);
    const detailsBySiId = new Map(); // dedupe by staging_item_id
    for (const it of items) {
      const details = await fetchStagingDetails(requestId, it.id);
      for (const d of details) {
        if (d.available > 0) {
          const existing = detailsBySiId.get(d.staging_item_id);
          if (!existing || d.available > existing.available) {
            detailsBySiId.set(d.staging_item_id, { ...d, _itemId: it.id });
          }
        }
      }
    }
    const allDetails = Array.from(detailsBySiId.values());
    if (allDetails.length === 0) {
      setError('No staged items available to return. Items may already be fully used or returned.');
      return;
    }
    setReturnDetails(allDetails);
    const qtys = {};
    allDetails.forEach((d) => { qtys[d.staging_item_id] = d.available; });
    setReturnQuantities(qtys);
    setReturnLocation('');
    setReturnSubLocation('');
    setReturnModal({ requestId, item: itemOrGroup });
  };

  const handleReturn = async () => {
    if (!returnModal || !returnLocation) {
      setActionError('Please select a return location.');
      return;
    }
    setSubmittingReturn(true);
    setActionError('');
    setActionSuccess('');

    try {
      for (const detail of returnDetails) {
        const qty = parseFloat(returnQuantities[detail.staging_item_id]) || 0;
        if (qty <= 0) continue;

        const itemId = detail._itemId ?? returnModal.item.id;
        await axios.post(
          `${API_BASE_URL}/service/staging-requests/${returnModal.requestId}/items/${itemId}/return`,
          {
            staging_item_id: detail.staging_item_id,
            quantity: qty,
            to_location_id: returnLocation,
            to_sub_location_id: returnSubLocation || null,
          },
          { headers: getAuthHeaders() }
        );
      }
      setActionSuccess('Items returned to warehouse successfully!');
      fetchRequests();
      if (returnModal?.fromCloseOut && closeOutModal) {
        const resp = await axios.get(
          `${API_BASE_URL}/service/staging-requests/${closeOutModal.requestId}/close-out-data`,
          { headers: getAuthHeaders() }
        );
        setCloseOutModal((prev) => prev ? { ...prev, data: resp.data } : null);
      }
      setTimeout(() => { setReturnModal(null); setActionSuccess(''); }, 1500);
    } catch (err) {
      console.error('Error returning items:', err);
      setActionError(err.response?.data?.detail || 'Failed to return items.');
    } finally {
      setSubmittingReturn(false);
    }
  };

  // ===========================================================================
  // Sync with Production
  // ===========================================================================

  const handleSync = async (requestId) => {
    setSyncingId(requestId);
    setSyncResult(null);
    try {
      const resp = await axios.post(
        `${API_BASE_URL}/service/staging-requests/${requestId}/sync`,
        {},
        { headers: getAuthHeaders() }
      );
      setSyncResult({ requestId, ...resp.data });
      fetchRequests(); // Refresh to show updated data
    } catch (err) {
      console.error('Error syncing with Production:', err);
      setSyncResult({ requestId, error: err.response?.data?.detail || 'Could not reach Production app. Please try again.' });
    } finally {
      setSyncingId(null);
    }
  };

  // ===========================================================================
  // Dismiss (never staged, production date passed)
  // ===========================================================================
  const handleDismiss = async (requestId) => {
    if (!window.confirm('Dismiss this staging request? Nothing was staged. This cannot be undone.')) return;
    setSubmittingDismiss(true);
    try {
      await axios.post(
        `${API_BASE_URL}/service/staging-requests/${requestId}/dismiss`,
        {},
        { headers: getAuthHeaders() }
      );
      fetchRequests();
      setActionSuccess('Request dismissed.');
      setTimeout(() => setActionSuccess(''), 2000);
    } catch (err) {
      setActionError(err.response?.data?.detail || 'Failed to dismiss.');
    } finally {
      setSubmittingDismiss(false);
    }
  };

  // ===========================================================================
  // Close Out (reconcile leftovers, then close)
  // ===========================================================================
  const openCloseOutModal = async (sr) => {
    setCloseOutModal({ requestId: sr.id, data: null, loading: true });
    setActionError('');
    setActionSuccess('');
    try {
      // Sync first to get latest usage from Production
      await axios.post(
        `${API_BASE_URL}/service/staging-requests/${sr.id}/sync`,
        {},
        { headers: getAuthHeaders() }
      );
      const resp = await axios.get(
        `${API_BASE_URL}/service/staging-requests/${sr.id}/close-out-data`,
        { headers: getAuthHeaders() }
      );
      setCloseOutModal({ requestId: sr.id, data: resp.data, loading: false });
    } catch (err) {
      setCloseOutModal((prev) => prev ? { ...prev, loading: false, error: err.response?.data?.detail || 'Failed to load' } : null);
    }
  };

  const fetchCloseOutData = async () => {
    if (!closeOutModal?.requestId) return;
    try {
      const resp = await axios.get(
        `${API_BASE_URL}/service/staging-requests/${closeOutModal.requestId}/close-out-data`,
        { headers: getAuthHeaders() }
      );
      setCloseOutModal((prev) => prev ? { ...prev, data: resp.data } : null);
    } catch (err) {
      setActionError(err.response?.data?.detail || 'Failed to refresh');
    }
  };

  const handleCompleteCloseOut = async () => {
    if (!closeOutModal?.requestId) return;
    const hasLeftover = closeOutModal.data?.items?.some((i) => (i.leftover || 0) > 0.001);
    if (hasLeftover) {
      setActionError('Return or mark as used all leftover materials before closing out.');
      return;
    }
    setSubmittingCloseOut(true);
    setActionError('');
    try {
      await axios.post(
        `${API_BASE_URL}/service/staging-requests/${closeOutModal.requestId}/close-out`,
        {},
        { headers: getAuthHeaders() }
      );
      setCloseOutModal(null);
      fetchRequests();
      setActionSuccess('Staging request closed.');
      setTimeout(() => setActionSuccess(''), 2000);
    } catch (err) {
      setActionError(err.response?.data?.detail || 'Failed to close out.');
    } finally {
      setSubmittingCloseOut(false);
    }
  };

  const openReturnFromCloseOut = (row) => {
    const group = {
      itemsWithStaging: row.items.map((i) => ({ id: i.id })),
      underlyingItems: row.items.map((i) => ({ id: i.id })),
      ingredient_name: row.ingredient_name,
      sid: row.sid,
      unit: row.unit,
    };
    setReturnDetails(row.staging_details.map((d) => ({
      staging_item_id: d.staging_item_id,
      available: d.available,
      _itemId: d.item_id,
      lot_number: d.lot_number ?? '—',
      location_name: d.location_name ?? '',
      sub_location_name: d.sub_location_name ?? '',
    })));
    const qtys = {};
    row.staging_details.forEach((d) => { qtys[d.staging_item_id] = d.available; });
    setReturnQuantities(qtys);
    setReturnLocation('');
    setReturnSubLocation('');
    setReturnModal({ requestId: closeOutModal.requestId, item: group, fromCloseOut: true });
  };

  const openMarkUsedFromCloseOut = (row) => {
    const group = {
      itemsWithStaging: row.items.map((i) => ({ id: i.id })),
      underlyingItems: row.items.map((i) => ({ id: i.id })),
      ingredient_name: row.ingredient_name,
      sid: row.sid,
      unit: row.unit,
    };
    setMarkUsedDetails(row.staging_details.map((d) => ({
      staging_item_id: d.staging_item_id,
      available: d.available,
      _itemId: d.item_id,
    })));
    const qtys = {};
    row.staging_details.forEach((d) => { qtys[d.staging_item_id] = d.available; });
    setMarkUsedQuantities(qtys);
    setMarkUsedModal({ requestId: closeOutModal.requestId, item: group, fromCloseOut: true });
  };

  // ===========================================================================
  // End-of-day reconciliation
  // ===========================================================================

  const fetchReconciliation = async () => {
    try {
      setLoadingRecon(true);
      const resp = await axios.get(
        `${API_BASE_URL}/service/staging-requests/reconciliation`,
        { headers: getAuthHeaders() }
      );
      setReconData(Array.isArray(resp.data) ? resp.data : []);
      setShowReconciliation(true);
    } catch (err) {
      console.error('Error fetching reconciliation:', err);
      setError('Failed to load reconciliation data.');
    } finally {
      setLoadingRecon(false);
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
    if (status === 'fulfilled') return <span style={{ color: '#155724', fontWeight: 600, fontSize: '0.85rem' }}>Fulfilled</span>;
    if (status === 'partially_fulfilled') return <span style={{ color: '#856404', fontWeight: 600, fontSize: '0.85rem' }}>Partial</span>;
    return <span style={{ color: '#6c757d', fontWeight: 600, fontSize: '0.85rem' }}>Pending</span>;
  };

  const formatDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  // ===========================================================================
  // Action buttons for each item
  // ===========================================================================

  const hasStagingIds = (obj) => {
    if (!obj || !obj.staging_item_ids) return false;
    const ids = obj.staging_item_ids;
    if (Array.isArray(ids)) return ids.length > 0;
    const s = String(ids).trim();
    return s.length > 0 && s !== '[]' && s !== 'null';
  };

  const renderItemActions = (sr, g) => {
    // g can be consolidated group (underlyingItems, anyStagingItems) or single item
    const hasStagingItems = g.anyStagingItems || hasStagingIds(g);
    const isNotTracked = g.inventory_tracked === false;
    const isFullyFulfilled = g.allFulfilled || g.status === 'fulfilled';

    // Non-tracked items (water, sugar) — no staging actions needed
    if (isNotTracked) {
      return (
        <span style={{ fontSize: '0.75rem', color: '#6c757d', fontStyle: 'italic' }}>
          No staging needed
        </span>
      );
    }

    return (
      <div style={{ display: 'flex', gap: '4px', justifyContent: 'center', flexWrap: 'wrap' }}>
        {/* Stage button — always show if not fully fulfilled */}
        {!isFullyFulfilled && (
          <button
            onClick={() => openStageModal(sr.id, g, sr.production_batch_uid)}
            style={{ padding: '3px 10px', borderRadius: '4px', border: '1px solid #007bff', backgroundColor: '#007bff', color: 'white', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 500 }}
          >
            Stage
          </button>
        )}
        {/* Mark Used / Return — show whenever any staging items exist */}
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
  // Generic overlay modal wrapper
  // ===========================================================================

  const ModalOverlay = ({ children, onClose }) => (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={(e) => { if (e.target === e.currentTarget && onClose) onClose(); }}
    >
      <div style={{ backgroundColor: 'white', borderRadius: '12px', width: '95%', maxWidth: 700, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 12px 40px rgba(0,0,0,0.2)' }}>
        {children}
      </div>
    </div>
  );

  // ===========================================================================
  // Render
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

      {/* ================================================================== */}
      {/* Reconciliation Summary */}
      {/* ================================================================== */}
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

      {/* ================================================================== */}
      {/* Requests list */}
      {/* ================================================================== */}
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
            const isOverdue = sr.production_date && new Date(sr.production_date + 'T23:59:59') < new Date() && !['closed', 'cancelled'].includes(sr.status);
            const prodDateLabel = sr.production_date ? new Date(sr.production_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
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
                          disabled={loadingCloseOut}
                          style={{ padding: '4px 12px', borderRadius: '4px', border: '1px solid #0d6efd', backgroundColor: '#0d6efd', color: 'white', fontSize: '0.75rem', fontWeight: 600, cursor: loadingCloseOut ? 'wait' : 'pointer' }}
                        >
                          {loadingCloseOut ? 'Loading...' : 'Close Out'}
                        </button>
                      )}
                    </span>
                  </div>
                )}
                {/* Header */}
                <div
                  onClick={() => toggleExpand(sr.id)}
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
                                : getItemStatusBadge(g.allFulfilled ? 'fulfilled' : g.anyFulfilled ? 'partially_fulfilled' : 'pending')
                              }
                            </td>
                            <td style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>
                              {renderItemActions(sr, g)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {/* Sync + Print buttons row */}
                    <div style={{ marginTop: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                      {/* Sync with Production + Close Out */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleSync(sr.id); }}
                          disabled={syncingId === sr.id}
                          style={{ padding: '6px 16px', borderRadius: '6px', border: '1px solid #17a2b8', backgroundColor: syncingId === sr.id ? '#adb5bd' : '#17a2b8', color: 'white', fontSize: '0.85rem', cursor: syncingId === sr.id ? 'wait' : 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px' }}
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
                            disabled={loadingCloseOut}
                            style={{ padding: '6px 16px', borderRadius: '6px', border: '1px solid #0d6efd', backgroundColor: loadingCloseOut ? '#adb5bd' : '#0d6efd', color: 'white', fontSize: '0.85rem', cursor: loadingCloseOut ? 'wait' : 'pointer', fontWeight: 500 }}
                          >
                            {loadingCloseOut ? 'Loading...' : 'Close Out'}
                          </button>
                        )}
                        {sr.last_synced_at && (
                          <span style={{ fontSize: '0.75rem', color: '#6c757d' }}>
                            Last synced: {new Date(sr.last_synced_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </span>
                        )}
                      </div>
                      {/* Sync result message */}
                      {syncResult && syncResult.requestId === sr.id && (
                        <div style={{ fontSize: '0.8rem', padding: '4px 10px', borderRadius: '4px', backgroundColor: syncResult.error ? '#f8d7da' : '#d4edda', color: syncResult.error ? '#721c24' : '#155724', fontWeight: 500 }}>
                          {syncResult.error
                            ? syncResult.error
                            : `${syncResult.batches_completed}/${syncResult.total_batches} batches completed · ${syncResult.marked_count} item(s) synced`
                          }
                        </div>
                      )}
                      {/* Print staging sheet */}
                      <button
                        onClick={() => printFullStagingSheet(sr)}
                        disabled={printingSheetId === sr.id}
                        style={{ padding: '6px 16px', borderRadius: '6px', border: '1px solid #6c757d', backgroundColor: printingSheetId === sr.id ? '#adb5bd' : '#6c757d', color: 'white', fontSize: '0.85rem', cursor: printingSheetId === sr.id ? 'wait' : 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px' }}
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

      {/* ================================================================== */}
      {/* Quick Stage Modal */}
      {/* ================================================================== */}
      {modal && (
        <ModalOverlay onClose={closeModal}>
          {/* Modal header */}
          <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid #dee2e6', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#212529' }}>Stage: {modal.item.ingredient_name}</h3>
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#6c757d' }}>
                {remaining} {modal.item.unit || 'units'} needed · Batch {modal.requestBatchUid}
              </p>
            </div>
            <button onClick={closeModal} style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: '#6c757d', lineHeight: 1 }}>×</button>
          </div>

          {/* Modal body */}
          <div style={{ padding: '1.25rem 1.5rem' }}>
            {modalSuccess && (
              <div style={{ padding: '0.75rem 1rem', backgroundColor: '#d4edda', color: '#155724', borderRadius: '6px', marginBottom: '1rem', border: '1px solid #c3e6cb', fontWeight: 600 }}>{modalSuccess}</div>
            )}
            {modalError && (
              <div style={{ padding: '0.75rem 1rem', backgroundColor: '#f8d7da', color: '#721c24', borderRadius: '6px', marginBottom: '1rem', border: '1px solid #f5c6cb' }}>{modalError}</div>
            )}

            {/* Location */}
            <div style={{ marginBottom: '1.25rem' }}>
              <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.4rem', fontSize: '0.9rem' }}>Staging Location *</label>
              <select value={modalLocation} onChange={(e) => { setModalLocation(e.target.value); setModalSubLocation(''); setLotSuggestions([]); setLotAllocations({}); }} style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #ccc', fontSize: '0.9rem' }}>
                <option value="">Select staging location</option>
                {(locations || []).map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
              </select>
              {modalLocation && subLocOptions.length > 0 && (
                <div style={{ marginTop: '0.5rem' }}>
                  <label style={{ display: 'block', fontWeight: 500, marginBottom: '0.3rem', fontSize: '0.85rem' }}>Sub-location (optional)</label>
                  <select value={modalSubLocation} onChange={(e) => setModalSubLocation(e.target.value)} style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #ccc', fontSize: '0.9rem' }}>
                    <option value="">None</option>
                    {subLocOptions.map((sub) => <option key={sub.id} value={sub.id}>{sub.name}</option>)}
                  </select>
                </div>
              )}
            </div>

            {/* Lots */}
            {modalLocation && (
              <>
                {loadingLots ? (
                  <div style={{ padding: '1rem', textAlign: 'center', color: '#6c757d' }}>Loading available lots...</div>
                ) : lotSuggestions.length === 0 ? (
                  <div style={{ padding: '1rem', textAlign: 'center', color: '#856404', backgroundColor: '#fff3cd', borderRadius: '6px', border: '1px solid #ffc107' }}>
                    No available lots found for this product. Check if receipts are approved and have quantity.
                  </div>
                ) : (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                      <label style={{ fontWeight: 600, fontSize: '0.9rem' }}>Select Lots (FEFO pre-selected)</label>
                      <span style={{ fontSize: '0.85rem', fontWeight: 600, color: Math.abs(totalAllocated - remaining) < 0.01 ? '#155724' : totalAllocated > remaining ? '#856404' : '#721c24' }}>
                        Allocated: {totalAllocated.toFixed(2)} / {remaining} {modal.item.unit || ''}
                      </span>
                    </div>

                    {/* Over-allocation note */}
                    {totalAllocated > remaining + 0.01 && (
                      <div style={{ padding: '0.5rem 0.75rem', backgroundColor: '#fff3cd', borderRadius: '4px', marginBottom: '0.5rem', fontSize: '0.8rem', color: '#856404', border: '1px solid #ffc107' }}>
                        Staging {(totalAllocated - remaining).toFixed(2)} {modal.item.unit || ''} more than needed — warehouse can stage full bag/pallet. Return unused quantity after production.
                      </div>
                    )}

                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid #dee2e6', backgroundColor: '#f6f7fb' }}>
                          <th style={{ padding: '0.4rem 0.6rem', textAlign: 'left' }}>Lot #</th>
                          <th style={{ padding: '0.4rem 0.6rem', textAlign: 'left' }}>Location</th>
                          <th style={{ padding: '0.4rem 0.6rem', textAlign: 'left' }}>Expires</th>
                          <th style={{ padding: '0.4rem 0.6rem', textAlign: 'right' }}>Available</th>
                          <th style={{ padding: '0.4rem 0.6rem', textAlign: 'right' }}>Allocate</th>
                          <th style={{ padding: '0.4rem 0.6rem', textAlign: 'center' }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {lotSuggestions.map((lot) => (
                          <tr key={lot.receipt_id} style={{ borderBottom: '1px solid #dee2e6' }}>
                            <td style={{ padding: '0.4rem 0.6rem', fontFamily: 'monospace', fontSize: '0.8rem' }}>{lot.lot_number || '—'}</td>
                            <td style={{ padding: '0.4rem 0.6rem', fontSize: '0.8rem' }}>
                              {[lot.location_name, lot.sub_location_name, lot.storage_row_name].filter(Boolean).join(' → ') || '—'}
                            </td>
                            <td style={{ padding: '0.4rem 0.6rem', fontSize: '0.8rem' }}>{lot.expiration_date ? new Date(lot.expiration_date).toLocaleDateString() : '—'}</td>
                            <td style={{ padding: '0.4rem 0.6rem', textAlign: 'right' }}>
                              {lot.available_quantity.toLocaleString()} {lot.unit || ''}
                              {lot.weight_per_container && lot.container_unit && lot.weight_per_container > 0 ? (
                                <div style={{ fontSize: '0.7rem', color: '#666' }}>
                                  ≈ {Math.ceil(lot.available_quantity / lot.weight_per_container)} {lot.container_unit}
                                </div>
                              ) : ['barrels','bags','drums','totes','pails'].includes((lot.unit || '').toLowerCase()) ? (
                                <div style={{ fontSize: '0.7rem', color: '#007bff', fontWeight: 600 }}>
                                  {lot.available_quantity} {lot.unit}
                                </div>
                              ) : null}
                            </td>
                            <td style={{ padding: '0.4rem 0.6rem', textAlign: 'right', width: '110px' }}>
                              <input
                                type="number" min="0" max={lot.available_quantity} step="0.01"
                                value={lotAllocations[lot.receipt_id] ?? ''}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setLotAllocations((prev) => ({ ...prev, [lot.receipt_id]: val === '' ? '' : Math.min(parseFloat(val) || 0, lot.available_quantity) }));
                                }}
                                style={{ width: '100%', padding: '0.3rem 0.4rem', borderRadius: '4px', border: '1px solid #ccc', textAlign: 'right', fontSize: '0.85rem' }}
                              />
                            </td>
                            <td style={{ padding: '0.4rem 0.6rem', textAlign: 'center' }}>
                              <button
                                onClick={() => setLotAllocations((prev) => ({ ...prev, [lot.receipt_id]: lot.available_quantity }))}
                                title="Stage full bag/pallet"
                                style={{ padding: '2px 6px', borderRadius: '3px', border: '1px solid #6c757d', backgroundColor: 'white', color: '#6c757d', fontSize: '0.7rem', cursor: 'pointer' }}
                              >
                                Full
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Modal footer */}
          <div style={{ padding: '1rem 1.5rem', borderTop: '1px solid #dee2e6', display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
            {pickSheetData ? (
              <>
                <button onClick={printPickSheet} style={{ padding: '0.5rem 1.5rem', borderRadius: '6px', border: '1px solid #007bff', backgroundColor: '#007bff', color: 'white', cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem' }}>Print Pick Sheet</button>
                <button onClick={() => { closeModal(); fetchRequests(); }} style={{ padding: '0.5rem 1.25rem', borderRadius: '6px', border: '1px solid #28a745', backgroundColor: '#28a745', color: 'white', cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem' }}>Done</button>
              </>
            ) : (
              <>
                <button onClick={closeModal} style={{ padding: '0.5rem 1.25rem', borderRadius: '6px', border: '1px solid #ccc', background: 'white', cursor: 'pointer', fontSize: '0.9rem' }}>Cancel</button>
                <button
                  onClick={handleConfirmStage}
                  disabled={submittingStage || !modalLocation || totalAllocated <= 0 || !!modalSuccess}
                  style={{ padding: '0.5rem 1.5rem', borderRadius: '6px', border: 'none', backgroundColor: submittingStage || !modalLocation || totalAllocated <= 0 ? '#6c757d' : '#28a745', color: 'white', cursor: submittingStage ? 'wait' : 'pointer', fontWeight: 600, fontSize: '0.9rem' }}
                >
                  {submittingStage ? 'Staging...' : `Confirm Stage (${totalAllocated.toFixed(2)} ${modal.item.unit || ''})`}
                </button>
              </>
            )}
          </div>
        </ModalOverlay>
      )}

      {/* ================================================================== */}
      {/* Mark Used Modal */}
      {/* ================================================================== */}
      {markUsedModal && (
        <ModalOverlay onClose={() => setMarkUsedModal(null)}>
          <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid #dee2e6' }}>
            <h3 style={{ margin: 0, fontSize: '1.1rem' }}>Mark as Used: {markUsedModal.item.ingredient_name}</h3>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#6c757d' }}>
              Select how much was used in production
            </p>
          </div>
          <div style={{ padding: '1.25rem 1.5rem' }}>
            {actionError && <div style={{ padding: '0.5rem', backgroundColor: '#f8d7da', color: '#721c24', borderRadius: '4px', marginBottom: '0.75rem', fontSize: '0.85rem' }}>{actionError}</div>}
            {actionSuccess && <div style={{ padding: '0.5rem', backgroundColor: '#d4edda', color: '#155724', borderRadius: '4px', marginBottom: '0.75rem', fontSize: '0.85rem' }}>{actionSuccess}</div>}
            {loadingDetails ? (
              <div style={{ textAlign: 'center', padding: '1rem', color: '#6c757d' }}>Loading staging details...</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #dee2e6', backgroundColor: '#f6f7fb' }}>
                    <th style={{ padding: '0.4rem 0.6rem', textAlign: 'left' }}>Lot #</th>
                    <th style={{ padding: '0.4rem 0.6rem', textAlign: 'right' }}>Staged</th>
                    <th style={{ padding: '0.4rem 0.6rem', textAlign: 'right' }}>Available</th>
                    <th style={{ padding: '0.4rem 0.6rem', textAlign: 'right' }}>Qty Used</th>
                  </tr>
                </thead>
                <tbody>
                  {markUsedDetails.map((d) => (
                    <tr key={d.staging_item_id} style={{ borderBottom: '1px solid #dee2e6' }}>
                      <td style={{ padding: '0.4rem 0.6rem', fontFamily: 'monospace' }}>{d.lot_number}</td>
                      <td style={{ padding: '0.4rem 0.6rem', textAlign: 'right' }}>{d.quantity_staged}</td>
                      <td style={{ padding: '0.4rem 0.6rem', textAlign: 'right', fontWeight: 600 }}>{d.available}</td>
                      <td style={{ padding: '0.4rem 0.6rem', textAlign: 'right', width: '120px' }}>
                        <input type="number" min="0" max={d.available} step="0.01"
                          value={markUsedQuantities[d.staging_item_id] ?? ''}
                          onChange={(e) => setMarkUsedQuantities((prev) => ({ ...prev, [d.staging_item_id]: Math.min(parseFloat(e.target.value) || 0, d.available) }))}
                          style={{ width: '100%', padding: '0.3rem', borderRadius: '4px', border: '1px solid #ccc', textAlign: 'right', fontSize: '0.85rem' }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div style={{ padding: '1rem 1.5rem', borderTop: '1px solid #dee2e6', display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
            <button onClick={() => setMarkUsedModal(null)} style={{ padding: '0.5rem 1.25rem', borderRadius: '6px', border: '1px solid #ccc', background: 'white', cursor: 'pointer', fontSize: '0.9rem' }}>Cancel</button>
            <button onClick={handleMarkUsed} disabled={submittingMarkUsed}
              style={{ padding: '0.5rem 1.5rem', borderRadius: '6px', border: 'none', backgroundColor: '#28a745', color: 'white', cursor: submittingMarkUsed ? 'wait' : 'pointer', fontWeight: 600, fontSize: '0.9rem' }}
            >
              {submittingMarkUsed ? 'Saving...' : 'Confirm Used'}
            </button>
          </div>
        </ModalOverlay>
      )}

      {/* ================================================================== */}
      {/* Return Modal */}
      {/* ================================================================== */}
      {returnModal && (
        <ModalOverlay onClose={() => setReturnModal(null)}>
          <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid #dee2e6' }}>
            <h3 style={{ margin: 0, fontSize: '1.1rem' }}>Return to Warehouse: {returnModal.item.ingredient_name}</h3>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#6c757d' }}>Return unused staged material back to a rack location</p>
          </div>
          <div style={{ padding: '1.25rem 1.5rem' }}>
            {actionError && <div style={{ padding: '0.5rem', backgroundColor: '#f8d7da', color: '#721c24', borderRadius: '4px', marginBottom: '0.75rem', fontSize: '0.85rem' }}>{actionError}</div>}
            {actionSuccess && <div style={{ padding: '0.5rem', backgroundColor: '#d4edda', color: '#155724', borderRadius: '4px', marginBottom: '0.75rem', fontSize: '0.85rem' }}>{actionSuccess}</div>}

            {/* Return location */}
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.4rem', fontSize: '0.9rem' }}>Return to Location *</label>
              <select value={returnLocation} onChange={(e) => { setReturnLocation(e.target.value); setReturnSubLocation(''); }} style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #ccc', fontSize: '0.9rem' }}>
                <option value="">Select location</option>
                {(locations || []).map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
              </select>
              {returnLocation && returnSubLocOptions.length > 0 && (
                <div style={{ marginTop: '0.5rem' }}>
                  <label style={{ display: 'block', fontWeight: 500, marginBottom: '0.3rem', fontSize: '0.85rem' }}>Sub-location (optional)</label>
                  <select value={returnSubLocation} onChange={(e) => setReturnSubLocation(e.target.value)} style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #ccc', fontSize: '0.9rem' }}>
                    <option value="">None</option>
                    {returnSubLocOptions.map((sub) => <option key={sub.id} value={sub.id}>{sub.name}</option>)}
                  </select>
                </div>
              )}
            </div>

            {/* Return quantities */}
            {loadingDetails ? (
              <div style={{ textAlign: 'center', padding: '1rem', color: '#6c757d' }}>Loading...</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #dee2e6', backgroundColor: '#f6f7fb' }}>
                    <th style={{ padding: '0.4rem 0.6rem', textAlign: 'left' }}>Lot #</th>
                    <th style={{ padding: '0.4rem 0.6rem', textAlign: 'left' }}>Original Location</th>
                    <th style={{ padding: '0.4rem 0.6rem', textAlign: 'right' }}>Available</th>
                    <th style={{ padding: '0.4rem 0.6rem', textAlign: 'right' }}>Return Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {returnDetails.map((d) => (
                    <tr key={d.staging_item_id} style={{ borderBottom: '1px solid #dee2e6' }}>
                      <td style={{ padding: '0.4rem 0.6rem', fontFamily: 'monospace' }}>{d.lot_number}</td>
                      <td style={{ padding: '0.4rem 0.6rem', fontSize: '0.8rem' }}>{[d.location_name, d.sub_location_name].filter(Boolean).join(' / ') || '—'}</td>
                      <td style={{ padding: '0.4rem 0.6rem', textAlign: 'right', fontWeight: 600 }}>{d.available}</td>
                      <td style={{ padding: '0.4rem 0.6rem', textAlign: 'right', width: '120px' }}>
                        <input type="number" min="0" max={d.available} step="0.01"
                          value={returnQuantities[d.staging_item_id] ?? ''}
                          onChange={(e) => setReturnQuantities((prev) => ({ ...prev, [d.staging_item_id]: Math.min(parseFloat(e.target.value) || 0, d.available) }))}
                          style={{ width: '100%', padding: '0.3rem', borderRadius: '4px', border: '1px solid #ccc', textAlign: 'right', fontSize: '0.85rem' }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div style={{ padding: '1rem 1.5rem', borderTop: '1px solid #dee2e6', display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
            <button onClick={() => setReturnModal(null)} style={{ padding: '0.5rem 1.25rem', borderRadius: '6px', border: '1px solid #ccc', background: 'white', cursor: 'pointer', fontSize: '0.9rem' }}>Cancel</button>
            <button onClick={handleReturn} disabled={submittingReturn || !returnLocation}
              style={{ padding: '0.5rem 1.5rem', borderRadius: '6px', border: 'none', backgroundColor: !returnLocation ? '#6c757d' : '#fd7e14', color: 'white', cursor: submittingReturn ? 'wait' : 'pointer', fontWeight: 600, fontSize: '0.9rem' }}
            >
              {submittingReturn ? 'Returning...' : 'Confirm Return'}
            </button>
          </div>
        </ModalOverlay>
      )}

      {/* Close Out modal */}
      {closeOutModal && (
        <ModalOverlay onClose={() => { setCloseOutModal(null); setActionError(''); setActionSuccess(''); }}>
          <div style={{ maxWidth: 720, maxHeight: '90vh', overflow: 'auto' }}>
            <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid #dee2e6', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '1.15rem', color: '#212529' }}>Close Out — Reconcile Leftovers</h3>
                {closeOutModal.data && (
                  <p style={{ margin: '0.25rem 0 0', fontSize: '0.9rem', color: '#6c757d' }}>
                    {closeOutModal.data.request?.product_name} · {closeOutModal.data.request?.production_date ? new Date(closeOutModal.data.request.production_date + 'T00:00:00').toLocaleDateString('en-US') : ''} · {closeOutModal.data.batches_completed}/{closeOutModal.data.total_batches} batches completed
                  </p>
                )}
              </div>
              <button onClick={() => { setCloseOutModal(null); setActionError(''); setActionSuccess(''); }} style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: '#6c757d', lineHeight: 1 }}>×</button>
            </div>
            {actionSuccess && <div style={{ padding: '0.5rem 1rem', margin: '0 1.5rem', marginTop: '0.5rem', backgroundColor: '#d4edda', color: '#155724', borderRadius: '6px', fontSize: '0.85rem' }}>{actionSuccess}</div>}
            {actionError && <div style={{ padding: '0.5rem 1rem', margin: '0 1.5rem', marginTop: '0.5rem', backgroundColor: '#f8d7da', color: '#721c24', borderRadius: '6px', fontSize: '0.85rem' }}>{actionError}</div>}
            {closeOutModal.loading ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: '#6c757d' }}>Syncing with Production and loading data...</div>
            ) : closeOutModal.error ? (
              <div style={{ padding: '1.5rem', color: '#721c24' }}>{closeOutModal.error}</div>
            ) : closeOutModal.data ? (
              <>
                <div style={{ padding: '1rem 1.5rem' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #dee2e6', backgroundColor: '#f6f7fb' }}>
                        <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left' }}>Ingredient</th>
                        <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>Staged</th>
                        <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>Used</th>
                        <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>Returned</th>
                        <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: '#dc3545' }}>Leftover</th>
                        <th style={{ padding: '0.5rem 0.75rem', textAlign: 'center', minWidth: 160 }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {closeOutModal.data.items.map((row, idx) => (
                        <tr key={idx} style={{ borderBottom: '1px solid #dee2e6', backgroundColor: row.leftover > 0 ? '#fff8f8' : 'transparent' }}>
                          <td style={{ padding: '0.5rem 0.75rem' }}>{row.ingredient_name}</td>
                          <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{row.quantity_staged.toLocaleString()} {row.unit || ''}</td>
                          <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: '#155724' }}>{row.quantity_used.toLocaleString()} {row.unit || ''}</td>
                          <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{row.quantity_returned.toLocaleString()} {row.unit || ''}</td>
                          <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontWeight: row.leftover > 0 ? 700 : 400, color: row.leftover > 0 ? '#dc3545' : '#6c757d' }}>
                            {row.leftover > 0 ? `${row.leftover.toLocaleString()} ${row.unit || ''}` : '—'}
                          </td>
                          <td style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>
                            {row.leftover > 0 ? (
                              <div style={{ display: 'flex', gap: '0.25rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                                <button onClick={() => openReturnFromCloseOut(row)} style={{ padding: '3px 10px', borderRadius: '4px', border: '1px solid #fd7e14', backgroundColor: '#fd7e14', color: 'white', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 500 }}>Return</button>
                                <button onClick={() => openMarkUsedFromCloseOut(row)} style={{ padding: '3px 10px', borderRadius: '4px', border: '1px solid #28a745', backgroundColor: '#28a745', color: 'white', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 500 }}>Mark Used</button>
                              </div>
                            ) : (
                              <span style={{ fontSize: '0.8rem', color: '#6c757d' }}>—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ padding: '1rem 1.5rem', borderTop: '1px solid #dee2e6', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <button onClick={fetchCloseOutData} style={{ padding: '0.5rem 1rem', borderRadius: '6px', border: '1px solid #6c757d', background: 'white', cursor: 'pointer', fontSize: '0.85rem' }}>Refresh</button>
                  <button
                    onClick={handleCompleteCloseOut}
                    disabled={submittingCloseOut || closeOutModal.data?.items?.some((i) => (i.leftover || 0) > 0.001)}
                    style={{ padding: '0.5rem 1.5rem', borderRadius: '6px', border: 'none', backgroundColor: (submittingCloseOut || closeOutModal.data?.items?.some((i) => (i.leftover || 0) > 0.001)) ? '#6c757d' : '#0d6efd', color: 'white', cursor: (submittingCloseOut || closeOutModal.data?.items?.some((i) => (i.leftover || 0) > 0.001)) ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: '0.9rem' }}
                  >
                    {submittingCloseOut ? 'Closing...' : 'Complete Close Out'}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </ModalOverlay>
      )}

      {/* Undo modal removed — use Return instead */}
    </div>
  );
};

export default ProductionStagingRequests;
