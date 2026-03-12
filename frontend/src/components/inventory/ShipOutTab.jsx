import React, { useMemo, useState } from 'react';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import { useToast } from '../../context/ToastContext';
import SearchableSelect from '../SearchableSelect';
import { formatDate, formatDateTime, escapeHtml } from '../../utils/dateUtils';
import '../InventoryActionsPage.css';
import { CATEGORY_TYPES, RECEIPT_STATUS } from '../../constants';

const ShipOutTab = () => {
  const { addToast } = useToast();
  const { isCorporateUser, selectedWarehouse, selectedWarehouseName } = useAuth();
  const { confirm } = useConfirm();
  const {
    products,
    categories,
    receipts,
    storageAreas,
    fetchPalletLicences,
    createShipOutPickList,
  } = useAppData();

  const [shipOutForm, setShipOutForm] = useState({
    productId: '',
    casesNeeded: '',
    orderNumber: ''
  });
  const [shipOutError, setShipOutError] = useState('');
  const [shipOutLicenceLoadError, setShipOutLicenceLoadError] = useState('');
  const [shipOutPickList, setShipOutPickList] = useState([]);
  const [shipOutLicences, setShipOutLicences] = useState([]);
  const [shipOutSelectedLicenceIds, setShipOutSelectedLicenceIds] = useState([]);
  const [isLoadingLicences, setIsLoadingLicences] = useState(false);
  const [isCreatingPickList, setIsCreatingPickList] = useState(false);

  const approvedReceipts = useMemo(
    () => receipts.filter(receipt => receipt.status === RECEIPT_STATUS.APPROVED),
    [receipts]
  );

  const finishedGoodsProducts = useMemo(() => {
    const productIdsWithStock = new Set(
      approvedReceipts
        .filter(r => r.quantity > 0)
        .map(r => r.productId)
    );
    return products
      .filter(product => {
        const category = categories.find(cat => cat.id === product.categoryId);
        return category?.type === CATEGORY_TYPES.FINISHED && productIdsWithStock.has(product.id);
      })
      .map(product => ({
        value: product.id,
        label: String(product.name || 'Unknown')
      }));
  }, [products, categories, approvedReceipts]);

  const generatePickList = (productId, casesNeeded) => {
    if (!productId || !casesNeeded || casesNeeded <= 0) {
      setShipOutPickList([]);
      return;
    }

    const productReceipts = approvedReceipts
      .filter(r => r.productId === productId && r.quantity > 0)
      .sort((a, b) => {
        const dateA = new Date(a.expiration || '9999-12-31');
        const dateB = new Date(b.expiration || '9999-12-31');
        return dateA - dateB;
      });

    const pickList = [];
    let remainingCases = casesNeeded;

    for (const receipt of productReceipts) {
      if (remainingCases <= 0) break;

      const availableQty = Math.max(0, (Number(receipt.quantity) || 0) - (Number(receipt.heldQuantity) || 0));
      const pickQty = Math.min(availableQty, remainingCases);

      let locationInfo = 'Unknown';
      if (receipt.allocation) {
        let allocation = receipt.allocation;
        if (typeof allocation === 'string') {
          try { allocation = JSON.parse(allocation); } catch { allocation = null; }
        }
        if (allocation?.plan?.length > 0) {
          const areaNames = allocation.plan.map(p => {
            const area = storageAreas.find(a => a.id === p.areaId);
            return `${area?.name || 'Area'}/${p.rowName || 'Row'}`;
          });
          locationInfo = areaNames.length === 1 ? areaNames[0] : `${areaNames[0]} +${areaNames.length - 1} more`;
          if (allocation.floorAllocation?.cases > 0) {
            locationInfo += ', Floor';
          }
        } else if (allocation?.floorAllocation?.cases > 0) {
          locationInfo = 'Floor';
        }
      }

      pickList.push({
        receiptId: receipt.id,
        lotNo: receipt.lotNo || '—',
        expiration: receipt.expiration,
        location: locationInfo,
        available: availableQty,
        pickQty: pickQty
      });

      remainingCases -= pickQty;
    }

    setShipOutPickList(pickList);

    if (remainingCases > 0) {
      setShipOutError(`Insufficient inventory. Short by ${remainingCases.toLocaleString()} cases.`);
    } else {
      setShipOutError('');
    }
  };

  const updateShipOutPickQty = (idx, newQty) => {
    setShipOutPickList(prev => {
      const list = [...prev];
      const item = list[idx];
      if (!item) return prev;
      const qty = Math.max(0, Math.min(Number(newQty) || 0, item.available));
      list[idx] = { ...item, pickQty: qty };
      return list;
    });
    setShipOutError('');
  };

  const loadShipOutLicences = async () => {
    const productId = shipOutForm.productId;
    if (!productId) return;
    setIsLoadingLicences(true);
    setShipOutLicences([]);
    setShipOutSelectedLicenceIds([]);
    setShipOutLicenceLoadError('');
    try {
      const licences = await fetchPalletLicences({ product_id: productId, status: 'in_stock', is_held: false });
      const sorted = (licences || []).sort((a, b) => {
        const dateA = a.expiration_date || a.lot_number || '';
        const dateB = b.expiration_date || b.lot_number || '';
        if (dateA < dateB) return -1;
        if (dateA > dateB) return 1;
        return (a.sequence || 0) - (b.sequence || 0);
      });
      setShipOutLicences(sorted);
      if (!sorted.length) {
        setShipOutLicenceLoadError('No pallet licences in stock for this product. Ensure the product has approved receipts with pallets put away.');
      } else {
        setShipOutLicenceLoadError('');
        const casesNeeded = Number(shipOutForm.casesNeeded) || 0;
        if (casesNeeded > 0 && shipOutPickList.length > 0) {
          const autoSelected = [];
          for (const pickItem of shipOutPickList) {
            if (pickItem.pickQty <= 0) continue;
            const receiptPallets = sorted.filter(l => l.receipt_id === pickItem.receiptId)
              .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
            let remaining = pickItem.pickQty;
            for (const pallet of receiptPallets) {
              if (remaining <= 0) break;
              autoSelected.push(pallet.id);
              remaining -= (pallet.cases || 0);
            }
          }
          setShipOutSelectedLicenceIds(autoSelected);
        }
      }
    } catch (e) {
      console.error(e);
      setShipOutLicenceLoadError('Failed to load pallet licences. Check connection and try again.');
      setShipOutLicences([]);
    } finally {
      setIsLoadingLicences(false);
    }
  };

  const handleCreateLicencePickList = async () => {
    if (!shipOutForm.orderNumber?.trim()) {
      setShipOutError('Order number is required.');
      return;
    }
    if (!shipOutForm.productId) {
      setShipOutError('Please select a product.');
      return;
    }
    const casesNeeded = Number(shipOutForm.casesNeeded) || 0;
    if (casesNeeded <= 0) {
      setShipOutError('Cases needed must be greater than zero.');
      return;
    }
    if (shipOutSelectedLicenceIds.length === 0) {
      setShipOutError('Select at least one pallet to create the pick list.');
      return;
    }
    const first = shipOutLicences.find(l => l.id === shipOutSelectedLicenceIds[0]);
    if (!first?.receipt_id) {
      setShipOutError('Invalid selection');
      return;
    }
    const fromSameReceipt = shipOutSelectedLicenceIds.every(id => {
      const l = shipOutLicences.find(x => x.id === id);
      return l?.receipt_id === first.receipt_id;
    });
    if (!fromSameReceipt) {
      setShipOutError('All selected pallets must be from the same receipt');
      return;
    }

    if (isCorporateUser && selectedWarehouse) {
      const ok = await confirm(`You are about to log this ship-out to "${selectedWarehouseName || 'Selected Warehouse'}". Is this the correct location?`);
      if (!ok) return;
    }

    setIsCreatingPickList(true);
    setShipOutError('');
    try {
      const result = await createShipOutPickList({
        receiptId: first.receipt_id,
        orderNumber: shipOutForm.orderNumber.trim(),
        palletLicenceIds: shipOutSelectedLicenceIds,
      });
      if (result.success) {
        setShipOutSelectedLicenceIds([]);
        setShipOutLicences([]);
        setShipOutError('');
        addToast('Ship-out pick list created. Forklift can now scan pallets.', 'success');
      } else {
        const errorMsg = result.error || 'Failed';
        setShipOutError(errorMsg);
        addToast(errorMsg, 'error');
      }
    } catch (e) {
      const errorMsg = e?.message || 'Failed';
      setShipOutError(errorMsg);
      addToast(errorMsg, 'error');
    } finally {
      setIsCreatingPickList(false);
    }
  };

  const totalPick = shipOutPickList.reduce((sum, item) => sum + item.pickQty, 0);
  const selectedProduct = products.find(p => p.id === shipOutForm.productId);

  const selectedPallets = shipOutSelectedLicenceIds
    .map(id => shipOutLicences.find(l => l.id === id))
    .filter(Boolean);
  const selectedCases = selectedPallets.reduce((s, p) => s + (p.cases || 0), 0);

  const movePallet = (id, direction) => {
    setShipOutSelectedLicenceIds(prev => {
      const arr = [...prev];
      const idx = arr.indexOf(id);
      if (idx < 0) return prev;
      const swapIdx = idx + direction;
      if (swapIdx < 0 || swapIdx >= arr.length) return prev;
      [arr[idx], arr[swapIdx]] = [arr[swapIdx], arr[idx]];
      return arr;
    });
  };

  const removePallet = (id) => {
    setShipOutSelectedLicenceIds(prev => prev.filter(x => x !== id));
  };

  const printPickList = () => {
    const palletRows = selectedPallets.length > 0
      ? selectedPallets.map((pl, i) => `
          <tr>
            <td>${i + 1}</td>
            <td style="font-family:monospace;font-weight:bold">${escapeHtml(pl.licence_number) || '—'}</td>
            <td>${escapeHtml(pl.lot_number) || '—'}</td>
            <td>${escapeHtml(pl.location || pl.storage_row_id) || '—'}</td>
            <td class="num">${pl.cases}</td>
            <td style="width:20mm"></td>
          </tr>
        `).join('')
      : shipOutPickList.map((item, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>—</td>
            <td>${escapeHtml(item.lotNo)}</td>
            <td>${escapeHtml(item.location)}</td>
            <td class="num">${item.pickQty.toLocaleString()}</td>
            <td style="width:20mm"></td>
          </tr>
        `).join('');

    const html = `<!DOCTYPE html>
<html><head>
  <title>Pick List - ${escapeHtml(selectedProduct?.name) || 'Unknown'}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; font-size: 10pt; padding: 15mm; }
    h1 { font-size: 14pt; margin-bottom: 4mm; }
    .info { font-size: 10pt; margin-bottom: 8mm; color: #333; }
    table { width: 100%; border-collapse: collapse; font-size: 9pt; }
    th { background: #f0f0f0; border: 1px solid #000; padding: 3mm; text-align: left; font-weight: bold; }
    td { border: 1px solid #000; padding: 3mm; }
    .num { text-align: right; }
    .total-row { background: #f9f9f9; font-weight: bold; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <h1>Pick List — ${escapeHtml(selectedProduct?.name) || 'Unknown Product'}</h1>
  <div class="info">
    <strong>Order #:</strong> ${escapeHtml(shipOutForm.orderNumber) || '—'} &nbsp;|&nbsp;
    <strong>Date:</strong> ${formatDateTime(new Date().toISOString())} &nbsp;|&nbsp;
    <strong>Cases:</strong> ${(selectedPallets.length > 0 ? selectedCases : totalPick).toLocaleString()} &nbsp;|&nbsp;
    <strong>Pallets:</strong> ${selectedPallets.length > 0 ? selectedPallets.length : shipOutPickList.length}
  </div>
  <table>
    <thead><tr>
      <th>#</th><th>Pallet Licence</th><th>Lot #</th><th>Location</th><th class="num">Cases</th><th>Picked</th>
    </tr></thead>
    <tbody>
      ${palletRows}
      <tr class="total-row">
        <td colspan="4" style="text-align:right">Total:</td>
        <td class="num">${(selectedPallets.length > 0 ? selectedCases : totalPick).toLocaleString()}</td>
        <td></td>
      </tr>
    </tbody>
  </table>
</body></html>`;
    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 250);
  };

  return (
    <div className="tab-panel">
      <div className="split">
        {/* Left: order form */}
        <div className="action-form">
          <h3>Ship Out Order</h3>
          <p className="muted small">Generate a FIFO pick list for finished goods — picks from oldest expiring lots first.</p>

          <label>
            <span>Order Number <span className="required">*</span></span>
            <input
              type="text"
              value={shipOutForm.orderNumber}
              onChange={(e) => setShipOutForm(prev => ({ ...prev, orderNumber: e.target.value }))}
              placeholder="Enter order/reference number"
              required
            />
          </label>

          <label>
            <span>Product <span className="required">*</span></span>
            <SearchableSelect
              options={finishedGoodsProducts}
              value={shipOutForm.productId}
              onChange={(productId) => {
                setShipOutForm(prev => ({ ...prev, productId }));
                setShipOutLicences([]);
                setShipOutSelectedLicenceIds([]);
                generatePickList(productId, Number(shipOutForm.casesNeeded) || 0);
              }}
              placeholder="Select finished goods product"
              searchPlaceholder="Search products..."
            />
          </label>

          <label>
            <span>Cases Needed <span className="required">*</span></span>
            <input
              type="number"
              min="1"
              value={shipOutForm.casesNeeded}
              onChange={(e) => {
                const val = e.target.value;
                setShipOutForm(prev => ({ ...prev, casesNeeded: val }));
                setShipOutLicences([]);
                setShipOutSelectedLicenceIds([]);
                generatePickList(shipOutForm.productId, Number(val) || 0);
              }}
              placeholder="Enter number of cases"
            />
          </label>

          {shipOutError && <div className="alert error">{shipOutError}</div>}
        </div>

        {/* Right: pick list + pallet selection */}
        <div className="action-list">
          <h3>Pick List (FIFO — Oldest First)</h3>
          {shipOutPickList.length > 0 ? (
            <>
              <div className="table-wrapper">
                <table className="report-table">
                  <thead>
                    <tr>
                      <th style={{ width: '28px' }}></th>
                      <th>Lot #</th>
                      <th>Expiration</th>
                      <th>Location</th>
                      <th className="text-right">Available</th>
                      <th className="text-right">Pick Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shipOutPickList.map((item, idx) => (
                      <tr key={idx}>
                        <td style={{ padding: '4px 2px' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                            <button
                              type="button"
                              onClick={() => {
                                if (idx === 0) return;
                                setShipOutPickList(prev => {
                                  const arr = [...prev];
                                  [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
                                  return arr;
                                });
                              }}
                              disabled={idx === 0}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 4px', fontSize: '10px', color: idx === 0 ? '#ddd' : '#666' }}
                              title="Move up"
                            >▲</button>
                            <button
                              type="button"
                              onClick={() => {
                                if (idx === shipOutPickList.length - 1) return;
                                setShipOutPickList(prev => {
                                  const arr = [...prev];
                                  [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
                                  return arr;
                                });
                              }}
                              disabled={idx === shipOutPickList.length - 1}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 4px', fontSize: '10px', color: idx === shipOutPickList.length - 1 ? '#ddd' : '#666' }}
                              title="Move down"
                            >▼</button>
                          </div>
                        </td>
                        <td>{item.lotNo}</td>
                        <td>{formatDate(item.expiration)}</td>
                        <td>{item.location}</td>
                        <td className="text-right">{item.available.toLocaleString()}</td>
                        <td className="text-right">
                          <input
                            type="number"
                            min={0}
                            max={item.available}
                            value={item.pickQty}
                            onChange={(e) => updateShipOutPickQty(idx, e.target.value)}
                            style={{ width: '5rem', textAlign: 'right' }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan="5" className="text-right"><strong>Total:</strong></td>
                      <td className="text-right"><strong>{totalPick.toLocaleString()}</strong></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="form-actions" style={{ marginTop: '0.75rem', gap: '0.5rem' }}>
                <button type="button" className="secondary-button" onClick={printPickList}>
                  Print Pick List
                </button>
              </div>
            </>
          ) : (
            <p className="muted">Select a product and enter cases needed to generate pick list.</p>
          )}

          <hr style={{ margin: '1.5rem 0' }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <div>
              <h3 style={{ margin: 0 }}>Forklift Pick List</h3>
              <p className="muted small" style={{ margin: '4px 0 0' }}>Select pallets for the forklift to scan. Auto-selected based on FIFO.</p>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={loadShipOutLicences}
              disabled={!shipOutForm.productId || isLoadingLicences}
              style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
            >
              {isLoadingLicences ? 'Loading...' : shipOutLicences.length > 0 ? 'Reload' : 'Load pallet licences'}
            </button>
          </div>

          {shipOutLicenceLoadError && (
            <div className="alert error" style={{ marginBottom: '0.75rem' }}>{shipOutLicenceLoadError}</div>
          )}

          {shipOutLicences.length > 0 && (
            <>
              {selectedPallets.length > 0 && (
                <div style={{ marginBottom: '0.75rem' }}>
                  <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '6px', fontWeight: 600 }}>
                    Selected for pick ({selectedPallets.length} pallets &middot; {selectedCases} cases):
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '200px', overflow: 'auto' }}>
                    {selectedPallets.map((pl, i) => (
                      <div
                        key={pl.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '6px 10px',
                          background: '#f0fdf4',
                          border: '1.5px solid #86efac',
                          borderRadius: '8px',
                          fontSize: '13px',
                        }}
                      >
                        <span style={{ color: '#9ca3af', width: '20px', textAlign: 'right', fontSize: '11px', flexShrink: 0 }}>{i + 1}.</span>
                        <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#1e40af', flex: 1 }}>{pl.licence_number}</span>
                        <span style={{ color: '#6b7280', fontSize: '12px' }}>{pl.location || pl.storage_row_id || 'Floor'}</span>
                        <span style={{ color: '#6b7280', fontSize: '12px' }}>&middot; {pl.cases} cs</span>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', marginLeft: '4px' }}>
                          <button
                            type="button"
                            onClick={() => movePallet(pl.id, -1)}
                            disabled={i === 0}
                            style={{ background: 'none', border: 'none', cursor: i === 0 ? 'default' : 'pointer', padding: '0 3px', fontSize: '10px', color: i === 0 ? '#ddd' : '#666', lineHeight: 1 }}
                            title="Move up"
                          >▲</button>
                          <button
                            type="button"
                            onClick={() => movePallet(pl.id, 1)}
                            disabled={i === selectedPallets.length - 1}
                            style={{ background: 'none', border: 'none', cursor: i === selectedPallets.length - 1 ? 'default' : 'pointer', padding: '0 3px', fontSize: '10px', color: i === selectedPallets.length - 1 ? '#ddd' : '#666', lineHeight: 1 }}
                            title="Move down"
                          >▼</button>
                        </div>
                        <button
                          type="button"
                          onClick={() => removePallet(pl.id)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: '0 4px', fontSize: '14px', lineHeight: 1 }}
                          title="Remove"
                        >x</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <details style={{ marginBottom: '0.75rem' }}>
                <summary style={{ cursor: 'pointer', fontSize: '13px', color: '#6b7280', fontWeight: 600, marginBottom: '6px', userSelect: 'none' }}>
                  All available pallets ({shipOutLicences.length}) — click to expand and add
                </summary>
                <div style={{ maxHeight: '180px', overflow: 'auto', paddingTop: '6px' }}>
                  {shipOutLicences.map(pl => {
                    const isSelected = shipOutSelectedLicenceIds.includes(pl.id);
                    return (
                      <label
                        key={pl.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          padding: '5px 8px',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          fontSize: '13px',
                          background: isSelected ? '#f0fdf4' : 'transparent',
                          marginBottom: '2px',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={e => {
                            if (e.target.checked) {
                              setShipOutSelectedLicenceIds(prev => [...prev, pl.id]);
                            } else {
                              setShipOutSelectedLicenceIds(prev => prev.filter(x => x !== pl.id));
                            }
                          }}
                        />
                        <span style={{ fontFamily: 'monospace', fontWeight: 600, color: '#1e40af' }}>{pl.licence_number}</span>
                        <span style={{ color: '#6b7280' }}>{pl.location || pl.storage_row_id || 'Floor'}</span>
                        <span style={{ color: '#6b7280', marginLeft: 'auto' }}>{pl.cases} cases</span>
                        {pl.lot_number && <span style={{ color: '#9ca3af', fontSize: '11px' }}>Lot: {pl.lot_number}</span>}
                      </label>
                    );
                  })}
                </div>
              </details>

              <button
                type="button"
                className="primary-button"
                onClick={handleCreateLicencePickList}
                disabled={
                  !shipOutForm.orderNumber?.trim() ||
                  !shipOutForm.productId ||
                  !(Number(shipOutForm.casesNeeded) > 0) ||
                  shipOutSelectedLicenceIds.length === 0 ||
                  isCreatingPickList
                }
              >
                {isCreatingPickList ? 'Submitting...' : `Submit Ship-out Pick List (${selectedPallets.length} pallets \u00b7 ${selectedCases} cases)`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default ShipOutTab;
