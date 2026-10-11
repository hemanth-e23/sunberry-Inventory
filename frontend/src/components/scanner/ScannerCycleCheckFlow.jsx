import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../../api/client';
import ScannerLayout from './ScannerLayout';
import ScanFeedback from './ScanFeedback';
import {
  cleanScannedLicence, isValidLicenceFormat, playErrorTone, playSuccessTone,
} from '../../utils/scannerFeedback';
import { formatDateTime } from '../../utils/dateUtils';
import { CYCLE_CHECK_CONFIRM_OVER, PALLET_STATUS } from '../../constants';
import { Check, MapPin, Scan, Search, X } from 'lucide-react';
import { matchRow, notHereIds } from '../../utils/cycleCheck';
import './ScannerReceiptFlow.css';
import './ScannerCycleCheckFlow.css';

const ACTION_LABELS = {
  move_here: 'Move it to this row',
  found_here: 'Found — in stock in this row',
  restore_here: 'Put back in stock in this row',
  create_here: 'Create in stock in this row from the sticker',
};

/**
 * Gun cycle check (FG pallet lifecycle §4.1). Any row, any time:
 * scan the row → see what the system says is there, grouped by product + lot →
 * scan the front pallet of each group that IS there, tap "Not here" on what
 * isn't → Submit. "Not here" pallets become MISSING at once (no approval);
 * every submit lands on the Cycle Count report. Find Pallet looks up one
 * licence and offers the fix that fits it.
 */
const ScannerCycleCheckFlow = () => {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const [rows, setRows] = useState([]);
  const [row, setRow] = useState(null);
  const [contents, setContents] = useState(null);
  const [scanned, setScanned] = useState([]);       // licence numbers scanned in this row
  const [groupNotHere, setGroupNotHere] = useState(new Set());
  const [palletNotHere, setPalletNotHere] = useState(new Set());
  const [openGroup, setOpenGroup] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);
  const [findMode, setFindMode] = useState(false);
  const [found, setFound] = useState(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);

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
  }, [row, findMode, result, confirming, feedback]);

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

  const resetRow = () => {
    setScanned([]);
    setGroupNotHere(new Set());
    setPalletNotHere(new Set());
    setOpenGroup(null);
    setConfirming(false);
  };

  const loadRow = async (r) => {
    setBusy(true);
    try {
      const resp = await apiClient.get(`/scanner/cycle-check/rows/${r.id}`);
      setRow(r);
      setContents(resp.data);
      setResult(null);
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
      else ok(`${cleaned} — not expected in this row; it will be put here on Submit`);
      return;
    }
    const r = matchRow(rows, raw);
    if (!r) { fail('Row not found — scan the row barcode or a pallet sticker.'); return; }
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

  const submit = async (confirmed = false) => {
    if (!row) return;
    if (!confirmed && pendingNotHere.length > CYCLE_CHECK_CONFIRM_OVER) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    try {
      const resp = await apiClient.post('/scanner/cycle-check/submit', {
        row_id: row.id,
        scanned,
        not_here_pallet_ids: pendingNotHere,
        confirmed: confirmed || pendingNotHere.length <= CYCLE_CHECK_CONFIRM_OVER,
      });
      if (resp.data.status === 'needs_confirm') {
        setConfirming(true);
        return;
      }
      setConfirming(false);
      setResult(resp.data);
      ok(`Row ${row.name} checked`);
    } catch (err) {
      fail(err.response?.data?.detail || 'Submit failed');
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (action) => {
    if (!row) { fail('Scan the row you are standing at first.'); return; }
    setBusy(true);
    try {
      const resp = await apiClient.post('/scanner/cycle-check/find', {
        licence_number: found.licence_number, action, row_id: row.id,
      });
      setFound(resp.data);
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
          <button type="button" className={!findMode ? 'active' : ''} onClick={() => { setFindMode(false); setFound(null); }}>
            <MapPin size={16} /> Row check
          </button>
          <button type="button" className={findMode ? 'active' : ''} onClick={() => setFindMode(true)}>
            <Search size={16} /> Find Pallet
          </button>
        </div>

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
                {found.exists && found.product_name && (
                  <div className="cc-find-meta">
                    {found.product_name} · {found.lot_number} · {found.cases ?? '—'} cs
                    {found.row_name ? ` · ${found.row_name}` : ''}
                  </div>
                )}
                {found.message && <p className="cc-find-msg">{found.message}</p>}
                {found.forklift_request && found.status === PALLET_STATUS.PENDING && (
                  <p className="cc-find-msg">Request {found.forklift_request.id} ({found.forklift_request.status})</p>
                )}
                {/* "Move it to this row" for a pallet already in this row is a no-op. */}
                {(found.actions || []).filter((a) => !(a === 'move_here' && row && found.storage_row_id === row.id)).map((a) => (
                  <button key={a} type="button" className="scanner-receipt-overfill-continue" disabled={busy} onClick={() => runAction(a)}>
                    <Check size={18} /> {ACTION_LABELS[a] || a}{row ? '' : ' (scan the row first)'}
                  </button>
                ))}
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
        ) : !row ? (
          <div className="scanner-receipt-empty">
            <p>Scan the row you want to check.</p>
            <p className="scanner-receipt-empty-hint">Any row, any time — racks, docks and the floor.</p>
          </div>
        ) : result ? (
          <div className="cc-card">
            <h3 style={{ marginTop: 0 }}>Checked {result.summary.row_name}</h3>
            <ul className="cc-history">
              <li>Expected {result.summary.expected_pallets} pallets</li>
              <li>Marked missing: {result.summary.not_here}</li>
              {result.summary.moved_in > 0 && <li>Moved here: {result.summary.moved_in}</li>}
              {result.summary.found > 0 && <li>Found again: {result.summary.found}</li>}
              {result.summary.created > 0 && <li>Created from sticker: {result.summary.created}</li>}
            </ul>
            {(result.summary.scans || []).filter((s) => s.message).map((s) => (
              <p key={s.licence_number} className="cc-find-msg">{s.message}</p>
            ))}
            <button type="button" className="scanner-receipt-submit-btn" onClick={() => { setRow(null); setContents(null); setResult(null); resetRow(); }}>
              Check another row
            </button>
          </div>
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
                <button type="button" className="scanner-receipt-overfill-continue" disabled={busy} onClick={() => submit(true)}>Yes, mark missing</button>
                <button type="button" className="scanner-receipt-try-scan-btn" onClick={() => setConfirming(false)}>Go back</button>
              </div>
            ) : (
              <button type="button" className="scanner-receipt-submit-btn" disabled={busy} onClick={() => submit(false)}>
                <Check size={18} /> Submit row check
                {pendingNotHere.length > 0 ? ` (${pendingNotHere.length} not here)` : ''}
              </button>
            )}
          </>
        )}
      </div>
      <ScanFeedback {...(feedback || {})} onDismiss={() => setFeedback(null)} />
    </ScannerLayout>
  );
};

export default ScannerCycleCheckFlow;
