import React from "react";
import SearchableSelect from "../SearchableSelect";
import { formatNumber, formatInputValue } from "./useReceiptForm";

const requiredStar = <span className="required">*</span>;

const FinishedGoodPlacements = ({
  manualAllocations,
  manualTotals,
  floorPallets,
  setFloorPallets,
  fgWarehouseFilter,
  setFgWarehouseFilter,
  fgLocationsWithAreas,
  activeStorageAreas,
  storageAreaLookup,
  formData,
  addManualAllocation,
  updateManualAllocation,
  removeManualAllocation,
}) => {
  return (
    <section className="manual-allocation-panel full-width">
      <div className="panel-header-line">
        <div>
          <h4>Actual Pallet Placements</h4>
          <p className="muted small">
            Enter the exact rack row and pallet counts from the forklift log. Use decimals for partial pallets. Remaining pallets can be recorded as floor staging.
          </p>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span>Warehouse</span>
          <select value={fgWarehouseFilter} onChange={(e) => setFgWarehouseFilter(e.target.value)}>
            <option value="">All locations</option>
            {fgLocationsWithAreas.map((loc) => (
              <option key={loc.id} value={loc.id}>{loc.name}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="secondary-button"
          onClick={addManualAllocation}
        >
          Add Location
        </button>
      </div>

      {manualAllocations.length === 0 && (
        <div className="manual-allocation-empty">
          No rack placements added yet.
        </div>
      )}

      {manualAllocations.map((entry, idx) => {
        const area = storageAreaLookup.get(entry.areaId);
        const row = area?.rows.find((rowItem) => rowItem.id === entry.rowId);

        let availablePallets = null;
        if (row) {
          const storedOccupied = Number(row.occupiedPallets || 0);
          const capacity = Number(row.palletCapacity || 0);
          const palletsFromOtherPlacements = manualAllocations
            .filter(otherEntry =>
              otherEntry.rowId === entry.rowId &&
              otherEntry.id !== entry.id &&
              otherEntry.rowId !== ""
            )
            .reduce((sum, otherEntry) => sum + Number(otherEntry.pallets || 0), 0);
          availablePallets = Math.max(0, capacity - storedOccupied - palletsFromOtherPlacements);
        }

        const areaOptions = activeStorageAreas
          .filter((a) => !fgWarehouseFilter || a.locationId === fgWarehouseFilter)
          .map((areaOption) => ({
            value: areaOption.id,
            label: areaOption.name,
          }));

        const rowOptions = area
          ? area.rows
            .map((rowItem) => {
              const storedOccupied = Number(rowItem.occupiedPallets || 0);
              const capacity = Number(rowItem.palletCapacity || 0);
              const palletsFromCurrentForm = manualAllocations
                .filter(otherEntry =>
                  otherEntry.rowId === rowItem.id &&
                  otherEntry.id !== entry.id
                )
                .reduce((sum, otherEntry) => sum + Number(otherEntry.pallets || 0), 0);
              const available = Math.max(0, capacity - storedOccupied - palletsFromCurrentForm);

              return {
                value: rowItem.id,
                label: `${rowItem.name} (${available.toFixed(0)} available)`,
                available
              };
            })
            .filter(opt => opt.available > 0)
          : [];

        const entryPallets = Number(entry.fullPallets || 0);
        const overCapacity =
          availablePallets !== null && entryPallets > 0 && entryPallets > availablePallets;

        return (
          <div key={entry.id} className="manual-allocation-entry">
            <div className="allocation-header">
              <div className="allocation-title">
                <span className="allocation-label">Placement {idx + 1}</span>
                <span className="allocation-location">
                  {area?.name || "Select Area"} - {row?.name || "Select Row"}
                </span>
              </div>
              <button
                type="button"
                className="remove-allocation-btn"
                onClick={() => removeManualAllocation(entry.id)}
                title="Remove this placement"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>

            <div className="allocation-fields">
              <label>
                <span>Storage Area {requiredStar}</span>
                <SearchableSelect
                  options={areaOptions}
                  value={entry.areaId}
                  onChange={(areaId) => updateManualAllocation(entry.id, { areaId, rowId: "" })}
                  placeholder="Select area"
                  searchPlaceholder="Search areas..."
                  required
                />
              </label>

              {availablePallets !== null && availablePallets === 0 && (
                <div className="manual-allocation-warning">
                  Row is full. Please select a different row or remove other placements to this row.
                </div>
              )}

              {availablePallets !== null &&
                availablePallets > 0 &&
                Number.isFinite(Number(entry.fullPallets)) &&
                Number(entry.fullPallets) >= availablePallets && (
                  <div className="manual-allocation-warning">
                    Row filled. Press Enter or click Add Location to continue. Remaining pallets will still be shown below.
                  </div>
                )}

              <label>
                <span>Row {requiredStar}</span>
                <SearchableSelect
                  options={rowOptions}
                  value={entry.rowId}
                  onChange={(rowId) => updateManualAllocation(entry.id, { rowId })}
                  placeholder="Select row"
                  searchPlaceholder="Search rows..."
                  disabled={!entry.areaId}
                  required
                />
              </label>

              <label>
                <span>Full Pallets {requiredStar}</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={entry.fullPallets}
                  onChange={(e) => updateManualAllocation(entry.id, { fullPallets: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addManualAllocation();
                    }
                  }}
                  onWheel={(e) => e.currentTarget.blur()}
                  required
                />
                <p className="muted small">
                  {availablePallets !== null ? `Available: ${formatNumber(availablePallets)} pallets` : 'Select a row to view capacity'}
                </p>
              </label>
            </div>
            {overCapacity && (
              <div className="manual-allocation-warning">
                Row capacity exceeded. Only {availablePallets.toFixed(0)} pallets available. Reduce pallets or choose another row.
              </div>
            )}
          </div>
        );
      })}

      <div className="manual-allocation-summary">
        <div className="summary-stats">
          <div>
            <strong>Total rack cases:</strong> {formatNumber(manualTotals.rackCases)}
          </div>
          <div>
            <strong>Total rack pallets:</strong> {formatNumber(manualTotals.rackPallets)}
          </div>
        </div>

        <div className="floor-input">
          <label>
            <span>Floor Pallets</span>
            <div className="floor-pallets-control">
              <input
                type="number"
                min="0"
                step="0.01"
                value={floorPallets}
                onChange={(event) => setFloorPallets(event.target.value)}
                onWheel={(e) => e.currentTarget.blur()}
              />
              {Number(manualTotals.remainingFloorPallets) > 0 && (
                <button
                  type="button"
                  className="link-button"
                  onClick={() =>
                    setFloorPallets(
                      formatInputValue(manualTotals.remainingFloorPallets, 4),
                    )
                  }
                >
                  Use remaining ({formatNumber(manualTotals.remainingFloorPallets)})
                </button>
              )}
            </div>
          </label>
          <p className="muted small">
            Floor cases: {formatNumber(manualTotals.floorCases)}
          </p>
        </div>
      </div>
    </section>
  );
};

export default FinishedGoodPlacements;
