import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../../api/client';
import ScannerLayout from './ScannerLayout';
import ScanFeedback from './ScanFeedback';
import { useAuth } from '../../context/AuthContext';
import {
  cleanScannedLicence, isValidLicenceFormat, playErrorTone, playSuccessTone,
} from '../../utils/scannerFeedback';
import { formatDateTime } from '../../utils/dateUtils';
import {
  CYCLE_CHECK_CONFIRM_OVER, CYCLE_CHECK_SESSION_IDLE_MINUTES, PALLET_STATUS,
} from '../../constants';
import { AlertTriangle, ArrowRight, Check, Flag, MapPin, Scan, Search, X } from 'lucide-react';
import {
  loadCycleSession, matchRow, notHereIds, saveCycleSession, sessionRowFromResult, sessionTotals,
} from '../../utils/cycleCheck';
import './ScannerReceiptFlow.css';
import './ScannerCycleCheckFlow.css';

const ACTION_LABELS = {
  move_here: 'Move it to this row',
  found_here: 'Found — in stock in this row',
  restore_here: 'Put back in stock in this row',
  create_here: 'Create in stock in this row from the sticker',
};

const IDLE_MS = CYCLE_CHECK_SESSION_IDLE_MINUTES * 60 * 1000;
const emptySession = () => ({ id: null, startedAt: null, lastAt: null, rows: [], draft: null });

/**
 * Gun cycle check (FG pallet lifecycle §4.1). Any row, any time — as a
 * count SESSION: scan a row → see what the system says is there, grouped by
 * product + lot → scan the front pallet of each group that IS there, tap
 * "Not here" on what isn't → Next row (saved at once, exactly like the old
 * Submit: not-here pallets go MISSING with no approval) … → Finish count
 * shows the walk's totals. Every row save carries the session id, so the
 * Cycle Count page shows the walk as one line. Find Pallet looks up one
 * licence, says why it is where it is, and offers the fix that fits it.
 */
