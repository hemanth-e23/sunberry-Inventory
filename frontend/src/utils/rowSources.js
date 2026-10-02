import { TRANSFER_STATUS } from '../constants';
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
        // The room comes back too: what a rack's FOOTPRINT is counted in is a
        // property of the room, not the row, and the forms need the word.
        return { row, label, sub };
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

// 'drum' -> 'drums', 'box' -> 'boxes'. The blind +'s' printed "boxs" on rack
// cards; already-plural labels pass through (2026-09-29 audit).
export const pluralizeUnit = (label) => {
  const word = String(label || '');
  if (!word || word.endsWith('s')) return word;
  if (/(x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
};

// 'drums' -> 'drum', 'boxes' -> 'box'. A bare s-strip minted 'boxe', which
// failed the palletised-unit check downstream (2026-09-29 audit).
export const singularUnit = (label) => {
  const word = String(label || '');
  if (/(xes|ches|shes|zes)$/.test(word)) return word.slice(0, -2);
  return word.replace(/s$/, '');
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
    displayFactor = Number(overrides.rackUnitWeight) > 0 ? Number(overrides.rackUnitWeight) : wpc;
  }
  // What this rack's FOOTPRINT is counted in — a property of the ROOM, not of
  // what the receipt arrived in. A drum room counts drums on its shelves
  // ("one drum, one slot"); a pallet room counts pallets, whatever is on them.
  // Kept separate from displayUnit, which is how the CONTENT is measured: the
  // two coincide for drums and are a factor of fifty apart for bags.
  const room = overrides.room || null;
  let footprintUnit = 'pallets';
  if (room?.storageUnit) {
    footprintUnit = pluralizeUnit(room.storageUnit);
  }
  // When the room counts its shelves in the SAME container the content is
  // measured in (a drum room holding drums), the footprint freed IS the
  // number of containers moved — one drum, one slot. Asking "drums emptied
  // from this row" right after "how many drums" is a question with only one
  // answer, so the forms derive it instead of showing a second box (2026-10-01).
  const footprintIsContent = footprintUnit !== 'pallets'
    && pluralizeUnit(displayUnit).toLowerCase() === footprintUnit.toLowerCase();
  const { room: _room, ...rest } = overrides;
  return { ...rest, displayUnit, displayFactor, footprintUnit, footprintIsContent };
};

// Footprint freed by moving `displayQty` (in the entry's display unit) off its
// row, for a room where one container is one slot. A partial container left
// behind still occupies its slot, so only whole containers that leave count —
// unless the row is being emptied, which frees every slot it had.
export const containersFreed = (entry, displayQty) => {
  const qty = Number(displayQty || 0);
  if (!(qty > 0)) return 0;
  const availDisp = Number(entry.available || 0) / (entry.displayFactor || 1);
  if (qty >= availDisp - 0.01) {
    return Math.ceil(availDisp - 1e-9);
  }
  return Math.floor(qty + 1e-9);
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
// Transfer statuses that hold drums back — same set the server subtracts in
// `open_reserved_for_receipts`.
const RESERVING_STATUSES = new Set([TRANSFER_STATUS.PENDING, TRANSFER_STATUS.FORKLIFT_SUBMITTED]);

/**
 * Weight already promised to in-flight transfers, per (lot, rack).
 *
 * The server caps a transfer or write-off net of pending transfers, but the
 * forms offered the full rack: "20 drum avail" with 14 already pending, then a
 * refusal (2026-10-01). Keyed by LOT — any receipt of a lot reserves from the
 * same drums — and by the rack each pending transfer takes from.
 */
const reservedByLotRow = (pendingTransfers, allReceipts) => {
  const lotOf = new Map(allReceipts.map((r) => [r.id, r.materialLotId || r.id]));
  const out = new Map();
  for (const t of pendingTransfers || []) {
    if (!RESERVING_STATUSES.has(t.status)) continue;
    const lot = lotOf.get(t.receiptId) || t.receiptId;
    for (const b of t.sourceBreakdown || []) {
      const rowId = String(b?.id || '').replace(/^row-/, '');
      if (!rowId) continue;
      const key = `${lot}::${rowId}`;
      out.set(key, (out.get(key) || 0) + (Number(b.quantity) || 0));
    }
  }
  return out;
};

export const buildEntriesForProduct = ({
  productId,
  approvedReceipts = [],
  storageAreas = [],
  locations = [],
  subLocationMap = {},
  pendingTransfers = [],
  allReceipts = null,
}) => {
  if (!productId) return [];

  const reserved = reservedByLotRow(pendingTransfers, allReceipts || approvedReceipts);
  // Units per pallet, per lot. The lot's rack picture rides on ONE receipt
  // (`project_lot`), which need not be the delivery that recorded the pallet
  // size, so read it from any receipt of the lot.
  const uppByLot = new Map();
  for (const r of (allReceipts || approvedReceipts)) {
    const upp = Number(r?.unitsPerPallet || 0);
    if (r?.materialLotId && upp > 1) {
      uppByLot.set(r.materialLotId, Math.max(uppByLot.get(r.materialLotId) || 0, upp));
    }
  }
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
        // Quarantined units are NOT available. The projection writes
        // `heldUnits` beside `cases` (all of them for a whole-lot hold), and
        // this builder used to ignore it — the transfer/adjustment forms
        // offered every held drum and the refusal only came at approval
        // (2026-09-29 audit, hold GAP 3).
        const heldUnits = Number(a.heldUnits) || 0;
        const grossWeight = Number(a.cases) || 0;
        const allocUnits = Number(a.units) || 0;
        // The rack's own weight per sealed unit first (its deliveries), then
        // the receipt's, then an average of what the rack holds.
        const perUnit = Number(a.weightPerUnit) > 0
          ? Number(a.weightPerUnit)
          : (weightPerContainer && weightPerContainer > 0)
            ? weightPerContainer
            : (allocUnits > 0 ? grossWeight / allocUnits : 0);
        const heldWeight = Math.min(grossWeight, heldUnits * perUnit);
        const reservedWeight = Math.min(
          Math.max(0, grossWeight - heldWeight),
          reserved.get(`${receipt.materialLotId || receipt.id}::${a.rowId}`) || 0,
        );
        entries.push(makeEntry({
          key: `${receipt.id}::row-${a.rowId}`,
          receiptId: receipt.id,
          room: info?.sub || null,
          // Counted lots move as WHOLE CONTAINERS off named racks, and their
          // footprint is derived from the count — so the screens must not ask
          // for a pallet figure the services then ignore.
          isCounted: Boolean(receipt.materialLotId),
          rowId: a.rowId,
          sourceId: `row-${a.rowId}`,
          lotNumber: lot,
          locationLabel: label,
          available: Math.max(0, grossWeight - heldWeight - reservedWeight),
          heldUnits,
          reservedWeight,
          fullUnits: Number(a.fullUnits) || 0,
          openUnits: Number(a.openUnits) || 0,
          openQty: Number(a.openQty) || 0,
          grossWeight: grossWeight,
          // What a sealed unit on THIS rack weighs (from the deliveries on
          // it). One lot can be 502s on one rack and 474s on another, and the
          // receipt's single figure misread the second (2026-10-01).
          rackUnitWeight: Number(a.weightPerUnit) || 0,
          rowPallets: Number(a.pallets) || 0,
          // Bags/boxes that ride a pallet: lets the forms offer "N pallets"
          // as a quick entry (N x this) beside loose units.
          unitsPerPallet: (receipt.materialLotId && uppByLot.get(receipt.materialLotId))
            || (Number(receipt.unitsPerPallet) > 1 ? Number(receipt.unitsPerPallet) : 0),
          unit,
          weightPerContainer,
          containerUnit,
          type: 'row',
          receiptTotal: total,
        }));
      }
      continue;
    }

    // A LOT-TRACKED receipt with no allocations was EMPTIED ON PURPOSE.
    //
    // `project_lot` writes the whole lot's picture onto the newest receipt and
    // blanks the older ones, precisely so the same drums are not counted once
    // per receipt. `storageRowId` still points at the row that receipt
    // originally named, so falling through to the single-row branch below
    // resurrects it as a phantom — the adjustment screen listed ROW 11 twice,
    // once real (4 drums) and once stale (the old receipt's 2 pallets), and
    // offered both for deduction against a rack holding four.
    //
    // No lot means legacy data, where `storageRowId` is still the only record
    // of where it went, so that path stays.
    if (receipt.materialLotId) {
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
        room: info?.sub || null,
        isCounted: false,
        rowId: receipt.storageRowId,
        sourceId: `row-${receipt.storageRowId}`,
        lotNumber: lot,
        locationLabel: label,
        available: Math.max(0, total - (reserved.get(`${receipt.id}::${receipt.storageRowId}`) || 0)),
        reservedWeight: reserved.get(`${receipt.id}::${receipt.storageRowId}`) || 0,
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

// `dominantDisplayUnit` was removed (2026-09-29): it picked ONE per-drum
// weight for a whole product, but weights are per-receipt (474/502/559 on one
// vendor lot is policy) — a factor with no receipt attached has no defensible
// use, and validating against it made mixed-weight products unsubmittable.
// Totals are now derived per entry at each receipt's own displayFactor.


/**
 * What a rack's capacity and occupancy MEAN, given the room it sits in.
 *
 * Two different physical facts share one column, and reading the wrong one is
 * how every Apple Barn row came to display "0 of 22 spaces free" while sitting
 * half empty.
 *
 * A pallet room counts pallet slots: capacity is the row's own
 * `palletCapacity`. A drum or bag room counts containers — the backend states
 * it plainly: "for barrels and totes the container IS the thing on the shelf,
 * so the footprint is the count — one drum, one slot"
 * (lot_placement_service.py). Capacity there is the ROOM's `unitCapacity`,
 * which is exactly what the receiving gun already reads
 * (lot_receiving_service._row_capacity_warning).
 *
 * `occupiedPallets` holds the container count for such a room, so comparing it
 * against the row's leftover pallet-era number understates free space by a
 * factor of four and reports a full rack on an empty one.
 *
 * `free` is null when nothing states a capacity — "no opinion", which the
 * backend spells as `pallet_capacity = 0`. Callers should show no figure rather
 * than invent zero.
 */
export const rowCapacityInfo = (sub, row) => {
  const typed = Boolean(sub?.storageUnit);
  const capacity = typed
    ? Number(sub?.unitCapacity || 0)
    : Number(row?.palletCapacity || 0);
  const occupied = Number(row?.occupiedPallets || 0);

  let unit = 'pallets';
  if (typed) {
    unit = pluralizeUnit(sub.storageUnit);
  }

  return {
    typed,
    capacity,
    occupied,
    unit,
    // Never negative: an over-filled rack is legal (capacity is a soft hint),
    // and "-10 free" is not a thing a warehouse can act on.
    free: capacity > 0 ? Math.max(0, Math.round(capacity - occupied)) : null,
  };
};


/**
 * `{rowId: footprint unit}` for every rack in the location tree.
 *
 * TAKES THE TREE, NOT `locations`. Those are two different values on the same
 * context and only one of them has rows: `locations` is `locationOptions`, a
 * flat [{id, name}] built for dropdowns, while `locationsTree` is the nested
 * state. Walking the flat one for `subLocations` throws nothing and yields
 * nothing — the lookup just comes back empty and every rack silently reports
 * the default. That is exactly how a drum room kept printing "20 pallets"
 * through three rounds of fixes that were all in the right place and reading
 * the wrong variable.
 */
export const buildRowUnitLookup = (locationsTree = []) => {
  const map = {};
  (locationsTree || []).forEach((location) => {
    (location.subLocations || []).forEach((subLoc) => {
      (subLoc.rows || []).forEach((row) => {
        if (row.id) map[row.id] = rowCapacityInfo(subLoc, row).unit;
      });
    });
  });
  return map;
};


/**
 * "6 full + 1 open (224 lbs)" — how many CONTAINERS are free on a rack.
 *
 * Dividing pounds by the per-drum weight printed "6.45 drums" for six sealed
 * drums and one 224 lb open one, while the rack header said 7 and the hold
 * form said 4: the same rack counted three ways (2026-10-01). An open drum is
 * one container with some weight left in it, never 0.45 of a drum.
 *
 * `available` is in the storage unit (lbs); `openQty` is the open drums'
 * remaining weight. Reservations and holds come off sealed drums first.
 * Returns null when the entry has no container split (legacy material), so
 * callers keep their old wording.
 */
export const describeContainers = (entry, available = entry.available) => {
  const factor = Number(entry.displayFactor) || 0;
  const full = Number(entry.fullUnits) || 0;
  const open = Number(entry.openUnits) || 0;
  if (!(factor > 1) || (full + open) === 0) return null;
  const unit = pluralizeUnit(singularUnit(entry.displayUnit || 'unit'));
  const openQty = Number(entry.openQty) || 0;
  const avail = Math.max(0, Number(available) || 0);
  const gross = Number(entry.grossWeight) || avail;
  const openFree = open > 0 && avail >= openQty - 0.01 ? open : 0;
  // Nothing held back: the free count IS the rack count. Dividing pounds by
  // one weight said "15 drums" for 14 when the lot had 502s and 474s
  // (2026-10-01). Only what is held or promised is converted, and rounded
  // up — a part-promised drum is not free.
  const withheld = Math.max(0, gross - avail);
  const fullFree = withheld <= 0.01
    ? full
    : Math.max(0, full - Math.ceil((withheld - 0.01) / factor));
  const fmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const storage = entry.unit || 'lbs';
  if (!openFree) return `${fullFree} ${fullFree === 1 ? singularUnit(unit) : unit}`;
  return `${fullFree} full + ${openFree} open (${fmt(openQty)} ${storage})`;
};


// ─── Display helpers for the Transfer / Adjustment forms ────────────────────

const fmtNum = (n, digits = 2) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: digits });

