import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle, Check, Clock, Keyboard, MapPin, Minus, Scan, Truck, X,
} from 'lucide-react';
import ScannerLayout from './ScannerLayout';
import NetworkStatus from './NetworkStatus';
import ScanFeedback from './ScanFeedback';
import { playErrorTone, playSuccessTone } from '../../utils/scannerFeedback';
import { pluralizeUnit, singularUnit } from '../../utils/rowSources';
import { removeScan } from '../../utils/scanQueue';
import { decodeLotPayload } from '../../utils/labelPayload';
import {
  createDoubleFireGuard, describeRecountDiff, formatUnitTotals, lineMismatchNote,
  overScanTitle, parseLooseQty, scanUnitsBadge, truckUnitWords, unitCount,
} from '../../utils/truckReceiving';
import { isTerminal, useLotScanQueue } from '../../hooks/useLotScanQueue';
import { useScanFocusKeeper } from '../../hooks/useScanFocusKeeper';
import {
  apiErrorMessage, getTruck, listReceivingSessions, listTrucks, locateTruck,
  newIdempotencyKey, orderIdFromTruckEndpoint, receiptIdFromEndpoint, resolveRow,
  truckFinish, truckRecount, truckRemove, truckScanEndpoint,
} from '../../api/lotReceivingApi';
import { listIngredientRows } from '../../api/ingredientIntakeApi';
import './ScannerIngredientReceiveFlow.css';

/**
 * Receiving a TRUCK on the gun (2026-10).
 *
 * A trailer carries several lots mixed together. The worker picks the truck
 * (or just scans any drum on it), scans a rack, then scans every drum they put
 * there in whatever order they come off — the server routes each one to its
 * own line by the lot on the sticker.
 *
 * Every drum of a lot wears an IDENTICAL sticker, so the gun cannot tell a
 * second drum from the same one read twice. The screen leans on checks instead
 * of trust:
 *   * a read identical to the last one inside 1 second is a trigger bounce
 *   * more than the paperwork, or a lot not on this truck, STOPS and asks
 *   * the rack forgets itself after 2 idle minutes — a worker back from a
 *     break must say where they are again
 *   * moving to a new rack asks for a count of the one just left, and the
 *     truck cannot be finished while any rack is uncounted
 *   * finishing short needs a reason
 *
 * Everything from the per-receipt screen about the offline queue still holds:
 * every outcome is an HTTP 200 with a `status`, the submit button is never
 * disabled while busy (a disabled default button swallows the gun's Enter), and
 * a confirm replays the SAME idempotency key so a lost response cannot become a
 * second drum.
 */

const HISTORY_LIMIT = 40;
const RACK_IDLE_MS = 2 * 60 * 1000;

const SHORT_REASONS = [
  { value: 'truck_short', label: 'Truck arrived short' },
  { value: 'damaged', label: 'Damaged on arrival' },
  { value: 'refused', label: 'Refused at the dock' },
  { value: 'other', label: 'Other' },
];

const errorText = (err, fallback) => apiErrorMessage(err, fallback);

const sameCode = (a, b) => String(a || '').toUpperCase() === String(b || '').toUpperCase();

// ─── Truck list ──────────────────────────────────────────────────────────────

