import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle, Check, Clock, Keyboard, MapPin, RotateCcw, Scan, X,
} from 'lucide-react';
import ScannerLayout from './ScannerLayout';
import NetworkStatus from './NetworkStatus';
import ScanFeedback from './ScanFeedback';
import { playErrorTone, playSuccessTone } from '../../utils/scannerFeedback';
import {
  drainScanQueue, enqueueScan, listScans, removeScan, retryFailedScans,
  subscribeToScanQueue,
} from '../../utils/scanQueue';
import { decodeLotPayload, formatCalendarDate } from '../../utils/labelPayload';
import { resolveRow } from '../../api/lotReceivingApi';
import { listIngredientRows } from '../../api/ingredientIntakeApi';
import {
  apiErrorMessage, getStagingPullRequest, listStagingPullRequests,
  requestIdFromEndpoint, stagingPullScanEndpoint, submitStagingPull,
  undoStagingPull,
} from '../../api/stagingPullApi';
import { useAppData } from '../../context/AppDataContext';
import './ScannerIngredientReceiveFlow.css';
import './ScannerStagingPullFlow.css';

/**
 * Staging pull on the gun.
 *
 * The physical job: a production batch needs material. The worker walks to the
 * rack the FEFO suggestion names, scans the rack, then scans the lot sticker on
 * each drum they lift onto the cart. When the cart is loaded they submit it to
 * a staging location and production takes it from there.
 *
 * Everything structural is inherited from ScannerLotReceiveFlow, deliberately:
 * wedge input cleared FIRST unconditionally; re-entrancy guard via a ref; the
 * submit button NEVER disabled while busy (a disabled default button stops
 * Enter submitting, which silently swallows gun triggers); focus watchdog
 * suspended while a dialog is open; needs_confirm rendered as an INLINE amber
 * banner, parked in a pending[] array and replayed with the SAME idempotency
 * key + allow_mismatch=true (here the question is FEFO-advisory: the worker
 * scanned a lot that is not the oldest — legal, said out loud, never blocked);
 * server-truth counters with a pending-queue overlay.
 *
 * Every scan outcome is an HTTP 200 with a `status` discriminator — scanQueue
 * treats anything that is not no-response/5xx/408/429 as terminal, so a soft
 * question asked as a 4xx would be a lost scan.
 */

const POLL_MS = 15000;
const HISTORY_LIMIT = 40;
const LOCATION_STORAGE_KEY = 'sunberry-staging-pull-location';

// Terminal per-scan outcomes: show, sound the error tone, drop the scan.
const TERMINAL_SCAN_STATUSES = ['unknown_lot', 'wrong_product', 'lot_held', 'not_enough'];

const errorText = (err, fallback) => apiErrorMessage(err, fallback);

/** Terminal = the queue will never retry it. Mirrors scanQueue's own policy. */
const isTerminal = (err) => {
  const status = err?.response?.status;
  if (!status) return false;
  return status < 500 && status !== 408 && status !== 429;
};

