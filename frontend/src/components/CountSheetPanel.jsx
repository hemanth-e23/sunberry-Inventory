import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ExcelJS from 'exceljs';
import apiClient from '../api/client';
import { useConfirm } from '../context/ConfirmContext';
import { useToast } from '../context/ToastContext';
import { formatDateKey, formatDateTime } from '../utils/dateUtils';
import { COUNT_SHEET, COUNT_SHEET_TYPE_LABELS } from '../constants';
import {
  classifyExtra, loadSheetDraft, parseCount, parseLicences, saveSheetDraft, sheetDraftStats, sheetPrintHtml,
  sheetRowsInOrder, sheetSubmitPayload, submitConfirmLines,
} from '../utils/cycleCheck';

// Count sheet by rack row: generate from live data → (print and walk) → fill
// in on screen → submit, which applies at once (FG through the gun's row
// check, RM / packaging through a counted placement event). Lines that
// changed since the sheet was made come back as skipped with a reason.

const apiError = (err, fallback) => {
  const d = err?.response?.data?.detail;
  return typeof d === 'string' ? d : fallback;
};

// Held stock is counted like any other — it is just marked, clearly.
const HeldBadge = ({ children = 'ON HOLD', title }) => (
  <span className="cs-held-badge" title={title || 'On hold — count it like any other'}>{children}</span>
);

