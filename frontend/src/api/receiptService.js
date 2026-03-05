import apiClient from './client';

export const getReceipts = (params) => apiClient.get('/receipts/', { params });
export const createReceipt = (data) => apiClient.post('/receipts/', data);
export const updateReceipt = (id, data) => apiClient.put(`/receipts/${id}`, data);
export const approveReceipt = (id) => apiClient.post(`/receipts/${id}/approve`, {});
export const rejectReceipt = (id) => apiClient.post(`/receipts/${id}/reject`, {});
export const sendBackReceipt = (id) => apiClient.post(`/receipts/${id}/send-back`, {});
