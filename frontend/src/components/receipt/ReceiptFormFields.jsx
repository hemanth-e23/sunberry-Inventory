import React from "react";
import SearchableSelect from "../SearchableSelect";
import RawMaterialRowSelection from "./RawMaterialRowSelection";
import { unitOptions, weightUnitOptions, formatNumber } from "./useReceiptForm";

const requiredStar = <span className="required">*</span>;

const ReceiptFormFields = ({
  formData,
  setFormData,
  handleChange,
  handleProductSelect,
  // Category type flags
  isFinishedGood,
  isIngredient,
  isPackaging,
  showPackagingFields,
  requiresRowSelection,
  isUnlimitedStorage,
  // Product options
  productLabel,
  finishedGoodOptions,
  ingredientOptions,
  packagingOptions,
  // Dropdown data
  vendors,
  locations,
  subLocationMap,
  productionShifts,
  productionLines,
  // Weight
  totalWeight,
  // Auto quantity
  autoQuantity,
  // Location / row
  availableRows,
  rawMaterialRowAllocations,
  setRawMaterialRowAllocations,
  handleLocationChange,
  handleSubLocationChange,
  handlePalletsChange,
}) => {
  if (!formData.categoryId) {
    return (
      <div className="form-hint full-width">
        Choose a product category to load the rest of the receipt form.
      </div>
    );
  }

  return (
    <React.Fragment>
      <label className="full-width">
        <span>
          {productLabel} {requiredStar}
        </span>
        <SearchableSelect
          options={
            isFinishedGood
              ? finishedGoodOptions
              : isIngredient
                ? ingredientOptions
                : packagingOptions
          }
          value={formData.productId}
          onChange={handleProductSelect}
          placeholder="Select product"
          searchPlaceholder="Type to search..."
          required
        />
      </label>

      {(isIngredient || isPackaging) && (
        <label>
          <span>SID / Barcode {requiredStar}</span>
          <input
            type="text"
            name="sid"
            value={formData.sid}
            onChange={handleChange}
            required
          />
        </label>
      )}

      {isFinishedGood && (
        <label>
          <span>FCC Code {requiredStar}</span>
          <input
            type="text"
            name="fccCode"
            value={formData.fccCode}
            onChange={handleChange}
            required
          />
        </label>
      )}

      {(isIngredient || isPackaging) && (
        <label>
          <span>Vendor</span>
          <select
            name="vendorId"
            value={formData.vendorId}
            onChange={handleChange}
          >
            <option value="">Select vendor (optional)</option>
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {isFinishedGood && (
        <label>
          <span>Production Date {requiredStar}</span>
          <input
            type="date"
            name="productionDate"
            value={formData.productionDate}
            onChange={handleChange}
            required
          />
        </label>
      )}

      {isFinishedGood && (
        <label>
          <span>Expiration Date {requiredStar}</span>
          <input
            type="date"
            name="expiration"
            value={formData.expiration}
            onChange={(e) => {
              handleChange(e);
              setFormData((prev) => ({ ...prev, expirationTouched: true }));
            }}
            required
          />
        </label>
      )}

      {isIngredient && (
        <label>
          <span>Expiration Date {requiredStar}</span>
          <input
            type="date"
            name="expiration"
            value={formData.expiration}
            onChange={handleChange}
            required
          />
        </label>
      )}

      {isPackaging && (
        <label>
          <span>Expiration Date (Optional)</span>
          <input
            type="date"
            name="expiration"
            value={formData.expiration}
            onChange={handleChange}
          />
        </label>
      )}

      <label>
        <span>Receipt Date {requiredStar}</span>
        <input
          type="date"
          name="receiptDate"
          value={formData.receiptDate}
          onChange={handleChange}
          required
        />
      </label>

      {isFinishedGood && (
        <label>
          <span>Shift {requiredStar}</span>
          <select
            name="shift"
            value={formData.shift}
            onChange={handleChange}
            required
          >
            <option value="">Select shift</option>
            {productionShifts.map((shift) => (
              <option key={shift.id} value={shift.id}>
                {shift.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {isFinishedGood && (
        <label>
          <span>Line Number {requiredStar}</span>
          <select
            name="lineNumber"
            value={formData.lineNumber}
            onChange={handleChange}
            required
          >
            <option value="">Select line</option>
            {productionLines.map((line) => (
              <option key={line.id} value={line.id}>
                {line.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <label>
        <span>Lot Number {(isFinishedGood || isIngredient) ? requiredStar : null}</span>
        <input
          type="text"
          name="lotNo"
          value={formData.lotNo}
          onChange={handleChange}
          required={isFinishedGood || isIngredient}
          aria-label="Lot number"
        />
      </label>

      {(isIngredient || showPackagingFields) && (
        <React.Fragment>
          {/* Inline container row: count [type] x weight [unit] */}
          <label className="full-width">
            <span>Received As {requiredStar}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <input
                type="number"
                name="quantity"
                value={formData.quantity}
                onChange={handleChange}
                min="0"
                step="0.01"
                required
                placeholder="Count"
                style={{ width: 90 }}
              />
              <select
                name="quantityUnits"
                value={formData.quantityUnits}
                onChange={handleChange}
                required
                style={{ width: 130 }}
              >
                <option value="">Type...</option>
                {unitOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>

              {isIngredient && (
                <>
                  <span style={{ color: '#9ca3af', fontWeight: 600 }}>×</span>
                  <input
                    type="number"
                    name="weightPerUnit"
                    value={formData.weightPerUnit}
                    onChange={handleChange}
                    min="0"
                    step="0.01"
                    required
                    placeholder="Weight each"
                    style={{ width: 110 }}
                  />
                  <select
                    name="weightUnits"
                    value={formData.weightUnits}
                    onChange={handleChange}
                    required
                    style={{ width: 100 }}
                  >
                    <option value="">Unit...</option>
                    {weightUnitOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>

            {/* Summary: 15 Bags . 3,750 lbs total */}
            {isIngredient && formData.quantity && formData.quantityUnits && formData.weightPerUnit && formData.weightUnits && totalWeight > 0 && (
              <div style={{ marginTop: 8, padding: '8px 14px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, display: 'inline-flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontWeight: 700, color: '#15803d', fontSize: '0.95rem' }}>
                  {formData.quantity} {formData.quantityUnits}
                </span>
                <span style={{ color: '#9ca3af' }}>·</span>
                <span style={{ fontWeight: 700, color: '#1a5276', fontSize: '0.95rem' }}>
                  {Number(formData.weight).toLocaleString()} {formData.weightUnits} total
                </span>
                <span style={{ color: '#9ca3af', fontSize: '0.8rem' }}>
                  ({formData.weightPerUnit} {formData.weightUnits} × {formData.quantity})
                </span>
              </div>
            )}
          </label>

          {isIngredient && (
            <label>
              <span>Brix</span>
              <input
                type="number"
                name="brix"
                value={formData.brix}
                onChange={handleChange}
                min="0"
                step="0.1"
              />
            </label>
          )}

          <label>
            <span>Location {requiredStar}</span>
            <select
              name="location"
              value={formData.location}
              onChange={(e) => handleLocationChange(e.target.value)}
              required
            >
              <option value="">Select location</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </label>

          {formData.location && (
            <label>
              <span>Sub Location {requiredStar}</span>
              <select
                name="subLocation"
                value={formData.subLocation}
                onChange={(e) => handleSubLocationChange(e.target.value)}
                required
              >
                <option value="">Select sub location</option>
                {(subLocationMap[formData.location] || []).map(
                  (sub) => (
                    <option key={sub.id} value={sub.id}>
                      {sub.name}
                    </option>
                  ),
                )}
              </select>
            </label>
          )}

          {/* Row selection for raw materials and packaging */}
          {formData.subLocation && (requiresRowSelection || availableRows.length > 0) && (
            <RawMaterialRowSelection
              formData={formData}
              handlePalletsChange={handlePalletsChange}
              requiresRowSelection={requiresRowSelection}
              isUnlimitedStorage={isUnlimitedStorage}
              availableRows={availableRows}
              rawMaterialRowAllocations={rawMaterialRowAllocations}
              setRawMaterialRowAllocations={setRawMaterialRowAllocations}
            />
          )}

          {formData.subLocation && availableRows.length === 0 && !formData.pallets && requiresRowSelection && (
            <div className="form-hint" style={{ marginTop: '4px', color: '#666', fontSize: '0.875rem' }}>
              {isUnlimitedStorage
                ? "Unlimited storage - enter total pallets above and submit."
                : "Enter pallet count above to see available rows."}
            </div>
          )}
        </React.Fragment>
      )}

      {showPackagingFields && null}

      {isIngredient && (
        <React.Fragment>
          <label>
            <span>BOL (Bill of Lading)</span>
            <input
              type="text"
              name="bol"
              value={formData.bol}
              onChange={handleChange}
            />
          </label>

          <label>
            <span>Purchase Order</span>
            <input
              type="text"
              name="purchaseOrder"
              value={formData.purchaseOrder}
              onChange={handleChange}
            />
          </label>

          <label className="full-width optional">
            <span>Description / Notes</span>
            <textarea
              name="note"
              value={formData.note}
              onChange={handleChange}
              rows={3}
            />
          </label>
        </React.Fragment>
      )}

      {isFinishedGood && (
        <label>
          <span>Cases per Pallet {requiredStar}</span>
          <input
            type="number"
            name="casesPerPallet"
            min="1"
            value={formData.casesPerPallet}
            onChange={handleChange}
            required
          />
        </label>
      )}

      {isFinishedGood && (
        <label>
          <span>Full Pallets {requiredStar}</span>
          <input
            type="number"
            name="fullPallets"
            min="0"
            step="1"
            value={formData.fullPallets}
            onChange={handleChange}
            required
          />
        </label>
      )}

      {isFinishedGood && (
        <div className="partial-layout">
          <label className="checkbox">
            <input
              type="checkbox"
              name="hasPartialPallet"
              checked={formData.hasPartialPallet}
              onChange={handleChange}
            />
            <span>Include partial pallet</span>
          </label>

          {formData.hasPartialPallet && (
            <label className="partial-cases">
              <span>Cases on Partial Pallet {requiredStar}</span>
              <input
                type="number"
                name="partialCases"
                min="0"
                step="1"
                value={formData.partialCases}
                onChange={handleChange}
                disabled={!formData.hasPartialPallet}
                required={formData.hasPartialPallet}
              />
            </label>
          )}
        </div>
      )}

      {isFinishedGood && (
        <label>
          <span>Quantity Produced {requiredStar}</span>
          <div className="unit-label">
            <input
              type="number"
              name="quantity"
              value={formData.quantity}
              onChange={handleChange}
              placeholder={autoQuantity ? formatNumber(Number(autoQuantity)) : ""}
              required
            />
            <span className="unit-badge">Cases</span>
          </div>
        </label>
      )}
    </React.Fragment>
  );
};

export default ReceiptFormFields;
