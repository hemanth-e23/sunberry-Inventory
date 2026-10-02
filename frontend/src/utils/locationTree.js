import { RECEIPT_STATUS } from '../constants';
import { rowCapacityInfo } from './rowSources';

// ─── Tree builder ─────────────────────────────────────────────────────────────
// Single hierarchical view: Location → (Sub-location | FG Area) → Row → Product
// Receipts are bucketed at the most specific level we can resolve.

const newProductBucket = (productId, name, unit) => ({
  productId,
  name,
  qty: 0,
  lots: new Set(),
  holdCount: 0,
  unit: unit || 'units',
  displayUnit: null,
  displayFactor: 1,
  // Containers from the live rack projection (lot-tracked material only).
  fullUnits: 0,
  openUnits: 0,
  openQty: 0,
});

const addProductToNode = (node, receipt, qty, productsById, alloc = null) => {
  if (qty <= 0) return;
  const product = productsById[receipt.productId];
  const key = receipt.productId;
  const bucket = node._products.get(key) || newProductBucket(
    key,
    product?.name || 'Unknown product',
    receipt.quantityUnits,
  );
  bucket.qty += qty;
  if (alloc) {
    bucket.fullUnits += Number(alloc.fullUnits) || 0;
    bucket.openUnits += Number(alloc.openUnits) || 0;
    bucket.openQty += Number(alloc.openQty) || 0;
  }
  if (receipt.lotNo) bucket.lots.add(receipt.lotNo);
  if (receipt.hold) bucket.holdCount += 1;
  if (receipt.weightPerContainer && receipt.containerUnit && !bucket.displayUnit) {
    bucket.displayUnit = receipt.containerUnit;
    bucket.displayFactor = Number(receipt.weightPerContainer) || 1;
  }
  node._products.set(key, bucket);
};

