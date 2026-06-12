import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../../api/client';
import ScannerLayout from './ScannerLayout';
import NetworkStatus from './NetworkStatus';
import ScanFeedback from './ScanFeedback';
import LicenceDisplay from './LicenceDisplay';
import { useScanQueue } from '../../hooks/useScanQueue';
import { removeScan } from '../../utils/scanQueue';
import { isValidLicenceFormat, cleanScannedLicence, playSuccessTone, playErrorTone } from '../../utils/scannerFeedback';
import { formatDateTime } from '../../utils/dateUtils';
import { Scan, MapPin, Package, Check, RefreshCw, CheckCircle2, Cloud, CloudOff, AlertTriangle, Keyboard, Clock } from 'lucide-react';
import './ScannerReceiptFlow.css';

const AUTO_SUBMIT_DISMISSED_KEY = 'forklift_auto_submit_dismissed_at';

const MAX_ROW_SCAN_ATTEMPTS = 3;

const ScannerReceiptFlow = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState('checking');
  const [firstLicence, setFirstLicence] = useState('');
  const [requestId, setRequestId] = useState(null);
  const [productName, setProductName] = useState('');
  const [lotNumber, setLotNumber] = useState('');
  const [storageRows, setStorageRows] = useState([]);
  const [selectedRowId, setSelectedRowId] = useState('');
  const [licenceInput, setLicenceInput] = useState('');
  const [isPartial, setIsPartial] = useState(false);
  const [partialCases, setPartialCases] = useState('');
  const [pallets, setPallets] = useState([]);
  const [gapMissing, setGapMissing] = useState([]);
  const [rowAvailable, setRowAvailable] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const [rowScanInput, setRowScanInput] = useState('');
  const [rowScanAttempts, setRowScanAttempts] = useState(0);
  const [showManualRows, setShowManualRows] = useState(false);
  const [resumeData, setResumeData] = useState(null);
  const [feedback, setFeedback] = useState(null); // { kind: 'success'|'error', message }
  const [manualKeyboard, setManualKeyboard] = useState(false);
  // Sessions auto-submitted by the 3h idle sweep that the user hasn't acknowledged yet.
  // Dismissal is persisted to localStorage so the banner doesn't reappear after refresh.
  const [autoSubmittedNotice, setAutoSubmittedNotice] = useState(null);
  const inputRef = useRef(null);

  const showSuccess = useCallback((message) => {
    playSuccessTone();
    setFeedback({ kind: 'success', message });
  }, []);
  const showError = useCallback((message) => {
    playErrorTone();
    setFeedback({ kind: 'error', message });
  }, []);
  const dismissFeedback = useCallback(() => setFeedback(null), []);

  // Scan queue: every scan goes through here so a Wi-Fi blip doesn't lose
  // anything. When online, drain is immediate. When offline, the operator
  // keeps scanning and items flush when network returns.
  const onScanSynced = useCallback((item, resp) => {
    // The sync endpoint returns HTTP 200 even for a soft rejection (a duplicate
    // pallet), with no `pallet` in the body. Treat that as a failure: drop the
    // optimistic row and surface the message instead of a false success beep.
    if (resp.status === 'duplicate' || (!resp.pallet && resp.status !== 'updated')) {
      setPallets((prev) => prev.filter((p) => p._idempotency_key !== item.idempotency_key));
      showError(resp.message || 'Pallet already scanned');
      return;
    }
    if (resp.pallet) {
      setPallets((prev) => prev.map((p) => (
        p._idempotency_key === item.idempotency_key
          ? { ...resp.pallet, _pending: false, _idempotency_key: undefined }
          : p
      )));
    }
    if (resp.row_available != null) setRowAvailable(resp.row_available);
    if (resp.gap_detected && resp.gap_missing?.length) {
      setGapMissing(resp.gap_missing);
      setStep('gap-prompt');
    }
    showSuccess(resp.message || `Scanned ${resp.pallet?.licence_number || ''}`.trim());
  }, [showSuccess, showError]);

  const onScanFailed = useCallback((item, err) => {
    // No response = transient (offline, 5xx, timeout). Leave optimistic
    // entry alone — the queue will keep retrying when the network returns.
    if (!err?.response) return;
    const status = err.response.status;
    // 5xx / 408 / 429 are retryable; queue keeps them as pending. Same UX.
    if (status >= 500 || status === 408 || status === 429) return;

    // 4xx = server rejected this scan permanently (bad format slipped past
    // client check, product mismatch, duplicate in another request, etc.).
    // Drop both the optimistic row AND the failed queue entry so the
    // operator's NetworkStatus chip stays clean and they don't have to
    // manually "drop failed".
    setPallets((prev) => prev.filter((p) => p._idempotency_key !== item.idempotency_key));
    removeScan(item.id);
    showError(err.response.data?.detail || 'Scan rejected');
  }, [showError]);
  const {
    online,
    pendingCount,
    failedCount,
    enqueueScan,
    retryFailed,
    dropFailed,
    drainNow,
  } = useScanQueue({ onSynced: onScanSynced, onFailed: onScanFailed });

  // On mount: check for an active (interrupted) session for THIS user only.
  // Multiple forklift users can scan simultaneously — each has their own session.
  useEffect(() => {
    apiClient.get('/scanner/requests/active')
      .then((r) => {
        if (r.data && r.data.pallet_count > 0) {
          setResumeData(r.data);
          setStep('resume-prompt');
        } else {
          setStep('scan-first');
        }
      })
      .catch(() => setStep('scan-first'));
  }, []);

  // On mount: check for sessions auto-submitted by the 3h idle sweep that the
  // user hasn't acknowledged yet. Backend filters by scanned_by for forklift
  // role, so this returns this user's submissions only.
  useEffect(() => {
    apiClient.get('/scanner/requests', { params: { status_filter: 'submitted' } })
      .then((r) => {
        const dismissedAt = parseInt(localStorage.getItem(AUTO_SUBMIT_DISMISSED_KEY) || '0', 10);
        const fresh = (r.data || []).filter((fr) => {
          if (!fr.auto_submitted_at) return false;
          const t = new Date(fr.auto_submitted_at).getTime();
          return t > dismissedAt;
        });
        if (fresh.length > 0) {
          setAutoSubmittedNotice({
            count: fresh.length,
            mostRecent: fresh[0],
          });
        }
      })
      .catch(() => { /* non-critical; banner just won't appear */ });
  }, []);

  const dismissAutoSubmittedNotice = useCallback(() => {
    localStorage.setItem(AUTO_SUBMIT_DISMISSED_KEY, String(Date.now()));
    setAutoSubmittedNotice(null);
  }, []);

  // Keep the scan input focused at all times. HID scanners type into
  // whatever has focus, so a lost focus means the scanner's keystrokes
  // go nowhere. Refocus whenever any state change might have dropped it
  // (step transition, overlay dismiss, scan accepted, manual toggle).
  useEffect(() => {
    if (manualKeyboard) return; // user wants the soft keyboard; don't steal focus
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [step, showManualRows, feedback, pallets.length, manualKeyboard]);

  // Aggressive focus guard: if anything else takes focus (taps elsewhere,
  // overlay click, dropdown), pull it back to the scan input on the next
  // tick. The manual-keyboard toggle short-circuits this so the operator
  // can actually type when they need to.
  useEffect(() => {
    if (manualKeyboard) return undefined;
    const onFocusOut = () => {
      // Don't fight interactive controls the operator legitimately tapped
      // (buttons, links, the partial-cases input). Only refocus when the
      // page-level focus has fallen back to body.
      setTimeout(() => {
        const ae = document.activeElement;
        if (!ae || ae === document.body) inputRef.current?.focus();
      }, 50);
    };
    document.addEventListener('focusout', onFocusOut);
    return () => document.removeEventListener('focusout', onFocusOut);
  }, [manualKeyboard]);

  useEffect(() => {
    if (requestId && (step === 'select-location' || step === 'scan')) {
      setLoadingRows(true);
      apiClient.get('/scanner/storage-rows')
        .then((r) => setStorageRows(r.data || []))
        .catch(() => setStorageRows([]))
        .finally(() => setLoadingRows(false));
    }
  }, [requestId, step]);

  const handleCreateRequest = async (e) => {
    e?.preventDefault?.();
    const lic = firstLicence.trim();
    if (!lic) return;
    setError('');

    // Client-side shape check — catches accidental row/FCC scans before
    // they hit the server. Format: {LOT}-{PRODUCT}-{NNN}.
    if (!isValidLicenceFormat(lic)) {
      setFirstLicence('');
      const msg = 'Not a pallet licence — did you scan a row or FCC code?';
      setError(msg);
      showError(msg);
      return;
    }

    setLoading(true);
    try {
      const r = await apiClient.post('/scanner/requests', { licence_number: lic });
      setRequestId(r.data.id);
      const detail = await apiClient.get(`/scanner/requests/${r.data.id}`);
      setProductName(detail.data.product?.name || 'Product');
      setLotNumber(detail.data.lot_number || '');
      setStep('select-location');
      setFirstLicence('');
      setRowScanAttempts(0);
      setShowManualRows(false);
      setRowScanInput('');
      showSuccess(detail.data.product?.name || 'Session started');
    } catch (err) {
      const msg = err.response?.data?.detail || 'Failed to create session';
      setFirstLicence('');
      setError(msg);
      showError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleRowScan = (e) => {
    e?.preventDefault?.();
    const scanned = rowScanInput.trim().toUpperCase();
    if (!scanned) return;
    setError('');

    // If the operator scanned a pallet licence instead of a row barcode,
    // tell them exactly that — much more useful than "Row not found".
    if (isValidLicenceFormat(rowScanInput.trim())) {
      const msg = "That's a pallet licence — scan the row barcode instead.";
      setRowScanInput('');
      setError(msg);
      showError(msg);
      return;
    }

    const match = storageRows.find((r) => {
      const rowName = (r.name || '').toUpperCase();
      const nameOnly = rowName.replace(/^FG[- ]?/, '');
      return nameOnly === scanned || rowName === scanned || r.id === rowScanInput.trim();
    });

    if (match) {
      if (match.available <= 0) {
        const msg = `${match.name} is full. Scan a different row.`;
        setError(msg);
        setRowScanInput('');
        setRowScanAttempts((prev) => prev + 1);
        showError(msg);
      } else {
        handleSelectLocation(match.id);
        showSuccess(`Row ${match.name}`);
      }
    } else {
      const newAttempts = rowScanAttempts + 1;
      setRowScanAttempts(newAttempts);
      setRowScanInput('');
      if (newAttempts >= MAX_ROW_SCAN_ATTEMPTS) {
        const msg = 'Scan not recognized. Select the row manually below.';
        setError(msg);
        setShowManualRows(true);
        showError(msg);
      } else {
        const msg = `Row not found. Try again (${newAttempts}/${MAX_ROW_SCAN_ATTEMPTS} before manual).`;
        setError(msg);
        showError('Row not found');
      }
    }
  };

  const handleSelectLocation = (rowId) => {
    const row = storageRows.find((r) => r.id === rowId);
    setSelectedRowId(rowId);
    setRowAvailable(row ? row.available : null);
    setError('');
    setStep('scan');
  };

  const handleChangeRow = () => {
    setStep('select-location');
    setRowScanAttempts(0);
    setShowManualRows(false);
    setRowScanInput('');
    setError('');
  };

  const handleScanPallet = (e) => {
    e?.preventDefault?.();
    // Trim any stray keystrokes that prefixed the scan because focus
    // wasn't fully on the input when the gun fired. Uses the request's
    // known lot_number as the anchor — no plant-specific hardcoding.
    const lic = cleanScannedLicence(licenceInput, lotNumber);
    if (!lic || !selectedRowId) return;
    setError('');

    // Shape check — accidental row/FCC scans never enter the list.
    if (!isValidLicenceFormat(lic)) {
      setLicenceInput('');
      const msg = 'Not a pallet licence — did you scan a row or FCC code?';
      setError(msg);
      showError(msg);
      return;
    }

    // Reject obvious duplicates client-side so an offline operator gets
    // immediate feedback instead of a delayed server error after sync.
    const alreadyHere = pallets.some((p) => p.licence_number === lic);
    if (alreadyHere) {
      setLicenceInput('');
      setError('Already scanned this pallet.');
      showError('Already scanned this pallet');
      return;
    }

    const payload = {
      licence_number: lic,
      storage_row_id: selectedRowId,
      is_partial: isPartial,
      partial_cases: isPartial && partialCases ? parseInt(partialCases, 10) : null,
    };

    const item = enqueueScan({ requestId, payload });

    // Optimistic entry — appears immediately whether online or not. The
    // useScanQueue callbacks will replace/mark this row when sync resolves.
    setPallets((prev) => [
      ...prev,
      {
        id: `local-${item.id}`,
        licence_number: lic,
        storage_row_id: selectedRowId,
        is_partial: isPartial,
        cases: isPartial && partialCases ? parseInt(partialCases, 10) : null,
        sequence: null,
        status: 'pending',
        _pending: true,
        _failed: false,
        _idempotency_key: item.idempotency_key,
      },
    ]);
    setLicenceInput('');
    setPartialCases('');
    if (rowAvailable != null) setRowAvailable(Math.max(0, rowAvailable - 1));
  };

  const handleSkipGaps = () => setStep('scan');

  const handleMarkMissing = async () => {
    if (gapMissing.length === 0) return;
    setLoading(true);
    try {
      await apiClient.post(`/scanner/requests/${requestId}/mark-missing`, { licence_numbers: gapMissing });
      const fr = await apiClient.get(`/scanner/requests/${requestId}`);
      setPallets(fr.data.pallet_licences?.filter((p) => p.status !== 'cancelled') || []);
      setGapMissing([]);
      setStep('scan');
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    setLoading(true);
    try {
      await apiClient.post(`/scanner/requests/${requestId}/submit`, {});
      setStep('done');
    } catch (err) {
      setError(err.response?.data?.detail || 'Submit failed');
    } finally {
      setLoading(false);
    }
  };

  const handleResume = () => {
    if (!resumeData) return;
    setRequestId(resumeData.id);
    setProductName(resumeData.product_name || 'Product');
    setLotNumber(resumeData.lot_number || '');
    setPallets(resumeData.pallets || []);
    setSelectedRowId(resumeData.last_row_id || '');
    setResumeData(null);
    setStep('scan');
  };

  const handleStartAnother = () => {
    setStep('scan-first');
    setFirstLicence('');
    setRequestId(null);
    setProductName('');
    setLotNumber('');
    setStorageRows([]);
    setSelectedRowId('');
    setLicenceInput('');
    setIsPartial(false);
    setPartialCases('');
    setPallets([]);
    setGapMissing([]);
    setRowAvailable(null);
    setError('');
    setRowScanInput('');
    setRowScanAttempts(0);
    setShowManualRows(false);
    setResumeData(null);
  };

  const getOnBack = () => {
    switch (step) {
      case 'resume-prompt': return () => navigate('/forklift');
      case 'scan-first': return () => navigate('/forklift');
      case 'select-location': return () => setStep('scan-first');
      case 'scan': return () => handleChangeRow();
      case 'gap-prompt': return () => setStep('scan');
      case 'summary': return () => setStep('scan');
      case 'done': return () => navigate('/forklift');
      default: return () => navigate('/forklift');
    }
  };

  const selectedRow = storageRows.find((r) => r.id === selectedRowId);
  const totalCases = pallets.reduce((s, p) => s + (p.cases || 0), 0);

  const netStatus = (
    <NetworkStatus
      online={online}
      pendingCount={pendingCount}
      failedCount={failedCount}
      onRetry={retryFailed}
      onDropFailed={dropFailed}
      onForceSync={drainNow}
    />
  );

  // Soft-keyboard suppression is handled by the kiosk browser at the OS
  // level; we don't set inputMode="none" here because some kiosk shells
  // interpret it as "no keyboard input at all" and break the HID scanner.
  const scanInputProps = {
    autoCapitalize: 'characters',
    autoCorrect: 'off',
    spellCheck: false,
  };
  const manualToggle = (
    <button
      type="button"
      className="scanner-receipt-manual-link"
      onClick={() => setManualKeyboard((v) => !v)}
      style={{ marginTop: '0.4rem' }}
    >
      <Keyboard size={14} style={{ verticalAlign: '-2px', marginRight: '4px' }} />
      {manualKeyboard ? 'Hide keyboard (use scanner)' : 'Type manually'}
    </button>
  );

  const palletStatusIcon = (p) => {
    if (p._failed) return <AlertTriangle size={14} color="#b91c1c" />;
    if (p._pending) return online ? <Cloud size={14} color="#92400e" /> : <CloudOff size={14} color="#92400e" />;
    return <Check size={14} color="#16a34a" />;
  };

  const autoSubmittedBanner = autoSubmittedNotice ? (
    <div
      style={{
        background: '#fef3c7',
        border: '1px solid #fcd34d',
        borderRadius: '8px',
        padding: '12px 14px',
        marginBottom: '14px',
        display: 'flex',
        gap: '10px',
        alignItems: 'flex-start',
      }}
    >
      <Clock size={20} color="#92400e" style={{ flexShrink: 0, marginTop: '2px' }} />
      <div style={{ flex: 1, fontSize: '13px', color: '#78350f', lineHeight: 1.4 }}>
        <div style={{ fontWeight: 600, marginBottom: '4px' }}>
          {autoSubmittedNotice.count === 1 ? 'Session auto-submitted' : `${autoSubmittedNotice.count} sessions auto-submitted`}
        </div>
        <div>
          {autoSubmittedNotice.count === 1
            ? `Your session from ${formatDateTime(autoSubmittedNotice.mostRecent.auto_submitted_at)} was auto-submitted after 3 hours of inactivity. It's awaiting supervisor approval.`
            : `Your most recent was auto-submitted ${formatDateTime(autoSubmittedNotice.mostRecent.auto_submitted_at)} after 3 hours of inactivity. They're awaiting supervisor approval.`}
        </div>
      </div>
      <button
        type="button"
        onClick={dismissAutoSubmittedNotice}
        style={{
          background: 'transparent',
          border: '1px solid #d97706',
          color: '#92400e',
          padding: '4px 10px',
          borderRadius: '6px',
          fontSize: '12px',
          fontWeight: 600,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        Got it
      </button>
    </div>
  ) : null;

  // ── Checking for active session ──────────────────────────────────────────
  if (step === 'checking') {
    return (
      <ScannerLayout title="Receipt Scan">
        <div className="scanner-receipt-flow">
          <p className="scanner-receipt-instruction">Checking for active session…</p>
        </div>
      </ScannerLayout>
    );
  }

  // ── Resume prompt ────────────────────────────────────────────────────────
  // Resume is the ONLY exit from a pending session. No "Start New" option here —
  // forklift drivers must submit (or let the 3h auto-submit fire) before they
  // can scan fresh, so no scan can be silently dropped.
  if (step === 'resume-prompt' && resumeData) {
    return (
      <ScannerLayout title="Resume Session" showBack onBack={getOnBack()} headerExtra={netStatus}>
        <div className="scanner-receipt-flow">
          {autoSubmittedBanner}
          <p className="scanner-receipt-instruction">You have an unfinished scan session. Resume to continue or submit it before starting a new one.</p>
          <div className="scanner-receipt-resume-card">
            <div className="scanner-receipt-product">{resumeData.product_name}</div>
            <div className="scanner-receipt-resume-stats">
              <span><strong>{resumeData.pallet_count}</strong> pallets scanned</span>
              <span><strong>{(resumeData.total_cases || 0).toLocaleString()}</strong> cases</span>
            </div>
          </div>
          <div className="scanner-receipt-gap-btns">
            <button
              type="button"
              className="scanner-receipt-btn"
              onClick={handleResume}
            >
              Resume Session
            </button>
          </div>
        </div>
      </ScannerLayout>
    );
  }

  // ── Scan first pallet ────────────────────────────────────────────────────
  if (step === 'scan-first') {
    return (
      <ScannerLayout title="Receipt Scan" showBack onBack={getOnBack()} headerExtra={netStatus}>
        <div className="scanner-receipt-flow">
          {autoSubmittedBanner}
          <p className="scanner-receipt-instruction">Scan the first pallet to identify the product</p>
          <form onSubmit={handleCreateRequest} className="scanner-receipt-form">
            <input
              ref={inputRef}
              type="text"
              value={firstLicence}
              onChange={(e) => setFirstLicence(e.target.value)}
              placeholder="Scan licence plate…"
              className="scanner-receipt-input"
              autoComplete="off"
              autoFocus
              {...scanInputProps}
            />
            <button type="submit" disabled={loading || !firstLicence.trim()} className="scanner-receipt-btn">
              {loading ? '…' : 'Start'}
            </button>
          </form>
          {error && <div className="scanner-receipt-error">{error}</div>}
          {manualToggle}
        </div>
        <ScanFeedback {...(feedback || {})} onDismiss={dismissFeedback} />
      </ScannerLayout>
    );
  }

  // ── Select location ──────────────────────────────────────────────────────
  if (step === 'select-location') {
    const availableRows = storageRows.filter((r) => r.available > 0);
    return (
      <ScannerLayout title="Select Row" showBack onBack={getOnBack()}>
        <div className="scanner-receipt-flow">
          <div className="scanner-receipt-product">{productName}</div>

          {!showManualRows ? (
            <>
              <p className="scanner-receipt-instruction">Scan the destination row barcode</p>
              {loadingRows ? (
                <p className="scanner-receipt-loading">Loading storage rows…</p>
              ) : (
                <form onSubmit={handleRowScan} className="scanner-receipt-form">
                  <input
                    ref={inputRef}
                    type="text"
                    value={rowScanInput}
                    onChange={(e) => setRowScanInput(e.target.value)}
                    placeholder="Scan row name"
                    className="scanner-receipt-input"
                    autoComplete="off"
                    autoFocus
                    {...scanInputProps}
                  />
                  <button type="submit" disabled={!rowScanInput.trim()} className="scanner-receipt-btn">
                    <Scan size={22} />
                  </button>
                </form>
              )}
              {error && <div className="scanner-receipt-error">{error}</div>}
              {rowScanAttempts > 0 && rowScanAttempts < MAX_ROW_SCAN_ATTEMPTS && (
                <button
                  type="button"
                  className="scanner-receipt-manual-link"
                  onClick={() => setShowManualRows(true)}
                >
                  Select row manually instead
                </button>
              )}
            </>
          ) : (
            <>
              <p className="scanner-receipt-instruction">Choose a storage row</p>
              <button
                type="button"
                className="scanner-receipt-try-scan-btn"
                onClick={() => { setShowManualRows(false); setRowScanAttempts(0); setError(''); setRowScanInput(''); }}
              >
                <Scan size={16} /> Try scanning again
              </button>
              {loadingRows ? (
                <p className="scanner-receipt-loading">Loading storage rows…</p>
              ) : availableRows.length === 0 ? (
                <div className="scanner-receipt-empty">
                  <p>No storage rows with available space.</p>
                  <p className="scanner-receipt-empty-hint">Add storage rows in Master Data or free up capacity.</p>
                </div>
              ) : (
                <div className="scanner-receipt-rows">
                  {availableRows.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      className="scanner-receipt-row-btn"
                      onClick={() => handleSelectLocation(row.id)}
                    >
                      <MapPin size={20} color="#1a472a" />
                      <span>{row.name}</span>
                      <span className="scanner-receipt-available">{row.available} free</span>
                    </button>
                  ))}
                </div>
              )}
              {error && <div className="scanner-receipt-error">{error}</div>}
            </>
          )}
        </div>
        <ScanFeedback {...(feedback || {})} onDismiss={dismissFeedback} />
      </ScannerLayout>
    );
  }

  // ── Gap detected ─────────────────────────────────────────────────────────
  if (step === 'gap-prompt') {
    return (
      <ScannerLayout title="Gap Detected" showBack onBack={getOnBack()}>
        <div className="scanner-receipt-flow">
          <p className="scanner-receipt-instruction">Missing pallet(s) in sequence:</p>
          <ul className="scanner-receipt-gap-list">
            {gapMissing.map((ln) => (
              <li key={ln}>{ln}</li>
            ))}
          </ul>
          <p className="scanner-receipt-instruction" style={{ marginTop: '0.5rem' }}>
            If you just scanned the wrong code, choose <strong>Skip for now</strong> and rescan
            the correct pallet — the gap will fill in automatically.
          </p>
          <div className="scanner-receipt-gap-btns">
            <button type="button" className="scanner-receipt-btn" onClick={handleSkipGaps}>
              Skip for now — I&apos;ll rescan it
            </button>
            <button type="button" className="scanner-receipt-btn secondary" onClick={handleMarkMissing} disabled={loading}>
              Mark as Missing (sticker destroyed)
            </button>
          </div>
        </div>
        <ScanFeedback {...(feedback || {})} onDismiss={dismissFeedback} />
      </ScannerLayout>
    );
  }

  // ── Scan pallets ─────────────────────────────────────────────────────────
  if (step === 'scan') {
    return (
      <ScannerLayout title="Scan Pallets" showBack onBack={getOnBack()}>
        <div className="scanner-receipt-flow">
          <div className="scanner-receipt-location-bar">
            <p className="scanner-receipt-location">
              <MapPin size={16} /> {selectedRow?.name}
              {rowAvailable !== null && <span className="scanner-receipt-capacity">({rowAvailable} left)</span>}
            </p>
            <button
              type="button"
              className="scanner-receipt-change-row-btn"
              onClick={handleChangeRow}
            >
              <RefreshCw size={14} /> Change Row
            </button>
          </div>

          <div className="scanner-receipt-toggle">
            <button
              type="button"
              className={!isPartial ? 'active' : ''}
              onClick={() => setIsPartial(false)}
            >
              Full pallet
            </button>
            <button
              type="button"
              className={isPartial ? 'active' : ''}
              onClick={() => setIsPartial(true)}
            >
              Partial pallet
            </button>
          </div>
          {isPartial && (
            <input
              type="number"
              min={1}
              max={999}
              value={partialCases}
              onChange={(e) => setPartialCases(e.target.value)}
              placeholder="Number of cases"
              className="scanner-receipt-partial-input"
            />
          )}
          <form onSubmit={handleScanPallet} className="scanner-receipt-form">
            <input
              ref={inputRef}
              type="text"
              value={licenceInput}
              onChange={(e) => setLicenceInput(e.target.value)}
              placeholder="Scan pallet licence…"
              className="scanner-receipt-input"
              autoComplete="off"
              autoFocus
              {...scanInputProps}
            />
            <button
              type="submit"
              disabled={loading || !licenceInput.trim() || (isPartial && !partialCases)}
              className="scanner-receipt-btn"
            >
              {loading ? '…' : <Scan size={22} />}
            </button>
          </form>
          {manualToggle}
          {error && <div className="scanner-receipt-error">{error}</div>}

          <div className="scanner-receipt-pallets">
            <div className="scanner-receipt-pallets-header">
              <h3>Scanned ({pallets.length})</h3>
              {pallets.length > 0 && (
                <span className="scanner-receipt-pallets-total">{totalCases.toLocaleString()} cases</span>
              )}
            </div>
            {pallets.slice(-10).reverse().map((p) => (
              <div
                key={p.id}
                className={`scanner-receipt-pallet-item${p._pending ? ' pallet-pending' : ''}${p._failed ? ' pallet-failed' : ''}`}
                title={p._failed ? p._failError : (p._pending ? (online ? 'Syncing…' : 'Pending sync (offline)') : 'Synced')}
              >
                {palletStatusIcon(p)}
                <LicenceDisplay licence={p.licence_number} className="pallet-lic" />
                <span className="pallet-cases">{p.cases != null ? `${p.cases} cs` : '—'}</span>
              </div>
            ))}
          </div>

          <button
            type="button"
            className="scanner-receipt-submit-btn"
            onClick={() => setStep('summary')}
            disabled={pallets.length === 0}
          >
            Review & Submit ({pallets.length})
          </button>
        </div>
        <ScanFeedback {...(feedback || {})} onDismiss={dismissFeedback} />
      </ScannerLayout>
    );
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  if (step === 'summary') {
    return (
      <ScannerLayout title="Review" showBack onBack={getOnBack()} headerExtra={netStatus}>
        <div className="scanner-receipt-flow">
          <div className="scanner-receipt-product">{productName}</div>
          <div className="scanner-receipt-summary-stats">
            <div className="scanner-receipt-stat">
              <span className="scanner-receipt-stat-value">{pallets.length}</span>
              <span className="scanner-receipt-stat-label">Pallets</span>
            </div>
            <div className="scanner-receipt-stat">
              <span className="scanner-receipt-stat-value">{totalCases.toLocaleString()}</span>
              <span className="scanner-receipt-stat-label">Cases</span>
            </div>
            <div className="scanner-receipt-stat">
              <span className="scanner-receipt-stat-value">{selectedRow?.name || '—'}</span>
              <span className="scanner-receipt-stat-label">Row</span>
            </div>
          </div>
          <div className="scanner-receipt-pallets">
            <div className="scanner-receipt-pallets-header">
              <h3>All Pallets</h3>
            </div>
            {pallets.map((p) => (
              <div
                key={p.id}
                className={`scanner-receipt-pallet-item${p._pending ? ' pallet-pending' : ''}${p._failed ? ' pallet-failed' : ''}`}
              >
                {p._pending || p._failed ? palletStatusIcon(p) : <Package size={14} color="#6b7280" />}
                <LicenceDisplay licence={p.licence_number} className="pallet-lic" />
                <span className="pallet-cases">{p.cases != null ? `${p.cases} cs` : '—'}</span>
              </div>
            ))}
          </div>
          <div className="scanner-receipt-summary-btns">
            <button type="button" className="scanner-receipt-btn secondary" onClick={() => setStep('scan')}>
              Back
            </button>
            <button
              type="button"
              className="scanner-receipt-btn"
              onClick={handleSubmit}
              disabled={loading || pendingCount > 0 || failedCount > 0}
              title={
                pendingCount > 0
                  ? 'Wait for all scans to sync before submitting'
                  : failedCount > 0
                    ? 'Resolve failed scans before submitting'
                    : ''
              }
            >
              {loading ? 'Submitting…' : (pendingCount > 0 ? `Syncing… (${pendingCount})` : <><Check size={18} /> Submit</>)}
            </button>
          </div>
        </div>
      </ScannerLayout>
    );
  }

  // ── Done ─────────────────────────────────────────────────────────────────
  if (step === 'done') {
    return (
      <ScannerLayout title="Submitted" showBack onBack={getOnBack()}>
        <div className="scanner-receipt-flow done">
          <CheckCircle2 size={64} className="scanner-receipt-done-icon" />
          <h2 className="scanner-receipt-done-title">Submitted!</h2>
          <p className="scanner-receipt-done-sub">
            {pallets.length} pallet{pallets.length !== 1 ? 's' : ''} · {totalCases.toLocaleString()} cases<br />
            Sent to supervisor for approval.
          </p>
          <div className="scanner-receipt-done-actions">
            <button type="button" className="scanner-receipt-btn" onClick={handleStartAnother}>
              <Package size={18} /> Scan Another Receipt
            </button>
            <button type="button" className="scanner-receipt-btn secondary" onClick={() => navigate('/forklift')}>
              Back to Home
            </button>
          </div>
        </div>
      </ScannerLayout>
    );
  }

  return null;
};

export default ScannerReceiptFlow;
