import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import ScannerLayout from './ScannerLayout';
import { MapPin, ArrowRight, Package, Scan } from 'lucide-react';
import './ScannerTransferFlow.css';

const API_BASE = '/api';

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

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    axios.get(`${API_BASE}/scanner/storage-rows`, { headers })
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
      const r = await axios.get(`${API_BASE}/pallet-licences/`, {
        params: { licence_number: lic, status: 'in_stock' },
        headers,
      });
      if (!r.data || r.data.length === 0) {
        setError('Pallet not found or not in stock');
        return;
      }
      const pl = r.data[0];
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

  // Destination rows with capacity only
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
      setError(`Row "${destScanInput.trim()}" not found or no capacity. Scan row name only.`);
      setDestScanInput('');
    }
  };

  const handleConfirmMove = () => {
    if (!currentLicence || !selectedDestId) return;
    setMoves((prev) => [...prev, { licence_id: currentLicence.id, licence_number: currentLicence.licence_number, to_row_id: selectedDestId }]);
    setCurrentLicence(null);
    setSelectedDestId('');
  };

  const handleCancelDestination = () => {
    setCurrentLicence(null);
    setSelectedDestId('');
    setDestScanInput('');
    setError('');
  };

  const handleSubmit = async () => {
    if (moves.length === 0) return;
    setLoading(true);
    setError('');

    try {
      const payload = { moves: moves.map((m) => ({ licence_id: m.licence_id, to_row_id: m.to_row_id })) };
      await axios.post(`${API_BASE}/scanner/internal-transfer`, payload, { headers });
      navigate('/forklift');
    } catch (err) {
      setError(err.response?.data?.detail || 'Submit failed');
    } finally {
      setLoading(false);
    }
  };

  const destRow = storageRows.find((r) => r.id === selectedDestId);

  return (
    <ScannerLayout title="Internal Transfer" showBack>
      <div className="scanner-transfer-flow">
        {!currentLicence ? (
          <>
            <p className="scanner-transfer-instruction">Scan pallet to move</p>
            <form onSubmit={handleScanPallet} className="scanner-transfer-form">
              <input
                ref={inputRef}
                type="text"
                value={licenceInput}
                onChange={(e) => setLicenceInput(e.target.value)}
                placeholder="Scan licence number"
                className="scanner-transfer-input"
                autoComplete="off"
              />
              <button type="submit" disabled={loading} className="scanner-transfer-btn">
                {loading ? '…' : 'Lookup'}
              </button>
            </form>
          </>
        ) : (
          <>
            <div className="scanner-transfer-current">
              <Package size={24} />
              <div>
                <strong>{currentLicence.licence_number}</strong>
                <p>
                  <MapPin size={14} /> {(() => {
                    const r = storageRows.find((x) => x.id === currentLicence.storage_row_id);
                    return r ? r.name : 'Unknown';
                  })()}
                </p>
              </div>
            </div>
            <p className="scanner-transfer-instruction">Scan destination row (row name only)</p>
            {!selectedDestId ? (
              <form onSubmit={handleScanDestination} className="scanner-transfer-form">
                <input
                  ref={destInputRef}
                  type="text"
                  value={destScanInput}
                  onChange={(e) => setDestScanInput(e.target.value)}
                  placeholder="Scan row name"
                  className="scanner-transfer-input"
                  autoComplete="off"
                />
                <button type="submit" disabled={!destScanInput.trim()} className="scanner-transfer-btn">
                  <Scan size={24} />
                </button>
              </form>
            ) : (
              <div className="scanner-transfer-dest-confirm">
                <p className="scanner-transfer-dest-name">
                  <MapPin size={18} /> {destRow?.name ?? 'Unknown'}
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
                    <ArrowRight size={20} /> Add
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {error && <div className="scanner-transfer-error">{error}</div>}
        {moves.length > 0 && (
          <div className="scanner-transfer-moves">
            <h3>Moves ({moves.length})</h3>
            {moves.map((m, i) => {
              const toRow = storageRows.find((r) => r.id === m.to_row_id);
              return (
                <div key={i} className="scanner-transfer-move-item">
                  {m.licence_number} → {toRow?.name ?? 'Row'}
                </div>
              );
            })}
            <button
              type="button"
              className="scanner-transfer-submit"
              onClick={handleSubmit}
              disabled={loading}
            >
              Submit for Approval
            </button>
          </div>
        )}
      </div>
    </ScannerLayout>
  );
};

export default ScannerTransferFlow;
