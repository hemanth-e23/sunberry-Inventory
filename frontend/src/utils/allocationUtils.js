// ─── Shared allocation helper functions ─────────────────────────────────────
// Used by InventoryContext, ReceiptContext, and ReportingContext.

export const EPSILON = 1e-4;

export const roundTo = (value, precision = 4) => {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
};

export const numberFrom = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const calculateFinishedGoodsAllocation = (areas, input) => {
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

export const cloneStorageAreas = (areas) =>
  areas.map((area) => ({
    ...area,
    rows: area.rows.map((row) => ({ ...row })),
  }));

export const releaseFinishedGoodsAllocation = (areas, allocation) => {
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
