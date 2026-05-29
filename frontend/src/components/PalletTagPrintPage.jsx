import React, { useState, useMemo, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAppData } from '../context/AppDataContext';
import { useAuth } from '../context/AuthContext';
import { getDashboardPath } from '../App';
import { formatDate } from '../utils/dateUtils';
import JsBarcode from 'jsbarcode';
import jsPDF from 'jspdf';
import PalletStickerLayout from './palletizer/PalletStickerLayout';
import SearchableSelect from './SearchableSelect';
import './Shared.css';
import './PalletTagPrintPage.css';
import { CATEGORY_TYPES, RECEIPT_STATUS } from '../constants';

const PRODUCT_TYPE_OPTIONS = [
  { value: 'all', label: 'All Types' },
  { value: CATEGORY_TYPES.FINISHED, label: 'Finished Goods' },
  { value: CATEGORY_TYPES.RAW_MATERIAL, label: 'Raw Materials' },
  { value: CATEGORY_TYPES.INGREDIENT, label: 'Ingredients' },
  { value: CATEGORY_TYPES.PACKAGING, label: 'Packaging' },
];

// Pallet statuses that mean "still in the building" — eligible for tag
// reprint. Excludes shipped/transferred/missing/cancelled/not_produced.
const IN_BUILDING_STATUSES = new Set([
  'pending',
  'missing_sticker',
  'in_stock',
  'reserved',
  'placed',
]);

const PalletTagPrintPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const {
    receipts,
    products,
    categories,
    locations,
    fetchPalletLicences,
  } = useAppData();

  // Get pre-selected receipt from URL
  const preselectedReceiptId = searchParams.get('receiptId');

  const [selectedReceipts, setSelectedReceipts] = useState(new Set());
  const [selectedPallets, setSelectedPallets] = useState(new Set());
  const [expandedReceipts, setExpandedReceipts] = useState(new Set());
  const [palletsByReceipt, setPalletsByReceipt] = useState({}); // receiptId -> pallet[]
  const [loadingReceiptIds, setLoadingReceiptIds] = useState(new Set());
  const [companyFilter, setCompanyFilter] = useState('all');
  const [productTypeFilter, setProductTypeFilter] = useState('all');
  const [productFilter, setProductFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  // Per-receipt pallet search inside the expansion. Lets the operator
  // narrow a long list down to one specific pallet ID quickly.
  const [palletSearchByReceipt, setPalletSearchByReceipt] = useState({});
  const [copiesPerTag, setCopiesPerTag] = useState(1);
  const [showPreview, setShowPreview] = useState(false);
  const [previewTags, setPreviewTags] = useState([]); // [{ kind: 'receipt'|'pallet', receipt, pallet? }]
  const [previewLoading, setPreviewLoading] = useState(false);

  const isFinishedGoodsReceipt = (receipt) => {
    if (!receipt) return false;
    const product = products.find((p) => p.id === receipt.productId);
    if (!product) return false;
    const category = categories.find((c) => c.id === product.categoryId);
    return category?.type === CATEGORY_TYPES.FINISHED;
  };


  // Filter receipts - only approved receipts with required data
  const availableReceipts = useMemo(() => {
    return receipts.filter(receipt => {
      // Only approved receipts
      if (receipt.status !== RECEIPT_STATUS.APPROVED) return false;

      // Must have product, lot number, and quantity
      if (!receipt.productId || !receipt.lotNo || !receipt.quantity) return false;

      // Company filter (CategoryGroup) — receipt's product must belong to a
      // category whose parent is the selected group.
      // Product Type filter — receipt's product's category.type must match.
      let receiptCategory = null;
      if (companyFilter !== 'all' || productTypeFilter !== 'all') {
        const product = products.find((p) => p.id === receipt.productId);
        if (!product) return false;
        receiptCategory = categories.find((c) => c.id === product.categoryId);
        if (!receiptCategory) return false;
        if (companyFilter !== 'all' && receiptCategory.parentId !== companyFilter) return false;
        if (productTypeFilter !== 'all' && receiptCategory.type !== productTypeFilter) return false;
      }

      // Filter by product
      if (productFilter !== 'all' && receipt.productId !== productFilter) return false;

      // Filter by search term — match product name, lot, FCC, OR any
      // cached pallet licence number for this receipt (so typing a pallet
      // ID surfaces the right receipt for a reprint).
      if (searchTerm) {
        const product = products.find(p => p.id === receipt.productId);
        const searchLower = searchTerm.toLowerCase();
        const matchesProduct = product?.name?.toLowerCase().includes(searchLower);
        const matchesLot = receipt.lotNo?.toLowerCase().includes(searchLower);
        const matchesFCC = product?.fcc?.toLowerCase().includes(searchLower);
        const cachedPallets = palletsByReceipt[receipt.id] || [];
        const matchesPallet = cachedPallets.some((p) =>
          (p.licence_number || '').toLowerCase().includes(searchLower)
        );
        if (!matchesProduct && !matchesLot && !matchesFCC && !matchesPallet) return false;
      }

      // For FG receipts: once we've fetched the pallet list and it has
      // zero in-building pallets, hide the receipt — nothing to tag.
      // We can't determine this until the fetch resolves, so receipts that
      // haven't been fetched yet remain visible (the prefetch effect below
      // will resolve them in the background).
      if (isFinishedGoodsReceipt(receipt) && palletsByReceipt[receipt.id]) {
        const inBuildingCount = palletsByReceipt[receipt.id].filter((p) =>
          IN_BUILDING_STATUSES.has(p.status)
        ).length;
        if (inBuildingCount === 0) return false;
      }

      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipts, products, categories, companyFilter, productTypeFilter, productFilter, searchTerm, palletsByReceipt]);

  // Background prefetch: for every FG receipt currently visible in the
  // filtered list, fetch its pallet licences if we don't have them yet.
  // This lets the "no in-building pallets" hide filter kick in shortly
  // after the list is rendered, so empty FG receipts vanish on their own.
  useEffect(() => {
    const toFetch = availableReceipts
      .filter((r) => isFinishedGoodsReceipt(r))
      .filter((r) => !palletsByReceipt[r.id] && !loadingReceiptIds.has(r.id));
    if (toFetch.length === 0) return;
    // Fire requests in parallel but cap concurrency so we don't pound the
    // API on a giant filter result.
    const MAX = 4;
    let i = 0;
    const worker = async () => {
      while (i < toFetch.length) {
        const idx = i++;
        const r = toFetch[idx];
        if (!r) return;
        try {
          await ensurePalletsLoaded(r.id);
        } catch (_) {
          // swallow — leave the receipt visible if fetch fails
        }
      }
    };
    Array.from({ length: Math.min(MAX, toFetch.length) }).forEach(() => worker());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableReceipts]);

  // Lazy-fetch a receipt's pallets the first time we need them (expansion,
  // preview, or select-all). Cached afterwards.
  const ensurePalletsLoaded = async (receiptId) => {
    if (palletsByReceipt[receiptId]) return palletsByReceipt[receiptId];
    setLoadingReceiptIds((prev) => new Set(prev).add(receiptId));
    try {
      const list = await fetchPalletLicences({ receipt_id: receiptId });
      const arr = Array.isArray(list) ? list : [];
      setPalletsByReceipt((prev) => ({ ...prev, [receiptId]: arr }));
      return arr;
    } finally {
      setLoadingReceiptIds((prev) => {
        const next = new Set(prev);
        next.delete(receiptId);
        return next;
      });
    }
  };

  const toggleExpand = async (receiptId) => {
    const willOpen = !expandedReceipts.has(receiptId);
    setExpandedReceipts((prev) => {
      const next = new Set(prev);
      if (willOpen) next.add(receiptId);
      else next.delete(receiptId);
      return next;
    });
    if (willOpen) {
      await ensurePalletsLoaded(receiptId);
    }
  };

  const togglePalletSelection = (palletId) => {
    setSelectedPallets((prev) => {
      const next = new Set(prev);
      if (next.has(palletId)) next.delete(palletId);
      else next.add(palletId);
      return next;
    });
  };

  // Initialize with preselected receipt
  useEffect(() => {
    if (preselectedReceiptId && availableReceipts.some(r => r.id === preselectedReceiptId)) {
      setSelectedReceipts(new Set([preselectedReceiptId]));
    }
  }, [preselectedReceiptId, availableReceipts]);

  // Generate barcodes for the RM/packaging tags (those still use the
  // legacy inline layout with svg refs). FG pallet tags are rendered
  // through <PalletStickerLayout>, which handles its own barcodes + QR.
  useEffect(() => {
    if (!showPreview || previewTags.length === 0) return;
    const timeoutId = setTimeout(() => {
      Array.from({ length: copiesPerTag }).forEach((_, copyIndex) => {
        previewTags.forEach((tag) => {
          if (tag.kind !== 'receipt') return;
          const receipt = tag.receipt;
          const product = products.find((p) => p.id === receipt.productId);
          // We only reach this branch for non-FG receipts — barcode 1 is
          // SID, barcode 2 is the receipt lot.
          const sid = product?.sid || '';
          const lotNo = receipt.lotNo || '';
          const tagKey = `${receipt.id}-${copyIndex}`;

          const el1 = document.getElementById(`barcode1-${tagKey}`);
          if (el1 && sid) {
            try {
              el1.textContent = '';
              JsBarcode(el1, sid, { format: 'CODE128', width: 2, height: 50, displayValue: false, margin: 10, background: '#ffffff', lineColor: '#000000' });
            } catch (e) { console.error('barcode1 render:', e); }
          }
          const el2 = document.getElementById(`barcode2-${tagKey}`);
          if (el2 && lotNo) {
            try {
              el2.textContent = '';
              JsBarcode(el2, lotNo, { format: 'CODE128', width: 2, height: 50, displayValue: false, margin: 10, background: '#ffffff', lineColor: '#000000' });
            } catch (e) { console.error('barcode2 render:', e); }
          }
        });
      });
    }, 100);
    return () => clearTimeout(timeoutId);
  }, [showPreview, previewTags, products, copiesPerTag]);

  const handleSelectReceipt = (receiptId) => {
    setSelectedReceipts((prev) => {
      const next = new Set(prev);
      if (next.has(receiptId)) {
        next.delete(receiptId);
        // When unchecking an FG receipt, also drop any individual pallet
        // selections under it so they don't linger and silently re-include
        // pallets next time the receipt is checked.
        const pallets = palletsByReceipt[receiptId] || [];
        if (pallets.length > 0) {
          setSelectedPallets((prevP) => {
            const nextP = new Set(prevP);
            for (const p of pallets) nextP.delete(p.id);
            return nextP;
          });
        }
      } else {
        next.add(receiptId);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedReceipts.size === availableReceipts.length) {
      setSelectedReceipts(new Set());
      setSelectedPallets(new Set());
    } else {
      setSelectedReceipts(new Set(availableReceipts.map((r) => r.id)));
    }
  };

  // Build the flat list of tags to print from current selections. For each
  // selected RM/packaging receipt → 1 tag. For each selected FG receipt →
  // one tag per pallet (explicitly checked pallets if any, else every
  // in-building pallet).
  const buildTagsToPrint = (palletData) => {
    const tags = [];
    for (const r of availableReceipts) {
      if (!selectedReceipts.has(r.id)) continue;
      if (isFinishedGoodsReceipt(r)) {
        const all = palletData[r.id] || [];
        const inBuilding = all.filter((p) => IN_BUILDING_STATUSES.has(p.status));
        const explicit = inBuilding.filter((p) => selectedPallets.has(p.id));
        const toTag = explicit.length > 0 ? explicit : inBuilding;
        for (const p of toTag) {
          tags.push({ kind: 'pallet', receipt: r, pallet: p });
        }
      } else {
        tags.push({ kind: 'receipt', receipt: r });
      }
    }
    return tags;
  };

  const handlePreview = async () => {
    setPreviewLoading(true);
    try {
      // Make sure every selected FG receipt has its pallets fetched.
      const fgReceiptsNeedingFetch = Array.from(selectedReceipts)
        .map((id) => availableReceipts.find((r) => r.id === id))
        .filter((r) => r && isFinishedGoodsReceipt(r) && !palletsByReceipt[r.id]);
      if (fgReceiptsNeedingFetch.length > 0) {
        await Promise.all(fgReceiptsNeedingFetch.map((r) => ensurePalletsLoaded(r.id)));
      }
      // After awaits, palletsByReceipt state may not have flushed for the
      // current closure — re-fetch synchronously into a local map for
      // buildTagsToPrint. We already updated state via ensurePalletsLoaded.
      const merged = { ...palletsByReceipt };
      for (const r of fgReceiptsNeedingFetch) {
        if (!merged[r.id]) {
          merged[r.id] = await fetchPalletLicences({ receipt_id: r.id });
        }
      }
      const tags = buildTagsToPrint(merged);
      setPreviewTags(tags);
      setShowPreview(true);
    } finally {
      setPreviewLoading(false);
    }
  };

  // Live count of tags that would print right now (for the button label).
  const projectedTagCount = useMemo(() => {
    let n = 0;
    for (const r of availableReceipts) {
      if (!selectedReceipts.has(r.id)) continue;
      if (isFinishedGoodsReceipt(r)) {
        const all = palletsByReceipt[r.id] || [];
        const inBuilding = all.filter((p) => IN_BUILDING_STATUSES.has(p.status));
        const explicit = inBuilding.filter((p) => selectedPallets.has(p.id));
        n += (explicit.length > 0 ? explicit.length : inBuilding.length) || 1;
      } else {
        n += 1;
      }
    }
    return n;
  }, // eslint-disable-next-line react-hooks/exhaustive-deps
  [selectedReceipts, selectedPallets, palletsByReceipt, availableReceipts, products, categories]);

  const handlePrint = () => {
    window.print();
  };

  const handleGeneratePDF = () => {
    // The PDF builder reproduces the legacy RM/packaging tag (SID barcode +
    // receipt-level quantity). FG pallet tags use the richer PalletStickerLayout
    // which depends on QR codes and SVG layouts that don't translate cleanly
    // into jsPDF — for those, use the browser Print button instead (this
    // matches the palletizer kiosk's workflow).
    const receiptTags = previewTags.filter((t) => t.kind === 'receipt');
    if (receiptTags.length === 0) {
      // Nothing PDF-able in this selection. Tell the user to use Print.
      alert('Selected tags are all finished-goods pallets. Use the Print button — it captures the kiosk-style pallet sticker layout. PDF export is supported for raw materials and packaging only.');
      return;
    }

    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: [101.6, 146.05], // 4" x 5.75"
    });

    let pageIndex = 0;
    Array.from({ length: copiesPerTag }).forEach(() => {
      receiptTags.forEach((tag) => {
        if (pageIndex > 0) pdf.addPage();
        pageIndex += 1;
        const receipt = tag.receipt;
        const product = products.find((p) => p.id === receipt.productId);

        const canvas1 = document.createElement('canvas');
        const canvas2 = document.createElement('canvas');
        const lotNo = receipt.lotNo || '';
        const sid = product?.sid || '';

        try {
          if (sid) {
            JsBarcode(canvas1, sid, { format: 'CODE128', width: 2, height: 50, displayValue: false, margin: 10, background: '#ffffff', lineColor: '#000000' });
          }
          if (lotNo) {
            JsBarcode(canvas2, lotNo, { format: 'CODE128', width: 2, height: 50, displayValue: false, margin: 10, background: '#ffffff', lineColor: '#000000' });
          }
        } catch (e) {
          console.error('Error generating barcodes for PDF:', e);
        }

        let yPos = 6;
        pdf.setFontSize(12);
        pdf.setFont(undefined, 'bold');
        pdf.text((product?.name || 'Unknown Product').toUpperCase(), 50.8, yPos, { align: 'center', maxWidth: 81.6 });
        yPos += 8;

        pdf.setDrawColor(0, 0, 0);
        pdf.line(10, yPos, 91.6, yPos);
        yPos += 5;

        if (canvas1.width > 0) {
          pdf.addImage(canvas1.toDataURL('image/png'), 'PNG', 10, yPos, 81.6, 14);
          yPos += 16;
        }

        pdf.line(10, yPos, 91.6, yPos);
        yPos += 5;

        pdf.setFontSize(14);
        pdf.setFont(undefined, 'bold');
        pdf.text((sid || '-').toUpperCase(), 50.8, yPos, { align: 'center' });
        yPos += 8;

        pdf.line(10, yPos, 91.6, yPos);
        yPos += 5;

        if (receipt.expiration) {
          const expDate = new Date(receipt.expiration);
          pdf.setFontSize(7);
          pdf.setFont(undefined, 'normal');
          pdf.text('BBD', 10, yPos);
          pdf.setFontSize(8);
          pdf.setFont(undefined, 'bold');
          pdf.text(formatDate(expDate.toISOString()), 10, yPos + 3);
        }
        yPos += 8;

        pdf.line(10, yPos, 91.6, yPos);
        yPos += 5;

        pdf.setFontSize(7);
        pdf.setFont(undefined, 'normal');
        pdf.text('Lot', 10, yPos);
        pdf.setFontSize(9);
        pdf.setFont(undefined, 'bold');
        pdf.text((lotNo || '-').toUpperCase(), 10, yPos + 3);
        yPos += 9;

        if (canvas2.width > 0) {
          pdf.addImage(canvas2.toDataURL('image/png'), 'PNG', 10, yPos, 81.6, 14);
        }
      });
    });

    pdf.save('pallet-tags.pdf');
  };

  const companyOptions = useMemo(() => {
    const groups = categories.filter((c) => c.type === 'group');
    return [
      { value: 'all', label: 'All Companies' },
      ...groups.map((g) => ({ value: g.id, label: g.name })),
    ];
  }, [categories]);

  const productOptions = useMemo(() => {
    // Filter products by selected company + product type so the searchable
    // picker only surfaces relevant items.
    const filtered = products.filter((p) => {
      if (companyFilter === 'all' && productTypeFilter === 'all') return true;
      const category = categories.find((c) => c.id === p.categoryId);
      if (!category) return false;
      if (companyFilter !== 'all' && category.parentId !== companyFilter) return false;
      if (productTypeFilter !== 'all' && category.type !== productTypeFilter) return false;
      return true;
    });
    return [
      { value: 'all', label: 'All Products' },
      ...filtered.map((p) => ({
        value: p.id,
        label: p.fcc ? `${p.name} (${p.fcc})` : p.name,
      })),
    ];
  }, [products, categories, companyFilter, productTypeFilter]);


  return (
    <div className="pallet-tag-print-page">
      <div className="page-header">
        <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
          ← Back to Dashboard
        </button>
        <div className="header-content">
          <h2>Print Pallet Tags</h2>
          <p className="muted">Select inventory items and generate printable pallet tags</p>
        </div>
      </div>

      {!showPreview ? (
        <div className="tag-selection-section">
          <div className="filters-panel">
            <div className="filter-row">
              <label>
                <span>Company</span>
                <select
                  value={companyFilter}
                  onChange={(e) => {
                    setCompanyFilter(e.target.value);
                    setProductFilter('all');
                  }}
                >
                  {companyOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>

              <label>
                <span>Product Type</span>
                <select
                  value={productTypeFilter}
                  onChange={(e) => {
                    setProductTypeFilter(e.target.value);
                    setProductFilter('all');
                  }}
                >
                  {PRODUCT_TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>

              <label>
                <span>Product</span>
                <SearchableSelect
                  options={productOptions}
                  value={productFilter}
                  onChange={(val) => setProductFilter(val || 'all')}
                  placeholder="All Products"
                  searchPlaceholder="Search products..."
                />
              </label>

              <label>
                <span>Search</span>
                <input
                  type="text"
                  placeholder="Search by product, lot, FCC, or pallet ID..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </label>
            </div>
          </div>

          <div className="selection-controls">
            <div className="selection-info">
              <span>
                {selectedReceipts.size} of {availableReceipts.length} selected · {projectedTagCount} tag{projectedTagCount === 1 ? '' : 's'} to print
              </span>
              <button onClick={handleSelectAll} className="link-button">
                {selectedReceipts.size === availableReceipts.length ? 'Deselect All' : 'Select All'}
              </button>
            </div>
            <button
              onClick={handlePreview}
              className="primary-button"
              disabled={selectedReceipts.size === 0 || previewLoading}
            >
              {previewLoading ? 'Loading…' : `Preview Tags (${projectedTagCount})`}
            </button>
          </div>

          <div className="receipts-list">
            <table>
              <thead>
                <tr>
                  <th style={{ width: '40px' }}>
                    <input
                      type="checkbox"
                      checked={selectedReceipts.size === availableReceipts.length && availableReceipts.length > 0}
                      onChange={handleSelectAll}
                    />
                  </th>
                  <th style={{ width: '32px' }}></th>
                  <th>Product</th>
                  <th>Lot Number</th>
                  <th>FCC Code</th>
                  <th>Quantity</th>
                  <th>Production Date</th>
                  <th>Expiration</th>
                  <th>Location</th>
                </tr>
              </thead>
              <tbody>
                {availableReceipts.map((receipt) => {
                  const product = products.find((p) => p.id === receipt.productId);
                  const location = locations.find((l) => l.id === receipt.location);
                  const isFG = isFinishedGoodsReceipt(receipt);
                  const isExpanded = expandedReceipts.has(receipt.id);
                  const isLoading = loadingReceiptIds.has(receipt.id);
                  const pallets = palletsByReceipt[receipt.id] || [];
                  const inBuilding = pallets.filter((p) => IN_BUILDING_STATUSES.has(p.status));
                  const inBuildingCount = inBuilding.length;
                  return (
                    <React.Fragment key={receipt.id}>
                      <tr>
                        <td>
                          <input
                            type="checkbox"
                            checked={selectedReceipts.has(receipt.id)}
                            onChange={() => handleSelectReceipt(receipt.id)}
                          />
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {isFG ? (
                            <button
                              type="button"
                              onClick={() => toggleExpand(receipt.id)}
                              className="link-button"
                              title={isExpanded ? 'Hide pallets' : 'Show pallets'}
                              style={{ padding: '0 4px' }}
                            >
                              {isExpanded ? '▾' : '▸'}
                            </button>
                          ) : null}
                        </td>
                        <td>
                          {product?.name || 'Unknown'}
                          {isFG && inBuildingCount > 0 && (
                            <span style={{ color: '#64748b', fontSize: '12px', marginLeft: '6px' }}>
                              ({inBuildingCount} pallet{inBuildingCount === 1 ? '' : 's'} in building)
                            </span>
                          )}
                        </td>
                        <td>{receipt.lotNo || '-'}</td>
                        <td>{product?.fcc || '-'}</td>
                        <td>{receipt.quantity} {receipt.quantityUnits || 'cases'}</td>
                        <td>{formatDate(receipt.productionDate)}</td>
                        <td>{formatDate(receipt.expiration)}</td>
                        <td>{location?.name || '-'}</td>
                      </tr>
                      {isFG && isExpanded && (
                        <tr>
                          <td></td>
                          <td colSpan={8} style={{ background: '#f9fafb', padding: '8px 12px' }}>
                            {isLoading ? (
                              <div style={{ color: '#64748b', fontSize: '13px' }}>Loading pallets…</div>
                            ) : inBuildingCount === 0 ? (
                              <div style={{ color: '#64748b', fontSize: '13px' }}>No in-building pallets for this receipt.</div>
                            ) : (() => {
                              const palletQuery = (palletSearchByReceipt[receipt.id] || '').trim().toLowerCase();
                              const visiblePallets = palletQuery
                                ? inBuilding.filter((p) =>
                                    (p.licence_number || '').toLowerCase().includes(palletQuery)
                                  )
                                : inBuilding;
                              return (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                                    <input
                                      type="text"
                                      value={palletSearchByReceipt[receipt.id] || ''}
                                      onChange={(e) =>
                                        setPalletSearchByReceipt((prev) => ({
                                          ...prev,
                                          [receipt.id]: e.target.value,
                                        }))
                                      }
                                      placeholder="Filter pallets…"
                                      style={{
                                        flex: '0 0 240px',
                                        padding: '4px 8px',
                                        fontSize: '12px',
                                        border: '1px solid #cbd5e1',
                                        borderRadius: '4px',
                                      }}
                                    />
                                    <span style={{ fontSize: '12px', color: '#475569' }}>
                                      {selectedReceipts.has(receipt.id)
                                        ? (selectedPallets.size > 0 && inBuilding.some((p) => selectedPallets.has(p.id))
                                            ? 'Only the checked pallets will print.'
                                            : 'All pallets below will print (no individual selection).')
                                        : 'Check the receipt above to include any of these pallets.'}
                                    </span>
                                    {palletQuery && (
                                      <span style={{ fontSize: '11px', color: '#9ca3af' }}>
                                        {visiblePallets.length} of {inBuildingCount} match
                                      </span>
                                    )}
                                  </div>
                                  <div
                                    style={{
                                      display: 'grid',
                                      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                                      gap: '4px 12px',
                                    }}
                                  >
                                    {visiblePallets.map((p) => {
                                      const checked = selectedPallets.has(p.id);
                                      return (
                                        <label
                                          key={p.id}
                                          style={{
                                            display: 'flex',
                                            gap: '8px',
                                            alignItems: 'center',
                                            fontSize: '13px',
                                            padding: '3px 6px',
                                            borderRadius: '4px',
                                            background: checked ? '#dcfce7' : 'transparent',
                                            cursor: 'pointer',
                                            minWidth: 0,
                                          }}
                                        >
                                          <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={() => togglePalletSelection(p.id)}
                                          />
                                          <span
                                            style={{
                                              fontFamily: 'monospace',
                                              fontWeight: 600,
                                              color: '#1e40af',
                                              overflow: 'hidden',
                                              textOverflow: 'ellipsis',
                                              whiteSpace: 'nowrap',
                                            }}
                                          >
                                            {p.licence_number}
                                          </span>
                                          <span style={{ color: '#64748b' }}>{p.cases || 0} cs</span>
                                          <span style={{ color: '#9ca3af', fontSize: '11px', marginLeft: 'auto' }}>
                                            {p.is_partial ? 'partial · ' : ''}{p.status}
                                          </span>
                                        </label>
                                      );
                                    })}
                                    {visiblePallets.length === 0 && (
                                      <div style={{ gridColumn: '1 / -1', color: '#64748b', fontSize: '12px', padding: '6px' }}>
                                        No pallets match "{palletQuery}".
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })()}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
            {availableReceipts.length === 0 && (
              <div className="empty-state">
                <p>No approved receipts found matching your filters.</p>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="tag-preview-section">
          <div className="preview-controls">
            <button onClick={() => setShowPreview(false)} className="secondary-button">
              ← Back to Selection
            </button>
            <div className="preview-options">
              <label>
                <span>Copies per tag:</span>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={copiesPerTag}
                  onChange={(e) => setCopiesPerTag(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                />
              </label>
              <button onClick={handleGeneratePDF} className="secondary-button">
                Generate PDF
              </button>
              <button onClick={handlePrint} className="primary-button">
                Print Tags
              </button>
            </div>
          </div>

          <div className="tags-preview print-area">
            {Array.from({ length: copiesPerTag }).map((_, copyIndex) =>
              previewTags.map((tag, idx) => {
                const receipt = tag.receipt;
                const product = products.find((p) => p.id === receipt.productId);

                // ─── FG pallet tag — uses the kiosk's PalletStickerLayout
                if (tag.kind === 'pallet') {
                  const p = tag.pallet;
                  return (
                    <PalletStickerLayout
                      key={`pallet-${p.id}-${copyIndex}`}
                      productName={product?.name || 'Unknown Product'}
                      fcc={product?.fcc || ''}
                      cases={p.cases || 0}
                      bbd={receipt.expiration || ''}
                      lot={receipt.lotNo || ''}
                      palletId={p.licence_number || ''}
                      orientation="portrait"
                      variant="primary"
                    />
                  );
                }

                // ─── RM / packaging receipt tag — existing inline layout
                const tagKey = `${receipt.id}-${copyIndex}-${idx}`;
                const sid = product?.sid || '-';
                return (
                  <div key={`receipt-${tagKey}`} className="pallet-tag">
                    <div className="tag-product-name">
                      {product?.name || 'Unknown Product'}
                    </div>
                    <div className="tag-divider"></div>
                    <div className="tag-barcode-container">
                      <svg id={`barcode1-${receipt.id}-${copyIndex}`} className="tag-barcode"></svg>
                    </div>
                    <div className="tag-divider"></div>
                    <div className="tag-fcc-code">{sid}</div>
                    <div className="tag-divider"></div>
                    {receipt.expiration && (
                      <div className="tag-bbd-section">
                        <span className="bbd-label">BBD</span>
                        <span className="bbd-value">{formatDate(receipt.expiration)}</span>
                      </div>
                    )}
                    <div className="tag-divider"></div>
                    <div className="tag-lot-section">
                      <span className="lot-label">Lot</span>
                      <span className="lot-value">{receipt.lotNo || '-'}</span>
                    </div>
                    <div className="tag-barcode-container">
                      <svg id={`barcode2-${receipt.id}-${copyIndex}`} className="tag-barcode"></svg>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default PalletTagPrintPage;

