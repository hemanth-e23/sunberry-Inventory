import React, { useCallback, useEffect, useMemo, useState } from 'react';
import apiClient from '../../api/client';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../context/ConfirmContext';
import SearchableSelect from '../SearchableSelect';
import ShipOutDocuments from '../ShipOutDocuments';
import { formatDateTime } from '../../utils/dateUtils';
import { shuttleSelectionTotals, selectRange } from '../../utils/moyelShuttle';
import { CATEGORY_TYPES, ROLES } from '../../constants';
import '../InventoryActionsPage.css';

const ADMIN_ROLES = [ROLES.ADMIN, ROLES.SUPERADMIN, ROLES.CORPORATE_ADMIN];

const STATUS_STYLE = {
  'in stock': { background: '#dcfce7', color: '#166534' },
  'waiting review': { background: '#e0e7ff', color: '#3730a3' },
  'scanning now': { background: '#fef3c7', color: '#92400e' },
  'never scanned': { background: '#fee2e2', color: '#991b1b' },
};

// Own box style: the global `.panel` rule lives in InventoryOverview.css,
// which is not loaded on Inventory Actions unless that page was opened first.
const PANEL_STYLE = {
  background: '#f9fbff',
  borderRadius: '12px',
  padding: '16px 20px',
  border: '1px solid rgba(148, 163, 184, 0.18)',
};

const rowKey = (r) => r.id || `missing:${r.licence_number}`;

/**
 * Moyel Shuttle (FG pallet lifecycle §1.1).
 *
 * Runs that go line → our own trailer → Moyel/RMI warehouse. The forklift
 * scans them to a dock (or the floor) and never submits mid-shift, so the
 * list offers everything physically loadable: in stock, waiting review, still
 * being scanned, and numbers nobody scanned. "Make paperwork" ships them on
 * one trailer record and prints the BOL; tomorrow's forklift review shows them
 * as "Moyel shuttle · trailer X".
 */