const CountSheetPanel = ({ clientGroups, onSubmitted }) => {
  const { confirm } = useConfirm();
  const { addToast } = useToast();

  const [kind, setKind] = useState(COUNT_SHEET.TYPE_FG);
  const [client, setClient] = useState('');
  const [where, setWhere] = useState(''); // '' | 'sub:<id>' | 'area:<id>'
  const [openSheets, setOpenSheets] = useState([]);
  const [sheet, setSheet] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  // Rooms / rack areas holding stock of the chosen type (and client).
  const [scopes, setScopes] = useState({ rooms: [], areas: [] });

  useEffect(() => {
    let live = true;
    apiClient.get('/scanner/cycle-check/sheet-scopes', { params: { kind, client_id: client || undefined } })
      .then((resp) => {
        if (!live) return;
        const next = { rooms: resp.data?.rooms || [], areas: resp.data?.areas || [] };
        setScopes(next);
        // A room / area that holds none of this type is no longer offered.
        setWhere((w) => {
          if (!w) return w;
          const [sc, id] = w.split(':');
          return (sc === 'sub' ? next.rooms : next.areas).some((o) => o.id === id) ? w : '';
        });
      })
      .catch(() => { if (live) setScopes({ rooms: [], areas: [] }); });
    return () => { live = false; };
  }, [kind, client]);

  const loadOpenSheets = useCallback(async () => {
    try {
      const resp = await apiClient.get('/scanner/cycle-check/sheets', { params: { status: COUNT_SHEET.STATUS_OPEN } });
      setOpenSheets(resp.data || []);
    } catch {
      setOpenSheets([]);
    }
  }, []);

  useEffect(() => { loadOpenSheets(); }, [loadOpenSheets]);

  // Keep what was typed across reloads until the sheet is submitted.
  useEffect(() => {
    if (sheet && draft) saveSheetDraft(sheet.id, draft);
  }, [sheet, draft]);

  const showSheet = (s) => {
    setSheet(s);
    setDraft(loadSheetDraft(s.id));
    setResult(null);
  };

  const handleGenerate = async () => {
    setBusy(true);
    try {
      const [scope, id] = where ? where.split(':') : [null, null];
      const resp = await apiClient.post('/scanner/cycle-check/sheets', {
        kind,
        client_id: client || null,
        sub_location_id: scope === 'sub' ? id : null,
        storage_area_id: scope === 'area' ? id : null,
      });
      showSheet(resp.data);
      loadOpenSheets();
    } catch (err) {
      addToast(apiError(err, 'Could not make the count sheet.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleOpen = async (id) => {
    setBusy(true);
    try {
      const resp = await apiClient.get(`/scanner/cycle-check/sheets/${id}`);
      showSheet(resp.data);
    } catch (err) {
      addToast(apiError(err, 'Could not open that sheet.'), 'error');
      loadOpenSheets();
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = async (s) => {
    const ok = await confirm(
      `Throw away ${s.summary.sheet_no} (${s.summary.scope})? Nothing on it is applied, and anything typed into it is lost.`,
      { title: `Discard ${s.summary.sheet_no}`, confirmLabel: 'Discard sheet' },
    );
    if (!ok) return;
    setBusy(true);
    try {
      await apiClient.post(`/scanner/cycle-check/sheets/${s.id}/discard`);
      saveSheetDraft(s.id, null);
      if (sheet?.id === s.id) { setSheet(null); setDraft(null); }
      addToast(`${s.summary.sheet_no} discarded.`, 'success');
    } catch (err) {
      addToast(apiError(err, 'Could not discard that sheet.'), 'error');
    } finally {
      setBusy(false);
      loadOpenSheets();
    }
  };

  const handlePrint = () => {
    const win = window.open('', '_blank');
    if (!win) {
      addToast('The print window was blocked — allow pop-ups for this site.', 'error');
      return;
    }
    win.document.write(sheetPrintHtml(sheet));
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 250);
  };

  // ─── Draft edits (any entry in a row marks it counted) ─────────────────────

  const edit = (rowId, fn) => setDraft((d) => {
    const next = fn({ ...d });
    if (rowId) next.rowCounted = { ...next.rowCounted, [rowId]: true };
    return next;
  });

  const toggleRowCounted = (rowId) => setDraft((d) => ({
    ...d, rowCounted: { ...d.rowCounted, [rowId]: !d.rowCounted[rowId] },
  }));

  const togglePallet = (rowId, palletId) => edit(rowId, (d) => {
    const set = new Set(d.notHere);
    if (set.has(palletId)) set.delete(palletId); else set.add(palletId);
    return { ...d, notHere: [...set] };
  });

  const setExtra = (rowId, text) => edit(rowId, (d) => ({ ...d, extras: { ...d.extras, [rowId]: text } }));
  const setCount = (rowId, placementId, v) => edit(rowId, (d) => ({ ...d, counts: { ...d.counts, [placementId]: v } }));
  const setLegacy = (receiptId, v) => edit(null, (d) => ({ ...d, legacy: { ...d.legacy, [receiptId]: v } }));

  // ─── Submit ────────────────────────────────────────────────────────────────

  const fg = sheet?.summary?.sheet_type === COUNT_SHEET.TYPE_FG;
  const snap = useMemo(() => {
    const sn = sheet?.summary?.sheet || { rows: [], legacy: [] };
    return { ...sn, rows: sheetRowsInOrder(sn.rows || []) };
  }, [sheet]);
  const snapRowName = useMemo(() => Object.fromEntries(snap.rows.map((r) => [r.row_id, r.row_name])), [snap]);

  const stats = useMemo(() => (sheet && draft ? sheetDraftStats(sheet, draft) : null), [sheet, draft]);
  const notHereSet = useMemo(() => new Set(draft?.notHere || []), [draft]);
  const payload = useMemo(() => (sheet && draft ? sheetSubmitPayload(sheet, draft) : null), [sheet, draft]);
  const nothingToSubmit = !payload || (payload.rows.length === 0 && payload.legacy.length === 0);

  const handleSubmit = async () => {
    if (nothingToSubmit) {
      addToast('Mark at least one row as counted.', 'error');
      return;
    }
    if (stats.badLines > 0) {
      addToast(`${stats.badLines} count(s) are not whole numbers — fix them first.`, 'error');
      return;
    }
    // What each extra licence will do (moved / found / created), from the
    // same lookup as Find Pallet. A lookup failure only makes the confirm
    // less specific.
    let extras = null;
    if (fg) {
      const typed = payload.rows.flatMap((r) => (r.extra_licences || []).map((licence) => ({
        licence, row_id: r.row_id, row_name: snapRowName[r.row_id] || r.row_id,
      })));
      if (typed.length) {
        setBusy(true);
        try {
          extras = await Promise.all(typed.map(async (x) => {
            const resp = await apiClient.get('/scanner/cycle-check/find', { params: { licence_number: x.licence } });
            return { ...x, outcome: classifyExtra(resp.data, x.row_id), message: resp.data?.message };
          }));
        } catch {
          extras = null;
        } finally {
          setBusy(false);
        }
        const bad = (extras || []).filter((x) => x.outcome === 'invalid');
        if (bad.length) {
          addToast(`Check these licences first: ${bad.map((x) => `${x.licence} (${x.row_name}) — ${x.message}`).join(' · ')}`, 'error');
          return;
        }
      }
    }
    const lines = submitConfirmLines({ stats, payload, extras, fg });
    const ok = await confirm(
      <div className="cs-confirm">{lines.map((l, i) => <p key={i}>{l}</p>)}</div>,
      { title: `Submit ${sheet.summary.sheet_no}`, confirmLabel: 'Submit and apply' },
    );
    if (!ok) return;
    setBusy(true);
    try {
      const resp = await apiClient.post(`/scanner/cycle-check/sheets/${sheet.id}/submit`, payload);
      saveSheetDraft(sheet.id, null);
      setResult({ ...resp.data, scope: sheet.summary.scope });
      setSheet(null);
      setDraft(null);
      loadOpenSheets();
      onSubmitted?.();
    } catch (err) {
      // Nothing was applied (the server rolls the whole submit back); the
      // draft is kept so the counts aren't lost.
      addToast(apiError(err, 'Submit failed — nothing was changed. Try again.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const exportResult = async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(result.sheet_no);
    ws.addRow(['Row', 'Product', 'Lot #', 'System', 'Counted', 'Unit', 'Variance', 'Status', 'Note']);
    result.items.forEach((v) => {
      ws.addRow([
        v.location, v.productName, v.lotNo, v.expectedQuantity, v.actualQuantity, v.unit, v.variance,
        v.status, v.skipReason || [...(v.notHere || []), ...(v.arrived || []).map((a) => `${a.licence_number} (${a.result})`)].join(', '),
      ]);
    });
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `count-sheet-${result.sheet_no}.xlsx`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // ─── Render ────────────────────────────────────────────────────────────────


  return (
    <>
      {/* ── Setup ─────────────────────────────────────────────────────────── */}
      <div className="count-setup-panel">
        <h2>Count sheet by row</h2>
        <div className="form-grid">
          <label>
            <span>Type</span>
            <select value={kind} onChange={(e) => { setKind(e.target.value); setWhere(''); }}>
              {Object.entries(COUNT_SHEET_TYPE_LABELS).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Client</span>
            <select value={client} onChange={(e) => setClient(e.target.value)}>
              <option value="">All clients</option>
              {clientGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
          <label>
            <span>Room or rack area (optional)</span>
            <select value={where} onChange={(e) => setWhere(e.target.value)}>
              <option value="">Whole warehouse</option>
              {scopes.rooms.length > 0 && (
                <optgroup label="Rooms">
                  {scopes.rooms.map((o) => <option key={o.id} value={`sub:${o.id}`}>{o.label}</option>)}
                </optgroup>
              )}
              {scopes.areas.length > 0 && (
                <optgroup label="Rack areas">
                  {scopes.areas.map((o) => <option key={o.id} value={`area:${o.id}`}>{o.label}</option>)}
                </optgroup>
              )}
            </select>
          </label>
        </div>
        <button className="primary-button" onClick={handleGenerate} disabled={busy}>
          {busy ? 'Working…' : 'Generate count sheet'}
        </button>

        {openSheets.length > 0 && (
          <div className="cs-open-sheets">
            <h3>Open sheets</h3>
            <ul>
              {openSheets.map((s) => (
                <li key={s.id} className="cs-open-sheet-item">
                  <button
                    type="button"
                    className={`cs-open-sheet${sheet?.id === s.id ? ' active' : ''}`}
                    onClick={() => handleOpen(s.id)}
                    disabled={busy}
                  >
                    <span className="cs-sheet-no">{s.summary.sheet_no}</span>
                    <span>{s.summary.scope}</span>
                    <span className="cs-muted">
                      {s.summary.rows_total} rows · {formatDateTime(s.summary.generated_at)} · {s.summary.generated_by || s.performed_by}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="secondary-button cs-discard"
                    onClick={() => handleDiscard(s)}
                    disabled={busy}
                    aria-label={`Discard ${s.summary.sheet_no}`}
                  >
                    Discard
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* ── Result of the last submit ─────────────────────────────────────── */}
      {result && (
        <div className="variance-summary-panel">
          <div className="cs-sheet-head">
            <h2>✓ {result.sheet_no} submitted</h2>
            <div className="cs-actions">
              {result.items.length > 0 && <button className="secondary-button" onClick={exportResult}>Export Excel</button>}
              <button className="secondary-button" onClick={() => setResult(null)}>Close</button>
            </div>
          </div>
          <p className="cs-muted">{result.scope}</p>
          <div className="variance-stats">
            <div className="stat-item"><div className="stat-label">Rows counted</div><div className="stat-value">{result.rows_counted}</div></div>
            <div className="stat-item"><div className="stat-label">Changes applied</div><div className="stat-value">{result.applied}</div></div>
            <div className="stat-item">
              <div className="stat-label">Skipped</div>
              <div className={`stat-value ${result.skipped.length ? 'variance-negative' : ''}`}>{result.skipped.length}</div>
            </div>
          </div>
          {result.warnings?.length > 0 && (
            <div className="cs-warnings" role="alert">
              <h3>Look for these pallets</h3>
              <ul>
                {result.warnings.map((w, i) => (
                  <li key={i}>
                    <b>{w.product_name}</b> · lot <span className="cs-mono">{w.lot}</span> · {w.row_name}: {w.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.skipped.length > 0 && (
            <>
              <h3>Skipped — not applied</h3>
              <div className="table-wrapper">
                <table className="variance-table">
                  <thead><tr><th>Row</th><th>Product</th><th>Lot / pallet</th><th>Why</th></tr></thead>
                  <tbody>
                    {result.skipped.map((s, i) => (
                      <tr key={i}>
                        <td>{s.row_name}</td>
                        <td>{s.product_name || '—'}</td>
                        <td className="cs-mono">{s.licence_number || s.lot || '—'}</td>
                        <td className="variance-shortage">{s.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {result.items.some((v) => v.status === 'shortage' || v.status === 'overage') && (
            <>
              <h3>Differences applied</h3>
              <div className="table-wrapper">
                <table className="variance-table">
                  <thead>
                    <tr>
                      <th>Row</th><th>Product</th><th>Lot #</th>
                      <th className="text-right">System</th><th className="text-right">Counted</th>
                      <th className="text-right">Variance</th><th>Pallets</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.items.filter((v) => v.status === 'shortage' || v.status === 'overage').map((v, i) => (
                      <tr key={i}>
                        <td>{v.location}</td>
                        <td>{v.productName}</td>
                        <td className="cs-mono">{v.lotNo}</td>
                        <td className="text-right">{v.expectedQuantity} {v.unit}</td>
                        <td className="text-right">{v.actualQuantity} {v.unit}</td>
                        <td className={`text-right variance-${v.status}`}>{v.variance > 0 ? '+' : ''}{v.variance}</td>
                        <td className="cc-pallet-notes">
                          {v.notHere?.length > 0 && <div>Not here (now missing): {v.notHere.join(', ')}</div>}
                          {v.arrived?.length > 0 && <div>Arrived: {v.arrived.map((a) => `${a.licence_number} (${a.result})`).join(', ')}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── The sheet ─────────────────────────────────────────────────────── */}
      {sheet && draft && (
        <div className="count-sheet-panel">
          <div className="cs-sheet-head">
            <div>
              <h2><span className="cs-sheet-no">{sheet.summary.sheet_no}</span> {sheet.summary.scope}</h2>
              <div className="cs-muted">
                From the system {formatDateTime(sheet.summary.generated_at)}
                {sheet.summary.generated_by ? ` by ${sheet.summary.generated_by}` : ''}
                {' · '}{stats.rowsCounted} of {stats.rowsTotal} rows counted
              </div>
            </div>
            <div className="cs-actions">
              <button className="secondary-button" onClick={handlePrint}>🖨 Print</button>
              <button className="secondary-button" onClick={() => handleDiscard(sheet)} disabled={busy}>Discard</button>
              <button className="secondary-button" onClick={() => { setSheet(null); setDraft(null); }}>Close</button>
            </div>
          </div>
          <p className="cs-help">
            {fg
              ? 'Every pallet is taken as seen. Tap a pallet that is not there (✗). Type or scan any other licence found in the row — each one is that one pallet only. ON HOLD pallets are counted like any other. Rows not marked "Row counted" are left alone.'
              : 'Enter the sealed units counted. Open and held units are shown for information; ON HOLD stock is counted like any other. A blank line is not counted. Rows not marked "Row counted" are left alone.'}
          </p>

          {snap.rows.length === 0 && <div className="empty-state">Nothing on a rack for this selection.</div>}

          {snap.rows.map((r) => {
            const counted = !!draft.rowCounted[r.row_id];
            return (
              <section key={r.row_id} className={`cs-row${counted ? ' counted' : ''}${r.empty ? ' empty' : ''}`}>
                <div className="cs-row-bar">
                  <div>
                    <span className="cs-row-name">{r.row_name}</span>
                    <span className="cs-row-area">{r.area_label || r.area_name}</span>
                  </div>
                  <label className="cs-row-toggle">
                    <input type="checkbox" checked={counted} onChange={() => toggleRowCounted(r.row_id)} />
                    {r.empty ? 'Confirmed empty' : 'Row counted'}
                  </label>
                </div>

                {r.empty ? (
                  <>
                    <div className="cs-empty-note">Empty — system shows nothing here.</div>
                    <label className="cs-extra">
                      <span>Found here {fg ? '(licence #)' : '(recorded only — nothing is changed)'}</span>
                      <input
                        type="text"
                        value={draft.extras[r.row_id] || ''}
                        onChange={(e) => setExtra(r.row_id, e.target.value)}
                        placeholder={fg ? 'Scan or type licence numbers, separated by spaces' : 'Product, lot and count of what you found'}
                        maxLength={fg ? undefined : 500}
                      />
                      {fg && parseLicences(draft.extras[r.row_id]).length > 0 && (
                        <span className="cs-muted">{parseLicences(draft.extras[r.row_id]).length} to add to this row — each that one pallet only</span>
                      )}
                    </label>
                  </>
                ) : fg ? (
                  <>
                    {r.lines.map((g) => {
                      const gone = g.pallets.filter((p) => notHereSet.has(p.id)).length;
                      const held = g.pallets.filter((p) => p.is_held).length;
                      return (
                        <div key={g.key} className="cs-line">
                          <div className="cs-line-head">
                            <span className="cs-product">{g.product_name}</span>
                            <span className="cs-mono">{g.lot_number || '—'}</span>
                            <span className="cs-muted">
                              {g.count - gone} of {g.count} pallets{gone ? ` · ${gone} not here` : ''}
                            </span>
                            {held > 0 && <HeldBadge>{held === g.count ? 'ALL ON HOLD' : `${held} ON HOLD`}</HeldBadge>}
                          </div>
                          <div className="cs-licences">
                            {g.pallets.map((p) => {
                              const off = notHereSet.has(p.id);
                              return (
                                <button
                                  key={p.id}
                                  type="button"
                                  className={`cs-lic${off ? ' off' : ''}${p.is_held ? ' held' : ''}`}
                                  onClick={() => togglePallet(r.row_id, p.id)}
                                  title={`${p.licence_number}${p.is_held ? ' — ON HOLD (count it like any other)' : ''} — tap if not here`}
                                  aria-pressed={off}
                                  aria-label={`${p.licence_number}${p.is_held ? ', on hold' : ''}, ${off ? 'not here' : 'seen'}`}
                                >
                                  {off ? '✗' : '✓'} {p.sequence != null ? String(p.sequence).padStart(3, '0') : p.licence_number}
                                  {p.is_held && <span className="cs-held-tag">HOLD</span>}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                    <label className="cs-extra">
                      <span>Extra licences found here</span>
                      <input
                        type="text"
                        value={draft.extras[r.row_id] || ''}
                        onChange={(e) => setExtra(r.row_id, e.target.value)}
                        placeholder="Scan or type licence numbers, separated by spaces"
                      />
                      {parseLicences(draft.extras[r.row_id]).length > 0 && (
                        <span className="cs-muted">{parseLicences(draft.extras[r.row_id]).length} to add to this row</span>
                      )}
                    </label>
                  </>
                ) : (
                  r.lines.map((l) => {
                    const raw = draft.counts[l.placement_id];
                    const n = parseCount(raw);
                    const bad = raw !== undefined && String(raw).trim() !== '' && n === null;
                    const diff = n === null ? null : n - l.full_units;
                    return (
                      <div key={l.placement_id} className="cs-line cs-rm-line">
                        <div className="cs-rm-info">
                          <span className="cs-product">{l.product_name}</span>
                          <span className="cs-mono">{l.vendor_lot_number || l.lot_code}</span>
                          <span className="cs-muted">BBD {l.bbd ? formatDateKey(l.bbd) : '—'}</span>
                          <span>
                            System <b>{l.full_units}</b> {l.unit_label}
                            {l.open_units > 0 && <span className="cs-muted"> · {l.open_units} open</span>}
                            {l.held_units > 0 && <HeldBadge title="Held on this rack — count them like any other">{l.held_units} ON HOLD</HeldBadge>}
                            {l.lot_is_held && <HeldBadge title="The whole lot is on hold — count it like any other">LOT ON HOLD</HeldBadge>}
                          </span>
                        </div>
                        <div className="cs-rm-count">
                          <input
                            type="number"
                            min="0"
                            step="1"
                            inputMode="numeric"
                            className={`cc-count-input-large${bad ? ' cs-bad' : ''}`}
                            value={raw ?? ''}
                            onChange={(e) => setCount(r.row_id, l.placement_id, e.target.value)}
                            placeholder="Counted sealed"
                            aria-label={`Counted sealed ${l.unit_label} of ${l.product_name} ${l.vendor_lot_number || ''} on ${r.row_name}`}
                          />
                          {diff !== null && (
                            <span className={`cc-card-variance ${diff === 0 ? 'variance-ok' : 'variance-shortage'}`}>
                              {diff === 0 ? '✓ matches' : `${diff > 0 ? '+' : ''}${diff}`}
                            </span>
                          )}
                          {n !== null && n < l.held_units && (
                            <span className="variance-shortage cs-small">{l.held_units} held here — release first</span>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </section>
            );
          })}

          {snap.legacy?.length > 0 && (
            <section className="cs-row">
              <div className="cs-row-bar">
                <div>
                  <span className="cs-row-name">Not on a rack</span>
                  <span className="cs-row-area">count is recorded, nothing is changed</span>
                </div>
              </div>
              {snap.legacy.map((rc) => (
                <div key={rc.receipt_id} className="cs-line cs-rm-line">
                  <div className="cs-rm-info">
                    <span className="cs-product">{rc.product_name}</span>
                    <span className="cs-mono">{rc.lot_number || '—'}</span>
                    <span>
                      System <b>{Number(rc.quantity || 0).toLocaleString()}</b> {rc.unit}
                      {rc.container_count ? <span className="cs-muted"> ({rc.container_count} {rc.container_unit})</span> : null}
                      {rc.is_held && <HeldBadge />}
                    </span>
                  </div>
                  <div className="cs-rm-count">
                    <input
                      type="number"
                      min="0"
                      step="1"
                      className="cc-count-input-large"
                      value={draft.legacy[rc.receipt_id] ?? ''}
                      onChange={(e) => setLegacy(rc.receipt_id, e.target.value)}
                      placeholder="Counted"
                      aria-label={`Counted ${rc.product_name}`}
                    />
                  </div>
                </div>
              ))}
            </section>
          )}

          <div className="count-actions">
            <button className="primary-button" onClick={handleSubmit} disabled={busy || nothingToSubmit}>
              {busy ? 'Submitting…' : `Submit and apply (${stats.rowsCounted} of ${stats.rowsTotal} rows)`}
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default CountSheetPanel;
