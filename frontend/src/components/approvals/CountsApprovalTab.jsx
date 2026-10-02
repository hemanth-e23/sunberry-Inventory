import React, { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../context/ConfirmContext';
import {
  apiErrorMessage, approveCountRequest, listCountRequests, rejectCountRequest,
} from '../../api/lotReceivingApi';
import { formatDateTime } from '../../utils/dateUtils';
import { countWithUnit } from '../../utils/rowSources';

/**
 * Counts waiting for a supervisor (2026-10-02, owner's decision): a warehouse
 * user's recount or "found" entry no longer changes stock until approved.
 * Each card states the system's figure at submit, the count, and the change.
 */
const CountsApprovalTab = ({ userNameMap = {}, onPendingCountChange }) => {
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const [requests, setRequests] = useState([]);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await listCountRequests('pending');
      setRequests(data || []);
      onPendingCountChange?.((data || []).length);
    } catch (error) {
      addToast(apiErrorMessage(error, 'Could not load counts'), 'error');
    }
  }, [addToast, onPendingCountChange]);

  useEffect(() => { load(); }, [load]);

  const approve = async (req) => {
    const ok = await confirm(
      `Apply this count? ${req.storage_row_name} will be set to ${countWithUnit(req.full_units, req.unit_label)}`
        + (req.open_units ? ` + ${req.open_units} open (${req.open_remaining_qty} lbs)` : '')
        + ' and the books will follow.',
      { title: 'Approve count', confirmLabel: 'Approve count' },
    );
    if (!ok) return;
    setBusyId(req.id);
    try {
      await approveCountRequest(req.id);
      addToast('Count applied.', 'success');
      await load();
    } catch (error) {
      addToast(apiErrorMessage(error, 'Could not approve this count'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (req) => {
    // A reject is final for this count — confirm it like an approve (two were
    // rejected by a stray click in the re-check).
    const ok = await confirm(
      `Reject this count of ${req.storage_row_name}? Nothing changes in stock; the counter can count again.`,
      { title: 'Reject count', confirmLabel: 'Reject count' },
    );
    if (!ok) return;
    const reason = 'Rejected by supervisor';
    setBusyId(req.id);
    try {
      await rejectCountRequest(req.id, reason);
      addToast('Count rejected — nothing changed.', 'info');
      await load();
    } catch (error) {
      addToast(apiErrorMessage(error, 'Could not reject this count'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  if (!requests.length) {
    return <p className="muted" style={{ padding: 16 }}>No counts waiting for approval.</p>;
  }

  return (
    <div className="approval-grid">
      {requests.map((req) => {
        const change = Number(req.variance_units) || 0;
        const isFound = req.kind === 'found';
        return (
          <article key={req.id} className="approval-card">
            <header>
              <div>
                <h3>{req.product_name || 'Unknown product'}</h3>
                <span className="badge">{isFound ? 'Found stock' : 'Recount'}</span>
                {' '}<span className="badge" style={{ marginLeft: 6 }}>Lot {req.vendor_lot || '—'}</span>
              </div>
            </header>
            <dl className="summary-grid">
              <div><dt>Rack</dt><dd>{req.storage_row_name}</dd></div>
              {!isFound && (
                <div>
                  <dt>System said</dt>
                  <dd>
                    {countWithUnit(req.system_full_units || 0, req.unit_label)}
                    {req.system_open_units ? ` + ${req.system_open_units} open (${req.system_open_qty} lbs)` : ''}
                  </dd>
                </div>
              )}
              <div>
                <dt>{isFound ? 'Found' : 'Counted'}</dt>
                <dd>
                  {countWithUnit(req.full_units, req.unit_label)}
                  {req.open_units ? ` + ${req.open_units} open (${req.open_remaining_qty} lbs)` : ''}
                </dd>
              </div>
              <div>
                <dt>Change</dt>
                <dd style={{ fontWeight: 700, color: change < 0 ? '#dc2626' : change > 0 ? '#16a34a' : undefined }}>
                  {change > 0 ? '+' : ''}{countWithUnit(change, req.unit_label)}
                </dd>
              </div>
              <div><dt>Counted by</dt><dd>{userNameMap[req.submitted_by] || req.submitted_by || '—'}</dd></div>
              <div><dt>When</dt><dd>{formatDateTime(req.submitted_at)}</dd></div>
              {req.note && <div><dt>Note</dt><dd>{req.note}</dd></div>}
            </dl>
            <div className="approval-actions" style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="primary-button" disabled={busyId === req.id} onClick={() => approve(req)}>
                Approve
              </button>
              <button type="button" className="secondary-button" disabled={busyId === req.id} onClick={() => reject(req)}>
                Reject
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
};

export default CountsApprovalTab;
