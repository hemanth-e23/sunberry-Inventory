import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Plus, Truck } from 'lucide-react';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../context/ConfirmContext';
import Modal from '../Modal';
import SearchableSelect from '../SearchableSelect';
import { formatCalendarDate } from '../../utils/labelPayload';
import { formatDateKey, getTodayDateKey } from '../../utils/dateUtils';
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

// Units that arrive wrapped on a pallet and cannot be stickered individually at
// the dock — these MUST state a per-pallet count, because it drives the sticker
// run and the gun's multiplier.
const PALLETISED_UNITS = new Set(['bag', 'box', 'bottle', 'case', 'pail']);

// Measures rather than containers, plus the pallet itself. Nothing else: DRUMS
// RIDE PALLETS TOO, two or four to a pallet, and refusing to ask made the rack
// count them one slot each — twenty drums reported twenty of twenty-two slots
// on a rack holding ten pallets. Optional for those, because some genuinely are
// one per slot; blank means exactly that.
const NOT_A_CONTAINER = new Set(['gallon', 'liter', 'litre', 'pallet']);
const asksPerPallet = (unit) => {
  const u = String(unit || '').toLowerCase().replace(/s$/, '');
  return Boolean(u) && !NOT_A_CONTAINER.has(u);
};

/** Move a YYYY-MM-DD key by N days without touching a timezone. */
const shiftDateKey = (key, days) => {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
};

// Reuses the outbound chip palette so the two tabs read as one screen. Every
// status got `scheduled` before, so a cancelled order wore an amber "planned"
// chip.
const STATUS_CHIP = {
  draft: 'scheduled',
  in_transit: 'scanning',
  receiving: 'checked_in',
  received: 'complete',
  closed_short: 'overdue',
  cancelled: 'cancelled',
};

const emptyLine = () => ({
  product_id: '',
  vendor_lot: '',
  bbd: '',
  expected_count: '',
  unit_label: 'drum',
  units_per_pallet: '',
  weight_per_unit: '',
  // Always lbs. There is no selector — see the weight input for why.
  weight_unit: 'lbs',
});

