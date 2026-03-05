/**
 * AppDataContext — thin facade.
 *
 * All state lives in the six domain contexts (see src/context/domains/).
 * This file aggregates them and re-exposes an identical `useAppData()` API
 * so every consumer component needs zero changes.
 */
import React, { createContext, useContext, useMemo } from 'react';
import { useFoundationContext } from './domains/FoundationContext';
import { useLocationContext } from './domains/LocationContext';
import { useReceipt } from './domains/ReceiptContext';
import { useInventory } from './domains/InventoryContext';
import { useReporting } from './domains/ReportingContext';
import { useUserContext } from './domains/UserContext';

const AppDataContext = createContext(null);

export const AppDataProvider = ({ children }) => {
  const foundation = useFoundationContext();
  const location = useLocationContext();
  const receipt = useReceipt();
  const inventory = useInventory();
  const reporting = useReporting();
  const userCtx = useUserContext();

  const value = useMemo(() => ({
    // Foundation
    categories: foundation.categories,
    categoryGroups: foundation.categoryGroups,
    categoryGroupsMapped: foundation.categoryGroupsMapped,
    productCategories: foundation.productCategories,
    products: foundation.products,
    vendors: foundation.vendors,
    productsLoading: foundation.productsLoading,
    categoriesLoading: foundation.categoriesLoading,
    addCategory: foundation.addCategory,
    updateCategory: foundation.updateCategory,
    toggleCategoryActive: foundation.toggleCategoryActive,
    removeCategory: foundation.removeCategory,
    addCategoryGroup: foundation.addCategoryGroup,
    updateCategoryGroup: foundation.updateCategoryGroup,
    addProduct: foundation.addProduct,
    updateProduct: foundation.updateProduct,
    toggleProductStatus: foundation.toggleProductStatus,
    addVendor: foundation.addVendor,
    updateVendor: foundation.updateVendor,
    toggleVendorActive: foundation.toggleVendorActive,
    removeVendor: foundation.removeVendor,

    // Location
    locations: location.locations,
    locationsTree: location.locationsTree,
    subLocationMap: location.subLocationMap,
    subLocationsUnifiedMap: location.subLocationsUnifiedMap,
    subLocationUnifiedLookup: location.subLocationUnifiedLookup,
    locationLookup: location.locationLookup,
    storageAreas: location.storageAreas,
    finishedGoodsRows: location.finishedGoodsRows,
    finishedGoodsLocations: location.finishedGoodsLocations,
    productionShifts: location.productionShifts,
    productionLines: location.productionLines,
    addLocation: location.addLocation,
    renameLocation: location.renameLocation,
    toggleLocationActive: location.toggleLocationActive,
    removeLocation: location.removeLocation,
    addSubLocation: location.addSubLocation,
    addSubLocationRow: location.addSubLocationRow,
    updateSubLocationRow: location.updateSubLocationRow,
    toggleSubLocationRowActive: location.toggleSubLocationRowActive,
    renameSubLocation: location.renameSubLocation,
    toggleSubLocationActive: location.toggleSubLocationActive,
    removeSubLocation: location.removeSubLocation,
    addStorageArea: location.addStorageArea,
    updateStorageArea: location.updateStorageArea,
    toggleStorageAreaActive: location.toggleStorageAreaActive,
    removeStorageArea: location.removeStorageArea,
    addStorageRow: location.addStorageRow,
    updateStorageRow: location.updateStorageRow,
    toggleStorageRowActive: location.toggleStorageRowActive,
    removeStorageRow: location.removeStorageRow,
    addProductionShift: location.addProductionShift,
    updateProductionShift: location.updateProductionShift,
    toggleProductionShiftActive: location.toggleProductionShiftActive,
    removeProductionShift: location.removeProductionShift,
    addProductionLine: location.addProductionLine,
    updateProductionLine: location.updateProductionLine,
    toggleProductionLineActive: location.toggleProductionLineActive,

    // Receipt
    receipts: receipt.receipts,
    activeReceipts: receipt.activeReceipts,
    pendingEdits: receipt.pendingEdits,
    editHistory: receipt.editHistory,
    setPendingEdits: receipt.setPendingEdits,
    allocationHistory: receipt.allocationHistory,
    refreshReceipts: receipt.refreshReceipts,
    submitReceipt: receipt.submitReceipt,
    updateReceiptStatus: receipt.updateReceiptStatus,
    updateReceipt: receipt.updateReceipt,
    approveReceipt: receipt.approveReceipt,
    rejectReceipt: receipt.rejectReceipt,
    sendBackReceipt: receipt.sendBackReceipt,

    // Inventory
    inventoryTransfers: inventory.inventoryTransfers,
    submitTransfer: inventory.submitTransfer,
    updateTransfer: inventory.updateTransfer,
    approveTransfer: inventory.approveTransfer,
    rejectTransfer: inventory.rejectTransfer,
    forkliftRequests: inventory.forkliftRequests,
    fetchForkliftRequests: inventory.fetchForkliftRequests,
    approveForkliftRequest: inventory.approveForkliftRequest,
    rejectForkliftRequest: inventory.rejectForkliftRequest,
    updateForkliftRequest: inventory.updateForkliftRequest,
    removePalletLicence: inventory.removePalletLicence,
    updatePalletLicence: inventory.updatePalletLicence,
    addPalletToForkliftRequest: inventory.addPalletToForkliftRequest,
    fetchPalletLicences: inventory.fetchPalletLicences,
    createShipOutPickList: inventory.createShipOutPickList,
    fetchTransferScanProgress: inventory.fetchTransferScanProgress,
    inventoryHoldActions: inventory.inventoryHoldActions,
    submitHoldAction: inventory.submitHoldAction,
    updateHoldAction: inventory.updateHoldAction,
    approveHoldAction: inventory.approveHoldAction,
    rejectHoldAction: inventory.rejectHoldAction,
    inventoryAdjustments: inventory.inventoryAdjustments,
    submitAdjustment: inventory.submitAdjustment,
    updateAdjustment: inventory.updateAdjustment,
    approveAdjustment: inventory.approveAdjustment,
    rejectAdjustment: inventory.rejectAdjustment,
    cycleCounts: inventory.cycleCounts,
    saveCycleCount: inventory.saveCycleCount,

    // Reporting
    receiptReportingRows: reporting.receiptReportingRows,
    movementReportingRows: reporting.movementReportingRows,
    receiptsTimeline: reporting.receiptsTimeline,
    financialReportingSummary: reporting.financialReportingSummary,
    finishedGoodsCapacitySummary: reporting.finishedGoodsCapacitySummary,
    rawMaterialsCapacitySummary: reporting.rawMaterialsCapacitySummary,

    // Users
    users: userCtx.users,
    userNameMap: userCtx.userNameMap,
    addUser: userCtx.addUser,
    updateUser: userCtx.updateUser,
    toggleUserStatus: userCtx.toggleUserStatus,
  }), [foundation, location, receipt, inventory, reporting, userCtx]);

  return (
    <AppDataContext.Provider value={value}>
      {children}
    </AppDataContext.Provider>
  );
};

export const useAppData = () => {
  const context = useContext(AppDataContext);
  if (!context) {
    throw new Error('useAppData must be used within an AppDataProvider');
  }
  return context;
};

export default AppDataContext;
