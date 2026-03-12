import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAutoLogout } from '../hooks/useAutoLogout';
import { useTokenRefresh } from '../hooks/useTokenRefresh';
import { setViewWarehouse, setUnauthorizedHandler } from '../api/client';
import * as authService from '../api/authService';
import { setAppTimezone } from '../utils/dateUtils';
import { ROLES } from '../constants';

const CORPORATE_ROLES = ['superadmin', 'corporate_admin', 'corporate_viewer'];

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
  const [sessionWarning, setSessionWarning] = useState(null);
  const [selectedWarehouse, setSelectedWarehouse] = useState(null);
  const [selectedWarehouseName, setSelectedWarehouseName] = useState(null);
  const isForklift = useRef(false);
  const queryClient = useQueryClient();

  const logout = useCallback(() => {
    setUser(null);
    setIsAuthenticated(false);
    setSessionWarning(null);
    setSelectedWarehouse(null);
    clearLoginDate();
    localStorage.removeItem('user');
    localStorage.removeItem('token');
    isForklift.current = false;
    queryClient.clear();
  }, [queryClient]);

  // Wire the unauthorized handler — uses a ref so logout is always current
  const logoutRef = useRef(logout);
  useEffect(() => { logoutRef.current = logout; }, [logout]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      logoutRef.current();
      window.location.href = import.meta.env.BASE_URL + 'login';
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // Keep apiClient's X-View-Warehouse header in sync
  useEffect(() => {
    setViewWarehouse(selectedWarehouse);
  }, [selectedWarehouse]);

  const clearSessionWarning = useCallback(() => setSessionWarning(null), []);

  // Silently call /api/auth/refresh and store the new token
  const refreshToken = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) return false;
    try {
      const response = await authService.refresh();
      localStorage.setItem('token', response.data.access_token);
      return true;
    } catch {
      return false;
    }
  }, []);

  // Called when token is expired and refresh failed — warn then force logout
  const handleTokenExpired = useCallback(() => {
    setSessionWarning('Your session has expired. Please log in again.');
    setTimeout(() => {
      logout();
      window.location.href = import.meta.env.BASE_URL + 'login';
    }, 4000);
  }, [logout]);

  // Auto-logout: 30 min for non-forklift; forklift uses day-change only
  useAutoLogout(logout, isAuthenticated, user?.role === ROLES.FORKLIFT ? null : 30);

  // Silent token refresh: only for non-forklift users
  useTokenRefresh(
    isAuthenticated && user?.role !== ROLES.FORKLIFT,
    refreshToken,
    handleTokenExpired
  );

  // Forklift: check day-change and force re-login
  useEffect(() => {
    if (!isAuthenticated || user?.role !== ROLES.FORKLIFT) return;
    const today = new Date().toDateString();
    if (getLoginDate() && getLoginDate() !== today) {
      logout();
    }
  }, [isAuthenticated, user?.role, logout]);

  useEffect(() => {
    const checkAuth = async () => {
      const savedUser = localStorage.getItem('user');
      const token = localStorage.getItem('token');

      if (savedUser && token) {
        try {
          const response = await authService.getMe();
          const userData = {
            id: response.data.id,
            username: response.data.username,
            role: response.data.role,
            name: response.data.name,
            email: response.data.email,
            warehouse_id: response.data.warehouse_id || null,
            warehouse_type: response.data.warehouse?.type || null,
            warehouse_name: response.data.warehouse?.name || null,
            warehouse_timezone: response.data.warehouse?.timezone || null,
          };
          setAppTimezone(userData.warehouse_timezone);
          setUser(userData);
          setIsAuthenticated(true);
          localStorage.setItem('user', JSON.stringify(userData));
        } catch (error) {
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
      const response = await authService.login(username, password);
      const token = response.data.access_token;
      localStorage.setItem('token', token);

      const userResponse = await authService.getMe();
      const userData = {
        id: userResponse.data.id,
        username: userResponse.data.username,
        role: userResponse.data.role,
        name: userResponse.data.name,
        email: userResponse.data.email,
        warehouse_id: userResponse.data.warehouse_id || null,
        warehouse_type: userResponse.data.warehouse?.type || null,
        warehouse_name: userResponse.data.warehouse?.name || null,
        warehouse_timezone: userResponse.data.warehouse?.timezone || null,
      };

      setAppTimezone(userData.warehouse_timezone);
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
      const response = await authService.badgeLogin(badgeId);
      const token = response.data.access_token;
      localStorage.setItem('token', token);

      const userResponse = await authService.getMe();
      const userData = {
        id: userResponse.data.id,
        username: userResponse.data.username,
        role: userResponse.data.role,
        name: userResponse.data.name,
        email: userResponse.data.email,
        warehouse_id: userResponse.data.warehouse_id || null,
        warehouse_type: userResponse.data.warehouse?.type || null,
        warehouse_name: userResponse.data.warehouse?.name || null,
        warehouse_timezone: userResponse.data.warehouse?.timezone || null,
      };

      setAppTimezone(userData.warehouse_timezone);
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

  const isCorporateUser = user && CORPORATE_ROLES.includes(user.role);

  const value = {
    user,
    isAuthenticated,
    loading,
    login,
    badgeLogin,
    logout,
    sessionWarning,
    clearSessionWarning,
    selectedWarehouse,
    selectedWarehouseName,
    setSelectedWarehouse: isCorporateUser ? setSelectedWarehouse : undefined,
    setSelectedWarehouseName: isCorporateUser ? setSelectedWarehouseName : undefined,
    isCorporateUser: !!isCorporateUser,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};
