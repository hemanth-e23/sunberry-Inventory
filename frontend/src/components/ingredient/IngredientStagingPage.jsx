/**
 * Ingredient staging — desk view (SPEC §11).
 *
 * The supervisor's counterpart to the gun flow: who is pulling what, how far
 * along each line is, and which specific drums went to which batch. Three
 * things here are the point of the screen rather than decoration:
 *
 *  - CLAIMS ARE VISIBLE AND REASSIGNABLE. A line claimed by someone who has
 *    gone home blocks the pull; a supervisor can force-release it. Scans
 *    already made keep their attribution — releasing a claim never rewrites
 *    history (§18.4 S-2).
 *
 *  - OVER-PULL READS AS A SURPLUS, NOT AN ERROR. `remaining` is floored server
 *    -side and the excess arrives as `over_pulled`, so a line shows
 *    "complete, +500 over" instead of a negative (§18.4 S-5).
 *
 *  - THE SERIAL LIST IS THE TRACE. Which drums are on a line is the answer to
 *    "what went into this batch", which was a spreadsheet exercise before.
 *
 * Read-mostly by design: the actual pulling happens on the gun, in front of the
 * rack. The only mutation offered here is releasing a claim.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../context/ConfirmContext';
import { useAppData } from '../../context/AppDataContext';
import { ROLES } from '../../constants';
import { formatDate } from '../../utils/dateUtils';
import {
  getLine,
  listStagingRequests,
  unclaimLine,
} from '../../api/ingredientStagingApi';
import './IngredientStagingPage.css';

const errText = (err, fallback) =>
  err?.response?.data?.detail || err?.message || fallback;

const OPEN_STATUSES = new Set(['pending', 'in_progress', 'partial']);

const IngredientStagingPage = () => {
  const { user } = useAuth();
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const { users } = useAppData();

  const [requests, setRequests] = useState([]);
  // Serialized detail per line id — the request list carries only the legacy
  // quantity fields, so container counts and claims come from a second call.
  const [lines, setLines] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [busyLine, setBusyLine] = useState(null);

  const canReassign = useMemo(() => {
    const rank = { [ROLES.SUPERVISOR]: 2, [ROLES.ADMIN]: 3, [ROLES.CORPORATE_ADMIN]: 5, [ROLES.SUPERADMIN]: 6 };
    return (rank[user?.role] ?? 0) >= 2;
  }, [user]);

  /** claimed_by is a USER ID; the only place the name appears is the 409 text. */
  const userName = useCallback((id) => {
    if (!id) return null;
    const match = (users || []).find((u) => String(u.id) === String(id));
    return match?.name || match?.username || id;
  }, [users]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listStagingRequests();
      const all = Array.isArray(data) ? data : [];
      setRequests(all);

      // Fetch serialized detail for every line in view. Failures are per-line
      // and non-fatal: a legacy (non-serialized) line has no container state and
      // simply has no entry here.
      const detail = {};
      await Promise.all(
        all.flatMap((request) => (request.items || []).map(async (item) => {
          try {
            detail[item.id] = await getLine(item.id);
          } catch { /* legacy or unreachable line — render the legacy numbers */ }
        })),
      );
      setLines(detail);
    } catch (err) {
      setError(errText(err, 'Could not load staging requests.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRelease = async (item) => {
    const line = lines[item.id];
    const holder = userName(line?.claimed_by);
    // confirm(message, options) — not an object-first signature.
    const ok = await confirm(
      `${item.ingredient_name} is claimed by ${holder}. Releasing lets someone else pull it. `
      + 'Drums already scanned stay on the line and keep their original scanner.',
      { title: 'Release this claim?', confirmText: 'Release' },
    );
    if (!ok) return;

    setBusyLine(item.id);
    try {
      await unclaimLine(item.id, { force: true });
      addToast('Claim released.', 'success');
      await load();
    } catch (err) {
      addToast(errText(err, 'Could not release the claim.'), 'error');
    } finally {
      setBusyLine(null);
    }
  };

  const visible = useMemo(
    () => requests.filter((r) => showClosed || OPEN_STATUSES.has(r.status)),
    [requests, showClosed],
  );

  return (
    <div className="ingstg-page">
      <header className="ingstg-head">
        <div>
          <h1>Ingredient Staging</h1>
          <p className="ingstg-sub">
            Serialized pulls per production request — who claimed each line, how far it is,
            and exactly which drums went to the batch.
          </p>
        </div>
        <label className="ingstg-toggle">
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(event) => setShowClosed(event.target.checked)}
          />
          Show closed
        </label>
      </header>

      {loading && <p className="ingstg-muted">Loading…</p>}
      {error && <div className="ingstg-banner ingstg-banner--error">{error}</div>}
      {!loading && !error && visible.length === 0 && (
        <p className="ingstg-muted">No staging requests to show.</p>
      )}

      {visible.map((request) => (
        <section key={request.id} className="ingstg-card">
          <div className="ingstg-card-head">
            <div>
              <span className="ingstg-title">
                {request.product_name || request.formula_name || 'Batch'}
              </span>
              <span className="ingstg-uid">{request.production_batch_uid}</span>
            </div>
            <div className="ingstg-card-meta">
              <span className={`ingstg-pill ingstg-pill--${request.status}`}>{request.status}</span>
              {request.production_date && <span>{formatDate(request.production_date)}</span>}
              {request.number_of_batches > 1 && <span>×{request.number_of_batches} batches</span>}
            </div>
          </div>

          <table className="ingstg-table">
            <thead>
              <tr>
                <th>Ingredient</th>
                <th>Progress</th>
                <th>Containers</th>
                <th>Claimed by</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {(request.items || []).map((item) => {
                const line = lines[item.id];
                const needed = Number(line?.quantity_needed ?? item.quantity_needed ?? 0);
                const pulled = Number(line?.quantity_fulfilled ?? item.quantity_fulfilled ?? 0);
                const over = Number(line?.over_pulled || 0);
                const remaining = Number(line?.remaining ?? Math.max(0, needed - pulled));
                const serials = line?.serials || [];
                const holderId = line?.claimed_by;

                return (
                  <React.Fragment key={item.id}>
                    <tr>
                      <td>
                        <div className="ingstg-ing">{item.ingredient_name}</div>
                        {item.sid && <div className="ingstg-sid">{item.sid}</div>}
                      </td>
                      <td>
                        <div className="ingstg-qty">
                          {pulled} / {needed} {item.unit || ''}
                        </div>
                        <div className="ingstg-sub-line">
                          {remaining > 0
                            ? `${remaining} remaining`
                            : <span className="ingstg-ok">complete</span>}
                          {over > 0 && <span className="ingstg-over"> · +{over} over</span>}
                        </div>
                      </td>
                      <td>
                        {line
                          ? `${line.container_count || 0} ${line.count_unit || ''}`.trim()
                          : <span className="ingstg-muted">legacy line</span>}
                      </td>
                      <td>
                        {holderId
                          ? <span className="ingstg-claim">{userName(holderId)}</span>
                          : <span className="ingstg-muted">unclaimed</span>}
                      </td>
                      <td className="ingstg-actions">
                        {holderId && canReassign && (
                          <button
                            type="button"
                            className="ingstg-btn"
                            disabled={busyLine === item.id}
                            onClick={() => handleRelease(item)}
                          >
                            Release
                          </button>
                        )}
                      </td>
                    </tr>
                    {serials.length > 0 && (
                      <tr className="ingstg-serial-row">
                        <td colSpan={5}>
                          <span className="ingstg-serial-label">Drums on this line:</span>
                          {serials.map((serial) => (
                            <code key={serial} className="ingstg-serial">{serial}</code>
                          ))}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
};

export default IngredientStagingPage;
