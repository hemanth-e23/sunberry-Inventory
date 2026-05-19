import React, { useState } from 'react';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import { useToast } from '../../context/ToastContext';
import ShipOutLineEditor, { buildLinePayload, emptyShipOutLine } from './ShipOutLineEditor';
import '../InventoryActionsPage.css';

/**
 * Ship Out tab — multi-product order builder.
 *
 * Layout:
 *   Order Number (single field at top)
 *   Line 1, Line 2, … (each Line = one product, cases needed, pallet selection)
 *   + Add another product
 *   Submit Ship-Out
 *
 * One submit creates one InventoryTransfer (the order) plus one
 * InventoryTransferLine per (product, receipt) pair on the backend.
 */
const ShipOutTab = () => {
  const { addToast } = useToast();
  const { isCorporateUser, selectedWarehouse, selectedWarehouseName } = useAuth();
  const { confirm } = useConfirm();
  const { createShipOutPickList } = useAppData();

  const [orderNumber, setOrderNumber] = useState('');
  const [lines, setLines] = useState([emptyShipOutLine()]);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateLine = (idx, next) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? next : l)));
  };

  const addLine = () => {
    setLines((prev) => [...prev, emptyShipOutLine()]);
  };

  const removeLine = (idx) => {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  };

  const takenPalletIdsExcept = (excludeIdx) => {
    const ids = [];
    lines.forEach((ln, i) => {
      if (i === excludeIdx) return;
      ids.push(...(ln.selectedPalletIds || []));
    });
    return ids;
  };

  const totalCases = lines.reduce((sum, ln) => {
    const info = ln.selectedPalletInfo || {};
    return sum + (ln.selectedPalletIds || []).reduce((s, id) => s + (info[id]?.cases || 0), 0);
  }, 0);
  const totalPallets = lines.reduce((sum, ln) => sum + (ln.selectedPalletIds?.length || 0), 0);
  const productCount = new Set(lines.map((ln) => ln.productId).filter(Boolean)).size;

  const handleSubmit = async () => {
    setError('');

    if (!orderNumber.trim()) {
      setError('Order number is required.');
      return;
    }
    if (lines.length === 0) {
      setError('Add at least one product line.');
      return;
    }

    const payloadLines = [];
    const seen = new Set();
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const built = buildLinePayload(ln);
      if (!built) {
        setError(`Line ${i + 1}: select a product, enter cases needed, and pick at least one pallet.`);
        return;
      }
      for (const pid of ln.selectedPalletIds) {
        if (seen.has(pid)) {
          setError(`Pallet selected on more than one line. Each pallet can only ship once per order.`);
          return;
        }
        seen.add(pid);
      }
      payloadLines.push(built);
    }

    if (isCorporateUser && selectedWarehouse) {
      const ok = await confirm(
        `You are about to log this ship-out to "${selectedWarehouseName || 'Selected Warehouse'}". Is this the correct location?`
      );
      if (!ok) return;
    }

    setIsSubmitting(true);
    try {
      const result = await createShipOutPickList({
        orderNumber: orderNumber.trim(),
        lines: payloadLines,
      });
      if (result.success) {
        if (result.warning) addToast(result.warning, 'warning');
        addToast('Ship-out submitted. Forklift can now scan pallets.', 'success');
        setOrderNumber('');
        setLines([emptyShipOutLine()]);
      } else {
        setError(result.error || 'Submit failed');
        addToast(result.error || 'Submit failed', 'error');
      }
    } catch (e) {
      const msg = e?.message || 'Submit failed';
      setError(msg);
      addToast(msg, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="tab-panel">
      <div className="action-form" style={{ maxWidth: '900px', margin: '0 auto' }}>
        <h3>Ship Out Order</h3>
        <p className="muted small">
          Add a line per product. Each line can draw pallets from multiple lots (FIFO across receipts).
          One order can ship multiple products at once.
        </p>

        <label>
          <span>Order Number <span className="required">*</span></span>
          <input
            type="text"
            value={orderNumber}
            onChange={(e) => setOrderNumber(e.target.value)}
            placeholder="Enter order/reference number"
            required
          />
        </label>

        <div style={{ marginTop: '12px' }}>
          {lines.map((ln, idx) => (
            <ShipOutLineEditor
              key={idx}
              lineIndex={idx}
              value={ln}
              onChange={(next) => updateLine(idx, next)}
              onRemove={() => removeLine(idx)}
              canRemove={lines.length > 1}
              takenPalletIds={takenPalletIdsExcept(idx)}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={addLine}
          style={{
            background: '#eff6ff',
            border: '1.5px dashed #93c5fd',
            color: '#1e40af',
            padding: '10px',
            borderRadius: '8px',
            cursor: 'pointer',
            width: '100%',
            fontWeight: 600,
            fontSize: '14px',
            marginBottom: '12px',
          }}
        >
          + Add another product
        </button>

        {error && <div className="alert error" style={{ marginBottom: '12px' }}>{error}</div>}

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '10px 12px',
            background: '#f9fafb',
            borderRadius: '8px',
            marginBottom: '12px',
            fontSize: '13px',
            color: '#374151',
          }}
        >
          <span>
            Order total: <strong>{totalCases.toLocaleString()} cases</strong> · {totalPallets} pallets · {productCount} product{productCount !== 1 ? 's' : ''}
          </span>
        </div>

        <button
          type="button"
          className="primary-button"
          onClick={handleSubmit}
          disabled={isSubmitting || !orderNumber.trim() || totalPallets === 0}
          style={{ width: '100%' }}
        >
          {isSubmitting
            ? 'Submitting…'
            : `Submit Ship-Out (${totalPallets} pallets · ${totalCases.toLocaleString()} cases)`}
        </button>
      </div>
    </div>
  );
};

export default ShipOutTab;
