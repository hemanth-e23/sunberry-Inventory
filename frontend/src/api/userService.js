import apiClient from './client';

export const getUsers = () => apiClient.get('/users/');
export const createUser = (data) => apiClient.post('/users/', data);
export const updateUser = (id, data) => apiClient.put(`/users/${id}`, data);
export const toggleUserStatus = (id, data) => apiClient.put(`/users/${id}`, data);
