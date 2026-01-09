import React from 'react';
import { useAuth } from '../context/AuthContext';
import { LogOut, Leaf } from 'lucide-react';
import './Layout.css';

const Layout = ({ children }) => {
  const { user, logout } = useAuth();

  const handleLogout = () => {
    logout();
  };

  return (
    <div className="layout">
      <header className="header">
        <div className="header-content">
          <div className="logo">
            <div className="logo-text">Sunberry Farms</div>
          </div>
          <div className="header-actions">
            <span className="username">Hello {user?.username || 'User'}!</span>
            <button
              type="button"
              className="logout-button"
              onClick={handleLogout}
              aria-label="Sign out"
            >
              <LogOut size={18} />
              <span>Sign Out</span>
            </button>
          </div>
        </div>
      </header>

      <main className="main-content">
        {children}
      </main>
    </div>
  );
};

export default Layout;
