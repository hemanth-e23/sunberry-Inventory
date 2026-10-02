import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  checkInTruck, knownLotWeights, listIncomingOrders, printSessionLabels, releaseIncomingOrder,
} from '../../api/lotReceivingApi';
import { formatUnitTotals } from '../../utils/truckReceiving';
import LotLabelPrint from '../ingredient/LotLabelPrint';
import '../OutgoingDashboard.css';
import { pluralizeUnit, singularUnit } from '../../utils/rowSources';
import {
  countOf, isAwaitingApproval, lotLookupKey, missingLineDetails, weightMismatchWarning,
} from '../../utils/incomingLines';

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
 * ── What "Check in truck" does, and what it deliberately does not ──────────
 *
 * It opens the WHOLE truck (2026-10): every line gets its receipt and lot, lines
 * that turn out to be the same lot are merged, and the stickers for all of them
 * come back as one print run. It puts NOTHING in stock. A desktop button that says "yes,
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
//
// DRUMS ARE NOT ON THIS LIST, and asking them the question is what printed
// "PALLET OF DRUMS" for a 69-drum delivery. Drums do ride pallets, two or four
// to a pallet, but they do not SHARE a sticker: each one is labelled and pulled
// on its own, so one scan must mean one drum. The rack count that motivated
// asking is answered by the room's `storage_unit` instead.
const PALLETISED_UNITS = new Set(['bag', 'box', 'bottle', 'case', 'pail']);

const asksPerPallet = (unit) =>
  PALLETISED_UNITS.has(singularUnit(String(unit || '').toLowerCase()));

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

// Amber, never red — the same convention as short/over on the cards. A
// weight that differs from an earlier delivery is a question, not an error.
const WARN_STYLE = { color: '#b45309', fontWeight: 600 };

const WeightNote = ({ text }) => (text ? (
  <div className="og-sub" style={WARN_STYLE}>
    <AlertTriangle size={13} /> {text}
  </div>
) : null);

