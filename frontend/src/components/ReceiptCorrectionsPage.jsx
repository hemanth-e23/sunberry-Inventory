import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../context/AppDataContext';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { getDashboardPath } from '../App';
import { formatDateTime } from '../utils/dateUtils';
import './Shared.css';
import './ReceiptCorrectionsPage.css';

const ReceiptCorrectionsPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { receipts, products, categories, vendors, updateReceipt, resubmitReceipt } = useAppData();
  const { addToast } = useToast();
  
  const [selectedReceipt, setSelectedReceipt] = useState(null);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);

  // Filter receipts that have been sent back. Accept the canonical 'sent_back'
  // enum value and the legacy 'sent-back' spelling (older rows, pre-migration),
  // plus 'recorded' receipts carrying a supervisor send-back note.
  const sentBackReceipts = useMemo(() => {
    return receipts.filter(receipt => {
      if (receipt.status === 'sent_back' || receipt.status === 'sent-back') return true;
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

  const handleSaveAndResubmit = async () => {
    if (!selectedReceipt || saving) return;
    setSaving(true);

    // Save the corrected fields, then move the receipt back into the approval
    // queue via the dedicated resubmit endpoint. Both calls are checked — on
    // failure we keep the detail view open so the corrections aren't lost.
    const upd = await updateReceipt(selectedReceipt.id, { ...draft });
    if (upd && upd.success === false) {
      addToast(upd.message || upd.error || 'Failed to save corrections.', 'error');
      setSaving(false);
      return;
    }
    const res = await resubmitReceipt(selectedReceipt.id);
    setSaving(false);
    if (!res?.success) {
      addToast(res?.error || res?.message || 'Failed to resubmit receipt.', 'error');
      return;
    }

    // Close the detail view only after a confirmed success.
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
                    <span>Quantity (read-only)</span>
                    {/* Quantity is derived server-side (container count × weight);
                        correct the container fields via approvals instead of
                        editing the number directly. */}
                    <input type="number" value={draft.quantity || ''} readOnly disabled />
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
                    <span>SID (read-only)</span>
                    {/* SID and Brix live on the PRODUCT, not the receipt — edits
                        here could never persist. Shown for reference only; change
                        them on the product in Master Data. */}
                    <input type="text" value={draft.sid || ''} readOnly disabled placeholder="Supplier ID" />
                  </label>

                  <label>
                    <span>Brix (read-only)</span>
                    <input type="text" value={draft.brix || ''} readOnly disabled placeholder="Brix level" />
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
                <button className="primary-button" onClick={handleSaveAndResubmit} disabled={saving}>
                  {saving ? 'Saving…' : 'Save & Resubmit for Approval'}
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
