import React, { lazy, Suspense, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import './App.css';
// Shared stylesheets used across many pages — imported here so they land in the
// main CSS bundle and are available before any lazy page chunk loads (prevents FOUC).
import './components/Shared.css';
import './components/InventoryActionsPage.css';

// Eagerly-loaded (critical path — needed before or during auth)
import ErrorBoundary from './components/ErrorBoundary';
import Login from './components/Login';
import Layout from './components/Layout';
import ScannerLogin from './components/scanner/ScannerLogin';
import ScannerLayout from './components/scanner/ScannerLayout';
import UnauthorizedPage from './components/UnauthorizedPage';
import LoadingSpinner from './components/LoadingSpinner';

// Lazy-loaded page components (split into separate JS chunks)
const AdminDashboard = lazy(() => import('./components/AdminDashboard'));
const ProductsPage = lazy(() => import('./components/ProductsPage'));
const ReceiptPage = lazy(() => import('./components/ReceiptPage'));
const InventoryOverview = lazy(() => import('./components/InventoryOverview'));
const ApprovalsPage = lazy(() => import('./components/ApprovalsPage'));
const UsersPage = lazy(() => import('./components/UsersPage'));
const WarehouseDashboard = lazy(() => import('./components/WarehouseDashboard'));
const SupervisorDashboard = lazy(() => import('./components/SupervisorDashboard'));
const MasterDataPage = lazy(() => import('./components/MasterDataPage'));
const InventoryActionsPage = lazy(() => import('./components/InventoryActionsPage'));
const ReportsPage = lazy(() => import('./components/ReportsPage'));
const ReceiptCorrectionsPage = lazy(() => import('./components/ReceiptCorrectionsPage'));
const CycleCountingPage = lazy(() => import('./components/CycleCountingPage'));
const PalletTagPrintPage = lazy(() => import('./components/PalletTagPrintPage'));
const StagingOverview = lazy(() => import('./components/StagingOverview'));
const ProductionStagingRequests = lazy(() => import('./components/ProductionStagingRequests'));
const BOLPage = lazy(() => import('./components/BOLPage'));
const InterWarehouseTransfersPage = lazy(() => import('./components/InterWarehouseTransfersPage'));
const SuperadminDashboard = lazy(() => import('./components/SuperadminDashboard'));
const WarehousesPage = lazy(() => import('./components/WarehousesPage'));
const ScannerHome = lazy(() => import('./components/scanner/ScannerHome'));
const ScannerReceiptFlow = lazy(() => import('./components/scanner/ScannerReceiptFlow'));
const ScannerTransferFlow = lazy(() => import('./components/scanner/ScannerTransferFlow'));
const ScannerShipOutFlow = lazy(() => import('./components/scanner/ScannerShipOutFlow'));

// Context
import { ToastProvider } from './context/ToastContext';
import { ConfirmProvider } from './context/ConfirmContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { UserProvider } from './context/domains/UserContext';
import { FoundationProvider } from './context/domains/FoundationContext';
import { LocationProvider } from './context/domains/LocationContext';
import { ReceiptProvider } from './context/domains/ReceiptContext';
import { InventoryProvider } from './context/domains/InventoryContext';
import { ReportingProvider } from './context/domains/ReportingContext';
import { AppDataProvider } from './context/AppDataContext';
import { hasFeature } from './utils/warehouseFeatures';

// Suspense fallback shown while lazy chunks load
const PageLoader = () => (
  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
    <LoadingSpinner />
  </div>
);

// Wraps a page element in a per-page ErrorBoundary so one crashed page
// doesn't take down the entire app (the global boundary stays as a last resort)
const page = (el) => <ErrorBoundary>{el}</ErrorBoundary>;

// Protected Route Component
function ProtectedRoute({ children, requiredRole, requiredFeature }) {
  const { user, isAuthenticated, loading } = useAuth();
  const redirectTo = requiredRole === 'forklift' ? '/forklift/login' : '/login';

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>Loading...</div>;
  }

  if (!isAuthenticated) {
    return <Navigate to={redirectTo} replace />;
  }

  const SUPERADMIN_ROLES = ['superadmin', 'corporate_admin', 'corporate_viewer'];
  if (requiredRole && user?.role !== requiredRole && !SUPERADMIN_ROLES.includes(user?.role)) {
    return <Navigate to="/unauthorized" replace />;
  }

  if (requiredFeature && !hasFeature(user?.warehouse_type, requiredFeature)) {
    return <Navigate to="/unauthorized" replace />;
  }

  return children;
}