/** A confirm message with the F17 weight questions under it (JSX — ConfirmDialog keeps no line breaks). */
const withWarnings = (text, notes = []) => (notes.length ? (
  <>
    {text}
    {notes.map((note) => (
      <span key={note} style={{ ...WARN_STYLE, display: 'block', marginTop: 8 }}>{note}</span>
    ))}
  </>
) : text);

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
  // Earlier deliveries' weight per unit, by lot key (lotLookupKey). Filled
  // while a form is open so a known lot typed at a different weight is
  // questioned before it is booked (F17). A failed lookup is cached as
  // "nothing known" — the warning is a nicety, never a gate.
  const [knownWeights, setKnownWeights] = useState({});
  const askedWeights = useRef(new Set());

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

  // The lot each open form line describes, in the shape the lookup takes.
  // Walk-in / order lines take the header vendor; check-in lines their own.
  const lotQueries = useMemo(() => {
    const out = [];
    (form?.lines || []).forEach((l) => out.push({
      product_id: l.product_id, vendor_id: form.vendor_id, vendor_lot: l.vendor_lot, bbd: l.bbd,
    }));
    (startForm?.lines || []).forEach((d) => out.push({
      product_id: d.line.product_id, vendor_id: d.vendor_id, vendor_lot: d.vendor_lot, bbd: d.bbd,
    }));
    return out.filter((q) => lotLookupKey(q));
  }, [form, startForm]);

  useEffect(() => {
    const todo = lotQueries.filter((q) => !askedWeights.current.has(lotLookupKey(q)));
    if (!todo.length) return undefined;
    // Debounced: the lot number is typed a character at a time.
    const timer = setTimeout(() => {
      todo.forEach((q) => {
        const key = lotLookupKey(q);
        if (askedWeights.current.has(key)) return;
        askedWeights.current.add(key);
        knownLotWeights(q)
          .catch(() => ({ lots: [] }))
          .then((data) => setKnownWeights((prev) => ({ ...prev, [key]: data || { lots: [] } })));
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [lotQueries]);

  // Forget the answers when no form is open: a truck checked in since then is
  // exactly the earlier delivery the next form must hear about.
  useEffect(() => {
    if (!form && !startForm) {
      askedWeights.current = new Set();
      setKnownWeights({});
    }
  }, [form, startForm]);

  /** The F17 "different weight, correct?" text for one line, or null. */
  const weightWarning = (query, typed, unit) => weightMismatchWarning(
    knownWeights[lotLookupKey(query)], typed, { vendorLot: query.vendor_lot, unit },
  );

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
    // lot — the lot is minted at check-in — so nothing can collide yet. The
    // vendor gate lives where the lot is actually born and where somebody is
    // holding the BOL. See `submitCheckIn`.
    //
    // The plant rule IS enforced here (2026-10-01, F14): a delivery with no
    // vendor lot, no best-by or no weight per unit is not accepted, so it is
    // refused before it lands on the schedule. The server refuses it too.
    const productName = (id) => (products || []).find((p) => p.id === id)?.name || 'A line';
    for (const line of lines) {
      const missing = missingLineDetails(line);
      if (missing.length) {
        addToast(
          `${productName(line.product_id)}: no ${missing.join(', ')}. A delivery without `
          + 'its vendor lot, best-by date and weight per unit is not accepted.',
          'error',
        );
        return;
      }
    }
    const isWalkIn = Boolean(form.walkIn);
    const totalUnits = lines.reduce((sum, l) => sum + Number(l.expected_count || 0), 0);
    const weightNotes = lines
      .map((l) => weightWarning(
        { product_id: l.product_id, vendor_id: form.vendor_id, vendor_lot: l.vendor_lot, bbd: l.bbd },
        l.weight_per_unit, l.unit_label,
      ))
      .filter(Boolean);
    const ok = await confirm(
      withWarnings(
        `This order is for ${selectedWarehouseName || 'the selected warehouse'}. `
        + `${totalUnits} units across ${countOf(lines.length, 'product line')}. `
        + (isWalkIn
          ? 'It goes straight onto today\'s schedule, ready to sticker and scan.'
          : 'Creating it puts nothing in stock.'),
        weightNotes,
      ),
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
   * Check the whole truck in against the driver's paperwork.
   *
   * One form for every line not yet started, prefilled from corporate's order
   * because corporate fills 99% of it. What is editable is the part the worker
   * can actually see on the truck.
   */
  const lineDraft = (order, line) => ({
    line,
    vendor_id: line.vendor_id || order.vendor_id || '',
    vendor_lot: line.vendor_lot || '',
    bbd: line.bbd ? String(line.bbd).slice(0, 10) : '',
    weight_per_unit: line.weight_per_unit == null ? '' : String(line.weight_per_unit),
    // Blank for anything stickered one container at a time, even when the line
    // carries a figure raised before that rule existed — loading it would put a
    // number into a field nobody can see, question or correct.
    units_per_pallet:
      line.units_per_pallet == null || !asksPerPallet(line.unit_label)
        ? ''
        : String(line.units_per_pallet),
    expected_count: String(line.expected_count ?? ''),
  });

  const openCheckIn = (order) => setStartForm({
    order,
    bol: order.bol || '',
    lines: (order.lines || []).filter((l) => !l.receipt_id).map((l) => lineDraft(order, l)),
  });

  const draftQuery = (d) => ({
    product_id: d.line.product_id, vendor_id: d.vendor_id, vendor_lot: d.vendor_lot, bbd: d.bbd,
  });

  const patchDraft = (index, patch) => setStartForm((prev) => ({
    ...prev,
    lines: prev.lines.map((d, i) => (i === index ? { ...d, ...patch } : d)),
  }));

  // NEVER SEND WHAT WAS NOT ASKED. Hiding the per-pallet input does not empty
  // it, so a drum line given a figure before that rule existed would otherwise
  // carry it invisibly onto the lot and print pallet stickers.
  const perPalletOf = (draft) => (
    asksPerPallet(draft.line.unit_label) ? Number(draft.units_per_pallet) || 0 : 0
  );

  const submitCheckIn = async () => {
    const { order } = startForm;
    // All of these are hard requirements at the SERVER too. Checked here so the
    // worker is told at the form instead of at the printer, standing next to a
    // pallet with nothing to stick on it.
    for (const draft of startForm.lines) {
      const name = draft.line.product_name;
      if (!draft.vendor_id) {
        addToast(
          `${name}: pick the vendor from the BOL — it is part of what tells this lot `
          + 'apart from another supplier\'s lot with the same number.',
          'error',
        );
        return;
      }
      if (!draft.vendor_lot.trim()) {
        addToast(
          `${name}: the vendor lot number is needed — every drum of this lot carries `
          + 'the same sticker, so one reading "UNKNOWN" makes them impossible to tell apart.',
          'error',
        );
        return;
      }
      if (!draft.bbd) {
        addToast(`${name}: the best-by date is needed — it is printed on every sticker.`, 'error');
        return;
      }
      if (!Number(draft.weight_per_unit)) {
        addToast(
          `${name}: weight per ${draft.line.unit_label || 'unit'} is needed — every pound is worked out from it.`,
          'error',
        );
        return;
      }
    }
    // A known lot at a different weight: ask, never refuse (F17).
    const weightNotes = startForm.lines
      .map((d) => weightWarning(draftQuery(d), d.weight_per_unit, d.line.unit_label))
      .filter(Boolean);
    if (weightNotes.length) {
      const ok = await confirm(
        withWarnings('Check the weight per unit against the paperwork before checking in.', weightNotes),
        { title: 'Different weight than before', confirmLabel: 'It is correct — check in' },
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      const truck = await checkInTruck(order.id, {
        bol: startForm.bol || null,
        lines: startForm.lines.map((draft) => ({
          line_id: draft.line.id,
          vendor_id: draft.vendor_id || null,
          vendor_lot: draft.vendor_lot || null,
          bbd: draft.bbd || null,
          weight_per_unit: Number(draft.weight_per_unit),
          weight_unit: 'lbs',
          units_per_pallet: perPalletOf(draft) || null,
          expected_count: draft.expected_count === '' ? null : Number(draft.expected_count),
        })),
      });

      // Printing is NOT receiving. One print run for the whole truck: every
      // line that was just opened. PALLETISED MATERIAL GETS PALLET STICKERS,
      // one per pallet — nobody destacks a wrapped pallet at the dock — and the
      // gun turns one scan of it into a whole pallet.
      const opened = new Set(startForm.lines.map((d) => d.line.id));
      const labels = [];
      let stickers = 0;
      for (const line of truck.lines) {
        if (!line.receipt_id || line.expected_count < 1) continue;
        // A merged line keeps the FIRST line's id, so match on what was opened
        // or on a line this form never saw (it cannot have been printed yet).
        if (!opened.has(line.line_id)) continue;
        const per = asksPerPallet(line.unit_label) ? Number(line.units_per_pallet) || 0 : 0;
        const count = per > 1 ? Math.ceil(line.expected_count / per) : line.expected_count;
        const printed = await printSessionLabels(line.receipt_id, count, {
          scope: per > 1 ? 'pallet' : 'unit',
        });
        labels.push(...(printed.labels || []));
        stickers += count;
      }
      if (labels.length) setSheet({ lot_code: order.order_number, count: labels.length, labels });
      setStartForm(null);
      const merged = startForm.lines.length - truck.lines.filter((l) => opened.has(l.line_id)).length;
      addToast(
        `${order.order_number} checked in — ${countOf(stickers, 'sticker')} for ${countOf(truck.lines.length, 'lot')}`
        + (merged > 0 ? ` (${merged} duplicate line${merged > 1 ? 's' : ''} merged)` : '')
        + '. Scan them in on the gun.',
        'success',
      );
      await load();
    } catch (error) {
      addToast(apiErrorMessage(error, 'Could not check this truck in'), 'error');
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

  // A truck has ONE line per lot — every drum of a lot wears the same sticker,
  // so the gun could not tell two lines for it apart. The server merges them;
  // this says so while the form is still open. Same rule as the server's key:
  // product + lot number with spaces removed, upper-cased + best-by day.
  const duplicateOf = useMemo(() => {
    const seen = new Map();
    const dupes = {};
    (form?.lines || []).forEach((l, i) => {
      const lot = String(l.vendor_lot || '').replace(/\s+/g, '').toUpperCase();
      if (!l.product_id || !lot) return;
      const key = `${l.product_id}|${lot}|${l.bbd || ''}`;
      if (seen.has(key)) dupes[i] = seen.get(key);
      else seen.set(key, i);
    });
    return dupes;
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
    const awaitingApproval = isAwaitingApproval(order);

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
              {awaitingApproval
                ? 'Finished — awaiting approval'
                : (STATUS_LABELS[order.status] || order.status)}
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
                    {isOpen && canReceive && line.receipt_id && (
                      <button
                        type="button"
                        className="og-btn og-btn-ghost"
                        style={{ marginRight: 8 }}
                        onClick={() => {
                          // Ignore a stored figure on material that is stickered
                          // one container at a time — a reprint must hand back
                          // the same sticker the drums already wear.
                          const per = asksPerPallet(line.unit_label)
                            ? Number(line.units_per_pallet) || 0
                            : 0;
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
                    {pluralizeUnit(line.unit_label || 'unit')}
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
          {/* One figure PER KIND of material — adding drums to bottles gave
              "0 of 14152", a number that meant nothing. */}
          <div className="og-count">
            {order.totals_by_unit?.length
              ? formatUnitTotals(order.totals_by_unit)
              : <><b>{received}</b> of {expected}</>}
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

          {isOpen && canReceive && order.status !== 'draft'
            && (order.lines || []).some((l) => !l.receipt_id) && (
            <div className="og-card-actions">
              <button
                type="button"
                className="og-btn og-btn-primary"
                onClick={() => openCheckIn(order)}
                disabled={busy}
              >
                <Truck size={14} /> Check in truck
              </button>
            </div>
          )}
          {awaitingApproval && (
            <div className="og-sub" style={{ fontWeight: 600 }}>Scanned — waiting for approval</div>
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
        title={startForm ? `Check in ${startForm.order.order_number}` : 'Check in truck'}
        size="lg"
      >
        {startForm && (
          <div className="og-modal-form" style={{ maxWidth: 'none' }}>
            <p className="og-sub">
              Check every line against the driver&apos;s paperwork and correct
              anything that is wrong. Nothing goes into stock here — this opens the
              truck on the gun and prints the stickers for all of it. Two lines
              that turn out to be the same lot are merged.
            </p>
            <label>
              <span>BOL</span>
              <input
                value={startForm.bol}
                onChange={(e) => setStartForm({ ...startForm, bol: e.target.value })}
              />
            </label>

            {startForm.lines.map((draft, index) => {
              const unit = draft.line.unit_label || 'unit';
              return (
                <fieldset key={draft.line.id} className="og-checkin-line">
                  <legend>{draft.line.product_name}</legend>
                  {/* The vendor is pinned down HERE, by somebody holding the BOL.
                      Unlike a missing lot number or best-by, a missing vendor
                      never announces itself: it just merges two suppliers'
                      "LOT001" into one lot. */}
                  <label>
                    <span>
                      Vendor{' '}
                      <span className="og-prefill">required — tells this lot from another supplier&apos;s</span>
                    </span>
                    <select
                      value={draft.vendor_id}
                      onChange={(e) => patchDraft(index, { vendor_id: e.target.value })}
                    >
                      <option value="">Select vendor</option>
                      {(vendors || []).map((v) => (
                        <option key={v.id} value={v.id}>{v.name}</option>
                      ))}
                    </select>
                  </label>
                  <div className="og-checkin-grid">
                    <label>
                      <span>Vendor lot <span className="og-prefill">required</span></span>
                      <input
                        value={draft.vendor_lot}
                        onChange={(e) => patchDraft(index, { vendor_lot: e.target.value })}
                      />
                    </label>
                    <label>
                      <span>BBD <span className="og-prefill">required</span></span>
                      <input
                        type="date"
                        value={draft.bbd}
                        onChange={(e) => patchDraft(index, { bbd: e.target.value })}
                      />
                    </label>
                    <label>
                      <span>Lbs per {unit} <span className="og-prefill">required</span></span>
                      {/* text + inputMode, never type="number": a number input
                          edits itself when the wheel passes over it. */}
                      <input
                        type="text"
                        inputMode="decimal"
                        value={draft.weight_per_unit}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === '' || /^\d*\.?\d*$/.test(v)) patchDraft(index, { weight_per_unit: v });
                        }}
                        placeholder="500"
                      />
                    </label>
                    {asksPerPallet(unit) && (
                      <label>
                        <span>{pluralizeUnit(unit)} per pallet</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={draft.units_per_pallet}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === '' || /^\d+$/.test(v)) patchDraft(index, { units_per_pallet: v });
                          }}
                        />
                      </label>
                    )}
                    <label>
                      <span>How many on the BOL</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={draft.expected_count}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === '' || /^\d+$/.test(v)) patchDraft(index, { expected_count: v });
                        }}
                      />
                    </label>
                  </div>
                  <WeightNote text={weightWarning(draftQuery(draft), draft.weight_per_unit, unit)} />
                </fieldset>
              );
            })}

            <div className="og-modal-actions">
              <button type="button" className="og-btn og-btn-ghost" onClick={() => setStartForm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="og-btn og-btn-primary"
                onClick={submitCheckIn}
                disabled={busy}
              >
                {busy ? 'Working…' : (() => {
                  const n = startForm.lines.reduce((sum, d) => {
                    const per = perPalletOf(d);
                    const count = Number(d.expected_count) || 0;
                    return sum + (per > 1 ? Math.ceil(count / per) : count);
                  }, 0);
                  return `Check in & print ${countOf(n, 'sticker')}`;
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
                {/* One text span: .og-note is a flex row, so loose text and the
                    <strong> each became their own column. */}
                <Truck size={14} />
                <span>
                  Copy what is on the driver&apos;s BOL — vendor lot, best-by and
                  weight per unit are required. This goes onto{' '}
                  <strong>today&apos;s</strong> schedule right away — then print the
                  stickers and scan it in, exactly like a scheduled load.
                </span>
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
                {duplicateOf[index] != null && (
                  <div className="og-sub" style={{ color: '#b45309', fontWeight: 600 }}>
                    <AlertTriangle size={13} /> Same lot as line {duplicateOf[index] + 1} —
                    the two will be saved as one line with the counts added.
                  </div>
                )}
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
                  <span>Vendor lot <span className="og-prefill">required</span></span>
                  <input
                    value={line.vendor_lot}
                    onChange={(e) => patchLine(index, { vendor_lot: e.target.value })}
                    placeholder="off the paperwork"
                  />
                </label>
                <label>
                  <span>BBD <span className="og-prefill">required</span></span>
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
                    onChange={(e) => {
                      const unit = e.target.value;
                      // Switching to something stickered one at a time hides the
                      // per-pallet input; drop the figure with it, or the line
                      // would carry a number the form no longer shows and the
                      // dock could not correct.
                      patchLine(index, asksPerPallet(unit)
                        ? { unit_label: unit }
                        : { unit_label: unit, units_per_pallet: '' });
                    }}
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
                        how many {pluralizeUnit(line.unit_label)} are wrapped on one pallet
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
                <WeightNote
                  text={weightWarning(
                    { product_id: line.product_id, vendor_id: form.vendor_id, vendor_lot: line.vendor_lot, bbd: line.bbd },
                    line.weight_per_unit, line.unit_label,
                  )}
                />
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
