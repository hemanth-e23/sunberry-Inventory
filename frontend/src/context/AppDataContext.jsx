import React, {
  createContext,
  useContext,
  useMemo,
  useState,
  useCallback,
  useEffect,
} from "react";
import axios from "axios";
import { useAuth } from "./AuthContext";

// Hardcoded category groups (only 3 fixed groups)
const initialCategoryGroups = [
  { id: "group-raw", name: "Raw Materials", type: "group", active: true, description: "Raw materials and ingredients" },
  { id: "group-finished", name: "Finished Goods", type: "group", active: true, description: "Finished products ready for sale" },
  { id: "group-packaging", name: "Packaging Materials", type: "group", active: true, description: "Packaging and container materials" },
];

// All other data will be fetched from the backend API
const initialCategories = [];

// All data will be fetched from the backend API
// All data will be fetched from the backend API
const initialProducts = [];

const initialProductionShifts = [];

const initialProductionLines = [];

const initialReceipts = [];

const initialUsers = [];

const initialVendors = [];

const initialLocations = [];

const initialStorageAreas = [];

const EPSILON = 1e-4;

const roundTo = (value, precision = 4) => {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
};

const numberFrom = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const calculateFinishedGoodsAllocation = (areas, input) => {
  const {
    productId,
    casesPerPallet,
    fullPallets = 0,
    partialCases = 0,
    locationId: targetLocationId = null,
  } = input;

  const casesPerPal = numberFrom(casesPerPallet, 0);
  if (casesPerPal <= 0) {
    return { success: false, error: "invalid_cases_per_pallet" };
  }

  const full = Math.max(0, numberFrom(fullPallets, 0));
  const partialCasesValue = Math.max(0, numberFrom(partialCases, 0));

  const totalCases = roundTo(
    full * casesPerPal + partialCasesValue,
    3,
  );
  const fractionalPallet = partialCasesValue > 0 ? 1 : 0;
  const totalPalletsPrecise = full + partialCasesValue / casesPerPal;
  const totalPalletsForCapacity = Math.ceil(totalPalletsPrecise + 1e-9);

  let remainingPallets = totalPalletsForCapacity;
  let remainingCases = totalCases;

  const plan = [];
  const areaClones = areas.map((area) => ({
    ...area,
    rows: area.rows.map((row) => ({ ...row })),
  }));

  const candidateRows = [];

  areaClones.forEach((area, areaIndex) => {
    if (
      targetLocationId &&
      (area.locationId || null) !== targetLocationId
    ) {
      return;
    }
    area.rows.forEach((row, rowIndex) => {
      const available = row.palletCapacity - numberFrom(row.occupiedPallets, 0);
      if (row.hold || available <= EPSILON) return;
      if (row.productId && row.productId !== productId) return;
      candidateRows.push({
        areaIndex,
        rowIndex,
        row,
        available,
        sameProduct: Boolean(row.productId && row.productId === productId),
        areaName: area.name,
      });
    });
  });

  candidateRows.sort((a, b) => {
    if (a.sameProduct !== b.sameProduct) return a.sameProduct ? -1 : 1;
    const areaCompare = a.areaName.localeCompare(b.areaName);
    if (areaCompare !== 0) return areaCompare;
    return a.row.name.localeCompare(b.row.name);
  });

  candidateRows.forEach(({ areaIndex, rowIndex, row }) => {
    if (remainingPallets <= EPSILON || remainingCases <= EPSILON) return;

    const available = row.palletCapacity - numberFrom(row.occupiedPallets, 0);
    if (available <= EPSILON) return;

    const palletsNeeded = Math.min(available, remainingPallets);
    if (palletsNeeded <= EPSILON) return;

    const casesAssignable = Math.min(
      remainingCases,
      palletsNeeded * casesPerPal,
    );
    if (casesAssignable <= EPSILON) return;

    const area = areaClones[areaIndex];
    const nextRow = { ...area.rows[rowIndex] };

    nextRow.occupiedPallets = roundTo(
      numberFrom(nextRow.occupiedPallets, 0) + palletsNeeded,
      4,
    );
    nextRow.occupiedCases = roundTo(
      numberFrom(nextRow.occupiedCases, 0) + casesAssignable,
      2,
    );
    if (!nextRow.productId) {
      nextRow.productId = productId;
    }

    area.rows[rowIndex] = nextRow;

    plan.push({
      areaId: area.id,
      areaName: area.name,
      rowId: nextRow.id,
      rowName: nextRow.name,
      pallets: roundTo(palletsNeeded, 4),
      cases: roundTo(casesAssignable, 2),
    });

    remainingPallets = Math.max(
      0,
      roundTo(remainingPallets - palletsNeeded, 4),
    );
    remainingCases = Math.max(0, roundTo(remainingCases - casesAssignable, 2));
  });

  const floorAllocation =
    remainingCases > EPSILON
      ? {
        pallets: roundTo(remainingPallets, 4),
        cases: roundTo(remainingCases, 2),
      }
      : null;

  return {
    success: true,
    plan,
    floorAllocation,
    nextAreas: areaClones,
    totalPallets: roundTo(totalPalletsForCapacity, 4),
    totalCases: roundTo(totalCases, 2),
    casesPerPallet: casesPerPal,
    fractionalPallets: roundTo(totalPalletsPrecise, 4),
    targetLocationId,
  };
};

const cloneStorageAreas = (areas) =>
  areas.map((area) => ({
    ...area,
    rows: area.rows.map((row) => ({ ...row })),
  }));

const releaseFinishedGoodsAllocation = (areas, allocation) => {
  const base = cloneStorageAreas(areas);
  const plan = allocation?.plan || [];
  if (!plan.length) {
    return base;
  }

  plan.forEach(({ areaId, rowId, pallets = 0, cases = 0 }) => {
    const area = base.find((candidate) => candidate.id === areaId);
    if (!area) return;
    const row = area.rows.find((candidate) => candidate.id === rowId);
    if (!row) return;

    const nextPallets = roundTo(
      numberFrom(row.occupiedPallets, 0) - numberFrom(pallets, 0),
      4,
    );
    const nextCases = roundTo(
      numberFrom(row.occupiedCases, 0) - numberFrom(cases, 0),
      2,
    );

    row.occupiedPallets = nextPallets > EPSILON ? nextPallets : 0;
    row.occupiedCases = nextCases > EPSILON ? nextCases : 0;

    if (row.occupiedPallets <= EPSILON) {
      row.occupiedPallets = 0;
      row.occupiedCases = 0;
      row.productId = null;
    }
  });

  return base;
};

const reassignFinishedGood = ({
  receipt,
  quantityCases,
  locationId,
  storageAreas,
  locations,
}) => {
  const casesPerPalletValue = Math.max(0, numberFrom(receipt.casesPerPallet, 0));
  const totalCases = Math.max(0, numberFrom(quantityCases, 0));

  if (totalCases > EPSILON && casesPerPalletValue <= 0) {
    return {
      success: false,
      error: "invalid_cases_per_pallet",
      message: "Cases per pallet must be set before reallocating finished goods.",
    };
  }

  const baseAreas = releaseFinishedGoodsAllocation(storageAreas, receipt.allocation);

  if (totalCases <= EPSILON) {
    const emptyAllocation = {
      success: true,
      plan: [],
      floorAllocation: null,
      totalCases: 0,
      totalPallets: 0,
      casesPerPallet: casesPerPalletValue,
      fractionalPallets: 0,
      targetLocationId: locationId || null,
      nextAreas: baseAreas,
    };

    return {
      success: true,
      nextAreas: baseAreas,
      allocationDetails: emptyAllocation,
      fullPallets: 0,
      partialCases: 0,
    };
  }

  const fullPallets = Math.floor(totalCases / Math.max(1, casesPerPalletValue));
  const residualCases = roundTo(
    totalCases - fullPallets * Math.max(1, casesPerPalletValue),
    2,
  );

  const allocationInput = {
    productId: receipt.productId,
    casesPerPallet: Math.max(1, casesPerPalletValue),
    fullPallets,
    partialCases: residualCases,
    locationId: locationId || null,
  };

  const allocationResult = calculateFinishedGoodsAllocation(
    baseAreas,
    allocationInput,
  );

  if (!allocationResult?.success) {
    return {
      success: false,
      error: allocationResult?.error || "allocation_failed",
      message:
        allocationResult?.errorMessage ||
        "Unable to assign finished goods to racks with the current capacity.",
    };
  }

  const allocationDetails = {
    ...allocationResult,
    request: allocationInput,
    locationName: allocationResult.targetLocationId
      ? locations.find((loc) => loc.id === allocationResult.targetLocationId)?.name || ""
      : "",
  };

  return {
    success: true,
    nextAreas: allocationResult.nextAreas,
    allocationDetails,
    fullPallets,
    partialCases: residualCases,
  };
};

const applyFinishedGoodsPlan = (areas, plan, productId) => {
  const base = cloneStorageAreas(areas);
  if (!plan?.length) return base;

  plan.forEach(({ areaId, rowId, pallets = 0, cases = 0 }) => {
    const area = base.find((candidate) => candidate.id === areaId);
    if (!area) return;
    const rowIndex = area.rows.findIndex((candidate) => candidate.id === rowId);
    if (rowIndex === -1) return;
    const row = { ...area.rows[rowIndex] };

    row.occupiedPallets = roundTo(
      numberFrom(row.occupiedPallets, 0) + numberFrom(pallets, 0),
      4,
    );
    row.occupiedCases = roundTo(
      numberFrom(row.occupiedCases, 0) + numberFrom(cases, 0),
      2,
    );

    if (!row.productId) {
      row.productId = productId;
    }

    area.rows[rowIndex] = row;
  });

  return base.map((area) => ({ ...area }));
};

const mergeFinishedGoodsPlans = (originalPlan, changePlan) => {
  const planMap = new Map();

  originalPlan.forEach((step) => {
    const key = `${step.areaId}__${step.rowId}`;
    planMap.set(key, {
      ...step,
      pallets: numberFrom(step.pallets, 0),
      cases: numberFrom(step.cases, 0),
    });
  });

  changePlan.forEach((step) => {
    const key = `${step.areaId}__${step.rowId}`;
    const existing = planMap.get(key) || {
      areaId: step.areaId,
      rowId: step.rowId,
      areaName: step.areaName,
      rowName: step.rowName,
      pallets: 0,
      cases: 0,
    };

    const nextPallets = roundTo(
      numberFrom(existing.pallets, 0) + numberFrom(step.pallets, 0),
      4,
    );
    const nextCases = roundTo(
      numberFrom(existing.cases, 0) + numberFrom(step.cases, 0),
      2,
    );

    if (nextPallets <= EPSILON) {
      planMap.delete(key);
    } else {
      planMap.set(key, {
        ...existing,
        pallets: nextPallets,
        cases: Math.max(0, nextCases),
      });
    }
  });

  return Array.from(planMap.values());
};

const initialTransfers = [];
const initialHoldActions = [];
const initialAdjustments = [];

const AppDataContext = createContext(null);

// API URL - use relative path, nginx will proxy to backend
const API_BASE_URL = '/api';

// Helper function to get auth headers
const getAuthHeaders = async (waitForAuth = false, maxWaitTime = 10000) => {
  let token = localStorage.getItem('token');

  // If no token and we should wait, poll for token (for race condition scenarios)
  if (!token && waitForAuth) {
    const startTime = Date.now();
    while (!token && (Date.now() - startTime) < maxWaitTime) {
      await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms
      token = localStorage.getItem('token');
    }
  }

  // If still no token, try to get user credentials from localStorage and login
  if (!token) {
    const savedUser = localStorage.getItem('user');
    if (savedUser) {
      try {
        // Try default credentials as fallback
        const loginResponse = await axios.post(`${API_BASE_URL}/auth/login`, {
          username: 'admin',
          password: 'admin123'
        });
        token = loginResponse.data.access_token;
        localStorage.setItem('token', token);
      } catch (loginError) {
        console.error('Auto-login failed:', loginError);
        // Don't clear user data on auto-login failure, just return empty headers
        // The actual API call will fail with 401 and can be handled by the caller
        return {};
      }
    }
  }

  if (!token) {
    // Return empty headers instead of throwing - let the API call fail with 401
    // This allows the caller to handle the error appropriately
    return {};
  }

  return { Authorization: `Bearer ${token}` };
};

