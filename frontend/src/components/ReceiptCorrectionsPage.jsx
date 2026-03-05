import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../context/AppDataContext';
import { useAuth } from '../context/AuthContext';
import { getDashboardPath } from '../App';
import { formatDateTime } from '../utils/dateUtils';
import './Shared.css';
import './ReceiptCorrectionsPage.css';

const ReceiptCorrectionsPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { receipts, products, categories, vendors, updateReceipt, updateReceiptStatus } = useAppData();
  
  const [selectedReceipt, setSelectedReceipt] = useState(null);
  const [draft, setDraft] = useState({});

  // Filter receipts that have been sent back (status: "sent-back", or legacy: "recorded" with supervisor notes)
  const sentBackReceipts = useMemo(() => {
    return receipts.filter(receipt => {
      if (receipt.status === 'sent-back') return true;
      if (receipt.status !== 'recorded') return false;
      return receipt.note && receipt.note.includes('[Sent Back by');
    });
  }, [receipts]);

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

  const handleOpenReceipt = (receiptId) => {
    const receipt = receipts.find(r => r.id === receiptId);
    if (receipt) {
      setSelectedReceipt(receipt);
      setDraft({
        receiptDate: receipt.receiptDate || '',
        lotNo: receipt.lotNo || '',
        quantity: receipt.quantity || '',
        quantityUnits: receipt.quantityUnits || '',
        expiration: receipt.expiration || '',
        vendorId: receipt.vendorId || '',
        bol: receipt.bol || '',
        purchaseOrder: receipt.purchaseOrder || '',
        sid: receipt.sid || '',
        brix: receipt.brix || '',
        note: receipt.note || '',
        location: receipt.location || '',
        subLocation: receipt.subLocation || ''
      });
    }
  };

  const handleDraftChange = (field, value) => {
    setDraft(prev => ({ ...prev, [field]: value }));
  };

  const handleSaveAndResubmit = () => {
    if (!selectedReceipt) return;
    
    // Update the receipt with corrections and set status to "reviewed" so it returns to approval queue
    updateReceipt(selectedReceipt.id, { ...draft, status: "reviewed" });
    
    // Update local state so UI reflects immediately
    updateReceiptStatus(selectedReceipt.id, "reviewed", "warehouse-user");
    
    // Close the detail view
    setSelectedReceipt(null);
    setDraft({});
  };

  const handleCancel = () => {
    setSelectedReceipt(null);
    setDraft({});
  };

  const extractSupervisorInstructions = (note) => {
    if (!note) return '';
    const match = note.match(/\[Sent Back by Supervisor\]:\s*(.*?)(?:\n|$)/);
    return match ? match[1].trim() : '';
  };


  const formatReceiptLabel = (receipt) => {
    const product = productLookup[receipt.productId];
    const category = categoryLookup[receipt.categoryId];
    return `${product?.name || 'Unknown'} · Lot ${receipt.lotNo || '-'} · ${category?.name || ''}`;
  };

  return (
    <div className="receipt-corrections-page">
      <div className="page-header">
        <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
          ← Back to Dashboard
        </button>
        <div className="header-content">
          <h2>Receipt Corrections</h2>
          <p className="muted">Review and fix receipts that were sent back by supervisors.</p>
        </div>
      </div>

      <div className="corrections-layout">
        <div className="sent-back-list">
          <h3>Sent Back Receipts ({sentBackReceipts.length})</h3>
          {sentBackReceipts.length === 0 ? (
            <div className="empty-state">
              <p>No receipts have been sent back for corrections.</p>
            </div>
          ) : (
            <div className="receipt-cards">
              {sentBackReceipts.map(receipt => {
                const product = productLookup[receipt.productId];
                const category = categoryLookup[receipt.categoryId];
                const instructions = extractSupervisorInstructions(receipt.note);
                
                return (
                  <div key={receipt.id} className="receipt-card">
                    <div className="card-header">
                      <h4>{product?.name || 'Unknown Product'}</h4>
                      <span className="category-badge">{category?.name || 'Uncategorized'}</span>
                    </div>
                    
                    <div className="card-details">
                      <div className="detail-item">
                        <span className="label">Lot:</span>
                        <span className="value">{receipt.lotNo || '—'}</span>
                      </div>
                      <div className="detail-item">
                        <span className="label">Quantity:</span>
                        <span className="value">{receipt.quantity} {receipt.quantityUnits}</span>
                      </div>
                      <div className="detail-item">
                        <span className="label">Submitted:</span>
                        <span className="value">{formatDateTime(receipt.submittedAt)}</span>
                      </div>
                    </div>

                    {instructions && (
                      <div className="supervisor-instructions">
                        <h5>Supervisor Instructions:</h5>
                        <p>{instructions}</p>
                      </div>
                    )}

                    <div className="card-actions">
                      <button 
                        className="primary-button"
                        onClick={() => handleOpenReceipt(receipt.id)}
                      >
                        Review & Fix
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {selectedReceipt && (
          <div className="correction-detail">
            <div className="detail-header">
              <h3>Fix Receipt: {formatReceiptLabel(selectedReceipt)}</h3>
              <button className="link-button" onClick={handleCancel}>
                Close
              </button>
            </div>

            <div className="detail-content">
              <div className="instructions-section">
                <h4>Supervisor Instructions</h4>
                <div className="instructions-box">
                  {extractSupervisorInstructions(selectedReceipt.note) || 'No specific instructions provided.'}
                </div>
              </div>

              <div className="form-section">
                <h4>Receipt Details</h4>
                <div className="form-grid">
                  <label>
                    <span>Receipt Date</span>
                    <input
                      type="date"
                      value={draft.receiptDate || ''}
                      onChange={(e) => handleDraftChange('receiptDate', e.target.value)}
                    />
                  </label>

                  <label>
                    <span>Lot Number</span>
                    <input
                      type="text"
                      value={draft.lotNo || ''}
                      onChange={(e) => handleDraftChange('lotNo', e.target.value)}
                    />
                  </label>

                  <label>
                    <span>Quantity</span>
                    <input
                      type="number"
                      value={draft.quantity || ''}
                      onChange={(e) => handleDraftChange('quantity', e.target.value)}
                    />
                  </label>

                  <label>
                    <span>Units</span>
                    <input
                      type="text"
                      value={draft.quantityUnits || ''}
                      onChange={(e) => handleDraftChange('quantityUnits', e.target.value)}
                    />
                  </label>

                  <label>
                    <span>Expiration</span>
                    <input
                      type="date"
                      value={draft.expiration || ''}
                      onChange={(e) => handleDraftChange('expiration', e.target.value)}
                    />
                  </label>

                  <label>
                    <span>Vendor</span>
                    <select
                      value={draft.vendorId || ''}
                      onChange={(e) => handleDraftChange('vendorId', e.target.value)}
                    >
                      <option value="">Select vendor</option>
                      {vendors.map(vendor => (
                        <option key={vendor.id} value={vendor.id}>{vendor.name}</option>
                      ))}
                    </select>
                  </label>

                  <label>
                    <span>BOL</span>
                    <input
                      type="text"
                      value={draft.bol || ''}
                      onChange={(e) => handleDraftChange('bol', e.target.value)}
                      placeholder="Bill of Lading number"
                    />
                  </label>

                  <label>
                    <span>Purchase Order</span>
                    <input
                      type="text"
                      value={draft.purchaseOrder || ''}
                      onChange={(e) => handleDraftChange('purchaseOrder', e.target.value)}
                      placeholder="Purchase order number"
                    />
                  </label>

                  <label>
                    <span>SID</span>
                    <input
                      type="text"
                      value={draft.sid || ''}
                      onChange={(e) => handleDraftChange('sid', e.target.value)}
                      placeholder="Supplier ID"
                    />
                  </label>

                  <label>
                    <span>Brix</span>
                    <input
                      type="text"
                      value={draft.brix || ''}
                      onChange={(e) => handleDraftChange('brix', e.target.value)}
                      placeholder="Brix level"
                    />
                  </label>

                  <label className="full-width">
                    <span>Notes</span>
                    <textarea
                      value={draft.note || ''}
                      onChange={(e) => handleDraftChange('note', e.target.value)}
                      rows={3}
                      placeholder="Additional notes or corrections made"
                    />
                  </label>
                </div>
              </div>

              <div className="detail-actions">
                <button className="secondary-button" onClick={handleCancel}>
                  Cancel
                </button>
                <button className="primary-button" onClick={handleSaveAndResubmit}>
                  Save & Resubmit for Approval
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ReceiptCorrectionsPage;
