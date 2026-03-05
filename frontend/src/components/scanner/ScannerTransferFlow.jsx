import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../../api/client';
import ScannerLayout from './ScannerLayout';
import { MapPin, ArrowRight, Package, Scan, X, Send } from 'lucide-react';
import './ScannerTransferFlow.css';

const ScannerTransferFlow = () => {
  const navigate = useNavigate();
  const [licenceInput, setLicenceInput] = useState('');
  const [destScanInput, setDestScanInput] = useState('');
  const [currentLicence, setCurrentLicence] = useState(null);
  const [storageRows, setStorageRows] = useState([]);
  const [selectedDestId, setSelectedDestId] = useState('');
  const [moves, setMoves] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);
  const destInputRef = useRef(null);

  useEffect(() => {
    apiClient.get('/scanner/storage-rows')
      .then((r) => setStorageRows(r.data || []))
      .catch(() => setStorageRows([]));
  }, []);

  useEffect(() => {
    if (currentLicence) {
      destInputRef.current?.focus();
    } else {
      inputRef.current?.focus();
    }
  }, [currentLicence]);

  const handleScanPallet = async (e) => {
    e?.preventDefault?.();
    const lic = licenceInput.trim();
    if (!lic) return;
    setError('');
    setLoading(true);

    try {
      const r = await apiClient.get('/pallet-licences/', {
        params: { licence_number: lic, status: 'in_stock' },
      });
      if (!r.data || r.data.length === 0) {
        setError('Pallet not found or not in stock');
        return;
      }
      const pl = r.data[0];
      if (pl.is_held) {
        setError('This pallet is on hold — release the hold before moving it.');
        return;
      }
      setCurrentLicence(pl);
      setLicenceInput('');
      setSelectedDestId('');
      setDestScanInput('');
    } catch (err) {
      setError(err.response?.data?.detail || 'Lookup failed');
    } finally {
      setLoading(false);
    }
  };

  const availableDestRows = storageRows.filter((r) => (r.available ?? 0) > 0);

  const handleScanDestination = (e) => {
    e?.preventDefault?.();
    const scanned = destScanInput.trim().toUpperCase();
    if (!scanned) return;
    setError('');

    const match = availableDestRows.find((r) => {
      const rowName = (r.name || '').toUpperCase();
      const nameOnly = rowName.replace(/^FG[- ]?/, '');
      return nameOnly === scanned || rowName === scanned || r.id === destScanInput.trim();
    });

    if (match) {
      setSelectedDestId(match.id);
      setDestScanInput('');
    } else {
      setError(`Row "${destScanInput.trim()}" not found or no capacity.`);
      setDestScanInput('');
    }
  };

  const handleConfirmMove = () => {
    if (!currentLicence || !selectedDestId) return;
    setMoves((prev) => [...prev, {
      licence_id: currentLicence.id,
      licence_number: currentLicence.licence_number,
      product_name: currentLicence.product?.name || currentLicence.product_name || null,
      cases: currentLicence.cases || 0,
      to_row_id: selectedDestId,
    }]);
    setCurrentLicence(null);
    setSelectedDestId('');
  };

  const handleCancelDestination = () => {
    setCurrentLicence(null);
    setSelectedDestId('');
    setDestScanInput('');
    setError('');
  };

  const handleRemoveMove = (idx) => {
    setMoves((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async () => {
    if (moves.length === 0) return;
    setLoading(true);
    setError('');

    try {
      const payload = { moves: moves.map((m) => ({ licence_id: m.licence_id, to_row_id: m.to_row_id })) };
      await apiClient.post('/scanner/internal-transfer', payload);
      navigate('/forklift');
    } catch (err) {
      setError(err.response?.data?.detail || 'Submit failed');
    } finally {
      setLoading(false);
    }
  };

  const destRow = storageRows.find((r) => r.id === selectedDestId);
  const currentRow = currentLicence
    ? storageRows.find((r) => r.id === currentLicence.storage_row_id)
    : null;

  return (
    <ScannerLayout title="Internal Transfer" showBack>
      <div className="scanner-transfer-flow">
        {!currentLicence ? (
          <>
            <p className="scanner-transfer-instruction">Scan the pallet to move</p>
            <form onSubmit={handleScanPallet} className="scanner-transfer-form">
              <input
                ref={inputRef}
                type="text"
                value={licenceInput}
                onChange={(e) => setLicenceInput(e.target.value)}
                placeholder="Scan licence plate…"
                className="scanner-transfer-input"
                autoComplete="off"
              />
              <button type="submit" disabled={loading || !licenceInput.trim()} className="scanner-transfer-btn">
                {loading ? '…' : <Scan size={22} />}
              </button>
            </form>
          </>
        ) : (
          <>
            {/* Pallet info card */}
            <div className="scanner-transfer-current">
              <div className="scanner-transfer-current-icon">
                <Package size={22} />
              </div>
              <div className="scanner-transfer-current-info">
                <div className="scanner-transfer-current-lic">{currentLicence.licence_number}</div>
                <div className="scanner-transfer-current-meta">
                  {(currentLicence.product?.name || currentLicence.product_name) && (
                    <span>{currentLicence.product?.name || currentLicence.product_name}</span>
                  )}
                  {currentLicence.lot_number && <span>Lot: {currentLicence.lot_number}</span>}
                  <span><Package size={12} /> {currentLicence.cases || 0} cases</span>
                  {currentRow && <span><MapPin size={12} /> {currentRow.name}</span>}
                </div>
              </div>
            </div>

            <p className="scanner-transfer-instruction">Scan the destination row</p>
            {!selectedDestId ? (
              <form onSubmit={handleScanDestination} className="scanner-transfer-form">
                <input
                  ref={destInputRef}
                  type="text"
                  value={destScanInput}
                  onChange={(e) => setDestScanInput(e.target.value)}
                  placeholder="Scan row name…"
                  className="scanner-transfer-input"
                  autoComplete="off"
                />
                <button type="submit" disabled={!destScanInput.trim()} className="scanner-transfer-btn">
                  <Scan size={22} />
                </button>
              </form>
            ) : (
              <div className="scanner-transfer-dest-confirm">
                <p className="scanner-transfer-dest-name">
                  <MapPin size={18} /> {destRow?.name ?? 'Unknown row'}
                  {destRow?.available !== undefined && (
                    <span style={{ fontSize: '0.8rem', fontWeight: 400, marginLeft: 'auto', opacity: 0.7 }}>
                      {destRow.available} free
                    </span>
                  )}
                </p>
                <div className="scanner-transfer-actions">
                  <button type="button" className="scanner-transfer-btn secondary" onClick={() => setSelectedDestId('')}>
                    Change row
                  </button>
                  <button type="button" className="scanner-transfer-btn secondary" onClick={handleCancelDestination}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="scanner-transfer-btn"
                    onClick={handleConfirmMove}
                  >
                    <ArrowRight size={18} /> Add
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {error && <div className="scanner-transfer-error">{error}</div>}

        {moves.length > 0 && (
          <div className="scanner-transfer-moves">
            <div className="scanner-transfer-moves-header">
              <h3>Queued moves ({moves.length})</h3>
            </div>
            {moves.map((m, i) => {
              const toRow = storageRows.find((r) => r.id === m.to_row_id);
              return (
                <div key={i} className="scanner-transfer-move-item">
                  <span className="scanner-transfer-move-lic">{m.licence_number}</span>
                  <ArrowRight size={14} className="scanner-transfer-move-arrow" />
                  <span className="scanner-transfer-move-dest">{toRow?.name ?? '?'}</span>
                  <button
                    type="button"
                    className="scanner-transfer-move-remove"
                    title="Remove this move"
                    onClick={() => handleRemoveMove(i)}
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              className="scanner-transfer-submit"
              onClick={handleSubmit}
              disabled={loading}
            >
              <Send size={18} />
              {loading ? 'Submitting…' : `Submit ${moves.length} move${moves.length !== 1 ? 's' : ''} for Approval`}
            </button>
          </div>
        )}
      </div>
    </ScannerLayout>
  );
};

export default ScannerTransferFlow;
