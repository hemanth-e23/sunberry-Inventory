import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle, Check, ChevronRight, Cloud, CloudOff, Keyboard, MapPin,
  PackageX, RefreshCw, Scan, Search, Send, Truck, X,
} from 'lucide-react';

import ScannerLayout from './ScannerLayout';
import NetworkStatus from './NetworkStatus';
import ScanFeedback from './ScanFeedback';
import {
  drainScanQueue, enqueueScan, listScans, removeScan, retryFailedScans,
  subscribeToScanQueue,
} from '../../utils/scanQueue';
import { decodeContainerPayload } from '../../utils/labelPayload';
import { playErrorTone, playSuccessTone } from '../../utils/scannerFeedback';
import { formatDate } from '../../utils/dateUtils';
import { INTAKE_STATUS, containerUnitLabel } from '../../constants';
import {
  closeIntakeShort, damageContainer, getIntake, intakeScanEndpoint,
  listIngredientRows, listIntakes, resolveIngredientRow, submitIntake,
} from '../../api/ingredientIntakeApi';
import './ScannerIngredientReceiveFlow.css';

// ─────────────────────────────────────────────────────────────────────────────
// Forklift receiving for serialized ingredient containers — SPEC §8.
//
// Two screens, one file, chosen by the presence of an `:intakeId` route param:
//   /forklift/ingredient-receiving            → open intakes, tap to resume
//   /forklift/ingredient-receiving/:intakeId  → the two-scan session
//
// Sessions are INTAKE-scoped, not person-scoped (§8.4 / §18.2 R-6, R-7): all
// session state lives on the server, so any gun can pick up a half-unloaded
// truck mid-count and the screen says "40 of 80 barrels" without knowing who
// scanned the first 40.
//
// The rhythm is: scan a ROW (sticky context, big banner) → scan drums into it →
// scan another row to switch. A drum scan with no row context is blocked HERE,
// client-side, before it ever reaches the wire (§18.2 R-3 / §6.4). There is
// deliberately no fall back to a last-known or default row.
// ─────────────────────────────────────────────────────────────────────────────

const POLL_MS = 8000;

// How many recent scans stay on screen. The gun shows the tail of the session,
// not the whole truck — the full list is the desk's job.
const HISTORY_LIMIT = 20;

/**
 * "80 barrels" — never "80 cases" (§6.3 / §19.1 acceptance criterion 1).
 *
 * When every lot line on the truck is the same container type, the label is
 * pluralized against the number actually on screen, so "1 barrel" reads right.
 * Mixed or unknown types fall back to the server's `count_unit`, which is
 * already the correct generic ("containers") — the string is never guessed.
 */
const countUnitFor = (intake, count) => {
  const types = new Set((intake?.lots || []).map((lot) => lot.container_type).filter(Boolean));
  if (types.size === 1) return containerUnitLabel([...types][0], count);
  return intake?.count_unit || containerUnitLabel(null, count);
};

const productSummary = (intake) => {
  const names = [...new Set((intake?.lots || []).map((l) => l.product_name).filter(Boolean))];
  if (names.length === 0) return 'No lot lines yet';
  if (names.length <= 2) return names.join(' · ');
  return `${names.slice(0, 2).join(' · ')} +${names.length - 2} more`;
};

const errorText = (err, fallback) => {
  const detail = err?.response?.data?.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail) && detail[0]?.msg) return detail[0].msg;
  if (!err?.response) return 'No connection — the scan is queued and will sync.';
  return fallback;
};

// A 4xx is the server's final answer; anything else is worth another pass.
const isTerminal = (err) => {
  const status = err?.response?.status;
  if (!status) return false;
  return status < 500 && status !== 408 && status !== 429;
};