/** "1 drum", "12 bags", "3 boxes": the count decides the grammar. */
export const countWithUnit = (n, unit) => {
  const num = Number(n) || 0;
  const one = singularUnit(unit || 'unit');
  return `${fmtNum(num)} ${Math.abs(num - 1) < 1e-9 ? one : pluralizeUnit(one)}`;
};

/** A weight in containers, rounded when it is (nearly) a whole number. */
const containersOf = (weight, factor) => {
  const v = Number(weight || 0) / (Number(factor) || 1);
  return Math.abs(v - Math.round(v)) < 0.01 ? Math.round(v) : Math.round(v * 100) / 100;
};

/**
 * How many containers can be taken off this rack right now, by the same rule
 * as `describeContainers` (holds and pending transfers come off sealed
 * containers first). Falls back to available / factor for material with no
 * container split.
 */
export const freeContainers = (entry) => {
  const factor = Number(entry.displayFactor) || 1;
  const full = Number(entry.fullUnits) || 0;
  const open = Number(entry.openUnits) || 0;
  const avail = Math.max(0, Number(entry.available) || 0);
  if (!(factor > 1) || (full + open) === 0) return containersOf(avail, factor);
  const gross = Number(entry.grossWeight) || avail;
  const openQty = Number(entry.openQty) || 0;
  const openFree = open > 0 && avail >= openQty - 0.01 ? open : 0;
  const withheld = Math.max(0, gross - avail);
  const fullFree = withheld <= 0.01 ? full : Math.max(0, full - Math.ceil((withheld - 0.01) / factor));
  return fullFree + openFree;
};

