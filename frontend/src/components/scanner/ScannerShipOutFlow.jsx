import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../../api/client';
import ScannerLayout from './ScannerLayout';
import { formatDateTime } from '../../utils/dateUtils';
import {
  Truck, Scan, CheckCircle2, Circle, AlertTriangle, XCircle,
  ChevronRight, Package, MapPin, Hash, Send, SkipForward, RefreshCw
} from 'lucide-react';
import './ScannerShipOutFlow.css';

const POLL_INTERVAL = 3000;

const ScannerShipOutFlow = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState('select'); // select | pick | submit | done
  const [transfers, setTransfers] = useState([]);
  const [selectedTransfer, setSelectedTransfer] = useState(null);
  const [pickList, setPickList] = useState([]);
  const [exceptions, setExceptions] = useState([]);
  // localSkippedIds is kept separately so polling can't overwrite manual skips
  const [localSkippedIds, setLocalSkippedIds] = useState(new Set());
  const [licenceInput, setLicenceInput] = useState('');
  const [scanFeedback, setScanFeedback] = useState(null); // {type: 'ok'|'warn'|'err', msg}
  const [loading, setLoading] = useState(false);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [exceptDialog, setExceptDialog] = useState(null); // {licence_number} - for not-on-list scans
  const [submitNotes, setSubmitNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pollTimer, setPollTimer] = useState(null);
  const inputRef = useRef(null);

  const loadOrders = useCallback(async () => {
    setLoadingOrders(true);
    try {
      const r = await apiClient.get('/inventory/transfers', {
        params: { status: 'pending' },
      });
      const shipOut = (r.data || []).filter(
        (t) => t.transfer_type === 'shipped-out' && (t.pallet_licence_ids || []).length > 0
      );
      setTransfers(shipOut);
    } catch {
      setTransfers([]);
    } finally {
      setLoadingOrders(false);
    }
  }, []);

  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  const loadPickProgress = useCallback(async (transferId) => {
    try {
      const r = await apiClient.get(`/inventory/transfers/${transferId}/scan-progress`);
      const data = r.data;
      setPickList(data.pick_list || []);
      setExceptions(data.exceptions || []);
      if (data.forklift_submitted_at) {
        setStep('done');
      }
    } catch {
      // ignore
    }
  }, []);

  const startPolling = useCallback((transferId) => {
    const id = setInterval(() => loadPickProgress(transferId), POLL_INTERVAL);
    setPollTimer(id);
    return id;
  }, [loadPickProgress]);

  const stopPolling = useCallback(() => {
    if (pollTimer) {
      clearInterval(pollTimer);
      setPollTimer(null);
    }
  }, [pollTimer]);

  useEffect(() => {
    return () => { if (pollTimer) clearInterval(pollTimer); };
  }, [pollTimer]);

  useEffect(() => {
    if (!selectedTransfer || step !== 'pick') return;
    const onVisibility = () => {
      if (document.hidden) stopPolling();
      else startPolling(selectedTransfer.id);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [selectedTransfer, step, startPolling, stopPolling]);

  const selectTransfer = async (transfer) => {
    setSelectedTransfer(transfer);
    setStep('pick');
    setScanFeedback(null);
    setExceptions([]);
    setSubmitNotes('');
    setLocalSkippedIds(new Set());
    await loadPickProgress(transfer.id);
    startPolling(transfer.id);
    setTimeout(() => inputRef.current?.focus(), 300);
  };

  const handleScan = async (e) => {
    e?.preventDefault?.();
    const lic = licenceInput.trim();
    if (!lic || !selectedTransfer) return;
    setScanFeedback(null);
    setLoading(true);

    try {
      const r = await apiClient.post(
        `/inventory/transfers/${selectedTransfer.id}/scan-pick`,
        { licence_number: lic }
      );
      const data = r.data;

      if (!data.success) {
        setScanFeedback({ type: 'err', msg: `Pallet "${lic}" not found in system.` });
        setLicenceInput('');
        inputRef.current?.focus();
        return;
      }

      if (data.on_list) {
        setScanFeedback({ type: 'ok', msg: `✓ ${lic} — on pick list` });
        await loadPickProgress(selectedTransfer.id);
      } else {
        // Not on list — show exception dialog
        setExceptDialog({ licence_number: lic });
      }
      setLicenceInput('');
    } catch (err) {
      setScanFeedback({ type: 'err', msg: err.response?.data?.detail || 'Scan failed' });
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  };

  const dismissException = () => {
    setExceptDialog(null);
    setScanFeedback({ type: 'warn', msg: `⚠ ${exceptDialog.licence_number} — not on list, logged as exception` });
    loadPickProgress(selectedTransfer.id);
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  // Merge server pick list with locally skipped pallets
  const mergedPickList = pickList.map((p) => ({
    ...p,
    is_skipped: p.is_skipped || localSkippedIds.has(p.pallet_id),
  }));

  const scannedCount = mergedPickList.filter((p) => p.is_scanned).length;
  const skippedCount = mergedPickList.filter((p) => p.is_skipped).length;
  const totalCount = mergedPickList.length;
  const pendingCount = totalCount - scannedCount - skippedCount;
  const allDone = totalCount > 0 && pendingCount === 0;

  const handleSkipPallet = (pallet) => {
    setLocalSkippedIds((prev) => {
      const next = new Set(prev);
      next.add(pallet.pallet_id);
      return next;
    });
  };

  const handleUnskipPallet = (pallet) => {
    setLocalSkippedIds((prev) => {
      const next = new Set(prev);
      next.delete(pallet.pallet_id);
      return next;
    });
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const skippedIds = mergedPickList.filter((p) => p.is_skipped).map((p) => p.pallet_id);
      await apiClient.post(
        `/inventory/transfers/${selectedTransfer.id}/forklift-submit`,
        { notes: submitNotes || null, skipped_pallet_ids: skippedIds }
      );
      stopPolling();
      setStep('done');
    } catch (err) {
      setScanFeedback({ type: 'err', msg: err.response?.data?.detail || 'Submit failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // ── Order selection screen ──────────────────────────────────────────────────
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
              <p>{loadingOrders ? 'Loading orders…' : 'No pending ship-out orders with pick lists.'}</p>
            </div>
          ) : (
            <div className="sso-order-list">
              {transfers.map((t) => {
                const palletCount = (t.pallet_licence_ids || []).length;
                const isReady = !!t.forklift_submitted_at;
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={`sso-order-card${isReady ? ' sso-order-card--submitted' : ''}`}
                    onClick={() => selectTransfer(t)}
                  >
                    <div className="sso-order-icon">
                      <Truck size={28} />
                    </div>
                    <div className="sso-order-info">
                      <strong>Order #{t.order_number || t.id.slice(-8)}</strong>
                      <span>{t.quantity} cases &middot; {palletCount} pallet{palletCount !== 1 ? 's' : ''}</span>
                      {isReady && <span className="sso-submitted-badge">Submitted</span>}
                    </div>
                    <ChevronRight size={20} className="sso-chevron" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </ScannerLayout>
    );
  }

  // ── Done screen ─────────────────────────────────────────────────────────────
  if (step === 'done') {
    return (
      <ScannerLayout title="Pick Submitted" showBack>
        <div className="sso-screen sso-done-screen">
          <div className="sso-done-icon">
            <CheckCircle2 size={72} color="#22c55e" />
          </div>
          <h2 className="sso-done-title">Pick list submitted!</h2>
          <p className="sso-done-sub">
            Order #{selectedTransfer?.order_number} has been sent for approval.<br />
            The supervisor will review and approve the ship-out.
          </p>
          {scannedCount < totalCount && (
            <div className="sso-done-partial">
              <AlertTriangle size={18} />
              <span>{totalCount - scannedCount} pallet(s) were not scanned — noted for approver.</span>
            </div>
          )}
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

  // ── Picking screen ──────────────────────────────────────────────────────────
  const nextPending = mergedPickList.find((p) => !p.is_scanned && !p.is_skipped);

  return (
    <ScannerLayout
      title={`Pick: ${selectedTransfer?.order_number || 'Order'}`}
      showBack
      onBack={() => { stopPolling(); setStep('select'); }}
    >
      <div className="sso-screen sso-pick-screen">

        {/* Progress bar */}
        <div className="sso-progress-bar-wrap">
          <div className="sso-progress-counts">
            <span className="sso-count-scanned">{scannedCount} scanned</span>
            {skippedCount > 0 && <span className="sso-count-skipped">{skippedCount} skipped</span>}
            <span className="sso-count-total">of {totalCount}</span>
          </div>
          <div className="sso-progress-track">
            <div
              className="sso-progress-fill"
              style={{ width: totalCount ? `${(scannedCount / totalCount) * 100}%` : '0%' }}
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
            placeholder={nextPending ? `Next: ${nextPending.licence_number}` : 'All pallets accounted for'}
            className="sso-scan-input"
            autoComplete="off"
            autoFocus
          />
          <button type="submit" disabled={loading || !licenceInput.trim()} className="sso-scan-btn">
            {loading ? <RefreshCw size={20} className="sso-spin" /> : <Scan size={20} />}
          </button>
        </form>

        {/* Scan feedback */}
        {scanFeedback && (
          <div className={`sso-feedback sso-feedback--${scanFeedback.type}`}>
            {scanFeedback.type === 'ok' && <CheckCircle2 size={18} />}
            {scanFeedback.type === 'warn' && <AlertTriangle size={18} />}
            {scanFeedback.type === 'err' && <XCircle size={18} />}
            <span>{scanFeedback.msg}</span>
          </div>
        )}

        {/* Exception dialog */}
        {exceptDialog && (
          <div className="sso-except-overlay">
            <div className="sso-except-dialog">
              <AlertTriangle size={32} color="#f59e0b" />
              <h3>Not on pick list</h3>
              <p>
                <strong>{exceptDialog.licence_number}</strong> is not on this order's pick list.
                It has been logged as an exception for the approver to review.
              </p>
              <button type="button" className="sso-primary-btn" onClick={dismissException}>
                OK, Continue
              </button>
            </div>
          </div>
        )}

        {/* Pallet pick list */}
        <div className="sso-picklist">
          {mergedPickList.map((pallet) => {
            const isActive = nextPending?.pallet_id === pallet.pallet_id;
            const isLocallySkipped = localSkippedIds.has(pallet.pallet_id);
            return (
              <div
                key={pallet.pallet_id}
                className={`sso-pallet-row${pallet.is_scanned ? ' sso-pallet--scanned' : ''}${pallet.is_skipped ? ' sso-pallet--skipped' : ''}${isActive ? ' sso-pallet--active' : ''}`}
              >
                <div className="sso-pallet-status-icon">
                  {pallet.is_scanned
                    ? <CheckCircle2 size={22} className="sso-icon-ok" />
                    : pallet.is_skipped
                      ? <SkipForward size={22} className="sso-icon-skip" />
                      : <Circle size={22} className="sso-icon-pending" />}
                </div>
                <div className="sso-pallet-info">
                  <span className="sso-pallet-licence">
                    <Hash size={12} />{pallet.licence_number}
                  </span>
                  <span className="sso-pallet-meta">
                    <MapPin size={11} />{pallet.location}
                    &nbsp;&middot;&nbsp;
                    <Package size={11} />{pallet.cases} cases
                  </span>
                  {pallet.is_scanned && pallet.scanned_at && (
                    <span className="sso-pallet-time">
                      Scanned {formatDateTime(pallet.scanned_at)}
                    </span>
                  )}
                  {isLocallySkipped && (
                    <span className="sso-pallet-time" style={{ color: '#f59e0b' }}>Skipped</span>
                  )}
                </div>
                {/* Skip button for pending pallets; undo button for locally-skipped */}
                {!pallet.is_scanned && (
                  isLocallySkipped ? (
                    <button
                      type="button"
                      className="sso-skip-btn sso-unskip-btn"
                      title="Undo skip"
                      onClick={() => handleUnskipPallet(pallet)}
                    >
                      ↩
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="sso-skip-btn"
                      title="Skip this pallet"
                      onClick={() => handleSkipPallet(pallet)}
                    >
                      <SkipForward size={16} />
                    </button>
                  )
                )}
              </div>
            );
          })}
        </div>

        {/* Exceptions summary */}
        {exceptions.length > 0 && (
          <div className="sso-exceptions-summary">
            <AlertTriangle size={16} />
            <span>{exceptions.length} exception{exceptions.length !== 1 ? 's' : ''} — pallets not on list scanned:</span>
            {exceptions.map((ex, i) => (
              <span key={i} className="sso-exception-badge">{ex.licence_number}</span>
            ))}
          </div>
        )}

        {/* Submit / done section */}
        <div className="sso-submit-section">
          {pendingCount > 0 && (
            <p className="sso-pending-note">
              {pendingCount} pallet{pendingCount !== 1 ? 's' : ''} remaining — scan them or tap ⏭ to skip.
            </p>
          )}
          {(allDone || skippedCount > 0) && (
            <textarea
              className="sso-notes-input"
              placeholder="Optional notes for approver (e.g. why pallets were skipped)…"
              value={submitNotes}
              onChange={(e) => setSubmitNotes(e.target.value)}
              rows={2}
            />
          )}
          <button
            type="button"
            className="sso-primary-btn"
            onClick={() => setStep('submit')}
            disabled={submitting || pendingCount > 0}
          >
            <Send size={18} />
            {allDone
              ? 'Submit for Approval'
              : skippedCount > 0
                ? `Submit Partial Pick (${scannedCount} scanned, ${skippedCount} skipped)`
                : 'Submit for Approval'}
          </button>
        </div>
      </div>

      {/* Submit confirmation modal */}
      {step === 'submit' && (
        <div className="sso-except-overlay">
          <div className="sso-except-dialog">
            <Send size={32} color="#1a472a" />
            <h3>Confirm submission</h3>
            {allDone && skippedCount === 0
              ? <p>All {totalCount} pallets scanned. Ready to submit for approval?</p>
              : <p>
                  {scannedCount} of {totalCount} pallets scanned
                  {skippedCount > 0 ? `, ${skippedCount} skipped` : ''}.
                  Submit for approval?
                </p>
            }
            {skippedCount > 0 && (
              <div className="sso-skipped-list">
                <strong>Skipped pallets:</strong>
                {mergedPickList.filter(p => p.is_skipped).map(p => (
                  <span key={p.pallet_id} className="sso-exception-badge">{p.licence_number}</span>
                ))}
              </div>
            )}
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

export default ScannerShipOutFlow;
