import React from "react";

const requiredStar = <span className="required">*</span>;

const RawMaterialRowSelection = ({
  formData,
  handlePalletsChange,
  requiresRowSelection,
  isUnlimitedStorage,
  availableRows,
  rawMaterialRowAllocations,
  setRawMaterialRowAllocations,
}) => {
  return (
    <>
      {/* Step 1: Enter total pallets needed FIRST */}
      <label>
        <span>Total Pallets Needed {requiredStar}</span>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <input
            type="number"
            name="pallets"
            value={formData.pallets}
            onChange={handlePalletsChange}
            min="1"
            step="1"
            required={requiresRowSelection}
            style={{ flex: 1 }}
            placeholder="Enter total pallet count"
          />
        </div>
        <div className="form-hint" style={{ marginTop: '4px', color: '#666', fontSize: '0.875rem' }}>
          {isUnlimitedStorage
            ? "Unlimited storage - no row selection needed. Enter total pallets and submit."
            : "Enter the total number of pallets you need to store. Then select one or more rows below."}
        </div>
      </label>

      {/* Step 2: Select rows (only when sub location has rows; 0/0 = unlimited, no selection) */}
      {formData.pallets && Number(formData.pallets) > 0 && !isUnlimitedStorage && (
        <div>
          <label style={{ display: 'block', marginBottom: '8px' }}>
            <span>Select Row(s) {requiredStar}</span>
          </label>

          {availableRows.length === 0 ? (
            <div className="form-error" style={{ padding: '12px', borderRadius: '4px', backgroundColor: '#fee', border: '1px solid #fcc' }}>
              No rows available with sufficient capacity for {formData.pallets} pallets.
              Please add more rows in Master Data or reduce the pallet count.
            </div>
          ) : (
            <div style={{
              border: '1px solid #ddd',
              borderRadius: '4px',
              padding: '12px',
              maxHeight: '200px',
              overflowY: 'auto',
              backgroundColor: '#fafafa'
            }}>
              {availableRows.map((row) => {
                const isSelected = rawMaterialRowAllocations.some(alloc => alloc.rowId === row.value);
                const canFitAll = row.available !== null && row.available >= Number(formData.pallets);

                return (
                  <label
                    key={row.value}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      padding: '8px',
                      marginBottom: '4px',
                      cursor: 'pointer',
                      backgroundColor: isSelected ? '#e8f5e9' : 'transparent',
                      borderRadius: '4px',
                      border: isSelected ? '2px solid #4caf50' : '1px solid transparent'
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={(e) => {
                        if (e.target.checked) {
                          const alreadyAllocated = rawMaterialRowAllocations.reduce(
                            (sum, a) => sum + (Number(a.pallets) || 0), 0
                          );
                          const totalNeeded = Number(formData.pallets) || 0;
                          const remainingToAllocate = Math.max(0, totalNeeded - alreadyAllocated);
                          const palletsForThisRow = Math.min(remainingToAllocate, row.available || 0);

                          const newAlloc = {
                            id: `raw-alloc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                            rowId: row.value,
                            rowName: row.rowData.name,
                            pallets: palletsForThisRow,
                            available: row.available,
                            capacity: row.capacity,
                          };
                          setRawMaterialRowAllocations(prev => [...prev, newAlloc]);
                        } else {
                          setRawMaterialRowAllocations(prev => prev.filter(alloc => alloc.rowId !== row.value));
                        }
                      }}
                      style={{ marginRight: '8px' }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: isSelected ? 'bold' : 'normal' }}>
                        {row.label}
                      </div>
                      {row.fitStatus && (
                        <div style={{ fontSize: '0.875rem', color: canFitAll ? '#4caf50' : '#ff9800', marginTop: '2px' }}>
                          {row.fitStatus}
                        </div>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          )}

          {/* Step 3: Distribution panel when multiple rows selected */}
          {rawMaterialRowAllocations.length > 1 && (
            <div style={{
              marginTop: '16px',
              padding: '12px',
              backgroundColor: '#f5f5f5',
              borderRadius: '4px',
              border: '1px solid #ddd'
            }}>
              <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>
                Distribute Pallets Across Selected Rows
              </div>
              {rawMaterialRowAllocations.map((alloc) => {
                const row = availableRows.find(r => r.value === alloc.rowId);
                const maxPallets = alloc.available || row?.capacity || alloc.capacity || 0;

                return (
                  <div key={alloc.id} style={{ marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <label style={{ minWidth: '100px', fontWeight: '500' }}>
                      {alloc.rowName}:
                    </label>
                    <input
                      type="number"
                      value={alloc.pallets}
                      onChange={(e) => {
                        const newPallets = Math.max(0, Math.min(Number(e.target.value), maxPallets));
                        setRawMaterialRowAllocations(prev =>
                          prev.map(a => a.id === alloc.id ? { ...a, pallets: newPallets } : a)
                        );
                      }}
                      min="0"
                      max={maxPallets}
                      step="1"
                      style={{ width: '80px', padding: '4px 8px' }}
                    />
                    <span style={{ fontSize: '0.875rem', color: '#666' }}>
                      (max: {maxPallets})
                    </span>
                  </div>
                );
              })}
              <div style={{ marginTop: '8px', padding: '8px', backgroundColor: '#fff', borderRadius: '4px' }}>
                <strong>Total: </strong>
                <span style={{
                  color: rawMaterialRowAllocations.reduce((sum, a) => sum + (Number(a.pallets) || 0), 0) === Number(formData.pallets)
                    ? '#4caf50'
                    : '#f44336',
                  fontWeight: 'bold'
                }}>
                  {rawMaterialRowAllocations.reduce((sum, a) => sum + (Number(a.pallets) || 0), 0)} / {formData.pallets}
                </span>
                {rawMaterialRowAllocations.reduce((sum, a) => sum + (Number(a.pallets) || 0), 0) !== Number(formData.pallets) && (
                  <div style={{ fontSize: '0.875rem', color: '#f44336', marginTop: '4px' }}>
                    Total must equal {formData.pallets} pallets
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Single row selected - show confirmation */}
          {rawMaterialRowAllocations.length === 1 && (
            <div style={{
              marginTop: '12px',
              padding: '8px',
              backgroundColor: '#e8f5e9',
              borderRadius: '4px',
              border: '1px solid #4caf50'
            }}>
              <div style={{ fontSize: '0.875rem', color: '#2e7d32' }}>
                {rawMaterialRowAllocations[0].rowName} will store {formData.pallets} pallets
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
};

export default RawMaterialRowSelection;
