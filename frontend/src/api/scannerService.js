import apiClient from './client';

// Scanner requests
export const getScannerRequests = (params) =>
  apiClient.get('/scanner/requests', { params });
export const getScannerRequest = (id) => apiClient.get(`/scanner/requests/${id}`);
export const createScannerRequest = (data) => apiClient.post('/scanner/requests', data);
export const scanRequest = (id, payload) =>
  apiClient.post(`/scanner/requests/${id}/scan`, payload);
export const markMissing = (id, payload) =>
  apiClient.post(`/scanner/requests/${id}/mark-missing`, payload);
export const submitScannerRequest = (id) =>
  apiClient.post(`/scanner/requests/${id}/submit`, {});
export const approveScannerRequest = (id) =>
  apiClient.post(`/scanner/requests/${id}/approve`, {});
export const rejectScannerRequest = (id) =>
  apiClient.post(`/scanner/requests/${id}/reject`, {});
export const updateScannerRequest = (id, data) =>
  apiClient.put(`/scanner/requests/${id}`, data);

// Scanner storage rows
export const getScannerStorageRows = () => apiClient.get('/scanner/storage-rows');

// Scanner internal transfer
export const internalTransfer = (data) => apiClient.post('/scanner/internal-transfer', data);

// Pallet licences
export const getPalletLicences = (params) =>
  apiClient.get('/pallet-licences/', { params });
export const updatePalletLicence = (id, data) =>
  apiClient.put(`/pallet-licences/${id}`, data);
export const deletePalletLicence = (id) => apiClient.delete(`/pallet-licences/${id}`);
export const addPalletToRequest = (requestId, data) =>
  apiClient.post(`/scanner/requests/${requestId}/pallets`, data);
export const createShipOutPickList = (data) =>
  apiClient.post('/scanner/ship-out/pick-list', data);
