import React, { useMemo, useRef, useState } from "react";
import { useAppData } from "../../context/AppDataContext";
import { useToast } from "../../context/ToastContext";
import "../MasterDataPage.css";

const FGStorageSection = ({ initialAreaLocation, onAreaLocationConsumed }) => {
  const {
    storageAreas,
    locations,
    addStorageArea,
    updateStorageArea,
    toggleStorageAreaActive,
    addStorageRow,
    updateStorageRow,
    toggleStorageRowActive,
  } = useAppData();
  const { addToast } = useToast();

  const fgFormRef = useRef(null);

  const [showInactiveStorage, setShowInactiveStorage] = useState(false);
  const [fgSearchTerm, setFgSearchTerm] = useState("");
  const [fgLocationFilter, setFgLocationFilter] = useState("all");
  const [expandedAreas, setExpandedAreas] = useState(new Set());
  const [expandedZones, setExpandedZones] = useState(new Set());

  const [newAreaName, setNewAreaName] = useState("");
  const [newAreaLocation, setNewAreaLocation] = useState(initialAreaLocation || "");
  const [allowFloorStorage, setAllowFloorStorage] = useState(true);

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

  // Allow parent (LocationsSection or shell) to pre-fill the location picker
  // and scroll the form into view
  React.useEffect(() => {
    if (initialAreaLocation) {
      setNewAreaLocation(initialAreaLocation);
      if (fgFormRef.current) {
        fgFormRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      if (onAreaLocationConsumed) onAreaLocationConsumed();
    }
  }, [initialAreaLocation, onAreaLocationConsumed]);

  const filteredStorageAreas = useMemo(() => {
    let areas = storageAreas;

    if (!showInactiveStorage) {
      areas = areas
        .filter((area) => area.active !== false)
        .map((area) => ({
          ...area,
          rows: area.rows.filter((row) => row.active !== false),
        }));
    }

    if (fgLocationFilter !== "all") {
      areas = areas.filter((area) => area.locationId === fgLocationFilter);
    }

    if (fgSearchTerm.trim()) {
      const searchLower = fgSearchTerm.toLowerCase().trim();
      areas = areas
        .filter((area) => {
          const areaMatches = area.name.toLowerCase().includes(searchLower);
          const rowMatches = area.rows.some((row) =>
            row.name.toLowerCase().includes(searchLower),
          );
          return areaMatches || rowMatches;
        })
        .map((area) => ({
          ...area,
          rows: area.rows.filter((row) =>
            row.name.toLowerCase().includes(searchLower),
          ),
        }));
    }

    return areas;
  }, [storageAreas, showInactiveStorage, fgLocationFilter, fgSearchTerm]);

  const groupedStorageAreas = useMemo(() => {
    return filteredStorageAreas.map((area) => {
      const zoneMap = new Map();

      area.rows.forEach((row) => {
        const match = row.name.match(/^([A-Z]+)\s*\d+/i);
        const zone = match
          ? match[1].toUpperCase()
          : row.name.split(/\s/)[0].toUpperCase();

        if (!zoneMap.has(zone)) {
          zoneMap.set(zone, []);
        }
        zoneMap.get(zone).push(row);
      });

      const zones = Array.from(zoneMap.entries())
        .map(([zoneName, rows]) => ({
          name: zoneName,
          rows: rows.sort((a, b) => {
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
        totalCapacity: area.rows.reduce(
          (sum, row) => sum + row.palletCapacity,
          0,
        ),
        totalUsed: area.rows.reduce(
          (sum, row) => sum + (row.occupiedPallets || 0),
          0,
        ),
        utilization:
          (area.rows.reduce((sum, row) => {
            const capacity = row.palletCapacity || 1;
            const used = row.occupiedPallets || 0;
            return sum + used / capacity;
          }, 0) /
            area.rows.length) *
          100,
      };
    });
  }, [filteredStorageAreas]);

  return (
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
            addToast(
              error.message || "Failed to add storage area. Please try again.",
              "error",
            );
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
      <div
        style={{
          marginBottom: "16px",
          display: "flex",
          gap: "12px",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <input
          type="text"
          placeholder="Search areas or rows..."
          value={fgSearchTerm}
          onChange={(e) => setFgSearchTerm(e.target.value)}
          style={{
            flex: "1",
            minWidth: "200px",
            padding: "8px 12px",
            border: "1px solid #ddd",
            borderRadius: "4px",
          }}
        />
        <select
          value={fgLocationFilter}
          onChange={(e) => setFgLocationFilter(e.target.value)}
          style={{
            padding: "8px 12px",
            border: "1px solid #ddd",
            borderRadius: "4px",
          }}
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
        <div
          style={{
            background: "#f5f5f5",
            padding: "12px",
            borderRadius: "6px",
            marginBottom: "16px",
            display: "flex",
            gap: "24px",
            flexWrap: "wrap",
            fontSize: "14px",
          }}
        >
          <span>
            <strong>{groupedStorageAreas.length}</strong> Areas
          </span>
          <span>
            <strong>
              {groupedStorageAreas.reduce((sum, a) => sum + a.totalRows, 0)}
            </strong>{" "}
            Rows
          </span>
          <span>
            <strong>
              {groupedStorageAreas.reduce((sum, a) => sum + a.totalUsed, 0)}
            </strong>{" "}
            /{" "}
            <strong>
              {groupedStorageAreas.reduce(
                (sum, a) => sum + a.totalCapacity,
                0,
              )}
            </strong>{" "}
            Pallets Used
          </span>
        </div>
      )}

      {/* Nested Accordion View */}
      <div className="storage-accordion">
        {groupedStorageAreas.map((area) => {
          const areaKey = area.id;
          const isAreaExpanded = expandedAreas.has(areaKey);

          return (
            <div
              key={area.id}
              className="accordion-item"
              style={{
                border: "1px solid #ddd",
                borderRadius: "6px",
                marginBottom: "12px",
                background: "#fff",
              }}
            >
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
                  padding: "16px",
                  cursor: "pointer",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  background: isAreaExpanded ? "#f9fafb" : "#fff",
                  borderBottom: isAreaExpanded ? "1px solid #ddd" : "none",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "12px",
                    flex: 1,
                  }}
                >
                  <span
                    style={{ fontSize: "18px", fontWeight: "bold" }}
                  >
                    {isAreaExpanded ? "▼" : "▶"}
                  </span>
                  <div>
                    <h3
                      style={{
                        margin: 0,
                        fontSize: "16px",
                        fontWeight: "600",
                      }}
                    >
                      {area.name}
                    </h3>
                    <div
                      style={{
                        fontSize: "12px",
                        color: "#666",
                        marginTop: "4px",
                      }}
                    >
                      {area.totalRows} rows · {area.totalUsed}/
                      {area.totalCapacity} pallets ·{" "}
                      {Math.round(area.utilization || 0)}% used
                    </div>
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: "8px",
                    alignItems: "center",
                  }}
                >
                  <span
                    className={`chip ${
                      area.active === false ? "chip-hold" : "chip-clear"
                    }`}
                  >
                    {area.active === false ? "Inactive" : "Active"}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingArea(area.id);
                      setAreaDraft(area.name);
                    }}
                    className="secondary-button"
                    style={{ fontSize: "12px", padding: "4px 8px" }}
                  >
                    Rename
                  </button>
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        await toggleStorageAreaActive(area.id);
                      } catch (error) {
                        addToast(
                          error.message ||
                            "Failed to toggle storage area. Please try again.",
                          "error",
                        );
                      }
                    }}
                    className="secondary-button"
                    style={{ fontSize: "12px", padding: "4px 8px" }}
                  >
                    {area.active === false ? "Activate" : "Deactivate"}
                  </button>
                </div>
              </div>

              {/* Area Content (Zones and Rows) */}
              {isAreaExpanded && (
                <div
                  className="accordion-content"
                  style={{ padding: "16px" }}
                >
                  {editingArea === area.id ? (
                    <>
                      <input
                        value={areaDraft}
                        onChange={(e) => setAreaDraft(e.target.value)}
                        autoFocus
                        style={{
                          width: "100%",
                          padding: "8px",
                          marginBottom: "12px",
                        }}
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
                              addToast(
                                error.message ||
                                  "Failed to update storage area. Please try again.",
                                "error",
                              );
                            }
                          }}
                        />
                        <span>Allow floor storage</span>
                      </label>
                      <div
                        className="node-actions"
                        style={{ marginTop: "12px" }}
                      >
                        <button
                          onClick={async () => {
                            try {
                              await updateStorageArea(area.id, {
                                name: areaDraft,
                              });
                              setEditingArea(null);
                            } catch (error) {
                              addToast(
                                error.message ||
                                  "Failed to update storage area. Please try again.",
                                "error",
                              );
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
                          const zoneCapacity = zone.rows.reduce(
                            (sum, r) => sum + r.palletCapacity,
                            0,
                          );
                          const zoneUsed = zone.rows.reduce(
                            (sum, r) => sum + (r.occupiedPallets || 0),
                            0,
                          );

                          return (
                            <div
                              key={zone.name}
                              style={{
                                marginBottom: "12px",
                                border: "1px solid #e5e7eb",
                                borderRadius: "4px",
                                background: "#fafafa",
                              }}
                            >
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
                                  padding: "12px",
                                  cursor: "pointer",
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  background: isZoneExpanded
                                    ? "#f0f0f0"
                                    : "#fafafa",
                                }}
                              >
                                <div
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "8px",
                                  }}
                                >
                                  <span style={{ fontSize: "14px" }}>
                                    {isZoneExpanded ? "▼" : "▶"}
                                  </span>
                                  <strong style={{ fontSize: "14px" }}>
                                    Zone {zone.name}
                                  </strong>
                                  <span
                                    style={{ fontSize: "12px", color: "#666" }}
                                  >
                                    ({zone.rows.length} rows · {zoneUsed}/
                                    {zoneCapacity} pallets)
                                  </span>
                                </div>
                              </div>

                              {/* Zone Rows */}
                              {isZoneExpanded && (
                                <div
                                  style={{
                                    padding: "8px",
                                    background: "#fff",
                                  }}
                                >
                                  {zone.rows.map((row) => (
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
                                            style={{
                                              width: "100%",
                                              padding: "8px",
                                              marginBottom: "8px",
                                            }}
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
                                                <option value="custom">
                                                  Custom
                                                </option>
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
                                                    palletCapacity: Number(
                                                      e.target.value,
                                                    ),
                                                  }))
                                                }
                                              />
                                            </label>
                                            <label>
                                              <span>Default Cases / Pallet</span>
                                              <input
                                                type="number"
                                                value={
                                                  rowDraft.defaultCasesPerPallet
                                                }
                                                min="0"
                                                onChange={(e) =>
                                                  setRowDraft((prev) => ({
                                                    ...prev,
                                                    defaultCasesPerPallet:
                                                      Number(e.target.value),
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
                                                  await updateStorageRow(
                                                    area.id,
                                                    row.id,
                                                    rowDraft,
                                                  );
                                                  setEditingRow(null);
                                                } catch (error) {
                                                  addToast(
                                                    error.message ||
                                                      "Failed to update storage row. Please try again.",
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
                                                capacity · {row.occupiedPallets}
                                                /{row.palletCapacity} pallets in
                                                use · {row.occupiedCases} cases
                                                stored
                                              </span>
                                              {row.productId && (
                                                <span
                                                  style={{
                                                    marginLeft: "8px",
                                                    fontSize: "12px",
                                                    color: "#666",
                                                  }}
                                                >
                                                  Product: {row.productId}
                                                </span>
                                              )}
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
                                                  areaId: area.id,
                                                  id: row.id,
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
                                                  await toggleStorageRowActive(
                                                    area.id,
                                                    row.id,
                                                  );
                                                } catch (error) {
                                                  addToast(
                                                    error.message ||
                                                      "Failed to toggle storage row. Please try again.",
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
                              )}
                            </div>
                          );
                        })
                      ) : (
                        <div
                          style={{
                            padding: "12px",
                            color: "#666",
                            fontSize: "14px",
                          }}
                        >
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
                            setRowError(
                              error.message ||
                                "Failed to add storage row. Please try again.",
                            );
                          }
                        }}
                        className="inline-form row-form"
                        style={{
                          marginTop: "16px",
                          padding: "12px",
                          background: "#f9fafb",
                          borderRadius: "4px",
                        }}
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
                            <option value="3x5">3 x 5 (15 pallets)</option>
                            <option value="3x8">3 x 8 (24 pallets)</option>
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
                                defaultCasesPerPallet: Number(e.target.value),
                              }))
                            }
                          />
                        </label>
                        <button type="submit" className="secondary-button">
                          Add Row
                        </button>
                        {rowError && (
                          <div
                            style={{
                              color: "red",
                              fontSize: "12px",
                              marginTop: "8px",
                            }}
                          >
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
        <div
          className="storage-card empty"
          style={{ padding: "24px", textAlign: "center", color: "#666" }}
        >
          {fgSearchTerm || fgLocationFilter !== "all"
            ? "No areas match your filters."
            : "No finished goods areas defined."}
        </div>
      )}
    </div>
  );
};

export default FGStorageSection;
