import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useFoundationContext as useFoundation } from './FoundationContext';
import { useLocationContext as useLocation } from './LocationContext';
import { useAuth } from '../AuthContext';
import apiClient from '../../api/client';
import { CATEGORY_TYPES, RECEIPT_STATUS } from '../../constants';
import { getTodayDateKey } from '../../utils/dateUtils';

// ─── Pure helper functions ────────────────────────────────────────────────────

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
    return { success: false, error: 'invalid_cases_per_pallet' };
  }

  const full = Math.max(0, numberFrom(fullPallets, 0));
  const partialCasesValue = Math.max(0, numberFrom(partialCases, 0));

  const totalCases = roundTo(full * casesPerPal + partialCasesValue, 3);
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
    if (targetLocationId && (area.locationId || null) !== targetLocationId) {
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

    const casesAssignable = Math.min(remainingCases, palletsNeeded * casesPerPal);
    if (casesAssignable <= EPSILON) return;

    const area = areaClones[areaIndex];
    const nextRow = { ...area.rows[rowIndex] };

    nextRow.occupiedPallets = roundTo(numberFrom(nextRow.occupiedPallets, 0) + palletsNeeded, 4);
    nextRow.occupiedCases = roundTo(numberFrom(nextRow.occupiedCases, 0) + casesAssignable, 2);
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

    remainingPallets = Math.max(0, roundTo(remainingPallets - palletsNeeded, 4));
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

    const nextPallets = roundTo(numberFrom(row.occupiedPallets, 0) - numberFrom(pallets, 0), 4);
    const nextCases = roundTo(numberFrom(row.occupiedCases, 0) - numberFrom(cases, 0), 2);

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

export const reassignFinishedGood = ({
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
      error: 'invalid_cases_per_pallet',
      message: 'Cases per pallet must be set before reallocating finished goods.',
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
  const residualCases = roundTo(totalCases - fullPallets * Math.max(1, casesPerPalletValue), 2);

  const allocationInput = {
    productId: receipt.productId,
    casesPerPallet: Math.max(1, casesPerPalletValue),
    fullPallets,
    partialCases: residualCases,
    locationId: locationId || null,
  };

  const allocationResult = calculateFinishedGoodsAllocation(baseAreas, allocationInput);

  if (!allocationResult?.success) {
    return {
      success: false,
      error: allocationResult?.error || 'allocation_failed',
      message:
        allocationResult?.errorMessage ||
        'Unable to assign finished goods to racks with the current capacity.',
    };
  }

  const allocationDetails = {
    ...allocationResult,
    request: allocationInput,
    locationName: allocationResult.targetLocationId
      ? locations.find((loc) => loc.id === allocationResult.targetLocationId)?.name || ''
      : '',
  };

  return {
    success: true,
    nextAreas: allocationResult.nextAreas,
    allocationDetails,
    fullPallets,
    partialCases: residualCases,
  };
};

// ─── Receipt mapping ──────────────────────────────────────────────────────────

const mapReceipt = (rec, products) => {
  const product = products.find((p) => p.id === rec.product_id);
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
    receiptDate: rec.receipt_date
      ? new Date(rec.receipt_date).toISOString().split('T')[0]
      : getTodayDateKey(),
    expiryDate: rec.expiration_date
      ? new Date(rec.expiration_date).toISOString().split('T')[0]
      : null,
    expiration: rec.expiration_date
      ? new Date(rec.expiration_date).toISOString().split('T')[0]
      : null,
    productionDate: rec.production_date
      ? new Date(rec.production_date).toISOString().split('T')[0]
      : null,
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
        try {
          return JSON.parse(rec.allocation);
        } catch (e) {
          return null;
        }
      }
      return rec.allocation;
    })(),
  };
};

// ─── Context ──────────────────────────────────────────────────────────────────

const ReceiptContext = createContext(null);

