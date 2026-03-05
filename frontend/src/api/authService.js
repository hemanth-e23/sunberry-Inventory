import axios from 'axios';
import apiClient from './client';

export const login = (username, password) =>
  apiClient.post('/auth/login', { username, password });

export const badgeLogin = (badgeId) =>
  apiClient.post('/auth/badge-login', { badge_id: badgeId });

export const getMe = () =>
  apiClient.get('/auth/me');

// Uses plain axios (NOT apiClient) to avoid the 401 interceptor triggering on refresh failure
export const refresh = () => {
  const token = localStorage.getItem('token');
  return axios.post('/api/auth/refresh', {}, {
    headers: { Authorization: `Bearer ${token}` },
  });
};
