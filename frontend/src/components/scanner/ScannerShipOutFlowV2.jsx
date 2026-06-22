import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../../api/client';
import ScannerLayout from './ScannerLayout';
import ScanFeedback from './ScanFeedback';
import LicenceDisplay from './LicenceDisplay';
import { isValidLicenceFormat, playSuccessTone, playErrorTone } from '../../utils/scannerFeedback';
import {
  Truck, Scan, CheckCircle2, AlertTriangle, XCircle, ChevronRight,
  Package, MapPin, Hash, Send, RefreshCw, Keyboard, Ban, ArrowRight,
} from 'lucide-react';
import './ScannerShipOutFlow.css';

const POLL_INTERVAL = 4000;

/**
 * Lot-level ship-out scanner (v2).
 *
 * Differences from v1:
 *   - Server returns a per-line / per-lot / per-row tree of pallets rather
 *     than a flat planned list. The forklift can scan ANY pallet whose
 *     full licence matches the order's product.
 *   - Soft totals: lots are advisory. Over-pulls and off-plan (non-FIFO) lots
 *     are accepted (server flags `is_overage` / `lot_hint` as a heads-up).
 *     Whole pallets are pulled by default — a partial pull only happens when
 *     the forklift explicitly sends `cases_to_consume`.
 *   - "Remove" on a picked pallet takes it back off the order (mistake →
 *     back to stock; leaker → on hold) via the unscan endpoint.
 *   - "Change lot" opens a reversible lot picker (all lots, oldest first) and
 *     retargets the line's outstanding cases — fully reversible.
 *   - "Not accessible" per row is a local visual aid only.
 */
