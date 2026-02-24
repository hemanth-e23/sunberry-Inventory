import React, { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import './App.css';

// Components
import ErrorBoundary from './components/ErrorBoundary';
import Login from './components/Login';
import AdminDashboard from './components/AdminDashboard';
import ProductsPage from './components/ProductsPage';
import ReceiptPage from './components/ReceiptPage';
import InventoryOverview from './components/InventoryOverview';
import ApprovalsPage from './components/ApprovalsPage';
import UsersPage from './components/UsersPage';
import WarehouseDashboard from './components/WarehouseDashboard';
import SupervisorDashboard from './components/SupervisorDashboard';
import MasterDataPage from './components/MasterDataPage';
import Layout from './components/Layout';
import InventoryActionsPage from './components/InventoryActionsPage';
import ReportsPage from './components/ReportsPage';
import ReceiptCorrectionsPage from './components/ReceiptCorrectionsPage';
import UnauthorizedPage from './components/UnauthorizedPage';
import CycleCountingPage from './components/CycleCountingPage';
import PalletTagPrintPage from './components/PalletTagPrintPage';
import StagingOverview from './components/StagingOverview';
import ProductionStagingRequests from './components/ProductionStagingRequests';
import BOLPage from './components/BOLPage';
import ScannerLogin from './components/scanner/ScannerLogin';
import ScannerHome from './components/scanner/ScannerHome';
import ScannerReceiptFlow from './components/scanner/ScannerReceiptFlow';
import ScannerTransferFlow from './components/scanner/ScannerTransferFlow';
import ScannerShipOutFlow from './components/scanner/ScannerShipOutFlow';
import ScannerLayout from './components/scanner/ScannerLayout';

// Context
import { AuthProvider, useAuth } from './context/AuthContext';
import { AppDataProvider } from './context/AppDataContext';

// Protected Route Component
function ProtectedRoute({ children, requiredRole }) {
  const { user, isAuthenticated, loading } = useAuth();
  const redirectTo = requiredRole === 'forklift' ? '/forklift/login' : '/login';

  // Wait for authentication check to complete before making redirect decisions
  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>Loading...</div>;
  }

  if (!isAuthenticated) {
    return <Navigate to={redirectTo} replace />;
  }

  if (requiredRole && user?.role !== requiredRole) {
    return <Navigate to="/unauthorized" replace />;
  }

  return children;
}

// Utility function to get dashboard path based on user role
export const getDashboardPath = (userRole) => {
  switch (userRole) {
    case 'admin':
      return '/admin';
    case 'supervisor':
      return '/supervisor';
    case 'warehouse':
      return '/warehouse';
    case 'forklift':
      return '/forklift';
    default:
      return '/warehouse';
  }
};

