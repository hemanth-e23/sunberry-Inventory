// Build the per-(lot × physical place) breakdown for raw-material /
// packaging adjustment, transfer, and ship-out forms.
//
// Three precedence modes per receipt — matches how the data is actually
// stored, no fallback heuristics:
//
//   1) `rawMaterialRowAllocations` (JSON list)
//      → receipt was split across multiple rows at receive time
//      → emit one entry per allocation
//
//   2) `storageRowId` (single string)
//      → receipt was logged into one specific row
//      → emit one entry for that row, full receipt qty as available
//
//   3) Neither
//      → row-less storage; single entry by location / sub-location

// Storage rows live in two unrelated state trees:
//   • FG rows under storageAreasState[].rows
//   • RM/PKG/ingredient rows under locationsState[].subLocations[].rows
//     (exposed to consumers as subLocationMap)
// findRowInfo searches both and returns a fully-qualified label.
const findRowInfo = (rowId, storageAreas = [], subLocationMap = {}, locations = []) => {
  for (const area of storageAreas) {
    const row = (area.rows || []).find((r) => r.id === rowId);
    if (row) return { row, label: area.name };
  }
  for (const [locId, subs] of Object.entries(subLocationMap)) {
    for (const sub of subs) {
      const row = (sub.rows || []).find((r) => r.id === rowId);
      if (row) {
        const locName = locations.find((l) => l.id === locId)?.name || '';
        const label = locName ? `${locName} / ${sub.name}` : sub.name;
        return { row, label };
      }
    }
  }
  return null;
};

const containerInfoFromReceipt = (receipt) => {
  const wpc = Number(receipt?.weightPerContainer || 0);
  const containerUnit = receipt?.containerUnit || null;
  if (wpc > 0 && containerUnit) {
    return { weightPerContainer: wpc, containerUnit };
  }
  return { weightPerContainer: null, containerUnit: null };
};

const makeEntry = (overrides) => {
  // Per-entry display unit: barrels (or whatever container the receipt
  // came in) when we have the container info, otherwise the storage unit.
  const wpc = overrides.weightPerContainer || null;
  const cu = overrides.containerUnit || null;
  // This builder is raw-material / packaging only — never default to "cases".
  let displayUnit = overrides.unit || 'units';
  let displayFactor = 1;
  if (wpc && cu) {
    displayUnit = cu;
    displayFactor = wpc;
  }
  return { ...overrides, displayUnit, displayFactor };
};

const locationLabelForReceipt = (receipt, locations, subLocationMap) => {
  const locId = receipt.location || null;
  const subId = receipt.subLocation || null;
  const locName = locations.find((l) => l.id === locId)?.name || 'Location';
  const subName =
    (subLocationMap[locId] || []).find((s) => s.id === subId)?.name || '';
  return `${locName}${subName ? ' / ' + subName : ''}`;
};

/**
 * One entry per (lot × physical place) for the chosen product.
 * Each entry carries everything the form needs: receiptId for routing,
 * sourceId for source_breakdown payload, display unit + factor for the
 * barrels/lbs/cases UX.
 */
