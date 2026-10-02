import React, { useState, useMemo } from "react";
import { describeContainers } from '../../utils/rowSources';
import { buildTree } from '../../utils/locationTree';

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
        {describeContainers({
          displayFactor: product.displayFactor, displayUnit, unit: product.unit,
          fullUnits: product.fullUnits, openUnits: product.openUnits, openQty: product.openQty,
          grossWeight: product.qty,
        }, product.qty)
          ?? `${displayQty.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${displayUnit}`}
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
      <span className="muted small">{capacity.occupiedPallets}/{capacity.total} {capacity.unit || 'pallets'}</span>
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
  const [occupancyFilter, setOccupancyFilter] = useState("all");
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
