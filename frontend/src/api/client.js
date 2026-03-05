import axios from 'axios';

let _warehouseHeader = null;
let _onUnauthorized = null;

export function setViewWarehouse(id) {
  _warehouseHeader = id || null;
}

export function setUnauthorizedHandler(fn) {
  _onUnauthorized = fn;
}

const apiClient = axios.create({ baseURL: (import.meta.env.VITE_API_URL || '') + '/api', timeout: 30000 });

// Request interceptor: read token from localStorage, add X-View-Warehouse if set
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers['Authorization'] = `Bearer ${token}`;
  if (_warehouseHeader) config.headers['X-View-Warehouse'] = _warehouseHeader;
  return config;
});

// Response interceptor: 401 → clear token + call logout handler
apiClient.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      _onUnauthorized?.();
    }
    return Promise.reject(err);
  }
);

export default apiClient;
