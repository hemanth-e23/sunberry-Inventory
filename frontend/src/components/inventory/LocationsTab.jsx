import React, { useState, useMemo } from "react";
import { RECEIPT_STATUS } from '../../constants';

const LocationsTab = ({
  locationsTree,
  receipts,
  productsById,
  locationLookup,
  storageAreas,
  productOptions,
}) => {
  const [locationFilter, setLocationFilter] = useState("all");
  const [areaFilter, setAreaFilter] = useState("all");
  const [occupancyFilter, setOccupancyFilter] = useState("all");
  const [locationProductFilter, setLocationProductFilter] = useState("all");
  const [locationSearch, setLocationSearch] = useState("");

  const locationOptions = useMemo(() => {
    const options = [{ value: "all", label: "All Locations" }];
    locationsTree.forEach((loc) => {
      options.push({ value: loc.id, label: loc.name, parentId: null });
      loc.subLocations.forEach((sub) => {
        options.push({
          value: sub.id,
          label: `${loc.name} / ${sub.name}`,
          parentId: loc.id,
        });
      });
    });
    return options;
  }, [locationsTree]);

  const areaOptions = useMemo(() => {
    const options = [{ value: "all", label: "All Areas" }];
    storageAreas.forEach((area) => {
      options.push({ value: area.id, label: area.name });
    });
    options.push({ value: "floor", label: "Floor Staging" });
    return options;
  }, [storageAreas]);

  const generalLocationData = useMemo(() => {
    const map = {};

    const ensureEntry = (id, name, parentId, parentName) => {
      if (!map[id]) {
        map[id] = {
          id,
          name,
          parentId,
          parentName,
          totalQuantity: 0,
          productsMap: new Map(),
        };
      }
      return map[id];
    };

    locationsTree.forEach((loc) => {
      ensureEntry(loc.id, loc.name, null, null);
      loc.subLocations.forEach((sub) => {
        ensureEntry(sub.id, sub.name, loc.id, loc.name);
      });
    });

    receipts
      .filter((receipt) => receipt.status === RECEIPT_STATUS.APPROVED)
      .forEach((receipt) => {
        const targetId = receipt.subLocation || receipt.location;
        if (!targetId) return;

        const lookupEntry = locationLookup[targetId];
        const parentName = lookupEntry?.parentId
          ? locationLookup[lookupEntry.parentId]?.name || null
          : null;
        const entry = ensureEntry(
          targetId,
          lookupEntry?.name || targetId,
          lookupEntry?.parentId || null,
          parentName,
        );

        const product = productsById[receipt.productId];
        const qty = Number(receipt.quantity) || 0;
        entry.totalQuantity += qty;

        const productEntry = entry.productsMap.get(receipt.productId) || {
          productId: receipt.productId,
          name: product?.name || "Unknown product",
          totalQuantity: 0,
          lots: new Set(),
          holdCount: 0,
        };
        productEntry.totalQuantity += qty;
        if (receipt.lotNo) {
          productEntry.lots.add(receipt.lotNo);
        }
        if (receipt.hold) {
          productEntry.holdCount += 1;
        }
        entry.productsMap.set(receipt.productId, productEntry);
      });

    return Object.values(map)
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        parentId: entry.parentId,
        parentName: entry.parentName,
        totalQuantity: entry.totalQuantity,
        products: Array.from(entry.productsMap.values()).map((product) => ({
          ...product,
          lots: Array.from(product.lots),
        })),
      }))
      .sort((a, b) => {
        const labelA = `${a.parentName || ""} ${a.name}`.trim().toLowerCase();
        const labelB = `${b.parentName || ""} ${b.name}`.trim().toLowerCase();
        return labelA.localeCompare(labelB);
      });
  }, [locationsTree, receipts, productsById, locationLookup]);

  const finishedRowsData = useMemo(() => {
    const rows = [];
    storageAreas.forEach((area) => {
      area.rows.forEach((row) => {
        rows.push({
          areaId: area.id,
          areaName: area.name,
          allowFloorStorage: area.allowFloorStorage,
          rowId: row.id,
          rowName: row.name,
          palletCapacity: row.palletCapacity,
          occupiedPallets: Number(row.occupiedPallets || 0),
          occupiedCases: Number(row.occupiedCases || 0),
          defaultCasesPerPallet:
            row.defaultCasesPerPallet ?? (row.productId ? (productsById[row.productId]?.defaultCasesPerPallet ?? null) : null),
          productId: row.productId || null,
          productName: row.productId
            ? productsById[row.productId]?.name || "Unknown product"
            : null,
          hold: Boolean(row.hold),
        });
      });
    });

    const floorMap = {};
    receipts
      .filter((receipt) => receipt.status === RECEIPT_STATUS.APPROVED)
      .forEach((receipt) => {
        const floor = receipt.allocation?.floorAllocation;
        if (floor && (floor.pallets > 0 || floor.cases > 0)) {
          const key = receipt.productId;
          const existing = floorMap[key] || {
            areaId: "floor",
            areaName: "Floor Staging",
            rowId: `floor-${key}`,
            rowName: productsById[key]?.name
              ? `${productsById[key].name} Floor`
              : "Floor",
            palletCapacity: null,
            occupiedPallets: 0,
            occupiedCases: 0,
            defaultCasesPerPallet:
              productsById[key]?.defaultCasesPerPallet ?? receipt.casesPerPallet ?? null,
            productId: receipt.productId,
            productName: productsById[key]?.name || "Unknown product",
            hold: Boolean(receipt.hold),
          };
          existing.occupiedPallets += Number(floor.pallets) || 0;
          existing.occupiedCases += Number(floor.cases) || 0;
          floorMap[key] = existing;
        }
      });

    return [...rows, ...Object.values(floorMap)];
  }, [storageAreas, receipts, productsById]);

  const filteredGeneralLocations = useMemo(() => {
    return generalLocationData
      .map((location) => {
        const matchesProduct = locationProductFilter === "all"
          ? location.products
          : location.products.filter(
            (product) => product.productId === locationProductFilter,
          );

        const productUnitMap = {};
        receipts
          .filter(r => r.status === RECEIPT_STATUS.APPROVED)
          .forEach(r => {
            if (!productUnitMap[r.productId] && r.quantityUnits) {
              productUnitMap[r.productId] = r.quantityUnits;
            }
          });

        return {
          ...location,
          displayProducts: matchesProduct.map(p => ({
            ...p,
            quantityUnits: productUnitMap[p.productId] || 'units'
          })),
        };
      })
      .filter((location) => {
        const inSelectedLocation =
          locationFilter === "all" ||
          location.id === locationFilter ||
          location.parentId === locationFilter;
        if (!inSelectedLocation) return false;

        if (occupancyFilter === "empty") {
          return location.totalQuantity === 0;
        }
        if (occupancyFilter === "occupied") {
          if (location.totalQuantity === 0) return false;
        }
        if (occupancyFilter === "near-capacity") {
          return location.totalQuantity > 0;
        }

        if (
          locationProductFilter !== "all" &&
          location.displayProducts.length === 0
        ) {
          return false;
        }

        if (locationSearch) {
          const needle = locationSearch.toLowerCase();
          const locationName = (
            location.parentName
              ? `${location.parentName} / ${location.name}`
              : location.name
          ).toLowerCase();
          const hasMatchingProduct = location.displayProducts.some(p =>
            (p.name || "").toLowerCase().includes(needle)
          );
          if (!locationName.includes(needle) && !hasMatchingProduct) return false;
        }

        return location.totalQuantity > 0 || location.displayProducts.length > 0;
      });
  }, [
    generalLocationData,
    locationFilter,
    locationProductFilter,
    occupancyFilter,
    locationSearch,
    receipts,
  ]);

  const filteredFinishedRows = useMemo(() => {
    return finishedRowsData.filter((row) => {
      if (areaFilter !== "all") {
        if (areaFilter === "floor" && row.areaId !== "floor") return false;
        if (areaFilter !== "floor" && row.areaId !== areaFilter) return false;
      }

      if (occupancyFilter === "empty") {
        if (row.occupiedPallets > 0 || row.occupiedCases > 0) return false;
      } else if (occupancyFilter === "occupied") {
        if (row.occupiedPallets === 0 && row.occupiedCases === 0) return false;
      } else if (occupancyFilter === "near-capacity") {
        const pct = row.palletCapacity > 0 ? row.occupiedPallets / row.palletCapacity : 0;
        if (pct <= 0.8) return false;
      } else {
        if (!row.productId && row.areaId !== "floor") {
          if (row.occupiedPallets === 0 && row.occupiedCases === 0) {
            return false;
          }
        }
      }

      if (locationProductFilter !== "all") {
        if (row.productId !== locationProductFilter) {
          if (!(occupancyFilter === "empty" && !row.productId)) {
            return false;
          }
        }
      }

      if (locationSearch) {
        const needle = locationSearch.toLowerCase();
        const areaRow = `${row.areaName || ""} ${row.rowName || ""}`.toLowerCase();
        const product = (row.productName || "").toLowerCase();
        if (!areaRow.includes(needle) && !product.includes(needle)) return false;
      }

      return true;
    });
  }, [finishedRowsData, areaFilter, locationProductFilter, occupancyFilter, locationSearch]);

  return (
    <>
      <section className="panel">
        <div className="panel-header">
          <h2>Location Explorer</h2>
          <span className="muted">
            Inspect availability by warehouse zone or finished-goods rack
          </span>
        </div>
        <div className="filters location-filters">
          <label>
            <span>Warehouse Location</span>
            <select
              value={locationFilter}
              onChange={(event) => setLocationFilter(event.target.value)}
            >
              {locationOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Finished Goods Area</span>
            <select
              value={areaFilter}
              onChange={(event) => setAreaFilter(event.target.value)}
            >
              {areaOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Product / Flavor</span>
            <select
              value={locationProductFilter}
              onChange={(event) =>
                setLocationProductFilter(event.target.value)
              }
            >
              <option value="all">All Products</option>
              {productOptions.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Occupancy</span>
            <select
              value={occupancyFilter}
              onChange={(event) => setOccupancyFilter(event.target.value)}
            >
              <option value="all">All</option>
              <option value="occupied">Occupied</option>
              <option value="empty">Empty slots only</option>
              <option value="near-capacity">Near capacity (&gt;80%)</option>
            </select>
          </label>
          <div className="location-search-bar">
            <input
              type="text"
              value={locationSearch}
              onChange={(event) => setLocationSearch(event.target.value)}
              placeholder="Search location or product…"
            />
          </div>
          <button
            className="clear-filters-btn"
            onClick={() => {
              setLocationFilter("all");
              setAreaFilter("all");
              setLocationProductFilter("all");
              setOccupancyFilter("all");
              setLocationSearch("");
            }}
          >
            Clear Filters
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h3>Warehouse Locations <span className="count-badge">{filteredGeneralLocations.length}</span></h3>
          <span className="muted">
            Totals include approved raw and packaging materials
          </span>
        </div>
        <div className="table-wrapper">
          <table className="simple-table enhanced-table">
            <thead>
              <tr>
                <th>Location</th>
                <th>Product</th>
                <th>Lots</th>
                <th style={{ textAlign: 'right' }}>Quantity</th>
              </tr>
            </thead>
            <tbody>
              {filteredGeneralLocations.map((location) => (
                location.displayProducts.length ? (
                  location.displayProducts.map(product => (
                    <tr key={`${location.id}-${product.productId}`}>
                      <td>
                        {location.parentName
                          ? `${location.parentName} / ${location.name}`
                          : location.name}
                      </td>
                      <td>
                        <strong>{product.name}</strong>
                        {product.holdCount > 0 && (
                          <span className="tag tag-hold" style={{ marginLeft: 6 }}>{product.holdCount} hold</span>
                        )}
                      </td>
                      <td className="muted">
                        {product.lots.length ? (
                          <span title={product.lots.join(', ')}>
                            {product.lots.length} lot{product.lots.length !== 1 ? 's' : ''}
                          </span>
                        ) : '—'}
                      </td>
                      <td style={{ textAlign: 'right' }}>{product.totalQuantity.toLocaleString()} {product.quantityUnits}</td>
                    </tr>
                  ))
                ) : (
                  <tr key={`${location.id}-empty`}>
                    <td>
                      {location.parentName
                        ? `${location.parentName} / ${location.name}`
                        : location.name}
                    </td>
                    <td colSpan={2} className="muted">No product stored</td>
                    <td style={{ textAlign: 'right' }}>0</td>
                  </tr>
                )
              ))}
              {!filteredGeneralLocations.length && (
                <tr>
                  <td colSpan={4} className="muted">No locations match the current filters.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h3>Finished Goods Rows <span className="count-badge">{filteredFinishedRows.length}</span></h3>
          <span className="muted">
            Capacity includes pallet and case occupancy for racks and floor staging
          </span>
        </div>
        <div className="table-wrapper">
          <table className="simple-table enhanced-table">
            <thead>
              <tr>
                <th>Area / Row</th>
                <th style={{ textAlign: 'right' }}>Pallets</th>
                <th>Product</th>
                <th style={{ textAlign: 'right' }}>Cases</th>
                <th style={{ textAlign: 'right' }}>Cases / Pallet</th>
              </tr>
            </thead>
            <tbody>
              {filteredFinishedRows.map((row) => (
                <tr key={row.rowId} className={row.hold ? 'on-hold' : ''}>
                  <td>{row.areaName}{row.rowName ? ` / ${row.rowName}` : ''}</td>
                  <td style={{ textAlign: 'right' }}>
                    {row.palletCapacity > 0 ? (() => {
                      const pct = Math.min((row.occupiedPallets / row.palletCapacity) * 100, 100);
                      const barColor = pct > 80 ? '#ef4444' : pct > 60 ? '#f59e0b' : '#22c55e';
                      return (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                          <span>{row.occupiedPallets}/{row.palletCapacity}</span>
                          <div style={{ width: 40, height: 6, background: '#e5e7eb', borderRadius: 3, overflow: 'hidden' }}>
                            <div style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: 3 }} />
                          </div>
                        </div>
                      );
                    })() : row.occupiedPallets}
                  </td>
                  <td>{row.productName || <span className="muted">Empty slot</span>}</td>
                  <td style={{ textAlign: 'right' }}>{row.productName ? row.occupiedCases.toLocaleString() : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{row.defaultCasesPerPallet || '—'}</td>
                </tr>
              ))}
              {!filteredFinishedRows.length && (
                <tr>
                  <td colSpan={5} className="muted">No finished-goods rows match the current filters.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
};

export default LocationsTab;
