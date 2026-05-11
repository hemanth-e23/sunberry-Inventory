import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { ChevronLeft, LogOut, Volume2, VolumeX } from 'lucide-react';
import { isScannerMuted, setScannerMuted, subscribeScannerMuted } from '../../utils/scannerFeedback';
import './ScannerLayout.css';

const ScannerLayout = ({ children, title, showBack = false, onBack, headerExtra }) => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [muted, setMuted] = useState(isScannerMuted());

  useEffect(() => subscribeScannerMuted(setMuted), []);

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else if (location.key !== 'default') {
      navigate(-1);
    } else {
      navigate('/forklift');
    }
  };

  return (
    <div className="scanner-layout">
      <header className="scanner-header">
        {showBack && (
          <button
            type="button"
            className="scanner-back-btn"
            onClick={handleBack}
            aria-label="Back"
          >
            <ChevronLeft size={28} />
          </button>
        )}
        <h1 className="scanner-header-title">{title || 'Forklift'}</h1>
        <div className="scanner-header-actions">
          {headerExtra}
          <button
            type="button"
            className="scanner-logout-btn"
            onClick={() => setScannerMuted(!muted)}
            aria-label={muted ? 'Unmute scan sounds' : 'Mute scan sounds'}
            title={muted ? 'Sounds off — tap to enable' : 'Sounds on — tap to mute'}
          >
            {muted ? <VolumeX size={22} /> : <Volume2 size={22} />}
          </button>
          <span className="scanner-user">{user?.name || user?.username}</span>
          <button
            type="button"
            className="scanner-logout-btn"
            onClick={() => logout()}
            aria-label="Sign out"
          >
            <LogOut size={24} />
          </button>
        </div>
      </header>
      <main className="scanner-main">{children}</main>
    </div>
  );
};

export default ScannerLayout;