export const buildTree = ({ locationsTree, storageAreas, receipts, productsById }) => {
  const tree = [];
  const locById = {};
  const subById = {};   // sub-location OR fg storage-area
  const rowById = {};

  const makeNode = (id, name, type, parentLocId, parentSubId, capacity, declaredProductId, occupiedCases) => ({
    id,
    name,
    type,
    parentLocId: parentLocId || null,
    parentSubId: parentSubId || null,
    capacity: capacity || null,
    declaredProductId: declaredProductId || null,
    occupiedCases: occupiedCases || 0,
    children: [],
    _products: new Map(),
    products: [],
    qty: 0,
    lotCount: 0,
    productCount: 0,
    holdCount: 0,
    descendantQty: 0,
  });

  for (const loc of locationsTree) {
    const locNode = makeNode(loc.id, loc.name, 'location');
    tree.push(locNode);
    locById[loc.id] = locNode;

    for (const sub of (loc.subLocations || [])) {
      const subNode = makeNode(sub.id, sub.name, 'sub-rm', loc.id);
      locNode.children.push(subNode);
      subById[sub.id] = subNode;

      for (const row of (sub.rows || [])) {
        // A deactivated rack holding nothing is not a place to look; this is
        // also how a room's retired default row (F6) stays off the board.
        if (row.active === false && !(Number(row.liveUnits) > 0)
            && !(Number(row.occupiedCases) > 0) && !(Number(row.occupiedPallets) > 0)) {
          continue;
        }
        const rowNode = makeNode(
          row.id,
          row.name,
          'row',
          loc.id,
          sub.id,
          // Capacity per the room's own unit — containers in a drum or bag
          // room, pallet slots elsewhere. Showing a drum rack's occupancy
          // against its leftover pallet figure reads as permanently full.
          (() => {
            const { capacity, occupied, unit } = rowCapacityInfo(sub, row);
            return capacity ? { occupiedPallets: occupied, total: capacity, unit } : null;
          })(),
          row.productId || null,
          Number(row.occupiedCases || 0),
        );
        subNode.children.push(rowNode);
        rowById[row.id] = rowNode;
      }
    }
  }

  // FG rows whose live aggregates we'll inject after the receipt-bucketing loop.
  // We still build the nodes the same way (capacity/declaredProduct/occupiedCases
  // are kept for back-compat), but for any row where the API returned live data
  // we'll replace its products / capacity counter with the live values, so the
  // row card reflects pallet_licences truth instead of receipt routing.
  const liveRowData = {};

  for (const area of storageAreas) {
    let parentLoc = locById[area.locationId];
    if (!parentLoc) {
      parentLoc = makeNode(area.locationId || 'unassigned', 'Unassigned', 'location');
      tree.push(parentLoc);
      locById[parentLoc.id] = parentLoc;
    }
    const areaNode = makeNode(area.id, area.name, 'sub-fg', parentLoc.id);
    parentLoc.children.push(areaNode);
    subById[area.id] = areaNode;

    for (const row of (area.rows || [])) {
      const hasLive = Array.isArray(row.liveProducts);
      const livePallets = hasLive ? Number(row.livePallets || 0) : null;
      const liveCases   = hasLive ? Number(row.liveCases   || 0) : null;

      const rowNode = makeNode(
        row.id,
        row.name,
        'row',
        parentLoc.id,
        area.id,
        row.palletCapacity ? {
          occupiedPallets: hasLive ? livePallets : Number(row.occupiedPallets || 0),
          total: Number(row.palletCapacity || 0),
        } : null,
        row.productId || null,
        hasLive ? liveCases : Number(row.occupiedCases || 0),
      );
      areaNode.children.push(rowNode);
      rowById[row.id] = rowNode;
      if (hasLive) liveRowData[row.id] = row.liveProducts;
    }
  }

  // Bucket each receipt
  for (const receipt of receipts) {
    if (receipt.status !== RECEIPT_STATUS.APPROVED) continue;
    const total = Number(receipt.quantity) || 0;
    if (total <= 0) continue;

    let placed = false;

    // Mode 1: rawMaterialRowAllocations
    const allocs = (receipt.rawMaterialRowAllocations || []).filter(
      (a) => a?.rowId && Number(a?.cases || 0) > 0,
    );
    if (allocs.length > 0) {
      for (const a of allocs) {
        const rowNode = rowById[a.rowId];
        if (rowNode) {
          addProductToNode(rowNode, receipt, Number(a.cases) || 0, productsById, a);
          placed = true;
        }
      }
    }

    // A LOT-TRACKED receipt with no allocations holds nothing of its own.
    // `project_lot` writes the lot's whole rack picture onto one receipt and
    // blanks the others (to [] or, for some older rows, NULL), so the drums
    // are already counted through that receipt. Falling through to the
    // storageRowId / product-row / room fallbacks below counted them twice:
    // QA-D4 showed "20 drums (13,830 lbs)" against a true 9,564 (browser test
    // PART 2, B2). Same rule as buildEntriesForProduct in rowSources.js.
    if (!placed && receipt.materialLotId) continue;

    // Mode 2: storageRowId
    if (!placed && receipt.storageRowId && rowById[receipt.storageRowId]) {
      addProductToNode(rowById[receipt.storageRowId], receipt, total, productsById);
      placed = true;
    }

    // Mode 3: scan rows in receipt's location/sub-location for productId match
    if (!placed) {
      const matching = [];
      for (const rowId in rowById) {
        const r = rowById[rowId];
        if (r.declaredProductId !== receipt.productId) continue;
        if (r.occupiedCases <= 0) continue;
        if (receipt.location && r.parentLocId !== receipt.location) continue;
        if (receipt.subLocation && r.parentSubId !== receipt.subLocation) continue;
        matching.push(r);
      }
      if (matching.length > 0) {
        const sumOcc = matching.reduce((s, r) => s + r.occupiedCases, 0);
        for (const r of matching) {
          const share = sumOcc > 0
            ? (total * r.occupiedCases) / sumOcc
            : total / matching.length;
          addProductToNode(r, receipt, share, productsById);
        }
        placed = true;
      }
    }

    // Mode 4: sub-location / FG-area bucket
    if (!placed && receipt.subLocation && subById[receipt.subLocation]) {
      addProductToNode(subById[receipt.subLocation], receipt, total, productsById);
      placed = true;
    }

    // Mode 5: location bucket
    if (!placed && receipt.location && locById[receipt.location]) {
      addProductToNode(locById[receipt.location], receipt, total, productsById);
      placed = true;
    }

    // Floor allocations from FG receipts → bucket on location node
    if (placed && receipt.allocation?.floorAllocation) {
      // already bucketed above; don't double-count
    }
  }

  // Replace FG row products with live pallet_licence aggregates. We do this
  // AFTER the receipt loop so receipt-bucketing logic for non-FG rows is
  // untouched; for any FG row that came back with live data, its _products map
  // is rebuilt from the live breakdown — receipts that landed on this row are
  // discarded since the pallet truth is authoritative.
  for (const rowId in liveRowData) {
    const node = rowById[rowId];
    if (!node) continue;
    node._products = new Map();
    for (const lp of liveRowData[rowId]) {
      if (!lp.productId || lp.cases <= 0) continue;
      const product = productsById[lp.productId];
      const bucket = node._products.get(lp.productId) || newProductBucket(
        lp.productId,
        product?.name || 'Unknown product',
        'cases',
      );
      bucket.qty += Number(lp.cases) || 0;
      if (lp.lotNumber) bucket.lots.add(lp.lotNumber);
      node._products.set(lp.productId, bucket);
    }
  }

  // Roll up totals from leaves to roots
  // Products and lots are counted DISTINCT across the subtree. Summing each
  // child's count listed one product once per rack it sat on: "QA Barn 12
  // products · 6 lots" for 4 products (browser test PART 2, U7). Lot numbers
  // are keyed with their product — production-day lot codes are shared
  // across products, and two products on lot X are two lots.
  const rollup = (node) => {
    let qty = 0;
    let descendantQty = 0;
    const lots = new Set();
    const productIds = new Set();
    let holdCount = 0;

    for (const p of node._products.values()) {
      qty += p.qty;
      p.lots.forEach((l) => lots.add(`${p.productId}::${l}`));
      holdCount += p.holdCount;
      productIds.add(p.productId);
    }

    for (const child of node.children) {
      rollup(child);
      descendantQty += child.qty + child.descendantQty;
      child._lotSet?.forEach((l) => lots.add(l));
      child._productSet?.forEach((id) => productIds.add(id));
      holdCount += child.holdCount;
    }

    node.qty = qty;
    node.descendantQty = descendantQty;
    node._lotSet = lots;
    node._productSet = productIds;
    node.lotCount = lots.size;
    node.holdCount = holdCount;
    node.productCount = productIds.size;

    node.products = Array.from(node._products.values())
      .map((p) => ({
        ...p,
        lots: Array.from(p.lots),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Sort children: location alphabetical; rows naturally
    node.children.sort((a, b) => {
      if (a.type !== b.type) {
        // sub-rm before sub-fg
        if (a.type === 'sub-rm' && b.type === 'sub-fg') return -1;
        if (a.type === 'sub-fg' && b.type === 'sub-rm') return 1;
      }
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
  };

  for (const loc of tree) rollup(loc);
  tree.sort((a, b) => a.name.localeCompare(b.name));
  return tree;
};
