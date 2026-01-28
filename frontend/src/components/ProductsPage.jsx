import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../context/AppDataContext';
import { useAuth } from '../context/AuthContext';
import { getDashboardPath } from '../App';
import { ChevronLeft, Plus, Filter, Edit2, Power, Package } from 'lucide-react';
import './Shared.css';
import './ProductsPage.css';

/** Turn API error into a clear message for product create/update (SID, FCC, ID duplicates, validation). */
function getProductErrorMessage(error) {
  const detail = error.response?.data?.detail;
  if (typeof detail === 'string') {
    // Backend already returns clear messages; optionally shorten for consistency
    if (detail.includes('SID code') && detail.includes('already exists')) return 'SID already exists. Please use a different SID or leave it blank.';
    if (detail.includes('FCC code') && detail.includes('already exists')) return 'FCC already exists. Please use a different FCC code or leave it blank.';
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
    addProduct,
    updateProduct,
    toggleProductStatus
  } = useAppData();

  const requiredStar = <span className="required">*</span>;

  const [showForm, setShowForm] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [formData, setFormData] = useState({
    name: '',
    categoryId: '',
    description: '',
    sid: '',
    fcc: '',
    defaultCasesPerPallet: '',
    expireYears: '',
    quantityUom: 'cases'
  });

  const filteredProducts = useMemo(() => {
    if (categoryFilter === 'all') return products;
    return products.filter(product => product.categoryId === categoryFilter);
  }, [products, categoryFilter]);

  const resetForm = () => {
    setFormData({
      name: '',
      categoryId: '',
      description: '',
      sid: '',
      fcc: '',
      defaultCasesPerPallet: '',
      expireYears: '',
      quantityUom: 'cases'
    });
    setEditingProduct(null);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!formData.name.trim()) return;
    if (!formData.categoryId) return;

    const payload = {
      name: formData.name.trim(),
      categoryId: formData.categoryId,
      description: formData.description.trim() || '',
      sid: formData.sid.trim() || '',
      // Always include FCC code - send empty string if not provided, it will be converted to null
      fcc: formData.fcc ? formData.fcc.trim() : '',
      defaultCasesPerPallet: formData.defaultCasesPerPallet ? Number(formData.defaultCasesPerPallet) : null,
      expireYears: formData.expireYears ? Number(formData.expireYears) : null,
      quantityUom: formData.quantityUom || 'cases',
      // Include active status if editing
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
      alert(errorMessage);
    }
  };

  const handleEdit = (product) => {
    setEditingProduct(product);
    setFormData({
      name: product.name,
      categoryId: product.categoryId,
      description: product.description || '',
      sid: product.sid || '',
      fcc: product.fcc || '',
      defaultCasesPerPallet: product.defaultCasesPerPallet ?? '',
      expireYears: product.expireYears ?? '',
      quantityUom: product.quantityUom || 'cases'
    });
    setShowForm(true);
  };

  const formatCategoryLabel = (category) => {
    if (!category) return 'Unknown';
    // Find the group name
    const group = categoryGroups.find(g => g.id === category.parentId);
    const groupName = group?.name || '';
    const typeLabel = category.type === 'finished' ? 'Finished Good' : 'Raw Material';

    // Determine subLabel based on group name (more reliable than subType field)
    let subLabel = null;
    if (category.type !== 'finished') {
      if (groupName.toLowerCase().includes('packaging')) {
        subLabel = 'Packaging';
      } else if (groupName.toLowerCase().includes('raw') || category.subType === 'ingredient') {
        subLabel = 'Ingredient';
      }
    }

    return `${groupName ? groupName + ' → ' : ''}${category.name} (${typeLabel}${subLabel ? ` · ${subLabel}` : ''})`;
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
                  </>
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
          <div className="panel-header">
            <div className="panel-title">
              <h3>Product Catalog</h3>
              <span className="muted">{filteredProducts.length} items</span>
            </div>
            <div className="panel-actions">
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
          <div className="table-wrapper">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Category</th>
                  <th>Code</th>
                  <th>Description</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map(product => {
                  const category = productCategories.find(cat => cat.id === product.categoryId);
                  return (
                    <tr key={product.id}>
                      <td>{product.id}</td>
                      <td>{product.name}</td>
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
                            } catch (error) {
                              alert('Failed to toggle product status. Please try again.');
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
            </table>
          </div>
        </section>
      </div>
    </div>
  );
};

export default ProductsPage;