const MoyelShuttleTab = () => {
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const { user, isCorporateUser, selectedWarehouse } = useAuth();
  const { products, categories } = useAppData();
  const needsWarehouse = isCorporateUser && !selectedWarehouse;
  const isAdmin = ADMIN_ROLES.includes(user?.role);

  const fgProducts = useMemo(() => (products || [])
    .filter((p) => {
      if (p.active === false) return false;
      const cat = (categories || []).find((c) => c.id === p.categoryId);
      return cat?.type === CATEGORY_TYPES.FINISHED;
    })
    .map((p) => ({ value: p.id, label: String(p.name || 'Unknown') })), [products, categories]);

  const [trailer, setTrailer] = useState('');
  const [seal, setSeal] = useState('');
  const [destinations, setDestinations] = useState([]);
  const [destinationId, setDestinationId] = useState('');
  const [productId, setProductId] = useState('');
  const [available, setAvailable] = useState([]);
  const [loadingAvail, setLoadingAvail] = useState(false);
  // Every product on this trailer: key -> row (incl. product name).
  const [selected, setSelected] = useState({});
  const [lastClicked, setLastClicked] = useState(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([]);
  const [docs, setDocs] = useState(null); // { id, snapshot }
  const [destForm, setDestForm] = useState(null);

  const loadDestinations = useCallback(() => {
    apiClient.get('/inventory/moyel-shuttle/destinations', { params: { include_inactive: isAdmin } })
      .then((r) => {
        const list = r.data || [];
        setDestinations(list);
        setDestinationId((cur) => cur || list.find((d) => d.is_default)?.id || list[0]?.id || '');
      })
      .catch(() => setDestinations([]));
  }, [isAdmin]);
  const loadHistory = useCallback(() => {
    apiClient.get('/inventory/moyel-shuttle')
      .then((r) => setHistory(r.data || []))
      .catch(() => setHistory([]));
  }, []);
  useEffect(() => { loadDestinations(); loadHistory(); }, [loadDestinations, loadHistory, selectedWarehouse]);

  const loadAvailable = async (pid) => {
    setAvailable([]);
    setLastClicked(null);
    if (!pid) return;
    setLoadingAvail(true);
    try {
      const r = await apiClient.get('/inventory/moyel-shuttle/available', { params: { product_id: pid } });
      const name = r.data.product?.name;
      setAvailable((r.data.pallets || []).map((row) => ({ ...row, product_name: name })));
    } catch (err) {
      addToast(err.response?.data?.detail || 'Could not load pallets', 'error');
    } finally {
      setLoadingAvail(false);
    }
  };

  const toggle = (row, index, shiftKey) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (shiftKey && lastClicked != null) {
        const turnOn = !prev[rowKey(row)];
        for (const r of selectRange(available, lastClicked, index)) {
          if (turnOn) next[rowKey(r)] = r; else delete next[rowKey(r)];
        }
      } else if (next[rowKey(row)]) {
        delete next[rowKey(row)];
      } else {
        next[rowKey(row)] = row;
      }
      return next;
    });
    setLastClicked(index);
  };
  const selectAllShown = () => setSelected((prev) => {
    const next = { ...prev };
    for (const r of available) next[rowKey(r)] = r;
    return next;
  });
  const clearShown = () => setSelected((prev) => {
    const next = { ...prev };
    for (const r of available) delete next[rowKey(r)];
    return next;
  });

  const totals = shuttleSelectionTotals(Object.values(selected));

  const makePaperwork = async () => {
    if (!trailer.trim() || !seal.trim()) { addToast('Enter the trailer # and seal #.', 'error'); return; }
    const rows = Object.values(selected);
    if (!rows.length) { addToast('Select the pallets on this trailer.', 'error'); return; }
    const missingCount = rows.filter((r) => r.kind === 'missing').length;
    const ok = await confirm(
      `Ship ${totals.pallets} pallets (${totals.cases} cases) on trailer ${trailer.trim()}?`
      + (missingCount ? ` ${missingCount} never-scanned number(s) will be recorded as produced and shipped.` : '')
      + ' They leave inventory now.',
      { title: 'Make paperwork', confirmLabel: 'Make paperwork' },
    );
    if (!ok) return;
    setBusy(true);
    try {
      const r = await apiClient.post('/inventory/moyel-shuttle', {
        trailer_number: trailer.trim(),
        seal_number: seal.trim(),
        destination_id: destinationId || null,
        pallet_ids: rows.filter((x) => x.kind === 'pallet').map((x) => x.id),
        missing_licences: rows.filter((x) => x.kind === 'missing').map((x) => x.licence_number),
      });
      addToast(`Trailer ${r.data.trailer_number} recorded — ${r.data.pallets} pallets.`, 'success');
      setDocs({ id: r.data.id, snapshot: r.data.document_snapshot });
      setSelected({});
      setTrailer('');
      setSeal('');
      loadHistory();
      if (productId) loadAvailable(productId);
    } catch (err) {
      addToast(err.response?.data?.detail || 'Could not make the paperwork', 'error');
    } finally {
      setBusy(false);
    }
  };

  const openDocs = async (id) => {
    try {
      const r = await apiClient.get(`/inventory/moyel-shuttle/${id}`);
      setDocs({ id, snapshot: r.data.document_snapshot });
    } catch (err) {
      addToast(err.response?.data?.detail || 'Could not load the BOL', 'error');
    }
  };

  const saveDestination = async () => {
    try {
      const body = { ...destForm };
      delete body.id;
      if (destForm.id) await apiClient.patch(`/inventory/moyel-shuttle/destinations/${destForm.id}`, body);
      else await apiClient.post('/inventory/moyel-shuttle/destinations', body);
      setDestForm(null);
      loadDestinations();
    } catch (err) {
      addToast(err.response?.data?.detail || 'Could not save the destination', 'error');
    }
  };

  if (needsWarehouse) {
    return <div className="tab-panel"><p className="muted">Select a warehouse at the top to use the Moyel Shuttle.</p></div>;
  }

  const selectedProducts = Object.values(selected).reduce((acc, r) => {
    acc[r.product_name || '—'] = (acc[r.product_name || '—'] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="tab-panel">
      <div className="action-form" style={{ maxWidth: 'none' }}>
        <h3>Moyel Shuttle</h3>
        <p className="muted small">
          Load a trailer for the Moyel/RMI warehouse. Pick the pallets on it — in stock, waiting review, still being
          scanned, or numbers nobody scanned — then make the paperwork.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
          <label><span>Trailer # <span className="required">*</span></span>
            <input type="text" value={trailer} onChange={(e) => setTrailer(e.target.value)} />
          </label>
          <label><span>Seal # <span className="required">*</span></span>
            <input type="text" value={seal} onChange={(e) => setSeal(e.target.value)} />
          </label>
          <label><span>Destination</span>
            <select value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>
              {destinations.filter((d) => d.is_active).map((d) => (
                <option key={d.id} value={d.id}>{d.name}{d.city ? ` — ${d.city}, ${d.state || ''}` : ''}</option>
              ))}
            </select>
          </label>
          <label><span>Product</span>
            <SearchableSelect
              options={fgProducts}
              value={productId}
              onChange={(id) => { setProductId(id); loadAvailable(id); }}
              placeholder="Pick a product to add"
              searchPlaceholder="Search products..."
            />
          </label>
        </div>
        {isAdmin && (
          <div style={{ marginTop: '6px' }}>
            {destForm ? (
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                <input placeholder="Name" value={destForm.name || ''} onChange={(e) => setDestForm({ ...destForm, name: e.target.value })} />
                <input placeholder="Address" value={destForm.address_line1 || ''} onChange={(e) => setDestForm({ ...destForm, address_line1: e.target.value })} />
                <input placeholder="City" value={destForm.city || ''} onChange={(e) => setDestForm({ ...destForm, city: e.target.value })} />
                <input placeholder="State" style={{ width: '60px' }} value={destForm.state || ''} onChange={(e) => setDestForm({ ...destForm, state: e.target.value })} />
                <input placeholder="ZIP" style={{ width: '80px' }} value={destForm.zip_code || ''} onChange={(e) => setDestForm({ ...destForm, zip_code: e.target.value })} />
                <button type="button" className="primary-button" onClick={saveDestination}>Save</button>
                <button type="button" className="secondary-button" onClick={() => setDestForm(null)}>Cancel</button>
              </div>
            ) : (
              <>
                <button type="button" className="secondary-button" onClick={() => {
                  const d = destinations.find((x) => x.id === destinationId);
                  if (d) setDestForm({ id: d.id, name: d.name, address_line1: d.address_line1, city: d.city, state: d.state, zip_code: d.zip_code });
                }}>Edit destination</button>
                <button type="button" className="secondary-button" style={{ marginLeft: '6px' }} onClick={() => setDestForm({ name: '' })}>Add destination</button>
              </>
            )}
          </div>
        )}
      </div>

      {productId && (
        <div style={PANEL_STYLE}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <strong>Available — {fgProducts.find((p) => p.value === productId)?.label}</strong>
            <span className="muted small">Shift-click to select a range.</span>
            <span>
              <button type="button" className="secondary-button" onClick={selectAllShown}>Select all</button>
              <button type="button" className="secondary-button" style={{ marginLeft: '6px' }} onClick={clearShown}>Clear</button>
            </span>
          </div>
          {loadingAvail ? <p className="muted">Loading…</p> : available.length === 0 ? (
            <p className="muted">Nothing loadable for this product.</p>
          ) : (
            <div style={{ maxHeight: '420px', overflow: 'auto', marginTop: '8px' }}>
              <table className="data-table" style={{ width: '100%' }}>
                <thead>
                  <tr><th /><th>Lot</th><th>#</th><th>Licence</th><th>Cases</th><th>Row / dock</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {available.map((r, i) => (
                    <tr key={rowKey(r)} onClick={(e) => toggle(r, i, e.shiftKey)} style={{ cursor: 'pointer' }}>
                      <td><input type="checkbox" readOnly checked={!!selected[rowKey(r)]} aria-label={`Select ${r.licence_number}`} /></td>
                      <td>{r.lot_number}</td>
                      <td>{String(r.sequence ?? '').padStart(3, '0')}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{r.licence_number}</td>
                      <td>{r.cases}{r.is_partial ? ' (partial)' : ''}</td>
                      <td>{r.row_name || '—'}</td>
                      <td><span className="badge" style={STATUS_STYLE[r.status_label] || {}}>{r.status_label}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div style={{ ...PANEL_STYLE, display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          <strong>On this trailer: {totals.pallets} pallets · {totals.cases} cases</strong>
          <div className="muted small">
            {Object.entries(selectedProducts).map(([n, c]) => `${n}: ${c}`).join(' · ') || 'Nothing selected yet'}
          </div>
        </div>
        <button type="button" className="primary-button" disabled={busy || !totals.pallets} onClick={makePaperwork}>
          {busy ? 'Working…' : 'Make paperwork'}
        </button>
      </div>

      {docs?.snapshot && (
        <div style={{ marginTop: '12px' }}>
          <ShipOutDocuments snapshot={docs.snapshot} transferId={docs.id} pdfPath={`/inventory/moyel-shuttle/${docs.id}/bol.pdf`} />
          <button type="button" className="secondary-button" onClick={() => setDocs(null)}>Close documents</button>
        </div>
      )}

      <div style={PANEL_STYLE}>
        <h4 style={{ marginTop: 0 }}>Past shuttle trailers</h4>
        {history.length === 0 ? <p className="muted">None yet.</p> : (
          <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ width: '100%' }}>
            <thead>
              <tr><th>Date</th><th>Trailer</th><th>Seal</th><th>Destination</th><th>Pallets</th><th>Cases</th><th>By</th><th /></tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{formatDateTime(h.shipped_at)}</td>
                  <td>{h.trailer_number}</td>
                  <td>{h.seal_number}</td>
                  <td>{h.destination || '—'}</td>
                  <td>{h.pallets}</td>
                  <td>{h.cases}</td>
                  <td>{h.created_by || '—'}</td>
                  <td><button type="button" className="secondary-button" onClick={() => openDocs(h.id)}>Reprint BOL</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default MoyelShuttleTab;
