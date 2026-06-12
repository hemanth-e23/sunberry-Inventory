import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../../api/client';
import ScannerLayout from './ScannerLayout';
import ScanFeedback from './ScanFeedback';
import LicenceDisplay from './LicenceDisplay';
import { isValidLicenceFormat, playSuccessTone, playErrorTone } from '../../utils/scannerFeedback';
import { SHIP_OUT_SCAN_REASON } from '../../constants';
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
 *     full licence matches an open lot allocation on the order.
 *   - On a partial-pull (pallet has more cases than the line needs), the
 *     server returns `needs_partial_confirm` with a suggested amount; the
 *     forklift confirms and we re-submit with `cases_to_consume`.
 *   - On a scanned pallet from the wrong lot (right product), the server
 *     returns `WRONG_LOT_NEEDS_SWAP` with a `swap_suggestion`; the forklift
 *     can swap the line's lot via the lot-escape-hatch endpoint.
 *   - "Not accessible" button per row: marks the row blocked locally, and
 *     when all rows of a lot are blocked auto-triggers the escape hatch.
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

  // Pending wrong-lot swap (modal driver) — pallet is in this scanned lot,
  // but the order has a different lot allocated; user confirms swap.
  const [swapPrompt, setSwapPrompt] = useState(null);
  // { licenceNumber, scannedLot, blockedLot, lineId, message }

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
      if (data.reject_reason === SHIP_OUT_SCAN_REASON.WRONG_LOT_NEEDS_SWAP) {
        // Offer the lot swap. We need to know which lot to swap OUT — that's
        // any currently-open lot on a matching-product line. Find one from
        // the view.
        const scannedLot = data.swap_suggestion?.lot_number;
        const blockedLot = pickFirstOpenLotForProductFromView(view, data.swap_suggestion);
        if (scannedLot && blockedLot) {
          setSwapPrompt({
            licenceNumber: lic,
            scannedLot,
            blockedLot: blockedLot.lotNumber,
            lineId: blockedLot.lineId,
            message: data.message,
          });
          return;
        }
      }
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
    setScanFeedback({ type: 'ok', msg });
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

  // Confirm a lot swap (forklift accepted that this is the right next lot)
  const confirmSwap = async () => {
    if (!swapPrompt) return;
    setLoading(true);
    try {
      // First swap the lot, then re-scan the same pallet to actually pick it.
      await apiClient.post(
        `/inventory/transfers/${selectedTransfer.id}/lot-escape-hatch`,
        {
          line_id: swapPrompt.lineId,
          blocked_lot_number: swapPrompt.blockedLot,
          blocked_row_ids: [],
          reason: `Forklift swap to scanned lot ${swapPrompt.scannedLot}`,
        }
      );
      // Re-scan the pallet so the line records the pick on the new lot
      const r = await callScanPick(swapPrompt.licenceNumber, null);
      setSwapPrompt(null);
      handleScanResponse(r.data, swapPrompt.licenceNumber);
    } catch (err) {
      const msg = err.response?.data?.detail || 'Swap failed';
      setScanFeedback({ type: 'err', msg });
      showOverlayError(msg);
      setSwapPrompt(null);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  };

  // Toggle a row's "not accessible" mark. Purely local — does NOT swap the
  // lot automatically. The forklift may later un-mark the row, OR press
  // the per-lot "Try next lot" button to explicitly escape.
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

  // Explicit escape-hatch: forklift confirms the lot is unreachable and
  // wants to swap to the next-oldest lot. Only enabled when at least one
  // row is marked blocked (UI rule).
  const swapLotToNext = async (lineId, lotNumber) => {
    const lineMap = blockedRowsByLine[lineId] || {};
    const blocked = lineMap[lotNumber] || [];
    setLoading(true);
    try {
      await apiClient.post(
        `/inventory/transfers/${selectedTransfer.id}/lot-escape-hatch`,
        {
          line_id: lineId,
          blocked_lot_number: lotNumber,
          blocked_row_ids: blocked.filter(Boolean),
          reason: 'Forklift requested swap to next lot',
        }
      );
      // Clear local blocks for this lot; new lot will surface in the view
      setBlockedRowsByLine((prev) => {
        const next = { ...prev };
        if (next[lineId]) {
          const lm = { ...next[lineId] };
          delete lm[lotNumber];
          if (Object.keys(lm).length === 0) delete next[lineId];
          else next[lineId] = lm;
        }
        return next;
      });
      await loadView(selectedTransfer.id);
      setScanFeedback({ type: 'warn', msg: `Swapped lot ${lotNumber} → next available.` });
    } catch (err) {
      const msg = err.response?.data?.detail || 'Escape hatch failed';
      setScanFeedback({ type: 'err', msg });
      showOverlayError(msg);
    } finally {
      setLoading(false);
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
              onSwapLotToNext={swapLotToNext}
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

      {/* Wrong-lot swap modal */}
      {swapPrompt && (
        <div className="sso-except-overlay">
          <div className="sso-except-dialog">
            <ArrowRight size={32} color="#1e40af" />
            <h3>Swap to scanned lot?</h3>
            <p>{swapPrompt.message}</p>
            <p style={{ fontSize: '13px', color: '#6b7280' }}>
              Order had lot <strong>{swapPrompt.blockedLot}</strong> planned.
              Scanned pallet is lot <strong>{swapPrompt.scannedLot}</strong>.
              Swap the line to the scanned lot and pick this pallet?
            </p>
            <div className="sso-dialog-actions">
              <button
                type="button"
                className="sso-secondary-btn"
                onClick={() => { setSwapPrompt(null); setTimeout(() => inputRef.current?.focus(), 100); }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="sso-primary-btn"
                onClick={confirmSwap}
                disabled={loading}
              >
                {loading ? 'Working…' : `Swap → ${swapPrompt.scannedLot}`}
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

const LineCard = ({ line, blockedRowsForLine, onToggleRowBlocked, onSwapLotToNext }) => {
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
              onSwapLotToNext={onSwapLotToNext}
            />
          );
        })
      )}
    </div>
  );
};

