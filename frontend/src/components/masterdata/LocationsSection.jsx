import React, { useMemo, useState } from "react";
import { useAppData } from "../../context/AppDataContext";
import { useToast } from "../../context/ToastContext";
import "../MasterDataPage.css";

const LocationsSection = ({ onAssignFGArea }) => {
  const {
    locationsTree,
    storageAreas,
    addLocation,
    renameLocation,
    toggleLocationActive,
    addSubLocation,
    addSubLocationRow,
    updateSubLocationRow,
    toggleSubLocationRowActive,
    toggleSubLocationActive,
    addStorageArea,
    addStorageRow,
  } = useAppData();
  const { addToast } = useToast();

  const [showInactiveLocations, setShowInactiveLocations] = useState(false);
  const [newLocationName, setNewLocationName] = useState("");
  const [parentForSub, setParentForSub] = useState("");
  const [newSubName, setNewSubName] = useState("");
  const [editingLocation, setEditingLocation] = useState(null);
  const [locationDraft, setLocationDraft] = useState("");
  const [editingSubLocation, setEditingSubLocation] = useState(null);
  const [subLocationDraft, setSubLocationDraft] = useState("");
  const [expandedSubLocations, setExpandedSubLocations] = useState(new Set());
  const [editingRow, setEditingRow] = useState(null);
  const [rowDraft, setRowDraft] = useState({
    name: "",
    template: "3x5",
    palletCapacity: 15,
    defaultCasesPerPallet: 60,
    notes: "",
  });

  const filteredLocations = useMemo(() => {
    if (showInactiveLocations) return locationsTree;
    return locationsTree
      .map((location) => ({
        ...location,
        subLocations: location.subLocations.filter(
          (sub) => sub.active !== false,
        ),
      }))
      .filter((location) => location.active !== false);
  }, [locationsTree, showInactiveLocations]);

  const handleAddLocation = async (event) => {
    event.preventDefault();
    if (!newLocationName.trim()) return;
    try {
      const created = await addLocation(newLocationName);
      if (created) {
        setNewLocationName("");
      }
    } catch (error) {
      console.error("Error adding location:", error);
      const errorMessage =
        error.response?.data?.detail ||
        error.message ||
        "Failed to add location. Please try again.";
      addToast(errorMessage, "error");
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
      console.error("Error adding sub-location:", error);
      const errorMessage =
        error.response?.data?.detail ||
        error.message ||
        "Failed to add sub-location. Please try again.";
      addToast(errorMessage, "error");
    }
  };

  const handleRenameSubLocation = async (locationId, subId) => {
    try {
      // renameSubLocation is expected from AppDataContext if available;
      // fall back to editing sub-location via context
      await renameLocation(subId, subLocationDraft);
      setEditingSubLocation(null);
    } catch (error) {
      console.error("Error renaming sub-location:", error);
      addToast("Failed to rename sub-location. Please try again.", "error");
    }
  };

  return (
    <section className="panel">
      <div className="panel-header">
        <div className="panel-title">
          <h2>Master Locations</h2>
          <span className="muted">Define both general locations and finished good storage rows</span>
        </div>
        <label className="toggle-label" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.875rem', cursor: 'pointer', userSelect: 'none' }}>
          <input
            type="checkbox"
            checked={showInactiveLocations}
            onChange={(event) =>
              setShowInactiveLocations(event.target.checked)
            }
          />
          <span>Show inactive</span>
        </label>
      </div>

      <div className="locations-column">
          <h3>General Locations</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
            {/* Add Location */}
            <form
              onSubmit={handleAddLocation}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'white', border: '2px solid var(--color-border)', borderLeft: '4px solid var(--color-primary)', borderRadius: '8px', padding: '10px 14px' }}
            >
              <input
                type="text"
                value={newLocationName}
                onChange={(e) => setNewLocationName(e.target.value)}
                placeholder="New location name"
                required
                style={{ flex: 1, border: '1px solid var(--color-border)', borderRadius: '6px', padding: '7px 10px', fontSize: '0.875rem' }}
              />
              <button type="submit" className="primary-button" style={{ whiteSpace: 'nowrap' }}>
                + Add Location
              </button>
            </form>

            {/* Add Sub Location */}
            <form
              onSubmit={handleAddSubLocation}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'white', border: '2px solid var(--color-border)', borderLeft: '4px solid var(--color-primary)', borderRadius: '8px', padding: '10px 14px' }}
            >
              <select
                value={parentForSub}
                onChange={(e) => setParentForSub(e.target.value)}
                required
                style={{ flex: '0 0 160px', border: '1px solid var(--color-border)', borderRadius: '6px', padding: '7px 10px', fontSize: '0.875rem' }}
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
                placeholder="Sub-location name"
                required
                style={{ flex: 1, border: '1px solid var(--color-border)', borderRadius: '6px', padding: '7px 10px', fontSize: '0.875rem' }}
              />
              <button type="submit" className="secondary-button" style={{ whiteSpace: 'nowrap' }}>
                + Add Sub Location
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
                              console.error("Error renaming location:", error);
                              addToast(
                                "Failed to rename location. Please try again.",
                                "error",
                              );
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
                        <span
                          className={`chip ${
                            location.active === false
                              ? "chip-hold"
                              : "chip-clear"
                          }`}
                        >
                          {location.active === false ? "Inactive" : "Active"}
                        </span>
                      </div>
                      <div className="node-actions">
                        <button
                          onClick={() => {
                            setEditingLocation(location.id);
                            setLocationDraft(location.name);
                          }}
                          className="secondary-button"
                        >
                          Rename
                        </button>
                        <button
                          onClick={async () => {
                            try {
                              await toggleLocationActive(location.id);
                            } catch (error) {
                              console.error(
                                "Error toggling location:",
                                error,
                              );
                              addToast(
                                "Failed to update location. Please try again.",
                                "error",
                              );
                            }
                          }}
                          className="secondary-button"
                        >
                          {location.active === false
                            ? "Activate"
                            : "Deactivate"}
                        </button>
                        {onAssignFGArea && (
                          <button
                            onClick={() => onAssignFGArea(location.id)}
                            className="secondary-button"
                          >
                            Assign FG Area
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>

                <div className="sub-list">
                  {location.subLocations.map((sub) => {
                    const subKey = `${location.id}-${sub.id}`;
                    const isSubExpanded = expandedSubLocations.has(subKey);
                    const totalCapacity = (sub.rows || []).reduce(
                      (sum, r) => sum + (r.palletCapacity || 0),
                      0,
                    );
                    const totalUsed = (sub.rows || []).reduce(
                      (sum, r) => sum + (r.occupiedPallets || 0),
                      0,
                    );
                    const rowCount = (sub.rows || []).length;

                    return (
                      <div
                        key={sub.id}
                        style={{
                          marginBottom: "12px",
                          border: "1px solid #e5e7eb",
                          borderRadius: "4px",
                          background: "#fafafa",
                        }}
                      >
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
                            padding: "12px 16px",
                            cursor: "pointer",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: "16px",
                            background: isSubExpanded ? "#f0f0f0" : "#fafafa",
                            flexWrap: "wrap",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "12px",
                              flex: "1",
                              minWidth: "200px",
                            }}
                          >
                            <span
                              style={{ fontSize: "14px", flexShrink: 0 }}
                            >
                              {isSubExpanded ? "▼" : "▶"}
                            </span>
                            <strong
                              style={{
                                fontSize: "14px",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {sub.name}
                            </strong>
                            <span
                              style={{
                                fontSize: "12px",
                                color: "#666",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {rowCount} rows · {Number(totalUsed).toFixed(2)}/{totalCapacity}{" "}
                              pallets
                            </span>
                            <span
                              className={`chip ${
                                sub.active === false
                                  ? "chip-hold"
                                  : "chip-clear"
                              }`}
                              style={{ flexShrink: 0 }}
                            >
                              {sub.active === false ? "Inactive" : "ACTIVE"}
                            </span>
                          </div>
                          <div
                            style={{
                              display: "flex",
                              gap: "8px",
                              flexShrink: 0,
                            }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              onClick={() => {
                                setEditingSubLocation(sub);
                                setSubLocationDraft(sub.name);
                              }}
                              className="secondary-button"
                            >
                              Rename
                            </button>
                            <button
                              onClick={async () => {
                                try {
                                  await toggleSubLocationActive(
                                    location.id,
                                    sub.id,
                                  );
                                } catch (error) {
                                  console.error(
                                    "Error toggling sub-location:",
                                    error,
                                  );
                                  addToast(
                                    "Failed to update sub-location. Please try again.",
                                    "error",
                                  );
                                }
                              }}
                              className="secondary-button"
                            >
                              {sub.active === false ? "Activate" : "Deactivate"}
                            </button>
                          </div>
                        </div>

                        {/* Rename sub-location inline form */}
                        {editingSubLocation && editingSubLocation.id === sub.id && (
                          <div
                            style={{
                              padding: "8px 16px",
                              background: "#fff",
                              borderTop: "1px solid #e5e7eb",
                              display: "flex",
                              gap: "8px",
                              alignItems: "center",
                            }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              value={subLocationDraft}
                              onChange={(e) =>
                                setSubLocationDraft(e.target.value)
                              }
                              autoFocus
                              style={{ flex: 1, padding: "6px" }}
                            />
                            <button
                              onClick={() =>
                                handleRenameSubLocation(location.id, sub.id)
                              }
                              className="primary-button"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setEditingSubLocation(null)}
                              className="secondary-button"
                            >
                              Cancel
                            </button>
                          </div>
                        )}

                        {/* Expandable content - Rows and Add Row form */}
                        {isSubExpanded && (
                          <div style={{ padding: "8px", background: "#fff" }}>
                            {/* Display existing rows for this SubLocation */}
                            {sub.rows && sub.rows.length > 0 ? (
                              <div style={{ marginBottom: "12px" }}>
                                {sub.rows.map((row) => (
                                  <div
                                    key={row.id}
                                    className={`storage-row ${
                                      row.hold ? "on-hold" : ""
                                    }`}
                                    style={{
                                      padding: "12px",
                                      marginBottom: "8px",
                                      border: "1px solid #e5e7eb",
                                      borderRadius: "4px",
                                      background: row.hold
                                        ? "#fff3cd"
                                        : "#fff",
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
                                          style={{
                                            width: "100%",
                                            padding: "8px",
                                            marginBottom: "8px",
                                          }}
                                        />
                                        <div
                                          className="row-grid"
                                          style={{
                                            display: "flex",
                                            gap: "12px",
                                            flexWrap: "wrap",
                                          }}
                                        >
                                          <label
                                            style={{
                                              display: "flex",
                                              flexDirection: "column",
                                              gap: "4px",
                                            }}
                                          >
                                            <span>Pallet Capacity</span>
                                            <input
                                              type="number"
                                              value={rowDraft.palletCapacity}
                                              onChange={(e) =>
                                                setRowDraft((prev) => ({
                                                  ...prev,
                                                  palletCapacity:
                                                    Number(e.target.value) || 0,
                                                }))
                                              }
                                              min="0"
                                              style={{
                                                width: "100px",
                                                padding: "6px",
                                              }}
                                            />
                                          </label>
                                          <label
                                            style={{
                                              display: "flex",
                                              flexDirection: "column",
                                              gap: "4px",
                                            }}
                                          >
                                            <span>Cases/Pallet</span>
                                            <input
                                              type="number"
                                              value={
                                                rowDraft.defaultCasesPerPallet
                                              }
                                              onChange={(e) =>
                                                setRowDraft((prev) => ({
                                                  ...prev,
                                                  defaultCasesPerPallet:
                                                    Number(e.target.value) || 0,
                                                }))
                                              }
                                              min="0"
                                              style={{
                                                width: "100px",
                                                padding: "6px",
                                              }}
                                            />
                                          </label>
                                          <label
                                            className="checkbox"
                                            style={{
                                              display: "flex",
                                              alignItems: "center",
                                              gap: "4px",
                                            }}
                                          >
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
                                          value={rowDraft.notes || ""}
                                          onChange={(e) =>
                                            setRowDraft((prev) => ({
                                              ...prev,
                                              notes: e.target.value,
                                            }))
                                          }
                                          placeholder="Notes"
                                          style={{
                                            width: "100%",
                                            marginTop: "8px",
                                            padding: "8px",
                                          }}
                                        />
                                        <div
                                          className="node-actions"
                                          style={{ marginTop: "12px" }}
                                        >
                                          <button
                                            onClick={async () => {
                                              try {
                                                await updateSubLocationRow(
                                                  location.id,
                                                  sub.id,
                                                  row.id,
                                                  rowDraft,
                                                );
                                                setEditingRow(null);
                                              } catch (error) {
                                                addToast(
                                                  error.message ||
                                                    "Failed to update row. Please try again.",
                                                  "error",
                                                );
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
                                            <span
                                              className="muted"
                                              style={{ marginLeft: "8px" }}
                                            >
                                              {row.palletCapacity} pallet
                                              capacity ·{" "}
                                              {Number(row.occupiedPallets || 0).toFixed(2)}/
                                              {row.palletCapacity} pallets in
                                              use · {row.occupiedCases || 0}{" "}
                                              cases stored
                                            </span>
                                            {row.hold && (
                                              <span
                                                className="hold-flag"
                                                style={{ marginLeft: "8px" }}
                                              >
                                                On Hold
                                              </span>
                                            )}
                                            <span
                                              className={`chip ${
                                                row.active === false
                                                  ? "chip-hold"
                                                  : "chip-clear"
                                              }`}
                                              style={{ marginLeft: "8px" }}
                                            >
                                              {row.active === false
                                                ? "Inactive"
                                                : "Active"}
                                            </span>
                                          </div>
                                        </div>
                                        {row.notes && (
                                          <div
                                            className="row-notes"
                                            style={{
                                              marginTop: "8px",
                                              fontSize: "12px",
                                              color: "#666",
                                            }}
                                          >
                                            {row.notes}
                                          </div>
                                        )}
                                        <div
                                          className="node-actions"
                                          style={{ marginTop: "8px" }}
                                        >
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
                                                palletCapacity:
                                                  row.palletCapacity,
                                                defaultCasesPerPallet:
                                                  row.defaultCasesPerPallet,
                                                hold: row.hold,
                                                notes: row.notes,
                                              });
                                            }}
                                            className="secondary-button"
                                            style={{
                                              fontSize: "12px",
                                              padding: "4px 8px",
                                            }}
                                          >
                                            Edit
                                          </button>
                                          <button
                                            onClick={async () => {
                                              try {
                                                await toggleSubLocationRowActive(
                                                  location.id,
                                                  sub.id,
                                                  row.id,
                                                );
                                              } catch (error) {
                                                addToast(
                                                  error.message ||
                                                    "Failed to toggle row. Please try again.",
                                                  "error",
                                                );
                                              }
                                            }}
                                            className="secondary-button"
                                            style={{
                                              fontSize: "12px",
                                              padding: "4px 8px",
                                            }}
                                          >
                                            {row.active === false
                                              ? "Activate"
                                              : "Deactivate"}
                                          </button>
                                        </div>
                                      </>
                                    )}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div
                                style={{
                                  padding: "12px",
                                  color: "#666",
                                  fontSize: "14px",
                                }}
                              >
                                No rows in this sub-location
                              </div>
                            )}

                            {/* Add row form for this SubLocation */}
                            <form
                              onSubmit={async (e) => {
                                e.preventDefault();
                                const form = e.currentTarget;
                                const name =
                                  form.elements["subRowName"].value.trim();
                                const palletCapacity = Number(
                                  form.elements["subRowCap"].value || 0,
                                );
                                const defaultCasesPerPallet = Number(
                                  form.elements["subRowCPP"].value || 0,
                                );
                                if (!name) return;
                                try {
                                  await addSubLocationRow(location.id, sub.id, {
                                    name,
                                    palletCapacity,
                                    defaultCasesPerPallet,
                                  });
                                  form.reset();
                                } catch (error) {
                                  addToast(
                                    error.message ||
                                      "Failed to add row. Please try again.",
                                    "error",
                                  );
                                }
                              }}
                              className="inline-form"
                              style={{
                                marginTop: 8,
                                padding: "8px",
                                background: "#f9f9f9",
                                borderRadius: "4px",
                              }}
                            >
                              <input
                                name="subRowName"
                                placeholder="Add row (e.g., cage-1)"
                                style={{ flex: 1 }}
                              />
                              <input
                                name="subRowCap"
                                type="number"
                                min="0"
                                placeholder="Pallet cap"
                                style={{ width: 100 }}
                              />
                              <input
                                name="subRowCPP"
                                type="number"
                                min="0"
                                placeholder="Cases/pallet"
                                style={{ width: 110 }}
                              />
                              <button
                                type="submit"
                                className="secondary-button"
                              >
                                Add Row
                              </button>
                            </form>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!location.subLocations.length && (
                    <div className="sub-node empty">
                      No sub locations added yet.
                    </div>
                  )}
                </div>

                {/* Unified view: list FG areas linked to this main location */}
                <div className="sub-list">
                  <div className="small" style={{ color: "#64748b" }}>
                    Finished Goods at this location
                  </div>
                  {(storageAreas || []).filter(
                    (a) => a.locationId === location.id,
                  ).length === 0 && (
                    <div className="sub-node empty">
                      No FG storage areas linked. Add one below.
                    </div>
                  )}
                  {(storageAreas || [])
                    .filter((a) => a.locationId === location.id)
                    .map((area) => (
                      <div
                        key={`fg-${area.id}`}
                        className="sub-node"
                        style={{
                          flexDirection: "column",
                          alignItems: "stretch",
                          gap: 8,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <span>FG Storage · {area.name}</span>
                        </div>
                        {/* Quick add row under this area */}
                        <form
                          onSubmit={async (e) => {
                            e.preventDefault();
                            const name =
                              e.currentTarget.elements["rowName"].value.trim();
                            const palletCapacity = Number(
                              e.currentTarget.elements["rowCap"].value || 0,
                            );
                            const defaultCasesPerPallet = Number(
                              e.currentTarget.elements["rowCPP"].value || 0,
                            );
                            if (!name) return;
                            try {
                              await addStorageRow(area.id, {
                                name,
                                palletCapacity,
                                defaultCasesPerPallet,
                              });
                              e.currentTarget.reset();
                            } catch (error) {
                              addToast(
                                error.message ||
                                  "Failed to add storage row. Please try again.",
                                "error",
                              );
                            }
                          }}
                          className="inline-form"
                        >
                          <input
                            name="rowName"
                            placeholder="Add row (e.g., Zone A - Row 1)"
                          />
                          <input
                            name="rowCap"
                            type="number"
                            min="0"
                            placeholder="Pallet cap"
                            style={{ width: 120 }}
                          />
                          <input
                            name="rowCPP"
                            type="number"
                            min="0"
                            placeholder="Cases/pallet"
                            style={{ width: 140 }}
                          />
                          <button type="submit" className="secondary-button">
                            Add Row
                          </button>
                        </form>
                      </div>
                    ))}
                  {/* Quick add FG Area to this location */}
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const areaName =
                        e.currentTarget.elements["fgAreaName"].value.trim();
                      const allow =
                        e.currentTarget.elements["fgAllowFloor"].checked;
                      if (!areaName) return;
                      try {
                        await addStorageArea(areaName, allow, location.id);
                        e.currentTarget.reset();
                      } catch (error) {
                        addToast(
                          error.message ||
                            "Failed to add storage area. Please try again.",
                          "error",
                        );
                      }
                    }}
                    className="inline-form"
                  >
                    <input
                      name="fgAreaName"
                      placeholder={`Add FG area for ${location.name}`}
                    />
                    <label className="checkbox">
                      <input
                        name="fgAllowFloor"
                        type="checkbox"
                        defaultChecked
                      />
                      <span>Allow floor staging</span>
                    </label>
                    <button type="submit" className="secondary-button">
                      Add FG Area
                    </button>
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
    </section>
  );
};

export default LocationsSection;
