// Ingredient intake approvals queue — SPEC §7 (approval gate) and §18.2 R-9
// (a rejection must say what happens to the drums that were already scanned).
//
// Visual language is deliberately the same as ReceiptsTab: `.approval-card`
// grid, `.summary-grid`, `.requester-row`, `.modal-overlay`. Those classes come
// from ApprovalsPage.css, which the parent page already imports.
//
// Intakes are fetched here rather than from AppDataContext — the queue is a
// single filtered request and the containers behind it are high-cardinality.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../context/ConfirmContext';
import { formatDate, formatDateTime, formatTimeAgo, getDaysAgo } from '../../utils/dateUtils';
import { formatCalendarDate } from '../../utils/labelPayload';
import { formatUserInitial, formatUserName } from '../../utils/userDisplay';
import {
  CONTAINER_TYPE,
  INTAKE_STATUS,
  ROLES,
  containerUnitLabel,
} from '../../constants';
import {
  apiErrorMessage,
  approveIntake,
  listIntakes,
  rejectIntake,
} from '../../api/ingredientContainerApi';

// Disposition is an intake-rejection argument, not a persisted status/role/
// category, so it is not part of constants/index.js. Kept as an object rather
// than inline literals so the two call sites cannot drift apart.
const REJECT_DISPOSITION = {
  FIX_AND_RESUBMIT: 'fix_and_resubmit',
  RETURN_TO_VENDOR: 'return_to_vendor',
};

const INTAKE_PAGE_SIZE = 50;

const getPriorityLevel = (days) => {
  if (days < 1) return { label: 'New', color: '#10b981' };
  if (days < 3) return { label: 'Recent', color: '#10b981' };
  if (days < 7) return { label: 'Moderate', color: '#f59e0b' };
  return { label: 'Urgent', color: '#ef4444' };
};

const SOURCE_LABELS = {
  truck: 'Truck delivery',
  legacy_sweep: 'Floor sweep (cutover)',
};

// A lot's counts are in ITS container type; the intake header uses the
// backend's `count_unit`. Never "cases" (§19.1).
const lotUnit = (lot, count) => containerUnitLabel(lot?.container_type, count);

const intakeUnit = (intake, count) => {
  const unit = intake?.count_unit;
  if (!unit) return containerUnitLabel(null, count);
  // count_unit arrives pluralised for the intake as a whole; singularise only
  // the obvious cases rather than guessing at arbitrary server strings.
  if (Number(count) === 1 && unit.endsWith('s')) return unit.slice(0, -1);
  return unit;
};

