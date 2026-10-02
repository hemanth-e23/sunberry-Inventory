import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle, Check, Clock, Keyboard, MapPin, RotateCcw, Scan, X,
} from 'lucide-react';
import ScannerLayout from './ScannerLayout';
import NetworkStatus from './NetworkStatus';
import ScanFeedback from './ScanFeedback';
import OfflineBanner from './OfflineBanner';
import { playErrorTone, playSuccessTone } from '../../utils/scannerFeedback';
import { singularUnit } from '../../utils/rowSources';
import {
  isUnreachableError, noteReachability, probeServer, removeScan,
} from '../../utils/scanQueue';
import { isTerminal, useLotScanQueue } from '../../hooks/useLotScanQueue';
import { useScanFocusKeeper } from '../../hooks/useScanFocusKeeper';
import { useGunRacks } from '../../hooks/useGunRacks';
import { decodeLotPayload } from '../../utils/labelPayload';
import { readCached, saveCached, sessionCacheKey } from '../../utils/gunCache';
import {
  needsPalletCheck, offlineMessage, palletCheckKey, queuedScanLabel, rackFillLabel,
  scanUnitsBadge, unitCount,
} from '../../utils/truckReceiving';
import {
  apiErrorMessage, getReceivingSession,
  lotScanEndpoint, newIdempotencyKey, resolveRow, submitReceivingSession,
  undoLastScan,
} from '../../api/lotReceivingApi';
import './ScannerIngredientReceiveFlow.css';

/**
 * Receiving on the gun, under lot-level identity.
 *
 * The physical job: scan a rack, then scan a drum, then scan the next drum, and
 * the next. EVERY DRUM OF A LOT WEARS AN IDENTICAL STICKER, so the same code is
 * read forty times in a row and each read means "+1 unit into this rack". When
 * the rack is full the gun asks whether to keep going rather than refusing, and
 * the worker moves to the next rack when they choose to.
 *
 * ── What is inherited unchanged from the per-drum flow, and why ──────────────
 *
 * The machinery below was built for unique serials but none of it actually
 * depends on uniqueness, so it is reused rather than rewritten:
 *
 *  * `useLotScanQueue` addresses the offline queue by ENDPOINT, never by what is
 *    in the payload. Swapping `{serial}` for `{lot_code}` changes nothing in it.
 *  * The queue mints an idempotency key per SCAN EVENT, not per item scanned, so
 *    forty reads of one sticker already produce forty distinct keys. That is
 *    exactly what lot receiving needs and it required no change.
 *  * The counter architecture is "server truth + pending overlay": counts of
 *    queue items, not of distinct identities.
 *  * The focus watchdog, the re-entrancy ref, and the deliberately NOT-disabled
 *    submit button. That last one is load-bearing — a form whose default button
 *    is disabled does not submit on Enter, so a disabled button silently
 *    swallows every gun trigger that lands mid-resolve, and the characters stay
 *    in the input so the NEXT scan decodes a concatenated string.
 *
 * ── What is genuinely different ─────────────────────────────────────────────
 *
 *  * NO client-side dedupe, and none is possible. Identical stickers mean the
 *    gun cannot tell a second drum from the same drum read twice. The honest
 *    answer is UNDO, which is why it is a first-class button rather than a
 *    supervisor correction the next day.
 *  * No "this drum is already in another row" fork. A lot has no per-item
 *    location, so the whole R-1/R-2 branch collapses into an increment.
 *  * The history shows "+1 → A-01 · 12 of 80" instead of a serial, because a
 *    serial is not a thing that exists any more.
 *
 * ── Rules the server upholds that this screen relies on ─────────────────────
 *
 * Every scan outcome is an HTTP 200 with a `status` discriminator. That is not
 * politeness: `scanQueue.js` treats anything that is not no-response/5xx/408/429
 * as terminal, writes the item to localStorage as permanently failed, and this
 * screen then drops the driver's optimistic row. A soft question asked as a 4xx
 * is a lost scan.
 */

const HISTORY_LIMIT = 40;

// A dropped connection and a 5xx read the same on the floor (browser test U1).
const errorText = (err, fallback) => (
  isUnreachableError(err)
    ? `${fallback} — the gun cannot reach the server.`
    : apiErrorMessage(err, fallback)
);

const reportFailure = (err) => {
  if (isUnreachableError(err)) noteReachability(false);
};

// ─── Session ─────────────────────────────────────────────────────────────────