const IncomingTab = () => {
  const { products, vendors, categories } = useAppData();
  const { user, isCorporateUser, selectedWarehouse, selectedWarehouseName } = useAuth();
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const today = getTodayDateKey();

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showClosed, setShowClosed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(null);
  const [closeForm, setCloseForm] = useState(null);
  const [startForm, setStartForm] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [reprint, setReprint] = useState(null);
  const [releaseForm, setReleaseForm] = useState(null);
  // The day the plant is looking at. Same shape as the outbound tab.
  const [dateKey, setDateKey] = useState(() => getTodayDateKey());

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
    // Drafts come back on every day — they have no slot yet, which is the whole
    // point of a draft, so filtering them by date would hide corporate's own
    // to-do list from them on every view.
    return listIncomingOrders({ include_closed: showClosed, date: dateKey })
      .then((data) => setOrders(Array.isArray(data) ? data : []))
      .catch((err) => addToast(apiErrorMessage(err, 'Could not load incoming orders'), 'error'))
      .finally(() => setLoading(false));
    // `selectedWarehouse` is not READ in here — the warehouse rides on the
    // X-View-Warehouse header AuthContext sets, so the request is already
    // scoped server-side. It is in the dep list because it must TRIGGER a
    // refetch: without it, switching the header selector leaves the previous
    // plant's rows on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showClosed, dateKey, selectedWarehouse, addToast]);

  useEffect(() => { load(); }, [load]);

  const startCreate = () => {
    setForm({
      vendor_id: '',
      bol: '',
      purchase_order: '',
      notes: '',
      lines: [emptyLine()],
      walkIn: false,
    });
    setCreating(true);
  };

  /**
   * A truck nobody scheduled, standing at the dock.
   *
   * Deliberately the SAME form and the same two endpoints as a corporate order,
   * with the release folded in and dated today. A walk-in is not a third way
   * material enters — it is the corporate path with its first step performed by
   * the plant instead, off the driver's BOL. Giving it its own intake would mean
   * a second flow to keep correct, and the two would drift.
   *
   * The driver is waiting, so the day is not asked for: it is today by
   * definition. Everything after this point — stickers, scanning, approval — is
   * byte-for-byte the scheduled path.
   */
  const startWalkIn = () => {
    setForm({
      vendor_id: '',
      bol: '',
      purchase_order: '',
      notes: '',
      lines: [emptyLine()],
      walkIn: true,
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
    // NO vendor gate here, deliberately. Raising an order does not create a
    // lot — the lot is minted at start-receiving — so nothing can collide yet,
    // and corporate legitimately raises orders before every detail is known.
    // The gate lives where the lot is actually born and where somebody is
    // holding the BOL. See the check in `beginReceiving`.
    const isWalkIn = Boolean(form.walkIn);
    const totalUnits = lines.reduce((sum, l) => sum + Number(l.expected_count || 0), 0);
    const ok = await confirm(
      `This order is for ${selectedWarehouseName || 'the selected warehouse'}. `
      + `${totalUnits} units across ${lines.length} product line${lines.length === 1 ? '' : 's'}. `
      + (isWalkIn
        ? 'It goes straight onto today\'s schedule, ready to sticker and scan.'
        : 'Creating it puts nothing in stock.'),
      {
        title: isWalkIn ? 'Log walk-in delivery' : 'Create incoming order',
        confirmLabel: isWalkIn ? 'Log walk-in' : 'Create',
      },
    );
    if (!ok) return;

    setBusy(true);
    try {
      const order = await createIncomingOrder({
        ...form,
        walkIn: undefined,
        // An untouched <select> sends "", which is not an id — it reached
        // Postgres as a foreign key to a vendor with an empty-string id and
        // died with `Key (vendor_id)=() is not present in table "vendors"`.
        // The server coerces this too; doing it here as well matches how the
        // receipt form has always behaved.
        vendor_id: form.vendor_id || null,
        lines: lines.map((line) => ({
          ...line,
          expected_count: Number(line.expected_count) || 0,
          units_per_pallet: line.units_per_pallet === '' ? null : Number(line.units_per_pallet),
          weight_per_unit: line.weight_per_unit === '' ? null : Number(line.weight_per_unit),
          bbd: line.bbd || null,
        })),
      });

      // A walk-in is already at the dock, so it is released in the same breath
      // and dated today. If this second call fails the order still exists as a
      // draft and the Schedule button on its card finishes the job — the truck
      // is not blocked by a network blip.
      if (isWalkIn && order?.id) {
        await releaseIncomingOrder(order.id, { expected_date: today });
        setDateKey(today);
      }

      setCreating(false);
      setForm(null);
      addToast(isWalkIn ? 'Walk-in logged and on today\'s schedule' : 'Incoming order created', 'success');
      await load();
    } catch (err) {
      addToast(apiErrorMessage(err, 'Could not create the order'), 'error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Schedule and release, as one step and one decision.
   *
   * Creating an order and committing it to a day are different moments:
   * corporate raises it as soon as they have the PO, and agrees the slot with
   * the carrier afterwards. So a draft carries no date, and the date is asked
   * for here — at the point the order becomes something a plant is expected to
   * act on.
   */
  const doRelease = async () => {
    if (!releaseForm?.expected_date) {
      addToast('Pick the day this shipment reaches the warehouse.', 'error');
      return;
    }
    setBusy(true);
    try {
      await releaseIncomingOrder(releaseForm.order.id, {
        expected_date: releaseForm.expected_date,
        expected_time: releaseForm.expected_time,
      });
      addToast(`${releaseForm.order.order_number} is in transit`, 'success');
      setReleaseForm(null);
      // Jump to the day it is now expected, so it does not appear to vanish.
      setDateKey(releaseForm.expected_date);
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
    const ok = await confirm(
      `${order.received_count} of ${order.expected_count} received. Close it?`,
      { title: 'Close this order', confirmLabel: 'Close' },
    );
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
    vendor_id: line.vendor_id || order.vendor_id || '',
    vendor_lot: line.vendor_lot || '',
    bbd: line.bbd ? String(line.bbd).slice(0, 10) : '',
    weight_per_unit: line.weight_per_unit == null ? '' : String(line.weight_per_unit),
    units_per_pallet: line.units_per_pallet == null ? '' : String(line.units_per_pallet),
    expected_count: String(line.expected_count ?? ''),
    bol: order.bol || '',
  });

  const submitStart = async () => {
    const { order, line } = startForm;
    // All three are hard requirements at the SERVER too. Checked here so the
    // worker is told at the form instead of at the printer, standing next to a
    // pallet with nothing to stick on it.
    if (!startForm.vendor_id) {
      addToast(
        'Pick the vendor from the BOL — it is part of what tells this lot apart '
        + 'from another supplier\'s lot with the same number.',
        'error',
      );
      return;
    }
    if (!startForm.vendor_lot.trim()) {
      addToast(
        'The vendor lot number is needed — every drum of this lot carries the '
        + 'same sticker, so one reading "UNKNOWN" makes them impossible to tell apart.',
        'error',
      );
      return;
    }
    if (!startForm.bbd) {
      addToast('The best-by date is needed — it is printed on every sticker.', 'error');
      return;
    }
    if (!Number(startForm.weight_per_unit)) {
      // Pounds are derived from this number, and a missing one reads as zero
      // stock to production.
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
        vendor_id: startForm.vendor_id || null,
        vendor_lot: startForm.vendor_lot || null,
        bbd: startForm.bbd || null,
        weight_per_unit: Number(startForm.weight_per_unit),
        weight_unit: 'lbs',
        units_per_pallet: Number(startForm.units_per_pallet) || null,
        expected_count: Number(startForm.expected_count) || null,
        bol: startForm.bol || null,
      });
      // Printing is NOT receiving. This hands the worker the stickers; the
      // material becomes stock when a forklift user scans it into a rack.
      // PALLETISED MATERIAL GETS PALLET STICKERS, one per pallet — nobody is
      // going to destack a wrapped pallet at the dock to label every bag. The
      // sticker is identical either way; only the middle band differs, and the
      // gun's multiplier turns one scan into a whole pallet.
      const per = Number(startForm.units_per_pallet) || 0;
      const palletised = per > 1;
      const count = palletised
        ? Math.ceil(summary.expected_count / per)
        : summary.expected_count;
      const printed = await printSessionLabels(summary.receipt_id, count, {
        scope: palletised ? 'pallet' : 'unit',
      });
      setSheet(printed);
      setStartForm(null);
      addToast(
        palletised
          ? `${count} pallet stickers — one per pallet, then scan each in on the gun`
          : `${count} stickers for ${summary.lot_code} — scan them in on the gun`,
        'success',
      );
      await load();
    } catch (error) {
      addToast(apiErrorMessage(error, 'Could not start receiving'), 'error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Reprint stickers for a line already being received.
   *
   * Available until the order is closed, because anything can happen on a dock:
   * a sticker tears, one goes in the freezer face-down, the printer jams
   * halfway through eighty. Under lot identity a reprint is TRIVIALLY the same
   * sticker — there is no serial to keep in step, no sequence to resume, and no
   * risk of minting a second identity for the same drums. That guarantee is
   * what the per-drum design needed a locked counter to provide.
   *
   * It writes nothing: printing is not receiving.
   */
  const doReprint = async () => {
    const count = Number(reprint?.count) || 0;
    if (count < 1) {
      addToast('How many stickers?', 'error');
      return;
    }
    setBusy(true);
    try {
      setSheet(await printSessionLabels(reprint.line.receipt_id, count, {
        scope: reprint.scope || 'unit',
      }));
      setReprint(null);
    } catch (error) {
      addToast(apiErrorMessage(error, 'Could not reprint'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const doCancel = async (order) => {
    const ok = await confirm(
      `${order.order_number} will be cancelled. This is only possible while nothing `
      + 'has been received against it.',
      { title: 'Cancel this order', confirmLabel: 'Cancel order' },
    );
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

  // Two groups, because they are two different jobs. Drafts are corporate's
  // backlog — orders raised but not yet committed to a day. Everything else is
  // what the plant should expect on the day being viewed.
  const drafts = useMemo(() => visible.filter((o) => o.status === 'draft'), [visible]);
  const scheduled = useMemo(() => visible.filter((o) => o.status !== 'draft'), [visible]);

  const renderCard = (order) => {
    const expected = order.expected_count || 0;
    const received = order.received_count || 0;
    const difference = received - expected;
    const isOpen = OPEN_STATUSES.includes(order.status);
    const short = Math.max(0, -difference);

    return (
      <div
        className={`og-card og-card--incoming${order.status === 'cancelled' ? ' is-cancelled' : ''}`}
        key={order.id}
      >
        {/* The 96px column is a DATE column here, not the time column it is on
            the outbound side — an inbound order has an expected day, not a dock
            appointment. The status chip used to live here and was clipped: a
            word like "CLOSED SHORT" does not fit 96px, and it belongs beside the
            order number anyway. */}
        <div className="og-card-time">
          {order.expected_date ? (
            <>
              <span className="ampm">expected</span>
              {/* Calendar day, stored at midnight UTC — the timezone-aware
                  formatter would show the day before. */}
              <span className="t">{formatCalendarDate(order.expected_date)}</span>
              {order.expected_time && <span className="ampm">{order.expected_time}</span>}
            </>
          ) : (
            <span className="ampm">no date</span>
          )}
        </div>

        <div className="og-card-main">
          <div className="og-card-title">
            <strong>{order.order_number}</strong>
            <span className={`og-chip og-chip-${STATUS_CHIP[order.status] || 'scheduled'}`}>
              {STATUS_LABELS[order.status] || order.status}
            </span>
          </div>
          <div className="og-sub">
            {[
              order.vendor_name,
              order.origin_name && `from ${order.origin_name}`,
              order.bol && `BOL ${order.bol}`,
              order.purchase_order && `PO ${order.purchase_order}`,
            ].filter(Boolean).join('  ·  ') || 'No vendor recorded'}
          </div>

          <div className="og-lines">
            {(order.lines || []).map((line) => {
              const lineShort = (line.expected_count || 0) - (line.received_count || 0);
              return (
                <div className="og-line" key={line.id}>
                  <span className="og-line-name">{line.product_name}</span>
                  <span className="og-sub">
                    {/* A missing lot number is worth flagging, not just
                        reporting: no sticker prints without one, so nothing can
                        be received against this line until it is filled in. */}
                    {line.lot_unknown || !line.vendor_lot ? (
                      <span style={{ color: '#b45309', fontWeight: 600 }}>
                        no lot number yet
                      </span>
                    ) : <>lot <strong>{line.vendor_lot}</strong></>}
                    {line.bbd ? ` · BBD ${formatCalendarDate(line.bbd)}` : (
                      <span style={{ color: '#b45309', fontWeight: 600 }}> · no BBD yet</span>
                    )}
                    {/* The sticker code is BUILT FROM the vendor's lot number
                        (SID-THEIRLOT-marker), so this reads as the same number
                        with our marker on it rather than a rival identity. */}
                    {line.lot_code && (
                      <>
                        {' · sticker '}
                        <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>
                          {line.lot_code}
                        </span>
                      </>
                    )}
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
                    {isOpen && canReceive && line.receipt_id && (
                      <button
                        type="button"
                        className="og-btn og-btn-ghost"
                        style={{ marginRight: 8 }}
                        onClick={() => {
                          const per = Number(line.units_per_pallet) || 0;
                          const remaining = Math.max(
                            0, (line.expected_count || 0) - (line.received_count || 0),
                          ) || line.expected_count || 1;
                          setReprint({
                            order,
                            line,
                            scope: per > 1 ? 'pallet' : 'unit',
                            perPallet: per,
                            count: String(per > 1 ? Math.ceil(remaining / per) : remaining),
                          });
                        }}
                        disabled={busy}
                      >
                        Reprint
                      </button>
                    )}
                    <b>{line.received_count}</b> of {line.expected_count}{' '}
                    {line.unit_label || 'unit'}s
                    {/* Amber, never red. Short and over are both legal and both
                        happen; red would train people to click past it. */}
                    {lineShort > 0 && (
                      <span style={{ color: '#b45309', fontWeight: 600 }}>
                        {' '}· {lineShort} short
                      </span>
                    )}
                    {lineShort < 0 && (
                      <span style={{ color: '#b45309', fontWeight: 600 }}>
                        {' '}· {-lineShort} over
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>

          {order.close_reason && (
            <div className="og-sub" style={{ marginTop: 8, color: '#b45309' }}>
              <AlertTriangle size={13} />{' '}
              {/* Labelled. On its own, a reason like "not shipped" reads as a
                  status rather than somebody's explanation. */}
              <strong>Closed short:</strong> {order.close_reason}
            </div>
          )}
        </div>

        <div className="og-card-side">
          {/* The total lives HERE and nowhere else. It used to appear twice —
              once per line and once in this column — which reads as two
              different figures that happen to agree. */}
          <div className="og-count">
            <b>{received}</b> of {expected}
          </div>
          {short > 0 && (
            <div className="og-sub" style={{ color: '#b45309', fontWeight: 600 }}>
              {short} short
            </div>
          )}
          {difference > 0 && (
            <div className="og-sub" style={{ color: '#b45309', fontWeight: 600 }}>
              {difference} over
            </div>
          )}

          {isOpen && canCreate && (
            <div className="og-card-actions">
              {order.status === 'draft' && (
                <button
                  type="button"
                  className="og-btn og-btn-primary"
                  onClick={() => setReleaseForm({
                    order,
                    expected_date: getTodayDateKey(),
                    expected_time: '',
                  })}
                  disabled={busy}
                >
                  Schedule &amp; release
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
        {/* Same day navigator as the outbound tab — the two halves of Shipping
            should be driven the same way. */}
        <div className="og-datenav">
          <button
            className="og-navbtn"
            onClick={() => setDateKey((k) => shiftDateKey(k, -1))}
            title="Previous day"
          >
            ‹
          </button>
          <div className="og-date-display">
            <span className="og-date-label">
              {dateKey === today ? 'Today' : formatDateKey(dateKey)}
            </span>
            <span className="og-date-sub">
              {dateKey === today ? formatDateKey(dateKey) : 'expected arrivals'}
            </span>
          </div>
          <button
            className="og-navbtn"
            onClick={() => setDateKey((k) => shiftDateKey(k, 1))}
            title="Next day"
          >
            ›
          </button>
          <input
            type="date"
            className="og-date-input"
            value={dateKey}
            onChange={(e) => setDateKey(e.target.value)}
            title="Jump to date"
          />
          <button
            className="og-todaybtn"
            onClick={() => setDateKey(today)}
            disabled={dateKey === today}
          >
            Today
          </button>
        </div>
        <div className="og-counts">
          <span className="og-count">
            <b>{scheduled.length}</b> arriving
          </span>
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
        {/* WALK-IN IS THE PLANT'S BUTTON, not corporate's.
            It happens at the dock, holding the driver's BOL, for a truck
            corporate never knew about — so it is gated on `canReceive` like
            Start receiving, not on `canCreate`. Behind the corporate flag it
            was invisible to the plant admin who is the only person in a
            position to press it: the same conflation this file already warns
            about above, in reverse. */}
        {canReceive && (
          <button
            type="button"
            className="og-btn og-btn-ghost"
            onClick={startWalkIn}
            disabled={needsWarehouse}
            title={needsWarehouse ? 'Pick a plant in the header first' : 'A truck nobody scheduled'}
          >
            <Truck size={15} />
            Walk-in
          </button>
        )}
        {canCreate && (
          // Disabled rather than open-then-refuse. An order is FOR one
          // destination site, so on "All Warehouses" there is no answer to
          // "where is this going" — and the server rejects it with a raw 400.
          // Better to never open a form that cannot be submitted.
          <>
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
          </>
        )}
      </div>

      {needsWarehouse && canCreate && (
        <div className="og-empty">
          <AlertTriangle size={18} /> An incoming order is for ONE destination
          site. Pick the plant in the header selector, then create it.
        </div>
      )}

      {loading && <div className="og-empty">Loading…</div>}

      {/* Corporate's backlog: raised, but not yet committed to a day. Shown on
          every day view because a draft has no day, and only to the people who
          can act on it — the plant cannot receive against a draft. */}
      {!loading && canCreate && drafts.length > 0 && (
        <>
          <h4 className="og-group-head">
            Not scheduled yet
            <span className="og-prefill">
              {drafts.length} order{drafts.length === 1 ? '' : 's'} waiting for an arrival day
            </span>
          </h4>
          <div className="og-cards">{drafts.map(renderCard)}</div>
        </>
      )}

      {!loading && (
        <h4 className="og-group-head">
          {dateKey === today ? 'Arriving today' : `Arriving ${formatDateKey(dateKey)}`}
        </h4>
      )}

      {!loading && scheduled.length === 0 && (
        <div className="og-empty">
          <Truck size={20} />
          <div>
            <strong>Nothing due {dateKey === today ? 'today' : 'that day'}.</strong>
            <div className="og-sub">
              Corporate raises an order per destination and picks the arrival day
              when they release it. Material that turns up without one is logged
              on the Log Receipt screen instead — the dock is never blocked
              waiting for paperwork.
            </div>
          </div>
        </div>
      )}

      <div className="og-cards">{scheduled.map(renderCard)}</div>

      <Modal
        isOpen={!!releaseForm}
        onClose={() => setReleaseForm(null)}
        title="Schedule & release"
        size="sm"
      >
        {releaseForm && (
          <div className="og-modal-form">
            <p className="og-sub">
              <strong>{releaseForm.order.order_number}</strong> —{' '}
              {releaseForm.order.expected_count} units. Releasing it tells the
              plant to expect it; nothing goes into stock until the drums are
              scanned in.
            </p>
            <label>
              <span>
                Day it reaches the warehouse{' '}
                <span className="og-prefill">required — the plant screen is by day</span>
              </span>
              <input
                type="date"
                value={releaseForm.expected_date}
                onChange={(e) => setReleaseForm({ ...releaseForm, expected_date: e.target.value })}
                autoFocus
              />
            </label>
            <label>
              <span>
                Time{' '}
                <span className="og-prefill">optional — whatever the carrier quoted</span>
              </span>
              <input
                value={releaseForm.expected_time}
                onChange={(e) => setReleaseForm({ ...releaseForm, expected_time: e.target.value })}
                placeholder="07:00 AM"
              />
            </label>
            <div className="og-modal-actions">
              <button type="button" className="og-btn og-btn-ghost" onClick={() => setReleaseForm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="og-btn og-btn-primary"
                onClick={doRelease}
                disabled={busy || !releaseForm.expected_date}
              >
                {busy ? 'Releasing…' : 'Release'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={!!reprint}
        onClose={() => setReprint(null)}
        title="Reprint stickers"
        size="sm"
      >
        {reprint && (
          <div className="og-modal-form">
            <p className="og-sub">
              <strong>{reprint.line.product_name}</strong>
              {reprint.line.lot_code ? ` · ${reprint.line.lot_code}` : ''}
              {reprint.line.vendor_lot ? ` · lot ${reprint.line.vendor_lot}` : ''}
              <br />
              Every sticker for this lot is identical, so a reprint is the same
              sticker again — nothing is duplicated and nothing goes into stock.
              {' '}
              {reprint.line.received_count > 0 && (
                <>Scanned so far: <strong>{reprint.line.received_count}</strong> of{' '}
                {reprint.line.expected_count}.</>
              )}
            </p>
            <label>
              <span>How many</span>
              <input
                type="text"
                inputMode="numeric"
                value={reprint.count}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === '' || /^\d+$/.test(v)) setReprint({ ...reprint, count: v });
                }}
                autoFocus
              />
            </label>
            <div className="og-modal-actions">
              <button type="button" className="og-btn og-btn-ghost" onClick={() => setReprint(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="og-btn og-btn-primary"
                onClick={doReprint}
                disabled={busy || !Number(reprint.count)}
              >
                {busy ? 'Preparing…' : `Print ${reprint.count || 0}`}
              </button>
            </div>
          </div>
        )}
      </Modal>

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
            {/* Corporate may raise an order before knowing the supplier, and
                the order creates no lot so nothing collides. The lot is minted
                by THIS button, and the person pressing it is holding the BOL —
                so the vendor is pinned down here. Unlike a missing lot number
                or best-by, a missing vendor never announces itself: it just
                merges two suppliers' "LOT001" into one lot. */}
            <label>
              <span>
                Vendor{' '}
                <span className="og-prefill">required — tells this lot from another supplier&apos;s</span>
              </span>
              <select
                value={startForm.vendor_id}
                onChange={(e) => setStartForm({ ...startForm, vendor_id: e.target.value })}
              >
                <option value="">Select vendor</option>
                {(vendors || []).map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span>
                Vendor lot{' '}
                <span className="og-prefill">required — printed on every sticker</span>
              </span>
              <input
                value={startForm.vendor_lot}
                onChange={(e) => setStartForm({ ...startForm, vendor_lot: e.target.value })}
              />
            </label>
            <label>
              <span>
                BBD{' '}
                <span className="og-prefill">required — printed on every sticker</span>
              </span>
              <input
                type="date"
                value={startForm.bbd}
                onChange={(e) => setStartForm({ ...startForm, bbd: e.target.value })}
              />
            </label>
            <label>
              <span>
                Weight per {startForm.line.unit_label || 'unit'}{' '}
                <span className="og-prefill">in LBS — every pound is derived from this</span>
              </span>
              {/* text + inputMode, never type="number": a number input edits itself
                    when the wheel passes over it, so scrolling the form silently
                    changes a figure somebody typed. */}
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
                autoFocus
              />
            </label>
            {/* Correctable here because vendors are not consistent: the order
                said 50 to a pallet and the truck brought 40. This is the gun's
                multiplier, so a wrong number books the wrong count 10 times. */}
            {/* Shown for any container, NOT only when the order already set a
                figure. That gate was self-defeating: corporate could not state a
                per-pallet count for drums because the order form never asked,
                and then this field stayed hidden because the count was empty —
                so the number could never be entered anywhere, and every drum
                took a whole rack slot. */}
            {asksPerPallet(startForm.line.unit_label) && (
              <label>
                <span>
                  Per pallet{' '}
                  <span className="og-prefill">
                    how many {startForm.line.unit_label || 'unit'}s on one pallet
                  </span>
                </span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={startForm.units_per_pallet}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === '' || /^\d+$/.test(v)) {
                      setStartForm({ ...startForm, units_per_pallet: v });
                    }
                  }}
                />
              </label>
            )}
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
                {busy ? 'Working…' : (() => {
                  const per = Number(startForm.units_per_pallet) || 0;
                  const n = Number(startForm.expected_count) || 0;
                  return per > 1
                    ? `Print ${Math.ceil(n / per)} pallet stickers`
                    : `Print ${n} stickers`;
                })()}
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
        title={form?.walkIn ? 'Walk-in delivery' : 'New incoming order'}
        size="lg"
      >
        {form && (
          <>
            {form.walkIn && (
              <div className="og-note" style={{ margin: '0 0 12px' }}>
                <Truck size={14} /> Copy what is on the driver&apos;s BOL. This
                goes onto <strong>today&apos;s</strong> schedule right away — then
                print the stickers and scan it in, exactly like a scheduled load.
              </div>
            )}
            <div className="og-modal-form">
              <label>
                <span>Vendor</span>
                <select
                  value={form.vendor_id}
                  onChange={(e) => setForm({ ...form, vendor_id: e.target.value })}
                >
                  <option value="">— not known yet</option>
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
                {/* Only for material that arrives palletised. Drums and totes
                    are stickered one by one at the dock, so there is no pallet
                    multiplier to record and asking would invite a wrong answer. */}
                {asksPerPallet(line.unit_label) && (
                  <label>
                    <span>
                      Per pallet{' '}
                      <span className="og-prefill">
                        {PALLETISED_UNITS.has(line.unit_label)
                          ? `how many ${line.unit_label}s are wrapped on one pallet`
                          : `how many ${line.unit_label}s ride one pallet — blank if one per slot`}
                      </span>
                    </span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={line.units_per_pallet}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === '' || /^\d+$/.test(v)) {
                          patchLine(index, { units_per_pallet: v });
                        }
                      }}
                      placeholder="50"
                    />
                  </label>
                )}
                <label>
                  <span>
                    Weight each{' '}
                    {/* Required in practice, not just useful: pounds are derived
                        from it, and the server flags a lot without one and
                        refuses to print stickers for it — so nothing can be
                        received until it is filled in. */}
                    <span className="og-prefill">in LBS — required, every pound comes from this</span>
                  </span>
                  {/* type="text" + inputMode="decimal", NOT type="number".
                      A number input changes its value when the wheel passes over
                      a focused field, so scrolling the form silently edits the
                      one figure every derived pound depends on.

                      POUNDS, and no unit selector. Nothing downstream converts,
                      so a mixed store means every aggregate has to know which
                      row is which — and one missed conversion is silent. If the
                      vendor quotes kg, convert before typing. */}
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
                  />
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
                {busy
                  ? (form.walkIn ? 'Logging…' : 'Creating…')
                  : (form.walkIn ? 'Log walk-in' : 'Create order')}
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
