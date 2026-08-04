import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../../api/client';
import ScannerLayout from './ScannerLayout';
import NetworkStatus from './NetworkStatus';
import ScanFeedback from './ScanFeedback';
import LicenceDisplay from './LicenceDisplay';
import { useScanQueue } from '../../hooks/useScanQueue';
import { removeScan } from '../../utils/scanQueue';
import {
  isValidLicenceFormat,
  cleanScannedLicence,
  parseLineFromLicence,
  parseLineFromLot,
  playSuccessTone,
  playErrorTone,
} from '../../utils/scannerFeedback';
import { formatDateTime } from '../../utils/dateUtils';
import {
  Scan, MapPin, Package, Check, RefreshCw, CheckCircle2, Cloud, CloudOff,
  AlertTriangle, Keyboard, Clock,
} from 'lucide-react';
import './ScannerReceiptFlow.css';

const AUTO_SUBMIT_DISMISSED_KEY = 'forklift_auto_submit_dismissed_at';

// Show the manual row picker only after this many failed row scans — default is
// scan-the-barcode, not pick-from-a-long-list.
const MAX_ROW_SCAN_ATTEMPTS = 3;

// One driver, one gun, two production lines. Each line is its own scanning
// session keyed by the L1/L2 suffix the pallet tag already carries. The gun
// routes a scan to its line automatically; the two buttons up top only switch
// which line is on screen (and trigger first-time setup).
const LINE_CODES = ['L1', 'L2'];
const lineLabel = (code) => (code === 'L1' ? 'Line 1' : code === 'L2' ? 'Line 2' : code);

// Per-line states:
//   needs-row         → product known, waiting for a destination row (scan or pick)
//   scanning          → actively taking pallets
//   overfill-confirm  → row is full BY THE SYSTEM; asking the driver whether to
//                       keep loading it anyway. Capacity is a prompt, not a block:
//                       a row the system thinks is full is routinely empty,
//                       because pallets leave without being scanned out. See
//                       scanner_service.scan_pallet.
//   gap               → a sequence gap was detected, awaiting skip / mark-missing
//
// overfill-confirm counts as a row state so the driver can answer the prompt by
// simply scanning a different rack barcode instead of tapping.
const isRowState = (status) => status === 'needs-row' || status === 'overfill-confirm';

