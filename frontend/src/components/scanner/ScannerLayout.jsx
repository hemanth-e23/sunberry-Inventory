import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { ChevronLeft, LogOut } from 'lucide-react';
import './ScannerLayout.css';

const ScannerLayout = ({ children, title, showBack = false, onBack }) => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

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
