import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { formatDate, formatDateTime, escapeHtml } from '../../utils/dateUtils';
import apiClient from '../../api/client';
import '../InventoryActionsPage.css';
import { CATEGORY_TYPES } from '../../constants';

/**
 * What is available, said in the unit the lot is actually counted in.
 *
 * "40 drums" for a counted lot, "20000 lbs" for a legacy one. The dropdown is
 * where somebody chooses which lot to pull from, so it has to be comparable to
 * what they will see on the rack — a weight is not.
 */
const describeAvailable = (suggestion) => {
  if (suggestion.is_counted) {
    const label = suggestion.unit_label || 'unit';
    const n = suggestion.available_units || 0;
    const held = suggestion.held_units || 0;
    return `${n} ${label}${n === 1 ? '' : 's'}${held ? ` (${held} on hold)` : ''}`;
  }
  return `${suggestion.available_quantity} ${suggestion.unit || 'cases'}`;
};

/**
 * How much of this lot to pull — in whatever the lot is actually counted in.
 *
 * A COUNTED lot asks for containers, because that is what a person carries.
 * The weight is derived and shown beside it, since production schedules in
 * pounds and the number still has to be recognisable to them.
 *
 * There is no pallet input for a counted lot, deliberately. The rack footprint
 * is DERIVED from the container count (see `_project_rows`), so a separate
 * pallet figure would be a second number for the same shelf, free to disagree
 * with the first — and `_stage_free_counted` ignores it anyway. An input whose
 * value is silently discarded is worse than no input.
 *
 * A legacy receipt keeps the old weight-and-pallets entry: it has no container
 * count, so containers is not a question it can answer.
 */
const LotAmountInputs = ({ lot, unit, onChange }) => {
  const suggestion = lot.suggestion;

  if (suggestion?.is_counted) {
    const label = suggestion.unit_label || 'unit';
    const per = Number(suggestion.weight_per_container) || 0;
    const units = Number(lot.units) || 0;
    return (
      <>
        <input
          type="number"
          value={lot.units ?? ''}
          onChange={(e) => onChange('units', e.target.value)}
          min="0"
          step="1"
          max={suggestion.available_units || 0}
          title={`How many ${label}s to pull`}
          style={{ width: '80px', padding: '0.25rem' }}
        />
        <span style={{ fontSize: '0.875rem', whiteSpace: 'nowrap' }}>
          {label}{units === 1 ? '' : 's'}
          {per > 0 && (
            <span style={{ color: '#6b7280' }}>
              {' '}= {(units * per).toLocaleString()} {suggestion.weight_unit || 'lbs'}
            </span>
          )}
        </span>
      </>
    );
  }

  return (
    <>
      <input
        type="number"
        value={lot.quantity || ''}
        onChange={(e) => onChange('quantity', e.target.value)}
        min="0.01"
        step="0.01"
        max={suggestion?.available_quantity || 999999}
        style={{ width: '100px', padding: '0.25rem' }}
      />
      <span style={{ fontSize: '0.875rem', whiteSpace: 'nowrap' }}>{lot.unit || unit}</span>
      <input
        type="number"
        value={lot.pallets ?? ''}
        onChange={(e) => onChange('pallets', e.target.value)}
        min="0"
        step="1"
        placeholder="pallets"
        title="Pallets emptied from the rack"
        style={{ width: '80px', padding: '0.25rem' }}
      />
    </>
  );
};

/**
 * Which racks to walk to, and what to take off each.
 *
 * The whole point of counting containers rather than smearing a weight across
 * every rack proportionally: this can be printed on a pull ticket and checked
 * against the shelf.
 */
