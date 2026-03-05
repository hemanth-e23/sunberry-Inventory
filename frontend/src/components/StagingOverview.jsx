import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../context/AppDataContext';
import { useAuth } from '../context/AuthContext';
import { getDashboardPath } from '../App';
import apiClient from '../api/client';
import { formatDateTime } from '../utils/dateUtils';
import './Shared.css';
import './StagingOverview.css';

const StagingOverview = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { products, locations, subLocationMap, storageAreas, receipts } = useAppData();

  const [stagingItems, setStagingItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterStatus, setFilterStatus] = useState('active'); // active, all
  const [filterProduct, setFilterProduct] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');

  // Modal states
  const [showMarkUsedModal, setShowMarkUsedModal] = useState(false);
  const [showReturnModal, setShowReturnModal] = useState(false);
  const [selectedItem, setSelectedItem] = useState(null);
  const [markUsedQuantity, setMarkUsedQuantity] = useState('');
  const [returnQuantity, setReturnQuantity] = useState('');
  const [returnLocation, setReturnLocation] = useState('');
  const [returnSubLocation, setReturnSubLocation] = useState('');
  const [returnStorageRow, setReturnStorageRow] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  // Get available storage rows for return location
  const returnLocationRows = useMemo(() => {
    if (!returnLocation) return [];
    const rows = [];
    storageAreas.forEach(area => {
      if (area.locationId === returnLocation) {
        area.rows?.forEach(row => {
          rows.push({
            id: row.id,
            name: `${area.name} / ${row.name}`,
            available: (row.palletCapacity || 0) - (row.occupiedPallets || 0)
          });
        });
      }
    });
    // Also check sub-locations
    (subLocationMap[returnLocation] || []).forEach(sub => {
      // Check if sub-location has rows
      storageAreas.forEach(area => {
        if (area.subLocationId === sub.id) {
          area.rows?.forEach(row => {
            rows.push({
              id: row.id,
              name: `${area.name} / ${row.name}`,
              available: (row.palletCapacity || 0) - (row.occupiedPallets || 0)
            });
          });
        }
      });
    });
    return rows;
  }, [returnLocation, storageAreas, subLocationMap]);

  const productLookup = {};
  products.forEach(p => { productLookup[p.id] = p; });

  useEffect(() => {
    fetchStagingItems();
  }, [filterStatus]);

  const fetchStagingItems = async () => {
    try {
      setLoading(true);
      setError('');
      const statusParam = filterStatus === 'active' ? null : 'all';
      const response = await apiClient.get('/inventory/staging/items', {
        params: statusParam ? { status_filter: statusParam } : undefined,
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

  const handleReturn = (item) => {
    const available = item.quantity_staged - item.quantity_used - item.quantity_returned;
    setSelectedItem(item);
    setReturnQuantity(available.toString());
    setReturnLocation('');
    setReturnSubLocation('');
    setReturnStorageRow('');
    setShowReturnModal(true);
  };

  const submitMarkUsed = async () => {
    if (!selectedItem || !markUsedQuantity || parseFloat(markUsedQuantity) <= 0) {
      setError('Please enter a valid quantity.');
      return;
    }

    const available = selectedItem.quantity_staged - selectedItem.quantity_used - selectedItem.quantity_returned;
    if (parseFloat(markUsedQuantity) > available) {
      setError(`Cannot use more than available (${available} cases).`);
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
      alert('Item marked as used successfully!');
    } catch (err) {
      console.error('Error marking item as used:', err);
      setError(err.response?.data?.detail || 'Failed to mark item as used.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const submitReturn = async () => {
    if (!selectedItem || !returnQuantity || parseFloat(returnQuantity) <= 0) {
      setError('Please enter a valid quantity.');
      return;
    }

    if (!returnLocation) {
      setError('Please select a return location.');
      return;
    }

    const available = selectedItem.quantity_staged - selectedItem.quantity_used - selectedItem.quantity_returned;
    if (parseFloat(returnQuantity) > available) {
      setError(`Cannot return more than available (${available} cases).`);
      return;
    }

    setIsSubmitting(true);
    try {
      await apiClient.post(`/inventory/staging/${selectedItem.id}/return`, {
        quantity: parseFloat(returnQuantity),
        to_location_id: returnLocation,
        to_sub_location_id: returnSubLocation || null,
        to_storage_row_id: returnStorageRow || null,
      });
      setShowReturnModal(false);
      setSelectedItem(null);
      setReturnQuantity('');
      setReturnLocation('');
      setReturnSubLocation('');
      setReturnStorageRow('');
      setError('');
      fetchStagingItems();
      alert('Item returned successfully!');
    } catch (err) {
      console.error('Error returning item:', err);
      setError(err.response?.data?.detail || 'Failed to return item.');
    } finally {
      setIsSubmitting(false);
    }
  };


  const filteredItems = stagingItems.filter(item => {
    // Calculate available quantity
    const available = item.quantity_staged - item.quantity_used - item.quantity_returned;
    
    // Exclude items with 0 or negative available quantity
    if (available <= 0) {
      return false;
    }
    
    if (filterStatus === 'active') {
      if (!['staged', 'partially_used', 'partially_returned'].includes(item.status)) {
        return false;
      }
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
      'staged': { label: 'Staged', className: 'status-badge staged' },
      'partially_used': { label: 'Partially Used', className: 'status-badge partially-used' },
      'used': { label: 'Used', className: 'status-badge used' },
      'returned': { label: 'Returned', className: 'status-badge returned' },
      'partially_returned': { label: 'Partially Returned', className: 'status-badge partially-returned' }
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
              <option value="active">Active (Staged/Partially Used)</option>
              <option value="all">All</option>
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
                const canAction = available > 0 && ['staged', 'partially_used', 'partially_returned'].includes(item.status);
                
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
                    </td>
                    <td>
                      {canAction && (
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                          <button
                            onClick={() => handleMarkUsed(item)}
                            className="primary-button"
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
              <div style={{ marginBottom: '1rem' }}>
                <p><strong>Product:</strong> {productLookup[selectedItem.product_id]?.name || 'Unknown'}</p>
                <p><strong>Lot:</strong> {selectedItem.receipt?.lot_number || '-'}</p>
                <p><strong>Available:</strong> {available.toLocaleString()} {unit}</p>
                {selectedItem.pallets_staged && (
                  <p style={{ fontSize: '0.875rem', color: '#666' }}>
                    <strong>Pallets Staged:</strong> {selectedItem.pallets_staged.toFixed(2)} 
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

      {/* Return Modal */}
      {showReturnModal && selectedItem && (() => {
        const receipt = receipts.find(r => r.id === selectedItem.receipt_id);
        const unit = selectedItem.receipt?.unit || receipt?.quantityUnits || 'cases';
        const available = selectedItem.quantity_staged - selectedItem.quantity_used - selectedItem.quantity_returned;
        return (
          <div className="modal-overlay" onClick={() => !isSubmitting && setShowReturnModal(false)}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              <h3>Return to Warehouse</h3>
              <div style={{ marginBottom: '1rem' }}>
                <p><strong>Product:</strong> {productLookup[selectedItem.product_id]?.name || 'Unknown'}</p>
                <p><strong>Lot:</strong> {selectedItem.receipt?.lot_number || selectedItem.receipt_id || '-'}</p>
                <p><strong>Available:</strong> {available.toLocaleString()} {unit}</p>
                {selectedItem.pallets_staged && (
                  <p style={{ fontSize: '0.875rem', color: '#666' }}>
                    <strong>Pallets Staged:</strong> {selectedItem.pallets_staged.toFixed(2)}
                    {selectedItem.pallets_used > 0 && ` (Used: ${selectedItem.pallets_used.toFixed(2)})`}
                    {selectedItem.pallets_returned > 0 && ` (Returned: ${selectedItem.pallets_returned.toFixed(2)})`}
                  </p>
                )}
              </div>
              <label>
                <span>Quantity to Return ({unit}):</span>
                <input
                  type="number"
                  value={returnQuantity}
                  onChange={(e) => setReturnQuantity(e.target.value)}
                  min="0.01"
                  step="0.01"
                  required
                />
              </label>
              <label>
                <span>Return Location <span className="required">*</span>:</span>
                <select
                  value={returnLocation}
                  onChange={(e) => {
                    setReturnLocation(e.target.value);
                    setReturnSubLocation('');
                    setReturnStorageRow('');
                  }}
                  required
                >
                  <option value="">Select location</option>
                  {locations.map(loc => (
                    <option key={loc.id} value={loc.id}>{loc.name}</option>
                  ))}
                </select>
              </label>
              {returnLocation && (
                <label>
                  <span>Return Sub Location:</span>
                  <select
                    value={returnSubLocation}
                    onChange={(e) => {
                      setReturnSubLocation(e.target.value);
                      setReturnStorageRow('');
                    }}
                  >
                    <option value="">Select sub location (optional)</option>
                    {(subLocationMap[returnLocation] || []).map(sub => (
                      <option key={sub.id} value={sub.id}>{sub.name}</option>
                    ))}
                  </select>
                </label>
              )}
              {returnLocation && returnLocationRows.length > 0 && (
                <label>
                  <span>Storage Row / Rack (optional):</span>
                  <select
                    value={returnStorageRow}
                    onChange={(e) => setReturnStorageRow(e.target.value)}
                  >
                    <option value="">Select row/rack (optional)</option>
                    {returnLocationRows.map(row => (
                      <option key={row.id} value={row.id}>
                        {row.name} (Available: {row.available} pallets)
                      </option>
                    ))}
                  </select>
                  <p style={{ fontSize: '0.875rem', color: '#666', marginTop: '0.25rem' }}>
                    Select a specific rack/row to reserve space. Leave empty if not using rack storage.
                  </p>
                </label>
              )}
            <div className="modal-actions">
              <button
                onClick={() => setShowReturnModal(false)}
                className="secondary-button"
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                onClick={submitReturn}
                className="primary-button"
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Processing...' : 'Return to Warehouse'}
              </button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
};

export default StagingOverview;
