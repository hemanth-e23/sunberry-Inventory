import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAppData } from '../context/AppDataContext';
import { useAuth } from '../context/AuthContext';
import { getDashboardPath } from '../App';
import SearchableSelect from './SearchableSelect';
import JsBarcode from 'jsbarcode';
import jsPDF from 'jspdf';
import './PalletTagPrintPage.css';
import './PalletTagPrintPageEnhanced.css';

const PalletTagPrintPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const {
    receipts,
    products,
    categories,
    productCategories,
    locations,
    subLocationMap
  } = useAppData();

  // Get pre-selected receipt from URL
  const preselectedReceiptId = searchParams.get('receiptId');

  const [selectedReceipts, setSelectedReceipts] = useState(new Set());
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [productFilter, setProductFilter] = useState('all');
  const [locationFilter, setLocationFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [copiesPerTag, setCopiesPerTag] = useState(1);
  const [showPreview, setShowPreview] = useState(false);
  const [previewReceipts, setPreviewReceipts] = useState([]);

  const barcodeRefs = useRef({});

  // Filter receipts - only approved receipts with required data
  const availableReceipts = useMemo(() => {
    return receipts.filter(receipt => {
      // Only approved receipts
      if (receipt.status !== 'approved') return false;

      // Must have product, lot number, and quantity
      if (!receipt.productId || !receipt.lotNo || !receipt.quantity) return false;

      // Filter by category
      if (categoryFilter !== 'all') {
        const product = products.find(p => p.id === receipt.productId);
        if (!product) return false;
        const category = categories.find(c => c.id === product.categoryId);
        if (!category) return false;
        if (category.parentId !== categoryFilter) return false;
      }

      // Filter by product
      if (productFilter !== 'all' && receipt.productId !== productFilter) return false;

      // Filter by location
      if (locationFilter !== 'all' && receipt.location !== locationFilter) return false;

      // Filter by search term
      if (searchTerm) {
        const product = products.find(p => p.id === receipt.productId);
        const searchLower = searchTerm.toLowerCase();
        const matchesProduct = product?.name?.toLowerCase().includes(searchLower);
        const matchesLot = receipt.lotNo?.toLowerCase().includes(searchLower);
        const matchesFCC = product?.fcc?.toLowerCase().includes(searchLower);
        if (!matchesProduct && !matchesLot && !matchesFCC) return false;
      }

      return true;
    });
  }, [receipts, products, categories, categoryFilter, productFilter, locationFilter, searchTerm]);

  // Initialize with preselected receipt
  useEffect(() => {
    if (preselectedReceiptId && availableReceipts.some(r => r.id === preselectedReceiptId)) {
      setSelectedReceipts(new Set([preselectedReceiptId]));
    }
  }, [preselectedReceiptId, availableReceipts]);

  // Generate barcodes when preview is shown
  useEffect(() => {
    if (showPreview && previewReceipts.length > 0) {
      // Small delay to ensure DOM is ready
      setTimeout(() => {
        Array.from({ length: copiesPerTag }).forEach((_, copyIndex) => {
          previewReceipts.forEach((receipt) => {
            const product = products.find(p => p.id === receipt.productId);
            const category = categories.find(c => c.id === product?.categoryId);
            const isFinishedGoods = category?.parentId === 'group-finished';

            const lotNo = receipt.lotNo || '';
            const tagKey = `${receipt.id}-${copyIndex}`;

            // Determine code for barcode 2: SID for raw materials, FCC for finished goods
            const codeForBarcode2 = isFinishedGoods
              ? (product?.fcc || '')
              : (product?.sid || '');

            // Generate barcode 1 (SID for raw materials, FCC for finished goods)
            const barcode1Id = `barcode1-${tagKey}`;
            const barcode1Element = document.getElementById(barcode1Id);
            if (barcode1Element && codeForBarcode2) {
              try {
                // Clear previous barcode - Safe: only clearing, not setting user content
                barcode1Element.textContent = '';
                JsBarcode(barcode1Element, codeForBarcode2, {
                  format: 'CODE128',
                  width: 2,
                  height: 50,
                  displayValue: false,
                  margin: 10,
                  background: '#ffffff',
                  lineColor: '#000000'
                });
              } catch (e) {
                console.error('Error generating barcode 1:', e);
              }
            }

            // Generate barcode 2 (lot number)
            const barcode2Id = `barcode2-${tagKey}`;
            const barcode2Element = document.getElementById(barcode2Id);
            if (barcode2Element && lotNo) {
              try {
                // Clear previous barcode - Safe: only clearing, not setting user content
                barcode2Element.textContent = '';
                JsBarcode(barcode2Element, lotNo, {
                  format: 'CODE128',
                  width: 2,
                  height: 50,
                  displayValue: false,
                  margin: 10,
                  background: '#ffffff',
                  lineColor: '#000000'
                });
              } catch (e) {
                console.error('Error generating barcode 2:', e);
              }
            }
          });
        });
      }, 100);
    }
  }, [showPreview, previewReceipts, products, categories, copiesPerTag]);

  const handleSelectReceipt = (receiptId) => {
    const newSelected = new Set(selectedReceipts);
    if (newSelected.has(receiptId)) {
      newSelected.delete(receiptId);
    } else {
      newSelected.add(receiptId);
    }
    setSelectedReceipts(newSelected);
  };

  const handleSelectAll = () => {
    if (selectedReceipts.size === availableReceipts.length) {
      setSelectedReceipts(new Set());
    } else {
      setSelectedReceipts(new Set(availableReceipts.map(r => r.id)));
    }
  };

  const handlePreview = () => {
    const selected = Array.from(selectedReceipts)
      .map(id => availableReceipts.find(r => r.id === id))
      .filter(Boolean);
    setPreviewReceipts(selected);
    setShowPreview(true);
  };

  const handlePrint = () => {
    window.print();
  };

  const handleGeneratePDF = () => {
    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: [101.6, 146.05] // Tag size: 4 inches x 5.75 inches (101.6mm x 146.05mm)
    });

    previewReceipts.forEach((receipt, index) => {
      if (index > 0) {
        pdf.addPage();
      }

      const product = products.find(p => p.id === receipt.productId);
      const category = categories.find(c => c.id === product?.categoryId);
      const isFinishedGoods = category?.parentId === 'group-finished';

      // Generate barcodes as canvas
      const canvas1 = document.createElement('canvas');
      const canvas2 = document.createElement('canvas');

      const lotNo = receipt.lotNo || '';
      // SID for raw materials, FCC for finished goods
      const codeForBarcode2 = isFinishedGoods
        ? (product?.fcc || '')
        : (product?.sid || '');

      try {
        if (codeForBarcode2) {
          JsBarcode(canvas1, codeForBarcode2, {
            format: 'CODE128',
            width: 2,
            height: 50,
            displayValue: false,
            margin: 10,
            background: '#ffffff',
            lineColor: '#000000'
          });
        }
        if (lotNo) {
          JsBarcode(canvas2, lotNo, {
            format: 'CODE128',
            width: 2,
            height: 50,
            displayValue: false,
            margin: 10,
            background: '#ffffff',
            lineColor: '#000000'
          });
        }
      } catch (e) {
        console.error('Error generating barcodes for PDF:', e);
      }

      // Add content to PDF - optimized for 4x5.75 inch (101.6mm x 146.05mm) sticker
      let yPos = 6;

      // Product Name - Top (large, bold, uppercase)
      pdf.setFontSize(12);
      pdf.setFont(undefined, 'bold');
      pdf.text((product?.name || 'Unknown Product').toUpperCase(), 50.8, yPos, { align: 'center', maxWidth: 81.6 });
      yPos += 8;

      // Horizontal line
      pdf.setDrawColor(0, 0, 0);
      pdf.line(10, yPos, 91.6, yPos);
      yPos += 5;

      // Barcode 1
      if (canvas1.width > 0) {
        const barcode1Data = canvas1.toDataURL('image/png');
        pdf.addImage(barcode1Data, 'PNG', 10, yPos, 81.6, 14);
        yPos += 16;
      }

      // Horizontal line
      pdf.line(10, yPos, 91.6, yPos);
      yPos += 5;

      // SID Code (for raw materials) or FCC Code (for finished goods)
      const displayCode = isFinishedGoods
        ? (product?.fcc || '-')
        : (product?.sid || '-');
      pdf.setFontSize(14);
      pdf.setFont(undefined, 'bold');
      pdf.text((displayCode || '-').toUpperCase(), 50.8, yPos, { align: 'center' });
      yPos += 8;

      // Horizontal line
      pdf.line(10, yPos, 91.6, yPos);
      yPos += 5;

      // Quantity (only for finished goods)
      if (isFinishedGoods) {
        pdf.setFontSize(8);
        pdf.setFont(undefined, 'normal');
        pdf.text('Quantity', 10, yPos);
        pdf.setFontSize(9);
        pdf.setFont(undefined, 'bold');
        const quantityText = `${receipt.quantity || 0} ${receipt.quantityUnits || 'cases'}`;
        pdf.text(quantityText, 10, yPos + 4);
        yPos += 9;

        // Horizontal line
        pdf.line(10, yPos, 91.6, yPos);
        yPos += 5;
      }

      // BBD only (no Produced date)
      if (receipt.expiration) {
        const expDate = new Date(receipt.expiration);
        pdf.setFontSize(7);
        pdf.setFont(undefined, 'normal');
        pdf.text('BBD', 10, yPos);
        pdf.setFontSize(8);
        pdf.setFont(undefined, 'bold');
        pdf.text(expDate.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }), 10, yPos + 3);
      }
      yPos += 8;

      // Horizontal line
      pdf.line(10, yPos, 91.6, yPos);
      yPos += 5;

      // Lot Number
      pdf.setFontSize(7);
      pdf.setFont(undefined, 'normal');
      pdf.text('Lot', 10, yPos);
      pdf.setFontSize(9);
      pdf.setFont(undefined, 'bold');
      pdf.text((receipt.lotNo || '-').toUpperCase(), 10, yPos + 3);
      yPos += 9;

      // Barcode 2 - Bottom
      if (canvas2.width > 0) {
        const barcode2Data = canvas2.toDataURL('image/png');
        pdf.addImage(barcode2Data, 'PNG', 10, yPos, 81.6, 14);
      }
    });

    pdf.save('pallet-tags.pdf');
  };

  const categoryGroups = useMemo(() => {
    return categories.filter(c => c.type === 'group');
  }, [categories]);

  const productOptions = useMemo(() => {
    return products.filter(p => {
      if (categoryFilter === 'all') return true;
      const category = categories.find(c => c.id === p.categoryId);
      return category?.parentId === categoryFilter;
    });
  }, [products, categories, categoryFilter]);

  const formatDate = (dateString) => {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  };

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
                <span>Category</span>
                <select value={categoryFilter} onChange={(e) => {
                  setCategoryFilter(e.target.value);
                  setProductFilter('all');
                }}>
                  <option value="all">All Categories</option>
                  {categoryGroups.map(group => (
                    <option key={group.id} value={group.id}>{group.name}</option>
                  ))}
                </select>
              </label>

              <label>
                <span>Product</span>
                <select value={productFilter} onChange={(e) => setProductFilter(e.target.value)}>
                  <option value="all">All Products</option>
                  {productOptions.map(product => (
                    <option key={product.id} value={product.id}>{product.name}</option>
                  ))}
                </select>
              </label>

              <label>
                <span>Location</span>
                <select value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)}>
                  <option value="all">All Locations</option>
                  {locations.map(location => (
                    <option key={location.id} value={location.id}>{location.name}</option>
                  ))}
                </select>
              </label>

              <label>
                <span>Search</span>
                <input
                  type="text"
                  placeholder="Search by product, lot, or FCC code..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </label>
            </div>
          </div>

          <div className="selection-controls">
            <div className="selection-info">
              <span>
                {selectedReceipts.size} of {availableReceipts.length} selected
              </span>
              <button onClick={handleSelectAll} className="link-button">
                {selectedReceipts.size === availableReceipts.length ? 'Deselect All' : 'Select All'}
              </button>
            </div>
            <button
              onClick={handlePreview}
              className="primary-button"
              disabled={selectedReceipts.size === 0}
            >
              Preview Tags ({selectedReceipts.size})
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
                {availableReceipts.map(receipt => {
                  const product = products.find(p => p.id === receipt.productId);
                  const location = locations.find(l => l.id === receipt.location);
                  return (
                    <tr key={receipt.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedReceipts.has(receipt.id)}
                          onChange={() => handleSelectReceipt(receipt.id)}
                        />
                      </td>
                      <td>{product?.name || 'Unknown'}</td>
                      <td>{receipt.lotNo || '-'}</td>
                      <td>{product?.fcc || '-'}</td>
                      <td>{receipt.quantity} {receipt.quantityUnits || 'cases'}</td>
                      <td>{formatDate(receipt.productionDate)}</td>
                      <td>{formatDate(receipt.expiration)}</td>
                      <td>{location?.name || '-'}</td>
                    </tr>
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
              previewReceipts.map((receipt, receiptIndex) => {
                const product = products.find(p => p.id === receipt.productId);
                const category = categories.find(c => c.id === product?.categoryId);
                const isFinishedGoods = category?.parentId === 'group-finished';
                const tagKey = `${receipt.id}-${copyIndex}`;

                // Determine code to display: SID for raw materials, FCC for finished goods
                const displayCode = isFinishedGoods
                  ? (product?.fcc || '-')
                  : (product?.sid || '-');

                return (
                  <div key={tagKey} className="pallet-tag">
                    {/* Product Name - Top */}
                    <div className="tag-product-name">
                      {product?.name || 'Unknown Product'}
                    </div>

                    {/* Horizontal Line */}
                    <div className="tag-divider"></div>

                    {/* Barcode 1 */}
                    <div className="tag-barcode-container">
                      <svg id={`barcode1-${tagKey}`} className="tag-barcode"></svg>
                    </div>

                    {/* Horizontal Line */}
                    <div className="tag-divider"></div>

                    {/* SID Code (for raw materials) or FCC Code (for finished goods) */}
                    <div className="tag-fcc-code">
                      {displayCode}
                    </div>

                    {/* Horizontal Line */}
                    <div className="tag-divider"></div>

                    {/* Quantity (only for finished goods) */}
                    {isFinishedGoods && (
                      <>
                        <div className="tag-quantity-section">
                          <span className="quantity-label">Quantity</span>
                          <span className="quantity-value">
                            {receipt.quantity || 0} {receipt.quantityUnits || 'cases'}
                          </span>
                        </div>

                        {/* Horizontal Line */}
                        <div className="tag-divider"></div>
                      </>
                    )}

                    {/* BBD only (no Produced date) */}
                    {receipt.expiration && (
                      <div className="tag-bbd-section">
                        <span className="bbd-label">BBD</span>
                        <span className="bbd-value">{formatDate(receipt.expiration)}</span>
                      </div>
                    )}

                    {/* Horizontal Line */}
                    <div className="tag-divider"></div>

                    {/* Lot Number */}
                    <div className="tag-lot-section">
                      <span className="lot-label">Lot</span>
                      <span className="lot-value">{receipt.lotNo || '-'}</span>
                    </div>

                    {/* Barcode 2 - Bottom */}
                    <div className="tag-barcode-container">
                      <svg id={`barcode2-${tagKey}`} className="tag-barcode"></svg>
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

