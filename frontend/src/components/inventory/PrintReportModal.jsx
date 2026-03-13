import React, { useState } from "react";
import { formatDateTime as formatDate, escapeHtml } from "../../utils/dateUtils";
import { CATEGORY_TYPES } from '../../constants';

const PrintReportModal = ({
  inventoryRows,
  productsById,
  categoriesById,
  onClose,
}) => {
  const [printOptions, setPrintOptions] = useState({
    includeRawMaterials: true,
    includePackaging: true,
    includeFinishedGoods: true,
    includeAllCategories: false
  });

  const handlePrint = () => {
    let dataToPrint = inventoryRows;

    if (!printOptions.includeAllCategories) {
      dataToPrint = inventoryRows.filter(row => {
        const product = productsById[row.id];
        const category = categoriesById[product?.categoryId];

        if (printOptions.includeRawMaterials && category?.type === 'raw') return true;
        if (printOptions.includePackaging && category?.type === CATEGORY_TYPES.PACKAGING) return true;
        if (printOptions.includeFinishedGoods && category?.type === CATEGORY_TYPES.FINISHED) return true;

        return false;
      });
    }

    const printContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Inventory Report - ${formatDate(new Date().toISOString())}</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; }
            h1 { color: #333; border-bottom: 2px solid #4a90e2; padding-bottom: 10px; }
            .report-info { margin: 20px 0; color: #666; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
            th { background-color: #f5f5f5; font-weight: bold; }
            .quantity { text-align: right; }
            .hold-active { background-color: #fff3cd; }
            .low-stock { background-color: #f8d7da; }
            .zero-inventory { background-color: #f8d7da; }
            .footer { margin-top: 30px; font-size: 12px; color: #666; }
          </style>
        </head>
        <body>
          <h1>Sunberry Inventory Report</h1>
          <div class="report-info">
            <p><strong>Report Date:</strong> ${formatDate(new Date().toISOString())}</p>
            <p><strong>Total Items:</strong> ${dataToPrint.length}</p>
            <p><strong>Categories Included:</strong>
              ${printOptions.includeAllCategories ? 'All Categories' : ''}
              ${!printOptions.includeAllCategories && printOptions.includeRawMaterials ? 'Raw Materials' : ''}
              ${!printOptions.includeAllCategories && printOptions.includePackaging ? ', Packaging Materials' : ''}
              ${!printOptions.includeAllCategories && printOptions.includeFinishedGoods ? ', Finished Goods' : ''}
            </p>
          </div>

          <table>
            <thead>
              <tr>
                <th>Product Name</th>
                <th>Category</th>
                <th>Type</th>
                <th>Available Quantity</th>
                <th>Hold Status</th>
                <th>Lots Tracked</th>
                <th>Pending Receipts</th>
                <th>Last Receipt</th>
                <th>Last Approval</th>
              </tr>
            </thead>
            <tbody>
              ${dataToPrint.map(row => `
                <tr class="${row.quantity === 0 ? 'zero-inventory' : row.quantity < 100 ? 'low-stock' : ''} ${row.holdActive ? 'hold-active' : ''}">
                  <td>${escapeHtml(row.name)}</td>
                  <td>${escapeHtml(row.category)}</td>
                  <td>${escapeHtml(row.type)}</td>
                  <td class="quantity">${row.quantity.toLocaleString()}</td>
                  <td>${escapeHtml(row.holdLabel)}</td>
                  <td>${row.lotCount}</td>
                  <td>${row.pendingCount}</td>
                  <td>${escapeHtml(row.lastSubmittedBy)}<br><small>${row.lastSubmittedAt}</small></td>
                  <td>${escapeHtml(row.lastApprovedBy)}<br><small>${row.lastApprovedAt}</small></td>
                </tr>
              `).join('')}
            </tbody>
          </table>

          <div class="footer">
            <p>Generated on ${formatDate(new Date().toISOString())} | Sunberry Inventory Management System</p>
          </div>
        </body>
      </html>
    `;

    const printWindow = window.open('', '_blank');
    printWindow.document.write(printContent);
    printWindow.document.close();
    printWindow.focus();

    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 250);

    onClose();
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <div className="modal-header">
          <h3>Print Options</h3>
          <button
            onClick={onClose}
            className="modal-close"
          >
            ×
          </button>
        </div>

        <div className="modal-body">
          <p>Select which categories to include in your inventory report:</p>

          <div className="print-options">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={printOptions.includeAllCategories}
                onChange={(e) => setPrintOptions(prev => ({
                  ...prev,
                  includeAllCategories: e.target.checked,
                  includeRawMaterials: e.target.checked,
                  includePackaging: e.target.checked,
                  includeFinishedGoods: e.target.checked
                }))}
              />
              <span>All Categories</span>
            </label>

            <div className="category-options">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={printOptions.includeRawMaterials}
                  onChange={(e) => setPrintOptions(prev => ({
                    ...prev,
                    includeRawMaterials: e.target.checked,
                    includeAllCategories: false
                  }))}
                  disabled={printOptions.includeAllCategories}
                />
                <span>Raw Materials</span>
              </label>

              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={printOptions.includePackaging}
                  onChange={(e) => setPrintOptions(prev => ({
                    ...prev,
                    includePackaging: e.target.checked,
                    includeAllCategories: false
                  }))}
                  disabled={printOptions.includeAllCategories}
                />
                <span>Packaging Materials</span>
              </label>

              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={printOptions.includeFinishedGoods}
                  onChange={(e) => setPrintOptions(prev => ({
                    ...prev,
                    includeFinishedGoods: e.target.checked,
                    includeAllCategories: false
                  }))}
                  disabled={printOptions.includeAllCategories}
                />
                <span>Finished Goods</span>
              </label>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button
            onClick={onClose}
            className="cancel-btn"
          >
            Cancel
          </button>
          <button
            onClick={handlePrint}
            className="print-confirm-btn"
            disabled={!printOptions.includeRawMaterials && !printOptions.includePackaging && !printOptions.includeFinishedGoods && !printOptions.includeAllCategories}
          >
            Print Report
          </button>
        </div>
      </div>
    </div>
  );
};

export default PrintReportModal;
