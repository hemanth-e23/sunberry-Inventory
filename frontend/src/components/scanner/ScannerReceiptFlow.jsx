import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import ScannerLayout from './ScannerLayout';
import { Scan, MapPin, Package, Check, RefreshCw } from 'lucide-react';
import './ScannerReceiptFlow.css';

const API_BASE = '/api';
const MAX_ROW_SCAN_ATTEMPTS = 3;

const ScannerReceiptFlow = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState('scan-first');
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
  const inputRef = useRef(null);

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    inputRef.current?.focus();
  }, [step, showManualRows]);

  useEffect(() => {
    if (requestId && (step === 'select-location' || step === 'scan')) {
      setLoadingRows(true);
      axios.get(`${API_BASE}/scanner/storage-rows`, { headers })
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
      const r = await axios.post(`${API_BASE}/scanner/requests`, { licence_number: lic }, { headers });
      setRequestId(r.data.id);
      const detail = await axios.get(`${API_BASE}/scanner/requests/${r.data.id}`, { headers });
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
      // Match by row name only (with optional FG- prefix stripped so "A1" matches "FG-A1")
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
      const r = await axios.post(`${API_BASE}/scanner/requests/${requestId}/scan`, payload, { headers });

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

  const handleSkipGaps = () => {
    setStep('scan');
  };

  const handleMarkMissing = async () => {
    if (gapMissing.length === 0) return;
    setLoading(true);
    try {
      await axios.post(`${API_BASE}/scanner/requests/${requestId}/mark-missing`,
        { licence_numbers: gapMissing }, { headers });
      const fr = await axios.get(`${API_BASE}/scanner/requests/${requestId}`, { headers });
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
      await axios.post(`${API_BASE}/scanner/requests/${requestId}/submit`, {}, { headers });
      setStep('done');
    } catch (err) {
      setError(err.response?.data?.detail || 'Submit failed');
    } finally {
      setLoading(false);
    }
  };

  const getOnBack = () => {
    switch (step) {
      case 'scan-first':
        return () => navigate('/forklift');
      case 'select-location':
        return () => setStep('scan-first');
      case 'scan':
        return () => handleChangeRow();
      case 'gap-prompt':
        return () => setStep('scan');
      case 'summary':
        return () => setStep('scan');
      case 'done':
        return () => navigate('/forklift');
      default:
        return () => navigate('/forklift');
    }
  };

  const selectedRow = storageRows.find((r) => r.id === selectedRowId);

  if (step === 'scan-first') {
    return (
      <ScannerLayout title="Receipt Scan" showBack onBack={getOnBack()}>
        <div className="scanner-receipt-flow">
          <p className="scanner-receipt-instruction">Scan the first pallet to start</p>
          <form onSubmit={handleCreateRequest} className="scanner-receipt-form">
            <input
              ref={inputRef}
              type="text"
              value={firstLicence}
              onChange={(e) => setFirstLicence(e.target.value)}
              placeholder="Scan licence (e.g. LOT-XXX-MANGO-001)"
              className="scanner-receipt-input"
              autoComplete="off"
            />
            <button type="submit" disabled={loading || !firstLicence.trim()} className="scanner-receipt-btn">
              {loading ? 'Starting…' : 'Start'}
            </button>
          </form>
          {error && <div className="scanner-receipt-error">{error}</div>}
        </div>
      </ScannerLayout>
    );
  }

  if (step === 'select-location') {
    const availableRows = storageRows.filter((r) => r.available > 0);
    return (
      <ScannerLayout title="Select Location" showBack onBack={getOnBack()}>
        <div className="scanner-receipt-flow">
          <p className="scanner-receipt-product">{productName}</p>

          {!showManualRows ? (
            <>
              <p className="scanner-receipt-instruction">Scan the storage row (row name only)</p>
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
                    <Scan size={24} />
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
              <p className="scanner-receipt-instruction">Choose storage row</p>
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
                      <MapPin size={20} />
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

  if (step === 'gap-prompt') {
    return (
      <ScannerLayout title="Gap Detected" showBack onBack={getOnBack()}>
        <div className="scanner-receipt-flow">
          <p className="scanner-receipt-instruction">Missing pallet(s):</p>
          <ul className="scanner-receipt-gap-list">
            {gapMissing.map((ln) => (
              <li key={ln}>{ln}</li>
            ))}
          </ul>
          <div className="scanner-receipt-gap-btns">
            <button type="button" className="scanner-receipt-btn secondary" onClick={handleSkipGaps}>
              Skip
            </button>
            <button type="button" className="scanner-receipt-btn" onClick={handleMarkMissing} disabled={loading}>
              Mark Missing
            </button>
          </div>
        </div>
      </ScannerLayout>
    );
  }

  if (step === 'scan') {
    return (
      <ScannerLayout title="Scan Pallets" showBack onBack={getOnBack()}>
        <div className="scanner-receipt-flow">
          <div className="scanner-receipt-location-bar">
            <p className="scanner-receipt-location">
              <MapPin size={18} /> {selectedRow?.name}
              {rowAvailable !== null && <span className="scanner-receipt-capacity">({rowAvailable} left)</span>}
            </p>
            <button
              type="button"
              className="scanner-receipt-change-row-btn"
              onClick={handleChangeRow}
            >
              <RefreshCw size={16} /> Change Row
            </button>
          </div>
          <div className="scanner-receipt-toggle">
            <button
              type="button"
              className={!isPartial ? 'active' : ''}
              onClick={() => setIsPartial(false)}
            >
              Full
            </button>
            <button
              type="button"
              className={isPartial ? 'active' : ''}
              onClick={() => setIsPartial(true)}
            >
              Partial
            </button>
          </div>
          {isPartial && (
            <input
              type="number"
              min={1}
              max={999}
              value={partialCases}
              onChange={(e) => setPartialCases(e.target.value)}
              placeholder="Cases"
              className="scanner-receipt-partial-input"
            />
          )}
          <form onSubmit={handleScanPallet} className="scanner-receipt-form">
            <input
              ref={inputRef}
              type="text"
              value={licenceInput}
              onChange={(e) => setLicenceInput(e.target.value)}
              placeholder="Scan pallet"
              className="scanner-receipt-input"
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={loading || !licenceInput.trim() || (isPartial && !partialCases)}
              className="scanner-receipt-btn"
            >
              {loading ? '…' : <Scan size={24} />}
            </button>
          </form>
          {error && <div className="scanner-receipt-error">{error}</div>}
          <div className="scanner-receipt-pallets">
            <h3>Scanned ({pallets.length})</h3>
            {pallets.slice(-10).reverse().map((p) => (
              <div key={p.id} className="scanner-receipt-pallet-item">
                <Package size={16} /> {p.licence_number} – {p.cases} cases
              </div>
            ))}
          </div>
          <button
            type="button"
            className="scanner-receipt-submit-btn"
            onClick={() => setStep('summary')}
            disabled={pallets.length === 0}
          >
            Review & Submit
          </button>
        </div>
      </ScannerLayout>
    );
  }

  if (step === 'summary') {
    const totalCases = pallets.reduce((s, p) => s + (p.cases || 0), 0);
    return (
      <ScannerLayout title="Review" showBack onBack={getOnBack()}>
        <div className="scanner-receipt-flow">
          <p className="scanner-receipt-product">{productName}</p>
          <p className="scanner-receipt-summary">{pallets.length} pallets, {totalCases} cases</p>
          <div className="scanner-receipt-pallets">
            {pallets.map((p) => (
              <div key={p.id} className="scanner-receipt-pallet-item">
                {p.licence_number} – {p.cases}
              </div>
            ))}
          </div>
          <div className="scanner-receipt-summary-btns">
            <button type="button" className="scanner-receipt-btn secondary" onClick={() => setStep('scan')}>
              Back
            </button>
            <button type="button" className="scanner-receipt-btn" onClick={handleSubmit} disabled={loading}>
              {loading ? 'Submitting…' : <><Check size={20} /> Submit</>}
            </button>
          </div>
        </div>
      </ScannerLayout>
    );
  }

  if (step === 'done') {
    return (
      <ScannerLayout title="Submitted" showBack onBack={getOnBack()}>
        <div className="scanner-receipt-flow done">
          <Check size={48} className="scanner-receipt-done-icon" />
          <p>Receipt scan submitted for approval.</p>
          <button type="button" className="scanner-receipt-btn" onClick={() => navigate('/forklift')}>
            Home
          </button>
        </div>
      </ScannerLayout>
    );
  }

  return null;
};

export default ScannerReceiptFlow;