const IngredientIntakesTab = ({ userNameMap = {}, onPendingCountChange }) => {
  const { user } = useAuth();
  const { addToast } = useToast();
  const { confirm } = useConfirm();

  const currentUserId = user?.id || user?.username;

  const [intakes, setIntakes] = useState([]);
  const [total, setTotal] = useState(0);
  // Gates the badge publish below: a seeded 0 must never reach ApprovalsPage.
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [actingId, setActingId] = useState(null);

  const [rejectTarget, setRejectTarget] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectDisposition, setRejectDisposition] = useState(REJECT_DISPOSITION.FIX_AND_RESUBMIT);
  const [isRejecting, setIsRejecting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await listIntakes({
        status: INTAKE_STATUS.SUBMITTED,
        limit: INTAKE_PAGE_SIZE,
      });
      const data = response?.data || {};
      setIntakes(Array.isArray(data.items) ? data.items : []);
      setTotal(Number(data.total) || 0);
      setLoadedOnce(true);
      setTruncated(Boolean(data.truncated));
      setLoadError(null);
    } catch (error) {
      setLoadError(apiErrorMessage(error, 'Failed to load ingredient intakes'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Publish the badge count only once a fetch has actually succeeded. Firing on
  // the seeded 0 would overwrite ApprovalsPage's own count with a zero before
  // this tab has loaded — and leave it at zero forever if the fetch fails, which
  // reads as "no ingredient intakes waiting" rather than "we could not check".
  useEffect(() => {
    if (loadedOnce) onPendingCountChange?.(total);
  }, [loadedOnce, total, onPendingCountChange]);

  const sorted = useMemo(
    () => [...intakes].sort(
      (a, b) => new Date(a.submitted_at || a.receipt_date || 0) - new Date(b.submitted_at || b.receipt_date || 0),
    ),
    [intakes],
  );

  // Warehouse workers may approve, but never their own submission — the backend
  // 403s on it. Disable rather than hide so the queue count still adds up.
  const isSelfSubmitted = (intake) =>
    user?.role === ROLES.WAREHOUSE && intake.submitted_by === String(currentUserId);

  const handleApprove = async (intake) => {
    const scanned = Number(intake.scanned_count) || 0;
    const ok = await confirm(
      `Approve intake ${intake.intake_number}? ${scanned} ${intakeUnit(intake, scanned)} go into stock immediately.`,
      { title: 'Approve ingredient intake', confirmLabel: 'Approve' },
    );
    if (!ok) return;
    setActingId(intake.id);
    try {
      await approveIntake(intake.id);
      addToast(`Intake ${intake.intake_number} approved`, 'success');
      await load();
    } catch (error) {
      addToast(apiErrorMessage(error, 'Failed to approve intake'), 'error');
    } finally {
      setActingId(null);
    }
  };

  const openRejectModal = (intake) => {
    setRejectTarget(intake);
    setRejectReason('');
    setRejectDisposition(REJECT_DISPOSITION.FIX_AND_RESUBMIT);
  };

  const closeRejectModal = () => {
    setRejectTarget(null);
    setRejectReason('');
    setRejectDisposition(REJECT_DISPOSITION.FIX_AND_RESUBMIT);
  };

  const handleReject = async () => {
    if (!rejectTarget) return;
    if (!rejectReason.trim()) {
      addToast('A rejection needs a reason.', 'error');
      return;
    }
    setIsRejecting(true);
    try {
      await rejectIntake(rejectTarget.id, {
        reason: rejectReason.trim(),
        disposition: rejectDisposition,
      });
      addToast(
        rejectDisposition === REJECT_DISPOSITION.RETURN_TO_VENDOR
          ? `Intake ${rejectTarget.intake_number} rejected — containers marked returned to vendor`
          : `Intake ${rejectTarget.intake_number} sent back for correction`,
        'success',
      );
      closeRejectModal();
      await load();
    } catch (error) {
      addToast(apiErrorMessage(error, 'Failed to reject intake'), 'error');
    } finally {
      setIsRejecting(false);
    }
  };

  const renderFlags = (intake) => {
    const flags = [];
    const shortCount = Number(intake.short_count) || 0;
    const damaged = Number(intake.damaged_count) || 0;
    if (shortCount > 0) {
      flags.push({
        key: 'short',
        text: `Short ${shortCount} ${intakeUnit(intake, shortCount)}`,
        detail: intake.short_reason,
        bg: '#fef3c7',
        fg: '#92400e',
      });
    }
    if (intake.over_received) {
      flags.push({
        key: 'over',
        text: 'Over-received',
        detail: intake.over_reason,
        bg: '#ffedd5',
        fg: '#9a3412',
      });
    }
    if (damaged > 0) {
      flags.push({
        key: 'damaged',
        text: `${damaged} damaged`,
        detail: null,
        bg: '#fee2e2',
        fg: '#991b1b',
      });
    }
    if (flags.length === 0) return null;
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
        {flags.map((flag) => (
          <span
            key={flag.key}
            className="badge"
            title={flag.detail || undefined}
            style={{ background: flag.bg, color: flag.fg }}
          >
            {flag.text}{flag.detail ? ` · ${flag.detail}` : ''}
          </span>
        ))}
      </div>
    );
  };

  const renderLotLines = (intake) => {
    const lots = Array.isArray(intake.lots) ? intake.lots : [];
    if (lots.length === 0) return <p className="muted small">No lot lines on this intake.</p>;
    return (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
              <th style={{ textAlign: 'left', padding: '4px 6px', color: '#6b7280', fontWeight: 500 }}>Product</th>
              <th style={{ textAlign: 'left', padding: '4px 6px', color: '#6b7280', fontWeight: 500 }}>Vendor lot</th>
              <th style={{ textAlign: 'left', padding: '4px 6px', color: '#6b7280', fontWeight: 500 }}>BBD</th>
              <th style={{ textAlign: 'right', padding: '4px 6px', color: '#6b7280', fontWeight: 500 }}>Expected</th>
              <th style={{ textAlign: 'right', padding: '4px 6px', color: '#6b7280', fontWeight: 500 }}>Printed</th>
              <th style={{ textAlign: 'right', padding: '4px 6px', color: '#6b7280', fontWeight: 500 }}>Scanned</th>
            </tr>
          </thead>
          <tbody>
            {lots.map((lot) => {
              const expected = Number(lot.expected_count) || 0;
              const minted = Number(lot.minted_count) || 0;
              const scanned = Number(lot.scanned_count) || 0;
              const shortLine = scanned < expected;
              return (
                <tr key={lot.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '4px 6px' }}>
                    <strong>{lot.product_name || 'Unknown product'}</strong>
                    {lot.product_sid ? <span className="muted"> · {lot.product_sid}</span> : null}
                    <div className="muted small">
                      {lot.container_type === CONTAINER_TYPE.BAG ? 'Bags' : 'Barrels'}
                      {lot.net_weight_per_container
                        ? ` · ${lot.net_weight_per_container} ${lot.weight_unit || ''} each`
                        : ''}
                      {lot.brix ? ` · ${lot.brix} Brix` : ''}
                    </div>
                  </td>
                  <td style={{ padding: '4px 6px', fontFamily: 'monospace' }}>
                    {lot.lot_unknown ? <em className="muted">Lot unknown</em> : (lot.vendor_lot || '—')}
                  </td>
                  <td style={{ padding: '4px 6px' }}>{lot.bbd ? formatCalendarDate(lot.bbd) : '—'}</td>
                  <td style={{ padding: '4px 6px', textAlign: 'right' }}>
                    {expected} {lotUnit(lot, expected)}
                  </td>
                  <td style={{ padding: '4px 6px', textAlign: 'right' }}>
                    {minted} {lotUnit(lot, minted)}
                  </td>
                  <td
                    style={{
                      padding: '4px 6px',
                      textAlign: 'right',
                      fontWeight: 600,
                      color: shortLine ? '#b45309' : '#166534',
                    }}
                  >
                    {scanned} {lotUnit(lot, scanned)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const renderRowBreakdown = (intake) => {
    const rows = Array.isArray(intake.row_breakdown) ? intake.row_breakdown : [];
    if (rows.length === 0) {
      return <p className="muted small">Nothing placed yet — no rows hold containers from this intake.</p>;
    }
    return (
      <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '13px' }}>
        {rows.map((row) => {
          const count = Number(row.count) || 0;
          return (
            <li key={row.storage_row_id} style={{ marginBottom: '4px' }}>
              <strong>{row.storage_row_name || row.storage_row_id}</strong>
              {row.location_path ? <span className="muted"> · {row.location_path}</span> : null}
              {' — '}
              {count} {intakeUnit(intake, count)}
            </li>
          );
        })}
      </ul>
    );
  };

  const renderCard = (intake) => {
    const days = getDaysAgo(intake.submitted_at || intake.receipt_date);
    const priority = getPriorityLevel(days);
    const expanded = expandedId === intake.id;
    const expected = Number(intake.expected_count) || 0;
    const scanned = Number(intake.scanned_count) || 0;
    const minted = Number(intake.minted_count) || 0;
    const acting = actingId === intake.id;
    const selfSubmitted = isSelfSubmitted(intake);

    return (
      <article key={intake.id} className="approval-card" style={{ borderLeft: `4px solid ${priority.color}` }}>
        <header>
          <div>
            <h3>{intake.intake_number}</h3>
            <span className="badge">{intake.vendor_name || 'No vendor'}</span>
            <span className="badge" style={{ marginLeft: '6px', background: '#eff6ff', color: '#1d4ed8' }}>
              {SOURCE_LABELS[intake.source] || intake.source || 'Intake'}
            </span>
          </div>
          <div className="meta">
            <span className="priority-badge" style={{ background: priority.color, color: 'white' }}>
              {priority.label}
            </span>
            <span className="timestamp">{formatTimeAgo(intake.submitted_at || intake.receipt_date)}</span>
          </div>
        </header>

        {renderFlags(intake)}

        <dl className="summary-grid">
          <div>
            <dt>Received</dt>
            <dd style={{ fontWeight: 600, color: scanned < expected ? '#b45309' : 'inherit' }}>
              {scanned} of {expected} {intakeUnit(intake, expected)}
            </dd>
          </div>
          <div>
            <dt>Labels printed</dt>
            <dd>{minted} {intakeUnit(intake, minted)}</dd>
          </div>
          <div>
            <dt>Receipt date</dt>
            <dd>{intake.receipt_date ? formatDate(intake.receipt_date) : '—'}</dd>
          </div>
          <div>
            <dt>BOL</dt>
            <dd>{intake.bol || '—'}</dd>
          </div>
          <div>
            <dt>Purchase order</dt>
            <dd>{intake.purchase_order || '—'}</dd>
          </div>
          <div>
            <dt>Lot lines</dt>
            <dd>{(intake.lots || []).length}</dd>
          </div>
        </dl>

        {intake.notes ? (
          <p className="muted small" style={{ marginTop: '-4px' }}>Notes: {intake.notes}</p>
        ) : null}

        <button
          type="button"
          className="link-button"
          onClick={() => setExpandedId(expanded ? null : intake.id)}
          style={{ alignSelf: 'flex-start' }}
        >
          {expanded ? 'Hide lot lines & placement' : 'Show lot lines & placement'}
        </button>

        {expanded && (
          <div
            style={{
              background: '#f9fafb',
              border: '1px solid #e5e7eb',
              borderRadius: '8px',
              padding: '12px 14px',
              marginTop: '10px',
            }}
          >
            <h4 style={{ margin: '0 0 8px', fontSize: '13px', fontWeight: 600 }}>Lot lines</h4>
            {renderLotLines(intake)}
            <h4 style={{ margin: '14px 0 8px', fontSize: '13px', fontWeight: 600 }}>Where they landed</h4>
            {renderRowBreakdown(intake)}
          </div>
        )}

        <div className="requester-row">
          <span className="requester-avatar">{formatUserInitial(intake.submitted_by, userNameMap)}</span>
          <span className="requester-label">
            <strong>{formatUserName(intake.submitted_by, userNameMap)}</strong> submitted this intake
            {intake.submitted_at ? ` · ${formatDateTime(intake.submitted_at)}` : ''}
          </span>
        </div>

        {selfSubmitted && (
          <p className="muted small" style={{ color: '#b45309' }}>
            You submitted this intake — someone else has to approve it.
          </p>
        )}

        <footer>
          <button
            type="button"
            className="secondary-button"
            disabled={acting || selfSubmitted}
            onClick={() => handleApprove(intake)}
            style={{ marginRight: '8px' }}
          >
            {acting ? 'Working…' : 'Approve'}
          </button>
          <button
            type="button"
            className="secondary-button danger"
            disabled={acting}
            onClick={() => openRejectModal(intake)}
          >
            Reject
          </button>
        </footer>
      </article>
    );
  };

  const rejectUnit = rejectTarget
    ? intakeUnit(rejectTarget, Number(rejectTarget.scanned_count) || 0)
    : 'containers';

  return (
    <>
      <section className="panel">
        <div className="panel-header horizontal">
          <div>
            <h2>Ingredient Intakes</h2>
            <p className="muted">
              {loading
                ? 'Loading…'
                : `${total} intake${total === 1 ? '' : 's'} awaiting approval`}
            </p>
          </div>
          <div className="panel-actions">
            <button type="button" className="secondary-button" onClick={load} disabled={loading}>
              Refresh
            </button>
          </div>
        </div>

        {truncated && (
          <p className="muted small" style={{ color: '#b45309' }}>
            Showing the first {INTAKE_PAGE_SIZE} of {total} submitted intakes.
          </p>
        )}

        {loadError && (
          <div className="empty-state" style={{ padding: '24px', textAlign: 'center', color: '#b91c1c' }}>
            <p>{loadError}</p>
            <button type="button" className="secondary-button" onClick={load}>Try again</button>
          </div>
        )}

        {!loadError && !loading && sorted.length === 0 && (
          <div className="empty-state" style={{ padding: '48px', textAlign: 'center' }}>
            <p>No ingredient intakes awaiting approval.</p>
          </div>
        )}

        {!loadError && sorted.length > 0 && (
          <div className="card-grid">{sorted.map(renderCard)}</div>
        )}
      </section>

      {rejectTarget && (
        <div className="modal-overlay">
          <div className="modal">
            <h3>Reject intake {rejectTarget.intake_number}</h3>
            <p className="muted">
              Scanned {rejectUnit} never silently disappear. Say what happens to them.
            </p>

            <div className="form-group">
              <label>
                <span>What happens to the containers</span>
              </label>
              <label
                style={{
                  display: 'block',
                  border: `1px solid ${rejectDisposition === REJECT_DISPOSITION.FIX_AND_RESUBMIT ? '#1d4ed8' : '#e5e7eb'}`,
                  borderRadius: '8px',
                  padding: '10px 12px',
                  marginBottom: '8px',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="radio"
                  name="reject-disposition"
                  value={REJECT_DISPOSITION.FIX_AND_RESUBMIT}
                  checked={rejectDisposition === REJECT_DISPOSITION.FIX_AND_RESUBMIT}
                  onChange={() => setRejectDisposition(REJECT_DISPOSITION.FIX_AND_RESUBMIT)}
                />
                <strong style={{ marginLeft: '8px' }}>Fix and resubmit</strong>
                <div className="muted small" style={{ marginTop: '4px' }}>
                  A data problem. The intake reopens for correction and comes back for approval.
                  Every scanned {rejectUnit} keeps its serial, its status and its rack — nothing
                  physically moves.
                </div>
              </label>
              <label
                style={{
                  display: 'block',
                  border: `1px solid ${rejectDisposition === REJECT_DISPOSITION.RETURN_TO_VENDOR ? '#b91c1c' : '#e5e7eb'}`,
                  borderRadius: '8px',
                  padding: '10px 12px',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="radio"
                  name="reject-disposition"
                  value={REJECT_DISPOSITION.RETURN_TO_VENDOR}
                  checked={rejectDisposition === REJECT_DISPOSITION.RETURN_TO_VENDOR}
                  onChange={() => setRejectDisposition(REJECT_DISPOSITION.RETURN_TO_VENDOR)}
                />
                <strong style={{ marginLeft: '8px' }}>Return to vendor</strong>
                <div className="muted small" style={{ marginTop: '4px' }}>
                  The material physically goes back on the truck. Every {rejectUnit} on this intake
                  is marked returned to vendor and leaves stock. Only pick this if the product is
                  actually leaving the building.
                </div>
              </label>
            </div>

            <div className="form-group">
              <label>
                <span>Reason</span>
                <textarea
                  value={rejectReason}
                  onChange={(event) => setRejectReason(event.target.value)}
                  placeholder="What is wrong with this intake?"
                  rows={4}
                  required
                />
              </label>
            </div>

            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={closeRejectModal} disabled={isRejecting}>
                Cancel
              </button>
              <button
                type="button"
                className="secondary-button danger"
                onClick={handleReject}
                disabled={!rejectReason.trim() || isRejecting}
              >
                {isRejecting ? 'Rejecting…' : 'Reject intake'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default IngredientIntakesTab;
