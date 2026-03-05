import apiClient from './client';

// Locations
export const getLocations = () => apiClient.get('/master-data/locations');
export const createLocation = (data) => apiClient.post('/master-data/locations', data);
export const updateLocation = (id, data) => apiClient.put(`/master-data/locations/${id}`, data);

// Sub-locations
export const getSubLocations = () => apiClient.get('/master-data/sub-locations');
export const createSubLocation = (data) => apiClient.post('/master-data/sub-locations', data);
export const updateSubLocation = (id, data) =>
  apiClient.put(`/master-data/sub-locations/${id}`, data);

// Storage areas
export const getStorageAreas = () => apiClient.get('/master-data/storage-areas');
export const createStorageArea = (data) => apiClient.post('/master-data/storage-areas', data);
export const updateStorageArea = (id, data) =>
  apiClient.put(`/master-data/storage-areas/${id}`, data);

// Storage rows
export const getStorageRow = (id) => apiClient.get(`/master-data/storage-rows/${id}`);
export const createStorageRow = (data) => apiClient.post('/master-data/storage-rows', data);
export const updateStorageRow = (id, data) =>
  apiClient.put(`/master-data/storage-rows/${id}`, data);

// Production
export const getProductionShifts = () => apiClient.get('/master-data/production-shifts');
export const createProductionShift = (data) =>
  apiClient.post('/master-data/production-shifts', data);
export const updateProductionShift = (id, data) =>
  apiClient.put(`/master-data/production-shifts/${id}`, data);

export const getProductionLines = () => apiClient.get('/master-data/production-lines');
export const createProductionLine = (data) =>
  apiClient.post('/master-data/production-lines', data);
export const updateProductionLine = (id, data) =>
  apiClient.put(`/master-data/production-lines/${id}`, data);

// Warehouses
export const getWarehouses = () => apiClient.get('/master-data/warehouses');
export const createWarehouse = (data) => apiClient.post('/master-data/warehouses', data);
export const updateWarehouse = (id, data) =>
  apiClient.put(`/master-data/warehouses/${id}`, data);
