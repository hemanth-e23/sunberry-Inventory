import React, { useState, useMemo } from 'react';
import { useAppData } from '../../context/AppDataContext';
import { useToast } from '../../context/ToastContext';
import apiClient from '../../api/client';
import ModalOverlay from './ModalOverlay';
import { activeRacks } from '../../utils/stagingDesk';
import { pluralizeUnit } from '../../utils/rowSources';

/**
 * ReturnModal
 *
 * Props:
 *   requestId        {string|number}  staging request ID
 *   item             {object}         consolidated item/group (ingredient_name, id, ...)
 *   details          {array}          pre-fetched staging details with available quantities
 *                                     Each element: { staging_item_id, lot_number, location_name,
 *                                                     sub_location_name, available, _itemId,
 *                                                     is_counted, weight_per_unit, weight_unit,
 *                                                     unit_label, original_storage_row_id,
 *                                                     original_storage_row_name }
 *   fromCloseOut     {boolean}        true when launched from CloseOutModal
 *   onClose          {function}       called when the modal should close
 *   onSuccess        {function}       called after successful return so parent can refresh
 *   onCloseOutRefresh {function}      optional — called to refresh close-out data after success
 *   submitDetail     {function}       optional — `(detail, body) => Promise`: posts one
 *                                     line's return somewhere else. Staging Overview (N7)
 *                                     returns bare staging items through
 *                                     /inventory/staging/{id}/return with the same body.
 *
 * Counted lots return as a SPLIT: whole sealed drums plus the weighed
 * remainder in the opened one. The worker check-weighs the partial drum on
 * the way back, so the number entered here is a real reading — the backend
 * records it as an open unit on the chosen rack.
 */
