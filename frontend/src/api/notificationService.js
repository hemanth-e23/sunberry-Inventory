import apiClient from './client';

export const getUnreadCount = () => apiClient.get('/notifications/unread-count');
export const getNotifications = () => apiClient.get('/notifications/');
export const markAllRead = () => apiClient.put('/notifications/read-all', {});
export const markRead = (id) => apiClient.put(`/notifications/${id}/read`, {});
