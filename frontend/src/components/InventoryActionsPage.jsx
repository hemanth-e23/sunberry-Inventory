import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../context/AppDataContext';
import { useAuth } from '../context/AuthContext';
import { getDashboardPath } from '../App';
import SearchableSelect from './SearchableSelect';
import axios from 'axios';
import './InventoryActionsPage.css';
import './InventoryActionsPageEnhanced.css';

const API_BASE_URL = '/api';

const TAB_OPTIONS = ['transfers', 'staging', 'holds', 'adjustments', 'shipout'];

const InventoryActionsPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const {
    products,
    categories,
    categoryGroups,
    productCategories,
    receipts,
    locations,
    subLocationMap,
    storageAreas,
    users,
    inventoryTransfers,
    submitTransfer,
    inventoryHoldActions,
    submitHoldAction,
    approveHoldAction,
    rejectHoldAction,
    inventoryAdjustments,
    submitAdjustment
  } = useAppData();

  const [activeTab, setActiveTab] = useState('transfers');

  const [transferForm, setTransferForm] = useState({
    categoryGroupId: '',
    receiptId: '',
    quantity: '',
    fromLocation: '',
    fromSubLocation: '',
    toLocation: '',
    toSubLocation: '',
    reason: '',
    availableQuantity: 0,
    transferType: 'warehouse-transfer', // 'warehouse-transfer' or 'shipped-out'
    orderNumber: ''
  });
  // Advanced toggle: allow cross-warehouse or destinations without FG storage/capacity
  const [showAllDestinations, setShowAllDestinations] = useState(false);
  const [transferError, setTransferError] = useState('');
  const [isSubmittingTransfer, setIsSubmittingTransfer] = useState(false);
  const [isSubmittingHold, setIsSubmittingHold] = useState(false);
  const [isSubmittingAdjust, setIsSubmittingAdjust] = useState(false);
  // Available sources (rows/floor for FGs, or current sub-location for others) and user selection
  const [availableSources, setAvailableSources] = useState([]); // [{id,label,available,type}]
  const [sourceSelections, setSourceSelections] = useState({}); // id -> cases chosen
  // Destination distribution for FG
  const [destSelections, setDestSelections] = useState({});
  const [destRowSearch, setDestRowSearch] = useState('');  // Search filter for destination rows

  const [holdForm, setHoldForm] = useState({
    productId: '',
    receiptId: '',
    action: 'hold',
    reason: ''
  });
  const [holdError, setHoldError] = useState('');
  const [holdLocations, setHoldLocations] = useState([]); // Available locations for selected product
  const [holdSelections, setHoldSelections] = useState({}); // location id -> quantity to hold

  const [adjustForm, setAdjustForm] = useState({
    categoryGroupId: '',
    categoryId: '',
    productId: '',
    receiptId: '',
    adjustmentType: 'stock-correction',
    quantity: '',
    reason: '',
    recipient: '',
    fromLocation: '',
    fromSubLocation: '',
    availableQuantity: 0
  });
  const [adjustError, setAdjustError] = useState('');

  // Source selections for adjustments (similar to transfers)
  const [adjustSourceSelections, setAdjustSourceSelections] = useState({});
  const [adjustAvailableSources, setAdjustAvailableSources] = useState([]);

  // Ship Out form state (FIFO pick list generator)
  const [shipOutForm, setShipOutForm] = useState({
    productId: '',
    casesNeeded: '',
    orderNumber: ''
  });
  const [shipOutError, setShipOutError] = useState('');
  const [shipOutPickList, setShipOutPickList] = useState([]);

  // Staging form state
  const [stagingForm, setStagingForm] = useState({
    stagingLocation: '',
    stagingSubLocation: '',
    items: [] // Array of {productId, quantityNeeded, lots: [{receiptId, quantity, unit, suggestion}], unit, suggestions}
  });
  const [stagingError, setStagingError] = useState('');
  const [isSubmittingStaging, setIsSubmittingStaging] = useState(false);
  const [stagingSuggestions, setStagingSuggestions] = useState({}); // productId -> suggestions

  const approvedReceipts = useMemo(
    () => receipts.filter(receipt => receipt.status === 'approved'),
    [receipts]
  );
  const trackedReceipts = useMemo(
    () => receipts.filter(receipt => ['approved', 'recorded', 'reviewed'].includes(receipt.status)),
    [receipts]
  );
  const allReceipts = useMemo(
    () => receipts.filter(receipt => ['approved', 'recorded', 'reviewed'].includes(receipt.status)),
    [receipts]
  );

  const productLookup = useMemo(() => {
    const map = {};
    products.forEach(product => {
      map[product.id] = product;
    });
    return map;
  }, [products]);

  const categoryLookup = useMemo(() => {
    const map = {};
    categories.forEach(category => {
      map[category.id] = category;
    });
    return map;
  }, [categories]);

  const userLookup = useMemo(() => {
    const map = {};
    users.forEach(user => {
      const label = user.name || user.username;
      map[user.id] = label;
      map[user.username] = label;
    });
    return map;
  }, [users]);

  const formatReceiptLabel = (receipt) => {
    const product = productLookup[receipt.productId];
    const category = categoryLookup[receipt.categoryId];
    return `${String(product?.name || 'Unknown')} · Lot ${String(receipt.lotNo || '-')} · ${String(category?.name || '')}`;
  };

  const receiptsWithHold = useMemo(() => {
    const map = {};
    receipts.forEach(receipt => {
      if (receipt.hold) {
        map[receipt.id] = true;
      }
    });
    return map;
  }, [receipts]);

  // Compute destination options for finished goods transfers
  const destOptions = useMemo(() => {
    if (transferForm.categoryGroupId !== 'group-finished' || !transferForm.toLocation) return [];

    const areasForLocation = storageAreas.filter(area => area.locationId === transferForm.toLocation);
    const options = [];

    // Add each individual row as an option
    areasForLocation.forEach(area => {
      if (area.rows && area.rows.length > 0) {
        area.rows.forEach(row => {
          const rowCapacity = (row.palletCapacity || 0) * (row.defaultCasesPerPallet || 0);
          const occupiedCases = row.occupiedCases || 0;
          const availableCapacity = Math.max(0, rowCapacity - occupiedCases);
          options.push({
            id: `row-${row.id}`,
            label: `${area.name} / ${row.name}`,
            available: availableCapacity,
            totalCapacity: rowCapacity,
            occupied: occupiedCases,
            type: 'rack-row',
            rowId: row.id,
            areaId: area.id,
          });
        });
      }
    });

    // Add floor staging option if available
    const hasFloor = areasForLocation.some(a => a.allowFloorStorage);
    if (hasFloor) {
      options.push({ id: 'floor', label: 'Floor staging', available: Number.MAX_SAFE_INTEGER, type: 'floor' });
    }

    return options;
  }, [transferForm.categoryGroupId, transferForm.toLocation, storageAreas]);

  // Finished goods products for Ship Out dropdown
  const finishedGoodsProducts = useMemo(() => {
    return products.filter(product => {
      const category = categories.find(cat => cat.id === product.categoryId);
      return category?.type === 'finished';
    }).map(product => ({
      value: product.id,
      label: String(product.name || 'Unknown')
    }));
  }, [products, categories]);

  // Generate FIFO pick list based on expiration date
  const generatePickList = (productId, casesNeeded) => {
    if (!productId || !casesNeeded || casesNeeded <= 0) {
      setShipOutPickList([]);
      return;
    }

    // Get all approved receipts for this product, sorted by expiration date (oldest first)
    const productReceipts = approvedReceipts
      .filter(r => r.productId === productId && r.quantity > 0)
      .sort((a, b) => {
        const dateA = new Date(a.expiration || '9999-12-31');
        const dateB = new Date(b.expiration || '9999-12-31');
        return dateA - dateB; // Oldest first (FIFO)
      });

    const pickList = [];
    let remainingCases = casesNeeded;

    for (const receipt of productReceipts) {
      if (remainingCases <= 0) break;

      const availableQty = Number(receipt.quantity) || 0;
      const pickQty = Math.min(availableQty, remainingCases);

      // Get location info from allocation
      let locationInfo = 'Unknown';
      if (receipt.allocation) {
        let allocation = receipt.allocation;
        if (typeof allocation === 'string') {
          try { allocation = JSON.parse(allocation); } catch (e) { allocation = null; }
        }
        if (allocation?.plan?.length > 0) {
          const areaNames = allocation.plan.map(p => {
            const area = storageAreas.find(a => a.id === p.areaId);
            return `${area?.name || 'Area'}/${p.rowName || 'Row'}`;
          });
          locationInfo = areaNames.join(', ');
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

  // Build available locations for hold selection
  const buildHoldLocations = (productId) => {
    if (!productId) {
      setHoldLocations([]);
      setHoldSelections({});
      return;
    }

    // Get all approved receipts for this product
    const productReceipts = approvedReceipts.filter(r => r.productId === productId && r.quantity > 0);
    const locations = [];

    productReceipts.forEach(receipt => {
      let allocation = receipt.allocation;
      if (allocation && typeof allocation === 'string') {
        try { allocation = JSON.parse(allocation); } catch (e) { allocation = null; }
      }

      if (allocation?.plan && Array.isArray(allocation.plan) && allocation.plan.length > 0) {
        // Calculate scale factor for current quantity
        const originalPlanTotal = allocation.plan.reduce((sum, p) => sum + (Number(p.cases) || 0), 0);
        const originalFloorCases = Number(allocation?.floorAllocation?.cases || 0);
        const originalTotal = originalPlanTotal + originalFloorCases;
        const currentTotal = Number(receipt.quantity || 0);
        const scaleFactor = originalTotal > 0 ? currentTotal / originalTotal : 0;

        allocation.plan.forEach((p) => {
          const area = storageAreas.find(a => a.id === p.areaId);
          const scaledCases = Math.round((Number(p.cases) || 0) * scaleFactor);
          if (scaledCases > 0) {
            locations.push({
              id: `${receipt.id}-row-${p.rowId}`,
              receiptId: receipt.id,
              lotNo: receipt.lotNo || '—',
              expiration: receipt.expiration,
              location: `${String(area?.name || 'Area')} / ${String(p.rowName || 'Row')}`,
              available: scaledCases,
              type: 'rack'
            });
          }
        });

        const scaledFloorCases = Math.round(originalFloorCases * scaleFactor);
        if (scaledFloorCases > 0) {
          locations.push({
            id: `${receipt.id}-floor`,
            receiptId: receipt.id,
            lotNo: receipt.lotNo || '—',
            expiration: receipt.expiration,
            location: 'Floor staging',
            available: scaledFloorCases,
            type: 'floor'
          });
        }
      } else {
        // No allocation - use receipt as single source
        locations.push({
          id: `${receipt.id}-all`,
          receiptId: receipt.id,
          lotNo: receipt.lotNo || '—',
          expiration: receipt.expiration,
          location: 'Unknown location',
          available: Number(receipt.quantity || 0),
          type: 'standard'
        });
      }
    });

    // Sort by expiration date (oldest first)
    locations.sort((a, b) => {
      const dateA = new Date(a.expiration || '9999-12-31');
      const dateB = new Date(b.expiration || '9999-12-31');
      return dateA - dateB;
    });

    setHoldLocations(locations);
    setHoldSelections({});
  };

  const handleTransferSubmit = async (event) => {
    event.preventDefault();
    // toLocation is only required for warehouse transfers, not shipped-out
    if (!transferForm.receiptId) return;
    if (transferForm.transferType !== 'shipped-out' && !transferForm.toLocation) return;
    if (!transferForm.quantity || Number(transferForm.quantity) <= 0) {
      setTransferError('Quantity is required to update inventory.');
      return;
    }
    if (Number(transferForm.quantity) > Number(transferForm.availableQuantity || 0)) {
      setTransferError(`Quantity cannot exceed available on the lot (${Number(transferForm.availableQuantity || 0).toLocaleString()}).`);
      return;
    }
    // Ensure selected sources match requested quantity for all categories
    const requested = Number(transferForm.quantity) || 0;
    let picked = Object.values(sourceSelections).reduce((sum, v) => sum + (Number(v) || 0), 0);

    // If no sources are selected but quantity matches total available, auto-select all sources
    if (picked === 0 && requested > 0 && availableSources.length > 0) {
      const totalAvailable = availableSources.reduce((sum, src) => sum + src.available, 0);
      if (Math.abs(requested - totalAvailable) < 0.01) {
        // Full shipment - auto-select all sources
        const autoSelections = {};
        availableSources.forEach(src => {
          autoSelections[src.id] = src.available.toString();
        });
        setSourceSelections(autoSelections);
        picked = totalAvailable; // Update picked value for validation
      }
    }

    if (Math.abs(picked - requested) > 0.01) {
      setTransferError(`Selection must equal requested quantity. Picked ${picked.toLocaleString()} of ${requested.toLocaleString()}.`);
      return;
    }
    // Per-source capacity check
    for (const src of availableSources) {
      const qty = Number(sourceSelections[src.id] || 0);
      if (qty > src.available) {
        setTransferError(`Source ${src.label} exceeds available (${src.available.toLocaleString()}).`);
        return;
      }
    }
    // Ensure destination distribution also matches (only for warehouse transfers, not shipped-out)
    if (transferForm.categoryGroupId === 'group-finished' && transferForm.transferType !== 'shipped-out') {
      const destPicked = Object.values(destSelections).reduce((sum, v) => sum + (Number(v) || 0), 0);
      if (destPicked !== requested) {
        setTransferError(`Destination must equal requested quantity. Allocated ${destPicked.toLocaleString()} of ${requested.toLocaleString()}.`);
        return;
      }
      // Validate capacities
      for (const option of destOptions) {
        const qty = Number(destSelections[option.id] || 0);
        if (option.type !== 'floor' && qty > option.available) {
          setTransferError(`Destination ${option.label} exceeds available capacity (${option.available.toLocaleString()}).`);
          return;
        }
      }
    } else {
      // Raw/Packaging must specify concrete destination sub-location (only for warehouse transfers)
      if (transferForm.transferType !== 'shipped-out' && !transferForm.toSubLocation) {
        setTransferError('Choose a destination sub location.');
        return;
      }
    }
    // Validate order number for shipped-out transfers
    if (transferForm.transferType === 'shipped-out' && !transferForm.orderNumber.trim()) {
      setTransferError('Order number is required for shipped-out transfers.');
      return;
    }

    const payload = {
      receiptId: transferForm.receiptId,
      quantity: Number(transferForm.quantity) || null,
      fromLocation: transferForm.fromLocation || null,
      fromSubLocation: transferForm.fromSubLocation || null,
      toLocation: transferForm.transferType === 'shipped-out' ? null : transferForm.toLocation,
      toSubLocation: transferForm.transferType === 'shipped-out' ? null : (transferForm.toSubLocation || null),
      reason: transferForm.reason.trim(),
      transferType: transferForm.transferType,
      orderNumber: transferForm.transferType === 'shipped-out' ? transferForm.orderNumber.trim() : null,
      sourceBreakdown: Object.entries(sourceSelections)
        .filter(([, qty]) => Number(qty) > 0)
        .map(([id, qty]) => ({ id, quantity: Number(qty) })),
      destinationBreakdown: transferForm.categoryGroupId === 'group-finished'
        ? Object.entries(destSelections)
          .filter(([, qty]) => Number(qty) > 0)
          .map(([id, qty]) => ({ id, quantity: Number(qty) }))
        : undefined,
    };
    setIsSubmittingTransfer(true);
    try {
      const result = await submitTransfer(payload);
      if (result.success) {
        setTransferForm({
          categoryGroupId: '',
          receiptId: '',
          quantity: '',
          fromLocation: '',
          fromSubLocation: '',
          toLocation: '',
          toSubLocation: '',
          reason: '',
          availableQuantity: 0,
          transferType: 'warehouse-transfer',
          orderNumber: ''
        });
        setTransferError('');
      } else {
        setTransferError(result.message || result.error || 'Failed to submit transfer');
      }
    } catch (error) {
      console.error('Error submitting transfer:', error);
      setTransferError('An unexpected error occurred while submitting the transfer.');
    } finally {
      setIsSubmittingTransfer(false);
    }
  };

  const handleHoldSubmit = async (event) => {
    event.preventDefault();

    // Calculate total hold quantity from selections
    const totalHoldQty = Object.values(holdSelections).reduce((sum, v) => sum + (Number(v) || 0), 0);

    // Validate - either use new partial hold or legacy full-lot hold
    if (holdForm.productId && holdLocations.length > 0) {
      // New partial hold mode
      if (totalHoldQty === 0) {
        setHoldError('Please enter quantities to hold for at least one location.');
        return;
      }
      if (!holdForm.reason.trim()) {
        setHoldError('Please provide a reason for the hold.');
        return;
      }

      // Validate each selection doesn't exceed available
      for (const loc of holdLocations) {
        const holdQty = Number(holdSelections[loc.id] || 0);
        if (holdQty > loc.available) {
          setHoldError(`Hold quantity for ${loc.location} exceeds available (${loc.available}).`);
          return;
        }
      }

      // Build hold items from selections
      const holdItems = holdLocations
        .filter(loc => Number(holdSelections[loc.id] || 0) > 0)
        .map(loc => ({
          receiptId: loc.receiptId,
          locationId: loc.id,
          location: loc.location,
          lotNo: loc.lotNo,
          quantity: Number(holdSelections[loc.id])
        }));

      const payload = {
        productId: holdForm.productId,
        action: holdForm.action,
        reason: holdForm.reason.trim(),
        submittedBy: user?.id || user?.username || 'warehouse-user',
        holdItems: holdItems,
        totalQuantity: totalHoldQty
      };

      setIsSubmittingHold(true);
      const result = await submitHoldAction(payload);
      setIsSubmittingHold(false);
      if (result.success) {
        setHoldForm({ productId: '', receiptId: '', action: 'hold', reason: '' });
        setHoldLocations([]);
        setHoldSelections({});
        setHoldError('');
      } else {
        const errorMsg = typeof result.error === 'object' ? JSON.stringify(result.error) : (result.error || 'Failed to submit hold request.');
        setHoldError(errorMsg);
      }
    } else if (holdForm.receiptId) {
      // Legacy full-lot hold mode
      if (!holdForm.reason.trim()) {
        setHoldError('Please select an inventory lot and provide a reason.');
        return;
      }

      const selectedReceipt = receipts.find(r => r.id === holdForm.receiptId);
      if (!selectedReceipt) {
        setHoldError('Selected receipt not found.');
        return;
      }

      const pendingHoldAction = inventoryHoldActions.find(
        action => action.receiptId === holdForm.receiptId && action.status === 'pending'
      );

      if (pendingHoldAction) {
        setHoldError(`This lot already has a pending ${pendingHoldAction.action} request.`);
        return;
      }

      if (holdForm.action === 'hold' && selectedReceipt.hold) {
        setHoldError('This lot is already on hold.');
        return;
      }
      if (holdForm.action === 'release' && !selectedReceipt.hold) {
        setHoldError('This lot is not currently on hold.');
        return;
      }

      const payload = {
        receiptId: holdForm.receiptId,
        action: holdForm.action,
        reason: holdForm.reason.trim(),
        submittedBy: user?.id || user?.username || 'warehouse-user'
      };
      setIsSubmittingHold(true);
      const result = await submitHoldAction(payload);
      setIsSubmittingHold(false);
      if (result.success) {
        setHoldForm({ productId: '', receiptId: '', action: 'hold', reason: '' });
        setHoldError('');
      } else {
        const errorMsg = typeof result.error === 'object' ? JSON.stringify(result.error) : (result.error || 'Failed to submit hold request.');
        setHoldError(errorMsg);
      }
    } else {
      setHoldError('Please select a product or an inventory lot.');
    }
  };

  const handleAdjustSubmit = async (event) => {
    event.preventDefault();
    if (!adjustForm.productId || !adjustForm.reason.trim()) {
      setAdjustError('Please select a product and provide a reason.');
      return;
    }
    if (!adjustForm.receiptId) {
      setAdjustError('Please select an inventory lot.');
      return;
    }
    if (!adjustForm.quantity || adjustForm.quantity <= 0) {
      setAdjustError('Please enter a valid quantity.');
      return;
    }

    const payload = {
      categoryId: adjustForm.categoryId,
      productId: adjustForm.productId,
      receiptId: adjustForm.receiptId,
      adjustmentType: adjustForm.adjustmentType,
      quantity: Number(adjustForm.quantity),
      reason: adjustForm.reason.trim(),
      recipient: adjustForm.recipient.trim() || null
    };
    setIsSubmittingAdjust(true);
    const result = await submitAdjustment(payload);
    setIsSubmittingAdjust(false);
    if (result.success) {
      setAdjustForm({
        productId: '',
        categoryId: '',
        receiptId: '',
        adjustmentType: 'stock-correction',
        quantity: '',
        reason: '',
        recipient: ''
      });
      setAdjustSourceSelections({});
      setAdjustAvailableSources([]);
      setAdjustError('');
    } else {
      setAdjustError(result.error || 'Failed to submit adjustment.');
    }
  };

  const renderTransfersTab = () => (
    <div className="tab-panel">
      <div className="split">
        <form onSubmit={handleTransferSubmit} className="action-form">
          <h3>{transferForm.transferType === 'shipped-out' ? 'Ship Out Inventory' : 'Request Warehouse Transfer'}</h3>

          <label>
            <span>Transfer Type</span>
            <select
              value={transferForm.transferType}
              onChange={(e) => {
                setTransferForm(prev => ({
                  ...prev,
                  transferType: e.target.value,
                  orderNumber: '',
                  toLocation: '',
                  toSubLocation: ''
                }));
              }}
              required
            >
              <option value="warehouse-transfer">Warehouse Transfer</option>
              <option value="shipped-out">Shipped Out</option>
            </select>
          </label>

          {transferForm.transferType === 'shipped-out' && (
            <label>
              <span>Order Number <span className="required">*</span></span>
              <input
                type="text"
                value={transferForm.orderNumber}
                onChange={(e) => setTransferForm(prev => ({ ...prev, orderNumber: e.target.value }))}
                placeholder="Enter order number"
                required
              />
            </label>
          )}

          <label>
            <span>Item Category</span>
            <select
              value={transferForm.categoryGroupId}
              onChange={(e) => {
                const categoryGroupId = e.target.value;
                setTransferForm(prev => ({
                  ...prev,
                  categoryGroupId,
                  receiptId: '',
                  fromLocation: '',
                  fromSubLocation: '',
                  availableQuantity: 0
                }));
              }}
              required
            >
              <option value="">Select category</option>
              <option value="group-raw">Raw Materials</option>
              <option value="group-packaging">Packaging Materials</option>
              <option value="group-finished">Finished Goods</option>
            </select>
          </label>

          {transferForm.categoryGroupId && (
            <label>
              <span>Inventory Lot</span>
              <SearchableSelect
                options={approvedReceipts
                  .filter(receipt => {
                    const category = categories.find(cat => cat.id === receipt.categoryId);
                    if (!category) return false;

                    switch (transferForm.categoryGroupId) {
                      case 'group-raw':
                        return category.parentId === 'group-raw';
                      case 'group-packaging':
                        return category.parentId === 'group-packaging';
                      case 'group-finished':
                        return category.parentId === 'group-finished';
                      default:
                        return false;
                    }
                  })
                  .map(receipt => ({
                    value: receipt.id,
                    label: formatReceiptLabel(receipt)
                  }))}
                value={transferForm.receiptId}
                onChange={(receiptId) => {
                  const selectedReceipt = approvedReceipts.find(r => r.id === receiptId);
                  // Do not preset from fields; quantity applies to the whole lot (rack + floor)
                  // Build source list for the selected category
                  const sources = [];
                  const category = categories.find(cat => cat.id === selectedReceipt?.categoryId);
                  let allocationData = null;

                  if (category?.type === 'finished') {
                    // Parse allocation if it's a string
                    allocationData = selectedReceipt?.allocation;
                    if (allocationData && typeof allocationData === 'string') {
                      try {
                        allocationData = JSON.parse(allocationData);
                      } catch (e) {
                        console.error('Error parsing allocation:', e);
                        allocationData = null;
                      }
                    }

                    // If allocation data exists, use it to build sources
                    // IMPORTANT: Allocation stores original case counts, but receipt.quantity is updated
                    // on transfers. We need to scale allocation proportionally.
                    if (allocationData?.plan && Array.isArray(allocationData.plan) && allocationData.plan.length > 0) {
                      // Calculate original total from allocation
                      const originalPlanTotal = allocationData.plan.reduce((sum, p) => sum + (Number(p.cases) || 0), 0);
                      const originalFloorCases = Number(allocationData?.floorAllocation?.cases || 0);
                      const originalTotal = originalPlanTotal + originalFloorCases;
                      const currentTotal = Number(selectedReceipt?.quantity || 0);

                      // Scale factor to convert original allocation to current inventory
                      const scaleFactor = originalTotal > 0 ? currentTotal / originalTotal : 0;

                      allocationData.plan.forEach((p) => {
                        const area = storageAreas.find(a => a.id === p.areaId);
                        const scaledCases = Math.round((Number(p.cases) || 0) * scaleFactor);
                        if (scaledCases > 0) {
                          sources.push({
                            id: `row-${p.rowId}`,
                            label: `${area?.name || 'Area'} / ${p.rowName || 'Row'}`,
                            available: scaledCases,
                            type: 'rack',
                          });
                        }
                      });
                      const scaledFloorCases = Math.round(originalFloorCases * scaleFactor);
                      if (scaledFloorCases > 0) {
                        sources.push({ id: 'floor', label: 'Floor staging', available: scaledFloorCases, type: 'floor' });
                      }
                    } else {
                      // No allocation data - this shouldn't happen for approved finished goods
                      // But we'll create a fallback source using the receipt's total quantity
                      // This allows the user to still ship out, but they can't select specific rows
                      console.warn('Finished goods receipt missing allocation data. Using fallback source.');
                      sources.push({
                        id: 'unknown',
                        label: 'Unknown location (allocation missing)',
                        available: Number(selectedReceipt?.quantity || 0),
                        type: 'standard',
                      });
                    }
                  } else {
                    // Raw / Packaging: treat current subLocation as single source
                    const locId = selectedReceipt?.location || null;
                    const subId = selectedReceipt?.subLocation || null;
                    const locName = locations.find(l => l.id === locId)?.name || 'Location';
                    const subName = (subLocationMap[locId] || []).find(s => s.id === subId)?.name || 'Sub Location';
                    sources.push({
                      id: subId || locId || 'unknown',
                      label: `${locName}${subName ? ' / ' + subName : ''}`,
                      available: Number(selectedReceipt?.quantity || 0),
                      type: 'standard',
                    });
                  }
                  const availableQty = selectedReceipt?.quantity || 0;
                  setTransferForm(prev => ({
                    ...prev,
                    receiptId,
                    fromLocation: '',
                    fromSubLocation: '',
                    availableQuantity: availableQty
                  }));
                  setAvailableSources(sources);
                  // Always clear selections when lot changes - user must choose sources manually
                  setSourceSelections({});

                  // If no sources found for finished goods, it might be missing allocation data
                  if (sources.length === 0 && category?.type === 'finished') {
                    console.warn('No sources found for finished goods receipt. Check if allocation data exists:', {
                      receiptId: selectedReceipt?.id,
                      hasAllocation: !!selectedReceipt?.allocation,
                      allocationType: typeof selectedReceipt?.allocation,
                      parsedAllocation: allocationData
                    });
                  }
                }}
                placeholder="Select inventory lot"
                searchPlaceholder="Type to search lots..."
                required
              />
            </label>
          )}

          <label>
            <span>Quantity to Move</span>
            <div className="quantity-input-container">
              <input
                type="number"
                min="0"
                step="0.01"
                value={transferForm.quantity}
                onChange={(e) => {
                  const val = e.target.value;
                  const quantity = Number(val) || 0;
                  setTransferForm(prev => ({ ...prev, quantity: val }));

                  // For partial shipments, don't clear existing selections - let user adjust manually
                  // Only clear if quantity is 0
                  if (quantity === 0) {
                    setSourceSelections({});
                  }
                  // Note: We don't auto-select anymore - user must manually choose sources
                  // This gives them control over which rows/locations to pick from

                  // If a concrete destination sub-location is chosen, auto-allocate entire quantity there
                  if (transferForm.categoryGroupId === 'group-finished' && transferForm.toSubLocation) {
                    setDestSelections({ [transferForm.toSubLocation]: quantity });
                  }
                }}
                required
              />
              {transferForm.availableQuantity > 0 && (
                <div className="quantity-helpers">
                  <button
                    type="button"
                    className="link-button small"
                    onClick={() => {
                      setTransferForm(prev => ({
                        ...prev,
                        quantity: transferForm.availableQuantity
                      }));
                      // Don't auto-select - user must manually choose which sources to use
                    }}
                  >
                    Move all ({transferForm.availableQuantity})
                  </button>
                  <button
                    type="button"
                    className="link-button small"
                    onClick={() => setTransferForm(prev => ({
                      ...prev,
                      quantity: transferForm.availableQuantity / 2
                    }))}
                  >
                    Move half ({transferForm.availableQuantity / 2})
                  </button>
                </div>
              )}
              {/* Guidance: clarify that quantity is total cases across all sub-locations */}
              {transferForm.receiptId && (
                <div className="muted small" style={{ marginTop: 6 }}>
                  Tip: Select which locations/rows to pick from. You can choose all from one location or split between multiple locations.
                </div>
              )}
            </div>
          </label>

          {/* Source picker for all categories - ALWAYS show when quantity is entered and sources are available */}
          {availableSources.length > 0 && Number(transferForm.quantity || 0) > 0 && (() => {

            const requestedQty = Number(transferForm.quantity || 0);
            const selectedQty = Object.values(sourceSelections).reduce((s, v) => s + (Number(v) || 0), 0);

            return (
              <div className="panel" style={{ marginTop: 8 }}>
                <div className="panel-header horizontal">
                  <strong>Select From Locations (Pick sources to match {requestedQty.toLocaleString()} cases)</strong>
                  <span className="muted small">
                    Selected {selectedQty.toLocaleString()} / {requestedQty.toLocaleString()}
                  </span>
                </div>
                <div className="form-grid">
                  {availableSources.map((src) => (
                    <label key={src.id}>
                      <span>{src.label} — available {src.available.toLocaleString()} cases</span>
                      <input
                        type="number"
                        min="0"
                        max={src.available}
                        step="1"
                        value={sourceSelections[src.id] ?? ''}
                        onChange={(e) => {
                          const val = Number(e.target.value) || 0;
                          const limited = Math.min(val, src.available);
                          setSourceSelections(prev => ({ ...prev, [src.id]: limited === val ? e.target.value : limited.toString() }));
                        }}
                        placeholder="0"
                      />
                    </label>
                  ))}
                </div>
              </div>
            );
          })()}


          <div className="two-col">
            {/* Only show "Shipping To" / "To Location" for warehouse transfers, not shipped-out */}
            {transferForm.transferType !== 'shipped-out' && (
              <label>
                <span>To Location</span>
                <select
                  value={transferForm.toLocation}
                  onChange={(e) => setTransferForm(prev => ({ ...prev, toLocation: e.target.value, toSubLocation: '' }))}
                  required
                >
                  <option value="">Select location</option>
                  {/* Filter locations based on category - only show locations with finished goods storage for FG transfers */}
                  {locations.filter(location => {
                    if (transferForm.categoryGroupId === 'group-finished' && !showAllDestinations) {
                      // For finished goods, only show locations that have finished goods storage areas
                      return storageAreas.some(area => area.locationId === location.id);
                    }
                    // Otherwise show all locations (including warehouses without FG storage)
                    return true;
                  }).map(location => (
                    <option key={location.id} value={location.id}>{location.name}</option>
                  ))}
                </select>
                {/* Toggle to allow seeing all facilities (cross-warehouse / no FG storage) */}
                {transferForm.categoryGroupId === 'group-finished' && (
                  <div className="muted small" style={{ marginTop: 6 }}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={showAllDestinations}
                        onChange={(e) => setShowAllDestinations(e.target.checked)}
                      />
                      Show all locations (include non-FG or without capacity)
                    </label>
                  </div>
                )}
              </label>
            )}
            {transferForm.transferType !== 'shipped-out' && (
              <label>
                <span>To Sub Location</span>
                <select
                  value={transferForm.toSubLocation}
                  onChange={(e) => {
                    const value = e.target.value;
                    setTransferForm(prev => ({ ...prev, toSubLocation: value }));
                    // When user picks a concrete destination (rack area or floor), no need for distribution panel
                    if (value) {
                      setDestSelections({ [value]: Number(transferForm.quantity) || 0 });
                    } else {
                      setDestSelections({});
                    }
                  }}
                  disabled={!transferForm.toLocation}
                >
                  <option value="">Select</option>

                  {transferForm.categoryGroupId !== 'group-finished' && (
                    (subLocationMap[transferForm.toLocation] || []).map(sub => (
                      <option key={sub.id} value={sub.id}>{sub.name}</option>
                    ))
                  )}

                  {transferForm.categoryGroupId === 'group-finished' && (() => {
                    const areasForLocation = storageAreas.filter(area => area.locationId === transferForm.toLocation);
                    const transferQuantity = parseInt(transferForm.quantity) || 0;
                    const candidateAreas = (showAllDestinations
                      ? areasForLocation
                      : areasForLocation.filter(area => {
                        const totalCapacity = area.rows?.reduce((sum, row) => sum + (row.palletCapacity * row.defaultCasesPerPallet), 0) || 0;
                        const currentQuantity = area.rows?.reduce((sum, row) => sum + row.occupiedCases, 0) || 0;
                        const availableCapacity = Math.max(0, totalCapacity - currentQuantity);
                        return availableCapacity >= transferQuantity && availableCapacity > 0;
                      })
                    );

                    const hasFloor = areasForLocation.some(a => a.allowFloorStorage);

                    const options = candidateAreas.map(area => {
                      const totalCapacity = area.rows?.reduce((sum, row) => sum + (row.palletCapacity * row.defaultCasesPerPallet), 0) || 0;
                      const currentQuantity = area.rows?.reduce((sum, row) => sum + row.occupiedCases, 0) || 0;
                      const availableCapacity = Math.max(0, totalCapacity - currentQuantity);
                      const isFull = availableCapacity <= 0;
                      return (
                        <option key={`fg-${area.id}`} value={`fg-${area.id}`}>
                          FG Storage · {area.name} — available {availableCapacity.toLocaleString()} cases{showAllDestinations && isFull ? ' · full' : ''}
                        </option>
                      );
                    });

                    if (options.length === 0 && hasFloor) {
                      options.push(
                        <option key="fg-floor" value="fg-floor">Floor staging at this location</option>
                      );
                    }

                    if (showAllDestinations && hasFloor) {
                      options.push(
                        <option key="fg-floor-all" value="fg-floor">Floor staging (show all)</option>
                      );
                    }

                    // If no racks exist at this site but destination selected, still allow floor staging option
                    if (options.length === 0 && !hasFloor) {
                      options.push(
                        <option key="fg-floor-fallback" value="fg-floor">Floor staging (no racks at this location)</option>
                      );
                    }

                    return options;
                  })()}
                </select>
              </label>
            )}

            {/* Destination distribution picker for finished goods */}
            {transferForm.transferType !== 'shipped-out' && transferForm.categoryGroupId === 'group-finished' && transferForm.toLocation && !transferForm.toSubLocation && destOptions.length > 0 && (() => {
              // Filter options based on search
              const filteredOptions = destOptions.filter(opt =>
                destRowSearch === '' || opt.label.toLowerCase().includes(destRowSearch.toLowerCase())
              );
              // Only show rows with available capacity (unless they already have a selection)
              const visibleOptions = filteredOptions.filter(opt =>
                opt.available > 0 || opt.type === 'floor' || (destSelections[opt.id] && Number(destSelections[opt.id]) > 0)
              );

              return (
                <div className="panel" style={{ marginTop: 8 }}>
                  <div className="panel-header horizontal" style={{ flexWrap: 'wrap', gap: '8px' }}>
                    <strong>Select destination row (must total {Number(transferForm.quantity || 0).toLocaleString()} cases)</strong>
                    <span className="muted small">Allocated {Object.values(destSelections).reduce((s, v) => s + (Number(v) || 0), 0).toLocaleString()}</span>
                  </div>

                  {/* Search filter */}
                  <div style={{ marginBottom: '12px' }}>
                    <input
                      type="text"
                      placeholder="🔍 Search rows (e.g., AA 1, AD, AI)..."
                      value={destRowSearch}
                      onChange={(e) => setDestRowSearch(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '8px 12px',
                        border: '1px solid #ddd',
                        borderRadius: '6px',
                        fontSize: '14px'
                      }}
                    />
                  </div>

                  {/* Quick actions */}
                  <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="small-button"
                      style={{ fontSize: '12px', padding: '4px 8px' }}
                      onClick={() => {
                        // Auto-fill first available row with capacity
                        const qty = Number(transferForm.quantity) || 0;
                        if (qty <= 0) return;
                        let remaining = qty;
                        const newSelections = {};
                        for (const opt of visibleOptions) {
                          if (remaining <= 0) break;
                          if (opt.type === 'floor') continue; // Skip floor for auto-fill
                          const toAllocate = Math.min(remaining, opt.available);
                          if (toAllocate > 0) {
                            newSelections[opt.id] = toAllocate.toString();
                            remaining -= toAllocate;
                          }
                        }
                        // If still remaining, put on floor
                        if (remaining > 0 && visibleOptions.some(o => o.type === 'floor')) {
                          newSelections['floor'] = remaining.toString();
                        }
                        setDestSelections(newSelections);
                      }}
                    >
                      Auto-fill rows
                    </button>
                    <button
                      type="button"
                      className="small-button secondary"
                      style={{ fontSize: '12px', padding: '4px 8px' }}
                      onClick={() => setDestSelections({})}
                    >
                      Clear all
                    </button>
                    <span className="muted small" style={{ alignSelf: 'center' }}>
                      {visibleOptions.length} rows available
                    </span>
                  </div>

                  {/* Scrollable row list */}
                  <div style={{ maxHeight: '250px', overflowY: 'auto', border: '1px solid #eee', borderRadius: '6px', padding: '8px' }}>
                    <div className="form-grid" style={{ gap: '8px' }}>
                      {visibleOptions.map(opt => (
                        <label key={opt.id} style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '12px',
                          padding: '6px 8px',
                          borderRadius: '4px',
                          background: destSelections[opt.id] && Number(destSelections[opt.id]) > 0 ? '#f0f7ff' : 'transparent'
                        }}>
                          <span style={{ flex: 1, fontSize: '13px' }}>
                            {opt.label} — {opt.type === 'floor' ? 'unlimited' : `${opt.available.toLocaleString()} avail`}
                          </span>
                          <input
                            type="number"
                            min="0"
                            max={opt.type === 'floor' ? undefined : opt.available}
                            step="1"
                            value={destSelections[opt.id] ?? ''}
                            onChange={(e) => {
                              const val = Number(e.target.value) || 0;
                              if (opt.type !== 'floor') {
                                const limited = Math.min(val, opt.available);
                                setDestSelections(prev => ({ ...prev, [opt.id]: limited === val ? e.target.value : limited.toString() }));
                              } else {
                                setDestSelections(prev => ({ ...prev, [opt.id]: e.target.value }));
                              }
                            }}
                            placeholder="0"
                            style={{ width: '80px', padding: '4px 8px', textAlign: 'right' }}
                          />
                        </label>
                      ))}
                      {visibleOptions.length === 0 && (
                        <p className="muted small" style={{ padding: '12px', textAlign: 'center' }}>
                          {destRowSearch ? 'No rows match your search' : 'No rows with available capacity'}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>

          <label className="full-width">
            <span>{transferForm.transferType === 'shipped-out' ? 'Shipping Notes' : 'Reason / Notes'}</span>
            <textarea
              value={transferForm.reason}
              onChange={(e) => setTransferForm(prev => ({ ...prev, reason: e.target.value }))}
              rows={3}
              placeholder={transferForm.transferType === 'shipped-out' ? 'Additional shipping details (customer, carrier, etc.)' : ''}
            />
          </label>

          {transferError && <div className="form-error">{transferError}</div>}

          <div className="form-actions">
            <button type="submit" className="primary-button" disabled={isSubmittingTransfer}>
              {isSubmittingTransfer ? 'Submitting...' :
                transferForm.transferType === 'shipped-out' ? 'Submit Shipment Request' :
                  'Submit Transfer'}
            </button>
          </div>
        </form>

        <div className="action-list">
          <h3>Recent Transfer Requests</h3>
          <ul>
            {inventoryTransfers.slice().reverse().slice(0, 4).map(transfer => {
              const receipt = receipts.find(r => r.id === transfer.receiptId);
              return (
                <li key={transfer.id}>
                  <div className="item-main">
                    <strong>{formatReceiptLabel(receipt || {})}</strong>
                    <span className={`status-badge status-${transfer.status}`}>{transfer.status}</span>
                  </div>
                  <div className="item-meta">
                    <span><strong>Type:</strong> {transfer.transferType === 'shipped-out' ? 'Shipped Out' : 'Warehouse Transfer'}</span>
                    {transfer.transferType === 'shipped-out' && transfer.orderNumber && (
                      <span><strong>Order #:</strong> {transfer.orderNumber}</span>
                    )}
                    {transfer.transferType !== 'shipped-out' && (
                      <span>To: {locations.find(loc => loc.id === transfer.toLocation)?.name || '-'}</span>
                    )}
                    <span>Requested: {new Date(transfer.submittedAt).toLocaleString()}</span>
                    {transfer.reason && <span>Note: {transfer.reason}</span>}
                  </div>
                </li>
              );
            })}
            {!inventoryTransfers.length && <li className="empty">No transfers submitted yet.</li>}
          </ul>
        </div>
      </div>
    </div>
  );

  const renderHoldsTab = () => (
    <div className="tab-panel">
      <div className="split">
        <form onSubmit={handleHoldSubmit} className="action-form">
          <h3>Request Hold / Release</h3>
          <p className="muted small">Select a product to hold specific locations/quantities, or select a lot to hold the entire batch.</p>

          <label>
            <span>Product (Finished Goods)</span>
            <SearchableSelect
              options={finishedGoodsProducts}
              value={holdForm.productId}
              onChange={(productId) => {
                setHoldForm(prev => ({ ...prev, productId, receiptId: '' }));
                buildHoldLocations(productId);
                setHoldError('');
              }}
              placeholder="Select product to see locations"
              searchPlaceholder="Search products..."
            />
          </label>

          {holdLocations.length > 0 && (
            <div className="panel" style={{ marginTop: '12px' }}>
              <div className="panel-header horizontal">
                <strong>Available Locations</strong>
                <span className="muted small">
                  Total to hold: {Object.values(holdSelections).reduce((sum, v) => sum + (Number(v) || 0), 0).toLocaleString()} cases
                </span>
              </div>
              <div className="table-wrapper" style={{ maxHeight: '300px', overflowY: 'auto' }}>
                <table className="report-table compact">
                  <thead>
                    <tr>
                      <th>Location</th>
                      <th>Lot #</th>
                      <th>Expiration</th>
                      <th className="text-right">Available</th>
                      <th className="text-right" style={{ width: '100px' }}>Hold Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdLocations.map(loc => (
                      <tr key={loc.id}>
                        <td>{String(loc.location || '')}</td>
                        <td>{String(loc.lotNo || '—')}</td>
                        <td>{loc.expiration ? new Date(loc.expiration).toLocaleDateString() : '—'}</td>
                        <td className="text-right">{Number(loc.available || 0).toLocaleString()}</td>
                        <td className="text-right">
                          <input
                            type="number"
                            min="0"
                            max={loc.available}
                            value={holdSelections[loc.id] || ''}
                            onChange={(e) => {
                              const val = Math.min(Number(e.target.value) || 0, loc.available);
                              setHoldSelections(prev => ({ ...prev, [loc.id]: val === 0 ? '' : val.toString() }));
                            }}
                            placeholder="0"
                            style={{ width: '80px', textAlign: 'right' }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!holdForm.productId && (
            <>
              <div className="divider" style={{ margin: '16px 0', borderTop: '1px solid #ddd' }}>
                <span className="muted small" style={{ background: '#fff', padding: '0 8px' }}>Or hold entire lot</span>
              </div>
              <label>
                <span>Inventory Lot</span>
                <SearchableSelect
                  options={trackedReceipts.map(receipt => ({
                    value: receipt.id,
                    label: formatReceiptLabel(receipt)
                  }))}
                  value={holdForm.receiptId}
                  onChange={(receiptId) => {
                    const selectedReceipt = trackedReceipts.find(r => r.id === receiptId);
                    if (selectedReceipt) {
                      setHoldForm(prev => ({
                        ...prev,
                        receiptId,
                        productId: '',
                        action: selectedReceipt.hold ? 'release' : 'hold'
                      }));
                    } else {
                      setHoldForm(prev => ({ ...prev, receiptId, productId: '' }));
                    }
                    setHoldLocations([]);
                    setHoldSelections({});
                    setHoldError('');
                  }}
                  placeholder="Select lot"
                  searchPlaceholder="Type to search lots..."
                />
              </label>
            </>
          )}

          <label>
            <span>Action</span>
            <select
              value={holdForm.action}
              onChange={(e) => setHoldForm(prev => ({ ...prev, action: e.target.value }))}
              required
            >
              <option value="hold">Place on Hold</option>
              <option value="release">Release Hold</option>
            </select>
          </label>

          <label className="full-width">
            <span>Reason / Notes <span className="required">*</span></span>
            <textarea
              value={holdForm.reason}
              onChange={(e) => setHoldForm(prev => ({ ...prev, reason: e.target.value }))}
              rows={3}
              required
            />
          </label>

          {holdError && <div className="form-error">{typeof holdError === 'string' ? holdError : JSON.stringify(holdError)}</div>}

          <div className="form-actions">
            <button type="submit" className="primary-button" disabled={isSubmittingHold}>
              {isSubmittingHold ? 'Submitting...' : 'Submit Request'}
            </button>
          </div>
        </form>

        <div className="action-list">
          <h3>Hold History</h3>
          <ul>
            {inventoryHoldActions.slice().reverse().slice(0, 4).map(action => {
              const receipt = receipts.find(r => r.id === action.receiptId);
              const isSupervisor = user?.role === 'supervisor' || user?.role === 'admin';
              const isPending = action.status === 'pending';
              return (
                <li key={action.id}>
                  <div className="item-main">
                    <strong>{formatReceiptLabel(receipt || {})}</strong>
                    <span className={`status-badge status-${action.status}`}>{action.status}</span>
                  </div>
                  <div className="item-meta">
                    <span>{action.action === 'hold' ? 'Hold' : 'Release'}</span>
                    <span>Requested: {new Date(action.submittedAt).toLocaleString()}</span>
                    <span>Notes: {action.reason || '-'}</span>
                    {action.approvedBy && (
                      <span>Approved by: {userLookup[action.approvedBy] || action.approvedBy} on {action.approvedAt ? new Date(action.approvedAt).toLocaleString() : '-'}</span>
                    )}
                  </div>
                </li>
              );
            })}
            {!inventoryHoldActions.length && <li className="empty">No hold requests yet.</li>}
          </ul>
        </div>
      </div>

      <div className="on-hold-grid">
        <h3>Currently On Hold</h3>
        <div className="card-grid">
          {receipts.filter(receipt => receipt.hold).map(receipt => {
            const lastHold = inventoryHoldActions
              .filter(action => action.receiptId === receipt.id && action.status === 'approved' && action.action === 'hold')
              .slice(-1)[0];
            return (
              <div key={receipt.id} className="hold-card">
                <span className="title">{formatReceiptLabel(receipt)}</span>
                <span className="meta">Since: {lastHold ? new Date(lastHold.approvedAt || lastHold.submittedAt).toLocaleString() : 'Pending'}</span>
                <span className="meta">Placed By: {lastHold ? (userLookup[lastHold.submittedBy] || lastHold.submittedBy) : '-'}</span>
              </div>
            );
          })}
          {!receipts.some(receipt => receipt.hold) && (
            <div className="empty">No inventory currently on hold.</div>
          )}
        </div>
      </div>
    </div>
  );

  const renderAdjustmentsTab = () => {
    // Get available sub-categories for the selected category group
    const availableCategories = productCategories.filter(cat => {
      if (!adjustForm.categoryGroupId) return false;
      return cat.parentId === adjustForm.categoryGroupId;
    });

    const availableProducts = products.filter(p => p.categoryId === adjustForm.categoryId);

    return (
      <div className="tab-panel">
        <div className="split">
          <form onSubmit={handleAdjustSubmit} className="action-form">
            <h3>Request Inventory Adjustment</h3>

            <label>
              <span>Category</span>
              <select
                value={adjustForm.categoryGroupId}
                onChange={(e) => setAdjustForm(prev => ({ ...prev, categoryGroupId: e.target.value, categoryId: '', productId: '' }))}
                required
              >
                <option value="">Select category</option>
                {categoryGroups.map(group => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>

            {availableCategories.length > 0 && (
              <label>
                <span>Sub-Category</span>
                <select
                  value={adjustForm.categoryId}
                  onChange={(e) => setAdjustForm(prev => ({ ...prev, categoryId: e.target.value, productId: '' }))}
                  required
                >
                  <option value="">Select sub-category</option>
                  {availableCategories.map(cat => (
                    <option key={cat.id} value={cat.id}>{cat.name}</option>
                  ))}
                </select>
              </label>
            )}

            {availableProducts.length > 0 && (
              <label>
                <span>Product</span>
                <SearchableSelect
                  options={availableProducts.map(product => ({
                    value: product.id,
                    label: product.name
                  }))}
                  value={adjustForm.productId}
                  onChange={(productId) => {
                    setAdjustForm(prev => ({ ...prev, productId, receiptId: '' }));
                    setAdjustSourceSelections({});
                    setAdjustAvailableSources([]);
                  }}
                  placeholder="Select product"
                  searchPlaceholder="Type to search products..."
                  required
                />
              </label>
            )}

            {/* Show lots for selected product */}
            {adjustForm.productId && (() => {
              const productReceipts = approvedReceipts.filter(r => r.productId === adjustForm.productId);
              return (
                <label>
                  <span>Inventory Lot</span>
                  <SearchableSelect
                    options={productReceipts.map(receipt => ({
                      value: receipt.id,
                      label: formatReceiptLabel(receipt)
                    }))}
                    value={adjustForm.receiptId}
                    onChange={(receiptId) => {
                      const selectedReceipt = productReceipts.find(r => r.id === receiptId);
                      setAdjustForm(prev => ({ ...prev, receiptId, availableQuantity: selectedReceipt?.quantity || 0 }));
                      setAdjustSourceSelections({});
                      // Populate adjustAvailableSources based on receipt allocation
                      if (selectedReceipt) {
                        const category = categoryLookup[selectedReceipt.categoryId];
                        const isFinishedGood = category?.type === 'finished';
                        const sources = [];

                        if (isFinishedGood && selectedReceipt.allocation) {
                          // Calculate scale factor: current quantity / original allocation total
                          const originalPlanTotal = selectedReceipt.allocation.plan?.reduce((sum, p) => sum + (Number(p.cases) || 0), 0) || 0;
                          const originalFloorCases = Number(selectedReceipt.allocation.floorAllocation?.cases || 0);
                          const originalTotal = originalPlanTotal + originalFloorCases;
                          const currentTotal = Number(selectedReceipt.quantity || 0);
                          const scaleFactor = originalTotal > 0 ? currentTotal / originalTotal : 0;

                          selectedReceipt.allocation.plan?.forEach(alloc => {
                            const area = storageAreas.find(a => a.id === alloc.areaId);
                            const row = area?.rows.find(r => r.id === alloc.rowId);
                            const scaledCases = Math.round((Number(alloc.cases) || 0) * scaleFactor);
                            if (row && scaledCases > 0) {
                              sources.push({
                                id: `rack-${alloc.areaId}-${alloc.rowId}`,
                                label: `Rack · ${area.name} / ${row.name}`,
                                available: scaledCases,
                                type: 'rack',
                                areaId: alloc.areaId,
                                rowId: alloc.rowId,
                              });
                            }
                          });
                          const scaledFloorCases = Math.round(originalFloorCases * scaleFactor);
                          if (scaledFloorCases > 0) {
                            sources.push({
                              id: 'floor-staging',
                              label: 'Floor Staging',
                              available: scaledFloorCases,
                              type: 'floor',
                            });
                          }
                        } else {
                          sources.push({
                            id: `general-${selectedReceipt.location}-${selectedReceipt.subLocation}`,
                            label: `${locations.find(loc => loc.id === selectedReceipt.location)?.name || 'Unknown'} / ${subLocationMap[selectedReceipt.location]?.find(sub => sub.id === selectedReceipt.subLocation)?.name || 'Unknown'}`,
                            available: selectedReceipt.quantity,
                            type: 'general',
                            locationId: selectedReceipt.location,
                            subLocationId: selectedReceipt.subLocation,
                          });
                        }
                        setAdjustAvailableSources(sources);
                      } else {
                        setAdjustAvailableSources([]);
                      }
                    }}
                    placeholder="Select lot"
                    searchPlaceholder="Type to search lots..."
                    required
                  />
                </label>
              );
            })()}

            {/* Quantity field - placed right after lot selection */}
            {adjustForm.receiptId && (
              <label>
                <span>Quantity to Adjust</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={adjustForm.quantity}
                  onChange={(e) => setAdjustForm(prev => ({ ...prev, quantity: e.target.value }))}
                  required
                />
              </label>
            )}

            {/* Source breakdown panel */}
            {adjustForm.receiptId && adjustForm.quantity && Number(adjustForm.quantity) > 0 && (() => {
              const selectedReceipt = approvedReceipts.find(r => r.id === adjustForm.receiptId);
              const product = productLookup[selectedReceipt?.productId];
              const category = categoryLookup[selectedReceipt?.categoryId];
              const isFinishedGood = category?.type === 'finished';

              // Determine available sources (same logic as transfers)
              const sources = [];
              if (isFinishedGood && selectedReceipt?.allocation) {
                // Calculate scale factor: current quantity / original allocation total
                const originalPlanTotal = selectedReceipt.allocation.plan?.reduce((sum, p) => sum + (Number(p.cases) || 0), 0) || 0;
                const originalFloorCases = Number(selectedReceipt.allocation.floorAllocation?.cases || 0);
                const originalTotal = originalPlanTotal + originalFloorCases;
                const currentTotal = Number(selectedReceipt.quantity || 0);
                const scaleFactor = originalTotal > 0 ? currentTotal / originalTotal : 0;

                selectedReceipt.allocation.plan?.forEach(alloc => {
                  const area = storageAreas.find(a => a.id === alloc.areaId);
                  const row = area?.rows.find(r => r.id === alloc.rowId);
                  const scaledCases = Math.round((Number(alloc.cases) || 0) * scaleFactor);
                  if (row && scaledCases > 0) {
                    sources.push({
                      id: `rack-${alloc.areaId}-${alloc.rowId}`,
                      label: `Rack · ${area.name} / ${row.name}`,
                      available: scaledCases,
                      type: 'rack',
                      areaId: alloc.areaId,
                      rowId: alloc.rowId,
                    });
                  }
                });
                const scaledFloorCases = Math.round(originalFloorCases * scaleFactor);
                if (scaledFloorCases > 0) {
                  sources.push({
                    id: 'floor-staging',
                    label: 'Floor Staging',
                    available: scaledFloorCases,
                    type: 'floor',
                  });
                }
              } else if (selectedReceipt) {
                sources.push({
                  id: `general-${selectedReceipt.location}-${selectedReceipt.subLocation}`,
                  label: `${locations.find(loc => loc.id === selectedReceipt.location)?.name || 'Unknown'} / ${subLocationMap[selectedReceipt.location]?.find(sub => sub.id === selectedReceipt.subLocation)?.name || 'Unknown'}`,
                  available: selectedReceipt.quantity,
                  type: 'general',
                  locationId: selectedReceipt.location,
                  subLocationId: selectedReceipt.subLocation,
                });
              }

              const mismatch = () => {
                const requested = Number(adjustForm.quantity);
                const picked = Object.values(adjustSourceSelections).reduce((sum, v) => sum + (Number(v) || 0), 0);
                return Math.abs(picked - requested) > 0.01;
              };

              return (
                <div className="panel" style={{ marginTop: 8, background: '#f9fafb', padding: '16px', borderRadius: '6px' }}>
                  <div className="panel-header">
                    <strong>Pick sources to match {Number(adjustForm.quantity || 0).toLocaleString()} cases</strong>
                  </div>
                  <div style={{ fontSize: '13px', color: '#666', marginBottom: '8px' }}>
                    Specify where the adjustment applies
                  </div>
                  {mismatch() && (
                    <div className="form-error" style={{ marginBottom: '12px' }}>
                      Total from sources must match Quantity to Adjust ({adjustForm.quantity} cases).
                      Currently: {Object.values(adjustSourceSelections).reduce((s, v) => s + (Number(v) || 0), 0).toLocaleString()} cases.
                    </div>
                  )}
                  <div className="form-grid">
                    {sources.map(src => (
                      <label key={src.id}>
                        <span>{src.label} — available {src.available.toLocaleString()} cases</span>
                        <input
                          type="number"
                          min="0"
                          max={src.available}
                          step="1"
                          value={adjustSourceSelections[src.id] ?? ''}
                          onChange={(e) => {
                            const val = Number(e.target.value) || 0;
                            const limited = Math.min(val, src.available);
                            setAdjustSourceSelections(prev => ({ ...prev, [src.id]: limited === val ? e.target.value : limited.toString() }));
                          }}
                          placeholder="0"
                        />
                      </label>
                    ))}
                  </div>
                </div>
              );
            })()}

            <label>
              <span>Adjustment Type</span>
              <select
                value={adjustForm.adjustmentType}
                onChange={(e) => setAdjustForm(prev => ({ ...prev, adjustmentType: e.target.value }))}
                required
              >
                <option value="stock-correction">Stock Correction</option>
                <option value="damage-reduction">Damage Reduction</option>
                <option value="donation">Donation</option>
                <option value="trash-disposal">Trash/Disposal</option>
                <option value="quality-rejection">Quality Rejection</option>
              </select>
            </label>

            {adjustForm.adjustmentType === 'donation' && (
              <label>
                <span>Recipient (Optional)</span>
                <input
                  type="text"
                  value={adjustForm.recipient}
                  onChange={(e) => setAdjustForm(prev => ({ ...prev, recipient: e.target.value }))}
                  placeholder="e.g., Community Food Bank, Local Charity"
                />
              </label>
            )}

            <label className="full-width">
              <span>Reason for Adjustment</span>
              <textarea
                value={adjustForm.reason}
                onChange={(e) => setAdjustForm(prev => ({ ...prev, reason: e.target.value }))}
                rows={3}
                placeholder={
                  adjustForm.adjustmentType === 'stock-correction' ? 'Describe the stock discrepancy found...' :
                    adjustForm.adjustmentType === 'damage-reduction' ? 'Describe the damage and cause...' :
                      adjustForm.adjustmentType === 'donation' ? 'Describe the donation purpose and recipient...' :
                        adjustForm.adjustmentType === 'trash-disposal' ? 'Describe why items need to be disposed...' :
                          'Describe the quality issue and rejection reason...'
                }
                required
              />
            </label>

            {adjustError && <div className="form-error">{adjustError}</div>}

            <div className="form-actions">
              <button type="submit" className="primary-button" disabled={isSubmittingAdjust}>
                {isSubmittingAdjust ? 'Submitting...' :
                  adjustForm.adjustmentType === 'donation' ? 'Submit Donation Request' :
                    adjustForm.adjustmentType === 'trash-disposal' ? 'Submit Disposal Request' :
                      'Submit Adjustment Request'}
              </button>
            </div>
          </form>

          <div className="action-list">
            <h3>Recent Adjustments</h3>
            <ul>
              {inventoryAdjustments.slice().reverse().slice(0, 4).map(adjustment => {
                const receipt = receipts.find(r => r.id === adjustment.receiptId);
                const getAdjustmentTypeLabel = (type) => {
                  switch (type) {
                    case 'stock-correction': return 'Stock Correction';
                    case 'damage-reduction': return 'Damage Reduction';
                    case 'donation': return 'Donation';
                    case 'trash-disposal': return 'Trash/Disposal';
                    case 'quality-rejection': return 'Quality Rejection';
                    default: return 'Adjustment';
                  }
                };
                return (
                  <li key={adjustment.id}>
                    <div className="item-main">
                      <strong>{formatReceiptLabel(receipt || {})}</strong>
                      <span className={`status-badge status-${adjustment.status}`}>{adjustment.status}</span>
                    </div>
                    <div className="item-meta">
                      <span><strong>Type:</strong> {getAdjustmentTypeLabel(adjustment.adjustmentType)}</span>
                      <span><strong>Quantity:</strong> {adjustment.quantity}</span>
                      <span>Requested: {new Date(adjustment.submittedAt).toLocaleString()}</span>
                      {adjustment.reason && <span><strong>Reason:</strong> {adjustment.reason}</span>}
                      {adjustment.recipient && <span><strong>Recipient:</strong> {adjustment.recipient}</span>}
                    </div>
                  </li>
                );
              })}
              {!inventoryAdjustments.length && <li className="empty">No adjustments submitted yet.</li>}
            </ul>
          </div>
        </div>
      </div>
    );
  };

  const renderShipOutTab = () => {
    const totalPick = shipOutPickList.reduce((sum, item) => sum + item.pickQty, 0);
    const casesNeeded = Number(shipOutForm.casesNeeded) || 0;
    const selectedProduct = products.find(p => p.id === shipOutForm.productId);

    const printPickList = () => {
      const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Pick List - ${selectedProduct?.name || 'Unknown'}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; font-size: 10pt; padding: 15mm; }
    h1 { font-size: 14pt; margin-bottom: 5mm; }
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
  <h1>Pick List - ${selectedProduct?.name || 'Unknown Product'}</h1>
  <div class="info">
    <strong>Order #:</strong> ${shipOutForm.orderNumber || '—'} | 
    <strong>Date:</strong> ${new Date().toLocaleDateString()} | 
    <strong>Cases Needed:</strong> ${casesNeeded.toLocaleString()}
  </div>
  <table>
    <thead>
      <tr>
        <th>Lot #</th>
        <th>Expiration</th>
        <th>Location</th>
        <th class="num">Available</th>
        <th class="num">Pick Qty</th>
        <th>Picked ✓</th>
      </tr>
    </thead>
    <tbody>
      ${shipOutPickList.map(item => `
        <tr>
          <td>${item.lotNo}</td>
          <td>${item.expiration ? new Date(item.expiration).toLocaleDateString() : '—'}</td>
          <td>${item.location}</td>
          <td class="num">${item.available.toLocaleString()}</td>
          <td class="num"><strong>${item.pickQty.toLocaleString()}</strong></td>
          <td style="width:20mm"></td>
        </tr>
      `).join('')}
      <tr class="total-row">
        <td colspan="4" style="text-align:right">Total Pick:</td>
        <td class="num">${totalPick.toLocaleString()}</td>
        <td></td>
      </tr>
    </tbody>
  </table>
</body>
</html>`;
      const printWindow = window.open('', '_blank');
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.focus();
      setTimeout(() => printWindow.print(), 250);
    };

    return (
      <div className="tab-panel">
        <div className="split">
          <div className="action-form">
            <h3>Ship Out Order</h3>
            <p className="muted small">Generate a FIFO pick list for finished goods - picks from oldest expiring lots first.</p>

            <label>
              <span>Order Number</span>
              <input
                type="text"
                value={shipOutForm.orderNumber}
                onChange={(e) => setShipOutForm(prev => ({ ...prev, orderNumber: e.target.value }))}
                placeholder="Enter order/reference number"
              />
            </label>

            <label>
              <span>Product <span className="required">*</span></span>
              <SearchableSelect
                options={finishedGoodsProducts}
                value={shipOutForm.productId}
                onChange={(productId) => {
                  setShipOutForm(prev => ({ ...prev, productId }));
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
                  generatePickList(shipOutForm.productId, Number(val) || 0);
                }}
                placeholder="Enter number of cases"
              />
            </label>

            {shipOutError && <div className="alert error">{shipOutError}</div>}
          </div>

          <div className="action-list">
            <h3>Pick List (FIFO - Oldest First)</h3>
            {shipOutPickList.length > 0 ? (
              <>
                <div className="table-wrapper">
                  <table className="report-table">
                    <thead>
                      <tr>
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
                          <td>{item.lotNo}</td>
                          <td>{item.expiration ? new Date(item.expiration).toLocaleDateString() : '—'}</td>
                          <td>{item.location}</td>
                          <td className="text-right">{item.available.toLocaleString()}</td>
                          <td className="text-right"><strong>{item.pickQty.toLocaleString()}</strong></td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan="4" className="text-right"><strong>Total:</strong></td>
                        <td className="text-right"><strong>{totalPick.toLocaleString()}</strong></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <div className="form-actions" style={{ marginTop: '1rem' }}>
                  <button type="button" className="secondary-button" onClick={printPickList}>
                    🖨️ Print Pick List
                  </button>
                </div>
              </>
            ) : (
              <p className="muted">Select a product and enter cases needed to generate pick list.</p>
            )}
          </div>
        </div>
      </div>
    );
  };

  // Staging helper functions
  const fetchLotSuggestions = async (productId, quantityNeeded) => {
    try {
      const headers = await getAuthHeaders();
      const response = await axios.get(
        `${API_BASE_URL}/inventory/staging/suggest-lots?product_id=${productId}&quantity=${quantityNeeded}`,
        { headers }
      );
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
    
    // Check if product already added
    if (stagingForm.items.some(item => item.productId === productId)) {
      setStagingError('This product is already in the staging list. Remove it first to change quantity.');
      return;
    }
    
    const product = productLookup[productId];
    
    // Fetch suggestions - get more suggestions than needed to allow multiple lot selection
    const suggestions = await fetchLotSuggestions(productId, quantity * 2); // Request more to show options
    
    if (suggestions.length === 0) {
      setStagingError('No available lots found for this product.');
      return;
    }
    
    // Get unit from first suggestion or product
    const unit = suggestions[0]?.unit || product?.quantityUom || 'cases';
    
    // Auto-select first lot (even if it doesn't have enough, user can add more)
    const firstSuggestion = suggestions[0];
    const lots = [];
    
    if (firstSuggestion) {
      // Add first lot with available quantity (or requested quantity if it has enough)
      const lotQuantity = Math.min(firstSuggestion.available_quantity, quantity);
      lots.push({
        receiptId: firstSuggestion.receipt_id,
        quantity: lotQuantity,
        unit: firstSuggestion.unit || unit,
        suggestion: firstSuggestion
      });
    }
    
    // Add to form
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
    
    // Clear inputs
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
        
        // Add empty lot entry
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
              
              // Auto-set quantity to minimum of: available, remaining needed, or current quantity
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
              const remainingNeeded = item.quantityNeeded - item.lots.reduce((sum, l, idx) => {
                if (idx === lotIndex) return sum;
                return sum + (l.quantity || 0);
              }, 0);
              
              // Allow up to max available, but suggest remaining needed
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
    <strong>Staging Location:</strong> ${stagingLocationName}${stagingSubLocationName ? ` / ${stagingSubLocationName}` : ''}<br>
    <strong>Date:</strong> ${new Date().toLocaleString()}<br>
    <strong>Prepared By:</strong> ${user?.name || user?.username || 'Unknown'}
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
            ? `${suggestion.location_name || 'Unknown'}${suggestion.sub_location_name ? ` / ${suggestion.sub_location_name}` : ''}`
            : 'Unknown';
          const expirationDate = suggestion?.expiration_date 
            ? new Date(suggestion.expiration_date).toLocaleDateString() 
            : '—';
          
          return `
          <tr>
            <td>${itemIndex + 1}${item.lots.length > 1 ? `-${lotIndex + 1}` : ''}</td>
            <td><strong>${product?.name || 'Unknown'}</strong></td>
            <td>${suggestion?.lot_number || '—'}</td>
            <td>${expirationDate}</td>
            <td>${locationText}</td>
            <td class="num"><strong>${(lot.quantity || 0).toLocaleString()}</strong></td>
            <td>${lot.unit || unit}</td>
          </tr>`;
        });
      }).join('')}
      ${stagingForm.items.map((item, itemIndex) => {
        const product = productLookup[item.productId];
        const unit = item.unit || 'cases';
        const totalForItem = item.lots.reduce((sum, lot) => sum + (lot.quantity || 0), 0);
        return item.lots.length > 1 ? `
          <tr class="total-row" style="background-color: #f0f0f0;">
            <td colspan="5" style="text-align:right"><strong>Subtotal (${product?.name || 'Unknown'}):</strong></td>
            <td class="num"><strong>${totalForItem.toLocaleString()}</strong></td>
            <td><strong>${unit}</strong></td>
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
    
    // Validate all items have lots selected and quantities match
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
      
      // Validate total lot quantities match requested quantity
      const totalLotQuantity = item.lots.reduce((sum, lot) => sum + (lot.quantity || 0), 0);
      if (Math.abs(totalLotQuantity - item.quantityNeeded) > 0.01) {
        setStagingError(`Total lot quantities must match requested quantity for ${productLookup[item.productId]?.name || 'product'}.`);
        return;
      }
    }
    
    setIsSubmittingStaging(true);
    setStagingError('');
    
    try {
      const headers = await getAuthHeaders();
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
      
      const response = await axios.post(
        `${API_BASE_URL}/inventory/staging/transfer`,
        payload,
        { headers }
      );
      
      // Print the staging list before resetting form
      printStagingList();
      
      // Success - reset form
      const currentItems = [...stagingForm.items]; // Save for potential re-print
      setStagingForm({
        stagingLocation: '',
        stagingSubLocation: '',
        items: []
      });
      setStagingError('');
      
      // Refresh data after a short delay to allow print dialog to open
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    } catch (error) {
      console.error('Error creating staging transfer:', error);
      setStagingError(error.response?.data?.detail || 'Failed to stage items. Please try again.');
    } finally {
      setIsSubmittingStaging(false);
    }
  };

  const renderStagingTab = () => {
    // Get raw materials and packaging products for staging (exclude finished goods)
    const stagingProducts = products.filter(product => {
      const category = categories.find(cat => cat.id === product.categoryId);
      if (!category) return false;
      
      // Exclude finished goods
      if (category.type === 'finished') return false;
      if (category.parentId === 'group-finished') return false;
      
      // Include only raw materials and packaging
      return category.parentId === 'group-raw' || category.parentId === 'group-packaging';
    });

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
                        
                        // Calculate total rows: 1 for first lot + (lots.length - 1) for additional lots + 1 for "Add Another Lot" button if not complete
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
                                          {suggestion.expiration_date ? ` (Exp: ${new Date(suggestion.expiration_date).toLocaleDateString()})` : ''} 
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
                                          ×
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
                                            {suggestion.expiration_date ? ` (Exp: ${new Date(suggestion.expiration_date).toLocaleDateString()})` : ''} 
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
                                      ×
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
              View Staging Overview →
            </button>
          </div>
        </div>
      </div>
    );
  };

  // Helper to get auth headers
  const getAuthHeaders = async () => {
    const token = localStorage.getItem('token');
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };
  };

  return (
    <div className="inventory-actions-page">
      <div className="page-header">
        <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">← Back to Dashboard</button>
        <div className="header-content">
          <h2>Inventory Actions</h2>
          <p className="muted">Request transfers, toggle holds, or submit quantity/location corrections.</p>
        </div>
      </div>

      <div className="tabs">
        {TAB_OPTIONS.map(tab => (
          <button
            key={tab}
            className={`tab-button ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'shipout' ? 'Ship Out' : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {activeTab === 'transfers' && renderTransfersTab()}
      {activeTab === 'staging' && renderStagingTab()}
      {activeTab === 'holds' && renderHoldsTab()}
      {activeTab === 'adjustments' && renderAdjustmentsTab()}
      {activeTab === 'shipout' && renderShipOutTab()}
    </div>
  );
};

export default InventoryActionsPage;