const ReturnModal = ({
  requestId,
  item,
  details,
  fromCloseOut,
  onClose,
  onSuccess,
  onCloseOutRefresh,
  submitDetail,
}) => {
  const { locations, subLocationMap, locationsTree } = useAppData();
  const { addToast } = useToast();

  const hasCounted = (details || []).some((d) => d.is_counted);

  const [returnLocation, setReturnLocation] = useState('');
  const [returnSubLocation, setReturnSubLocation] = useState('');
  // The rack the containers came off is the default return rack.
  const originalRowId = useMemo(() => {
    const withRow = (details || []).find((d) => d.original_storage_row_id);
    return withRow ? withRow.original_storage_row_id : '';
  }, [details]);
  const originalRowName = useMemo(() => {
    const withRow = (details || []).find((d) => d.original_storage_row_name);
    return withRow ? withRow.original_storage_row_name : null;
  }, [details]);
  const [returnStorageRow, setReturnStorageRow] = useState(originalRowId);
  // Legacy (uncounted) rows: one weight per line, defaulted to everything.
  const [quantities, setQuantities] = useState(() => {
    const qtys = {};
    (details || []).forEach((d) => {
      if (!d.is_counted) qtys[d.staging_item_id] = d.available;
    });
    return qtys;
  });
  // Counted rows: full sealed units + weighed remainder, defaulted to the
  // whole available amount split by the lot's weight per unit.
  const [splits, setSplits] = useState(() => {
    const s = {};
    (details || []).forEach((d) => {
      if (!d.is_counted) return;
      const wpu = parseFloat(d.weight_per_unit) || 0;
      const avail = parseFloat(d.available) || 0;
      const full = wpu > 0 ? Math.floor(avail / wpu + 1e-9) : 0;
      let partial = Math.max(0, avail - full * wpu);
      if (partial <= 0.01) partial = 0;
      s[d.staging_item_id] = { full, partial: partial ? partial.toFixed(2) : '' };
    });
    return s;
  });
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');

  const returnSubLocOptions = useMemo(() => {
    if (!returnLocation) return [];
    return subLocationMap[returnLocation] || [];
  }, [returnLocation, subLocationMap]);

  const racks = useMemo(() => activeRacks(locationsTree), [locationsTree]);
  const selectedRack = racks.find((r) => r.id === returnStorageRow) || null;
  // Where the material goes: the rack's own room, else the picked location.
  // A rack the tree does not list (not loaded yet) still goes: the server
  // resolves its room from the rack itself.
  const targetLocation = selectedRack ? selectedRack.locationId : (returnLocation || null);
  const targetSubLocation = selectedRack ? selectedRack.subLocationId : (returnSubLocation || null);
  const canSubmit = Boolean(returnStorageRow || targetLocation);

  const countedQty = (d) => {
    const split = splits[d.staging_item_id] || {};
    const wpu = parseFloat(d.weight_per_unit) || 0;
    const full = parseInt(split.full, 10) || 0;
    const partial = parseFloat(split.partial) || 0;
    return full * wpu + partial;
  };

  const handleReturn = async () => {
    if (!canSubmit) {
      setActionError(hasCounted ? 'Pick the rack the material went back onto.' : 'Please select a return location.');
      return;
    }
    for (const d of details || []) {
      if (!d.is_counted) continue;
      const split = splits[d.staging_item_id] || {};
      const wpu = parseFloat(d.weight_per_unit) || 0;
      const partial = parseFloat(split.partial) || 0;
      if (wpu > 0 && partial > wpu + 0.01) {
        setActionError(
          `Weighed remainder for lot ${d.lot_number} is more than one full ` +
          `${d.unit_label || 'unit'} (${wpu} ${d.weight_unit || 'lbs'}). ` +
          'Count it as a full unit instead.'
        );
        return;
      }
      const qty = countedQty(d);
      if (qty > (parseFloat(d.available) || 0) + 0.01) {
        setActionError(
          `Return for lot ${d.lot_number} (${qty.toFixed(2)}) is more than ` +
          `what is still staged (${d.available}).`
        );
        return;
      }
      if (qty > 0 && !returnStorageRow) {
        setActionError('Pick the rack the material physically went back to.');
        return;
      }
    }

    setSubmitting(true);
    setActionError('');
    setActionSuccess('');

    try {
      const post = (detail, body) => {
        if (submitDetail) return submitDetail(detail, body);
        const itemId = detail._itemId ?? item.id;
        return apiClient.post(
          `/service/staging-requests/${requestId}/items/${itemId}/return`,
          body,
        );
      };
      for (const detail of details || []) {
        if (detail.is_counted) {
          const split = splits[detail.staging_item_id] || {};
          const full = parseInt(split.full, 10) || 0;
          const partial = parseFloat(split.partial) || 0;
          const qty = countedQty(detail);
          if (qty <= 0) continue;
          await post(detail, {
            staging_item_id: detail.staging_item_id,
            quantity: Math.round(qty * 1000) / 1000,
            to_location_id: targetLocation,
            to_sub_location_id: targetSubLocation,
            to_storage_row_id: returnStorageRow || null,
            full_units: full,
            weighed_partial_qty: partial,
          });
        } else {
          const qty = parseFloat(quantities[detail.staging_item_id]) || 0;
          if (qty <= 0) continue;
          await post(detail, {
            staging_item_id: detail.staging_item_id,
            quantity: qty,
            to_location_id: targetLocation,
            to_sub_location_id: targetSubLocation,
            to_storage_row_id: returnStorageRow || null,
          });
        }
      }

      const successMsg = 'Items returned to warehouse successfully!';
      setActionSuccess(successMsg);
      addToast(successMsg, 'success');

      if (onSuccess) onSuccess();
      if (fromCloseOut && onCloseOutRefresh) onCloseOutRefresh();

      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (err) {
      console.error('Error returning items:', err);
      const errMsg =
        err.response?.data?.detail || 'Failed to return items.';
      setActionError(errMsg);
      addToast(errMsg, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalOverlay onClose={onClose}>
      {/* Header */}
      <div
        style={{
          padding: '1.25rem 1.5rem',
          borderBottom: '1px solid #dee2e6',
        }}
      >
        <h3 style={{ margin: 0, fontSize: '1.1rem' }}>
          Return to Warehouse: {item.ingredient_name}
        </h3>
        <p
          style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#6c757d' }}
        >
          Return unused staged material back to a rack location
        </p>
      </div>

      {/* Body */}
      <div style={{ padding: '1.25rem 1.5rem' }}>
        {actionError && (
          <div
            style={{
              padding: '0.5rem',
              backgroundColor: '#f8d7da',
              color: '#721c24',
              borderRadius: '4px',
              marginBottom: '0.75rem',
              fontSize: '0.85rem',
            }}
          >
            {actionError}
          </div>
        )}
        {actionSuccess && (
          <div
            style={{
              padding: '0.5rem',
              backgroundColor: '#d4edda',
              color: '#155724',
              borderRadius: '4px',
              marginBottom: '0.75rem',
              fontSize: '0.85rem',
            }}
          >
            {actionSuccess}
          </div>
        )}

        {/* Return rack: ANY active rack of the warehouse, defaulting to the
            one the material came off (browser test PART 3, G2). The rack's
            own room is where the material goes, so no separate location
            pick is needed once a rack is chosen. */}
        <div style={{ marginBottom: '1rem' }}>
          <label
            htmlFor="return-rack"
            style={{
              display: 'block',
              fontWeight: 600,
              marginBottom: '0.4rem',
              fontSize: '0.9rem',
            }}
          >
            Return to Rack {hasCounted ? '*' : '(optional)'}
          </label>
          <select
            id="return-rack"
            value={returnStorageRow}
            onChange={(e) => setReturnStorageRow(e.target.value)}
            style={{
              width: '100%',
              padding: '0.5rem',
              borderRadius: '6px',
              border: '1px solid #ccc',
              fontSize: '0.9rem',
            }}
          >
            <option value="">{hasCounted ? 'Select rack' : 'No rack — pick a location below'}</option>
            {racks.map((rack) => (
              <option key={rack.id} value={rack.id}>
                {rack.label}{rack.id === originalRowId ? ' (original rack)' : ''}
              </option>
            ))}
          </select>
          {originalRowName && returnStorageRow && returnStorageRow !== originalRowId && (
            <div style={{ marginTop: '0.3rem', fontSize: '0.75rem', color: '#6c757d' }}>
              Came off {originalRowName} — returning to a different rack.
            </div>
          )}
          {!selectedRack && !hasCounted && (
            <div style={{ marginTop: '0.75rem' }}>
              <label
                style={{
                  display: 'block',
                  fontWeight: 500,
                  marginBottom: '0.3rem',
                  fontSize: '0.85rem',
                }}
              >
                Return to Location *
              </label>
              <select
                value={returnLocation}
                onChange={(e) => {
                  setReturnLocation(e.target.value);
                  setReturnSubLocation('');
                }}
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  borderRadius: '6px',
                  border: '1px solid #ccc',
                  fontSize: '0.9rem',
                }}
              >
                <option value="">Select location</option>
                {(locations || []).map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </select>
              {returnLocation && returnSubLocOptions.length > 0 && (
                <select
                  value={returnSubLocation}
                  onChange={(e) => setReturnSubLocation(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.5rem',
                    borderRadius: '6px',
                    border: '1px solid #ccc',
                    fontSize: '0.9rem',
                    marginTop: '0.5rem',
                  }}
                >
                  <option value="">Sub-location (optional)</option>
                  {returnSubLocOptions.map((sub) => (
                    <option key={sub.id} value={sub.id}>
                      {sub.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>

        {/* Return quantities table */}
        <table
          style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}
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
                Original Location
              </th>
              <th style={{ padding: '0.4rem 0.6rem', textAlign: 'right' }}>
                Available
              </th>
              <th style={{ padding: '0.4rem 0.6rem', textAlign: 'right' }}>
                Return
              </th>
            </tr>
          </thead>
          <tbody>
            {(details || []).map((d) => {
              const wpu = parseFloat(d.weight_per_unit) || 0;
              const split = splits[d.staging_item_id] || {};
              return (
                <tr
                  key={d.staging_item_id}
                  style={{ borderBottom: '1px solid #dee2e6' }}
                >
                  <td
                    style={{ padding: '0.4rem 0.6rem', fontFamily: 'monospace' }}
                  >
                    {d.lot_number}
                  </td>
                  <td style={{ padding: '0.4rem 0.6rem', fontSize: '0.8rem' }}>
                    {(d.origin_rows || []).length > 0
                      // Every rack it came off (PART 3, U2), not one.
                      ? d.origin_rows
                          .map((o) => (o.units ? `${o.storage_row_name} (${o.units})` : o.storage_row_name))
                          .join(', ')
                      : [d.location_name, d.sub_location_name]
                          .filter(Boolean)
                          .join(' / ') || '—'}
                  </td>
                  <td
                    style={{
                      padding: '0.4rem 0.6rem',
                      textAlign: 'right',
                      fontWeight: 600,
                    }}
                  >
                    {d.available}
                  </td>
                  {d.is_counted && wpu > 0 ? (
                    <td
                      style={{
                        padding: '0.4rem 0.6rem',
                        textAlign: 'right',
                        width: '220px',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          gap: '0.4rem',
                          justifyContent: 'flex-end',
                          alignItems: 'center',
                        }}
                      >
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={split.full ?? ''}
                          onChange={(e) =>
                            setSplits((prev) => ({
                              ...prev,
                              [d.staging_item_id]: {
                                ...prev[d.staging_item_id],
                                full: e.target.value,
                              },
                            }))
                          }
                          title={`Full ${pluralizeUnit(d.unit_label || 'unit')}`}
                          style={{
                            width: '60px',
                            padding: '0.3rem',
                            borderRadius: '4px',
                            border: '1px solid #ccc',
                            textAlign: 'right',
                            fontSize: '0.85rem',
                          }}
                        />
                        <span style={{ fontSize: '0.75rem', color: '#6c757d' }}>
                          full +
                        </span>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={split.partial ?? ''}
                          onChange={(e) =>
                            setSplits((prev) => ({
                              ...prev,
                              [d.staging_item_id]: {
                                ...prev[d.staging_item_id],
                                partial: e.target.value,
                              },
                            }))
                          }
                          title={`Weighed remainder (${d.weight_unit || 'lbs'})`}
                          placeholder="weighed"
                          style={{
                            width: '80px',
                            padding: '0.3rem',
                            borderRadius: '4px',
                            border: '1px solid #ccc',
                            textAlign: 'right',
                            fontSize: '0.85rem',
                          }}
                        />
                        <span style={{ fontSize: '0.75rem', color: '#6c757d' }}>
                          {d.weight_unit || 'lbs'}
                        </span>
                      </div>
                      <div
                        style={{
                          marginTop: '0.2rem',
                          fontSize: '0.75rem',
                          color: '#6c757d',
                        }}
                      >
                        = {countedQty(d).toFixed(2)} {d.weight_unit || 'lbs'}
                        {` (${d.unit_label || 'unit'} holds ${wpu})`}
                      </div>
                    </td>
                  ) : (
                    <td
                      style={{
                        padding: '0.4rem 0.6rem',
                        textAlign: 'right',
                        width: '120px',
                      }}
                    >
                      <input
                        type="number"
                        min="0"
                        max={d.available}
                        step="0.01"
                        value={quantities[d.staging_item_id] ?? ''}
                        onChange={(e) =>
                          setQuantities((prev) => ({
                            ...prev,
                            [d.staging_item_id]: Math.min(
                              parseFloat(e.target.value) || 0,
                              d.available
                            ),
                          }))
                        }
                        style={{
                          width: '100%',
                          padding: '0.3rem',
                          borderRadius: '4px',
                          border: '1px solid #ccc',
                          textAlign: 'right',
                          fontSize: '0.85rem',
                        }}
                      />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
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
        <button
          onClick={onClose}
          style={{
            padding: '0.5rem 1.25rem',
            borderRadius: '6px',
            border: '1px solid #ccc',
            background: 'white',
            color: '#374151', // a global button colour made this white on white (PART 3, U5)
            cursor: 'pointer',
            fontSize: '0.9rem',
          }}
        >
          Cancel
        </button>
        <button
          onClick={handleReturn}
          disabled={submitting || !canSubmit}
          style={{
            padding: '0.5rem 1.5rem',
            borderRadius: '6px',
            border: 'none',
            backgroundColor: !canSubmit ? '#6c757d' : '#fd7e14',
            color: 'white',
            cursor: submitting ? 'wait' : 'pointer',
            fontWeight: 600,
            fontSize: '0.9rem',
          }}
        >
          {submitting ? 'Returning...' : 'Confirm Return'}
        </button>
      </div>
    </ModalOverlay>
  );
};

export default ReturnModal;