const TruckListView = () => {
  const navigate = useNavigate();
  const [trucks, setTrucks] = useState([]);
  const [walkIns, setWalkIns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scanInput, setScanInput] = useState('');
  const [choices, setChoices] = useState(null);
  const [feedback, setFeedback] = useState(null);
  // The last refusal stays on screen: a 2-second flash was easy to miss, and
  // a scan that "did nothing" is exactly what the browser test reported (F7).
  const [notice, setNotice] = useState('');
  const inputRef = useRef(null);

  // The list keeps the queue draining, so backing out mid-truck strands nothing.
  const { online, queue, drain, retry, syncing, lastSyncError } = useLotScanQueue(() => {});
  const mine = useMemo(
    () => queue.filter((it) => orderIdFromTruckEndpoint(it.endpoint) || receiptIdFromEndpoint(it.endpoint)),
    [queue],
  );

  const load = useCallback(() => {
    setLoading(true);
    return Promise.all([listTrucks(), listReceivingSessions({ walkInOnly: true })])
      .then(([t, s]) => {
        setTrucks(Array.isArray(t) ? t : []);
        setWalkIns(Array.isArray(s) ? s : []);
        setError('');
      })
      .catch((err) => setError(errorText(err, 'Could not load receiving')))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!choices) inputRef.current?.focus();
  }, [choices, loading]);
  // The first scan after the list loaded went nowhere (F7a): nothing put focus
  // back once it was lost. The keeper does, and catches a scan typed at <body>.
  useScanFocusKeeper(inputRef, !choices);

  const refuse = useCallback((message) => {
    playErrorTone();
    setNotice(message);
    setFeedback({ kind: 'error', message });
  }, []);

  // Scanning any drum opens the truck it is on — the worker does not have to
  // find the right card first.
  const handleScan = useCallback(async (e) => {
    e?.preventDefault?.();
    const raw = scanInput.trim();
    setScanInput('');
    if (!raw) return;
    const decoded = decodeLotPayload(raw);
    const code = decoded?.lotCode || raw;
    setNotice('');
    try {
      const result = await locateTruck(code);
      if (result.trucks?.length === 1) {
        navigate(`/forklift/lot-receiving/truck/${result.trucks[0].order_id}`);
      } else if (result.trucks?.length > 1) {
        setChoices(result);
      } else if (result.status === 'unknown_lot' && (!decoded || decoded.bare)) {
        // A bare code that is no lot may be a rack label scanned too early.
        const rack = await resolveRow(raw).catch(() => null);
        refuse(rack
          ? `${rack.name} is a rack. Open a truck first (scan any sticker on it, or tap it below), then scan the rack.`
          : result.message || 'No lot with this sticker has been checked in yet.');
      } else {
        refuse(result.message || 'That sticker is not on any truck being received.');
      }
    } catch (err) {
      refuse(errorText(err, 'Could not look that sticker up'));
    }
  }, [scanInput, navigate, refuse]);

  return (
    <ScannerLayout
      title="Receiving"
      showBack
      onBack={() => navigate('/forklift')}
      headerExtra={(
        <NetworkStatus
          online={online}
          pendingCount={mine.filter((it) => it.state === 'pending').length}
          failedCount={mine.filter((it) => it.state === 'failed').length}
          syncing={syncing}
          lastSyncError={lastSyncError}
          onRetry={retry}
          onForceSync={drain}
        />
      )}
    >
      <div className="sir-list">
        <form onSubmit={handleScan} className="sir-form">
          <input
            ref={inputRef}
            type="text"
            value={scanInput}
            onChange={(e) => setScanInput(e.target.value)}
            placeholder="Scan any sticker to open its truck…"
            className="sir-input"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
          <button type="submit" className="sir-scan-btn" disabled={!scanInput.trim()}>
            <Scan size={22} />
          </button>
        </form>

        {notice && (
          <div className="sir-error" role="alert">
            <AlertTriangle size={16} /> {notice}
          </div>
        )}
        {loading && <p className="sir-muted">Loading…</p>}
        {error && <div className="sir-error"><AlertTriangle size={16} /> {error}</div>}

        {!loading && !error && trucks.length === 0 && walkIns.length === 0 && (
          <p className="sir-muted">
            Nothing to receive. A truck shows up here once the office has checked
            it in and printed its stickers.
          </p>
        )}

        {trucks.map((truck) => {
          const products = truck.lines.reduce((acc, line) => {
            const key = line.product_name || line.lot_code;
            if (!acc[key]) acc[key] = { lots: 0, scanned: 0, expected: 0, unit: line.count_unit };
            acc[key].lots += 1;
            acc[key].scanned += line.scanned_count;
            acc[key].expected += line.expected_count;
            return acc;
          }, {});
          return (
            <button
              key={truck.order_id}
              type="button"
              className="sir-card"
              onClick={() => navigate(`/forklift/lot-receiving/truck/${truck.order_id}`)}
            >
              <div className="sir-card-head">
                <span className="sir-card-number sir-truck-number"><Truck size={18} /> {truck.order_number}</span>
                <span className="sir-card-status">{truck.vendor_name || truck.origin_name || ''}</span>
              </div>
              <div className="sir-card-meta">
                {truck.bol ? `BOL ${truck.bol}` : 'No BOL'}
                {Object.entries(products).map(([name, p]) => (
                  <div key={name} className="sir-truck-product">
                    <span>{name}{p.lots > 1 ? ` (${p.lots} lots)` : ''}</span>
                    <strong>{p.scanned} of {unitCount(p.expected, p.unit)}</strong>
                  </div>
                ))}
              </div>
            </button>
          );
        })}

        {walkIns.length > 0 && <div className="sir-dialog-group">Walk-in receipts</div>}
        {walkIns.map((session) => (
          <button
            key={session.receipt_id}
            type="button"
            className="sir-card"
            onClick={() => navigate(`/forklift/lot-receiving/${session.receipt_id}`)}
          >
            <div className="sir-card-head">
              <span className="sir-card-number">{session.product_name || session.lot_code}</span>
              <span className="sir-card-status">Walk-in</span>
            </div>
            <div className="sir-card-meta">
              {session.vendor_lot ? `Lot ${session.vendor_lot}` : 'Lot unknown'}
              {' · sticker '}{session.lot_code}
              <br />
              <strong>{session.scanned_count} of {unitCount(session.expected_count, session.count_unit)}</strong>
            </div>
          </button>
        ))}
      </div>

      {choices && (
        <div className="sir-overlay" role="dialog" aria-modal="true">
          <div className="sir-dialog">
            <h3>Which truck?</h3>
            <p className="sir-dialog-hint">
              Lot {choices.lot_code} is on more than one truck being received.
            </p>
            <div className="sir-dialog-list">
              {choices.trucks.map((t) => (
                <button
                  key={t.order_id}
                  type="button"
                  className="sir-dialog-row"
                  onClick={() => navigate(`/forklift/lot-receiving/truck/${t.order_id}`)}
                >
                  <strong>{t.order_number}</strong>
                  <span>{t.vendor_name || ''}{t.bol ? ` · BOL ${t.bol}` : ''}</span>
                </button>
              ))}
            </div>
            <button type="button" className="sir-btn sir-btn--ghost" onClick={() => setChoices(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {feedback && (
        <ScanFeedback kind={feedback.kind} message={feedback.message} onDismiss={() => setFeedback(null)} />
      )}
    </ScannerLayout>
  );
};

// ─── Truck session ───────────────────────────────────────────────────────────

const TruckView = ({ orderId }) => {
  const navigate = useNavigate();
  const endpoint = useMemo(() => truckScanEndpoint(orderId), [orderId]);
  const endpointRef = useRef(endpoint);
  useEffect(() => { endpointRef.current = endpoint; }, [endpoint]);

  const [truck, setTruck] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // Sticky rack. Not persisted across a reload, and forgotten after 2 idle
  // minutes: a rack restored from memory is a guessed location, and with
  // identical stickers a wrong rack cannot be untangled afterwards.
  const [row, setRow] = useState(null);
  const rowRef = useRef(null);
  useEffect(() => { rowRef.current = row; }, [row]);
  const [rows, setRows] = useState([]);
  const rowsRef = useRef([]);
  useEffect(() => { rowsRef.current = rows; }, [rows]);
  const lastActivity = useRef(Date.now());

  const [history, setHistory] = useState([]);
  const [lastHit, setLastHit] = useState(null);
  const [scanInput, setScanInput] = useState('');
  const [manualKeyboard, setManualKeyboard] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [busy, setBusy] = useState(false);
  const scanInFlight = useRef(false);
  const doubleFire = useRef(createDoubleFireGuard(1000));
  // One-shot: the NEXT scan is a single loose bag on a pallet-stickered lot.
  const [single, setSingle] = useState(false);
  // "Loose units: [qty]" — N singles of one lot onto the rack in one step, for
  // a broken pallet. 30 loose bags were 30 tap-refocus-scan cycles (F12).
  const [loose, setLoose] = useState(null);
  // The loose entry in flight, so its N single bookings show as one "+N".
  const looseBatchRef = useRef(null);
  // A refusal the worker must acknowledge — an unknown sticker or a closed
  // truck. A list row alone was missed (F13).
  const [stop, setStop] = useState(null);

  // Parked scans waiting on the worker. Kept here because the queue forgets an
  // item the moment its 200 arrives, and a "please confirm" IS a 200.
  const [overConfirm, setOverConfirm] = useState([]);
  const [rowFull, setRowFull] = useState(null);

  const [rowPicker, setRowPicker] = useState(false);
  const [rowQuery, setRowQuery] = useState('');
  const [recount, setRecount] = useState(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [finishState, setFinishState] = useState(null);
  const [shortReason, setShortReason] = useState('');
  const [shortNote, setShortNote] = useState('');
  // Set when the last rack Finish asked for has been counted, so Finish carries
  // on by itself instead of making the worker press it a second time.
  const [resumeFinish, setResumeFinish] = useState(false);

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

  // ── Queue result handling ──────────────────────────────────────────────────
  const onScanSettled = useCallback((item, response, error) => {
    if (item.endpoint !== endpointRef.current) return;

    if (error) {
      if (!isTerminal(error)) return;
      removeScan(item.id);
      const message = errorText(error, 'Scan rejected');
      patchHistory(item.idempotency_key, { state: 'error', message });
      showError(message);
      return;
    }

    if (response.truck) setTruck(response.truck);
    const parked = { payload: item.payload, idempotencyKey: item.idempotency_key };

    if (response.status === 'needs_confirm_over') {
      patchHistory(item.idempotency_key, { state: 'confirm', message: response.message });
      setOverConfirm((prev) => (
        prev.some((p) => p.idempotencyKey === parked.idempotencyKey)
          ? prev
          : [...prev, {
            ...parked,
            message: response.message,
            units: response.units || item.payload?.est_units || 1,
            countUnit: response.count_unit,
          }]
      ));
      playErrorTone();
      return;
    }

    if (response.status === 'needs_confirm') {
      patchHistory(item.idempotency_key, { state: 'confirm', message: response.message });
      setRowFull((prev) => {
        const entry = {
          ...parked,
          rowId: response.row_id || item.payload?.storage_row_id,
          rowName: response.row_name || '',
        };
        if (!prev) {
          return {
            rowName: entry.rowName,
            question: response.message || '',
            detail: response.warning_detail || '',
            pending: [entry],
          };
        }
        if (prev.pending.some((p) => p.idempotencyKey === entry.idempotencyKey)) return prev;
        return { ...prev, pending: [...prev.pending, entry] };
      });
      playErrorTone();
      return;
    }

    if (response.status !== 'ok') {
      patchHistory(item.idempotency_key, { state: 'error', message: response.message });
      if (response.status === 'unknown_lot' || response.status === 'truck_closed') {
        playErrorTone();
        setStop({
          title: response.status === 'unknown_lot' ? 'Not expected on this truck' : 'This truck is finished',
          message: response.message,
        });
        return;
      }
      showError(response.message);
      return;
    }

    // The VENDOR's lot is what is printed big on the drum and what the worker
    // reads; our sticker code is a long machine string.
    const hitLine = (response.truck?.lines || []).find((l) => l.line_id === response.line_id);
    const lotLabel = hitLine?.vendor_lot ? `Lot ${hitLine.vendor_lot}` : response.lot_code;
    // One "Loose… 5" entry is five single bookings; the badge must say +5,
    // not the last +1 (re-check 2026-10-01).
    const batch = looseBatchRef.current;
    const inBatch = batch && batch.lineId === response.line_id && Number(response.units) === 1;
    if (inBatch) {
      batch.booked += 1;
      if (batch.booked >= batch.total) looseBatchRef.current = null;
    }
    const unitWord = response.count_unit || hitLine?.unit_label;
    const hit = {
      lineId: response.line_id,
      text: `${lotLabel} → ${response.row_name}`,
      count: `${response.line_scanned_count} of ${response.line_expected_count}`,
      product: response.product_name,
      badge: inBatch
        ? { text: `+${unitCount(batch.booked, unitWord)} · loose`, pallet: false }
        : scanUnitsBadge(response.units, unitWord),
    };
    setLastHit(hit);
    patchHistory(item.idempotency_key, {
      state: response.flag ? 'duplicate' : 'ok',
      message: response.message,
      label: lotLabel,
      rowName: response.row_name,
      count: response.row_line_count,
      units: response.units,
      unit: response.count_unit || hitLine?.unit_label,
    });
    if (response.flag) {
      playSuccessTone();
      showInfo(`${response.message} — flagged for the office.`);
    } else {
      showSuccess(`${response.message} (${hit.count})`);
    }
  }, [patchHistory, showError, showInfo, showSuccess]);

  const {
    online, queue, send, drain, retry, syncing, lastSyncError,
  } = useLotScanQueue(onScanSettled);

  const myItems = useMemo(() => queue.filter((it) => it.endpoint === endpoint), [queue, endpoint]);
  const pendingItems = useMemo(() => myItems.filter((it) => it.state === 'pending'), [myItems]);
  const failedCount = useMemo(() => myItems.filter((it) => it.state === 'failed').length, [myItems]);

  // Optimistic overlay: a queued scan's lot is known from its sticker, so it
  // can be shown against its line before the server answers.
  const lines = useMemo(() => {
    const base = truck?.lines || [];
    return base.map((line) => {
      const pendingUnits = pendingItems
        .filter((it) => sameCode(it.payload?.lot_code_resolved, line.lot_code))
        .reduce((n, it) => n + (Number(it.payload?.est_units) || 1), 0);
      return { ...line, shown: line.scanned_count + pendingUnits };
    });
  }, [truck, pendingItems]);
  const palletLines = useMemo(() => lines.filter((l) => (l.units_per_pallet || 0) > 1), [lines]);
  const hasPalletised = palletLines.length > 0;
  // The truck's own words: a truck of bags and boxes is never told about drums.
  const words = useMemo(() => truckUnitWords(lines), [lines]);
  const mismatch = lineMismatchNote(lines, { countKey: 'shown' });

  // ── Load ───────────────────────────────────────────────────────────────────
  const loadTruck = useCallback(() => {
    setLoading(true);
    return getTruck(orderId)
      .then((data) => { setTruck(data); setLoadError(''); })
      .catch((err) => setLoadError(errorText(err, 'Could not load this truck')))
      .finally(() => setLoading(false));
  }, [orderId]);
  useEffect(() => { loadTruck(); }, [loadTruck]);

  useEffect(() => {
    let cancelled = false;
    listIngredientRows()
      .then((data) => { if (!cancelled) setRows(Array.isArray(data) ? data : []); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, []);

  // ── Rack forgets itself after 2 idle minutes ───────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      if (rowRef.current && Date.now() - lastActivity.current > RACK_IDLE_MS) {
        setRow(null);
        showInfo('Rack cleared after 2 minutes idle — scan the rack you are at.');
      }
    }, 15000);
    return () => clearInterval(id);
  }, [showInfo]);

  const finishAsking = finishState?.status === 'needs_confirm' || finishState?.status === 'needs_reason';
  const dialogOpen = !!(rowPicker || recount || removeOpen || overConfirm.length
    || finishAsking || loose || stop);

  // ── Keyboard-wedge focus ───────────────────────────────────────────────────
  useEffect(() => {
    if (manualKeyboard || dialogOpen) return undefined;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [manualKeyboard, dialogOpen, feedback, row, loading, single]);
  useScanFocusKeeper(inputRef, !manualKeyboard && !dialogOpen);

  // ── Recount ────────────────────────────────────────────────────────────────
  const openRecount = useCallback((rowId, summary = truck) => {
    const items = (summary?.pending_recounts || []).filter((p) => p.storage_row_id === rowId);
    if (!items.length) return false;
    setRecount({
      rowId,
      rowName: items[0].storage_row_name,
      items: items.map((p) => ({ ...p, actual: String(p.scanned), agreed: null })),
    });
    return true;
  }, [truck]);

  const nextRecount = useCallback((summary) => {
    const first = summary?.pending_recounts?.[0];
    if (first) openRecount(first.storage_row_id, summary);
    else setRecount(null);
  }, [openRecount]);

  // ── Rack context ───────────────────────────────────────────────────────────
  const adoptRow = useCallback((resolved) => {
    const previous = rowRef.current;
    lastActivity.current = Date.now();
    setRow(resolved);
    setRows((prev) => (prev.some((r) => r.id === resolved.id) ? prev : [...prev, resolved]));
    setRowFull(null);
    setRowPicker(false);
    showSuccess(`→ ${resolved.name}`);
    // Leaving a rack: count it now, while standing in front of it.
    if (previous && previous.id !== resolved.id) {
      const waiting = pendingItems.some((it) => it.payload?.storage_row_id === previous.id);
      if (waiting) {
        showInfo(`Scans for ${previous.name} are still syncing — you will be asked to count it at Finish.`);
      } else {
        openRecount(previous.id);
      }
    }
  }, [showSuccess, showInfo, pendingItems, openRecount]);

  const resolveRowCode = useCallback(async (code) => {
    if (!online) {
      const upper = code.toUpperCase();
      const hit = rowsRef.current.find((r) => (r.barcode || '').toUpperCase() === upper);
      return { row: hit || null, error: null };
    }
    try {
      return { row: await resolveRow(code), error: null };
    } catch (err) {
      const status = err?.response?.status;
      if (status === 404) return { row: null, error: null };
      if (!err?.response) return { row: null, error: null };
      return { row: null, error: errorText(err, 'Could not resolve that rack') };
    }
  }, [online]);

  // A scan that is NOT put away still gets a row in Recent scans. A refusal
  // shown only as a 2-second flash read as "the gun ignored me" (F7b).
  const logRefusal = useCallback((label, message) => {
    showError(message);
    setHistory((prev) => [
      { key: newIdempotencyKey(), label, rowName: '—', state: 'error', message },
      ...prev,
    ].slice(0, HISTORY_LIMIT));
  }, [showError]);

  // ── Unit scan ──────────────────────────────────────────────────────────────
  // `forceSingle` books one loose unit whatever the toggle says (loose entry).
  const recordDrum = useCallback((lotCode, { forceSingle = false } = {}) => {
    const target = rowRef.current;
    const line = (truck?.lines || []).find((l) => sameCode(l.lot_code, lotCode));
    const label = line?.vendor_lot ? `Lot ${line.vendor_lot}` : lotCode;
    if (!target) {
      logRefusal(label, `Not put away — scan the rack first. A ${words.one} is never placed by guess.`);
      return null;
    }
    lastActivity.current = Date.now();
    const isSingle = forceSingle || single;
    const estUnits = isSingle ? 1 : Math.max(1, Number(line?.units_per_pallet) || 1);
    const payload = {
      lot_code: lotCode,
      storage_row_id: target.id,
      // Display-only hints for the optimistic overlay; the server ignores them.
      lot_code_resolved: lotCode,
      est_units: estUnits,
    };
    if (isSingle) payload.single = true;
    if (!forceSingle) setSingle(false);
    const item = send(orderId, endpoint, payload);
    setHistory((prev) => [
      {
        key: item.idempotency_key,
        label,
        rowName: target.name,
        units: estUnits,
        unit: line?.unit_label,
        state: 'pending',
        message: 'Queued',
      },
      ...prev.filter((h) => h.key !== item.idempotency_key),
    ].slice(0, HISTORY_LIMIT));
    return item;
  }, [truck, single, send, orderId, endpoint, logRefusal, words.one]);

  // Replays a parked scan with the worker's answer on it, under the SAME key.
  const resend = useCallback((parked, extra) => {
    send(orderId, endpoint, { ...parked.payload, ...extra }, parked.idempotencyKey);
    setHistory((prev) => prev.map((h) => (
      h.key === parked.idempotencyKey ? { ...h, state: 'pending', message: 'Queued' } : h
    )));
  }, [send, orderId, endpoint]);

  const handleScanSubmit = useCallback(async (e) => {
    e?.preventDefault?.();
    const raw = scanInput.trim();
    setScanInput('');
    if (!raw) return;
    if (doubleFire.current(raw)) return;   // trigger bounce, not a second drum
    if (scanInFlight.current) {
      showError(`Still resolving the last rack — scan that ${words.one} again.`);
      return;
    }

    const decoded = decodeLotPayload(raw);
    if (decoded && !decoded.bare) {
      recordDrum(decoded.lotCode);
      return;
    }
    if (!decoded) {
      showError('Unreadable sticker — scan the 2D code or key the lot code.');
      return;
    }

    scanInFlight.current = true;
    setBusy(true);
    try {
      const { row: found, error } = await resolveRowCode(raw);
      if (found) { adoptRow(found); return; }
      if (error) { showError(error); return; }
      if (!rowRef.current) {
        logRefusal(raw, `Not a known rack — scan the rack first, then any ${words.one}.`);
        return;
      }
      recordDrum(raw);
    } finally {
      scanInFlight.current = false;
      setBusy(false);
    }
  }, [scanInput, recordDrum, resolveRowCode, adoptRow, showError, logRefusal, words.one]);

  // ── Confirms ───────────────────────────────────────────────────────────────
  const answerOver = useCallback((yes, { all = false } = {}) => {
    const [first, ...rest] = overConfirm;
    if (!first) return;
    // "All" answers every waiting scan the same way — loose units booked in one
    // step can park several at once.
    (all ? overConfirm : [first]).forEach((parked) => {
      if (yes) resend(parked, { confirm_over: true });
      else patchHistory(parked.idempotencyKey, { state: 'error', message: 'Not put away — you said no.' });
    });
    setOverConfirm(all ? [] : rest);
  }, [overConfirm, resend, patchHistory]);

  // ── Loose units ────────────────────────────────────────────────────────────
  const openLoose = useCallback(() => {
    if (!rowRef.current) {
      logRefusal('Loose units', `Not booked — scan the rack first. A ${words.one} is never placed by guess.`);
      return;
    }
    const preferred = palletLines.find((l) => l.line_id === lastHit?.lineId) || palletLines[0];
    setLoose({ lineId: preferred?.line_id || '', qty: '', error: '' });
  }, [palletLines, lastHit, logRefusal, words.one]);

  const bookLoose = useCallback(() => {
    if (!loose) return;
    const line = palletLines.find((l) => l.line_id === loose.lineId);
    const { qty, error } = parseLooseQty(loose.qty);
    if (!line) { setLoose((prev) => ({ ...prev, error: 'Pick the lot.' })); return; }
    if (error) { setLoose((prev) => ({ ...prev, error })); return; }
    // N separate single scans, each under its own idempotency key: a lost
    // response replays one bag, never the batch.
    looseBatchRef.current = { lineId: line.line_id, total: qty, booked: 0 };
    for (let i = 0; i < qty; i += 1) {
      if (!recordDrum(line.lot_code, { forceSingle: true })) break;
    }
    setLoose(null);
    showInfo(`${unitCount(qty, line.unit_label)} of lot ${line.vendor_lot || line.lot_code} queued as loose.`);
  }, [loose, palletLines, recordDrum, showInfo]);

  const confirmOverfill = useCallback(() => {
    (rowFull?.pending || []).forEach((p) => resend(p, { allow_overfill: true }));
    setRowFull(null);
  }, [rowFull, resend]);

  // ── Recount submit ─────────────────────────────────────────────────────────
  const submitRecount = useCallback(async ({ confirmed = false } = {}) => {
    if (!recount) return;
    const counts = recount.items.map((item) => ({
      line_id: item.line_id,
      actual: Math.max(0, parseInt(item.agreed === true ? item.scanned : item.actual, 10) || 0),
    }));
    // The count wins on the server, so a typo silently took stock off the
    // rack (F11). A count that disagrees with the scans is read back first.
    const questions = recount.items
      .map((item, i) => {
        const q = describeRecountDiff({
          scanned: item.scanned, actual: counts[i].actual, unitLabel: item.count_unit,
        });
        // Several lots on one rack: say which one each question is about.
        return q && recount.items.length > 1 ? `Lot ${item.vendor_lot || item.lot_code}: ${q}` : q;
      })
      .filter(Boolean);
    if (questions.length && !confirmed) {
      setRecount((prev) => ({ ...prev, confirming: questions }));
      return;
    }
    setBusy(true);
    try {
      const result = await truckRecount(orderId, { storage_row_id: recount.rowId, counts });
      setTruck(result.truck);
      // A corrected count makes the last "→ rack (n of m)" banner a lie.
      setLastHit(null);
      if (result.status === 'corrected') showInfo(result.message);
      else showSuccess(result.message);
      // At Finish, walk straight on to the next uncounted rack, then finish.
      if (finishState?.status === 'needs_recount') {
        if (result.truck.pending_recounts.length) nextRecount(result.truck);
        else { setRecount(null); setFinishState(null); setResumeFinish(true); }
      } else {
        setRecount(null);
      }
    } catch (err) {
      showError(errorText(err, 'Could not save the count'));
    } finally {
      setBusy(false);
    }
  }, [recount, orderId, finishState, nextRecount, showError, showInfo, showSuccess]);

  // ── Remove ─────────────────────────────────────────────────────────────────
  const removeOne = useCallback(async (line, rowId, rowName, { single: oneLoose = false } = {}) => {
    if (pendingItems.length) {
      showError('Wait for queued scans to sync first.');
      return;
    }
    setBusy(true);
    try {
      const result = await truckRemove(orderId, {
        line_id: line.line_id,
        storage_row_id: rowId,
        idempotency_key: newIdempotencyKey(),
        single: oneLoose,
      });
      setTruck(result.truck);
      setLastHit(null);
      if (result.status === 'removed') {
        showSuccess(result.message);
        setHistory((prev) => [{
          key: newIdempotencyKey(),
          label: `−${unitCount(result.units, line.unit_label)} · Lot ${line.vendor_lot || line.lot_code}`,
          rowName,
          state: 'ok',
          message: result.message,
        }, ...prev].slice(0, HISTORY_LIMIT));
      } else {
        showError(result.message);
      }
    } catch (err) {
      showError(errorText(err, 'Could not remove that'));
    } finally {
      setBusy(false);
    }
  }, [orderId, pendingItems.length, showError, showSuccess]);

  // ── Finish ─────────────────────────────────────────────────────────────────
  const handleFinish = useCallback(async ({ confirmed = false, withReason = false } = {}) => {
    if (pendingItems.length) {
      showError('Wait for queued scans to sync before finishing.');
      return;
    }
    if (overConfirm.length || rowFull) {
      showError('Answer the waiting questions first.');
      return;
    }
    setBusy(true);
    try {
      const result = await truckFinish(orderId, {
        confirmed,
        short_reason: withReason ? shortReason : undefined,
        short_note: withReason ? shortNote : undefined,
      });
      setTruck(result.truck);
      if (result.status === 'submitted' || result.status === 'already_submitted') {
        setFinishState(null);
        showSuccess(result.message);
        navigate('/forklift/lot-receiving');
        return;
      }
      setFinishState(result);
      if (result.status === 'needs_recount') nextRecount(result.truck);
    } catch (err) {
      showError(errorText(err, 'Could not finish this truck'));
    } finally {
      setBusy(false);
    }
  }, [orderId, pendingItems.length, overConfirm.length, rowFull, shortReason, shortNote,
    navigate, nextRecount, showError, showSuccess]);

  useEffect(() => {
    if (!resumeFinish) return;
    setResumeFinish(false);
    handleFinish();
  }, [resumeFinish, handleFinish]);

  // ── Rack picker ────────────────────────────────────────────────────────────
  const rackGroups = useMemo(() => {
    const q = rowQuery.trim().toLowerCase();
    const matches = q
      ? rows.filter((r) => `${r.name} ${r.path || ''} ${r.barcode || ''}`.toLowerCase().includes(q))
      : rows;
    const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true });
    return [
      { key: 'units', label: 'Drum and bag rooms', rows: matches.filter((r) => r.storage_unit).sort(byName).slice(0, 60) },
      { key: 'other', label: 'Everywhere else', rows: matches.filter((r) => !r.storage_unit).sort(byName).slice(0, 60) },
    ].filter((g) => g.rows.length > 0);
  }, [rows, rowQuery]);

  const scannedPlaces = useMemo(() => lines.flatMap((line) => (
    (line.rows || []).filter((r) => r.count > 0).map((r) => ({ line, row: r }))
  )), [lines]);

  // No "Loading…" screen in place of the scan box: a scan fired while the
  // truck loads must land somewhere visible (F7a).
  if (loadError && !truck) {
    return (
      <ScannerLayout title="Receiving" showBack onBack={() => navigate('/forklift/lot-receiving')}>
        <div className="sir-error"><AlertTriangle size={16} /> {loadError}</div>
      </ScannerLayout>
    );
  }

  const historyIcon = (entry) => {
    if (entry.state === 'pending') return <Clock size={16} color="#b45309" />;
    if (entry.state === 'error') return <X size={16} color="#dc2626" />;
    if (entry.state === 'confirm' || entry.state === 'duplicate') return <AlertTriangle size={16} color="#b45309" />;
    return <Check size={16} color="#16a34a" />;
  };
  const closed = !!truck?.forklift_submitted_at;
  const pendingRecountRows = new Set((truck?.pending_recounts || []).map((p) => p.storage_row_id));

  return (
    <ScannerLayout
      title={truck?.order_number || 'Truck'}
      showBack
      onBack={() => navigate('/forklift/lot-receiving')}
      headerExtra={(
        <NetworkStatus
          online={online}
          pendingCount={pendingItems.length}
          failedCount={failedCount}
          syncing={syncing}
          lastSyncError={lastSyncError}
          onRetry={retry}
          onForceSync={drain}
        />
      )}
    >
      <div className="sir-session">
        <div className="sir-meta">
          <span>{truck?.vendor_name || truck?.origin_name || ''}</span>
          {truck?.bol && <><span className="sir-meta-sep">·</span><span>BOL {truck.bol}</span></>}
          <span className="sir-meta-sep">·</span>
          <span>{formatUnitTotals(truck?.totals)}</span>
          {/* The total can hide lot A over and lot B short (F15). */}
          {mismatch && <span className="sir-truck-mismatch">· {mismatch}</span>}
        </div>

        {loading && !truck && <p className="sir-muted">Loading truck…</p>}

        {closed && (
          <div className="sir-error"><AlertTriangle size={16} /> This truck is finished. See the office to change it.</div>
        )}

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
              <span className="sir-rowbanner-path">No location set — {words.many} are blocked</span>
            </div>
          )}
          <button type="button" className="sir-rowbanner-btn" onClick={() => setRowPicker(true)}>
            {row ? 'Change' : 'Pick rack'}
          </button>
        </div>

        {rowFull && (
          <div className="sir-warn">
            <AlertTriangle size={18} />
            <div>
              <strong>{rowFull.question || `${rowFull.rowName || 'This rack'} is at its capacity — load past it?`}</strong>
              <div className="sir-warn-detail">
                {rowFull.pending.length > 1
                  ? `${rowFull.pending.length} scans are waiting on your answer.`
                  : (rowFull.detail || 'Load into it anyway, or scan a different rack.')}
              </div>
              <div className="sir-warn-actions">
                <button type="button" className="sir-btn sir-btn--warn" onClick={confirmOverfill}>
                  {rowFull.pending.length > 1 ? `Load all ${rowFull.pending.length} here anyway` : 'Load it here anyway'}
                </button>
                <button
                  type="button"
                  className="sir-btn sir-btn--ghost"
                  onClick={() => { setRowFull(null); setRowPicker(true); }}
                >
                  Pick another rack
                </button>
              </div>
            </div>
          </div>
        )}

        <form onSubmit={handleScanSubmit} className="sir-form">
          <input
            ref={inputRef}
            type="text"
            value={scanInput}
            onChange={(e) => setScanInput(e.target.value)}
            placeholder={row ? `Scan any ${words.one} (or a new rack)…` : 'Scan the rack barcode…'}
            className="sir-input"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            disabled={closed}
          />
          {/* NOT disabled while busy — a disabled default button stops Enter submitting. */}
          <button type="submit" className="sir-scan-btn" disabled={!scanInput.trim()}>
            {busy ? '…' : <Scan size={22} />}
          </button>
        </form>
        <button type="button" className="sir-link" onClick={() => setManualKeyboard((v) => !v)}>
          <Keyboard size={14} /> {manualKeyboard ? 'Hide keyboard (use scanner)' : 'Type manually'}
        </button>

        {hasPalletised && (
          <div className="sir-perscan">
            <span className="sir-perscan-label">Next pallet sticker</span>
            <div className="sir-perscan-opts">
              {/* onMouseDown preventDefault: a tap must not take focus off the
                  scan box, or the next trigger pull goes nowhere (F12). */}
              <button
                type="button"
                className={`sir-perscan-btn${single ? '' : ' is-on'}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setSingle(false)}
              >
                <strong>Pallet</strong>
                <span>whole pallet</span>
              </button>
              <button
                type="button"
                className={`sir-perscan-btn${single ? ' is-on' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setSingle((v) => !v)}
              >
                <strong>1</strong>
                <span>one loose {words.one}</span>
              </button>
            </div>
            <button
              type="button"
              className="sir-btn sir-btn--ghost sir-loose-btn"
              onClick={openLoose}
              disabled={closed}
            >
              Loose…
            </button>
          </div>
        )}

        {lastHit && (
          <div className={`sir-truck-lasthit${lastHit.badge?.pallet ? ' is-pallet' : ''}`}>
            <Check size={22} />
            <div>
              <span className={`sir-units-badge${lastHit.badge?.pallet ? ' sir-units-badge--pallet' : ''}`}>
                {lastHit.badge?.text}
              </span>
              <strong>{lastHit.text}</strong>
              <span>{lastHit.product} · {lastHit.count}</span>
            </div>
          </div>
        )}

        <div className="sir-truck-lines">
          {lines.map((line) => {
            const done = line.expected_count > 0 && line.shown >= line.expected_count;
            const over = line.shown > line.expected_count;
            return (
              <div
                key={line.line_id}
                className={[
                  'sir-truck-line',
                  lastHit?.lineId === line.line_id ? 'is-hit' : '',
                  done ? 'is-done' : '',
                  over ? 'is-over' : '',
                ].join(' ')}
              >
                <div className="sir-truck-line-main">
                  <strong>{line.product_name}</strong>
                  <span>
                    Lot {line.vendor_lot || '—'} · sticker {line.lot_code}
                    {line.expected_count === 0 && ' · NOT ON PAPERWORK'}
                    {line.is_held && ' · ON HOLD'}
                  </span>
                  {(line.units_per_pallet || 0) > 1 && (
                    <span className={`sir-truck-perscan${single ? ' is-single' : ''}`}>
                      {single
                        ? `Next scan = 1 ${singularUnit(line.unit_label || line.count_unit)}`
                        : `1 scan = ${unitCount(line.units_per_pallet, line.unit_label || line.count_unit)}`}
                    </span>
                  )}
                </div>
                <div className="sir-truck-line-count">
                  <strong>{line.shown}</strong>
                  <span>of {line.expected_count} {line.count_unit}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="sir-history">
          <div className="sir-history-head">
            <h3>Recent scans</h3>
            {pendingItems.length > 0 && <span className="sir-history-pending">{pendingItems.length} queued</span>}
          </div>
          {history.length === 0 ? (
            <p className="sir-muted">Scan the rack, then any {words.one} you put in it — in any order.</p>
          ) : history.map((entry) => (
            <div key={entry.key} className={`sir-history-item sir-history-item--${entry.state}`}>
              {historyIcon(entry)}
              <div className="sir-history-body">
                <span className="sir-history-serial">
                  {entry.units > 0 && entry.state !== 'error' && (() => {
                    const badge = scanUnitsBadge(entry.units, entry.unit);
                    return (
                      <span className={`sir-units-badge${badge.pallet ? ' sir-units-badge--pallet' : ''}`}>
                        {badge.text}
                      </span>
                    );
                  })()}
                  {entry.label}
                  {entry.count != null ? ` · ${entry.count} in rack` : ''}
                </span>
                {entry.state !== 'ok' && entry.message && <span className="sir-history-msg">{entry.message}</span>}
              </div>
              <span className="sir-history-row">{entry.rowName}</span>
            </div>
          ))}
        </div>

        <div className="sir-actions">
          <button
            type="button"
            className="sir-btn sir-btn--ghost"
            onClick={() => setRemoveOpen(true)}
            disabled={busy || closed || scannedPlaces.length === 0}
          >
            <Minus size={16} /> Remove a scan
          </button>
          {row && pendingRecountRows.has(row.id) && (
            <button
              type="button"
              className="sir-btn sir-btn--ghost"
              onClick={() => openRecount(row.id)}
              disabled={busy || closed}
            >
              Count {row.name}
            </button>
          )}
        </div>

        {finishState?.status === 'needs_confirm' && (
          <div className="sir-overlay" role="dialog" aria-modal="true">
            <div className="sir-dialog sir-dialog--tall">
              <AlertTriangle size={36} color="#b45309" />
              <h3>The counts do not match the paperwork</h3>
              <ul className="sir-truck-difflist">
                {finishState.lines.map((l) => (
                  <li key={l.line_id}>
                    Lot {l.vendor_lot || l.lot_code} · {l.product_name}: {l.scanned_count} of
                    {' '}{unitCount(l.expected_count, l.unit_label || l.count_unit)}
                    {' '}({l.difference > 0 ? `+${l.difference}` : l.difference})
                  </li>
                ))}
              </ul>
              <div className="sir-warn-actions">
                <button type="button" className="sir-btn sir-btn--warn" onClick={() => handleFinish({ confirmed: true })} disabled={busy}>
                  Yes, finish the truck
                </button>
                <button type="button" className="sir-btn sir-btn--ghost" onClick={() => setFinishState(null)}>
                  Keep scanning
                </button>
              </div>
            </div>
          </div>
        )}

        {finishState?.status === 'needs_reason' && (
          <div className="sir-overlay" role="dialog" aria-modal="true">
            <div className="sir-dialog sir-dialog--tall">
              <AlertTriangle size={36} color="#b45309" />
              <h3>This truck is short. Why?</h3>
              <div className="sir-truck-reasons">
                {SHORT_REASONS.map((r) => (
                  <button
                    key={r.value}
                    type="button"
                    className={`sir-btn ${shortReason === r.value ? 'sir-btn--warn' : 'sir-btn--ghost'}`}
                    onClick={() => setShortReason(r.value)}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              {shortReason === 'other' && (
                <input
                  type="text"
                  className="sir-dialog-input"
                  value={shortNote}
                  onChange={(e) => setShortNote(e.target.value)}
                  placeholder="What happened?"
                />
              )}
              <div className="sir-warn-actions">
                <button
                  type="button"
                  className="sir-btn sir-btn--warn"
                  disabled={busy || !shortReason || (shortReason === 'other' && !shortNote.trim())}
                  onClick={() => handleFinish({ confirmed: true, withReason: true })}
                >
                  Finish short
                </button>
                <button type="button" className="sir-btn sir-btn--ghost" onClick={() => setFinishState(null)}>
                  Keep scanning
                </button>
              </div>
            </div>
          </div>
        )}

        {finishState?.status === 'not_checked_in' && (
          <div className="sir-error"><AlertTriangle size={16} /> {finishState.message}</div>
        )}

        <button
          type="button"
          className="sir-submit"
          onClick={() => handleFinish()}
          disabled={busy || closed || pendingItems.length > 0}
        >
          Finish truck
        </button>

        <button type="button" className="sir-link" onClick={() => navigate('/forklift/lot-receiving')}>
          Leave for now — keep this truck open
        </button>
        <p className="sir-muted sir-fineprint">
          Everything scanned is already in stock. Finishing takes the truck off the
          gun; the office checks it against the paperwork afterwards.
        </p>
      </div>

      {overConfirm.length > 0 && (
        <div className="sir-overlay" role="dialog" aria-modal="true">
          <div className="sir-dialog">
            <AlertTriangle size={36} color="#b45309" />
            <h3>{overScanTitle(overConfirm[0])}</h3>
            <p className="sir-dialog-hint sir-truck-question">{overConfirm[0].message}</p>
            {overConfirm.length > 1 && (
              <p className="sir-muted">{overConfirm.length - 1} more waiting after this one.</p>
            )}
            <button type="button" className="sir-btn sir-btn--warn" onClick={() => answerOver(true)}>
              {overConfirm[0].units > 1
                ? `Yes, put away ${unitCount(overConfirm[0].units, overConfirm[0].countUnit)}`
                : 'Yes, put it away'}
            </button>
            <button type="button" className="sir-btn sir-btn--ghost" onClick={() => answerOver(false)}>
              No — that was a mistake
            </button>
            {overConfirm.length > 1 && (
              <>
                <button type="button" className="sir-btn sir-btn--warn" onClick={() => answerOver(true, { all: true })}>
                  Yes to all {overConfirm.length}
                </button>
                <button type="button" className="sir-btn sir-btn--ghost" onClick={() => answerOver(false, { all: true })}>
                  No to all {overConfirm.length}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {recount && recount.confirming && !overConfirm.length && (
        <div className="sir-overlay" role="dialog" aria-modal="true">
          <div className="sir-dialog">
            <AlertTriangle size={36} color="#b45309" />
            <h3>Check {recount.rowName} again</h3>
            {recount.confirming.map((q, i) => (
              <p key={i} className="sir-dialog-hint sir-truck-question">{q}</p>
            ))}
            <p className="sir-muted">Your count replaces what was scanned, and the office sees the difference.</p>
            <button
              type="button"
              className="sir-btn sir-btn--warn"
              disabled={busy}
              onClick={() => submitRecount({ confirmed: true })}
            >
              Confirm my count
            </button>
            <button
              type="button"
              className="sir-btn sir-btn--ghost"
              onClick={() => setRecount((prev) => ({ ...prev, confirming: null }))}
            >
              Recount
            </button>
          </div>
        </div>
      )}

      {recount && !recount.confirming && !overConfirm.length && (
        <div className="sir-overlay" role="dialog" aria-modal="true">
          <div className="sir-dialog sir-dialog--tall">
            <h3>Count {recount.rowName}</h3>
            <p className="sir-dialog-hint">
              Look at the rack and count what this truck put there. Your count wins.
            </p>
            <div className="sir-dialog-list">
              {recount.items.map((item, idx) => (
                <div key={item.line_id} className="sir-truck-recount">
                  <strong>{item.product_name}</strong>
                  <span>Lot {item.vendor_lot || '—'} · sticker {item.lot_code}</span>
                  <span className="sir-truck-recount-q">
                    Scanned <b>{unitCount(item.scanned, item.count_unit)}</b> here. Is that right?
                  </span>
                  <div className="sir-warn-actions">
                    <button
                      type="button"
                      className={`sir-btn ${item.agreed === true ? 'sir-btn--warn' : 'sir-btn--ghost'}`}
                      onClick={() => setRecount((prev) => ({
                        ...prev,
                        items: prev.items.map((x, i) => (i === idx ? { ...x, agreed: true } : x)),
                      }))}
                    >
                      Yes, {item.scanned}
                    </button>
                    <button
                      type="button"
                      className={`sir-btn ${item.agreed === false ? 'sir-btn--warn' : 'sir-btn--ghost'}`}
                      onClick={() => setRecount((prev) => ({
                        ...prev,
                        items: prev.items.map((x, i) => (i === idx ? { ...x, agreed: false } : x)),
                      }))}
                    >
                      No
                    </button>
                  </div>
                  {item.agreed === false && (
                    <input
                      type="number"
                      inputMode="numeric"
                      min="0"
                      className="sir-dialog-input"
                      value={item.actual}
                      onChange={(e) => setRecount((prev) => ({
                        ...prev,
                        items: prev.items.map((x, i) => (i === idx ? { ...x, actual: e.target.value } : x)),
                      }))}
                      placeholder="How many are really there?"
                    />
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              className="sir-btn sir-btn--warn"
              disabled={busy || recount.items.some((x) => x.agreed === null || (x.agreed === false && x.actual === ''))}
              onClick={() => submitRecount()}
            >
              Save count
            </button>
            <button
              type="button"
              className="sir-btn sir-btn--ghost"
              onClick={() => { setRecount(null); if (finishState?.status === 'needs_recount') setFinishState(null); }}
            >
              Later
            </button>
          </div>
        </div>
      )}

      {removeOpen && (
        <div className="sir-overlay" role="dialog" aria-modal="true">
          <div className="sir-dialog sir-dialog--tall">
            <h3>Remove a scan</h3>
            <p className="sir-dialog-hint">
              Pick the lot and rack you scanned by mistake. One tap takes one scan off.
            </p>
            <div className="sir-dialog-list">
              {scannedPlaces.map(({ line, row: r }) => {
                const unit = line.unit_label || line.count_unit || 'unit';
                // A pallet can only come off a rack that could hold a whole one:
                // 4 loose boxes offered "−4 boxes (pallet)" (re-check 2026-10-01).
                const fullPallet = Number(line.units_per_pallet) || 1;
                const perPallet = r.count >= fullPallet ? fullPallet : 1;
                const lotName = `Lot ${line.vendor_lot || line.lot_code}`;
                const detail = `${line.product_name} · sticker ${line.lot_code} · ${unitCount(r.count, unit)} there now`;
                return (
                  <React.Fragment key={`${line.line_id}-${r.storage_row_id}`}>
                    <button
                      type="button"
                      className="sir-dialog-row"
                      disabled={busy}
                      onClick={() => removeOne(line, r.storage_row_id, r.storage_row_name)}
                    >
                      <strong>
                        −{perPallet > 1 ? `${unitCount(perPallet, unit)} (pallet)` : 1} · {lotName} @ {r.storage_row_name}
                      </strong>
                      <span>{detail}</span>
                    </button>
                    {perPallet > 1 && (
                      <button
                        type="button"
                        className="sir-dialog-row"
                        disabled={busy}
                        onClick={() => removeOne(line, r.storage_row_id, r.storage_row_name, { single: true })}
                      >
                        <strong>−1 loose {singularUnit(unit)} · {lotName} @ {r.storage_row_name}</strong>
                        <span>{detail}</span>
                      </button>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
            <button type="button" className="sir-btn sir-btn--ghost" onClick={() => setRemoveOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}

      {loose && (
        <div className="sir-overlay" role="dialog" aria-modal="true">
          <div className="sir-dialog sir-dialog--tall">
            <h3>Loose units onto {row?.name || 'this rack'}</h3>
            <p className="sir-dialog-hint">
              For a broken pallet: each one is booked as a single loose unit of the lot you pick.
            </p>
            <div className="sir-dialog-list">
              {palletLines.map((line) => (
                <button
                  key={line.line_id}
                  type="button"
                  className={`sir-dialog-row${loose.lineId === line.line_id ? ' is-selected' : ''}`}
                  onClick={() => setLoose((prev) => ({ ...prev, lineId: line.line_id, error: '' }))}
                >
                  <strong>Lot {line.vendor_lot || line.lot_code}</strong>
                  <span>{line.product_name} · {pluralizeUnit(singularUnit(line.unit_label || line.count_unit))}</span>
                </button>
              ))}
            </div>
            <input
              type="number"
              inputMode="numeric"
              min="1"
              className="sir-dialog-input"
              value={loose.qty}
              onChange={(e) => setLoose((prev) => ({ ...prev, qty: e.target.value, error: '' }))}
              onKeyDown={(e) => { if (e.key === 'Enter') bookLoose(); }}
              placeholder="How many loose?"
              autoFocus
            />
            {loose.error && <div className="sir-error"><AlertTriangle size={16} /> {loose.error}</div>}
            <button type="button" className="sir-btn sir-btn--warn" onClick={bookLoose} disabled={busy}>
              {(() => {
                const line = palletLines.find((l) => l.line_id === loose.lineId);
                const { qty } = parseLooseQty(loose.qty);
                return qty && line
                  ? `Book ${unitCount(qty, line.unit_label || line.count_unit)} loose`
                  : 'Book loose';
              })()}
            </button>
            <button type="button" className="sir-btn sir-btn--ghost" onClick={() => setLoose(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {stop && (
        <div className="sir-overlay" role="dialog" aria-modal="true">
          <div className="sir-dialog">
            <X size={36} color="#dc2626" />
            <h3>{stop.title}</h3>
            <p className="sir-dialog-hint sir-truck-question">{stop.message}</p>
            {/* No autoFocus: the next scan's Enter must not dismiss this unread. */}
            <button type="button" className="sir-btn sir-btn--warn" onClick={() => setStop(null)}>
              OK — nothing was put away
            </button>
          </div>
        </div>
      )}

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
                  {rackGroups.length > 1 && <div className="sir-dialog-group">{group.label}</div>}
                  {group.rows.map((r) => (
                    <button key={r.id} type="button" className="sir-dialog-row" onClick={() => adoptRow(r)}>
                      <strong>{r.name}</strong>
                      <span>
                        {r.path || ''}
                        {r.storage_unit ? ` · ${r.unit_capacity || 0} ${pluralizeUnit(r.storage_unit)}` : ''}
                      </span>
                    </button>
                  ))}
                </React.Fragment>
              ))}
              {rackGroups.length === 0 && <p className="sir-muted">No racks match.</p>}
            </div>
            <button type="button" className="sir-btn sir-btn--ghost" onClick={() => setRowPicker(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {feedback && (
        <ScanFeedback kind={feedback.kind} message={feedback.message} onDismiss={() => setFeedback(null)} />
      )}
    </ScannerLayout>
  );
};

const ScannerTruckReceiveFlow = () => {
  const { orderId } = useParams();
  return orderId ? <TruckView orderId={orderId} /> : <TruckListView />;
};

export default ScannerTruckReceiveFlow;
