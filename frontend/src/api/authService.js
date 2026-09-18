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
//
// The timeout is load-bearing, not hygiene. Bare axios defaults to NO timeout,
// and this call sits inside the 401 interceptor, which the offline scan queue's
// drain loop awaits. On a gun that is associated to the AP but has no route to
// the server — the same half-dead wifi that produced the offline scans — this
// request hangs forever, so the interceptor never resolves, so the drain's POST
// never settles, so `drainInFlight` never clears and NOTHING can flush for the
// rest of the session: not the poll, not tab focus, not the Sync now button.
// Bounded here, a dead refresh fails fast and the queue keeps its rhythm.
const REFRESH_TIMEOUT_MS = 15000;

export const refresh = () => {
  const token = localStorage.getItem('token');
  const baseURL = (import.meta.env.VITE_API_URL || '') + '/api';
  return axios.post(`${baseURL}/auth/refresh`, {}, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: REFRESH_TIMEOUT_MS,
  });
};
