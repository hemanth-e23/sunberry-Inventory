import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../context/AppDataContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import ReturnModal from './staging/ReturnModal';
import { pluralizeUnit } from '../utils/rowSources';
import { getDashboardPath } from '../App';
import apiClient from '../api/client';
import { formatDateTime } from '../utils/dateUtils';
import {
  ACTIVE_STAGING_STATUSES,
  STAGING_ITEM_STATUS_LABELS,
  stagingItemMatchesFilter,
} from '../utils/stagingDesk';
import './Shared.css';

// `pallets_staged` stores the CONTAINER count for counted lots (drums/bags
// pulled) and a pallet count only for legacy ones — labelling it "Pallets"
// showed "Pallets Staged: 50.00" for one pallet of bags (2026-09-29 audit).
const stagedFootprintLabel = (item) => {
  const cu = item?.receipt?.container_unit;
  if (!cu) return 'Pallets staged';
  const plural = pluralizeUnit(String(cu));
  return `${plural.charAt(0).toUpperCase()}${plural.slice(1)} staged`;
};

import './StagingOverview.css';

const StagingOverview = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { products, receipts } = useAppData();
  const { addToast } = useToast();

  const [stagingItems, setStagingItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterStatus, setFilterStatus] = useState('active'); // active, all, or one status
  const [filterProduct, setFilterProduct] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');

  // Modal states
  const [showMarkUsedModal, setShowMarkUsedModal] = useState(false);
  const [selectedItem, setSelectedItem] = useState(null);
  const [markUsedQuantity, setMarkUsedQuantity] = useState('');
  // The Return dialog is the Production Requests one (N7): `{ item, details }`.
  const [returnProps, setReturnProps] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const productLookup = {};
  products.forEach(p => { productLookup[p.id] = p; });

  useEffect(() => {
    fetchStagingItems();
  }, []);

  const fetchStagingItems = async () => {
    try {
      setLoading(true);
      setError('');
      // EVERY staged item; the filter below narrows it. With no status the
      // server returns only the active ones, which is why "All" showed only
      // partially-returned items (browser test PART 3, B8).
      const response = await apiClient.get('/inventory/staging/items', {
        params: { status_filter: 'all' },
      });
      
      // Ensure response.data is an array
      if (Array.isArray(response.data)) {
        setStagingItems(response.data);
      } else {
        setStagingItems([]);
        console.warn('Unexpected response format:', response.data);
      }
    } catch (err) {
      console.error('Error fetching staging items:', err);
      console.error('Error response:', err.response?.data);
      console.error('Error status:', err.response?.status);
      const errorMessage = err.response?.data?.detail || err.message || 'Failed to load staging items.';
      setError(errorMessage);
      setStagingItems([]);
    } finally {
      setLoading(false);
    }
  };

  const handleMarkUsed = (item) => {
    const available = item.quantity_staged - item.quantity_used - item.quantity_returned;
    setSelectedItem(item);
    setMarkUsedQuantity(available.toString());
    setShowMarkUsedModal(true);
  };

  // Same dialog as Production Requests (N7): full drums + weighed partial,
  // any active rack, the original rack by default.
  const handleReturn = async (item) => {
    setError('');
    try {
      const { data: detail } = await apiClient.get(`/inventory/staging/${item.id}/return-details`);
      setReturnProps({
        item: {
          ingredient_name: productLookup[item.product_id]?.name || 'Unknown',
          id: item.id,
        },
        details: [{ ...detail, lot_number: detail.lot_number ?? item.receipt?.lot_number ?? '—' }],
      });
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not load this staged item.');
    }
  };

  const submitReturnDetail = (detail, body) => apiClient.post(
    `/inventory/staging/${detail.staging_item_id}/return`,
    {
      quantity: body.quantity,
      to_location_id: body.to_location_id || null,
      to_sub_location_id: body.to_sub_location_id || null,
      to_storage_row_id: body.to_storage_row_id || null,
      full_units: body.full_units ?? null,
      weighed_partial_qty: body.weighed_partial_qty ?? null,
    },
  );

  const submitMarkUsed = async () => {
    if (!selectedItem || !markUsedQuantity || parseFloat(markUsedQuantity) <= 0) {
      setError('Please enter a valid quantity.');
      return;
    }

    const available = selectedItem.quantity_staged - selectedItem.quantity_used - selectedItem.quantity_returned;
    if (parseFloat(markUsedQuantity) > available) {
      const unit = selectedItem.receipt?.unit || receipts.find(r => r.id === selectedItem.receipt_id)?.quantityUnits || 'units';
      setError(`Cannot use more than available (${available} ${unit}).`);
      return;
    }

    setIsSubmitting(true);
    try {
      await apiClient.post(`/inventory/staging/${selectedItem.id}/mark-used`, {
        quantity: parseFloat(markUsedQuantity),
      });
      setShowMarkUsedModal(false);
      setSelectedItem(null);
      setMarkUsedQuantity('');
      setError('');
      fetchStagingItems();
      // A toast, never alert(): a native alert blocks the whole tab until it
      // is dismissed — the "page froze ~1 minute" after Mark as Used (N9).
      addToast('Marked as used.', 'success');
    } catch (err) {
      console.error('Error marking item as used:', err);
      setError(err.response?.data?.detail || 'Failed to mark item as used.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const filteredItems = stagingItems.filter(item => {
    if (!stagingItemMatchesFilter(item, filterStatus)) {
      return false;
    }
    
    if (filterProduct !== 'all' && item.product_id !== filterProduct) {
      return false;
    }
    
    if (searchTerm) {
      const product = productLookup[item.product_id];
      const productName = product?.name || '';
      const lotNumber = item.receipt?.lot_number || '';
      const searchLower = searchTerm.toLowerCase();
      return productName.toLowerCase().includes(searchLower) || 
             lotNumber.toLowerCase().includes(searchLower);
    }
    
    return true;
  });

  const getStatusBadge = (status) => {
    const badges = {
      'staged': { label: STAGING_ITEM_STATUS_LABELS.staged, className: 'status-badge staged' },
      'partially_used': { label: STAGING_ITEM_STATUS_LABELS.partially_used, className: 'status-badge partially-used' },
      'used': { label: STAGING_ITEM_STATUS_LABELS.used, className: 'status-badge used' },
      'returned': { label: STAGING_ITEM_STATUS_LABELS.returned, className: 'status-badge returned' },
      'partially_returned': { label: STAGING_ITEM_STATUS_LABELS.partially_returned, className: 'status-badge partially-returned' },
      'completed': { label: STAGING_ITEM_STATUS_LABELS.completed, className: 'status-badge used' },
    };
    return badges[status] || { label: status, className: 'status-badge' };
  };

  if (loading) {
    return (
      <div className="staging-overview">
        <div className="page-header">
          <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
            ← Back to Dashboard
          </button>
          <div className="header-content">
            <h2>Staging Overview</h2>
          </div>
        </div>
        <div style={{ padding: '2rem', textAlign: 'center' }}>Loading staging items...</div>
      </div>
    );
  }

  return (
    <div className="staging-overview">
      <div className="page-header">
        <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
          ← Back to Dashboard
        </button>
        <div className="header-content">
          <h2>Staging Overview</h2>
          <p className="muted">View and manage items currently in staging</p>
        </div>
      </div>

      <div className="filters-section" style={{ marginBottom: '1.5rem', padding: '1rem', backgroundColor: '#f5f5f5', borderRadius: '4px' }}>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <label>
            <span>Status:</span>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="active">Active (still in staging)</option>
              <option value="all">All</option>
              {Object.entries(STAGING_ITEM_STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          
          <label>
            <span>Product:</span>
            <select value={filterProduct} onChange={(e) => setFilterProduct(e.target.value)}>
              <option value="all">All Products</option>
              {products.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          
          <label style={{ flex: 1, minWidth: '200px' }}>
            <span>Search:</span>
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search by product or lot number..."
            />
          </label>
        </div>
      </div>

      {error && (
        <div className="error-message" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      <div className="staging-table-container">
        <table className="staging-table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Lot Number</th>
              <th>Staged Quantity</th>
              <th>Used</th>
              <th>Returned</th>
              <th>Available</th>
              <th>Staged Date</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.length === 0 ? (
              <tr>
                <td colSpan="9" style={{ textAlign: 'center', padding: '2rem' }}>
                  {filterStatus === 'active' 
                    ? 'No active staging items found.' 
                    : 'No staging items found.'}
                </td>
              </tr>
            ) : (
              filteredItems.map(item => {
                const product = productLookup[item.product_id];
                const receipt = receipts.find(r => r.id === item.receipt_id);
                const unit = item.receipt?.unit || receipt?.quantityUnits || 'cases';
                const available = item.quantity_staged - item.quantity_used - item.quantity_returned;
                const statusBadge = getStatusBadge(item.status);
                const canAction = available > 0.001 && ACTIVE_STAGING_STATUSES.includes(item.status);
                
                return (
                  <tr key={item.id}>
                    <td>{product?.name || 'Unknown'}</td>
                    <td>{item.receipt?.lot_number || item.receipt_id || '-'}</td>
                    <td className="text-right">{item.quantity_staged.toLocaleString()} {unit}</td>
                    <td className="text-right">{item.quantity_used.toLocaleString()} {unit}</td>
                    <td className="text-right">{item.quantity_returned.toLocaleString()} {unit}</td>
                    <td className="text-right"><strong>{available.toLocaleString()} {unit}</strong></td>
                    <td>{formatDateTime(item.staged_at) || '-'}</td>
                    <td>
                      <span className={statusBadge.className}>{statusBadge.label}</span>
                      {item.hold_message && (
                        <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#991b1b' }} title={item.hold_message}>
                          ON HOLD
                        </div>
                      )}
                    </td>
                    <td>
                      {canAction && (
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                          <button
                            onClick={() => handleMarkUsed(item)}
                            className="primary-button"
                            disabled={Boolean(item.hold_message)}
                            title={item.hold_message || ''}
                            style={{ padding: '0.25rem 0.75rem', fontSize: '0.875rem' }}
                          >
                            Mark Used
                          </button>
                          <button
                            onClick={() => handleReturn(item)}
                            className="secondary-button"
                            style={{ padding: '0.25rem 0.75rem', fontSize: '0.875rem' }}
                          >
                            Return
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Mark Used Modal */}
      {showMarkUsedModal && selectedItem && (() => {
        const receipt = receipts.find(r => r.id === selectedItem.receipt_id);
        const unit = selectedItem.receipt?.unit || receipt?.quantityUnits || 'cases';
        const available = selectedItem.quantity_staged - selectedItem.quantity_used - selectedItem.quantity_returned;
        return (
          <div className="modal-overlay" onClick={() => !isSubmitting && setShowMarkUsedModal(false)}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              <h3>Mark as Used for Production</h3>
              {selectedItem.hold_message && (
                <p role="alert" style={{ color: '#991b1b', fontWeight: 600 }}>{selectedItem.hold_message}</p>
              )}
              <div style={{ marginBottom: '1rem' }}>
                <p><strong>Product:</strong> {productLookup[selectedItem.product_id]?.name || 'Unknown'}</p>
                <p><strong>Lot:</strong> {selectedItem.receipt?.lot_number || '-'}</p>
                <p><strong>Available:</strong> {available.toLocaleString()} {unit}</p>
                {selectedItem.pallets_staged && (
                  <p style={{ fontSize: '0.875rem', color: '#666' }}>
                    <strong>{stagedFootprintLabel(selectedItem)}:</strong> {selectedItem.pallets_staged.toFixed(2)} 
                    {selectedItem.pallets_used > 0 && ` (Used: ${selectedItem.pallets_used.toFixed(2)})`}
                  </p>
                )}
              </div>
              <label>
                <span>Quantity Used ({unit}):</span>
              <input
                type="number"
                value={markUsedQuantity}
                onChange={(e) => setMarkUsedQuantity(e.target.value)}
                min="0.01"
                step="0.01"
                required
              />
            </label>
            <div className="modal-actions">
              <button
                onClick={() => setShowMarkUsedModal(false)}
                className="secondary-button"
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                onClick={submitMarkUsed}
                className="primary-button"
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Processing...' : 'Mark as Used'}
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Return — the Production Requests dialog (N7) */}
      {returnProps && (
        <ReturnModal
          requestId={null}
          item={returnProps.item}
          details={returnProps.details}
          submitDetail={submitReturnDetail}
          onClose={() => setReturnProps(null)}
          onSuccess={fetchStagingItems}
        />
      )}
    </div>
  );
};

export default StagingOverview;
