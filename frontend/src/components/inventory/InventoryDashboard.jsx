import React, { useState, useMemo } from "react";
import { CATEGORY_TYPES, RECEIPT_STATUS } from '../../constants';

const InventoryDashboard = ({
  products,
  receipts,
  categoriesById,
  productsById,
  storageAreas,
}) => {
  const [showWidgets, setShowWidgets] = useState(true);

  const inventoryMetrics = useMemo(() => {
    const totalProducts = products.length;
    const activeProducts = products.filter(p => p.status === 'active').length;
    const onHoldProducts = receipts.filter(r => r.hold).length;
    const pendingReceipts = receipts.filter(r => r.status === RECEIPT_STATUS.RECORDED).length;

    const expiringSoon = receipts.filter(r => {
      if (!r.expiration) return false;
      const expiryDate = new Date(r.expiration);
      const sixMonthsFromNow = new Date();
      sixMonthsFromNow.setMonth(sixMonthsFromNow.getMonth() + 6);
      return expiryDate <= sixMonthsFromNow && expiryDate >= new Date();
    }).length;

    const lowStockItems = receipts.filter(r => r.quantity < 100).length;

    const totalValue = receipts.reduce((sum, r) => {
      const category = categoriesById[productsById[r.productId]?.categoryId];
      const pricePerCase = category?.type === CATEGORY_TYPES.FINISHED ? 5 : 2;
      return sum + (r.quantity * pricePerCase);
    }, 0);

    return {
      totalProducts,
      activeProducts,
      onHoldProducts,
      pendingReceipts,
      expiringSoon,
      lowStockItems,
      totalValue: Math.round(totalValue)
    };
  }, [products, receipts, categoriesById, productsById]);

  const finishedGoodsCapacity = useMemo(() => {
    const fgAreas = storageAreas.filter(area => area.active !== false);

    return fgAreas
      .map(area => {
        const totalCapacity = area.rows?.reduce((sum, row) => {
          const capacity = Number(row.palletCapacity) || 0;
          const casesPerPallet = Number(row.defaultCasesPerPallet) || 0;
          return sum + (capacity * casesPerPallet);
        }, 0) || 0;

        const currentQuantity = area.rows?.reduce((sum, row) => {
          const occupied = Number(row.occupiedCases) || 0;
          return sum + occupied;
        }, 0) || 0;

        const utilization = totalCapacity > 0 ? (currentQuantity / totalCapacity) * 100 : 0;

        return {
          name: area.name,
          totalCapacity,
          currentQuantity,
          utilization: Math.round(utilization),
          available: totalCapacity - currentQuantity
        };
      })
      .filter(area => area.totalCapacity > 0);
  }, [storageAreas]);

  return (
    <div className="collapsible-section">
      <div
        className="collapsible-header"
        onClick={() => setShowWidgets(!showWidgets)}
      >
        <h3>Inventory Overview</h3>
        <span className="chevron">{showWidgets ? '▼' : '▶'}</span>
      </div>
      {showWidgets && (
        <div className="collapsible-content">
          <p className="muted">
            Only approved receipts are counted. Pending receipts appear in the
            approvals queue.
          </p>

          <div className="dashboard-widgets">
            <div className="widget-row">
              <div className="metric-card">
                <div className="metric-content">
                  <div className="metric-value">{inventoryMetrics.totalProducts}</div>
                  <div className="metric-label">Total Products</div>
                </div>
              </div>
              <div className="metric-card">
                <div className="metric-content">
                  <div className="metric-value">{inventoryMetrics.activeProducts}</div>
                  <div className="metric-label">Active Products</div>
                </div>
              </div>
              <div className="metric-card">
                <div className="metric-content">
                  <div className="metric-value">{inventoryMetrics.pendingReceipts}</div>
                  <div className="metric-label">Pending Receipts</div>
                </div>
              </div>
            </div>

            <div className="widget-row">
              <div className="alert-card">
                <div className="alert-content">
                  <div className="alert-value">{inventoryMetrics.expiringSoon}</div>
                  <div className="alert-label">Expiring Soon (6 months)</div>
                </div>
              </div>
              <div className="alert-card">
                <div className="alert-content">
                  <div className="alert-value">{inventoryMetrics.lowStockItems}</div>
                  <div className="alert-label">
                    Low Stock Items
                    <span className="threshold-text">(products less than 100 cases)</span>
                  </div>
                </div>
              </div>
              <div className="alert-card">
                <div className="alert-content">
                  <div className="alert-value">{inventoryMetrics.onHoldProducts}</div>
                  <div className="alert-label">Items on Hold</div>
                </div>
              </div>
            </div>

            <div className="charts-row">
              <div className="chart-container">
                <h3>Finished Goods Capacity</h3>
                <div className="capacity-chart">
                  {finishedGoodsCapacity.map((area) => (
                    <div key={area.name} className="capacity-bar">
                      <div className="capacity-label">
                        <span>{area.name}</span>
                        <span className="capacity-stats">
                          {area.currentQuantity.toLocaleString()}/{area.totalCapacity.toLocaleString()} cases
                          ({area.utilization}%)
                        </span>
                      </div>
                      <div className="capacity-progress">
                        <div
                          className={`capacity-fill ${area.utilization > 80 ? 'high' : area.utilization > 60 ? 'medium' : 'low'}`}
                          style={{ width: `${Math.min(area.utilization, 100)}%` }}
                        ></div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default InventoryDashboard;