/** Short rack name for messages: the last part of "Barn / Room / QA-D1". */
const rackName = (entry) => {
  const parts = String(entry.locationLabel || '').split(' / ');
  return parts[parts.length - 1] || 'this rack';
};

/**
 * Plain-words reason a typed amount is more than a rack can give, or null
 * when it fits. Replaces the browser's bare "Value must be less than or equal
 * to 4" bubble with containers, pounds and WHY (browser test PART 2, U5).
 */
export const overAskMessage = (entry, displayQty) => {
  const qty = Number(displayQty || 0);
  if (!(qty > 0)) return null;
  const factor = Number(entry.displayFactor) || 1;
  if (qty * factor <= Number(entry.available || 0) + 0.01) return null;
  const unit = entry.displayUnit || entry.unit || 'units';
  const storage = entry.unit || 'lbs';
  const free = freeContainers(entry);
  const showWeight = singularUnit(unit) !== singularUnit(storage);
  let msg = `${rackName(entry)} has only ${countWithUnit(free, unit)} free`;
  if (showWeight) msg += ` (${fmtNum(entry.available, 0)} ${storage})`;
  msg += `; you asked for ${countWithUnit(qty, unit)}`;
  const reasons = [];
  const held = Number(entry.heldUnits) || 0;
  if (held > 0) reasons.push(`${countWithUnit(held, unit)} on hold`);
  const reserved = Number(entry.reservedWeight) || 0;
  if (reserved > 0) {
    reasons.push(`${countWithUnit(containersOf(reserved, factor), unit)} on pending transfers`);
  }
  if (reasons.length) msg += `. Not free: ${reasons.join(', ')}`;
  return `${msg}.`;
};

