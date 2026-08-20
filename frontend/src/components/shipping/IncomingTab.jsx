import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Plus, Truck } from 'lucide-react';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../context/ConfirmContext';
import Modal from '../Modal';
import SearchableSelect from '../SearchableSelect';
import { formatDate } from '../../utils/dateUtils';
import {
  apiErrorMessage, cancelIncomingOrder, closeIncomingOrder, createIncomingOrder,
  listIncomingOrders, printSessionLabels, releaseIncomingOrder, startReceiving,
} from '../../api/lotReceivingApi';
import LotLabelPrint from '../ingredient/LotLabelPrint';
import '../OutgoingDashboard.css';

/**
 * Incoming orders — corporate plans, the plant receives.
 *
 * The mirror image of the Outgoing tab beside it, and deliberately built on the
 * same `og-` card system so the two read as one screen pointed in two
 * directions. No new nav item: "Outgoing" became "Shipping" and gained tabs.
 *
 * ── The model, in the owner's words ────────────────────────────────────────
 *
 * "I have 800 drums of mango in the yard. 500 go to the Chicago 3PL, 300 to
 * Florida." That is THREE orders, one per destination — not one order with three
 * destinations. Each is received, shorted and closed on its own, and a shared
 * header would couple three unrelated events.
 *
 * Corporate fills in 99% of it because corporate has the paperwork. The plant
 * worker checks it against the driver's BOL, corrects the 1% that is wrong,
 * prints stickers, and scans. Creating an order puts NOTHING in stock — it is a
 * plan, exactly like a scheduled ship-out, where creation deliberately reserves
 * nothing and correctness is enforced at scan time.
 *
 * ── What "Start receiving" does, and what it deliberately does not ─────────
 *
 * It opens ONE line: creates the receipt, resolves the lot, and hands back
 * stickers to print. It puts NOTHING in stock. A desktop button that says "yes,
 * all 80 arrived" is precisely the guess this model exists to remove — the units
 * are counted on the gun, against a physical rack, one at a time.
 *
 * It is also where the worker corrects the 1% corporate got wrong, because they
 * are holding the driver's BOL and corporate is not. The vendor lot, the BBD and
 * the weight per drum are all editable here and nowhere else.
 */

const STATUS_LABELS = {
  draft: 'Draft',
  in_transit: 'In transit',
  receiving: 'Receiving',
  received: 'Received',
  closed_short: 'Closed short',
  cancelled: 'Cancelled',
};

const OPEN_STATUSES = ['draft', 'in_transit', 'receiving'];

const emptyLine = () => ({
  product_id: '',
  vendor_lot: '',
  bbd: '',
  expected_count: '',
  unit_label: 'drum',
  weight_per_unit: '',
  weight_unit: 'lbs',
});