// ─── Offline scan queue ──────────────────────────────────────────────────────
// Uses scanQueue.js directly rather than the useScanQueue hook: the hook's
// `enqueue` wrapper does not forward the `endpoint` field, and the endpoint is
// exactly what lets container scans share the ONE queue (one storage key, one
// retry policy, one drain loop) with pallet scans.
const useContainerScanQueue = (onSettled) => {
  const [online, setOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [queue, setQueue] = useState(() => listScans());
  const settledRef = useRef(onSettled);

  useEffect(() => { settledRef.current = onSettled; }, [onSettled]);
  useEffect(() => subscribeToScanQueue(setQueue), []);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  const drain = useCallback(async () => {
    if (!online) return;
    await drainScanQueue({
      onItemResult: (item, response, error) => settledRef.current?.(item, response, error),
    });
  }, [online]);

  useEffect(() => { drain(); }, [drain]);

  useEffect(() => {
    const timer = setInterval(drain, POLL_MS);
    return () => clearInterval(timer);
  }, [drain]);

  useEffect(() => {
    const onVisible = () => { if (!document.hidden) drain(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [drain]);

  // Every scan — including a confirmed move — goes through the queue, so every
  // scan carries the idempotency_key the queue mints and a replay is deduped
  // server-side instead of double-counting a drum.
  const send = useCallback((requestId, endpoint, payload) => {
    const item = enqueueScan({ requestId, payload, endpoint });
    drain();
    return item;
  }, [drain]);

  const retry = useCallback(() => { retryFailedScans(); drain(); }, [drain]);

  return { online, queue, send, drain, retry };
};

/** `/ingredient-intakes/<id>/scan` → `<id>`; anything else → null. */
const intakeIdFromEndpoint = (endpoint) => {
  const match = /^\/ingredient-intakes\/([^/]+)\/scan$/.exec(endpoint || '');
  return match ? match[1] : null;
};

// ─── Entry list ──────────────────────────────────────────────────────────────

const IntakeListView = () => {
  const navigate = useNavigate();
  const [intakes, setIntakes] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Scans that came back needing a human decision (or were rejected) while
  // nobody was looking at the session they belong to.
  const [notices, setNotices] = useState([]);

  // The list screen keeps draining, so backing out of a session mid-truck does
  // not strand queued scans. Nothing is auto-confirmed here: a drum that comes
  // back 'needs_confirm' becomes a notice pointing at its intake (§18.2 R-2).
  const onQueueSettled = useCallback((item, response, error_) => {
    const owningIntake = intakeIdFromEndpoint(item.endpoint);
    if (!owningIntake) return; // another flow's scan
    if (error_) {
      if (!isTerminal(error_)) return;
      removeScan(item.id);
      setNotices((prev) => [...prev, {
        key: item.idempotency_key,
        intakeId: owningIntake,
        serial: item.payload?.serial,
        message: errorText(error_, 'Scan rejected'),
      }]);
      return;
    }
    if (response.status === 'needs_confirm') {
      setNotices((prev) => [...prev, {
        key: item.idempotency_key,
        intakeId: owningIntake,
        serial: item.payload?.serial,
        message: `${response.message} — reopen the intake and scan it again to decide.`,
      }]);
    }
  }, []);

  const { online, queue, drain, retry } = useContainerScanQueue(onQueueSettled);

  const queued = useMemo(
    () => queue.filter((it) => intakeIdFromEndpoint(it.endpoint)),
    [queue],
  );
  const pendingCount = queued.filter((it) => it.state === 'pending').length;
  const failedCount = queued.filter((it) => it.state === 'failed').length;

  const load = useCallback(() => {
    setLoading(true);
    listIntakes({ status: INTAKE_STATUS.RECORDED, limit: 100 })
      .then((data) => {
        setIntakes(data.items || []);
        setTruncated(!!data.truncated);
        setTotal(data.total || 0);
        setError('');
      })
      .catch((err) => setError(errorText(err, 'Could not load open intakes')))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <ScannerLayout
      title="Ingredient Receiving"
      showBack
      onBack={() => navigate('/forklift')}
      headerExtra={(
        <NetworkStatus
          online={online}
          pendingCount={pendingCount}
          failedCount={failedCount}
          onRetry={retry}
          onDropFailed={removeScan}
          onForceSync={drain}
        />
      )}
    >
      <div className="sir-list">
        <div className="sir-list-head">
          <p className="sir-list-hint">
            Open trucks. Tap one to scan drums into it — anyone can pick up a
            part-scanned intake.
          </p>
          <button type="button" className="sir-icon-btn" onClick={load} aria-label="Refresh">
            <RefreshCw size={18} />
          </button>
        </div>

        {notices.map((notice) => (
          <div key={notice.key} className="sir-warn">
            <AlertTriangle size={18} />
            <div>
              <strong>{notice.serial}</strong>
              <div className="sir-warn-detail">{notice.message}</div>
              <button
                type="button"
                className="sir-link"
                onClick={() => navigate(`/forklift/ingredient-receiving/${notice.intakeId}`)}
              >
                Open that intake
              </button>
            </div>
            <button
              type="button"
              className="sir-warn-dismiss"
              onClick={() => setNotices((prev) => prev.filter((n) => n.key !== notice.key))}
              aria-label="Dismiss"
            >
              <X size={16} />
            </button>
          </div>
        ))}

        {error && (
          <div className="sir-error"><AlertTriangle size={16} /> {error}</div>
        )}

        {loading && <p className="sir-muted">Loading open intakes…</p>}

        {!loading && intakes.length === 0 && !error && (
          <div className="sir-empty">
            <Truck size={32} />
            <p>No open intakes.</p>
            <p className="sir-empty-hint">
              The desk creates the intake from the BOL and prints the drum labels
              before anything can be scanned.
            </p>
          </div>
        )}

        {intakes.map((intake) => {
          const expected = intake.expected_count || 0;
          const scanned = intake.scanned_count || 0;
          const unit = countUnitFor(intake, expected);
          const pct = expected > 0 ? Math.min(100, Math.round((scanned / expected) * 100)) : 0;
          return (
            <button
              key={intake.id}
              type="button"
              className="sir-intake-card"
              onClick={() => navigate(`/forklift/ingredient-receiving/${intake.id}`)}
            >
              <div className="sir-intake-top">
                <span className="sir-intake-number">{intake.intake_number}</span>
                {scanned > 0 && scanned < expected && (
                  <span className="sir-badge sir-badge--mid">In progress</span>
                )}
                <ChevronRight size={22} className="sir-intake-chevron" />
              </div>
              <div className="sir-intake-vendor">
                {intake.vendor_name || 'Vendor not recorded'}
                {intake.receipt_date && ` · ${formatDate(intake.receipt_date)}`}
              </div>
              <div className="sir-intake-products">{productSummary(intake)}</div>
              <div className="sir-intake-count">
                <strong>{scanned}</strong> of {expected} {unit}
              </div>
              <div className="sir-progress"><span style={{ width: `${pct}%` }} /></div>
            </button>
          );
        })}

        {truncated && (
          <p className="sir-muted sir-truncated">
            Showing {intakes.length} of {total} — open the rest at the desk.
          </p>
        )}
      </div>
    </ScannerLayout>
  );
};

// ─── Session ─────────────────────────────────────────────────────────────────

const IntakeSessionView = ({ intakeId }) => {
  const navigate = useNavigate();
  const endpoint = useMemo(() => intakeScanEndpoint(intakeId), [intakeId]);
  const endpointRef = useRef(endpoint);
  useEffect(() => { endpointRef.current = endpoint; }, [endpoint]);

  const [intake, setIntake] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // Sticky location context. Intentionally NOT persisted across a reload: a row
  // restored from storage is a guessed location, and §6.4 says a drum is never
  // placed by guess. Re-scanning the rack costs one scan and is always right.
  const [row, setRow] = useState(null);
  const [rows, setRows] = useState([]);
  const rowsRef = useRef([]);
  useEffect(() => { rowsRef.current = rows; }, [rows]);

  // Server truth for the counters; pending queue items are added on top for the
  // optimistic display and drop off as each one settles.
  const [serverScanned, setServerScanned] = useState(0);
  const [serverRowCounts, setServerRowCounts] = useState({});
  const [history, setHistory] = useState([]);

  const [scanInput, setScanInput] = useState('');
  const [manualKeyboard, setManualKeyboard] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rowFull, setRowFull] = useState(null);
  const [confirmMove, setConfirmMove] = useState(null);
  const [rowPicker, setRowPicker] = useState(false);
  const [rowQuery, setRowQuery] = useState('');
  const [damageForm, setDamageForm] = useState(null);
  const [shortForm, setShortForm] = useState(null);
  const [submitForm, setSubmitForm] = useState(null);

  const inputRef = useRef(null);

  const showSuccess = useCallback((message) => {
    playSuccessTone();
    setFeedback({ kind: 'success', message });
  }, []);
  const showError = useCallback((message) => {
    playErrorTone();
    setFeedback({ kind: 'error', message });
  }, []);
  const showInfo = useCallback((message) => setFeedback({ kind: 'info', message }), []);

  const patchHistory = useCallback((key, patch) => {
    setHistory((prev) => prev.map((h) => (h.key === key ? { ...h, ...patch } : h)));
  }, []);

  const rowNameFor = useCallback((rowId) => {
    if (!rowId) return '';
    const known = rowsRef.current.find((r) => r.id === rowId);
    return known?.name || '';
  }, []);

  // ── Queue result handling ──────────────────────────────────────────────────
  const onScanSettled = useCallback((item, response, error) => {
    // The queue is shared with the pallet flow and with other intakes; only
    // touch what this session sent.
    if (item.endpoint !== endpointRef.current) return;

    if (error) {
      if (!isTerminal(error)) return; // transient — leave it queued, keep the optimistic count
      removeScan(item.id);
      const message = errorText(error, 'Scan rejected');
      patchHistory(item.idempotency_key, { state: 'error', message });
      showError(message);
      return;
    }

    if (response.intake_scanned_count != null) setServerScanned(response.intake_scanned_count);
    const settledRowId = response.container?.storage_row_id || item.payload?.storage_row_id;
    if (settledRowId && response.row_scanned_count != null) {
      setServerRowCounts((prev) => ({ ...prev, [settledRowId]: response.row_scanned_count }));
    }

    // 'needs_confirm' — the drum is already received into a DIFFERENT row.
    // Explicit two-button confirm, never an auto-resend (§18.2 R-2).
    if (response.status === 'needs_confirm') {
      patchHistory(item.idempotency_key, { state: 'confirm', message: response.message });
      setConfirmMove({
        serial: item.payload.serial,
        toRowId: item.payload.storage_row_id,
        toRowName: rowNameFor(item.payload.storage_row_id) || 'the scanned row',
        fromRowName: response.container?.storage_row_name || '',
        message: response.message,
      });
      // Tone only, no full-screen ScanFeedback: that overlay sits above the
      // dialog for a second and a half and would eat the first tap on it.
      playErrorTone();
      return;
    }

    // R-1: same drum, same row. The count is unchanged and that is correct —
    // the drum is accounted for, so this reads as benign, not as a failure.
    if (response.status === 'already_received') {
      patchHistory(item.idempotency_key, { state: 'duplicate', message: response.message });
      playSuccessTone();
      showInfo(response.message || 'Already received');
      return;
    }

    patchHistory(item.idempotency_key, {
      state: 'ok',
      message: response.message,
      rowName: response.container?.storage_row_name || rowNameFor(settledRowId),
    });

    // A full row is a WARNING on a SUCCESSFUL scan (§8.1 / §19.6): amber banner,
    // never red, never blocking. The drum is already recorded where it is.
    if (response.warning === 'row_full') {
      setRowFull({
        rowId: settledRowId,
        rowName: response.container?.storage_row_name || rowNameFor(settledRowId),
        detail: response.warning_detail || '',
      });
    }

    showSuccess(response.message || 'Received');
  }, [patchHistory, rowNameFor, showError, showInfo, showSuccess]);

  const { online, queue, send, drain, retry } = useContainerScanQueue(onScanSettled);

  // ── Derived queue counts, scoped to this intake ────────────────────────────
  const myItems = useMemo(
    () => queue.filter((it) => it.endpoint === endpoint),
    [queue, endpoint],
  );
  const pendingItems = useMemo(
    () => myItems.filter((it) => it.state === 'pending'),
    [myItems],
  );
  const failedCount = useMemo(
    () => myItems.filter((it) => it.state === 'failed').length,
    [myItems],
  );
  // A confirmed move re-scans a drum that is already counted, so it must not
  // bump the optimistic total.
  const pendingNew = useMemo(
    () => pendingItems.filter((it) => !it.payload?.confirm_move).length,
    [pendingItems],
  );
  const pendingForRow = useMemo(() => {
    if (!row) return 0;
    return pendingItems.filter(
      (it) => !it.payload?.confirm_move && it.payload?.storage_row_id === row.id,
    ).length;
  }, [pendingItems, row]);

  const expected = intake?.expected_count || 0;
  const totalScanned = serverScanned + pendingNew;
  const unit = countUnitFor(intake, expected || totalScanned);
  const rowCount = row ? (serverRowCounts[row.id] || 0) + pendingForRow : 0;
  const remaining = Math.max(0, expected - totalScanned);
  const isOpen = intake?.status === INTAKE_STATUS.RECORDED;
  const dialogOpen = !!(confirmMove || rowPicker || damageForm || shortForm || submitForm);

  // ── Load ───────────────────────────────────────────────────────────────────
  const loadIntake = useCallback(() => {
    setLoading(true);
    return getIntake(intakeId)
      .then((data) => {
        setIntake(data);
        setServerScanned(data.scanned_count || 0);
        const counts = {};
        (data.row_breakdown || []).forEach((b) => { counts[b.storage_row_id] = b.count; });
        setServerRowCounts(counts);
        setLoadError('');
      })
      .catch((err) => setLoadError(errorText(err, 'Could not load this intake')))
      .finally(() => setLoading(false));
  }, [intakeId]);

  useEffect(() => { loadIntake(); }, [loadIntake]);

  // Row list: the manual picker, the quarantine picker, and the offline
  // barcode fallback all read from this one cached list.
  useEffect(() => {
    let cancelled = false;
    listIngredientRows()
      .then((data) => { if (!cancelled) setRows(Array.isArray(data) ? data : []); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, []);

  // ── Keyboard-wedge focus, same idiom as the pallet gun ─────────────────────
  useEffect(() => {
    if (manualKeyboard || dialogOpen) return undefined;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [manualKeyboard, dialogOpen, feedback, row, loading]);

  useEffect(() => {
    if (manualKeyboard || dialogOpen) return undefined;
    const onFocusOut = () => {
      setTimeout(() => {
        const active = document.activeElement;
        if (!active || active === document.body) inputRef.current?.focus();
      }, 50);
    };
    document.addEventListener('focusout', onFocusOut);
    return () => document.removeEventListener('focusout', onFocusOut);
  }, [manualKeyboard, dialogOpen]);

  // ── Row context ────────────────────────────────────────────────────────────
  const adoptRow = useCallback((resolved) => {
    setRow(resolved);
    setRows((prev) => (prev.some((r) => r.id === resolved.id) ? prev : [...prev, resolved]));
    setRowFull(null);
    setRowPicker(false);
    showSuccess(`→ ${resolved.name}`);
  }, [showSuccess]);

  /**
   * Ask the SERVER what row a code is. Returns `{ row, error }`:
   *   row set     → resolved, adopt it
   *   error set   → the server named a problem (ambiguous name, deactivated
   *                 row); show it verbatim and stop — never guess past it
   *   both null   → not a row; the caller may treat the token as a serial
   */
  const resolveRowCode = useCallback(async (code) => {
    if (!online) {
      // Offline: exact BARCODE equality against the list cached when the
      // session opened. Barcodes are unique, so an exact hit is unambiguous.
      // Names are deliberately not matched here — that is the fuzzy path that
      // puts drums in the wrong barn.
      const upper = code.toUpperCase();
      const hit = rowsRef.current.find((r) => (r.barcode || '').toUpperCase() === upper);
      return { row: hit || null, error: null };
    }
    try {
      return { row: await resolveIngredientRow(code), error: null };
    } catch (err) {
      const status = err?.response?.status;
      if (status === 404) return { row: null, error: null }; // simply not a row
      if (!err?.response) return { row: null, error: null }; // dropped mid-scan
      return { row: null, error: errorText(err, 'Could not resolve that row') };
    }
  }, [online]);

  // ── Drum scan ──────────────────────────────────────────────────────────────
  const recordDrum = useCallback((serial, { confirmMoveTo } = {}) => {
    const target = confirmMoveTo || row;
    if (!target) {
      // §18.2 R-3. The server enforces this too; blocking here saves the trip
      // and, offline, is the only thing standing between a drum and a guess.
      showError(online
        ? 'Scan a row first — a drum is never placed by guess.'
        : 'Scan a row first — offline, so pick the row from the list.');
      return;
    }
    if (!isOpen) {
      showError(`This intake is ${intake?.status} — scanning is closed.`);
      return;
    }
    const payload = { serial, storage_row_id: target.id };
    if (confirmMoveTo) payload.confirm_move = true;
    const item = send(intakeId, endpoint, payload);
    setHistory((prev) => [
      {
        key: item.idempotency_key,
        serial,
        rowId: target.id,
        rowName: target.name,
        state: 'pending',
        message: confirmMoveTo ? 'Confirming move…' : 'Queued',
        isMove: !!confirmMoveTo,
      },
      ...prev,
    ].slice(0, HISTORY_LIMIT));
  }, [row, online, isOpen, intake, send, intakeId, endpoint, showError]);

  const handleScanSubmit = useCallback(async (e) => {
    e?.preventDefault?.();
    const raw = scanInput.trim();
    if (!raw) return;
    setScanInput('');

    const decoded = decodeContainerPayload(raw);

    // A versioned envelope (`SB1|serial|lot|bbd`) is unambiguously a drum label.
    if (decoded && !decoded.bare) {
      recordDrum(decoded.serial);
      return;
    }
    if (!decoded) {
      showError('Unreadable label — scan the 2D code or key the serial.');
      return;
    }

    // A bare token is either a row barcode or a hand-keyed serial. The server
    // decides which; there is no client-side format test, because §4.2 says no
    // code parses a serial and §8.3 says row resolution is server-side.
    setBusy(true);
    try {
      const { row: found, error } = await resolveRowCode(raw);
      if (found) { adoptRow(found); return; }
      if (error) { showError(error); return; }
      if (!row) {
        showError(online
          ? 'Not a known row. Scan a row barcode before any drum.'
          : 'Offline — that code is not in the cached row list. Pick the row from the list.');
        return;
      }
      recordDrum(raw);
    } finally {
      setBusy(false);
    }
  }, [scanInput, recordDrum, resolveRowCode, adoptRow, row, online, showError]);

  const acceptMove = useCallback(() => {
    if (!confirmMove) return;
    const target = { id: confirmMove.toRowId, name: confirmMove.toRowName };
    recordDrum(confirmMove.serial, { confirmMoveTo: target });
    setConfirmMove(null);
  }, [confirmMove, recordDrum]);

  const cancelMove = useCallback(() => setConfirmMove(null), []);

  // ── Damage ─────────────────────────────────────────────────────────────────
  const submitDamage = useCallback(async () => {
    if (!damageForm?.serial.trim() || !damageForm?.reason.trim()) return;
    setBusy(true);
    try {
      await damageContainer({
        serial: damageForm.serial.trim(),
        reason: damageForm.reason.trim(),
        quarantineRowId: damageForm.quarantineRowId || null,
      });
      setDamageForm(null);
      showSuccess(`${damageForm.serial.trim()} flagged damaged`);
      await loadIntake();
    } catch (err) {
      showError(errorText(err, 'Could not flag that drum'));
    } finally {
      setBusy(false);
    }
  }, [damageForm, loadIntake, showError, showSuccess]);

  // ── Close-out ──────────────────────────────────────────────────────────────
  const submitShort = useCallback(async () => {
    const reason = (shortForm?.reason || '').trim();
    if (!reason) return;
    setBusy(true);
    try {
      await closeIntakeShort(intakeId, reason);
      setShortForm(null);
      showSuccess('Short receipt recorded');
      await loadIntake();
    } catch (err) {
      showError(errorText(err, 'Could not record the shortage'));
    } finally {
      setBusy(false);
    }
  }, [shortForm, intakeId, loadIntake, showError, showSuccess]);

  const submitIntakeNow = useCallback(async () => {
    if (pendingItems.length > 0 || failedCount > 0) {
      showError(pendingItems.length > 0
        ? 'Wait for queued scans to sync before submitting.'
        : 'Resolve failed scans before submitting.');
      return;
    }
    const needsReason = remaining > 0 && !intake?.short_reason;
    const reason = (submitForm?.reason || '').trim();
    if (needsReason && !reason) return;
    setBusy(true);
    try {
      // Short first, so the shortage and its reason are on the record before the
      // approver ever sees it. Unapplied serials survive — a drum found in the
      // trailer tomorrow still scans onto this intake (§18.1 I-2).
      if (needsReason) await closeIntakeShort(intakeId, reason);
      await submitIntake(intakeId);
      setSubmitForm(null);
      showSuccess('Submitted for approval');
      navigate('/forklift/ingredient-receiving');
    } catch (err) {
      showError(errorText(err, 'Submit failed'));
    } finally {
      setBusy(false);
    }
  }, [pendingItems, failedCount, remaining, intake, submitForm, intakeId, navigate,
    showError, showSuccess]);

  // ── Render ─────────────────────────────────────────────────────────────────
  const netStatus = (
    <NetworkStatus
      online={online}
      pendingCount={pendingItems.length}
      failedCount={failedCount}
      onRetry={retry}
      onDropFailed={removeScan}
      onForceSync={drain}
    />
  );

  if (loading && !intake) {
    return (
      <ScannerLayout title="Ingredient Receiving" showBack onBack={() => navigate('/forklift/ingredient-receiving')}>
        <div className="sir-session"><p className="sir-muted">Loading intake…</p></div>
      </ScannerLayout>
    );
  }

  if (loadError && !intake) {
    return (
      <ScannerLayout title="Ingredient Receiving" showBack onBack={() => navigate('/forklift/ingredient-receiving')}>
        <div className="sir-session">
          <div className="sir-error"><AlertTriangle size={16} /> {loadError}</div>
          <button type="button" className="sir-btn" onClick={loadIntake}>
            <RefreshCw size={16} /> Try again
          </button>
        </div>
      </ScannerLayout>
    );
  }

  const filteredRows = rowQuery.trim()
    ? rows.filter((r) => {
      const needle = rowQuery.trim().toLowerCase();
      return (r.name || '').toLowerCase().includes(needle)
        || (r.path || '').toLowerCase().includes(needle)
        || (r.barcode || '').toLowerCase().includes(needle);
    })
    : rows;

  const historyIcon = (entry) => {
    if (entry.state === 'pending') {
      return online ? <Cloud size={16} color="#92400e" /> : <CloudOff size={16} color="#92400e" />;
    }
    if (entry.state === 'error') return <X size={16} color="#b91c1c" />;
    if (entry.state === 'confirm') return <AlertTriangle size={16} color="#b45309" />;
    if (entry.state === 'duplicate') return <Check size={16} color="#6b7280" />;
    return <Check size={16} color="#16a34a" />;
  };

  return (
    <ScannerLayout
      title={intake?.intake_number || 'Ingredient Receiving'}
      showBack
      onBack={() => navigate('/forklift/ingredient-receiving')}
      headerExtra={netStatus}
    >
      <div className="sir-session">
        <div className="sir-meta">
          <span>{intake?.vendor_name || 'Vendor not recorded'}</span>
          <span className="sir-meta-sep">·</span>
          <span>{productSummary(intake)}</span>
        </div>

        {!isOpen && (
          <div className="sir-error">
            <AlertTriangle size={16} /> This intake is {intake?.status} — scanning is closed.
          </div>
        )}

        {/* Sticky location context — the single most important thing on screen. */}
        <div className={`sir-rowbanner${row ? '' : ' sir-rowbanner--empty'}`}>
          <MapPin size={26} />
          {row ? (
            <div className="sir-rowbanner-text">
              <span className="sir-rowbanner-name">→ {row.name}</span>
              <span className="sir-rowbanner-path">{row.path || 'Location'}</span>
            </div>
          ) : (
            <div className="sir-rowbanner-text">
              <span className="sir-rowbanner-name">Scan a row</span>
              <span className="sir-rowbanner-path">No location set — drums are blocked</span>
            </div>
          )}
          <button type="button" className="sir-rowbanner-btn" onClick={() => setRowPicker(true)}>
            {row ? 'Change' : 'Pick row'}
          </button>
        </div>

        {rowFull && (
          <div className="sir-warn">
            <AlertTriangle size={18} />
            <div>
              <strong>{rowFull.rowName || 'Row'} is full by the system.</strong>
              <div className="sir-warn-detail">
                {rowFull.detail || 'The drum was still recorded here. Keep going, or scan a new row.'}
              </div>
            </div>
            <button type="button" className="sir-warn-dismiss" onClick={() => setRowFull(null)} aria-label="Dismiss">
              <X size={16} />
            </button>
          </div>
        )}

        <form onSubmit={handleScanSubmit} className="sir-form">
          <input
            ref={inputRef}
            type="text"
            value={scanInput}
            onChange={(e) => setScanInput(e.target.value)}
            placeholder={row ? 'Scan drum (or a new row)…' : 'Scan the row barcode…'}
            className="sir-input"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            disabled={!isOpen}
          />
          <button type="submit" className="sir-scan-btn" disabled={busy || !scanInput.trim()}>
            {busy ? '…' : <Scan size={22} />}
          </button>
        </form>
        <button type="button" className="sir-link" onClick={() => setManualKeyboard((v) => !v)}>
          <Keyboard size={14} /> {manualKeyboard ? 'Hide keyboard (use scanner)' : 'Type manually'}
        </button>

        {/* Big, glanceable counters. */}
        <div className="sir-counts">
          <div className="sir-count">
            <span className="sir-count-value">{rowCount}</span>
            <span className="sir-count-label">into {row ? row.name : 'this row'}</span>
          </div>
          <div className="sir-count sir-count--total">
            <span className="sir-count-value">{totalScanned}</span>
            <span className="sir-count-label">of {expected} {unit}</span>
          </div>
        </div>

        <div className="sir-history">
          <div className="sir-history-head">
            <h3>Recent scans</h3>
            {pendingItems.length > 0 && (
              <span className="sir-history-pending">{pendingItems.length} queued</span>
            )}
          </div>
          {history.length === 0 ? (
            <p className="sir-muted">
              Scan a row, then peel → wipe → stick → scan each drum.
            </p>
          ) : history.map((entry) => (
            <div key={entry.key} className={`sir-history-item sir-history-item--${entry.state}`}>
              {historyIcon(entry)}
              <div className="sir-history-body">
                <span className="sir-history-serial">{entry.serial}</span>
                {entry.state !== 'ok' && entry.message && (
                  <span className="sir-history-msg">{entry.message}</span>
                )}
              </div>
              <span className="sir-history-row">{entry.rowName}</span>
              <button
                type="button"
                className="sir-damage-btn"
                onClick={() => setDamageForm({
                  serial: entry.serial,
                  reason: '',
                  quarantineRowId: '',
                })}
                aria-label={`Flag ${entry.serial} damaged`}
              >
                <PackageX size={15} />
              </button>
            </div>
          ))}
        </div>

        <div className="sir-actions">
          <button
            type="button"
            className="sir-btn sir-btn--ghost"
            onClick={() => setDamageForm({ serial: '', reason: '', quarantineRowId: '' })}
          >
            <PackageX size={16} /> Damaged drum
          </button>
          <button
            type="button"
            className="sir-btn sir-btn--warn"
            onClick={() => setShortForm({ reason: intake?.short_reason || '' })}
            disabled={!isOpen}
          >
            Received short
          </button>
        </div>

        <button
          type="button"
          className="sir-submit"
          onClick={() => setSubmitForm({ reason: '' })}
          disabled={!isOpen || busy}
        >
          <Send size={18} /> Review &amp; submit
        </button>
      </div>

      <ScanFeedback {...(feedback || {})} onDismiss={() => setFeedback(null)} />

      {/* ── Move confirmation (§18.2 R-2) — explicit, never auto-confirmed ── */}
      {confirmMove && (
        <div className="sir-overlay">
          <div className="sir-dialog">
            <AlertTriangle size={30} color="#d97706" />
            <h3>Move this drum?</h3>
            <p className="sir-dialog-serial">{confirmMove.serial}</p>
            <p>{confirmMove.message}</p>
            <div className="sir-dialog-actions">
              <button type="button" className="sir-btn sir-btn--ghost" onClick={cancelMove}>
                Cancel
              </button>
              <button type="button" className="sir-btn" onClick={acceptMove}>
                Move to {confirmMove.toRowName}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Manual row picker ── */}
      {rowPicker && (
        <div className="sir-overlay">
          <div className="sir-dialog sir-dialog--tall">
            <h3>Pick a row</h3>
            <p className="sir-dialog-hint">
              Scanning the rack barcode is faster and safer. Use this only when the
              label is missing or unreadable.
            </p>
            <div className="sir-search">
              <Search size={16} />
              <input
                type="text"
                value={rowQuery}
                onChange={(e) => setRowQuery(e.target.value)}
                placeholder="Filter rows…"
                autoComplete="off"
              />
            </div>
            <div className="sir-rowlist">
              {filteredRows.length === 0 && <p className="sir-muted">No rows match.</p>}
              {filteredRows.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="sir-rowlist-item"
                  onClick={() => { setRowQuery(''); adoptRow(r); }}
                >
                  <MapPin size={16} />
                  <span className="sir-rowlist-name">{r.name}</span>
                  <span className="sir-rowlist-path">{r.path}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="sir-btn sir-btn--ghost"
              onClick={() => { setRowPicker(false); setRowQuery(''); }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Damage (§18.2 R-8) ── */}
      {damageForm && (
        <div className="sir-overlay">
          <div className="sir-dialog">
            <PackageX size={30} color="#b91c1c" />
            <h3>Flag drum damaged</h3>
            <label className="sir-field">
              <span>Serial</span>
              <input
                type="text"
                value={damageForm.serial}
                onChange={(e) => setDamageForm({ ...damageForm, serial: e.target.value })}
                placeholder="Scan or key the serial"
                autoComplete="off"
                autoCapitalize="characters"
              />
            </label>
            <label className="sir-field">
              <span>What happened? (required)</span>
              <textarea
                rows={2}
                value={damageForm.reason}
                onChange={(e) => setDamageForm({ ...damageForm, reason: e.target.value })}
                placeholder="Leaking seam, crushed lid…"
              />
            </label>
            <label className="sir-field">
              <span>Quarantine row (optional)</span>
              <select
                value={damageForm.quarantineRowId}
                onChange={(e) => setDamageForm({ ...damageForm, quarantineRowId: e.target.value })}
              >
                <option value="">Leave it where it is</option>
                {rows.map((r) => (
                  <option key={r.id} value={r.id}>{r.path ? `${r.name} — ${r.path}` : r.name}</option>
                ))}
              </select>
            </label>
            <div className="sir-dialog-actions">
              <button type="button" className="sir-btn sir-btn--ghost" onClick={() => setDamageForm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="sir-btn sir-btn--danger"
                onClick={submitDamage}
                disabled={busy || !damageForm.serial.trim() || !damageForm.reason.trim()}
              >
                {busy ? 'Working…' : 'Flag damaged'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Received short (§18.1 I-1) ── */}
      {shortForm && (
        <div className="sir-overlay">
          <div className="sir-dialog">
            <AlertTriangle size={30} color="#d97706" />
            <h3>Received short</h3>
            <p>
              {remaining} {countUnitFor(intake, remaining)} of {expected} never arrived.
            </p>
            <p className="sir-dialog-hint">
              The unused labels stay live — a drum found in the trailer tomorrow
              still scans onto this intake.
            </p>
            <label className="sir-field">
              <span>Reason (required)</span>
              <textarea
                rows={2}
                value={shortForm.reason}
                onChange={(e) => setShortForm({ reason: e.target.value })}
                placeholder="Only 76 on the truck, BOL says 80…"
              />
            </label>
            <div className="sir-dialog-actions">
              <button type="button" className="sir-btn sir-btn--ghost" onClick={() => setShortForm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="sir-btn sir-btn--warn"
                onClick={submitShort}
                disabled={busy || !shortForm.reason.trim()}
              >
                {busy ? 'Working…' : 'Record shortage'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Submit summary (§8.5) ── */}
      {submitForm && (
        <div className="sir-overlay">
          <div className="sir-dialog sir-dialog--tall">
            <Send size={30} color="#1a472a" />
            <h3>Submit {intake?.intake_number}</h3>
            <div className="sir-summary">
              <div className="sir-summary-line">
                <span>Scanned</span>
                <strong>{serverScanned} {countUnitFor(intake, serverScanned)}</strong>
              </div>
              <div className="sir-summary-line">
                <span>Expected</span>
                <strong>{expected}</strong>
              </div>
              {remaining > 0 && (
                <div className="sir-summary-line sir-summary-line--warn">
                  <span>Short</span>
                  <strong>{remaining}</strong>
                </div>
              )}
              {serverScanned > expected && (
                <div className="sir-summary-line sir-summary-line--warn">
                  <span>Over-received</span>
                  <strong>+{serverScanned - expected}</strong>
                </div>
              )}
              {(intake?.damaged_count || 0) > 0 && (
                <div className="sir-summary-line sir-summary-line--warn">
                  <span>Damaged</span>
                  <strong>{intake.damaged_count}</strong>
                </div>
              )}
            </div>

            <div className="sir-breakdown">
              <h4>By row</h4>
              {(intake?.row_breakdown || []).length === 0 && (
                <p className="sir-muted">Nothing scanned yet.</p>
              )}
              {(intake?.row_breakdown || []).map((b) => (
                <div key={b.storage_row_id} className="sir-breakdown-line">
                  <MapPin size={14} />
                  <span className="sir-breakdown-name">{b.storage_row_name}</span>
                  <span className="sir-breakdown-path">{b.location_path}</span>
                  <strong>{b.count}</strong>
                </div>
              ))}
              <button type="button" className="sir-link" onClick={loadIntake}>
                <RefreshCw size={14} /> Refresh summary
              </button>
            </div>

            {remaining > 0 && !intake?.short_reason && (
              <label className="sir-field">
                <span>Short reason (required — {remaining} {countUnitFor(intake, remaining)} missing)</span>
                <textarea
                  rows={2}
                  value={submitForm.reason}
                  onChange={(e) => setSubmitForm({ reason: e.target.value })}
                  placeholder="Only 76 on the truck, BOL says 80…"
                />
              </label>
            )}

            {(pendingItems.length > 0 || failedCount > 0) && (
              <div className="sir-warn sir-warn--inline">
                <AlertTriangle size={16} />
                <div>
                  {pendingItems.length > 0
                    ? `${pendingItems.length} scan(s) still syncing.`
                    : `${failedCount} scan(s) failed — clear them from the network panel.`}
                </div>
              </div>
            )}

            <div className="sir-dialog-actions">
              <button type="button" className="sir-btn sir-btn--ghost" onClick={() => setSubmitForm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="sir-btn"
                onClick={submitIntakeNow}
                disabled={
                  busy
                  || pendingItems.length > 0
                  || failedCount > 0
                  || (remaining > 0 && !intake?.short_reason && !submitForm.reason.trim())
                }
              >
                {busy ? 'Submitting…' : 'Submit for approval'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ScannerLayout>
  );
};

const ScannerIngredientReceiveFlow = () => {
  const { intakeId } = useParams();
  return intakeId ? <IntakeSessionView intakeId={intakeId} /> : <IntakeListView />;
};

export default ScannerIngredientReceiveFlow;
