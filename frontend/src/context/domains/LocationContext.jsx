import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import apiClient from '../../api/client';
import { useAuth } from '../AuthContext';

const LocationContext = createContext(null);

export const useLocationContext = () => {
  const ctx = useContext(LocationContext);
  if (!ctx) throw new Error('useLocationContext must be used within a LocationProvider');
  return ctx;
};

export const LocationProvider = ({ children }) => {
  const { isAuthenticated, loading: authLoading, selectedWarehouse } = useAuth();

  const [locationsState, setLocationsState] = useState([]);
  const [storageAreasState, setStorageAreasState] = useState([]);
  const [productionShiftsState, setProductionShiftsState] = useState([]);
  const [productionLinesState, setProductionLinesState] = useState([]);

  // ---------------------------------------------------------------------------
  // Fetch helpers (also exposed for external refresh)
  // ---------------------------------------------------------------------------

  const fetchLocations = async () => {
    try {
      const locResponse = await apiClient.get('/master-data/locations');
      const subLocResponse = await apiClient.get('/master-data/sub-locations');

      const locations = locResponse.data.map(loc => ({
        id: loc.id,
        name: loc.name,
        active: loc.is_active !== false,
        subLocations: subLocResponse.data
          .filter(sub => sub.location_id === loc.id)
          .map(sub => ({
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
          })),
      }));

      setLocationsState(locations);
    } catch (error) {
      console.error('Error fetching locations:', error);
    }
  };

  const fetchStorageAreas = async () => {
    try {
      const response = await apiClient.get('/master-data/storage-areas');
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

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (authLoading || !isAuthenticated) return;
    fetchLocations();
  }, [authLoading, isAuthenticated, selectedWarehouse]);

  useEffect(() => {
    if (authLoading || !isAuthenticated) return;
    fetchStorageAreas();
  }, [authLoading, isAuthenticated, selectedWarehouse]);

  useEffect(() => {
    if (authLoading || !isAuthenticated) return;

    const fetchProductionShifts = async () => {
      try {
        const response = await apiClient.get('/master-data/production-shifts');
        const shifts = response.data.map(shift => ({
          id: shift.id,
          name: shift.name,
          active: shift.is_active !== false,
          notes: shift.start_time || shift.end_time
            ? `${shift.start_time || ''} - ${shift.end_time || ''}`.trim()
            : '',
        }));
        setProductionShiftsState(shifts);
      } catch (error) {
        console.error('Error fetching production shifts:', error);
      }
    };
    fetchProductionShifts();
  }, [authLoading, isAuthenticated]);

  useEffect(() => {
    if (authLoading || !isAuthenticated) return;

    const fetchProductionLines = async () => {
      try {
        const response = await apiClient.get('/master-data/production-lines');
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

  // ---------------------------------------------------------------------------
  // Derived / computed values
  // ---------------------------------------------------------------------------

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

  const subLocationsUnifiedMap = useMemo(() => {
    const map = {};
    locationsState.forEach((loc) => {
      map[loc.id] = (loc.subLocations || []).map((sub) => ({
        ...sub,
        type: "general",
      }));
    });
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

  // ---------------------------------------------------------------------------
  // Location CRUD
  // ---------------------------------------------------------------------------

  const addLocationNode = async (name) => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const exists = locationsState.some(
      (loc) => loc.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (exists) return null;

    try {
      const locationData = {
        id: `loc-${Date.now()}`,
        name: trimmed,
        description: null,
      };

      const response = await apiClient.post('/master-data/locations', locationData);
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
      throw error;
    }
  };

  const renameLocationNode = async (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;

    try {
      const updateData = { name: trimmed };
      const response = await apiClient.put(`/master-data/locations/${id}`, updateData);

      setLocationsState((prev) =>
        prev.map((location) =>
          location.id === id ? { ...location, name: response.data.name } : location,
        ),
      );
    } catch (error) {
      console.error('Error updating location:', error);
      throw error;
    }
  };

  const toggleLocationActive = async (id) => {
    try {
      const location = locationsState.find(loc => loc.id === id);
      const updateData = { is_active: !location?.active };
      const response = await apiClient.put(`/master-data/locations/${id}`, updateData);

      setLocationsState((prev) =>
        prev.map((loc) =>
          loc.id === id
            ? { ...loc, active: response.data.is_active !== false }
            : loc,
        ),
      );
    } catch (error) {
      console.error('Error toggling location active:', error);
      throw error;
    }
  };

  const removeLocationNode = async (id) => {
    try {
      await apiClient.put(`/master-data/locations/${id}`, { is_active: false });
      setLocationsState((prev) => prev.filter((location) => location.id !== id));
    } catch (error) {
      console.error('Error deleting location:', error);
      throw error;
    }
  };

  // ---------------------------------------------------------------------------
  // Sub-location CRUD
  // ---------------------------------------------------------------------------

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
      const subLocationData = {
        id: `sub-${Date.now()}`,
        name: trimmed,
        location_id: parentId,
      };

      const response = await apiClient.post('/master-data/sub-locations', subLocationData);
      const newSubLocation = {
        id: response.data.id,
        name: response.data.name,
        active: response.data.is_active !== false,
        rows: [],
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
      throw error;
    }
  };

  const renameSubLocationNode = async (parentId, subId, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;

    try {
      const updateData = { name: trimmed };
      const response = await apiClient.put(`/master-data/sub-locations/${subId}`, updateData);

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
      throw error;
    }
  };

  const toggleSubLocationActive = async (parentId, subId) => {
    try {
      const parentLocation = locationsState.find(loc => loc.id === parentId);
      const subLocation = parentLocation?.subLocations.find(sub => sub.id === subId);
      const updateData = { is_active: !subLocation?.active };
      const response = await apiClient.put(`/master-data/sub-locations/${subId}`, updateData);

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
      throw error;
    }
  };

  const removeSubLocationNode = async (parentId, subId) => {
    try {
      await apiClient.put(`/master-data/sub-locations/${subId}`, { is_active: false });
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
      throw error;
    }
  };

  // ---------------------------------------------------------------------------
  // Sub-location row CRUD
  // ---------------------------------------------------------------------------

  const addSubLocationRow = async (parentLocationId, subLocationId, row) => {
    const trimmedName = row.name.trim();
    if (!trimmedName) return null;

    try {
      const rowId = row.id || `sub-row-${Date.now()}`;
      const rowData = {
        id: rowId,
        sub_location_id: subLocationId,
        storage_area_id: null,
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
      const response = await apiClient.post('/master-data/storage-rows', rowData);

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

  const updateSubLocationRow = async (parentLocationId, subLocationId, rowId, updates) => {
    try {
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

      const response = await apiClient.put(`/master-data/storage-rows/${rowId}`, updateData);

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

  const toggleSubLocationRowActive = async (parentLocationId, subLocationId, rowId) => {
    try {
      const location = locationsState.find(loc => loc.id === parentLocationId);
      const subLocation = location?.subLocations.find(sub => sub.id === subLocationId);
      const row = subLocation?.rows?.find(r => r.id === rowId);
      if (!row) return;

      const updateData = { is_active: !row.active };
      const response = await apiClient.put(`/master-data/storage-rows/${rowId}`, updateData);

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

  // ---------------------------------------------------------------------------
  // Storage area CRUD
  // ---------------------------------------------------------------------------

  const addStorageArea = async (name, allowFloorStorage = false, locationId = null) => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const exists = storageAreasState.some(
      (area) => area.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (exists) return null;

    try {
      const areaId = `fg-area-${Date.now()}`;
      const areaData = {
        id: areaId,
        name: trimmed,
        location_id: locationId || null,
        sub_location_id: null,
        allow_floor_storage: allowFloorStorage,
        rows: [],
      };
      const response = await apiClient.post('/master-data/storage-areas', areaData);

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
      const updateData = {};
      if (updates.name !== undefined) updateData.name = updates.name;
      if (updates.locationId !== undefined) updateData.location_id = updates.locationId;
      if (updates.allowFloorStorage !== undefined) updateData.allow_floor_storage = updates.allowFloorStorage;
      if (updates.active !== undefined) updateData.is_active = updates.active;

      const response = await apiClient.put(`/master-data/storage-areas/${id}`, updateData);

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
            ...updates,
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

      const updateData = { is_active: !area.active };
      const response = await apiClient.put(`/master-data/storage-areas/${id}`, updateData);

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
      await apiClient.put(`/master-data/storage-areas/${id}`, { is_active: false });
      setStorageAreasState((prev) => prev.filter((area) => area.id !== id));
    } catch (error) {
      console.error('Error removing storage area:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to remove storage area';
      throw new Error(errorMessage);
    }
  };

  // ---------------------------------------------------------------------------
  // Storage row CRUD
  // ---------------------------------------------------------------------------

  const addStorageRow = async (areaId, row) => {
    const trimmedName = row.name.trim();
    if (!trimmedName) return null;

    try {
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
      const response = await apiClient.post('/master-data/storage-rows', rowData);

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

      const response = await apiClient.put(`/master-data/storage-rows/${rowId}`, updateData);

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
                ...updates,
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

      const updateData = { is_active: !row.active };
      const response = await apiClient.put(`/master-data/storage-rows/${rowId}`, updateData);

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
      await apiClient.put(`/master-data/storage-rows/${rowId}`, { is_active: false });
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

  // ---------------------------------------------------------------------------
  // Production shift CRUD
  // ---------------------------------------------------------------------------

  const addProductionShift = async (name, notes = "") => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const exists = productionShiftsState.some(
      (shift) => shift.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (exists) return null;

    try {
      const shiftId = `shift-${Date.now()}`;
      const shiftData = {
        id: shiftId,
        name: trimmed,
        start_time: null,
        end_time: null,
      };
      const response = await apiClient.post('/master-data/production-shifts', shiftData);

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
      const updateData = {};
      if (updates.name !== undefined) updateData.name = updates.name;
      if (updates.active !== undefined) updateData.is_active = updates.active;

      const response = await apiClient.put(`/master-data/production-shifts/${id}`, updateData);

      setProductionShiftsState((prev) =>
        prev.map((shift) =>
          shift.id === id ? {
            ...shift,
            name: response.data.name,
            active: response.data.is_active !== false,
            ...updates,
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

      const updateData = { is_active: !shift.active };
      const response = await apiClient.put(`/master-data/production-shifts/${id}`, updateData);

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
      await apiClient.put(`/master-data/production-shifts/${id}`, { is_active: false });
      setProductionShiftsState((prev) => prev.filter((shift) => shift.id !== id));
    } catch (error) {
      console.error('Error removing production shift:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to remove production shift';
      throw new Error(errorMessage);
    }
  };

  // ---------------------------------------------------------------------------
  // Production line CRUD
  // ---------------------------------------------------------------------------

  const addProductionLine = async (name, notes = "") => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const exists = productionLinesState.some(
      (line) => line.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (exists) return null;

    try {
      const lineId = `line-${Date.now()}`;
      const lineData = {
        id: lineId,
        name: trimmed,
        description: notes.trim() || null,
      };
      const response = await apiClient.post('/master-data/production-lines', lineData);

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
      const updateData = {};
      if (updates.name !== undefined) updateData.name = updates.name;
      if (updates.active !== undefined) updateData.is_active = updates.active;
      if (updates.notes !== undefined) updateData.description = updates.notes || null;

      const response = await apiClient.put(`/master-data/production-lines/${id}`, updateData);

      setProductionLinesState((prev) =>
        prev.map((line) =>
          line.id === id ? {
            ...line,
            name: response.data.name,
            active: response.data.is_active !== false,
            notes: response.data.description || '',
            ...updates,
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

      const updateData = { is_active: !line.active };
      const response = await apiClient.put(`/master-data/production-lines/${id}`, updateData);

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
      await apiClient.put(`/master-data/production-lines/${id}`, { is_active: false });
      setProductionLinesState((prev) => prev.filter((line) => line.id !== id));
    } catch (error) {
      console.error('Error removing production line:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to remove production line';
      throw new Error(errorMessage);
    }
  };

  // ---------------------------------------------------------------------------
  // Exposed setter for cross-context use
  // ---------------------------------------------------------------------------

  const setStorageAreas = (updaterFn) => {
    setStorageAreasState(updaterFn);
  };

  // ---------------------------------------------------------------------------
  // Context value
  // ---------------------------------------------------------------------------

  const value = {
    // Raw state (for consumers that need the full tree)
    locationsState,
    storageAreasState,
    productionShiftsState,
    productionLinesState,

    // Derived / computed
    locationOptions,
    subLocationMap,
    subLocationsUnifiedMap,
    subLocationUnifiedLookup,
    locationLookup,
    finishedGoodsRows,
    finishedGoodsLocations,

    // Aliases kept for backward compatibility with AppDataContext consumers
    locations: locationOptions,
    locationsTree: locationsState,
    storageAreas: storageAreasState,
    productionShifts: productionShiftsState,
    productionLines: productionLinesState,

    // Refresh functions
    fetchLocations,
    fetchStorageAreas,

    // Cross-context setter
    setStorageAreas,

    // Location CRUD
    addLocation: addLocationNode,
    renameLocation: renameLocationNode,
    toggleLocationActive,
    removeLocation: removeLocationNode,

    // Sub-location CRUD
    addSubLocation: addSubLocationNode,
    renameSubLocation: renameSubLocationNode,
    toggleSubLocationActive,
    removeSubLocation: removeSubLocationNode,

    // Sub-location row CRUD
    addSubLocationRow,
    updateSubLocationRow,
    toggleSubLocationRowActive,

    // Storage area CRUD
    addStorageArea,
    updateStorageArea,
    toggleStorageAreaActive,
    removeStorageArea,

    // Storage row CRUD
    addStorageRow,
    updateStorageRow,
    toggleStorageRowActive,
    removeStorageRow,

    // Production shift CRUD
    addProductionShift,
    updateProductionShift,
    toggleProductionShiftActive,
    removeProductionShift,

    // Production line CRUD
    addProductionLine,
    updateProductionLine,
    toggleProductionLineActive,
    removeProductionLine,
  };

  return (
    <LocationContext.Provider value={value}>
      {children}
    </LocationContext.Provider>
  );
};
