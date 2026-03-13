import { createContext, useContext, useMemo } from 'react';
import { useFoundationContext as useFoundation } from './FoundationContext';
import { useLocationContext as useLocation } from './LocationContext';
import { useReceipt } from './ReceiptContext';
import { useInventory } from './InventoryContext';
import { numberFrom } from '../../utils/allocationUtils';
import { toDateKey } from '../../utils/dateUtils';

// ─── Pure helper functions ────────────────────────────────────────────────────

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
      ? `${locationLookup[subEntry.parentId]?.name || locationEntry?.name || ''}${
          locationEntry || locationLookup[subEntry.parentId] ? ' / ' : ''
        }${subEntry.name}`
      : locationEntry?.name || '';

    return {
      id: receipt.id,
      receiptDate: receipt.receiptDate,
      productionDate: receipt.productionDate || null,
      submittedAt: receipt.submittedAt,
      approvedAt: receipt.approvedAt,
      productId: receipt.productId,
      productName: product?.name || 'Unknown product',
      productCode: product?.fcc || product?.sid || '',
      categoryId: product?.categoryId || null,
      categoryName: category?.name || 'Unknown category',
      quantity: numberFrom(receipt.quantity, 0),
      quantityUnits: receipt.quantityUnits || '',
      casesPerPallet: numberFrom(receipt.casesPerPallet, 0),
      fullPallets: numberFrom(receipt.fullPallets, 0),
      partialCases: numberFrom(receipt.partialCases, 0),
      floorPallets: numberFrom(receipt.allocation?.floorAllocation?.pallets, 0),
      floorCases: numberFrom(receipt.allocation?.floorAllocation?.cases, 0),
      hold: Boolean(receipt.hold),
      lotNo: receipt.lotNo || '',
      locationId: receipt.location || null,
      subLocationId: receipt.subLocation || null,
      locationName,
      status: receipt.status,
    };
  });
};