const IncomingTab = () => {
  const { products, vendors, categories } = useAppData();
  const { user, isCorporateUser, selectedWarehouse, selectedWarehouseName } = useAuth();
  const { addToast } = useToast();
  const { confirm } = useConfirm();

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showClosed, setShowClosed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(null);
  const [closeForm, setCloseForm] = useState(null);
  const [startForm, setStartForm] = useState(null);
  const [sheet, setSheet] = useState(null);

  // Corporate must pick a target warehouse in the header before creating
  // anything. Without it `resolve_warehouse_for_write` raises a raw 400 —
  // pre-empting it here is the same guard ScheduleShipOutTab uses.
  const needsWarehouse = isCorporateUser && !selectedWarehouse;

  // Creating an order is a corporate job. Ship-out scheduling leaves this as a
  // convention rather than a gate; incoming is gated, because a plant worker
  // raising their own inbound paperwork and then receiving against it is one
  // person checking their own work.
  // TWO DIFFERENT PERMISSIONS, deliberately not one.
  //
  // Raising an incoming order is corporate paperwork: they hold the PO and they
  // decide which site a load goes to. `corporate_viewer` is inside
  // CORPORATE_ROLES but is a viewer, so it is excluded here.
  //
  // STARTING to receive one is the plant's job — it is done holding the driver's
  // BOL, at the dock. Collapsing these into one flag is what put a "New incoming
  // order" button in front of a plant admin, and would have taken "Start
  // receiving" away from them when that was fixed.
  const canCreate = ['superadmin', 'corporate_admin'].includes(user?.role);
  const canReceive = user?.role !== 'forklift';

  // Weighed material only: raw AND ingredient. There is no category typed
  // `ingredient` in production — every puree and concentrate is `raw` — so
  // filtering on `ingredient` alone empties the list. Packaging and finished
  // goods are excluded: packaging is counted in cases, FG uses pallet licences.
  //
  // `useAppData()` exposes `categories` as an ARRAY, not a lookup map. Reaching
  // for a `categoryLookup` that does not exist made every type `undefined`, so
  // the filter rejected everything and the dropdown rendered empty.
  const ingredientProducts = useMemo(() => {
    const typeById = new Map((categories || []).map((c) => [c.id, c.type]));
    const WEIGHED = new Set(['ingredient', 'raw', 'raw-material']);
    return (products || [])
      .filter((p) => WEIGHED.has(typeById.get(p.categoryId || p.category_id)))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  }, [products, categories]);

  const load = useCallback(() => {
    setLoading(true);
    return listIncomingOrders({ include_closed: showClosed })
      .then((data) => setOrders(Array.isArray(data) ? data : []))
      .catch((err) => addToast(apiErrorMessage(err, 'Could not load incoming orders'), 'error'))
      .finally(() => setLoading(false));
  }, [showClosed, addToast]);

  useEffect(() => { load(); }, [load]);

  const startCreate = () => {
    setForm({
      vendor_id: '',
      bol: '',
      purchase_order: '',
      expected_date: '',
      notes: '',
      lines: [emptyLine()],
    });
    setCreating(true);
  };

  const patchLine = (index, patch) => {
    setForm((prev) => ({
      ...prev,
      lines: prev.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    }));
  };

  const submitCreate = async () => {
    const lines = (form.lines || []).filter((l) => l.product_id && Number(l.expected_count) > 0);
    if (!lines.length) {
      addToast('Add at least one product with an expected count.', 'error');
      return;
    }
    if (needsWarehouse) {
      addToast('Pick a warehouse in the header before creating an order.', 'error');
      return;
    }
    const ok = await confirm({
      title: 'Create incoming order',
      message: `This order is for ${selectedWarehouseName || 'the selected warehouse'}. `
        + `${lines.reduce((sum, l) => sum + Number(l.expected_count || 0), 0)} units across `
        + `${lines.length} product line${lines.length === 1 ? '' : 's'}. Creating it puts nothing in stock.`,
      confirmText: 'Create',
    });
    if (!ok) return;

    setBusy(true);
    try {
      await createIncomingOrder({
        ...form,
        expected_date: form.expected_date || null,
        lines: lines.map((line) => ({
          ...line,
          expected_count: Number(line.expected_count) || 0,
          weight_per_unit: line.weight_per_unit === '' ? null : Number(line.weight_per_unit),
          bbd: line.bbd || null,
        })),
      });
      setCreating(false);
      setForm(null);
      addToast('Incoming order created', 'success');
      await load();
    } catch (err) {
      addToast(apiErrorMessage(err, 'Could not create the order'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const doRelease = async (order) => {
    setBusy(true);
    try {
      await releaseIncomingOrder(order.id);
      addToast(`${order.order_number} is in transit`, 'success');
      await load();
    } catch (err) {
      addToast(apiErrorMessage(err, 'Could not release the order'), 'error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Close an order. A SHORT close needs a reason and the server enforces it, so
   * the reason is collected here rather than letting the worker hit a 400 and
   * retype it. A complete close is just a confirm.
   */
  const doClose = async (order) => {
    const short = (order.expected_count || 0) - (order.received_count || 0);
    if (short > 0) {
      setCloseForm({ order, short, reason: '' });
      return;
    }
    const ok = await confirm({
      title: 'Close this order',
      message: `${order.received_count} of ${order.expected_count} received. Close it?`,
      confirmText: 'Close',
    });
    if (!ok) return;
    await finishClose(order, null);
  };

  const finishClose = async (order, reason) => {
    setBusy(true);
    try {
      await closeIncomingOrder(order.id, reason);
      setCloseForm(null);
      addToast(`${order.order_number} closed`, 'success');
      await load();
    } catch (err) {
      addToast(apiErrorMessage(err, 'Could not close the order'), 'error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Open a line against the driver's paperwork.
   *
   * Prefilled from corporate's order, because corporate fills 99% of it. What is
   * editable is the part the worker can actually see on the truck.
   */
  const openStart = (order, line) => setStartForm({
    order,
    line,
    vendor_lot: line.vendor_lot || '',
    bbd: line.bbd ? String(line.bbd).slice(0, 10) : '',
    weight_per_unit: line.weight_per_unit == null ? '' : String(line.weight_per_unit),
    weight_unit: line.weight_unit || 'lbs',
    expected_count: String(line.expected_count ?? ''),
    bol: order.bol || '',
  });

  const submitStart = async () => {
    const { order, line } = startForm;
    if (!Number(startForm.weight_per_unit)) {
      // The server flags a weightless lot and refuses to print for it, because
      // pounds are derived from this number and a missing one reads as zero
      // stock to production. Saying so here saves a round trip.
      addToast(
        `Weight per ${line.unit_label || 'unit'} is needed — every pound is worked out from it.`,
        'error',
      );
      return;
    }
    setBusy(true);
    try {
      const summary = await startReceiving(order.id, {
        line_id: line.id,
        vendor_lot: startForm.vendor_lot || null,
        bbd: startForm.bbd || null,
        weight_per_unit: Number(startForm.weight_per_unit),
        weight_unit: startForm.weight_unit || 'lbs',
        expected_count: Number(startForm.expected_count) || null,
        bol: startForm.bol || null,
      });
      // Printing is NOT receiving. This hands the worker the stickers; the
      // material becomes stock when a forklift user scans it into a rack.
      const printed = await printSessionLabels(summary.receipt_id, summary.expected_count);
      setSheet(printed);
      setStartForm(null);
      addToast(
        `${summary.expected_count} stickers for ${summary.lot_code} — scan them in on the gun`,
        'success',
      );
      await load();
    } catch (error) {
      addToast(apiErrorMessage(error, 'Could not start receiving'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const doCancel = async (order) => {
    const ok = await confirm({
      title: 'Cancel this order',
      message: `${order.order_number} will be cancelled. This is only possible while nothing has been received against it.`,
      confirmText: 'Cancel order',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await cancelIncomingOrder(order.id, null);
      addToast(`${order.order_number} cancelled`, 'success');
      await load();
    } catch (err) {
      addToast(apiErrorMessage(err, 'Could not cancel the order'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const lineTotals = useMemo(() => {
    const rows = (form?.lines || []).filter((l) => l.product_id && Number(l.expected_count) > 0);
    return {
      lines: rows.length,
      units: rows.reduce((sum, l) => sum + (Number(l.expected_count) || 0), 0),
    };
  }, [form]);

  const visible = useMemo(
    () => (showClosed ? orders : orders.filter((o) => OPEN_STATUSES.includes(o.status))),
    [orders, showClosed],
  );

  const renderCard = (order) => {
    const expected = order.expected_count || 0;
    const received = order.received_count || 0;
    const difference = received - expected;
    const isOpen = OPEN_STATUSES.includes(order.status);

    return (
      <div className="og-card" key={order.id}>
        <div className="og-card-time">
          <span className="og-chip og-chip-scheduled">{STATUS_LABELS[order.status] || order.status}</span>
          {order.expected_date && (
            <span className="og-date-sub">{formatDate(order.expected_date)}</span>
          )}
        </div>

        <div className="og-card-main">
          <div className="og-card-title">
            <strong>{order.order_number}</strong>
            {order.origin_name && <span className="og-sub"> from {order.origin_name}</span>}
          </div>
          <div className="og-sub">
            {order.vendor_name || 'Vendor not recorded'}
            {order.bol ? ` · BOL ${order.bol}` : ''}
            {order.purchase_order ? ` · PO ${order.purchase_order}` : ''}
          </div>

          <div className="og-lines">
            {(order.lines || []).map((line) => {
              const lineDiff = (line.received_count || 0) - (line.expected_count || 0);
              return (
                <div className="og-line" key={line.id}>
                  <span className="og-line-name">{line.product_name}</span>
                  <span className="og-sub">
                    {line.lot_unknown ? 'lot unknown' : `lot ${line.vendor_lot || '—'}`}
                    {line.bbd ? ` · BBD ${formatDate(line.bbd)}` : ''}
                  </span>
                  <span className="og-line-count">
                    {isOpen && canReceive && order.status !== 'draft' && !line.receipt_id && (
                      <button
                        type="button"
                        className="og-btn og-btn-primary"
                        style={{ marginRight: 8 }}
                        onClick={() => openStart(order, line)}
                        disabled={busy}
                      >
                        Start receiving
                      </button>
                    )}
                    <b>{line.received_count}</b> of {line.expected_count}{' '}
                    {line.unit_label || 'unit'}s
                    {/* Amber, not red: a difference is information. Over and
                        under are both legal and both get recorded. */}
                    {lineDiff !== 0 && (
                      <span style={{ color: '#b45309', fontWeight: 600 }}>
                        {' '}({lineDiff > 0 ? '+' : ''}{lineDiff})
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>

          {order.close_reason && (
            <div className="og-sub" style={{ marginTop: 6 }}>
              <AlertTriangle size={13} /> {order.close_reason}
            </div>
          )}
        </div>

        <div className="og-card-side">
          <div className="og-count">
            <b>{received}</b> of {expected}
            {difference !== 0 && (
              <span style={{ color: '#b45309' }}> ({difference > 0 ? '+' : ''}{difference})</span>
            )}
          </div>
          {isOpen && canCreate && (
            <div className="og-card-actions">
              {order.status === 'draft' && (
                <button
                  type="button"
                  className="og-btn og-btn-primary"
                  onClick={() => doRelease(order)}
                  disabled={busy}
                >
                  Release
                </button>
              )}
              {order.status !== 'draft' && (
                <button
                  type="button"
                  className="og-btn"
                  onClick={() => doClose(order)}
                  disabled={busy}
                >
                  Close
                </button>
              )}
              {received === 0 && (
                <button
                  type="button"
                  className="og-btn og-btn-ghost"
                  onClick={() => doCancel(order)}
                  disabled={busy}
                >
                  Cancel
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="og-toolbar">
        <div className="og-counts">
          <span className="og-count"><b>{visible.length}</b> order{visible.length === 1 ? '' : 's'}</span>
          <label className="og-count" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(e) => setShowClosed(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            Show closed
          </label>
        </div>
        {canCreate && (
          // Disabled rather than open-then-refuse. An order is FOR one
          // destination site, so on "All Warehouses" there is no answer to
          // "where is this going" — and the server rejects it with a raw 400.
          // Better to never open a form that cannot be submitted.
          <button
            type="button"
            className="og-btn og-btn-primary"
            onClick={startCreate}
            disabled={needsWarehouse}
            title={needsWarehouse ? 'Pick a plant in the header first' : undefined}
          >
            <Plus size={15} />
            {needsWarehouse ? 'Pick a plant first' : 'New incoming order'}
          </button>
        )}
      </div>

      {needsWarehouse && canCreate && (
        <div className="og-empty">
          <AlertTriangle size={18} /> An incoming order is for ONE destination
          site. Pick the plant in the header selector, then create it.
        </div>
      )}

      {loading && <div className="og-empty">Loading…</div>}

      {!loading && visible.length === 0 && (
        <div className="og-empty">
          <Truck size={20} />
          <div>
            <strong>Nothing inbound.</strong>
            <div className="og-sub">
              Corporate raises an order per destination. Material that turns up
              without one is logged on the Log Receipt screen instead — the dock
              is never blocked waiting for paperwork.
            </div>
          </div>
        </div>
      )}

      <div className="og-cards">{visible.map(renderCard)}</div>

      <Modal
        isOpen={!!startForm}
        onClose={() => setStartForm(null)}
        title="Start receiving"
        size="md"
      >
        {startForm && (
          <div className="og-modal-form">
            <p className="og-sub">
              <strong>{startForm.line.product_name}</strong> — check these against
              the driver&apos;s paperwork and correct anything that is wrong.
              Nothing goes into stock here; this prints the stickers so a forklift
              user can scan the {startForm.line.unit_label || 'unit'}s in.
            </p>
            <label>
              <span>Vendor lot</span>
              <input
                value={startForm.vendor_lot}
                onChange={(e) => setStartForm({ ...startForm, vendor_lot: e.target.value })}
              />
            </label>
            <label>
              <span>BBD</span>
              <input
                type="date"
                value={startForm.bbd}
                onChange={(e) => setStartForm({ ...startForm, bbd: e.target.value })}
              />
            </label>
            <label>
              <span>
                Weight per {startForm.line.unit_label || 'unit'}{' '}
                <span className="og-prefill">every pound is derived from this</span>
              </span>
              {/* text + inputMode, never type="number": a number input edits itself
                    when the wheel passes over it, so scrolling the form silently
                    changes a figure somebody typed. */}
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  inputMode="decimal"
                  value={startForm.weight_per_unit}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === '' || /^\d*\.?\d*$/.test(v)) {
                      setStartForm({ ...startForm, weight_per_unit: v });
                    }
                  }}
                  placeholder="500"
                  style={{ flex: 1 }}
                  autoFocus
                />
                <select
                  value={startForm.weight_unit}
                  onChange={(e) => setStartForm({ ...startForm, weight_unit: e.target.value })}
                  style={{ width: 110 }}
                  aria-label="Weight unit"
                >
                  <option value="lbs">lbs</option>
                  <option value="kg">kg</option>
                </select>
              </div>
            </label>
            <label>
              <span>How many arrived</span>
              <input
                type="text"
                inputMode="numeric"
                value={startForm.expected_count}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === '' || /^\d+$/.test(v)) {
                    setStartForm({ ...startForm, expected_count: v });
                  }
                }}
              />
            </label>
            <label>
              <span>BOL</span>
              <input
                value={startForm.bol}
                onChange={(e) => setStartForm({ ...startForm, bol: e.target.value })}
              />
            </label>
            <div className="og-modal-actions">
              <button type="button" className="og-btn og-btn-ghost" onClick={() => setStartForm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="og-btn og-btn-primary"
                onClick={submitStart}
                disabled={busy}
              >
                {busy ? 'Working…' : `Print ${startForm.expected_count || 0} stickers`}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={!!closeForm}
        onClose={() => setCloseForm(null)}
        title="Close short"
        size="sm"
      >
        {closeForm && (
          <div className="og-modal-form">
            <p className="og-sub">
              {closeForm.order.received_count} of {closeForm.order.expected_count}{' '}
              received — <strong>{closeForm.short} short</strong>. The difference
              stays on the record, so it needs an explanation somebody can answer
              for later.
            </p>
            <label>
              <span>Why?</span>
              <input
                value={closeForm.reason}
                onChange={(e) => setCloseForm({ ...closeForm, reason: e.target.value })}
                placeholder="Truck was 10 short against the BOL"
                autoFocus
              />
            </label>
            <div className="og-modal-actions">
              <button
                type="button"
                className="og-btn og-btn-ghost"
                onClick={() => setCloseForm(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="og-btn og-btn-primary"
                onClick={() => finishClose(closeForm.order, closeForm.reason.trim())}
                disabled={busy || !closeForm.reason.trim()}
              >
                {busy ? 'Closing…' : 'Close short'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={creating && !!form}
        onClose={() => { setCreating(false); setForm(null); }}
        title="New incoming order"
        size="lg"
      >
        {form && (
          <>
            <div className="og-modal-form">
              <label>
                <span>Vendor</span>
                <select
                  value={form.vendor_id}
                  onChange={(e) => setForm({ ...form, vendor_id: e.target.value })}
                >
                  <option value="">—</option>
                  {(vendors || []).map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>BOL</span>
                <input
                  value={form.bol}
                  onChange={(e) => setForm({ ...form, bol: e.target.value })}
                />
              </label>
              <label>
                <span>PO</span>
                <input
                  value={form.purchase_order}
                  onChange={(e) => setForm({ ...form, purchase_order: e.target.value })}
                />
              </label>
              <label>
                <span>Expected</span>
                <input
                  type="date"
                  value={form.expected_date}
                  onChange={(e) => setForm({ ...form, expected_date: e.target.value })}
                />
              </label>
            </div>

            <h4 style={{ margin: '16px 0 6px', display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span>What is on the truck</span>
              <span className="og-prefill">one line per lot — a truck can carry several</span>
              {lineTotals.units > 0 && (
                <span className="og-count" style={{ marginLeft: 'auto' }}>
                  <b>{lineTotals.lines}</b> line{lineTotals.lines === 1 ? '' : 's'}
                  {' · '}<b>{lineTotals.units}</b> units
                </span>
              )}
            </h4>

            {form.lines.map((line, index) => (
              // Index as key: these rows have no identity until they are saved,
              // and reordering is not possible in this form.
              <div
                className="og-modal-form"
                key={index}
                style={{
                  marginBottom: 12, paddingBottom: 12,
                  borderBottom: index < form.lines.length - 1 ? '1px solid #e5e7eb' : 'none',
                }}
              >
                {form.lines.length > 1 && (
                  <button
                    type="button"
                    className="og-btn og-btn-ghost"
                    style={{ alignSelf: 'flex-end' }}
                    onClick={() => setForm({
                      ...form,
                      lines: form.lines.filter((_, i) => i !== index),
                    })}
                  >
                    Remove this line
                  </button>
                )}
                <label>
                  <span>Product</span>
                  {/* Type-to-search, not a plain select. There are already a
                      dozen purees and concentrates with names that share long
                      prefixes ("CONVENTIONAL MANGO PUREE (ALPHONSO)" next to
                      "CONVENTIONAL MANGO CONCENTRATE (TOTAPURI)"), and scrolling
                      a native dropdown to tell those apart is how the wrong one
                      gets picked. Same control the ship-out scheduler uses. */}
                  <SearchableSelect
                    options={ingredientProducts.map((p) => ({
                      value: p.id,
                      label: p.sid ? `${p.name}  ·  ${p.sid}` : p.name,
                    }))}
                    value={line.product_id}
                    onChange={(v) => patchLine(index, { product_id: v })}
                    placeholder="Search products…"
                    emptyLabel="—"
                  />
                </label>
                <label>
                  <span>Vendor lot</span>
                  <input
                    value={line.vendor_lot}
                    onChange={(e) => patchLine(index, { vendor_lot: e.target.value })}
                    placeholder="off the paperwork"
                  />
                </label>
                <label>
                  <span>BBD</span>
                  <input
                    type="date"
                    value={line.bbd}
                    onChange={(e) => patchLine(index, { bbd: e.target.value })}
                  />
                </label>
                <label>
                  <span>How many</span>
                  {/* Whole units only, and text-not-number for the same
                      wheel-scroll reason as the weight above. */}
                  <input
                    type="text"
                    inputMode="numeric"
                    value={line.expected_count}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === '' || /^\d+$/.test(v)) {
                        patchLine(index, { expected_count: v });
                      }
                    }}
                    placeholder="80"
                  />
                </label>
                <label>
                  <span>Unit</span>
                  <select
                    value={line.unit_label}
                    onChange={(e) => patchLine(index, { unit_label: e.target.value })}
                  >
                    <option value="drum">Drums</option>
                    <option value="bag">Bags</option>
                    <option value="tote">Totes</option>
                    <option value="pail">Pails</option>
                    <option value="box">Boxes</option>
                  </select>
                </label>
                <label>
                  <span>
                    Weight each{' '}
                    {/* Required in practice, not just useful: pounds are derived
                        from it, and the server flags a lot without one and
                        refuses to print stickers for it — so nothing can be
                        received until it is filled in. */}
                    <span className="og-prefill">required — every pound comes from this</span>
                  </span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {/* type="text" + inputMode="decimal", NOT type="number".
                        A number input changes its value when the wheel passes
                        over a focused field, so scrolling the form silently
                        edits the one figure every derived pound depends on —
                        and it shows spinner arrows nobody wants on a weight. */}
                    <input
                      type="text"
                      inputMode="decimal"
                      value={line.weight_per_unit}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === '' || /^\d*\.?\d*$/.test(v)) {
                          patchLine(index, { weight_per_unit: v });
                        }
                      }}
                      placeholder="500"
                      style={{ flex: 1 }}
                    />
                    {/* Asked, not assumed. Vendors quote in both, and a drum
                        recorded as 500 kg when it is 500 lb is wrong by a factor
                        of 2.2 in every pound the system derives from it. */}
                    <select
                      value={line.weight_unit}
                      onChange={(e) => patchLine(index, { weight_unit: e.target.value })}
                      style={{ width: 110 }}
                      aria-label="Weight unit"
                    >
                      <option value="lbs">lbs</option>
                      <option value="kg">kg</option>
                    </select>
                  </div>
                </label>
              </div>
            ))}

            <button
              type="button"
              className="og-btn og-btn-ghost"
              onClick={() => setForm({ ...form, lines: [...form.lines, emptyLine()] })}
            >
              <Plus size={14} /> Add another product
            </button>

            <div className="og-modal-actions">
              <button
                type="button"
                className="og-btn og-btn-ghost"
                onClick={() => { setCreating(false); setForm(null); }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="og-btn og-btn-primary"
                onClick={submitCreate}
                disabled={busy || needsWarehouse}
              >
                {busy ? 'Creating…' : 'Create order'}
              </button>
            </div>
          </>
        )}
      </Modal>

      {sheet && <LotLabelPrint sheet={sheet} onDone={() => setSheet(null)} />}
    </>
  );
};

export default IncomingTab;
