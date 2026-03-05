import React, { useState, useMemo } from 'react';
import { useAppData } from '../../context/AppDataContext';
import { useToast } from '../../context/ToastContext';
import apiClient from '../../api/client';
import ModalOverlay from './ModalOverlay';

/**
 * ReturnModal
 *
 * Props:
 *   requestId        {string|number}  staging request ID
 *   item             {object}         consolidated item/group (ingredient_name, id, ...)
 *   details          {array}          pre-fetched staging details with available quantities
 *                                     Each element: { staging_item_id, lot_number, location_name,
 *                                                     sub_location_name, available, _itemId }
 *   fromCloseOut     {boolean}        true when launched from CloseOutModal
 *   onClose          {function}       called when the modal should close
 *   onSuccess        {function}       called after successful return so parent can refresh
 *   onCloseOutRefresh {function}      optional — called to refresh close-out data after success
 */
const ReturnModal = ({
  requestId,
  item,
  details,
  fromCloseOut,
  onClose,
  onSuccess,
  onCloseOutRefresh,
}) => {
  const { locations, subLocationMap } = useAppData();
  const { addToast } = useToast();

  const [returnLocation, setReturnLocation] = useState('');
  const [returnSubLocation, setReturnSubLocation] = useState('');
  const [quantities, setQuantities] = useState(() => {
    const qtys = {};
    (details || []).forEach((d) => {
      qtys[d.staging_item_id] = d.available;
    });
    return qtys;
  });
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');

  const returnSubLocOptions = useMemo(() => {
    if (!returnLocation) return [];
    return subLocationMap[returnLocation] || [];
  }, [returnLocation, subLocationMap]);

  const handleReturn = async () => {
    if (!returnLocation) {
      setActionError('Please select a return location.');
      return;
    }
    setSubmitting(true);
    setActionError('');
    setActionSuccess('');

    try {
      for (const detail of details || []) {
        const qty = parseFloat(quantities[detail.staging_item_id]) || 0;
        if (qty <= 0) continue;

        const itemId = detail._itemId ?? item.id;
        await apiClient.post(
          `/service/staging-requests/${requestId}/items/${itemId}/return`,
          {
            staging_item_id: detail.staging_item_id,
            quantity: qty,
            to_location_id: returnLocation,
            to_sub_location_id: returnSubLocation || null,
          }
        );
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

        {/* Return location selector */}
        <div style={{ marginBottom: '1rem' }}>
          <label
            style={{
              display: 'block',
              fontWeight: 600,
              marginBottom: '0.4rem',
              fontSize: '0.9rem',
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
                value={returnSubLocation}
                onChange={(e) => setReturnSubLocation(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  borderRadius: '6px',
                  border: '1px solid #ccc',
                  fontSize: '0.9rem',
                }}
              >
                <option value="">None</option>
                {returnSubLocOptions.map((sub) => (
                  <option key={sub.id} value={sub.id}>
                    {sub.name}
                  </option>
                ))}
              </select>
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
                Return Qty
              </th>
            </tr>
          </thead>
          <tbody>
            {(details || []).map((d) => (
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
                  {[d.location_name, d.sub_location_name]
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
              </tr>
            ))}
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
            cursor: 'pointer',
            fontSize: '0.9rem',
          }}
        >
          Cancel
        </button>
        <button
          onClick={handleReturn}
          disabled={submitting || !returnLocation}
          style={{
            padding: '0.5rem 1.5rem',
            borderRadius: '6px',
            border: 'none',
            backgroundColor: !returnLocation ? '#6c757d' : '#fd7e14',
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
