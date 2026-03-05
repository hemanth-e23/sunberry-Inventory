import React from 'react';

/**
 * Props:
 *   open          {boolean}
 *   summary       {object}   { product, totalCases, rackCases, floorCases, licencePreview, placements[] }
 *   isSubmitting  {boolean}
 *   onConfirm     {function}
 *   onCancel      {function}
 *   formatNumber  {function}
 */
const ReceiptConfirmModal = ({ open, summary, isSubmitting, onConfirm, onCancel, formatNumber }) => {
  if (!open || !summary) return null;

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-header">
          <h3>Review Finished-Good Receipt</h3>
          <p className="muted">
            Confirm the lot details and pallet placements before submitting for approval.
          </p>
        </div>
        <div className="modal-body">
          <div className="modal-summary">
            <div>
              <strong>Product</strong>
              <span>{summary.product}</span>
            </div>
            <div>
              <strong>Total Cases Produced</strong>
              <span>{formatNumber(summary.totalCases)}</span>
            </div>
            <div>
              <strong>Rack Cases</strong>
              <span>{formatNumber(summary.rackCases)}</span>
            </div>
            <div>
              <strong>Floor Cases</strong>
              <span>{formatNumber(summary.floorCases)}</span>
            </div>
            {summary.licencePreview && (
              <div style={{ gridColumn: "1 / -1", marginTop: "8px", fontSize: "0.9rem" }}>
                <strong>Pallet licences:</strong> {summary.licencePreview}
              </div>
            )}
          </div>

          <div className="table-wrapper mini">
            <table className="report-table confirmation-table">
              <thead>
                <tr>
                  <th>Storage Area</th>
                  <th>Row</th>
                  <th>Pallets</th>
                  <th>Cases</th>
                </tr>
              </thead>
              <tbody>
                {summary.placements.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="empty-state">
                      All pallets staged on floor.
                    </td>
                  </tr>
                ) : (
                  summary.placements.map((placement, index) => (
                    <tr key={`${placement.areaName}-${placement.rowName}-${index}`}>
                      <td>{placement.areaName}</td>
                      <td>{placement.rowName}</td>
                      <td>{formatNumber(placement.pallets)}</td>
                      <td>{formatNumber(placement.cases)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>
            Go Back
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={onConfirm}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Submitting...' : 'Submit Receipt'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ReceiptConfirmModal;
