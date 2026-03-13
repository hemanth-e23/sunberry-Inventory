import React, { useMemo, useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAppData } from "../context/AppDataContext";
import { useAuth } from "../context/AuthContext";
import { getDashboardPath } from "../App";
import apiClient from "../api/client";
import { formatDateTime as formatDate } from "../utils/dateUtils";
import "./Shared.css";
import "./InventoryOverview.css";
import { CATEGORY_TYPES, RECEIPT_STATUS } from '../constants';

import RecentEntriesTab from "./inventory/RecentEntriesTab";
import InventoryDashboard from "./inventory/InventoryDashboard";
import InventoryFilters from "./inventory/InventoryFilters";
import InventoryTable from "./inventory/InventoryTable";
import ProductDetailModal from "./inventory/ProductDetailModal";
import PrintReportModal from "./inventory/PrintReportModal";
import LocationsTab from "./inventory/LocationsTab";

const parseDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
};

const toDateKey = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
};

const getLocationLabel = (lookup, locationId, subLocationId) => {
  const locationEntry = locationId ? lookup[locationId] : null;
  const subEntry = subLocationId ? lookup[subLocationId] : null;

  if (subEntry) {
    const parentName = subEntry.parentId
      ? lookup[subEntry.parentId]?.name || ""
      : locationEntry?.name || "";
    return parentName
      ? `${parentName} / ${subEntry.name}`
      : subEntry.name;
  }

  if (locationEntry) {
    return locationEntry.name;
  }

  return null;
};