const ScannerReceiptFlow = () => {
  const navigate = useNavigate();
  const [booted, setBooted] = useState(false);

  // lines: { L1: lineState, L2: lineState } — only present once set up.
  const [lines, setLines] = useState({});
  const [activeLine, setActiveLine] = useState(null);

  const [storageRows, setStorageRows] = useState([]);
  const [loadingRows, setLoadingRows] = useState(false);

  const [scanInput, setScanInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [manualKeyboard, setManualKeyboard] = useState(false);
  const [feedback, setFeedback] = useState(null); // { kind: 'success'|'error', message }
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

  const updateLine = useCallback((code, patch) => {
    setLines((prev) => {
      const cur = prev[code];
      if (!cur) return prev;
      const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch };
      return { ...prev, [code]: next };
    });
  }, []);

  // ── Offline scan queue ─────────────────────────────────────────────────────
  // Every scan flows through the queue (items carry their own requestId), so a
  // Wi-Fi blip never loses work and L1/L2 scans coexist. Sync results resolve
  // back into the right line by matching the item's requestId.
  const onScanSynced = useCallback((item, resp) => {
    setLines((prev) => {
      const code = Object.keys(prev).find((c) => prev[c].requestId === item.requestId);
      if (!code) return prev;
      const line = prev[code];
      let pallets = line.pallets;
      // The row filled up between our cached count and this scan landing (the
      // other line, or the other driver, got there first). Nothing was written:
      // pull the optimistic row back out and ask. Must come before the branches
      // below, which would read a pallet-less response as "already scanned".
      if (resp.status === 'needs_confirm') {
        return {
          ...prev,
          [code]: {
            ...line,
            pallets: pallets.filter((p) => p._idempotency_key !== item.idempotency_key),
            status: 'overfill-confirm',
            rowAvailable: 0,
            rowScanAttempts: 0,
            showManualRows: false,
            pendingOverfill: {
              payload: item.payload,
              idempotencyKey: item.idempotency_key,
              rowName: resp.row_name || '',
            },
          },
        };
      }
      if (resp.status === 'duplicate' || (!resp.pallet && resp.status !== 'updated')) {
        pallets = pallets.filter((p) => p._idempotency_key !== item.idempotency_key);
      } else if (resp.status === 'updated' && !resp.pallet) {
        pallets = pallets.filter((p) => p._idempotency_key !== item.idempotency_key);
      } else if (resp.pallet) {
        pallets = pallets.map((p) => (
          p._idempotency_key === item.idempotency_key
            ? { ...resp.pallet, _pending: false, _idempotency_key: undefined }
            : p
        ));
      }
      const patch = { pallets };
      if (resp.row_available != null) patch.rowAvailable = resp.row_available;
      if (resp.gap_detected && resp.gap_missing?.length) {
        patch.gapMissing = resp.gap_missing;
        patch.status = 'gap';
      }
      return { ...prev, [code]: { ...line, ...patch } };
    });

    if (resp.status === 'needs_confirm') {
      showError(resp.message || 'Row is full by the system. Load into it anyway?');
    } else if (resp.status === 'duplicate' || (!resp.pallet && resp.status !== 'updated')) {
      showError(resp.message || 'Pallet already scanned');
    } else if (resp.status === 'updated' && !resp.pallet) {
      showSuccess(resp.message || 'Moved to new location');
    } else {
      showSuccess(resp.message || `Scanned ${resp.pallet?.licence_number || ''}`.trim());
    }
  }, [showSuccess, showError]);

  const onScanFailed = useCallback((item, err) => {
    // No response = transient (offline, 5xx, timeout): leave the optimistic row,
    // the queue keeps retrying.
    if (!err?.response) return;
    const status = err.response.status;
    if (status >= 500 || status === 408 || status === 429) return;

    // 4xx = permanently rejected: drop the optimistic row + the failed item.
    setLines((prev) => {
      const code = Object.keys(prev).find((c) => prev[c].requestId === item.requestId);
      if (!code) return prev;
      const line = prev[code];
      return {
        ...prev,
        [code]: { ...line, pallets: line.pallets.filter((p) => p._idempotency_key !== item.idempotency_key) },
      };
    });
    removeScan(item.id);
    showError(err.response.data?.detail || 'Scan rejected');
  }, [showError]);

  const {
    online,
    pendingCount,
    failedCount,
    countsForRequest,
    enqueueScan,
    retryFailed,
    dropFailed,
    clearRequest,
    drainNow,
  } = useScanQueue({ onSynced: onScanSynced, onFailed: onScanFailed });

  // ── Resume: rebuild BOTH lines from this driver's open scanning sessions ────
  useEffect(() => {
    let cancelled = false;
    apiClient.get('/scanner/requests', { params: { status_filter: 'scanning' } })
      .then((r) => {
        if (cancelled) return;
        const sessions = r.data || [];
        const next = {};
        for (const fr of sessions) {
          const code = parseLineFromLot(fr.lot_number);
          if (code !== 'L1' && code !== 'L2') continue;
          if (next[code]) continue; // guard: one session per line
          const pls = (fr.pallet_licences || []).filter((p) => p.status !== 'cancelled');
          let lastRow = '';
          for (let i = pls.length - 1; i >= 0; i -= 1) {
            if (pls[i].storage_row_id) { lastRow = pls[i].storage_row_id; break; }
          }
          next[code] = {
            requestId: fr.id,
            productName: fr.product?.name || 'Product',
            lotNumber: fr.lot_number || '',
            selectedRowId: lastRow,
            rowAvailable: null,
            isPartial: false,
            partialCases: '',
            pallets: pls.map((p) => ({
              id: p.id,
              licence_number: p.licence_number,
              storage_row_id: p.storage_row_id,
              cases: p.cases,
              is_partial: p.is_partial,
              status: p.status,
            })),
            status: lastRow ? 'scanning' : 'needs-row',
            gapMissing: [],
            rowScanAttempts: 0,
            showManualRows: false,
            // Not carried across a resume: we can't know the driver already
            // said yes to this rack, so the server asks again on the next scan.
            overfillAckRowId: '',
            pendingOverfill: null,
          };
        }
        setLines(next);
        const firstCode = parseLineFromLot(sessions[0]?.lot_number);
        const codes = Object.keys(next);
        if (codes.length) setActiveLine(next[firstCode] ? firstCode : codes[0]);
        setBooted(true);
      })
      .catch(() => { if (!cancelled) setBooted(true); });
    return () => { cancelled = true; };
  }, []);

  // Auto-submitted notice (sessions closed by the per-driver 3h idle sweep).
  useEffect(() => {
    apiClient.get('/scanner/requests', { params: { status_filter: 'submitted' } })
      .then((r) => {
        const dismissedAt = parseInt(localStorage.getItem(AUTO_SUBMIT_DISMISSED_KEY) || '0', 10);
        const fresh = (r.data || []).filter((fr) => {
          if (!fr.auto_submitted_at) return false;
          return new Date(fr.auto_submitted_at).getTime() > dismissedAt;
        });
        if (fresh.length > 0) setAutoSubmittedNotice({ count: fresh.length, mostRecent: fresh[0] });
      })
      .catch(() => { /* non-critical */ });
  }, []);

  const dismissAutoSubmittedNotice = useCallback(() => {
    localStorage.setItem(AUTO_SUBMIT_DISMISSED_KEY, String(Date.now()));
    setAutoSubmittedNotice(null);
  }, []);

  // Storage rows: fetched on mount and refreshed whenever the active line is
  // waiting for a row, so capacity is current at the moment of choosing.
  const fetchStorageRows = useCallback(() => {
    setLoadingRows(true);
    apiClient.get('/scanner/storage-rows')
      .then((r) => setStorageRows(r.data || []))
      .catch(() => setStorageRows([]))
      .finally(() => setLoadingRows(false));
  }, []);

  useEffect(() => { fetchStorageRows(); }, [fetchStorageRows]);

  const activeState = activeLine ? lines[activeLine] : null;
  const activeStatus = activeState?.status || null;

  useEffect(() => {
    if (activeState && isRowState(activeState.status)) fetchStorageRows();
  }, [activeLine, activeStatus, activeState, fetchStorageRows]);

  // Keep the single shared scan input focused — HID scanners type into whatever
  // has focus. One always-mounted input survives line switches without losing
  // focus or the gun's keystrokes.
  useEffect(() => {
    if (manualKeyboard) return undefined;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [activeLine, activeStatus, feedback, manualKeyboard, booted]);

  useEffect(() => {
    if (manualKeyboard) return undefined;
    const onFocusOut = () => {
      setTimeout(() => {
        const ae = document.activeElement;
        if (!ae || ae === document.body) inputRef.current?.focus();
      }, 50);
    };
    document.addEventListener('focusout', onFocusOut);
    return () => document.removeEventListener('focusout', onFocusOut);
  }, [manualKeyboard]);

  // ── Scan routing ───────────────────────────────────────────────────────────
  // Strip junk keystrokes using any known line's lot, then read the line from
  // the tag so we can route it. Falls back to the trimmed raw for a brand-new
  // line (its lot isn't known until the session is created).
  const resolveScan = useCallback((raw) => {
    const trimmed = String(raw).trim();
    for (const code of Object.keys(lines)) {
      const lot = lines[code]?.lotNumber;
      if (!lot) continue;
      const cleaned = cleanScannedLicence(trimmed, lot);
      if (isValidLicenceFormat(cleaned)) {
        const line = parseLineFromLicence(cleaned);
        if (line) return { cleaned, line };
      }
    }
    const cleaned = cleanScannedLicence(trimmed);
    return { cleaned, line: parseLineFromLicence(cleaned) };
  }, [lines]);

  const createLine = async (code, licence) => {
    setLoading(true);
    try {
      const r = await apiClient.post('/scanner/requests', { licence_number: licence });
      const detail = await apiClient.get(`/scanner/requests/${r.data.id}`);
      setLines((prev) => ({
        ...prev,
        [code]: {
          requestId: r.data.id,
          productName: detail.data.product?.name || 'Product',
          lotNumber: detail.data.lot_number || '',
          selectedRowId: '',
          rowAvailable: null,
          isPartial: false,
          partialCases: '',
          pallets: [],
          status: 'needs-row',
          gapMissing: [],
          rowScanAttempts: 0,
          showManualRows: false,
          overfillAckRowId: '',
          pendingOverfill: null,
        },
      }));
      setActiveLine(code);
      fetchStorageRows();
      showSuccess(`${detail.data.product?.name || 'Line started'} — now set the ${lineLabel(code)} row`);
    } catch (err) {
      showError(err.response?.data?.detail || 'Failed to start line');
    } finally {
      setLoading(false);
    }
  };

  const rowNameOf = (rowId) => storageRows.find((r) => r.id === rowId)?.name || 'This rack';

  // Picking a row the system calls full is allowed — it just asks first, once
  // per rack. A rack the driver already answered for stays answered.
  const selectRow = (code, rowId) => {
    const row = storageRows.find((r) => r.id === rowId);
    const available = row ? row.available : null;
    const acked = lines[code]?.overfillAckRowId === rowId;
    const full = available != null && available <= 0;
    updateLine(code, {
      selectedRowId: rowId,
      rowAvailable: available,
      status: full && !acked ? 'overfill-confirm' : 'scanning',
      overfillAckRowId: acked ? rowId : '',
      pendingOverfill: null,
      rowScanAttempts: 0,
      showManualRows: false,
    });
    setError('');
    return { full, acked, rowName: row?.name || '' };
  };

  const handleRowScan = (code, raw) => {
    const scanned = raw.trim().toUpperCase();
    if (!scanned) return;
    if (isValidLicenceFormat(raw.trim())) {
      showError("That's a pallet licence — scan the row barcode instead.");
      return;
    }
    const match = storageRows.find((r) => {
      const rowName = (r.name || '').toUpperCase();
      const nameOnly = rowName.replace(/^FG[- ]?/, '');
      return nameOnly === scanned || rowName === scanned || r.id === raw.trim();
    });
    if (!match) {
      const attempts = (lines[code]?.rowScanAttempts || 0) + 1;
      if (attempts >= MAX_ROW_SCAN_ATTEMPTS) {
        updateLine(code, { rowScanAttempts: attempts, showManualRows: true });
        showError('Scan not recognized. Pick the row manually below.');
      } else {
        updateLine(code, { rowScanAttempts: attempts });
        showError(`Row not found. Try again (${attempts}/${MAX_ROW_SCAN_ATTEMPTS} before manual).`);
      }
      return;
    }
    const { full, acked } = selectRow(code, match.id);
    if (full && !acked) {
      showError(`${match.name} is full by the system — load into it anyway?`);
    } else {
      showSuccess(`Row ${match.name}`);
    }
  };

  // Enqueue + optimistic row. Shared by a fresh scan and by the replay after the
  // driver answers the full-rack prompt (which reuses the original idempotency
  // key, so a lost response can't become a second pallet).
  const queuePallet = (code, licence, payload, idempotencyKey) => {
    const ls = lines[code];
    if (!ls) return;
    const item = enqueueScan({ requestId: ls.requestId, payload, idempotencyKey });
    updateLine(code, (prev) => {
      const nextAvail = prev.rowAvailable != null ? Math.max(0, prev.rowAvailable - 1) : null;
      // Out of room by the books. If the driver has already said to keep going
      // on this rack, don't ask again — the answer is per rack, not per pallet.
      const askAgain = nextAvail != null && nextAvail <= 0
        && prev.overfillAckRowId !== prev.selectedRowId;
      return {
        ...prev,
        pallets: [
          ...prev.pallets,
          {
            id: `local-${item.id}`,
            licence_number: licence,
            storage_row_id: prev.selectedRowId,
            is_partial: prev.isPartial,
            cases: prev.isPartial && prev.partialCases ? parseInt(prev.partialCases, 10) : null,
            status: 'pending',
            _pending: true,
            _failed: false,
            _idempotency_key: item.idempotency_key,
          },
        ],
        partialCases: '',
        rowAvailable: nextAvail,
        ...(askAgain ? { status: 'overfill-confirm', rowScanAttempts: 0, showManualRows: false } : {}),
      };
    });
  };

  // "Continue loading" on the full-rack prompt. Remembers the answer for this
  // rack and replays the scan that triggered it, if the prompt came from the
  // server (the rack filled up after our count was cached).
  const handleOverfillContinue = (code) => {
    const ls = lines[code];
    if (!ls) return;
    const pending = ls.pendingOverfill;
    updateLine(code, {
      overfillAckRowId: ls.selectedRowId,
      status: 'scanning',
      pendingOverfill: null,
    });
    setError('');
    if (pending) {
      queuePallet(
        code,
        pending.payload.licence_number,
        { ...pending.payload, allow_overfill: true },
        pending.idempotencyKey,
      );
    }
    showSuccess('Loading into this rack anyway');
  };

  const recordPallet = (code, licence) => {
    const ls = lines[code];
    if (!ls?.selectedRowId) return;
    if (ls.pallets.some((p) => p.licence_number === licence)) {
      showError('Already scanned this pallet.');
      return;
    }
    queuePallet(code, licence, {
      licence_number: licence,
      storage_row_id: ls.selectedRowId,
      is_partial: ls.isPartial,
      partial_cases: ls.isPartial && ls.partialCases ? parseInt(ls.partialCases, 10) : null,
      // The driver already answered "load it anyway" for this rack.
      allow_overfill: ls.overfillAckRowId === ls.selectedRowId,
    });
  };

  const handleScan = (e) => {
    e?.preventDefault?.();
    const raw = scanInput;
    if (!raw.trim()) return;
    setScanInput('');
    setError('');

    const active = activeLine ? lines[activeLine] : null;
    const needsRow = active && isRowState(active.status);
    const { cleaned, line } = resolveScan(raw);

    // While the active line waits for a row, a non-pallet scan is the row barcode.
    if (needsRow && !isValidLicenceFormat(cleaned)) {
      handleRowScan(activeLine, raw);
      return;
    }

    if (!isValidLicenceFormat(cleaned)) {
      showError('Not a pallet licence — did you scan a row or FCC code?');
      return;
    }
    if (!line) {
      showError("Couldn't read the line (L1/L2) from this tag.");
      return;
    }
    if (line !== 'L1' && line !== 'L2') {
      showError('Only 2 lines are supported.');
      return;
    }

    const target = lines[line];
    if (!target) {
      createLine(line, cleaned);
      return;
    }
    if (isRowState(target.status)) {
      setActiveLine(line);
      showError(target.status === 'overfill-confirm'
        ? `${rowNameOf(target.selectedRowId)} is full by the system — tap Continue to load it anyway, or scan a different rack.`
        : `Set a row for ${lineLabel(line)} before scanning into it.`);
      return;
    }
    recordPallet(line, cleaned);
    setActiveLine(line); // view follows the scan
  };

  const handleChangeRow = (code) => {
    // Leaving the rack drops both the answer and any scan waiting on it — the
    // driver is telling us this load is going somewhere else.
    updateLine(code, {
      status: 'needs-row',
      rowScanAttempts: 0,
      showManualRows: false,
      overfillAckRowId: '',
      pendingOverfill: null,
    });
    setActiveLine(code);
    setError('');
    // A scan that was waiting on the prompt never landed anywhere. Say so, or
    // the driver walks away thinking that pallet was recorded.
    if (lines[code]?.pendingOverfill) {
      showError('That pallet was not recorded — scan it again into the new rack.');
    }
    fetchStorageRows();
  };

  const handleSkipGap = (code) => {
    updateLine(code, { status: 'scanning', gapMissing: [] });
  };

  const handleMarkMissing = async (code) => {
    const ls = lines[code];
    if (!ls || ls.gapMissing.length === 0) return;
    setLoading(true);
    try {
      await apiClient.post(`/scanner/requests/${ls.requestId}/mark-missing`, { licence_numbers: ls.gapMissing });
      const fr = await apiClient.get(`/scanner/requests/${ls.requestId}`);
      updateLine(code, {
        pallets: (fr.data.pallet_licences || []).filter((p) => p.status !== 'cancelled'),
        gapMissing: [],
        status: 'scanning',
      });
    } catch (err) {
      showError(err.response?.data?.detail || 'Failed to mark missing');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitLine = async (code) => {
    const ls = lines[code];
    if (!ls) return;
    const { pending, failed } = countsForRequest(ls.requestId);
    if (pending > 0 || failed > 0) {
      showError(pending > 0 ? 'Wait for scans to sync before submitting.' : 'Resolve failed scans before submitting.');
      return;
    }
    if (ls.pallets.length === 0) {
      showError('Scan at least one pallet before submitting.');
      return;
    }
    setLoading(true);
    try {
      await apiClient.post(`/scanner/requests/${ls.requestId}/submit`, {});
      clearRequest(ls.requestId);
      setLines((prev) => {
        const next = { ...prev };
        delete next[code];
        const remaining = Object.keys(next);
        setActiveLine(remaining[0] || null);
        return next;
      });
      showSuccess(`${lineLabel(code)} submitted — sent for approval`);
    } catch (err) {
      showError(err.response?.data?.detail || 'Submit failed');
    } finally {
      setLoading(false);
    }
  };

  // ── Derived UI bits ─────────────────────────────────────────────────────────
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

  const scanInputProps = { autoCapitalize: 'characters', autoCorrect: 'off', spellCheck: false };

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

  const lineNeedsAttention = (code) => {
    const ls = lines[code];
    return !!ls && (ls.status === 'overfill-confirm' || ls.status === 'gap');
  };

  const autoSubmittedBanner = autoSubmittedNotice ? (
    <div className="scanner-receipt-autosubmit">
      <Clock size={20} color="#92400e" style={{ flexShrink: 0, marginTop: '2px' }} />
      <div style={{ flex: 1, fontSize: '13px', color: '#78350f', lineHeight: 1.4 }}>
        <div style={{ fontWeight: 600, marginBottom: '4px' }}>
          {autoSubmittedNotice.count === 1 ? 'Session auto-submitted' : `${autoSubmittedNotice.count} sessions auto-submitted`}
        </div>
        <div>
          Auto-submitted {formatDateTime(autoSubmittedNotice.mostRecent.auto_submitted_at)} after 3 hours of
          inactivity. Awaiting supervisor approval.
        </div>
      </div>
      <button type="button" className="scanner-receipt-autosubmit-btn" onClick={dismissAutoSubmittedNotice}>
        Got it
      </button>
    </div>
  ) : null;

  const lineTabs = (
    <div className="scanner-receipt-linetabs">
      {LINE_CODES.map((code) => {
        const ls = lines[code];
        const isActive = activeLine === code;
        const classes = [
          'scanner-receipt-linetab',
          isActive ? 'active' : '',
          ls ? 'live' : 'empty',
          lineNeedsAttention(code) ? 'attention' : '',
        ].filter(Boolean).join(' ');
        return (
          <button
            key={code}
            type="button"
            className={classes}
            onClick={() => setActiveLine(code)}
          >
            <span className="scanner-receipt-linetab-name">{lineLabel(code)}</span>
            <span className="scanner-receipt-linetab-meta">
              {ls ? `${ls.pallets.length} pallet${ls.pallets.length !== 1 ? 's' : ''}` : 'not started'}
            </span>
            {lineNeedsAttention(code) && <span className="scanner-receipt-linetab-badge" aria-hidden>!</span>}
          </button>
        );
      })}
    </div>
  );

  // ── Render ──────────────────────────────────────────────────────────────────
  if (!booted) {
    return (
      <ScannerLayout title="Receipt Scan">
        <div className="scanner-receipt-flow">
          <p className="scanner-receipt-instruction">Checking for active sessions…</p>
        </div>
      </ScannerLayout>
    );
  }

  const placeholder = activeState && activeState.status === 'overfill-confirm'
    ? 'Scan a different rack, or tap Continue…'
    : activeState && isRowState(activeState.status)
      ? `Scan the ${lineLabel(activeLine)} row barcode…`
      : 'Scan pallet licence…';

  const { pending: activePending, failed: activeFailed } = activeState
    ? countsForRequest(activeState.requestId)
    : { pending: 0, failed: 0 };
  // Full racks stay pickable — the system's idea of full is often wrong, and
  // hiding them left a driver with "no rows available" and nowhere to put a
  // pallet. Roomy racks first, full ones marked.
  const pickableRows = [...storageRows].sort(
    (a, b) => (b.available > 0) - (a.available > 0),
  );

  return (
    <ScannerLayout title="Receipt Scan" showBack onBack={() => navigate('/forklift')} headerExtra={netStatus}>
      <div className="scanner-receipt-flow">
        {autoSubmittedBanner}
        {lineTabs}

        <form onSubmit={handleScan} className="scanner-receipt-form">
          <input
            ref={inputRef}
            type="text"
            value={scanInput}
            onChange={(e) => setScanInput(e.target.value)}
            placeholder={placeholder}
            className="scanner-receipt-input"
            autoComplete="off"
            autoFocus
            {...scanInputProps}
          />
          <button type="submit" disabled={loading || !scanInput.trim()} className="scanner-receipt-btn">
            {loading ? '…' : <Scan size={22} />}
          </button>
        </form>
        {manualToggle}
        {error && <div className="scanner-receipt-error">{error}</div>}

        {/* ── Active line panel ── */}
        {!activeState ? (
          <div className="scanner-receipt-empty">
            <p>{activeLine ? `Scan a ${lineLabel(activeLine)} pallet to start this line.` : 'Scan any pallet to start a line.'}</p>
            <p className="scanner-receipt-empty-hint">The tag decides the line — scan and it routes itself.</p>
          </div>
        ) : (
          <div className="scanner-receipt-panel">
            <div className="scanner-receipt-product">
              {activeState.productName} <span className="scanner-receipt-lot">· {activeState.lotNumber}</span>
            </div>

            {activeState.status === 'overfill-confirm' ? (
              <>
                <div className="scanner-receipt-overfill">
                  <AlertTriangle size={20} color="#b45309" style={{ flexShrink: 0 }} />
                  <div>
                    <strong>
                      {activeState.pendingOverfill?.rowName || rowNameOf(activeState.selectedRowId)} is
                      full by the system.
                    </strong>
                    <div className="scanner-receipt-overfill-detail">
                      It is often not full for real — pallets leave without being scanned out.
                      Load into it anyway?
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  className="scanner-receipt-overfill-continue"
                  onClick={() => handleOverfillContinue(activeLine)}
                >
                  <Check size={18} /> Continue loading
                </button>
                <button
                  type="button"
                  className="scanner-receipt-try-scan-btn"
                  onClick={() => handleChangeRow(activeLine)}
                >
                  <Scan size={16} /> Scan a different rack
                </button>
              </>
            ) : isRowState(activeState.status) ? (
              <>
                {!activeState.showManualRows ? (
                  <>
                    <p className="scanner-receipt-instruction">Scan the {lineLabel(activeLine)} row barcode.</p>
                    <button
                      type="button"
                      className="scanner-receipt-manual-link"
                      onClick={() => updateLine(activeLine, { showManualRows: true })}
                    >
                      Select row manually instead
                    </button>
                  </>
                ) : (
                  <>
                    <p className="scanner-receipt-instruction">Choose a storage row for {lineLabel(activeLine)}.</p>
                    <button
                      type="button"
                      className="scanner-receipt-try-scan-btn"
                      onClick={() => updateLine(activeLine, { showManualRows: false, rowScanAttempts: 0 })}
                    >
                      <Scan size={16} /> Try scanning again
                    </button>
                    {loadingRows ? (
                      <p className="scanner-receipt-loading">Loading storage rows…</p>
                    ) : pickableRows.length === 0 ? (
                      <div className="scanner-receipt-empty">
                        <p>No storage rows set up.</p>
                        <p className="scanner-receipt-empty-hint">Add rows in Master Data.</p>
                      </div>
                    ) : (
                      <div className="scanner-receipt-rows">
                        {pickableRows.map((row) => (
                          <button
                            key={row.id}
                            type="button"
                            className="scanner-receipt-row-btn"
                            onClick={() => selectRow(activeLine, row.id)}
                          >
                            <MapPin size={20} color={row.available > 0 ? '#1a472a' : '#b45309'} />
                            <span>{row.name}</span>
                            <span className="scanner-receipt-available">
                              {row.available > 0 ? `${row.available} free` : 'full'}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                <div className="scanner-receipt-location-bar">
                  <p className="scanner-receipt-location">
                    <MapPin size={16} /> {storageRows.find((r) => r.id === activeState.selectedRowId)?.name || 'Row'}
                    {activeState.rowAvailable !== null && (
                      <span className="scanner-receipt-capacity">({activeState.rowAvailable} left)</span>
                    )}
                  </p>
                  <button type="button" className="scanner-receipt-change-row-btn" onClick={() => handleChangeRow(activeLine)}>
                    <RefreshCw size={14} /> Change Row
                  </button>
                </div>

                <div className="scanner-receipt-toggle">
                  <button
                    type="button"
                    className={!activeState.isPartial ? 'active' : ''}
                    onClick={() => updateLine(activeLine, { isPartial: false })}
                  >
                    Full pallet
                  </button>
                  <button
                    type="button"
                    className={activeState.isPartial ? 'active' : ''}
                    onClick={() => updateLine(activeLine, { isPartial: true })}
                  >
                    Partial pallet
                  </button>
                </div>
                {activeState.isPartial && (
                  <input
                    type="number"
                    min={1}
                    max={999}
                    value={activeState.partialCases}
                    onChange={(e) => updateLine(activeLine, { partialCases: e.target.value })}
                    placeholder="Number of cases"
                    className="scanner-receipt-partial-input"
                  />
                )}

                {activeState.status === 'gap' && (
                  <div className="scanner-receipt-gap">
                    <p className="scanner-receipt-instruction">Missing pallet(s) in sequence:</p>
                    <ul className="scanner-receipt-gap-list">
                      {activeState.gapMissing.map((ln) => <li key={ln}>{ln}</li>)}
                    </ul>
                    <div className="scanner-receipt-gap-btns">
                      <button type="button" className="scanner-receipt-btn" onClick={() => handleSkipGap(activeLine)}>
                        Skip for now — I&apos;ll rescan it
                      </button>
                      <button type="button" className="scanner-receipt-btn secondary" onClick={() => handleMarkMissing(activeLine)} disabled={loading}>
                        Mark as Missing (sticker destroyed)
                      </button>
                    </div>
                  </div>
                )}

                <div className="scanner-receipt-pallets">
                  <div className="scanner-receipt-pallets-header">
                    <h3>Scanned ({activeState.pallets.length})</h3>
                    {activeState.pallets.length > 0 && (
                      <span className="scanner-receipt-pallets-total">
                        {activeState.pallets.reduce((s, p) => s + (p.cases || 0), 0).toLocaleString()} cases
                      </span>
                    )}
                  </div>
                  {activeState.pallets.slice(-10).reverse().map((p) => (
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

                <button
                  type="button"
                  className="scanner-receipt-submit-btn"
                  onClick={() => handleSubmitLine(activeLine)}
                  disabled={loading || activeState.pallets.length === 0 || activePending > 0 || activeFailed > 0}
                  title={activePending > 0 ? 'Wait for scans to sync before submitting' : (activeFailed > 0 ? 'Resolve failed scans before submitting' : '')}
                >
                  {loading
                    ? 'Submitting…'
                    : activePending > 0
                      ? `Syncing… (${activePending})`
                      : <><Check size={18} /> Submit {lineLabel(activeLine)} ({activeState.pallets.length})</>}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <ScanFeedback {...(feedback || {})} onDismiss={dismissFeedback} />
    </ScannerLayout>
  );
};

export default ScannerReceiptFlow;
