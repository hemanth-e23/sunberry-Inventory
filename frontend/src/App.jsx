import React, { lazy, Suspense, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
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
const ShippingPage = lazy(() => import('./components/ShippingPage'));
const ReportsPage = lazy(() => import('./components/ReportsPage'));
const ReceiptCorrectionsPage = lazy(() => import('./components/ReceiptCorrectionsPage'));
const CycleCountingPage = lazy(() => import('./components/CycleCountingPage'));
const PalletTagPrintPage = lazy(() => import('./components/PalletTagPrintPage'));
const ActiveProductionPage = lazy(() => import('./components/palletizer/ActiveProductionPage'));
const PalletizerKioskPage = lazy(() => import('./components/palletizer/PalletizerKioskPage'));
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
const ScannerShipOutFlowV2 = lazy(() => import('./components/scanner/ScannerShipOutFlowV2'));

// Ingredient container serialization (INGREDIENT-SERIALIZATION-SPEC.md).
// Mounted under each role prefix like the rest of the app; the desk pages read
// their own base path off the URL so links stay inside the caller's prefix.
const ScannerIngredientReceiveFlow = lazy(() => import('./components/scanner/ScannerIngredientReceiveFlow'));
const ScannerLotReceiveFlow = lazy(() => import('./components/scanner/ScannerLotReceiveFlow'));
const IngredientIntakesPage = lazy(() => import('./components/ingredient/IngredientIntakesPage'));
const ContainersPage = lazy(() => import('./components/ingredient/ContainersPage'));
const CutoverSweepPage = lazy(() => import('./components/ingredient/CutoverSweepPage'));
const IngredientAuditsPage = lazy(() => import('./components/ingredient/IngredientAuditsPage'));
const RowLabelPrintPage = lazy(() => import('./components/ingredient/RowLabelPrintPage'));
const IngredientStagingPage = lazy(() => import('./components/ingredient/IngredientStagingPage'));
const ScannerIngredientStagingFlow = lazy(() => import('./components/scanner/ScannerIngredientStagingFlow'));

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
// Pages a read-only corporate viewer may open. Everything else admin-ranked is
// an operational/mutating surface (receipts, approvals, master data, transfers,
// cycle counting, ...) the viewer must not reach even by URL.
const CORPORATE_VIEWER_ALLOWED_PATHS = ['/admin', '/admin/inventory', '/admin/reports'];

function ProtectedRoute({ children, requiredRole, requiredFeature }) {
  const { user, isAuthenticated, loading } = useAuth();
  const location = useLocation();
  const redirectTo = requiredRole === 'forklift' ? '/forklift/login' : '/login';

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>Loading...</div>;
  }

  if (!isAuthenticated) {
    return <Navigate to={redirectTo} replace />;
  }

  // Role hierarchy for route access. Higher rank = more access. Corporate roles
  // outrank plant admin for cross-warehouse VIEW pages, but must NOT bypass
  // superadmin-only routes (the previous flat allow-list let them through).
  const ROLE_RANK = {
    forklift: 0, warehouse: 1, supervisor: 2, admin: 3,
    corporate_viewer: 4, corporate_admin: 5, superadmin: 6,
  };
  if (requiredRole) {
    const authorized = requiredRole === 'forklift'
      ? user?.role === 'forklift'   // forklift routes need the forklift role specifically
      : (ROLE_RANK[user?.role] ?? -1) >= (ROLE_RANK[requiredRole] ?? 0);
    if (!authorized) {
      return <Navigate to="/unauthorized" replace />;
    }
    // corporate_viewer is read-only: rank gets it past view pages, but it must
    // not open mutating pages even by direct URL.
    if (user?.role === 'corporate_viewer' && !CORPORATE_VIEWER_ALLOWED_PATHS.includes(location.pathname)) {
      return <Navigate to="/unauthorized" replace />;
    }
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
            <ScannerShipOutFlowV2 />
          </ProtectedRoute>
        } />

        {/* Legacy v1 pallet-level ship-out scanner — kept for in-flight
            orders submitted before the v2 cutover. Will drain over time. */}
        <Route path="/forklift/ship-out-v1" element={
          <ProtectedRoute requiredRole="forklift">
            <ScannerShipOutFlow />
          </ProtectedRoute>
        } />

        {/* Ingredient receiving on the gun. One component serves both the open-intake
            list and a scanning session; the optional :intakeId picks which.
            Sessions are intake-scoped, not person-scoped, so any forklift user can
            resume a part-finished truck. */}
        <Route path="/forklift/ingredient-receiving" element={
          <ProtectedRoute requiredRole="forklift">
            <ScannerIngredientReceiveFlow />
          </ProtectedRoute>
        } />
        <Route path="/forklift/ingredient-receiving/:intakeId" element={
          <ProtectedRoute requiredRole="forklift">
            <ScannerIngredientReceiveFlow />
          </ProtectedRoute>
        } />

        {/* Lot-level receiving on the gun. One component serves both the open-session
            list and a scanning session; the optional :receiptId picks which.
            Sessions are receipt-scoped, not person-scoped, so any forklift user can
            resume a part-finished truck — and the same screen serves a corporate
            incoming order and a walk-in, because a worker at the gun does not care
            which raised it. */}
        <Route path="/forklift/lot-receiving" element={
          <ProtectedRoute requiredRole="forklift">
            <ScannerLotReceiveFlow />
          </ProtectedRoute>
        } />
        <Route path="/forklift/lot-receiving/:receiptId" element={
          <ProtectedRoute requiredRole="forklift">
            <ScannerLotReceiveFlow />
          </ProtectedRoute>
        } />

        {/* Ingredient staging pulls. Same list/session shape as receiving: the
            optional :itemId selects one staging LINE, which is the unit a
            worker claims and pulls against. */}
        <Route path="/forklift/ingredient-staging" element={
          <ProtectedRoute requiredRole="forklift">
            <ScannerIngredientStagingFlow />
          </ProtectedRoute>
        } />
        <Route path="/forklift/ingredient-staging/:itemId" element={
          <ProtectedRoute requiredRole="forklift">
            <ScannerIngredientStagingFlow />
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

        <Route path="/admin/shipping" element={
          <ProtectedRoute requiredRole="admin">
            <Layout>
              {page(<ShippingPage />)}
            </Layout>
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

        <Route path="/warehouse/shipping" element={
          <ProtectedRoute requiredRole="warehouse">
            <Layout>
              {page(<ShippingPage />)}
            </Layout>
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

        <Route path="/supervisor/shipping" element={
          <ProtectedRoute requiredRole="supervisor">
            <Layout>
              {page(<ShippingPage />)}
            </Layout>
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

        <Route path="/warehouse/active-production" element={
          <ProtectedRoute requiredRole="warehouse">
            <Layout>
              {page(<ActiveProductionPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/supervisor/active-production" element={
          <ProtectedRoute requiredRole="supervisor">
            <Layout>
              {page(<ActiveProductionPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/admin/active-production" element={
          <ProtectedRoute requiredRole="admin">
            <Layout>
              {page(<ActiveProductionPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        {/* Palletizer kiosk: PUBLIC route — no auth, protected by X-Api-Key in URL.
            Bookmarked on a kiosk system at the production line. */}
        <Route path="/palletizer" element={page(<PalletizerKioskPage />)} />

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

        {/* ─── Ingredient container serialization (desk screens) ──────────────
            Mounted per role prefix to match the rest of the app. The intake page
            derives its own base path from the URL, so its internal links stay
            inside whichever prefix the user entered through.
            Cutover and audits are supervisor-and-up: the sweep permanently moves
            quantity off a legacy receipt, and the drift audits are diagnostics. */}
        <Route path="/warehouse/ingredient-intakes" element={
          <ProtectedRoute requiredRole="warehouse">
            <Layout>
              {page(<IngredientIntakesPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/warehouse/ingredient-intakes/:intakeId" element={
          <ProtectedRoute requiredRole="warehouse">
            <Layout>
              {page(<IngredientIntakesPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/warehouse/ingredient-staging" element={
          <ProtectedRoute requiredRole="warehouse">
            <Layout>
              {page(<IngredientStagingPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/warehouse/ingredient-containers" element={
          <ProtectedRoute requiredRole="warehouse">
            <Layout>
              {page(<ContainersPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/warehouse/ingredient-rows/labels" element={
          <ProtectedRoute requiredRole="warehouse">
            <Layout>
              {page(<RowLabelPrintPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/supervisor/ingredient-intakes" element={
          <ProtectedRoute requiredRole="supervisor">
            <Layout>
              {page(<IngredientIntakesPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/supervisor/ingredient-intakes/:intakeId" element={
          <ProtectedRoute requiredRole="supervisor">
            <Layout>
              {page(<IngredientIntakesPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/supervisor/ingredient-staging" element={
          <ProtectedRoute requiredRole="supervisor">
            <Layout>
              {page(<IngredientStagingPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/supervisor/ingredient-containers" element={
          <ProtectedRoute requiredRole="supervisor">
            <Layout>
              {page(<ContainersPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/supervisor/ingredient-rows/labels" element={
          <ProtectedRoute requiredRole="supervisor">
            <Layout>
              {page(<RowLabelPrintPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/supervisor/ingredient-cutover" element={
          <ProtectedRoute requiredRole="supervisor">
            <Layout>
              {page(<CutoverSweepPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/supervisor/ingredient-audits" element={
          <ProtectedRoute requiredRole="supervisor">
            <Layout>
              {page(<IngredientAuditsPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/admin/ingredient-intakes" element={
          <ProtectedRoute requiredRole="admin">
            <Layout>
              {page(<IngredientIntakesPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/admin/ingredient-intakes/:intakeId" element={
          <ProtectedRoute requiredRole="admin">
            <Layout>
              {page(<IngredientIntakesPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/admin/ingredient-staging" element={
          <ProtectedRoute requiredRole="admin">
            <Layout>
              {page(<IngredientStagingPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/admin/ingredient-containers" element={
          <ProtectedRoute requiredRole="admin">
            <Layout>
              {page(<ContainersPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/admin/ingredient-rows/labels" element={
          <ProtectedRoute requiredRole="admin">
            <Layout>
              {page(<RowLabelPrintPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/admin/ingredient-cutover" element={
          <ProtectedRoute requiredRole="admin">
            <Layout>
              {page(<CutoverSweepPage />)}
            </Layout>
          </ProtectedRoute>
        } />

        <Route path="/admin/ingredient-audits" element={
          <ProtectedRoute requiredRole="admin">
            <Layout>
              {page(<IngredientAuditsPage />)}
            </Layout>
          </ProtectedRoute>
        } />

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
                      <Router basename={import.meta.env.BASE_URL}>
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
