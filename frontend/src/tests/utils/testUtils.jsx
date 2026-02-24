import React from 'react'
import { render } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '../../context/AuthContext'
import { AppDataProvider } from '../../context/AppDataContext'

/**
 * Custom render function that includes all providers
 */
export function renderWithProviders(ui, { ...renderOptions } = {}) {
  function Wrapper({ children }) {
    return (
      <BrowserRouter>
        <AuthProvider>
          <AppDataProvider>
            {children}
          </AppDataProvider>
        </AuthProvider>
      </BrowserRouter>
    )
  }

  return render(ui, { wrapper: Wrapper, ...renderOptions })
}

/**
 * Mock user for testing
 */
export const mockUser = {
  id: 'user-123',
  username: 'testuser',
  name: 'Test User',
  email: 'test@example.com',
  role: 'warehouse',
  is_active: true,
}

/**
 * Mock admin user for testing
 */
export const mockAdmin = {
  id: 'user-admin',
  username: 'admin',
  name: 'Admin User',
  email: 'admin@example.com',
  role: 'admin',
  is_active: true,
}
