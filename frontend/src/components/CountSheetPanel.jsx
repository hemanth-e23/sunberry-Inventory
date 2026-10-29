import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ExcelJS from 'exceljs';
import apiClient from '../api/client';
import { useConfirm } from '../context/ConfirmContext';
import { useToast } from '../context/ToastContext';
import { formatDateKey, formatDateTime } from '../utils/dateUtils';
import { COUNT_SHEET, COUNT_SHEET_TYPE_LABELS } from '../constants';
import {
  loadSheetDraft, parseCount, parseLicences, saveSheetDraft, sheetDraftStats, sheetPrintHtml,
  sheetSubmitPayload,
} from '../utils/cycleCheck';

// Count sheet by rack row: generate from live data → (print and walk) → fill
// in on screen → submit, which applies at once (FG through the gun's row
// check, RM / packaging through a counted placement event). Lines that
// changed since the sheet was made come back as skipped with a reason.

const apiError = (err, fallback) => {
  const d = err?.response?.data?.detail;
  return typeof d === 'string' ? d : fallback;
};

const CountSheetPanel = ({ clientGroups, roomOptions, areaOptions, onSubmitted }) => {
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
    const notHere = payload.rows.reduce((n, r) => n + (r.not_here_pallet_ids?.length || 0), 0);
    const parts = [`${stats.rowsCounted} of ${stats.rowsTotal} rows marked counted. Rows not marked are left as they are.`];
    if (notHere) parts.push(`${notHere} pallet(s) ticked ✗ will be marked MISSING.`);
    if (stats.blankLines) parts.push(`${stats.blankLines} line(s) in counted rows are blank and will be skipped.`);
    parts.push('Changes apply immediately.');
    const ok = await confirm(parts.join(' '), { title: `Submit ${sheet.summary.sheet_no}`, confirmLabel: 'Submit and apply' });
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

  const fg = sheet?.summary?.sheet_type === COUNT_SHEET.TYPE_FG;
  const snap = sheet?.summary?.sheet || { rows: [], legacy: [] };

  return (
    <>
      {/* ── Setup ─────────────────────────────────────────────────────────── */}
      <div className="count-setup-panel">
        <h2>Count sheet by row</h2>
        <div className="form-grid">
          <label>
            <span>Type</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
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
              {roomOptions.length > 0 && (
                <optgroup label="Rooms">
                  {roomOptions.map((o) => <option key={o.id} value={`sub:${o.id}`}>{o.label}</option>)}
                </optgroup>
              )}
              {areaOptions.length > 0 && (
                <optgroup label="Rack areas">
                  {areaOptions.map((o) => <option key={o.id} value={`area:${o.id}`}>{o.label}</option>)}
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
                <li key={s.id}>
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
                        <td>{s.product_name}</td>
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
              <button className="secondary-button" onClick={() => { setSheet(null); setDraft(null); }}>Close</button>
            </div>
          </div>
          <p className="cs-help">
            {fg
              ? 'Every pallet is taken as seen. Tap a pallet that is not there (✗). Type or scan any other licence found in the row. Rows not marked "Row counted" are left alone.'
              : 'Enter the sealed units counted. Open and held units are shown for information. A blank line is not counted. Rows not marked "Row counted" are left alone.'}
          </p>

          {snap.rows.length === 0 && <div className="empty-state">Nothing on a rack for this selection.</div>}

          {snap.rows.map((r) => {
            const counted = !!draft.rowCounted[r.row_id];
            return (
              <section key={r.row_id} className={`cs-row${counted ? ' counted' : ''}`}>
                <div className="cs-row-bar">
                  <div>
                    <span className="cs-row-name">{r.row_name}</span>
                    <span className="cs-row-area">{r.area_name}</span>
                  </div>
                  <label className="cs-row-toggle">
                    <input type="checkbox" checked={counted} onChange={() => toggleRowCounted(r.row_id)} />
                    Row counted
                  </label>
                </div>

                {fg ? (
                  <>
                    {r.lines.map((g) => {
                      const gone = g.pallets.filter((p) => notHereSet.has(p.id)).length;
                      return (
                        <div key={g.key} className="cs-line">
                          <div className="cs-line-head">
                            <span className="cs-product">{g.product_name}</span>
                            <span className="cs-mono">{g.lot_number || '—'}</span>
                            <span className="cs-muted">
                              {g.count - gone} of {g.count} pallets{gone ? ` · ${gone} not here` : ''}
                            </span>
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
                                  title={`${p.licence_number}${p.is_held ? ' (held)' : ''} — tap if not here`}
                                  aria-pressed={off}
                                >
                                  {off ? '✗' : '✓'} {p.sequence != null ? String(p.sequence).padStart(3, '0') : p.licence_number}
                                  {p.is_held && <span className="cs-held-tag">H</span>}
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
                            {l.held_units > 0 && <span className="hold-badge">{l.held_units} held</span>}
                            {l.lot_is_held && !l.held_units && <span className="hold-badge">lot held</span>}
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
                      {rc.is_held && <span className="hold-badge">HOLD</span>}
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
