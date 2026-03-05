import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useAppData } from '../../context/AppDataContext';
import { useToast } from '../../context/ToastContext';
import apiClient from '../../api/client';
import ModalOverlay from './ModalOverlay';
import { formatDate, formatDateTime, escapeHtml } from '../../utils/dateUtils';

/**
 * QuickStageModal
 *
 * Props:
 *   requestId        {string|number}  staging request ID
 *   item             {object}         consolidated item/group (ingredient_name, product_id, sid, unit,
 *                                     quantity_needed, quantity_fulfilled)
 *   requestBatchUid  {string}         batch UID for display / pick-sheet
 *   underlyingItems  {array}          raw request items that make up the consolidated group
 *   onClose          {function}       called when the modal should close
 *   onSuccess        {function}       called after a successful stage so the parent can refresh
 */
const QuickStageModal = ({
  requestId,
  item,
  requestBatchUid,
  underlyingItems,
  onClose,
  onSuccess,
}) => {
  const { locations, subLocationMap } = useAppData();
  const { addToast } = useToast();

  const [modalLocation, setModalLocation] = useState('');
  const [modalSubLocation, setModalSubLocation] = useState('');
  const [lotSuggestions, setLotSuggestions] = useState([]);
  const [lotAllocations, setLotAllocations] = useState({});
  const [loadingLots, setLoadingLots] = useState(false);
  const [submittingStage, setSubmittingStage] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');
  const [pickSheetData, setPickSheetData] = useState(null);

  const subLocOptions = useMemo(() => {
    if (!modalLocation) return [];
    return subLocationMap[modalLocation] || [];
  }, [modalLocation, subLocationMap]);

  const totalAllocated = Object.values(lotAllocations).reduce(
    (s, v) => s + (parseFloat(v) || 0),
    0
  );
  const remaining = item
    ? item.quantity_needed - (item.quantity_fulfilled || 0)
    : 0;

  const fetchLotSuggestions = useCallback(async () => {
    if (!item?.product_id) {
      setActionError(
        `No matching product found in Inventory for SID "${item?.sid || '?'}". Make sure this product exists in Inventory with the correct SID.`
      );
      return;
    }
    if (!modalLocation) {
      setActionError('Please select a staging location first.');
      return;
    }

    try {
      setLoadingLots(true);
      setActionError('');
      const fetchQty = remaining * 3;
      const response = await apiClient.get('/inventory/staging/suggest-lots', {
        params: { product_id: item.product_id, quantity: fetchQty },
      });
      const lots = Array.isArray(response.data) ? response.data : [];
      setLotSuggestions(lots);

      // Auto-allocate FEFO
      const allocs = {};
      let needed = remaining;
      for (const lot of lots) {
        if (needed <= 0) break;
        const take = Math.min(lot.available_quantity, needed);
        allocs[lot.receipt_id] = parseFloat(take.toFixed(3));
        needed -= take;
      }
      setLotAllocations(allocs);
    } catch (err) {
      console.error('Error fetching lot suggestions:', err);
      setActionError(
        err.response?.data?.detail || 'Failed to fetch available lots.'
      );
      setLotSuggestions([]);
    } finally {
      setLoadingLots(false);
    }
  }, [item, modalLocation, remaining]);

  useEffect(() => {
    if (modalLocation) {
      fetchLotSuggestions();
    }
  }, [modalLocation, fetchLotSuggestions]);

  const handleConfirmStage = async () => {
    if (!modalLocation) {
      setActionError('Please select a staging location.');
      return;
    }

    const lots = Object.entries(lotAllocations)
      .filter(([, qty]) => parseFloat(qty) > 0)
      .map(([receiptId, qty]) => ({
        receipt_id: receiptId,
        quantity: parseFloat(qty),
      }));

    if (lots.length === 0) {
      setActionError('Please allocate quantity to at least one lot.');
      return;
    }

    try {
      setSubmittingStage(true);
      setActionError('');

      // 1. Transfer to staging location
      const transferPayload = {
        staging_location_id: modalLocation,
        staging_sub_location_id: modalSubLocation || null,
        items: [
          {
            product_id: item.product_id,
            quantity_needed: totalAllocated,
            lots,
          },
        ],
      };
      const transferResponse = await apiClient.post(
        '/inventory/staging/transfer',
        transferPayload
      );
      const stagingItemIds = (transferResponse.data?.staging_items || []).map(
        (si) => si.id
      );

      // 2. Fulfill-item for each underlying request item
      const items = underlyingItems || (item.id ? [item] : []);
      if (items.length > 0) {
        let remainingToAllocate = Math.min(totalAllocated, remaining);
        for (const it of items) {
          const itemRem = (it.quantity_needed || 0) - (it.quantity_fulfilled || 0);
          if (itemRem <= 0) continue;
          const fulfillQty = Math.min(itemRem, remainingToAllocate);
          if (fulfillQty <= 0) break;
          await apiClient.post(
            `/service/staging-requests/${requestId}/fulfill-item?item_id=${it.id}&quantity_fulfilled=${fulfillQty}`,
            { staging_item_ids: stagingItemIds }
          );
          remainingToAllocate -= fulfillQty;
        }
      } else {
        const fulfillQty = Math.min(totalAllocated, remaining);
        await apiClient.post(
          `/service/staging-requests/${requestId}/fulfill-item?item_id=${item.id}&quantity_fulfilled=${fulfillQty}`,
          { staging_item_ids: stagingItemIds }
        );
      }

      // 3. Build pick-sheet data
      const stagingLocationName =
        (locations || []).find((l) => l.id === modalLocation)?.name || '';
      const stagingSubLocName = modalSubLocation
        ? (subLocationMap[modalLocation] || []).find(
            (s) => s.id === modalSubLocation
          )?.name || ''
        : '';

      const pickLines = lots.map((lot) => {
        const suggestion =
          lotSuggestions.find((s) => s.receipt_id === lot.receipt_id) || {};
        const locParts = [
          suggestion.location_name,
          suggestion.sub_location_name,
          suggestion.storage_row_name,
        ].filter(Boolean);
        let containerInfo = '';
        if (
          suggestion.weight_per_container &&
          suggestion.container_unit &&
          suggestion.weight_per_container > 0
        ) {
          const containers = Math.ceil(
            lot.quantity / suggestion.weight_per_container
          );
          containerInfo = ` (≈ ${containers} ${suggestion.container_unit})`;
        }
        return {
          product_name: item.ingredient_name,
          sid: item.sid,
          lot_number: suggestion.lot_number || '—',
          quantity: lot.quantity,
          unit: item.unit || '',
          containerInfo,
          pick_from: locParts.length > 0 ? locParts.join(' → ') : '—',
        };
      });

      setPickSheetData({
        batchUid: requestBatchUid,
        stagingLocation: [stagingLocationName, stagingSubLocName]
          .filter(Boolean)
          .join(' / '),
        lines: pickLines,
        timestamp: formatDateTime(new Date().toISOString()),
      });

      const overNote =
        totalAllocated > remaining
          ? ` (${(totalAllocated - remaining).toFixed(2)} ${item.unit || ''} over — return unused after production)`
          : '';
      const successMsg = `Staged ${totalAllocated} ${item.unit || 'units'} of ${item.ingredient_name} successfully!${overNote}`;
      setActionSuccess(successMsg);
      addToast(successMsg, 'success');

      if (onSuccess) onSuccess();
    } catch (err) {
      console.error('Error staging item:', err);
      const errMsg =
        err.response?.data?.detail || 'Failed to stage item. Please try again.';
      setActionError(errMsg);
      addToast(errMsg, 'error');
    } finally {
      setSubmittingStage(false);
    }
  };

  const printPickSheet = () => {
    if (!pickSheetData) return;
    const rows = pickSheetData.lines
      .map(
        (l) =>
          `<tr><td>${escapeHtml(l.product_name)}</td><td style="font-family:monospace">${escapeHtml(l.sid)}</td><td style="font-family:monospace">${escapeHtml(l.lot_number)}</td><td style="text-align:right;font-weight:600">${l.quantity} ${escapeHtml(l.unit)}${l.containerInfo ? `<div style="font-size:11px;color:#555;font-weight:normal">${escapeHtml(l.containerInfo)}</div>` : ''}</td><td>${escapeHtml(l.pick_from)}</td></tr>`
      )
      .join('');
    const html = `<html><head><title>Staging Pick Sheet</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;padding:24px;color:#222}h1{font-size:20px;margin-bottom:4px}.meta{font-size:13px;color:#555;margin-bottom:16px}table{width:100%;border-collapse:collapse;margin-top:8px}th{background:#f0f0f0;text-align:left;padding:6px 10px;border:1px solid #ccc;font-size:13px}td{padding:6px 10px;border:1px solid #ccc;font-size:13px}.footer{margin-top:24px;font-size:12px;color:#888}@media print{body{padding:0}button{display:none!important}}</style></head><body><h1>Staging Pick Sheet</h1><div class="meta"><strong>Batch:</strong> ${escapeHtml(pickSheetData.batchUid)}<br><strong>Stage to:</strong> ${escapeHtml(pickSheetData.stagingLocation)}<br><strong>Printed:</strong> ${pickSheetData.timestamp}</div><table><thead><tr><th>Product Name</th><th>SID</th><th>Lot Number</th><th style="text-align:right">Quantity</th><th>Pick From Location</th></tr></thead><tbody>${rows}</tbody></table><div class="footer">Sunberry Farms — Staging Pick Sheet</div></body></html>`;
    const w = window.open('', '_blank', 'width=800,height=600');
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
  };

  return (
    <ModalOverlay onClose={onClose}>
      {/* Header */}
      <div
        style={{
          padding: '1.25rem 1.5rem',
          borderBottom: '1px solid #dee2e6',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#212529' }}>
            Stage: {item.ingredient_name}
          </h3>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#6c757d' }}>
            {remaining} {item.unit || 'units'} needed · Batch {requestBatchUid}
          </p>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            fontSize: '1.5rem',
            cursor: 'pointer',
            color: '#6c757d',
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      {/* Body */}
      <div style={{ padding: '1.25rem 1.5rem' }}>
        {actionSuccess && (
          <div
            style={{
              padding: '0.75rem 1rem',
              backgroundColor: '#d4edda',
              color: '#155724',
              borderRadius: '6px',
              marginBottom: '1rem',
              border: '1px solid #c3e6cb',
              fontWeight: 600,
            }}
          >
            {actionSuccess}
          </div>
        )}
        {actionError && (
          <div
            style={{
              padding: '0.75rem 1rem',
              backgroundColor: '#f8d7da',
              color: '#721c24',
              borderRadius: '6px',
              marginBottom: '1rem',
              border: '1px solid #f5c6cb',
            }}
          >
            {actionError}
          </div>
        )}

        {/* Staging Location */}
        <div style={{ marginBottom: '1.25rem' }}>
          <label
            style={{
              display: 'block',
              fontWeight: 600,
              marginBottom: '0.4rem',
              fontSize: '0.9rem',
            }}
          >
            Staging Location *
          </label>
          <select
            value={modalLocation}
            onChange={(e) => {
              setModalLocation(e.target.value);
              setModalSubLocation('');
              setLotSuggestions([]);
              setLotAllocations({});
            }}
            style={{
              width: '100%',
              padding: '0.5rem',
              borderRadius: '6px',
              border: '1px solid #ccc',
              fontSize: '0.9rem',
            }}
          >
            <option value="">Select staging location</option>
            {(locations || []).map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </select>
          {modalLocation && subLocOptions.length > 0 && (
            <div style={{ marginTop: '0.5rem' }}>
              <label
                style={{
                  display: 'block',
                  fontWeight: 500,
                  marginBottom: '0.3rem',
                  fontSize: '0.85rem',
                }}
              >
                Sub-location (optional)
              </label>
              <select
                value={modalSubLocation}
                onChange={(e) => setModalSubLocation(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  borderRadius: '6px',
                  border: '1px solid #ccc',
                  fontSize: '0.9rem',
                }}
              >
                <option value="">None</option>
                {subLocOptions.map((sub) => (
                  <option key={sub.id} value={sub.id}>
                    {sub.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Lot table */}
        {modalLocation && (
          <>
            {loadingLots ? (
              <div
                style={{ padding: '1rem', textAlign: 'center', color: '#6c757d' }}
              >
                Loading available lots...
              </div>
            ) : lotSuggestions.length === 0 ? (
              <div
                style={{
                  padding: '1rem',
                  textAlign: 'center',
                  color: '#856404',
                  backgroundColor: '#fff3cd',
                  borderRadius: '6px',
                  border: '1px solid #ffc107',
                }}
              >
                No available lots found for this product. Check if receipts are
                approved and have quantity.
              </div>
            ) : (
              <div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '0.5rem',
                  }}
                >
                  <label style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                    Select Lots (FEFO pre-selected)
                  </label>
                  <span
                    style={{
                      fontSize: '0.85rem',
                      fontWeight: 600,
                      color:
                        Math.abs(totalAllocated - remaining) < 0.01
                          ? '#155724'
                          : totalAllocated > remaining
                          ? '#856404'
                          : '#721c24',
                    }}
                  >
                    Allocated: {totalAllocated.toFixed(2)} / {remaining}{' '}
                    {item.unit || ''}
                  </span>
                </div>

                {totalAllocated > remaining + 0.01 && (
                  <div
                    style={{
                      padding: '0.5rem 0.75rem',
                      backgroundColor: '#fff3cd',
                      borderRadius: '4px',
                      marginBottom: '0.5rem',
                      fontSize: '0.8rem',
                      color: '#856404',
                      border: '1px solid #ffc107',
                    }}
                  >
                    Staging {(totalAllocated - remaining).toFixed(2)}{' '}
                    {item.unit || ''} more than needed — warehouse can stage full
                    bag/pallet. Return unused quantity after production.
                  </div>
                )}

                <table
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: '0.85rem',
                  }}
                >
                  <thead>
                    <tr
                      style={{
                        borderBottom: '2px solid #dee2e6',
                        backgroundColor: '#f6f7fb',
                      }}
                    >
                      <th style={{ padding: '0.4rem 0.6rem', textAlign: 'left' }}>
                        Lot #
                      </th>
                      <th style={{ padding: '0.4rem 0.6rem', textAlign: 'left' }}>
                        Location
                      </th>
                      <th style={{ padding: '0.4rem 0.6rem', textAlign: 'left' }}>
                        Expires
                      </th>
                      <th
                        style={{ padding: '0.4rem 0.6rem', textAlign: 'right' }}
                      >
                        Available
                      </th>
                      <th
                        style={{ padding: '0.4rem 0.6rem', textAlign: 'right' }}
                      >
                        Allocate
                      </th>
                      <th
                        style={{ padding: '0.4rem 0.6rem', textAlign: 'center' }}
                      ></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lotSuggestions.map((lot) => (
                      <tr
                        key={lot.receipt_id}
                        style={{ borderBottom: '1px solid #dee2e6' }}
                      >
                        <td
                          style={{
                            padding: '0.4rem 0.6rem',
                            fontFamily: 'monospace',
                            fontSize: '0.8rem',
                          }}
                        >
                          {lot.lot_number || '—'}
                        </td>
                        <td style={{ padding: '0.4rem 0.6rem', fontSize: '0.8rem' }}>
                          {[
                            lot.location_name,
                            lot.sub_location_name,
                            lot.storage_row_name,
                          ]
                            .filter(Boolean)
                            .join(' → ') || '—'}
                        </td>
                        <td style={{ padding: '0.4rem 0.6rem', fontSize: '0.8rem' }}>
                          {lot.expiration_date
                            ? formatDate(lot.expiration_date)
                            : '—'}
                        </td>
                        <td
                          style={{ padding: '0.4rem 0.6rem', textAlign: 'right' }}
                        >
                          {lot.available_quantity.toLocaleString()} {lot.unit || ''}
                          {lot.weight_per_container &&
                          lot.container_unit &&
                          lot.weight_per_container > 0 ? (
                            <div style={{ fontSize: '0.7rem', color: '#666' }}>
                              ≈{' '}
                              {Math.ceil(
                                lot.available_quantity / lot.weight_per_container
                              )}{' '}
                              {lot.container_unit}
                            </div>
                          ) : [
                              'barrels',
                              'bags',
                              'drums',
                              'totes',
                              'pails',
                            ].includes((lot.unit || '').toLowerCase()) ? (
                            <div
                              style={{
                                fontSize: '0.7rem',
                                color: '#007bff',
                                fontWeight: 600,
                              }}
                            >
                              {lot.available_quantity} {lot.unit}
                            </div>
                          ) : null}
                        </td>
                        <td
                          style={{
                            padding: '0.4rem 0.6rem',
                            textAlign: 'right',
                            width: '110px',
                          }}
                        >
                          <input
                            type="number"
                            min="0"
                            max={lot.available_quantity}
                            step="0.01"
                            value={lotAllocations[lot.receipt_id] ?? ''}
                            onChange={(e) => {
                              const val = e.target.value;
                              setLotAllocations((prev) => ({
                                ...prev,
                                [lot.receipt_id]:
                                  val === ''
                                    ? ''
                                    : Math.min(
                                        parseFloat(val) || 0,
                                        lot.available_quantity
                                      ),
                              }));
                            }}
                            style={{
                              width: '100%',
                              padding: '0.3rem 0.4rem',
                              borderRadius: '4px',
                              border: '1px solid #ccc',
                              textAlign: 'right',
                              fontSize: '0.85rem',
                            }}
                          />
                        </td>
                        <td
                          style={{ padding: '0.4rem 0.6rem', textAlign: 'center' }}
                        >
                          <button
                            onClick={() =>
                              setLotAllocations((prev) => ({
                                ...prev,
                                [lot.receipt_id]: lot.available_quantity,
                              }))
                            }
                            title="Stage full bag/pallet"
                            style={{
                              padding: '2px 6px',
                              borderRadius: '3px',
                              border: '1px solid #6c757d',
                              backgroundColor: 'white',
                              color: '#6c757d',
                              fontSize: '0.7rem',
                              cursor: 'pointer',
                            }}
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

      {/* Footer */}
      <div
        style={{
          padding: '1rem 1.5rem',
          borderTop: '1px solid #dee2e6',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '0.75rem',
        }}
      >
        {pickSheetData ? (
          <>
            <button
              onClick={printPickSheet}
              style={{
                padding: '0.5rem 1.5rem',
                borderRadius: '6px',
                border: '1px solid #007bff',
                backgroundColor: '#007bff',
                color: 'white',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '0.9rem',
              }}
            >
              Print Pick Sheet
            </button>
            <button
              onClick={onClose}
              style={{
                padding: '0.5rem 1.25rem',
                borderRadius: '6px',
                border: '1px solid #28a745',
                backgroundColor: '#28a745',
                color: 'white',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '0.9rem',
              }}
            >
              Done
            </button>
          </>
        ) : (
          <>
            <button
              onClick={onClose}
              style={{
                padding: '0.5rem 1.25rem',
                borderRadius: '6px',
                border: '1px solid #ccc',
                background: 'white',
                cursor: 'pointer',
                fontSize: '0.9rem',
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmStage}
              disabled={
                submittingStage ||
                !modalLocation ||
                totalAllocated <= 0 ||
                !!actionSuccess
              }
              style={{
                padding: '0.5rem 1.5rem',
                borderRadius: '6px',
                border: 'none',
                backgroundColor:
                  submittingStage || !modalLocation || totalAllocated <= 0
                    ? '#6c757d'
                    : '#28a745',
                color: 'white',
                cursor: submittingStage ? 'wait' : 'pointer',
                fontWeight: 600,
                fontSize: '0.9rem',
              }}
            >
              {submittingStage
                ? 'Staging...'
                : `Confirm Stage (${totalAllocated.toFixed(2)} ${item.unit || ''})`}
            </button>
          </>
        )}
      </div>
    </ModalOverlay>
  );
};

export default QuickStageModal;
