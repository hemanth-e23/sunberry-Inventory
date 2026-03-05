import apiClient from './client';

export const getInterWarehouseTransfers = (params) =>
  apiClient.get('/inter-warehouse-transfers/', { params });
export const createInterWarehouseTransfer = (data) =>
  apiClient.post('/inter-warehouse-transfers/', data);
export const performTransferAction = (id, action, payload = {}) =>
  apiClient.post(`/inter-warehouse-transfers/${id}/${action}`, payload);
