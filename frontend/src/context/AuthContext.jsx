import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { useAutoLogout } from '../hooks/useAutoLogout';

// API URL - use relative path, nginx will proxy to backend
const API_BASE_URL = '/api';

const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

const getLoginDate = () => localStorage.getItem('loginDate') || '';
const setLoginDate = (d) => localStorage.setItem('loginDate', d);
const clearLoginDate = () => localStorage.removeItem('loginDate');

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const isForklift = useRef(false);

  const logout = () => {
    setUser(null);
    setIsAuthenticated(false);
    clearLoginDate();
    localStorage.removeItem('user');
    localStorage.removeItem('token');
    isForklift.current = false;
  };

  // Auto-logout: 30 min for non-forklift; forklift uses day-change only
  useAutoLogout(logout, isAuthenticated, user?.role === 'forklift' ? null : 30);

  // Forklift: check day-change and force re-login
  useEffect(() => {
    if (!isAuthenticated || user?.role !== 'forklift') return;
    const today = new Date().toDateString();
    if (getLoginDate() && getLoginDate() !== today) {
      logout();
    }
  }, [isAuthenticated, user?.role]);

  useEffect(() => {
    // Check for existing session on app load
    const checkAuth = async () => {
      const savedUser = localStorage.getItem('user');
      const token = localStorage.getItem('token');

      if (savedUser && token) {
        try {
          // Verify token is still valid by fetching user info
          const headers = { Authorization: `Bearer ${token}` };
          const response = await axios.get(`${API_BASE_URL}/auth/me`, { headers });
          const userData = {
            id: response.data.id,
            username: response.data.username,
            role: response.data.role,
            name: response.data.name,
            email: response.data.email
          };
          setUser(userData);
          setIsAuthenticated(true);
          localStorage.setItem('user', JSON.stringify(userData));
        } catch (error) {
          // Token is invalid, clear everything
          console.error('Token validation failed:', error);
          localStorage.removeItem('user');
          localStorage.removeItem('token');
        }
      }
      setLoading(false);
    };

    checkAuth();
  }, []);

  const login = async (username, password) => {
    try {
      // Call backend API for authentication
      const response = await axios.post(`${API_BASE_URL}/auth/login`, {
        username,
        password
      });

      const token = response.data.access_token;
      localStorage.setItem('token', token);

      // Fetch user info
      const headers = { Authorization: `Bearer ${token}` };
      const userResponse = await axios.get(`${API_BASE_URL}/auth/me`, { headers });

      const userData = {
        id: userResponse.data.id,
        username: userResponse.data.username,
        role: userResponse.data.role,
        name: userResponse.data.name,
        email: userResponse.data.email
      };

      setUser(userData);
      setIsAuthenticated(true);
      localStorage.setItem('user', JSON.stringify(userData));
      setLoginDate(new Date().toDateString());

      return { success: true, user: userData };
    } catch (error) {
      console.error('Login error:', error);
      const errorMessage = error.response?.data?.detail || 'Invalid credentials';
      return { success: false, error: errorMessage };
    }
  };

  const badgeLogin = async (badgeId) => {
    try {
      const response = await axios.post(`${API_BASE_URL}/auth/badge-login`, {
        badge_id: badgeId
      });

      const token = response.data.access_token;
      localStorage.setItem('token', token);

      const headers = { Authorization: `Bearer ${token}` };
      const userResponse = await axios.get(`${API_BASE_URL}/auth/me`, { headers });

      const userData = {
        id: userResponse.data.id,
        username: userResponse.data.username,
        role: userResponse.data.role,
        name: userResponse.data.name,
        email: userResponse.data.email
      };

      setUser(userData);
      setIsAuthenticated(true);
      localStorage.setItem('user', JSON.stringify(userData));
      setLoginDate(new Date().toDateString());

      return { success: true, user: userData };
    } catch (error) {
      console.error('Badge login error:', error);
      const errorMessage = error.response?.data?.detail || 'Invalid badge';
      return { success: false, error: errorMessage };
    }
  };

  const value = {
    user,
    isAuthenticated,
    loading,
    login,
    badgeLogin,
    logout
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};
