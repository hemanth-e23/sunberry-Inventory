import React, { useState, useMemo } from "react";
import { RECEIPT_STATUS } from '../../constants';

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
});

const addProductToNode = (node, receipt, qty, productsById) => {
  if (qty <= 0) return;
  const product = productsById[receipt.productId];
  const key = receipt.productId;
  const bucket = node._products.get(key) || newProductBucket(
    key,
    product?.name || 'Unknown product',
    receipt.quantityUnits,
  );
  bucket.qty += qty;
  if (receipt.lotNo) bucket.lots.add(receipt.lotNo);
  if (receipt.hold) bucket.holdCount += 1;
  if (receipt.weightPerContainer && receipt.containerUnit && !bucket.displayUnit) {
    bucket.displayUnit = receipt.containerUnit;
    bucket.displayFactor = Number(receipt.weightPerContainer) || 1;
  }
  node._products.set(key, bucket);
};

const buildTree = ({ locationsTree, storageAreas, receipts, productsById }) => {
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
        const rowNode = makeNode(
          row.id,
          row.name,
          'row',
          loc.id,
          sub.id,
          row.palletCapacity ? {
            occupiedPallets: Number(row.occupiedPallets || 0),
            total: Number(row.palletCapacity || 0),
          } : null,
          row.productId || null,
          Number(row.occupiedCases || 0),
        );
        subNode.children.push(rowNode);
        rowById[row.id] = rowNode;
      }
    }
  }

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
      const rowNode = makeNode(
        row.id,
        row.name,
        'row',
        parentLoc.id,
        area.id,
        row.palletCapacity ? {
          occupiedPallets: Number(row.occupiedPallets || 0),
          total: Number(row.palletCapacity || 0),
        } : null,
        row.productId || null,
        Number(row.occupiedCases || 0),
      );
      areaNode.children.push(rowNode);
      rowById[row.id] = rowNode;
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
          addProductToNode(rowNode, receipt, Number(a.cases) || 0, productsById);
          placed = true;
        }
      }
    }

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

  // Roll up totals from leaves to roots
  const rollup = (node) => {
    let qty = 0;
    let descendantQty = 0;
    const lots = new Set();
    let holdCount = 0;
    let productCount = 0;

    for (const p of node._products.values()) {
      qty += p.qty;
      p.lots.forEach((l) => lots.add(l));
      holdCount += p.holdCount;
      productCount += 1;
    }

    for (const child of node.children) {
      rollup(child);
      descendantQty += child.qty + child.descendantQty;
      child._lotSet?.forEach((l) => lots.add(l));
      holdCount += child.holdCount;
      productCount += child.productCount;
    }

    node.qty = qty;
    node.descendantQty = descendantQty;
    node._lotSet = lots;
    node.lotCount = lots.size;
    node.holdCount = holdCount;
    node.productCount = productCount;

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

// ─── Tree filter ──────────────────────────────────────────────────────────────

const cloneNodeShallow = (n) => ({
  ...n,
  children: [],
});

const filterTree = (tree, { locationFilter, occupancyFilter, productFilter, searchTerm }) => {
  const matchesProduct = (node) => {
    if (productFilter === 'all') return true;
    if (node.products.some((p) => p.productId === productFilter)) return true;
    if (node.declaredProductId === productFilter) return true;
    return node.children.some(matchesProduct);
  };

  const matchesSearch = (node) => {
    if (!searchTerm) return true;
    if ((node.name || '').toLowerCase().includes(searchTerm)) return true;
    if (node.products.some((p) => (p.name || '').toLowerCase().includes(searchTerm))) return true;
    return node.children.some(matchesSearch);
  };

  const passesOccupancy = (node) => {
    const occupied = node.qty > 0 || node.descendantQty > 0;
    if (occupancyFilter === 'all') return true;
    if (occupancyFilter === 'occupied') return occupied;
    if (occupancyFilter === 'empty') {
      // Only meaningful for rows
      if (node.type === 'row') return !occupied;
      return true;
    }
    if (occupancyFilter === 'near-capacity') {
      if (node.type !== 'row') return true;
      if (!node.capacity || node.capacity.total <= 0) return false;
      return (node.capacity.occupiedPallets / node.capacity.total) > 0.8;
    }
    return true;
  };

  const passesLocationFilter = (node) => {
    if (locationFilter === 'all') return true;
    if (node.id === locationFilter) return true;
    if (node.parentLocId === locationFilter) return true;
    if (node.parentSubId === locationFilter) return true;
    return false;
  };

  const filterNode = (node, locationFilterPassedByAncestor = false) => {
    const locOK = locationFilterPassedByAncestor || passesLocationFilter(node);
    if (!locOK) {
      // see if any descendant satisfies the filter
      const matchingChildren = node.children
        .map((c) => filterNode(c, false))
        .filter(Boolean);
      if (matchingChildren.length === 0) return null;
      const clone = cloneNodeShallow(node);
      clone.children = matchingChildren;
      return clone;
    }

    if (!matchesProduct(node)) return null;
    if (!matchesSearch(node)) return null;
    if (!passesOccupancy(node)) {
      // even if this row fails occupancy, it has no children, so drop
      if (node.children.length === 0) return null;
      // for sub/loc nodes, recursive check on children
      const matchingChildren = node.children
        .map((c) => filterNode(c, true))
        .filter(Boolean);
      if (matchingChildren.length === 0) return null;
      const clone = cloneNodeShallow(node);
      clone.children = matchingChildren;
      return clone;
    }

    const clone = cloneNodeShallow(node);
    clone.children = node.children
      .map((c) => filterNode(c, true))
      .filter(Boolean);

    // After filtering products: if node has no own qty, no children, and product filter is set, drop
    if (productFilter !== 'all' && clone.children.length === 0 && !node.products.some((p) => p.productId === productFilter)) {
      if (node.declaredProductId !== productFilter) return null;
    }

    // Hide totally empty branches (no products and no children) unless occupancy=all/empty
    if (clone.children.length === 0 && node.products.length === 0) {
      if (occupancyFilter === 'occupied' || occupancyFilter === 'near-capacity') return null;
    }

    return clone;
  };

  return tree.map((n) => filterNode(n, false)).filter(Boolean);
};

const collectAllIds = (tree) => {
  const out = new Set();
  const walk = (n) => {
    out.add(n.id);
    n.children.forEach(walk);
  };
  tree.forEach(walk);
  return out;
};

// ─── Render helpers ───────────────────────────────────────────────────────────

const ProductLine = ({ product, depth }) => {
  const paddingLeft = 16 + (depth + 1) * 22 + 18;
  const displayQty = product.displayUnit
    ? product.qty / product.displayFactor
    : product.qty;
  const displayUnit = product.displayUnit || product.unit;
  return (
    <div className="loc-tree-product" style={{ paddingLeft }}>
      <span className="loc-tree-product-name">{product.name}</span>
      {product.holdCount > 0 && (
        <span className="tag tag-hold loc-tree-tag">{product.holdCount} hold</span>
      )}
      <span className="loc-tree-product-meta muted">
        {product.lots.length} lot{product.lots.length !== 1 ? 's' : ''}
      </span>
      <span className="loc-tree-product-qty">
        {displayQty.toLocaleString(undefined, { maximumFractionDigits: 2 })} {displayUnit}
        {product.displayUnit && (
          <span className="muted small"> ({Math.round(product.qty).toLocaleString()} {product.unit})</span>
        )}
      </span>
    </div>
  );
};

const CapacityBar = ({ capacity }) => {
  if (!capacity || capacity.total <= 0) return null;
  const pct = Math.min((capacity.occupiedPallets / capacity.total) * 100, 100);
  const color = pct > 80 ? '#ef4444' : pct > 60 ? '#f59e0b' : '#22c55e';
  return (
    <span className="loc-tree-cap">
      <span className="muted small">{capacity.occupiedPallets}/{capacity.total} pallets</span>
      <span className="loc-tree-cap-bar">
        <span className="loc-tree-cap-fill" style={{ width: `${pct}%`, background: color }} />
      </span>
    </span>
  );
};

const TYPE_BADGE = {
  'sub-rm': null,
  'sub-fg': 'FG',
};

const TreeNode = ({ node, depth, collapsedIds, onToggle }) => {
  const collapsed = collapsedIds.has(node.id);
  const hasContent = node.children.length > 0 || node.products.length > 0;
  const paddingLeft = 16 + depth * 22;
  const occupied = node.qty > 0 || node.descendantQty > 0;

  return (
    <>
      <div
        className={`loc-tree-row loc-tree-row-${node.type} ${occupied ? '' : 'is-empty'} ${node.holdCount > 0 ? 'has-hold' : ''}`}
        style={{ paddingLeft }}
      >
        {hasContent ? (
          <button
            type="button"
            className="loc-tree-disclosure"
            onClick={() => onToggle(node.id)}
            aria-label={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? '▸' : '▾'}
          </button>
        ) : (
          <span className="loc-tree-disclosure loc-tree-disclosure-leaf">·</span>
        )}
        <span className="loc-tree-name">{node.name}</span>
        {TYPE_BADGE[node.type] && (
          <span className={`tag loc-tree-tag tag-${node.type}`}>{TYPE_BADGE[node.type]}</span>
        )}
        <span className="loc-tree-meta muted">
          {node.productCount > 0 && (
            <>
              {node.productCount} product{node.productCount !== 1 ? 's' : ''}
              {node.lotCount > 0 && <> · {node.lotCount} lot{node.lotCount !== 1 ? 's' : ''}</>}
            </>
          )}
          {node.productCount === 0 && node.type === 'row' && 'empty'}
        </span>
        {node.holdCount > 0 && (
          <span className="tag tag-hold loc-tree-tag">{node.holdCount} hold</span>
        )}
        {node.capacity && <CapacityBar capacity={node.capacity} />}
      </div>

      {!collapsed && node.products.map((p) => (
        <ProductLine key={`${node.id}-${p.productId}`} product={p} depth={depth} />
      ))}

      {!collapsed && node.children.map((c) => (
        <TreeNode
          key={c.id}
          node={c}
          depth={depth + 1}
          collapsedIds={collapsedIds}
          onToggle={onToggle}
        />
      ))}
    </>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────

const LocationsTab = ({
  locationsTree,
  receipts,
  productsById,
  storageAreas,
  productOptions,
}) => {
  const [locationFilter, setLocationFilter] = useState("all");
  const [occupancyFilter, setOccupancyFilter] = useState("occupied");
  const [productFilter, setProductFilter] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [collapsedIds, setCollapsedIds] = useState(() => new Set());

  const locationOptions = useMemo(() => {
    const options = [{ value: 'all', label: 'All Locations' }];
    locationsTree.forEach((loc) => {
      options.push({ value: loc.id, label: loc.name });
      (loc.subLocations || []).forEach((sub) => {
        options.push({ value: sub.id, label: `  └ ${sub.name}` });
      });
    });
    storageAreas.forEach((area) => {
      const loc = locationsTree.find((l) => l.id === area.locationId);
      const prefix = loc ? `${loc.name} / ` : '';
      options.push({ value: area.id, label: `  └ ${prefix}${area.name} (FG)` });
    });
    return options;
  }, [locationsTree, storageAreas]);

  const tree = useMemo(
    () => buildTree({ locationsTree, storageAreas, receipts, productsById }),
    [locationsTree, storageAreas, receipts, productsById],
  );

  const filteredTree = useMemo(
    () => filterTree(tree, {
      locationFilter,
      occupancyFilter,
      productFilter,
      searchTerm: searchTerm.toLowerCase().trim(),
    }),
    [tree, locationFilter, occupancyFilter, productFilter, searchTerm],
  );

  const totalNodes = useMemo(() => {
    let count = 0;
    const walk = (n) => { count += 1; n.children.forEach(walk); };
    filteredTree.forEach(walk);
    return count;
  }, [filteredTree]);

  const toggle = (id) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const expandAll = () => setCollapsedIds(new Set());
  const collapseAll = () => setCollapsedIds(collectAllIds(filteredTree));
  const clearFilters = () => {
    setLocationFilter('all');
    setOccupancyFilter('occupied');
    setProductFilter('all');
    setSearchTerm('');
  };

  return (
    <>
      <section className="panel">
        <div className="panel-header">
          <h2>Location Explorer</h2>
          <span className="muted">
            Drill into any warehouse to see what each row holds. Empty rows are hidden by default.
          </span>
        </div>
        <div className="filters location-filters">
          <label>
            <span>Location</span>
            <select value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)}>
              {locationOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Occupancy</span>
            <select value={occupancyFilter} onChange={(e) => setOccupancyFilter(e.target.value)}>
              <option value="occupied">Occupied</option>
              <option value="all">All (incl. empty)</option>
              <option value="empty">Empty rows only</option>
              <option value="near-capacity">Rows &gt;80% full</option>
            </select>
          </label>
          <label>
            <span>Product</span>
            <select value={productFilter} onChange={(e) => setProductFilter(e.target.value)}>
              <option value="all">All Products</option>
              {productOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <div className="location-search-bar">
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search location, row or product…"
            />
          </div>
          <button type="button" className="loc-tree-btn" onClick={expandAll}>Expand all</button>
          <button type="button" className="loc-tree-btn" onClick={collapseAll}>Collapse all</button>
          <button type="button" className="loc-tree-btn loc-tree-btn-clear" onClick={clearFilters}>Clear filters</button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h3>
            Inventory by Location <span className="count-badge">{totalNodes}</span>
          </h3>
          <span className="muted">
            Includes approved raw materials, packaging, and finished goods
          </span>
        </div>
        <div className="loc-tree">
          {filteredTree.length === 0 ? (
            <div className="muted" style={{ padding: 16 }}>
              No locations match the current filters.
            </div>
          ) : (
            filteredTree.map((loc) => (
              <TreeNode
                key={loc.id}
                node={loc}
                depth={0}
                collapsedIds={collapsedIds}
                onToggle={toggle}
              />
            ))
          )}
        </div>
      </section>
    </>
  );
};

export default LocationsTab;
