import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import ExcelJS from 'exceljs';
import { useAppData } from '../context/AppDataContext';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { getDashboardPath } from '../App';
import { formatDate, getTodayDateKey, toDateKey, escapeHtml } from '../utils/dateUtils';
import { ROLES, RECEIPT_STATUS, CATEGORY_TYPES } from '../constants';
import './Shared.css';
import './CycleCountingPage.css';

// ─── Module-level constants ────────────────────────────────────────────────

// Category types that should appear on count sheets
const COUNTABLE_TYPES = new Set([
  CATEGORY_TYPES.FINISHED,
  CATEGORY_TYPES.RAW_MATERIAL,
  CATEGORY_TYPES.INGREDIENT,
  CATEGORY_TYPES.PACKAGING,
  'raw', // pre-existing DB inconsistency — same as raw-material
]);

// Used for the "Ingredients" category filter
const INGREDIENT_TYPES = new Set([
  CATEGORY_TYPES.INGREDIENT,
  CATEGORY_TYPES.RAW_MATERIAL,
  'raw',
]);

const TYPE_ORDER = {
  [CATEGORY_TYPES.FINISHED]: 0,
  [CATEGORY_TYPES.INGREDIENT]: 1,
  [CATEGORY_TYPES.RAW_MATERIAL]: 1,
  raw: 1,
  [CATEGORY_TYPES.PACKAGING]: 2,
};

const SECTION_DEFS = [
  {
    key: 'finished',
    label: 'Finished Goods',
    types: new Set([CATEGORY_TYPES.FINISHED]),
  },
  {
    key: 'ingredient',
    label: 'Ingredients',
    types: new Set([CATEGORY_TYPES.INGREDIENT, CATEGORY_TYPES.RAW_MATERIAL, 'raw']),
  },
  {
    key: 'packaging',
    label: 'Packaging',
    types: new Set([CATEGORY_TYPES.PACKAGING]),
  },
];

// ─────────────────────────────────────────────────────────────────────────────

const CycleCountingPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { confirm } = useConfirm();
  const {
    receipts,
    products,
    productCategories,
    categoryGroups,
    locations,
    cycleCounts,
    saveCycleCount,
    subLocationUnifiedLookup,
    locationLookup,
  } = useAppData();

  const [selectedClient, setSelectedClient] = useState(''); // category group ID (Sunberry, Arizona, etc.)
  const [selectedLocation, setSelectedLocation] = useState('');
  const [countDate, setCountDate] = useState(getTodayDateKey());
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState('all'); // 'all' | 'finished' | 'ingredient' | 'packaging'
  const [countGenerated, setCountGenerated] = useState(false);
  const [physicalCounts, setPhysicalCounts] = useState({});
  const [countSearch, setCountSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submittedVariances, setSubmittedVariances] = useState([]);
  const [selectedCycleCount, setSelectedCycleCount] = useState(null);

  // ─── Lookups ───────────────────────────────────────────────────────────────

  const productLookup = useMemo(() => {
    const map = {};
    products.forEach(p => { map[p.id] = p; });
    return map;
  }, [products]);

  const categoryLookup = useMemo(() => {
    const map = {};
    productCategories.forEach(c => { map[c.id] = c; });
    return map;
  }, [productCategories]);

  // Category groups = clients (Sunberry, Arizona, etc.) — filter to only groups
  // that have at least one active category with countable type
  const clientGroups = useMemo(() => {
    const groupsWithInventory = new Set(
      productCategories
        .filter(c => COUNTABLE_TYPES.has(c.type) && c.parentId)
        .map(c => c.parentId)
    );
    return categoryGroups.filter(g => groupsWithInventory.has(g.id));
  }, [categoryGroups, productCategories]);

  // ─── Inventory items ───────────────────────────────────────────────────────

  const inventoryItems = useMemo(() => {
    return receipts
      .filter(r => {
        if (r.status !== RECEIPT_STATUS.APPROVED && r.hold !== true) return false;
        const cat = categoryLookup[r.categoryId];
        if (!cat || !COUNTABLE_TYPES.has(cat.type)) return false;
        if (selectedCategoryFilter === 'finished' && cat.type !== CATEGORY_TYPES.FINISHED) return false;
        if (selectedCategoryFilter === 'ingredient' && !INGREDIENT_TYPES.has(cat.type)) return false;
        if (selectedCategoryFilter === 'packaging' && cat.type !== CATEGORY_TYPES.PACKAGING) return false;
        if (selectedClient && cat.parentId !== selectedClient) return false;
        if (selectedLocation && r.location !== selectedLocation) return false;
        return true;
      })
      .map(r => ({
        ...r,
        product: productLookup[r.productId] || null,
        category: categoryLookup[r.categoryId] || null,
      }))
      .sort((a, b) => {
        const aOrder = TYPE_ORDER[a.category?.type] ?? 9;
        const bOrder = TYPE_ORDER[b.category?.type] ?? 9;
        if (aOrder !== bOrder) return aOrder - bOrder;
        const aName = a.product?.name || '';
        const bName = b.product?.name || '';
        if (aName !== bName) return aName.localeCompare(bName);
        return (a.lotNo || '').localeCompare(b.lotNo || '');
      });
  }, [receipts, productLookup, categoryLookup, selectedClient, selectedLocation, selectedCategoryFilter]);

  // Items grouped into labeled sections for display
  const groupedInventoryItems = useMemo(() => {
    return SECTION_DEFS
      .map(def => ({
        ...def,
        items: inventoryItems.filter(i => def.types.has(i.category?.type)),
      }))
      .filter(g => g.items.length > 0);
  }, [inventoryItems]);

  // Search-filtered view — only affects display, never the underlying physicalCounts data
  const displayedGroupedItems = useMemo(() => {
    if (!countSearch.trim()) return groupedInventoryItems;
    const q = countSearch.toLowerCase();
    return groupedInventoryItems
      .map(group => ({
        ...group,
        items: group.items.filter(item =>
          (item.product?.name || '').toLowerCase().includes(q) ||
          (item.lotNo || '').toLowerCase().includes(q)
        ),
      }))
      .filter(g => g.items.length > 0);
  }, [groupedInventoryItems, countSearch]);

  // ─── Helpers ──────────────────────────────────────────────────────────────

  const getLocationLabel = (item) => {
    if (!item) return '—';
    const loc = locationLookup?.[item.location];
    const locName = loc?.name || '—';
    if (item.subLocation) {
      const sub = subLocationUnifiedLookup?.[item.subLocation];
      return `${locName} / ${sub?.name || item.subLocation}`;
    }
    return locName;
  };

  const isFinished = (item) => item.category?.type === CATEGORY_TYPES.FINISHED;

  // Returns { sysLabel, expectedCount } — expectedCount is what variance is calculated against
  const getQtyInfo = (item) => {
    if (isFinished(item)) {
      const pallets = item.pallets ?? item.fullPallets ?? 0;
      const cases = Number(item.quantity) || 0;
      return {
        sysLabel: `${pallets} pal / ${cases.toLocaleString()} cs`,
        expectedCount: Number(pallets) || 0,
        unit: 'pallets',
      };
    }
    const qty = Number(item.quantity) || 0;
    return {
      sysLabel: qty.toLocaleString(),
      expectedCount: qty,
      unit: 'units',
    };
  };

  const getVarianceInfo = (item) => {
    const raw = physicalCounts[item.id];
    if (raw === undefined || raw === '') return null;
    const { expectedCount } = getQtyInfo(item);
    const actual = Number(raw) || 0;
    const variance = actual - expectedCount;
    return {
      actual,
      variance,
      status: Math.abs(variance) < 1 ? 'ok' : variance < 0 ? 'shortage' : 'overage',
    };
  };

  // ─── Actions ──────────────────────────────────────────────────────────────

  const handleReset = () => {
    setCountGenerated(false);
    setPhysicalCounts({});
    setCountSearch('');
    setSubmitted(false);
    setSubmittedVariances([]);
  };

  const handleGenerate = () => {
    setPhysicalCounts({});
    setCountSearch('');
    setSubmitted(false);
    setSubmittedVariances([]);
    setCountGenerated(true);
  };

  const handleClearCounts = () => {
    setPhysicalCounts({});
  };

  const handleSubmit = async () => {
    // Warn on partial submissions
    if (countedCount < inventoryItems.length) {
      const ok = await confirm(
        `You have entered counts for ${countedCount} of ${inventoryItems.length} items. The ${inventoryItems.length - countedCount} uncounted item(s) will not be included. Continue?`,
        { title: 'Partial Count', confirmLabel: 'Submit Anyway' }
      );
      if (!ok) return;
    }

    setSubmitting(true);
    const items = [];
    inventoryItems.forEach(item => {
      const info = getVarianceInfo(item);
      if (info === null) return;
      const { expectedCount } = getQtyInfo(item);
      const vPct = expectedCount > 0
        ? ((info.variance / expectedCount) * 100).toFixed(2)
        : '0';
      items.push({
        receiptId: item.id,
        productName: item.product?.name || 'Unknown',
        lotNo: item.lotNo || '—',
        expiryDate: item.expiryDate || null,
        location: getLocationLabel(item),
        expectedQuantity: expectedCount,
        actualQuantity: info.actual,
        variance: info.variance,
        variancePercent: vPct,
        status: info.status,
      });
    });

    const totalExpected = items.reduce((s, v) => s + v.expectedQuantity, 0);
    const totalActual = items.reduce((s, v) => s + v.actualQuantity, 0);
    const totalVariance = totalActual - totalExpected;
    const variancePct = totalExpected > 0
      ? ((totalVariance / totalExpected) * 100).toFixed(2)
      : '0';

    const summary = {
      totalItems: items.length,
      expectedValue: totalExpected,
      actualValue: totalActual,
      totalVariance,
      varianceValue: variancePct,
    };

    await saveCycleCount({
      location: selectedLocation || null,
      category: null,
      countDate,
      items,
      summary,
      performedBy: user?.name || user?.username || 'Unknown',
      performedById: user?.id || 'unknown',
    });

    setSubmittedVariances(items);
    setSubmitted(true);
    setSubmitting(false);
  };

  // ─── Excel export ──────────────────────────────────────────────────────────

  const exportVariances = async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Variance Summary');
    ws.addRow(['Product', 'Lot #', 'Expires', 'Location', 'System Qty', 'Physical Qty', 'Variance', 'Variance %', 'Status']);
    submittedVariances.forEach(v => {
      ws.addRow([
        v.productName,
        v.lotNo,
        v.expiryDate ? formatDate(v.expiryDate) : '—',
        v.location,
        v.expectedQuantity,
        v.actualQuantity,
        v.variance,
        `${v.variancePercent}%`,
        v.status,
      ]);
    });
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `cycle-count-${countDate}.xlsx`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // ─── Print ────────────────────────────────────────────────────────────────

  const printCountSheet = () => {
    const vendorName = clientGroups.find(g => g.id === selectedClient)?.name || 'All Clients';
    const locationName = selectedLocation
      ? (locationLookup?.[selectedLocation]?.name || 'Selected Location')
      : 'All Locations';
    const today = countDate || getTodayDateKey();

    let html = `<!DOCTYPE html>
<html>
<head>
  <title>Count Sheet — ${escapeHtml(vendorName)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; font-size: 10pt; padding: 10mm; }
    h1 { font-size: 12pt; margin-bottom: 1mm; }
    .info { font-size: 9pt; color: #333; margin-bottom: 5mm; }
    table { width: 100%; border-collapse: collapse; font-size: 9pt; }
    th { background: #eee; border: 1px solid #000; padding: 2mm; text-align: center; font-size: 8pt; font-weight: bold; }
    td { border: 1px solid #000; padding: 2mm; }
    .num { text-align: right; }
    .mono { font-family: monospace; }
    .count-col { width: 22mm; }
    .notes-col { width: 35mm; }
    .section-hdr { background: #333; color: #fff; font-weight: bold; font-size: 9pt; padding: 2mm 3mm; border: 1px solid #000; }
    @media print { body { padding: 0; } @page { size: A4 landscape; margin: 8mm; } }
  </style>
</head>
<body>
  <h1>Physical Count Sheet — ${escapeHtml(vendorName)}</h1>
  <div class="info">Date: ${today} &nbsp;|&nbsp; Location: ${escapeHtml(locationName)} &nbsp;|&nbsp; Items: ${inventoryItems.length}</div>
  <table>
    <tr>
      <th>Product</th>
      <th>Lot #</th>
      <th>Expires</th>
      <th>Location</th>
      <th>Sys Qty</th>
      <th class="count-col">Physical Count</th>
      <th class="notes-col">Notes</th>
    </tr>
`;
    groupedInventoryItems.forEach(group => {
      html += `    <tr><td colspan="7" class="section-hdr">${escapeHtml(group.label)} (${group.items.length})</td></tr>\n`;
      group.items.forEach(item => {
        const { sysLabel } = getQtyInfo(item);
        html += `    <tr>
      <td>${escapeHtml(item.product?.name) || '—'}</td>
      <td class="mono">${escapeHtml(item.lotNo) || '—'}</td>
      <td>${item.expiryDate ? formatDate(item.expiryDate) : '—'}</td>
      <td>${escapeHtml(getLocationLabel(item))}</td>
      <td class="num">${sysLabel}</td>
      <td class="count-col"></td>
      <td class="notes-col"></td>
    </tr>\n`;
      });
    });
    html += `  </table>
</body>
</html>`;

    const win = window.open('', '_blank');
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 250);
  };

  // ─── History filter ────────────────────────────────────────────────────────

  const filteredCycleCounts = useMemo(() => {
    const isAdmin = [ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.SUPERADMIN, ROLES.CORPORATE_ADMIN]
      .includes(user?.role);
    if (isAdmin) return cycleCounts;
    // Use ID-based filter — performedById is always set and doesn't depend on display name format
    return cycleCounts.filter(c => c.performedById === user?.id);
  }, [cycleCounts, user]);

  // ─── Derived ──────────────────────────────────────────────────────────────

  const countedCount = Object.keys(physicalCounts).filter(
    k => physicalCounts[k] !== '' && physicalCounts[k] !== undefined
  ).length;

  // ─── Variance summary panel (computed before render) ──────────────────────

  const varianceSummary = (() => {
    if (!submitted || submittedVariances.length === 0) return null;
    const totalExpected = submittedVariances.reduce((s, v) => s + v.expectedQuantity, 0);
    const totalActual = submittedVariances.reduce((s, v) => s + v.actualQuantity, 0);
    const totalVariance = totalActual - totalExpected;
    const varianceItems = submittedVariances.filter(v => v.status !== 'ok');
    return (
      <div className="variance-summary-panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h2 style={{ margin: 0 }}>Variance Summary</h2>
          <button className="secondary-button" onClick={exportVariances}>
            Export Excel
          </button>
        </div>
        <div className="variance-stats">
          <div className="stat-item">
            <div className="stat-label">Items Counted</div>
            <div className="stat-value">{submittedVariances.length}</div>
          </div>
          <div className="stat-item">
            <div className="stat-label">System Total</div>
            <div className="stat-value">{totalExpected.toLocaleString()}</div>
          </div>
          <div className="stat-item">
            <div className="stat-label">Physical Total</div>
            <div className="stat-value">{totalActual.toLocaleString()}</div>
          </div>
          <div className="stat-item">
            <div className="stat-label">Total Variance</div>
            <div className={`stat-value ${totalVariance !== 0 ? 'variance-negative' : ''}`}>
              {totalVariance > 0 ? '+' : ''}{totalVariance.toLocaleString()}
            </div>
          </div>
        </div>
        {varianceItems.length > 0 && (
          <>
            <h3>Items with Variance</h3>
            <div className="table-wrapper">
              <table className="variance-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Lot #</th>
                    <th>Expires</th>
                    <th>Location</th>
                    <th className="text-right">System</th>
                    <th className="text-right">Physical</th>
                    <th className="text-right">Variance</th>
                    <th className="text-right">%</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {varianceItems.map((v, idx) => (
                    <tr key={idx}>
                      <td>{v.productName}</td>
                      <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{v.lotNo}</td>
                      <td>{v.expiryDate ? formatDate(v.expiryDate) : '—'}</td>
                      <td>{v.location}</td>
                      <td className="text-right">{v.expectedQuantity.toLocaleString()}</td>
                      <td className="text-right">{v.actualQuantity.toLocaleString()}</td>
                      <td className={`text-right variance-${v.status}`}>
                        {v.variance > 0 ? '+' : ''}{v.variance.toLocaleString()}
                      </td>
                      <td className={`text-right variance-${v.status}`}>
                        {v.variancePercent}%
                      </td>
                      <td>
                        <span className={`status-badge-${v.status}`}>
                          {v.status === 'shortage' ? '⚠ Shortage' : '⚠ Overage'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    );
  })();

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="cycle-counting-page">
      <div className="page-header">
        <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
          ← Back to Dashboard
        </button>
      </div>

      <div className="page-content">
        <h1>Cycle Counting / Physical Inventory</h1>
        <p className="page-description">
          Generate a count sheet for all inventory, fill in physical counts, then submit to record variances.
        </p>

        {/* ── Setup panel ─────────────────────────────────────────────────── */}
        <div className="count-setup-panel">
          <h2>Setup</h2>
          <div className="form-grid">
            <label>
              <span>Client</span>
              <select
                value={selectedClient}
                onChange={e => { setSelectedClient(e.target.value); handleReset(); }}
              >
                <option value="">All Clients</option>
                {clientGroups.map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </label>

            <label>
              <span>Category Type</span>
              <select
                value={selectedCategoryFilter}
                onChange={e => { setSelectedCategoryFilter(e.target.value); handleReset(); }}
              >
                <option value="all">All (FG + Ingredients + Packaging)</option>
                <option value="finished">Finished Goods only</option>
                <option value="ingredient">Ingredients only</option>
                <option value="packaging">Packaging only</option>
              </select>
            </label>

            <label>
              <span>Location (optional)</span>
              <select
                value={selectedLocation}
                onChange={e => { setSelectedLocation(e.target.value); handleReset(); }}
              >
                <option value="">All Locations</option>
                {locations.map(l => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </label>

            <label>
              <span>Count Date</span>
              <input
                type="date"
                value={countDate}
                onChange={e => setCountDate(e.target.value)}
              />
            </label>
          </div>

          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="primary-button" onClick={handleGenerate}>
              Generate Count Sheet ({inventoryItems.length} items)
            </button>
            {countGenerated && inventoryItems.length > 0 && (
              <button className="secondary-button" onClick={printCountSheet}>
                🖨 Print Sheet
              </button>
            )}
          </div>
        </div>

        {/* ── Count sheet ─────────────────────────────────────────────────── */}
        {countGenerated && inventoryItems.length > 0 && (
          <div className="count-sheet-panel">
            <div className="panel-header">
              <h2>
                Count Sheet
                {submitted && <span style={{ color: '#16a34a', marginLeft: '8px', fontSize: '14px' }}>✓ Submitted</span>}
              </h2>
              <span style={{ fontSize: '14px', color: '#6b7280' }}>
                {countedCount} / {inventoryItems.length} counted
              </span>
            </div>

            {/* Search bar */}
            <div style={{ marginBottom: '12px' }}>
              <input
                type="text"
                placeholder="Search by product name or lot #…"
                value={countSearch}
                onChange={e => setCountSearch(e.target.value)}
                style={{
                  padding: '8px 12px',
                  border: '1px solid #d1d5db',
                  borderRadius: '6px',
                  fontSize: '14px',
                  width: '100%',
                  maxWidth: '360px',
                }}
              />
              {countSearch && (
                <span style={{ marginLeft: '8px', fontSize: '13px', color: '#6b7280' }}>
                  Showing {displayedGroupedItems.reduce((s, g) => s + g.items.length, 0)} of {inventoryItems.length}
                </span>
              )}
            </div>

            {/* Desktop table */}
            <div className="cc-table-view">
              <div className="table-wrapper">
                <table className="count-sheet-table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Lot #</th>
                      <th>Expires</th>
                      <th>Location</th>
                      <th className="text-right">System Qty</th>
                      <th>Physical Count</th>
                      {submitted && <th className="text-right">Variance</th>}
                      <th>Hold</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedGroupedItems.map(group => (
                      <React.Fragment key={group.key}>
                        <tr className="cc-section-header-row">
                          <td colSpan={submitted ? 8 : 7} className="cc-section-header-cell">
                            {group.label}
                            <span className="cc-section-count">{group.items.length} items</span>
                          </td>
                        </tr>
                        {group.items.map(item => {
                          const { sysLabel } = getQtyInfo(item);
                          const submittedItem = submitted
                            ? submittedVariances.find(v => v.receiptId === item.id)
                            : null;
                          const isExpired = item.expiryDate && toDateKey(item.expiryDate) < getTodayDateKey();
                          return (
                            <tr key={item.id} className={item.hold ? 'cc-row-hold' : ''}>
                              <td>{item.product?.name || '—'}</td>
                              <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>
                                {item.lotNo || '—'}
                              </td>
                              <td className={isExpired ? 'cc-expired' : ''}>
                                {item.expiryDate ? formatDate(item.expiryDate) : '—'}
                              </td>
                              <td>{getLocationLabel(item)}</td>
                              <td className="text-right">{sysLabel}</td>
                              <td>
                                <input
                                  type="number"
                                  min="0"
                                  step="1"
                                  value={physicalCounts[item.id] ?? ''}
                                  onChange={e => setPhysicalCounts(prev => ({
                                    ...prev,
                                    [item.id]: e.target.value,
                                  }))}
                                  className="count-input"
                                  disabled={submitted}
                                  placeholder="—"
                                />
                              </td>
                              {submitted && (
                                <td className={`text-right ${submittedItem ? `variance-${submittedItem.status}` : ''}`}>
                                  {submittedItem
                                    ? `${submittedItem.variance > 0 ? '+' : ''}${submittedItem.variance}`
                                    : '—'}
                                </td>
                              )}
                              <td>
                                {item.hold
                                  ? <span className="hold-badge">HOLD</span>
                                  : <span style={{ color: '#9ca3af' }}>—</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile card view */}
            <div className="cc-card-view">
              {displayedGroupedItems.map(group => (
                <div key={group.key}>
                  <div className="cc-section-header-mobile">
                    {group.label}
                    <span className="cc-section-count">{group.items.length} items</span>
                  </div>
                  {group.items.map(item => {
                    const { sysLabel } = getQtyInfo(item);
                    const submittedItem = submitted
                      ? submittedVariances.find(v => v.receiptId === item.id)
                      : null;
                    const isExpired = item.expiryDate && toDateKey(item.expiryDate) < getTodayDateKey();
                    return (
                      <div key={item.id} className={`cc-card${item.hold ? ' cc-card-hold' : ''}`}>
                        <div className="cc-card-header">
                          <span className="cc-card-product">{item.product?.name || '—'}</span>
                          {item.hold && <span className="hold-badge">HOLD</span>}
                        </div>
                        <div className="cc-card-meta">
                          <div className="cc-card-meta-row">
                            <span className="cc-card-label">Lot #</span>
                            <span className="cc-card-value cc-mono">{item.lotNo || '—'}</span>
                          </div>
                          <div className="cc-card-meta-row">
                            <span className="cc-card-label">Expires</span>
                            <span className={`cc-card-value ${isExpired ? 'cc-expired' : ''}`}>
                              {item.expiryDate ? formatDate(item.expiryDate) : '—'}
                            </span>
                          </div>
                          <div className="cc-card-meta-row">
                            <span className="cc-card-label">Location</span>
                            <span className="cc-card-value">{getLocationLabel(item)}</span>
                          </div>
                          <div className="cc-card-meta-row">
                            <span className="cc-card-label">System Qty</span>
                            <span className="cc-card-value cc-bold">{sysLabel}</span>
                          </div>
                        </div>
                        <div className="cc-card-count-row">
                          <label className="cc-card-count-label">Physical Count</label>
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={physicalCounts[item.id] ?? ''}
                            onChange={e => setPhysicalCounts(prev => ({
                              ...prev,
                              [item.id]: e.target.value,
                            }))}
                            className="cc-count-input-large"
                            disabled={submitted}
                            placeholder="Enter count"
                          />
                          {submitted && submittedItem && (
                            <span className={`cc-card-variance variance-${submittedItem.status}`}>
                              {submittedItem.variance > 0 ? '+' : ''}{submittedItem.variance}
                              {' '}({submittedItem.variancePercent}%)
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            {!submitted && (
              <div className="count-actions">
                {countedCount > 0 && (
                  <button className="secondary-button" onClick={handleClearCounts}>
                    Clear Counts
                  </button>
                )}
                <button
                  className="primary-button"
                  onClick={handleSubmit}
                  disabled={submitting || countedCount === 0}
                >
                  {submitting
                    ? 'Submitting…'
                    : `Submit Count (${countedCount} of ${inventoryItems.length} entered)`}
                </button>
              </div>
            )}

            {submitted && submittedVariances.length > 0 && (
              <div className="count-submitted-banner">
                <strong>✓ Count submitted.</strong> {submittedVariances.filter(v => v.status !== 'ok').length} variance(s) recorded.
              </div>
            )}
          </div>
        )}

        {countGenerated && inventoryItems.length === 0 && (
          <div className="empty-state">
            No active inventory found for the selected filters.
          </div>
        )}

        {/* ── Variance summary ─────────────────────────────────────────────── */}
        {varianceSummary}

        {/* ── Count history ────────────────────────────────────────────────── */}
        <div className="count-history-panel">
          <h2>Count History</h2>
          {filteredCycleCounts.length > 0 ? (
            <div className="table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Location</th>
                    <th>Items</th>
                    <th className="text-right">Total Variance</th>
                    <th className="text-right">Variance %</th>
                    <th>Performed By</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCycleCounts.map(count => {
                    const loc = locationLookup?.[count.location];
                    return (
                      <tr
                        key={count.id}
                        onClick={() => setSelectedCycleCount(count)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td>{formatDate(count.countDate)}</td>
                        <td>{loc?.name || (count.location ? count.location : 'All Locations')}</td>
                        <td>{count.summary?.totalItems ?? 0}</td>
                        <td className={`text-right ${count.summary?.totalVariance !== 0 ? 'variance-shortage' : 'variance-ok'}`}>
                          {count.summary?.totalVariance > 0 ? '+' : ''}{count.summary?.totalVariance ?? 0}
                        </td>
                        <td className={`text-right ${count.summary?.totalVariance !== 0 ? 'variance-shortage' : 'variance-ok'}`}>
                          {count.summary?.varianceValue ?? 0}%
                        </td>
                        <td>{count.performedBy || '—'}</td>
                        <td>
                          <span className={count.summary?.totalVariance === 0 ? 'status-ok' : 'status-warning'}>
                            {count.summary?.totalVariance === 0 ? '✓ OK' : '⚠ Variance'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">No cycle count history yet.</div>
          )}
        </div>

        {/* ── History detail modal ─────────────────────────────────────────── */}
        {selectedCycleCount && (
          <div className="modal-overlay" onClick={() => setSelectedCycleCount(null)}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Count Details — {formatDate(selectedCycleCount.countDate)}</h2>
                <button className="close-button" onClick={() => setSelectedCycleCount(null)}>×</button>
              </div>
              <div className="modal-body">
                <div className="detail-section">
                  <h3>Summary</h3>
                  <div className="detail-grid">
                    <div className="detail-item">
                      <span className="detail-label">Date</span>
                      <span className="detail-value">{formatDate(selectedCycleCount.countDate)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Location</span>
                      <span className="detail-value">
                        {locationLookup?.[selectedCycleCount.location]?.name || 'All Locations'}
                      </span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Performed By</span>
                      <span className="detail-value">{selectedCycleCount.performedBy || '—'}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Items Counted</span>
                      <span className="detail-value">{selectedCycleCount.summary?.totalItems ?? 0}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">System Total</span>
                      <span className="detail-value">
                        {(selectedCycleCount.summary?.expectedValue ?? 0).toLocaleString()}
                      </span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Physical Total</span>
                      <span className="detail-value">
                        {(selectedCycleCount.summary?.actualValue ?? 0).toLocaleString()}
                      </span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Total Variance</span>
                      <span className={`detail-value ${selectedCycleCount.summary?.totalVariance !== 0 ? 'variance-shortage' : 'variance-ok'}`}>
                        {selectedCycleCount.summary?.totalVariance > 0 ? '+' : ''}
                        {(selectedCycleCount.summary?.totalVariance ?? 0).toLocaleString()}
                      </span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Variance %</span>
                      <span className={`detail-value ${selectedCycleCount.summary?.totalVariance !== 0 ? 'variance-shortage' : 'variance-ok'}`}>
                        {selectedCycleCount.summary?.varianceValue ?? 0}%
                      </span>
                    </div>
                  </div>
                </div>

                {selectedCycleCount.items?.length > 0 && (
                  <div className="detail-section">
                    <h3>Item Details</h3>
                    <div className="table-wrapper">
                      <table className="detail-table">
                        <thead>
                          <tr>
                            <th>Product</th>
                            <th>Lot #</th>
                            <th>Expires</th>
                            <th>Location</th>
                            <th className="text-right">System</th>
                            <th className="text-right">Physical</th>
                            <th className="text-right">Variance</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedCycleCount.items.map((item, idx) => (
                            <tr key={idx}>
                              <td>{item.productName}</td>
                              <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{item.lotNo}</td>
                              <td>{item.expiryDate ? formatDate(item.expiryDate) : '—'}</td>
                              <td>{item.location || '—'}</td>
                              <td className="text-right">{(item.expectedQuantity ?? 0).toLocaleString()}</td>
                              <td className="text-right">{(item.actualQuantity ?? 0).toLocaleString()}</td>
                              <td className={`text-right variance-${item.status}`}>
                                {item.variance > 0 ? '+' : ''}{(item.variance ?? 0).toLocaleString()}
                              </td>
                              <td>
                                <span className={`status-badge-${item.status}`}>
                                  {item.status === 'ok' ? '✓' : '⚠'}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default CycleCountingPage;