const readSavedLocation = () => {
  try {
    const raw = window.localStorage.getItem(LOCATION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

const saveLocation = (locationId, subLocationId) => {
  try {
    window.localStorage.setItem(
      LOCATION_STORAGE_KEY,
      JSON.stringify({ locationId, subLocationId }),
    );
  } catch {
    // localStorage disabled — the choice just is not remembered.
  }
};

// ─── Offline scan queue ──────────────────────────────────────────────────────
// scanQueue.js directly, not the useScanQueue hook — the hook's `enqueue` does
// not forward `endpoint`, and the endpoint is exactly what lets pull scans
// share the ONE queue (one storage key, one retry policy, one drain loop) with
// every other flow on the gun.
const usePullScanQueue = (onSettled) => {
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

  // `idempotencyKey` reuses a key from an earlier attempt. The FEFO confirm
  // re-sends the same scan with the worker's answer on it; carrying the
  // original key keeps that a replay rather than a second drum, in the case
  // where the first attempt actually landed and only its response was lost.
  const send = useCallback((requestId, endpoint, payload, idempotencyKey) => {
    const item = enqueueScan({ requestId, payload, endpoint, idempotencyKey });
    drain();
    return item;
  }, [drain]);

  const retry = useCallback(() => { retryFailedScans(); drain(); }, [drain]);

  return { online, queue, send, drain, retry };
};

// ─── Request list ────────────────────────────────────────────────────────────

const RequestListView = () => {
  const navigate = useNavigate();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // The list screen keeps draining, so backing out of a request mid-cart does
  // not strand queued scans.
  const onQueueSettled = useCallback(() => {}, []);
  const { online, queue, drain, retry } = usePullScanQueue(onQueueSettled);

  const mine = useMemo(
    () => queue.filter((it) => requestIdFromEndpoint(it.endpoint)),
    [queue],
  );
  const pendingCount = mine.filter((it) => it.state === 'pending').length;
  const failedCount = mine.filter((it) => it.state === 'failed').length;

  const load = useCallback(() => {
    setLoading(true);
    return listStagingPullRequests()
      .then((data) => { setRequests(Array.isArray(data) ? data : []); setError(''); })
      .catch((err) => setError(errorText(err, 'Could not load pull requests')))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <ScannerLayout
      title="Staging Pull"
      showBack
      onBack={() => navigate('/forklift')}
      headerExtra={(
        <NetworkStatus
          online={online}
          pendingCount={pendingCount}
          failedCount={failedCount}
          onRetry={retry}
          onForceSync={drain}
        />
      )}
    >
      <div className="sir-list">
        {loading && <p className="sir-muted">Loading…</p>}
        {error && <div className="sir-error"><AlertTriangle size={16} /> {error}</div>}

        {!loading && !error && requests.length === 0 && (
          <p className="sir-muted">
            Nothing to pull. Production raises a staging request and it shows up
            here once it is released to the floor.
          </p>
        )}

        {requests.map((request) => (
          <button
            key={request.id}
            type="button"
            className="sir-card"
            onClick={() => navigate(`/forklift/staging-pull/${request.id}`)}
          >
            <div className="sir-card-head">
              <span className="sir-card-number">
                {request.product_name || request.production_batch_uid}
              </span>
              <span className="sir-card-status">{request.status}</span>
            </div>
            <div className="sir-card-meta">
              {request.formula_name || 'Formula unknown'}
              {' · '}{formatCalendarDate(request.production_date)}
              <br />
              <strong>
                {request.fulfilled_qty} of {request.needed_qty} staged
              </strong>
              {request.pending_qty > 0 ? ` · ${request.pending_qty} on cart` : ''}
              {' · '}{request.item_count} items
            </div>
          </button>
        ))}
      </div>
    </ScannerLayout>
  );
};

// ─── One request ─────────────────────────────────────────────────────────────

const RequestView = ({ requestId }) => {
  const navigate = useNavigate();
  const { locations, subLocationMap } = useAppData();
  const endpoint = useMemo(() => stagingPullScanEndpoint(requestId), [requestId]);
  const endpointRef = useRef(endpoint);
  useEffect(() => { endpointRef.current = endpoint; }, [endpoint]);

  const [request, setRequest] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // Sticky rack context — the rack being pulled FROM. Not persisted across a
  // reload: a rack restored from storage is a guessed location.
  const [row, setRow] = useState(null);
  const [rows, setRows] = useState([]);
  const rowsRef = useRef([]);
  useEffect(() => { rowsRef.current = rows; }, [rows]);

  const [history, setHistory] = useState([]);
  const [scanInput, setScanInput] = useState('');
  const [manualKeyboard, setManualKeyboard] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [busy, setBusy] = useState(false);
  // True while a scan is resolving. A ref, not state: the guard must be read
  // synchronously by the very next submit, before React re-renders.
  const scanInFlight = useRef(false);
  const [rowPicker, setRowPicker] = useState(false);
  const [rowQuery, setRowQuery] = useState('');
  // HOW MANY UNITS ONE SCAN MEANS. Default 1 — one drum per trigger-pull.
  const [perScan, setPerScan] = useState(1);
  // Armed for exactly ONE scan, then auto-resets: pulling a part-used drum is
  // the exception, and a toggle that stays on would book every following full
  // drum as an open one.
  const [pullOpen, setPullOpen] = useState(false);
  // FEFO-advisory confirm. Parked pending[] array, replayed with the SAME
  // idempotency key + allow_mismatch=true — never a modal.
  const [fefoConfirm, setFefoConfirm] = useState(null);

  // Submit-to-staging panel (inline, never a modal).
  const [submitPanel, setSubmitPanel] = useState(false);
  const saved = useMemo(readSavedLocation, []);
  const [locationId, setLocationId] = useState(saved.locationId || '');
  const [subLocationId, setSubLocationId] = useState(saved.subLocationId || '');
  const [submitConfirm, setSubmitConfirm] = useState(null);

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

  // Server truth for the per-item counters. Scan responses carry the settled
  // numbers back, so the cards update without a refetch.
  const applyCounts = useCallback((response) => {
    if (response.item_id == null) return;
    setItems((prev) => prev.map((it) => {
      if (it.id !== response.item_id) return it;
      const needed = response.item_needed_qty ?? it.quantity_needed;
      const fulfilled = response.item_fulfilled_qty ?? it.quantity_fulfilled;
      const pending = response.item_pending_qty ?? it.pending_qty;
      return {
        ...it,
        quantity_needed: needed,
        quantity_fulfilled: fulfilled,
        pending_qty: pending,
        remaining_qty: Math.max(0, needed - fulfilled - pending),
      };
    }));
  }, []);

  // ── Queue result handling ──────────────────────────────────────────────────
  const onScanSettled = useCallback((item, response, error) => {
    // The queue is shared with every other flow; only touch what this request sent.
    if (item.endpoint !== endpointRef.current) return;

    if (error) {
      if (!isTerminal(error)) return; // transient — leave it queued
      removeScan(item.id);
      const message = errorText(error, 'Scan rejected');
      patchHistory(item.idempotency_key, { state: 'error', message });
      showError(message);
      return;
    }

    // FEFO advisory: NOTHING was written. Rendered inline rather than as a
    // modal so it cannot steal focus from the scan input. APPEND, never
    // replace — scanQueue deletes the item from localStorage the moment a 200
    // comes back, so the pending[] entry kept here is the only remaining
    // handle on that scan, and several can be in flight back to back.
    if (response.status === 'needs_confirm') {
      patchHistory(item.idempotency_key, { state: 'confirm', message: response.message });
      setFefoConfirm((prev) => {
        const pending = {
          // The SAME idempotency key is replayed with allow_mismatch, so a
          // lost first response cannot become a second pull.
          payload: item.payload,
          idempotencyKey: item.idempotency_key,
          rowId: item.payload?.storage_row_id,
          rowName: rowNameFor(item.payload?.storage_row_id),
          lotCode: response.lot_code || item.payload?.code,
        };
        if (!prev) {
          return { message: response.message, warning: response.warning || '', pending: [pending] };
        }
        if (prev.pending.some((p) => p.idempotencyKey === pending.idempotencyKey)) return prev;
        return { ...prev, pending: [...prev.pending, pending] };
      });
      playErrorTone();
      return;
    }

    if (TERMINAL_SCAN_STATUSES.includes(response.status)) {
      patchHistory(item.idempotency_key, { state: 'error', message: response.message });
      showError(response.message);
      return;
    }

    applyCounts(response);
    patchHistory(item.idempotency_key, {
      state: 'ok',
      message: response.message,
      ingredientName: response.ingredient_name,
      lotCode: response.lot_code || undefined,
      units: response.units ?? undefined,
    });
    if (response.warning) {
      playSuccessTone();
      showInfo(response.warning);
      return;
    }
    showSuccess(response.message || 'Pulled');
  }, [applyCounts, patchHistory, rowNameFor, showError, showInfo, showSuccess]);

  const { online, queue, send, drain, retry } = usePullScanQueue(onScanSettled);

  // ── Derived queue counts, scoped to this request ───────────────────────────
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
  // UNITS, not queue items. The client cannot map a queued lot code to an item
  // (that is the server's job), so the overlay is a whole-cart unit count:
  // quantities update per item when each scan settles.
  const queuedUnits = useMemo(
    () => pendingItems.reduce((n, it) => n + (Number(it.payload?.units) || 1), 0),
    [pendingItems],
  );

  const onCartQty = useMemo(
    () => items.reduce((n, it) => n + (Number(it.pending_qty) || 0), 0),
    [items],
  );
  const dialogOpen = !!rowPicker;

  // ── Load ───────────────────────────────────────────────────────────────────
  const loadRequest = useCallback(() => {
    setLoading(true);
    return getStagingPullRequest(requestId)
      .then((data) => {
        setRequest(data);
        setItems(Array.isArray(data.items) ? data.items : []);
        setLoadError('');
      })
      .catch((err) => setLoadError(errorText(err, 'Could not load this request')))
      .finally(() => setLoading(false));
  }, [requestId]);

  useEffect(() => { loadRequest(); }, [loadRequest]);

  // Row list: the manual picker and the offline barcode fallback both read
  // from this one cached list.
  useEffect(() => {
    let cancelled = false;
    listIngredientRows()
      .then((data) => { if (!cancelled) setRows(Array.isArray(data) ? data : []); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, []);

  // Remember the staging location across visits.
  useEffect(() => {
    if (locationId) saveLocation(locationId, subLocationId);
  }, [locationId, subLocationId]);

  // ── Keyboard-wedge focus watchdog ──────────────────────────────────────────
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

  // ── Rack context ───────────────────────────────────────────────────────────
  const adoptRow = useCallback((resolved) => {
    setRow(resolved);
    setRows((prev) => (prev.some((r) => r.id === resolved.id) ? prev : [...prev, resolved]));
    setRowPicker(false);
    showSuccess(`→ ${resolved.name}`);
  }, [showSuccess]);

  /**
   * Ask the SERVER what rack a code is. Returns `{ row, error }`:
   *   row set    → resolved, adopt it
   *   error set  → the server named a problem; show it verbatim, never guess
   *   both null  → not a rack; the caller may treat the token as a lot code
   */
  const resolveRowCode = useCallback(async (code) => {
    if (!online) {
      // Offline: exact BARCODE equality against the cached list. Barcodes are
      // unique; names are deliberately not matched — row names are NOT unique,
      // and that fuzzy path pulls from the wrong barn.
      const upper = code.toUpperCase();
      const hit = rowsRef.current.find((r) => (r.barcode || '').toUpperCase() === upper);
      return { row: hit || null, error: null };
    }
    try {
      return { row: await resolveRow(code), error: null };
    } catch (err) {
      const status = err?.response?.status;
      if (status === 404) return { row: null, error: null }; // simply not a rack
      if (!err?.response) return { row: null, error: null }; // dropped mid-scan
      return { row: null, error: errorText(err, 'Could not resolve that rack') };
    }
  }, [online]);

  // ── Record one pull ────────────────────────────────────────────────────────
  const recordPull = useCallback((code, {
    displayCode, allowMismatch = false, reuseKey, intoRow, payloadOverride,
  } = {}) => {
    // `intoRow` / `payloadOverride` pin the FEFO replay to exactly what was
    // parked — the sticky rack and the toggles may have moved on since.
    const target = intoRow || row;
    if (!target) {
      showError(online
        ? 'Scan a rack first — a pull is never placed by guess.'
        : 'Scan a rack first — offline, so pick the rack from the list.');
      return;
    }
    const payload = payloadOverride || {
      code,
      storage_row_id: target.id,
      units: perScan,
      pull_open: pullOpen,
    };
    if (allowMismatch) payload.allow_mismatch = true;
    const item = send(requestId, endpoint, payload, reuseKey);
    const entry = {
      key: item.idempotency_key,
      lotCode: displayCode || payload.code,
      rowId: target.id,
      rowName: target.name,
      units: payload.units || 1,
      pullOpen: !!payload.pull_open,
      state: 'pending',
      message: 'Queued',
    };
    setHistory((prev) => [
      entry,
      // Drop any earlier entry with this key — the FEFO confirm deliberately
      // REUSES the idempotency key, and two entries under one React key render
      // whichever React reconciles to rather than the live one.
      ...prev.filter((h) => h.key !== entry.key),
    ].slice(0, HISTORY_LIMIT));
    // Armed for one scan only.
    if (!payloadOverride && pullOpen) setPullOpen(false);
  }, [row, online, send, requestId, endpoint, perScan, pullOpen, showError]);

  const handleScanSubmit = useCallback(async (e) => {
    e?.preventDefault?.();
    const raw = scanInput.trim();
    if (!raw) return;

    // Clear FIRST, including on the guarded path. Leaving the characters in
    // the controlled input is the exact failure the guard exists to prevent:
    // the next trigger appends to them and decodes a concatenated string.
    setScanInput('');
    if (scanInFlight.current) {
      showError('Still resolving the last scan — scan that drum again.');
      return;
    }

    const decoded = decodeLotPayload(raw);

    // A versioned envelope (`SB2|lot_code|lot|bbd`) is unambiguously a sticker.
    if (decoded && !decoded.bare) {
      recordPull(raw, { displayCode: decoded.lotCode });
      return;
    }
    if (!decoded) {
      showError('Unreadable sticker — scan the 2D code or key the lot code.');
      return;
    }

    // A bare token is either a rack barcode or a hand-keyed lot code. The
    // server decides which; there is no client-side format test.
    scanInFlight.current = true;
    setBusy(true);
    try {
      const { row: found, error } = await resolveRowCode(raw);
      if (found) { adoptRow(found); return; }
      if (error) { showError(error); return; }
      if (!row) {
        showError(online
          ? 'Not a known rack. Scan a rack barcode before any drum.'
          : 'Offline — that code is not in the cached rack list. Pick the rack from the list.');
        return;
      }
      recordPull(raw);
    } finally {
      scanInFlight.current = false;
      setBusy(false);
    }
  }, [scanInput, recordPull, resolveRowCode, adoptRow, row, online, showError]);

  // ── FEFO confirm ───────────────────────────────────────────────────────────
  const confirmFefo = useCallback(() => {
    if (!fefoConfirm?.pending?.length) { setFefoConfirm(null); return; }
    // Replay EVERY parked scan, each with exactly the payload it was raised
    // for — never the current sticky rack or toggles, which may have moved on.
    fefoConfirm.pending.forEach((p) => {
      recordPull(p.payload.code, {
        displayCode: p.lotCode,
        allowMismatch: true,
        reuseKey: p.idempotencyKey, // same key -> replay, not a second pull
        intoRow: { id: p.rowId, name: p.rowName },
        payloadOverride: { ...p.payload },
      });
    });
    setFefoConfirm(null);
  }, [fefoConfirm, recordPull]);

  const dismissFefo = useCallback(() => {
    // Dropping the scans is a real answer: nothing was written server-side.
    (fefoConfirm?.pending || []).forEach((p) => {
      patchHistory(p.idempotencyKey, { state: 'error', message: 'Not pulled — put it back' });
    });
    setFefoConfirm(null);
  }, [fefoConfirm, patchHistory]);

  // ── Undo ───────────────────────────────────────────────────────────────────
  const handleUndo = useCallback(async () => {
    if (pendingItems.length > 0) {
      showError('Wait for queued scans to sync before undoing.');
      return;
    }
    setBusy(true);
    try {
      const result = await undoStagingPull(requestId);
      if (result.status === 'nothing_to_undo') {
        showInfo(result.message);
      } else {
        applyCounts(result);
        setHistory((prev) => prev.slice(1));
        showSuccess(result.message);
      }
    } catch (err) {
      showError(errorText(err, 'Could not undo'));
    } finally {
      setBusy(false);
    }
  }, [requestId, pendingItems.length, applyCounts, showError, showInfo, showSuccess]);

  // ── Submit to staging ──────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (confirmed = false) => {
    if (pendingItems.length > 0) {
      showError('Wait for queued scans to sync before submitting.');
      return;
    }
    if (!locationId) {
      showError('Pick a staging location first.');
      return;
    }
    setBusy(true);
    try {
      const result = await submitStagingPull(requestId, {
        staging_location_id: locationId,
        staging_sub_location_id: subLocationId || null,
        confirmed,
      });
      if (result.status === 'needs_confirm') {
        setSubmitConfirm(result);
        return;
      }
      setSubmitConfirm(null);
      if (result.status === 'nothing_to_submit') {
        showInfo(result.message);
        return;
      }
      navigate('/forklift/staging-pull');
    } catch (err) {
      showError(errorText(err, 'Could not submit this pull.'));
    } finally {
      setBusy(false);
    }
  }, [requestId, pendingItems.length, locationId, subLocationId, navigate, showError, showInfo]);

  /**
   * Racks for the manual picker, in two groups. SORTED, never filtered: drum
   * and bag rooms first, everything else still reachable below.
   */
  const rackGroups = useMemo(() => {
    const q = rowQuery.trim().toLowerCase();
    const matches = q
      ? rows.filter((r) => `${r.name} ${r.path || ''} ${r.barcode || ''}`.toLowerCase().includes(q))
      : rows;
    const byName = (a, b) => String(a.name || '').localeCompare(
      String(b.name || ''), undefined, { numeric: true },
    );
    return [
      { key: 'units', label: 'Drum and bag rooms',
        rows: matches.filter((r) => r.storage_unit).sort(byName).slice(0, 60) },
      { key: 'other', label: 'Everywhere else',
        rows: matches.filter((r) => !r.storage_unit).sort(byName).slice(0, 60) },
    ].filter((g) => g.rows.length > 0);
  }, [rows, rowQuery]);

  const rackMatchCount = useMemo(
    () => rackGroups.reduce((n, g) => n + g.rows.length, 0),
    [rackGroups],
  );

  const subLocOptions = useMemo(
    () => (locationId ? (subLocationMap?.[locationId] || []) : []),
    [locationId, subLocationMap],
  );

  const netStatus = (
    <NetworkStatus
      online={online}
      pendingCount={pendingItems.length}
      failedCount={failedCount}
      onRetry={retry}
      onForceSync={drain}
    />
  );

  if (loading) {
    return (
      <ScannerLayout title="Staging Pull" showBack onBack={() => navigate('/forklift/staging-pull')}>
        <p className="sir-muted">Loading…</p>
      </ScannerLayout>
    );
  }
  if (loadError) {
    return (
      <ScannerLayout title="Staging Pull" showBack onBack={() => navigate('/forklift/staging-pull')}>
        <div className="sir-error"><AlertTriangle size={16} /> {loadError}</div>
      </ScannerLayout>
    );
  }

  const historyIcon = (entry) => {
    if (entry.state === 'pending') return <Clock size={16} color="#b45309" />;
    if (entry.state === 'error') return <X size={16} color="#dc2626" />;
    if (entry.state === 'confirm') return <AlertTriangle size={16} color="#b45309" />;
    return <Check size={16} color="#16a34a" />;
  };

  return (
    <ScannerLayout
      title="Staging Pull"
      showBack
      onBack={() => navigate('/forklift/staging-pull')}
      headerExtra={netStatus}
    >
      <div className="sir-session">
        <div className="sir-meta">
          <span>{request?.product_name}</span>
          {request?.formula_name && (
            <>
              <span className="sir-meta-sep">·</span>
              <span>{request.formula_name}</span>
            </>
          )}
          <span className="sir-meta-sep">·</span>
          <span>{formatCalendarDate(request?.production_date)}</span>
        </div>

        {/* What to pull, item by item, with the FEFO suggestion as ADVICE. */}
        <div className="spf-items">
          {items.map((item) => {
            const suggestion = item.suggestion;
            const topRack = suggestion?.racks?.[0];
            const unitLabel = suggestion?.unit_label || 'units';
            const done = (item.remaining_qty ?? 0) <= 0;
            return (
              <div key={item.id} className={`spf-item${done ? ' spf-item--done' : ''}`}>
                <div className="spf-item-head">
                  <strong>{item.ingredient_name}</strong>
                  <span className="spf-item-sid">{item.sid}</span>
                </div>
                <div className="spf-item-nums">
                  <span><strong>{item.quantity_needed}</strong> {item.unit} needed</span>
                  <span><strong>{item.quantity_fulfilled}</strong> staged</span>
                  <span><strong>{item.pending_qty}</strong> on cart</span>
                </div>
                {suggestion && !done && (
                  <div className="spf-suggest">
                    <span className="spf-suggest-line">
                      FEFO: lot {suggestion.lot_number}
                      {suggestion.expiration_date
                        ? ` (${formatCalendarDate(suggestion.expiration_date)})` : ''}
                      {topRack
                        ? ` — Rack: ${topRack.storage_row_name} (${topRack.available_units} ${unitLabel})`
                        : ''}
                    </span>
                    {suggestion.racks?.length > 0 && (
                      <span className="spf-suggest-chips">
                        {suggestion.racks.slice(0, 2).map((rack) => (
                          <span key={rack.storage_row_id} className="spf-chip">
                            {rack.storage_row_name} · {rack.available_units}
                            {rack.held_units > 0 ? ` (${rack.held_units} held)` : ''}
                          </span>
                        ))}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Sticky rack context — where the pull is coming FROM. */}
        <div className={`sir-rowbanner${row ? '' : ' sir-rowbanner--empty'}`}>
          <MapPin size={26} />
          {row ? (
            <div className="sir-rowbanner-text">
              <span className="sir-rowbanner-name">← {row.name}</span>
              <span className="sir-rowbanner-path">{row.path || 'Location'}</span>
            </div>
          ) : (
            <div className="sir-rowbanner-text">
              <span className="sir-rowbanner-name">Scan a rack</span>
              <span className="sir-rowbanner-path">No rack set — pulls are blocked</span>
            </div>
          )}
          <button type="button" className="sir-rowbanner-btn" onClick={() => setRowPicker(true)}>
            {row ? 'Change' : 'Pick rack'}
          </button>
        </div>

        {/* The FEFO question ASKS, inline, amber. Nothing was written; the
            parked scans replay with the same keys on confirm. */}
        {fefoConfirm && (
          <div className="sir-warn">
            <AlertTriangle size={18} />
            <div>
              <strong>{fefoConfirm.message || 'That is not the oldest lot.'}</strong>
              <div className="sir-warn-detail">
                {fefoConfirm.pending.length > 1
                  ? `${fefoConfirm.pending.length} scans are waiting on your answer.`
                  : (fefoConfirm.warning || 'Pull it anyway, or put it back and take the FEFO lot.')}
              </div>
              <div className="sir-warn-actions">
                <button type="button" className="sir-btn sir-btn--warn" onClick={confirmFefo}>
                  {fefoConfirm.pending.length > 1
                    ? `Pull all ${fefoConfirm.pending.length} anyway`
                    : 'Pull it anyway'}
                </button>
                <button type="button" className="sir-btn sir-btn--ghost" onClick={dismissFefo}>
                  Put it back
                </button>
              </div>
            </div>
            <button
              type="button"
              className="sir-warn-dismiss"
              onClick={dismissFefo}
              aria-label="Dismiss"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {/* Per-scan controls: how many units one trigger-pull means, and the
            one-shot open-drum flag. Visible, never a prompt per scan. */}
        <div className="spf-scanopts">
          <div className="spf-units">
            <span className="spf-units-label">Each scan is</span>
            <button
              type="button"
              className="spf-units-btn"
              onClick={() => setPerScan((v) => Math.max(1, v - 1))}
              aria-label="Fewer units per scan"
            >
              −
            </button>
            <input
              type="text"
              inputMode="numeric"
              className="spf-units-input"
              value={perScan}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                setPerScan(Number.isFinite(n) && n > 0 ? n : 1);
              }}
              aria-label="Units per scan"
            />
            <button
              type="button"
              className="spf-units-btn"
              onClick={() => setPerScan((v) => v + 1)}
              aria-label="More units per scan"
            >
              +
            </button>
          </div>
          <button
            type="button"
            className={`spf-open-btn${pullOpen ? ' is-on' : ''}`}
            onClick={() => setPullOpen((v) => !v)}
          >
            {pullOpen ? 'Next scan: OPEN drum' : 'Pull open drum'}
          </button>
        </div>

        <form onSubmit={handleScanSubmit} className="sir-form">
          <input
            ref={inputRef}
            type="text"
            value={scanInput}
            onChange={(e) => setScanInput(e.target.value)}
            placeholder={row ? 'Scan a lot sticker (or a new rack)…' : 'Scan the rack barcode…'}
            className="sir-input"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
          />
          {/* NOT disabled while busy — a disabled default button stops Enter
              submitting, and the gun types Enter after every read. */}
          <button type="submit" className="sir-scan-btn" disabled={!scanInput.trim()}>
            {busy ? '…' : <Scan size={22} />}
          </button>
        </form>
        <button type="button" className="sir-link" onClick={() => setManualKeyboard((v) => !v)}>
          <Keyboard size={14} /> {manualKeyboard ? 'Hide keyboard (use scanner)' : 'Type manually'}
        </button>

        <div className="sir-history">
          <div className="sir-history-head">
            <h3>Recent pulls</h3>
            {pendingItems.length > 0 && (
              <span className="sir-history-pending">
                {pendingItems.length} queued · {queuedUnits} units
              </span>
            )}
          </div>
          {history.length === 0 ? (
            <p className="sir-muted">
              Scan the rack, then scan the lot sticker on every drum you lift.
            </p>
          ) : history.map((entry) => (
            <div key={entry.key} className={`sir-history-item sir-history-item--${entry.state}`}>
              {historyIcon(entry)}
              <div className="sir-history-body">
                <span className="sir-history-serial">
                  +{entry.units || 1}
                  {entry.pullOpen ? ' (open)' : ''}
                  {entry.ingredientName ? ` · ${entry.ingredientName}` : ` · ${entry.lotCode}`}
                </span>
                {entry.state !== 'ok' && entry.message && (
                  <span className="sir-history-msg">{entry.message}</span>
                )}
              </div>
              <span className="sir-history-row">{entry.rowName}</span>
            </div>
          ))}
        </div>

        <div className="sir-actions">
          {/* Identical stickers make client-side dedupe impossible, so UNDO is
              first-class. Server-side, so it must wait for the queue. */}
          <button
            type="button"
            className="sir-btn sir-btn--ghost"
            onClick={handleUndo}
            disabled={busy || pendingItems.length > 0}
          >
            <RotateCcw size={16} /> Undo last pull
          </button>
        </div>

        {/* A short cart ASKS. Inline, amber — short is legal, and colouring a
            legal outcome red trains people to click past it. */}
        {submitConfirm && (
          <div className="sir-warn">
            <AlertTriangle size={18} />
            <div>
              <strong>{submitConfirm.message}</strong>
              {(submitConfirm.short_items || []).length > 0 && (
                <div className="sir-warn-detail">
                  Short: {submitConfirm.short_items.map((s) => (
                    typeof s === 'string' ? s : (s.ingredient_name || s.name || '')
                  )).filter(Boolean).join(', ') || `${submitConfirm.short_items.length} items`}
                </div>
              )}
              {submitConfirm.warning && (
                <div className="sir-warn-detail">{submitConfirm.warning}</div>
              )}
              <div className="sir-warn-actions">
                <button
                  type="button"
                  className="sir-btn sir-btn--warn"
                  onClick={() => handleSubmit(true)}
                  disabled={busy}
                >
                  Yes, submit short
                </button>
                <button
                  type="button"
                  className="sir-btn sir-btn--ghost"
                  onClick={() => setSubmitConfirm(null)}
                >
                  Keep pulling
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Where the cart goes. An inline panel, never a modal — a dialog that
            steals focus leaves the gun scanning into the void. */}
        {submitPanel && (
          <div className="spf-submit-panel">
            <span className="spf-submit-label">Stage the cart at</span>
            <select
              className="spf-select"
              value={locationId}
              onChange={(e) => { setLocationId(e.target.value); setSubLocationId(''); }}
            >
              <option value="">Select staging location…</option>
              {(locations || []).map((loc) => (
                <option key={loc.id} value={loc.id}>{loc.name}</option>
              ))}
            </select>
            {locationId && subLocOptions.length > 0 && (
              <select
                className="spf-select"
                value={subLocationId}
                onChange={(e) => setSubLocationId(e.target.value)}
              >
                <option value="">No sub-location</option>
                {subLocOptions.map((sub) => (
                  <option key={sub.id} value={sub.id}>{sub.name}</option>
                ))}
              </select>
            )}
          </div>
        )}

        <button
          type="button"
          className="sir-submit"
          onClick={() => {
            if (!submitPanel) { setSubmitPanel(true); return; }
            handleSubmit(false);
          }}
          disabled={busy || pendingItems.length > 0 || (submitPanel && !locationId)}
        >
          {submitPanel
            ? `Submit ${onCartQty > 0 ? `${onCartQty} on cart ` : ''}to staging`
            : 'Submit to staging…'}
        </button>

        <button
          type="button"
          className="sir-link"
          onClick={() => navigate('/forklift/staging-pull')}
        >
          Leave for now — keep this pull open
        </button>

        <p className="sir-muted sir-fineprint">
          Every scan is already off the rack and on the cart. Submitting hands
          the cart to staging; production takes it from there.
        </p>
      </div>

      {rowPicker && (
        <div className="sir-overlay" role="dialog" aria-modal="true">
          <div className="sir-dialog sir-dialog--tall">
            <h3>Pick a rack</h3>
            <p className="sir-dialog-hint">
              Scanning the rack label is faster and cannot pick the wrong one.
              This is for when the label is damaged.
            </p>
            <input
              type="text"
              value={rowQuery}
              onChange={(e) => setRowQuery(e.target.value)}
              placeholder="Search racks…"
              className="sir-dialog-input"
              autoFocus
            />
            <div className="sir-dialog-list">
              {rackGroups.map((group) => (
                <React.Fragment key={group.key}>
                  {rackGroups.length > 1 && (
                    <div className="sir-dialog-group">{group.label}</div>
                  )}
                  {group.rows.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className="sir-dialog-row"
                      onClick={() => adoptRow(r)}
                    >
                      <strong>{r.name}</strong>
                      <span>
                        {r.path || ''}
                        {r.storage_unit ? ` · ${r.unit_capacity || 0} ${r.storage_unit}s` : ''}
                      </span>
                    </button>
                  ))}
                </React.Fragment>
              ))}
              {rackMatchCount === 0 && <p className="sir-muted">No racks match.</p>}
            </div>
            <button
              type="button"
              className="sir-btn sir-btn--ghost"
              onClick={() => setRowPicker(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {feedback && (
        <ScanFeedback
          kind={feedback.kind}
          message={feedback.message}
          onDismiss={() => setFeedback(null)}
        />
      )}
    </ScannerLayout>
  );
};

const ScannerStagingPullFlow = () => {
  const { requestId } = useParams();
  return requestId ? <RequestView requestId={requestId} /> : <RequestListView />;
};

export default ScannerStagingPullFlow;
