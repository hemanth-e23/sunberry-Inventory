import apiClient from './client';

// Categories
export const getCategories = () => apiClient.get('/products/categories');
export const createCategory = (data) => apiClient.post('/products/categories', data);
export const updateCategory = (id, data) => apiClient.put(`/products/categories/${id}`, data);

// Products
export const getProducts = (params) => apiClient.get('/products/products', { params });
export const createProduct = (data) => apiClient.post('/products/products', data);
export const updateProduct = (id, data) => apiClient.put(`/products/products/${id}`, data);
export const toggleProductStatus = (id) =>
  apiClient.post(`/products/products/${id}/toggle-status`, {});

// Vendors
export const getVendors = () => apiClient.get('/products/vendors');
export const createVendor = (data) => apiClient.post('/products/vendors', data);
export const updateVendor = (id, data) => apiClient.put(`/products/vendors/${id}`, data);