const SessionView = ({ receiptId }) => {
  const navigate = useNavigate();
  const endpoint = useMemo(() => lotScanEndpoint(receiptId), [receiptId]);
  const endpointRef = useRef(endpoint);
  useEffect(() => { endpointRef.current = endpoint; }, [endpoint]);

  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  // The line as saved on this gun, shown when a reload finds no wifi (U1).
  const [staleSince, setStaleSince] = useState(null);
  // An action that needs the server (finish, undo) and could not reach it —
  // kept on screen, not a 2-second flash.
  const [actionNotice, setActionNotice] = useState('');
  // The pallet-or-bag question (U2) and the (rack) answers already given.
  const [palletAsk, setPalletAsk] = useState(null);
  const palletConfirmed = useRef(new Set());

  // Sticky rack context. Deliberately NOT persisted across a reload: a rack
  // restored from storage is a guessed location, and under lot identity a wrong
  // rack cannot be untangled afterwards — every drum on both racks wears the
  // same sticker, so nobody can work out later which pile was which.
  const [row, setRow] = useState(null);
  const { rows, setRows, fill: rackFill, refreshFill } = useGunRacks();
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
  // True while a scan is resolving. A ref, not state: the guard must be read
  // synchronously by the very next submit, before React re-renders.
  const scanInFlight = useRef(false);
  const [rowFull, setRowFull] = useState(null);
  const rowFullRef = useRef(null);
  useEffect(() => { rowFullRef.current = rowFull; }, [rowFull]);
  const [rowPicker, setRowPicker] = useState(false);
  // Set when finishing a line whose count disagrees with the paperwork. Holds
  // the server's wording of the difference so the worker is told WHAT
  // disagrees, not just that something does.
  const [submitConfirm, setSubmitConfirm] = useState(null);
  // HOW MANY UNITS ONE SCAN MEANS. 1 for drums and totes, which are stickered
  // individually. For bags and boxes it defaults to what a pallet holds, so
  // scanning the sticker on a wrapped pallet books all of them at once —
  // otherwise receiving 500 bags means 500 trigger-pulls at the dock.
  //
  // A visible control rather than a prompt on every scan: a modal per scan
  // would be unusable at gun speed, and it would steal focus from the input.
  // The multiplier stays on screen so it can never be silently wrong.
  const [perScan, setPerScan] = useState(1);
  const [rowQuery, setRowQuery] = useState('');

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
    // The queue is shared with the pallet flow and with other sessions; only
    // touch what this session sent.
    if (item.endpoint !== endpointRef.current) return;

    if (error) {
      if (!isTerminal(error)) return; // transient — leave it queued, keep the count
      removeScan(item.id);
      const message = errorText(error, 'Scan rejected');
      patchHistory(item.idempotency_key, { state: 'error', message });
      showError(message);
      return;
    }

    if (response.session_scanned_count != null) {
      setServerScanned(response.session_scanned_count);
    }
    // Only trust the rack count when the SERVER resolved a rack. On the
    // unknown_lot / lot_held / unknown_row paths it builds the payload with no
    // row at all and emits row_scanned_count: 0 — falling back to the payload's
    // row id there would overwrite a live "40 into A-01" with 0 because someone
    // scanned one bad sticker.
    const settledRowId = response.row_id || null;
    if (settledRowId && response.row_scanned_count != null) {
      setServerRowCounts((prev) => ({ ...prev, [settledRowId]: response.row_scanned_count }));
    }

    // The rack is full by the system. Asked, never refused — a driver holding a
    // drum needs somewhere the system will accept it. Rendered INLINE rather
    // than as a modal so it cannot steal focus from the scan input.
    if (response.status === 'needs_confirm') {
      patchHistory(item.idempotency_key, { state: 'confirm', message: response.message });
      // APPEND, never replace.
      //
      // scanQueue deletes each item from localStorage the moment a 200 comes
      // back, and a needs_confirm IS a 200 — so the only remaining handle on
      // that scan is the one kept here. The driver is pulling the trigger on
      // forty identical stickers back to back, so several can be in flight when
      // the rack fills. Replacing a single object would throw every earlier one
      // away: the drums are physically on the rack and the system has no record
      // of them and no way to resend.
      setRowFull((prev) => {
        const pending = {
          // The SAME idempotency key is replayed with allow_overfill, so a lost
          // first response cannot become a second drum.
          payload: item.payload,
          idempotencyKey: item.idempotency_key,
          rowId: response.row_id || item.payload?.storage_row_id,
          rowName: response.row_name || rowNameFor(item.payload?.storage_row_id),
        };
        if (!prev) {
          return {
            rowName: pending.rowName,
            question: response.message || '',
            detail: response.warning_detail || '',
            pending: [pending],
          };
        }
        if (prev.pending.some((p) => p.idempotencyKey === pending.idempotencyKey)) return prev;
        return { ...prev, pending: [...prev.pending, pending] };
      });
      playErrorTone();
      return;
    }

    if (response.status === 'unknown_lot' || response.status === 'unknown_row'
        || response.status === 'lot_held') {
      patchHistory(item.idempotency_key, { state: 'error', message: response.message });
      showError(response.message);
      return;
    }

    patchHistory(item.idempotency_key, {
      state: response.lot_mismatch ? 'duplicate' : 'ok',
      message: response.message,
      rowName: response.row_name || rowNameFor(settledRowId),
      count: response.row_scanned_count,
    });

    if (response.lot_mismatch) {
      // Recorded, but worth saying out loud: the usual cause is picking up the
      // wrong sticker stack.
      playSuccessTone();
      showInfo(response.message);
      return;
    }
    showSuccess(response.message || 'Received');
  }, [patchHistory, rowNameFor, showError, showInfo, showSuccess]);

  const {
    online, queue, send, drain, retry, syncing, lastSyncError,
  } = useLotScanQueue(onScanSettled);

  // ── Derived queue counts, scoped to this session ───────────────────────────
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
  // Counts UNITS, not queue items. One queued scan of a pallet sticker is 50
  // bags, so counting items would show "2 of 500" after two pallets.
  const unitsOf = (it) => Number(it.payload?.units) || 1;
  const pendingNew = useMemo(
    () => pendingItems.reduce((n, it) => n + unitsOf(it), 0),
    [pendingItems],
  );
  const pendingForRow = useMemo(() => {
    if (!row) return 0;
    return pendingItems
      .filter((it) => it.payload?.storage_row_id === row.id)
      .reduce((n, it) => n + unitsOf(it), 0);
  }, [pendingItems, row]);

  const expected = session?.expected_count || 0;
  const totalScanned = serverScanned + pendingNew;
  const unit = session?.count_unit || 'units';
  const oneUnit = singularUnit(unit) || 'unit';
  const rowCount = row ? (serverRowCounts[row.id] || 0) + pendingForRow : 0;
  const remaining = Math.max(0, expected - totalScanned);

  // Every rack this line has drums in, whatever visit put them there.
  //
  // Driven off serverRowCounts rather than session.rows: the session payload is
  // a snapshot from load, so a rack scanned during THIS visit would be missing
  // from it. Names are resolved from whichever source knows them — the session
  // snapshot, the cached rack list, or the rack in hand.
  const rackTally = useMemo(() => {
    const names = {};
    (session?.rows || []).forEach((b) => { names[b.storage_row_id] = b.storage_row_name; });
    rows.forEach((r) => { if (!names[r.id]) names[r.id] = r.name; });
    if (row) names[row.id] = row.name;
    return Object.entries(serverRowCounts)
      .filter(([, count]) => count > 0)
      .map(([id, count]) => ({ id, count, name: names[id] || id }))
      .sort((a, b) => b.count - a.count);
  }, [serverRowCounts, session, rows, row]);
  const dialogOpen = !!(rowPicker || palletAsk);

  // ── Load ───────────────────────────────────────────────────────────────────
  const applySession = useCallback((data) => {
    setSession(data);
    // Palletised material starts on the pallet multiplier; individually
    // stickered material stays at 1 and never shows the control.
    setPerScan(data.units_per_pallet && data.units_per_pallet > 1
      ? data.units_per_pallet : 1);
    setServerScanned(data.scanned_count || 0);
    const counts = {};
    (data.rows || []).forEach((b) => { counts[b.storage_row_id] = b.count; });
    setServerRowCounts(counts);
  }, []);

  const loadSession = useCallback(() => {
    setLoading(true);
    return getReceivingSession(receiptId)
      .then((data) => {
        applySession(data);
        saveCached(sessionCacheKey(receiptId), data);
        setStaleSince(null);
        setLoadError('');
        noteReachability(true);
      })
      .catch((err) => {
        reportFailure(err);
        // No wifi on a reload: the line as this gun last saw it (U1).
        const cached = isUnreachableError(err) ? readCached(sessionCacheKey(receiptId)) : null;
        if (cached) {
          applySession(cached.data);
          setStaleSince(cached.savedAt);
          setLoadError('');
        } else if (isUnreachableError(err)) {
          setLoadError(
            'The gun cannot reach the server, and this line is not saved on this gun yet. '
            + 'It opens by itself as soon as the gun is back online.',
          );
        } else {
          setLoadError(errorText(err, 'Could not load this session'));
        }
      })
      .finally(() => setLoading(false));
  }, [receiptId, applySession]);

  useEffect(() => { loadSession(); }, [loadSession]);

  // Back online with a saved copy (or nothing) on screen: load the real one.
  useEffect(() => {
    if (online && (staleSince || loadError)) loadSession();
  }, [online]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the saved copy current with every count the server confirms, so a
  // reload offline shows what was really booked, not the count at opening.
  useEffect(() => {
    if (!session || staleSince) return;
    const names = {};
    (session.rows || []).forEach((b) => { names[b.storage_row_id] = b.storage_row_name; });
    rowsRef.current.forEach((r) => { if (!names[r.id]) names[r.id] = r.name; });
    saveCached(sessionCacheKey(receiptId), {
      ...session,
      scanned_count: serverScanned,
      rows: Object.entries(serverRowCounts).map(([id, count]) => ({
        storage_row_id: id, storage_row_name: names[id] || id, count,
      })),
    });
  }, [session, staleSince, serverScanned, serverRowCounts, receiptId]);

  // Back online: the actions that needed the server can be tried again.
  useEffect(() => { if (online) setActionNotice(''); }, [online]);

  // ── Keyboard-wedge focus, same idiom as the pallet gun ─────────────────────
  useEffect(() => {
    if (manualKeyboard || dialogOpen) return undefined;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [manualKeyboard, dialogOpen, feedback, row, loading, perScan]);
  useScanFocusKeeper(inputRef, !manualKeyboard && !dialogOpen);

  // A scan that is NOT put away still gets a row in Recent scans — a flash
  // alone read as "the gun ignored me" (browser test F7b).
  const logRefusal = useCallback((lotCode, message) => {
    showError(message);
    setHistory((prev) => [
      { key: newIdempotencyKey(), lotCode, rowName: '—', units: 0, state: 'error', refused: true, message },
      ...prev,
    ].slice(0, HISTORY_LIMIT));
  }, [showError]);

  // ── Rack context ───────────────────────────────────────────────────────────
  const adoptRow = useCallback((resolved) => {
    // Scans still waiting on the full-rack question were never booked; moving
    // on must not leave them looking like "+1" in Recent scans (U10).
    (rowFullRef.current?.pending || []).forEach((p) => patchHistory(p.idempotencyKey, {
      state: 'error', refused: true, message: 'Not put away — you moved to another rack. Scan it again here.',
    }));
    setRow(resolved);
    setRows((prev) => (prev.some((r) => r.id === resolved.id) ? prev : [...prev, resolved]));
    setRowFull(null);
    setRowPicker(false);
    showSuccess(`→ ${resolved.name}`);
  }, [showSuccess, patchHistory, setRows]);

  /**
   * Ask the SERVER what rack a code is. Returns `{ row, error }`:
   *   row set    → resolved, adopt it
   *   error set  → the server named a problem (ambiguous name, deactivated
   *                rack); show it verbatim and never guess past it
   *   both null  → not a rack; the caller may treat the token as a lot code
   */
  const resolveRowCode = useCallback(async (code) => {
    // Offline: exact BARCODE equality against the list saved on the gun.
    // Barcodes are unique, so an exact hit is unambiguous. Names are
    // deliberately not matched — row names are NOT unique, and that is the
    // fuzzy path that puts drums in the wrong barn.
    const fromCache = () => {
      const upper = code.toUpperCase();
      const hit = rowsRef.current.find((r) => (r.barcode || '').toUpperCase() === upper);
      return { row: hit || null, error: null };
    };
    if (!online) return fromCache();
    try {
      return { row: await resolveRow(code), error: null };
    } catch (err) {
      const status = err?.response?.status;
      if (status === 404) return { row: null, error: null }; // simply not a rack
      // Dropped mid-scan: a rack label still works from the saved list.
      if (isUnreachableError(err)) { reportFailure(err); return fromCache(); }
      return { row: null, error: errorText(err, 'Could not resolve that rack') };
    }
  }, [online]);

  // ── Unit scan ──────────────────────────────────────────────────────────────
  // `units` overrides the per-scan setting (the pallet-or-bag answer, or the
  // over-fill replay of what was originally scanned).
  const recordUnit = useCallback((lotCode, {
    allowOverfill = false, reuseKey, intoRow, units, palletChecked = false,
  } = {}) => {
    // `intoRow` pins the rack explicitly. Used by the over-fill replay, where
    // the rack the confirm was raised for may no longer be the sticky one.
    const target = intoRow || row;
    if (!target) {
      // The server enforces this too; blocking here saves the trip and, offline,
      // is the only thing standing between a drum and a guess.
      logRefusal(lotCode, online
        ? `Not put away — scan the rack first. A ${oneUnit} is never placed by guess.`
        : 'Not put away — scan the rack first (offline, so pick the rack from the list).');
      return;
    }
    const n = Math.max(1, Number(units) || perScan);
    // U2: a pallet and a bag of this lot wear the same code. The first
    // pallet-sized scan onto a rack that has none of it yet asks which it was.
    const alreadyThere = (serverRowCounts[target.id] || 0) > 0
      || pendingItems.some((it) => it.payload?.storage_row_id === target.id);
    if (!reuseKey && !palletChecked && !alreadyThere && needsPalletCheck({
      unitsPerScan: n, confirmed: palletConfirmed.current, lineId: receiptId, rowId: target.id,
    })) {
      playErrorTone();
      setPalletAsk({ lotCode, row: target, units: n });
      return;
    }
    const payload = {
      lot_code: lotCode,
      storage_row_id: target.id,
      // Display-only, for the queue panel; the server ignores it.
      display: queuedScanLabel({
        productName: session?.product_name,
        vendorLot: session?.vendor_lot,
        lotCode,
        rowName: target.name,
        units: n,
        unit: oneUnit,
      }),
    };
    if (n > 1) payload.units = n;
    if (allowOverfill) payload.allow_overfill = true;
    const item = send(receiptId, endpoint, payload, reuseKey);
    const entry = {
      key: item.idempotency_key,
      lotCode,
      rowId: target.id,
      rowName: target.name,
      units: n,
      state: 'pending',
      message: 'Queued',
    };
    setHistory((prev) => [
      entry,
      // Drop any earlier entry with this key. The over-fill confirm deliberately
      // REUSES the idempotency key — that is what stops a lost first response
      // becoming a second drum — so without this the replayed scan would sit in
      // the list twice under one React key, and React would render whichever it
      // reconciled to rather than the live one.
      ...prev.filter((h) => h.key !== entry.key),
    ].slice(0, HISTORY_LIMIT));
  }, [row, online, send, receiptId, endpoint, perScan, logRefusal, oneUnit, serverRowCounts,
    pendingItems, session]);

  const handleScanSubmit = useCallback(async (e) => {
    e?.preventDefault?.();
    const raw = scanInput.trim();
    if (!raw) return;

    // Re-entrancy guard. The submit button must NOT be disabled while a scan is
    // resolving (see the JSX) — a form whose default button is disabled does not
    // submit on Enter, so a disabled button silently swallows every gun trigger
    // that lands during the rack-resolve round trip, and the characters stay in
    // the input so the NEXT scan decodes a concatenated string. One drum
    // recorded twice, one never recorded, no error.
    // Clear FIRST, including on the guarded path. Leaving the characters in the
    // controlled input is the exact failure the guard exists to prevent: the
    // next trigger appends to them and decodes a concatenated string, so one
    // drum is recorded twice and one is never recorded, with no error.
    setScanInput('');
    if (scanInFlight.current) {
      showError(`Still resolving the last rack — scan that ${oneUnit} again.`);
      return;
    }

    const decoded = decodeLotPayload(raw);

    // A versioned envelope (`SB2|lot_code|lot|bbd`) is unambiguously a sticker.
    if (decoded && !decoded.bare) {
      recordUnit(decoded.lotCode);
      return;
    }
    if (!decoded) {
      showError('Unreadable sticker — scan the 2D code or key the lot code.');
      return;
    }

    // A bare token is either a rack barcode or a hand-keyed lot code. The server
    // decides which; there is no client-side format test, because rack
    // resolution is server-side and a lot code has no parseable structure.
    scanInFlight.current = true;
    setBusy(true);
    try {
      const { row: found, error } = await resolveRowCode(raw);
      if (found) { adoptRow(found); return; }
      if (error) { showError(error); return; }
      if (!row) {
        logRefusal(raw, online
          ? `Not a known rack — scan the rack first, then any ${oneUnit}.`
          : 'Offline — that code is not in the cached rack list. Pick the rack from the list.');
        return;
      }
      recordUnit(raw);
    } finally {
      scanInFlight.current = false;
      setBusy(false);
    }
  }, [scanInput, recordUnit, resolveRowCode, adoptRow, row, online, showError, logRefusal, oneUnit]);

  // ── Over-fill confirm ──────────────────────────────────────────────────────
  const confirmOverfill = useCallback(() => {
    if (!rowFull?.pending?.length) { setRowFull(null); return; }
    // Replay EVERY parked scan, each against the rack IT was raised for — never
    // against the current sticky rack. The two can differ: a needs_confirm
    // arriving from the drain re-opens this banner after the driver has already
    // moved to the next rack, and replaying against `row` would file drums into
    // a rack they were never put in. Under lot identity that is unrecoverable,
    // because every drum wears the same sticker.
    rowFull.pending.forEach((p) => {
      recordUnit(p.payload.lot_code, {
        allowOverfill: true,
        reuseKey: p.idempotencyKey,  // same key -> replay, not a second drum
        intoRow: { id: p.rowId, name: p.rowName },
        units: Number(p.payload?.units) || 1, // what was scanned, not today's setting
      });
    });
    setRowFull(null);
  }, [rowFull, recordUnit]);

  // ── Undo ───────────────────────────────────────────────────────────────────
  /**
   * Finish the line and leave the gun.
   *
   * A line stays on the gun until somebody says it is done — `open_sessions`
   * cannot infer it, because over-receiving is legal and hiding at the
   * paperwork count would strand the 81st drum of an expected 80.
   *
   * A mismatch is confirmed, never blocked. Both directions are legal and both
   * happen; refusing either would teach drivers to make the number fit rather
   * than report what they counted.
   */
  // Finish and Undo need the server. Neither is queued: an undo replayed later
  // could take off a scan the worker has since re-made, and a remove made
  // offline used to vanish without a word (B7). Both say so instead.
  const needsServer = useCallback(async (what) => {
    if (pendingItems.length > 0) {
      setActionNotice(online
        ? `${what}: ${pendingItems.length} scan(s) are still sending. Try again in a moment.`
        : `${what}: the gun is offline. ${pendingItems.length} scan(s) are saved on this gun `
          + 'and send by themselves when it is back — then try again.');
      playErrorTone();
      if (online) drain();
      return false;
    }
    // "Offline" may be a stale browser flag: ask the server once before refusing.
    if (!online && !(await probeServer())) {
      setActionNotice(offlineMessage(`${what} — not done`));
      playErrorTone();
      return false;
    }
    setActionNotice('');
    return true;
  }, [pendingItems.length, online, drain]);

  const handleSubmit = useCallback(async (confirmed = false) => {
    if (!(await needsServer('Cannot finish yet'))) return;
    setBusy(true);
    try {
      const result = await submitReceivingSession(receiptId, { confirmed });
      if (result.status === 'needs_confirm') {
        setSubmitConfirm(result);
        return;
      }
      setSubmitConfirm(null);
      navigate('/forklift/lot-receiving');
    } catch (err) {
      reportFailure(err);
      if (isUnreachableError(err)) setActionNotice(offlineMessage('Line NOT finished'));
      else showError(apiErrorMessage(err, 'Could not finish this line.'));
    } finally {
      setBusy(false);
    }
  }, [receiptId, navigate, showError, needsServer]);

  const handleUndo = useCallback(async () => {
    if (!(await needsServer('Cannot undo yet'))) return;
    setBusy(true);
    try {
      const result = await undoLastScan(receiptId);
      if (result.status === 'nothing_to_undo') {
        showInfo(result.message);
      } else {
        setServerScanned(result.session_scanned_count);
        if (result.row_id) {
          setServerRowCounts((prev) => ({
            ...prev, [result.row_id]: result.row_scanned_count,
          }));
        }
        setHistory((prev) => prev.slice(1));
        showSuccess(result.message);
      }
    } catch (err) {
      reportFailure(err);
      // Never a count change that did not happen: the counters only move on
      // the server's answer, so here they stay exactly as they were.
      if (isUnreachableError(err)) setActionNotice(offlineMessage('NOT undone'));
      else showError(errorText(err, 'Could not undo'));
    } finally {
      setBusy(false);
    }
  }, [receiptId, showError, showInfo, showSuccess, needsServer]);

  // "Pick another rack" (or dismissing the full-rack question): the parked
  // scans booked nothing, so Recent scans must not keep a "+1" for them (U10).
  const dropParked = useCallback((reason) => {
    (rowFull?.pending || []).forEach((p) => patchHistory(p.idempotencyKey, {
      state: 'error', refused: true, message: reason,
    }));
    setRowFull(null);
  }, [rowFull, patchHistory]);

  const openRackPicker = useCallback(() => {
    setRowPicker(true);
    refreshFill();
  }, [refreshFill]);

  const queuedByRack = useMemo(() => {
    const out = {};
    pendingItems.forEach((it) => {
      const id = it.payload?.storage_row_id;
      if (id) out[id] = (out[id] || 0) + (Number(it.payload?.units) || 1);
    });
    return out;
  }, [pendingItems]);

  const answerPallet = useCallback((isPallet) => {
    const ask = palletAsk;
    setPalletAsk(null);
    if (!ask) return;
    if (isPallet) {
      palletConfirmed.current.add(palletCheckKey(receiptId, ask.row.id));
      recordUnit(ask.lotCode, { units: ask.units, palletChecked: true, intoRow: ask.row });
    } else {
      recordUnit(ask.lotCode, { units: 1, palletChecked: true, intoRow: ask.row });
      showInfo(`Booked 1 ${oneUnit}. More single ones? Switch "Each scan is" to 1.`);
    }
  }, [palletAsk, receiptId, recordUnit, showInfo, oneUnit]);

  /**
   * Racks for the manual picker, in two groups.
   *
   * SORTED, never filtered. A driver receiving drums should see drum and bag
   * rooms first — unsorted, the list is every rack in the plant alphabetically,
   * so finished-goods areas sit at the top and the actual barn is a long thumb
   * away. But hiding the rest would deny somebody with a real reason to use a
   * rack we did not anticipate, and row capacity is a soft hint here by policy.
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

  const netStatus = (
    <NetworkStatus
      online={online}
      pendingCount={pendingItems.length}
      failedCount={failedCount}
      syncing={syncing}
      lastSyncError={lastSyncError}
      onRetry={retry}
      onForceSync={drain}
    />
  );

  if (loading && !session) {
    return (
      <ScannerLayout title="Receiving" showBack onBack={() => navigate('/forklift/lot-receiving')}>
        <p className="sir-muted">Loading…</p>
      </ScannerLayout>
    );
  }
  if (loadError && !session) {
    return (
      <ScannerLayout
        title="Receiving"
        showBack
        onBack={() => navigate('/forklift/lot-receiving')}
        headerExtra={netStatus}
      >
        <OfflineBanner online={online} queued={pendingItems.length} />
        <div className="sir-error"><AlertTriangle size={16} /> {loadError}</div>
      </ScannerLayout>
    );
  }

  const historyIcon = (entry) => {
    if (entry.state === 'pending') return <Clock size={16} color="#b45309" />;
    if (entry.state === 'error') return <X size={16} color="#dc2626" />;
    if (entry.state === 'confirm') return <AlertTriangle size={16} color="#b45309" />;
    if (entry.state === 'duplicate') return <AlertTriangle size={16} color="#6b7280" />;
    return <Check size={16} color="#16a34a" />;
  };

  return (
    <ScannerLayout
      title={session?.product_name || session?.lot_code || 'Receiving'}
      showBack
      onBack={() => navigate('/forklift/lot-receiving')}
      headerExtra={netStatus}
    >
      <div className="sir-session">
        <div className="sir-meta">
          <span>{session?.vendor_lot ? `Lot ${session.vendor_lot}` : 'Lot unknown'}</span>
          <span className="sir-meta-sep">·</span>
          <span>sticker {session?.lot_code}</span>
          <span className="sir-meta-sep">·</span>
          <span>
            {session?.source === 'incoming_order' ? session.order_number : 'Walk-in'}
          </span>
        </div>

        {session?.needs_review && (
          <div className="sir-error">
            <AlertTriangle size={16} /> This lot is flagged for review — stop and
            fetch a supervisor before scanning any of it in.
          </div>
        )}

        {/* Sticky rack context — the single most important thing on screen. */}
        <div className={`sir-rowbanner${row ? '' : ' sir-rowbanner--empty'}`}>
          <MapPin size={26} />
          {row ? (
            <div className="sir-rowbanner-text">
              <span className="sir-rowbanner-name">→ {row.name}</span>
              <span className="sir-rowbanner-path">{row.path || 'Location'}</span>
            </div>
          ) : (
            <div className="sir-rowbanner-text">
              <span className="sir-rowbanner-name">Scan a rack</span>
              <span className="sir-rowbanner-path">No location set — {unit} are blocked</span>
            </div>
          )}
          <button type="button" className="sir-rowbanner-btn" onClick={openRackPicker}>
            {row ? 'Change' : 'Pick rack'}
          </button>
        </div>

        <OfflineBanner online={online} queued={pendingItems.length} staleSince={staleSince} what="line" />

        {/* A full rack ASKS. Rendered inline rather than as a modal, deliberately:
            a dialog that steals focus and does not give it back leaves the driver
            scanning into the void with no visible error. */}
        {rowFull && (
          <div className="sir-warn">
            <AlertTriangle size={18} />
            <div>
              <strong>{rowFull.question || `${rowFull.rowName || 'This rack'} is at its capacity — load past it?`}</strong>
              <div className="sir-warn-detail">
                {rowFull.pending?.length > 1
                  ? `${rowFull.pending.length} scans are waiting on your answer.`
                  : (rowFull.detail || 'Load into it anyway, or scan a different rack.')}
              </div>
              {rowFull.pending?.length > 0 && (
                <div className="sir-warn-actions">
                  <button type="button" className="sir-btn sir-btn--warn" onClick={confirmOverfill}>
                    {rowFull.pending.length > 1
                      ? `Load all ${rowFull.pending.length} here anyway`
                      : 'Load it here anyway'}
                  </button>
                  <button
                    type="button"
                    className="sir-btn sir-btn--ghost"
                    onClick={() => {
                      dropParked('Not put away — you chose another rack. Scan it again at the new rack.');
                      openRackPicker();
                    }}
                  >
                    Pick another rack
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              className="sir-warn-dismiss"
              onClick={() => dropParked('Not put away — the full-rack question was dismissed.')}
              aria-label="Dismiss"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {/* Shown ONLY for palletised material. Drums and totes are stickered
            individually, so one scan is one drum and a multiplier would be a
            way to get it wrong for no benefit. */}
        {session?.units_per_pallet > 1 && (
          <div className="sir-perscan">
            <span className="sir-perscan-label">Each scan is</span>
            <div className="sir-perscan-opts">
              {/* onMouseDown preventDefault: a tap must not take focus off the
                  scan box, or the next trigger pull goes nowhere (F12). */}
              <button
                type="button"
                className={`sir-perscan-btn${perScan === session.units_per_pallet ? ' is-on' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setPerScan(session.units_per_pallet)}
              >
                <strong>{session.units_per_pallet}</strong>
                <span>a pallet</span>
              </button>
              <button
                type="button"
                className={`sir-perscan-btn${perScan === 1 ? ' is-on' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setPerScan(1)}
              >
                <strong>1</strong>
                <span>single {singularUnit(unit)}</span>
              </button>
            </div>
          </div>
        )}

        <form onSubmit={handleScanSubmit} className="sir-form">
          <input
            ref={inputRef}
            type="text"
            value={scanInput}
            onChange={(e) => setScanInput(e.target.value)}
            placeholder={row ? `Scan a ${oneUnit} (or a new rack)…` : 'Scan the rack barcode…'}
            className="sir-input"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
          />
          {/* NOT disabled while busy — see the re-entrancy note in
              handleScanSubmit. A disabled default button stops Enter submitting. */}
          <button type="submit" className="sir-scan-btn" disabled={!scanInput.trim()}>
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
            <span className="sir-count-label">into {row ? row.name : 'this rack'}</span>
          </div>
          <div className="sir-count sir-count--total">
            <span className="sir-count-value">{totalScanned}</span>
            <span className="sir-count-label">of {expected} {unit}</span>
          </div>
        </div>

        {/* Where this line's drums already are, across every rack.
            "Recent scans" below is this visit only — walk away and come back and
            it is empty, which read as "nothing was ever scanned" on a line that
            was half done. This survives, because the server has counted it all
            along; it just was not being shown.

            Per RACK, never per drum: every drum of a lot wears an identical
            sticker, so the gun cannot tell drum 4 from drum 7. A per-drum list
            would be invented detail. */}
        {rackTally.length > 0 && (
          <div className="sir-rack-tally">
            <span className="sir-rack-tally-label">Counted in so far</span>
            <ul className="sir-rack-tally-list">
              {rackTally.map((entry) => (
                <li key={entry.id}>
                  <strong>{entry.name}</strong>
                  <span>{entry.count} {unit}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {totalScanned > expected && expected > 0 && (
          <div className="sir-warn">
            <AlertTriangle size={18} />
            <div>
              <strong>{totalScanned - expected} more than the paperwork.</strong>
              <div className="sir-warn-detail">
                That is allowed — it is recorded and the approver will see it.
              </div>
            </div>
          </div>
        )}

        <div className="sir-history">
          <div className="sir-history-head">
            <h3>Recent scans</h3>
            {pendingItems.length > 0 && (
              <span className="sir-history-pending">{pendingItems.length} queued</span>
            )}
          </div>
          {history.length === 0 ? (
            <p className="sir-muted">
              Scan the rack, then scan a {oneUnit} for every one you put in it.
            </p>
          ) : history.map((entry) => (
            <div key={entry.key} className={`sir-history-item sir-history-item--${entry.state}`}>
              {historyIcon(entry)}
              <div className="sir-history-body">
                {/* No serial to show — every sticker is identical. What a worker
                    can actually check against the pile is the running count. */}
                <span className="sir-history-serial">
                  {entry.refused ? `Not put away · ${entry.lotCode}` : (() => {
                    // A pallet scan (+50) must not look like a single (+1).
                    const badge = scanUnitsBadge(entry.units, unit);
                    return (
                      <span className={`sir-units-badge${badge.pallet ? ' sir-units-badge--pallet' : ''}`}>
                        {badge.text}
                      </span>
                    );
                  })()}
                  {entry.count != null ? ` · ${entry.count} in rack` : ''}
                </span>
                {entry.state !== 'ok' && entry.message && (
                  <span className="sir-history-msg">
                    {entry.state === 'pending' && !online
                      ? 'Saved on this gun — sends when back online'
                      : entry.message}
                  </span>
                )}
              </div>
              <span className="sir-history-row">{entry.rowName}</span>
            </div>
          ))}
        </div>

        <div className="sir-actions">
          {/* Undo is first-class because identical stickers make client-side
              dedupe impossible: the gun cannot tell a second drum from the same
              drum read twice, so the worker needs a way to say so.
              Not disabled while scans are queued or offline: the tap says why. */}
          <button
            type="button"
            className="sir-btn sir-btn--ghost"
            onClick={handleUndo}
            disabled={busy}
          >
            <RotateCcw size={16} /> Undo last scan
          </button>
        </div>

        {actionNotice && (
          <div className="sir-error" role="alert">
            <AlertTriangle size={16} /> {actionNotice}
          </div>
        )}

        {/* A count that disagrees with the paperwork ASKS. Inline, not a modal,
            for the same reason the full-rack warning is: a dialog that steals
            focus and does not give it back leaves the driver scanning into the
            void. Amber, never red — short and over are both legal, and
            colouring a legal outcome red trains people to click past it. */}
        {submitConfirm && (
          <div className="sir-warn">
            <AlertTriangle size={18} />
            <div>
              <strong>{submitConfirm.message}</strong>
              <div className="sir-warn-detail">
                Counted {submitConfirm.scanned_count} of {submitConfirm.expected_count}
                {' '}{unit} on the paperwork.
              </div>
              <div className="sir-warn-actions">
                <button
                  type="button"
                  className="sir-btn sir-btn--warn"
                  onClick={() => handleSubmit(true)}
                  disabled={busy}
                >
                  Yes, finish this line
                </button>
                <button
                  type="button"
                  className="sir-btn sir-btn--ghost"
                  onClick={() => setSubmitConfirm(null)}
                >
                  Keep scanning
                </button>
              </div>
            </div>
          </div>
        )}

        <button
          type="button"
          className="sir-submit"
          onClick={() => handleSubmit(false)}
          disabled={busy}
        >
          {remaining > 0
            ? `Finish — ${remaining} ${unit} still expected`
            : 'Finish'}
        </button>

        <button
          type="button"
          className="sir-link"
          onClick={() => navigate('/forklift/lot-receiving')}
        >
          Leave for now — keep this line open
        </button>

        <p className="sir-muted sir-fineprint">
          Everything scanned is already in stock. Finishing takes this line off
          the gun; the office checks the paperwork against these counts
          afterwards.
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
                  {group.rows.map((r) => {
                    // "11/12 drums", not just "12 drums" (U10).
                    const fillLabel = rackFillLabel(r, (rackFill[r.id] || 0) + (queuedByRack[r.id] || 0));
                    return (
                      <button
                        key={r.id}
                        type="button"
                        className="sir-dialog-row"
                        onClick={() => adoptRow(r)}
                      >
                        <strong>
                          {r.name}
                          {fillLabel.text && (
                            <span className={`sir-rack-fill${fillLabel.full ? ' is-full' : ''}`}>
                              {fillLabel.text}
                            </span>
                          )}
                        </strong>
                        <span>{r.path || ''}</span>
                      </button>
                    );
                  })}
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

      {palletAsk && (
        <div className="sir-overlay" role="dialog" aria-modal="true">
          <div className="sir-dialog">
            <AlertTriangle size={36} color="#b45309" />
            <h3>Pallet sticker, or one {oneUnit}?</h3>
            <p className="sir-dialog-hint sir-truck-question">
              Onto {palletAsk.row.name}. A pallet and a single {oneUnit} wear the same
              code — check the word on the sticker. Asked once per rack.
            </p>
            {/* No autoFocus: the gun's next Enter must not answer this. */}
            <button type="button" className="sir-btn sir-btn--warn" onClick={() => answerPallet(true)}>
              PALLET sticker — book {unitCount(palletAsk.units, oneUnit)}
            </button>
            <button type="button" className="sir-btn sir-btn--warn" onClick={() => answerPallet(false)}>
              One {oneUnit} — book 1
            </button>
            <button
              type="button"
              className="sir-btn sir-btn--ghost"
              onClick={() => { setPalletAsk(null); showInfo('Nothing booked.'); }}
            >
              Cancel — book nothing
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

/**
 * One per-receipt session. Only walk-in receipts (logged off a BOL with no
 * incoming order) open here now; an incoming order is received a TRUCK at a
 * time in ScannerTruckReceiveFlow, which also owns the list screen.
 */
const ScannerLotReceiveFlow = () => {
  const { receiptId } = useParams();
  return <SessionView receiptId={receiptId} />;
};

export default ScannerLotReceiveFlow;