// Main App Routes
function AppRoutes() {
  const { user, isAuthenticated, loading } = useAuth();

  const roleRedirects = {
    admin: '/admin',
    supervisor: '/supervisor',
    warehouse: '/warehouse',
    forklift: '/forklift'
  };

  const defaultRedirect = user?.role && roleRedirects[user.role] ? roleRedirects[user.role] : '/warehouse';

  const inventoryActionsElement = (
    <Layout>
      <InventoryActionsPage />
    </Layout>
  );

  return (
    <Routes>
      <Route
        path="/login"
        element={!isAuthenticated ? <Login /> : <Navigate to={defaultRedirect} replace />}
      />

      <Route
        path="/forklift/login"
        element={!isAuthenticated ? <ScannerLogin /> : <Navigate to="/forklift" replace />}
      />

      <Route path="/forklift" element={
        <ProtectedRoute requiredRole="forklift">
          <ScannerLayout title="Forklift">
            <ScannerHome />
          </ScannerLayout>
        </ProtectedRoute>
      } />

      <Route path="/forklift/receipt" element={
        <ProtectedRoute requiredRole="forklift">
          <ScannerReceiptFlow />
        </ProtectedRoute>
      } />

      <Route path="/forklift/transfer" element={
        <ProtectedRoute requiredRole="forklift">
          <ScannerTransferFlow />
        </ProtectedRoute>
      } />

      <Route path="/forklift/ship-out" element={
        <ProtectedRoute requiredRole="forklift">
          <ScannerShipOutFlow />
        </ProtectedRoute>
      } />

      <Route path="/admin" element={
        <ProtectedRoute requiredRole="admin">
          <Layout>
            <AdminDashboard />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/admin/products" element={
        <ProtectedRoute requiredRole="admin">
          <Layout>
            <ProductsPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/admin/master-data" element={
        <ProtectedRoute requiredRole="admin">
          <Layout>
            <MasterDataPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/admin/receipt" element={
        <ProtectedRoute requiredRole="admin">
          <Layout>
            <ReceiptPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/admin/inventory" element={
        <ProtectedRoute requiredRole="admin">
          <Layout>
            <InventoryOverview />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/admin/inventory-actions" element={
        <ProtectedRoute requiredRole="admin">
          {inventoryActionsElement}
        </ProtectedRoute>
      } />

      <Route path="/admin/staging" element={
        <ProtectedRoute requiredRole="admin">
          <Layout>
            <StagingOverview />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/admin/production-requests" element={
        <ProtectedRoute requiredRole="admin">
          <Layout>
            <ProductionStagingRequests />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/admin/approvals" element={
        <ProtectedRoute requiredRole="admin">
          <Layout>
            <ApprovalsPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/admin/users" element={
        <ProtectedRoute requiredRole="admin">
          <Layout>
            <UsersPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/admin/reports" element={
        <ProtectedRoute requiredRole="admin">
          <Layout>
            <ReportsPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/admin/bol" element={
        <ProtectedRoute requiredRole="admin">
          <Layout>
            <BOLPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/admin/cycle-counting" element={
        <ProtectedRoute requiredRole="admin">
          <Layout>
            <CycleCountingPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/admin/pallet-tags" element={
        <ProtectedRoute requiredRole="admin">
          <Layout>
            <PalletTagPrintPage />
          </Layout>
        </ProtectedRoute>
      } />


      <Route path="/warehouse" element={
        <ProtectedRoute requiredRole="warehouse">
          <Layout>
            <WarehouseDashboard />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/warehouse/receipt" element={
        <ProtectedRoute requiredRole="warehouse">
          <Layout>
            <ReceiptPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/warehouse/inventory" element={
        <ProtectedRoute requiredRole="warehouse">
          <Layout>
            <InventoryOverview />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/warehouse/inventory-actions" element={
        <ProtectedRoute requiredRole="warehouse">
          {inventoryActionsElement}
        </ProtectedRoute>
      } />

      <Route path="/warehouse/staging" element={
        <ProtectedRoute requiredRole="warehouse">
          <Layout>
            <StagingOverview />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/warehouse/production-requests" element={
        <ProtectedRoute requiredRole="warehouse">
          <Layout>
            <ProductionStagingRequests />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/warehouse/receipt-corrections" element={
        <ProtectedRoute requiredRole="warehouse">
          <Layout>
            <ReceiptCorrectionsPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/warehouse/cycle-counting" element={
        <ProtectedRoute requiredRole="warehouse">
          <Layout>
            <CycleCountingPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/warehouse/pallet-tags" element={
        <ProtectedRoute requiredRole="warehouse">
          <Layout>
            <PalletTagPrintPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/warehouse/approvals" element={
        <ProtectedRoute requiredRole="warehouse">
          <Layout>
            <ApprovalsPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/warehouse/bol" element={
        <ProtectedRoute requiredRole="warehouse">
          <Layout>
            <BOLPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/supervisor" element={
        <ProtectedRoute requiredRole="supervisor">
          <Layout>
            <SupervisorDashboard />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/supervisor/approvals" element={
        <ProtectedRoute requiredRole="supervisor">
          <Layout>
            <ApprovalsPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/supervisor/inventory" element={
        <ProtectedRoute requiredRole="supervisor">
          <Layout>
            <InventoryOverview />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/supervisor/inventory-actions" element={
        <ProtectedRoute requiredRole="supervisor">
          {inventoryActionsElement}
        </ProtectedRoute>
      } />

      <Route path="/supervisor/staging" element={
        <ProtectedRoute requiredRole="supervisor">
          <Layout>
            <StagingOverview />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/supervisor/production-requests" element={
        <ProtectedRoute requiredRole="supervisor">
          <Layout>
            <ProductionStagingRequests />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/supervisor/products" element={
        <ProtectedRoute requiredRole="supervisor">
          <Layout>
            <ProductsPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/supervisor/master-data" element={
        <ProtectedRoute requiredRole="supervisor">
          <Layout>
            <MasterDataPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/supervisor/receipt" element={
        <ProtectedRoute requiredRole="supervisor">
          <Layout>
            <ReceiptPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/supervisor/pallet-tags" element={
        <ProtectedRoute requiredRole="supervisor">
          <Layout>
            <PalletTagPrintPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/supervisor/cycle-counting" element={
        <ProtectedRoute requiredRole="supervisor">
          <Layout>
            <CycleCountingPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route path="/supervisor/bol" element={
        <ProtectedRoute requiredRole="supervisor">
          <Layout>
            <BOLPage />
          </Layout>
        </ProtectedRoute>
      } />

      <Route
        path="/"
        element={
          loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>Loading...</div>
          ) : isAuthenticated ? (
            <Navigate to={defaultRedirect} replace />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route path="/unauthorized" element={<UnauthorizedPage />} />

      {/* Catch-all route for undefined paths */}
      <Route
        path="*"
        element={
          loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>Loading...</div>
          ) : isAuthenticated ? (
            <Navigate to={defaultRedirect} replace />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
    </Routes>
  );
}

function App() {
  // Prevent mouse wheel scrolling from changing number input values
  useEffect(() => {
    const handleWheel = (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type === 'number') {
        e.preventDefault();
        e.target.blur();
      }
    };

    // Use capture phase to catch all wheel events
    document.addEventListener('wheel', handleWheel, { passive: false, capture: true });

    return () => {
      document.removeEventListener('wheel', handleWheel, { capture: true });
    };
  }, []);

  return (
    <ErrorBoundary>
      <AuthProvider>
        <AppDataProvider>
          <Router>
            <div className="App">
              <AppRoutes />
            </div>
          </Router>
        </AppDataProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