export const useReceipt = () => {
  const ctx = useContext(ReceiptContext);
  if (!ctx) throw new Error('useReceipt must be used within a ReceiptProvider');
  return ctx;
};

export const ReceiptProvider = ({ children }) => {
  const { isAuthenticated, loading: authLoading, selectedWarehouse } = useAuth();
  const { products, categories } = useFoundation();
  const locationCtx = useLocation();
  const fetchLocations = locationCtx?.fetchLocations ?? (() => {});
  const fetchStorageAreas = locationCtx?.fetchStorageAreas ?? (() => {});
  const locationsState = locationCtx?.locationsTree ?? [];

  const [receipts, setReceipts] = useState([]);
  const [pendingEdits, setPendingEdits] = useState([]);
  const [allocationHistory, setAllocationHistory] = useState([]);

  // ─── Fetch receipts ─────────────────────────────────────────────────────────

  const fetchReceipts = useCallback(async () => {
    if (authLoading || !isAuthenticated) return;
    try {
      const response = await apiClient.get('/receipts/', { params: { limit: 10000 } });
      const recs = response.data.map((rec) => mapReceipt(rec, products));
      setReceipts(recs);
    } catch (error) {
      console.error('Error fetching receipts:', error);
    }
  }, [authLoading, isAuthenticated, products]);

  useEffect(() => {
    if (authLoading || !isAuthenticated) return;
    fetchReceipts();
  }, [products, authLoading, isAuthenticated, selectedWarehouse, fetchReceipts]);

  // ─── Helper: validate manual FG placements ──────────────────────────────────

  const validateManualFinishedGoodPlacements = (storageAreas, { manualAllocations = [], floorPallets = 0, casesPerPallet = 0, totalCases = 0 }) => {
    const errors = [];
    const areaMap = new Map();
    storageAreas.forEach((area) => { areaMap.set(area.id, area); });

    manualAllocations.forEach((allocation) => {
      const area = areaMap.get(allocation.areaId);
      if (!area) { errors.push('Storage area not found for placement.'); return; }
      const row = area.rows.find((rowItem) => rowItem.id === allocation.rowId);
      if (!row) { errors.push(`Row not found in area ${area.name}.`); return; }
      const palletsRequested = numberFrom(allocation.pallets, 0);
      if (palletsRequested < 0) { errors.push(`Negative pallet count for ${area.name} / ${row.name}.`); return; }
      const available = Math.max(0, numberFrom(row.palletCapacity, 0) - numberFrom(row.occupiedPallets, 0));
      if (palletsRequested > available + 1e-6) {
        errors.push(`Area ${area.name} / ${row.name} only has ${available} pallets available.`);
      }
    });

    if (casesPerPallet > 0 && totalCases >= 0) {
      const totalAllocatedCases =
        manualAllocations.reduce((sum, allocation) => sum + numberFrom(allocation.cases, 0), 0) +
        numberFrom(floorPallets, 0) * casesPerPallet;
      if (Math.abs(totalAllocatedCases - totalCases) > 0.5) {
        errors.push(`Pallet placements (${totalAllocatedCases} cases) must equal cases produced (${totalCases}).`);
      }
    }

    return errors;
  };

  // ─── submitReceipt ──────────────────────────────────────────────────────────

  const submitReceipt = async (receipt) => {
    const storageAreasState = locationCtx?.storageAreas ?? [];

    const category = categories.find((cat) => cat.id === receipt.categoryId);
    const isRawMaterial = category?.type === 'raw';
    const isFinishedGood = category?.type === CATEGORY_TYPES.FINISHED;
    const isIngredient = isRawMaterial;
    const bolValue = receipt.bol?.toLowerCase().trim();


    if (isFinishedGood) {
      const casesPerPalletValue = numberFrom(receipt.casesPerPallet, 0);
      const fullPalletsValue = numberFrom(receipt.fullPallets, 0);
      const partialCasesValue = numberFrom(receipt.partialCases, 0);
      const totalCases = fullPalletsValue * casesPerPalletValue + partialCasesValue;

      const validationErrors = validateManualFinishedGoodPlacements(storageAreasState, {
        manualAllocations: receipt.manualAllocations || [],
        floorPallets: receipt.floorPallets || 0,
        casesPerPallet: casesPerPalletValue,
        totalCases,
      });

      if (validationErrors.length) {
        return { success: false, error: 'invalid_manual_allocation', message: validationErrors.join(' ') };
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
          areaName: area?.name || '',
          rowName: row?.name || '',
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
        fractionalPallets: roundTo(totalCases / (casesPerPalletValue > 0 ? casesPerPalletValue : 1), 4),
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
    if (isIngredient && (receipt.quantity || receipt.weightUnits) && receipt.quantityUnits) {
      const quantityValue = Number(receipt.quantity);
      const perUnitWeight = Number(receipt.weightUnits);
      if (Number.isFinite(quantityValue) && Number.isFinite(perUnitWeight)) {
        totalWeight = (quantityValue * perUnitWeight).toFixed(2);
      }
    }

    if (isFinishedGood && totalWeight == null) {
      totalWeight = null;
    }

    let locationId = receipt.locationId || receipt.location || null;
    let subLocationId = receipt.subLocationId || receipt.subLocation || null;

    if (isFinishedGood && receipt.manualAllocations && receipt.manualAllocations.length > 0) {
      const firstAllocation = receipt.manualAllocations[0];
      if (firstAllocation.areaId) {
        const area = storageAreasState.find((a) => a.id === firstAllocation.areaId);
        if (area) {
          locationId = area.locationId || locationId || null;
          subLocationId = area.subLocationId || subLocationId || null;
        }
      }
    }

    if (receipt.location && !isFinishedGood) locationId = receipt.location;
    if (receipt.subLocation && !isFinishedGood) subLocationId = receipt.subLocation;

    if (!subLocationId && (receipt.storageRowId || receipt.rawMaterialRowAllocations)) {
      const rowId = receipt.storageRowId || receipt.rawMaterialRowAllocations?.[0]?.rowId;
      if (rowId) {
        for (const loc of locationsState) {
          for (const sub of loc.subLocations || []) {
            const matchRow = (sub.rows || []).find((r) => r.id === rowId);
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

    const receiptData = {
      id: newReceiptId,
      product_id: receipt.productId,
      category_id: receipt.categoryId || null,
      quantity: Number(receipt.quantity) || 0,
      unit: receipt.quantityUnits || 'cases',
      container_count: receipt.containerCount || null,
      container_unit: receipt.containerUnit || null,
      weight_per_container: receipt.weightPerContainer || null,
      weight_unit: receipt.weightUnit || null,
      lot_number: receipt.lotNo || null,
      receipt_date: receipt.receiptDate ? new Date(receipt.receiptDate).toISOString() : new Date().toISOString(),
      expiration_date: (receipt.expiryDate || receipt.expiration)
        ? new Date(receipt.expiryDate || receipt.expiration).toISOString()
        : null,
      production_date: receipt.productionDate ? new Date(receipt.productionDate).toISOString() : null,
      vendor_id: receipt.vendorId || null,
      location_id: locationId,
      sub_location_id: subLocationId,
      storage_row_id: receipt.storageRowId || null,
      pallets: receipt.pallets ? Number(receipt.pallets) : null,
      raw_material_row_allocations: receipt.rawMaterialRowAllocations || null,
      cases_per_pallet: receipt.casesPerPallet ? Number(receipt.casesPerPallet) : null,
      full_pallets: receipt.fullPallets ? Number(receipt.fullPallets) : null,
      partial_cases: receipt.partialCases ? Number(receipt.partialCases) : 0,
      bol: receipt.bol || null,
      purchase_order: receipt.purchaseOrder || null,
      hold: receipt.hold || false,
      shift_id: receipt.shift || null,
      line_id: receipt.lineNumber || null,
      note: receipt.note || '',
      allocations: (receipt.manualAllocations || pendingAllocation?.plan || []).map((alloc) => ({
        storage_area_id: alloc.areaId,
        pallet_quantity: Number(alloc.pallets) || 0,
        cases_quantity: Number(alloc.cases) || 0,
      })),
      allocation: pendingAllocation
        ? {
            success: true,
            plan: pendingAllocation.plan || [],
            floorAllocation: pendingAllocation.floorAllocation || null,
            totalCases: pendingAllocation.totalCases || 0,
            totalPallets: pendingAllocation.totalPallets || 0,
          }
        : null,
    };

    Object.keys(receiptData).forEach((key) => {
      if (
        key !== 'id' &&
        key !== 'product_id' &&
        key !== 'quantity' &&
        key !== 'unit' &&
        key !== 'allocations' &&
        key !== 'receipt_date' &&
        key !== 'allocation'
      ) {
        if (receiptData[key] === null || receiptData[key] === undefined || receiptData[key] === '') {
          delete receiptData[key];
        }
      }
    });

    if (receiptData.lot_number === '' || receiptData.lot_number === null) {
      delete receiptData.lot_number;
    }

    try {
      const response = await apiClient.post('/receipts/', receiptData);

      const product = products.find((p) => p.id === response.data.product_id);
      const baseReceipt = {
        id: response.data.id,
        status: response.data.status || 'recorded',
        submittedAt: response.data.submitted_at || new Date().toISOString(),
        submittedBy: response.data.submitted_by || 'warehouse-user',
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
        receiptDate: response.data.receipt_date
          ? new Date(response.data.receipt_date).toISOString().split('T')[0]
          : getTodayDateKey(),
        expiryDate: response.data.expiration_date
          ? new Date(response.data.expiration_date).toISOString().split('T')[0]
          : null,
        expiration: response.data.expiration_date
          ? new Date(response.data.expiration_date).toISOString().split('T')[0]
          : null,
        productionDate: response.data.production_date
          ? new Date(response.data.production_date).toISOString().split('T')[0]
          : null,
        vendorId: response.data.vendor_id || null,
        locationId: response.data.location_id || locationId || receipt.locationId || receipt.location || null,
        location: response.data.location_id || locationId || receipt.locationId || receipt.location || null,
        subLocationId: response.data.sub_location_id || subLocationId || receipt.subLocationId || receipt.subLocation || null,
        subLocation: response.data.sub_location_id || subLocationId || receipt.subLocationId || receipt.subLocation || null,
        storageRowId: response.data.storage_row_id || receipt.storageRowId || null,
        pallets: response.data.pallets || receipt.pallets || null,
        rawMaterialRowAllocations: response.data.raw_material_row_allocations || receipt.rawMaterialRowAllocations || null,
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
        sid: product?.sid || receipt.sid || '',
      };

      const allocationData =
        response.data.allocation ||
        (pendingAllocation
          ? {
              success: true,
              plan: pendingAllocation.plan || [],
              floorAllocation: pendingAllocation.floorAllocation || null,
              totalCases: pendingAllocation.totalCases || 0,
              totalPallets: pendingAllocation.totalPallets || 0,
            }
          : null);

      const newReceipt = {
        ...baseReceipt,
        allocation: allocationData,
        ...(pendingAllocation ? { pendingAllocation } : {}),
      };

      setReceipts((prev) => [...prev, newReceipt]);

      if (receipt.storageRowId || receipt.rawMaterialRowAllocations || (isFinishedGood && pendingAllocation)) {
        if (receipt.storageRowId || receipt.rawMaterialRowAllocations) {
          fetchLocations();
        }
        if (isFinishedGood && pendingAllocation) {
          fetchStorageAreas();
        }
      }

      return { success: true, receipt: newReceipt };
    } catch (error) {
      console.error('Error submitting receipt:', error);

      if (!error.response) {
        if (
          error.code === 'ECONNREFUSED' ||
          error.message?.includes('Network Error') ||
          error.message?.includes('Failed to fetch')
        ) {
          return {
            success: false,
            error: 'network_error',
            message: 'Cannot connect to server. Please check if the backend is running.',
          };
        }
        return {
          success: false,
          error: 'network_error',
          message: error.message || 'Network error. Please check your connection and try again.',
        };
      }

      const errorMessage = error.response?.data?.detail || error.message || 'Failed to submit receipt';
      return { success: false, error: 'api_error', message: errorMessage };
    }
  };

  // ─── updateReceiptStatus ────────────────────────────────────────────────────

  const updateReceiptStatus = (id, status, approverId) => {
    setReceipts((prev) =>
      prev.map((receipt) => {
        if (receipt.id !== id) return receipt;
        return {
          ...receipt,
          status,
          approvedBy: approverId || receipt.approvedBy,
          approvedAt: status === RECEIPT_STATUS.APPROVED ? new Date().toISOString() : receipt.approvedAt,
        };
      }),
    );
  };

  // ─── updateReceipt ──────────────────────────────────────────────────────────

  const updateReceipt = async (id, updates) => {
    try {
      const updateData = {};
      if (updates.lotNo !== undefined) updateData.lot_number = updates.lotNo;
      if (updates.quantity !== undefined) updateData.quantity = Number(updates.quantity);
      if (updates.productionDate !== undefined)
        updateData.production_date = updates.productionDate
          ? new Date(updates.productionDate).toISOString()
          : null;
      if (updates.expiryDate !== undefined || updates.expiration !== undefined) {
        updateData.expiration_date =
          updates.expiryDate || updates.expiration
            ? new Date(updates.expiryDate || updates.expiration).toISOString()
            : null;
      }
      if (updates.casesPerPallet !== undefined)
        updateData.cases_per_pallet = updates.casesPerPallet ? Number(updates.casesPerPallet) : null;
      if (updates.fullPallets !== undefined)
        updateData.full_pallets = updates.fullPallets ? Number(updates.fullPallets) : null;
      if (updates.partialCases !== undefined)
        updateData.partial_cases = Number(updates.partialCases) || 0;
      if (updates.shift !== undefined) updateData.shift_id = updates.shift || null;
      if (updates.lineNumber !== undefined) updateData.line_id = updates.lineNumber || null;
      if (updates.bol !== undefined) updateData.bol = updates.bol || null;
      if (updates.purchaseOrder !== undefined) updateData.purchase_order = updates.purchaseOrder || null;
      if (updates.vendorId !== undefined) updateData.vendor_id = updates.vendorId || null;
      if (updates.note !== undefined) updateData.note = updates.note || null;
      if (updates.status !== undefined) updateData.status = updates.status;

      Object.keys(updates).forEach((key) => {
        if (
          ![
            'lotNo', 'quantity', 'productionDate', 'expiryDate', 'expiration',
            'casesPerPallet', 'fullPallets', 'partialCases', 'shift', 'lineNumber',
            'bol', 'purchaseOrder', 'vendorId', 'note', 'status',
          ].includes(key)
        ) {
          if (key === 'sid' || key === 'fccCode') return;
          updateData[key] = updates[key];
        }
      });

      const response = await apiClient.put(`/receipts/${id}`, updateData);

      setReceipts((prev) =>
        prev.map((receipt) => {
          if (receipt.id !== id) return receipt;
          return {
            ...receipt,
            ...updates,
            status: response.data.status || receipt.status,
            approvedBy: response.data.approved_by || receipt.approvedBy,
            approvedAt: response.data.approved_at
              ? new Date(response.data.approved_at).toISOString()
              : receipt.approvedAt,
          };
        }),
      );

      return { success: true };
    } catch (error) {
      console.error('Error updating receipt:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to update receipt';
      return { success: false, error: 'api_error', message: errorMessage };
    }
  };

  // ─── approveReceipt ─────────────────────────────────────────────────────────

  const approveReceipt = async (id, approverId = 'admin-user') => {
    try {
      const response = await apiClient.post(`/receipts/${id}/approve`, {});

      const receipt = receipts.find((r) => r.id === id);
      const hasRowAllocation =
        receipt?.storageRowId ||
        receipt?.rawMaterialRowAllocations ||
        (receipt?.allocation &&
          receipt?.categoryId &&
          categories.find((c) => c.id === receipt.categoryId)?.type === CATEGORY_TYPES.FINISHED);

      setReceipts((prev) =>
        prev.map((r) => {
          if (r.id !== id) return r;
          return {
            ...r,
            status: 'approved',
            approvedBy: response.data.receipt?.approved_by || approverId,
            approvedAt: response.data.receipt?.approved_at
              ? new Date(response.data.receipt.approved_at).toISOString()
              : new Date().toISOString(),
          };
        }),
      );

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
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to approve receipt';
      return { success: false, error: 'api_error', message: errorMessage };
    }
  };

  // ─── rejectReceipt ──────────────────────────────────────────────────────────

  const rejectReceipt = async (id, reason, _approverId = 'admin-user') => {
    try {
      const response = await apiClient.post(`/receipts/${id}/reject`, null, {
        params: { reason: reason || 'No reason provided' },
      });

      const receipt = receipts.find((r) => r.id === id);
      const hasRowAllocation =
        receipt?.storageRowId ||
        receipt?.rawMaterialRowAllocations ||
        (receipt?.allocation &&
          receipt?.categoryId &&
          categories.find((c) => c.id === receipt.categoryId)?.type === CATEGORY_TYPES.FINISHED);

      setReceipts((prev) =>
        prev.map((r) => {
          if (r.id !== id) return r;
          return {
            ...r,
            status: 'rejected',
            note: response.data.receipt?.note || r.note,
          };
        }),
      );

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
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to reject receipt';
      return { success: false, error: 'api_error', message: errorMessage };
    }
  };

  // ─── sendBackReceipt ────────────────────────────────────────────────────────

  const sendBackReceipt = async (id, reason, _approverId = 'admin-user') => {
    try {
      const response = await apiClient.post(`/receipts/${id}/send-back`, null, {
        params: { reason: reason || 'No reason provided' },
      });

      const receipt = receipts.find((r) => r.id === id);
      const hasRowAllocation =
        receipt?.storageRowId ||
        receipt?.rawMaterialRowAllocations ||
        (receipt?.allocation &&
          receipt?.categoryId &&
          categories.find((c) => c.id === receipt.categoryId)?.type === CATEGORY_TYPES.FINISHED);

      const updatedStatus = response.data.receipt?.status || 'sent-back';
      setReceipts((prev) =>
        prev.map((r) => {
          if (r.id !== id) return r;
          return {
            ...r,
            status: updatedStatus,
            note: response.data.receipt?.note || r.note,
          };
        }),
      );

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
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to send back receipt';
      return { success: false, error: 'api_error', message: errorMessage };
    }
  };

  // ─── Context value ──────────────────────────────────────────────────────────

  const value = {
    receipts,
    activeReceipts: receipts.filter((rec) => rec.status !== RECEIPT_STATUS.DEPLETED && rec.quantity > 0),
    pendingEdits,
    setPendingEdits,
    editHistory: pendingEdits,
    allocationHistory,
    setAllocationHistory,
    setReceipts,
    refreshReceipts: fetchReceipts,
    submitReceipt,
    updateReceiptStatus,
    updateReceipt,
    approveReceipt,
    rejectReceipt,
    sendBackReceipt,
  };

  return <ReceiptContext.Provider value={value}>{children}</ReceiptContext.Provider>;
};

export default ReceiptContext;
