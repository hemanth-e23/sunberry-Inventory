import axios from 'axios';
import apiClient from './client';

export const login = (username, password) =>
  apiClient.post('/auth/login', { username, password });

export const badgeLogin = (badgeId) =>
  apiClient.post('/auth/badge-login', { badge_id: badgeId });

export const getMe = () =>
  apiClient.get('/auth/me');

// Uses plain axios (NOT apiClient) to avoid the 401 interceptor triggering on
// refresh failure. Must still hit the API host (VITE_API_URL), same base as
// client.js — a relative URL resolves against the frontend origin and 404s in
// production, breaking refresh entirely.
export const refresh = () => {
  const token = localStorage.getItem('token');
  const baseURL = (import.meta.env.VITE_API_URL || '') + '/api';
  return axios.post(`${baseURL}/auth/refresh`, {}, {
    headers: { Authorization: `Bearer ${token}` },
  });
};
