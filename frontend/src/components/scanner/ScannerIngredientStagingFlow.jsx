/**
 * Ingredient staging on the gun — SPEC §11, §18.4.
 *
 * The pull side of serialization: production asks for material, a worker claims
 * a line, and scans specific drums against it. Three things here are deliberate
 * inversions of how the finished-goods flows behave, and each one is a spec
 * requirement rather than a preference:
 *
 *  1. THE FEFO LIST IS ADVISORY. It is rendered as a suggestion, not a
 *     worklist, and scanning something not on it is allowed — with a reason.
 *     A rack is a physical place; the drum in front of the worker wins over the
 *     drum the database would have preferred (§11.4).
 *
 *  2. OVER-PULL IS RECORDED, NOT BLOCKED. `remaining` is floored at zero
 *     server-side and the excess arrives separately as `over_pulled`, so a line
 *     that took one drum too many reads "complete, +500 lbs over" instead of a
 *     counter stuck below zero (§18.4 S-5).
 *
 *  3. A RETURN REQUIRES A DESTINATION ROW SCAN. There is no "put it back"
 *     button that guesses. Without a row there is nothing to re-credit, and the
 *     path this replaces never re-credited the rack at all — so occupancy drifted
 *     down a little on every staging round, forever (§11.5).
 *
 * Claims are atomic server-side; the loser gets a 409 whose message names the
 * holder, which is shown verbatim because the line payload carries only an id.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import ScannerLayout from './ScannerLayout';
import ScanFeedback from './ScanFeedback';
import NetworkStatus from './NetworkStatus';
import { useAuth } from '../../context/AuthContext';
import { CONTAINER_STATUS, containerUnitLabel } from '../../constants';
import { formatDate } from '../../utils/dateUtils';
import {
  claimLine,
  getFefoSuggestions,
  getLine,
  listStagingRequests,
  returnContainer,
  stageContainer,
  unclaimLine,
} from '../../api/ingredientStagingApi';
import { resolveIngredientRow } from '../../api/ingredientIntakeApi';
import { decodeContainerPayload } from '../../utils/labelPayload';
import './ScannerIngredientStagingFlow.css';

/** Server error text, or a fallback. FastAPI puts the useful sentence in
 *  `detail` — including the 409 that names whoever holds a claim. */
const errText = (err, fallback) =>
  err?.response?.data?.detail || err?.message || fallback;

/** A staging line is ours to work if nobody holds it, or we do. */
const isMine = (line, userId) =>
  line?.claimed_by != null && String(line.claimed_by) === String(userId);

// ─── request / line list ─────────────────────────────────────────────────────

