import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import './UnauthorizedPage.css';

const UnauthorizedPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();

  const getDashboardPath = () => {
    switch (user?.role) {
      case 'admin':
        return '/admin';
      case 'supervisor':
        return '/supervisor';
      case 'warehouse':
        return '/warehouse';
      default:
        return '/warehouse';
    }
  };

  const getRoleDisplayName = () => {
    switch (user?.role) {
      case 'admin':
        return 'Administrator';
      case 'supervisor':
        return 'Supervisor';
      case 'warehouse':
        return 'Warehouse Staff';
      default:
        return 'User';
    }
  };

  return (
    <div className="unauthorized-page">
      <div className="unauthorized-container">
        <div className="unauthorized-content">
          <div className="error-icon">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="10" stroke="#ef4444" strokeWidth="2"/>
              <path d="m15 9-6 6" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="m9 9 6 6" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          
          <h1>Unauthorized Access</h1>
          
          <p className="error-message">
            You don't have permission to access this page. This area is restricted to authorized personnel only.
          </p>
          
          <div className="user-info">
            <p>
              <strong>Current User:</strong> {user?.name || user?.username || 'Unknown'}
            </p>
            <p>
              <strong>Role:</strong> {getRoleDisplayName()}
            </p>
          </div>
          
          <div className="action-buttons">
            <button 
              className="primary-button"
              onClick={() => navigate(getDashboardPath())}
            >
              Go to {getRoleDisplayName()} Dashboard
            </button>
            
            <button 
              className="secondary-button"
              onClick={() => navigate(-1)}
            >
              Go Back
            </button>
          </div>
          
          <div className="help-text">
            <p>
              If you believe you should have access to this page, please contact your system administrator.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UnauthorizedPage;