export const buildEntriesForProduct = ({
  productId,
  approvedReceipts = [],
  storageAreas = [],
  locations = [],
  subLocationMap = {},
}) => {
  if (!productId) return [];

  const entries = [];
  const matching = approvedReceipts.filter(
    (r) => r.productId === productId && Number(r.quantity || 0) > 0,
  );

  for (const receipt of matching) {
    const lot = receipt.lotNo || receipt.lot_number || receipt.id;
    const unit = receipt.quantityUnits || 'units';
    const { weightPerContainer, containerUnit } = containerInfoFromReceipt(receipt);
    const total = Number(receipt.quantity || 0);

    // 1) Multi-row allocation (recorded at receive time)
    const allocs = (receipt.rawMaterialRowAllocations || []).filter(
      (a) => a?.rowId && Number(a?.cases || 0) > 0,
    );
    if (allocs.length > 0) {
      for (const a of allocs) {
        const info = findRowInfo(a.rowId, storageAreas, subLocationMap, locations);
        const label = info ? `${info.label} / ${info.row.name}` : `Row ${a.rowId}`;
        entries.push(makeEntry({
          key: `${receipt.id}::row-${a.rowId}`,
          receiptId: receipt.id,
          rowId: a.rowId,
          sourceId: `row-${a.rowId}`,
          lotNumber: lot,
          locationLabel: label,
          available: Number(a.cases) || 0,
          rowPallets: Number(a.pallets) || 0,
          unit,
          weightPerContainer,
          containerUnit,
          type: 'row',
          receiptTotal: total,
        }));
      }
      continue;
    }

    // 2) Single-row receipt
    if (receipt.storageRowId) {
      const info = findRowInfo(receipt.storageRowId, storageAreas, subLocationMap, locations);
      const label = info
        ? `${info.label} / ${info.row.name}`
        : locationLabelForReceipt(receipt, locations, subLocationMap);
      entries.push(makeEntry({
        key: `${receipt.id}::row-${receipt.storageRowId}`,
        receiptId: receipt.id,
        rowId: receipt.storageRowId,
        sourceId: `row-${receipt.storageRowId}`,
        lotNumber: lot,
        locationLabel: label,
        available: total,
        rowPallets: Number(receipt.pallets) || 0,
        unit,
        weightPerContainer,
        containerUnit,
        type: 'row',
        receiptTotal: total,
      }));
      continue;
    }

    // 3) Receipt didn't capture the row, but the StorageRow itself records
    //    which product it holds (this is how the inventory modal finds
    //    "Row 15"). Surface every row matching this receipt's product, in
    //    the receipt's location — searching BOTH the FG storage-area tree
    //    and the sub-location row tree (where RM/PKG rows actually live).
    const productRows = [];
    for (const area of storageAreas) {
      if (receipt.location && area.locationId !== receipt.location) continue;
      if (receipt.subLocation && area.subLocationId && area.subLocationId !== receipt.subLocation) continue;
      for (const row of area.rows || []) {
        if (row.productId !== receipt.productId) continue;
        if (Number(row.occupiedCases || 0) <= 0) continue;
        productRows.push({ row, label: area.name });
      }
    }
    const recLocId = receipt.location || null;
    const recLocName = locations.find((l) => l.id === recLocId)?.name || '';
    const subsForLoc = recLocId ? (subLocationMap[recLocId] || []) : [];
    for (const sub of subsForLoc) {
      if (receipt.subLocation && sub.id !== receipt.subLocation) continue;
      for (const row of sub.rows || []) {
        if (row.productId !== receipt.productId) continue;
        if (Number(row.occupiedCases || 0) <= 0) continue;
        const label = recLocName ? `${recLocName} / ${sub.name}` : sub.name;
        productRows.push({ row, label });
      }
    }
    if (productRows.length > 0) {
      let attributed = 0;
      for (const { row, label } of productRows) {
        const remaining = Math.max(0, total - attributed);
        if (remaining <= 0) break;
        const cases = Math.min(Number(row.occupiedCases) || 0, remaining);
        attributed += cases;
        entries.push(makeEntry({
          key: `${receipt.id}::row-${row.id}`,
          receiptId: receipt.id,
          rowId: row.id,
          sourceId: `row-${row.id}`,
          lotNumber: lot,
          locationLabel: `${label} / ${row.name}`,
          available: cases,
          rowPallets: Number(row.occupiedPallets) || 0,
          unit,
          weightPerContainer,
          containerUnit,
          type: 'row',
          receiptTotal: total,
        }));
      }
      // Anything left over (lot quantity exceeds attributed rows) shows as
      // an unassigned location entry so it can still be adjusted.
      const leftover = total - attributed;
      if (leftover > 0.0001) {
        entries.push(makeEntry({
          key: `${receipt.id}::loc`,
          receiptId: receipt.id,
          rowId: null,
          sourceId: receipt.subLocation || receipt.location || 'unknown',
          lotNumber: lot,
          locationLabel: `${locationLabelForReceipt(receipt, locations, subLocationMap)} (unassigned)`,
          available: leftover,
          unit,
          weightPerContainer,
          containerUnit,
          type: 'standard',
          receiptTotal: total,
        }));
      }
      continue;
    }

    // 4) Row-less location entry
    const subId = receipt.subLocation || null;
    const locId = receipt.location || null;
    entries.push(makeEntry({
      key: `${receipt.id}::loc`,
      receiptId: receipt.id,
      rowId: null,
      sourceId: subId || locId || 'unknown',
      lotNumber: lot,
      locationLabel: locationLabelForReceipt(receipt, locations, subLocationMap),
      available: total,
      unit,
      weightPerContainer,
      containerUnit,
      type: 'standard',
      receiptTotal: total,
    }));
  }

  return entries;
};

/**
 * Pick the most popular display unit across entries — used as the unit of
 * the global "Quantity to Adjust" / "Quantity to Move" field at the top.
 * Falls back to the storage unit when entries are mixed.
 */
export const dominantDisplayUnit = (entries = []) => {
  if (entries.length === 0) return null;
  const tallies = new Map();
  for (const e of entries) {
    const key = `${e.displayUnit}|${e.displayFactor}`;
    const slot = tallies.get(key) || { unit: e.displayUnit, factor: e.displayFactor, count: 0 };
    slot.count += 1;
    tallies.set(key, slot);
  }
  let best = null;
  for (const slot of tallies.values()) {
    if (!best || slot.count > best.count) best = slot;
  }
  return best;
};