const StagingRequestList = () => {
  const navigate = useNavigate();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listStagingRequests();
      // Only requests that still need pulling. A fulfilled request on the gun
      // is noise the worker has to scroll past.
      const open = (Array.isArray(data) ? data : []).filter(
        (r) => r.status !== 'fulfilled' && r.status !== 'closed' && r.status !== 'cancelled',
      );
      setRequests(open);
    } catch (err) {
      setError(errText(err, 'Could not load staging requests.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <ScannerLayout title="Ingredient Staging" showBack onBack={() => navigate('/forklift')}>
      <NetworkStatus />
      <div className="sis-list">
        {loading && <p className="sis-muted">Loading staging requests…</p>}
        {error && <div className="sis-banner sis-banner--error">{error}</div>}
        {!loading && !error && requests.length === 0 && (
          <p className="sis-muted">No open staging requests.</p>
        )}

        {requests.map((request) => {
          const items = request.items || [];
          const done = items.filter((i) => i.status === 'fulfilled').length;
          return (
            <div key={request.id} className="sis-request-card">
              <div className="sis-request-head">
                <span className="sis-request-title">{request.product_name || request.formula_name || 'Batch'}</span>
                <span className="sis-request-uid">{request.production_batch_uid}</span>
              </div>
              {request.production_date && (
                <div className="sis-muted sis-small">Production {formatDate(request.production_date)}</div>
              )}
              <div className="sis-muted sis-small">{done} of {items.length} lines complete</div>

              <div className="sis-lines">
                {items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`sis-line-btn${item.status === 'fulfilled' ? ' sis-line-btn--done' : ''}`}
                    onClick={() => navigate(`/forklift/ingredient-staging/${item.id}`)}
                  >
                    <span className="sis-line-name">{item.ingredient_name}</span>
                    <span className="sis-line-qty">
                      {Number(item.quantity_fulfilled || 0)} / {Number(item.quantity_needed || 0)} {item.unit || ''}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </ScannerLayout>
  );
};

// ─── one line: claim → pull → return ─────────────────────────────────────────

const StagingLineSession = ({ itemId }) => {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [line, setLine] = useState(null);
  const [fefo, setFefo] = useState([]);
  const [row, setRow] = useState(null);          // staging destination (optional)
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState(null);
  const [scanValue, setScanValue] = useState('');
  const [mode, setMode] = useState('pull');      // 'pull' | 'return'
  // An off-list pull is allowed but must carry a reason; this holds the serial
  // awaiting that reason rather than blocking the scan outright.
  const [offListPrompt, setOffListPrompt] = useState(null);
  const [offListReason, setOffListReason] = useState('');
  const [returnPrompt, setReturnPrompt] = useState(null);

  const inputRef = useRef(null);

  /** Keep the wedge focused: a gun trigger must always land somewhere. */
  const refocus = useCallback(() => {
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const refresh = useCallback(async () => {
    const [detail, suggestions] = await Promise.all([
      getLine(itemId),
      getFefoSuggestions(itemId).catch(() => []),
    ]);
    setLine(detail);
    setFefo(Array.isArray(suggestions) ? suggestions : []);
    return detail;
  }, [itemId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        await refresh();
        if (!cancelled) setError('');
      } catch (err) {
        if (!cancelled) setError(errText(err, 'Could not load this line.'));
      } finally {
        if (!cancelled) { setLoading(false); refocus(); }
      }
    })();
    return () => { cancelled = true; };
  }, [refresh, refocus]);

  const mine = isMine(line, user?.id);
  const unclaimed = line != null && line.claimed_by == null;

  const fefoSerials = useMemo(
    () => new Set(fefo.map((c) => c.serial)),
    [fefo],
  );

  // ── claim ──────────────────────────────────────────────────────────────────

  const handleClaim = async () => {
    setBusy(true);
    setError('');
    try {
      await claimLine(itemId);
      await refresh();
    } catch (err) {
      // The 409 detail is the ONLY place the holder's name exists — the line
      // payload carries just an id. Show it as-is.
      setError(errText(err, 'Could not claim this line.'));
    } finally {
      setBusy(false);
      refocus();
    }
  };

  const handleUnclaim = async () => {
    setBusy(true);
    setError('');
    try {
      await unclaimLine(itemId);
      await refresh();
    } catch (err) {
      setError(errText(err, 'Could not release this line.'));
    } finally {
      setBusy(false);
      refocus();
    }
  };

  // ── pull ───────────────────────────────────────────────────────────────────

  const submitPull = useCallback(async (serial, reason) => {
    setBusy(true);
    setError('');
    try {
      const result = await stageContainer(itemId, {
        serial,
        staging_row_id: row?.id || null,
        off_list_reason: reason || null,
      });
      setFeedback({
        type: result.status === 'already_staged' ? 'info' : 'success',
        message: result.message || `${serial} staged`,
      });
      await refresh();
    } catch (err) {
      // Held / wrong product / not in stock all arrive here with a specific
      // sentence from the server. Never flatten them into one message.
      setFeedback({ type: 'error', message: errText(err, 'Scan rejected.') });
    } finally {
      setBusy(false);
      setOffListPrompt(null);
      setOffListReason('');
      refocus();
    }
  }, [itemId, row, refresh, refocus]);

  const handleScan = useCallback(async (raw) => {
    const text = (raw || '').trim();
    if (!text) return;
    setScanValue('');

    // The label encodes SB1|serial|lot|bbd; a bare serial is also valid so a
    // damaged code can be hand-keyed.
    let serial = text;
    try {
      const decoded = decodeContainerPayload(text);
      if (decoded?.serial) serial = decoded.serial;
    } catch { /* not a payload — treat the input as a serial */ }

    if (mode === 'return') {
      setReturnPrompt({ serial });
      return;
    }

    if (!mine) {
      setFeedback({ type: 'error', message: 'Claim this line before pulling.' });
      refocus();
      return;
    }

    // Off-list is allowed — but the reason is collected BEFORE the request, so
    // the record is never written without it.
    if (fefoSerials.size > 0 && !fefoSerials.has(serial)) {
      setOffListPrompt({ serial });
      return;
    }
    await submitPull(serial, null);
  }, [mode, mine, fefoSerials, submitPull, refocus]);

  // ── return ─────────────────────────────────────────────────────────────────

  const submitReturn = async (serial, code) => {
    setBusy(true);
    setError('');
    try {
      const resolved = await resolveIngredientRow(code);
      const result = await returnContainer(itemId, { serial, toRowId: resolved.id });
      setFeedback({ type: 'success', message: result.message || `${serial} returned` });
      await refresh();
      setReturnPrompt(null);
    } catch (err) {
      setFeedback({ type: 'error', message: errText(err, 'Return failed.') });
    } finally {
      setBusy(false);
      refocus();
    }
  };

  // ── staging row context (optional for pulls) ───────────────────────────────

  const handleRowCode = async (code) => {
    try {
      const resolved = await resolveIngredientRow(code);
      setRow(resolved);
      setFeedback({ type: 'info', message: `Staging into ${resolved.name}` });
    } catch (err) {
      setFeedback({ type: 'error', message: errText(err, 'Row not recognised.') });
    } finally {
      refocus();
    }
  };

  if (loading) {
    return (
      <ScannerLayout title="Staging" showBack onBack={() => navigate('/forklift/ingredient-staging')}>
        <p className="sis-muted">Loading…</p>
      </ScannerLayout>
    );
  }

  const needed = Number(line?.quantity_needed || 0);
  const pulled = Number(line?.quantity_fulfilled || 0);
  const remaining = Number(line?.remaining || 0);
  const over = Number(line?.over_pulled || 0);
  const pct = needed > 0 ? Math.min(100, (pulled / needed) * 100) : 0;

  return (
    <ScannerLayout
      title="Ingredient Staging"
      showBack
      onBack={() => navigate('/forklift/ingredient-staging')}
    >
      <NetworkStatus />

      <div className="sis-session">
        {/* progress — over-pull is shown as a surplus, never a negative */}
        <div className="sis-progress-card">
          <div className="sis-progress-nums">
            <span className="sis-progress-big">{pulled}</span>
            <span className="sis-progress-sep">/</span>
            <span>{needed} {line?.count_unit ? '' : ''}</span>
          </div>
          <div className="sis-progress-bar">
            <div className={`sis-progress-fill${over > 0 ? ' sis-progress-fill--over' : ''}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="sis-progress-meta">
            <span>{remaining > 0 ? `${remaining} remaining` : 'Complete'}</span>
            {over > 0 && <span className="sis-over">+{over} over</span>}
            <span>
              {line?.container_count || 0}{' '}
              {line?.count_unit || containerUnitLabel(null, line?.container_count || 0)} pulled
            </span>
          </div>
        </div>

        {/* claim state */}
        {unclaimed && (
          <button type="button" className="sis-btn sis-btn--primary" disabled={busy} onClick={handleClaim}>
            Claim this line
          </button>
        )}
        {!unclaimed && !mine && (
          <div className="sis-banner sis-banner--warn">
            Claimed by someone else. Ask them to release it, or have a supervisor reassign.
          </div>
        )}
        {mine && (
          <div className="sis-claim-row">
            <span className="sis-claim-badge">Claimed by you</span>
            <button type="button" className="sis-btn sis-btn--ghost" disabled={busy} onClick={handleUnclaim}>
              Release
            </button>
          </div>
        )}

        {error && <div className="sis-banner sis-banner--error">{error}</div>}
        {feedback && <ScanFeedback type={feedback.type} message={feedback.message} />}

        {/* staging destination — optional, but frees the rack when set */}
        <div className="sis-row-context">
          <span className="sis-muted sis-small">
            {row ? `Staging into ${row.name}` : 'No staging row set — drums stay in place'}
          </span>
        </div>

        {/* mode */}
        <div className="sis-modes">
          <button
            type="button"
            className={`sis-mode${mode === 'pull' ? ' sis-mode--on' : ''}`}
            onClick={() => { setMode('pull'); refocus(); }}
          >
            Pull
          </button>
          <button
            type="button"
            className={`sis-mode${mode === 'return' ? ' sis-mode--on' : ''}`}
            onClick={() => { setMode('return'); refocus(); }}
          >
            Return
          </button>
        </div>

        {/* the wedge input */}
        <form
          className="sis-scan-form"
          onSubmit={(event) => { event.preventDefault(); handleScan(scanValue); }}
        >
          <input
            ref={inputRef}
            className="sis-scan-input"
            value={scanValue}
            onChange={(event) => setScanValue(event.target.value)}
            placeholder={mode === 'pull' ? 'Scan a drum…' : 'Scan the drum to return…'}
            autoFocus
            autoComplete="off"
            disabled={busy}
          />
        </form>

        <details className="sis-row-set">
          <summary>Set staging row</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const code = new FormData(event.currentTarget).get('rowcode');
              if (code) handleRowCode(String(code).trim());
              event.currentTarget.reset();
            }}
          >
            <input name="rowcode" className="sis-scan-input" placeholder="Scan a row barcode…" autoComplete="off" />
          </form>
        </details>

        {/* FEFO — a suggestion, and labelled as one */}
        <div className="sis-fefo">
          <div className="sis-fefo-head">
            Suggested order <span className="sis-muted sis-small">— advisory; scan what is actually there</span>
          </div>
          {fefo.length === 0 && <p className="sis-muted sis-small">No suggestions available.</p>}
          {fefo.slice(0, 12).map((container) => (
            <div key={container.serial} className="sis-fefo-item">
              <span className="sis-fefo-serial">{container.serial}</span>
              <span className="sis-fefo-meta">
                {container.status === CONTAINER_STATUS.OPENED && <span className="sis-open-tag">OPEN</span>}
                {container.bbd ? formatDate(container.bbd) : 'no BBD'}
                {container.storage_row_name ? ` · ${container.storage_row_name}` : ''}
              </span>
            </div>
          ))}
        </div>

        {/* already pulled */}
        {(line?.serials || []).length > 0 && (
          <div className="sis-pulled">
            <div className="sis-fefo-head">On this line</div>
            {line.serials.map((serial) => (
              <div key={serial} className="sis-pulled-item">{serial}</div>
            ))}
          </div>
        )}
      </div>

      {/* off-list reason — allowed, but never recorded without the why */}
      {offListPrompt && (
        <div className="sis-modal">
          <div className="sis-modal-card">
            <h3>Not on the suggested list</h3>
            <p className="sis-muted sis-small">
              {offListPrompt.serial} wasn&apos;t suggested for this line. Pulling it is fine —
              tell us why so the record makes sense later.
            </p>
            <input
              className="sis-scan-input"
              value={offListReason}
              onChange={(event) => setOffListReason(event.target.value)}
              placeholder="e.g. front of the rack, suggested drum not found"
              autoFocus
            />
            <div className="sis-modal-actions">
              <button
                type="button"
                className="sis-btn sis-btn--ghost"
                onClick={() => { setOffListPrompt(null); setOffListReason(''); refocus(); }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="sis-btn sis-btn--primary"
                disabled={!offListReason.trim() || busy}
                onClick={() => submitPull(offListPrompt.serial, offListReason.trim())}
              >
                Pull anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {/* return needs a destination row — no default, no guess */}
      {returnPrompt && (
        <div className="sis-modal">
          <div className="sis-modal-card">
            <h3>Return {returnPrompt.serial}</h3>
            <p className="sis-muted sis-small">
              Scan the row you are putting it back into. The rack only gets its space
              back when we know where the drum went.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const code = new FormData(event.currentTarget).get('returnrow');
                if (code) submitReturn(returnPrompt.serial, String(code).trim());
              }}
            >
              <input name="returnrow" className="sis-scan-input" placeholder="Scan destination row…" autoFocus autoComplete="off" />
            </form>
            <div className="sis-modal-actions">
              <button
                type="button"
                className="sis-btn sis-btn--ghost"
                onClick={() => { setReturnPrompt(null); refocus(); }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </ScannerLayout>
  );
};

const ScannerIngredientStagingFlow = () => {
  const { itemId } = useParams();
  return itemId ? <StagingLineSession itemId={itemId} /> : <StagingRequestList />;
};

export default ScannerIngredientStagingFlow;
