import React, { useState } from "react";
import { getDashboardPath } from "../App";
import useReceiptForm, { formatNumber } from "./receipt/useReceiptForm";
import ReceiptFormFields from "./receipt/ReceiptFormFields";
import FinishedGoodPlacements from "./receipt/FinishedGoodPlacements";
import ReceiptConfirmModal from "./receipt/ReceiptConfirmModal";
import LotLabelPrint from "./ingredient/LotLabelPrint";
import PrintStickersDialog from "./ingredient/PrintStickersDialog";
import { useToast } from "../context/ToastContext";
import { apiErrorMessage, printSessionLabels } from "../api/lotReceivingApi";
import "./Shared.css";
import "./ReceiptPage.css";
import { singularUnit } from '../utils/rowSources';

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
    justLogged,
    setJustLogged,
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
    roomStorageUnit,

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

  const { addToast } = useToast();
  const [sheet, setSheet] = useState(null);
  const [printing, setPrinting] = useState(false);
  // Open while the pallet-vs-container choice is being made.
  const [asking, setAsking] = useState(false);

  /**
   * Resolve (or mint) this receipt's lot and pull down `count` identical
   * stickers. The server refuses to print for a lot flagged for review — an
   * identical sticker on the wrong material cannot be found later, because every
   * drum on the pile is wearing it.
   */
  const handlePrintStickers = async ({ count, scope }) => {
    if (!justLogged) return;
    setPrinting(true);
    try {
      setSheet(await printSessionLabels(justLogged.receiptId, count, { scope }));
      setAsking(false);
    } catch (error) {
      addToast(apiErrorMessage(error, 'Could not print stickers'), 'error');
    } finally {
      setPrinting(false);
    }
  };

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
                roomStorageUnit={roomStorageUnit}
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

            {/* A Log Receipt is stock ALREADY on the racks: approval places it
                from the form, and nothing is scanned. Stickers are optional and
                only label it for later moves and staging pulls. A delivery that
                must be scanned in is a truck (Incoming -> Walk-in), not this
                form — telling people to scan here put a logged receipt on the
                gun at "0 of 105" (production, 2026-10-05). */}
            {justLogged && (
              <div className="alert info" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                <span>
                  Stickers for this lot — one per wrapped pallet if it came
                  palletised, otherwise one for every{' '}
                  {singularUnit(justLogged.unitLabel)}. Optional — this stock is
                  already on the rack, so nothing needs scanning; approval puts it
                  in the system. A delivery that needs scanning in goes through
                  Incoming → Walk-in instead.
                </span>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => setAsking(true)}
                  disabled={printing}
                >
                  {printing ? 'Preparing…' : 'Print stickers'}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setJustLogged(null)}
                >
                  Not now
                </button>
              </div>
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

        <PrintStickersDialog
          open={asking && !!justLogged}
          busy={printing}
          lot={justLogged && {
            productName: justLogged.productName,
            unitLabel: singularUnit(justLogged.unitLabel || 'unit'),
            unitsPerPallet: justLogged.unitsPerPallet,
            totalUnits: justLogged.count,
          }}
          onCancel={() => setAsking(false)}
          onConfirm={handlePrintStickers}
        />

        {sheet && <LotLabelPrint sheet={sheet} onDone={() => setSheet(null)} />}

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
