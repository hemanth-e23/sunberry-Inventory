import React, { useState } from 'react';
import { useAppData } from '../../context/AppDataContext';
import { useToast } from '../../context/ToastContext';
import apiClient from '../../api/client';
import ModalOverlay from './ModalOverlay';
import ReturnModal from './ReturnModal';
import MarkUsedModal from './MarkUsedModal';
import { formatDate } from '../../utils/dateUtils';

/**
 * CloseOutModal
 *
 * Shows the reconciliation table (staged / used / returned / leftover) for a
 * staging request and lets the user return or mark-used any leftover items
 * before completing the close-out.
 *
 * Props:
 *   requestId  {string|number}  staging request ID
 *   data       {object}         close-out payload from /close-out-data
 *                               { request, items, batches_completed, total_batches }
 *   loading    {boolean}        true while close-out data is being loaded
 *   error      {string}         error message from initial load, if any
 *   productionError {string}    set when the Production app could not be
 *                               reached (N5): the figures are this system's
 *                               own, and a supervisor may close on them
 *   canCloseWithoutProduction {boolean}  supervisor+ (mirrors the server)
 *   onClose    {function}       called when the modal should close
 *   onSuccess  {function}       called after successful close-out so parent can refresh
 */
const CloseOutModal = ({
  requestId,
  data,
  loading,
  error: loadError,
  productionError = null,
  canCloseWithoutProduction = false,
  onClose,
  onSuccess,
}) => {
  // useAppData called directly as per project convention
  useAppData();
  const { addToast } = useToast();

  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');
  const [submittingCloseOut, setSubmittingCloseOut] = useState(false);
  // N5: the confirm step before closing on this system's figures.
  const [confirmLocal, setConfirmLocal] = useState(false);
  const localOnly = Boolean(productionError);

  // Inline close-out data state so "Refresh" works without lifting state
  const [localData, setLocalData] = useState(data);
  // Keep localData in sync if parent passes new data prop (on mount)
  React.useEffect(() => {
    setLocalData(data);
  }, [data]);

  // Sub-modal state
  const [returnModalProps, setReturnModalProps] = useState(null);
  const [markUsedModalProps, setMarkUsedModalProps] = useState(null);

  const refreshCloseOutData = async () => {
    try {
      const resp = await apiClient.get(
        `/service/staging-requests/${requestId}/close-out-data`,
        localOnly ? { params: { skip_production: true } } : undefined,
      );
      setLocalData(resp.data);
    } catch (err) {
      setActionError(err.response?.data?.detail || 'Failed to refresh');
    }
  };

  const handleCompleteCloseOut = async () => {
    if (!requestId) return;
    const hasLeftover = localData?.items?.some((i) => (i.leftover || 0) > 0.001);
    if (hasLeftover) {
      setActionError(
        'Return or mark as used all leftover materials before closing out.'
      );
      return;
    }
    if (localOnly && !confirmLocal) {
      setConfirmLocal(true);
      return;
    }
    setSubmittingCloseOut(true);
    setActionError('');
    try {
      await apiClient.post(
        `/service/staging-requests/${requestId}/close-out`,
        localOnly ? { without_production: true } : {}
      );
      const successMsg = localOnly
        ? 'Staging request closed on this system\'s figures (no Production data).'
        : 'Staging request closed.';
      addToast(successMsg, 'success');
      if (onSuccess) onSuccess();
      onClose();
    } catch (err) {
      const errMsg =
        err.response?.data?.detail || 'Failed to close out.';
      setActionError(errMsg);
      addToast(errMsg, 'error');
    } finally {
      setSubmittingCloseOut(false);
      setConfirmLocal(false);
    }
  };

  const openReturnFromRow = (row) => {
    const details = row.staging_details.map((d) => ({
      ...d,
      _itemId: d.item_id,
      lot_number: d.lot_number ?? '—',
      location_name: d.location_name ?? '',
      sub_location_name: d.sub_location_name ?? '',
    }));
    const groupItem = {
      ingredient_name: row.ingredient_name,
      sid: row.sid,
      unit: row.unit,
    };
    setReturnModalProps({ item: groupItem, details });
  };

  const openMarkUsedFromRow = (row) => {
    const details = row.staging_details.map((d) => ({
      staging_item_id: d.staging_item_id,
      available: d.available,
      _itemId: d.item_id,
      lot_number: d.lot_number ?? '—',
      quantity_staged: d.quantity_staged ?? 0,
      // Hold flag + container counts for the Mark Used dialog (PART 3, B3/U5).
      is_held: d.is_held,
      hold_message: d.hold_message,
      units_staged: d.units_staged,
      staged_unit_weight: d.staged_unit_weight,
      unit_label: d.unit_label,
      weight_unit: d.weight_unit,
    }));
    const groupItem = {
      ingredient_name: row.ingredient_name,
      sid: row.sid,
      unit: row.unit,
    };
    setMarkUsedModalProps({ item: groupItem, details });
  };

  const hasLeftover = localData?.items?.some((i) => (i.leftover || 0) > 0.001);
  // Without Production's figures only a supervisor may close (server agrees).
  const closeBlocked = submittingCloseOut || hasLeftover
    || (localOnly && !canCloseWithoutProduction);

  return (
    <>
      <ModalOverlay
        onClose={() => {
          setActionError('');
          setActionSuccess('');
          onClose();
        }}
      >
        <div style={{ maxWidth: 720, maxHeight: '90vh', overflow: 'auto' }}>
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
              <h3
                style={{ margin: 0, fontSize: '1.15rem', color: '#212529' }}
              >
                Close Out — Reconcile Leftovers
              </h3>
              {localData && (
                <p
                  style={{
                    margin: '0.25rem 0 0',
                    fontSize: '0.9rem',
                    color: '#6c757d',
                  }}
                >
                  {localData.request?.product_name} ·{' '}
                  {localData.request?.production_date
                    ? formatDate(localData.request.production_date + 'T12:00:00')
                    : ''}
                  {localOnly
                    ? ' · batches: not known (Production not reached)'
                    : ` · ${localData.batches_completed}/${localData.total_batches} batches completed`}
                </p>
              )}
            </div>
            <button
              onClick={() => {
                setActionError('');
                setActionSuccess('');
                onClose();
              }}
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

          {/* Toast-style banners inside modal */}
          {actionSuccess && (
            <div
              style={{
                padding: '0.5rem 1rem',
                margin: '0 1.5rem',
                marginTop: '0.5rem',
                backgroundColor: '#d4edda',
                color: '#155724',
                borderRadius: '6px',
                fontSize: '0.85rem',
              }}
            >
              {actionSuccess}
            </div>
          )}
          {actionError && (
            <div
              style={{
                padding: '0.5rem 1rem',
                margin: '0 1.5rem',
                marginTop: '0.5rem',
                backgroundColor: '#f8d7da',
                color: '#721c24',
                borderRadius: '6px',
                fontSize: '0.85rem',
              }}
            >
              {actionError}
            </div>
          )}

          {/* Content */}
          {loading ? (
            <div
              style={{
                padding: '2rem',
                textAlign: 'center',
                color: '#6c757d',
              }}
            >
              Syncing with Production and loading data...
            </div>
          ) : loadError ? (
            <div style={{ padding: '1.5rem', color: '#721c24' }}>
              {loadError}
            </div>
          ) : localData ? (
            <>
              {localOnly && (
                <div
                  role="alert"
                  style={{
                    margin: '1rem 1.5rem 0',
                    padding: '0.75rem 1rem',
                    background: '#fff7ed',
                    border: '1px solid #fdba74',
                    borderRadius: '6px',
                    color: '#7c2d12',
                    fontSize: '0.88rem',
                    lineHeight: 1.45,
                  }}
                >
                  <strong>Production usage could not be fetched.</strong>{' '}
                  {productionError}
                  <br />
                  The figures below are this system&apos;s own: what was staged, marked used
                  and returned here. Anything the floor used but nobody marked used here shows
                  as leftover — mark it used (or return it) before closing.
                  {!canCloseWithoutProduction && (
                    <>
                      <br />
                      Only a supervisor can close out without the Production app&apos;s figures.
                    </>
                  )}
                </div>
              )}
              <div style={{ padding: '1rem 1.5rem' }}>
                <table
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: '0.9rem',
                  }}
                >
                  <thead>
                    <tr
                      style={{
                        borderBottom: '2px solid #dee2e6',
                        backgroundColor: '#f6f7fb',
                      }}
                    >
                      <th
                        style={{
                          padding: '0.5rem 0.75rem',
                          textAlign: 'left',
                        }}
                      >
                        Ingredient
                      </th>
                      <th
                        style={{
                          padding: '0.5rem 0.75rem',
                          textAlign: 'right',
                        }}
                      >
                        Staged
                      </th>
                      <th
                        style={{
                          padding: '0.5rem 0.75rem',
                          textAlign: 'right',
                        }}
                      >
                        Used
                      </th>
                      <th
                        style={{
                          padding: '0.5rem 0.75rem',
                          textAlign: 'right',
                        }}
                      >
                        Returned
                      </th>
                      <th
                        style={{
                          padding: '0.5rem 0.75rem',
                          textAlign: 'right',
                          color: '#dc3545',
                        }}
                      >
                        Leftover
                      </th>
                      <th
                        style={{
                          padding: '0.5rem 0.75rem',
                          textAlign: 'center',
                          minWidth: 160,
                        }}
                      >
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {localData.items.map((row, idx) => (
                      <tr
                        key={idx}
                        style={{
                          borderBottom: '1px solid #dee2e6',
                          backgroundColor:
                            row.leftover > 0 ? '#fff8f8' : 'transparent',
                        }}
                      >
                        <td style={{ padding: '0.5rem 0.75rem' }}>
                          {row.ingredient_name}
                        </td>
                        <td
                          style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}
                        >
                          {row.quantity_staged.toLocaleString()} {row.unit || ''}
                        </td>
                        <td
                          style={{
                            padding: '0.5rem 0.75rem',
                            textAlign: 'right',
                            color: '#155724',
                          }}
                        >
                          {row.quantity_used.toLocaleString()} {row.unit || ''}
                        </td>
                        <td
                          style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}
                        >
                          {row.quantity_returned.toLocaleString()} {row.unit || ''}
                        </td>
                        <td
                          style={{
                            padding: '0.5rem 0.75rem',
                            textAlign: 'right',
                            fontWeight: row.leftover > 0 ? 700 : 400,
                            color: row.leftover > 0 ? '#dc3545' : '#6c757d',
                          }}
                        >
                          {row.leftover > 0
                            ? `${row.leftover.toLocaleString()} ${row.unit || ''}`
                            : '—'}
                        </td>
                        <td
                          style={{
                            padding: '0.5rem 0.75rem',
                            textAlign: 'center',
                          }}
                        >
                          {row.leftover > 0 ? (
                            <div
                              style={{
                                display: 'flex',
                                gap: '0.25rem',
                                justifyContent: 'center',
                                flexWrap: 'wrap',
                              }}
                            >
                              <button
                                onClick={() => openReturnFromRow(row)}
                                style={{
                                  padding: '3px 10px',
                                  borderRadius: '4px',
                                  border: '1px solid #fd7e14',
                                  backgroundColor: '#fd7e14',
                                  color: 'white',
                                  fontSize: '0.75rem',
                                  cursor: 'pointer',
                                  fontWeight: 500,
                                }}
                              >
                                Return
                              </button>
                              <button
                                onClick={() => openMarkUsedFromRow(row)}
                                style={{
                                  padding: '3px 10px',
                                  borderRadius: '4px',
                                  border: '1px solid #28a745',
                                  backgroundColor: '#28a745',
                                  color: 'white',
                                  fontSize: '0.75rem',
                                  cursor: 'pointer',
                                  fontWeight: 500,
                                }}
                              >
                                Mark Used
                              </button>
                            </div>
                          ) : (
                            <span style={{ fontSize: '0.8rem', color: '#6c757d' }}>
                              —
                            </span>
                          )}
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
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '0.5rem',
                }}
              >
                <button
                  onClick={refreshCloseOutData}
                  style={{
                    padding: '0.5rem 1rem',
                    borderRadius: '6px',
                    border: '1px solid #6c757d',
                    background: 'white',
                    color: '#374151', // a global button colour made this white on white (PART 3, U5)
                    cursor: 'pointer',
                    fontSize: '0.85rem',
                  }}
                >
                  Refresh
                </button>
                {confirmLocal && (
                  <div
                    role="alertdialog"
                    style={{
                      flexBasis: '100%',
                      padding: '0.6rem 0.85rem',
                      background: '#fff7ed',
                      border: '1px solid #fdba74',
                      borderRadius: '6px',
                      color: '#7c2d12',
                      fontSize: '0.85rem',
                    }}
                  >
                    Close out WITHOUT the Production app&apos;s usage? The request is closed on
                    the figures above, and that is recorded on it.
                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                      <button
                        type="button"
                        onClick={() => setConfirmLocal(false)}
                        style={{
                          padding: '0.4rem 0.9rem',
                          borderRadius: '6px',
                          border: '1px solid #6c757d',
                          background: 'white',
                          color: '#374151',
                          cursor: 'pointer',
                        }}
                      >
                        Go back
                      </button>
                      <button
                        type="button"
                        onClick={handleCompleteCloseOut}
                        disabled={submittingCloseOut}
                        style={{
                          padding: '0.4rem 0.9rem',
                          borderRadius: '6px',
                          border: 'none',
                          background: '#c2410c',
                          color: 'white',
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        {submittingCloseOut ? 'Closing...' : 'Confirm — close on these figures'}
                      </button>
                    </div>
                  </div>
                )}
                {!confirmLocal && (
                  <button
                    onClick={handleCompleteCloseOut}
                    disabled={closeBlocked}
                    style={{
                      padding: '0.5rem 1.5rem',
                      borderRadius: '6px',
                      border: 'none',
                      backgroundColor: closeBlocked ? '#6c757d' : '#0d6efd',
                      color: 'white',
                      cursor: closeBlocked ? 'not-allowed' : 'pointer',
                      fontWeight: 600,
                      fontSize: '0.9rem',
                    }}
                  >
                    {submittingCloseOut
                      ? 'Closing...'
                      : localOnly ? 'Close out on these figures…' : 'Complete Close Out'}
                  </button>
                )}
              </div>
            </>
          ) : null}
        </div>
      </ModalOverlay>

      {/* Sub-modal: Return */}
      {returnModalProps && (
        <ReturnModal
          requestId={requestId}
          item={returnModalProps.item}
          details={returnModalProps.details}
          fromCloseOut={true}
          onClose={() => setReturnModalProps(null)}
          onSuccess={() => {
            if (onSuccess) onSuccess();
          }}
          onCloseOutRefresh={refreshCloseOutData}
        />
      )}

      {/* Sub-modal: Mark Used */}
      {markUsedModalProps && (
        <MarkUsedModal
          requestId={requestId}
          item={markUsedModalProps.item}
          details={markUsedModalProps.details}
          fromCloseOut={true}
          onClose={() => setMarkUsedModalProps(null)}
          onSuccess={() => {
            if (onSuccess) onSuccess();
          }}
          onCloseOutRefresh={refreshCloseOutData}
        />
      )}
    </>
  );
};

export default CloseOutModal;
