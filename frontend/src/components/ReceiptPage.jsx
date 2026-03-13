import React from "react";
import { getDashboardPath } from "../App";
import useReceiptForm, { formatNumber } from "./receipt/useReceiptForm";
import ReceiptFormFields from "./receipt/ReceiptFormFields";
import FinishedGoodPlacements from "./receipt/FinishedGoodPlacements";
import ReceiptConfirmModal from "./receipt/ReceiptConfirmModal";
import "./Shared.css";
import "./ReceiptPage.css";

const ReceiptPage = () => {
  const {
    // Navigation
    navigate,
    user,

    // Context data
    categoryGroups,
    categoryOptions,
    vendors,
    locations,
    subLocationMap,
    productionShifts,
    productionLines,

    // Form state
    formData,
    setFormData,
    formRef,
    feedback,
    autoQuantity,
    isSubmitting,
    confirmation,

    // Derived values
    productLabel,
    isFinishedGood,
    isPackaging,
    showPackagingFields,
    isIngredient,
    requiresRowSelection,
    isUnlimitedStorage,
    totalWeight,

    // Product options
    finishedGoodOptions,
    ingredientOptions,
    packagingOptions,

    // Location / row
    availableRows,

    // FG placement state
    manualAllocations,
    manualTotals,
    floorPallets,
    setFloorPallets,
    fgWarehouseFilter,
    setFgWarehouseFilter,
    fgLocationsWithAreas,
    activeStorageAreas,
    storageAreaLookup,

    // RM/packaging row allocations
    rawMaterialRowAllocations,
    setRawMaterialRowAllocations,

    // Handlers
    handleChange,
    handleCategoryGroupChange,
    handleCategoryChange,
    handleProductSelect,
    handleLocationChange,
    handleSubLocationChange,
    handlePalletsChange,
    handleSubmit,
    addManualAllocation,
    updateManualAllocation,
    removeManualAllocation,
    finalizeFinishedGoodReceipt,
    cancelConfirmation,
    clearForm,
  } = useReceiptForm();

  return (
    <div className="receipt-page">
      <div className="page-header">
        <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
          ← Back to Dashboard
        </button>
      </div>

      <div className="page-content">
        <section className="panel">
          <div className="panel-header">
            <h2>Log Receipt</h2>
            <p className="muted">
              Submit new inventory for supervisor approval. Finished and
              packaging goods will be auto slotted once approved.
            </p>
          </div>

          <form ref={formRef} onSubmit={handleSubmit} className="simple-form">
            <div className="form-grid receipt-layout">
              {/* Category Group Select */}
              <label className="full-width">
                <span>Item Category <span className="required">*</span></span>
                <select
                  name="categoryGroupId"
                  value={formData.categoryGroupId}
                  onChange={(e) => handleCategoryGroupChange(e.target.value)}
                  required
                >
                  <option value="">Select category</option>
                  {categoryGroups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </label>

              {/* Product Category Select */}
              {formData.categoryGroupId && (
                <label className="full-width">
                  <span>Product Category <span className="required">*</span></span>
                  <select
                    name="categoryId"
                    value={formData.categoryId}
                    onChange={(e) => handleCategoryChange(e.target.value)}
                    required
                  >
                    <option value="">Select product category</option>
                    {categoryOptions
                      .filter(
                        (category) =>
                          category.parentId === formData.categoryGroupId,
                      )
                      .map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}

              {/* Conditional form fields based on category type */}
              <ReceiptFormFields
                formData={formData}
                setFormData={setFormData}
                handleChange={handleChange}
                handleProductSelect={handleProductSelect}
                isFinishedGood={isFinishedGood}
                isIngredient={isIngredient}
                isPackaging={isPackaging}
                showPackagingFields={showPackagingFields}
                requiresRowSelection={requiresRowSelection}
                isUnlimitedStorage={isUnlimitedStorage}
                productLabel={productLabel}
                finishedGoodOptions={finishedGoodOptions}
                ingredientOptions={ingredientOptions}
                packagingOptions={packagingOptions}
                vendors={vendors}
                locations={locations}
                subLocationMap={subLocationMap}
                productionShifts={productionShifts}
                productionLines={productionLines}
                totalWeight={totalWeight}
                autoQuantity={autoQuantity}
                availableRows={availableRows}
                rawMaterialRowAllocations={rawMaterialRowAllocations}
                setRawMaterialRowAllocations={setRawMaterialRowAllocations}
                handleLocationChange={handleLocationChange}
                handleSubLocationChange={handleSubLocationChange}
                handlePalletsChange={handlePalletsChange}
              />

              {/* Finished Good Pallet Placements */}
              {isFinishedGood && formData.categoryId && (
                <FinishedGoodPlacements
                  manualAllocations={manualAllocations}
                  manualTotals={manualTotals}
                  floorPallets={floorPallets}
                  setFloorPallets={setFloorPallets}
                  fgWarehouseFilter={fgWarehouseFilter}
                  setFgWarehouseFilter={setFgWarehouseFilter}
                  fgLocationsWithAreas={fgLocationsWithAreas}
                  activeStorageAreas={activeStorageAreas}
                  storageAreaLookup={storageAreaLookup}
                  formData={formData}
                  addManualAllocation={addManualAllocation}
                  updateManualAllocation={updateManualAllocation}
                  removeManualAllocation={removeManualAllocation}
                />
              )}
            </div>

            {feedback && (
              <div className={`alert ${feedback.type}`}>{feedback.message}</div>
            )}

            <div className="form-actions">
              <button
                type="submit"
                className="primary-button"
                disabled={!formData.categoryId || !formData.productId || isSubmitting}
              >
                {isSubmitting ? 'Submitting...' : 'Submit for Approval'}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={clearForm}
              >
                Clear
              </button>
            </div>
          </form>
        </section>

        <ReceiptConfirmModal
          open={confirmation.open}
          summary={confirmation.summary}
          isSubmitting={isSubmitting}
          onConfirm={finalizeFinishedGoodReceipt}
          onCancel={cancelConfirmation}
          formatNumber={formatNumber}
        />
      </div>
    </div>
  );
};

export default ReceiptPage;