const buildMovementReportingRows = (transfers, adjustments, holdActions, receipts, products) => {
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
      type: 'Transfer',
      id: transfer.id,
      timestamp: transfer.submittedAt,
      status: transfer.status,
      productName: product?.name || 'Unknown product',
      productCode: product?.fcc || product?.sid || '',
      quantity: numberFrom(transfer.quantity, 0),
      fromLocation: receipt?.location || null,
      toLocation: transfer.toLocation || null,
      notes: transfer.reason || '',
    };
  });

  const adjustmentRows = adjustments.map((adjustment) => {
    const receipt = receiptsById[adjustment.receiptId];
    const product = receipt ? productsById[receipt.productId] : null;
    return {
      type: 'Adjustment',
      id: adjustment.id,
      timestamp: adjustment.submittedAt,
      status: adjustment.status,
      productName: product?.name || 'Unknown product',
      productCode: product?.fcc || product?.sid || '',
      quantity: numberFrom(adjustment.updates?.quantity, receipt?.quantity || 0),
      fromLocation: receipt?.location || null,
      toLocation: adjustment.updates?.location || receipt?.location || null,
      notes: adjustment.note || '',
    };
  });

  const holdRows = holdActions.map((action) => {
    const receipt = receiptsById[action.receiptId];
    const product = receipt ? productsById[receipt.productId] : null;
    return {
      type: action.action === 'hold' ? 'Hold' : 'Release',
      id: action.id,
      timestamp: action.submittedAt,
      status: action.status,
      productName: product?.name || 'Unknown product',
      productCode: product?.fcc || product?.sid || '',
      quantity: numberFrom(receipt?.quantity, 0),
      fromLocation: receipt?.location || null,
      toLocation: receipt?.location || null,
      notes: action.reason || '',
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
  const buckets = groupByDate(rows, 'receiptDate');
  const timeline = Object.keys(buckets)
    .sort()
    .map((dateKey) => {
      const rowsForDate = buckets[dateKey];
      const totalCases = rowsForDate.reduce((sum, row) => sum + numberFrom(row.quantity, 0), 0);
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

// ─── Context ──────────────────────────────────────────────────────────────────

const ReportingContext = createContext(null);

export const useReporting = () => {
  const ctx = useContext(ReportingContext);
  if (!ctx) throw new Error('useReporting must be used within a ReportingProvider');
  return ctx;
};

export const ReportingProvider = ({ children }) => {
  const { products, categories } = useFoundation();
  const locationCtx = useLocation();
  const locationLookup = locationCtx?.locationLookup ?? {};
  const storageAreasState = locationCtx?.storageAreas ?? [];
  const locationsState = locationCtx?.locationsTree ?? [];
  const { activeReceipts: receipts } = useReceipt();
  const { inventoryTransfers, inventoryAdjustments, inventoryHoldActions } = useInventory();

  // ─── receiptReportingRows ───────────────────────────────────────────────────

  const receiptReportingRows = useMemo(
    () => buildReceiptReportingRows(receipts, products, categories, locationLookup),
    [receipts, products, categories, locationLookup],
  );

  // ─── movementReportingRows ──────────────────────────────────────────────────

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

  // ─── receiptsTimeline ───────────────────────────────────────────────────────

  const receiptsTimeline = useMemo(
    () => summarizeReceiptsByDate(receiptReportingRows),
    [receiptReportingRows],
  );

  // ─── financialReportingSummary ──────────────────────────────────────────────

  const financialReportingSummary = useMemo(() => {
    const totals = receiptReportingRows.reduce((acc, row) => {
      const quantity = numberFrom(row.quantity, 0);
      if (!acc[row.categoryName]) {
        acc[row.categoryName] = { category: row.categoryName, cases: 0, lots: 0 };
      }
      acc[row.categoryName].cases += quantity;
      acc[row.categoryName].lots += 1;
      return acc;
    }, {});
    return Object.values(totals).sort((a, b) => b.cases - a.cases);
  }, [receiptReportingRows]);

  // ─── finishedGoodsCapacitySummary ───────────────────────────────────────────

  const finishedGoodsCapacitySummary = useMemo(() => {
    let totalPalletCapacity = 0;
    let occupiedPallets = 0;
    let heldPallets = 0;

    storageAreasState.forEach((area) => {
      area.rows.forEach((row) => {
        totalPalletCapacity += numberFrom(row.palletCapacity, 0);
        const used = Math.min(numberFrom(row.palletCapacity, 0), numberFrom(row.occupiedPallets, 0));
        occupiedPallets += used;
        if (row.hold) heldPallets += used;
      });
    });

    const floorStagingPallets = receipts.reduce((sum, receipt) => {
      const pallets = numberFrom(receipt.allocation?.floorAllocation?.pallets, 0);
      return sum + pallets;
    }, 0);

    const utilization =
      totalPalletCapacity > 0 ? Math.min(100, (occupiedPallets / totalPalletCapacity) * 100) : 0;

    return {
      totalPalletCapacity,
      occupiedPallets,
      availablePallets: Math.max(totalPalletCapacity - occupiedPallets, 0),
      heldPallets,
      utilization,
      floorStagingPallets,
    };
  }, [storageAreasState, receipts]);

  // ─── rawMaterialsCapacitySummary ────────────────────────────────────────────

  const rawMaterialsCapacitySummary = useMemo(() => {
    let totalPalletCapacity = 0;
    let occupiedPallets = 0;
    let heldPallets = 0;

    locationsState.forEach((location) => {
      location.subLocations?.forEach((subLoc) => {
        subLoc.rows?.forEach((row) => {
          totalPalletCapacity += numberFrom(row.palletCapacity, 0);
          const used = Math.min(
            numberFrom(row.palletCapacity, 0),
            numberFrom(row.occupiedPallets, 0),
          );
          occupiedPallets += used;
          if (row.hold) heldPallets += used;
        });
      });
    });

    const floorStagingPallets = receipts.reduce((sum, receipt) => {
      const product = products.find((p) => p.id === receipt.productId);
      const category = categories.find((c) => c.id === product?.categoryId);
      const isRawMaterial = category?.type === 'raw-material';
      if (isRawMaterial && receipt.status === 'approved') {
        return sum + numberFrom(receipt.allocation?.floorAllocation?.pallets, 0);
      }
      return sum;
    }, 0);

    const utilization =
      totalPalletCapacity > 0 ? Math.min(100, (occupiedPallets / totalPalletCapacity) * 100) : 0;

    return {
      totalPalletCapacity,
      occupiedPallets,
      availablePallets: Math.max(totalPalletCapacity - occupiedPallets, 0),
      heldPallets,
      utilization,
      floorStagingPallets,
    };
  }, [locationsState, receipts, products, categories]);

  // ─── Context value ──────────────────────────────────────────────────────────

  const value = {
    receiptReportingRows,
    movementReportingRows,
    receiptsTimeline,
    financialReportingSummary,
    finishedGoodsCapacitySummary,
    rawMaterialsCapacitySummary,
  };

  return <ReportingContext.Provider value={value}>{children}</ReportingContext.Provider>;
};

export default ReportingContext;