const LotBlock = ({ lot, lineId, lotBlockedRowIds, onToggleRowBlocked, onSwapLotToNext }) => {
  const accessibleRows = (lot.rows || []).filter(
    (r) => (r.pallets_total || 0) > 0 && !lotBlockedRowIds.has(r.row_id || '')
  );
  const hasAnyBlocked = lotBlockedRowIds.size > 0;

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
        {hasAnyBlocked && (
          <button
            type="button"
            onClick={() => onSwapLotToNext(lineId, lot.lot_number)}
            style={{
              background: '#fef3c7',
              border: '1px solid #f59e0b',
              color: '#92400e',
              padding: '2px 8px',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '11px',
              fontWeight: 600,
            }}
            title={
              accessibleRows.length > 0
                ? 'Swap anyway — there are still accessible rows in this lot'
                : 'Swap to next available lot'
            }
          >
            Try next lot
          </button>
        )}
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
          />
        );
      })}
    </div>
  );
};

const RowBlock = ({ row, lotNumber, lineId, isBlocked, onToggleRowBlocked }) => {
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// Helpers --------------------------------------------------------------------

// Given the scanner view, find a line whose product matches the scanned
// pallet's swap_suggestion AND has at least one open lot allocation. Returns
// { lineId, lotNumber } of the first open lot to swap OUT.
const pickFirstOpenLotForProductFromView = (view, swapSuggestion) => {
  if (!view || !swapSuggestion) return null;
  // We don't know the product_id directly from swap_suggestion (it carries
  // the new lot's rows). Heuristic: pick the first open lot on any line.
  // For multi-product orders this could pick the wrong line, but the server
  // will reject if the scanned pallet's product doesn't match — at which
  // point the forklift re-tries on the right line. Good enough for v1.
  for (const line of (view.lines || [])) {
    for (const lot of (line.lots || [])) {
      if (lot.cases_remaining > 0) {
        return { lineId: line.line_id, lotNumber: lot.lot_number };
      }
    }
  }
  return null;
};

export default ScannerShipOutFlowV2;
