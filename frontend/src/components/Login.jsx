import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getDashboardPath } from '../App';
import { Eye, EyeOff, User, Lock, LogIn, Sparkles, Leaf } from 'lucide-react';
import LoadingSpinner from './LoadingSpinner';
import './Login.css';

const Login = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const result = await login(username, password);

    if (result.success) {
      // Navigate to role-based dashboard on successful login
      const dashboardPath = getDashboardPath(result.user.role);
      navigate(dashboardPath, { replace: true });
    } else {
      setError(result.error);
      setLoading(false);
    }
  };

  const handleDemoLogin = (demoUsername, demoPassword) => {
    setUsername(demoUsername);
    setPassword(demoPassword);
  };

  const handleUsernameKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const passwordInput = document.getElementById('password');
      if (passwordInput) {
        passwordInput.focus();
      }
    }
  };

  return (
    <div className="login-page">
      {/* Split Screen Layout */}
      <div className="login-container">
        {/* Left Side - Branding Section */}
        <div className="login-brand-side">
          <div className="brand-overlay"></div>
          <div className="brand-content animate-fade-in">
            <div className="brand-logo-section">
              <div className="text-logo">
                <div className="logo-sunberry-login">SunBerry</div>
                <div className="logo-farms-login">
                  <span>FARMS</span>
                  <Leaf size={20} className="logo-leaf-small" />
                </div>
              </div>
              <p className="brand-subtitle">Inventory Management System</p>
            </div>
          </div>
        </div>

        {/* Right Side - Login Form */}
        <div className="login-form-side">
          <div className="form-wrapper glass-card animate-fade-in">
            <div className="form-header">
              <h2 className="form-title heading">Welcome Back</h2>
              <p className="form-subtitle">Sign in to access your dashboard</p>
            </div>

            <form onSubmit={handleSubmit} className="login-form">
              <div className="form-group">
                <label htmlFor="username" className="form-label">
                  Username
                </label>
                <div className="input-wrapper">
                  <User className="input-icon" size={18} />
                  <input
                    type="text"
                    id="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    onKeyDown={handleUsernameKeyDown}
                    required
                    placeholder="Enter your username"
                    className="form-input"
                    autoComplete="username"
                  />
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="password" className="form-label">
                  Password
                </label>
                <div className="input-wrapper">
                  <Lock className="input-icon" size={18} />
                  <input
                    type={showPassword ? "text" : "password"}
                    id="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    placeholder="Enter your password"
                    className="form-input"
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    className="password-toggle icon-btn"
                    onClick={() => setShowPassword(!showPassword)}
                    tabIndex={-1}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              {error && (
                <div className="error-message animate-slide-in">
                  <span>{error}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={loading || !username || !password}
                className="login-button"
              >
                {loading ? (
                  <>
                    <LoadingSpinner size="sm" />
                    <span>Signing in...</span>
                  </>
                ) : (
                  <>
                    <LogIn size={18} />
                    <span>Sign In</span>
                  </>
                )}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Login;
