import React, { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppData } from "../context/AppDataContext";
import { useAuth } from "../context/AuthContext";
import { getDashboardPath } from "../App";
import "./MasterDataPage.css";
import "./MasterDataPageExtra.css";

const MasterDataPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const {
    categories,
    addCategory,
    updateCategory,
    toggleCategoryActive,
    vendors,
    addVendor,
    updateVendor,
    toggleVendorActive,
    locationsTree,
    addLocation,
    renameLocation,
    toggleLocationActive,
    addSubLocation,
    addSubLocationRow,
    updateSubLocationRow,
    toggleSubLocationRowActive,
    renameSubLocation,
    toggleSubLocationActive,
    storageAreas,
    addStorageArea,
    updateStorageArea,
    toggleStorageAreaActive,
    locations,
    addStorageRow,
    updateStorageRow,
    toggleStorageRowActive,
    finishedGoodsRows,
    productionShifts,
    productionLines,
    addProductionShift,
    removeProductionShift,
    addProductionLine,
    removeProductionLine,
    updateProductionShift,
    updateProductionLine,
    toggleProductionShiftActive,
    toggleProductionLineActive,
  } = useAppData();

  const [showInactiveCategories, setShowInactiveCategories] = useState(false);
  const [showInactiveVendors, setShowInactiveVendors] = useState(false);
  const [showInactiveLocations, setShowInactiveLocations] = useState(false);
  const [showInactiveStorage, setShowInactiveStorage] = useState(false);

  // FG Storage UI state
  const [fgSearchTerm, setFgSearchTerm] = useState("");
  const [fgLocationFilter, setFgLocationFilter] = useState("all");
  const [expandedAreas, setExpandedAreas] = useState(new Set());
  const [expandedZones, setExpandedZones] = useState(new Set());
  const [expandedSubLocations, setExpandedSubLocations] = useState(new Set());

  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryType, setNewCategoryType] = useState("raw");
  const [newCategorySubType, setNewCategorySubType] = useState("ingredient");
  const [editingCategory, setEditingCategory] = useState(null);
  const [categoryDraft, setCategoryDraft] = useState("");
  const [categoryTypeDraft, setCategoryTypeDraft] = useState("raw");
  const [categorySubTypeDraft, setCategorySubTypeDraft] = useState("ingredient");
  const [newCategoryParent, setNewCategoryParent] = useState("");
  const [categoryParentDraft, setCategoryParentDraft] = useState("");

  const [newVendorName, setNewVendorName] = useState("");
  const [editingVendor, setEditingVendor] = useState(null);
  const [vendorDraft, setVendorDraft] = useState("");

  const [newLocationName, setNewLocationName] = useState("");
  const [parentForSub, setParentForSub] = useState("");
  const [newSubName, setNewSubName] = useState("");
  const [editingLocation, setEditingLocation] = useState(null);
  const [locationDraft, setLocationDraft] = useState("");
  const [editingSubLocation, setEditingSubLocation] = useState(null);
  const [subLocationDraft, setSubLocationDraft] = useState("");

  const [newAreaName, setNewAreaName] = useState("");
  const [newAreaLocation, setNewAreaLocation] = useState("");
  const [allowFloorStorage, setAllowFloorStorage] = useState(true);
  const fgFormRef = useRef(null);
  const [editingArea, setEditingArea] = useState(null);
  const [areaDraft, setAreaDraft] = useState("");
  const [editingRow, setEditingRow] = useState(null);
  const [rowDraft, setRowDraft] = useState({
    name: "",
    template: "3x5",
    palletCapacity: 15,
    defaultCasesPerPallet: 60,
    notes: "",
  });
  const [newRowDraft, setNewRowDraft] = useState({
    name: "",
    template: "3x5",
    palletCapacity: 15,
    defaultCasesPerPallet: 60,
    notes: "",
  });
  const [rowError, setRowError] = useState("");
  const [newShiftName, setNewShiftName] = useState("");
  const [newShiftNotes, setNewShiftNotes] = useState("");
  const [editingShift, setEditingShift] = useState(null);
  const [shiftDraft, setShiftDraft] = useState({ name: "", notes: "" });
  const [showInactiveShifts, setShowInactiveShifts] = useState(false);

  const [newLineName, setNewLineName] = useState("");
  const [newLineNotes, setNewLineNotes] = useState("");
  const [editingLine, setEditingLine] = useState(null);
  const [lineDraft, setLineDraft] = useState({ name: "", notes: "" });
  const [showInactiveLines, setShowInactiveLines] = useState(false);

  const parentOptions = useMemo(
    () => categories.filter((category) => category.type === "group"),
    [categories],
  );
  const displayCategories = useMemo(
    () =>
      categories.filter((category) => category.type !== "group" && (showInactiveCategories || category.active !== false)),
    [categories, showInactiveCategories],
  );

  const filteredVendors = useMemo(
    () => vendors.filter((vendor) => showInactiveVendors || vendor.active !== false),
    [vendors, showInactiveVendors],
  );

  const filteredLocations = useMemo(() => {
    if (showInactiveLocations) return locationsTree;
    return locationsTree.map((location) => ({
      ...location,
      subLocations: location.subLocations.filter((sub) => sub.active !== false),
    })).filter((location) => location.active !== false);
  }, [locationsTree, showInactiveLocations]);

  const filteredStorageAreas = useMemo(() => {
    let areas = storageAreas;

    // Filter by active status
    if (!showInactiveStorage) {
      areas = areas
        .filter((area) => area.active !== false)
        .map((area) => ({
          ...area,
          rows: area.rows.filter((row) => row.active !== false),
        }));
    }

    // Filter by location
    if (fgLocationFilter !== "all") {
      areas = areas.filter((area) => area.locationId === fgLocationFilter);
    }

    // Filter by search term
    if (fgSearchTerm.trim()) {
      const searchLower = fgSearchTerm.toLowerCase().trim();
      areas = areas
        .filter((area) => {
          const areaMatches = area.name.toLowerCase().includes(searchLower);
          const rowMatches = area.rows.some((row) =>
            row.name.toLowerCase().includes(searchLower)
          );
          return areaMatches || rowMatches;
        })
        .map((area) => ({
          ...area,
          rows: area.rows.filter((row) =>
            row.name.toLowerCase().includes(searchLower)
          ),
        }));
    }

    return areas;
  }, [storageAreas, showInactiveStorage, fgLocationFilter, fgSearchTerm]);

  // Group rows by zone (e.g., AA, AB, AC) for each area
  const groupedStorageAreas = useMemo(() => {
    return filteredStorageAreas.map((area) => {
      // Group rows by zone prefix (e.g., "AA 1", "AA 2" -> zone "AA")
      const zoneMap = new Map();

      area.rows.forEach((row) => {
        // Extract zone prefix (e.g., "AA 1" -> "AA", "AB 10" -> "AB")
        const match = row.name.match(/^([A-Z]+)\s*\d+/i);
        const zone = match ? match[1].toUpperCase() : row.name.split(/\s/)[0].toUpperCase();

        if (!zoneMap.has(zone)) {
          zoneMap.set(zone, []);
        }
        zoneMap.get(zone).push(row);
      });

      // Convert to array and sort zones
      const zones = Array.from(zoneMap.entries())
        .map(([zoneName, rows]) => ({
          name: zoneName,
          rows: rows.sort((a, b) => {
            // Sort rows within zone by number (AA 1, AA 2, ... AA 10)
            const numA = parseInt(a.name.match(/\d+/)?.[0] || "0");
            const numB = parseInt(b.name.match(/\d+/)?.[0] || "0");
            return numA - numB;
          }),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return {
        ...area,
        zones,
        totalRows: area.rows.length,
        totalCapacity: area.rows.reduce((sum, row) => sum + row.palletCapacity, 0),
        totalUsed: area.rows.reduce((sum, row) => sum + (row.occupiedPallets || 0), 0),
        utilization: area.rows.reduce((sum, row) => {
          const capacity = row.palletCapacity || 1;
          const used = row.occupiedPallets || 0;
          return sum + (used / capacity);
        }, 0) / area.rows.length * 100,
      };
    });
  }, [filteredStorageAreas]);

  const filteredShifts = useMemo(
    () =>
      productionShifts.filter(
        (shift) => showInactiveShifts || shift.active !== false,
      ),
    [productionShifts, showInactiveShifts],
  );

  const filteredLines = useMemo(
    () =>
      productionLines.filter(
        (line) => showInactiveLines || line.active !== false,
      ),
    [productionLines, showInactiveLines],
  );

  const stats = useMemo(() => {
    const locationCount = locationsTree.filter((loc) => loc.active !== false).length;
    const subLocationCount = locationsTree.reduce(
      (sum, loc) =>
        sum + loc.subLocations.filter((sub) => sub.active !== false).length,
      0,
    );
    return [
      { label: "Categories", value: categories.filter((cat) => cat.active !== false && cat.type !== "group").length },
      { label: "Vendors", value: vendors.filter((vendor) => vendor.active !== false).length },
      { label: "Locations", value: locationCount },
      { label: "Sub Locations", value: subLocationCount },
      { label: "FG Areas", value: storageAreas.filter((area) => area.active !== false).length },
      { label: "FG Rows", value: finishedGoodsRows.filter((row) => row.active !== false).length },
      { label: "Production Shifts", value: productionShifts.length },
      { label: "Production Lines", value: productionLines.length },
    ];
  }, [
    categories,
    vendors,
    locationsTree,
    storageAreas,
    finishedGoodsRows,
    productionShifts,
    productionLines,
  ]);

  const handleAddCategory = async (event) => {
    event.preventDefault();
    if (!newCategoryName.trim()) {
      alert('Please enter a category name');
      return;
    }
    try {
      const created = await addCategory(
        newCategoryName,
        newCategoryType,
        newCategoryType === "raw" ? newCategorySubType : null,
        newCategoryParent || null,
      );
      if (created) {
        setNewCategoryName("");
        setNewCategoryType("raw");
        setNewCategorySubType("ingredient");
        setNewCategoryParent("");
      }
    } catch (error) {
      console.error('Error adding category:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to add category. Please try again.';
      alert(errorMessage);
    }
  };

  const handleSaveCategory = async (id) => {
    const name = categoryDraft.trim();
    if (!name) return;
    try {
      await updateCategory(id, {
        name,
        type: categoryTypeDraft,
        subType: categoryTypeDraft === "raw" ? categorySubTypeDraft : null,
        parentId: categoryParentDraft || null,
      });
    } catch (error) {
      console.error('Error updating category:', error);
      alert('Failed to update category. Please try again.');
    }
    setEditingCategory(null);
    setCategoryDraft("");
  };

  const handleAddVendor = async (event) => {
    event.preventDefault();
    if (!newVendorName.trim()) return;
    try {
      const created = await addVendor(newVendorName);
      if (created) {
        setNewVendorName("");
      }
    } catch (error) {
      console.error('Error adding vendor:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to add vendor. Please try again.';
      alert(errorMessage);
    }
  };

  const handleSaveVendor = async (id) => {
    const name = vendorDraft.trim();
    if (!name) return;
    try {
      await updateVendor(id, name);
      setEditingVendor(null);
      setVendorDraft("");
    } catch (error) {
      console.error('Error updating vendor:', error);
      alert('Failed to update vendor. Please try again.');
    }
  };

  const handleAddLocation = async (event) => {
    event.preventDefault();
    if (!newLocationName.trim()) return;
    try {
      const created = await addLocation(newLocationName);
      if (created) {
        setNewLocationName("");
      }
    } catch (error) {
      console.error('Error adding location:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to add location. Please try again.';
      alert(errorMessage);
    }
  };

  const handleAddSubLocation = async (event) => {
    event.preventDefault();
    if (!parentForSub || !newSubName.trim()) return;
    try {
      const created = await addSubLocation(parentForSub, newSubName);
      if (created) {
        setParentForSub("");
        setNewSubName("");
      }
    } catch (error) {
      console.error('Error adding sub-location:', error);
      const errorMessage = error.response?.data?.detail || error.message || 'Failed to add sub-location. Please try again.';
      alert(errorMessage);
    }
  };

  return (
    <div className="master-data-page">
      <div className="page-header">
        <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
          ← Back to Dashboard
        </button>
      </div>

      <div className="page-content">
        <section className="panel stats-panel">
          <div className="stats-grid">
            {stats.map((stat) => (
              <div key={stat.label} className="stat-card">
                <span className="label">{stat.label}</span>
                <span className="value">{stat.value}</span>
              </div>
            ))}
          </div>
        </section>

        <div className="data-grid">
          <section className="panel">
            <div className="panel-header">
              <h2>Product Categories</h2>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={showInactiveCategories}
                  onChange={(event) => setShowInactiveCategories(event.target.checked)}
                />
                <span>Show inactive</span>
              </label>
            </div>
            <form onSubmit={handleAddCategory} className="inline-form">
              <label>
                <span>Category Name</span>
                <input
                  type="text"
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  placeholder="Add category name"
                  required
                />
              </label>

              <label>
                <span>Category Type</span>
                <select
                  value={newCategoryType}
                  onChange={(e) => {
                    const value = e.target.value;
                    setNewCategoryType(value);
                    if (value !== "raw") {
                      setNewCategorySubType("ingredient");
                    }
                  }}
                >
                  <option value="raw">Raw Material</option>
                  <option value="finished">Finished Good</option>
                </select>
              </label>

              {newCategoryType === "raw" && (
                <label>
                  <span>Sub Type</span>
                  <select
                    value={newCategorySubType}
                    onChange={(e) => setNewCategorySubType(e.target.value)}
                  >
                    <option value="ingredient">Ingredient</option>
                    <option value="packaging">Packaging</option>
                  </select>
                </label>
              )}

              <label>
                <span>Assign to Group</span>
                <select
                  value={newCategoryParent}
                  onChange={(e) => setNewCategoryParent(e.target.value)}
                  required
                >
                  <option value="">Select group</option>
                  {parentOptions.map((parent) => (
                    <option key={parent.id} value={parent.id}>
                      {parent.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className="primary-button">
                Add
              </button>
            </form>

            <div className="table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th>Type</th>
                    <th>Sub Type</th>
                    <th>Group</th>
                    <th>Status</th>
                    <th className="actions-col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {displayCategories.map((category) =>
                    editingCategory === category.id ? (
                      <tr key={category.id} className="editing">
                        <td>
                          <input
                            value={categoryDraft}
                            onChange={(e) => setCategoryDraft(e.target.value)}
                            autoFocus
                          />
                        </td>
                        <td>
                          <select
                            value={categoryTypeDraft}
                            onChange={(e) =>
                              setCategoryTypeDraft(e.target.value)
                            }
                          >
                            <option value="raw">Raw Material</option>
                            <option value="finished">Finished Good</option>
                          </select>
                        </td>
                        <td>
                          {categoryTypeDraft === "raw" ? (
                            <select
                              value={categorySubTypeDraft}
                              onChange={(e) =>
                                setCategorySubTypeDraft(e.target.value)
                              }
                            >
                              <option value="ingredient">Ingredient</option>
                              <option value="packaging">Packaging</option>
                            </select>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          <select
                            value={categoryParentDraft}
                            onChange={(e) =>
                              setCategoryParentDraft(e.target.value)
                            }
                            required
                          >
                            <option value="">Assign to group</option>
                            {parentOptions.map((parent) => (
                              <option key={parent.id} value={parent.id}>
                                {parent.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <span
                            className={`chip ${category.active === false ? "chip-hold" : "chip-clear"
                              }`}
                          >
                            {category.active === false ? "Inactive" : "Active"}
                          </span>
                        </td>
                        <td className="actions-col">
                          <button
                            className="primary-button"
                            onClick={() => handleSaveCategory(category.id)}
                          >
                            Save
                          </button>
                          <button
                            className="secondary-button"
                            onClick={() => setEditingCategory(null)}
                          >
                            Cancel
                          </button>
                        </td>
                      </tr>
                    ) : (
                      <tr key={category.id}>
                        <td>{category.name}</td>
                        <td>
                          {category.type === "raw"
                            ? "Raw Material"
                            : "Finished Good"}
                        </td>
                        <td>
                          {category.subType
                            ? category.subType === "packaging"
                              ? "Packaging"
                              : "Ingredient"
                            : "—"}
                        </td>
                        <td>
                          {parentOptions.find(
                            (parent) => parent.id === category.parentId,
                          )?.name || "—"}
                        </td>
                        <td>
                          <span
                            className={`chip ${category.active === false ? "chip-hold" : "chip-clear"
                              }`}
                          >
                            {category.active === false ? "Inactive" : "Active"}
                          </span>
                        </td>
                        <td className="actions-col">
                          <div className="node-actions">
                            <button
                              className="secondary-button"
                              onClick={() => {
                                setEditingCategory(category.id);
                                setCategoryDraft(category.name);
                                setCategoryTypeDraft(category.type);
                                setCategorySubTypeDraft(
                                  category.subType || "ingredient",
                                );
                                setCategoryParentDraft(category.parentId || "");
                              }}
                            >
                              Edit
                            </button>
                            <button
                              className="secondary-button"
                              onClick={async () => {
                                try {
                                  await toggleCategoryActive(category.id);
                                } catch (error) {
                                  console.error('Error toggling category:', error);
                                  alert('Failed to update category. Please try again.');
                                }
                              }}
                            >
                              {category.active === false ? "Activate" : "Deactivate"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ),
                  )}
                  {!displayCategories.length && (
                    <tr>
                      <td colSpan={6} className="empty">
                        No categories defined.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2>Vendors</h2>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={showInactiveVendors}
                  onChange={(event) => setShowInactiveVendors(event.target.checked)}
                />
                <span>Show inactive</span>
              </label>
            </div>
            <form onSubmit={handleAddVendor} className="inline-form">
              <input
                type="text"
                value={newVendorName}
                onChange={(e) => setNewVendorName(e.target.value)}
                placeholder="Add vendor"
                required
              />
              <button type="submit" className="primary-button">
                Add
              </button>
            </form>

            <div className="table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Vendor</th>
                    <th>Status</th>
                    <th className="actions-col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredVendors.map((vendor) =>
                    editingVendor === vendor.id ? (
                      <tr key={vendor.id} className="editing">
                        <td>
                          <input
                            value={vendorDraft}
                            onChange={(e) => setVendorDraft(e.target.value)}
                            autoFocus
                          />
                        </td>
                        <td>
                          <span
                            className={`chip ${vendor.active === false ? "chip-hold" : "chip-clear"
                              }`}
                          >
                            {vendor.active === false ? "Inactive" : "Active"}
                          </span>
                        </td>
                        <td className="actions-col">
                          <button
                            className="primary-button"
                            onClick={() => handleSaveVendor(vendor.id)}
                          >
                            Save
                          </button>
                          <button
                            className="secondary-button"
                            onClick={() => setEditingVendor(null)}
                          >
                            Cancel
                          </button>
                        </td>
                      </tr>
                    ) : (
                      <tr key={vendor.id}>
                        <td>{vendor.name}</td>
                        <td>
                          <span
                            className={`chip ${vendor.active === false ? "chip-hold" : "chip-clear"
                              }`}
                          >
                            {vendor.active === false ? "Inactive" : "Active"}
                          </span>
                        </td>
                        <td className="actions-col">
                          <div className="node-actions">
                            <button
                              className="secondary-button"
                              onClick={() => {
                                setEditingVendor(vendor.id);
                                setVendorDraft(vendor.name);
                              }}
                            >
                              Edit
                            </button>
                            <button
                              className="secondary-button"
                              onClick={async () => {
                                try {
                                  await toggleVendorActive(vendor.id);
                                } catch (error) {
                                  console.error('Error toggling vendor:', error);
                                  alert('Failed to update vendor. Please try again.');
                                }
                              }}
                            >
                              {vendor.active === false ? "Activate" : "Deactivate"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ),
                  )}
                  {!filteredVendors.length && (
                    <tr>
                      <td colSpan={3} className="empty">
                        No vendors defined.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <section className="panel">
          <div className="panel-header">
            <h2>Master Locations</h2>
            <span className="muted">
              Define both general locations and finished good storage rows
            </span>
            <label className="toggle-label">
              <input
                type="checkbox"
                checked={showInactiveLocations}
                onChange={(event) => setShowInactiveLocations(event.target.checked)}
              />
              <span>Show inactive</span>
            </label>
          </div>

          <div className="locations-layout">
            <div className="locations-column">
              <h3>General Locations</h3>
              <div className="inline-form responsive">
                <form
                  onSubmit={handleAddLocation}
                  className="inline-form no-wrap"
                >
                  <input
                    type="text"
                    value={newLocationName}
                    onChange={(e) => setNewLocationName(e.target.value)}
                    placeholder="Add new location"
                    required
                  />
                  <button type="submit" className="primary-button">
                    Add Location
                  </button>
                </form>
                <form
                  onSubmit={handleAddSubLocation}
                  className="inline-form no-wrap"
                >
                  <select
                    value={parentForSub}
                    onChange={(e) => setParentForSub(e.target.value)}
                    required
                  >
                    <option value="">Parent location</option>
                    {locationsTree.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={newSubName}
                    onChange={(e) => setNewSubName(e.target.value)}
                    placeholder="Sub location name"
                    required
                  />
                  <button type="submit" className="secondary-button">
                    Add Sub Location
                  </button>
                </form>
              </div>

              <div className="location-grid">
                {filteredLocations.map((location) => (
                  <div key={location.id} className="location-card">
                    <div className="location-header">
                      {editingLocation === location.id ? (
                        <>
                          <input
                            value={locationDraft}
                            onChange={(e) => setLocationDraft(e.target.value)}
                            autoFocus
                          />
                          <div className="node-actions">
                            <button
                              onClick={async () => {
                                try {
                                  await renameLocation(location.id, locationDraft);
                                  setEditingLocation(null);
                                } catch (error) {
                                  console.error('Error renaming location:', error);
                                  alert('Failed to rename location. Please try again.');
                                }
                              }}
                              className="primary-button"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setEditingLocation(null)}
                              className="secondary-button"
                            >
                              Cancel
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div>
                            <h3>{location.name}</h3>
                            <span className={`chip ${location.active === false ? "chip-hold" : "chip-clear"}`}>
                              {location.active === false ? "Inactive" : "Active"}
                            </span>
                          </div>
                          <div className="node-actions">
                            <button onClick={() => { setEditingLocation(location.id); setLocationDraft(location.name); }} className="secondary-button">Rename</button>
                            <button
                              onClick={async () => {
                                try {
                                  await toggleLocationActive(location.id);
                                } catch (error) {
                                  console.error('Error toggling location:', error);
                                  alert('Failed to update location. Please try again.');
                                }
                              }}
                              className="secondary-button"
                            >
                              {location.active === false ? "Activate" : "Deactivate"}
                            </button>
                            <button
                              onClick={() => {
                                setNewAreaLocation(location.id);
                                const el = fgFormRef?.current;
                                if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
                              }}
                              className="secondary-button"
                            >
                              Assign FG Area
                            </button>
                          </div>
                        </>
                      )}
                    </div>

                    <div className="sub-list">
                      {location.subLocations.map((sub) => {
                        const subKey = `${location.id}-${sub.id}`;
                        const isSubExpanded = expandedSubLocations.has(subKey);
                        const totalCapacity = (sub.rows || []).reduce((sum, r) => sum + (r.palletCapacity || 0), 0);
                        const totalUsed = (sub.rows || []).reduce((sum, r) => sum + (r.occupiedPallets || 0), 0);
                        const rowCount = (sub.rows || []).length;

                        return (
                          <div key={sub.id} style={{
                            marginBottom: '12px',
                            border: '1px solid #e5e7eb',
                            borderRadius: '4px',
                            background: '#fafafa'
                          }}>
                            {/* SubLocation Header - Clickable to expand */}
                            <div
                              onClick={() => {
                                const newExpanded = new Set(expandedSubLocations);
                                if (isSubExpanded) {
                                  newExpanded.delete(subKey);
                                } else {
                                  newExpanded.add(subKey);
                                }
                                setExpandedSubLocations(newExpanded);
                              }}
                              style={{
                                padding: '12px 16px',
                                cursor: 'pointer',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                gap: '16px',
                                background: isSubExpanded ? '#f0f0f0' : '#fafafa',
                                flexWrap: 'wrap'
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: '1', minWidth: '200px' }}>
                                <span style={{ fontSize: '14px', flexShrink: 0 }}>{isSubExpanded ? '▼' : '▶'}</span>
                                <strong style={{ fontSize: '14px', whiteSpace: 'nowrap' }}>{sub.name}</strong>
                                <span style={{ fontSize: '12px', color: '#666', whiteSpace: 'nowrap' }}>
                                  {rowCount} rows · {totalUsed}/{totalCapacity} pallets
                                </span>
                                <span
                                  className={`chip ${sub.active === false ? "chip-hold" : "chip-clear"}`}
                                  style={{ flexShrink: 0 }}
                                >
                                  {sub.active === false ? "Inactive" : "ACTIVE"}
                                </span>
                              </div>
                              <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                                <button onClick={() => { setEditingSubLocation(sub); setSubLocationDraft(sub.name); }} className="secondary-button">Rename</button>
                                <button
                                  onClick={async () => {
                                    try {
                                      await toggleSubLocationActive(location.id, sub.id);
                                    } catch (error) {
                                      console.error('Error toggling sub-location:', error);
                                      alert('Failed to update sub-location. Please try again.');
                                    }
                                  }}
                                  className="secondary-button"
                                >
                                  {sub.active === false ? "Activate" : "Deactivate"}
                                </button>
                              </div>
                            </div>

                            {/* Expandable content - Rows and Add Row form */}
                            {isSubExpanded && (
                              <div style={{ padding: '8px', background: '#fff' }}>
                                {/* Display existing rows for this SubLocation */}
                                {sub.rows && sub.rows.length > 0 ? (
                                  <div style={{ marginBottom: '12px' }}>
                                    {sub.rows.map(row => (
                                      <div
                                        key={row.id}
                                        className={`storage-row ${row.hold ? "on-hold" : ""}`}
                                        style={{
                                          padding: '12px',
                                          marginBottom: '8px',
                                          border: '1px solid #e5e7eb',
                                          borderRadius: '4px',
                                          background: row.hold ? '#fff3cd' : '#fff'
                                        }}
                                      >
                                        {editingRow &&
                                          editingRow.isSubLocationRow &&
                                          editingRow.subLocationId === sub.id &&
                                          editingRow.id === row.id ? (
                                          <>
                                            <input
                                              type="text"
                                              value={rowDraft.name}
                                              onChange={(e) =>
                                                setRowDraft((prev) => ({
                                                  ...prev,
                                                  name: e.target.value,
                                                }))
                                              }
                                              placeholder="Row name"
                                              autoFocus
                                              style={{ width: '100%', padding: '8px', marginBottom: '8px' }}
                                            />
                                            <div className="row-grid" style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                                              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                                <span>Pallet Capacity</span>
                                                <input
                                                  type="number"
                                                  value={rowDraft.palletCapacity}
                                                  onChange={(e) =>
                                                    setRowDraft((prev) => ({
                                                      ...prev,
                                                      palletCapacity: Number(e.target.value) || 0,
                                                    }))
                                                  }
                                                  min="0"
                                                  style={{ width: '100px', padding: '6px' }}
                                                />
                                              </label>
                                              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                                <span>Cases/Pallet</span>
                                                <input
                                                  type="number"
                                                  value={rowDraft.defaultCasesPerPallet}
                                                  onChange={(e) =>
                                                    setRowDraft((prev) => ({
                                                      ...prev,
                                                      defaultCasesPerPallet: Number(e.target.value) || 0,
                                                    }))
                                                  }
                                                  min="0"
                                                  style={{ width: '100px', padding: '6px' }}
                                                />
                                              </label>
                                              <label className="checkbox" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                <input
                                                  type="checkbox"
                                                  checked={rowDraft.hold || false}
                                                  onChange={(e) =>
                                                    setRowDraft((prev) => ({
                                                      ...prev,
                                                      hold: e.target.checked,
                                                    }))
                                                  }
                                                />
                                                <span>On Hold</span>
                                              </label>
                                            </div>
                                            <textarea
                                              value={rowDraft.notes || ''}
                                              onChange={(e) =>
                                                setRowDraft((prev) => ({
                                                  ...prev,
                                                  notes: e.target.value,
                                                }))
                                              }
                                              placeholder="Notes"
                                              style={{ width: '100%', marginTop: '8px', padding: '8px' }}
                                            />
                                            <div className="node-actions" style={{ marginTop: '12px' }}>
                                              <button
                                                onClick={async () => {
                                                  try {
                                                    await updateSubLocationRow(location.id, sub.id, row.id, rowDraft);
                                                    setEditingRow(null);
                                                  } catch (error) {
                                                    alert(error.message || 'Failed to update row. Please try again.');
                                                  }
                                                }}
                                                className="primary-button"
                                              >
                                                Save
                                              </button>
                                              <button
                                                onClick={() => setEditingRow(null)}
                                                className="secondary-button"
                                              >
                                                Cancel
                                              </button>
                                            </div>
                                          </>
                                        ) : (
                                          <>
                                            <div className="row-summary">
                                              <div>
                                                <strong>{row.name}</strong>
                                                <span className="muted" style={{ marginLeft: '8px' }}>
                                                  {row.palletCapacity} pallet capacity · {row.occupiedPallets || 0}/{row.palletCapacity} pallets in use · {row.occupiedCases || 0} cases stored
                                                </span>
                                                {row.hold && (
                                                  <span className="hold-flag" style={{ marginLeft: '8px' }}>On Hold</span>
                                                )}
                                                <span
                                                  className={`chip ${row.active === false ? "chip-hold" : "chip-clear"}`}
                                                  style={{ marginLeft: '8px' }}
                                                >
                                                  {row.active === false ? "Inactive" : "Active"}
                                                </span>
                                              </div>
                                            </div>
                                            {row.notes && (
                                              <div className="row-notes" style={{ marginTop: '8px', fontSize: '12px', color: '#666' }}>{row.notes}</div>
                                            )}
                                            <div className="node-actions" style={{ marginTop: '8px' }}>
                                              <button
                                                onClick={() => {
                                                  setEditingRow({
                                                    locationId: location.id,
                                                    subLocationId: sub.id,
                                                    id: row.id,
                                                    isSubLocationRow: true,
                                                  });
                                                  setRowDraft({
                                                    name: row.name,
                                                    template: row.template,
                                                    palletCapacity: row.palletCapacity,
                                                    defaultCasesPerPallet: row.defaultCasesPerPallet,
                                                    hold: row.hold,
                                                    notes: row.notes,
                                                  });
                                                }}
                                                className="secondary-button"
                                                style={{ fontSize: '12px', padding: '4px 8px' }}
                                              >
                                                Edit
                                              </button>
                                              <button
                                                onClick={async () => {
                                                  try {
                                                    await toggleSubLocationRowActive(location.id, sub.id, row.id);
                                                  } catch (error) {
                                                    alert(error.message || 'Failed to toggle row. Please try again.');
                                                  }
                                                }}
                                                className="secondary-button"
                                                style={{ fontSize: '12px', padding: '4px 8px' }}
                                              >
                                                {row.active === false ? "Activate" : "Deactivate"}
                                              </button>
                                            </div>
                                          </>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div style={{ padding: '12px', color: '#666', fontSize: '14px' }}>
                                    No rows in this sub-location
                                  </div>
                                )}

                                {/* Add row form for this SubLocation */}
                                <form
                                  onSubmit={async (e) => {
                                    e.preventDefault();
                                    const form = e.currentTarget;
                                    const name = form.elements["subRowName"].value.trim();
                                    const palletCapacity = Number(form.elements["subRowCap"].value || 0);
                                    const defaultCasesPerPallet = Number(form.elements["subRowCPP"].value || 0);
                                    if (!name) return;
                                    try {
                                      await addSubLocationRow(location.id, sub.id, { name, palletCapacity, defaultCasesPerPallet });
                                      form.reset();
                                    } catch (error) {
                                      alert(error.message || 'Failed to add row. Please try again.');
                                    }
                                  }}
                                  className="inline-form"
                                  style={{ marginTop: 8, padding: '8px', background: '#f9f9f9', borderRadius: '4px' }}
                                >
                                  <input name="subRowName" placeholder="Add row (e.g., cage-1)" style={{ flex: 1 }} />
                                  <input name="subRowCap" type="number" min="0" placeholder="Pallet cap" style={{ width: 100 }} />
                                  <input name="subRowCPP" type="number" min="0" placeholder="Cases/pallet" style={{ width: 110 }} />
                                  <button type="submit" className="secondary-button">Add Row</button>
                                </form>
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {!location.subLocations.length && (
                        <div className="sub-node empty">No sub locations added yet.</div>
                      )}
                    </div>

                    {/* Unified view: list FG areas linked to this main location */}
                    <div className="sub-list">
                      <div className="small" style={{ color: "#64748b" }}>Finished Goods at this location</div>
                      {((storageAreas || []).filter(a => a.locationId === location.id).length === 0) && (
                        <div className="sub-node empty">No FG storage areas linked. Add one below.</div>
                      )}
                      {(storageAreas || []).filter(a => a.locationId === location.id).map(area => (
                        <div key={`fg-${area.id}`} className="sub-node" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                            <span>FG Storage · {area.name}</span>
                            <div className="node-actions">
                              <button onClick={() => setEditingArea(area.id)} className="secondary-button">Manage</button>
                            </div>
                          </div>
                          {/* Quick add row under this area */}
                          <form
                            onSubmit={async (e) => {
                              e.preventDefault();
                              const name = e.currentTarget.elements["rowName"].value.trim();
                              const palletCapacity = Number(e.currentTarget.elements["rowCap"].value || 0);
                              const defaultCasesPerPallet = Number(e.currentTarget.elements["rowCPP"].value || 0);
                              if (!name) return;
                              try {
                                await addStorageRow(area.id, { name, palletCapacity, defaultCasesPerPallet });
                                e.currentTarget.reset();
                              } catch (error) {
                                alert(error.message || 'Failed to add storage row. Please try again.');
                              }
                            }}
                            className="inline-form"
                          >
                            <input name="rowName" placeholder="Add row (e.g., Zone A - Row 1)" />
                            <input name="rowCap" type="number" min="0" placeholder="Pallet cap" style={{ width: 120 }} />
                            <input name="rowCPP" type="number" min="0" placeholder="Cases/pallet" style={{ width: 140 }} />
                            <button type="submit" className="secondary-button">Add Row</button>
                          </form>
                        </div>
                      ))}
                      {/* Quick add FG Area to this location */}
                      <form
                        onSubmit={async (e) => {
                          e.preventDefault();
                          const areaName = e.currentTarget.elements["fgAreaName"].value.trim();
                          const allow = e.currentTarget.elements["fgAllowFloor"].checked;
                          if (!areaName) return;
                          try {
                            await addStorageArea(areaName, allow, location.id);
                            e.currentTarget.reset();
                          } catch (error) {
                            alert(error.message || 'Failed to add storage area. Please try again.');
                          }
                        }}
                        className="inline-form"
                      >
                        <input name="fgAreaName" placeholder={`Add FG area for ${location.name}`} />
                        <label className="checkbox">
                          <input name="fgAllowFloor" type="checkbox" defaultChecked />
                          <span>Allow floor staging</span>
                        </label>
                        <button type="submit" className="secondary-button">Add FG Area</button>
                      </form>
                    </div>
                  </div>
                ))}
                {!filteredLocations.length && (
                  <div className="location-card empty">
                    No locations match the current filter.
                  </div>
                )}
              </div>
            </div>

            <div className="locations-column">
              <h3>Finished Goods Storage</h3>

              <form
                ref={fgFormRef}
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    const created = await addStorageArea(
                      newAreaName,
                      allowFloorStorage,
                      newAreaLocation || null,
                    );
                    if (created) {
                      setNewAreaName("");
                      setAllowFloorStorage(true);
                      setNewAreaLocation("");
                    }
                  } catch (error) {
                    alert(error.message || 'Failed to add storage area. Please try again.');
                  }
                }}
                className="inline-form responsive"
              >
                <input
                  type="text"
                  value={newAreaName}
                  onChange={(e) => setNewAreaName(e.target.value)}
                  placeholder="Add finished goods area"
                  required
                />
                <select
                  value={newAreaLocation}
                  onChange={(e) => setNewAreaLocation(e.target.value)}
                >
                  <option value="">Assign to general location (optional)</option>
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={allowFloorStorage}
                    onChange={(e) => setAllowFloorStorage(e.target.checked)}
                  />
                  <span>Allow floor staging</span>
                </label>
                <button type="submit" className="primary-button">
                  Add Area
                </button>
              </form>

              {/* Search and Filter Controls */}
              <div style={{ marginBottom: '16px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  type="text"
                  placeholder="Search areas or rows..."
                  value={fgSearchTerm}
                  onChange={(e) => setFgSearchTerm(e.target.value)}
                  style={{ flex: '1', minWidth: '200px', padding: '8px 12px', border: '1px solid #ddd', borderRadius: '4px' }}
                />
                <select
                  value={fgLocationFilter}
                  onChange={(e) => setFgLocationFilter(e.target.value)}
                  style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: '4px' }}
                >
                  <option value="all">All Locations</option>
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
                <label className="toggle-label" style={{ margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={showInactiveStorage}
                    onChange={(event) => setShowInactiveStorage(event.target.checked)}
                  />
                  <span>Show inactive</span>
                </label>
              </div>

              {/* Summary Stats */}
              {groupedStorageAreas.length > 0 && (
                <div style={{
                  background: '#f5f5f5',
                  padding: '12px',
                  borderRadius: '6px',
                  marginBottom: '16px',
                  display: 'flex',
                  gap: '24px',
                  flexWrap: 'wrap',
                  fontSize: '14px'
                }}>
                  <span><strong>{groupedStorageAreas.length}</strong> Areas</span>
                  <span><strong>{groupedStorageAreas.reduce((sum, a) => sum + a.totalRows, 0)}</strong> Rows</span>
                  <span><strong>{groupedStorageAreas.reduce((sum, a) => sum + a.totalUsed, 0)}</strong> / <strong>{groupedStorageAreas.reduce((sum, a) => sum + a.totalCapacity, 0)}</strong> Pallets Used</span>
                </div>
              )}

              {/* Nested Accordion View */}
              <div className="storage-accordion">
                {groupedStorageAreas.map((area) => {
                  const areaKey = area.id;
                  const isAreaExpanded = expandedAreas.has(areaKey);

                  return (
                    <div key={area.id} className="accordion-item" style={{
                      border: '1px solid #ddd',
                      borderRadius: '6px',
                      marginBottom: '12px',
                      background: '#fff'
                    }}>
                      {/* Area Header */}
                      <div
                        className="accordion-header"
                        onClick={() => {
                          const newExpanded = new Set(expandedAreas);
                          if (isAreaExpanded) {
                            newExpanded.delete(areaKey);
                          } else {
                            newExpanded.add(areaKey);
                          }
                          setExpandedAreas(newExpanded);
                        }}
                        style={{
                          padding: '16px',
                          cursor: 'pointer',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          background: isAreaExpanded ? '#f9fafb' : '#fff',
                          borderBottom: isAreaExpanded ? '1px solid #ddd' : 'none'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1 }}>
                          <span style={{ fontSize: '18px', fontWeight: 'bold' }}>{isAreaExpanded ? '▼' : '▶'}</span>
                          <div>
                            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '600' }}>{area.name}</h3>
                            <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
                              {area.totalRows} rows · {area.totalUsed}/{area.totalCapacity} pallets · {Math.round(area.utilization || 0)}% used
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <span className={`chip ${area.active === false ? "chip-hold" : "chip-clear"}`}>
                            {area.active === false ? "Inactive" : "Active"}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingArea(area.id);
                              setAreaDraft(area.name);
                            }}
                            className="secondary-button"
                            style={{ fontSize: '12px', padding: '4px 8px' }}
                          >
                            Rename
                          </button>
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              try {
                                await toggleStorageAreaActive(area.id);
                              } catch (error) {
                                alert(error.message || 'Failed to toggle storage area. Please try again.');
                              }
                            }}
                            className="secondary-button"
                            style={{ fontSize: '12px', padding: '4px 8px' }}
                          >
                            {area.active === false ? "Activate" : "Deactivate"}
                          </button>
                        </div>
                      </div>

                      {/* Area Content (Zones and Rows) */}
                      {isAreaExpanded && (
                        <div className="accordion-content" style={{ padding: '16px' }}>
                          {editingArea === area.id ? (
                            <>
                              <input
                                value={areaDraft}
                                onChange={(e) => setAreaDraft(e.target.value)}
                                autoFocus
                                style={{ width: '100%', padding: '8px', marginBottom: '12px' }}
                              />
                              <label className="checkbox">
                                <input
                                  type="checkbox"
                                  checked={area.allowFloorStorage}
                                  onChange={async (e) => {
                                    try {
                                      await updateStorageArea(area.id, {
                                        allowFloorStorage: e.target.checked,
                                      });
                                    } catch (error) {
                                      alert(error.message || 'Failed to update storage area. Please try again.');
                                    }
                                  }}
                                />
                                <span>Allow floor storage</span>
                              </label>
                              <div className="node-actions" style={{ marginTop: '12px' }}>
                                <button
                                  onClick={async () => {
                                    try {
                                      await updateStorageArea(area.id, { name: areaDraft });
                                      setEditingArea(null);
                                    } catch (error) {
                                      alert(error.message || 'Failed to update storage area. Please try again.');
                                    }
                                  }}
                                  className="primary-button"
                                >
                                  Save
                                </button>
                                <button
                                  onClick={() => setEditingArea(null)}
                                  className="secondary-button"
                                >
                                  Cancel
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              {/* Zones */}
                              {area.zones && area.zones.length > 0 ? (
                                area.zones.map((zone) => {
                                  const zoneKey = `${area.id}-${zone.name}`;
                                  const isZoneExpanded = expandedZones.has(zoneKey);
                                  const zoneCapacity = zone.rows.reduce((sum, r) => sum + r.palletCapacity, 0);
                                  const zoneUsed = zone.rows.reduce((sum, r) => sum + (r.occupiedPallets || 0), 0);

                                  return (
                                    <div key={zone.name} style={{
                                      marginBottom: '12px',
                                      border: '1px solid #e5e7eb',
                                      borderRadius: '4px',
                                      background: '#fafafa'
                                    }}>
                                      {/* Zone Header */}
                                      <div
                                        onClick={() => {
                                          const newExpanded = new Set(expandedZones);
                                          if (isZoneExpanded) {
                                            newExpanded.delete(zoneKey);
                                          } else {
                                            newExpanded.add(zoneKey);
                                          }
                                          setExpandedZones(newExpanded);
                                        }}
                                        style={{
                                          padding: '12px',
                                          cursor: 'pointer',
                                          display: 'flex',
                                          justifyContent: 'space-between',
                                          alignItems: 'center',
                                          background: isZoneExpanded ? '#f0f0f0' : '#fafafa'
                                        }}
                                      >
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                          <span style={{ fontSize: '14px' }}>{isZoneExpanded ? '▼' : '▶'}</span>
                                          <strong style={{ fontSize: '14px' }}>Zone {zone.name}</strong>
                                          <span style={{ fontSize: '12px', color: '#666' }}>
                                            ({zone.rows.length} rows · {zoneUsed}/{zoneCapacity} pallets)
                                          </span>
                                        </div>
                                      </div>

                                      {/* Zone Rows */}
                                      {isZoneExpanded && (
                                        <div style={{ padding: '8px', background: '#fff' }}>
                                          {zone.rows.map((row) => (
                                            <div
                                              key={row.id}
                                              className={`storage-row ${row.hold ? "on-hold" : ""}`}
                                              style={{
                                                padding: '12px',
                                                marginBottom: '8px',
                                                border: '1px solid #e5e7eb',
                                                borderRadius: '4px',
                                                background: row.hold ? '#fff3cd' : '#fff'
                                              }}
                                            >
                                              {editingRow &&
                                                editingRow.areaId === area.id &&
                                                editingRow.id === row.id ? (
                                                <>
                                                  <input
                                                    type="text"
                                                    value={rowDraft.name}
                                                    onChange={(e) =>
                                                      setRowDraft((prev) => ({
                                                        ...prev,
                                                        name: e.target.value,
                                                      }))
                                                    }
                                                    placeholder="Row name"
                                                    autoFocus
                                                    style={{ width: '100%', padding: '8px', marginBottom: '8px' }}
                                                  />
                                                  <div className="row-grid">
                                                    <label>
                                                      <span>Template</span>
                                                      <select
                                                        value={rowDraft.template}
                                                        onChange={(e) =>
                                                          setRowDraft((prev) => ({
                                                            ...prev,
                                                            template: e.target.value,
                                                          }))
                                                        }
                                                      >
                                                        <option value="3x5">
                                                          3 x 5 (15 pallets)
                                                        </option>
                                                        <option value="3x8">
                                                          3 x 8 (24 pallets)
                                                        </option>
                                                        <option value="custom">Custom</option>
                                                      </select>
                                                    </label>
                                                    <label>
                                                      <span>Pallet Capacity</span>
                                                      <input
                                                        type="number"
                                                        value={rowDraft.palletCapacity}
                                                        min="0"
                                                        onChange={(e) =>
                                                          setRowDraft((prev) => ({
                                                            ...prev,
                                                            palletCapacity: Number(e.target.value),
                                                          }))
                                                        }
                                                      />
                                                    </label>
                                                    <label>
                                                      <span>Default Cases / Pallet</span>
                                                      <input
                                                        type="number"
                                                        value={rowDraft.defaultCasesPerPallet}
                                                        min="0"
                                                        onChange={(e) =>
                                                          setRowDraft((prev) => ({
                                                            ...prev,
                                                            defaultCasesPerPallet: Number(
                                                              e.target.value,
                                                            ),
                                                          }))
                                                        }
                                                      />
                                                    </label>
                                                  </div>
                                                  <label className="checkbox">
                                                    <input
                                                      type="checkbox"
                                                      checked={rowDraft.hold || false}
                                                      onChange={(e) =>
                                                        setRowDraft((prev) => ({
                                                          ...prev,
                                                          hold: e.target.checked,
                                                        }))
                                                      }
                                                    />
                                                    <span>Hold this row</span>
                                                  </label>
                                                  <textarea
                                                    value={rowDraft.notes || ""}
                                                    onChange={(e) =>
                                                      setRowDraft((prev) => ({
                                                        ...prev,
                                                        notes: e.target.value,
                                                      }))
                                                    }
                                                    placeholder="Notes"
                                                    style={{ width: '100%', marginTop: '8px', padding: '8px' }}
                                                  />
                                                  <div className="node-actions" style={{ marginTop: '12px' }}>
                                                    <button
                                                      onClick={async () => {
                                                        try {
                                                          await updateStorageRow(area.id, row.id, rowDraft);
                                                          setEditingRow(null);
                                                        } catch (error) {
                                                          alert(error.message || 'Failed to update storage row. Please try again.');
                                                        }
                                                      }}
                                                      className="primary-button"
                                                    >
                                                      Save
                                                    </button>
                                                    <button
                                                      onClick={() => setEditingRow(null)}
                                                      className="secondary-button"
                                                    >
                                                      Cancel
                                                    </button>
                                                  </div>
                                                </>
                                              ) : (
                                                <>
                                                  <div className="row-summary">
                                                    <div>
                                                      <strong>{row.name}</strong>
                                                      <span className="muted" style={{ marginLeft: '8px' }}>
                                                        {row.palletCapacity} pallet capacity · {row.occupiedPallets}/{row.palletCapacity} pallets in use · {row.occupiedCases} cases stored
                                                      </span>
                                                      {row.productId && (
                                                        <span style={{ marginLeft: '8px', fontSize: '12px', color: '#666' }}>
                                                          Product: {row.productId}
                                                        </span>
                                                      )}
                                                      {row.hold && (
                                                        <span className="hold-flag" style={{ marginLeft: '8px' }}>On Hold</span>
                                                      )}
                                                      <span
                                                        className={`chip ${row.active === false
                                                          ? "chip-hold"
                                                          : "chip-clear"
                                                          }`}
                                                        style={{ marginLeft: '8px' }}
                                                      >
                                                        {row.active === false ? "Inactive" : "Active"}
                                                      </span>
                                                    </div>
                                                  </div>
                                                  {row.notes && (
                                                    <div className="row-notes" style={{ marginTop: '8px', fontSize: '12px', color: '#666' }}>{row.notes}</div>
                                                  )}
                                                  <div className="node-actions" style={{ marginTop: '8px' }}>
                                                    <button
                                                      onClick={() => {
                                                        setEditingRow({
                                                          areaId: area.id,
                                                          id: row.id,
                                                        });
                                                        setRowDraft({
                                                          name: row.name,
                                                          template: row.template,
                                                          palletCapacity: row.palletCapacity,
                                                          defaultCasesPerPallet:
                                                            row.defaultCasesPerPallet,
                                                          hold: row.hold,
                                                          notes: row.notes,
                                                        });
                                                      }}
                                                      className="secondary-button"
                                                      style={{ fontSize: '12px', padding: '4px 8px' }}
                                                    >
                                                      Edit
                                                    </button>
                                                    <button
                                                      onClick={async () => {
                                                        try {
                                                          await toggleStorageRowActive(area.id, row.id);
                                                        } catch (error) {
                                                          alert(error.message || 'Failed to toggle storage row. Please try again.');
                                                        }
                                                      }}
                                                      className="secondary-button"
                                                      style={{ fontSize: '12px', padding: '4px 8px' }}
                                                    >
                                                      {row.active === false ? "Activate" : "Deactivate"}
                                                    </button>
                                                  </div>
                                                </>
                                              )}
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })
                              ) : (
                                <div style={{ padding: '12px', color: '#666', fontSize: '14px' }}>
                                  No rows in this area
                                </div>
                              )}

                              {/* Add Row Form */}
                              <form
                                onSubmit={async (event) => {
                                  event.preventDefault();
                                  if (!newRowDraft.name.trim()) {
                                    setRowError("Row name is required.");
                                    return;
                                  }
                                  if (newRowDraft.palletCapacity <= 0) {
                                    setRowError(
                                      "Pallet capacity must be greater than zero.",
                                    );
                                    return;
                                  }
                                  try {
                                    await addStorageRow(area.id, newRowDraft);
                                    setNewRowDraft({
                                      name: "",
                                      template: "3x5",
                                      palletCapacity: 15,
                                      defaultCasesPerPallet: 60,
                                      notes: "",
                                    });
                                    setRowError("");
                                  } catch (error) {
                                    setRowError(error.message || 'Failed to add storage row. Please try again.');
                                  }
                                }}
                                className="inline-form row-form"
                                style={{ marginTop: '16px', padding: '12px', background: '#f9fafb', borderRadius: '4px' }}
                              >
                                <label>
                                  <span>Row Name</span>
                                  <input
                                    type="text"
                                    value={newRowDraft.name}
                                    onChange={(e) =>
                                      setNewRowDraft((prev) => ({
                                        ...prev,
                                        name: e.target.value,
                                      }))
                                    }
                                    placeholder="Row name (e.g., AA 1)"
                                    required
                                  />
                                </label>
                                <label>
                                  <span>Template</span>
                                  <select
                                    value={newRowDraft.template}
                                    onChange={(e) =>
                                      setNewRowDraft((prev) => ({
                                        ...prev,
                                        template: e.target.value,
                                      }))
                                    }
                                  >
                                    <option value="3x5">
                                      3 x 5 (15 pallets)
                                    </option>
                                    <option value="3x8">
                                      3 x 8 (24 pallets)
                                    </option>
                                    <option value="custom">Custom</option>
                                  </select>
                                </label>
                                <label>
                                  <span>Pallet Capacity</span>
                                  <input
                                    type="number"
                                    value={newRowDraft.palletCapacity}
                                    min="0"
                                    onChange={(e) =>
                                      setNewRowDraft((prev) => ({
                                        ...prev,
                                        palletCapacity: Number(e.target.value),
                                      }))
                                    }
                                    required
                                  />
                                </label>
                                <label>
                                  <span>Default Cases / Pallet</span>
                                  <input
                                    type="number"
                                    value={newRowDraft.defaultCasesPerPallet}
                                    min="0"
                                    onChange={(e) =>
                                      setNewRowDraft((prev) => ({
                                        ...prev,
                                        defaultCasesPerPallet: Number(
                                          e.target.value,
                                        ),
                                      }))
                                    }
                                  />
                                </label>
                                <button type="submit" className="secondary-button">
                                  Add Row
                                </button>
                                {rowError && (
                                  <div style={{ color: 'red', fontSize: '12px', marginTop: '8px' }}>
                                    {rowError}
                                  </div>
                                )}
                              </form>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Empty State */}
              {groupedStorageAreas.length === 0 && (
                <div className="storage-card empty" style={{ padding: '24px', textAlign: 'center', color: '#666' }}>
                  {fgSearchTerm || fgLocationFilter !== "all"
                    ? "No areas match your filters."
                    : "No finished goods areas defined."}
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Production Shifts & Lines</h2>
            <span className="muted">
              Configure options for the receipt form dropdowns
            </span>
          </div>
          <div className="dual-forms">
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                try {
                  const result = await addProductionShift(newShiftName, newShiftNotes);
                  if (result) {
                    setNewShiftName("");
                    setNewShiftNotes("");
                  }
                } catch (error) {
                  alert(error.message || 'Failed to add production shift. Please try again.');
                }
              }}
              className="inline-form responsive"
            >
              <label className="full">
                <span>Add Shift</span>
                <input
                  type="text"
                  value={newShiftName}
                  onChange={(e) => setNewShiftName(e.target.value)}
                  placeholder="e.g. Shift A"
                  required
                />
              </label>
              <label className="full">
                <span>Notes</span>
                <input
                  type="text"
                  value={newShiftNotes}
                  onChange={(e) => setNewShiftNotes(e.target.value)}
                  placeholder="Optional"
                />
              </label>
              <button type="submit" className="primary-button">
                Add Shift
              </button>
            </form>

            <form
              onSubmit={async (event) => {
                event.preventDefault();
                try {
                  const result = await addProductionLine(newLineName, newLineNotes);
                  if (result) {
                    setNewLineName("");
                    setNewLineNotes("");
                  }
                } catch (error) {
                  alert(error.message || 'Failed to add production line. Please try again.');
                }
              }}
              className="inline-form responsive"
            >
              <label className="full">
                <span>Add Line</span>
                <input
                  type="text"
                  value={newLineName}
                  onChange={(e) => setNewLineName(e.target.value)}
                  placeholder="e.g. Line 1"
                  required
                />
              </label>
              <label className="full">
                <span>Notes</span>
                <input
                  type="text"
                  value={newLineNotes}
                  onChange={(e) => setNewLineNotes(e.target.value)}
                  placeholder="Optional"
                />
              </label>
              <button type="submit" className="primary-button">
                Add Line
              </button>
            </form>
          </div>

          <div className="lists-grid">
            <div>
              <div className="panel-header">
                <h3>Shifts</h3>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={showInactiveShifts}
                    onChange={(event) => setShowInactiveShifts(event.target.checked)}
                  />
                  <span>Show inactive</span>
                </label>
              </div>
              <ul className="chip-list">
                {filteredShifts.map((shift) => (
                  <li key={shift.id} className="chip-item">
                    {editingShift === shift.id ? (
                      <div className="inline-edit">
                        <input
                          type="text"
                          value={shiftDraft.name}
                          onChange={(e) =>
                            setShiftDraft((prev) => ({
                              ...prev,
                              name: e.target.value,
                            }))
                          }
                          placeholder="Shift name"
                          autoFocus
                        />
                        <input
                          type="text"
                          value={shiftDraft.notes}
                          onChange={(e) =>
                            setShiftDraft((prev) => ({
                              ...prev,
                              notes: e.target.value,
                            }))
                          }
                          placeholder="Notes"
                        />
                        <div className="node-actions">
                          <button
                            className="primary-button"
                            onClick={async () => {
                              try {
                                await updateProductionShift(shift.id, shiftDraft);
                                setEditingShift(null);
                              } catch (error) {
                                alert(error.message || 'Failed to update production shift. Please try again.');
                              }
                            }}
                          >
                            Save
                          </button>
                          <button
                            className="secondary-button"
                            onClick={() => setEditingShift(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="chip-item-inner">
                        <div>
                          <span className="chip-label">{shift.name}</span>
                          {shift.notes && (
                            <span className="muted small">{shift.notes}</span>
                          )}
                          <span
                            className={`chip ${shift.active === false ? "chip-hold" : "chip-clear"
                              }`}
                          >
                            {shift.active === false ? "Inactive" : "Active"}
                          </span>
                        </div>
                        <div className="node-actions">
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => {
                              setEditingShift(shift.id);
                              setShiftDraft({ name: shift.name, notes: shift.notes || "" });
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={async () => {
                              try {
                                await toggleProductionShiftActive(shift.id);
                              } catch (error) {
                                alert(error.message || 'Failed to toggle production shift. Please try again.');
                              }
                            }}
                          >
                            {shift.active === false ? "Activate" : "Deactivate"}
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
                {!filteredShifts.length && (
                  <li className="muted">No shifts defined.</li>
                )}
              </ul>
            </div>
            <div>
              <div className="panel-header">
                <h3>Lines</h3>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={showInactiveLines}
                    onChange={(event) => setShowInactiveLines(event.target.checked)}
                  />
                  <span>Show inactive</span>
                </label>
              </div>
              <ul className="chip-list">
                {filteredLines.map((line) => (
                  <li key={line.id} className="chip-item">
                    {editingLine === line.id ? (
                      <div className="inline-edit">
                        <input
                          type="text"
                          value={lineDraft.name}
                          onChange={(e) =>
                            setLineDraft((prev) => ({
                              ...prev,
                              name: e.target.value,
                            }))
                          }
                          placeholder="Line name"
                          autoFocus
                        />
                        <input
                          type="text"
                          value={lineDraft.notes}
                          onChange={(e) =>
                            setLineDraft((prev) => ({
                              ...prev,
                              notes: e.target.value,
                            }))
                          }
                          placeholder="Notes"
                        />
                        <div className="node-actions">
                          <button
                            className="primary-button"
                            onClick={async () => {
                              try {
                                await updateProductionLine(line.id, lineDraft);
                                setEditingLine(null);
                              } catch (error) {
                                alert(error.message || 'Failed to update production line. Please try again.');
                              }
                            }}
                          >
                            Save
                          </button>
                          <button
                            className="secondary-button"
                            onClick={() => setEditingLine(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="chip-item-inner">
                        <div>
                          <span className="chip-label">{line.name}</span>
                          {line.notes && (
                            <span className="muted small">{line.notes}</span>
                          )}
                          <span
                            className={`chip ${line.active === false ? "chip-hold" : "chip-clear"
                              }`}
                          >
                            {line.active === false ? "Inactive" : "Active"}
                          </span>
                        </div>
                        <div className="node-actions">
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => {
                              setEditingLine(line.id);
                              setLineDraft({ name: line.name, notes: line.notes || "" });
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={async () => {
                              try {
                                await toggleProductionLineActive(line.id);
                              } catch (error) {
                                alert(error.message || 'Failed to toggle production line. Please try again.');
                              }
                            }}
                          >
                            {line.active === false ? "Activate" : "Deactivate"}
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
                {!filteredLines.length && (
                  <li className="muted">No lines defined.</li>
                )}
              </ul>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

export default MasterDataPage;