const ScannerShipOutFlowV2 = () => {
  const navigate = useNavigate();

  const [step, setStep] = useState('select');
  const [transfers, setTransfers] = useState([]);
  const [selectedTransfer, setSelectedTransfer] = useState(null);
  const [view, setView] = useState(null); // ScannerTransferView from backend
  const [loading, setLoading] = useState(false);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [licenceInput, setLicenceInput] = useState('');
  const [scanFeedback, setScanFeedback] = useState(null);
  const [overlay, setOverlay] = useState(null);
  const [manualKeyboard, setManualKeyboard] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitNotes, setSubmitNotes] = useState('');
  const [pollTimer, setPollTimer] = useState(null);

  // Per-line, per-lot blocked row tracking (forklift hit "not accessible").
  // Shape: { [lineId]: { [lotNumber]: Set<rowId> } }
  const [blockedRowsByLine, setBlockedRowsByLine] = useState({});

  // Pending partial-pull confirmation (modal driver).
  const [partialPrompt, setPartialPrompt] = useState(null);
  // { licenceNumber, suggestedCases, palletCases, lineId, lotNumber, message }

  // Reversible lot picker (modal driver) — forklift opens the full lot list
  // for a line and moves outstanding cases to a chosen lot.
  const [lotPicker, setLotPicker] = useState(null);
  // { lineId, fromLot, lots: [...], loading }

  // Pending remove-a-scan (modal driver) — forklift wants to take a scanned
  // pallet back off the order (mistake, or a leaker found after scanning).
  const [removePrompt, setRemovePrompt] = useState(null);
  // { palletLicenceId, licenceNumber }

  const inputRef = useRef(null);

  const scanInputProps = {
    autoCapitalize: 'characters',
    autoCorrect: 'off',
    spellCheck: false,
  };

  const showOverlaySuccess = useCallback((message) => {
    playSuccessTone();
    setOverlay({ kind: 'success', message });
  }, []);
  const showOverlayError = useCallback((message) => {
    playErrorTone();
    setOverlay({ kind: 'error', message });
  }, []);
  const dismissOverlay = useCallback(() => setOverlay(null), []);

  // ── Data loaders ──────────────────────────────────────────────────────────

  const loadOrders = useCallback(async () => {
    setLoadingOrders(true);
    try {
      // Forklift can only list pending ship-outs; backend enforces both
      // params for this role.
      const r = await apiClient.get('/inventory/transfers', {
        params: { status: 'pending', transfer_type: 'shipped-out' },
      });
      setTransfers(r.data || []);
    } catch (err) {
      console.error('loadOrders failed:', err.response?.data || err);
      setTransfers([]);
    } finally {
      setLoadingOrders(false);
    }
  }, []);

  useEffect(() => { loadOrders(); }, [loadOrders]);

  const loadView = useCallback(async (transferId) => {
    try {
      const r = await apiClient.get(`/inventory/transfers/${transferId}/scanner-view`);
      setView(r.data);
    } catch (err) {
      const msg = err.response?.data?.detail || 'Failed to load scanner view';
      setScanFeedback({ type: 'err', msg });
    }
  }, []);

  const startPolling = useCallback((transferId) => {
    const id = setInterval(() => loadView(transferId), POLL_INTERVAL);
    setPollTimer(id);
    return id;
  }, [loadView]);

  const stopPolling = useCallback(() => {
    if (pollTimer) {
      clearInterval(pollTimer);
      setPollTimer(null);
    }
  }, [pollTimer]);

  useEffect(() => {
    return () => { if (pollTimer) clearInterval(pollTimer); };
  }, [pollTimer]);

  const selectTransfer = async (transfer) => {
    setSelectedTransfer(transfer);
    setStep('pick');
    setScanFeedback(null);
    setBlockedRowsByLine({});
    await loadView(transfer.id);
    startPolling(transfer.id);
    setTimeout(() => inputRef.current?.focus(), 300);
  };

  // Keep scan input focused for HID scanners.
  useEffect(() => {
    if (manualKeyboard || step !== 'pick') return;
    const id = requestAnimationFrame(() => {
      // Don't steal focus while the operator is typing in another field (e.g.
      // the notes textarea) — the 4s poll re-runs this effect via `view`.
      const active = document.activeElement;
      const typing = active && active !== inputRef.current &&
        (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
      if (typing) return;
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [step, overlay, scanFeedback, manualKeyboard, view]);

  // ── Scan handler ──────────────────────────────────────────────────────────

  const callScanPick = async (licenceNumber, casesToConsume) => {
    return apiClient.post(
      `/inventory/transfers/${selectedTransfer.id}/scan-pick-v2`,
      {
        licence_number: licenceNumber,
        ...(casesToConsume != null ? { cases_to_consume: casesToConsume } : {}),
      }
    );
  };

  const handleScan = async (e) => {
    e?.preventDefault?.();
    const lic = licenceInput.trim();
    if (!lic || !selectedTransfer) return;
    setScanFeedback(null);

    if (!isValidLicenceFormat(lic)) {
      setLicenceInput('');
      const msg = 'Not a pallet licence — did you scan a row or FCC code?';
      setScanFeedback({ type: 'err', msg });
      showOverlayError(msg);
      setTimeout(() => inputRef.current?.focus(), 100);
      return;
    }

    setLoading(true);
    try {
      const r = await callScanPick(lic, null);
      handleScanResponse(r.data, lic);
    } catch (err) {
      const msg = err.response?.data?.detail || 'Scan failed';
      setScanFeedback({ type: 'err', msg });
      showOverlayError(msg);
    } finally {
      setLoading(false);
      setLicenceInput('');
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  };

  const handleScanResponse = (data, lic) => {
    // Partial confirmation needed
    if (data.needs_partial_confirm) {
      setPartialPrompt({
        licenceNumber: lic,
        suggestedCases: data.suggested_partial_cases,
        lineId: data.line_id,
        message: data.message,
      });
      return;
    }

    if (!data.ok) {
      // Wrong-lot pulls are no longer rejected (lots are advisory) — the server
      // accepts them with a lot_hint. Remaining rejects are hard errors
      // (not found, on hold, wrong warehouse/product).
      const msg = data.message || `Pallet "${lic}" not accepted.`;
      setScanFeedback({ type: 'err', msg });
      showOverlayError(msg);
      return;
    }

    // Successful scan.
    let msg = data.message || `✓ ${lic}`;
    if (data.pick?.was_partial) {
      msg = `↳ Partial pull: ${data.pick.cases_consumed} cs. Remaining ${data.partial_pallet_remaining} cs → Partials row.`;
    }
    // Over-pull or an off-plan (non-FIFO) lot is accepted, but flag it as a
    // non-blocking heads-up rather than a clean success.
    const advisory = data.is_overage || !!data.lot_hint;
    setScanFeedback({ type: advisory ? 'warn' : 'ok', msg });
    showOverlaySuccess(msg);
    loadView(selectedTransfer.id);
  };

  // Confirm a partial pull
  const confirmPartialPull = async () => {
    if (!partialPrompt) return;
    setLoading(true);
    try {
      const r = await callScanPick(partialPrompt.licenceNumber, partialPrompt.suggestedCases);
      setPartialPrompt(null);
      handleScanResponse(r.data, partialPrompt.licenceNumber);
    } catch (err) {
      const msg = err.response?.data?.detail || 'Partial pull failed';
      setScanFeedback({ type: 'err', msg });
      showOverlayError(msg);
      setPartialPrompt(null);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  };

  // Toggle a row's "not accessible" mark. Purely local visual aid — the
  // forklift just picks a different lot via "Change lot" when a rack is blocked.
  const toggleRowBlocked = (lineId, lotNumber, rowId) => {
    setBlockedRowsByLine((prev) => {
      const next = { ...prev };
      const lineMap = { ...(next[lineId] || {}) };
      const lotSet = new Set(lineMap[lotNumber] || []);
      const key = rowId || '';
      if (lotSet.has(key)) {
        lotSet.delete(key);
      } else {
        lotSet.add(key);
      }
      if (lotSet.size === 0) {
        delete lineMap[lotNumber];
      } else {
        lineMap[lotNumber] = Array.from(lotSet);
      }
      if (Object.keys(lineMap).length === 0) {
        delete next[lineId];
      } else {
        next[lineId] = lineMap;
      }
      return next;
    });
  };

  // Open the reversible lot picker for a line — fetches ALL lots (oldest
  // first, recommended/current flagged) so the forklift can move to any lot,
  // including one previously left.
  const openLotPicker = async (lineId, fromLot) => {
    setLotPicker({ lineId, fromLot, lots: [], loading: true });
    try {
      const r = await apiClient.get(
        `/inventory/transfers/${selectedTransfer.id}/lots-for-line`,
        { params: { line_id: lineId } }
      );
      setLotPicker({ lineId, fromLot, lots: r.data?.lots || [], loading: false });
    } catch (err) {
      const msg = err.response?.data?.detail || 'Could not load lots';
      setScanFeedback({ type: 'err', msg });
      showOverlayError(msg);
      setLotPicker(null);
    }
  };

  // Move the line's outstanding cases from the current lot to the chosen lot.
  const confirmRetarget = async (toLot) => {
    if (!lotPicker) return;
    setLoading(true);
    try {
      const r = await apiClient.post(
        `/inventory/transfers/${selectedTransfer.id}/retarget-lot`,
        { line_id: lotPicker.lineId, from_lot: lotPicker.fromLot, to_lot: toLot,
          reason: 'Forklift changed lot at load time' }
      );
      setLotPicker(null);
      await loadView(selectedTransfer.id);
      const msg = r.data?.message || `Moved to lot ${toLot}.`;
      setScanFeedback({ type: 'warn', msg });
    } catch (err) {
      const msg = err.response?.data?.detail || 'Lot change failed';
      setScanFeedback({ type: 'err', msg });
      showOverlayError(msg);
    } finally {
      setLoading(false);
    }
  };

  // Remove a pallet already scanned onto this order. Opened from the picked
  // pallet's "Remove" button; the forklift then chooses why.
  const requestRemovePick = (pallet) => {
    setRemovePrompt({
      palletLicenceId: pallet.pallet_licence_id,
      licenceNumber: pallet.licence_number,
    });
  };

  const confirmRemovePick = async (reason) => {
    if (!removePrompt) return;
    setLoading(true);
    try {
      const r = await apiClient.post(
        `/inventory/transfers/${selectedTransfer.id}/unscan-pick-v2`,
        { pallet_licence_id: removePrompt.palletLicenceId, reason }
      );
      setRemovePrompt(null);
      await loadView(selectedTransfer.id);
      const msg = r.data?.message || 'Pallet removed from order.';
      setScanFeedback({ type: 'warn', msg });
      showOverlaySuccess(msg);
    } catch (err) {
      const msg = err.response?.data?.detail || 'Remove failed';
      setScanFeedback({ type: 'err', msg });
      showOverlayError(msg);
      setRemovePrompt(null);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  };

  // ── Submit ────────────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await apiClient.post(
        `/inventory/transfers/${selectedTransfer.id}/forklift-submit`,
        { notes: submitNotes || null, skipped_pallet_ids: [] }
      );
      stopPolling();
      setStep('done');
    } catch (err) {
      setScanFeedback({ type: 'err', msg: err.response?.data?.detail || 'Submit failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // ── Derived ───────────────────────────────────────────────────────────────

  const totalRemaining = useMemo(() => {
    if (!view) return 0;
    return (view.lines || []).reduce((s, l) => s + (l.cases_remaining || 0), 0);
  }, [view]);

  const allDone = view && totalRemaining <= 0;

  // ── Render ────────────────────────────────────────────────────────────────

  if (step === 'select') {
    return (
      <ScannerLayout title="Ship-out Picking" showBack>
        <div className="sso-screen">
          <div className="sso-header-row">
            <p className="sso-subtitle">Select an order to pick</p>
            <button type="button" className="sso-refresh-btn" onClick={loadOrders} disabled={loadingOrders}>
              <RefreshCw size={16} className={loadingOrders ? 'sso-spin' : ''} />
            </button>
          </div>
          {transfers.length === 0 ? (
            <div className="sso-empty">
              <Truck size={40} opacity={0.3} />
              <p>{loadingOrders ? 'Loading orders…' : 'No pending ship-out orders.'}</p>
            </div>
          ) : (
            <div className="sso-order-list">
              {transfers.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`sso-order-card${t.forklift_submitted_at ? ' sso-order-card--submitted' : ''}`}
                  onClick={() => selectTransfer(t)}
                >
                  <div className="sso-order-icon"><Truck size={28} /></div>
                  <div className="sso-order-info">
                    <strong>Order #{t.order_number || t.id.slice(-8)}</strong>
                    <span>{t.quantity} cases · {(t.lines || []).length} line{(t.lines || []).length !== 1 ? 's' : ''}</span>
                    {t.forklift_submitted_at && <span className="sso-submitted-badge">Submitted</span>}
                  </div>
                  <ChevronRight size={20} className="sso-chevron" />
                </button>
              ))}
            </div>
          )}
        </div>
      </ScannerLayout>
    );
  }

  if (step === 'done') {
    return (
      <ScannerLayout title="Pick Submitted" showBack>
        <div className="sso-screen sso-done-screen">
          <div className="sso-done-icon">
            <CheckCircle2 size={72} color="#22c55e" />
          </div>
          <h2 className="sso-done-title">Pick list submitted!</h2>
          <p className="sso-done-sub">
            Order #{selectedTransfer?.order_number} has been sent for approval.
          </p>
          <button
            type="button"
            className="sso-primary-btn"
            onClick={() => { stopPolling(); navigate('/forklift'); }}
          >
            Back to Home
          </button>
        </div>
      </ScannerLayout>
    );
  }

  return (
    <ScannerLayout
      title={`Pick: ${selectedTransfer?.order_number || 'Order'}`}
      showBack
      onBack={() => { stopPolling(); setStep('select'); }}
    >
      <div className="sso-screen sso-pick-screen">

        {/* Order progress */}
        <div className="sso-progress-bar-wrap">
          <div className="sso-progress-counts">
            <span className="sso-count-scanned">
              {Math.max(0, (selectedTransfer?.quantity || 0) - totalRemaining)} cases picked
            </span>
            <span className="sso-count-total">of {selectedTransfer?.quantity || 0}</span>
          </div>
          <div className="sso-progress-track">
            <div
              className="sso-progress-fill"
              style={{
                width: selectedTransfer?.quantity
                  ? `${((selectedTransfer.quantity - totalRemaining) / selectedTransfer.quantity) * 100}%`
                  : '0%',
              }}
            />
          </div>
        </div>

        {/* Scan input */}
        <form onSubmit={handleScan} className="sso-scan-form">
          <input
            ref={inputRef}
            type="text"
            value={licenceInput}
            onChange={(e) => setLicenceInput(e.target.value)}
            placeholder="Scan pallet licence"
            className="sso-scan-input"
            autoComplete="off"
            autoFocus
            {...scanInputProps}
          />
          <button type="submit" disabled={loading || !licenceInput.trim()} className="sso-scan-btn">
            {loading ? <RefreshCw size={20} className="sso-spin" /> : <Scan size={20} />}
          </button>
        </form>
        <button
          type="button"
          className="scanner-receipt-manual-link"
          onClick={() => setManualKeyboard((v) => !v)}
          style={{ marginTop: '0.2rem' }}
        >
          <Keyboard size={14} style={{ verticalAlign: '-2px', marginRight: '4px' }} />
          {manualKeyboard ? 'Hide keyboard (use scanner)' : 'Type manually'}
        </button>

        {scanFeedback && (
          <div className={`sso-feedback sso-feedback--${scanFeedback.type}`}>
            {scanFeedback.type === 'ok' && <CheckCircle2 size={18} />}
            {scanFeedback.type === 'warn' && <AlertTriangle size={18} />}
            {scanFeedback.type === 'err' && <XCircle size={18} />}
            <span>{scanFeedback.msg}</span>
          </div>
        )}

        {view?.partial_pallet_row && (
          <div style={{
            padding: '6px 10px',
            fontSize: '12px',
            color: '#374151',
            background: '#eff6ff',
            borderLeft: '3px solid #1e40af',
            borderRadius: '4px',
            marginBottom: '8px',
          }}>
            Partials row: <strong>{view.partial_pallet_row.row_name}</strong>
          </div>
        )}

        {/* Tree: lines → lots → rows → pallets */}
        <div className="sso-picklist">
          {(view?.lines || []).map((line) => (
            <LineCard
              key={line.line_id}
              line={line}
              blockedRowsForLine={blockedRowsByLine[line.line_id] || {}}
              onToggleRowBlocked={toggleRowBlocked}
              onOpenLotPicker={openLotPicker}
              onRemovePick={requestRemovePick}
            />
          ))}
        </div>

        {/* Submit section */}
        <div className="sso-submit-section">
          {!allDone && (
            <p className="sso-pending-note">
              {totalRemaining.toLocaleString()} cases remaining across all lines.
            </p>
          )}
          {allDone && (
            <textarea
              className="sso-notes-input"
              placeholder="Optional notes for approver…"
              value={submitNotes}
              onChange={(e) => setSubmitNotes(e.target.value)}
              rows={2}
            />
          )}
          <button
            type="button"
            className="sso-primary-btn"
            onClick={() => setStep('submit')}
            disabled={submitting || !allDone}
          >
            <Send size={18} />
            Submit for Approval
          </button>
        </div>
      </div>

      <ScanFeedback {...(overlay || {})} onDismiss={dismissOverlay} />

      {/* Partial confirmation modal */}
      {partialPrompt && (
        <div className="sso-except-overlay">
          <div className="sso-except-dialog">
            <AlertTriangle size={32} color="#f59e0b" />
            <h3>Partial pull?</h3>
            <p>{partialPrompt.message}</p>
            <p style={{ fontSize: '13px', color: '#6b7280' }}>
              Pull <strong>{partialPrompt.suggestedCases}</strong> cases off
              this pallet. The remainder will be moved to the Partials row.
            </p>
            <div className="sso-dialog-actions">
              <button
                type="button"
                className="sso-secondary-btn"
                onClick={() => { setPartialPrompt(null); setTimeout(() => inputRef.current?.focus(), 100); }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="sso-primary-btn"
                onClick={confirmPartialPull}
                disabled={loading}
              >
                {loading ? 'Working…' : `Confirm partial (${partialPrompt.suggestedCases} cs)`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reversible lot picker modal */}
      {lotPicker && (
        <div className="sso-except-overlay">
          <div className="sso-except-dialog" style={{ maxWidth: '420px' }}>
            <ArrowRight size={32} color="#1e40af" />
            <h3>Change lot</h3>
            <p style={{ fontSize: '13px', color: '#6b7280' }}>
              Move the remaining cases off lot <strong>{lotPicker.fromLot}</strong> to
              another lot. Oldest is recommended; you can move back anytime.
            </p>
            {lotPicker.loading ? (
              <p style={{ color: '#6b7280' }}>Loading lots…</p>
            ) : (
              <div style={{ width: '100%', maxHeight: '50vh', overflowY: 'auto' }}>
                {lotPicker.lots.filter((l) => l.lot_number !== lotPicker.fromLot).length === 0 && (
                  <p style={{ color: '#6b7280', fontSize: '13px' }}>No other lots available.</p>
                )}
                {lotPicker.lots
                  .filter((l) => l.lot_number !== lotPicker.fromLot)
                  .map((l) => {
                    const disabled = loading || l.cases_available <= 0;
                    return (
                      <button
                        key={l.lot_number}
                        type="button"
                        onClick={() => confirmRetarget(l.lot_number)}
                        disabled={disabled}
                        style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          width: '100%', textAlign: 'left', gap: '8px',
                          padding: '8px 10px', marginBottom: '6px',
                          border: `1px solid ${l.is_recommended ? '#16a34a' : '#e5e7eb'}`,
                          borderRadius: '6px',
                          background: disabled ? '#f3f4f6' : 'white',
                          cursor: disabled ? 'not-allowed' : 'pointer',
                          opacity: disabled ? 0.6 : 1,
                        }}
                      >
                        <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#1e40af' }}>
                          Lot {l.lot_number}
                          {l.is_recommended && (
                            <span style={{ marginLeft: '6px', background: '#dcfce7', color: '#15803d', borderRadius: '4px', padding: '1px 5px', fontSize: '10px', fontWeight: 700 }}>oldest</span>
                          )}
                          {l.is_current && (
                            <span style={{ marginLeft: '6px', background: '#eff6ff', color: '#1d4ed8', borderRadius: '4px', padding: '1px 5px', fontSize: '10px', fontWeight: 700 }}>current</span>
                          )}
                        </span>
                        <span style={{ fontSize: '12px', color: '#475569' }}>
                          {Math.round(l.cases_available).toLocaleString()} cs · {l.pallets_available} pl
                        </span>
                      </button>
                    );
                  })}
              </div>
            )}
            <div className="sso-dialog-actions">
              <button
                type="button"
                className="sso-secondary-btn"
                onClick={() => { setLotPicker(null); setTimeout(() => inputRef.current?.focus(), 100); }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Remove-a-scan reason modal */}
      {removePrompt && (
        <div className="sso-except-overlay">
          <div className="sso-except-dialog">
            <XCircle size={32} color="#dc2626" />
            <h3>Remove this pallet?</h3>
            <p style={{ fontSize: '13px', color: '#6b7280' }}>
              Pallet <strong>{removePrompt.licenceNumber}</strong> will come off
              this order. Why are you removing it?
            </p>
            <div className="sso-dialog-actions" style={{ flexDirection: 'column', gap: '8px' }}>
              <button
                type="button"
                className="sso-secondary-btn"
                onClick={() => confirmRemovePick('wrong_pallet')}
                disabled={loading}
                title="Scanned by mistake — pallet goes back into shippable stock"
              >
                {loading ? 'Working…' : 'Wrong pallet (back to stock)'}
              </button>
              <button
                type="button"
                className="sso-primary-btn"
                onClick={() => confirmRemovePick('leaker_damaged')}
                disabled={loading}
                title="Damaged/leaker — pallet goes on hold for supervisor review"
              >
                {loading ? 'Working…' : 'Damaged / leaker (put on hold)'}
              </button>
              <button
                type="button"
                className="sso-secondary-btn"
                onClick={() => { setRemovePrompt(null); setTimeout(() => inputRef.current?.focus(), 100); }}
                disabled={loading}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Submit confirmation */}
      {step === 'submit' && (
        <div className="sso-except-overlay">
          <div className="sso-except-dialog">
            <Send size={32} color="#1a472a" />
            <h3>Confirm submission</h3>
            <p>All lines fully picked. Submit for supervisor approval?</p>
            <textarea
              className="sso-notes-input"
              placeholder="Notes for approver (optional)…"
              value={submitNotes}
              onChange={(e) => setSubmitNotes(e.target.value)}
              rows={2}
            />
            <div className="sso-dialog-actions">
              <button type="button" className="sso-secondary-btn" onClick={() => setStep('pick')}>
                Back
              </button>
              <button type="button" className="sso-primary-btn" onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Submitting…' : 'Confirm Submit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ScannerLayout>
  );
};

// ── LineCard: one product line with its lots and rows ───────────────────────

const LineCard = ({ line, blockedRowsForLine, onToggleRowBlocked, onOpenLotPicker, onRemovePick }) => {
  return (
    <div style={{ border: '1.5px solid #e5e7eb', borderRadius: '8px', padding: '8px', marginBottom: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
        <strong style={{ color: '#1e40af', fontSize: '14px' }}>
          {line.product_name || 'Unknown'}
          {line.product_short_code && (
            <span style={{ color: '#6b7280', marginLeft: '6px', fontWeight: 500 }}>
              ({line.product_short_code})
            </span>
          )}
        </strong>
        <span style={{ fontSize: '12px', color: '#475569' }}>
          {(line.cases_requested - line.cases_remaining).toLocaleString()} /{' '}
          {line.cases_requested.toLocaleString()} cs
        </span>
      </div>

      {(line.lots || []).length === 0 ? (
        <div style={{ fontSize: '12px', color: '#16a34a', padding: '6px' }}>
          ✓ Line complete
        </div>
      ) : (
        (line.lots || []).map((lot) => {
          const lotBlocked = new Set(blockedRowsForLine[lot.lot_number] || []);
          return (
            <LotBlock
              key={lot.lot_number}
              lot={lot}
              lineId={line.line_id}
              lotBlockedRowIds={lotBlocked}
              onToggleRowBlocked={onToggleRowBlocked}
              onOpenLotPicker={onOpenLotPicker}
              onRemovePick={onRemovePick}
            />
          );
        })
      )}
    </div>
  );
};

const LotBlock = ({ lot, lineId, lotBlockedRowIds, onToggleRowBlocked, onOpenLotPicker, onRemovePick }) => {
  return (
    <div style={{
      background: '#f9fafb',
      borderRadius: '6px',
      padding: '6px 8px',
      marginBottom: '5px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px', gap: '6px' }}>
        <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#1e40af', fontSize: '13px' }}>
          Lot {lot.lot_number}
        </span>
        <span style={{ fontSize: '12px', color: '#475569', flex: 1, textAlign: 'right' }}>
          {lot.cases_remaining.toLocaleString()} cs remaining
        </span>
        <button
          type="button"
          onClick={() => onOpenLotPicker(lineId, lot.lot_number)}
          style={{
            background: '#eff6ff',
            border: '1px solid #93c5fd',
            color: '#1d4ed8',
            padding: '2px 8px',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '11px',
            fontWeight: 600,
          }}
          title="Move the remaining cases to a different lot (reversible)"
        >
          Change lot
        </button>
      </div>
      {(lot.rows || []).map((row) => {
        const isBlocked = row.is_blocked || lotBlockedRowIds.has(row.row_id || '');
        return (
          <RowBlock
            key={row.row_id || row.row_name}
            row={row}
            lotNumber={lot.lot_number}
            lineId={lineId}
            isBlocked={isBlocked}
            onToggleRowBlocked={onToggleRowBlocked}
            onRemovePick={onRemovePick}
          />
        );
      })}
    </div>
  );
};

const RowBlock = ({ row, lotNumber, lineId, isBlocked, onToggleRowBlocked, onRemovePick }) => {
  const isEmpty = (row.pallets_total || 0) === 0;
  return (
    <div style={{
      padding: '5px 6px',
      marginBottom: '3px',
      border: '1px solid #e5e7eb',
      borderRadius: '4px',
      background: isEmpty ? '#dcfce7' : isBlocked ? '#fef2f2' : '#ffffff',
      opacity: isBlocked ? 0.65 : 1,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 600, fontSize: '12px', color: isEmpty ? '#16a34a' : '#374151' }}>
          <MapPin size={11} style={{ verticalAlign: '-1px', marginRight: '3px' }} />
          {row.row_name}
          {isEmpty && ' ✓'}
        </span>
        <span style={{ fontSize: '11px', color: '#6b7280' }}>
          {row.pallets_total} pl · {row.cases_total} cs
        </span>
        {!isEmpty && (
          <button
            type="button"
            onClick={() => onToggleRowBlocked(lineId, lotNumber, row.row_id || '')}
            style={{
              background: isBlocked ? '#dcfce7' : 'none',
              border: `1px solid ${isBlocked ? '#16a34a' : '#fca5a5'}`,
              color: isBlocked ? '#15803d' : '#dc2626',
              padding: '1px 6px',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '11px',
              marginLeft: '6px',
              fontWeight: 600,
            }}
            title={isBlocked ? 'Mark this row accessible again' : 'Mark this row inaccessible'}
          >
            {isBlocked ? (
              <>↩ Undo</>
            ) : (
              <><Ban size={11} style={{ verticalAlign: '-1px' }} /> Not accessible</>
            )}
          </button>
        )}
      </div>
      {(row.pallets || []).length > 0 && (
        <div style={{ marginTop: '3px' }}>
          {row.pallets.map((p) => (
            <div
              key={p.pallet_licence_id}
              style={{
                display: 'flex',
                gap: '6px',
                alignItems: 'center',
                fontSize: '11px',
                padding: '2px 4px',
                color: p.is_picked ? '#166534' : '#374151',
                background: p.is_picked ? '#dcfce7' : 'transparent',
                borderRadius: p.is_picked ? '3px' : '0',
              }}
            >
              {p.is_picked ? (
                <CheckCircle2 size={12} color="#16a34a" />
              ) : (
                <Hash size={10} />
              )}
              <span style={{
                fontFamily: 'monospace',
                fontWeight: 600,
                textDecoration: p.is_picked ? 'line-through' : 'none',
                color: p.is_picked ? '#15803d' : 'inherit',
              }}>
                <LicenceDisplay licence={p.licence_number} />
              </span>
              <span style={{ color: '#9ca3af' }}>(lot {p.lot_number})</span>
              <span style={{ marginLeft: 'auto', color: p.is_picked ? '#15803d' : '#475569' }}>
                <Package size={10} style={{ verticalAlign: '-1px' }} />{' '}
                {p.is_picked
                  ? `✓ pulled ${p.cases_consumed ?? p.cases} cs${p.was_partial ? ' (partial)' : ''}`
                  : `${p.cases} cs`}
              </span>
              {p.is_picked && !p.was_partial && onRemovePick && (
                <button
                  type="button"
                  onClick={() => onRemovePick(p)}
                  style={{
                    background: 'none',
                    border: '1px solid #fca5a5',
                    color: '#dc2626',
                    padding: '0px 5px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '10px',
                    fontWeight: 600,
                    marginLeft: '4px',
                  }}
                  title="Remove this pallet from the order (mistake or leaker)"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ScannerShipOutFlowV2;