/**
 * Header totals for the breakdown. "On hand" is what physically sits on the
 * racks (held and promised included); "available" is what can be taken now.
 * The header used to print the available figure as "on hand": "0 lbs on
 * hand" for a held lot (browser test PART 2, U6).
 */
export const stockSummary = (entries = []) => {
  let onHand = 0;
  let available = 0;
  let onHandUnits = 0;
  let availableUnits = 0;
  const units = new Set();
  let allCounted = entries.length > 0;
  for (const e of entries) {
    const avail = Number(e.available) || 0;
    const gross = Number(e.grossWeight) > 0
      ? Number(e.grossWeight)
      : avail + (Number(e.reservedWeight) || 0);
    onHand += gross;
    available += avail;
    units.add(singularUnit(e.displayUnit || e.unit || ''));
    const containers = (Number(e.fullUnits) || 0) + (Number(e.openUnits) || 0);
    if (containers > 0 && Number(e.displayFactor) > 1) {
      onHandUnits += containers;
      availableUnits += freeContainers(e);
    } else {
      allCounted = false;
    }
  }
  const storage = entries[0]?.unit || 'units';
  const unit = units.size === 1 ? [...units][0] : null;
  const part = (count, weight) => (allCounted && unit && unit !== singularUnit(storage)
    ? `${countWithUnit(count, unit)} (${fmtNum(weight)} ${storage})`
    : `${fmtNum(weight)} ${storage}`);
  return {
    onHand,
    available,
    text: `On hand ${part(onHandUnits, onHand)} · available ${part(availableUnits, available)}`,
  };
};
