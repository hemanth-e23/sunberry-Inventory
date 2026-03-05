import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../context/AppDataContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { getDashboardPath } from '../App';
import { ChevronLeft, Plus, Filter, Edit2, Power, Package, Search } from 'lucide-react';
import TableSkeleton from './TableSkeleton';
import './Shared.css';
import './ProductsPage.css';

/** Turn API error into a clear message for product create/update (SID, FCC, ID duplicates, validation). */
function getProductErrorMessage(error) {
  const detail = error.response?.data?.detail;
  if (typeof detail === 'string') {
    // Backend already returns clear messages; optionally shorten for consistency
    if (detail.includes('SID code') && detail.includes('already exists')) return 'SID already exists. Please use a different SID or leave it blank.';
    if (detail.includes('FCC code') && detail.includes('already exists')) return 'FCC already exists. Please use a different FCC code or leave it blank.';
    if (detail.includes('short code') && detail.includes('already exists')) return 'Short code already exists. Please use a different short code.';
    if (detail.includes('Product with this ID already exists')) return 'Product ID already exists. Please use a different product ID.';
    return detail;
  }
  if (Array.isArray(detail)) {
    const first = detail[0];
    const msg = first?.msg ?? first?.message ?? String(first);
    return msg || 'Please check the form and try again.';
  }
  return error.message || 'Failed to save product. Please try again.';
}

const ProductsPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const {
    productCategories,
    categoryGroups,
    products,
    productsLoading,
    addProduct,
    updateProduct,
    toggleProductStatus
  } = useAppData();
  const { addToast } = useToast();
  const requiredStar = <span className="required">*</span>;

  const [showForm, setShowForm] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [formData, setFormData] = useState({
    name: '',
    shortCode: '',
    categoryId: '',
    description: '',
    sid: '',
    fcc: '',
    defaultCasesPerPallet: '',
    expireYears: '',
    quantityUom: 'cases',
    inventoryTracked: true,
    galPerCase: '',
  });

  const filteredProducts = useMemo(() => {
    let result = products;
    if (categoryFilter !== 'all') {
      result = result.filter(product => product.categoryId === categoryFilter);
    }
    if (statusFilter !== 'all') {
      result = result.filter(product => product.status === statusFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter(product =>
        product.name?.toLowerCase().includes(q) ||
        product.fcc?.toLowerCase().includes(q) ||
        product.sid?.toLowerCase().includes(q) ||
        product.shortCode?.toLowerCase().includes(q)
      );
    }
    return result;
  }, [products, categoryFilter, statusFilter, searchQuery]);

  const resetForm = () => {
    setFormData({
      name: '',
      shortCode: '',
      categoryId: '',
      description: '',
      sid: '',
      fcc: '',
      defaultCasesPerPallet: '',
      expireYears: '',
      quantityUom: 'cases',
      inventoryTracked: true,
      galPerCase: '',
    });
    setEditingProduct(null);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!formData.name.trim()) return;
    if (!formData.categoryId) return;

    const payload = {
      name: formData.name.trim(),
      shortCode: formData.shortCode ? formData.shortCode.trim().toUpperCase() : '',
      categoryId: formData.categoryId,
      description: formData.description.trim() || '',
      sid: formData.sid.trim() || '',
      fcc: formData.fcc ? formData.fcc.trim() : '',
      defaultCasesPerPallet: formData.defaultCasesPerPallet ? Number(formData.defaultCasesPerPallet) : null,
      expireYears: formData.expireYears ? Number(formData.expireYears) : null,
      quantityUom: formData.quantityUom || 'cases',
      inventoryTracked: formData.inventoryTracked,
      galPerCase: formData.galPerCase != null && formData.galPerCase !== '' ? Number(formData.galPerCase) : null,
      active: editingProduct ? editingProduct.active : true
    };

    try {
      if (editingProduct) {
        await updateProduct(editingProduct.id, payload);
      } else {
        await addProduct(payload);
      }
      resetForm();
      setShowForm(false);
    } catch (error) {
      console.error('Error saving product:', error);
      const errorMessage = getProductErrorMessage(error);
      addToast(errorMessage, 'error');
    }
  };

  const handleEdit = (product) => {
    setEditingProduct(product);
    setFormData({
      name: product.name,
      shortCode: product.shortCode || '',
      categoryId: product.categoryId,
      description: product.description || '',
      sid: product.sid || '',
      fcc: product.fcc || '',
      defaultCasesPerPallet: product.defaultCasesPerPallet ?? '',
      expireYears: product.expireYears ?? '',
      quantityUom: product.quantityUom || 'cases',
      inventoryTracked: product.inventoryTracked !== false,
      galPerCase: product.galPerCase ?? '',
    });
    setShowForm(true);
  };

  const formatCategoryLabel = (category) => {
    if (!category) return 'Unknown';
    const group = categoryGroups.find(g => g.id === category.parentId);
    const groupName = group?.name || '';
    return groupName ? `${groupName} — ${category.name}` : category.name;
  };

  const selectedCategory = useMemo(
    () => productCategories.find(cat => cat.id === formData.categoryId) || null,
    [productCategories, formData.categoryId]
  );

  const isFinishedCategory = selectedCategory?.type === 'finished';

  return (
    <div className="products-page animate-fade-in">
      <div className="page-header">
        <div>
          <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
            <ChevronLeft size={18} />
            <span>Back to Dashboard</span>
          </button>
        </div>
      </div>

      <div className="page-content">
        <section className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <Package size={24} style={{ color: 'var(--color-primary)' }} />
              <h2>Products</h2>
            </div>
            <div className="panel-actions">
              <button onClick={() => {
                resetForm();
                setShowForm(prev => !prev);
              }} className="primary-button">
                {showForm ? 'Close Form' : (
                  <>
                    <Plus size={18} />
                    <span>Add Product</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {showForm && (
            <form onSubmit={handleSubmit} className="simple-form">
              <div className="form-grid">
                <label>
                  <span>Product Name {requiredStar}</span>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    required
                  />
                </label>

                <label>
                  <span>Short Code <span className="muted small">(for barcodes, e.g. PFJ128C)</span></span>
                  <input
                    type="text"
                    value={formData.shortCode}
                    onChange={(e) => setFormData(prev => ({ ...prev, shortCode: e.target.value.toUpperCase() }))}
                    placeholder="e.g. PFJ128C"
                    maxLength={20}
                  />
                </label>

                <label>
                  <span>Category {requiredStar}</span>
                  <select
                    value={formData.categoryId}
                    onChange={(e) => setFormData(prev => ({ ...prev, categoryId: e.target.value }))}
                    required
                  >
                    <option value="">Select Category</option>
                    {productCategories.map(category => (
                      <option key={category.id} value={category.id}>{formatCategoryLabel(category)}</option>
                    ))}
                  </select>
                </label>

                {!isFinishedCategory && (
                  <label>
                    <span>Product SID {requiredStar}</span>
                    <input
                      type="text"
                      value={formData.sid}
                      onChange={(e) => setFormData(prev => ({ ...prev, sid: e.target.value }))}
                      placeholder="eg. SID-001"
                      required
                    />
                  </label>
                )}

                {isFinishedCategory && (
                  <>
                    <label>
                      <span>FCC Code {requiredStar}</span>
                      <input
                        type="text"
                        value={formData.fcc}
                        onChange={(e) => setFormData(prev => ({ ...prev, fcc: e.target.value }))}
                        placeholder="eg. FCCPG4792SUN01"
                        required
                      />
                    </label>

                    <label>
                      <span>Default Cases per Pallet</span>
                      <input
                        type="number"
                        min="1"
                        value={formData.defaultCasesPerPallet}
                        onChange={(e) => setFormData(prev => ({ ...prev, defaultCasesPerPallet: e.target.value }))}
                      />
                    </label>

                    <label>
                      <span>Expiration (Years)</span>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={formData.expireYears}
                        onChange={(e) => setFormData(prev => ({ ...prev, expireYears: e.target.value }))}
                      />
                    </label>

                    <label>
                      <span>Quantity Unit</span>
                      <input
                        type="text"
                        value={formData.quantityUom}
                        onChange={(e) => setFormData(prev => ({ ...prev, quantityUom: e.target.value }))}
                      />
                    </label>

                    <label>
                      <span>Gal per Case <span className="muted small">(for BOL)</span></span>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        placeholder="e.g. 4"
                        value={formData.galPerCase}
                        onChange={(e) => setFormData(prev => ({ ...prev, galPerCase: e.target.value }))}
                      />
                    </label>
                  </>
                )}

                {!isFinishedCategory && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 0' }}>
                    <input
                      type="checkbox"
                      checked={formData.inventoryTracked}
                      onChange={(e) => setFormData(prev => ({ ...prev, inventoryTracked: e.target.checked }))}
                    />
                    <span>Track Inventory</span>
                    {!formData.inventoryTracked && (
                      <span style={{ fontSize: '0.8rem', color: '#856404', backgroundColor: '#fff3cd', padding: '2px 8px', borderRadius: '4px', border: '1px solid #ffc107' }}>
                        No staging needed (e.g. water, sugar)
                      </span>
                    )}
                  </label>
                )}

                <label className="full-width">
                  <span>Description <span className="muted small">(Optional)</span></span>
                  <textarea
                    value={formData.description}
                    onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                    rows={3}
                  />
                </label>
              </div>

              <div className="form-actions">
                <button type="submit" className="primary-button">
                  {editingProduct ? 'Update Product' : 'Add Product'}
                </button>
                {editingProduct && (
                  <button type="button" className="secondary-button" onClick={() => {
                    resetForm();
                    setShowForm(false);
                  }}>
                    Cancel
                  </button>
                )}
              </div>
            </form>
          )}
        </section>

        <section className="panel">
          <div className="panel-header" style={{ flexWrap: 'wrap', gap: '12px' }}>
            <div className="panel-title">
              <h3>Product Catalog</h3>
              <span className="muted">{filteredProducts.length} items</span>
            </div>
            <div className="panel-actions" style={{ flexWrap: 'wrap', gap: '8px' }}>
              {/* Search */}
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <Search size={16} style={{ position: 'absolute', left: '10px', color: 'var(--color-text-muted)', pointerEvents: 'none' }} />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search name, code…"
                  aria-label="Search products"
                  style={{ paddingLeft: '34px', paddingRight: '10px', height: '36px', borderRadius: '6px', border: '1px solid var(--color-border)', fontSize: '0.875rem', width: '200px' }}
                />
              </div>

              {/* Status filter toggle */}
              <div style={{ display: 'flex', gap: '4px', background: 'var(--color-bg-muted, #f3f4f6)', borderRadius: '8px', padding: '3px' }}>
                {[
                  { value: 'all', label: 'All' },
                  { value: 'active', label: 'Active' },
                  { value: 'inactive', label: 'Inactive' },
                ].map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setStatusFilter(value)}
                    style={{
                      padding: '4px 12px',
                      borderRadius: '6px',
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: '0.8rem',
                      fontWeight: 500,
                      transition: 'all 0.15s',
                      background: statusFilter === value
                        ? value === 'active' ? '#16a34a' : value === 'inactive' ? '#dc2626' : 'white'
                        : 'transparent',
                      color: statusFilter === value
                        ? value === 'all' ? 'var(--color-text)' : 'white'
                        : 'var(--color-text-muted)',
                      boxShadow: statusFilter === value ? '0 1px 3px rgba(0,0,0,0.12)' : 'none',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Category filter */}
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <Filter size={16} style={{ position: 'absolute', left: '12px', color: 'var(--color-text-muted)', pointerEvents: 'none' }} />
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  aria-label="Filter products by category"
                  style={{ paddingLeft: '36px' }}
                >
                  <option value="all">All Categories</option>
                  {productCategories.map(category => (
                    <option key={category.id} value={category.id}>{formatCategoryLabel(category)}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <div className="table-wrapper" style={{ maxHeight: '600px', overflowY: 'auto' }}>
            <table className="simple-table">
              <thead>
                <tr>
                  <th>S.No</th>
                  <th>Name</th>
                  <th>Short Code</th>
                  <th>Category</th>
                  <th>Code</th>
                  <th>Description</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              {productsLoading ? (
                <TableSkeleton rows={8} columns={8} />
              ) : (
                <tbody>
                  {filteredProducts.map((product, index) => {
                    const category = productCategories.find(cat => cat.id === product.categoryId);
                    return (
                      <tr key={product.id}>
                        <td style={{ color: 'var(--color-text-muted)', fontWeight: 500 }}>{index + 1}</td>
                        <td>
                          {product.name}
                          {product.inventoryTracked === false && (
                            <span style={{ marginLeft: '6px', fontSize: '0.7rem', color: '#856404', backgroundColor: '#fff3cd', padding: '1px 6px', borderRadius: '3px', border: '1px solid #ffc107', verticalAlign: 'middle' }}>
                              Not Tracked
                            </span>
                          )}
                        </td>
                        <td>
                          {product.shortCode ? (
                            <span style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: '0.9rem' }}>
                              {product.shortCode}
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>{category ? formatCategoryLabel(category) : 'Unknown'}</td>
                        <td>{product.fcc || product.sid || '—'}</td>
                        <td>{product.description}</td>
                        <td>
                          <span className={`chip status-${product.status}`}>
                            {product.status}
                          </span>
                        </td>
                        <td>
                          <div className="row-actions">
                            <button type="button" onClick={() => handleEdit(product)}>
                              <Edit2 size={14} />
                              <span>Edit</span>
                            </button>
                            <button type="button" onClick={async () => {
                              try {
                                await toggleProductStatus(product.id);
                              } catch {
                                addToast('Failed to toggle product status. Please try again.', 'error');
                              }
                            }}>
                              <Power size={14} />
                              <span>{product.status === 'active' ? 'Deactivate' : 'Activate'}</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              )}
            </table>
          </div>
        </section>
      </div>
    </div>
  );
};

export default ProductsPage;