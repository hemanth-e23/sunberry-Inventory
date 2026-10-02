import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Truck } from 'lucide-react';
import { approveTruck, getTruck, apiErrorMessage } from '../../api/lotReceivingApi';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../context/ConfirmContext';
import { formatCalendarDate } from '../../utils/labelPayload';
import { attentionFlags, describeFlag, formatUnitTotals } from '../../utils/truckReceiving';
import { approvableLines, approvalBookingNotes, countOf, isRejectedLine } from '../../utils/incomingLines';

/**
 * One card per TRUCK (incoming order) on the approvals page, instead of one per
 * lot line (2026-10).
 *
 * What the approver is checking: this was on the paperwork, this was scanned,
 * into these racks — and everything the gun flagged on the way (drums from a lot
 * not on this truck, more than the paperwork, recounts that disagreed, held lots,
 * over-full racks, a short with its reason). Flags lead, because they are the
 * reason to look twice.
 *
 * "Approve truck" approves every line in ONE server transaction, so a truck is
 * never left half-approved. "Edit" opens the existing per-receipt drawer for
 * one line — corrections go through the same update path as any receipt.
 */
const TruckApprovalCard = ({ orderId, receiptIds, onEdit, onApproved }) => {
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const [truck, setTruck] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    getTruck(orderId)
      .then((data) => { if (!cancelled) { setTruck(data); setError(''); } })
      .catch((err) => { if (!cancelled) setError(apiErrorMessage(err, 'Could not load this truck')); });
    return () => { cancelled = true; };
  }, [orderId]);

  // Refetch when the set of pending receipts changes — an edit in the drawer
  // or another approver's action.
  const receiptKey = (receiptIds || []).join(',');
  useEffect(() => load(), [load, receiptKey]);

  const handleApprove = async () => {
    // Approval books what was SCANNED. Say which lines that makes short or
    // over BEFORE the click, not in a toast after it (2026-10-01, F15).
    const notes = approvalBookingNotes(truck);
    const question = `Approve ${countOf(approvableLines(truck).length, 'line')} of `
      + `${truck.order_number} and close it?`;
    const ok = await confirm(
      notes.length ? (
        <>
          {question}
          {notes.map((note) => (
            <span key={note} style={{ display: 'block', marginTop: 8, color: '#b45309', fontWeight: 600 }}>
              {note}
            </span>
          ))}
        </>
      ) : question,
      { title: 'Approve truck', confirmLabel: 'Approve truck' },
    );
    if (!ok) return;
    setBusy(true);
    try {
      const result = await approveTruck(orderId);
      addToast(
        `${truck.order_number} approved — ${countOf(result.approved_receipts, 'line')}`
          + (result.not_delivered ? `; ${countOf(result.not_delivered, 'line')} closed as not delivered` : ''),
        'success',
      );
      setTruck(result.truck);
      await onApproved?.();
    } catch (err) {
      addToast(apiErrorMessage(err, 'Could not approve this truck'), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <article className="approval-card truck-card">
        <div className="receiving-check-note"><AlertTriangle size={13} /> {error}</div>
      </article>
    );
  }
  if (!truck) {
    return <article className="approval-card truck-card"><p className="muted">Loading truck…</p></article>;
  }

  // Flags about a rejected line are history, not something to approve over.
  const rejectedIds = new Set((truck.lines || []).filter(isRejectedLine).map((l) => l.line_id));
  const flags = attentionFlags((truck.flags || []).filter((f) => !rejectedIds.has(f.line_id)));
  const finished = Boolean(truck.forklift_submitted_at);
  const pending = new Set(receiptIds || []);

  return (
    <article className="approval-card truck-card">
      <header>
        <div>
          <h3><Truck size={18} /> {truck.order_number}</h3>
          <span className="badge">
            {[truck.vendor_name || truck.origin_name, truck.bol && `BOL ${truck.bol}`,
              truck.purchase_order && `PO ${truck.purchase_order}`].filter(Boolean).join(' · ')}
          </span>
        </div>
        <div className="meta">
          <span className={`truck-card-state ${finished ? 'is-ready' : 'is-open'}`}>
            {finished ? 'Scanned — ready' : 'Still being scanned'}
          </span>
          <span className="timestamp">{formatUnitTotals(truck.totals)}</span>
        </div>
      </header>

      {flags.length > 0 && (
        <ul className="truck-card-flags">
          {flags.map((f) => (
            <li key={f.id}><AlertTriangle size={13} /> {describeFlag(f)}</li>
          ))}
        </ul>
      )}

      <div className="table-wrapper">
        <table className="simple-table truck-card-table">
          <thead>
            <tr>
              <th>Product · lot</th>
              <th>Scanned</th>
              <th>Racks</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {truck.lines.map((line) => (
              <tr key={line.line_id} className={line.difference !== 0 ? 'truck-card-diff' : ''}>
                <td>
                  <strong>{line.product_name}</strong>
                  {line.is_held && <span className="truck-card-held"> HELD</span>}
                  <span className="truck-card-sub">
                    Lot {line.vendor_lot || '—'}
                    {line.bbd ? ` · BBD ${formatCalendarDate(line.bbd)}` : ''}
                    {line.expected_count === 0 ? ' · not on paperwork' : ''}
                  </span>
                </td>
                <td>
                  <strong>{line.scanned_count}</strong> of {line.expected_count}
                  {line.difference !== 0 && (
                    <span className="truck-card-delta">
                      {' '}({line.difference > 0 ? `+${line.difference}` : line.difference})
                    </span>
                  )}
                </td>
                <td>
                  {line.rows.map((r) => `${r.storage_row_name} ×${r.count}`).join(', ') || '—'}
                </td>
                <td>
                  {line.receipt_id && pending.has(line.receipt_id) && (
                    <button type="button" className="link-button" onClick={() => onEdit(line.receipt_id)}>
                      Edit
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="requester-row muted">
        {truck.scanned_by?.length ? `Scanned by ${truck.scanned_by.join(', ')}` : 'Nothing scanned yet'}
        {truck.short_reason ? ` · Short: ${truck.short_reason}` : ''}
      </div>

      <footer>
        <button
          type="button"
          className="primary-button"
          onClick={handleApprove}
          disabled={busy || !finished}
          title={finished ? '' : 'The forklift has not finished this truck yet'}
        >
          {busy ? 'Approving…' : 'Approve truck'}
        </button>
      </footer>
    </article>
  );
};

export default TruckApprovalCard;
