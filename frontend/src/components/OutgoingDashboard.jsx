import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useConfirm } from '../context/ConfirmContext';
import { getDashboardPath } from '../App';
import { getTodayDateKey, formatDate } from '../utils/dateUtils';
import Modal from './Modal';
import ShipOutOrderDetail from './ShipOutOrderDetail';
import { StatusChip, MiniPipeline } from './ShipOutPipeline';
import './Shared.css';
import './MasterDataPage.css';
import './OutgoingDashboard.css';

const TIME_SLOTS = Array.from({ length: 24 }, (_, h) => {
  const ampm = h < 12 ? 'AM' : 'PM';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${String(hr).padStart(2, '0')}:00 ${ampm}`;
});

// Shift a YYYY-MM-DD key by N days (UTC-noon avoids DST edge cases).
const shiftDateKey = (key, days) => {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
};

// "03:00 AM" → { t: "03:00", ampm: "AM" }
const splitTime = (appt) => {
  if (!appt) return { t: '—', ampm: '' };
  const m = appt.match(/^(\d{1,2}:\d{2})\s*(AM|PM)?$/i);
  return m ? { t: m[1], ampm: (m[2] || '').toUpperCase() } : { t: appt, ampm: '' };
};

const ACTIVE_STATUSES = ['checked_in', 'scanning'];
const DONE_STATUSES = ['reconciled', 'complete', 'docs_generated'];

const OutgoingDashboard = () => {
  const navigate = useNavigate();
  const { user, selectedWarehouseName } = useAuth();
  const { addToast } = useToast();
  const { confirm } = useConfirm();

  const today = getTodayDateKey();
  const [dateKey, setDateKey] = useState(today);
  const [orders, setOrders] = useState([]);
  const [overdue, setOverdue] = useState([]);
  const [loading, setLoading] = useState(false);

  const [reschedTarget, setReschedTarget] = useState(null);
  const [reschedDate, setReschedDate] = useState('');
  const [reschedTime, setReschedTime] = useState('');

  const [checkInTarget, setCheckInTarget] = useState(null);
  const emptyCheckIn = {
    carrier: '', driver_name: '', driver_license: '',
    truck_number: '', truck_license: '', trailer_number: '', trailer_license: '',
  };
  const [checkIn, setCheckIn] = useState(emptyCheckIn);
  const [carriers, setCarriers] = useState([]);

  const [detailId, setDetailId] = useState(null);

  const overdueRef = useRef(null);
  const scrollToOverdue = () => overdueRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  useEffect(() => {
    apiClient.get('/master-data/carriers')
      .then(r => setCarriers((r.data || []).map(c => c.name).filter(Boolean)))
      .catch(() => { /* type-ahead is optional */ });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [day, over] = await Promise.all([
        apiClient.get('/inventory/ship-out/scheduled', { params: { date: dateKey } }),
        apiClient.get('/inventory/ship-out/scheduled/overdue', { params: { before: today } }),
      ]);
      setOrders(day.data || []);
      setOverdue(over.data || []);
    } catch (e) {
      addToast(e?.response?.data?.detail || 'Failed to load scheduled shipments', 'error');
    } finally {
      setLoading(false);
    }
  }, [dateKey, today, addToast]);

  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => ({
    total: orders.filter(o => o.status !== 'cancelled').length,
    scheduled: orders.filter(o => o.status === 'scheduled').length,
    loading: orders.filter(o => ACTIVE_STATUSES.includes(o.status)).length,
    done: orders.filter(o => DONE_STATUSES.includes(o.status)).length,
    cancelled: orders.filter(o => o.status === 'cancelled').length,
  }), [orders]);

  const openReschedule = (row) => {
    setReschedTarget(row);
    setReschedDate(row.scheduled_date || dateKey);
    setReschedTime(row.appointment_time || '');
  };

  const submitReschedule = async () => {
    try {
      await apiClient.patch(`/inventory/transfers/${reschedTarget.id}/reschedule`, {
        scheduled_date: reschedDate,
        appointment_time: reschedTime || null,
      });
      addToast(`Order ${reschedTarget.order_number} moved to ${formatDate(reschedDate)}.`, 'success');
      setReschedTarget(null);
      load();
    } catch (e) {
      addToast(e?.response?.data?.detail || 'Reschedule failed', 'error');
    }
  };

  const openCheckIn = (row) => {
    setCheckInTarget(row);
    // Pre-fill from the schedule (carrier) + any prior check-in so an
    // already-checked-in order can be corrected.
    setCheckIn({
      carrier: row.carrier || '',
      driver_name: row.driver_name || '',
      driver_license: row.driver_license || '',
      truck_number: row.truck_number || '',
      truck_license: row.truck_license || '',
      trailer_number: row.trailer_number || '',
      trailer_license: row.trailer_license || '',
    });
  };

  const submitCheckIn = async () => {
    const wasCheckedIn = checkInTarget.status !== 'scheduled';
    try {
      await apiClient.post(`/inventory/transfers/${checkInTarget.id}/check-in`, checkIn);
      addToast(
        wasCheckedIn
          ? `Check-in details for ${checkInTarget.order_number} updated.`
          : `Order ${checkInTarget.order_number} checked in — now on the forklift gun.`,
        'success',
      );
      setCheckInTarget(null);
      load();
    } catch (e) {
      addToast(e?.response?.data?.detail || 'Check-in failed', 'error');
    }
  };

  const cancelOrder = async (row) => {
    const ok = await confirm(`Cancel scheduled order ${row.order_number}? You can restore it later from this list if needed.`);
    if (!ok) return;
    try {
      await apiClient.post(`/inventory/transfers/${row.id}/cancel-scheduled`);
      addToast(`Order ${row.order_number} cancelled. Use Restore on its card to undo.`, 'success');
      load();
    } catch (e) {
      addToast(e?.response?.data?.detail || 'Cancel failed', 'error');
    }
  };

  const restoreOrder = async (row) => {
    try {
      await apiClient.post(`/inventory/transfers/${row.id}/restore-scheduled`);
      addToast(`Order ${row.order_number} restored to Scheduled.`, 'success');
      load();
    } catch (e) {
      addToast(e?.response?.data?.detail || 'Restore failed', 'error');
    }
  };

  const renderCard = (row, { overdue: isOverdue } = {}) => {
    const { t, ampm } = splitTime(row.appointment_time);
    const products = row.detail || [];
    const truckBits = [row.driver_name, row.truck_number && `Truck ${row.truck_number}`, row.trailer_number && `Trailer ${row.trailer_number}`]
      .filter(Boolean).join(' · ');
    return (
      <div key={row.id}
           className={`og-card${row.status === 'cancelled' ? ' is-cancelled' : ''}${isOverdue ? ' is-overdue' : ''}`}>
        <div className="og-card-time">
          <span className="t">{t}</span>
          {ampm && <span className="ampm">{ampm}</span>}
          {isOverdue && <span className="d">{formatDate(row.scheduled_date)}</span>}
        </div>

        <div className="og-card-main">
          <div className="og-card-title">
            <button className="og-ordno-badge" onClick={() => setDetailId(row.id)} title="Open order detail">
              <span className="og-ordno-label">Order</span>
              <span className="og-ordno-num">#{row.order_number}</span>
            </button>
            <span className="cust">{row.customer_name || 'No customer'}</span>
            <span className="loc">{row.location || row.ship_to_name || ''}</span>
          </div>
          <div className="og-card-meta">
            {row.po_number && <span>PO <b>{row.po_number}</b></span>}
            {row.carrier && <span>Carrier <b>{row.carrier}</b></span>}
            <span><b>{Number(row.total_cases).toLocaleString()}</b> cases</span>
            <span>{products.length === 1
              ? <b>{products[0].product}</b>
              : <><b>{products.length}</b> products</>}
            </span>
            {truckBits && <span className="truckinfo">🚛 {truckBits}</span>}
          </div>
          {row.status === 'cancelled'
            ? <div className="og-card-meta" style={{ marginTop: '10px' }}><span>Cancelled — can be restored to Scheduled.</span></div>
            : <MiniPipeline status={row.status} />}
        </div>

        <div className="og-card-side">
          <StatusChip status={isOverdue ? 'overdue' : row.status}
                      label={isOverdue ? 'Overdue' : row.status_label} />
          <div className="og-card-actions">
            {row.status === 'scheduled' && (
              <button className="og-btn og-btn-primary" onClick={() => openCheckIn(row)}>Check In</button>
            )}
            {['checked_in', 'scanning', 'reconciled'].includes(row.status) && (
              <button className="og-btn og-btn-ghost" onClick={() => openCheckIn(row)}>Edit Check-In</button>
            )}
            {['reconciled', 'complete', 'docs_generated'].includes(row.status) && (
              <button className="og-btn og-btn-primary" onClick={() => setDetailId(row.id)}>
                {row.status === 'docs_generated' ? 'Documents' : 'Finalize & Docs'}
              </button>
            )}
            {ACTIVE_STATUSES.includes(row.status) && (
              <button className="og-btn og-btn-ghost" onClick={() => setDetailId(row.id)}>Watch Loading</button>
            )}
            {row.can_modify && (
              <>
                <button className="og-btn og-btn-ghost" onClick={() => openReschedule(row)}>Reschedule</button>
                <button className="og-btn og-btn-danger-ghost" onClick={() => cancelOrder(row)}>Cancel</button>
              </>
            )}
            {row.status === 'cancelled' && (
              <button className="og-btn og-btn-ghost" onClick={() => restoreOrder(row)}>↩ Restore</button>
            )}
          </div>
        </div>
      </div>
    );
  };

  if (detailId) {
    return (
      <div className="inventory-actions-page">
        <ShipOutOrderDetail orderId={detailId} onBack={() => { setDetailId(null); load(); }} />
      </div>
    );
  }

  return (
    <div className="inventory-actions-page">
      <div className="page-header">
        <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
          &larr; Back to Dashboard
        </button>
      </div>

      <div className="og-header">
        <div>
          <h2>Outgoing — Scheduled Shipments</h2>
          <div className="og-sub">
            Trucks scheduled to ship out.{selectedWarehouseName ? ` Warehouse: ${selectedWarehouseName}.` : ''}
          </div>
        </div>
      </div>

      <div className="og-toolbar">
        <div className="og-datenav">
          <button className="og-navbtn" onClick={() => setDateKey(k => shiftDateKey(k, -1))} title="Previous day">‹</button>
          <div className="og-date-display">
            <span className="og-date-label">{dateKey === today ? 'Today' : formatDate(dateKey)}</span>
            <span className="og-date-sub">{dateKey === today ? formatDate(dateKey) : 'scheduled shipments'}</span>
          </div>
          <button className="og-navbtn" onClick={() => setDateKey(k => shiftDateKey(k, 1))} title="Next day">›</button>
          <input type="date" className="og-date-input" value={dateKey} onChange={(e) => setDateKey(e.target.value)} title="Jump to date" />
          <button className="og-todaybtn" onClick={() => setDateKey(today)} disabled={dateKey === today}>
            Today
          </button>
        </div>
        <div className="og-counts">
          <span className="og-count"><b>{counts.total}</b> truck{counts.total !== 1 ? 's' : ''}</span>
          {counts.scheduled > 0 && <span className="og-count"><b>{counts.scheduled}</b> scheduled</span>}
          {counts.loading > 0 && <span className="og-count is-loading"><span className="og-live-dot" /><b>{counts.loading}</b> loading</span>}
          {counts.done > 0 && <span className="og-count is-done"><b>{counts.done}</b> done</span>}
          {counts.cancelled > 0 && <span className="og-count"><b>{counts.cancelled}</b> cancelled</span>}
          {overdue.length > 0 && (
            <button className="og-count is-overdue is-clickable" onClick={scrollToOverdue}
                    title="Jump to overdue orders">
              <b>{overdue.length}</b> overdue ›
            </button>
          )}
        </div>
      </div>

      {overdue.length > 0 && (
        <div ref={overdueRef}>
          <div className="og-section-label danger">
            ⚠ Overdue ({overdue.length}) — ship date passed, never checked in
            <span className="og-section-hint">Reschedule to a new day or cancel</span>
          </div>
          <div className="og-cards" style={{ marginBottom: 'var(--spacing-lg)' }}>
            {overdue.map(r => renderCard(r, { overdue: true }))}
          </div>
          <div className="og-section-label">{dateKey === today ? "Today's schedule" : formatDate(dateKey)}</div>
        </div>
      )}

      {loading ? (
        <div className="og-empty"><div className="big">⏳</div>Loading schedule…</div>
      ) : orders.length ? (
        <div className="og-cards">{orders.map(r => renderCard(r))}</div>
      ) : (
        <div className="og-empty">
          <div className="big">🚚</div>
          No shipments scheduled for {formatDate(dateKey)}.
          <div className="small" style={{ marginTop: '6px' }}>
            Corporate schedules orders under Inventory Actions → Schedule Ship-Out.
          </div>
        </div>
      )}

      <Modal isOpen={!!checkInTarget} onClose={() => setCheckInTarget(null)}
             title={`${checkInTarget && checkInTarget.status !== 'scheduled' ? 'Edit Check-In' : 'Check In'} — ${checkInTarget?.order_number || ''}`}>
        <div className="og-modal-form">
          <p className="og-modal-note">
            {checkInTarget && checkInTarget.status !== 'scheduled'
              ? 'Correct or complete the carrier / truck / driver details. The order keeps its current status.'
              : 'Confirm the carrier and enter the truck/driver details on arrival. This releases the order to the forklift gun. Fields can be completed before paperwork.'}
          </p>

          <div className="og-fieldset-label">Carrier</div>
          <label><span>Carrier <span className="og-prefill">pre-filled by corporate · editable</span></span>
            <input list="og-carrier-list" value={checkIn.carrier}
                   onChange={(e) => setCheckIn(p => ({ ...p, carrier: e.target.value }))}
                   placeholder="Carrier name" autoFocus />
            <datalist id="og-carrier-list">
              {carriers.map(c => <option key={c} value={c} />)}
            </datalist>
          </label>

          <div className="og-fieldset-label">Driver</div>
          <div className="row2">
            <label><span>Driver Name</span>
              <input value={checkIn.driver_name} onChange={(e) => setCheckIn(p => ({ ...p, driver_name: e.target.value }))} /></label>
            <label><span>Driver License #</span>
              <input value={checkIn.driver_license} onChange={(e) => setCheckIn(p => ({ ...p, driver_license: e.target.value }))} /></label>
          </div>

          <div className="og-fieldset-label">Tractor / Truck</div>
          <div className="row2">
            <label><span>Tractor / Truck #</span>
              <input value={checkIn.truck_number} onChange={(e) => setCheckIn(p => ({ ...p, truck_number: e.target.value }))} placeholder="unit #" /></label>
            <label><span>Tractor License Plate #</span>
              <input value={checkIn.truck_license} onChange={(e) => setCheckIn(p => ({ ...p, truck_license: e.target.value }))} placeholder="plate #" /></label>
          </div>

          <div className="og-fieldset-label">Trailer</div>
          <div className="row2">
            <label><span>Trailer #</span>
              <input value={checkIn.trailer_number} onChange={(e) => setCheckIn(p => ({ ...p, trailer_number: e.target.value }))} placeholder="e.g. 2286" /></label>
            <label><span>Trailer License Plate #</span>
              <input value={checkIn.trailer_license} onChange={(e) => setCheckIn(p => ({ ...p, trailer_license: e.target.value }))} placeholder="plate #" /></label>
          </div>

          <div className="og-modal-actions">
            <button className="og-btn og-btn-primary" onClick={submitCheckIn}>
              {checkInTarget && checkInTarget.status !== 'scheduled' ? 'Save Changes' : 'Check In & Release to Gun'}
            </button>
            <button className="og-btn og-btn-ghost" onClick={() => setCheckInTarget(null)}>Cancel</button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!reschedTarget} onClose={() => setReschedTarget(null)}
             title={`Reschedule ${reschedTarget?.order_number || ''}`}>
        <div className="og-modal-form">
          <label>
            <span>New Ship Date</span>
            <input type="date" value={reschedDate} onChange={(e) => setReschedDate(e.target.value)} />
          </label>
          <label>
            <span>Appointment Time</span>
            <select value={reschedTime} onChange={(e) => setReschedTime(e.target.value)}>
              <option value="">— Select time —</option>
              {TIME_SLOTS.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <div className="og-modal-actions">
            <button className="og-btn og-btn-primary" onClick={submitReschedule} disabled={!reschedDate}>Save</button>
            <button className="og-btn og-btn-ghost" onClick={() => setReschedTarget(null)}>Cancel</button>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default OutgoingDashboard;
