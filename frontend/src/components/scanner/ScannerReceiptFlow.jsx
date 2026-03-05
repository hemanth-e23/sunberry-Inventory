import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../../api/client';
import ScannerLayout from './ScannerLayout';
import { Scan, MapPin, Package, Check, RefreshCw, CheckCircle2 } from 'lucide-react';
import './ScannerReceiptFlow.css';

const MAX_ROW_SCAN_ATTEMPTS = 3;

const ScannerReceiptFlow = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState('checking');
  const [firstLicence, setFirstLicence] = useState('');
  const [requestId, setRequestId] = useState(null);
  const [productName, setProductName] = useState('');
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
  const inputRef = useRef(null);

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

  useEffect(() => {
    inputRef.current?.focus();
  }, [step, showManualRows]);

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
    setLoading(true);

    try {
      const r = await apiClient.post('/scanner/requests', { licence_number: lic });
      setRequestId(r.data.id);
      const detail = await apiClient.get(`/scanner/requests/${r.data.id}`);
      setProductName(detail.data.product?.name || 'Product');
      setStep('select-location');
      setFirstLicence('');
      setRowScanAttempts(0);
      setShowManualRows(false);
      setRowScanInput('');
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to create session');
    } finally {
      setLoading(false);
    }
  };

  const handleRowScan = (e) => {
    e?.preventDefault?.();
    const scanned = rowScanInput.trim().toUpperCase();
    if (!scanned) return;
    setError('');

    const match = storageRows.find((r) => {
      const rowName = (r.name || '').toUpperCase();
      const nameOnly = rowName.replace(/^FG[- ]?/, '');
      return nameOnly === scanned || rowName === scanned || r.id === rowScanInput.trim();
    });

    if (match) {
      if (match.available <= 0) {
        setError(`${match.name} is full. Scan a different row.`);
        setRowScanInput('');
        setRowScanAttempts((prev) => prev + 1);
      } else {
        handleSelectLocation(match.id);
      }
    } else {
      const newAttempts = rowScanAttempts + 1;
      setRowScanAttempts(newAttempts);
      setRowScanInput('');
      if (newAttempts >= MAX_ROW_SCAN_ATTEMPTS) {
        setError('Scan not recognized. You can select the row manually below.');
        setShowManualRows(true);
      } else {
        setError(`Row not found. Try again (${newAttempts}/${MAX_ROW_SCAN_ATTEMPTS} before manual).`);
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

  const handleScanPallet = async (e) => {
    e?.preventDefault?.();
    const lic = licenceInput.trim();
    if (!lic || !selectedRowId) return;
    setError('');
    setLoading(true);

    try {
      const payload = {
        licence_number: lic,
        storage_row_id: selectedRowId,
        is_partial: isPartial,
        partial_cases: isPartial && partialCases ? parseInt(partialCases, 10) : null,
      };
      const r = await apiClient.post(`/scanner/requests/${requestId}/scan`, payload);

      if (r.data.status === 'duplicate') {
        setError(r.data.message || 'Already scanned this pallet.');
        setLicenceInput('');
        setLoading(false);
        return;
      }
      if (r.data.status === 'updated') {
        setError(r.data.message || 'Pallet moved to this row.');
        setLicenceInput('');
        setLoading(false);
        return;
      }

      setPallets((prev) => [...prev, r.data.pallet]);
      setGapMissing(r.data.gap_missing || []);
      setRowAvailable(r.data.row_available ?? 0);
      setLicenceInput('');
      setPartialCases('');
      if (r.data.gap_detected && r.data.gap_missing?.length) {
        setStep('gap-prompt');
      }
    } catch (err) {
      setError(err.response?.data?.detail || 'Scan failed');
    } finally {
      setLoading(false);
    }
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
  if (step === 'resume-prompt' && resumeData) {
    return (
      <ScannerLayout title="Resume Session" showBack onBack={getOnBack()}>
        <div className="scanner-receipt-flow">
          <p className="scanner-receipt-instruction">You have an unfinished scan session:</p>
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
            <button
              type="button"
              className="scanner-receipt-btn secondary"
              onClick={handleStartAnother}
            >
              Start New
            </button>
          </div>
        </div>
      </ScannerLayout>
    );
  }

  // ── Scan first pallet ────────────────────────────────────────────────────
  if (step === 'scan-first') {
    return (
      <ScannerLayout title="Receipt Scan" showBack onBack={getOnBack()}>
        <div className="scanner-receipt-flow">
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
            />
            <button type="submit" disabled={loading || !firstLicence.trim()} className="scanner-receipt-btn">
              {loading ? '…' : 'Start'}
            </button>
          </form>
          {error && <div className="scanner-receipt-error">{error}</div>}
        </div>
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
          <div className="scanner-receipt-gap-btns">
            <button type="button" className="scanner-receipt-btn secondary" onClick={handleSkipGaps}>
              Skip — continue scanning
            </button>
            <button type="button" className="scanner-receipt-btn" onClick={handleMarkMissing} disabled={loading}>
              Mark as Missing
            </button>
          </div>
        </div>
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
            />
            <button
              type="submit"
              disabled={loading || !licenceInput.trim() || (isPartial && !partialCases)}
              className="scanner-receipt-btn"
            >
              {loading ? '…' : <Scan size={22} />}
            </button>
          </form>
          {error && <div className="scanner-receipt-error">{error}</div>}

          <div className="scanner-receipt-pallets">
            <div className="scanner-receipt-pallets-header">
              <h3>Scanned ({pallets.length})</h3>
              {pallets.length > 0 && (
                <span className="scanner-receipt-pallets-total">{totalCases.toLocaleString()} cases</span>
              )}
            </div>
            {pallets.slice(-10).reverse().map((p) => (
              <div key={p.id} className="scanner-receipt-pallet-item">
                <Check size={14} color="#16a34a" />
                <span className="pallet-lic">{p.licence_number}</span>
                <span className="pallet-cases">{p.cases} cs</span>
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
      </ScannerLayout>
    );
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  if (step === 'summary') {
    return (
      <ScannerLayout title="Review" showBack onBack={getOnBack()}>
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
              <div key={p.id} className="scanner-receipt-pallet-item">
                <Package size={14} color="#6b7280" />
                <span className="pallet-lic">{p.licence_number}</span>
                <span className="pallet-cases">{p.cases} cs</span>
              </div>
            ))}
          </div>
          <div className="scanner-receipt-summary-btns">
            <button type="button" className="scanner-receipt-btn secondary" onClick={() => setStep('scan')}>
              Back
            </button>
            <button type="button" className="scanner-receipt-btn" onClick={handleSubmit} disabled={loading}>
              {loading ? 'Submitting…' : <><Check size={18} /> Submit</>}
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