const PullPlan = ({ lot, plan }) => {
  const suggestion = lot?.suggestion;
  if (!suggestion?.is_counted) return null;

  const label = suggestion.unit_label || 'unit';
  const held = suggestion.held_units || 0;

  return (
    <div style={{ marginTop: '0.35rem', fontSize: '0.8rem' }}>
      {plan.length > 0 ? (
        <span style={{ color: '#166534' }}>
          Take{' '}
          {plan.map((rack, i) => (
            <span key={rack.storage_row_id}>
              {i > 0 ? ', ' : ''}
              <strong>{rack.take}</strong> from <strong>{rack.storage_row_name}</strong>
            </span>
          ))}
        </span>
      ) : (
        <span style={{ color: '#6b7280' }}>
          {suggestion.available_units} {label}
          {suggestion.available_units === 1 ? '' : 's'} across{' '}
          {(suggestion.racks || []).map(r => r.storage_row_name).join(', ') || 'no rack'}
        </span>
      )}
      {/* Quarantined containers are on the rack but cannot be pulled. Saying so
          here stops somebody counting forty on the shelf and concluding the
          system is wrong. */}
      {held > 0 && (
        <span style={{ color: '#b45309' }}> · {held} on hold, not pickable</span>
      )}
    </div>
  );
};

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

              // A counted lot is pulled in whole containers, so seed the
              // container count and derive the weight from it — not the other
              // way round. Rounded UP: 600 lbs of a 500 lb drum is two drums off
              // the rack, and the remainder comes back as a partial.
              if (suggestion.is_counted) {
                const per = Number(suggestion.weight_per_container) || 0;
                const wanted = per > 0 ? Math.ceil(newQuantity / per) : 0;
                const units = Math.min(wanted, suggestion.available_units || 0);
                return {
                  ...lot,
                  receiptId: value,
                  suggestion,
                  units,
                  quantity: units * per,
                  unit: suggestion.unit || item.unit || 'cases',
                };
              }

              return {
                ...lot,
                receiptId: value,
                suggestion: suggestion,
                quantity: newQuantity,
                unit: suggestion.unit || item.unit || 'cases'
              };
            } else if (field === 'units') {
              // Containers in, weight derived. The API still carries weight —
              // production schedules in pounds — but the number a person types
              // is the number of things they will carry.
              const suggestion = lot.suggestion;
              const per = Number(suggestion?.weight_per_container) || 0;
              const max = suggestion?.available_units || 0;
              const units = Math.min(Math.max(0, Math.round(Number(value) || 0)), max);
              return { ...lot, units, quantity: units * per };
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

  /**
   * Which racks a pull of `units` containers will actually come off.
   *
   * MIRRORS `lot_placement_service.take_units`: fullest rack first, because
   * that produces an instruction somebody can follow — "two off ROW 3" — and
   * empties racks rather than leaving ones and twos scattered across the barn.
   *
   * Shown, not sent. The server recomputes it from the placements as they are
   * at approval time, which is the only moment that can be authoritative — a
   * drum may move between now and then. If the two ever disagree the server
   * wins and the pull ticket is regenerated.
   */
  const pullPlan = (suggestion, units) => {
    if (!suggestion?.is_counted || !units) return [];
    const racks = [...(suggestion.racks || [])]
      .filter(r => r.available_units > 0)
      .sort((a, b) => b.available_units - a.available_units);
    const plan = [];
    let left = units;
    for (const rack of racks) {
      if (left <= 0) break;
      const take = Math.min(rack.available_units, left);
      plan.push({ ...rack, take });
      left -= take;
    }
    return plan;
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
        <th style="width: 18%">Pick from</th>
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

          // For a counted lot the ticket names the RACKS and a container count,
          // because that is what the person holding this piece of paper has to
          // do: walk to ROW 3 and pick up two drums. A weight and a room name
          // cannot be checked against a shelf.
          const counted = suggestion?.is_counted;
          const plan = counted ? pullPlan(suggestion, lot.units) : [];
          const whereText = plan.length
            ? plan.map(r => `${escapeHtml(r.storage_row_name)} × ${r.take}`).join(', ')
            : locationText;
          const amount = counted
            ? (lot.units || 0)
            : (lot.quantity || 0);
          const amountUnit = counted
            ? `${escapeHtml(suggestion.unit_label || 'unit')}s`
            : escapeHtml(lot.unit || unit);

          return `
          <tr>
            <td>${itemIndex + 1}${item.lots.length > 1 ? `-${lotIndex + 1}` : ''}</td>
            <td><strong>${escapeHtml(product?.name) || 'Unknown'}</strong></td>
            <td>${escapeHtml(suggestion?.lot_number) || '—'}</td>
            <td>${expirationDate}</td>
            <td>${whereText}</td>
            <td class="num"><strong>${amount.toLocaleString()}</strong></td>
            <td>${amountUnit}</td>
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
            quantity: lot.quantity,
            // Pallets emptied from the rack (optional). Blank → backend estimates
            // proportionally from the lot's real pallets.
            pallets: (lot.pallets === '' || lot.pallets === undefined || lot.pallets === null)
              ? null : Number(lot.pallets),
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
                                        - {describeAvailable(suggestion)}
                                      </option>
                                    );
                                  })}
                                </select>
                                {item.lots[0]?.receiptId && (
                                  <>
                                    <LotAmountInputs
                                      lot={item.lots[0]}
                                      unit={unit}
                                      onChange={(field, value) =>
                                        handleStagingLotChange(itemIndex, 0, field, value)}
                                    />
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
                              <PullPlan lot={item.lots[0]} plan={pullPlan(item.lots[0]?.suggestion, item.lots[0]?.units)} />
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
                                          - {describeAvailable(suggestion)}
                                        </option>
                                      );
                                    })}
                                  </select>
                                  {lot.receiptId && (
                                    <LotAmountInputs
                                      lot={lot}
                                      unit={unit}
                                      onChange={(field, value) =>
                                        handleStagingLotChange(itemIndex, lotIndex + 1, field, value)}
                                    />
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
                                <PullPlan lot={lot} plan={pullPlan(lot.suggestion, lot.units)} />
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
