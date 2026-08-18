import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { getReceivingSession } from '../../api/lotReceivingApi';

/**
 * Paperwork vs scanned, per rack — what the second worker actually checks.
 *
 * The approval is a CHECK, not a gate on stock. The units are already in the
 * racks and already count as availability; the dock was never blocked waiting
 * for this. What is being confirmed is that the paperwork and the scanning
 * agree, and where the difference is if they do not.
 *
 * ── Why this fetches instead of reading the receipt it was handed ───────────
 *
 * The obvious implementation reads `rawMaterialRowAllocations` off the receipt
 * the approvals list already has — no request, and the projection keeps it live.
 * It is wrong, and wrong in a way that would quietly train approvers to ignore
 * the number.
 *
 * That JSON is projected per LOT, not per receipt: `project_lot` writes the
 * whole lot's placement picture onto the newest receipt for that lot and blanks
 * the older ones. So when a second truck brings 40 more of a vendor lot the
 * first truck already delivered, the newest receipt's JSON reads 120 while its
 * own `container_count` says 40 — a false "+80 over-receipt" on a delivery that
 * was exactly right, and the earlier receipt showing nothing at all.
 *
 * `GET /lot-receiving/sessions/{id}` returns the count scoped to THIS receipt's
 * own scan events and this receipt's own lot, which is the comparison the
 * approver is actually being asked to make. One request per card that has a lot,
 * on a queue that is small by construction.
 */

const ReceivingCheck = ({ receipt }) => {
  const [summary, setSummary] = useState(null);
  const [failed, setFailed] = useState(false);

  const receiptId = receipt?.id;
  // Receipts with no lot were never counted in — nothing to check, no request.
  const hasLot = Boolean(receipt?.materialLotId || receipt?.material_lot_id);

  useEffect(() => {
    if (!receiptId || !hasLot) return undefined;
    let cancelled = false;
    getReceivingSession(receiptId)
      .then((data) => { if (!cancelled) setSummary(data); })
      .catch(() => { if (!cancelled) setFailed(true); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [receiptId, hasLot]);

  if (!hasLot) return null;
  if (failed) {
    // Say so rather than rendering nothing. An absent panel reads as "this
    // receipt had no scanning", which is a different and much more comfortable
    // claim than "we could not check".
    return (
      <div className="receiving-check">
        <div className="receiving-check-note">
          <AlertTriangle size={13} /> Could not load the scanned counts for this receipt.
        </div>
      </div>
    );
  }
  if (!summary) return null;

  const { expected_count: expected, scanned_count: scanned, difference } = summary;
  const unit = summary.count_unit || 'units';

  return (
    <div className="receiving-check">
      <div className="receiving-check-head">
        <span className="receiving-check-title">
          Counted in{summary.lot_code ? ` · ${summary.lot_code}` : ''}
        </span>
        <span
          className="receiving-check-total"
          style={difference === 0 ? undefined : { color: '#b45309', fontWeight: 700 }}
        >
          {scanned} of {expected} {unit}
          {difference !== 0 && ` (${difference > 0 ? '+' : ''}${difference})`}
        </span>
      </div>

      {/* Amber, never red. Both directions are legal and both happen: 78 against
          an expected 80 is a short truck, 82 is an over-receipt. Neither is a
          failure to be blocked — they are facts to be seen and explained, and
          colouring them red trains people to click past the colour. */}
      {difference !== 0 && (
        <div className="receiving-check-note">
          <AlertTriangle size={13} />
          {difference > 0
            ? `${difference} more than the paperwork says. Over-receipts are allowed — confirm the count is right.`
            : `${-difference} short of the paperwork. Confirm the count before approving.`}
        </div>
      )}

      {summary.needs_review && (
        <div className="receiving-check-note">
          <AlertTriangle size={13} /> This lot is flagged for review — no stickers
          print for it until somebody resolves that.
        </div>
      )}

      <ul className="receiving-check-rows">
        {(summary.rows || []).map((row) => (
          <li key={row.storage_row_id}>
            <span>{row.storage_row_name}</span>
            <span>{row.count} {unit}</span>
          </li>
        ))}
      </ul>

      {summary.derived_weight != null && (
        <div className="receiving-check-note" style={{ color: 'inherit' }}>
          {/* Weight is DERIVED from the count, and shown second for that reason.
              The count is what a person can check against the rack. */}
          {summary.derived_weight} {summary.weight_per_unit ? '' : ''}
          {' '}derived from {scanned} × {summary.weight_per_unit ?? '—'} each
        </div>
      )}
    </div>
  );
};

export default ReceivingCheck;