export const AppDataProvider = ({ children }) => {
  const { isAuthenticated, loading: authLoading } = useAuth();
  const [allocationHistory, setAllocationHistory] = useState([]);

  // Initialize with hardcoded category groups + fetched categories
  const [categories, setCategories] = useState([...initialCategoryGroups, ...initialCategories]);

  // Fetch categories from backend (groups are hardcoded)
  useEffect(() => {
    // Wait for auth to finish loading before fetching data
    if (authLoading) return;
    // Only fetch if authenticated
    if (!isAuthenticated) return;

    const fetchCategories = async () => {
      try {
        const headers = await getAuthHeaders(true); // Wait for auth token
        if (!headers.Authorization) {
          // No token available, skip this fetch
          return;
        }
        const catResponse = await axios.get(`${API_BASE_URL}/products/categories`, { headers });
        const cats = catResponse.data.map(cat => {
          // Determine subType based on category type
          // Backend has: raw, packaging, finished
          // Frontend needs: subType for raw (ingredient/packaging)
          let subType = null;
          if (cat.type === "raw") {
            // Raw materials are ingredients by default
            subType = "ingredient";
          } else if (cat.type === "packaging") {
            // Packaging materials
            subType = "packaging";
          }
          // finished goods have subType = null

          return {
            id: cat.id,
            name: cat.name,
            type: cat.type,
            subType: subType,
            parentId: cat.parent_id,
            active: cat.is_active !== false,
          };
        });
        setCategories([...initialCategoryGroups, ...cats]);
      } catch (error) {
        console.error('Error fetching categories:', error);
        // Only set to initial if it's not an auth error (401)
        if (error.response?.status !== 401) {
          setCategories(initialCategoryGroups);
        }
      }
    };
    fetchCategories();
  }, [authLoading, isAuthenticated]);
  const [products, setProducts] = useState(initialProducts);
  const [receipts, setReceipts] = useState(initialReceipts);

  // Fetch products from backend
  useEffect(() => {
    // Wait for auth to finish loading before fetching data
    if (authLoading) return;
    // Only fetch if authenticated
    if (!isAuthenticated) return;

    const fetchProducts = async () => {
      try {
        const headers = await getAuthHeaders(true); // Wait for auth token
        if (!headers.Authorization) {
          // No token available, skip this fetch
          return;
        }
        const pageSize = 100;
        let skip = 0;
        let total = 1;
        const allProds = [];
        while (skip < total) {
          const response = await axios.get(`${API_BASE_URL}/products/products`, {
            headers,
            params: { skip, limit: pageSize },
          });
          const { items, total: totalCount } = response.data;
          total = totalCount;
          allProds.push(...items);
          skip += pageSize;
        }
        const prods = allProds.map(prod => ({
          id: prod.id,
          name: prod.name,
          shortCode: prod.short_code || '',
          categoryId: prod.category_id,
          description: prod.description || '',
          status: prod.is_active ? 'active' : 'inactive',
          sid: prod.sid || '',
          fcc: prod.fcc_code || '',
          defaultCasesPerPallet: prod.default_cases_per_pallet,
          expireYears: prod.expire_years,
          quantityUom: prod.quantity_uom || 'cases',
          active: prod.is_active !== false,
          inventoryTracked: prod.inventory_tracked !== false,
          galPerCase: prod.gal_per_case ?? null,
        }));
        setProducts(prods);
      } catch (error) {
        console.error('Error fetching products:', error);
        // Don't clear products on auth errors, just log
      }
    };
    fetchProducts();
  }, [authLoading, isAuthenticated]);

  // Fetch receipts from backend
  useEffect(() => {
    // Wait for auth to finish loading before fetching data
    if (authLoading) return;
    // Only fetch if authenticated
    if (!isAuthenticated) return;

    const fetchReceipts = async () => {
      try {
        const headers = await getAuthHeaders(true); // Wait for auth token
        if (!headers.Authorization) {
          // No token available, skip this fetch
          return;
        }
        const response = await axios.get(`${API_BASE_URL}/receipts/`, { headers, params: { limit: 10000 } });
        const recs = response.data.map(rec => {
          // Find the product to get SID
          const product = products.find(p => p.id === rec.product_id);
          return {
            id: rec.id,
            productId: rec.product_id,
            categoryId: rec.category_id || null,
            quantity: Number(rec.quantity) || 0,
            quantityUnits: rec.unit || rec.quantity_units || 'cases',
            containerCount: rec.container_count || null,
            containerUnit: rec.container_unit || null,
            weightPerContainer: rec.weight_per_container || null,
            weightUnit: rec.weight_unit || null,
            lotNo: rec.lot_number || '',
            receiptDate: rec.receipt_date ? new Date(rec.receipt_date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
            expiryDate: rec.expiration_date ? new Date(rec.expiration_date).toISOString().split('T')[0] : null,
            expiration: rec.expiration_date ? new Date(rec.expiration_date).toISOString().split('T')[0] : null,
            productionDate: rec.production_date ? new Date(rec.production_date).toISOString().split('T')[0] : null,
            vendorId: rec.vendor_id || null,
            status: rec.status || 'recorded',
            submittedBy: rec.submitted_by || '',
            submittedAt: rec.submitted_at || null,
            approvedBy: rec.approved_by || null,
            approvedAt: rec.approved_at || null,
            note: rec.note || '',
            locationId: rec.location_id || null,
            location: rec.location_id || null, // For compatibility
            subLocationId: rec.sub_location_id || null,
            subLocation: rec.sub_location_id || null, // For compatibility
            storageAreaId: rec.storage_area_id || null,
            storageRowId: rec.storage_row_id || null,
            pallets: rec.pallets || null,  // Pallet count for raw materials/packaging
            rawMaterialRowAllocations: rec.raw_material_row_allocations || null,  // Multiple row allocations
            fullPallets: rec.full_pallets || 0,
            partialCases: rec.partial_cases || 0,
            casesPerPallet: rec.cases_per_pallet || null,
            bol: rec.bol || null,
            purchaseOrder: rec.purchase_order || null,
            hold: rec.hold || false,
            heldQuantity: rec.held_quantity || 0,
            holdLocation: rec.hold_location || null,  // Row/location name on hold (e.g., "AC")
            shift: rec.shift_id || null,
            lineNumber: rec.line_id || null,
            editHistory: [],
            // Populate SID from product so it's always available and doesn't trigger false change detection
            sid: product?.sid || '',
            // Include allocation data (JSON field from database)
            // Parse allocation if it's a string (some databases return JSON as string)
            allocation: (() => {
              if (!rec.allocation) return null;
              if (typeof rec.allocation === 'string') {
                try {
                  return JSON.parse(rec.allocation);
                } catch (e) {
                  console.error('Failed to parse allocation JSON:', e);
                  return null;
                }
              }
              return rec.allocation;
            })(),
          };
        });
        // Keep ALL receipts in state for historical lookups (hold history, adjustments, etc.)
        // Components that display active inventory should filter out depleted/zero-quantity receipts themselves
        setReceipts(recs);
      } catch (error) {
        console.error('Error fetching receipts:', error);
        // Don't clear receipts on auth errors, just log
      }
    };
    fetchReceipts();
  }, [products, authLoading, isAuthenticated]); // Add auth dependencies
  const [pendingEdits, setPendingEdits] = useState([]);
  const [users, setUsers] = useState(initialUsers);
  const [vendorsState, setVendorsState] = useState(initialVendors);

  // Fetch users from backend
  useEffect(() => {
    // Wait for auth to finish loading before fetching data
    if (authLoading) return;
    // Only fetch if authenticated
    if (!isAuthenticated) return;

    const fetchUsers = async () => {
      try {
        const headers = await getAuthHeaders(true); // Wait for auth token
        if (!headers.Authorization) {
          // No token available, skip this fetch
          return;
        }
        const response = await axios.get(`${API_BASE_URL}/users/`, { headers });
        const usersData = response.data.map(user => ({
          id: user.id,
          username: user.username,
          name: user.name,
          role: user.role,
          status: user.is_active ? "active" : "inactive",
          email: user.email || null,
          badgeId: user.badge_id || null,
        }));
        setUsers(usersData);
      } catch (error) {
        console.error('Error fetching users:', error);
        // If 401, clear invalid token
        if (error.response?.status === 401) {
          localStorage.removeItem('token');
          localStorage.removeItem('user');
        }
      }
    };
    fetchUsers();
  }, [authLoading, isAuthenticated]);

  // Fetch vendors from backend
  useEffect(() => {
    // Wait for auth to finish loading before fetching data
    if (authLoading) return;
    // Only fetch if authenticated
    if (!isAuthenticated) return;

    const fetchVendors = async () => {
      try {
        const headers = await getAuthHeaders(true); // Wait for auth token
        if (!headers.Authorization) {
          // No token available, skip this fetch
          return;
        }
        const response = await axios.get(`${API_BASE_URL}/products/vendors`, { headers });
        const vendors = response.data.map(vendor => ({
          id: vendor.id,
          name: vendor.name,
          active: vendor.is_active !== false,
        }));
        setVendorsState(vendors);
      } catch (error) {
        console.error('Error fetching vendors:', error);
      }
    };
    fetchVendors();
  }, [authLoading, isAuthenticated]);
  const [locationsState, setLocationsState] = useState(initialLocations);

  // Fetch locations and sub-locations from backend
  const fetchLocations = async () => {
    try {
      const headers = await getAuthHeaders(true); // Wait for auth token
      if (!headers.Authorization) {
        // No token available, skip this fetch
        return;
      }
      // Fetch locations
      const locResponse = await axios.get(`${API_BASE_URL}/master-data/locations`, { headers });
      // Fetch sub-locations
      const subLocResponse = await axios.get(`${API_BASE_URL}/master-data/sub-locations`, { headers });

      // Transform backend data to frontend structure (nested)
      const locations = locResponse.data.map(loc => ({
        id: loc.id,
        name: loc.name,
        active: loc.is_active !== false,
        subLocations: subLocResponse.data
          .filter(sub => sub.location_id === loc.id)
          .map(sub => {
            return {
              id: sub.id,
              name: sub.name,
              active: sub.is_active !== false,
              rows: (sub.rows || []).map(row => ({
                id: row.id,
                name: row.name,
                template: row.template || 'custom',
                palletCapacity: row.pallet_capacity || 0,
                defaultCasesPerPallet: row.default_cases_per_pallet || 0,
                occupiedPallets: row.occupied_pallets || 0,
                occupiedCases: row.occupied_cases || 0,
                productId: row.product_id || null,
                hold: row.hold || false,
                notes: row.notes || '',
                active: row.is_active !== false,
              })),
            };
          }),
      }));

      setLocationsState(locations);
    } catch (error) {
      console.error('Error fetching locations:', error);
    }
  };

  useEffect(() => {
    // Wait for auth to finish loading before fetching data
    if (authLoading) return;
    // Only fetch if authenticated
    if (!isAuthenticated) return;

    fetchLocations();
  }, [authLoading, isAuthenticated]);
  const [storageAreasState, setStorageAreasState] =
    useState(initialStorageAreas);

  // Fetch storage areas from backend
  const fetchStorageAreas = async () => {
    try {
      const headers = await getAuthHeaders(true); // Wait for auth token
      if (!headers.Authorization) {
        // No token available, skip this fetch
        return;
      }
      const response = await axios.get(`${API_BASE_URL}/master-data/storage-areas`, { headers });
      const areas = response.data.map(area => ({
        id: area.id,
        name: area.name,
        locationId: area.location_id,
        subLocationId: area.sub_location_id || null,
        allowFloorStorage: area.allow_floor_storage || false,
        active: area.is_active !== false,
        rows: (area.rows || []).map(row => ({
          id: row.id,
          name: row.name,
          template: row.template || 'custom',
          palletCapacity: row.pallet_capacity || 0,
          defaultCasesPerPallet: row.default_cases_per_pallet || 0,
          occupiedPallets: row.occupied_pallets || 0,
          occupiedCases: row.occupied_cases || 0,
          productId: row.product_id || null,
          hold: row.hold || false,
          notes: row.notes || '',
          active: row.is_active !== false,
        })),
      }));
      setStorageAreasState(areas);
    } catch (error) {
      console.error('Error fetching storage areas:', error);
    }
  };

  useEffect(() => {
    // Wait for auth to finish loading before fetching data
    if (authLoading) return;
    // Only fetch if authenticated
    if (!isAuthenticated) return;

    fetchStorageAreas();
  }, [authLoading, isAuthenticated]);

  const [productionShiftsState, setProductionShiftsState] = useState(
    initialProductionShifts,
  );
  const [productionLinesState, setProductionLinesState] = useState(
    initialProductionLines,
  );

  // Fetch production shifts from backend
  useEffect(() => {
    // Wait for auth to finish loading before fetching data
    if (authLoading) return;
    // Only fetch if authenticated
    if (!isAuthenticated) return;

    const fetchProductionShifts = async () => {
      try {
        const headers = await getAuthHeaders(true); // Wait for auth token
        if (!headers.Authorization) {
          // No token available, skip this fetch
          return;
        }
        const response = await axios.get(`${API_BASE_URL}/master-data/production-shifts`, { headers });
        const shifts = response.data.map(shift => ({
          id: shift.id,
          name: shift.name,
          active: shift.is_active !== false,
          notes: shift.start_time || shift.end_time ? `${shift.start_time || ''} - ${shift.end_time || ''}`.trim() : '',
        }));
        setProductionShiftsState(shifts);
      } catch (error) {
        console.error('Error fetching production shifts:', error);
      }
    };
    fetchProductionShifts();
  }, [authLoading, isAuthenticated]);

  // Fetch production lines from backend
  useEffect(() => {
    // Wait for auth to finish loading before fetching data
    if (authLoading) return;
    // Only fetch if authenticated
    if (!isAuthenticated) return;

    const fetchProductionLines = async () => {
      try {
        const headers = await getAuthHeaders(true); // Wait for auth token
        if (!headers.Authorization) {
          // No token available, skip this fetch
          return;
        }
        const response = await axios.get(`${API_BASE_URL}/master-data/production-lines`, { headers });
        const lines = response.data.map(line => ({
          id: line.id,
          name: line.name,
          active: line.is_active !== false,
          notes: line.description || '',
        }));
        setProductionLinesState(lines);
      } catch (error) {
        console.error('Error fetching production lines:', error);
      }
    };
    fetchProductionLines();
  }, [authLoading, isAuthenticated]);

  // Fetch inventory holds and adjustments from backend
  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) return;

    const fetchInventoryActions = async () => {
      try {
        const headers = await getAuthHeaders(true);
        if (!headers.Authorization) return;

        // Fetch hold actions
        const holdsResponse = await axios.get(`${API_BASE_URL}/inventory/hold-actions`, { headers });
        const holds = holdsResponse.data.map(hold => ({
          id: hold.id,
          receiptId: hold.receipt_id,
          action: hold.action,
          reason: hold.reason,
          status: hold.status,
          submittedAt: hold.submitted_at,
          submittedBy: hold.submitted_by,
          approvedBy: hold.approved_by,
          approvedAt: hold.approved_at,
          editHistory: []
        }));
        setInventoryHoldActions(holds);

        // Fetch transfers
        const transfersResponse = await axios.get(`${API_BASE_URL}/inventory/transfers`, { headers });
        const transfers = transfersResponse.data.map(t => ({
          id: t.id,
          receiptId: t.receipt_id,
          transferType: t.transfer_type,
          fromLocation: t.from_location_id,
          fromSubLocation: t.from_sub_location_id,
          toLocation: t.to_location_id,
          toSubLocation: t.to_sub_location_id,
          quantity: t.quantity,
          reason: t.reason,
          orderNumber: t.order_number,
          status: t.status,
          submittedAt: t.submitted_at,
          submittedBy: t.requested_by,
          approvedBy: t.approved_by,
          approvedAt: t.approved_at,
          sourceBreakdown: t.source_breakdown || [],
          destinationBreakdown: t.destination_breakdown || [],
          palletLicenceIds: t.pallet_licence_ids || [],
          palletLicenceDetails: t.pallet_licence_details || [],
          editHistory: []
        }));
        setInventoryTransfers(transfers);

        // Fetch adjustments
        const adjustmentsResponse = await axios.get(`${API_BASE_URL}/inventory/adjustments`, { headers });
        const adjustments = adjustmentsResponse.data.map(adj => ({
          id: adj.id,
          receiptId: adj.receipt_id,
          productId: adj.product_id,
          categoryId: adj.category_id,
          adjustmentType: adj.adjustment_type,
          quantity: adj.quantity,
          reason: adj.reason,
          recipient: adj.recipient,
          status: adj.status,
          submittedAt: adj.submitted_at,
          submittedBy: adj.submitted_by,
          approvedBy: adj.approved_by,
          approvedAt: adj.approved_at,
          editHistory: []
        }));
        setInventoryAdjustments(adjustments);
      } catch (error) {
        console.error('Error fetching inventory actions:', error);
      }
    };
    fetchInventoryActions();
  }, [authLoading, isAuthenticated]);

  // Fetch cycle counts from backend
  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) return;

    const fetchCycleCounts = async () => {
      try {
        const headers = await getAuthHeaders(true);
        if (!headers.Authorization) return;

        const response = await axios.get(`${API_BASE_URL}/inventory/cycle-counts`, { headers });
        const counts = response.data.map(count => ({
          id: count.id,
          location: count.location_id,
          category: count.category_id,
          countDate: count.count_date,
          items: count.items,
          summary: count.summary,
          performedBy: count.performed_by,
          performedById: count.performed_by_id,
          createdAt: count.created_at,
        }));
        setCycleCounts(counts);
      } catch (error) {
        console.error('Error fetching cycle counts:', error);
      }
    };
    fetchCycleCounts();
  }, [authLoading, isAuthenticated]);

  // Fetch forklift requests (for approvals page)
  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) return;

    const fetchForkliftRequests = async () => {
      try {
        const headers = await getAuthHeaders(true);
        if (!headers.Authorization) return;
        const response = await axios.get(`${API_BASE_URL}/scanner/requests`, { headers });
        setForkliftRequests(response.data || []);
      } catch (error) {
        console.error('Error fetching forklift requests:', error);
      }
    };
    fetchForkliftRequests();
  }, [authLoading, isAuthenticated]);

  const [cycleCounts, setCycleCounts] = useState([]);
  const [forkliftRequests, setForkliftRequests] = useState([]);
  const [inventoryTransfers, setInventoryTransfers] =
    useState(initialTransfers);
  const [inventoryHoldActions, setInventoryHoldActions] =
    useState(initialHoldActions);
  const [inventoryAdjustments, setInventoryAdjustments] =
    useState(initialAdjustments);

  const addCategory = async (name, type = "raw", subType = null, parentId = null) => {
    const trimmed = name.trim();
    if (!trimmed) return null;

    // Map category type to group ID if parentId is not provided
    let finalParentId = parentId;
    if (!finalParentId || finalParentId === "") {
      if (type === "raw") {
        finalParentId = "group-raw";
      } else if (type === "finished") {
        finalParentId = "group-finished";
      } else if (type === "packaging") {
        finalParentId = "group-packaging";
      } else {
        // Default to raw materials group
        finalParentId = "group-raw";
      }
    }

    const exists = categories.some(
      (cat) =>
        cat.name.toLowerCase() === trimmed.toLowerCase() &&
        cat.parentId === finalParentId,
    );
    if (exists) return null;

    try {
      const headers = await getAuthHeaders();
      const categoryData = {
        id: `cat-${Date.now()}`,
        name: trimmed,
        type,
        parent_id: finalParentId,
        is_active: true,
      };

      const response = await axios.post(`${API_BASE_URL}/products/categories`, categoryData, { headers });
      const newCategory = {
        id: response.data.id,
        name: response.data.name,
        type: response.data.type,
        subType: type === "raw" ? subType || "ingredient" : null,
        parentId: response.data.parent_id,
        active: response.data.is_active !== false,
      };
      setCategories((prev) => [...prev, newCategory]);
      return newCategory;
    } catch (error) {
      console.error('Error adding category:', error);
      // If 401, clear invalid token
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      throw error;
    }
  };

  const updateCategory = async (id, updates) => {
    try {
      const headers = await getAuthHeaders();
      const updateData = {
        name: updates.name,
        type: updates.type,
        parent_id: updates.parentId,
        is_active: updates.active !== undefined ? updates.active : true,
      };

      Object.keys(updateData).forEach(key =>
        updateData[key] === undefined && delete updateData[key]
      );

      const response = await axios.put(`${API_BASE_URL}/products/categories/${id}`, updateData, { headers });
      const updatedCategory = {
        id: response.data.id,
        name: response.data.name,
        type: response.data.type,
        subType: response.data.type === "raw" ? (updates.subType || "ingredient") : null,
        parentId: response.data.parent_id,
        active: response.data.is_active !== false,
      };
      setCategories((prev) =>
        prev.map((category) => (category.id === id ? updatedCategory : category))
      );
      return updatedCategory;
    } catch (error) {
      console.error('Error updating category:', error);
      throw error;
    }
  };

  const toggleCategoryActive = async (id) => {
    try {
      const headers = await getAuthHeaders();
      const category = categories.find(cat => cat.id === id);
      if (!category) return;

      const updateData = { is_active: !category.active };
      const response = await axios.put(`${API_BASE_URL}/products/categories/${id}`, updateData, { headers });

      setCategories((prev) =>
        prev.map((cat) =>
          cat.id === id ? { ...cat, active: response.data.is_active !== false } : cat,
        ),
      );
    } catch (error) {
      console.error('Error toggling category active:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      throw error;
    }
  };

  const removeCategory = (id) => {
    setCategories((prev) => prev.filter((category) => category.id !== id));
  };

  const addProduct = async (product) => {
    try {
      const headers = await getAuthHeaders();
      const productData = {
        id: product.id || `prod-${Date.now()}`,
        name: product.name,
        short_code: product.shortCode?.trim() || null,
        category_id: product.categoryId,
        description: product.description?.trim() || null,
        sid: product.sid?.trim() || null,
        fcc_code: product.fcc?.trim() || null,
        vendor_id: product.vendorId?.trim() || null,
        default_cases_per_pallet: product.defaultCasesPerPallet ? Number(product.defaultCasesPerPallet) : null,
        expire_years: product.expireYears ? Number(product.expireYears) : null,
        quantity_uom: product.quantityUom || null,
        is_active: product.active !== undefined ? product.active : true,
        inventory_tracked: product.inventoryTracked !== undefined ? product.inventoryTracked : true,
        gal_per_case: product.galPerCase != null && product.galPerCase !== '' ? Number(product.galPerCase) : null,
      };

      // Remove null/empty fields (except required ones)
      Object.keys(productData).forEach(key => {
        if (key !== 'id' && key !== 'name' && key !== 'category_id' && key !== 'is_active') {
          if (productData[key] === null || productData[key] === undefined || productData[key] === "") {
            delete productData[key];
          }
        }
      });

      const response = await axios.post(`${API_BASE_URL}/products/products`, productData, { headers });
      const newProduct = {
        id: response.data.id,
        name: response.data.name,
        shortCode: response.data.short_code || "",
        categoryId: response.data.category_id,
        description: response.data.description || "",
        status: response.data.is_active ? "active" : "inactive",
        sid: response.data.sid || "",
        fcc: response.data.fcc_code || "",
        vendorId: response.data.vendor_id || null,
        defaultCasesPerPallet: response.data.default_cases_per_pallet || product.defaultCasesPerPallet || null,
        expireYears: response.data.expire_years || product.expireYears || null,
        quantityUom: response.data.quantity_uom || product.quantityUom || "cases",
        active: response.data.is_active !== false,
        inventoryTracked: response.data.inventory_tracked !== false,
        galPerCase: response.data.gal_per_case ?? product.galPerCase ?? null,
      };
      setProducts((prev) => [...prev, newProduct]);
      return newProduct;
    } catch (error) {
      console.error('Error adding product:', error);
      // If 401, clear invalid token
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      throw error;
    }
  };

  const updateProduct = async (id, updates) => {
    try {
      const headers = await getAuthHeaders();
      const updateData = {};

      // Only include fields that are explicitly provided in updates
      if (updates.name !== undefined) updateData.name = updates.name;
      if (updates.shortCode !== undefined) {
        updateData.short_code = (updates.shortCode && updates.shortCode.trim()) ? updates.shortCode.trim() : null;
      }
      if (updates.categoryId !== undefined) updateData.category_id = updates.categoryId;
      if (updates.description !== undefined) updateData.description = updates.description || null;
      if (updates.sid !== undefined) updateData.sid = updates.sid || null;
      if (updates.fcc !== undefined) {
        updateData.fcc_code = (updates.fcc && updates.fcc.trim()) ? updates.fcc.trim() : null;
      }
      if (updates.vendorId !== undefined) updateData.vendor_id = updates.vendorId || null;
      if (updates.defaultCasesPerPallet !== undefined) {
        updateData.default_cases_per_pallet = updates.defaultCasesPerPallet ? Number(updates.defaultCasesPerPallet) : null;
      }
      if (updates.expireYears !== undefined) {
        updateData.expire_years = updates.expireYears ? Number(updates.expireYears) : null;
      }
      if (updates.quantityUom !== undefined) updateData.quantity_uom = updates.quantityUom || null;
      if (updates.inventoryTracked !== undefined) updateData.inventory_tracked = updates.inventoryTracked;
      if (updates.galPerCase !== undefined) {
        updateData.gal_per_case = updates.galPerCase != null && updates.galPerCase !== '' ? Number(updates.galPerCase) : null;
      }
      if (updates.active !== undefined) {
        updateData.is_active = updates.active;
      } else if (updates.status !== undefined) {
        updateData.is_active = updates.status === 'active';
      }

      const response = await axios.put(`${API_BASE_URL}/products/products/${id}`, updateData, { headers });
      const updatedProduct = {
        id: response.data.id,
        name: response.data.name,
        shortCode: response.data.short_code || "",
        categoryId: response.data.category_id,
        description: response.data.description || "",
        status: response.data.is_active ? "active" : "inactive",
        sid: response.data.sid || "",
        fcc: response.data.fcc_code || "",
        vendorId: response.data.vendor_id || null,
        defaultCasesPerPallet: response.data.default_cases_per_pallet || updates.defaultCasesPerPallet || null,
        expireYears: response.data.expire_years || updates.expireYears || null,
        quantityUom: response.data.quantity_uom || updates.quantityUom || "cases",
        active: response.data.is_active !== false,
        inventoryTracked: response.data.inventory_tracked !== false,
        galPerCase: response.data.gal_per_case ?? updates.galPerCase ?? null,
      };
      setProducts((prev) =>
        prev.map((product) => (product.id === id ? updatedProduct : product))
      );
      return updatedProduct;
    } catch (error) {
      console.error('Error updating product:', error);
      // If 401, clear invalid token
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      throw error;
    }
  };

  const toggleProductStatus = async (id) => {
    try {
      const headers = await getAuthHeaders();
      const response = await axios.post(`${API_BASE_URL}/products/products/${id}/toggle-status`, {}, { headers });

      setProducts((prev) =>
        prev.map((product) => {
          if (product.id !== id) return product;
          return {
            ...product,
            status: response.data.is_active ? "active" : "inactive",
            active: response.data.is_active,
          };
        }),
      );
    } catch (error) {
      console.error('Error toggling product status:', error);
      // If 401, clear invalid token
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      throw error;
    }
  };

  const addVendor = async (name) => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const exists = vendorsState.some(
      (vendor) => vendor.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (exists) return null;

    try {
      const headers = await getAuthHeaders();
      const vendorData = {
        id: `vendor-${Date.now()}`,
        name: trimmed,
      };

      const response = await axios.post(`${API_BASE_URL}/products/vendors`, vendorData, { headers });
      const newVendor = {
        id: response.data.id,
        name: response.data.name,
        active: response.data.is_active !== false,
      };
      setVendorsState((prev) => [...prev, newVendor]);
      return newVendor;
    } catch (error) {
      console.error('Error adding vendor:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      throw error;
    }
  };

  const updateVendor = async (id, name) => {
    try {
      const headers = await getAuthHeaders();
      const updateData = { name };
      const response = await axios.put(`${API_BASE_URL}/products/vendors/${id}`, updateData, { headers });

      setVendorsState((prev) =>
        prev.map((vendor) =>
          vendor.id === id ? { ...vendor, name: response.data.name } : vendor,
        ),
      );
    } catch (error) {
      console.error('Error updating vendor:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      throw error;
    }
  };

  const toggleVendorActive = async (id) => {
    try {
      const headers = await getAuthHeaders();
      const vendor = vendorsState.find(v => v.id === id);
      const updateData = { is_active: !vendor?.active };
      const response = await axios.put(`${API_BASE_URL}/products/vendors/${id}`, updateData, { headers });

      setVendorsState((prev) =>
        prev.map((vendor) =>
          vendor.id === id ? { ...vendor, active: response.data.is_active !== false } : vendor,
        ),
      );
    } catch (error) {
      console.error('Error toggling vendor active:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      throw error;
    }
  };

  const removeVendor = async (id) => {
    try {
      const headers = await getAuthHeaders();
      // Set is_active to false instead of deleting
      await axios.put(`${API_BASE_URL}/products/vendors/${id}`, { is_active: false }, { headers });
      setVendorsState((prev) => prev.filter((vendor) => vendor.id !== id));
    } catch (error) {
      console.error('Error deleting vendor:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      throw error;
    }
  };

  const addProductionShift = async (name, notes = "") => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const exists = productionShiftsState.some(
      (shift) => shift.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (exists) return null;

    try {
      const headers = await getAuthHeaders();
      const shiftId = `shift-${Date.now()}`;
      const shiftData = {
        id: shiftId,
        name: trimmed,
        start_time: null,
        end_time: null,
      };
      const response = await axios.post(`${API_BASE_URL}/master-data/production-shifts`, shiftData, { headers });

      const newShift = {
        id: response.data.id,
        name: response.data.name,
        active: response.data.is_active !== false,
        notes: notes.trim(),
      };
      setProductionShiftsState((prev) => [...prev, newShift]);
      return newShift;
    } catch (error) {
      console.error('Error adding production shift:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to add production shift';
      throw new Error(errorMessage);
    }
  };

  const updateProductionShift = async (id, updates) => {
    try {
      const headers = await getAuthHeaders();
      const updateData = {};
      if (updates.name !== undefined) updateData.name = updates.name;
      if (updates.active !== undefined) updateData.is_active = updates.active;
      if (updates.notes !== undefined) {
        // Notes are stored as start_time/end_time in backend, but we'll just update name for now
        // If needed, we can parse notes to extract times
      }

      const response = await axios.put(`${API_BASE_URL}/master-data/production-shifts/${id}`, updateData, { headers });

      setProductionShiftsState((prev) =>
        prev.map((shift) =>
          shift.id === id ? {
            ...shift,
            name: response.data.name,
            active: response.data.is_active !== false,
            ...updates
          } : shift,
        ),
      );
    } catch (error) {
      console.error('Error updating production shift:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to update production shift';
      throw new Error(errorMessage);
    }
  };

  const toggleProductionShiftActive = async (id) => {
    try {
      const shift = productionShiftsState.find(s => s.id === id);
      if (!shift) return;

      const headers = await getAuthHeaders();
      const updateData = { is_active: !shift.active };
      const response = await axios.put(`${API_BASE_URL}/master-data/production-shifts/${id}`, updateData, { headers });

      setProductionShiftsState((prev) =>
        prev.map((s) =>
          s.id === id ? { ...s, active: response.data.is_active !== false } : s,
        ),
      );
    } catch (error) {
      console.error('Error toggling production shift active:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to toggle production shift';
      throw new Error(errorMessage);
    }
  };

  const removeProductionShift = async (id) => {
    try {
      const headers = await getAuthHeaders();
      // Set is_active to false instead of deleting
      await axios.put(`${API_BASE_URL}/master-data/production-shifts/${id}`, { is_active: false }, { headers });
      setProductionShiftsState((prev) => prev.filter((shift) => shift.id !== id));
    } catch (error) {
      console.error('Error removing production shift:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to remove production shift';
      throw new Error(errorMessage);
    }
  };

  const addProductionLine = async (name, notes = "") => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const exists = productionLinesState.some(
      (line) => line.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (exists) return null;

    try {
      const headers = await getAuthHeaders();
      const lineId = `line-${Date.now()}`;
      const lineData = {
        id: lineId,
        name: trimmed,
        description: notes.trim() || null,
      };
      const response = await axios.post(`${API_BASE_URL}/master-data/production-lines`, lineData, { headers });

      const newLine = {
        id: response.data.id,
        name: response.data.name,
        active: response.data.is_active !== false,
        notes: response.data.description || '',
      };
      setProductionLinesState((prev) => [...prev, newLine]);
      return newLine;
    } catch (error) {
      console.error('Error adding production line:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to add production line';
      throw new Error(errorMessage);
    }
  };

  const updateProductionLine = async (id, updates) => {
    try {
      const headers = await getAuthHeaders();
      const updateData = {};
      if (updates.name !== undefined) updateData.name = updates.name;
      if (updates.active !== undefined) updateData.is_active = updates.active;
      if (updates.notes !== undefined) updateData.description = updates.notes || null;

      const response = await axios.put(`${API_BASE_URL}/master-data/production-lines/${id}`, updateData, { headers });

      setProductionLinesState((prev) =>
        prev.map((line) =>
          line.id === id ? {
            ...line,
            name: response.data.name,
            active: response.data.is_active !== false,
            notes: response.data.description || '',
            ...updates
          } : line,
        ),
      );
    } catch (error) {
      console.error('Error updating production line:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to update production line';
      throw new Error(errorMessage);
    }
  };

  const toggleProductionLineActive = async (id) => {
    try {
      const line = productionLinesState.find(l => l.id === id);
      if (!line) return;

      const headers = await getAuthHeaders();
      const updateData = { is_active: !line.active };
      const response = await axios.put(`${API_BASE_URL}/master-data/production-lines/${id}`, updateData, { headers });

      setProductionLinesState((prev) =>
        prev.map((l) =>
          l.id === id ? { ...l, active: response.data.is_active !== false } : l,
        ),
      );
    } catch (error) {
      console.error('Error toggling production line active:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to toggle production line';
      throw new Error(errorMessage);
    }
  };

  const removeProductionLine = async (id) => {
    try {
      const headers = await getAuthHeaders();
      // Set is_active to false instead of deleting
      await axios.put(`${API_BASE_URL}/master-data/production-lines/${id}`, { is_active: false }, { headers });
      setProductionLinesState((prev) => prev.filter((line) => line.id !== id));
    } catch (error) {
      console.error('Error removing production line:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to remove production line';
      throw new Error(errorMessage);
    }
  };

  const addLocationNode = async (name) => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const exists = locationsState.some(
      (loc) => loc.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (exists) return null;

    try {
      const headers = await getAuthHeaders();
      const locationData = {
        id: `loc-${Date.now()}`,
        name: trimmed,
        description: null,
      };

      const response = await axios.post(`${API_BASE_URL}/master-data/locations`, locationData, { headers });
      const newLocation = {
        id: response.data.id,
        name: response.data.name,
        subLocations: [],
        active: response.data.is_active !== false,
      };
      setLocationsState((prev) => [...prev, newLocation]);
      return newLocation;
    } catch (error) {
      console.error('Error adding location:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      throw error;
    }
  };

  const renameLocationNode = async (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;

    try {
      const headers = await getAuthHeaders();
      const updateData = { name: trimmed };
      const response = await axios.put(`${API_BASE_URL}/master-data/locations/${id}`, updateData, { headers });

      setLocationsState((prev) =>
        prev.map((location) =>
          location.id === id ? { ...location, name: response.data.name } : location,
        ),
      );
    } catch (error) {
      console.error('Error updating location:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      throw error;
    }
  };

  const toggleLocationActive = async (id) => {
    try {
      const headers = await getAuthHeaders();
      const location = locationsState.find(loc => loc.id === id);
      const updateData = { is_active: !location?.active };
      const response = await axios.put(`${API_BASE_URL}/master-data/locations/${id}`, updateData, { headers });

      setLocationsState((prev) =>
        prev.map((location) =>
          location.id === id
            ? { ...location, active: response.data.is_active !== false }
            : location,
        ),
      );
    } catch (error) {
      console.error('Error toggling location active:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      throw error;
    }
  };

  const removeLocationNode = async (id) => {
    try {
      const headers = await getAuthHeaders();
      // Set is_active to false instead of deleting
      await axios.put(`${API_BASE_URL}/master-data/locations/${id}`, { is_active: false }, { headers });
      setLocationsState((prev) => prev.filter((location) => location.id !== id));
    } catch (error) {
      console.error('Error deleting location:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      throw error;
    }
  };

  const addSubLocationNode = async (parentId, name) => {
    const trimmed = name.trim();
    if (!trimmed) return null;

    const parentLocation = locationsState.find(loc => loc.id === parentId);
    if (!parentLocation) return null;

    const exists = parentLocation.subLocations.some(
      (sub) => sub.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (exists) return null;

    try {
      const headers = await getAuthHeaders();
      const subLocationData = {
        id: `sub-${Date.now()}`,
        name: trimmed,
        location_id: parentId,
      };

      const response = await axios.post(`${API_BASE_URL}/master-data/sub-locations`, subLocationData, { headers });
      const newSubLocation = {
        id: response.data.id,
        name: response.data.name,
        active: response.data.is_active !== false,
      };

      setLocationsState((prev) =>
        prev.map((location) => {
          if (location.id !== parentId) return location;
          return {
            ...location,
            subLocations: [...location.subLocations, newSubLocation],
          };
        }),
      );
      return newSubLocation;
    } catch (error) {
      console.error('Error adding sub-location:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      throw error;
    }
  };

  const renameSubLocationNode = async (parentId, subId, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;

    try {
      const headers = await getAuthHeaders();
      const updateData = { name: trimmed };
      const response = await axios.put(`${API_BASE_URL}/master-data/sub-locations/${subId}`, updateData, { headers });

      setLocationsState((prev) =>
        prev.map((location) => {
          if (location.id !== parentId) return location;
          return {
            ...location,
            subLocations: location.subLocations.map((sub) =>
              sub.id === subId ? { ...sub, name: response.data.name } : sub,
            ),
          };
        }),
      );
    } catch (error) {
      console.error('Error updating sub-location:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      throw error;
    }
  };

  const toggleSubLocationActive = async (parentId, subId) => {
    try {
      const headers = await getAuthHeaders();
      const parentLocation = locationsState.find(loc => loc.id === parentId);
      const subLocation = parentLocation?.subLocations.find(sub => sub.id === subId);
      const updateData = { is_active: !subLocation?.active };
      const response = await axios.put(`${API_BASE_URL}/master-data/sub-locations/${subId}`, updateData, { headers });

      setLocationsState((prev) =>
        prev.map((location) => {
          if (location.id !== parentId) return location;
          return {
            ...location,
            subLocations: location.subLocations.map((sub) =>
              sub.id === subId ? { ...sub, active: response.data.is_active !== false } : sub,
            ),
          };
        }),
      );
    } catch (error) {
      console.error('Error toggling sub-location active:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      throw error;
    }
  };

  const removeSubLocationNode = async (parentId, subId) => {
    try {
      const headers = await getAuthHeaders();
      // Set is_active to false instead of deleting
      await axios.put(`${API_BASE_URL}/master-data/sub-locations/${subId}`, { is_active: false }, { headers });
      setLocationsState((prev) =>
        prev.map((location) => {
          if (location.id !== parentId) return location;
          return {
            ...location,
            subLocations: location.subLocations.filter((sub) => sub.id !== subId),
          };
        }),
      );
    } catch (error) {
      console.error('Error deleting sub-location:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      throw error;
    }
  };

  // Add a row to a SubLocation (for raw materials/packaging)
  const addSubLocationRow = async (parentLocationId, subLocationId, row) => {
    const trimmedName = row.name.trim();
    if (!trimmedName) return null;

    try {
      const headers = await getAuthHeaders();
      const rowId = row.id || `sub-row-${Date.now()}`;
      const rowData = {
        id: rowId,
        sub_location_id: subLocationId,
        storage_area_id: null, // This row belongs to a SubLocation, not a StorageArea
        name: trimmedName,
        template: row.template || "custom",
        pallet_capacity: Number(row.palletCapacity) || 0,
        default_cases_per_pallet: Number(row.defaultCasesPerPallet) || 0,
        occupied_pallets: row.occupiedPallets || 0,
        occupied_cases: row.occupiedCases || 0,
        product_id: row.productId || null,
        hold: !!row.hold,
        notes: row.notes || null,
      };
      const response = await axios.post(`${API_BASE_URL}/master-data/storage-rows`, rowData, { headers });

      const newRow = {
        id: response.data.id,
        name: response.data.name,
        template: response.data.template || 'custom',
        palletCapacity: response.data.pallet_capacity || 0,
        defaultCasesPerPallet: response.data.default_cases_per_pallet || 0,
        occupiedPallets: response.data.occupied_pallets || 0,
        occupiedCases: response.data.occupied_cases || 0,
        productId: response.data.product_id || null,
        hold: response.data.hold || false,
        notes: response.data.notes || '',
        active: response.data.is_active !== false,
      };

      // Update the nested subLocation's rows
      setLocationsState((prev) =>
        prev.map((location) => {
          if (location.id !== parentLocationId) return location;
          return {
            ...location,
            subLocations: location.subLocations.map((sub) => {
              if (sub.id !== subLocationId) return sub;
              return {
                ...sub,
                rows: [...(sub.rows || []), newRow],
              };
            }),
          };
        }),
      );
      return newRow;
    } catch (error) {
      console.error('Error adding sub-location row:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to add row';
      throw new Error(errorMessage);
    }
  };

  // Update a row in a SubLocation
  const updateSubLocationRow = async (parentLocationId, subLocationId, rowId, updates) => {
    try {
      const headers = await getAuthHeaders();
      const updateData = {};
      if (updates.name !== undefined) updateData.name = updates.name;
      if (updates.template !== undefined) updateData.template = updates.template;
      if (updates.palletCapacity !== undefined) updateData.pallet_capacity = Math.max(0, Number(updates.palletCapacity) || 0);
      if (updates.defaultCasesPerPallet !== undefined) updateData.default_cases_per_pallet = Math.max(0, Number(updates.defaultCasesPerPallet) || 0);
      if (updates.occupiedPallets !== undefined) updateData.occupied_pallets = updates.occupiedPallets;
      if (updates.occupiedCases !== undefined) updateData.occupied_cases = updates.occupiedCases;
      if (updates.hold !== undefined) updateData.hold = updates.hold;
      if (updates.notes !== undefined) updateData.notes = updates.notes || null;
      if (updates.active !== undefined) updateData.is_active = updates.active;

      const response = await axios.put(`${API_BASE_URL}/master-data/storage-rows/${rowId}`, updateData, { headers });

      setLocationsState((prev) =>
        prev.map((location) => {
          if (location.id !== parentLocationId) return location;
          return {
            ...location,
            subLocations: location.subLocations.map((sub) => {
              if (sub.id !== subLocationId) return sub;
              return {
                ...sub,
                rows: (sub.rows || []).map((row) => {
                  if (row.id !== rowId) return row;
                  return {
                    ...row,
                    name: response.data.name,
                    template: response.data.template || 'custom',
                    palletCapacity: response.data.pallet_capacity || 0,
                    defaultCasesPerPallet: response.data.default_cases_per_pallet || 0,
                    occupiedPallets: response.data.occupied_pallets || 0,
                    occupiedCases: response.data.occupied_cases || 0,
                    hold: response.data.hold || false,
                    notes: response.data.notes || '',
                    active: response.data.is_active !== false,
                  };
                }),
              };
            }),
          };
        }),
      );
    } catch (error) {
      console.error('Error updating sub-location row:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to update row';
      throw new Error(errorMessage);
    }
  };

  // Toggle active status of a row in a SubLocation
  const toggleSubLocationRowActive = async (parentLocationId, subLocationId, rowId) => {
    try {
      // Find the current row to get its active status
      const location = locationsState.find(loc => loc.id === parentLocationId);
      const subLocation = location?.subLocations.find(sub => sub.id === subLocationId);
      const row = subLocation?.rows?.find(r => r.id === rowId);
      if (!row) return;

      const headers = await getAuthHeaders();
      const updateData = { is_active: !row.active };
      const response = await axios.put(`${API_BASE_URL}/master-data/storage-rows/${rowId}`, updateData, { headers });

      setLocationsState((prev) =>
        prev.map((loc) => {
          if (loc.id !== parentLocationId) return loc;
          return {
            ...loc,
            subLocations: loc.subLocations.map((sub) => {
              if (sub.id !== subLocationId) return sub;
              return {
                ...sub,
                rows: (sub.rows || []).map((r) =>
                  r.id === rowId ? { ...r, active: response.data.is_active !== false } : r,
                ),
              };
            }),
          };
        }),
      );
    } catch (error) {
      console.error('Error toggling sub-location row active:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to toggle row';
      throw new Error(errorMessage);
    }
  };

  const addStorageArea = async (name, allowFloorStorage = false, locationId = null) => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const exists = storageAreasState.some(
      (area) => area.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (exists) return null;

    try {
      const headers = await getAuthHeaders();
      const areaId = `fg-area-${Date.now()}`;
      const areaData = {
        id: areaId,
        name: trimmed,
        location_id: locationId || null,
        sub_location_id: null,
        allow_floor_storage: allowFloorStorage,
        rows: [],
      };
      const response = await axios.post(`${API_BASE_URL}/master-data/storage-areas`, areaData, { headers });

      const newArea = {
        id: response.data.id,
        name: response.data.name,
        locationId: response.data.location_id,
        subLocationId: response.data.sub_location_id || null,
        allowFloorStorage: response.data.allow_floor_storage || false,
        active: response.data.is_active !== false,
        rows: (response.data.rows || []).map(row => ({
          id: row.id,
          name: row.name,
          template: row.template || 'custom',
          palletCapacity: row.pallet_capacity || 0,
          defaultCasesPerPallet: row.default_cases_per_pallet || 0,
          occupiedPallets: row.occupied_pallets || 0,
          occupiedCases: row.occupied_cases || 0,
          productId: row.product_id || null,
          hold: row.hold || false,
          notes: row.notes || '',
          active: row.is_active !== false,
        })),
      };
      setStorageAreasState((prev) => [...prev, newArea]);
      return newArea;
    } catch (error) {
      console.error('Error adding storage area:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to add storage area';
      throw new Error(errorMessage);
    }
  };

  const updateStorageArea = async (id, updates) => {
    try {
      const headers = await getAuthHeaders();
      const updateData = {};
      if (updates.name !== undefined) updateData.name = updates.name;
      if (updates.locationId !== undefined) updateData.location_id = updates.locationId;
      if (updates.allowFloorStorage !== undefined) updateData.allow_floor_storage = updates.allowFloorStorage;
      if (updates.active !== undefined) updateData.is_active = updates.active;

      const response = await axios.put(`${API_BASE_URL}/master-data/storage-areas/${id}`, updateData, { headers });

      setStorageAreasState((prev) =>
        prev.map((area) => {
          if (area.id !== id) return area;
          return {
            ...area,
            name: response.data.name,
            locationId: response.data.location_id,
            subLocationId: response.data.sub_location_id || null,
            allowFloorStorage: response.data.allow_floor_storage || false,
            active: response.data.is_active !== false,
            ...updates
          };
        }),
      );
    } catch (error) {
      console.error('Error updating storage area:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to update storage area';
      throw new Error(errorMessage);
    }
  };

  const toggleStorageAreaActive = async (id) => {
    try {
      const area = storageAreasState.find(a => a.id === id);
      if (!area) return;

      const headers = await getAuthHeaders();
      const updateData = { is_active: !area.active };
      const response = await axios.put(`${API_BASE_URL}/master-data/storage-areas/${id}`, updateData, { headers });

      setStorageAreasState((prev) =>
        prev.map((a) =>
          a.id === id ? { ...a, active: response.data.is_active !== false } : a,
        ),
      );
    } catch (error) {
      console.error('Error toggling storage area active:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to toggle storage area';
      throw new Error(errorMessage);
    }
  };

  const removeStorageArea = async (id) => {
    try {
      const headers = await getAuthHeaders();
      // Set is_active to false instead of deleting
      await axios.put(`${API_BASE_URL}/master-data/storage-areas/${id}`, { is_active: false }, { headers });
      setStorageAreasState((prev) => prev.filter((area) => area.id !== id));
    } catch (error) {
      console.error('Error removing storage area:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to remove storage area';
      throw new Error(errorMessage);
    }
  };

  const addStorageRow = async (areaId, row) => {
    const trimmedName = row.name.trim();
    if (!trimmedName) return null;

    try {
      const headers = await getAuthHeaders();
      const rowId = row.id || `fg-row-${Date.now()}`;
      const rowData = {
        id: rowId,
        storage_area_id: areaId,
        name: trimmedName,
        template: row.template || "custom",
        pallet_capacity: Number(row.palletCapacity) || 0,
        default_cases_per_pallet: Number(row.defaultCasesPerPallet) || 0,
        occupied_pallets: row.occupiedPallets || 0,
        occupied_cases: row.occupiedCases || 0,
        product_id: row.productId || null,
        hold: !!row.hold,
        notes: row.notes || null,
      };
      const response = await axios.post(`${API_BASE_URL}/master-data/storage-rows`, rowData, { headers });

      const newRow = {
        id: response.data.id,
        name: response.data.name,
        template: response.data.template || 'custom',
        palletCapacity: response.data.pallet_capacity || 0,
        defaultCasesPerPallet: response.data.default_cases_per_pallet || 0,
        occupiedPallets: response.data.occupied_pallets || 0,
        occupiedCases: response.data.occupied_cases || 0,
        productId: response.data.product_id || null,
        hold: response.data.hold || false,
        notes: response.data.notes || '',
        active: response.data.is_active !== false,
      };

      setStorageAreasState((prev) =>
        prev.map((area) => {
          if (area.id !== areaId) return area;
          return {
            ...area,
            rows: [...area.rows, newRow],
          };
        }),
      );
      return newRow;
    } catch (error) {
      console.error('Error adding storage row:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to add storage row';
      throw new Error(errorMessage);
    }
  };

  const updateStorageRow = async (areaId, rowId, updates) => {
    try {
      const headers = await getAuthHeaders();
      const updateData = {};
      if (updates.name !== undefined) updateData.name = updates.name;
      if (updates.template !== undefined) updateData.template = updates.template;
      if (updates.palletCapacity !== undefined) updateData.pallet_capacity = Math.max(0, Number(updates.palletCapacity) || 0);
      if (updates.defaultCasesPerPallet !== undefined) updateData.default_cases_per_pallet = Math.max(0, Number(updates.defaultCasesPerPallet) || 0);
      if (updates.occupiedPallets !== undefined) updateData.occupied_pallets = updates.occupiedPallets;
      if (updates.occupiedCases !== undefined) updateData.occupied_cases = updates.occupiedCases;
      if (updates.productId !== undefined) updateData.product_id = updates.productId;
      if (updates.hold !== undefined) updateData.hold = updates.hold;
      if (updates.notes !== undefined) updateData.notes = updates.notes || null;
      if (updates.active !== undefined) updateData.is_active = updates.active;

      const response = await axios.put(`${API_BASE_URL}/master-data/storage-rows/${rowId}`, updateData, { headers });

      setStorageAreasState((prev) =>
        prev.map((area) => {
          if (area.id !== areaId) return area;
          return {
            ...area,
            rows: area.rows.map((row) => {
              if (row.id !== rowId) return row;
              return {
                ...row,
                name: response.data.name,
                template: response.data.template || 'custom',
                palletCapacity: response.data.pallet_capacity || 0,
                defaultCasesPerPallet: response.data.default_cases_per_pallet || 0,
                occupiedPallets: response.data.occupied_pallets || 0,
                occupiedCases: response.data.occupied_cases || 0,
                productId: response.data.product_id || null,
                hold: response.data.hold || false,
                notes: response.data.notes || '',
                active: response.data.is_active !== false,
                ...updates
              };
            }),
          };
        }),
      );
    } catch (error) {
      console.error('Error updating storage row:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to update storage row';
      throw new Error(errorMessage);
    }
  };

  const toggleStorageRowActive = async (areaId, rowId) => {
    try {
      const area = storageAreasState.find(a => a.id === areaId);
      const row = area?.rows.find(r => r.id === rowId);
      if (!row) return;

      const headers = await getAuthHeaders();
      const updateData = { is_active: !row.active };
      const response = await axios.put(`${API_BASE_URL}/master-data/storage-rows/${rowId}`, updateData, { headers });

      setStorageAreasState((prev) =>
        prev.map((a) => {
          if (a.id !== areaId) return a;
          return {
            ...a,
            rows: a.rows.map((r) =>
              r.id === rowId ? { ...r, active: response.data.is_active !== false } : r,
            ),
          };
        }),
      );
    } catch (error) {
      console.error('Error toggling storage row active:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to toggle storage row';
      throw new Error(errorMessage);
    }
  };

  const removeStorageRow = async (areaId, rowId) => {
    try {
      const headers = await getAuthHeaders();
      // Set is_active to false instead of deleting
      await axios.put(`${API_BASE_URL}/master-data/storage-rows/${rowId}`, { is_active: false }, { headers });
      setStorageAreasState((prev) =>
        prev.map((area) => {
          if (area.id !== areaId) return area;
          return {
            ...area,
            rows: area.rows.filter((row) => row.id !== rowId),
          };
        }),
      );
    } catch (error) {
      console.error('Error removing storage row:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to remove storage row';
      throw new Error(errorMessage);
    }
  };

  const validateManualFinishedGoodPlacements = (
    storageAreas,
    { manualAllocations = [], floorPallets = 0, casesPerPallet = 0, totalCases = 0 },
  ) => {
    const errors = [];
    const areaMap = new Map();
    storageAreas.forEach((area) => {
      areaMap.set(area.id, area);
    });

    manualAllocations.forEach((allocation) => {
      const area = areaMap.get(allocation.areaId);
      if (!area) {
        errors.push(`Storage area not found for placement.`);
        return;
      }
      const row = area.rows.find((rowItem) => rowItem.id === allocation.rowId);
      if (!row) {
        errors.push(`Row not found in area ${area.name}.`);
        return;
      }
      const palletsRequested = numberFrom(allocation.pallets, 0);
      if (palletsRequested < 0) {
        errors.push(`Negative pallet count for ${area.name} / ${row.name}.`);
        return;
      }
      const available = Math.max(0, numberFrom(row.palletCapacity, 0) - numberFrom(row.occupiedPallets, 0));
      if (palletsRequested > available + 1e-6) {
        errors.push(`Area ${area.name} / ${row.name} only has ${available} pallets available.`);
      }
    });

    if (casesPerPallet > 0 && totalCases >= 0) {
      const totalAllocatedCases = manualAllocations.reduce(
        (sum, allocation) => sum + numberFrom(allocation.cases, 0),
        0,
      ) + numberFrom(floorPallets, 0) * casesPerPallet;
      if (Math.abs(totalAllocatedCases - totalCases) > 0.5) {
        errors.push(`Pallet placements (${totalAllocatedCases} cases) must equal cases produced (${totalCases}).`);
      }
    }

    return errors;
  };

  const submitReceipt = async (receipt) => {
    const category = categories.find((cat) => cat.id === receipt.categoryId);
    const isRawMaterial = category?.type === "raw";
    const isFinishedGood = category?.type === "finished";
    const isIngredient = isRawMaterial && category?.subType === "ingredient";
    const isPackaging = category?.subType === "packaging";
    const bolValue = receipt.bol?.toLowerCase().trim();

    if (isRawMaterial && bolValue) {
      const duplicate = receipts.some(
        (existing) => (existing.bol?.toLowerCase().trim() || "") === bolValue,
      );
      if (duplicate) {
        return { success: false, error: "duplicate_bol" };
      }
    }

    if (isFinishedGood) {
      const casesPerPalletValue = numberFrom(receipt.casesPerPallet, 0);
      const fullPalletsValue = numberFrom(receipt.fullPallets, 0);
      const partialCasesValue = numberFrom(receipt.partialCases, 0);
      const totalCases = fullPalletsValue * casesPerPalletValue + partialCasesValue;

      const validationErrors = validateManualFinishedGoodPlacements(
        storageAreasState,
        {
          manualAllocations: receipt.manualAllocations || [],
          floorPallets: receipt.floorPallets || 0,
          casesPerPallet: casesPerPalletValue,
          totalCases,
        },
      );

      if (validationErrors.length) {
        return {
          success: false,
          error: "invalid_manual_allocation",
          message: validationErrors.join(" "),
        };
      }
    }

    const pendingAllocation = (() => {
      if (!isFinishedGood) return null;
      const casesPerPalletValue = numberFrom(receipt.casesPerPallet, 0);
      const fullPalletsValue = numberFrom(receipt.fullPallets, 0);
      const partialCasesValue = numberFrom(receipt.partialCases, 0);
      const totalCases = fullPalletsValue * casesPerPalletValue + partialCasesValue;

      const manualPlan = (receipt.manualAllocations || []).map((entry) => {
        const area = storageAreasState.find((item) => item.id === entry.areaId);
        const row = area?.rows.find((rowItem) => rowItem.id === entry.rowId);
        return {
          areaId: entry.areaId,
          rowId: entry.rowId,
          areaName: area?.name || "",
          rowName: row?.name || "",
          pallets: numberFrom(entry.pallets, 0),
          cases: numberFrom(entry.cases, 0),
        };
      });

      return {
        success: true,
        plan: manualPlan,
        floorAllocation:
          numberFrom(receipt.floorPallets, 0) > 0
            ? {
              pallets: numberFrom(receipt.floorPallets, 0),
              cases: numberFrom(receipt.floorCases, 0),
            }
            : null,
        totalCases: roundTo(totalCases, 2),
        totalPallets: roundTo(fullPalletsValue + (partialCasesValue > 0 ? 1 : 0), 4),
        casesPerPallet: casesPerPalletValue,
        fractionalPallets: roundTo(
          totalCases / (casesPerPalletValue > 0 ? casesPerPalletValue : 1),
          4,
        ),
        request: {
          productId: receipt.productId,
          casesPerPallet: casesPerPalletValue,
          fullPallets: fullPalletsValue,
          partialCases: partialCasesValue,
        },
        manualEntry: true,
        approved: false,
      };
    })();

    const newReceiptId = `rcpt-${Date.now()}`;

    let totalWeight = receipt.weight;
    if (
      isIngredient &&
      (receipt.quantity || receipt.weightUnits) &&
      receipt.quantityUnits
    ) {
      const quantityValue = Number(receipt.quantity);
      const perUnitWeight = Number(receipt.weightUnits);
      if (Number.isFinite(quantityValue) && Number.isFinite(perUnitWeight)) {
        totalWeight = (quantityValue * perUnitWeight).toFixed(2);
      }
    }

    if (isFinishedGood && totalWeight == null) {
      totalWeight = null;
    }

    // For finished goods, extract location and sub-location from storage areas
    // The storage area selection (FG) determines the sub-location
    let locationId = receipt.locationId || receipt.location || null;
    let subLocationId = receipt.subLocationId || receipt.subLocation || null;

    // For finished goods, always extract location/sub-location from the selected storage area
    if (isFinishedGood && receipt.manualAllocations && receipt.manualAllocations.length > 0) {
      // Get location from first storage area (all allocations should be in same area)
      const firstAllocation = receipt.manualAllocations[0];
      if (firstAllocation.areaId) {
        const area = storageAreasState.find(a => a.id === firstAllocation.areaId);
        if (area) {
          // Storage area determines both location and sub-location
          locationId = area.locationId || locationId || null;
          subLocationId = area.subLocationId || subLocationId || null;
        }
      }
    }

    // Form values can override if explicitly provided (for raw materials)
    if (receipt.location && !isFinishedGood) locationId = receipt.location;
    if (receipt.subLocation && !isFinishedGood) subLocationId = receipt.subLocation;

    // Fallback: derive sub_location_id from storageRowId via locationsState
    // This prevents sub_location_id being lost if the form state loses it
    if (!subLocationId && (receipt.storageRowId || receipt.rawMaterialRowAllocations)) {
      const rowId = receipt.storageRowId || (receipt.rawMaterialRowAllocations?.[0]?.rowId);
      if (rowId) {
        // Search all sub-locations' rows for this row ID
        for (const loc of locationsState) {
          for (const sub of (loc.subLocations || [])) {
            const matchRow = (sub.rows || []).find(r => r.id === rowId);
            if (matchRow) {
              subLocationId = sub.id;
              if (!locationId) locationId = loc.id;
              break;
            }
          }
          if (subLocationId) break;
        }
      }
    }

    // Prepare receipt data for API
    // Map frontend field names to backend field names
    const receiptData = {
      id: newReceiptId,
      product_id: receipt.productId,
      category_id: receipt.categoryId || null,
      quantity: Number(receipt.quantity) || 0,
      unit: receipt.quantityUnits || 'cases',
      // Container & weight fields (backend will auto-compute quantity as total weight when all are present)
      container_count: receipt.containerCount || null,
      container_unit: receipt.containerUnit || null,
      weight_per_container: receipt.weightPerContainer || null,
      weight_unit: receipt.weightUnit || null,
      lot_number: receipt.lotNo || null,
      receipt_date: receipt.receiptDate ? new Date(receipt.receiptDate).toISOString() : new Date().toISOString(),
      expiration_date: (receipt.expiryDate || receipt.expiration) ? new Date(receipt.expiryDate || receipt.expiration).toISOString() : null,
      production_date: receipt.productionDate ? new Date(receipt.productionDate).toISOString() : null,
      vendor_id: receipt.vendorId || null,
      location_id: locationId,
      sub_location_id: subLocationId,
      storage_row_id: receipt.storageRowId || null,
      pallets: receipt.pallets ? Number(receipt.pallets) : null,  // Pallet count for raw materials/packaging
      raw_material_row_allocations: receipt.rawMaterialRowAllocations || null,  // Multiple row allocations
      cases_per_pallet: receipt.casesPerPallet ? Number(receipt.casesPerPallet) : null,
      full_pallets: receipt.fullPallets ? Number(receipt.fullPallets) : null,
      partial_cases: receipt.partialCases ? Number(receipt.partialCases) : 0,
      bol: receipt.bol || null,
      purchase_order: receipt.purchaseOrder || null,
      hold: receipt.hold || false,
      shift_id: receipt.shift || null,
      line_id: receipt.lineNumber || null,
      note: receipt.note || '',
      allocations: (receipt.manualAllocations || pendingAllocation?.plan || []).map(alloc => ({
        storage_area_id: alloc.areaId,
        pallet_quantity: Number(alloc.pallets) || 0,
        cases_quantity: Number(alloc.cases) || 0,
      })),
      // Store allocation plan with area/row names in the allocation JSON field
      allocation: pendingAllocation ? {
        success: true,
        plan: pendingAllocation.plan || [],
        floorAllocation: pendingAllocation.floorAllocation || null,
        totalCases: pendingAllocation.totalCases || 0,
        totalPallets: pendingAllocation.totalPallets || 0,
      } : null,
    };

    // Remove null/undefined/empty string fields (except required ones)
    Object.keys(receiptData).forEach(key => {
      if (key !== 'id' && key !== 'product_id' && key !== 'quantity' && key !== 'unit' && key !== 'allocations' && key !== 'receipt_date' && key !== 'allocation') {
        if (receiptData[key] === null || receiptData[key] === undefined || receiptData[key] === '') {
          delete receiptData[key];
        }
      }
    });

    // Don't send empty lot_number
    if (receiptData.lot_number === '' || receiptData.lot_number === null) {
      delete receiptData.lot_number;
    }

    try {
      const headers = await getAuthHeaders();
      const response = await axios.post(`${API_BASE_URL}/receipts/`, receiptData, { headers });

      // Get product to populate SID
      const product = products.find(p => p.id === response.data.product_id);
      const baseReceipt = {
        id: response.data.id,
        status: response.data.status || "recorded",
        submittedAt: response.data.submitted_at || new Date().toISOString(),
        submittedBy: response.data.submitted_by || "warehouse-user",
        approvedBy: response.data.approved_by || null,
        approvedAt: response.data.approved_at || null,
        editHistory: [],
        productId: response.data.product_id,
        categoryId: response.data.category_id || receipt.categoryId,
        quantity: Number(response.data.quantity) || 0,
        quantityUnits: response.data.unit || 'cases',
        containerCount: response.data.container_count || null,
        containerUnit: response.data.container_unit || null,
        weightPerContainer: response.data.weight_per_container || null,
        weightUnit: response.data.weight_unit || null,
        lotNo: response.data.lot_number || '',
        receiptDate: response.data.receipt_date ? new Date(response.data.receipt_date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        expiryDate: response.data.expiration_date ? new Date(response.data.expiration_date).toISOString().split('T')[0] : null,
        expiration: response.data.expiration_date ? new Date(response.data.expiration_date).toISOString().split('T')[0] : null,
        productionDate: response.data.production_date ? new Date(response.data.production_date).toISOString().split('T')[0] : null,
        vendorId: response.data.vendor_id || null,
        locationId: response.data.location_id || locationId || receipt.locationId || receipt.location || null,
        location: response.data.location_id || locationId || receipt.locationId || receipt.location || null,
        subLocationId: response.data.sub_location_id || subLocationId || receipt.subLocationId || receipt.subLocation || null,
        subLocation: response.data.sub_location_id || subLocationId || receipt.subLocationId || receipt.subLocation || null,
        storageRowId: response.data.storage_row_id || receipt.storageRowId || null,
        pallets: response.data.pallets || receipt.pallets || null,  // Pallet count for raw materials/packaging
        rawMaterialRowAllocations: response.data.raw_material_row_allocations || receipt.rawMaterialRowAllocations || null,  // Multiple row allocations
        casesPerPallet: response.data.cases_per_pallet || receipt.casesPerPallet,
        fullPallets: response.data.full_pallets || 0,
        partialCases: response.data.partial_cases || 0,
        bol: response.data.bol || receipt.bol,
        purchaseOrder: response.data.purchase_order || receipt.purchaseOrder,
        hold: response.data.hold || false,
        shift: response.data.shift_id || receipt.shift,
        lineNumber: response.data.line_id || receipt.lineNumber,
        note: response.data.note || '',
        weight: totalWeight,
        weightUnits: receipt.weightUnitType || receipt.weightUnits,
        // Populate SID from product so it's always available and doesn't trigger false change detection
        sid: product?.sid || receipt.sid || '',
      };

      // Set allocation from pendingAllocation or from response
      const allocationData = response.data.allocation || (pendingAllocation ? {
        success: true,
        plan: pendingAllocation.plan || [],
        floorAllocation: pendingAllocation.floorAllocation || null,
        totalCases: pendingAllocation.totalCases || 0,
        totalPallets: pendingAllocation.totalPallets || 0,
      } : null);

      const newReceipt = {
        ...baseReceipt,
        allocation: allocationData,
        // Keep pendingAllocation for backward compatibility
        ...(pendingAllocation ? { pendingAllocation } : {}),
      };

      setReceipts((prev) => [...prev, newReceipt]);

      // Refresh locations and storage areas to update occupied pallet counts
      // Only refresh if receipt has row allocation (raw materials/packaging) or finished goods allocation
      if (receipt.storageRowId || receipt.rawMaterialRowAllocations || (isFinishedGood && pendingAllocation)) {
        // Refresh locations (for raw materials/packaging rows)
        if (receipt.storageRowId || receipt.rawMaterialRowAllocations) {
          fetchLocations();
        }
        // Refresh storage areas (for finished goods rows)
        if (isFinishedGood && pendingAllocation) {
          fetchStorageAreas();
        }
      }

      return { success: true, receipt: newReceipt };
    } catch (error) {
      console.error('Error submitting receipt:', error);
      // If 401, clear invalid token
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }

      // Handle network errors
      if (!error.response) {
        if (error.code === 'ECONNREFUSED' || error.message?.includes('Network Error') || error.message?.includes('Failed to fetch')) {
          return {
            success: false,
            error: 'network_error',
            message: 'Cannot connect to server. Please check if the backend is running.'
          };
        }
        return {
          success: false,
          error: 'network_error',
          message: error.message || 'Network error. Please check your connection and try again.'
        };
      }

      const errorMessage = error.response?.data?.detail || error.message || 'Failed to submit receipt';
      return { success: false, error: 'api_error', message: errorMessage };
    }
  };

  const updateReceiptStatus = (id, status, approverId) => {
    setReceipts((prev) =>
      prev.map((receipt) => {
        if (receipt.id !== id) return receipt;
        return {
          ...receipt,
          status,
          approvedBy: approverId || receipt.approvedBy,
          approvedAt:
            status === "approved"
              ? new Date().toISOString()
              : receipt.approvedAt,
        };
      }),
    );
  };

  const updateReceipt = async (id, updates) => {
    try {
      const headers = await getAuthHeaders();

      // Map frontend field names to backend field names
      const updateData = {};
      if (updates.lotNo !== undefined) updateData.lot_number = updates.lotNo;
      if (updates.quantity !== undefined) updateData.quantity = Number(updates.quantity);
      if (updates.productionDate !== undefined) updateData.production_date = updates.productionDate ? new Date(updates.productionDate).toISOString() : null;
      if (updates.expiryDate !== undefined || updates.expiration !== undefined) {
        updateData.expiration_date = (updates.expiryDate || updates.expiration) ? new Date(updates.expiryDate || updates.expiration).toISOString() : null;
      }
      if (updates.casesPerPallet !== undefined) updateData.cases_per_pallet = updates.casesPerPallet ? Number(updates.casesPerPallet) : null;
      if (updates.fullPallets !== undefined) updateData.full_pallets = updates.fullPallets ? Number(updates.fullPallets) : null;
      if (updates.partialCases !== undefined) updateData.partial_cases = Number(updates.partialCases) || 0;
      if (updates.shift !== undefined) updateData.shift_id = updates.shift || null;
      if (updates.lineNumber !== undefined) updateData.line_id = updates.lineNumber || null;
      if (updates.bol !== undefined) updateData.bol = updates.bol || null;
      if (updates.purchaseOrder !== undefined) updateData.purchase_order = updates.purchaseOrder || null;
      if (updates.vendorId !== undefined) updateData.vendor_id = updates.vendorId || null;
      if (updates.note !== undefined) updateData.note = updates.note || null;
      if (updates.status !== undefined) updateData.status = updates.status;

      // Copy any other fields that match backend schema
      Object.keys(updates).forEach(key => {
        if (!['lotNo', 'quantity', 'productionDate', 'expiryDate', 'expiration', 'casesPerPallet', 'fullPallets', 'partialCases', 'shift', 'lineNumber', 'bol', 'purchaseOrder', 'vendorId', 'note', 'status'].includes(key)) {
          // Try to map common fields
          if (key === 'sid') return; // Not in backend schema
          if (key === 'fccCode') return; // Not in backend schema
          updateData[key] = updates[key];
        }
      });

      const response = await axios.put(`${API_BASE_URL}/receipts/${id}`, updateData, { headers });

      // Update local state with response data
      setReceipts((prev) =>
        prev.map((receipt) => {
          if (receipt.id !== id) return receipt;
          return {
            ...receipt,
            ...updates,
            status: response.data.status || receipt.status,
            approvedBy: response.data.approved_by || receipt.approvedBy,
            approvedAt: response.data.approved_at ? new Date(response.data.approved_at).toISOString() : receipt.approvedAt,
          };
        }),
      );

      return { success: true };
    } catch (error) {
      console.error('Error updating receipt:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to update receipt';
      return { success: false, error: 'api_error', message: errorMessage };
    }
  };

  const approveReceipt = async (id, approverId = "admin-user") => {
    try {
      const headers = await getAuthHeaders();
      const response = await axios.post(`${API_BASE_URL}/receipts/${id}/approve`, {}, { headers });

      // Find receipt to check if it has row allocation
      const receipt = receipts.find(r => r.id === id);
      const hasRowAllocation = receipt?.storageRowId || receipt?.rawMaterialRowAllocations || 
                               (receipt?.allocation && receipt?.categoryId && 
                                categories.find(c => c.id === receipt.categoryId)?.type === 'finished');

      // Update local state with response data
      setReceipts((prev) =>
        prev.map((receipt) => {
          if (receipt.id !== id) return receipt;
          return {
            ...receipt,
            status: "approved",
            approvedBy: response.data.receipt?.approved_by || approverId,
            approvedAt: response.data.receipt?.approved_at ? new Date(response.data.receipt.approved_at).toISOString() : new Date().toISOString(),
          };
        }),
      );

      // Refresh locations and storage areas to update occupied pallet counts
      if (hasRowAllocation) {
        if (receipt?.storageRowId || receipt?.rawMaterialRowAllocations) {
          fetchLocations();
        }
        if (receipt?.allocation) {
          fetchStorageAreas();
        }
      }

      return { success: true };
    } catch (error) {
      console.error('Error approving receipt:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to approve receipt';
      return { success: false, error: 'api_error', message: errorMessage };
    }
  };

  const rejectReceipt = async (id, reason, approverId = "admin-user") => {
    try {
      const headers = await getAuthHeaders();
      const response = await axios.post(`${API_BASE_URL}/receipts/${id}/reject`, null, {
        headers,
        params: { reason: reason || 'No reason provided' }
      });

      // Find receipt to check if it has row allocation that needs to be freed
      const receipt = receipts.find(r => r.id === id);
      const hasRowAllocation = receipt?.storageRowId || receipt?.rawMaterialRowAllocations || 
                               (receipt?.allocation && receipt?.categoryId && 
                                categories.find(c => c.id === receipt.categoryId)?.type === 'finished');

      // Update local state with response data
      setReceipts((prev) =>
        prev.map((receipt) => {
          if (receipt.id !== id) return receipt;
          return {
            ...receipt,
            status: "rejected",
            note: response.data.receipt?.note || receipt.note,
          };
        }),
      );

      // Refresh locations and storage areas to update freed capacity
      if (hasRowAllocation) {
        if (receipt?.storageRowId || receipt?.rawMaterialRowAllocations) {
          fetchLocations();
        }
        if (receipt?.allocation) {
          fetchStorageAreas();
        }
      }

      return { success: true };
    } catch (error) {
      console.error('Error rejecting receipt:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to reject receipt';
      return { success: false, error: 'api_error', message: errorMessage };
    }
  };

  const sendBackReceipt = async (id, reason, approverId = "admin-user") => {
    try {
      const headers = await getAuthHeaders();
      const response = await axios.post(`${API_BASE_URL}/receipts/${id}/send-back`, null, {
        headers,
        params: { reason: reason || 'No reason provided' }
      });

      // Find receipt to check if it has row allocation that needs to be freed
      const receipt = receipts.find(r => r.id === id);
      const hasRowAllocation = receipt?.storageRowId || receipt?.rawMaterialRowAllocations || 
                               (receipt?.allocation && receipt?.categoryId && 
                                categories.find(c => c.id === receipt.categoryId)?.type === 'finished');

      // Update local state with response data (backend sets status to "sent-back")
      const updatedStatus = response.data.receipt?.status || "sent-back";
      setReceipts((prev) =>
        prev.map((receipt) => {
          if (receipt.id !== id) return receipt;
          return {
            ...receipt,
            status: updatedStatus,
            note: response.data.receipt?.note || receipt.note,
          };
        }),
      );

      // Refresh locations and storage areas to update freed capacity
      if (hasRowAllocation) {
        if (receipt?.storageRowId || receipt?.rawMaterialRowAllocations) {
          fetchLocations();
        }
        if (receipt?.allocation) {
          fetchStorageAreas();
        }
      }

      return { success: true };
    } catch (error) {
      console.error('Error sending back receipt:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to send back receipt';
      return { success: false, error: 'api_error', message: errorMessage };
    }
  };

  const submitTransfer = async (transfer) => {
    try {
      const quantityValue = Number(transfer.quantity);
      if (!Number.isFinite(quantityValue) || quantityValue <= 0) {
        return {
          success: false,
          error: "invalid_quantity",
          message: "Quantity must be greater than zero to move inventory.",
        };
      }

      const receipt = receipts.find((item) => item.id === transfer.receiptId);
      if (!receipt) {
        return {
          success: false,
          error: "receipt_not_found",
          message: "Selected receipt could not be found.",
        };
      }

      const currentQuantity = numberFrom(receipt.quantity, 0);
      if (quantityValue > currentQuantity + EPSILON) {
        return {
          success: false,
          error: "quantity_exceeds_available",
          message: "You cannot move more than the available quantity on the lot.",
        };
      }

      // Call backend API to persist the transfer
      const headers = await getAuthHeaders();
      const payload = {
        receipt_id: transfer.receiptId,
        from_location_id: transfer.fromLocation || null,
        from_sub_location_id: transfer.fromSubLocation || null,
        to_location_id: transfer.toLocation || null,
        to_sub_location_id: transfer.toSubLocation || null,
        quantity: quantityValue,
        reason: transfer.reason || '',
        transfer_type: transfer.transferType || 'warehouse-transfer',
        order_number: transfer.orderNumber || null,
        source_breakdown: transfer.sourceBreakdown || null,
        destination_breakdown: transfer.destinationBreakdown || null,
        ...(transfer.palletLicenceIds?.length ? { pallet_licence_ids: transfer.palletLicenceIds } : {}),
      };

      const response = await axios.post(`${API_BASE_URL}/inventory/transfers`, payload, { headers });

      const newTransfer = {
        id: response.data.id,
        receiptId: response.data.receipt_id,
        fromLocation: response.data.from_location_id,
        fromSubLocation: response.data.from_sub_location_id,
        toLocation: response.data.to_location_id,
        toSubLocation: response.data.to_sub_location_id,
        quantity: response.data.quantity,
        reason: response.data.reason,
        transferType: response.data.transfer_type,
        orderNumber: response.data.order_number,
        sourceBreakdown: response.data.source_breakdown || [],
        destinationBreakdown: response.data.destination_breakdown || [],
        palletLicenceIds: response.data.pallet_licence_ids || [],
        palletLicenceDetails: response.data.pallet_licence_details || [],
        status: response.data.status || 'pending',
        submittedAt: response.data.submitted_at,
        submittedBy: response.data.requested_by,
        approvedBy: response.data.approved_by || null,
        approvedAt: response.data.approved_at || null,
        editHistory: [],
      };

      setInventoryTransfers((prev) => [newTransfer, ...prev]);
      return {
        success: true,
        message: 'Transfer request submitted successfully.',
        transfer: newTransfer
      };
    } catch (error) {
      console.error('Error submitting transfer:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to submit transfer';
      return { success: false, error: errorMessage, message: errorMessage };
    }
  };

  const updateTransfer = (id, updates) => {
    setInventoryTransfers((prev) =>
      prev.map((transfer) =>
        transfer.id === id ? { ...transfer, ...updates } : transfer,
      ),
    );
  };

  const updateTransferStatus = (id, status, approverId) => {
    setInventoryTransfers((prev) => {
      const target = prev.find((transfer) => transfer.id === id);
      if (!target) return prev;

      if (status !== "approved") {
        return prev.map((transfer) =>
          transfer.id === id
            ? {
              ...transfer,
              status,
              approvedBy: approverId || transfer.approvedBy,
              approvedAt:
                status === "approved"
                  ? new Date().toISOString()
                  : transfer.approvedAt,
            }
            : transfer,
        );
      }

      const receipt = receipts.find((item) => item.id === target.receiptId);
      if (!receipt) {
        return prev.map((transfer) =>
          transfer.id === id
            ? {
              ...transfer,
              status,
              approvedBy: approverId || transfer.approvedBy,
              approvedAt: new Date().toISOString(),
            }
            : transfer,
        );
      }

      const category = categories.find((cat) => cat.id === receipt.categoryId);
      const isFinishedGood = category?.type === "finished";
      let nextAreas = storageAreasState;
      let allocationDetails = receipt.allocation;
      let fullPallets = receipt.fullPallets;
      let partialCases = receipt.partialCases;

      if (isFinishedGood) {
        const reassignment = reassignFinishedGood({
          receipt,
          quantityCases: target.quantity,
          locationId: target.toLocation || receipt.location,
          storageAreas: storageAreasState,
          locations: locationsState,
        });

        if (!reassignment.success) {
          return prev.map((transfer) =>
            transfer.id === id
              ? {
                ...transfer,
                status: "recorded",
                approvedBy: approverId || transfer.approvedBy,
                approvedAt: null,
                rejectionReason:
                  reassignment.message ||
                  "Unable to reallocate finished goods capacity for this transfer.",
              }
              : transfer,
          );
        }

        nextAreas = reassignment.nextAreas;
        allocationDetails = reassignment.allocationDetails;
        fullPallets = reassignment.fullPallets;
        partialCases = reassignment.partialCases;

        if (allocationDetails?.success) {
          setAllocationHistory((prevHistory) => [
            {
              id: `alloc-${Date.now()}`,
              receiptId: receipt.id,
              timestamp: new Date().toISOString(),
              ...allocationDetails,
              approvedBy: approverId || target.approvedBy || "system",
            },
            ...prevHistory,
          ]);
        }
      }

      setReceipts((current) =>
        current.map((item) => {
          if (item.id !== receipt.id) return item;
          const updatedHistory = [
            ...item.editHistory,
            {
              id: `edit-${Date.now()}`,
              type: "transfer",
              timestamp: new Date().toISOString(),
              updaterId: approverId || target.approvedBy || "system",
              details: {
                transferType: target.transferType || 'warehouse-transfer',
                orderNumber: target.orderNumber || null,
                toLocation: target.toLocation,
                toSubLocation: target.toSubLocation,
                quantity: target.quantity,
                reason: target.reason || "",
              },
            },
          ];

          // For shipped-out transfers, reduce quantity instead of setting it
          const isShippedOut = target.transferType === 'shipped-out';
          const newQuantity = isShippedOut
            ? Math.max(0, item.quantity - target.quantity)
            : target.quantity;

          return {
            ...item,
            quantity: newQuantity,
            location: isShippedOut ? item.location : (target.toLocation || item.location),
            subLocation: isShippedOut ? item.subLocation : (target.toSubLocation || item.subLocation),
            editHistory: updatedHistory,
            allocation: allocationDetails,
            fullPallets,
            partialCases,
          };
        }),
      );

      if (nextAreas !== storageAreasState) {
        setStorageAreasState(nextAreas);
      }

      return prev.map((transfer) =>
        transfer.id === id
          ? {
            ...transfer,
            status,
            approvedBy: approverId || transfer.approvedBy,
            approvedAt: new Date().toISOString(),
          }
          : transfer,
      );
    });
  };

  const approveTransfer = async (id, approverId = "admin-user") => {
    try {
      const headers = await getAuthHeaders();
      await axios.post(`${API_BASE_URL}/inventory/transfers/${id}/approve`, {}, { headers });

      // Update local state after successful API call
      updateTransferStatus(id, "approved", approverId);

      // Refresh receipts to get updated quantities from backend
      const receiptsResponse = await axios.get(`${API_BASE_URL}/receipts/`, { headers });
      const recs = receiptsResponse.data.map(rec => {
        const product = products.find(p => p.id === rec.product_id);
        return {
          id: rec.id,
          productId: rec.product_id,
          categoryId: rec.category_id || null,
          quantity: Number(rec.quantity) || 0,
          quantityUnits: rec.unit || rec.quantity_units || 'cases',
          lotNo: rec.lot_number || '',
          receiptDate: rec.receipt_date ? new Date(rec.receipt_date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
          expiryDate: rec.expiration_date ? new Date(rec.expiration_date).toISOString().split('T')[0] : null,
          expiration: rec.expiration_date ? new Date(rec.expiration_date).toISOString().split('T')[0] : null,
          productionDate: rec.production_date ? new Date(rec.production_date).toISOString().split('T')[0] : null,
          vendorId: rec.vendor_id || null,
          status: rec.status || 'recorded',
          submittedBy: rec.submitted_by || '',
          submittedAt: rec.submitted_at || null,
          approvedBy: rec.approved_by || null,
          approvedAt: rec.approved_at || null,
          note: rec.note || '',
          locationId: rec.location_id || null,
          location: rec.location_id || null,
          subLocationId: rec.sub_location_id || null,
          subLocation: rec.sub_location_id || null,
          storageAreaId: rec.storage_area_id || null,
          storageRowId: rec.storage_row_id || null,
          fullPallets: rec.full_pallets || 0,
          partialCases: rec.partial_cases || 0,
          casesPerPallet: rec.cases_per_pallet || null,
          bol: rec.bol || null,
          purchaseOrder: rec.purchase_order || null,
          hold: rec.hold || false,
          heldQuantity: rec.held_quantity || 0,
          shift: rec.shift_id || null,
          lineNumber: rec.line_id || null,
          editHistory: [],
          sid: product?.sid || '',
          allocation: (() => {
            if (!rec.allocation) return null;
            if (typeof rec.allocation === 'string') {
              try {
                return JSON.parse(rec.allocation);
              } catch (e) {
                return null;
              }
            }
            return rec.allocation;
          })(),
        };
      });
      // Keep all receipts - filtering is handled by activeReceipts in context
      setReceipts(recs);

      return { success: true };
    } catch (error) {
      console.error('Error approving transfer:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to approve transfer';
      return { success: false, error: errorMessage };
    }
  };

  const rejectTransfer = async (id, reason = '', approverId = "admin-user") => {
    try {
      const headers = await getAuthHeaders();
      await axios.post(`${API_BASE_URL}/inventory/transfers/${id}/reject?reason=${encodeURIComponent(reason)}`, {}, { headers });

      // Update local state after successful API call
      updateTransferStatus(id, "rejected", approverId);

      return { success: true };
    } catch (error) {
      console.error('Error rejecting transfer:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to reject transfer';
      return { success: false, error: errorMessage };
    }
  };

  const fetchForkliftRequests = async () => {
    try {
      const headers = await getAuthHeaders();
      const response = await axios.get(`${API_BASE_URL}/scanner/requests`, { headers });
      setForkliftRequests(response.data || []);
      return response.data || [];
    } catch (error) {
      console.error('Error fetching forklift requests:', error);
      return [];
    }
  };

  const approveForkliftRequest = async (id) => {
    try {
      const headers = await getAuthHeaders();
      await axios.post(`${API_BASE_URL}/scanner/requests/${id}/approve`, {}, { headers });
      await fetchForkliftRequests();

      const receiptsResponse = await axios.get(`${API_BASE_URL}/receipts/`, { headers, params: { limit: 10000 } });
      const recs = receiptsResponse.data.map(rec => {
        const product = products.find(p => p.id === rec.product_id);
        return {
          id: rec.id,
          productId: rec.product_id,
          categoryId: rec.category_id || null,
          quantity: Number(rec.quantity) || 0,
          quantityUnits: rec.unit || rec.quantity_units || 'cases',
          containerCount: rec.container_count || null,
          containerUnit: rec.container_unit || null,
          weightPerContainer: rec.weight_per_container || null,
          weightUnit: rec.weight_unit || null,
          lotNo: rec.lot_number || '',
          receiptDate: rec.receipt_date ? new Date(rec.receipt_date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
          expiryDate: rec.expiration_date ? new Date(rec.expiration_date).toISOString().split('T')[0] : null,
          expiration: rec.expiration_date ? new Date(rec.expiration_date).toISOString().split('T')[0] : null,
          productionDate: rec.production_date ? new Date(rec.production_date).toISOString().split('T')[0] : null,
          vendorId: rec.vendor_id || null,
          status: rec.status || 'recorded',
          submittedBy: rec.submitted_by || '',
          submittedAt: rec.submitted_at || null,
          approvedBy: rec.approved_by || null,
          approvedAt: rec.approved_at || null,
          note: rec.note || '',
          locationId: rec.location_id || null,
          location: rec.location_id || null,
          subLocationId: rec.sub_location_id || null,
          subLocation: rec.sub_location_id || null,
          storageAreaId: rec.storage_area_id || null,
          storageRowId: rec.storage_row_id || null,
          pallets: rec.pallets || null,
          rawMaterialRowAllocations: rec.raw_material_row_allocations || null,
          fullPallets: rec.full_pallets || 0,
          partialCases: rec.partial_cases || 0,
          casesPerPallet: rec.cases_per_pallet || null,
          bol: rec.bol || null,
          purchaseOrder: rec.purchase_order || null,
          hold: rec.hold || false,
          heldQuantity: rec.held_quantity || 0,
          holdLocation: rec.hold_location || null,
          shift: rec.shift_id || null,
          lineNumber: rec.line_id || null,
          editHistory: [],
          sid: product?.sid || '',
          allocation: (() => {
            if (!rec.allocation) return null;
            if (typeof rec.allocation === 'string') {
              try { return JSON.parse(rec.allocation); } catch (e) { return null; }
            }
            return rec.allocation;
          })(),
        };
      });
      setReceipts(recs);

      return { success: true };
    } catch (error) {
      console.error('Error approving forklift request:', error);
      const msg = error.response?.data?.detail || error.message || 'Approval failed';
      return { success: false, error: msg };
    }
  };

  const rejectForkliftRequest = async (id) => {
    try {
      const headers = await getAuthHeaders();
      await axios.post(`${API_BASE_URL}/scanner/requests/${id}/reject`, {}, { headers });
      await fetchForkliftRequests();
      return { success: true };
    } catch (error) {
      console.error('Error rejecting forklift request:', error);
      const msg = error.response?.data?.detail || error.message || 'Reject failed';
      return { success: false, error: msg };
    }
  };

  const updateForkliftRequest = async (id, updates) => {
    try {
      const headers = await getAuthHeaders();
      await axios.put(`${API_BASE_URL}/scanner/requests/${id}`, updates, { headers });
      await fetchForkliftRequests();
      return { success: true };
    } catch (error) {
      console.error('Error updating forklift request:', error);
      const msg = error.response?.data?.detail || error.message || 'Update failed';
      return { success: false, error: msg };
    }
  };

  const removePalletLicence = async (requestId, licenceId) => {
    try {
      const headers = await getAuthHeaders();
      await axios.delete(`${API_BASE_URL}/scanner/requests/${requestId}/pallet-licences/${licenceId}`, { headers });
      await fetchForkliftRequests();
      return { success: true };
    } catch (error) {
      console.error('Error removing pallet licence:', error);
      const msg = error.response?.data?.detail || error.message || 'Remove failed';
      return { success: false, error: msg };
    }
  };

  const updatePalletLicence = async (requestId, licenceId, updates) => {
    try {
      const headers = await getAuthHeaders();
      await axios.put(`${API_BASE_URL}/scanner/requests/${requestId}/pallet-licences/${licenceId}`, updates, { headers });
      await fetchForkliftRequests();
      return { success: true };
    } catch (error) {
      console.error('Error updating pallet licence:', error);
      const msg = error.response?.data?.detail || error.message || 'Update failed';
      return { success: false, error: msg };
    }
  };

  const addPalletToForkliftRequest = async (requestId, palletData) => {
    try {
      const headers = await getAuthHeaders();
      await axios.post(`${API_BASE_URL}/scanner/requests/${requestId}/add-pallet`, palletData, { headers });
      await fetchForkliftRequests();
      return { success: true };
    } catch (error) {
      console.error('Error adding pallet to request:', error);
      const msg = error.response?.data?.detail || error.message || 'Add pallet failed';
      return { success: false, error: msg };
    }
  };

  const fetchPalletLicences = async (filters = {}) => {
    try {
      const headers = await getAuthHeaders();
      const response = await axios.get(`${API_BASE_URL}/pallet-licences/`, { headers, params: filters });
      return response.data || [];
    } catch (error) {
      console.error('Error fetching pallet licences:', error);
      return [];
    }
  };

  const createShipOutPickList = async (data) => {
    try {
      const headers = await getAuthHeaders();
      const response = await axios.post(`${API_BASE_URL}/inventory/ship-out/pick-list`, {
        receipt_id: data.receiptId,
        order_number: data.orderNumber,
        pallet_licence_ids: data.palletLicenceIds,
      }, { headers });
      const t = response.data;
      const newTransfer = {
        id: t.id,
        receiptId: t.receipt_id,
        transferType: t.transfer_type,
        fromLocation: t.from_location_id,
        toLocation: t.to_location_id,
        quantity: t.quantity,
        orderNumber: t.order_number,
        status: t.status,
        submittedAt: t.submitted_at,
        palletLicenceIds: t.pallet_licence_ids || [],
        palletLicenceDetails: t.pallet_licence_details || [],
        sourceBreakdown: t.source_breakdown || [],
        destinationBreakdown: t.destination_breakdown || [],
        editHistory: [],
      };
      setInventoryTransfers((prev) => [newTransfer, ...prev]);
      return { success: true, transfer: newTransfer };
    } catch (error) {
      console.error('Error creating ship-out pick list:', error);
      const msg = error.response?.data?.detail || error.message || 'Create failed';
      return { success: false, error: msg };
    }
  };

  const fetchTransferScanProgress = async (transferId) => {
    try {
      const headers = await getAuthHeaders();
      const response = await axios.get(`${API_BASE_URL}/inventory/transfers/${transferId}/scan-progress`, { headers });
      return response.data;
    } catch (error) {
      console.error('Error fetching transfer scan progress:', error);
      return null;
    }
  };

  const submitHoldAction = async (action) => {
    try {
      const headers = await getAuthHeaders();

      // Build payload - support both partial holds and legacy full-lot holds
      const payload = {
        action: action.action,
        reason: action.reason
      };

      // For partial holds (by location)
      if (action.holdItems && action.holdItems.length > 0) {
        payload.hold_items = action.holdItems.map(item => ({
          receipt_id: item.receiptId,
          location_id: item.locationId,
          quantity: item.quantity
        }));
        payload.total_quantity = action.totalQuantity;
      }

      // For legacy full-lot holds
      if (action.receiptId) {
        payload.receipt_id = action.receiptId;
      }

      const response = await axios.post(`${API_BASE_URL}/inventory/hold-actions`, payload, { headers });

      const newAction = {
        id: response.data.id,
        receiptId: response.data.receipt_id,
        action: response.data.action,
        reason: response.data.reason,
        status: response.data.status || 'pending',
        submittedAt: response.data.submitted_at,
        submittedBy: response.data.submitted_by,
        approvedBy: response.data.approved_by || null,
        approvedAt: response.data.approved_at || null,
        editHistory: []
      };

      setInventoryHoldActions((prev) => [...prev, newAction]);
      return { success: true, action: newAction };
    } catch (error) {
      console.error('Error submitting hold action:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to submit hold action';
      return { success: false, error: errorMessage };
    }
  };

  const updateHoldAction = (id, updates) => {
    setInventoryHoldActions((prev) =>
      prev.map((action) =>
        action.id === id ? { ...action, ...updates } : action,
      ),
    );
  };

  const updateHoldStatus = (id, status, approverId) => {
    setInventoryHoldActions((prev) => {
      const target = prev.find((action) => action.id === id);
      if (status === "approved" && target?.receiptId) {
        setReceipts((current) =>
          current.map((receipt) => {
            if (receipt.id !== target.receiptId) return receipt;
            return { ...receipt, hold: target.action === "hold" };
          }),
        );
      }
      return prev.map((action) => {
        if (action.id !== id) return action;
        return {
          ...action,
          status,
          approvedBy: approverId || action.approvedBy,
          approvedAt:
            status === "approved"
              ? new Date().toISOString()
              : action.approvedAt,
        };
      });
    });
  };

  const approveHoldAction = async (id, approverId = "admin-user") => {
    try {
      const headers = await getAuthHeaders();
      await axios.post(`${API_BASE_URL}/inventory/hold-actions/${id}/approve`, {}, { headers });

      // Update local state optimistically
      setInventoryHoldActions((prev) => prev.map(hold =>
        hold.id === id
          ? { ...hold, status: 'approved', approvedBy: approverId, approvedAt: new Date().toISOString() }
          : hold
      ));

      // Update receipt's hold status based on the action
      const targetHold = inventoryHoldActions.find(h => h.id === id);
      if (targetHold) {
        setReceipts((current) =>
          current.map((receipt) => {
            if (receipt.id !== targetHold.receiptId) return receipt;
            return { ...receipt, hold: targetHold.action === "hold" };
          })
        );
      }
    } catch (error) {
      console.error('Error approving hold action:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
    }
  };

  const rejectHoldAction = async (id, approverId = "admin-user") => {
    try {
      const headers = await getAuthHeaders();
      await axios.post(`${API_BASE_URL}/inventory/hold-actions/${id}/reject`, {}, { headers });

      // Update local state optimistically
      setInventoryHoldActions((prev) => prev.map(hold =>
        hold.id === id
          ? { ...hold, status: 'rejected', approvedBy: approverId, approvedAt: new Date().toISOString() }
          : hold
      ));
    } catch (error) {
      console.error('Error rejecting hold action:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
    }
  };

  const submitAdjustment = async (adjustment) => {
    try {
      const headers = await getAuthHeaders();
      const payload = {
        receipt_id: adjustment.receiptId,
        product_id: adjustment.productId,
        category_id: adjustment.categoryId,
        adjustment_type: adjustment.adjustmentType,
        quantity: adjustment.quantity,
        reason: adjustment.reason,
        recipient: adjustment.recipient || null
      };

      const response = await axios.post(`${API_BASE_URL}/inventory/adjustments`, payload, { headers });

      const newAdjustment = {
        id: response.data.id,
        receiptId: response.data.receipt_id,
        productId: response.data.product_id,
        categoryId: response.data.category_id,
        adjustmentType: response.data.adjustment_type,
        quantity: response.data.quantity,
        reason: response.data.reason,
        recipient: response.data.recipient,
        status: response.data.status || 'pending',
        submittedAt: response.data.submitted_at,
        submittedBy: response.data.submitted_by,
        approvedBy: response.data.approved_by || null,
        approvedAt: response.data.approved_at || null,
        editHistory: []
      };

      setInventoryAdjustments((prev) => [newAdjustment, ...prev]);
      return {
        success: true,
        message: 'Adjustment request submitted successfully.',
        adjustment: newAdjustment
      };
    } catch (error) {
      console.error('Error submitting adjustment:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to submit adjustment';
      return { success: false, error: errorMessage };
    }
  };

  const updateAdjustment = (id, updates) => {
    setInventoryAdjustments((prev) =>
      prev.map((adjustment) =>
        adjustment.id === id ? { ...adjustment, ...updates } : adjustment,
      ),
    );
  };

  const updateAdjustmentStatus = (id, status, approverId) => {
    setInventoryAdjustments((prev) => {
      const target = prev.find((adjustment) => adjustment.id === id);
      if (status === "approved" && target?.receiptId && target?.adjustmentType) {
        // Apply the adjustment to the receipt
        setReceipts((current) =>
          current.map((receipt) => {
            if (receipt.id !== target.receiptId) return receipt;

            // Calculate new quantity based on adjustment type
            let newQuantity = receipt.quantity;
            if (target.adjustmentType === 'stock-correction') {
              // For stock correction, we might increase or decrease
              newQuantity = Math.max(0, receipt.quantity - target.quantity);
            } else if (['damage-reduction', 'donation', 'trash-disposal', 'quality-rejection', 'shipped-out'].includes(target.adjustmentType)) {
              // For these types, we reduce the quantity
              newQuantity = Math.max(0, receipt.quantity - target.quantity);
            }

            return {
              ...receipt,
              quantity: newQuantity,
              editHistory: [
                ...receipt.editHistory,
                {
                  id: `edit-${Date.now()}`,
                  type: "adjustment",
                  timestamp: new Date().toISOString(),
                  updaterId: approverId || "admin-user",
                  details: {
                    adjustmentType: target.adjustmentType,
                    quantityAdjusted: target.quantity,
                    reason: target.reason,
                    recipient: target.recipient,
                  },
                },
              ],
            };
          }),
        );
      }
      return prev.map((adjustment) => {
        if (adjustment.id !== id) return adjustment;
        return {
          ...adjustment,
          status,
          approvedBy: approverId || adjustment.approvedBy,
          approvedAt:
            status === "approved"
              ? new Date().toISOString()
              : adjustment.approvedAt,
        };
      });
    });
  };

  const approveAdjustment = async (id, approverId = "admin-user") => {
    try {
      const headers = await getAuthHeaders();

      // Find the adjustment to get the details before approving
      const adjustment = inventoryAdjustments.find(adj => adj.id === id);

      await axios.post(`${API_BASE_URL}/inventory/adjustments/${id}/approve`, {}, { headers });

      // Update local adjustment state
      setInventoryAdjustments((prev) => prev.map(adj =>
        adj.id === id
          ? { ...adj, status: 'approved', approvedBy: approverId, approvedAt: new Date().toISOString() }
          : adj
      ));

      // Also update the receipt quantity (backend already did this, sync frontend)
      if (adjustment && adjustment.receiptId) {
        const deductTypes = ['stock-correction', 'damage-reduction', 'donation', 'trash-disposal', 'quality-rejection'];
        if (deductTypes.includes(adjustment.adjustmentType)) {
          setReceipts((prev) => prev.map(r =>
            r.id === adjustment.receiptId
              ? { ...r, quantity: Math.max(0, r.quantity - (adjustment.quantity || 0)) }
              : r
          ));
        }
      }
    } catch (error) {
      console.error('Error approving adjustment:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
    }
  };

  const rejectAdjustment = async (id, approverId = "admin-user") => {
    try {
      const headers = await getAuthHeaders();
      await axios.post(`${API_BASE_URL}/inventory/adjustments/${id}/reject`, {}, { headers });

      // Update local state optimistically
      setInventoryAdjustments((prev) => prev.map(adj =>
        adj.id === id
          ? { ...adj, status: 'rejected', approvedBy: approverId, approvedAt: new Date().toISOString() }
          : adj
      ));
    } catch (error) {
      console.error('Error rejecting adjustment:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
    }
  };

  const saveCycleCount = async (cycleCountData) => {
    try {
      const headers = await getAuthHeaders();
      const payload = {
        location_id: cycleCountData.location,
        category_id: cycleCountData.category || null,
        count_date: cycleCountData.countDate,
        items: cycleCountData.items,
        summary: cycleCountData.summary,
        performed_by: cycleCountData.performedBy,
        performed_by_id: cycleCountData.performedById,
      };

      const response = await axios.post(`${API_BASE_URL}/inventory/cycle-counts`, payload, { headers });

      const newCycleCount = {
        id: response.data.id,
        location: response.data.location_id,
        category: response.data.category_id,
        countDate: response.data.count_date,
        items: response.data.items,
        summary: response.data.summary,
        performedBy: response.data.performed_by,
        performedById: response.data.performed_by_id,
        createdAt: response.data.created_at,
      };

      setCycleCounts((prev) => [...prev, newCycleCount]);
      return newCycleCount.id;
    } catch (error) {
      console.error('Error saving cycle count:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      return null;
    }
  };

  const addUser = async (user) => {
    try {
      const headers = await getAuthHeaders();
      const userData = {
        username: user.username,
        name: user.name,
        role: user.role,
        password: user.password,
        email: user.email || null,
        ...(user.badgeId ? { badge_id: user.badgeId } : {}),
      };
      const response = await axios.post(`${API_BASE_URL}/users/`, userData, { headers });
      const newUser = {
        id: response.data.id,
        username: response.data.username,
        name: response.data.name,
        role: response.data.role,
        status: response.data.is_active ? "active" : "inactive",
        email: response.data.email || null,
        badgeId: response.data.badge_id || null,
      };
      setUsers((prev) => [...prev, newUser]);
      return newUser;
    } catch (error) {
      console.error('Error adding user:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      const detail = error.response?.data?.detail;
      const errorMessage = typeof detail === 'string' ? detail
        : Array.isArray(detail) ? detail.map((d) => d.msg || JSON.stringify(d)).join(', ')
        : detail && typeof detail === 'object' ? JSON.stringify(detail) : (error.message || 'Failed to add user');
      throw new Error(errorMessage);
    }
  };

  const updateUser = async (id, updates) => {
    try {
      const headers = await getAuthHeaders();
      const updateData = {};
      if (updates.name !== undefined) updateData.name = updates.name;
      if (updates.username !== undefined) updateData.username = updates.username;
      if (updates.role !== undefined) updateData.role = updates.role;
      if (updates.email !== undefined) updateData.email = updates.email;
      if (updates.password !== undefined && updates.password !== "") {
        updateData.password = updates.password;
      }
      if (updates.badgeId !== undefined) {
        updateData.badge_id = updates.badgeId === "" ? null : updates.badgeId;
      }

      const response = await axios.put(`${API_BASE_URL}/users/${id}`, updateData, { headers });
      const updatedUser = {
        id: response.data.id,
        username: response.data.username,
        name: response.data.name,
        role: response.data.role,
        status: response.data.is_active ? "active" : "inactive",
        email: response.data.email || null,
        badgeId: response.data.badge_id || null,
      };
      setUsers((prev) =>
        prev.map((user) => (user.id === id ? updatedUser : user))
      );
      return updatedUser;
    } catch (error) {
      console.error('Error updating user:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      const detail = error.response?.data?.detail;
      const errorMessage = typeof detail === 'string' ? detail
        : Array.isArray(detail) ? detail.map((d) => d.msg || JSON.stringify(d)).join(', ')
        : detail && typeof detail === 'object' ? JSON.stringify(detail) : (error.message || 'Failed to update user');
      throw new Error(errorMessage);
    }
  };

  const toggleUserStatus = async (id) => {
    try {
      const headers = await getAuthHeaders();
      const response = await axios.post(`${API_BASE_URL}/users/${id}/toggle-status`, {}, { headers });
      const updatedStatus = response.data.is_active ? "active" : "inactive";
      setUsers((prev) =>
        prev.map((user) => {
          if (user.id !== id) return user;
          return {
            ...user,
            status: updatedStatus,
          };
        }),
      );
      return { success: true, status: updatedStatus };
    } catch (error) {
      console.error('Error toggling user status:', error);
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
      const detail = error.response?.data?.detail;
      const errorMessage = typeof detail === 'string' ? detail
        : Array.isArray(detail) ? detail.map((d) => d.msg || JSON.stringify(d)).join(', ')
        : detail && typeof detail === 'object' ? JSON.stringify(detail) : (error.message || 'Failed to toggle user status');
      throw new Error(errorMessage);
    }
  };

  const locationOptions = useMemo(
    () => locationsState.map((loc) => ({ id: loc.id, name: loc.name })),
    [locationsState],
  );

  const subLocationMap = useMemo(() => {
    const map = {};
    locationsState.forEach((loc) => {
      map[loc.id] = loc.subLocations || [];
    });
    return map;
  }, [locationsState]);

  // Unified sub-location view: merge general sub-locations and FG storage areas under each main location
  const subLocationsUnifiedMap = useMemo(() => {
    const map = {};
    // Start with general sub-locations
    locationsState.forEach((loc) => {
      map[loc.id] = (loc.subLocations || []).map((sub) => ({
        ...sub,
        type: "general",
      }));
    });
    // Append finished-goods areas as sub-locations with type 'finished'
    storageAreasState.forEach((area) => {
      const locationId = area.locationId || null;
      if (!locationId) return;
      if (!map[locationId]) map[locationId] = [];
      map[locationId].push({
        id: `fg-${area.id}`,
        name: area.name,
        type: "finished",
        active: area.active,
        allowFloorStorage: area.allowFloorStorage,
        rows: area.rows,
      });
    });
    return map;
  }, [locationsState, storageAreasState]);

  const subLocationUnifiedLookup = useMemo(() => {
    const map = {};
    Object.entries(subLocationsUnifiedMap).forEach(([locationId, subs]) => {
      subs.forEach((sub) => {
        map[sub.id] = { ...sub, locationId };
      });
    });
    return map;
  }, [subLocationsUnifiedMap]);

  const locationLookup = useMemo(() => {
    const map = {};
    locationsState.forEach((loc) => {
      map[loc.id] = { name: loc.name, parentId: null };
      loc.subLocations.forEach((sub) => {
        map[sub.id] = { name: sub.name, parentId: loc.id };
      });
    });
    return map;
  }, [locationsState]);

  const finishedGoodsRows = useMemo(() => {
    const rows = [];
    storageAreasState.forEach((area) => {
      area.rows.forEach((row) => {
        rows.push({
          ...row,
          areaId: area.id,
          areaName: area.name,
          allowFloorStorage: area.allowFloorStorage,
          locationId: area.locationId || null,
        });
      });
    });
    return rows;
  }, [storageAreasState]);

  const finishedGoodsLocations = useMemo(() => {
    const map = {};
    storageAreasState.forEach((area) => {
      const locationId = area.locationId || "unassigned";
      if (!map[locationId]) {
        const location = locationsState.find((loc) => loc.id === locationId);
        map[locationId] = {
          locationId,
          locationName: location?.name || "Unassigned",
          areas: [],
        };
      }
      map[locationId].areas.push({
        id: area.id,
        name: area.name,
        allowFloorStorage: area.allowFloorStorage,
        active: area.active,
        rows: area.rows,
      });
    });
    return Object.values(map);
  }, [storageAreasState, locationsState]);

  const finishedGoodsCapacitySummary = useMemo(() => {
    let totalPalletCapacity = 0;
    let occupiedPallets = 0;
    let heldPallets = 0;

    storageAreasState.forEach((area) => {
      area.rows.forEach((row) => {
        totalPalletCapacity += numberFrom(row.palletCapacity, 0);
        const used = Math.min(
          numberFrom(row.palletCapacity, 0),
          numberFrom(row.occupiedPallets, 0),
        );
        occupiedPallets += used;
        if (row.hold) {
          heldPallets += used;
        }
      });
    });

    const floorStagingPallets = receipts.reduce((sum, receipt) => {
      const pallets = numberFrom(receipt.allocation?.floorAllocation?.pallets, 0);
      return sum + pallets;
    }, 0);

    const utilization = totalPalletCapacity > 0
      ? Math.min(100, (occupiedPallets / totalPalletCapacity) * 100)
      : 0;

    return {
      totalPalletCapacity,
      occupiedPallets,
      availablePallets: Math.max(totalPalletCapacity - occupiedPallets, 0),
      heldPallets,
      utilization,
      floorStagingPallets,
    };
  }, [storageAreasState, receipts]);

  const rawMaterialsCapacitySummary = useMemo(() => {
    let totalPalletCapacity = 0;
    let occupiedPallets = 0;
    let heldPallets = 0;

    // Calculate from all rows in locations/sub-locations (for raw materials and packaging)
    locationsState.forEach((location) => {
      location.subLocations?.forEach((subLoc) => {
        subLoc.rows?.forEach((row) => {
          totalPalletCapacity += numberFrom(row.palletCapacity, 0);
          const used = Math.min(
            numberFrom(row.palletCapacity, 0),
            numberFrom(row.occupiedPallets, 0),
          );
          occupiedPallets += used;
          if (row.hold) {
            heldPallets += used;
          }
        });
      });
    });

    // Calculate floor staging pallets for raw materials
    // Check receipts that are raw materials (category parentId === 'group-raw')
    const floorStagingPallets = receipts.reduce((sum, receipt) => {
      // Check if this is a raw material receipt
      const product = products.find(p => p.id === receipt.productId);
      const category = categories.find(c => c.id === product?.categoryId);
      const isRawMaterial = category?.parentId === 'group-raw';
      
      if (isRawMaterial && receipt.status === 'approved') {
        // Check for floor staging in allocation
        const floorPallets = numberFrom(receipt.allocation?.floorAllocation?.pallets, 0);
        // Also check if receipt has pallets but no row allocation (might be floor staging)
        if (floorPallets === 0 && receipt.pallets && !receipt.storageRowId && !receipt.rawMaterialRowAllocations) {
          // This might be floor staging, but we can't be sure, so we'll only count explicit floor allocations
        }
        return sum + floorPallets;
      }
      return sum;
    }, 0);

    const utilization = totalPalletCapacity > 0
      ? Math.min(100, (occupiedPallets / totalPalletCapacity) * 100)
      : 0;

    return {
      totalPalletCapacity,
      occupiedPallets,
      availablePallets: Math.max(totalPalletCapacity - occupiedPallets, 0),
      heldPallets,
      utilization,
      floorStagingPallets,
    };
  }, [locationsState, receipts, products, categories]);

  const toDateKey = (value) => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  };

  const toDateTime = (value) => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date;
  };

  const buildReceiptReportingRows = (receipts, products, categories, locationLookup) => {
    const productsById = products.reduce((map, product) => {
      map[product.id] = product;
      return map;
    }, {});

    const categoriesById = categories.reduce((map, category) => {
      map[category.id] = category;
      return map;
    }, {});

    return receipts.map((receipt) => {
      const product = productsById[receipt.productId];
      const category = categoriesById[product?.categoryId];

      const locationEntry = receipt.location ? locationLookup[receipt.location] : null;
      const subEntry = receipt.subLocation ? locationLookup[receipt.subLocation] : null;

      const locationName = subEntry
        ? `${locationLookup[subEntry.parentId]?.name || locationEntry?.name || ""}${locationEntry || locationLookup[subEntry.parentId] ? " / " : ""}${subEntry.name}`
        : locationEntry?.name || "";

      return {
        id: receipt.id,
        receiptDate: receipt.receiptDate,
        productionDate: receipt.productionDate || null,
        submittedAt: receipt.submittedAt,
        approvedAt: receipt.approvedAt,
        productId: receipt.productId,
        productName: product?.name || "Unknown product",
        productCode: product?.fcc || product?.sid || "",
        categoryId: product?.categoryId || null,
        categoryName: category?.name || "Unknown category",
        quantity: numberFrom(receipt.quantity, 0),
        quantityUnits: receipt.quantityUnits || "",
        casesPerPallet: numberFrom(receipt.casesPerPallet, 0),
        fullPallets: numberFrom(receipt.fullPallets, 0),
        partialCases: numberFrom(receipt.partialCases, 0),
        floorPallets: numberFrom(receipt.allocation?.floorAllocation?.pallets, 0),
        floorCases: numberFrom(receipt.allocation?.floorAllocation?.cases, 0),
        hold: Boolean(receipt.hold),
        lotNo: receipt.lotNo || "",
        locationId: receipt.location || null,
        subLocationId: receipt.subLocation || null,
        locationName,
        status: receipt.status,
      };
    });
  };

  const buildMovementReportingRows = (
    transfers,
    adjustments,
    holdActions,
    receipts,
    products,
  ) => {
    const receiptsById = receipts.reduce((map, receipt) => {
      map[receipt.id] = receipt;
      return map;
    }, {});

    const productsById = products.reduce((map, product) => {
      map[product.id] = product;
      return map;
    }, {});

    const transferRows = transfers.map((transfer) => {
      const receipt = receiptsById[transfer.receiptId];
      const product = receipt ? productsById[receipt.productId] : null;
      return {
        type: "Transfer",
        id: transfer.id,
        timestamp: transfer.submittedAt,
        status: transfer.status,
        productName: product?.name || "Unknown product",
        productCode: product?.fcc || product?.sid || "",
        quantity: numberFrom(transfer.quantity, 0),
        fromLocation: receipt?.location || null,
        toLocation: transfer.toLocation || null,
        notes: transfer.reason || "",
      };
    });

    const adjustmentRows = adjustments.map((adjustment) => {
      const receipt = receiptsById[adjustment.receiptId];
      const product = receipt ? productsById[receipt.productId] : null;
      return {
        type: "Adjustment",
        id: adjustment.id,
        timestamp: adjustment.submittedAt,
        status: adjustment.status,
        productName: product?.name || "Unknown product",
        productCode: product?.fcc || product?.sid || "",
        quantity: numberFrom(adjustment.updates?.quantity, receipt?.quantity || 0),
        fromLocation: receipt?.location || null,
        toLocation: adjustment.updates?.location || receipt?.location || null,
        notes: adjustment.note || "",
      };
    });

    const holdRows = holdActions.map((action) => {
      const receipt = receiptsById[action.receiptId];
      const product = receipt ? productsById[receipt.productId] : null;
      return {
        type: action.action === "hold" ? "Hold" : "Release",
        id: action.id,
        timestamp: action.submittedAt,
        status: action.status,
        productName: product?.name || "Unknown product",
        productCode: product?.fcc || product?.sid || "",
        quantity: numberFrom(receipt?.quantity, 0),
        fromLocation: receipt?.location || null,
        toLocation: receipt?.location || null,
        notes: action.reason || "",
      };
    });

    return [...transferRows, ...adjustmentRows, ...holdRows];
  };

  const groupByDate = (rows, dateField) => {
    const buckets = {};
    rows.forEach((row) => {
      const key = toDateKey(row[dateField]);
      if (!key) return;
      if (!buckets[key]) {
        buckets[key] = [];
      }
      buckets[key].push(row);
    });
    return buckets;
  };

  const summarizeReceiptsByDate = (rows) => {
    const buckets = groupByDate(rows, "receiptDate");
    const timeline = Object.keys(buckets)
      .sort()
      .map((dateKey) => {
        const rowsForDate = buckets[dateKey];
        const totalCases = rowsForDate.reduce(
          (sum, row) => sum + numberFrom(row.quantity, 0),
          0,
        );
        const floorPallets = rowsForDate.reduce(
          (sum, row) => sum + numberFrom(row.floorPallets, 0),
          0,
        );
        return {
          date: dateKey,
          totalCases,
          floorPallets,
        };
      });
    return timeline;
  };

  const receiptReportingRows = useMemo(
    () =>
      buildReceiptReportingRows(
        receipts,
        products,
        categories,
        locationLookup,
      ),
    [receipts, products, categories, locationLookup],
  );

  const movementReportingRows = useMemo(
    () =>
      buildMovementReportingRows(
        inventoryTransfers,
        inventoryAdjustments,
        inventoryHoldActions,
        receipts,
        products,
      ),
    [inventoryTransfers, inventoryAdjustments, inventoryHoldActions, receipts, products],
  );

  const receiptsTimeline = useMemo(
    () => summarizeReceiptsByDate(receiptReportingRows),
    [receiptReportingRows],
  );

  const financialReportingSummary = useMemo(() => {
    const totals = receiptReportingRows.reduce(
      (acc, row) => {
        const quantity = numberFrom(row.quantity, 0);
        if (!acc[row.categoryName]) {
          acc[row.categoryName] = {
            category: row.categoryName,
            cases: 0,
            lots: 0,
          };
        }
        acc[row.categoryName].cases += quantity;
        acc[row.categoryName].lots += 1;
        return acc;
      },
      {},
    );

    return Object.values(totals).sort((a, b) => b.cases - a.cases);
  }, [receiptReportingRows]);

  const contextValue = useMemo(
    () => ({
      categories,
      categoryGroups: categories.filter(
        (category) => category.type === "group",
      ),
      productCategories: categories.filter(
        (category) => category.type !== "group" && category.active !== false,
      ),
      products,
      receipts,
      // Active receipts for inventory views (filters out depleted/zero-quantity)
      activeReceipts: receipts.filter(rec => rec.status !== 'depleted' && rec.quantity > 0),
      pendingEdits,
      addCategory,
      updateCategory,
      toggleCategoryActive,
      removeCategory,
      addProduct,
      updateProduct,
      toggleProductStatus,
      submitReceipt,
      updateReceiptStatus,
      updateReceipt,
      approveReceipt,
      rejectReceipt,
      sendBackReceipt,
      addUser,
      updateUser,
      toggleUserStatus,
      users,
      vendors: vendorsState,
      addVendor,
      updateVendor,
      toggleVendorActive,
      removeVendor,
      locations: locationOptions,
      locationsTree: locationsState,
      subLocationMap,
      subLocationsUnifiedMap,
      subLocationUnifiedLookup,
      locationLookup,
      storageAreas: storageAreasState,
      finishedGoodsRows,
      finishedGoodsLocations,
      finishedGoodsCapacitySummary,
      rawMaterialsCapacitySummary,
      productionShifts: productionShiftsState,
      productionLines: productionLinesState,
      addProductionShift,
      updateProductionShift,
      toggleProductionShiftActive,
      removeProductionShift,
      addProductionLine,
      updateProductionLine,
      toggleProductionLineActive,
      allocationHistory,
      addLocation: addLocationNode,
      renameLocation: renameLocationNode,
      toggleLocationActive,
      removeLocation: removeLocationNode,
      addSubLocation: addSubLocationNode,
      addSubLocationRow,
      updateSubLocationRow,
      toggleSubLocationRowActive,
      renameSubLocation: renameSubLocationNode,
      toggleSubLocationActive,
      removeSubLocation: removeSubLocationNode,
      addStorageArea,
      updateStorageArea,
      toggleStorageAreaActive,
      removeStorageArea,
      addStorageRow,
      updateStorageRow,
      toggleStorageRowActive,
      removeStorageRow,
      editHistory: pendingEdits,
      setPendingEdits,
      inventoryTransfers,
      submitTransfer,
      updateTransfer,
      approveTransfer,
      rejectTransfer,
      forkliftRequests,
      fetchForkliftRequests,
      approveForkliftRequest,
      rejectForkliftRequest,
      updateForkliftRequest,
      removePalletLicence,
      updatePalletLicence,
      addPalletToForkliftRequest,
      fetchPalletLicences,
      createShipOutPickList,
      fetchTransferScanProgress,
      inventoryHoldActions,
      submitHoldAction,
      updateHoldAction,
      approveHoldAction,
      rejectHoldAction,
      inventoryAdjustments,
      submitAdjustment,
      updateAdjustment,
      approveAdjustment,
      rejectAdjustment,
      receiptReportingRows,
      movementReportingRows,
      receiptsTimeline,
      financialReportingSummary,
      cycleCounts,
      saveCycleCount,
    }),
    [
      categories,
      products,
      receipts,
      users,
      vendorsState,
      locationsState,
      storageAreasState,
      locationOptions,
      subLocationMap,
      locationLookup,
      finishedGoodsRows,
      finishedGoodsLocations,
      finishedGoodsCapacitySummary,
      rawMaterialsCapacitySummary,
      productionShiftsState,
      productionLinesState,
      pendingEdits,
      inventoryTransfers,
      forkliftRequests,
      inventoryHoldActions,
      inventoryAdjustments,
      receiptReportingRows,
      movementReportingRows,
      receiptsTimeline,
      financialReportingSummary,
      cycleCounts,
    ],
  );

  return (
    <AppDataContext.Provider value={contextValue}>
      {children}
    </AppDataContext.Provider>
  );
};

export const useAppData = () => {
  const context = useContext(AppDataContext);
  if (!context) {
    throw new Error("useAppData must be used within an AppDataProvider");
  }
  return context;
};

export default AppDataContext;
