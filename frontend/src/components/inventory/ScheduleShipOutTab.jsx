import React, { useMemo, useState, useEffect } from 'react';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../context/ConfirmContext';
import SearchableSelect from '../SearchableSelect';
import { CATEGORY_TYPES } from '../../constants';
import '../InventoryActionsPage.css';

// Hourly appointment slots in 12-hour format, matching the BOL ("07:00 AM").
const TIME_SLOTS = Array.from({ length: 24 }, (_, h) => {
  const ampm = h < 12 ? 'AM' : 'PM';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${String(hr).padStart(2, '0')}:00 ${ampm}`;
});

/**
 * Schedule Ship-Out tab (SPEC Task 2).
 *
 * Corporate/warehouse plans an order in advance: order number, ship date +
 * appointment, ship-to, PO, carrier, pallet type, and product lines (product +
 * cases — NO lots; lots are chosen live at scan time). Saved as `scheduled`;
 * it does NOT reach the forklift gun until yard check-in (Task 3/4).
 */
const NEW_SHIP_TO = '__new__';
const emptyLine = () => ({ productId: '', cases: '' });

const ScheduleShipOutTab = () => {
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const { isCorporateUser, selectedWarehouse, selectedWarehouseName } = useAuth();
  const {
    products, categories, palletTypes, shipToLocations, carriers, createScheduledOrder,
  } = useAppData();

  // Corporate/superadmin must target a specific warehouse (the create endpoint
  // rejects "All Warehouses"). Block the form until they pick one up top.
  const needsWarehouse = isCorporateUser && !selectedWarehouse;

  // Only finished goods ship on a BOL — exclude purees/concentrates/raw/packaging.
  // Shaped as {value,label} for SearchableSelect (type-to-search).
  const shippableProducts = useMemo(() => {
    return (products || [])
      .filter(p => {
        if (p.active === false) return false;
        const cat = (categories || []).find(c => c.id === p.categoryId);
        return cat?.type === CATEGORY_TYPES.FINISHED;
      })
      .map(p => ({ value: p.id, label: String(p.name || 'Unknown') }));
  }, [products, categories]);
  const defaultPalletTypeId = useMemo(
    () => (palletTypes || []).find(p => p.is_default)?.id || (palletTypes || [])[0]?.id || '',
    [palletTypes],
  );

  const [orderNumber, setOrderNumber] = useState('');
  const [scheduledDate, setScheduledDate] = useState('');
  const [appointmentTime, setAppointmentTime] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [carrier, setCarrier] = useState('');
  const [palletTypeId, setPalletTypeId] = useState('');
  const [shipToId, setShipToId] = useState('');
  const [newShipTo, setNewShipTo] = useState({
    customer_name: '', location_name: '', address_line1: '', city: '', state: '', zip_code: '',
  });
  const [lines, setLines] = useState([emptyLine()]);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!palletTypeId && defaultPalletTypeId) setPalletTypeId(defaultPalletTypeId);
  }, [defaultPalletTypeId, palletTypeId]);

  const totalCases = lines.reduce((s, l) => s + (Number(l.cases) || 0), 0);
  const updateLine = (i, patch) => setLines(prev => prev.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  const addLine = () => setLines(prev => [...prev, emptyLine()]);
  const removeLine = (i) => setLines(prev => prev.filter((_, idx) => idx !== i));

  const resetForm = () => {
    setOrderNumber(''); setScheduledDate(''); setAppointmentTime(''); setPoNumber('');
    setCarrier(''); setPalletTypeId(defaultPalletTypeId); setShipToId('');
    setNewShipTo({ customer_name: '', location_name: '', address_line1: '', city: '', state: '', zip_code: '' });
    setLines([emptyLine()]);
  };

  const handleSubmit = async () => {
    setError('');
    if (!orderNumber.trim()) return setError('Order number is required.');
    if (!scheduledDate) return setError('Ship date is required.');

    const payloadLines = [];
    const seen = new Set();
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln.productId || !(Number(ln.cases) > 0)) {
        return setError(`Line ${i + 1}: pick a product and enter cases (> 0).`);
      }
      if (seen.has(ln.productId)) {
        return setError(`Line ${i + 1}: product is on more than one line — combine into one.`);
      }
      seen.add(ln.productId);
      payloadLines.push({ product_id: ln.productId, cases_requested: Number(ln.cases) });
    }

    let ship_to = null;
    if (shipToId === NEW_SHIP_TO) {
      if (!newShipTo.customer_name.trim() || !newShipTo.location_name.trim()) {
        return setError('New ship-to needs at least a customer name and location name.');
      }
      ship_to = { ...newShipTo };
    } else if (shipToId) {
      ship_to = { id: shipToId };
    }

    if (isCorporateUser && selectedWarehouse) {
      const ok = await confirm(
        `You are about to schedule this order for "${selectedWarehouseName || 'Selected Warehouse'}". Is this the correct location?`
      );
      if (!ok) return;
    }

    const payload = {
      order_number: orderNumber.trim(),
      scheduled_date: scheduledDate,
      appointment_time: appointmentTime.trim() || null,
      po_number: poNumber.trim() || null,
      carrier: carrier.trim() || null,
      pallet_type_id: palletTypeId || null,
      ship_to,
      lines: payloadLines,
    };

    setIsSubmitting(true);
    try {
      const result = await createScheduledOrder(payload);
      if (result?.warning) addToast(result.warning, 'warning');
      addToast(`Scheduled order ${orderNumber.trim()} created for ${scheduledDate}.`, 'success');
      resetForm();
    } catch (e) {
      const msg = e?.response?.data?.detail || e?.message || 'Failed to create scheduled order';
      setError(msg);
      addToast(msg, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="tab-panel">
      <div className="action-form" style={{ maxWidth: '900px', margin: '0 auto' }}>
        <h3>Schedule Ship-Out Order</h3>
        <p className="muted small">
          Plan an order in advance. Pick products and cases — lots are chosen by the
          forklift at scan time. Saved as <strong>Scheduled</strong>; it reaches the
          forklift only after the truck checks in at the yard.
          {selectedWarehouseName ? ` Warehouse: ${selectedWarehouseName}.` : ''}
        </p>

        {needsWarehouse && (
          <div className="alert error" style={{ marginBottom: '12px' }}>
            Select a specific warehouse from the selector at the top of the page before
            scheduling an order.
          </div>
        )}

        <div className="form-grid-2">
          <label>
            <span>Order Number <span className="required">*</span></span>
            <input type="text" value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)}
                   placeholder="e.g. 06-12531" />
          </label>
          <label>
            <span>Ship Date <span className="required">*</span></span>
            <input type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} />
          </label>
          <label>
            <span>Appointment Time</span>
            <select value={appointmentTime} onChange={(e) => setAppointmentTime(e.target.value)}>
              <option value="">— Select time —</option>
              {TIME_SLOTS.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label>
            <span>PO Number</span>
            <input type="text" value={poNumber} onChange={(e) => setPoNumber(e.target.value)}
                   placeholder="e.g. 10520612207" />
          </label>
          <label>
            <span>Carrier</span>
            <input type="text" list="carrier-options" value={carrier}
                   onChange={(e) => setCarrier(e.target.value)} placeholder="e.g. IIK" />
            <datalist id="carrier-options">
              {(carriers || []).map(c => <option key={c.id} value={c.name} />)}
            </datalist>
          </label>
          <label>
            <span>Pallet Type</span>
            <select value={palletTypeId} onChange={(e) => setPalletTypeId(e.target.value)}>
              {(palletTypes || []).map(pt => (
                <option key={pt.id} value={pt.id}>{pt.name}{pt.is_default ? ' (default)' : ''}</option>
              ))}
            </select>
          </label>
        </div>

        <label style={{ marginTop: '4px' }}>
          <span>Ship To</span>
          <SearchableSelect
            options={[
              ...(shipToLocations || []).map(s => ({
                value: s.id,
                label: [
                  `${s.customer_name} — ${s.location_name}`,
                  [s.address_line1, s.city, s.state, s.zip_code].filter(Boolean).join(', '),
                ].filter(Boolean).join('  ·  '),
              })),
              { value: NEW_SHIP_TO, label: '＋ New ship-to…' },
            ]}
            value={shipToId}
            onChange={(v) => setShipToId(v)}
            placeholder="Select ship-to"
            searchPlaceholder="Search customer / city / address..."
          />
        </label>

        {shipToId && shipToId !== NEW_SHIP_TO && (() => {
          const s = (shipToLocations || []).find(x => x.id === shipToId);
          if (!s) return null;
          return (
            <div style={{ marginTop: '6px', padding: '10px 12px', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '8px', fontSize: '13px', lineHeight: 1.5 }}>
              <strong>{s.customer_name} — {s.location_name}</strong><br />
              {s.address_line1 || <em className="muted">no street address on file</em>}<br />
              {[s.city, s.state].filter(Boolean).join(', ')} {s.zip_code || ''}
            </div>
          );
        })()}

        {shipToId === NEW_SHIP_TO && (
          <div className="form-grid-2" style={{ marginTop: '8px', padding: '10px', background: '#f9fafb', borderRadius: '8px' }}>
            <label><span>Customer Name <span className="required">*</span></span>
              <input value={newShipTo.customer_name} onChange={(e) => setNewShipTo(p => ({ ...p, customer_name: e.target.value }))} placeholder="e.g. COSTCO" /></label>
            <label><span>Location Name <span className="required">*</span></span>
              <input value={newShipTo.location_name} onChange={(e) => setNewShipTo(p => ({ ...p, location_name: e.target.value }))} placeholder="e.g. COSTCO FREDERICK DRY" /></label>
            <label><span>Address</span>
              <input value={newShipTo.address_line1} onChange={(e) => setNewShipTo(p => ({ ...p, address_line1: e.target.value }))} placeholder="Street address" /></label>
            <label><span>City</span>
              <input value={newShipTo.city} onChange={(e) => setNewShipTo(p => ({ ...p, city: e.target.value }))} /></label>
            <label><span>State</span>
              <input value={newShipTo.state} onChange={(e) => setNewShipTo(p => ({ ...p, state: e.target.value }))} placeholder="e.g. MD" /></label>
            <label><span>ZIP</span>
              <input value={newShipTo.zip_code} onChange={(e) => setNewShipTo(p => ({ ...p, zip_code: e.target.value }))} /></label>
          </div>
        )}

        <div style={{ marginTop: '16px' }}>
          <div className="muted small" style={{ marginBottom: '6px', fontWeight: 600 }}>Products</div>
          {lines.map((ln, idx) => (
            <div key={idx} className="form-grid-2" style={{ alignItems: 'end', marginBottom: '8px' }}>
              <label>
                <span>Product <span className="required">*</span></span>
                <SearchableSelect
                  options={shippableProducts}
                  value={ln.productId}
                  onChange={(productId) => updateLine(idx, { productId })}
                  placeholder="Select finished goods product"
                  searchPlaceholder="Search products..."
                />
              </label>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'end' }}>
                <label style={{ flex: 1 }}>
                  <span>Cases <span className="required">*</span></span>
                  <input type="number" min="0" value={ln.cases}
                         onChange={(e) => updateLine(idx, { cases: e.target.value })} placeholder="0" />
                </label>
                {lines.length > 1 && (
                  <button type="button" className="secondary-button" onClick={() => removeLine(idx)}
                          style={{ height: '40px' }}>Remove</button>
                )}
              </div>
            </div>
          ))}
        </div>

        <button type="button" onClick={addLine} style={{
          background: '#eff6ff', border: '1.5px dashed #93c5fd', color: '#1e40af',
          padding: '10px', borderRadius: '8px', cursor: 'pointer', width: '100%',
          fontWeight: 600, fontSize: '14px', marginBottom: '12px', marginTop: '4px',
        }}>+ Add another product</button>

        {error && <div className="alert error" style={{ marginBottom: '12px' }}>{error}</div>}

        <button type="button" className="primary-button" onClick={handleSubmit}
                disabled={isSubmitting || needsWarehouse || !orderNumber.trim() || !scheduledDate || totalCases === 0}
                style={{ width: '100%' }}>
          {isSubmitting ? 'Creating…' : `Create Scheduled Order (${totalCases.toLocaleString()} cases)`}
        </button>
      </div>
    </div>
  );
};

export default ScheduleShipOutTab;
