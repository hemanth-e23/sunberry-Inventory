import apiClient from './client';

// Transfers
export const getTransfers = (params) => apiClient.get('/inventory/transfers', { params });
export const createTransfer = (data) => apiClient.post('/inventory/transfers', data);
export const approveTransfer = (id) => apiClient.post(`/inventory/transfers/${id}/approve`, {});
export const rejectTransfer = (id, reason) =>
  apiClient.post(`/inventory/transfers/${id}/reject?reason=${encodeURIComponent(reason || '')}`, {});
export const getTransferScanProgress = (id) =>
  apiClient.get(`/inventory/transfers/${id}/scan-progress`);

// Hold actions
export const getHoldActions = () => apiClient.get('/inventory/hold-actions');
export const createHoldAction = (data) => apiClient.post('/inventory/hold-actions', data);
export const approveHoldAction = (id) => apiClient.post(`/inventory/hold-actions/${id}/approve`, {});
export const rejectHoldAction = (id) => apiClient.post(`/inventory/hold-actions/${id}/reject`, {});

// Adjustments
export const getAdjustments = () => apiClient.get('/inventory/adjustments');
export const createAdjustment = (data) => apiClient.post('/inventory/adjustments', data);
export const approveAdjustment = (id) => apiClient.post(`/inventory/adjustments/${id}/approve`, {});
export const rejectAdjustment = (id) => apiClient.post(`/inventory/adjustments/${id}/reject`, {});

// Cycle counts
export const getCycleCounts = () => apiClient.get('/inventory/cycle-counts');
export const createCycleCount = (data) => apiClient.post('/inventory/cycle-counts', data);

// Staging
export const stagingTransfer = (data) => apiClient.post('/inventory/staging/transfer', data);

// BOL
export const getBOL = (params) => apiClient.get('/inventory/bol', { params });

// Ship-out
export const createShipOut = (data) => apiClient.post('/inventory/ship-out', data);
export const getShipOutPickList = (params) =>
  apiClient.get('/inventory/ship-out/pick-list', { params });