// Utility function to get dashboard path based on user role
export const getDashboardPath = (userRole) => {
  switch (userRole) {
    case 'superadmin':
    case 'corporate_admin':
    case 'corporate_viewer':
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

// Session expiry warning banner
function SessionWarningBanner() {
  const { sessionWarning, clearSessionWarning } = useAuth();
  if (!sessionWarning) return null;
  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 99999,
      background: '#dc2626',
      color: '#fff',
      padding: '12px 20px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '12px',
      fontWeight: 600,
      fontSize: '14px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    }}>
      <span>⚠ {sessionWarning}</span>
      <button
        onClick={clearSessionWarning}
        style={{
          background: 'transparent',
          border: '1px solid rgba(255,255,255,0.6)',
          color: '#fff',
          borderRadius: '4px',
          padding: '2px 10px',
          cursor: 'pointer',
          fontSize: '13px',
        }}
      >
        Dismiss
      </button>
    </div>
  );
}

// Main App Routes
function AppRoutes() {
  const { user, isAuthenticated, loading } = useAuth();

  const roleRedirects = {
    superadmin: '/admin',
    corporate_admin: '/admin',
    corporate_viewer: '/admin',
    admin: '/admin',
    supervisor: '/supervisor',
    warehouse: '/warehouse',
    forklift: '/forklift'
  };

  const defaultRedirect = user?.role && roleRedirects[user.role] ? roleRedirects[user.role] : '/warehouse';

  const inventoryActionsElement = (
    <Layout>
      {page(<InventoryActionsPage />)}
    </Layout>
  );

  return (
    <Suspense fallback={<PageLoader />}>
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
              {page(user?.role === 'superadmin' ? <SuperadminDashboard /> : <AdminDashboard />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/admin/warehouses" element={
          <ProtectedRoute requiredRole="admin">
            <Layout>
              {page(<WarehousesPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/admin/products" element={
          <ProtectedRoute requiredRole="admin">
            <Layout>
              {page(<ProductsPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/admin/master-data" element={
          <ProtectedRoute requiredRole="admin">
            <Layout>
              {page(<MasterDataPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/admin/receipt" element={
          <ProtectedRoute requiredRole="admin">
            <Layout>
              {page(<ReceiptPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/admin/inventory" element={
          <ProtectedRoute requiredRole="admin">
            <Layout>
              {page(<InventoryOverview />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/admin/inventory-actions" element={
          <ProtectedRoute requiredRole="admin">
            {inventoryActionsElement}
          </ProtectedRoute>
        } />

        <Route path="/admin/staging" element={
          <ProtectedRoute requiredRole="admin" requiredFeature="staging">
            <Layout>
              {page(<StagingOverview />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/admin/production-requests" element={
          <ProtectedRoute requiredRole="admin" requiredFeature="productionRequests">
            <Layout>
              {page(<ProductionStagingRequests />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/admin/approvals" element={
          <ProtectedRoute requiredRole="admin">
            <Layout>
              {page(<ApprovalsPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/admin/users" element={
          <ProtectedRoute requiredRole="superadmin">
            <Layout>
              {page(<UsersPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/admin/reports" element={
          <ProtectedRoute requiredRole="admin">
            <Layout>
              {page(<ReportsPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/admin/bol" element={
          <ProtectedRoute requiredRole="admin">
            <Layout>
              {page(<BOLPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/admin/cycle-counting" element={
          <ProtectedRoute requiredRole="admin">
            <Layout>
              {page(<CycleCountingPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/admin/pallet-tags" element={
          <ProtectedRoute requiredRole="admin">
            <Layout>
              {page(<PalletTagPrintPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/admin/inter-warehouse-transfers" element={
          <ProtectedRoute requiredRole="admin">
            <Layout>
              {page(<InterWarehouseTransfersPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/warehouse" element={
          <ProtectedRoute requiredRole="warehouse">
            <Layout>
              {page(<WarehouseDashboard />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/warehouse/receipt" element={
          <ProtectedRoute requiredRole="warehouse">
            <Layout>
              {page(<ReceiptPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/warehouse/inventory" element={
          <ProtectedRoute requiredRole="warehouse">
            <Layout>
              {page(<InventoryOverview />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/warehouse/inventory-actions" element={
          <ProtectedRoute requiredRole="warehouse">
            {inventoryActionsElement}
          </ProtectedRoute>
        } />

        <Route path="/warehouse/staging" element={
          <ProtectedRoute requiredRole="warehouse" requiredFeature="staging">
            <Layout>
              {page(<StagingOverview />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/warehouse/production-requests" element={
          <ProtectedRoute requiredRole="warehouse" requiredFeature="productionRequests">
            <Layout>
              {page(<ProductionStagingRequests />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/warehouse/receipt-corrections" element={
          <ProtectedRoute requiredRole="warehouse">
            <Layout>
              {page(<ReceiptCorrectionsPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/warehouse/cycle-counting" element={
          <ProtectedRoute requiredRole="warehouse">
            <Layout>
              {page(<CycleCountingPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/warehouse/pallet-tags" element={
          <ProtectedRoute requiredRole="warehouse">
            <Layout>
              {page(<PalletTagPrintPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/warehouse/approvals" element={
          <ProtectedRoute requiredRole="warehouse">
            <Layout>
              {page(<ApprovalsPage />)}
            </Layout>
          </ProtectedRoute>
        } />


        <Route path="/supervisor" element={
          <ProtectedRoute requiredRole="supervisor">
            <Layout>
              {page(<SupervisorDashboard />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/supervisor/approvals" element={
          <ProtectedRoute requiredRole="supervisor">
            <Layout>
              {page(<ApprovalsPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/supervisor/inventory" element={
          <ProtectedRoute requiredRole="supervisor">
            <Layout>
              {page(<InventoryOverview />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/supervisor/inventory-actions" element={
          <ProtectedRoute requiredRole="supervisor">
            {inventoryActionsElement}
          </ProtectedRoute>
        } />

        <Route path="/supervisor/staging" element={
          <ProtectedRoute requiredRole="supervisor" requiredFeature="staging">
            <Layout>
              {page(<StagingOverview />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/supervisor/production-requests" element={
          <ProtectedRoute requiredRole="supervisor" requiredFeature="productionRequests">
            <Layout>
              {page(<ProductionStagingRequests />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/supervisor/products" element={
          <ProtectedRoute requiredRole="supervisor">
            <Layout>
              {page(<ProductsPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/supervisor/master-data" element={
          <ProtectedRoute requiredRole="supervisor">
            <Layout>
              {page(<MasterDataPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/supervisor/receipt" element={
          <ProtectedRoute requiredRole="supervisor">
            <Layout>
              {page(<ReceiptPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/supervisor/pallet-tags" element={
          <ProtectedRoute requiredRole="supervisor">
            <Layout>
              {page(<PalletTagPrintPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/supervisor/cycle-counting" element={
          <ProtectedRoute requiredRole="supervisor">
            <Layout>
              {page(<CycleCountingPage />)}
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
    </Suspense>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function App() {
  // Prevent mouse wheel scrolling from changing number input values
  useEffect(() => {
    const handleWheel = (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type === 'number') {
        e.preventDefault();
        e.target.blur();
      }
    };
    document.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    return () => {
      document.removeEventListener('wheel', handleWheel, { capture: true });
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
    <ErrorBoundary>
      <ToastProvider>
      <ConfirmProvider>
      <AuthProvider>
        <UserProvider>
          <FoundationProvider>
            <LocationProvider>
              <ReceiptProvider>
                <InventoryProvider>
                  <ReportingProvider>
                    <AppDataProvider>
                      <Router>
                        <div className="App">
                          <SessionWarningBanner />
                          <AppRoutes />
                        </div>
                      </Router>
                    </AppDataProvider>
                  </ReportingProvider>
                </InventoryProvider>
              </ReceiptProvider>
            </LocationProvider>
          </FoundationProvider>
        </UserProvider>
      </AuthProvider>
      </ConfirmProvider>
      </ToastProvider>
    </ErrorBoundary>
    </QueryClientProvider>
  );
}

export default App;
