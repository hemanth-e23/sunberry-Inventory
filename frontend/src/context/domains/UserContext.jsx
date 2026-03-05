import React, { createContext, useContext, useState, useEffect } from 'react';
import apiClient from '../../api/client';
import { useAuth } from '../AuthContext';

const UserContext = createContext(null);

export const useUserContext = () => {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error('useUserContext must be used within a UserProvider');
  return ctx;
};

const ROLES_WITH_USER_ACCESS = ['superadmin', 'corporate_admin', 'corporate_viewer', 'admin', 'supervisor'];

export const UserProvider = ({ children }) => {
  const { isAuthenticated, loading: authLoading, user } = useAuth();
  const [users, setUsers] = useState([]);
  // userNameMap: id/username → display name, from all warehouses (for resolving submitter names)
  const [userNameMap, setUserNameMap] = useState({});

  useEffect(() => {
    if (authLoading || !isAuthenticated) return;
    if (!ROLES_WITH_USER_ACCESS.includes(user?.role)) return;
    const fetchUsers = async () => {
      try {
        const response = await apiClient.get('/users/');
        const usersData = response.data.map(user => ({
          id: user.id,
          username: user.username,
          name: user.name,
          role: user.role,
          status: user.is_active ? "active" : "inactive",
          email: user.email || null,
          badgeId: user.badge_id || null,
          warehouse_id: user.warehouse_id || null,
        }));
        setUsers(usersData);
      } catch (error) {
        if (error.response?.status !== 403) {
          console.error('Error fetching users:', error);
        }
      }
    };
    const fetchDirectory = async () => {
      try {
        const response = await apiClient.get('/users/directory');
        const map = {};
        response.data.forEach(u => {
          const label = u.name || u.username;
          map[u.id] = label;
          map[u.username] = label;
        });
        setUserNameMap(map);
      } catch (error) {
        if (error.response?.status !== 403) {
          console.error('Error fetching user directory:', error);
        }
      }
    };
    fetchUsers();
    fetchDirectory();
  }, [authLoading, isAuthenticated, user?.role]);

  const addUser = async (user) => {
    const userData = {
      username: user.username,
      name: user.name,
      role: user.role,
      password: user.password,
      email: user.email || null,
      ...(user.badgeId ? { badge_id: user.badgeId } : {}),
      ...(user.warehouse_id !== undefined ? { warehouse_id: user.warehouse_id || null } : {}),
    };
    try {
      const response = await apiClient.post('/users/', userData);
      const newUser = {
        id: response.data.id,
        username: response.data.username,
        name: response.data.name,
        role: response.data.role,
        status: response.data.is_active ? "active" : "inactive",
        email: response.data.email || null,
        badgeId: response.data.badge_id || null,
        warehouse_id: response.data.warehouse_id || null,
      };
      setUsers(prev => [...prev, newUser]);
      return newUser;
    } catch (error) {
      console.error('Error adding user:', error);
      const detail = error.response?.data?.detail;
      const errorMessage = typeof detail === 'string' ? detail
        : Array.isArray(detail) ? detail.map(d => d.msg || JSON.stringify(d)).join(', ')
        : detail && typeof detail === 'object' ? JSON.stringify(detail)
        : (error.message || 'Failed to add user');
      throw new Error(errorMessage);
    }
  };

  const updateUser = async (id, updates) => {
    const updateData = {};
    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.username !== undefined) updateData.username = updates.username;
    if (updates.role !== undefined) updateData.role = updates.role;
    if (updates.email !== undefined) updateData.email = updates.email;
    if (updates.password !== undefined && updates.password !== '') updateData.password = updates.password;
    if (updates.badgeId !== undefined) updateData.badge_id = updates.badgeId === '' ? null : updates.badgeId;
    if (updates.warehouse_id !== undefined) updateData.warehouse_id = updates.warehouse_id || null;
    try {
      const response = await apiClient.put(`/users/${id}`, updateData);
      const updatedUser = {
        id: response.data.id,
        username: response.data.username,
        name: response.data.name,
        role: response.data.role,
        status: response.data.is_active ? "active" : "inactive",
        email: response.data.email || null,
        badgeId: response.data.badge_id || null,
        warehouse_id: response.data.warehouse_id || null,
      };
      setUsers(prev => prev.map(u => u.id === id ? updatedUser : u));
      return updatedUser;
    } catch (error) {
      console.error('Error updating user:', error);
      const detail = error.response?.data?.detail;
      const errorMessage = typeof detail === 'string' ? detail
        : Array.isArray(detail) ? detail.map(d => d.msg || JSON.stringify(d)).join(', ')
        : detail && typeof detail === 'object' ? JSON.stringify(detail)
        : (error.message || 'Failed to update user');
      throw new Error(errorMessage);
    }
  };

  const toggleUserStatus = async (id) => {
    const user = users.find(u => u.id === id);
    if (!user) return;
    const newStatus = user.status === 'active' ? false : true;
    try {
      const response = await apiClient.put(`/users/${id}`, { is_active: newStatus });
      const updatedUser = {
        id: response.data.id,
        username: response.data.username,
        name: response.data.name,
        role: response.data.role,
        status: response.data.is_active ? "active" : "inactive",
        email: response.data.email || null,
        badgeId: response.data.badge_id || null,
        warehouse_id: response.data.warehouse_id || null,
      };
      setUsers(prev => prev.map(u => u.id === id ? updatedUser : u));
    } catch (error) {
      console.error('Error toggling user status:', error);
      const detail = error.response?.data?.detail;
      const errorMessage = typeof detail === 'string' ? detail
        : Array.isArray(detail) ? detail.map(d => d.msg || JSON.stringify(d)).join(', ')
        : detail && typeof detail === 'object' ? JSON.stringify(detail)
        : (error.message || 'Failed to toggle user status');
      throw new Error(errorMessage);
    }
  };

  const value = { users, userNameMap, addUser, updateUser, toggleUserStatus };

  return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
};
