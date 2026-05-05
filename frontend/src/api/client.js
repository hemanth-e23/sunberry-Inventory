import axios from 'axios';

let _warehouseHeader = null;
let _onUnauthorized = null;
let _refreshTokenFn = null;

export function setViewWarehouse(id) {
  _warehouseHeader = id || null;
}

export function setUnauthorizedHandler(fn) {
  _onUnauthorized = fn;
}

export function setRefreshTokenHandler(fn) {
  _refreshTokenFn = fn;
}

const apiClient = axios.create({ baseURL: (import.meta.env.VITE_API_URL || '') + '/api', timeout: 30000 });

// Request interceptor: read token from localStorage, add X-View-Warehouse if set
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers['Authorization'] = `Bearer ${token}`;
  if (_warehouseHeader) config.headers['X-View-Warehouse'] = _warehouseHeader;
  return config;
});

// Single in-flight refresh shared by all concurrent 401-failed requests.
let refreshInFlight = null;
let refreshSubscribers = [];

function onRefreshSettled(success) {
  const subs = refreshSubscribers;
  refreshSubscribers = [];
  refreshInFlight = null;
  subs.forEach((cb) => cb(success));
}

function isAuthEndpoint(url) {
  if (!url) return false;
  return /\/auth\/(login|refresh|badge-login)\b/.test(url);
}

apiClient.interceptors.response.use(
  (r) => r,
  async (err) => {
    const original = err.config || {};
    const status = err.response?.status;

    // Force-logout cases:
    //   - Network error or non-401: just propagate
    //   - 401 from /auth/login or /auth/badge-login: real bad credentials
    //   - 401 from /auth/refresh: refresh actually failed
    //   - 401 after we already retried once (refresh succeeded but new token still 401)
    //   - No refresh handler wired up
    if (status !== 401) return Promise.reject(err);

    if (isAuthEndpoint(original.url) || original._authRetry || !_refreshTokenFn) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      _onUnauthorized?.();
      return Promise.reject(err);
    }

    // Try a one-shot refresh, then replay the original request once.
    original._authRetry = true;

    const waitForRefresh = new Promise((resolve) => {
      refreshSubscribers.push(resolve);
    });

    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        try {
          const ok = await _refreshTokenFn();
          onRefreshSettled(ok);
        } catch {
          onRefreshSettled(false);
        }
      })();
    }

    const success = await waitForRefresh;

    if (!success) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      _onUnauthorized?.();
      return Promise.reject(err);
    }

    const newToken = localStorage.getItem('token');
    if (newToken) {
      original.headers = original.headers || {};
      original.headers['Authorization'] = `Bearer ${newToken}`;
    }
    return apiClient(original);
  }
);

export default apiClient;
