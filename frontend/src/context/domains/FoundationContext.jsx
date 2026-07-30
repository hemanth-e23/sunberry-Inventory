import React, { createContext, useContext, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import apiClient from '../../api/client';
import { useAuth } from '../AuthContext';

// --- Mappers (raw API → app format) ---

const mapCategoryGroup = (grp) => ({
  id: grp.id,
  name: grp.name,
  type: "group",
  active: grp.is_active !== false,
  description: grp.description || '',
});

const mapCategory = (cat, subTypeOverride) => ({
  id: cat.id,
  name: cat.name,
  type: cat.type,
  subType: subTypeOverride ?? (cat.type === "raw" ? "ingredient" : cat.type === "packaging" ? "packaging" : null),
  parentId: cat.parent_id,
  active: cat.is_active !== false,
});

const mapProduct = (prod) => ({
  id: prod.id,
  name: prod.name,
  shortCode: prod.short_code || '',
  categoryId: prod.category_id,
  description: prod.description || '',
  status: prod.is_active ? 'active' : 'inactive',
  sid: prod.sid || '',
  fcc: prod.fcc_code || '',
  vendorId: prod.vendor_id || null,
  defaultCasesPerPallet: prod.default_cases_per_pallet,
  expireYears: prod.expire_years,
  quantityUom: prod.quantity_uom || 'cases',
  active: prod.is_active !== false,
  inventoryTracked: prod.inventory_tracked !== false,
  galPerCase: prod.gal_per_case ?? null,
  packageSizeId: prod.package_size_id ?? null,
  customerName: prod.customer_name || '',
  customerItemNumber: prod.customer_item_number || '',
  customerUpc: prod.customer_upc || '',
});

const mapVendor = (vendor) => ({
  id: vendor.id,
  name: vendor.name,
  active: vendor.is_active !== false,
});

// --- Context ---

const FoundationContext = createContext(null);

export const useFoundationContext = () => {
  const ctx = useContext(FoundationContext);
  if (!ctx) throw new Error('useFoundationContext must be used within a FoundationProvider');
  return ctx;
};

export const FoundationProvider = ({ children }) => {
  const { isAuthenticated, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const enabled = !authLoading && isAuthenticated;

  // ─── Queries ────────────────────────────────────────────────────────────────

  const { data: rawCategoryGroups = [] } = useQuery({
    queryKey: ['category-groups'],
    queryFn: () => apiClient.get('/products/category-groups').then(r => r.data),
    enabled,
    staleTime: 5 * 60 * 1000,
  });

  const { data: rawCategories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ['categories'],
    queryFn: () => apiClient.get('/products/categories').then(r => r.data),
    enabled,
    staleTime: 5 * 60 * 1000,
  });

  const { data: rawProducts = [], isLoading: productsLoading } = useQuery({
    queryKey: ['products'],
    queryFn: async () => {
      const pageSize = 100;
      let skip = 0;
      let total = 1;
      const all = [];
      while (skip < total) {
        const { data } = await apiClient.get('/products/products', { params: { skip, limit: pageSize } });
        total = data.total;
        all.push(...data.items);
        skip += pageSize;
      }
      return all;
    },
    enabled,
    staleTime: 5 * 60 * 1000,
  });

  const { data: rawVendors = [] } = useQuery({
    queryKey: ['vendors'],
    queryFn: () => apiClient.get('/products/vendors').then(r => r.data),
    enabled,
    staleTime: 5 * 60 * 1000,
  });

  const { data: rawPackageSizes = [] } = useQuery({
    queryKey: ['package-sizes'],
    queryFn: () => apiClient.get('/master-data/package-sizes').then(r => r.data),
    enabled,
    staleTime: 5 * 60 * 1000,
  });

  const { data: palletTypes = [] } = useQuery({
    queryKey: ['pallet-types'],
    queryFn: () => apiClient.get('/master-data/pallet-types').then(r => r.data),
    enabled,
    staleTime: 5 * 60 * 1000,
  });

  const { data: shipToLocations = [] } = useQuery({
    queryKey: ['ship-to-locations'],
    queryFn: () => apiClient.get('/master-data/ship-to-locations').then(r => r.data),
    enabled,
    staleTime: 60 * 1000,
  });

  const { data: carriers = [] } = useQuery({
    queryKey: ['carriers'],
    queryFn: () => apiClient.get('/master-data/carriers').then(r => r.data),
    enabled,
    staleTime: 60 * 1000,
  });

  // Create a scheduled ship-out order (Task 2). On success, refresh the
  // self-populating ship-to/carrier lists so new entries appear in type-aheads.
  const createScheduledOrder = async (payload) => {
    const { data } = await apiClient.post('/inventory/ship-out/schedule', payload);
    queryClient.invalidateQueries({ queryKey: ['ship-to-locations'] });
    queryClient.invalidateQueries({ queryKey: ['carriers'] });
    return data;
  };

  // ─── Derived state ──────────────────────────────────────────────────────────

  const categoryGroupsMapped = useMemo(
    () => rawCategoryGroups.map(mapCategoryGroup),
    [rawCategoryGroups]
  );

  const categories = useMemo(
    () => [...categoryGroupsMapped, ...rawCategories.map(c => mapCategory(c))],
    [categoryGroupsMapped, rawCategories]
  );

  const products = useMemo(() => rawProducts.map(mapProduct), [rawProducts]);

  const vendors = useMemo(() => rawVendors.map(mapVendor), [rawVendors]);

  // Package sizes come from the API already snake_cased; expose case_weight as
  // caseWeight for the master-data editor. Ordered by the API (sort_order).
  const packageSizes = useMemo(
    () => rawPackageSizes.map(s => ({
      id: s.id,
      label: s.label,
      caseWeight: s.case_weight ?? null,
      sortOrder: s.sort_order,
      isActive: s.is_active !== false,
    })),
    [rawPackageSizes]
  );

  const updatePackageSize = async (id, updates) => {
    const body = {};
    if (updates.caseWeight !== undefined) body.case_weight = updates.caseWeight != null && updates.caseWeight !== '' ? Number(updates.caseWeight) : null;
    if (updates.label !== undefined) body.label = updates.label;
    if (updates.isActive !== undefined) body.is_active = updates.isActive;
    const { data } = await apiClient.put(`/master-data/package-sizes/${id}`, body);
    queryClient.setQueryData(['package-sizes'], (old = []) => old.map(s => s.id === id ? data : s));
    return data;
  };

  // ─── Category mutations ─────────────────────────────────────────────────────

  const addCategory = async (name, type = "raw", subType = null, parentId = null) => {
    const trimmed = name.trim();
    if (!trimmed) return null;

    let finalParentId = parentId;
    if (!finalParentId || finalParentId === "") {
      // Default to first available active group
      finalParentId = categoryGroupsMapped[0]?.id || null;
    }

    const exists = categories.some(
      cat => cat.name.toLowerCase() === trimmed.toLowerCase() && cat.parentId === finalParentId
    );
    if (exists) return null;

    const response = await apiClient.post('/products/categories', {
      id: `cat-${Date.now()}`,
      name: trimmed,
      type,
      parent_id: finalParentId,
      is_active: true,
    });
    const newCategory = { ...mapCategory(response.data), subType: type === "raw" ? (subType || "ingredient") : null };
    queryClient.setQueryData(['categories'], (old = []) => [...old, response.data]);
    return newCategory;
  };

  const updateCategory = async (id, updates) => {
    const updateData = {
      name: updates.name,
      type: updates.type,
      parent_id: updates.parentId,
      is_active: updates.active !== undefined ? updates.active : true,
    };
    Object.keys(updateData).forEach(key => updateData[key] === undefined && delete updateData[key]);

    const response = await apiClient.put(`/products/categories/${id}`, updateData);
    const updated = { ...mapCategory(response.data), subType: updates.subType || null };
    queryClient.setQueryData(['categories'], (old = []) => old.map(c => c.id === id ? response.data : c));
    return updated;
  };

  const toggleCategoryActive = async (id) => {
    const category = categories.find(cat => cat.id === id);
    if (!category) return;
    const response = await apiClient.put(`/products/categories/${id}`, { is_active: !category.active });
    queryClient.setQueryData(['categories'], (old = []) => old.map(c => c.id === id ? response.data : c));
  };

  const removeCategory = (id) => {
    queryClient.setQueryData(['categories'], (old = []) => (old || []).filter(c => c.id !== id));
  };

  // ─── Product mutations ──────────────────────────────────────────────────────

  const addProduct = async (product) => {
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
      package_size_id: product.packageSizeId || null,
      customer_name: product.customerName?.trim() || null,
      customer_item_number: product.customerItemNumber?.trim() || null,
      customer_upc: product.customerUpc?.trim() || null,
    };

    Object.keys(productData).forEach(key => {
      if (key !== 'id' && key !== 'name' && key !== 'category_id' && key !== 'is_active') {
        if (productData[key] === null || productData[key] === undefined || productData[key] === "") {
          delete productData[key];
        }
      }
    });

    const response = await apiClient.post('/products/products', productData);
    queryClient.setQueryData(['products'], (old = []) => [...old, response.data]);
    return mapProduct(response.data);
  };

  const updateProduct = async (id, updates) => {
    const updateData = {};
    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.shortCode !== undefined) updateData.short_code = (updates.shortCode?.trim()) || null;
    if (updates.categoryId !== undefined) updateData.category_id = updates.categoryId;
    if (updates.description !== undefined) updateData.description = updates.description || null;
    if (updates.sid !== undefined) updateData.sid = updates.sid || null;
    if (updates.fcc !== undefined) updateData.fcc_code = updates.fcc?.trim() || null;
    if (updates.vendorId !== undefined) updateData.vendor_id = updates.vendorId || null;
    if (updates.defaultCasesPerPallet !== undefined) updateData.default_cases_per_pallet = updates.defaultCasesPerPallet ? Number(updates.defaultCasesPerPallet) : null;
    if (updates.expireYears !== undefined) updateData.expire_years = updates.expireYears ? Number(updates.expireYears) : null;
    if (updates.quantityUom !== undefined) updateData.quantity_uom = updates.quantityUom || null;
    if (updates.inventoryTracked !== undefined) updateData.inventory_tracked = updates.inventoryTracked;
    if (updates.galPerCase !== undefined) updateData.gal_per_case = updates.galPerCase != null && updates.galPerCase !== '' ? Number(updates.galPerCase) : null;
    if (updates.packageSizeId !== undefined) updateData.package_size_id = updates.packageSizeId || null;
    if (updates.customerName !== undefined) updateData.customer_name = updates.customerName?.trim() || null;
    if (updates.customerItemNumber !== undefined) updateData.customer_item_number = updates.customerItemNumber?.trim() || null;
    if (updates.customerUpc !== undefined) updateData.customer_upc = updates.customerUpc?.trim() || null;
    if (updates.active !== undefined) updateData.is_active = updates.active;
    else if (updates.status !== undefined) updateData.is_active = updates.status === 'active';

    const response = await apiClient.put(`/products/products/${id}`, updateData);
    queryClient.setQueryData(['products'], (old = []) => old.map(p => p.id === id ? response.data : p));
    return mapProduct(response.data);
  };

  const toggleProductStatus = async (id) => {
    const response = await apiClient.post(`/products/products/${id}/toggle-status`, {});
    queryClient.setQueryData(['products'], (old = []) =>
      old.map(p => p.id === id ? { ...p, is_active: response.data.is_active } : p)
    );
  };

  // ─── Vendor mutations ───────────────────────────────────────────────────────

  const addVendor = async (name) => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const exists = vendors.some(v => v.name.toLowerCase() === trimmed.toLowerCase());
    if (exists) return null;

    const response = await apiClient.post('/products/vendors', { id: `vendor-${Date.now()}`, name: trimmed });
    queryClient.setQueryData(['vendors'], (old = []) => [...old, response.data]);
    return mapVendor(response.data);
  };

  const updateVendor = async (id, name) => {
    const response = await apiClient.put(`/products/vendors/${id}`, { name });
    queryClient.setQueryData(['vendors'], (old = []) => old.map(v => v.id === id ? response.data : v));
  };

  const toggleVendorActive = async (id) => {
    const vendor = vendors.find(v => v.id === id);
    const response = await apiClient.put(`/products/vendors/${id}`, { is_active: !vendor?.active });
    queryClient.setQueryData(['vendors'], (old = []) => old.map(v => v.id === id ? response.data : v));
  };

  const removeVendor = async (id) => {
    await apiClient.put(`/products/vendors/${id}`, { is_active: false });
    queryClient.setQueryData(['vendors'], (old = []) => (old || []).filter(v => v.id !== id));
  };

  // ─── Category group mutations (superadmin only) ──────────────────────────────

  const addCategoryGroup = async (id, name, description = '') => {
    const response = await apiClient.post('/products/category-groups', {
      id, name, description, is_active: true,
    });
    queryClient.setQueryData(['category-groups'], (old = []) => [...old, response.data]);
    return mapCategoryGroup(response.data);
  };

  const updateCategoryGroup = async (id, updates) => {
    const response = await apiClient.put(`/products/category-groups/${id}`, updates);
    queryClient.setQueryData(['category-groups'], (old = []) =>
      old.map(g => g.id === id ? response.data : g)
    );
    return mapCategoryGroup(response.data);
  };

  // ─── Context value ──────────────────────────────────────────────────────────

  const value = {
    categories,
    categoryGroups: categories.filter(cat => cat.type === "group"),
    productCategories: categories.filter(cat => cat.type !== "group" && cat.active !== false),
    categoryGroupsMapped,
    products,
    vendors,
    packageSizes,
    updatePackageSize,
    palletTypes,
    shipToLocations,
    carriers,
    createScheduledOrder,
    productsLoading,
    categoriesLoading,
    addCategory,
    updateCategory,
    toggleCategoryActive,
    removeCategory,
    addCategoryGroup,
    updateCategoryGroup,
    addProduct,
    updateProduct,
    toggleProductStatus,
    addVendor,
    updateVendor,
    toggleVendorActive,
    removeVendor,
  };

  return (
    <FoundationContext.Provider value={value}>
      {children}
    </FoundationContext.Provider>
  );
};
