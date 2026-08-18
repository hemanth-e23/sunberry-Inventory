import React, { useCallback, useEffect, useState } from 'react';
import apiClient from '../api/client';
import { useToast } from '../context/ToastContext';
import { useConfirm } from '../context/ConfirmContext';
import { formatDate, formatTime } from '../utils/dateUtils';
import Modal from './Modal';
import ShipOutDocuments from './ShipOutDocuments';
import { StatusChip, BigStepper } from './ShipOutPipeline';
import './Shared.css';
import './MasterDataPage.css';
import './OutgoingDashboard.css';

// Warehouse-worker view of one scheduled order: watch loading live, reconcile
// ordered-vs-shipped, add pallets by licence, manual attribution, then seal +
// generate the Packing Slip / BOL.
const ShipOutOrderDetail = ({ orderId, onBack }) => {
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const [summary, setSummary] = useState(null);
  const [status, setStatus] = useState(null);
  const [docs, setDocs] = useState(null);
  const [loading, setLoading] = useState(true);

  // pallet-select modal (lots-first: pick a lot, then its ready pallets)
  const [selectLine, setSelectLine] = useState(null);
  const [palletQuery, setPalletQuery] = useState('');
  const [pallets, setPallets] = useState([]);
  const [selLot, setSelLot] = useState(null);

  // live scan feed (polls while the forklift is loading)
  const [scanProg, setScanProg] = useState(null);

  // manual attribution modal
  const [manualLine, setManualLine] = useState(null);
  const [manual, setManual] = useState({ lot_number: '', cases: '', reason: '' });

  // adjust-to-partial modal (trim a scanned pallet, return remainder to floor)
  const [adjustLine, setAdjustLine] = useState(null);
  const [adjustVals, setAdjustVals] = useState({});

  // docs modal
  const [docForm, setDocForm] = useState(null); // {seal_number, time_out, pallet_count_override}

  // void & regenerate modal
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiClient.get(`/inventory/transfers/${orderId}/reconcile`);
      setSummary(r.data);
      setStatus(r.data.status);
      if (r.data.status === 'docs_generated') {
        const d = await apiClient.get(`/inventory/transfers/${orderId}/documents`);
        setDocs(d.data);
      } else {
        setDocs(null);
      }
    } catch (e) {
      addToast(e?.response?.data?.detail || 'Failed to load order', 'error');
    } finally {
      setLoading(false);
    }
  }, [orderId, addToast]);

  useEffect(() => { load(); }, [load]);

  // Live scan feed: poll every 5s while the forklift is loading, so the office
  // sees who's scanning, the last pallet, and running totals in real time.
  useEffect(() => {
    let timer = null;
    const poll = async () => {
      try {
        const r = await apiClient.get(`/inventory/transfers/${orderId}/scan-progress`);
        setScanProg(r.data);
      } catch { /* transient */ }
    };
    poll();
    if (['checked_in', 'scanning'].includes(status)) {
      timer = setInterval(async () => {
        await poll();
        try {
          const r = await apiClient.get(`/inventory/transfers/${orderId}/reconcile`);
          setSummary(r.data);
          setStatus(r.data.status);
        } catch { /* transient */ }
      }, 5000);
    }
    return () => { if (timer) clearInterval(timer); };
  }, [orderId, status]);

  // ── pallet select (lots-first) ──
  const openSelect = async (line) => {
    setSelectLine(line);
    setPalletQuery('');
    setSelLot(null);
    const r = await apiClient.get(`/inventory/transfers/${orderId}/selectable-pallets`, { params: { product_id: line.product_id } });
    setPallets(r.data || []);
  };
  const refreshPallets = async () => {
    const r = await apiClient.get(`/inventory/transfers/${orderId}/selectable-pallets`, { params: { product_id: selectLine.product_id } });
    setPallets(r.data || []);
  };
  const addPallet = async (lic) => {
    try {
      const r = await apiClient.post(`/inventory/transfers/${orderId}/select-pallet`, { licence_number: lic });
      if (r.data?.ok === false) { addToast(r.data.message || 'Could not add pallet', 'error'); return; }
      addToast(`Pallet ${lic} added.`, 'success');
      refreshPallets();
      load();
    } catch (e) {
      addToast(e?.response?.data?.detail || 'Failed to add pallet', 'error');
    }
  };

  // Group the available pallets by lot for the lots-first view.
  const lotGroups = React.useMemo(() => {
    const g = {};
    for (const p of pallets) {
      const key = p.lot_number || '(no lot)';
      const e = g[key] || { lot: key, pallets: 0, cases: 0, live: 0 };
      e.pallets += 1; e.cases += p.cases || 0; if (p.is_live) e.live += 1;
      g[key] = e;
    }
    return Object.values(g).sort((a, b) => a.lot.localeCompare(b.lot));
  }, [pallets]);

  const visiblePallets = React.useMemo(() => {
    const q = palletQuery.trim().toLowerCase();
    if (q) return pallets.filter(p => (p.licence_number || '').toLowerCase().includes(q));
    if (selLot) return pallets.filter(p => (p.lot_number || '(no lot)') === selLot);
    return [];
  }, [pallets, palletQuery, selLot]);

  // ── manual attribution ──
  const submitManual = async () => {
    if (!manual.lot_number || !(Number(manual.cases) > 0)) { addToast('Enter a lot and cases (> 0).', 'error'); return; }
    try {
      const r = await apiClient.post(`/inventory/transfers/${orderId}/manual-attribution`, {
        product_id: manualLine.product_id, lot_number: manual.lot_number,
        cases: Number(manual.cases), reason: manual.reason || null,
      });
      setSummary(r.data);
      setManualLine(null);
      setManual({ lot_number: '', cases: '', reason: '' });
      addToast('Manual attribution added (paperwork only — no inventory change).', 'success');
    } catch (e) {
      addToast(e?.response?.data?.detail || 'Failed', 'error');
    }
  };
  const removeManual = async (lineId, index) => {
    const r = await apiClient.post(`/inventory/transfers/${orderId}/manual-attribution/remove`, { line_id: lineId, index });
    setSummary(r.data);
  };

  // ── adjust a scanned pallet to a partial (return the remainder to the floor) ──
  const scannedForProduct = (pid) => (scanProg?.pick_list || [])
    .filter(p => p.is_scanned && p.product_id === pid)
    .sort((a, b) => (b.scanned_at || '').localeCompare(a.scanned_at || ''));

  const openAdjust = (line) => {
    const init = {};
    scannedForProduct(line.product_id).forEach(p => { init[p.pallet_id] = String(p.cases); });
    setAdjustVals(init);
    setAdjustLine(line);
  };

  // Refresh scans + line totals, then re-seed the open adjust modal's inputs.
  const refreshAfterAdjust = async () => {
    let fresh = null;
    try {
      const sp = await apiClient.get(`/inventory/transfers/${orderId}/scan-progress`);
      setScanProg(sp.data);
      fresh = sp.data;
    } catch { /* transient */ }
    await load();
    if (fresh && adjustLine) {
      const init = {};
      (fresh.pick_list || [])
        .filter(x => x.is_scanned && x.product_id === adjustLine.product_id)
        .forEach(x => { init[x.pallet_id] = String(x.cases); });
      setAdjustVals(init);
    }
  };

  const saveAdjust = async (p) => {
    const target = Number(adjustVals[p.pallet_id]);
    if (!Number.isInteger(target) || target < 1 || target > p.cases) {
      addToast(`Enter 1–${p.cases} cases for that pallet.`, 'error');
      return;
    }
    if (target === p.cases) { addToast('That pallet is unchanged.', 'info'); return; }
    try {
      const r = await apiClient.post(`/inventory/transfers/${orderId}/adjust-pallet-cases`,
        { pallet_licence_id: p.pallet_id, cases: target });
      addToast(r.data?.message || 'Pallet adjusted.', 'success');
      await refreshAfterAdjust();
    } catch (e) {
      addToast(e?.response?.data?.detail || 'Adjust failed', 'error');
    }
  };

  // Pull an ENTIRE pallet back off the truck — un-scan it, returning the whole
  // pallet to shippable stock (reason "wrong_pallet").
  const removePallet = async (p) => {
    const ok = await confirm(`Take pallet ${p.licence_number} (${p.cases} cs) off the truck? The whole pallet returns to stock.`);
    if (!ok) return;
    try {
      await apiClient.post(`/inventory/transfers/${orderId}/unscan-pick-v2`,
        { pallet_licence_id: p.pallet_id, reason: 'wrong_pallet' });
      addToast(`Pallet ${p.licence_number} removed — ${p.cases} cs back to stock.`, 'success');
      await refreshAfterAdjust();
    } catch (e) {
      addToast(e?.response?.data?.detail || 'Remove failed', 'error');
    }
  };

  // ── reconcile ──
  const reconcile = async (confirmShort = false, confirmOver = false) => {
    try {
      await apiClient.post(`/inventory/transfers/${orderId}/reconcile`, { confirm_short: confirmShort, confirm_over: confirmOver });
      addToast('Load finalized.', 'success');
      load();
    } catch (e) {
      const detail = e?.response?.data?.detail;
      if (detail === 'SHORT_CONFIRM_REQUIRED') {
        if (await confirm('This order is SHORT — shipping fewer cases than ordered. The order will close short. Are you sure?')) {
          return reconcile(true, confirmOver);
        }
      } else if (detail === 'OVER_CONFIRM_REQUIRED') {
        if (await confirm('This order is OVER — shipping more cases than ordered. Are you sure?')) {
          return reconcile(confirmShort, true);
        }
      } else {
        addToast(detail || 'Finalize failed', 'error');
      }
    }
  };

  // ── docs ──
  const submitDocs = async () => {
    try {
      const body = {
        seal_number: docForm.seal_number || null,
        time_out: docForm.time_out ? new Date().toISOString() : null,
        pallet_count_override: docForm.pallet_count_override !== '' ? Number(docForm.pallet_count_override) : null,
      };
      const r = await apiClient.post(`/inventory/transfers/${orderId}/generate-documents`, body);
      setDocs(r.data);
      setDocForm(null);
      addToast(`Documents generated — BOL #${r.data.bol_number}.`, 'success');
      load();
    } catch (e) {
      addToast(e?.response?.data?.detail || 'Doc generation failed', 'error');
    }
  };

  const submitVoid = async () => {
    if (!voidReason.trim()) { addToast('A reason is required to void documents.', 'error'); return; }
    try {
      await apiClient.post(`/inventory/transfers/${orderId}/void-documents`, { reason: voidReason.trim() });
      addToast('Documents voided — old BOL number is burned. Correct the order, then regenerate.', 'success');
      setVoidOpen(false);
      setVoidReason('');
      load();
    } catch (e) {
      addToast(e?.response?.data?.detail || 'Void failed', 'error');
    }
  };

  if (loading) return <div className="og-empty"><div className="big">⏳</div>Loading order…</div>;
  if (!summary) return <div className="og-empty"><button className="og-btn og-btn-ghost" onClick={onBack}>← Back to Shipping</button></div>;

  const canReconcile = ['checked_in', 'scanning', 'reconciled'].includes(status);
  const canDocs = ['reconciled', 'complete'].includes(status);
  const locked = status === 'docs_generated';
  const isLive = ['checked_in', 'scanning'].includes(status);

  const totalOrdered = summary.lines.reduce((s, l) => s + l.ordered, 0);
  const totalShipped = summary.lines.reduce((s, l) => s + l.shipped, 0);

  const val = (v, cls = '') => (v
    ? <span className={`v ${cls}`.trim()}>{v}</span>
    : <span className="v missing">not entered</span>);

  const scanned = (scanProg?.pick_list || []).filter(p => p.is_scanned)
    .sort((a, b) => (b.scanned_at || '').localeCompare(a.scanned_at || ''));
  const lastScan = scanned[0];

  return (
    <div>
      <div className="page-header">
        <button onClick={onBack} className="back-button">&larr; Back to Shipping</button>
      </div>

      <div className="og-det-head">
        <div className="title-wrap">
          <h2>
            <span className="og-ordno-strong">Order&nbsp;#{summary.order_number}</span>
            <StatusChip status={status} label={summary.ship_short && locked ? 'Shipped Short' : undefined} />
          </h2>
          <span className="subtitle">
            {[summary.customer_name, summary.location].filter(Boolean).join(' — ')}
            {summary.scheduled_date ? ` · ${formatDate(summary.scheduled_date)}` : ''}
            {summary.appointment_time ? ` · ${summary.appointment_time}` : ''}
          </span>
        </div>
      </div>

      <BigStepper
        status={status}
        subs={{
          checked_in: summary.time_in ? `in ${formatTime(summary.time_in)}` : undefined,
          scanning: isLive ? `${totalShipped.toLocaleString()} / ${totalOrdered.toLocaleString()} cs` : undefined,
          docs_generated: summary.bol_number ? `BOL #${summary.bol_number}` : undefined,
        }}
      />

      <div className="og-info-grid">
        <div className="og-info-card">
          <h4>Shipment</h4>
          <div className="og-kv">
            <span className="k">Customer</span>{val(summary.customer_name)}
            <span className="k">Ship to</span>{val([summary.ship_to_name, summary.location].filter(Boolean).join(' · '))}
            <span className="k">PO #</span>{val(summary.po_number, 'mono')}
            <span className="k">Carrier</span>{val(summary.carrier)}
            <span className="k">Cases</span>
            <span className="v">{totalShipped.toLocaleString()} shipped / {totalOrdered.toLocaleString()} ordered</span>
          </div>
        </div>
        <div className="og-info-card">
          <h4>Truck &amp; Driver</h4>
          <div className="og-kv">
            <span className="k">Driver</span>{val(summary.driver_name)}
            <span className="k">License #</span>{val(summary.driver_license, 'mono')}
            <span className="k">Tractor #</span>{val(summary.truck_number, 'mono')}
            <span className="k">Tractor plate</span>{val(summary.truck_license, 'mono')}
            <span className="k">Trailer #</span>{val(summary.trailer_number, 'mono')}
            <span className="k">Trailer plate</span>{val(summary.trailer_license, 'mono')}
            <span className="k">Time in</span>{val(summary.time_in ? formatTime(summary.time_in) : null)}
          </div>
        </div>
        <div className="og-info-card">
          <h4>Paperwork</h4>
          <div className="og-kv">
            <span className="k">Seal #</span>{val(summary.seal_number, 'mono')}
            <span className="k">BOL #</span>{val(summary.bol_number, 'mono')}
            <span className="k">Time out</span>{val(summary.time_out ? formatTime(summary.time_out) : null)}
            <span className="k">Status</span>
            <span className="v">{locked ? 'Locked — documents generated' : canDocs ? 'Ready to generate' : 'After finalize'}</span>
          </div>
        </div>
      </div>

      <div className="og-panel">
        <div className="og-panel-head">
          <h3>Order Lines</h3>
          {isLive && <span className="og-chip og-chip-scanning"><span className="og-live-dot" />Live — updates every 5s</span>}
        </div>
        <div className="og-panel-body" style={{ overflowX: 'auto' }}>
          <table className="og-table">
            <thead>
              <tr>
                <th>Product</th>
                <th className="num">Ordered</th>
                <th className="num">Scanned</th>
                <th className="num">Manual</th>
                <th className="num">Shipped</th>
                <th className="num">Δ</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {summary.lines.map((ln) => {
                const delta = ln.shipped - ln.ordered;
                const pct = ln.ordered > 0 ? Math.min(100, (ln.shipped / ln.ordered) * 100) : (ln.shipped > 0 ? 100 : 0);
                const fillCls = delta > 0 ? 'over' : (delta === 0 && ln.ordered > 0 ? 'full' : '');
                return (
                  <React.Fragment key={ln.product_id}>
                    <tr>
                      <td>
                        <div className="og-prod-cell">
                          <span className="name">{ln.product_name}</span>
                          <div className="og-prog"><div className={`fill ${fillCls}`.trim()} style={{ width: `${pct}%` }} /></div>
                        </div>
                      </td>
                      <td className="num">{ln.ordered.toLocaleString()}</td>
                      <td className="num">{ln.scanned.toLocaleString()}</td>
                      <td className="num">{ln.manual.toLocaleString()}</td>
                      <td className="num"><strong>{ln.shipped.toLocaleString()}</strong></td>
                      <td className="num">
                        <span className={`og-delta ${delta === 0 ? 'ok' : delta > 0 ? 'over' : 'short'}`}>
                          {delta === 0 ? '✓' : (delta > 0 ? `+${delta.toLocaleString()}` : delta.toLocaleString())}
                        </span>
                      </td>
                      <td>
                        {!locked && (
                          <div className="og-card-actions">
                            {delta > 0 && (
                              <button className="og-btn og-btn-primary" onClick={() => openAdjust(ln)}>Fix over-ship</button>
                            )}
                            <button className="og-btn og-btn-ghost" onClick={() => openSelect(ln)}>Select pallets</button>
                            <button className="og-btn og-btn-ghost" onClick={() => setManualLine(ln)}>Manual</button>
                          </div>
                        )}
                      </td>
                    </tr>
                    {(ln.manual_attributions || []).map((m, i) => (
                      <tr key={`${ln.product_id}-m-${i}`} className="og-manual-row">
                        <td colSpan={5}>
                          ↳ manual: <b>{m.cases} cs</b> · lot <span className="mono">{m.lot_number}</span>
                          {m.reason ? ` · ${m.reason}` : ''} <em>(no inventory change)</em>
                        </td>
                        <td colSpan={2} style={{ textAlign: 'right' }}>
                          {!locked && <button className="og-btn og-btn-danger-ghost" onClick={() => removeManual(m.line_id, i)}>Remove</button>}
                        </td>
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="og-actionbar">
          {canReconcile && (
            <>
              <button className="og-btn og-btn-primary" onClick={() => reconcile()}>Finalize Load</button>
              <span className="og-hint">Confirms shipped vs ordered and closes loading. Short/over totals ask for confirmation.</span>
            </>
          )}
          {canDocs && (
            <>
              <button className="og-btn og-btn-primary"
                      onClick={() => setDocForm({ seal_number: summary.seal_number || '', time_out: true, pallet_count_override: '' })}>
                Seal &amp; Generate Documents
              </button>
              <span className="og-hint">Builds the Packing Slip and BOL from what actually shipped, then locks the order.</span>
            </>
          )}
          {locked && (
            <div className="og-locked">
              🔒 Locked — BOL #{docs?.bol_number || summary.bol_number}
              <button className="og-btn og-btn-ghost" onClick={() => setVoidOpen(true)}>Void &amp; Regenerate…</button>
            </div>
          )}
        </div>
      </div>

      {(scanned.length > 0 || isLive) && (
        <div className="og-panel">
          <div className="og-panel-head">
            <h3>
              Forklift Scans
              {isLive && <span className="og-chip og-chip-scanning"><span className="og-live-dot" />Live</span>}
            </h3>
            <span className="og-hint">{scanned.length} pallet{scanned.length !== 1 ? 's' : ''} scanned</span>
          </div>
          <div className="og-panel-body">
            {lastScan ? (
              <div className="og-lastscan">
                <span className="lic">{lastScan.licence_number}</span>
                <span className="meta">
                  <b>{lastScan.cases} cs</b> · lot {lastScan.lot_number}
                  {lastScan.scanned_by ? <> · by <b>{lastScan.scanned_by}</b></> : null}
                  {lastScan.scanned_at ? <> · {formatTime(lastScan.scanned_at)}</> : null}
                </span>
              </div>
            ) : (
              <div className="og-lastscan" style={{ background: 'var(--color-canvas)', borderColor: 'var(--color-border)' }}>
                <span className="meta">Waiting for the first scan from the gun…</span>
              </div>
            )}
            {scanned.length > 0 && (
              <div className="og-scroll">
                <table className="og-table">
                  <thead>
                    <tr><th>#</th><th>Licence</th><th>Product</th><th>Lot</th><th className="num">Cases</th><th>From</th><th>Scanned by</th><th>Time</th>{isLive && <th></th>}</tr>
                  </thead>
                  <tbody>
                    {scanned.map((p, i) => (
                      <tr key={p.pallet_id} className={i === 0 ? 'og-row-new' : ''}>
                        <td>{scanned.length - i}</td>
                        <td className="mono">{p.licence_number}</td>
                        <td>{p.product_name || '—'}</td>
                        <td className="mono">{p.lot_number}</td>
                        <td className="num">{p.cases}</td>
                        <td>{p.location || '—'}</td>
                        <td>{p.scanned_by || '—'}</td>
                        <td>{p.scanned_at ? formatTime(p.scanned_at) : '—'}</td>
                        {isLive && (
                          <td style={{ textAlign: 'right' }}>
                            {p.is_partial ? (
                              <span className="og-hint" title="Partial pallets are corrected with an inventory adjustment, not removed here.">partial</span>
                            ) : (
                              <button className="og-btn og-btn-danger-ghost" onClick={() => removePallet(p)}>Remove</button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {docs && <ShipOutDocuments snapshot={docs} transferId={orderId} />}

      {/* Pallet-select modal — lots first, then that lot's ready pallets */}
      <Modal isOpen={!!selectLine} onClose={() => setSelectLine(null)} title={`Select pallets — ${selectLine?.product_name || ''}`}>
        <div className="og-modal-form" style={{ minWidth: '480px' }}>
          <input placeholder="Search licence # (searches all lots)" value={palletQuery}
                 onChange={(e) => setPalletQuery(e.target.value)} />

          {!palletQuery.trim() && !selLot && (
            <div className="og-scroll" style={{ maxHeight: '340px' }}>
              <table className="og-table">
                <thead><tr><th>Lot</th><th className="num">Pallets</th><th className="num">Cases</th><th></th></tr></thead>
                <tbody>
                  {lotGroups.map(g => (
                    <tr key={g.lot}>
                      <td className="mono" style={{ fontWeight: 700 }}>{g.lot}{g.live ? ' 🏭' : ''}</td>
                      <td className="num">{g.pallets}</td>
                      <td className="num">{g.cases.toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="og-btn og-btn-ghost" onClick={() => setSelLot(g.lot)}>View pallets ›</button>
                      </td>
                    </tr>
                  ))}
                  {!lotGroups.length && (
                    <tr><td colSpan={4} className="empty">
                      No ready-to-ship pallets for this product in this warehouse
                      (in stock, not on hold, or fresh off the line).
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {(palletQuery.trim() || selLot) && (
            <>
              {selLot && !palletQuery.trim() && (
                <button className="og-btn og-btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setSelLot(null)}>
                  ‹ Back to lots (viewing lot {selLot})
                </button>
              )}
              <div className="og-scroll" style={{ maxHeight: '320px' }}>
                <table className="og-table">
                  <thead><tr><th>Licence</th><th>Lot</th><th>Row</th><th className="num">Cases</th><th></th></tr></thead>
                  <tbody>
                    {visiblePallets.map(p => (
                      <tr key={p.pallet_licence_id}>
                        <td className="mono">{p.licence_number}{p.is_live ? ' 🏭' : ''}</td>
                        <td className="mono">{p.lot_number}</td>
                        <td>{p.row || '—'}</td>
                        <td className="num">{p.cases}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button className="og-btn og-btn-primary" onClick={() => addPallet(p.licence_number)}>Add</button>
                        </td>
                      </tr>
                    ))}
                    {!visiblePallets.length && <tr><td colSpan={5} className="empty">No pallets match.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <p className="og-modal-note">
            Only pallets that are in stock, not on hold, and ready to ship.
            🏭 = fresh off the line (live-load). Whole pallets only.
          </p>
        </div>
      </Modal>

      {/* Adjust-to-partial modal — trim a scanned pallet, remainder back to floor */}
      <Modal isOpen={!!adjustLine} onClose={() => setAdjustLine(null)} title={`Fix over-ship — ${adjustLine?.product_name || ''}`}>
        {adjustLine && (() => {
          const ps = scannedForProduct(adjustLine.product_id);
          const over = adjustLine.shipped - adjustLine.ordered;
          return (
            <div className="og-modal-form" style={{ minWidth: '540px' }}>
              <p className="og-modal-note">
                Shipped <b>{adjustLine.shipped.toLocaleString()}</b> vs ordered <b>{adjustLine.ordered.toLocaleString()}</b>
                {over > 0
                  ? <> — <b style={{ color: 'var(--color-warning-dark)' }}>{over.toLocaleString()} over</b>.</>
                  : <> — <b style={{ color: 'var(--color-success-dark)' }}>on target</b>.</>}
                {' '}<b>Remove</b> pulls a whole pallet off the truck (back to stock).
                To keep part of a pallet, lower its <b>Ship</b> count — the rest returns to
                the Partials rack. Whole cases only.
              </p>
              <div className="og-scroll" style={{ maxHeight: '340px' }}>
                <table className="og-table">
                  <thead>
                    <tr><th>Licence</th><th>Lot</th><th className="num">On truck</th><th>Ship</th><th></th></tr>
                  </thead>
                  <tbody>
                    {ps.map(p => {
                      const v = adjustVals[p.pallet_id] ?? '';
                      const n = Number(v);
                      const ret = Number.isInteger(n) && n >= 0 && n <= p.cases ? p.cases - n : null;
                      const changed = Number.isInteger(n) && n >= 1 && n < p.cases;
                      return (
                        <tr key={p.pallet_id}>
                          <td className="mono">{p.licence_number}</td>
                          <td className="mono">{p.lot_number}</td>
                          <td className="num">{p.cases}</td>
                          <td>
                            <input type="number" min="1" max={p.cases} value={v} style={{ width: '80px' }}
                                   onChange={(e) => setAdjustVals(m => ({ ...m, [p.pallet_id]: e.target.value }))} />
                            {ret !== null && ret > 0 && (
                              <span className="og-hint" style={{ marginLeft: '8px' }}>{ret} → floor</span>
                            )}
                          </td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <button className="og-btn og-btn-primary" disabled={!changed} onClick={() => saveAdjust(p)}>Save</button>
                            <button className="og-btn og-btn-danger-ghost" style={{ marginLeft: '6px' }} onClick={() => removePallet(p)}>Remove</button>
                          </td>
                        </tr>
                      );
                    })}
                    {!ps.length && <tr><td colSpan={5} className="empty">No scanned pallets for this product yet.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="og-modal-actions">
                <button className="og-btn og-btn-ghost" onClick={() => setAdjustLine(null)}>Done</button>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* Manual attribution modal */}
      <Modal isOpen={!!manualLine} onClose={() => setManualLine(null)} title={`Manual attribution — ${manualLine?.product_name || ''}`}>
        <div className="og-modal-form">
          <p className="og-modal-note">
            Last resort — for cases loaded without a scannable sticker. Paperwork only;
            inventory is NOT deducted (clean up later via adjustments).
          </p>
          <label><span>Lot Number</span><input value={manual.lot_number} onChange={(e) => setManual(p => ({ ...p, lot_number: e.target.value }))} placeholder="e.g. MP17526L1" /></label>
          <div className="row2">
            <label><span>Cases</span><input type="number" min="0" value={manual.cases} onChange={(e) => setManual(p => ({ ...p, cases: e.target.value }))} /></label>
            <label><span>Reason</span><input value={manual.reason} onChange={(e) => setManual(p => ({ ...p, reason: e.target.value }))} placeholder="e.g. no sticker" /></label>
          </div>
          <div className="og-modal-actions">
            <button className="og-btn og-btn-primary" onClick={submitManual}>Add</button>
            <button className="og-btn og-btn-ghost" onClick={() => setManualLine(null)}>Cancel</button>
          </div>
        </div>
      </Modal>

      {/* Void & regenerate modal */}
      <Modal isOpen={voidOpen} onClose={() => setVoidOpen(false)} title="Void Documents">
        <div className="og-modal-form">
          <p className="og-modal-note">
            This voids the printed Packing Slip and BOL. The BOL number is <strong>burned</strong> —
            regeneration gets a fresh number. The voided document is archived for audit.
          </p>
          <label><span>Reason <span className="required">*</span></span>
            <input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="e.g. wrong seal number" autoFocus /></label>
          <div className="og-modal-actions">
            <button className="og-btn og-btn-primary" onClick={submitVoid}>Void Documents</button>
            <button className="og-btn og-btn-ghost" onClick={() => setVoidOpen(false)}>Cancel</button>
          </div>
        </div>
      </Modal>

      {/* Generate docs modal */}
      <Modal isOpen={!!docForm} onClose={() => setDocForm(null)} title="Seal & Generate Documents">
        {docForm && (
          <div className="og-modal-form">
            <div className="row2">
              <label><span>Seal Number</span><input value={docForm.seal_number} onChange={(e) => setDocForm(p => ({ ...p, seal_number: e.target.value }))} placeholder="e.g. 0007325" autoFocus /></label>
              <label><span>Pallet Override</span>
                <input type="number" min="0" value={docForm.pallet_count_override} onChange={(e) => setDocForm(p => ({ ...p, pallet_count_override: e.target.value }))}
                  placeholder={summary?.computed_pallet_count != null ? `auto — ${summary.computed_pallet_count} pallets` : 'auto'} />
                <span className="og-hint" style={{ marginTop: '4px' }}>
                  Leave blank to use the auto count{summary?.computed_pallet_count != null ? ` (${summary.computed_pallet_count} pallets)` : ''} on the BOL.
                </span></label>
            </div>
            <label className="toggle-label" style={{ flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
              <input type="checkbox" checked={docForm.time_out} onChange={(e) => setDocForm(p => ({ ...p, time_out: e.target.checked }))} />
              <span style={{ textTransform: 'none', letterSpacing: 0 }}>Set time-out to now (truck leaving)</span>
            </label>
            <div className="og-modal-actions">
              <button className="og-btn og-btn-primary" onClick={submitDocs}>Generate &amp; Lock</button>
              <button className="og-btn og-btn-ghost" onClick={() => setDocForm(null)}>Cancel</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default ShipOutOrderDetail;
