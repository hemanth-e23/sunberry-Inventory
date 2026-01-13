import React, { useMemo, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAppData } from "../context/AppDataContext";
import { useAuth } from "../context/AuthContext";
import { getDashboardPath } from "../App";
import axios from "axios";
import "./InventoryOverview.css";
import "./InventoryOverviewEnhanced.css";

const API_BASE_URL = `http://${window.location.hostname}:8000/api`;

const formatDate = (value) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

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
    activeReceipts: receipts,  // Use activeReceipts for inventory view (excludes depleted)
    productCategories,
    categoryGroups,
    users,
    locationLookup,
    locationsTree,
    storageAreas,
    locations,
  } = useAppData();

  const [activeTab, setActiveTab] = useState("inventory");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [holdFilter, setHoldFilter] = useState("all");
  const [sortOption, setSortOption] = useState("recent");
  const [searchTerm, setSearchTerm] = useState("");
  const [productFilter, setProductFilter] = useState("all");
  const [recentSearch, setRecentSearch] = useState("");

  const [locationFilter, setLocationFilter] = useState("all");
  const [areaFilter, setAreaFilter] = useState("all");
  const [showEmptyOnly, setShowEmptyOnly] = useState(false);
  const [locationProductFilter, setLocationProductFilter] = useState("all");
  const [inventoryStartDate, setInventoryStartDate] = useState("");
  const [inventoryEndDate, setInventoryEndDate] = useState("");
  const [showZeroInventory, setShowZeroInventory] = useState(false);
  const [detailProductId, setDetailProductId] = useState(null);

  // Modal-specific filters
  const [modalExpiryStartDate, setModalExpiryStartDate] = useState("");
  const [modalExpiryEndDate, setModalExpiryEndDate] = useState("");
  const [modalExpiryFilter, setModalExpiryFilter] = useState("all"); // "all", "expiring-soon", "expired", "custom"
  const [expirySortDirection, setExpirySortDirection] = useState("desc"); // "desc" or "asc"

  // Advanced filters
  const [expiryStartDate, setExpiryStartDate] = useState("");
  const [expiryEndDate, setExpiryEndDate] = useState("");
  const [quantityThreshold, setQuantityThreshold] = useState("");
  const [quantityOperator, setQuantityOperator] = useState("above");
  const [supplierFilter, setSupplierFilter] = useState("all");
  const [ageFilter, setAgeFilter] = useState("all");

  // Smart search
  const [smartSearchTerm, setSmartSearchTerm] = useState("");
  const [searchFields, setSearchFields] = useState(["name", "sid", "fcc", "lot"]);

  // Dashboard widgets state (hidden by default)
  const [showWidgets, setShowWidgets] = useState(false);

  // Filters visibility (hidden by default)
  const [showFilters, setShowFilters] = useState(false);

  // Column visibility
  const [visibleColumns, setVisibleColumns] = useState({
    product: true,
    category: true,
    type: true,
    locations: true,
    holdStatus: true,
    availableQty: true,
    lotsTracked: true,
    pendingReceipts: true,
    lastReceipt: true,
    lastApproval: true,
    description: true
  });

  // Bulk operations
  const [selectedItems, setSelectedItems] = useState(new Set());
  const [bulkAction, setBulkAction] = useState("");

  // Print options
  const [showPrintModal, setShowPrintModal] = useState(false);
  const [printOptions, setPrintOptions] = useState({
    includeRawMaterials: true,
    includePackaging: true,
    includeFinishedGoods: true,
    includeAllCategories: false
  });

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

  // Dashboard widgets calculations
  const inventoryMetrics = useMemo(() => {
    const totalProducts = products.length;
    const activeProducts = products.filter(p => p.status === 'active').length;
    const onHoldProducts = receipts.filter(r => r.hold).length;
    const pendingReceipts = receipts.filter(r => r.status === 'recorded').length;

    // Calculate expiring soon (next 6 months)
    const expiringSoon = receipts.filter(r => {
      if (!r.expiration) return false;
      const expiryDate = new Date(r.expiration);
      const sixMonthsFromNow = new Date();
      sixMonthsFromNow.setMonth(sixMonthsFromNow.getMonth() + 6);
      return expiryDate <= sixMonthsFromNow && expiryDate >= new Date();
    }).length;

    // Calculate low stock (below 100 cases)
    const lowStockItems = receipts.filter(r => r.quantity < 100).length;

    // Calculate total inventory value (rough estimate)
    const totalValue = receipts.reduce((sum, r) => {
      // Rough estimate: $5 per case for finished goods, $2 for raw materials
      const category = categoriesById[productsById[r.productId]?.categoryId];
      const pricePerCase = category?.parentId === 'group-finished' ? 5 : 2;
      return sum + (r.quantity * pricePerCase);
    }, 0);

    return {
      totalProducts,
      activeProducts,
      onHoldProducts,
      pendingReceipts,
      expiringSoon,
      lowStockItems,
      totalValue: Math.round(totalValue)
    };
  }, [products, receipts, categoriesById, productsById]);

  // Finished goods capacity calculations
  const finishedGoodsCapacity = useMemo(() => {
    // Show all storage areas - they're all for finished goods
    const fgAreas = storageAreas.filter(area => area.active !== false);

    return fgAreas
      .map(area => {
        const totalCapacity = area.rows?.reduce((sum, row) => {
          const capacity = Number(row.palletCapacity) || 0;
          const casesPerPallet = Number(row.defaultCasesPerPallet) || 0;
          return sum + (capacity * casesPerPallet);
        }, 0) || 0;

        const currentQuantity = area.rows?.reduce((sum, row) => {
          const occupied = Number(row.occupiedCases) || 0;
          return sum + occupied;
        }, 0) || 0;

        const utilization = totalCapacity > 0 ? (currentQuantity / totalCapacity) * 100 : 0;

        return {
          name: area.name,
          totalCapacity,
          currentQuantity,
          utilization: Math.round(utilization),
          available: totalCapacity - currentQuantity
        };
      })
      .filter(area => area.totalCapacity > 0); // Only show areas with defined capacity
  }, [storageAreas]);

  // Raw materials graph data
  const rawMaterialsData = useMemo(() => {
    const rawCategories = productCategories.filter(cat => cat.parentId === 'group-raw');
    return rawCategories.map(category => {
      const categoryReceipts = receipts.filter(r => {
        const product = productsById[r.productId];
        return product?.categoryId === category.id && r.status === 'approved';
      });

      const totalQuantity = categoryReceipts.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0);
      const onHold = categoryReceipts.filter(r => r.hold).length;

      // Get the most common unit from receipts
      const unitCounts = {};
      categoryReceipts.forEach(r => {
        const unit = r.quantityUnits || 'units';
        unitCounts[unit] = (unitCounts[unit] || 0) + 1;
      });
      const mostCommonUnit = Object.keys(unitCounts).reduce((a, b) =>
        unitCounts[a] > unitCounts[b] ? a : b, 'units');

      return {
        name: category.name,
        quantity: totalQuantity,
        unit: mostCommonUnit,
        onHold,
        lots: categoryReceipts.length
      };
    }).sort((a, b) => b.quantity - a.quantity);
  }, [receipts, productsById, productCategories]);

  // Print function
  const handlePrint = () => {
    // Filter data based on print options
    let dataToPrint = inventoryRows;

    if (!printOptions.includeAllCategories) {
      dataToPrint = inventoryRows.filter(row => {
        const product = productsById[row.id];
        const category = categoriesById[product?.categoryId];

        if (printOptions.includeRawMaterials && category?.parentId === 'group-raw') return true;
        if (printOptions.includePackaging && category?.parentId === 'group-packaging') return true;
        if (printOptions.includeFinishedGoods && category?.parentId === 'group-finished') return true;

        return false;
      });
    }

    // Create print content
    const printContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Inventory Report - ${new Date().toLocaleDateString()}</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; }
            h1 { color: #333; border-bottom: 2px solid #4a90e2; padding-bottom: 10px; }
            .report-info { margin: 20px 0; color: #666; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
            th { background-color: #f5f5f5; font-weight: bold; }
            .quantity { text-align: right; }
            .hold-active { background-color: #fff3cd; }
            .low-stock { background-color: #f8d7da; }
            .zero-inventory { background-color: #f8d7da; }
            .footer { margin-top: 30px; font-size: 12px; color: #666; }
          </style>
        </head>
        <body>
          <h1>Sunberry Inventory Report</h1>
          <div class="report-info">
            <p><strong>Report Date:</strong> ${new Date().toLocaleDateString()}</p>
            <p><strong>Total Items:</strong> ${dataToPrint.length}</p>
            <p><strong>Categories Included:</strong> 
              ${printOptions.includeAllCategories ? 'All Categories' : ''}
              ${!printOptions.includeAllCategories && printOptions.includeRawMaterials ? 'Raw Materials' : ''}
              ${!printOptions.includeAllCategories && printOptions.includePackaging ? ', Packaging Materials' : ''}
              ${!printOptions.includeAllCategories && printOptions.includeFinishedGoods ? ', Finished Goods' : ''}
            </p>
          </div>
          
          <table>
            <thead>
              <tr>
                <th>Product Name</th>
                <th>Category</th>
                <th>Type</th>
                <th>Available Quantity</th>
                <th>Hold Status</th>
                <th>Lots Tracked</th>
                <th>Pending Receipts</th>
                <th>Last Receipt</th>
                <th>Last Approval</th>
              </tr>
            </thead>
            <tbody>
              ${dataToPrint.map(row => `
                <tr class="${row.quantity === 0 ? 'zero-inventory' : row.quantity < 100 ? 'low-stock' : ''} ${row.holdActive ? 'hold-active' : ''}">
                  <td>${row.name}</td>
                  <td>${row.category}</td>
                  <td>${row.type}</td>
                  <td class="quantity">${row.quantity.toLocaleString()}</td>
                  <td>${row.holdLabel}</td>
                  <td>${row.lotCount}</td>
                  <td>${row.pendingCount}</td>
                  <td>${row.lastSubmittedBy}<br><small>${row.lastSubmittedAt}</small></td>
                  <td>${row.lastApprovedBy}<br><small>${row.lastApprovedAt}</small></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          
          <div class="footer">
            <p>Generated on ${new Date().toLocaleString()} | Sunberry Inventory Management System</p>
          </div>
        </body>
      </html>
    `;

    // Open print window
    const printWindow = window.open('', '_blank');
    printWindow.document.write(printContent);
    printWindow.document.close();
    printWindow.focus();

    // Wait for content to load, then print
    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 250);

    setShowPrintModal(false);
  };

  // Row name cache for rows not found in locations structure
  const [rowNameCache, setRowNameCache] = useState({});
  
  // Row lookup: get row name from storageRowId
  const rowLookup = useMemo(() => {
    const map = { ...rowNameCache }; // Start with cached names
    // Check all locations and their sub-locations for rows
    locations?.forEach((location) => {
      location.subLocations?.forEach((subLoc) => {
        subLoc.rows?.forEach((row) => {
          if (row.id && row.name) {
            map[row.id] = row.name;
          }
        });
      });
    });
    // Also check storage areas (for finished goods)
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
  const fetchRowName = async (rowId) => {
    if (!rowId || rowNameCache[rowId]) return rowNameCache[rowId];
    
    try {
      const token = localStorage.getItem('token');
      if (!token) return null;
      
      const response = await axios.get(`${API_BASE_URL}/master-data/storage-rows/${rowId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      if (response.data?.name) {
        setRowNameCache(prev => ({ ...prev, [rowId]: response.data.name }));
        return response.data.name;
      }
    } catch (error) {
      console.warn(`Failed to fetch row name for ${rowId}:`, error);
    }
    return null;
  };

  // Pre-fetch row names for receipts that have storageRowId but no name in lookup
  useEffect(() => {
    const missingRowIds = new Set();
    
    // Check all receipts for missing row names
    receipts.forEach(receipt => {
      if (receipt.storageRowId || receipt.storage_row_id) {
        const rowId = receipt.storageRowId || receipt.storage_row_id;
        if (rowId && !rowLookup[rowId] && !rowNameCache[rowId]) {
          missingRowIds.add(rowId);
        }
      }
      // Also check rawMaterialRowAllocations
      if (receipt.rawMaterialRowAllocations && Array.isArray(receipt.rawMaterialRowAllocations)) {
        receipt.rawMaterialRowAllocations.forEach(alloc => {
          if (alloc.rowId && !rowLookup[alloc.rowId] && !rowNameCache[alloc.rowId]) {
            missingRowIds.add(alloc.rowId);
          }
        });
      }
    });
    
    // Fetch all missing row names
    if (missingRowIds.size > 0) {
      missingRowIds.forEach(rowId => {
        fetchRowName(rowId);
      });
    }
  }, [receipts, rowLookup, rowNameCache]);

  const getReceiptLocations = (receipt) => {
    // Check if this is a finished goods receipt with allocation plan
    const category = productCategories.find(c => c.id === receipt.categoryId);
    const isFinishedGood = category?.parentId === 'group-finished' || category?.type === 'finished';

    // Parse allocation if it's a string
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

      // For finished goods, format as "FG: AA (10 pallets), AB (15 pallets)"
      if (isFinishedGood && plan.length > 0) {
        // Group by storage area name
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

        // Format as "FG: AA (10 pallets), AB (15 pallets)"
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

        // Add floor staging if present
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
        // For non-finished goods or old format, use original display
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

    const label = getLocationLabel(
      locationLookup,
      receipt?.location,
      receipt?.subLocation,
    );
    
    // Add row information for raw materials/packaging
    const rowInfo = [];
    
    // Check for multiple row allocations (rawMaterialRowAllocations)
    if (receipt.rawMaterialRowAllocations && Array.isArray(receipt.rawMaterialRowAllocations)) {
      receipt.rawMaterialRowAllocations.forEach(alloc => {
        const rowName = rowLookup[alloc.rowId] || alloc.rowName || alloc.rowId;
        const pallets = alloc.pallets || 0;
        if (rowName) {
          rowInfo.push(`${rowName}${pallets > 0 ? ` (${pallets} pallets)` : ''}`);
        }
      });
    }
    // Check for single row (storageRowId)
    else if (receipt.storageRowId || receipt.storage_row_id) {
      const rowId = receipt.storageRowId || receipt.storage_row_id;
      // Check both rowLookup and rowNameCache (cache is updated async)
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
  };

  const recentEntries = useMemo(() => {
    const sorted = [...receipts].sort((a, b) => {
      const aTime =
        parseDate(a.approvedAt) || parseDate(a.submittedAt) || parseDate(a.receiptDate) || 0;
      const bTime =
        parseDate(b.approvedAt) || parseDate(b.submittedAt) || parseDate(b.receiptDate) || 0;
      return bTime - aTime;
    });

    const term = recentSearch.trim().toLowerCase();

    return sorted
      .filter((receipt) => {
        if (!term) return true;
        const product = productsById[receipt.productId];
        const productName = (product?.name || "").toLowerCase();
        const lot = (receipt.lotNo || "").toLowerCase();
        const submitted = formatDate(receipt.submittedAt || receipt.receiptDate).toLowerCase();
        const approved = formatDate(receipt.approvedAt).toLowerCase();
        return (
          productName.includes(term) ||
          lot.includes(term) ||
          submitted.includes(term) ||
          approved.includes(term)
        );
      })
      .slice(0, 30)
      .map((receipt) => {
        const product = productsById[receipt.productId];
        const category = categoriesById[product?.categoryId];
        const productType = category?.type || '-';
        const defaultCPP = productsById[receipt.productId]?.defaultCasesPerPallet ?? null;
        const qty = Number(receipt.quantity) || 0;
        const qtyUnits = receipt.quantityUnits || '';
        const derivedPallets =
          productType === 'finished' && qtyUnits === 'cases' && defaultCPP > 0
            ? Math.round((qty / defaultCPP) * 100) / 100
            : null;
        return {
          id: receipt.id,
          status: receipt.status,
          productName: product?.name || "Unknown product",
          categoryName: category?.name || "—",
          quantity: qty,
          quantityUnits: qtyUnits,
          pallets: derivedPallets,
          lot: receipt.lotNo || "—",
          hold: Boolean(receipt.hold),
          submittedBy:
            userLookup[receipt.submittedBy] || receipt.submittedBy || "—",
          approvedBy: receipt.approvedBy
            ? userLookup[receipt.approvedBy] || receipt.approvedBy
            : "Pending",
          timestamp:
            formatDate(receipt.approvedAt) ||
            formatDate(receipt.submittedAt) ||
            formatDate(receipt.receiptDate),
          timestampMs:
            parseDate(receipt.approvedAt) ||
            parseDate(receipt.submittedAt) ||
            parseDate(receipt.receiptDate) || 0,
          locations: getReceiptLocations(receipt),
          note: receipt.note || "",
        };
      });
  }, [receipts, productsById, categoriesById, userLookup, locationLookup, recentSearch]);

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

      if (receipt.status === "approved") {
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
          .filter((receipt) => receipt.status === "approved")
          .reduce((latest, current) => {
            const latestTime = latest ? parseDate(latest.approvedAt) || -Infinity : -Infinity;
            const currentTime = parseDate(current.approvedAt) || -Infinity;
            return currentTime > latestTime ? current : latest;
          }, null);

        const locations = lastApproval
          ? getReceiptLocations(lastApproval)
          : lastSubmission
            ? getReceiptLocations(lastSubmission)
            : [];

        const holdCount = productReceipts.filter((receipt) => receipt.hold).length;

        // Determine unit label for quantity: finished goods default to cases; for others use last receipt units
        const quantityUnitLabel = (lastApproval?.quantityUnits || lastSubmission?.quantityUnits || (category?.type === 'finished' ? 'cases' : ''));

        return {
          id: product.id,
          name: product.name,
          category: category?.name || "Unknown",
          type: category?.type || "-",
          quantity: summary.quantity,
          unitLabel: quantityUnitLabel,
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
          locations,
        };
      })
      .filter((row) => {
        // Hold filter
        if (holdFilter === "hold") return row.holdActive;
        if (holdFilter === "clear") return !row.holdActive;

        // Advanced filters
        // Expiry date filter
        if (expiryStartDate || expiryEndDate) {
          const productReceipts = productReceiptsMap[row.id] || [];
          const hasExpiringInRange = productReceipts.some(receipt => {
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

        // Quantity threshold filter
        if (quantityThreshold) {
          const threshold = parseFloat(quantityThreshold);
          if (quantityOperator === "above" && row.quantity <= threshold) return false;
          if (quantityOperator === "below" && row.quantity >= threshold) return false;
          if (quantityOperator === "equal" && row.quantity !== threshold) return false;
        }

        // Age filter (days since last receipt)
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
          }
        }

        // Smart search filter
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
    locationLookup,
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
  ]);

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
      .filter((receipt) => receipt.status === "approved")
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
          // Prefer row default, otherwise use product standard default
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
      .filter((receipt) => receipt.status === "approved")
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
            // Use product default if available; fall back to receipt value
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

        // Attach unit label for each product using latest approved receipt as source of truth
        const productUnitMap = {};
        receipts
          .filter(r => r.status === 'approved')
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

        if (showEmptyOnly) {
          return location.totalQuantity === 0;
        }

        if (
          locationProductFilter !== "all" &&
          location.displayProducts.length === 0
        ) {
          return false;
        }

        return location.totalQuantity > 0 || location.displayProducts.length > 0;
      });
  }, [
    generalLocationData,
    locationFilter,
    locationProductFilter,
    showEmptyOnly,
  ]);

  const filteredFinishedRows = useMemo(() => {
    return finishedRowsData.filter((row) => {
      if (areaFilter !== "all") {
        if (areaFilter === "floor" && row.areaId !== "floor") return false;
        if (areaFilter !== "floor" && row.areaId !== areaFilter) return false;
      }

      if (showEmptyOnly) {
        if (row.occupiedPallets > 0 || row.occupiedCases > 0) return false;
      } else if (!row.productId && row.areaId !== "floor") {
        if (row.occupiedPallets === 0 && row.occupiedCases === 0) {
          return false;
        }
      }

      if (locationProductFilter !== "all") {
        if (row.productId !== locationProductFilter) {
          if (!(showEmptyOnly && !row.productId)) {
            return false;
          }
        }
      }

      return true;
    });
  }, [finishedRowsData, areaFilter, locationProductFilter, showEmptyOnly]);

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
          <section className="panel">
            <div className="panel-header">
              <h2>Latest Activity</h2>
              <span className="muted">
                Most recent submissions and approvals across all inventory
              </span>
            </div>
            <div className="filters">
              <label>
                <span>Search</span>
                <input
                  type="text"
                  value={recentSearch}
                  onChange={(event) => setRecentSearch(event.target.value)}
                  placeholder="Search product, lot, or date"
                />
              </label>
            </div>
            <div className="recent-list">
              {(() => {
                const groups = recentEntries.reduce((acc, e) => {
                  const d = new Date(e.timestampMs);
                  const today = new Date(); today.setHours(0, 0, 0, 0);
                  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
                  const key = d >= today ? 'Today' : d >= yesterday ? 'Yesterday' : 'Earlier';
                  (acc[key] = acc[key] || []).push(e);
                  return acc;
                }, {});
                return Object.entries(groups).map(([label, items]) => (
                  <div key={label} className="recent-group">
                    <div className="group-header sticky">{label}</div>
                    {items.map(entry => (
                      <article key={entry.id} className="recent-card">
                        <header>
                          <div>
                            <h3>{entry.productName}</h3>
                            <span className="badge">{entry.categoryName}</span>
                          </div>
                          <div className="meta">
                            <span className={`status status-${entry.status}`}>
                              {entry.status}
                              {entry.hold && <span className="tag tag-hold">Hold</span>}
                            </span>
                            <span className="timestamp">{entry.timestamp}</span>
                          </div>
                        </header>
                        <div className="recent-details">
                          <span>
                            Qty: <strong>{entry.quantity}</strong> {entry.quantityUnits || ''}
                            {entry.pallets !== null && entry.pallets !== undefined && (
                              <span className="muted"> · {entry.pallets} pallets</span>
                            )}
                          </span>
                          <span>Lot: {entry.lot}</span>
                          <span>Submitted by: {entry.submittedBy}</span>
                          <span>Reviewed by: {entry.approvedBy}</span>
                        </div>
                        {entry.locations.length > 0 && (
                          <ul className="location-list">
                            {entry.locations.map((loc, index) => (
                              <li key={`${entry.id}-loc-${index}`}>
                                <strong>{loc.label}</strong>
                                {loc.detail && <span>{loc.detail}</span>}
                              </li>
                            ))}
                          </ul>
                        )}
                        {entry.note && <p className="note">{entry.note}</p>}
                      </article>
                    ))}
                  </div>
                ));
              })()}
              {!recentEntries.length && (
                <div className="empty-state">No receipts recorded yet.</div>
              )}
            </div>
          </section>
        )}

        {activeTab === "inventory" && (
          <>
            {/* Collapsible Sections - Filters and Dashboard (shown first) */}
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
                              {category.name}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
              </div>
              {/* Collapsible Dashboard Overview Section */}
              <div className="collapsible-section">
                <div
                  className="collapsible-header"
                  onClick={() => setShowWidgets(!showWidgets)}
                >
                  <h3>Inventory Overview</h3>
                  <span className="chevron">{showWidgets ? '▼' : '▶'}</span>
                </div>
                {showWidgets && (
                  <div className="collapsible-content">
                    <p className="muted">
                      Only approved receipts are counted. Pending receipts appear in the
                      approvals queue.
                    </p>

                    {/* Dashboard Widgets */}
                    <div className="dashboard-widgets">
                      <div className="widget-row">
                        <div className="metric-card">
                          <div className="metric-content">
                            <div className="metric-value">{inventoryMetrics.totalProducts}</div>
                            <div className="metric-label">Total Products</div>
                          </div>
                        </div>
                        <div className="metric-card">
                          <div className="metric-content">
                            <div className="metric-value">{inventoryMetrics.activeProducts}</div>
                            <div className="metric-label">Active Products</div>
                          </div>
                        </div>
                        <div className="metric-card">
                          <div className="metric-content">
                            <div className="metric-value">{inventoryMetrics.pendingReceipts}</div>
                            <div className="metric-label">Pending Receipts</div>
                          </div>
                        </div>
                      </div>

                      <div className="widget-row">
                        <div className="alert-card">
                          <div className="alert-content">
                            <div className="alert-value">{inventoryMetrics.expiringSoon}</div>
                            <div className="alert-label">Expiring Soon (6 months)</div>
                          </div>
                        </div>
                        <div className="alert-card">
                          <div className="alert-content">
                            <div className="alert-value">{inventoryMetrics.lowStockItems}</div>
                            <div className="alert-label">
                              Low Stock Items
                              <span className="threshold-text">(products less than 100 cases)</span>
                            </div>
                          </div>
                        </div>
                        <div className="alert-card">
                          <div className="alert-content">
                            <div className="alert-value">{inventoryMetrics.onHoldProducts}</div>
                            <div className="alert-label">Items on Hold</div>
                          </div>
                        </div>
                      </div>

                      {/* Capacity Charts */}
                      <div className="charts-row">
                        <div className="chart-container">
                          <h3>Finished Goods Capacity</h3>
                          <div className="capacity-chart">
                            {finishedGoodsCapacity.map((area, index) => (
                              <div key={area.name} className="capacity-bar">
                                <div className="capacity-label">
                                  <span>{area.name}</span>
                                  <span className="capacity-stats">
                                    {area.currentQuantity.toLocaleString()}/{area.totalCapacity.toLocaleString()} cases
                                    ({area.utilization}%)
                                  </span>
                                </div>
                                <div className="capacity-progress">
                                  <div
                                    className={`capacity-fill ${area.utilization > 80 ? 'high' : area.utilization > 60 ? 'medium' : 'low'}`}
                                    style={{ width: `${Math.min(area.utilization, 100)}%` }}
                                  ></div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Collapsible Filters Section */}
              <div className="collapsible-section">
                <div
                  className="collapsible-header"
                  onClick={() => setShowFilters(!showFilters)}
                >
                  <h3>Filters</h3>
                  <span className="chevron">{showFilters ? '▼' : '▶'}</span>
                </div>
                {showFilters && (
                  <div className="collapsible-content">
                    {/* Advanced Filters */}
                    <div className="advanced-filters">
                      <div className="filter-section">
                        <h3>Basic Filters</h3>
                        <div className="filters">
                          <label>
                            <span>Smart Search</span>
                            <input
                              type="text"
                              value={smartSearchTerm}
                              onChange={(event) => setSmartSearchTerm(event.target.value)}
                              placeholder="Search by name, SID, FCC code, or lot number"
                            />
                          </label>
                          <label>
                            <span>Search Fields</span>
                            <div className="checkbox-group">
                              <label className="checkbox-label">
                                <input
                                  type="checkbox"
                                  checked={searchFields.includes("name")}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setSearchFields([...searchFields, "name"]);
                                    } else {
                                      setSearchFields(searchFields.filter(f => f !== "name"));
                                    }
                                  }}
                                />
                                <span>Product Name</span>
                              </label>
                              <label className="checkbox-label">
                                <input
                                  type="checkbox"
                                  checked={searchFields.includes("sid")}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setSearchFields([...searchFields, "sid"]);
                                    } else {
                                      setSearchFields(searchFields.filter(f => f !== "sid"));
                                    }
                                  }}
                                />
                                <span>SID</span>
                              </label>
                              <label className="checkbox-label">
                                <input
                                  type="checkbox"
                                  checked={searchFields.includes("fcc")}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setSearchFields([...searchFields, "fcc"]);
                                    } else {
                                      setSearchFields(searchFields.filter(f => f !== "fcc"));
                                    }
                                  }}
                                />
                                <span>FCC Code</span>
                              </label>
                              <label className="checkbox-label">
                                <input
                                  type="checkbox"
                                  checked={searchFields.includes("lot")}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setSearchFields([...searchFields, "lot"]);
                                    } else {
                                      setSearchFields(searchFields.filter(f => f !== "lot"));
                                    }
                                  }}
                                />
                                <span>Lot Number</span>
                              </label>
                            </div>
                          </label>
                          <label>
                            <span>Product</span>
                            <select
                              value={productFilter}
                              onChange={(event) => setProductFilter(event.target.value)}
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
                            <span>Hold Filter</span>
                            <select
                              value={holdFilter}
                              onChange={(event) => setHoldFilter(event.target.value)}
                            >
                              <option value="all">Show All</option>
                              <option value="hold">Hold Only</option>
                              <option value="clear">Exclude Holds</option>
                            </select>
                          </label>
                        </div>
                      </div>

                      <div className="filter-section">
                        <h3>Advanced Filters</h3>
                        <div className="filters">
                          <label>
                            <span>Expiry Date Range</span>
                            <div className="date-range">
                              <input
                                type="date"
                                value={expiryStartDate}
                                onChange={(event) => setExpiryStartDate(event.target.value)}
                                placeholder="From"
                              />
                              <input
                                type="date"
                                value={expiryEndDate}
                                onChange={(event) => setExpiryEndDate(event.target.value)}
                                placeholder="To"
                              />
                            </div>
                          </label>
                          <label>
                            <span>Quantity Filter</span>
                            <div className="quantity-filter">
                              <select
                                value={quantityOperator}
                                onChange={(event) => setQuantityOperator(event.target.value)}
                              >
                                <option value="above">Above</option>
                                <option value="below">Below</option>
                                <option value="equal">Equal to</option>
                              </select>
                              <input
                                type="number"
                                value={quantityThreshold}
                                onChange={(event) => setQuantityThreshold(event.target.value)}
                                placeholder="Enter quantity"
                              />
                            </div>
                          </label>
                          <label>
                            <span>Age Filter</span>
                            <select
                              value={ageFilter}
                              onChange={(event) => setAgeFilter(event.target.value)}
                            >
                              <option value="all">All Ages</option>
                              <option value="7days">Last 7 days</option>
                              <option value="30days">Last 30 days</option>
                              <option value="90days">Last 90 days</option>
                              <option value="older">Older than 90 days</option>
                            </select>
                          </label>
                          <label>
                            <span>Sort</span>
                            <select
                              value={sortOption}
                              onChange={(event) => setSortOption(event.target.value)}
                            >
                              <option value="recent">Recent First</option>
                              <option value="oldest">Oldest First</option>
                              <option value="hold-first">Hold Status (Hold → Clear)</option>
                              <option value="clear-first">Hold Status (Clear → Hold)</option>
                            </select>
                          </label>
                        </div>
                      </div>

                      <div className="filter-section">
                        <h3>Display Options</h3>
                        <div className="filters">
                          <label>
                            <span>Date Range</span>
                            <div className="date-range">
                              <input
                                type="date"
                                value={inventoryStartDate}
                                onChange={(event) => setInventoryStartDate(event.target.value)}
                                placeholder="From"
                              />
                              <input
                                type="date"
                                value={inventoryEndDate}
                                onChange={(event) => setInventoryEndDate(event.target.value)}
                                placeholder="To"
                              />
                            </div>
                          </label>
                          <label className="checkbox-label">
                            <input
                              type="checkbox"
                              checked={showZeroInventory}
                              onChange={(event) => setShowZeroInventory(event.target.checked)}
                            />
                            <span>Include products not in hand</span>
                          </label>
                          <div className="filter-actions">
                            <button
                              onClick={() => {
                                setExpiryStartDate("");
                                setExpiryEndDate("");
                                setQuantityThreshold("");
                                setQuantityOperator("above");
                                setAgeFilter("all");
                                setSmartSearchTerm("");
                                setSearchFields(["name", "sid", "fcc", "lot"]);
                              }}
                              className="clear-filters-btn"
                            >
                              Clear All Filters
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* Table Section - Shown after filters */}
            <section className="panel">
              {/* Bulk Actions */}
              {selectedItems.size > 0 && (
                <div className="bulk-actions">
                  <span className="bulk-selection">
                    {selectedItems.size} item{selectedItems.size !== 1 ? 's' : ''} selected
                  </span>
                  <div className="bulk-buttons">
                    <select
                      value={bulkAction}
                      onChange={(e) => setBulkAction(e.target.value)}
                      className="bulk-select"
                    >
                      <option value="">Choose Action</option>
                      <option value="hold">Set on Hold</option>
                      <option value="release">Release from Hold</option>
                      <option value="print">Print Selected</option>
                    </select>
                    <button
                      onClick={() => {
                        if (bulkAction === "print") {
                          setShowPrintModal(true);
                        } else {
                          alert(`Bulk action "${bulkAction}" for ${selectedItems.size} items`);
                        }
                        setBulkAction("");
                        setSelectedItems(new Set());
                      }}
                      disabled={!bulkAction}
                      className="bulk-execute-btn"
                    >
                      Execute
                    </button>
                    <button
                      onClick={() => setSelectedItems(new Set())}
                      className="bulk-clear-btn"
                    >
                      Clear Selection
                    </button>
                  </div>
                </div>
              )}

              {/* Column Visibility Toggle */}
              <div className="column-controls">
                <span>Columns:</span>
                <div className="column-checkboxes">
                  {Object.entries(visibleColumns).map(([key, visible]) => (
                    <label key={key} className="checkbox-label small">
                      <input
                        type="checkbox"
                        checked={visible}
                        onChange={(e) => setVisibleColumns(prev => ({
                          ...prev,
                          [key]: e.target.checked
                        }))}
                      />
                      <span>{key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1')}</span>
                    </label>
                  ))}
                </div>
                <button
                  onClick={() => setShowPrintModal(true)}
                  className="print-btn"
                >
                  Print Report
                </button>
              </div>

              <div className="table-wrapper">
                <table className="simple-table enhanced-table">
                  <thead>
                    <tr>
                      {visibleColumns.product && <th>
                        <input
                          type="checkbox"
                          checked={selectedItems.size === inventoryRows.length && inventoryRows.length > 0}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedItems(new Set(inventoryRows.map(row => row.id)));
                            } else {
                              setSelectedItems(new Set());
                            }
                          }}
                        />
                      </th>}
                      {visibleColumns.product && <th>Product</th>}
                      {visibleColumns.category && <th>Category</th>}
                      {visibleColumns.type && <th>Type</th>}
                      {visibleColumns.locations && <th>Location(s)</th>}
                      {visibleColumns.holdStatus && <th>Hold Status</th>}
                      {visibleColumns.availableQty && <th>Available Qty</th>}
                      {visibleColumns.lotsTracked && <th>Lots Tracked</th>}
                      {visibleColumns.pendingReceipts && <th>Pending Receipts</th>}
                      {visibleColumns.lastReceipt && <th>Last Receipt</th>}
                      {visibleColumns.lastApproval && <th>Last Approval</th>}
                      {visibleColumns.description && <th>Description</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {inventoryRows.map((row) => {
                      // Color coding logic
                      const getRowClass = () => {
                        let classes = [];
                        if (row.quantity === 0) classes.push('zero-inventory');
                        if (row.holdActive) classes.push('on-hold');
                        if (row.pendingCount > 0) classes.push('has-pending');
                        if (row.quantity < 100) classes.push('low-stock');
                        return classes.join(' ');
                      };

                      const getQuantityClass = () => {
                        if (row.quantity === 0) return 'qty-zero';
                        if (row.quantity < 100) return 'qty-low';
                        if (row.quantity > 1000) return 'qty-high';
                        return 'qty-normal';
                      };

                      return (
                        <tr key={row.id} className={getRowClass()}>
                          {visibleColumns.product && <td>
                            <input
                              type="checkbox"
                              checked={selectedItems.has(row.id)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedItems(prev => new Set([...prev, row.id]));
                                } else {
                                  setSelectedItems(prev => {
                                    const newSet = new Set(prev);
                                    newSet.delete(row.id);
                                    return newSet;
                                  });
                                }
                              }}
                            />
                          </td>}
                          {visibleColumns.product && <td>
                            <div className="product-cell">
                              <button
                                type="button"
                                className="link-plain"
                                onClick={() => setDetailProductId(row.id)}
                                title="View details"
                              >
                                <strong>{row.name}</strong>
                              </button>
                              {row.pendingCount > 0 && <span className="pending-badge">{row.pendingCount}</span>}
                            </div>
                          </td>}
                          {visibleColumns.category && <td>{row.category}</td>}
                          {visibleColumns.type && <td className="capitalize">{row.type}</td>}
                          {visibleColumns.locations && <td>
                            {row.locations.length ? (
                              <ul className="location-list compact">
                                {row.locations.map((loc, index) => (
                                  <li key={`${row.id}-loc-${index}`}>
                                    <strong>{loc.label}</strong>
                                    {loc.detail && <span>{loc.detail}</span>}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>}
                          {visibleColumns.holdStatus && <td>
                            <span
                              className={`chip ${row.holdActive ? "chip-hold" : "chip-clear"}`}
                            >
                              {row.holdLabel}
                            </span>
                          </td>}
                          {visibleColumns.availableQty && <td>
                            <span className={`quantity-cell ${getQuantityClass()}`}>
                              {row.quantity.toLocaleString()} {row.unitLabel ? row.unitLabel : ''}
                            </span>
                          </td>}
                          {visibleColumns.lotsTracked && <td>{row.lotCount}</td>}
                          {visibleColumns.pendingReceipts && <td>
                            {row.pendingCount > 0 ? (
                              <span className="pending-count">{row.pendingCount}</span>
                            ) : (
                              <span className="muted">0</span>
                            )}
                          </td>}
                          {visibleColumns.lastReceipt && <td>
                            <div className="cell-stack">
                              <span className="cell-main">{row.lastSubmittedBy}</span>
                              <span className="cell-sub">{row.lastSubmittedAt}</span>
                            </div>
                          </td>}
                          {visibleColumns.lastApproval && <td>
                            <div className="cell-stack">
                              <span className="cell-main">{row.lastApprovedBy}</span>
                              <span className="cell-sub">{row.lastApprovedAt}</span>
                            </div>
                          </td>}
                          {visibleColumns.description && <td>
                            <span className="muted">{row.description}</span>
                          </td>}
                        </tr>
                      );
                    })}
                    {!inventoryRows.length && (
                      <tr>
                        <td colSpan={11} className="empty">
                          No inventory found with the current filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Detail Drawer / Modal */}
            {detailProductId && (() => {
              const product = productsById[detailProductId];
              // Filter to only show approved and pending receipts (exclude rejected)
              let detailReceipts = receipts.filter(r =>
                r.productId === detailProductId && r.status !== "rejected"
              );

              // Apply expiration date filters
              if (modalExpiryFilter === "expiring-soon") {
                const sixMonthsFromNow = new Date();
                sixMonthsFromNow.setMonth(sixMonthsFromNow.getMonth() + 6);
                detailReceipts = detailReceipts.filter(r => {
                  const expiry = r.expiration || r.expirationDate;
                  if (!expiry) return false;
                  const expiryDate = new Date(expiry);
                  return expiryDate <= sixMonthsFromNow && expiryDate >= new Date();
                });
              } else if (modalExpiryFilter === "expired") {
                detailReceipts = detailReceipts.filter(r => {
                  const expiry = r.expiration || r.expirationDate;
                  if (!expiry) return false;
                  return new Date(expiry) < new Date();
                });
              } else if (modalExpiryFilter === "custom" && (modalExpiryStartDate || modalExpiryEndDate)) {
                detailReceipts = detailReceipts.filter(r => {
                  const expiry = r.expiration || r.expirationDate;
                  if (!expiry) return false;
                  const expiryDate = new Date(expiry);
                  const startDate = modalExpiryStartDate ? new Date(modalExpiryStartDate) : null;
                  const endDate = modalExpiryEndDate ? new Date(modalExpiryEndDate) : null;

                  if (startDate && endDate) {
                    return expiryDate >= startDate && expiryDate <= endDate;
                  } else if (startDate) {
                    return expiryDate >= startDate;
                  } else if (endDate) {
                    return expiryDate <= endDate;
                  }
                  return true;
                });
              }

              // Sort by expiration date
              detailReceipts = [...detailReceipts].sort((a, b) => {
                const expiryA = a.expiration || a.expirationDate;
                const expiryB = b.expiration || b.expirationDate;

                // Items without expiration date go to the end
                if (!expiryA && !expiryB) return 0;
                if (!expiryA) return 1;
                if (!expiryB) return -1;

                const dateA = new Date(expiryA).getTime();
                const dateB = new Date(expiryB).getTime();

                if (expirySortDirection === "desc") {
                  return dateB - dateA; // Descending: newest/latest dates first
                } else {
                  return dateA - dateB; // Ascending: oldest/earliest dates first
                }
              });

              const lots = Array.from(new Set(detailReceipts.map(r => r.lotNo).filter(Boolean)));
              const locationTotals = {};
              detailReceipts.forEach(r => {
                const locs = getReceiptLocations(r);
                const qty = Number(r.quantity) || 0;
                locs.forEach(l => {
                  locationTotals[l.label] = (locationTotals[l.label] || 0) + qty;
                });
              });
              return (
                <div className="modal-backdrop" onClick={() => setDetailProductId(null)}>
                  <div className="modal panel" onClick={e => e.stopPropagation()}>
                    <header className="modal-header">
                      <h3>{product?.name || 'Product Details'}</h3>
                    </header>
                    <div className="modal-body">
                      <div className="detail-grid">
                        <div><strong>Category:</strong> {categoriesById[product?.categoryId]?.name || '—'}</div>
                        <div><strong>Type:</strong> {categoriesById[product?.categoryId]?.type || '—'}</div>
                        <div><strong>Lots Tracked:</strong> {lots.length}</div>
                      </div>
                      <h4>Locations</h4>
                      {Object.keys(locationTotals).length ? (
                        <ul className="location-list">
                          {Object.entries(locationTotals).map(([label, qty]) => (
                            <li key={label}><strong>{label}</strong> — {qty.toLocaleString()}</li>
                          ))}
                        </ul>
                      ) : <span className="muted">No locations recorded</span>}

                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                        <h4 style={{ margin: 0 }}>Lots</h4>
                        {modalExpiryFilter !== "all" && (
                          <span style={{ fontSize: '14px', color: '#666' }}>
                            Showing {detailReceipts.length} of {receipts.filter(r => r.productId === detailProductId).length} lots
                          </span>
                        )}
                      </div>

                      {/* Expiration Date Filters */}
                      <div style={{ marginBottom: '16px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ fontSize: '14px', fontWeight: '500' }}>Filter by Expiration:</span>
                          <select
                            value={modalExpiryFilter}
                            onChange={(e) => {
                              setModalExpiryFilter(e.target.value);
                              if (e.target.value !== "custom") {
                                setModalExpiryStartDate("");
                                setModalExpiryEndDate("");
                              }
                            }}
                            style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '14px' }}
                          >
                            <option value="all">All</option>
                            <option value="expiring-soon">Expiring Soon (Next 6 Months)</option>
                            <option value="expired">Expired</option>
                            <option value="custom">Custom Date Range</option>
                          </select>
                        </label>

                        {modalExpiryFilter === "custom" && (
                          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                            <input
                              type="date"
                              value={modalExpiryStartDate}
                              onChange={(e) => setModalExpiryStartDate(e.target.value)}
                              placeholder="From"
                              style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '14px' }}
                            />
                            <span style={{ color: '#666' }}>to</span>
                            <input
                              type="date"
                              value={modalExpiryEndDate}
                              onChange={(e) => setModalExpiryEndDate(e.target.value)}
                              placeholder="To"
                              style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '14px' }}
                            />
                            {(modalExpiryStartDate || modalExpiryEndDate) && (
                              <button
                                onClick={() => {
                                  setModalExpiryStartDate("");
                                  setModalExpiryEndDate("");
                                }}
                                style={{
                                  padding: '6px 12px',
                                  background: '#f5f5f5',
                                  border: '1px solid #ddd',
                                  borderRadius: '4px',
                                  cursor: 'pointer',
                                  fontSize: '14px'
                                }}
                              >
                                Clear
                              </button>
                            )}
                          </div>
                        )}
                      </div>

                      {lots.length ? (
                        <table className="simple-table compact">
                          <thead>
                            <tr>
                              <th>Lot</th>
                              <th>Location</th>
                              <th>Row</th>
                              <th>Quantity</th>
                              <th>Status</th>
                              <th>Hold</th>
                              <th>Receipt Date</th>
                              <th
                                style={{ cursor: 'pointer', userSelect: 'none' }}
                                onClick={() => setExpirySortDirection(prev => prev === "desc" ? "asc" : "desc")}
                                title={`Click to sort ${expirySortDirection === "desc" ? "ascending" : "descending"}`}
                              >
                                Expiration Date
                                <span style={{ marginLeft: '6px', fontSize: '12px' }}>
                                  {expirySortDirection === "desc" ? "▼" : "▲"}
                                </span>
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {detailReceipts.map(r => {
                              const locations = getReceiptLocations(r);
                              const locationLabel = locations[0]?.label || '—';
                              const rowDetail = locations[0]?.detail || '';
                              
                              // Extract row names from detail or check directly
                              let rowDisplay = '—';
                              if (rowDetail) {
                                // Format: "Rows: A1 (15 pallets), A2 (1 pallet)"
                                rowDisplay = rowDetail.replace('Rows: ', '').replace('Row: ', '');
                              } else if (r.storageRowId || r.storage_row_id) {
                                const rowId = r.storageRowId || r.storage_row_id;
                                // Check both rowLookup and rowNameCache (cache is updated async)
                                const rowName = rowLookup[rowId] || rowNameCache[rowId];
                                const pallets = r.pallets || 0;
                                
                                if (rowName) {
                                  rowDisplay = `${rowName}${pallets > 0 ? ` (${pallets} pallets)` : ''}`;
                                } else {
                                  // If still not found, show ID temporarily (will update when fetch completes)
                                  rowDisplay = `${rowId}${pallets > 0 ? ` (${pallets} pallets)` : ''}`;
                                }
                              }
                              
                              return (
                                <tr key={r.id}>
                                  <td>{r.lotNo || '—'}</td>
                                  <td>{locationLabel}</td>
                                  <td>{rowDisplay}</td>
                                  <td>{Number(r.quantity || 0).toLocaleString()} {r.quantityUnits || ''}</td>
                                  <td className="capitalize">{r.status}</td>
                                  <td>
                                    {(() => {
                                      const heldQty = Number(r.heldQuantity || r.held_quantity || 0);
                                      const holdLoc = r.holdLocation || r.hold_location || null;
                                      if (heldQty > 0) {
                                        const locLabel = holdLoc ? ` (${holdLoc})` : '';
                                        return <span className="chip chip-hold">{heldQty.toLocaleString()} on Hold{locLabel}</span>;
                                      } else if (r.hold) {
                                        return <span className="chip chip-hold">Hold</span>;
                                      } else {
                                        return <span className="chip chip-clear">Clear</span>;
                                      }
                                    })()}
                                  </td>
                                  <td>{formatDate(r.approvedAt) || formatDate(r.submittedAt) || formatDate(r.receiptDate)}</td>
                                  <td>{formatDate(r.expiration) || formatDate(r.expirationDate) || '—'}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      ) : <span className="muted">No lots recorded</span>}
                    </div>
                    <footer className="modal-footer">
                      <button
                        className="secondary-button"
                        onClick={() => {
                          setDetailProductId(null);
                          // Reset modal filters when closing
                          setModalExpiryFilter("all");
                          setModalExpiryStartDate("");
                          setModalExpiryEndDate("");
                          setExpirySortDirection("desc");
                        }}
                      >
                        Close
                      </button>
                    </footer>
                  </div>
                </div>
              );
            })()}
          </>
        )}

        {activeTab === "locations" && (
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
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={showEmptyOnly}
                    onChange={(event) => setShowEmptyOnly(event.target.checked)}
                  />
                  <span>Show empty slots only</span>
                </label>
              </div>
            </section>

            <section className="panel">
              <div className="panel-header">
                <h3>Warehouse Locations</h3>
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
                            <td className="muted">{product.lots.length ? product.lots.join(', ') : '—'}</td>
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
                <h3>Finished Goods Rows</h3>
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
                          {row.palletCapacity !== null
                            ? `${row.occupiedPallets}/${row.palletCapacity}`
                            : row.occupiedPallets}
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
        )}
      </div>

      {/* Print Options Modal */}
      {showPrintModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3>Print Options</h3>
              <button
                onClick={() => setShowPrintModal(false)}
                className="modal-close"
              >
                ×
              </button>
            </div>

            <div className="modal-body">
              <p>Select which categories to include in your inventory report:</p>

              <div className="print-options">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={printOptions.includeAllCategories}
                    onChange={(e) => setPrintOptions(prev => ({
                      ...prev,
                      includeAllCategories: e.target.checked,
                      includeRawMaterials: e.target.checked,
                      includePackaging: e.target.checked,
                      includeFinishedGoods: e.target.checked
                    }))}
                  />
                  <span>All Categories</span>
                </label>

                <div className="category-options">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={printOptions.includeRawMaterials}
                      onChange={(e) => setPrintOptions(prev => ({
                        ...prev,
                        includeRawMaterials: e.target.checked,
                        includeAllCategories: false
                      }))}
                      disabled={printOptions.includeAllCategories}
                    />
                    <span>Raw Materials</span>
                  </label>

                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={printOptions.includePackaging}
                      onChange={(e) => setPrintOptions(prev => ({
                        ...prev,
                        includePackaging: e.target.checked,
                        includeAllCategories: false
                      }))}
                      disabled={printOptions.includeAllCategories}
                    />
                    <span>Packaging Materials</span>
                  </label>

                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={printOptions.includeFinishedGoods}
                      onChange={(e) => setPrintOptions(prev => ({
                        ...prev,
                        includeFinishedGoods: e.target.checked,
                        includeAllCategories: false
                      }))}
                      disabled={printOptions.includeAllCategories}
                    />
                    <span>Finished Goods</span>
                  </label>
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button
                onClick={() => setShowPrintModal(false)}
                className="cancel-btn"
              >
                Cancel
              </button>
              <button
                onClick={handlePrint}
                className="print-confirm-btn"
                disabled={!printOptions.includeRawMaterials && !printOptions.includePackaging && !printOptions.includeFinishedGoods && !printOptions.includeAllCategories}
              >
                Print Report
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default InventoryOverview;