const ScannerCycleCheckFlow = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const userId = user?.id;
  const inputRef = useRef(null);
  const [rows, setRows] = useState([]);
  const [row, setRow] = useState(null);
  const [contents, setContents] = useState(null);
  const [scanned, setScanned] = useState([]);       // licence numbers scanned in this row
  const [groupNotHere, setGroupNotHere] = useState(new Set());
  const [palletNotHere, setPalletNotHere] = useState(new Set());
  const [openGroup, setOpenGroup] = useState(null);
  const [confirming, setConfirming] = useState(null);  // 'next' | 'finish' while asking "N not here — sure?"
  const [session, setSession] = useState(() => loadCycleSession(userId, CYCLE_CHECK_SESSION_IDLE_MINUTES) || emptySession());
  const [lastRow, setLastRow] = useState(null);        // the row just saved (its notes)
  const [finished, setFinished] = useState(null);      // the walk's totals after Finish
  const [finishedRows, setFinishedRows] = useState([]);
  const [findMode, setFindMode] = useState(false);
  const [found, setFound] = useState(null);
  const [confirmCreate, setConfirmCreate] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const restored = useRef(false);

  const ok = useCallback((message) => { playSuccessTone(); setFeedback({ kind: 'success', message }); }, []);
  const fail = useCallback((message) => { playErrorTone(); setFeedback({ kind: 'error', message }); }, []);

  useEffect(() => {
    apiClient.get('/scanner/cycle-check/rows')
      .then((r) => setRows(r.data || []))
      .catch(() => setRows([]));
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [row, findMode, finished, confirming, feedback]);

  // Keep the walk (and the row in progress) across a reload of the gun.
  useEffect(() => {
    if (!restored.current) return;
    const draft = row ? {
      row, scanned, groupNotHere: [...groupNotHere], palletNotHere: [...palletNotHere],
    } : null;
    const hasAnything = session.id || session.rows.length || draft;
    saveCycleSession(userId, hasAnything ? { ...session, draft } : null);
  }, [userId, session, row, scanned, groupNotHere, palletNotHere]);

  // A reload mid-row: re-read the row and put the checker's marks back.
  useEffect(() => {
    if (restored.current) return;
    const draft = session.draft;
    if (!draft?.row) { restored.current = true; return; }
    apiClient.get(`/scanner/cycle-check/rows/${draft.row.id}`)
      .then((resp) => {
        const ids = new Set((resp.data.groups || []).flatMap((g) => g.pallets.map((p) => p.id)));
        setRow(draft.row);
        setContents(resp.data);
        setScanned(draft.scanned || []);
        setGroupNotHere(new Set(draft.groupNotHere || []));
        setPalletNotHere(new Set((draft.palletNotHere || []).filter((id) => ids.has(id))));
      })
      .catch(() => {})
      .finally(() => { restored.current = true; });
  }, [session.draft]);

  const scannedSet = useMemo(() => new Set(scanned), [scanned]);
  const groups = useMemo(() => contents?.groups || [], [contents]);
  const pendingNotHere = useMemo(
    () => notHereIds(groups, groupNotHere, palletNotHere, scannedSet),
    [groups, groupNotHere, palletNotHere, scannedSet],
  );
  const knownLicences = useMemo(
    () => new Set(groups.flatMap((g) => g.pallets.map((p) => p.licence_number))),
    [groups],
  );
  const extraScans = scanned.filter((l) => !knownLicences.has(l));
  const rowTouched = scanned.length > 0 || pendingNotHere.length > 0;
  const totals = useMemo(() => sessionTotals(session.rows), [session.rows]);

  const resetRow = () => {
    setScanned([]);
    setGroupNotHere(new Set());
    setPalletNotHere(new Set());
    setOpenGroup(null);
    setConfirming(null);
  };

  const loadRow = async (r) => {
    setBusy(true);
    try {
      const resp = await apiClient.get(`/scanner/cycle-check/rows/${r.id}`);
      setRow(r);
      setContents(resp.data);
      setFinished(null);
      resetRow();
      ok(`Row ${r.name}`);
    } catch (err) {
      fail(err.response?.data?.detail || 'Could not load that row');
    } finally {
      setBusy(false);
    }
  };

  const lookUp = async (licence) => {
    setBusy(true);
    setConfirmCreate(false);
    try {
      const resp = await apiClient.get('/scanner/cycle-check/find', { params: { licence_number: licence } });
      setFound(resp.data);
    } catch (err) {
      fail(err.response?.data?.detail || 'Lookup failed');
    } finally {
      setBusy(false);
    }
  };

  const handleScan = (e) => {
    e?.preventDefault?.();
    const raw = input;
    setInput('');
    if (!raw.trim()) return;
    const cleaned = cleanScannedLicence(raw.trim());
    if (isValidLicenceFormat(cleaned)) {
      if (findMode) { lookUp(cleaned); return; }
      if (!row) { fail('Scan the row barcode first.'); return; }
      if (scannedSet.has(cleaned)) { ok('Already scanned'); return; }
      setScanned((prev) => [...prev, cleaned]);
      const g = groups.find((x) => x.pallets.some((p) => p.licence_number === cleaned));
      if (g) ok(`${g.product_name} ${g.lot_number} — here`);
      else ok(`${cleaned} — not expected in this row; it will be put here when the row is saved`);
      return;
    }
    if (findMode) { fail('Not a pallet sticker — scan or type a licence.'); return; }
    const r = matchRow(rows, raw);
    if (!r) { fail('Row not found — scan the row barcode or a pallet sticker.'); return; }
    if (row && rowTouched && r.id !== row.id) {
      fail(`Save ${row.name} first — tap Next row.`);
      return;
    }
    loadRow(r);
  };

  const toggleGroup = (key) => {
    setGroupNotHere((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const togglePallet = (id) => {
    setPalletNotHere((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const wholeRowEmpty = () => setGroupNotHere(new Set(groups.map((g) => g.key)));

  const finishWalk = (rowsSoFar) => {
    setFinished(sessionTotals(rowsSoFar));
    setFinishedRows(rowsSoFar);
    setSession(emptySession());
    setLastRow(null);
    setRow(null);
    setContents(null);
    resetRow();
  };

  // Save the current row (exactly what Submit did), then either go on to the
  // next row or end the walk.
  const saveRow = async (intent, confirmed = false) => {
    if (!row) return;
    if (!confirmed && pendingNotHere.length > CYCLE_CHECK_CONFIRM_OVER) {
      setConfirming(intent);
      return;
    }
    // An idle walk is over: this row starts a new one.
    const stale = session.lastAt && Date.now() - session.lastAt > IDLE_MS;
    const base = stale ? emptySession() : session;
    setBusy(true);
    try {
      const resp = await apiClient.post('/scanner/cycle-check/submit', {
        row_id: row.id,
        scanned,
        not_here_pallet_ids: pendingNotHere,
        confirmed: confirmed || pendingNotHere.length <= CYCLE_CHECK_CONFIRM_OVER,
        session_id: base.id,
      });
      if (resp.data.status === 'needs_confirm') {
        setConfirming(intent);
        return;
      }
      const saved = sessionRowFromResult(resp.data.summary);
      // The server decides the session: a new id means a new walk.
      const sameWalk = base.id && resp.data.session_id === base.id;
      const nextRows = [...(sameWalk ? base.rows : []), saved];
      const nextSession = {
        id: resp.data.session_id,
        startedAt: sameWalk ? base.startedAt : resp.data.session_started_at,
        lastAt: Date.now(),
        rows: nextRows,
        draft: null,
      };
      setConfirming(null);
      if (intent === 'finish') {
        finishWalk(nextRows);
        ok(`Count finished — ${nextRows.length} row${nextRows.length === 1 ? '' : 's'}`);
        return;
      }
      setSession(nextSession);
      setLastRow(saved);
      setRow(null);
      setContents(null);
      resetRow();
      ok(`${saved.row_name} saved${saved.not_here ? ` — ${saved.not_here} not here` : saved.ok ? ' — OK' : ''}`);
    } catch (err) {
      fail(err.response?.data?.detail || 'Could not save the row');
    } finally {
      setBusy(false);
    }
  };

  // Finish = save the row on screen (like Next row), then end the walk.
  const finish = () => {
    if (row) { saveRow('finish'); return; }
    finishWalk(session.rows);
  };

  const runAction = async (action, confirmed = false) => {
    if (!row) { fail('Scan the row you are standing at first.'); return; }
    if (action === 'create_here' && found?.confirm_create && !confirmed) {
      setConfirmCreate(true);
      return;
    }
    setBusy(true);
    try {
      const resp = await apiClient.post('/scanner/cycle-check/find', {
        licence_number: found.licence_number, action, row_id: row.id, confirmed,
      });
      setFound(resp.data);
      setConfirmCreate(false);
      ok(`${found.licence_number} — in stock in ${row.name}`);
    } catch (err) {
      fail(err.response?.data?.detail || 'Could not update the pallet');
    } finally {
      setBusy(false);
    }
  };

  const placeholder = findMode
    ? 'Scan or type a pallet licence…'
    : row ? 'Scan the front pallet of each group…' : 'Scan the row barcode…';
  const walkActive = session.rows.length > 0;

  return (
    <ScannerLayout title="Cycle Check" showBack onBack={() => navigate('/forklift')}>
      <div className="scanner-receipt-flow">
        <form onSubmit={handleScan} className="scanner-receipt-form">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={placeholder}
            className="scanner-receipt-input"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Scan"
          />
          <button type="submit" disabled={busy || !input.trim()} className="scanner-receipt-btn">
            <Scan size={22} />
          </button>
        </form>

        <div className="cc-modebar">
          <button type="button" className={!findMode ? 'active' : ''} onClick={() => { setFindMode(false); setFound(null); setConfirmCreate(false); }}>
            <MapPin size={16} /> Row check
          </button>
          <button type="button" className={findMode ? 'active' : ''} onClick={() => setFindMode(true)}>
            <Search size={16} /> Find Pallet
          </button>
        </div>

        {walkActive && !finished && (
          <div className="cc-sessionbar" data-testid="cc-sessionbar">
            <span>Count: <strong>{totals.rows}</strong> row{totals.rows === 1 ? '' : 's'} · {totals.ok} OK</span>
            {totals.differences > 0 && <span className="cc-diff">{totals.differences} with differences</span>}
          </div>
        )}

        {row && (
          <div className="scanner-receipt-product">
            <MapPin size={16} /> {row.name}
            {row.area_name ? <span className="scanner-receipt-lot"> · {row.area_name}</span> : null}
          </div>
        )}

        {findMode ? (
          <div className="cc-find">
            {!found && <p className="scanner-receipt-instruction">Scan any pallet to see where it is and what happened to it.</p>}
            {found && (
              <div className="cc-card">
                <div className="cc-find-head">
                  <strong>{found.licence_number}</strong>
                  <span className={`cc-status cc-status-${found.status || 'none'}`}>
                    {found.status ? found.status.replace('_', ' ') : 'not in system'}
                  </span>
                </div>
                {found.product_name && (
                  <div className="cc-find-meta">
                    {found.product_name} · {found.lot_number}
                    {found.exists ? ` · ${found.cases ?? '—'} cs` : ''}
                    {found.row_name ? ` · ${found.row_name}` : ''}
                  </div>
                )}
                {found.message && (
                  <p className={`cc-find-msg${found.confirm_create ? ' cc-warn' : ''}`}>
                    {found.confirm_create && <AlertTriangle size={16} aria-hidden="true" />} {found.message}
                  </p>
                )}
                {found.forklift_request && found.status === PALLET_STATUS.PENDING && (
                  <p className="cc-find-msg">Request {found.forklift_request.id} ({found.forklift_request.status})</p>
                )}
                {confirmCreate ? (
                  <div role="alert">
                    <div className="scanner-receipt-overfill">
                      <div style={{ flex: 1 }}>
                        <strong>Create the first pallet of this lot?</strong>
                        <div className="scanner-receipt-overfill-detail">Only if the product and lot on the sticker are right — otherwise it is counted twice.</div>
                      </div>
                    </div>
                    <button type="button" className="scanner-receipt-overfill-continue" disabled={busy} onClick={() => runAction('create_here', true)}>Yes, create it in {row?.name}</button>
                    <button type="button" className="scanner-receipt-try-scan-btn" onClick={() => setConfirmCreate(false)}>Go back</button>
                  </div>
                ) : (
                  /* "Move it to this row" for a pallet already in this row is a no-op. */
                  (found.actions || []).filter((a) => !(a === 'move_here' && row && found.storage_row_id === row.id)).map((a) => (
                    <button key={a} type="button" className="scanner-receipt-overfill-continue" disabled={busy} onClick={() => runAction(a)}>
                      <Check size={18} /> {ACTION_LABELS[a] || a}{row ? '' : ' (scan the row first)'}
                    </button>
                  ))
                )}
                {(found.history || []).length > 0 && (
                  <ul className="cc-history">
                    {found.history.map((h, i) => (
                      <li key={i}>
                        <strong>{h.event_type.replace(/_/g, ' ')}</strong>
                        {h.by ? ` · ${h.by}` : ''}{h.at ? ` · ${formatDateTime(h.at)}` : ''}
                        {h.reason ? <div className="cc-history-reason">{h.reason}</div> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        ) : finished ? (
          <div className="cc-card" data-testid="cc-finished">
            <h3 style={{ marginTop: 0 }}>Count finished</h3>
            <div className="cc-totals">
              <div><strong>{finished.rows}</strong><span>rows checked</span></div>
              <div><strong>{finished.ok}</strong><span>OK</span></div>
              <div className={finished.differences ? 'bad' : ''}><strong>{finished.differences}</strong><span>with differences</span></div>
            </div>
            <ul className="cc-history">
              <li>Not here (now missing): {finished.not_here}</li>
              <li>Found again: {finished.found}</li>
              <li>Moved here: {finished.moved_in}</li>
              <li>Created from sticker: {finished.created}</li>
            </ul>
            {finishedRows.some((r) => !r.ok) && (
              <ul className="cc-history">
                {finishedRows.filter((r) => !r.ok).map((r, i) => (
                  <li key={i}>
                    <strong>{r.row_name}</strong>
                    {r.not_here ? ` · ${r.not_here} not here` : ''}{r.found ? ` · ${r.found} found` : ''}
                    {r.moved_in ? ` · ${r.moved_in} moved` : ''}{r.created ? ` · ${r.created} created` : ''}
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="scanner-receipt-submit-btn" onClick={() => { setFinished(null); setFinishedRows([]); }}>
              Start a new count
            </button>
          </div>
        ) : !row ? (
          <>
            {lastRow && (
              <div className={`cc-card cc-lastrow${lastRow.ok ? '' : ' bad'}`}>
                <strong>{lastRow.row_name} saved</strong>
                {' — '}{lastRow.ok ? 'OK' : [
                  lastRow.not_here && `${lastRow.not_here} not here`,
                  lastRow.found && `${lastRow.found} found`,
                  lastRow.moved_in && `${lastRow.moved_in} moved here`,
                  lastRow.created && `${lastRow.created} created`,
                ].filter(Boolean).join(' · ') || 'count differs'}
                {lastRow.messages.map((m, i) => <p key={i} className="cc-find-msg">{m}</p>)}
              </div>
            )}
            <div className="scanner-receipt-empty">
              <p>{walkActive ? 'Scan the next row.' : 'Scan the row you want to check.'}</p>
              <p className="scanner-receipt-empty-hint">Any row, any time — racks, docks and the floor.</p>
            </div>
            {walkActive && (
              <button type="button" className="scanner-receipt-submit-btn cc-finish-only" disabled={busy} onClick={finish}>
                <Flag size={18} /> Finish count
              </button>
            )}
          </>
        ) : (
          <>
            {groups.length === 0 ? (
              <p className="scanner-receipt-instruction">The system says this row is empty. Scan anything that is here.</p>
            ) : (
              <div className="cc-groups">
                {groups.map((g) => {
                  const isOut = groupNotHere.has(g.key);
                  const seen = g.pallets.some((p) => scannedSet.has(p.licence_number));
                  return (
                    <div key={g.key} className={`cc-group${isOut ? ' out' : ''}${seen ? ' seen' : ''}`}>
                      <button type="button" className="cc-group-main" onClick={() => setOpenGroup(openGroup === g.key ? null : g.key)}>
                        <span className="cc-group-name">{g.product_name} <span className="cc-lot">{g.lot_number}</span></span>
                        <span className="cc-group-count">{g.count}</span>
                        {seen && <Check size={18} color="#16a34a" aria-label="seen" />}
                      </button>
                      <button type="button" className={`cc-nothere${isOut ? ' on' : ''}`} onClick={() => toggleGroup(g.key)}>
                        {isOut ? 'Undo' : 'Not here'}
                      </button>
                      {openGroup === g.key && (
                        <ul className="cc-pallets">
                          {g.pallets.map((p) => {
                            const out = !scannedSet.has(p.licence_number) && (isOut || palletNotHere.has(p.id));
                            return (
                              <li key={p.id} className={out ? 'out' : ''}>
                                <span>#{String(p.sequence ?? '').padStart(3, '0')} · {p.cases} cs</span>
                                {scannedSet.has(p.licence_number) ? <Check size={16} color="#16a34a" /> : (
                                  <button type="button" className="cc-nothere small" onClick={() => togglePallet(p.id)} disabled={isOut}>
                                    {palletNotHere.has(p.id) ? 'Undo' : <><X size={14} /> Not here</>}
                                  </button>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  );
                })}
                <button type="button" className="scanner-receipt-try-scan-btn" onClick={wholeRowEmpty}>Whole row empty</button>
              </div>
            )}

            {extraScans.length > 0 && (
              <div className="cc-card">
                <strong>Also here (not expected):</strong>
                <ul className="cc-history">{extraScans.map((l) => <li key={l}>{l}</li>)}</ul>
              </div>
            )}

            {confirming ? (
              <div role="alert">
                {/* Text in the warning box, buttons full-width below it — inside
                    the flex row the buttons squeezed the message to one word
                    per line on a gun-sized screen. */}
                <div className="scanner-receipt-overfill">
                  <div style={{ flex: 1 }}>
                    <strong>{pendingNotHere.length} pallets not here — sure?</strong>
                    <div className="scanner-receipt-overfill-detail">They will be marked missing right away.</div>
                  </div>
                </div>
                <button type="button" className="scanner-receipt-overfill-continue" disabled={busy} onClick={() => saveRow(confirming, true)}>Yes, mark missing</button>
                <button type="button" className="scanner-receipt-try-scan-btn" onClick={() => setConfirming(null)}>Go back</button>
              </div>
            ) : (
              <div className="cc-actions">
                <button type="button" className="scanner-receipt-submit-btn cc-next" disabled={busy} onClick={() => saveRow('next')}>
                  <ArrowRight size={18} /> Next row
                  {pendingNotHere.length > 0 ? ` (${pendingNotHere.length} not here)` : ''}
                </button>
                <button type="button" className="scanner-receipt-submit-btn cc-finish" disabled={busy} onClick={finish}>
                  <Flag size={18} /> Finish count
                </button>
              </div>
            )}
          </>
        )}
      </div>
      <ScanFeedback {...(feedback || {})} onDismiss={() => setFeedback(null)} />
    </ScannerLayout>
  );
};

export default ScannerCycleCheckFlow;
