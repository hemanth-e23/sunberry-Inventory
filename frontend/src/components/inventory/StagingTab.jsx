import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { formatDate, formatDateTime, escapeHtml } from '../../utils/dateUtils';
import apiClient from '../../api/client';
import '../InventoryActionsPage.css';
import { CATEGORY_TYPES } from '../../constants';

const StagingTab = () => {
  const navigate = useNavigate();
  const { addToast } = useToast();
  const { user } = useAuth();
  const {
    products,
    categories,
    locations,
    subLocationMap,
    refreshReceipts,
  } = useAppData();

  const [stagingForm, setStagingForm] = useState({
    stagingLocation: '',
    stagingSubLocation: '',
    items: []
  });
  const [stagingError, setStagingError] = useState('');
  const [isSubmittingStaging, setIsSubmittingStaging] = useState(false);

  const productLookup = useMemo(() => {
    const map = {};
    products.forEach(product => { map[product.id] = product; });
    return map;
  }, [products]);

  const stagingProducts = useMemo(() => products.filter(product => {
    const category = categories.find(cat => cat.id === product.categoryId);
    if (!category) return false;
    if (category.type === CATEGORY_TYPES.FINISHED) return false;
    return category.type === 'raw' || category.type === CATEGORY_TYPES.PACKAGING;
  }), [products, categories]);

  const fetchLotSuggestions = async (productId, quantityNeeded) => {
    try {
      const response = await apiClient.get('/inventory/staging/suggest-lots', {
        params: { product_id: productId, quantity: quantityNeeded },
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching lot suggestions:', error);
      return [];
    }
  };

  const handleAddStagingProduct = async () => {
    const productSelect = document.getElementById('staging-product-select');
    const quantityInput = document.getElementById('staging-quantity-input');

    if (!productSelect || !quantityInput) return;

    const productId = productSelect.value;
    const quantity = parseFloat(quantityInput.value);

    if (!productId || !quantity || quantity <= 0) {
      setStagingError('Please select a product and enter a valid quantity.');
      return;
    }

    if (stagingForm.items.some(item => item.productId === productId)) {
      setStagingError('This product is already in the staging list. Remove it first to change quantity.');
      return;
    }

    const product = productLookup[productId];

    const suggestions = await fetchLotSuggestions(productId, quantity * 2);

    if (suggestions.length === 0) {
      setStagingError('No available lots found for this product.');
      return;
    }

    const unit = suggestions[0]?.unit || product?.quantityUom || 'cases';

    const firstSuggestion = suggestions[0];
    const lots = [];

    if (firstSuggestion) {
      const lotQuantity = Math.min(firstSuggestion.available_quantity, quantity);
      lots.push({
        receiptId: firstSuggestion.receipt_id,
        quantity: lotQuantity,
        unit: firstSuggestion.unit || unit,
        suggestion: firstSuggestion
      });
    }

    setStagingForm(prev => ({
      ...prev,
      items: [...prev.items, {
        productId,
        quantityNeeded: quantity,
        lots: lots,
        unit: unit,
        suggestions: suggestions
      }]
    }));

    productSelect.value = '';
    quantityInput.value = '';
    setStagingError('');
  };

  const handleRemoveStagingProduct = (index) => {
    setStagingForm(prev => ({
      ...prev,
      items: prev.items.filter((_, i) => i !== index)
    }));
  };

  const handleAddLotToStagingItem = (itemIndex) => {
    setStagingForm(prev => ({
      ...prev,
      items: prev.items.map((item, i) => {
        if (i !== itemIndex) return item;

        const totalSelected = item.lots.reduce((sum, lot) => sum + lot.quantity, 0);
        const remainingNeeded = item.quantityNeeded - totalSelected;

        if (remainingNeeded <= 0) {
          setStagingError('All quantity has been allocated to lots.');
          return item;
        }

        return {
          ...item,
          lots: [...item.lots, { receiptId: '', quantity: remainingNeeded, unit: item.unit, suggestion: null }]
        };
      })
    }));
    setStagingError('');
  };

  const handleStagingLotChange = (itemIndex, lotIndex, field, value) => {
    setStagingForm(prev => ({
      ...prev,
      items: prev.items.map((item, i) => {
        if (i !== itemIndex) return item;

        return {
          ...item,
          lots: item.lots.map((lot, j) => {
            if (j !== lotIndex) return lot;

            if (field === 'receiptId') {
              const suggestion = item.suggestions?.find(s => s.receipt_id === value);
              if (!suggestion) return { ...lot, receiptId: '', suggestion: null };

              const maxAvailable = suggestion.available_quantity || 0;
              const currentQuantity = lot.quantity || 0;
              const remainingNeeded = item.quantityNeeded - item.lots.reduce((sum, l, idx) => {
                if (idx === lotIndex) return sum;
                return sum + (l.quantity || 0);
              }, 0);

              const newQuantity = Math.min(maxAvailable, Math.max(remainingNeeded, currentQuantity)) || Math.min(maxAvailable, remainingNeeded) || maxAvailable || 0;

              return {
                ...lot,
                receiptId: value,
                suggestion: suggestion,
                quantity: newQuantity,
                unit: suggestion.unit || item.unit || 'cases'
              };
            } else if (field === 'quantity') {
              const qty = parseFloat(value) || 0;
              const maxAvailable = lot.suggestion?.available_quantity || 999999;

              const clampedQty = Math.min(Math.max(0, qty), maxAvailable);

              return {
                ...lot,
                quantity: clampedQty
              };
            }

            return { ...lot, [field]: value };
          })
        };
      })
    }));
    setStagingError('');
  };

  const handleRemoveStagingLot = (itemIndex, lotIndex) => {
    setStagingForm(prev => ({
      ...prev,
      items: prev.items.map((item, i) => {
        if (i !== itemIndex) return item;
        return {
          ...item,
          lots: item.lots.filter((_, j) => j !== lotIndex)
        };
      })
    }));
  };

  const printStagingList = () => {
    const stagingLocationName = locations.find(loc => loc.id === stagingForm.stagingLocation)?.name || 'Unknown';
    const stagingSubLocationName = stagingForm.stagingSubLocation
      ? (subLocationMap[stagingForm.stagingLocation] || []).find(sub => sub.id === stagingForm.stagingSubLocation)?.name
      : null;

    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Staging List</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; font-size: 10pt; padding: 15mm; }
    h1 { font-size: 16pt; margin-bottom: 5mm; color: #333; }
    .info { font-size: 10pt; margin-bottom: 10mm; color: #333; line-height: 1.6; }
    table { width: 100%; border-collapse: collapse; font-size: 9pt; margin-top: 5mm; }
    th { background: #f0f0f0; border: 1px solid #000; padding: 4mm 3mm; text-align: left; font-weight: bold; }
    td { border: 1px solid #000; padding: 3mm; }
    .num { text-align: right; }
    .total-row { background: #f9f9f9; font-weight: bold; }
    @media print {
      body { padding: 0; }
      @page { margin: 15mm; }
    }
  </style>
</head>
<body>
  <h1>Staging List for Production</h1>
  <div class="info">
    <strong>Staging Location:</strong> ${escapeHtml(stagingLocationName)}${stagingSubLocationName ? ` / ${escapeHtml(stagingSubLocationName)}` : ''}<br>
    <strong>Date:</strong> ${formatDateTime(new Date().toISOString())}<br>
    <strong>Prepared By:</strong> ${escapeHtml(user?.name || user?.username) || 'Unknown'}
  </div>
  <table>
    <thead>
      <tr>
        <th style="width: 5%">#</th>
        <th style="width: 25%">Product Name</th>
        <th style="width: 15%">Lot Number</th>
        <th style="width: 12%">Expiration Date</th>
        <th style="width: 18%">Current Location</th>
        <th style="width: 10%" class="num">Quantity</th>
        <th style="width: 15%">Unit</th>
      </tr>
    </thead>
    <tbody>
      ${stagingForm.items.flatMap((item, itemIndex) => {
        const product = productLookup[item.productId];
        const unit = item.unit || 'cases';

        return item.lots.map((lot, lotIndex) => {
          const suggestion = lot.suggestion || item.suggestions?.find(s => s.receipt_id === lot.receiptId);
          const locationText = suggestion
            ? `${escapeHtml(suggestion.location_name) || 'Unknown'}${suggestion.sub_location_name ? ` / ${escapeHtml(suggestion.sub_location_name)}` : ''}`
            : 'Unknown';
          const expirationDate = suggestion?.expiration_date
            ? formatDate(suggestion.expiration_date)
            : '—';

          return `
          <tr>
            <td>${itemIndex + 1}${item.lots.length > 1 ? `-${lotIndex + 1}` : ''}</td>
            <td><strong>${escapeHtml(product?.name) || 'Unknown'}</strong></td>
            <td>${escapeHtml(suggestion?.lot_number) || '—'}</td>
            <td>${expirationDate}</td>
            <td>${locationText}</td>
            <td class="num"><strong>${(lot.quantity || 0).toLocaleString()}</strong></td>
            <td>${escapeHtml(lot.unit || unit)}</td>
          </tr>`;
        });
      }).join('')}
      ${stagingForm.items.map((item) => {
        const product = productLookup[item.productId];
        const unit = item.unit || 'cases';
        const totalForItem = item.lots.reduce((sum, lot) => sum + (lot.quantity || 0), 0);
        return item.lots.length > 1 ? `
          <tr class="total-row" style="background-color: #f0f0f0;">
            <td colspan="5" style="text-align:right"><strong>Subtotal (${escapeHtml(product?.name) || 'Unknown'}):</strong></td>
            <td class="num"><strong>${totalForItem.toLocaleString()}</strong></td>
            <td><strong>${escapeHtml(unit)}</strong></td>
          </tr>` : '';
      }).join('')}
      <tr class="total-row">
        <td colspan="5" style="text-align:right"><strong>Total Items:</strong></td>
        <td class="num"><strong>${stagingForm.items.reduce((sum, item) => sum + item.lots.reduce((lotSum, lot) => lotSum + (lot.quantity || 0), 0), 0).toLocaleString()}</strong></td>
        <td><strong>mixed</strong></td>
      </tr>
    </tbody>
  </table>
  <div style="margin-top: 10mm; font-size: 9pt; color: #666;">
    <p><strong>Instructions:</strong></p>
    <ul style="margin-left: 15mm; margin-top: 2mm;">
      <li>Move all listed items to the staging area</li>
      <li>Verify lot numbers and expiration dates</li>
      <li>Check quantities before staging</li>
      <li>Update inventory system after physical move</li>
    </ul>
  </div>
</body>
</html>`;

    const printWindow = window.open('', '_blank');
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => printWindow.print(), 250);
  };

  const handleStagingSubmit = async (e) => {
    e.preventDefault();

    if (!stagingForm.stagingLocation) {
      setStagingError('Please select a staging location.');
      return;
    }

    if (stagingForm.items.length === 0) {
      setStagingError('Please add at least one product to stage.');
      return;
    }

    for (const item of stagingForm.items) {
      if (!item.lots || item.lots.length === 0) {
        setStagingError('Please select at least one lot for all products.');
        return;
      }

      for (const lot of item.lots) {
        if (!lot.receiptId) {
          setStagingError('Please select a lot for all entries.');
          return;
        }
        if (!lot.quantity || lot.quantity <= 0) {
          setStagingError('Please enter a valid quantity for all lots.');
          return;
        }
      }

      const totalLotQuantity = item.lots.reduce((sum, lot) => sum + (lot.quantity || 0), 0);
      if (Math.abs(totalLotQuantity - item.quantityNeeded) > 0.01) {
        setStagingError(`Total lot quantities must match requested quantity for ${productLookup[item.productId]?.name || 'product'}.`);
        return;
      }
    }

    setIsSubmittingStaging(true);
    setStagingError('');

    try {
      const payload = {
        staging_location_id: stagingForm.stagingLocation,
        staging_sub_location_id: stagingForm.stagingSubLocation || null,
        items: stagingForm.items.map(item => ({
          product_id: item.productId,
          quantity_needed: item.quantityNeeded,
          lots: item.lots.map(lot => ({
            receipt_id: lot.receiptId,
            quantity: lot.quantity
          }))
        }))
      };

      await apiClient.post('/inventory/staging/transfer', payload);

      // Print the staging list before resetting form
      printStagingList();

      // Reset form
      setStagingForm({
        stagingLocation: '',
        stagingSubLocation: '',
        items: []
      });
      setStagingError('');
      addToast('Items staged successfully.', 'success');

      // Refresh receipts data instead of reloading the page
      await refreshReceipts();
    } catch (error) {
      console.error('Error creating staging transfer:', error);
      const msg = error.response?.data?.detail || 'Failed to stage items. Please try again.';
      setStagingError(msg);
      addToast(msg, 'error');
    } finally {
      setIsSubmittingStaging(false);
    }
  };

  return (
    <div className="tab-panel">
      <div className="split">
        <form onSubmit={handleStagingSubmit} className="action-form">
          <h3>Stage Items for Production</h3>

          <label>
            <span>Staging Location <span className="required">*</span></span>
            <select
              value={stagingForm.stagingLocation}
              onChange={(e) => setStagingForm(prev => ({ ...prev, stagingLocation: e.target.value, stagingSubLocation: '' }))}
              required
            >
              <option value="">Select staging location</option>
              {locations.map(loc => (
                <option key={loc.id} value={loc.id}>{loc.name}</option>
              ))}
            </select>
          </label>

          {stagingForm.stagingLocation && (
            <label>
              <span>Staging Sub Location</span>
              <select
                value={stagingForm.stagingSubLocation}
                onChange={(e) => setStagingForm(prev => ({ ...prev, stagingSubLocation: e.target.value }))}
              >
                <option value="">Select sub location (optional)</option>
                {(subLocationMap[stagingForm.stagingLocation] || []).map(sub => (
                  <option key={sub.id} value={sub.id}>{sub.name}</option>
                ))}
              </select>
            </label>
          )}

          <div style={{ marginTop: '1.5rem', padding: '1rem', backgroundColor: '#f5f5f5', borderRadius: '4px' }}>
            <h4 style={{ marginTop: 0 }}>Add Products to Stage</h4>

            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <select
                id="staging-product-select"
                style={{ flex: 1 }}
              >
                <option value="">Select product</option>
                {stagingProducts.map(product => (
                  <option key={product.id} value={product.id}>{product.name}</option>
                ))}
              </select>
              <input
                id="staging-quantity-input"
                type="number"
                placeholder="Quantity"
                min="0.01"
                step="0.01"
                style={{ width: '120px' }}
              />
              <button
                type="button"
                onClick={handleAddStagingProduct}
                className="secondary-button"
              >
                Add
              </button>
            </div>

            {stagingForm.items.length > 0 && (
              <div style={{ marginTop: '1rem' }}>
                <h5>Items to Stage:</h5>
                <table style={{ width: '100%', marginTop: '0.5rem', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                  <colgroup>
                    <col style={{ width: '25%' }} />
                    <col style={{ width: '15%' }} />
                    <col style={{ width: '50%' }} />
                    <col style={{ width: '10%' }} />
                  </colgroup>
                  <thead>
                    <tr style={{ backgroundColor: '#f5f5f5' }}>
                      <th style={{ padding: '0.5rem', border: '1px solid #ddd', textAlign: 'left' }}>Product</th>
                      <th style={{ padding: '0.5rem', border: '1px solid #ddd', textAlign: 'left' }}>Total Needed</th>
                      <th style={{ padding: '0.5rem', border: '1px solid #ddd', textAlign: 'left' }}>Lots</th>
                      <th style={{ padding: '0.5rem', border: '1px solid #ddd', textAlign: 'left' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stagingForm.items.map((item, itemIndex) => {
                      const product = productLookup[item.productId];
                      const unit = item.unit || 'cases';
                      const totalSelected = item.lots.reduce((sum, lot) => sum + (lot.quantity || 0), 0);
                      const remainingNeeded = item.quantityNeeded - totalSelected;
                      const isComplete = remainingNeeded <= 0.01;

                      const totalRows = item.lots.length + (isComplete ? 0 : 1);

                      return (
                        <React.Fragment key={itemIndex}>
                          <tr>
                            <td rowSpan={totalRows} style={{ padding: '0.5rem', border: '1px solid #ddd', verticalAlign: 'top' }}>
                              <strong>{product?.name || 'Unknown'}</strong>
                            </td>
                            <td rowSpan={totalRows} style={{ padding: '0.5rem', border: '1px solid #ddd', verticalAlign: 'top' }}>
                              <strong>{item.quantityNeeded.toLocaleString()} {unit}</strong>
                              {!isComplete && (
                                <div style={{ fontSize: '0.875rem', color: '#d32f2f', marginTop: '0.25rem' }}>
                                  Need: {remainingNeeded.toFixed(2)} {unit}
                                </div>
                              )}
                            </td>
                            <td style={{ padding: '0.5rem', border: '1px solid #ddd' }}>
                              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'nowrap' }}>
                                <select
                                  value={item.lots[0]?.receiptId || ''}
                                  onChange={(e) => {
                                    if (e.target.value) {
                                      handleStagingLotChange(itemIndex, 0, 'receiptId', e.target.value);
                                    }
                                  }}
                                  style={{ flex: 1, padding: '0.25rem', minWidth: '200px' }}
                                >
                                  <option value="">Select lot</option>
                                  {item.suggestions?.map((suggestion, idx) => {
                                    const isSelected = item.lots.some(l => l.receiptId === suggestion.receipt_id && l !== item.lots[0]);
                                    return (
                                      <option key={idx} value={suggestion.receipt_id} disabled={isSelected}>
                                        Lot {suggestion.lot_number} - {suggestion.location_name || 'Unknown'}
                                        {suggestion.expiration_date ? ` (Exp: ${formatDate(suggestion.expiration_date)})` : ''}
                                        - {suggestion.available_quantity} {suggestion.unit || 'cases'}
                                      </option>
                                    );
                                  })}
                                </select>
                                {item.lots[0]?.receiptId && (
                                  <>
                                    <input
                                      type="number"
                                      value={item.lots[0].quantity || ''}
                                      onChange={(e) => handleStagingLotChange(itemIndex, 0, 'quantity', e.target.value)}
                                      min="0.01"
                                      step="0.01"
                                      max={item.lots[0].suggestion?.available_quantity || 999999}
                                      style={{ width: '100px', padding: '0.25rem' }}
                                    />
                                    <span style={{ fontSize: '0.875rem', whiteSpace: 'nowrap' }}>{item.lots[0].unit || unit}</span>
                                    {item.lots.length > 1 && (
                                      <button
                                        type="button"
                                        onClick={() => handleRemoveStagingLot(itemIndex, 0)}
                                        className="secondary-button"
                                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', flexShrink: 0 }}
                                      >
                                        x
                                      </button>
                                    )}
                                  </>
                                )}
                              </div>
                            </td>
                            <td rowSpan={totalRows} style={{ padding: '0.5rem', border: '1px solid #ddd', verticalAlign: 'top' }}>
                              <button
                                type="button"
                                onClick={() => handleRemoveStagingProduct(itemIndex)}
                                className="secondary-button"
                                style={{ padding: '0.25rem 0.5rem', fontSize: '0.875rem' }}
                              >
                                Remove
                              </button>
                            </td>
                          </tr>
                          {item.lots.slice(1).map((lot, lotIndex) => (
                            <tr key={`${itemIndex}-lot-${lotIndex + 1}`}>
                              <td style={{ padding: '0.5rem', border: '1px solid #ddd' }}>
                                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'nowrap' }}>
                                  <select
                                    value={lot.receiptId || ''}
                                    onChange={(e) => handleStagingLotChange(itemIndex, lotIndex + 1, 'receiptId', e.target.value)}
                                    style={{ flex: 1, padding: '0.25rem', minWidth: '200px' }}
                                  >
                                    <option value="">Select lot</option>
                                    {item.suggestions?.map((suggestion, idx) => {
                                      const isSelected = item.lots.some(l => l.receiptId === suggestion.receipt_id && l !== lot);
                                      return (
                                        <option key={idx} value={suggestion.receipt_id} disabled={isSelected}>
                                          Lot {suggestion.lot_number} - {suggestion.location_name || 'Unknown'}
                                          {suggestion.expiration_date ? ` (Exp: ${formatDate(suggestion.expiration_date)})` : ''}
                                          - {suggestion.available_quantity} {suggestion.unit || 'cases'}
                                        </option>
                                      );
                                    })}
                                  </select>
                                  {lot.receiptId && (
                                    <>
                                      <input
                                        type="number"
                                        value={lot.quantity || ''}
                                        onChange={(e) => handleStagingLotChange(itemIndex, lotIndex + 1, 'quantity', e.target.value)}
                                        min="0.01"
                                        step="0.01"
                                        max={lot.suggestion?.available_quantity || 999999}
                                        style={{ width: '100px', padding: '0.25rem' }}
                                      />
                                      <span style={{ fontSize: '0.875rem', whiteSpace: 'nowrap' }}>{lot.unit || unit}</span>
                                    </>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveStagingLot(itemIndex, lotIndex + 1)}
                                    className="secondary-button"
                                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', flexShrink: 0 }}
                                  >
                                    x
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                          {!isComplete && (
                            <tr>
                              <td style={{ padding: '0.5rem', border: '1px solid #ddd' }}>
                                <button
                                  type="button"
                                  onClick={() => handleAddLotToStagingItem(itemIndex)}
                                  className="secondary-button"
                                  style={{ padding: '0.25rem 0.75rem', fontSize: '0.875rem', width: '100%' }}
                                >
                                  + Add Another Lot
                                </button>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {stagingError && (
            <div className="error-message" style={{ marginTop: '1rem' }}>
              {stagingError}
            </div>
          )}

          <div className="form-actions" style={{ marginTop: '1.5rem' }}>
            <button
              type="submit"
              className="primary-button"
              disabled={isSubmittingStaging || stagingForm.items.length === 0}
            >
              {isSubmittingStaging ? 'Staging...' : 'Stage Items'}
            </button>
          </div>
        </form>

        <div className="recent-requests">
          <h3>Staging Overview</h3>
          <p className="muted">View and manage all staged items.</p>
          <button
            onClick={() => navigate(`/${user?.role || 'warehouse'}/staging`)}
            className="primary-button"
            style={{ marginTop: '1rem' }}
          >
            View Staging Overview &rarr;
          </button>
        </div>
      </div>
    </div>
  );
};

export default StagingTab;
