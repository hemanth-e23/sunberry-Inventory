import { createContext, useContext, useState, useEffect } from 'react';
import { useFoundationContext as useFoundation } from './FoundationContext';
import { useLocationContext as useLocation } from './LocationContext';
import { useReceipt } from './ReceiptContext';
import { useAuth } from '../AuthContext';
import apiClient from '../../api/client';
import { CATEGORY_TYPES, RECEIPT_STATUS } from '../../constants';
import { getTodayDateKey } from '../../utils/dateUtils';

// ─── Pure helper functions (duplicated from ReceiptContext for independence) ──

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
  if (!plan.length) return base;

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

const reassignFinishedGood = ({ receipt, quantityCases, locationId, storageAreas, locations }) => {
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

// ─── Local receipt mapper (mirrors ReceiptContext.mapReceipt) ─────────────────

const mapReceiptFromApi = (rec, products) => ({
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
  sid: products.find((p) => p.id === rec.product_id)?.sid || '',
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
});

// ─── Context ──────────────────────────────────────────────────────────────────

const InventoryContext = createContext(null);

export const useInventory = () => {
  const ctx = useContext(InventoryContext);
  if (!ctx) throw new Error('useInventory must be used within an InventoryProvider');
  return ctx;
};

export const InventoryProvider = ({ children }) => {
  const { isAuthenticated, loading: authLoading, selectedWarehouse } = useAuth();
  const { products, categories } = useFoundation();
  const locationCtx = useLocation();
  const storageAreasState = locationCtx?.storageAreas ?? [];
  const locationsState = locationCtx?.locationsTree ?? [];
  const setStorageAreas = locationCtx?.setStorageAreas ?? (() => {});
  const { receipts, setReceipts } = useReceipt();

  const [inventoryTransfers, setInventoryTransfers] = useState([]);
  const [inventoryHoldActions, setInventoryHoldActions] = useState([]);
  const [inventoryAdjustments, setInventoryAdjustments] = useState([]);
  const [cycleCounts, setCycleCounts] = useState([]);
  const [forkliftRequests, setForkliftRequests] = useState([]);

  // ─── Fetch inventory actions (transfers, holds, adjustments) ────────────────

  useEffect(() => {
    if (authLoading || !isAuthenticated) return;

    const fetchInventoryActions = async () => {
      // Each fetch is independent — a failure in one must not block the others
      await Promise.allSettled([
        apiClient.get('/inventory/hold-actions').then((holdsResponse) => {
          const holds = holdsResponse.data.map((hold) => ({
            id: hold.id,
            receiptId: hold.receipt_id,
            action: hold.action,
            reason: hold.reason,
            status: hold.status,
            submittedAt: hold.submitted_at,
            submittedBy: hold.submitted_by,
            approvedBy: hold.approved_by,
            approvedAt: hold.approved_at,
            totalQuantity: hold.total_quantity,
            holdItems: hold.hold_items || [],
            palletLicenceIds: hold.pallet_licence_ids || [],
            palletLicenceDetails: hold.pallet_licence_details || [],
            editHistory: [],
          }));
          setInventoryHoldActions(holds);
        }).catch((error) => console.error('Error fetching hold actions:', error)),

        apiClient.get('/inventory/transfers').then((transfersResponse) => {
          const transfers = transfersResponse.data.map((t) => ({
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
            editHistory: [],
          }));
          setInventoryTransfers(transfers);
        }).catch((error) => console.error('Error fetching transfers:', error)),

        apiClient.get('/inventory/adjustments').then((adjustmentsResponse) => {
          const adjustments = adjustmentsResponse.data.map((adj) => ({
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
            editHistory: [],
          }));
          setInventoryAdjustments(adjustments);
        }).catch((error) => console.error('Error fetching adjustments:', error)),
      ]);
    };
    fetchInventoryActions();
  }, [authLoading, isAuthenticated, selectedWarehouse]);

  // ─── Fetch cycle counts ─────────────────────────────────────────────────────

  useEffect(() => {
    if (authLoading || !isAuthenticated) return;

    const fetchCycleCounts = async () => {
      try {
        const response = await apiClient.get('/inventory/cycle-counts');
        const counts = response.data.map((count) => ({
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
  }, [authLoading, isAuthenticated, selectedWarehouse]);

  // ─── Fetch forklift requests ────────────────────────────────────────────────

  useEffect(() => {
    if (authLoading || !isAuthenticated) return;

    const doFetchForkliftRequests = async () => {
      try {
        const response = await apiClient.get('/scanner/requests');
        setForkliftRequests(response.data || []);
      } catch (error) {
        console.error('Error fetching forklift requests:', error);
      }
    };
    doFetchForkliftRequests();
  }, [authLoading, isAuthenticated, selectedWarehouse]);

  // ─── submitTransfer ─────────────────────────────────────────────────────────

  const submitTransfer = async (transfer) => {
    try {
      const quantityValue = Number(transfer.quantity);
      if (!Number.isFinite(quantityValue) || quantityValue <= 0) {
        return {
          success: false,
          error: 'invalid_quantity',
          message: 'Quantity must be greater than zero to move inventory.',
        };
      }

      const receipt = receipts.find((item) => item.id === transfer.receiptId);
      if (!receipt) {
        return {
          success: false,
          error: 'receipt_not_found',
          message: 'Selected receipt could not be found.',
        };
      }

      const currentQuantity = numberFrom(receipt.quantity, 0);
      if (quantityValue > currentQuantity + EPSILON) {
        return {
          success: false,
          error: 'quantity_exceeds_available',
          message: 'You cannot move more than the available quantity on the lot.',
        };
      }

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

      const response = await apiClient.post('/inventory/transfers', payload);

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
        transfer: newTransfer,
      };
    } catch (error) {
      console.error('Error submitting transfer:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to submit transfer';
      return { success: false, error: errorMessage, message: errorMessage };
    }
  };

  // ─── updateTransfer ─────────────────────────────────────────────────────────

  const updateTransfer = (id, updates) => {
    setInventoryTransfers((prev) =>
      prev.map((transfer) => (transfer.id === id ? { ...transfer, ...updates } : transfer)),
    );
  };

  // ─── updateTransferStatus (internal) ────────────────────────────────────────

  const updateTransferStatus = (id, status, approverId) => {
    setInventoryTransfers((prev) => {
      const target = prev.find((transfer) => transfer.id === id);
      if (!target) return prev;

      if (status !== RECEIPT_STATUS.APPROVED) {
        return prev.map((transfer) =>
          transfer.id === id
            ? {
                ...transfer,
                status,
                approvedBy: approverId || transfer.approvedBy,
                approvedAt: status === RECEIPT_STATUS.APPROVED ? new Date().toISOString() : transfer.approvedAt,
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
      const isFinishedGood = category?.type === CATEGORY_TYPES.FINISHED;
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
                  status: 'recorded',
                  approvedBy: approverId || transfer.approvedBy,
                  approvedAt: null,
                  rejectionReason:
                    reassignment.message ||
                    'Unable to reallocate finished goods capacity for this transfer.',
                }
              : transfer,
          );
        }

        nextAreas = reassignment.nextAreas;
        allocationDetails = reassignment.allocationDetails;
        fullPallets = reassignment.fullPallets;
        partialCases = reassignment.partialCases;
      }

      setReceipts((current) =>
        current.map((item) => {
          if (item.id !== receipt.id) return item;
          const updatedHistory = [
            ...item.editHistory,
            {
              id: `edit-${Date.now()}`,
              type: 'transfer',
              timestamp: new Date().toISOString(),
              updaterId: approverId || target.approvedBy || 'system',
              details: {
                transferType: target.transferType || 'warehouse-transfer',
                orderNumber: target.orderNumber || null,
                toLocation: target.toLocation,
                toSubLocation: target.toSubLocation,
                quantity: target.quantity,
                reason: target.reason || '',
              },
            },
          ];

          const isShippedOut = target.transferType === 'shipped-out';
          const newQuantity = isShippedOut
            ? Math.max(0, item.quantity - target.quantity)
            : target.quantity;

          return {
            ...item,
            quantity: newQuantity,
            location: isShippedOut ? item.location : target.toLocation || item.location,
            subLocation: isShippedOut ? item.subLocation : target.toSubLocation || item.subLocation,
            editHistory: updatedHistory,
            allocation: allocationDetails,
            fullPallets,
            partialCases,
          };
        }),
      );

      if (nextAreas !== storageAreasState) {
        setStorageAreas(nextAreas);
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

  // ─── approveTransfer ────────────────────────────────────────────────────────

  const approveTransfer = async (id, approverId = 'admin-user') => {
    try {
      await apiClient.post(`/inventory/transfers/${id}/approve`, {});

      updateTransferStatus(id, 'approved', approverId);

      const receiptsResponse = await apiClient.get('/receipts/', { params: { limit: 10000 } });
      const recs = receiptsResponse.data.map((rec) => mapReceiptFromApi(rec, products));
      setReceipts(recs);

      return { success: true };
    } catch (error) {
      console.error('Error approving transfer:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to approve transfer';
      return { success: false, error: errorMessage };
    }
  };

  // ─── rejectTransfer ─────────────────────────────────────────────────────────

  const rejectTransfer = async (id, reason = '', approverId = 'admin-user') => {
    try {
      await apiClient.post(
        `/inventory/transfers/${id}/reject?reason=${encodeURIComponent(reason)}`,
        {},
      );

      updateTransferStatus(id, 'rejected', approverId);

      return { success: true };
    } catch (error) {
      console.error('Error rejecting transfer:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to reject transfer';
      return { success: false, error: errorMessage };
    }
  };

  // ─── submitHoldAction ───────────────────────────────────────────────────────

  const submitHoldAction = async (action) => {
    try {
      const payload = {
        action: action.action,
        reason: action.reason,
      };

      if (action.palletLicenceIds && action.palletLicenceIds.length > 0) {
        payload.pallet_licence_ids = action.palletLicenceIds;
      } else if (action.holdItems && action.holdItems.length > 0) {
        payload.hold_items = action.holdItems.map((item) => ({
          receipt_id: item.receiptId,
          location_id: item.locationId,
          quantity: item.quantity,
        }));
        payload.total_quantity = action.totalQuantity;
      }

      if (action.receiptId) {
        payload.receipt_id = action.receiptId;
      }

      const response = await apiClient.post('/inventory/hold-actions', payload);

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
        totalQuantity: response.data.total_quantity,
        holdItems: response.data.hold_items || [],
        palletLicenceIds: response.data.pallet_licence_ids || [],
        palletLicenceDetails: response.data.pallet_licence_details || [],
        editHistory: [],
      };

      setInventoryHoldActions((prev) => [...prev, newAction]);
      return { success: true, action: newAction };
    } catch (error) {
      console.error('Error submitting hold action:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to submit hold action';
      return { success: false, error: errorMessage };
    }
  };

  // ─── updateHoldAction ───────────────────────────────────────────────────────

  const updateHoldAction = (id, updates) => {
    setInventoryHoldActions((prev) =>
      prev.map((action) => (action.id === id ? { ...action, ...updates } : action)),
    );
  };

  // ─── updateHoldStatus (internal) ────────────────────────────────────────────

  const updateHoldStatus = (id, status, approverId) => {
    setInventoryHoldActions((prev) => {
      const target = prev.find((action) => action.id === id);
      if (status === RECEIPT_STATUS.APPROVED && target?.receiptId) {
        setReceipts((current) =>
          current.map((receipt) => {
            if (receipt.id !== target.receiptId) return receipt;
            return { ...receipt, hold: target.action === 'hold' };
          }),
        );
      }
      return prev.map((action) => {
        if (action.id !== id) return action;
        return {
          ...action,
          status,
          approvedBy: approverId || action.approvedBy,
          approvedAt: status === RECEIPT_STATUS.APPROVED ? new Date().toISOString() : action.approvedAt,
        };
      });
    });
  };

  // ─── approveHoldAction ──────────────────────────────────────────────────────

  const approveHoldAction = async (id, approverId = 'admin-user') => {
    try {
      await apiClient.post(`/inventory/hold-actions/${id}/approve`, {});

      setInventoryHoldActions((prev) =>
        prev.map((hold) =>
          hold.id === id
            ? { ...hold, status: 'approved', approvedBy: approverId, approvedAt: new Date().toISOString() }
            : hold,
        ),
      );

      const targetHold = inventoryHoldActions.find((h) => h.id === id);
      if (targetHold?.palletLicenceIds?.length > 0) {
        // Pallet hold: receipt_id is null on the hold action; refetch all receipts so
        // held_quantity and hold flag reflect the updated pallet is_held values.
        const receiptsResponse = await apiClient.get('/receipts/', { params: { limit: 10000 } });
        const recs = receiptsResponse.data.map((rec) => mapReceiptFromApi(rec, products));
        setReceipts(recs);
      } else if (targetHold) {
        setReceipts((current) =>
          current.map((receipt) => {
            if (receipt.id !== targetHold.receiptId) return receipt;
            return { ...receipt, hold: targetHold.action === 'hold' };
          }),
        );
      }
    } catch (error) {
      console.error('Error approving hold action:', error);
    }
  };

  // ─── rejectHoldAction ───────────────────────────────────────────────────────

  const rejectHoldAction = async (id, approverId = 'admin-user') => {
    try {
      await apiClient.post(`/inventory/hold-actions/${id}/reject`, {});

      setInventoryHoldActions((prev) =>
        prev.map((hold) =>
          hold.id === id
            ? { ...hold, status: 'rejected', approvedBy: approverId, approvedAt: new Date().toISOString() }
            : hold,
        ),
      );
    } catch (error) {
      console.error('Error rejecting hold action:', error);
    }
  };

  // ─── submitAdjustment ───────────────────────────────────────────────────────

  const submitAdjustment = async (adjustment) => {
    try {
      const payload = {
        product_id: adjustment.productId || null,
        category_id: adjustment.categoryId || null,
        adjustment_type: adjustment.adjustmentType,
        reason: adjustment.reason,
        recipient: adjustment.recipient || null,
      };
      if (adjustment.palletLicenceIds?.length > 0) {
        payload.pallet_licence_ids = adjustment.palletLicenceIds;
      } else {
        payload.receipt_id = adjustment.receiptId;
        payload.quantity = adjustment.quantity;
      }

      const response = await apiClient.post('/inventory/adjustments', payload);

      const newAdjustment = {
        id: response.data.id,
        receiptId: response.data.receipt_id,
        productId: response.data.product_id,
        categoryId: response.data.category_id,
        adjustmentType: response.data.adjustment_type,
        quantity: response.data.quantity,
        reason: response.data.reason,
        recipient: response.data.recipient,
        palletLicenceIds: response.data.pallet_licence_ids || [],
        status: response.data.status || 'pending',
        submittedAt: response.data.submitted_at,
        submittedBy: response.data.submitted_by,
        approvedBy: response.data.approved_by || null,
        approvedAt: response.data.approved_at || null,
        editHistory: [],
      };

      setInventoryAdjustments((prev) => [newAdjustment, ...prev]);
      return {
        success: true,
        message: 'Adjustment request submitted successfully.',
        adjustment: newAdjustment,
      };
    } catch (error) {
      console.error('Error submitting adjustment:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to submit adjustment';
      return { success: false, error: errorMessage };
    }
  };

  // ─── updateAdjustment ───────────────────────────────────────────────────────

  const updateAdjustment = (id, updates) => {
    setInventoryAdjustments((prev) =>
      prev.map((adjustment) => (adjustment.id === id ? { ...adjustment, ...updates } : adjustment)),
    );
  };

  // ─── updateAdjustmentStatus (internal) ──────────────────────────────────────

  const updateAdjustmentStatus = (id, status, approverId) => {
    setInventoryAdjustments((prev) => {
      const target = prev.find((adjustment) => adjustment.id === id);
      if (status === RECEIPT_STATUS.APPROVED && target?.receiptId && target?.adjustmentType) {
        setReceipts((current) =>
          current.map((receipt) => {
            if (receipt.id !== target.receiptId) return receipt;

            let newQuantity = receipt.quantity;
            if (target.adjustmentType === 'stock-correction') {
              newQuantity = Math.max(0, receipt.quantity - target.quantity);
            } else if (
              ['damage-reduction', 'donation', 'trash-disposal', 'quality-rejection', 'shipped-out'].includes(
                target.adjustmentType,
              )
            ) {
              newQuantity = Math.max(0, receipt.quantity - target.quantity);
            }

            return {
              ...receipt,
              quantity: newQuantity,
              editHistory: [
                ...receipt.editHistory,
                {
                  id: `edit-${Date.now()}`,
                  type: 'adjustment',
                  timestamp: new Date().toISOString(),
                  updaterId: approverId || 'admin-user',
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
          approvedAt: status === RECEIPT_STATUS.APPROVED ? new Date().toISOString() : adjustment.approvedAt,
        };
      });
    });
  };

  // ─── approveAdjustment ──────────────────────────────────────────────────────

  const approveAdjustment = async (id, approverId = 'admin-user') => {
    try {
      const adjustment = inventoryAdjustments.find((adj) => adj.id === id);

      await apiClient.post(`/inventory/adjustments/${id}/approve`, {});

      setInventoryAdjustments((prev) =>
        prev.map((adj) =>
          adj.id === id
            ? { ...adj, status: 'approved', approvedBy: approverId, approvedAt: new Date().toISOString() }
            : adj,
        ),
      );

      if (adjustment && adjustment.receiptId) {
        const deductTypes = ['stock-correction', 'damage-reduction', 'donation', 'trash-disposal', 'quality-rejection'];
        if (deductTypes.includes(adjustment.adjustmentType)) {
          setReceipts((prev) =>
            prev.map((r) =>
              r.id === adjustment.receiptId
                ? { ...r, quantity: Math.max(0, r.quantity - (adjustment.quantity || 0)) }
                : r,
            ),
          );
        }
      }
    } catch (error) {
      console.error('Error approving adjustment:', error);
    }
  };

  // ─── rejectAdjustment ───────────────────────────────────────────────────────

  const rejectAdjustment = async (id, approverId = 'admin-user') => {
    try {
      await apiClient.post(`/inventory/adjustments/${id}/reject`, {});

      setInventoryAdjustments((prev) =>
        prev.map((adj) =>
          adj.id === id
            ? { ...adj, status: 'rejected', approvedBy: approverId, approvedAt: new Date().toISOString() }
            : adj,
        ),
      );
    } catch (error) {
      console.error('Error rejecting adjustment:', error);
    }
  };

  // ─── saveCycleCount ─────────────────────────────────────────────────────────

  const saveCycleCount = async (cycleCountData) => {
    try {
      const payload = {
        location_id: cycleCountData.location,
        category_id: cycleCountData.category || null,
        count_date: cycleCountData.countDate,
        items: cycleCountData.items,
        summary: cycleCountData.summary,
        performed_by: cycleCountData.performedBy,
        performed_by_id: cycleCountData.performedById,
      };

      const response = await apiClient.post('/inventory/cycle-counts', payload);

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
      return null;
    }
  };

  // ─── fetchForkliftRequests ──────────────────────────────────────────────────

  const fetchForkliftRequests = async () => {
    try {
      const response = await apiClient.get('/scanner/requests');
      setForkliftRequests(response.data || []);
      return response.data || [];
    } catch (error) {
      console.error('Error fetching forklift requests:', error);
      return [];
    }
  };

  // ─── approveForkliftRequest ─────────────────────────────────────────────────

  const approveForkliftRequest = async (id) => {
    try {
      await apiClient.post(`/scanner/requests/${id}/approve`, {});
      await fetchForkliftRequests();

      const receiptsResponse = await apiClient.get('/receipts/', { params: { limit: 10000 } });
      const recs = receiptsResponse.data.map((rec) => mapReceiptFromApi(rec, products));
      setReceipts(recs);

      return { success: true };
    } catch (error) {
      console.error('Error approving forklift request:', error);
      const msg = error.response?.data?.detail || error.message || 'Approval failed';
      return { success: false, error: msg };
    }
  };

  // ─── rejectForkliftRequest ──────────────────────────────────────────────────

  const rejectForkliftRequest = async (id) => {
    try {
      await apiClient.post(`/scanner/requests/${id}/reject`, {});
      await fetchForkliftRequests();
      return { success: true };
    } catch (error) {
      console.error('Error rejecting forklift request:', error);
      const msg = error.response?.data?.detail || error.message || 'Reject failed';
      return { success: false, error: msg };
    }
  };

  // ─── updateForkliftRequest ──────────────────────────────────────────────────

  const updateForkliftRequest = async (id, updates) => {
    try {
      await apiClient.put(`/scanner/requests/${id}`, updates);
      await fetchForkliftRequests();
      return { success: true };
    } catch (error) {
      console.error('Error updating forklift request:', error);
      const msg = error.response?.data?.detail || error.message || 'Update failed';
      return { success: false, error: msg };
    }
  };

  // ─── removePalletLicence ────────────────────────────────────────────────────

  const removePalletLicence = async (requestId, licenceId) => {
    try {
      await apiClient.delete(`/scanner/requests/${requestId}/pallet-licences/${licenceId}`);
      await fetchForkliftRequests();
      return { success: true };
    } catch (error) {
      console.error('Error removing pallet licence:', error);
      const msg = error.response?.data?.detail || error.message || 'Remove failed';
      return { success: false, error: msg };
    }
  };

  // ─── updatePalletLicence ────────────────────────────────────────────────────

  const updatePalletLicence = async (requestId, licenceId, updates) => {
    try {
      await apiClient.put(`/scanner/requests/${requestId}/pallet-licences/${licenceId}`, updates);
      await fetchForkliftRequests();
      return { success: true };
    } catch (error) {
      console.error('Error updating pallet licence:', error);
      const msg = error.response?.data?.detail || error.message || 'Update failed';
      return { success: false, error: msg };
    }
  };

  // ─── addPalletToForkliftRequest ─────────────────────────────────────────────

  const addPalletToForkliftRequest = async (requestId, palletData) => {
    try {
      await apiClient.post(`/scanner/requests/${requestId}/add-pallet`, palletData);
      await fetchForkliftRequests();
      return { success: true };
    } catch (error) {
      console.error('Error adding pallet to request:', error);
      const msg = error.response?.data?.detail || error.message || 'Add pallet failed';
      return { success: false, error: msg };
    }
  };

  // ─── fetchPalletLicences ────────────────────────────────────────────────────

  const fetchPalletLicences = async (filters = {}) => {
    try {
      const response = await apiClient.get('/pallet-licences/', { params: filters });
      return response.data || [];
    } catch (error) {
      console.error('Error fetching pallet licences:', error);
      return [];
    }
  };

  // ─── createShipOutPickList ──────────────────────────────────────────────────

  const createShipOutPickList = async (data) => {
    try {
      const response = await apiClient.post('/inventory/ship-out/pick-list', {
        receipt_id: data.receiptId,
        order_number: data.orderNumber,
        pallet_licence_ids: data.palletLicenceIds,
      });
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

  // ─── fetchTransferScanProgress ──────────────────────────────────────────────

  const fetchTransferScanProgress = async (transferId) => {
    try {
      const response = await apiClient.get(`/inventory/transfers/${transferId}/scan-progress`);
      return response.data;
    } catch (error) {
      console.error('Error fetching transfer scan progress:', error);
      return null;
    }
  };

  // ─── Context value ──────────────────────────────────────────────────────────

  const value = {
    inventoryTransfers,
    inventoryHoldActions,
    inventoryAdjustments,
    cycleCounts,
    forkliftRequests,
    submitTransfer,
    updateTransfer,
    approveTransfer,
    rejectTransfer,
    submitHoldAction,
    updateHoldAction,
    updateHoldStatus,
    approveHoldAction,
    rejectHoldAction,
    submitAdjustment,
    updateAdjustment,
    updateAdjustmentStatus,
    approveAdjustment,
    rejectAdjustment,
    saveCycleCount,
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
  };

  return <InventoryContext.Provider value={value}>{children}</InventoryContext.Provider>;
};

export default InventoryContext;
