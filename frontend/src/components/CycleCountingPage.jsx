import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../context/AppDataContext';
import { useAuth } from '../context/AuthContext';
import { getDashboardPath } from '../App';
import './CycleCountingPage.css';
import './CycleCountingPageEnhanced.css';

const CycleCountingPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const {
    receipts,
    products,
    productCategories,
    categoryGroups,
    locations,
    storageAreas,
    cycleCounts,
    saveCycleCount,
    subLocationUnifiedLookup,
  } = useAppData();

  const [selectedLocation, setSelectedLocation] = useState('');
  const [selectedSubLocation, setSelectedSubLocation] = useState('');
  const [selectedStorageArea, setSelectedStorageArea] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [countDate, setCountDate] = useState(new Date().toISOString().split('T')[0]);
  const [countStatus, setCountStatus] = useState('planned'); // planned, in-progress, completed
  const [physicalCounts, setPhysicalCounts] = useState({});
  const [variances, setVariances] = useState([]);
  const [selectedCycleCount, setSelectedCycleCount] = useState(null);

  const productLookup = useMemo(() => {
    const map = {};
    products.forEach(product => map[product.id] = product);
    return map;
  }, [products]);

  const categoryLookup = useMemo(() => {
    const map = {};
    productCategories.forEach(cat => map[cat.id] = cat);
    return map;
  }, [productCategories]);


  // Get current location object
  const currentLocation = useMemo(() => {
    return locations.find(l => l.id === selectedLocation);
  }, [locations, selectedLocation]);

  // Get available sub-locations for selected location
  const availableSubLocations = useMemo(() => {
    if (!currentLocation) return [];
    return currentLocation.subLocations || [];
  }, [currentLocation]);

  // Get available storage areas (FG) for selected location
  const availableStorageAreas = useMemo(() => {
    if (!selectedLocation) return [];
    return storageAreas.filter(area => area.locationId === selectedLocation && area.active !== false);
  }, [storageAreas, selectedLocation]);

  // Determine if we should show FG view (storage areas) or regular view (sublocations)
  const isFGLocation = useMemo(() => {
    return availableStorageAreas.length > 0;
  }, [availableStorageAreas]);

  // Get current storage context (subLocation or storageArea)
  const currentStorageContext = useMemo(() => {
    if (isFGLocation && selectedStorageArea) {
      const area = storageAreas.find(a => a.id === selectedStorageArea);
      return { type: 'storageArea', data: area, hasRows: (area?.rows || []).length > 0 };
    } else if (!isFGLocation && selectedSubLocation) {
      const subLoc = availableSubLocations.find(s => s.id === selectedSubLocation);
      return { type: 'subLocation', data: subLoc, hasRows: (subLoc?.rows || []).length > 0 };
    }
    return null;
  }, [isFGLocation, selectedStorageArea, selectedSubLocation, storageAreas, availableSubLocations]);

  // Get inventory items for count sheet - now includes approved OR hold items
  const inventoryItems = useMemo(() => {
    if (!selectedLocation) return [];

    return receipts
      .filter(receipt => {
        // Include approved items OR items on hold
        const approvedOrHold = receipt.status === 'approved' || receipt.hold === true;
        const locationMatch = receipt.location === selectedLocation;
        const categoryMatch = !selectedCategory || receipt.categoryId === selectedCategory;

        // Filter by subLocation if selected (for non-FG)
        let subLocationMatch = true;
        if (!isFGLocation && selectedSubLocation) {
          subLocationMatch = receipt.subLocation === selectedSubLocation;
        }

        // Filter by storage area if selected (for FG)
        let storageAreaMatch = true;
        if (isFGLocation && selectedStorageArea) {
          // Check if receipt is allocated to this storage area
          if (receipt.allocation?.plan) {
            const areaMatch = receipt.allocation.plan.some(p =>
              storageAreas.find(a => a.id === selectedStorageArea)?.rows?.some(r => r.id === p.rowId)
            );
            storageAreaMatch = areaMatch;
          } else {
            storageAreaMatch = false;
          }
        }

        return approvedOrHold && locationMatch && categoryMatch && subLocationMatch && storageAreaMatch;
      })
      .map(receipt => {
        const product = productLookup[receipt.productId];
        const category = categoryLookup[receipt.categoryId];
        return {
          ...receipt,
          product,
          category,
        };
      });
  }, [receipts, selectedLocation, selectedSubLocation, selectedStorageArea, selectedCategory, productLookup, categoryLookup, isFGLocation, storageAreas]);

  // Group inventory by row (if rows exist) or by location
  const groupedInventory = useMemo(() => {
    // Collect all rows from storage areas or sublocations
    let allRows = [];

    if (isFGLocation) {
      // Get rows from selected storage area, or all storage areas if none selected
      if (selectedStorageArea) {
        const area = storageAreas.find(a => a.id === selectedStorageArea);
        allRows = (area?.rows || []).map(row => ({ ...row, areaName: area?.name }));
      } else {
        // Get all rows from all storage areas at this location
        availableStorageAreas.forEach(area => {
          (area.rows || []).forEach(row => {
            allRows.push({ ...row, areaName: area.name });
          });
        });
      }
    } else {
      // Get rows from selected sublocation, or all sublocations if none selected
      if (selectedSubLocation) {
        const subLoc = availableSubLocations.find(s => s.id === selectedSubLocation);
        allRows = (subLoc?.rows || []).map(row => ({ ...row, subLocName: subLoc?.name }));
      } else {
        // Get all rows from all sublocations at this location
        availableSubLocations.forEach(subLoc => {
          (subLoc.rows || []).forEach(row => {
            allRows.push({ ...row, subLocName: subLoc.name });
          });
        });
      }
    }

    // If no rows exist anywhere, use flat view
    if (allRows.length === 0) {
      return { type: 'flat', items: inventoryItems };
    }

    // Group by row
    const grouped = {};
    allRows.forEach(row => {
      grouped[row.id] = { row, items: [] };
    });

    // Track items that don't match any row
    const unassignedItems = [];

    inventoryItems.forEach(item => {
      let assigned = false;

      // For FG, check allocation
      if (isFGLocation && item.allocation?.plan) {
        item.allocation.plan.forEach(alloc => {
          if (grouped[alloc.rowId]) {
            grouped[alloc.rowId].items.push({
              ...item,
              rowAllocation: alloc
            });
            assigned = true;
          }
        });
      } else if (!isFGLocation && item.rowId) {
        // For non-FG with row assignment
        if (grouped[item.rowId]) {
          grouped[item.rowId].items.push(item);
          assigned = true;
        }
      }

      // If item wasn't assigned to any row, add to unassigned
      if (!assigned) {
        unassignedItems.push(item);
      }
    });

    const groups = Object.values(grouped).filter(g => g.items.length > 0);

    return {
      type: 'grouped',
      groups,
      unassignedItems // Items not in any row (e.g. raw materials in sublocations without rows)
    };
  }, [inventoryItems, isFGLocation, selectedStorageArea, selectedSubLocation, storageAreas, availableStorageAreas, availableSubLocations]);

  // Filter cycle counts based on user role
  // Admin/Supervisor can see all, warehouse users can only see their own counts
  const filteredCycleCounts = useMemo(() => {
    const isAdminOrSupervisor = user?.role === 'admin' || user?.role === 'supervisor';

    if (isAdminOrSupervisor) {
      // Admin and Supervisor can see all cycle counts
      return cycleCounts;
    }

    // Warehouse users can only see their own cycle counts
    return cycleCounts.filter(count =>
      count.performedBy === user?.username ||
      count.performedBy === user?.name ||
      count.userId === user?.id
    );
  }, [cycleCounts, user]);

  const handlePhysicalCountChange = (receiptId, value) => {
    setPhysicalCounts(prev => ({
      ...prev,
      [receiptId]: value
    }));
  };

  const generateCountSheet = () => {
    setCountStatus('in-progress');
  };

  // Generate printable count sheet in new window
  const printCountSheet = () => {
    const locationName = locations.find(l => l.id === selectedLocation)?.name || 'Unknown';
    const storageName = currentStorageContext?.data?.name || '';
    const today = new Date().toLocaleDateString();

    // Build HTML content
    let html = `
<!DOCTYPE html>
<html>
<head>
  <title>Count Sheet - ${locationName}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; font-size: 10pt; padding: 10mm; }
    h1 { font-size: 12pt; margin-bottom: 2mm; }
    .info { font-size: 9pt; margin-bottom: 5mm; color: #333; }
    .row-section { margin-bottom: 8mm; page-break-inside: avoid; }
    .row-header { background: #eee; padding: 2mm; font-weight: bold; font-size: 9pt; border: 1px solid #000; }
    table { width: 100%; border-collapse: collapse; font-size: 9pt; }
    th { background: #ddd; border: 1px solid #000; padding: 2mm; text-align: center; font-size: 8pt; }
    td { border: 1px solid #000; padding: 2mm; }
    .num { text-align: right; }
    .count-cell { width: 20mm; }
    .notes-cell { width: 40mm; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <h1>Count Sheet - ${locationName}${storageName ? ' / ' + storageName : ''}</h1>
  <div class="info">Date: ${today} | Items: ${inventoryItems.length}${inventoryItems.filter(i => i.hold).length > 0 ? ` (${inventoryItems.filter(i => i.hold).length} on hold)` : ''}</div>
`;

    // Add row-grouped items
    if (groupedInventory.type === 'grouped' && groupedInventory.groups.length > 0) {
      groupedInventory.groups.forEach(group => {
        html += `
  <div class="row-section">
    <div class="row-header">${group.row.areaName || group.row.subLocName || ''} - ${group.row.name} | Capacity: ${group.row.palletCapacity} pallets</div>
    <table>
      <tr><th>Product</th><th>Lot #</th><th>Pallets</th><th>Cases</th><th class="count-cell">Count</th><th class="notes-cell">Notes</th></tr>
`;
        group.items.forEach(item => {
          const pallets = item.rowAllocation?.pallets || 0;
          const cases = item.rowAllocation?.cases || item.quantity || 0;
          html += `      <tr>
        <td>${item.product?.name || 'Unknown'}</td>
        <td>${item.lotNo || '-'}</td>
        <td class="num">${pallets}</td>
        <td class="num">${cases}</td>
        <td></td>
        <td>${item.hold ? 'HOLD' : ''}</td>
      </tr>\n`;
        });
        html += `    </table>
  </div>\n`;
      });
    }

    // Add unassigned items
    if (groupedInventory.unassignedItems?.length > 0) {
      html += `
  <div class="row-section">
    <div class="row-header">Other Items (Not in Rows) - ${groupedInventory.unassignedItems.length} items</div>
    <table>
      <tr><th>Product</th><th>Lot #</th><th>Location</th><th>Qty</th><th class="count-cell">Count</th><th class="notes-cell">Notes</th></tr>
`;
      groupedInventory.unassignedItems.forEach(item => {
        html += `      <tr>
        <td>${item.product?.name || 'Unknown'}</td>
        <td>${item.lotNo || '-'}</td>
        <td>${getDetailedLocation(item)}</td>
        <td class="num">${item.quantity || 0}</td>
        <td></td>
        <td>${item.hold ? 'HOLD' : ''}</td>
      </tr>\n`;
      });
      html += `    </table>
  </div>\n`;
    }

    // Flat view if no groups
    if (groupedInventory.type === 'flat') {
      html += `
  <table>
    <tr><th>Product</th><th>Lot #</th><th>Location</th><th>Qty</th><th class="count-cell">Count</th><th class="notes-cell">Notes</th></tr>
`;
      inventoryItems.forEach(item => {
        html += `    <tr>
      <td>${item.product?.name || 'Unknown'}</td>
      <td>${item.lotNo || '-'}</td>
      <td>${getDetailedLocation(item)}</td>
      <td class="num">${item.quantity || 0}</td>
      <td></td>
      <td>${item.hold ? 'HOLD' : ''}</td>
    </tr>\n`;
      });
      html += `  </table>\n`;
    }

    html += `
</body>
</html>`;

    // Open in new window and print
    const printWindow = window.open('', '_blank');
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => printWindow.print(), 250);
  };

  const calculateVariances = () => {
    const varianceMap = new Map(); // Track variances by receipt ID (to aggregate multi-row items)

    // Process row-grouped items (finished goods with row allocations)
    if (groupedInventory.type === 'grouped' && groupedInventory.groups.length > 0) {
      groupedInventory.groups.forEach(group => {
        group.items.forEach(item => {
          const countKey = `${item.id}-${group.row.id}`;
          const actualPallets = Number(physicalCounts[countKey]) || 0;
          
          if (physicalCounts[countKey] !== undefined) {
            // For row-grouped items, expected is pallets from allocation
            const expectedPallets = Number(item.rowAllocation?.pallets || 0);
            const variance = actualPallets - expectedPallets;
            
            // Aggregate if item appears in multiple rows
            if (varianceMap.has(item.id)) {
              const existing = varianceMap.get(item.id);
              existing.expectedQuantity += expectedPallets;
              existing.actualQuantity += actualPallets;
              existing.variance += variance;
            } else {
              varianceMap.set(item.id, {
                receiptId: item.id,
                productName: item.product?.name || 'Unknown',
                lotNo: item.lotNo || '—',
                expectedQuantity: expectedPallets,
                actualQuantity: actualPallets,
                variance: variance,
              });
            }
          }
        });
      });
    }

    // Process unassigned items (raw materials/packaging not in rows)
    if (groupedInventory.type === 'grouped' && groupedInventory.unassignedItems) {
      groupedInventory.unassignedItems.forEach(item => {
        if (physicalCounts[item.id] !== undefined) {
          const expected = Number(item.quantity) || 0;
          const actual = Number(physicalCounts[item.id]) || 0;
          const variance = actual - expected;
          
          if (varianceMap.has(item.id)) {
            const existing = varianceMap.get(item.id);
            existing.expectedQuantity += expected;
            existing.actualQuantity += actual;
            existing.variance += variance;
          } else {
            varianceMap.set(item.id, {
              receiptId: item.id,
              productName: item.product?.name || 'Unknown',
              lotNo: item.lotNo || '—',
              expectedQuantity: expected,
              actualQuantity: actual,
              variance: variance,
            });
          }
        }
      });
    }

    // Process flat view items (when no rows exist)
    if (groupedInventory.type === 'flat') {
      inventoryItems.forEach(item => {
        if (physicalCounts[item.id] !== undefined) {
          const expected = Number(item.quantity) || 0;
          const actual = Number(physicalCounts[item.id]) || 0;
          const variance = actual - expected;
          
          varianceMap.set(item.id, {
            receiptId: item.id,
            productName: item.product?.name || 'Unknown',
            lotNo: item.lotNo || '—',
            expectedQuantity: expected,
            actualQuantity: actual,
            variance: variance,
          });
        }
      });
    }

    // Convert map to array and calculate percentages
    const newVariances = Array.from(varianceMap.values()).map(v => {
      const variancePercent = v.expectedQuantity > 0 
        ? ((v.variance / v.expectedQuantity) * 100).toFixed(2) 
        : 0;
      
      return {
        ...v,
        variancePercent,
        status: Math.abs(v.variance) < 1 ? 'ok' : v.variance < 0 ? 'shortage' : 'overage',
      };
    });

    setVariances(newVariances);

    // Calculate summary
    const totalVariance = newVariances.reduce((sum, v) => sum + v.variance, 0);
    const totalExpected = newVariances.reduce((sum, v) => sum + v.expectedQuantity, 0);
    const varianceValue = totalExpected > 0 ? ((totalVariance / totalExpected) * 100).toFixed(2) : 0;

    const summary = {
      totalItems: newVariances.length,
      totalVariance,
      varianceValue,
      expectedValue: totalExpected,
      actualValue: totalExpected + totalVariance,
    };

    setCountStatus('completed');

    // Save to history
    saveCycleCount({
      location: selectedLocation,
      category: selectedCategory,
      countDate,
      items: newVariances,
      summary,
      performedBy: user?.name || user?.username || 'Unknown',
      performedById: user?.id || 'unknown',
    });
  };

  const getTotalVarianceSummary = () => {
    const totalVariance = variances.reduce((sum, v) => sum + v.variance, 0);
    const totalExpected = variances.reduce((sum, v) => sum + v.expectedQuantity, 0);
    const varianceValue = totalExpected > 0 ? ((totalVariance / totalExpected) * 100).toFixed(2) : 0;

    return {
      totalItems: variances.length,
      totalVariance,
      varianceValue,
      expectedValue: totalExpected,
      actualValue: totalExpected + totalVariance,
    };
  };

  const getDetailedLocation = (item) => {
    const location = locations.find(l => l.id === item.location);
    const locationName = location?.name || item.location || '—';

    // For finished goods, show allocation details
    if (item.categoryId?.startsWith('cat-our-finished') || item.categoryId?.startsWith('cat-other-finished')) {
      if (item.allocation?.success) {
        const details = [];

        // Add rack details
        if (item.allocation.plan && item.allocation.plan.length > 0) {
          const areas = [...new Set(item.allocation.plan.map(p => p.areaName))];
          details.push(`Rack: ${areas.join(', ')}`);
        }

        // Add floor details
        if (item.allocation.floorAllocation && item.allocation.floorAllocation.pallets > 0) {
          details.push('Floor');
        }

        const locationText = details.length > 0 ? ` (${details.join(', ')})` : '';
        return `${locationName}${locationText}`;
      }
      return locationName;
    }

    // For raw materials and packaging, show subLocation name
    if (item.subLocation) {
      // Use the precomputed lookup map from AppDataContext
      const subLocInfo = subLocationUnifiedLookup?.[item.subLocation];
      const subLocationName = subLocInfo?.name || item.subLocation;
      return `${locationName} / ${subLocationName}`;
    }

    return locationName;
  };

  const getCategoryHierarchy = (categoryId) => {
    const category = categoryLookup[categoryId];
    if (!category) return 'Unknown';

    const parent = categoryGroups.find(g => g.id === category.parentId);
    if (!parent) return category.name;

    // Group → Type → Category format
    const parts = [parent.name];

    // Add subtype if available (for raw materials: ingredient/packaging)
    if (category.subType) {
      const subTypeLabel = category.subType === 'ingredient' ? 'Ingredient' :
        category.subType === 'packaging' ? 'Packaging' : category.subType;
      parts.push(subTypeLabel);
    }

    parts.push(category.name);

    return parts.join(' → ');
  };

  const summary = getTotalVarianceSummary();

  return (
    <div className="cycle-counting-page">
      <div className="page-header">
        <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
          ← Back to Dashboard
        </button>
      </div>

      <div className="page-content">
        <h1>Cycle Counting / Physical Inventory</h1>
        <p className="page-description">
          Schedule and perform physical inventory counts. Track discrepancies and generate variance reports.
        </p>

        <div className="count-setup-panel">
          <h2>Count Setup</h2>
          <div className="form-grid">
            <label>
              <span>Location</span>
              <select
                value={selectedLocation}
                onChange={(e) => {
                  setSelectedLocation(e.target.value);
                  setSelectedSubLocation('');
                  setSelectedStorageArea('');
                  setPhysicalCounts({});
                  setVariances([]);
                  setCountStatus('planned');
                }}
                required
              >
                <option value="">Select location</option>
                {locations.map(location => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </label>

            {/* SubLocation selector for non-FG locations */}
            {selectedLocation && !isFGLocation && availableSubLocations.length > 0 && (
              <label>
                <span>Storage Area</span>
                <select
                  value={selectedSubLocation}
                  onChange={(e) => {
                    setSelectedSubLocation(e.target.value);
                    setPhysicalCounts({});
                    setVariances([]);
                    setCountStatus('planned');
                  }}
                >
                  <option value="">All Sub-Locations</option>
                  {availableSubLocations.map(sub => (
                    <option key={sub.id} value={sub.id}>
                      {sub.name} {sub.rows?.length > 0 ? `(${sub.rows.length} rows)` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {/* Storage Area selector for FG locations */}
            {selectedLocation && isFGLocation && (
              <label>
                <span>Storage Zone</span>
                <select
                  value={selectedStorageArea}
                  onChange={(e) => {
                    setSelectedStorageArea(e.target.value);
                    setPhysicalCounts({});
                    setVariances([]);
                    setCountStatus('planned');
                  }}
                >
                  <option value="">All Zones</option>
                  {availableStorageAreas.map(area => (
                    <option key={area.id} value={area.id}>
                      {area.name} ({area.rows?.length || 0} rows)
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label>
              <span>Category (Optional)</span>
              <select
                value={selectedCategory}
                onChange={(e) => {
                  setSelectedCategory(e.target.value);
                  setPhysicalCounts({});
                  setVariances([]);
                  setCountStatus('planned');
                }}
              >
                <option value="">All Categories</option>
                {productCategories.map(category => (
                  <option key={category.id} value={category.id}>
                    {getCategoryHierarchy(category.id)}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Count Date</span>
              <input
                type="date"
                value={countDate}
                onChange={(e) => setCountDate(e.target.value)}
                required
              />
            </label>
          </div>

          {selectedLocation && (
            <button
              className="primary-button"
              onClick={generateCountSheet}
              disabled={countStatus === 'in-progress'}
            >
              Generate Count Sheet
            </button>
          )}
        </div>

        {countStatus !== 'planned' && inventoryItems.length > 0 && (
          <div className="count-sheet-panel">
            <div className="panel-header">
              <h2>
                Count Sheet - {locations.find(l => l.id === selectedLocation)?.name}
                {currentStorageContext && ` / ${currentStorageContext.data?.name || ''}`}
              </h2>
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                <span style={{ fontSize: '14px', color: '#666' }}>
                  {inventoryItems.length} items
                  {inventoryItems.filter(i => i.hold).length > 0 &&
                    ` (${inventoryItems.filter(i => i.hold).length} on hold)`}
                </span>
                <span className="status-badge">{countStatus === 'in-progress' ? 'In Progress' : 'Completed'}</span>
                <button
                  className="secondary-button"
                  onClick={printCountSheet}
                  style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  🖨️ Print
                </button>
              </div>
            </div>

            {/* Row-grouped view (when rows exist) */}
            {groupedInventory.type === 'grouped' && groupedInventory.groups.length > 0 && (
              <div className="row-grouped-view">
                {groupedInventory.groups.map(group => (
                  <div key={group.row.id} style={{ marginBottom: '24px' }}>
                    <div style={{
                      background: 'linear-gradient(135deg, #FF6B35 0%, #FFD23F 100%)',
                      color: 'white',
                      padding: '10px 16px',
                      borderRadius: '8px 8px 0 0',
                      fontWeight: '600',
                      display: 'flex',
                      justifyContent: 'space-between'
                    }}>
                      <span>Row: {group.row.name}</span>
                      <span style={{ opacity: 0.9, fontWeight: 'normal' }}>
                        Capacity: {group.row.palletCapacity} pallets · {group.items.length} items
                      </span>
                    </div>
                    {group.items.length > 0 ? (
                      <div className="table-wrapper" style={{ border: '1px solid #e5e7eb', borderTop: 'none', borderRadius: '0 0 8px 8px' }}>
                        <table className="count-sheet-table">
                          <thead>
                            <tr>
                              <th>Product</th>
                              <th>Lot #</th>
                              <th>Pallets</th>
                              <th>Cases</th>
                              <th>Physical Count</th>
                              <th>Variance</th>
                              <th>Hold</th>
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {group.items.map(item => {
                              const pallets = Number(item.rowAllocation?.pallets || 0);
                              const cases = Number(item.rowAllocation?.cases || item.quantity) || 0;
                              const actual = Number(physicalCounts[`${item.id}-${group.row.id}`]) || 0;
                              const variance = actual - pallets;
                              const status = Math.abs(variance) < 1 ? 'ok' : variance < 0 ? 'shortage' : 'overage';

                              return (
                                <tr key={`${item.id}-${group.row.id}`}>
                                  <td>{item.product?.name || 'Unknown'}</td>
                                  <td>{item.lotNo || '—'}</td>
                                  <td className="text-right">{pallets.toLocaleString()}</td>
                                  <td className="text-right">{cases.toLocaleString()}</td>
                                  <td>
                                    <input
                                      type="number"
                                      min="0"
                                      step="1"
                                      value={physicalCounts[`${item.id}-${group.row.id}`] || ''}
                                      onChange={(e) => handlePhysicalCountChange(`${item.id}-${group.row.id}`, e.target.value)}
                                      className="count-input"
                                    />
                                  </td>
                                  <td className={`text-right variance-${status}`}>
                                    {countStatus === 'completed' ? (
                                      <>
                                        {variance > 0 ? '+' : ''}{variance.toLocaleString()}
                                      </>
                                    ) : '—'}
                                  </td>
                                  <td>
                                    {item.hold ? (
                                      <span style={{
                                        background: '#fee2e2',
                                        color: '#b91c1c',
                                        padding: '2px 8px',
                                        borderRadius: '12px',
                                        fontSize: '12px',
                                        fontWeight: '600'
                                      }}>HOLD</span>
                                    ) : '—'}
                                  </td>
                                  <td>
                                    {countStatus === 'completed' && (
                                      <span className={`status-badge-${status}`}>
                                        {status === 'ok' ? '✓' : '⚠'}
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div style={{
                        padding: '16px',
                        background: '#f9fafb',
                        border: '1px solid #e5e7eb',
                        borderTop: 'none',
                        borderRadius: '0 0 8px 8px',
                        color: '#6b7280',
                        textAlign: 'center'
                      }}>
                        No items in this row
                      </div>
                    )}
                  </div>
                ))}

                {/* Unassigned items (raw materials/packaging not in rows) */}
                {groupedInventory.unassignedItems?.length > 0 && (
                  <div style={{ marginTop: '24px' }}>
                    <div style={{
                      background: '#6b7280',
                      color: 'white',
                      padding: '10px 16px',
                      borderRadius: '8px 8px 0 0',
                      fontWeight: '600',
                      display: 'flex',
                      justifyContent: 'space-between'
                    }}>
                      <span>Other Items (Not in Rows)</span>
                      <span style={{ opacity: 0.9, fontWeight: 'normal' }}>
                        {groupedInventory.unassignedItems.length} items
                      </span>
                    </div>
                    <div className="table-wrapper" style={{ border: '1px solid #e5e7eb', borderTop: 'none', borderRadius: '0 0 8px 8px' }}>
                      <table className="count-sheet-table">
                        <thead>
                          <tr>
                            <th>Product</th>
                            <th>Lot #</th>
                            <th>Location</th>
                            <th>System Qty</th>
                            <th>Physical Count</th>
                            <th>Variance</th>
                            <th>Hold</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {groupedInventory.unassignedItems.map(item => {
                            const expected = Number(item.quantity) || 0;
                            const actual = Number(physicalCounts[item.id]) || 0;
                            const variance = actual - expected;
                            const status = Math.abs(variance) < 1 ? 'ok' : variance < 0 ? 'shortage' : 'overage';

                            return (
                              <tr key={item.id}>
                                <td>{item.product?.name || 'Unknown'}</td>
                                <td>{item.lotNo || '—'}</td>
                                <td>{getDetailedLocation(item)}</td>
                                <td className="text-right">{expected.toLocaleString()}</td>
                                <td>
                                  <input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    value={physicalCounts[item.id] || ''}
                                    onChange={(e) => handlePhysicalCountChange(item.id, e.target.value)}
                                    className="count-input"
                                  />
                                </td>
                                <td className={`text-right variance-${status}`}>
                                  {countStatus === 'completed' ? (
                                    <>
                                      {variance > 0 ? '+' : ''}{variance.toLocaleString()}
                                    </>
                                  ) : '—'}
                                </td>
                                <td>
                                  {item.hold ? (
                                    <span style={{
                                      background: '#fee2e2',
                                      color: '#b91c1c',
                                      padding: '2px 8px',
                                      borderRadius: '12px',
                                      fontSize: '12px',
                                      fontWeight: '600'
                                    }}>HOLD</span>
                                  ) : '—'}
                                </td>
                                <td>
                                  {countStatus === 'completed' && (
                                    <span className={`status-badge-${status}`}>
                                      {status === 'ok' ? '✓' : '⚠'}
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Flat view (when no rows exist anywhere) */}
            {groupedInventory.type === 'flat' && (
              <div className="table-wrapper">
                <table className="count-sheet-table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Lot Number</th>
                      <th>Category</th>
                      <th>Location</th>
                      <th>System Qty</th>
                      <th>Physical Count</th>
                      <th>Variance</th>
                      <th>Hold</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inventoryItems.map(item => {
                      const expected = Number(item.quantity) || 0;
                      const actual = Number(physicalCounts[item.id]) || 0;
                      const variance = actual - expected;
                      const status = Math.abs(variance) < 1 ? 'ok' : variance < 0 ? 'shortage' : 'overage';

                      return (
                        <tr key={item.id}>
                          <td>{item.product?.name || 'Unknown'}</td>
                          <td>{item.lotNo || '—'}</td>
                          <td>{item.category?.name || '—'}</td>
                          <td>{getDetailedLocation(item)}</td>
                          <td className="text-right">{expected.toLocaleString()}</td>
                          <td>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={physicalCounts[item.id] || ''}
                              onChange={(e) => handlePhysicalCountChange(item.id, e.target.value)}
                              className="count-input"
                            />
                          </td>
                          <td className={`text-right variance-${status}`}>
                            {countStatus === 'completed' ? (
                              <>
                                {variance > 0 ? '+' : ''}{variance.toLocaleString()}
                                <span className="variance-percent">
                                  ({expected > 0 ? ((variance / expected) * 100).toFixed(2) : 0}%)
                                </span>
                              </>
                            ) : '—'}
                          </td>
                          <td>
                            {item.hold ? (
                              <span style={{
                                background: '#fee2e2',
                                color: '#b91c1c',
                                padding: '2px 8px',
                                borderRadius: '12px',
                                fontSize: '12px',
                                fontWeight: '600'
                              }}>HOLD</span>
                            ) : '—'}
                          </td>
                          <td>
                            {countStatus === 'completed' && (
                              <span className={`status-badge-${status}`}>
                                {status === 'ok' ? '✓ OK' : status === 'shortage' ? '⚠ Shortage' : '⚠ Overage'}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="count-actions">
              <button
                className="secondary-button"
                onClick={calculateVariances}
                disabled={countStatus === 'completed' || Object.keys(physicalCounts).length === 0}
              >
                Calculate Variances
              </button>
            </div>
          </div>
        )}

        {countStatus === 'completed' && variances.length > 0 && (
          <div className="variance-summary-panel">
            <h2>Variance Summary</h2>
            <div className="variance-stats">
              <div className="stat-item">
                <div className="stat-label">Total Items Counted</div>
                <div className="stat-value">{summary.totalItems}</div>
              </div>
              <div className="stat-item">
                <div className="stat-label">System Total</div>
                <div className="stat-value">{summary.expectedValue.toLocaleString()}</div>
              </div>
              <div className="stat-item">
                <div className="stat-label">Physical Total</div>
                <div className="stat-value">{summary.actualValue.toLocaleString()}</div>
              </div>
              <div className="stat-item">
                <div className="stat-label">Total Variance</div>
                <div className={`stat-value ${summary.totalVariance !== 0 ? 'variance-negative' : ''}`}>
                  {summary.totalVariance > 0 ? '+' : ''}{summary.totalVariance.toLocaleString()}
                </div>
              </div>
              <div className="stat-item">
                <div className="stat-label">Variance %</div>
                <div className={`stat-value ${summary.totalVariance !== 0 ? 'variance-negative' : ''}`}>
                  {summary.varianceValue}%
                </div>
              </div>
            </div>

            <h3>Variance Details</h3>
            <div className="table-wrapper">
              <table className="variance-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Lot</th>
                    <th>Location</th>
                    <th>System</th>
                    <th>Physical</th>
                    <th>Variance</th>
                    <th>%</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {variances.map(v => {
                    const receipt = receipts.find(r => r.id === v.receiptId);
                    return (
                      <tr key={v.receiptId}>
                        <td>{v.productName}</td>
                        <td>{v.lotNo}</td>
                        <td>{getDetailedLocation(receipt)}</td>
                        <td className="text-right">{v.expectedQuantity.toLocaleString()}</td>
                        <td className="text-right">{v.actualQuantity.toLocaleString()}</td>
                        <td className={`text-right variance-${v.status}`}>
                          {v.variance > 0 ? '+' : ''}{v.variance.toLocaleString()}
                        </td>
                        <td className={`text-right variance-${v.status}`}>
                          {v.variancePercent}%
                        </td>
                        <td>
                          <span className={`status-badge-${v.status}`}>
                            {v.status === 'ok' ? '✓ OK' : v.status === 'shortage' ? '⚠ Shortage' : '⚠ Overage'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {selectedLocation && inventoryItems.length === 0 && (
          <div className="empty-state">
            No inventory items found for the selected location and category.
          </div>
        )}

        {/* Cycle Count History */}
        <div className="count-history-panel">
          <h2>Cycle Count History</h2>
          {filteredCycleCounts.length > 0 ? (
            <div className="table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Location</th>
                    <th>Category</th>
                    <th>Items</th>
                    <th>Total Variance</th>
                    <th>Variance %</th>
                    <th>Performed By</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCycleCounts.map((count) => {
                    const location = locations.find(l => l.id === count.location);
                    const category = productCategories.find(c => c.id === count.category);
                    return (
                      <tr key={count.id} onClick={() => setSelectedCycleCount(count)} style={{ cursor: 'pointer' }}>
                        <td>{new Date(count.countDate).toLocaleDateString()}</td>
                        <td>{location?.name || 'Unknown'}</td>
                        <td>{category?.name || count.category || 'All Categories'}</td>
                        <td>{count.summary.totalItems}</td>
                        <td className={`text-right ${count.summary.totalVariance !== 0 ? 'variance-negative' : ''}`}>
                          {count.summary.totalVariance > 0 ? '+' : ''}{count.summary.totalVariance}
                        </td>
                        <td className={`text-right ${count.summary.totalVariance !== 0 ? 'variance-negative' : ''}`}>
                          {count.summary.varianceValue}%
                        </td>
                        <td>{count.performedBy || 'Unknown'}</td>
                        <td>
                          <span className={count.summary.totalVariance === 0 ? 'status-ok' : 'status-warning'}>
                            {count.summary.totalVariance === 0 ? '✓ OK' : '⚠ Variance'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">
              No cycle count history available yet.
            </div>
          )}
        </div>

        {/* Detailed View Modal */}
        {selectedCycleCount && (
          <div className="modal-overlay" onClick={() => setSelectedCycleCount(null)}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Cycle Count Details</h2>
                <button className="close-button" onClick={() => setSelectedCycleCount(null)}>×</button>
              </div>

              <div className="modal-body">
                <div className="detail-section">
                  <h3>Count Summary</h3>
                  <div className="detail-grid">
                    <div className="detail-item">
                      <span className="detail-label">Date:</span>
                      <span className="detail-value">{new Date(selectedCycleCount.countDate).toLocaleDateString()}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Location:</span>
                      <span className="detail-value">{locations.find(l => l.id === selectedCycleCount.location)?.name || 'Unknown'}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Category:</span>
                      <span className="detail-value">{productCategories.find(c => c.id === selectedCycleCount.category)?.name || selectedCycleCount.category || 'All Categories'}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Performed By:</span>
                      <span className="detail-value">{selectedCycleCount.performedBy || 'Unknown'}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Total Items:</span>
                      <span className="detail-value">{selectedCycleCount.summary.totalItems}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">System Total:</span>
                      <span className="detail-value">{selectedCycleCount.summary.expectedValue.toLocaleString()}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Physical Total:</span>
                      <span className="detail-value">{selectedCycleCount.summary.actualValue.toLocaleString()}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Total Variance:</span>
                      <span className={`detail-value ${selectedCycleCount.summary.totalVariance !== 0 ? 'variance-negative' : ''}`}>
                        {selectedCycleCount.summary.totalVariance > 0 ? '+' : ''}{selectedCycleCount.summary.totalVariance.toLocaleString()}
                      </span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Variance %:</span>
                      <span className={`detail-value ${selectedCycleCount.summary.totalVariance !== 0 ? 'variance-negative' : ''}`}>
                        {selectedCycleCount.summary.varianceValue}%
                      </span>
                    </div>
                  </div>
                </div>

                <div className="detail-section">
                  <h3>Item Details</h3>
                  <div className="table-wrapper">
                    <table className="detail-table">
                      <thead>
                        <tr>
                          <th>Product</th>
                          <th>Lot</th>
                          <th>Location Details</th>
                          <th>System Qty</th>
                          <th>Physical Qty</th>
                          <th>Variance</th>
                          <th>%</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedCycleCount.items.map((item, idx) => {
                          const receipt = receipts.find(r => r.id === item.receiptId);
                          return (
                            <tr key={idx}>
                              <td>{item.productName}</td>
                              <td>{item.lotNo}</td>
                              <td>{getDetailedLocation(receipt)}</td>
                              <td className="text-right">{item.expectedQuantity.toLocaleString()}</td>
                              <td className="text-right">{item.actualQuantity.toLocaleString()}</td>
                              <td className={`text-right variance-${item.status}`}>
                                {item.variance > 0 ? '+' : ''}{item.variance.toLocaleString()}
                              </td>
                              <td className={`text-right variance-${item.status}`}>
                                {item.variancePercent}%
                              </td>
                              <td>
                                <span className={`status-badge-${item.status}`}>
                                  {item.status === 'ok' ? '✓ OK' : item.status === 'shortage' ? '⚠ Shortage' : '⚠ Overage'}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              <div className="modal-footer">
                <button className="secondary-button" onClick={() => setSelectedCycleCount(null)}>Close</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default CycleCountingPage;

