import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { getDashboardPath } from '../../App';
import { Scan } from 'lucide-react';
import LoadingSpinner from '../LoadingSpinner';
import './ScannerLogin.css';

const ScannerLogin = () => {
  const [badgeId, setBadgeId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);
  const { badgeLogin } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (!badgeId.trim()) return;
    setError('');
    setLoading(true);

    const result = await badgeLogin(badgeId.trim());

    if (result.success) {
      const dashboardPath = getDashboardPath(result.user.role);
      navigate(dashboardPath, { replace: true });
    } else {
      setError(result.error);
      setLoading(false);
      setBadgeId('');
    }
  };

  const handleScan = (e) => {
    const value = e.target.value;
    setBadgeId(value);
    if (value.endsWith('\n') || value.includes('\r')) {
      const trimmed = value.replace(/[\r\n]/g, '').trim();
      if (trimmed) {
        setBadgeId(trimmed);
        badgeLogin(trimmed).then((result) => {
          if (result.success) {
            navigate(getDashboardPath(result.user.role), { replace: true });
          } else {
            setError(result.error);
          }
        }).finally(() => setLoading(false));
        setBadgeId('');
      }
    }
  };

  return (
    <div className="scanner-login-page">
      <div className="scanner-login-container">
        <div className="scanner-login-brand">
          <h1 className="scanner-login-title">Forklift Scanner</h1>
          <p className="scanner-login-subtitle">Scan your badge to sign in</p>
        </div>

        <form onSubmit={handleSubmit} className="scanner-login-form">
          <input
            ref={inputRef}
            type="text"
            value={badgeId}
            onChange={handleScan}
            placeholder="Scan badge or type ID"
            className="scanner-login-input"
            autoComplete="off"
            autoFocus
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || !badgeId.trim()}
            className="scanner-login-btn"
          >
            {loading ? (
              <LoadingSpinner size="sm" />
            ) : (
              <>
                <Scan size={32} />
                <span>Scan Badge</span>
              </>
            )}
          </button>
          {error && (
            <div className="scanner-login-error">{error}</div>
          )}
        </form>
      </div>
    </div>
  );
};

export default ScannerLogin;