const InventoryOverview = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const {
    products,
    activeReceipts: receipts,
    productCategories,
    categoryGroups,
    users,
    locationLookup,
    locationsTree,
    storageAreas,
    locations,
  } = useAppData();

  // Tab state
  const [activeTab, setActiveTab] = useState("inventory");

  // Inventory tab filter state (shared between InventoryFilters and inventoryRows computation)
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [holdFilter, setHoldFilter] = useState("all");
  const [sortOption, setSortOption] = useState("recent");
  const [searchTerm] = useState("");
  const [productFilter, setProductFilter] = useState("all");

  const [inventoryStartDate, setInventoryStartDate] = useState("");
  const [inventoryEndDate, setInventoryEndDate] = useState("");
  const [showZeroInventory, setShowZeroInventory] = useState(false);
  const [detailProductId, setDetailProductId] = useState(null);

  // Advanced filters
  const [expiryStartDate, setExpiryStartDate] = useState("");
  const [expiryEndDate, setExpiryEndDate] = useState("");
  const [quantityThreshold, setQuantityThreshold] = useState("");
  const [quantityOperator, setQuantityOperator] = useState("above");
  const [_supplierFilter] = useState("all");
  const [ageFilter, setAgeFilter] = useState("all");

  // Smart search
  const [smartSearchTerm, setSmartSearchTerm] = useState("");
  const [searchFields, setSearchFields] = useState(["name", "sid", "fcc", "lot"]);

  // Print modal
  const [showPrintModal, setShowPrintModal] = useState(false);

  // Lookups
  const productsById = useMemo(() => {
    const map = {};
    products.forEach((product) => {
      map[product.id] = product;
    });
    return map;
  }, [products]);

  const categoriesById = useMemo(() => {
    const map = {};
    productCategories.forEach((category) => {
      map[category.id] = category;
    });
    return map;
  }, [productCategories]);

  const userLookup = useMemo(() => {
    const map = {};
    users.forEach((user) => {
      const label = user.name || user.username;
      map[user.id] = label;
      map[user.username] = label;
    });
    return map;
  }, [users]);

  const productOptions = useMemo(
    () => products.filter((product) => product.status === "active"),
    [products],
  );

  // Row name cache for rows not found in locations structure
  const [rowNameCache, setRowNameCache] = useState({});

  // Row lookup: get row name from storageRowId
  const rowLookup = useMemo(() => {
    const map = { ...rowNameCache };
    locations?.forEach((location) => {
      location.subLocations?.forEach((subLoc) => {
        subLoc.rows?.forEach((row) => {
          if (row.id && row.name) {
            map[row.id] = row.name;
          }
        });
      });
    });
    storageAreas?.forEach((area) => {
      area.rows?.forEach((row) => {
        if (row.id && row.name) {
          map[row.id] = row.name;
        }
      });
    });
    return map;
  }, [locations, storageAreas, rowNameCache]);

  // Helper function to fetch row name from backend if not in lookup
  const fetchRowName = useCallback(async (rowId) => {
    if (!rowId || rowNameCache[rowId]) return rowNameCache[rowId];

    try {
      const response = await apiClient.get(`/master-data/storage-rows/${rowId}`);

      if (response.data?.name) {
        setRowNameCache(prev => ({ ...prev, [rowId]: response.data.name }));
        return response.data.name;
      }
    } catch (error) {
      console.warn(`Failed to fetch row name for ${rowId}:`, error);
    }
    return null;
  }, [rowNameCache]);

  // Pre-fetch row names for receipts that have storageRowId but no name in lookup
  useEffect(() => {
    const missingRowIds = new Set();

    receipts.forEach(receipt => {
      if (receipt.storageRowId || receipt.storage_row_id) {
        const rowId = receipt.storageRowId || receipt.storage_row_id;
        if (rowId && !rowLookup[rowId] && !rowNameCache[rowId]) {
          missingRowIds.add(rowId);
        }
      }
      if (receipt.rawMaterialRowAllocations && Array.isArray(receipt.rawMaterialRowAllocations)) {
        receipt.rawMaterialRowAllocations.forEach(alloc => {
          if (alloc.rowId && !rowLookup[alloc.rowId] && !rowNameCache[alloc.rowId]) {
            missingRowIds.add(alloc.rowId);
          }
        });
      }
    });

    if (missingRowIds.size > 0) {
      missingRowIds.forEach(rowId => {
        fetchRowName(rowId);
      });
    }
  }, [receipts, rowLookup, rowNameCache, fetchRowName]);

  const getReceiptLocations = useCallback((receipt) => {
    const category = productCategories.find(c => c.id === receipt.categoryId);
    const isFinishedGood = category?.type === CATEGORY_TYPES.FINISHED;

    let allocation = receipt?.allocation;
    if (allocation && typeof allocation === 'string') {
      try {
        allocation = JSON.parse(allocation);
      } catch (e) {
        console.error('Failed to parse allocation JSON:', e);
        allocation = null;
      }
    }

    if (allocation && (allocation.success || allocation.plan)) {
      const plan = allocation.plan || [];

      if (isFinishedGood && plan.length > 0) {
        const areaGroups = {};
        plan.forEach((item) => {
          if (item.areaName) {
            if (!areaGroups[item.areaName]) {
              areaGroups[item.areaName] = [];
            }
            if (item.rowName && item.pallets) {
              areaGroups[item.areaName].push({
                rowName: item.rowName,
                pallets: item.pallets
              });
            }
          }
        });

        const formattedLabels = Object.keys(areaGroups).map(areaName => {
          const rows = areaGroups[areaName];
          if (rows.length > 0) {
            const rowStrings = rows.map(r => {
              const palletCount = Number(r.pallets) || 0;
              const palletDisplay = palletCount % 1 === 0 ? palletCount : palletCount.toFixed(2);
              return `${r.rowName} (${palletDisplay} pallets)`;
            });
            return `${areaName}: ${rowStrings.join(', ')}`;
          }
          return areaName;
        });

        const planSpots = formattedLabels.map(label => ({
          label,
          detail: ""
        }));

        const floor = allocation.floorAllocation;
        if (floor && (floor.pallets > 0 || floor.cases > 0)) {
          planSpots.push({
            label: "Floor Staging",
            detail: `${floor.pallets} pallets · ${floor.cases} cases`,
          });
        }

        if (planSpots.length) {
          return planSpots;
        }
      } else {
        const planSpots = plan.map((item) => ({
          label: `${item.areaName}${item.rowName ? ` / ${item.rowName}` : ""}`,
          detail: `${item.pallets} pallets · ${item.cases} cases`,
        }));
        const floor = allocation.floorAllocation;
        if (floor && (floor.pallets > 0 || floor.cases > 0)) {
          planSpots.push({
            label: "Floor Staging",
            detail: `${floor.pallets} pallets · ${floor.cases} cases`,
          });
        }
        if (planSpots.length) {
          return planSpots;
        }
      }
    }

    let effectiveSubLocation = receipt?.subLocation;
    if (!effectiveSubLocation && (receipt?.storageRowId || receipt?.storage_row_id)) {
      const rowId = receipt.storageRowId || receipt.storage_row_id;
      for (const loc of (locationsTree || [])) {
        for (const sub of (loc.subLocations || [])) {
          if ((sub.rows || []).some(r => r.id === rowId)) {
            effectiveSubLocation = sub.id;
            break;
          }
        }
        if (effectiveSubLocation) break;
      }
    }

    const label = getLocationLabel(
      locationLookup,
      receipt?.location,
      effectiveSubLocation,
    );

    const rowInfo = [];

    if (receipt.rawMaterialRowAllocations && Array.isArray(receipt.rawMaterialRowAllocations)) {
      receipt.rawMaterialRowAllocations.forEach(alloc => {
        const rowName = rowLookup[alloc.rowId] || alloc.rowName || alloc.rowId;
        const pallets = alloc.pallets || 0;
        if (rowName) {
          rowInfo.push(`${rowName}${pallets > 0 ? ` (${pallets} pallets)` : ''}`);
        }
      });
    }
    else if (receipt.storageRowId || receipt.storage_row_id) {
      const rowId = receipt.storageRowId || receipt.storage_row_id;
      const rowName = rowLookup[rowId] || rowNameCache[rowId];
      const pallets = receipt.pallets || 0;
      if (rowName) {
        rowInfo.push(`${rowName}${pallets > 0 ? ` (${pallets} pallets)` : ''}`);
      }
    }

    if (label) {
      const detail = rowInfo.length > 0 ? `Row${rowInfo.length > 1 ? 's' : ''}: ${rowInfo.join(', ')}` : "";
      return [{ label, detail }];
    }
    return [];
  }, [productCategories, locationsTree, locationLookup, rowLookup, rowNameCache]);

  // Inventory rows computation (needed by the table and print modal)
  const inventoryRows = useMemo(() => {
    const totals = {};
    const pendingCount = {};
    const productReceiptsMap = {};

    const startKey = inventoryStartDate ? inventoryStartDate : null;
    const endKey = inventoryEndDate ? inventoryEndDate : null;

    const isWithinRange = (receipt) => {
      if (!startKey && !endKey) return true;
      const key =
        toDateKey(receipt.approvedAt) ||
        toDateKey(receipt.submittedAt) ||
        toDateKey(receipt.receiptDate);
      if (!key) return false;
      if (startKey && key < startKey) return false;
      if (endKey && key > endKey) return false;
      return true;
    };

    receipts.forEach((receipt) => {
      if (!isWithinRange(receipt)) return;
      const productId = receipt.productId;
      if (!productReceiptsMap[productId]) {
        productReceiptsMap[productId] = [];
      }
      productReceiptsMap[productId].push(receipt);

      if (receipt.status === RECEIPT_STATUS.APPROVED) {
        if (!totals[productId]) {
          totals[productId] = { quantity: 0, lots: new Set() };
        }
        totals[productId].quantity += Number(receipt.quantity) || 0;
        if (receipt.lotNo) {
          totals[productId].lots.add(receipt.lotNo);
        }
      }

      if (["recorded", "pending", "reviewed"].includes(receipt.status)) {
        pendingCount[productId] = (pendingCount[productId] || 0) + 1;
      }
    });

    const term = searchTerm.trim().toLowerCase();

    const rows = products
      .filter((product) => showZeroInventory || product.status === "active")
      .filter(
        (product) =>
          selectedCategory === "all" || product.categoryId === selectedCategory,
      )
      .filter(
        (product) => productFilter === "all" || product.id === productFilter,
      )
      .filter((product) => {
        if (!term) return true;
        const haystack = `${product.name} ${product.description || ""}`
          .toLowerCase()
          .trim();
        return haystack.includes(term);
      })
      .map((product) => {
        const category = categoriesById[product.categoryId];
        const summary = totals[product.id] || { quantity: 0, lots: new Set() };
        const pending = pendingCount[product.id] || 0;
        const productReceipts = productReceiptsMap[product.id] || [];

        const lastSubmission = productReceipts.reduce((latest, current) => {
          const latestTime = latest
            ? parseDate(latest.submittedAt) || parseDate(latest.receiptDate) || -Infinity
            : -Infinity;
          const currentTime =
            parseDate(current.submittedAt) || parseDate(current.receiptDate) || -Infinity;
          return currentTime > latestTime ? current : latest;
        }, null);

        const lastApproval = productReceipts
          .filter((receipt) => receipt.status === RECEIPT_STATUS.APPROVED)
          .reduce((latest, current) => {
            const latestTime = latest ? parseDate(latest.approvedAt) || -Infinity : -Infinity;
            const currentTime = parseDate(current.approvedAt) || -Infinity;
            return currentTime > latestTime ? current : latest;
          }, null);

        const locationsData = lastApproval
          ? getReceiptLocations(lastApproval)
          : lastSubmission
            ? getReceiptLocations(lastSubmission)
            : [];

        const holdCount = productReceipts.filter((receipt) => receipt.hold).length;

        const quantityUnitLabel = (lastApproval?.quantityUnits || lastSubmission?.quantityUnits || (category?.type === CATEGORY_TYPES.FINISHED ? 'cases' : ''));

        const refReceipt = lastApproval || lastSubmission;
        let containerInfo = null;
        if (refReceipt?.containerCount && refReceipt?.containerUnit && refReceipt?.weightPerContainer && refReceipt?.weightUnit) {
          const currentContainers = refReceipt.weightPerContainer > 0
            ? Math.round((summary.quantity / refReceipt.weightPerContainer) * 100) / 100
            : refReceipt.containerCount;
          containerInfo = `≈ ${currentContainers.toLocaleString()} ${refReceipt.containerUnit} @ ${refReceipt.weightPerContainer.toLocaleString()} ${refReceipt.weightUnit} ea.`;
        }

        return {
          id: product.id,
          name: product.name,
          category: category?.name || "Unknown",
          type: category?.type || "-",
          quantity: summary.quantity,
          unitLabel: quantityUnitLabel,
          containerInfo,
          lotCount: summary.lots.size,
          pendingCount: pending,
          description: product.description,
          lastSubmittedBy:
            userLookup[lastSubmission?.submittedBy] ||
            lastSubmission?.submittedBy ||
            "—",
          lastSubmittedAt: formatDate(
            lastSubmission?.submittedAt || lastSubmission?.receiptDate,
          ),
          lastApprovedBy:
            userLookup[lastApproval?.approvedBy] || lastApproval?.approvedBy || "—",
          lastApprovedAt: formatDate(lastApproval?.approvedAt),
          lastEntryTimestamp:
            parseDate(lastApproval?.approvedAt) ||
            parseDate(lastSubmission?.submittedAt) ||
            parseDate(lastSubmission?.receiptDate) ||
            0,
          holdActive: holdCount > 0,
          holdLabel: holdCount > 0 ? `${holdCount} on hold` : "Clear",
          holdCount,
          locations: locationsData,
        };
      })
      .filter((row) => {
        if (holdFilter === "hold") return row.holdActive;
        if (holdFilter === "clear") return !row.holdActive;

        // Advanced filters
        if (expiryStartDate || expiryEndDate) {
          const pReceipts = productReceiptsMap[row.id] || [];
          const hasExpiringInRange = pReceipts.some(receipt => {
            if (!receipt.expiration) return false;
            const expiryDate = new Date(receipt.expiration);
            const startDate = expiryStartDate ? new Date(expiryStartDate) : null;
            const endDate = expiryEndDate ? new Date(expiryEndDate) : null;

            if (startDate && endDate) {
              return expiryDate >= startDate && expiryDate <= endDate;
            } else if (startDate) {
              return expiryDate >= startDate;
            } else if (endDate) {
              return expiryDate <= endDate;
            }
            return false;
          });
          if (!hasExpiringInRange) return false;
        }

        if (quantityThreshold) {
          const threshold = parseFloat(quantityThreshold);
          if (quantityOperator === "above" && row.quantity <= threshold) return false;
          if (quantityOperator === "below" && row.quantity >= threshold) return false;
          if (quantityOperator === "equal" && row.quantity !== threshold) return false;
        }

        if (ageFilter !== "all") {
          const daysSinceLastReceipt = row.lastEntryTimestamp ?
            Math.floor((Date.now() - row.lastEntryTimestamp) / (1000 * 60 * 60 * 24)) : Infinity;

          switch (ageFilter) {
            case "7days":
              if (daysSinceLastReceipt > 7) return false;
              break;
            case "30days":
              if (daysSinceLastReceipt > 30) return false;
              break;
            case "90days":
              if (daysSinceLastReceipt > 90) return false;
              break;
            case "older":
              if (daysSinceLastReceipt <= 90) return false;
              break;
            case "none":
              if (row.lastEntryTimestamp !== 0) return false;
              break;
          }
        }

        if (smartSearchTerm) {
          const searchLower = smartSearchTerm.toLowerCase();
          const product = productsById[row.id];

          let matches = false;
          if (searchFields.includes("name") && row.name.toLowerCase().includes(searchLower)) matches = true;
          if (searchFields.includes("sid") && product?.sid?.toLowerCase().includes(searchLower)) matches = true;
          if (searchFields.includes("fcc") && product?.fcc?.toLowerCase().includes(searchLower)) matches = true;
          if (searchFields.includes("lot") && row.locations.some(loc => loc.label.toLowerCase().includes(searchLower))) matches = true;

          if (!matches) return false;
        }

        return true;
      })
      .filter((row) => (showZeroInventory ? true : row.quantity > 0));

    const sorted = [...rows].sort((a, b) => {
      if (sortOption === "hold-first") {
        if (a.holdActive !== b.holdActive) return a.holdActive ? -1 : 1;
        return (b.lastEntryTimestamp || 0) - (a.lastEntryTimestamp || 0);
      }
      if (sortOption === "clear-first") {
        if (a.holdActive !== b.holdActive) return a.holdActive ? 1 : -1;
        return (b.lastEntryTimestamp || 0) - (a.lastEntryTimestamp || 0);
      }
      if (sortOption === "oldest") {
        return (a.lastEntryTimestamp || 0) - (b.lastEntryTimestamp || 0);
      }
      return (b.lastEntryTimestamp || 0) - (a.lastEntryTimestamp || 0);
    });

    return sorted;
  }, [
    products,
    receipts,
    categoriesById,
    productsById,
    selectedCategory,
    productFilter,
    searchTerm,
    holdFilter,
    sortOption,
    userLookup,
    inventoryStartDate,
    inventoryEndDate,
    showZeroInventory,
    expiryStartDate,
    expiryEndDate,
    quantityThreshold,
    quantityOperator,
    ageFilter,
    smartSearchTerm,
    searchFields,
    getReceiptLocations,
  ]);

  const categoryProductCounts = useMemo(() => {
    const counts = {};
    inventoryRows.forEach(row => {
      const product = productsById[row.id];
      if (product?.categoryId) {
        counts[product.categoryId] = (counts[product.categoryId] || 0) + 1;
      }
    });
    return counts;
  }, [inventoryRows, productsById]);

  return (
    <div className="inventory-page">
      <div className="page-header">
        <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
          ← Back to Dashboard
        </button>
      </div>

      <div className="tab-bar">
        <button
          type="button"
          className={`tab-button ${activeTab === "recent" ? "active" : ""}`}
          onClick={() => setActiveTab("recent")}
        >
          Recent Entries
        </button>
        <button
          type="button"
          className={`tab-button ${activeTab === "inventory" ? "active" : ""}`}
          onClick={() => setActiveTab("inventory")}
        >
          All Inventory
        </button>
        <button
          type="button"
          className={`tab-button ${activeTab === "locations" ? "active" : ""}`}
          onClick={() => setActiveTab("locations")}
        >
          By Location
        </button>
      </div>

      <div className="page-content">
        {activeTab === "recent" && (
          <RecentEntriesTab
            receipts={receipts}
            productsById={productsById}
            categoriesById={categoriesById}
            userLookup={userLookup}
            getReceiptLocations={getReceiptLocations}
          />
        )}

        {activeTab === "inventory" && (
          <>
            <section className="panel">
              <div className="panel-header">
                <h2>Inventory Overview</h2>
                <div className="panel-actions">
                  <select
                    value={selectedCategory}
                    onChange={(event) => setSelectedCategory(event.target.value)}
                  >
                    <option value="all">All Categories</option>
                    {categoryGroups.map((group) => (
                      <optgroup key={group.id} label={group.name}>
                        {productCategories
                          .filter((category) => category.parentId === group.id)
                          .map((category) => (
                            <option key={category.id} value={category.id}>
                              {category.name}{categoryProductCounts[category.id] !== undefined ? ` (${categoryProductCounts[category.id]})` : ""}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
              </div>

              <InventoryDashboard
                products={products}
                receipts={receipts}
                categoriesById={categoriesById}
                productsById={productsById}
                storageAreas={storageAreas}
              />

              <InventoryFilters
                smartSearchTerm={smartSearchTerm}
                setSmartSearchTerm={setSmartSearchTerm}
                searchFields={searchFields}
                setSearchFields={setSearchFields}
                productFilter={productFilter}
                setProductFilter={setProductFilter}
                holdFilter={holdFilter}
                setHoldFilter={setHoldFilter}
                expiryStartDate={expiryStartDate}
                setExpiryStartDate={setExpiryStartDate}
                expiryEndDate={expiryEndDate}
                setExpiryEndDate={setExpiryEndDate}
                quantityThreshold={quantityThreshold}
                setQuantityThreshold={setQuantityThreshold}
                quantityOperator={quantityOperator}
                setQuantityOperator={setQuantityOperator}
                ageFilter={ageFilter}
                setAgeFilter={setAgeFilter}
                sortOption={sortOption}
                setSortOption={setSortOption}
                inventoryStartDate={inventoryStartDate}
                setInventoryStartDate={setInventoryStartDate}
                inventoryEndDate={inventoryEndDate}
                setInventoryEndDate={setInventoryEndDate}
                showZeroInventory={showZeroInventory}
                setShowZeroInventory={setShowZeroInventory}
                productOptions={productOptions}
              />
            </section>

            {/* Always-visible smart search */}
            <div className="inventory-search-bar">
              <input
                type="text"
                value={smartSearchTerm}
                onChange={(e) => setSmartSearchTerm(e.target.value)}
                placeholder="Search by name, SID, FCC, or lot…"
              />
              <span className="inventory-result-count muted">{inventoryRows.length} product{inventoryRows.length !== 1 ? "s" : ""}</span>
            </div>

            <InventoryTable
              inventoryRows={inventoryRows}
              onProductClick={(productId) => setDetailProductId(productId)}
              onPrintClick={() => setShowPrintModal(true)}
            />

            {detailProductId && (
              <ProductDetailModal
                productId={detailProductId}
                productsById={productsById}
                categoriesById={categoriesById}
                receipts={receipts}
                rowLookup={rowLookup}
                rowNameCache={rowNameCache}
                getReceiptLocations={getReceiptLocations}
                onClose={() => setDetailProductId(null)}
              />
            )}
          </>
        )}

        {activeTab === "locations" && (
          <LocationsTab
            locationsTree={locationsTree}
            receipts={receipts}
            productsById={productsById}
            locationLookup={locationLookup}
            storageAreas={storageAreas}
            productOptions={productOptions}
          />
        )}
      </div>

      {showPrintModal && (
        <PrintReportModal
          inventoryRows={inventoryRows}
          productsById={productsById}
          categoriesById={categoriesById}
          onClose={() => setShowPrintModal(false)}
        />
      )}
    </div>
  );
};

export default InventoryOverview;
