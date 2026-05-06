import axios from 'axios';
import apiClient from './client';

// ─── Authenticated supervisor/admin endpoints ────────────────────────────────
export const getActiveProductionLines = () =>
  apiClient.get('/active-production/lines');

export const setActiveProduction = (lineId, productId) =>
  apiClient.post(`/active-production/lines/${lineId}/set`, { product_id: productId });

export const clearActiveProduction = (lineId) =>
  apiClient.delete(`/active-production/lines/${lineId}/active`);

// ─── Kiosk endpoints (no JWT — uses X-Api-Key) ───────────────────────────────
// The kiosk is a separate page that bookmarks a URL with the api key in it,
// so we build a dedicated axios client and pass the key per request.

const kioskClient = axios.create({
  baseURL: (import.meta.env.VITE_API_URL || '') + '/api',
  timeout: 30000,
});

const withKey = (apiKey, config = {}) => ({
  ...config,
  headers: {
    ...(config.headers || {}),
    'X-Api-Key': apiKey,
  },
});

export const kioskGetLines = (apiKey, warehouseId) =>
  kioskClient.get('/palletizer/lines', withKey(apiKey, { params: { warehouse_id: warehouseId } }));

export const kioskMintPallets = (apiKey, warehouseId, lineId, count) =>
  kioskClient.post(
    `/palletizer/lines/${lineId}/mint-pallets`,
    { count },
    withKey(apiKey, { params: { warehouse_id: warehouseId } }),
  );

export const kioskRecentPallets = (apiKey, warehouseId, lineId) =>
  kioskClient.get(
    `/palletizer/lines/${lineId}/recent-pallets`,
    withKey(apiKey, { params: { warehouse_id: warehouseId } }),
  );
