import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import { useToast } from '../../context/ToastContext';
import { getDashboardPath } from '../../App';
import SearchableSelect from '../SearchableSelect';
import { ContainerLabelSheet } from './ContainerLabel';
import {
  apiErrorMessage,
  convertLegacyDrum,
  getSweepEligibility,
  listIngredientRows,
  resolveIngredientRow,
} from '../../api/ingredientCutoverApi';
import { formatDate, formatDateTime } from '../../utils/dateUtils';
import {
  CONTAINER_STATUS,
  CONTAINER_TYPE,
  RECEIPT_STATUS,
  ROLES,
  containerUnitLabel,
  isIngredientType,
} from '../../constants';
import '../Shared.css';
import './CutoverSweepPage.css';

/**
 * Floor-sweep workstation — SPEC §15.2.
 *
 * Converts legacy ingredient drums into serialized containers ONE DRUM AT A
 * TIME, which is the only granularity that is physically true: a sweeper is
 * standing in front of a drum, reading its old sticker, and sticking a new one
 * on it. There is deliberately no "convert all 40" button — a bulk convert
 * would mint forty serials for drums nobody looked at, and §15.2's whole point
 * is capturing sealed/partial/damaged state *while touching each drum*.
 *
 * ── Why the loop is shaped the way it is ─────────────────────────────────────
 * A sweep session is dozens of drums off ONE receipt into (usually) ONE row.
 * So the receipt and the row are sticky and only the per-drum facts reset after
 * each conversion. The two per-drum corrections — `damaged` and
 * `opened_remaining` — are cleared automatically on success, because a ticked
 * "damaged" box carried silently into the next twenty drums is a far worse
 * outcome than re-ticking it.
 *
 * The lot/BBD overrides are the opposite: they rewrite the SWEEP LOT that every
 * drum off this receipt hangs from (ingredient_cutover_service.convert_one), so
 * they stay set for the session and their blast radius is spelled out on screen
 * and re-confirmed the first time they are applied.
 *
 * ── Why conversions are not queued offline ──────────────────────────────────
 * See the note on `convertLegacyDrum` in api/ingredientCutoverApi.js: convert
 * carries no idempotency key and mints the next serial on every call, so a
 * replay is a phantom drum. Scans that CAN be replayed safely (receiving,
 * staging) go through utils/scanQueue.js; this one must not.
 *
 * ── Role ────────────────────────────────────────────────────────────────────
 * Gated client-side to APPROVAL_ROLES (backend `_require_sweeper`,
 * routers/ingredient_cutover.py). The gate is a courtesy — the server is the
 * authority, so a 403 that slips through is rendered as the server wrote it
 * rather than as a generic failure.
 */

// Mirrors backend APPROVAL_ROLES (app/constants.py). `corporate_viewer` is
// absent there and absent here.
const SWEEP_ROLES = [
  ROLES.SUPERVISOR,
  ROLES.ADMIN,
  ROLES.SUPERADMIN,
  ROLES.CORPORATE_ADMIN,
];

// Statuses that represent live legacy stock. Rejected/depleted/pending receipts
// are not sweepable material; the server re-checks anyway.
const SWEEPABLE_STATUSES = [
  RECEIPT_STATUS.APPROVED,
  RECEIPT_STATUS.RECORDED,
  RECEIPT_STATUS.REVIEWED,
];

// Sweep drums are barrels — ingredient_cutover_service pins the sweep lot's
// container_type to 'barrel'. Never the string "cases" (§6.3 / §19.1).
const SWEEP_CONTAINER_TYPE = CONTAINER_TYPE.BARREL;

/** Numbers only. `Date.toLocaleString` is banned; this is a Number. */
const fmtQty = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
};

const fmtCount = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString();
};

/**
 * The label wants an INSTANT for RCV, but the mapped receipt only carries a
 * calendar day (`YYYY-MM-DD`). Feeding that straight through would let
 * `toDateKey` inside ContainerLabel shift it a day backwards in any US
 * warehouse timezone and print the wrong received date on a food-safety label.
 * Anchoring at noon UTC makes the calendar day survive a conversion in either
 * direction. Values that already look like instants are passed through
 * untouched.
 */
const receiptDateAsInstant = (dateKey) => {
  if (!dateKey) return null;
  const str = String(dateKey);
  if (str.includes('T')) return str;
  return /^\d{4}-\d{2}-\d{2}$/.test(str) ? `${str}T12:00:00Z` : str;
};

const CutoverSweepPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const { receipts, products, categories, vendors, refreshReceipts } = useAppData();

  const canSweep = SWEEP_ROLES.includes(user?.role);

  // ─── Step 1: the legacy receipt ────────────────────────────────────────────
  const [receiptId, setReceiptId] = useState('');
  const [eligibility, setEligibility] = useState(null);
  const [eligibilityLoading, setEligibilityLoading] = useState(false);
  const [eligibilityError, setEligibilityError] = useState('');

  // ─── Step 2: the destination row ───────────────────────────────────────────
  const [rowCode, setRowCode] = useState('');
  const [resolvedRow, setResolvedRow] = useState(null);
  const [rowResolving, setRowResolving] = useState(false);
  const [rowError, setRowError] = useState('');
  const [rowOptions, setRowOptions] = useState([]);
  const [rowOptionsLoading, setRowOptionsLoading] = useState(false);
  const [showRowPicker, setShowRowPicker] = useState(false);

  // ─── Step 3: per-drum corrections ──────────────────────────────────────────
  const [lotOverride, setLotOverride] = useState('');
  const [bbdOverride, setBbdOverride] = useState('');
  const [damaged, setDamaged] = useState(false);
  const [openedRemaining, setOpenedRemaining] = useState('');
  const [overridesAcknowledged, setOverridesAcknowledged] = useState(false);

  // ─── Conversion + session ──────────────────────────────────────────────────
  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const [session, setSession] = useState([]);
  const [autoPrint, setAutoPrint] = useState(true);
  const [printBatch, setPrintBatch] = useState(null);

  const rowInputRef = useRef(null);
  // Guards against a stale eligibility response landing after the user has
  // already moved to a different receipt.
  const eligibilitySeq = useRef(0);
  // Set once a drum has been converted since the last global receipts refresh,
  // so the refresh happens on leaving the lot rather than on every drum.
  const receiptsDirty = useRef(false);

  const productLookup = useMemo(() => {
    const map = {};
    products.forEach((p) => { map[p.id] = p; });
    return map;
  }, [products]);

  const categoryLookup = useMemo(() => {
    const map = {};
    categories.forEach((c) => { map[c.id] = c; });
    return map;
  }, [categories]);

  const vendorLookup = useMemo(() => {
    const map = {};
    (vendors || []).forEach((v) => { map[v.id] = v; });
    return map;
  }, [vendors]);

  // ─── Sweepable receipts ────────────────────────────────────────────────────
  // isIngredientType, never a bare equality: raw materials keep the legacy
  // receipt flow and must not appear here.
  const sweepReceipts = useMemo(
    () => receipts.filter((r) => (
      isIngredientType(categoryLookup[r.categoryId]?.type)
      && SWEEPABLE_STATUSES.includes(r.status)
      && (r.quantity || 0) > 0
    )),
    [receipts, categoryLookup],
  );

  const selectedReceipt = useMemo(
    () => sweepReceipts.find((r) => r.id === receiptId) || null,
    [sweepReceipts, receiptId],
  );

  const receiptOptions = useMemo(() => sweepReceipts.map((r) => {
    const name = productLookup[r.productId]?.name || 'Unknown product';
    const count = r.containerCount || 0;
    const countPart = count
      ? ` · ${fmtCount(count)} ${containerUnitLabel(SWEEP_CONTAINER_TYPE, count)}`
      : '';
    const holdPart = r.hold ? ' [ON HOLD]' : '';
    return {
      value: r.id,
      label: `${name} · Lot ${r.lotNo || '—'} · ${fmtQty(r.quantity)} ${r.quantityUnits}${countPart} · ${formatDate(r.receiptDate)}${holdPart}`,
    };
  }), [sweepReceipts, productLookup]);

  // ─── Eligibility ───────────────────────────────────────────────────────────
  const loadEligibility = useCallback(async (id) => {
    if (!id) {
      setEligibility(null);
      setEligibilityError('');
      return;
    }
    const seq = ++eligibilitySeq.current;
    setEligibilityLoading(true);
    setEligibilityError('');
    try {
      const { data } = await getSweepEligibility(id);
      if (seq !== eligibilitySeq.current) return;
      setEligibility(data);
    } catch (err) {
      if (seq !== eligibilitySeq.current) return;
      setEligibility(null);
      setEligibilityError(apiErrorMessage(err, 'Could not check sweep eligibility.'));
    } finally {
      if (seq === eligibilitySeq.current) setEligibilityLoading(false);
    }
  }, []);

  const syncReceipts = useCallback(() => {
    // The receipt list is the eagerly-loaded global store; refreshing it per
    // drum would put a full receipts fetch inside a 40-drum loop. The
    // authoritative per-drum numbers come from the convert response and the
    // eligibility re-check, so the global refresh happens only when the sweeper
    // leaves the lot.
    if (!receiptsDirty.current) return;
    receiptsDirty.current = false;
    Promise.resolve(refreshReceipts?.()).catch(() => {
      // A stale picker label is cosmetic; never surface it as a sweep failure.
    });
  }, [refreshReceipts]);

  const handleReceiptChange = useCallback((id) => {
    syncReceipts();
    setReceiptId(id);
    setLastResult(null);
    setConvertError('');
    setLotOverride('');
    setBbdOverride('');
    setDamaged(false);
    setOpenedRemaining('');
    setOverridesAcknowledged(false);
    loadEligibility(id);
  }, [loadEligibility, syncReceipts]);

  // ─── Row resolution (server-side only) ─────────────────────────────────────
  const handleResolveRow = useCallback(async (rawCode) => {
    const code = (rawCode ?? '').trim();
    if (!code) {
      setRowError('Scan or type a row barcode.');
      return;
    }
    setRowResolving(true);
    setRowError('');
    try {
      const { data } = await resolveIngredientRow(code);
      setResolvedRow(data);
      setRowCode('');
      setRowError('');
    } catch (err) {
      // The server's message names the ambiguous candidates or the deactivated
      // row. Show it verbatim — this endpoint exists precisely so the client
      // never guesses which rack was meant.
      setResolvedRow(null);
      setRowError(apiErrorMessage(err, 'Row not found.'));
    } finally {
      setRowResolving(false);
    }
  }, []);

  const loadRowOptions = useCallback(async () => {
    setRowOptionsLoading(true);
    try {
      const { data } = await listIngredientRows();
      setRowOptions(Array.isArray(data) ? data : []);
    } catch (err) {
      addToast(apiErrorMessage(err, 'Could not load storage rows.'), 'error');
      setRowOptions([]);
    } finally {
      setRowOptionsLoading(false);
    }
  }, [addToast]);

  const handleOpenRowPicker = useCallback(() => {
    setShowRowPicker(true);
    if (!rowOptions.length && !rowOptionsLoading) loadRowOptions();
  }, [rowOptions.length, rowOptionsLoading, loadRowOptions]);

  // Picking from the list is a human reading names and choosing one, which is
  // NOT the banned client-side fuzzy match: a wrong pick is visible on screen
  // before anything is written. Scans still go through /resolve.
  const handlePickRow = useCallback((id) => {
    const row = rowOptions.find((r) => r.id === id);
    if (!row) return;
    setResolvedRow({ ...row, resolved_by: 'picker' });
    setRowError('');
  }, [rowOptions]);

  // ─── Print ─────────────────────────────────────────────────────────────────
  // Idiom copied from PalletizerKioskPage.jsx:97-101 — render the sheet, let the
  // DOM paint, then fire window.print on a timeout.
  useEffect(() => {
    if (!printBatch) return undefined;
    document.body.classList.add('cutover-print-mode');
    const id = setTimeout(() => {
      window.print();
      setPrintBatch(null);
    }, 250);
    return () => {
      clearTimeout(id);
      document.body.classList.remove('cutover-print-mode');
    };
  }, [printBatch]);

  // Focus the scan box as soon as there is something to scan into.
  useEffect(() => {
    if (eligibility?.eligible && !resolvedRow) rowInputRef.current?.focus();
  }, [eligibility?.eligible, resolvedRow]);

  // Leaving the page with unsynced conversions still refreshes the store.
  useEffect(() => () => syncReceipts(), [syncReceipts]);

  // ─── Convert ───────────────────────────────────────────────────────────────
  const weightPerContainer = Number(eligibility?.weight_per_container || 0);

  const openedRemainingNumber = openedRemaining === '' ? null : Number(openedRemaining);

  const openedRemainingError = useMemo(() => {
    if (openedRemaining === '') return '';
    if (!Number.isFinite(openedRemainingNumber)) return 'Enter a number.';
    if (openedRemainingNumber <= 0) {
      return 'An empty drum is not stock — dispose of it instead of converting it.';
    }
    if (weightPerContainer > 0 && openedRemainingNumber > weightPerContainer) {
      return `Cannot exceed the drum's net weight (${fmtQty(weightPerContainer)} ${eligibility?.unit || ''}).`;
    }
    return '';
  }, [openedRemaining, openedRemainingNumber, weightPerContainer, eligibility?.unit]);

  const readyToConvert = Boolean(
    canSweep
    && eligibility?.eligible
    && resolvedRow?.id
    && !openedRemainingError
    && !converting,
  );

  const handleConvert = useCallback(async () => {
    if (!readyToConvert || !selectedReceipt) return;

    const hasOverride = Boolean(lotOverride.trim() || bbdOverride);
    if (hasOverride && !overridesAcknowledged) {
      const ok = await confirm(
        'The lot / BBD override is written to the sweep lot for this receipt, so every '
        + 'drum converted from it — including the ones already converted in this session — '
        + 'carries the corrected value. Apply it?',
        { title: 'Apply lot correction', confirmLabel: 'Apply' },
      );
      if (!ok) return;
      setOverridesAcknowledged(true);
    }

    setConverting(true);
    setConvertError('');
    try {
      const payload = {
        receipt_id: selectedReceipt.id,
        storage_row_id: resolvedRow.id,
        damaged,
      };
      if (lotOverride.trim()) payload.lot_number_override = lotOverride.trim();
      if (bbdOverride) payload.bbd_override = bbdOverride;
      if (openedRemainingNumber !== null) payload.opened_remaining = openedRemainingNumber;

      const { data } = await convertLegacyDrum(payload);

      const product = productLookup[selectedReceipt.productId];
      const labelContainer = {
        ...data.container,
        // Joined client-side: the convert response serializes the Container row,
        // which carries no SID / vendor / receipt date of its own.
        product_sid: product?.sid || '',
        vendor_name: vendorLookup[selectedReceipt.vendorId]?.name || '',
        receipt_date: receiptDateAsInstant(selectedReceipt.receiptDate),
        // Derived exactly as the backend derives it for a sweep lot
        // (`lot_unknown = not bool(lot_number)`), so an unreadable drum prints
        // "UNKNOWN" rather than a blank Lot field (§15.4, §18.8 C-1).
        lot_unknown: !data.container?.vendor_lot,
      };

      const entry = {
        key: data.serial,
        serial: data.serial,
        intakeNumber: data.intake_number,
        rowName: resolvedRow.name,
        rowPath: resolvedRow.path || '',
        taken: data.taken,
        unit: data.unit,
        status: data.container?.status,
        at: new Date().toISOString(),
        labelContainer,
      };

      receiptsDirty.current = true;
      setSession((prev) => [entry, ...prev]);
      // The row card's count is now one behind. This is an echo of a KNOWN
      // increment (the drum just went into this row), not a client-side
      // recompute — re-resolving the row on every drum would put a round trip
      // in the middle of the loop for one number.
      setResolvedRow((prev) => (
        prev ? { ...prev, container_count: Number(prev.container_count || 0) + 1 } : prev
      ));
      setLastResult({ ...data, labelContainer, rowName: resolvedRow.name });
      // Per-drum facts never survive a drum. See the header note.
      setDamaged(false);
      setOpenedRemaining('');
      if (autoPrint) setPrintBatch([labelContainer]);
      addToast(`${data.serial} converted into ${resolvedRow.name}.`, 'success');
      loadEligibility(selectedReceipt.id);
    } catch (err) {
      const message = apiErrorMessage(err, 'Conversion failed.');
      if (err?.response?.status === 403) setForbidden(true);
      setConvertError(message);
      addToast(message, 'error');
      // The receipt may have moved even on a rejected balance assertion path;
      // re-read rather than trusting the screen.
      loadEligibility(selectedReceipt.id);
    } finally {
      setConverting(false);
    }
  }, [
    readyToConvert, selectedReceipt, resolvedRow, damaged, lotOverride, bbdOverride,
    openedRemainingNumber, overridesAcknowledged, confirm, productLookup, vendorLookup,
    autoPrint, addToast, loadEligibility,
  ]);

  const handleFinishLot = useCallback(() => {
    syncReceipts();
    setReceiptId('');
    setEligibility(null);
    setLastResult(null);
    setConvertError('');
    setLotOverride('');
    setBbdOverride('');
    setDamaged(false);
    setOpenedRemaining('');
    setOverridesAcknowledged(false);
  }, [syncReceipts]);

  // ─── Render ────────────────────────────────────────────────────────────────
  if (!canSweep) {
    return (
      <div className="cutover-sweep">
        <div className="page-header">
          <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
            &larr; Back to Dashboard
          </button>
          <div className="header-content">
            <h2>Cutover Sweep</h2>
          </div>
        </div>
        <div className="cutover-card cutover-banner cutover-banner--danger">
          <strong>Only supervisors and above can run the floor sweep.</strong>
          <p className="muted small">
            A conversion permanently moves quantity off a legacy receipt, so it carries the
            same authority as an approval.
          </p>
        </div>
      </div>
    );
  }

  const unit = eligibility?.unit || selectedReceipt?.quantityUnits || '';
  const eligibleCount = Number(eligibility?.container_count || 0);

  return (
    <div className="cutover-sweep">
      <div className="page-header">
        <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
          &larr; Back to Dashboard
        </button>
        <div className="header-content">
          <h2>Cutover Sweep</h2>
          <p className="muted">
            One drum at a time: pick the legacy lot, scan the rack, record what the drum
            actually looks like, convert, sticker it.
          </p>
        </div>
      </div>

      {forbidden && (
        <div className="cutover-banner cutover-banner--danger">
          The server refused the conversion for your role. Nothing was written.
        </div>
      )}

      <div className="cutover-sweep__grid">
        <div className="cutover-sweep__col">
          {/* ── Step 1 ── */}
          <section className="cutover-card">
            <header className="cutover-card__header">
              <span className="cutover-step">1</span>
              <h3>Legacy lot</h3>
            </header>

            <label className="cutover-field">
              <span>Ingredient receipt</span>
              <SearchableSelect
                options={receiptOptions}
                value={receiptId}
                onChange={handleReceiptChange}
                placeholder="Select the legacy lot being swept"
                searchPlaceholder="Search by product or lot…"
              />
            </label>

            {!receiptOptions.length && (
              <p className="muted small">
                No legacy ingredient receipts with stock remaining.
              </p>
            )}

            {eligibilityLoading && <p className="muted small">Checking eligibility…</p>}

            {eligibilityError && (
              <div className="cutover-banner cutover-banner--danger">{eligibilityError}</div>
            )}

            {eligibility && !eligibility.eligible && (
              <div className="cutover-banner cutover-banner--danger">
                <strong>Cannot sweep this lot</strong>
                <ul className="cutover-reasons">
                  {(eligibility.reasons || []).map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}

            {eligibility?.eligible && (
              <div className="cutover-banner cutover-banner--ok">
                <strong>Eligible to sweep</strong>
              </div>
            )}

            {eligibility?.fully_held && (
              <div className="cutover-banner cutover-banner--warn">
                Lot is fully held — every drum converted from it inherits the hold.
              </div>
            )}

            {eligibility && (
              <dl className="cutover-stats">
                <div>
                  <dt>Remaining on receipt</dt>
                  <dd>{fmtQty(eligibility.remaining_qty)} {unit}</dd>
                </div>
                <div>
                  <dt>Drums left</dt>
                  <dd>
                    {fmtCount(eligibility.container_count)}{' '}
                    {containerUnitLabel(SWEEP_CONTAINER_TYPE, eligibleCount)}
                  </dd>
                </div>
                <div>
                  <dt>Weight per drum</dt>
                  <dd>
                    {eligibility.weight_per_container
                      ? `${fmtQty(eligibility.weight_per_container)} ${unit}`
                      : '— not recorded'}
                  </dd>
                </div>
              </dl>
            )}
          </section>

          {/* ── Step 2 ── */}
          <section className={`cutover-card ${eligibility?.eligible ? '' : 'cutover-card--muted'}`}>
            <header className="cutover-card__header">
              <span className="cutover-step">2</span>
              <h3>Destination row</h3>
            </header>

            <form
              className="cutover-scan"
              onSubmit={(e) => { e.preventDefault(); handleResolveRow(rowCode); }}
            >
              <input
                ref={rowInputRef}
                type="text"
                className="cutover-scan__input"
                value={rowCode}
                onChange={(e) => setRowCode(e.target.value)}
                placeholder="Scan rack label…"
                disabled={!eligibility?.eligible || rowResolving}
                autoComplete="off"
              />
              <button
                type="submit"
                className="primary-button"
                disabled={!eligibility?.eligible || rowResolving || !rowCode.trim()}
              >
                {rowResolving ? 'Resolving…' : 'Resolve'}
              </button>
            </form>

            {rowError && (
              <div className="cutover-banner cutover-banner--danger">{rowError}</div>
            )}

            {resolvedRow && (
              <div className="cutover-row-card">
                <div className="cutover-row-card__name">{resolvedRow.name}</div>
                <div className="muted small">{resolvedRow.path || '—'}</div>
                <div className="muted small">
                  Holding {fmtCount(resolvedRow.container_count || 0)}{' '}
                  {containerUnitLabel(SWEEP_CONTAINER_TYPE, resolvedRow.container_count || 0)}
                  {resolvedRow.pallet_capacity
                    ? ` · capacity ${fmtCount(resolvedRow.pallet_capacity)} (advisory)`
                    : ''}
                </div>
                <button
                  type="button"
                  className="link-button small"
                  onClick={() => { setResolvedRow(null); rowInputRef.current?.focus(); }}
                >
                  Change row
                </button>
              </div>
            )}

            {!showRowPicker ? (
              <button
                type="button"
                className="link-button small"
                onClick={handleOpenRowPicker}
                disabled={!eligibility?.eligible}
              >
                Rack label unreadable — pick the row from a list
              </button>
            ) : (
              <label className="cutover-field">
                <span>Row</span>
                <SearchableSelect
                  options={rowOptions.map((r) => ({
                    value: r.id,
                    label: `${r.name}${r.path ? ` — ${r.path}` : ''}`,
                  }))}
                  value={resolvedRow?.id || ''}
                  onChange={handlePickRow}
                  placeholder={rowOptionsLoading ? 'Loading rows…' : 'Select a row'}
                  searchPlaceholder="Search rows…"
                />
              </label>
            )}
          </section>

          {/* ── Step 3 ── */}
          <section className={`cutover-card ${resolvedRow ? '' : 'cutover-card--muted'}`}>
            <header className="cutover-card__header">
              <span className="cutover-step">3</span>
              <h3>This drum</h3>
            </header>

            <div className="cutover-field-row">
              <label className="cutover-field">
                <span>Lot correction</span>
                <input
                  type="text"
                  value={lotOverride}
                  onChange={(e) => { setLotOverride(e.target.value); setOverridesAcknowledged(false); }}
                  placeholder={selectedReceipt?.lotNo || 'Lot unknown on receipt'}
                  disabled={!eligibility?.eligible}
                />
              </label>
              <label className="cutover-field">
                <span>BBD correction</span>
                <input
                  type="date"
                  value={bbdOverride}
                  onChange={(e) => { setBbdOverride(e.target.value); setOverridesAcknowledged(false); }}
                  disabled={!eligibility?.eligible}
                />
              </label>
            </div>
            <p className="muted small">
              Corrections read off a legible drum label. Both are written to the sweep lot,
              so they apply to every drum converted from this receipt — not just this one.
            </p>

            <div className="cutover-field-row">
              <label className="cutover-check">
                <input
                  type="checkbox"
                  checked={damaged}
                  onChange={(e) => setDamaged(e.target.checked)}
                  disabled={!eligibility?.eligible}
                />
                <span>Drum is damaged</span>
              </label>

              <label className="cutover-field">
                <span>Remaining if part-used ({unit || 'weight'})</span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={openedRemaining}
                  onChange={(e) => setOpenedRemaining(e.target.value)}
                  placeholder={weightPerContainer ? `Sealed = ${fmtQty(weightPerContainer)}` : 'Sealed drum: leave blank'}
                  disabled={!eligibility?.eligible}
                />
              </label>
            </div>
            {openedRemainingError && (
              <div className="cutover-banner cutover-banner--danger">{openedRemainingError}</div>
            )}
            <p className="muted small">
              Both reset after every conversion — a ticked box must never ride along to the
              next drum.
            </p>
          </section>

          {/* ── Convert ── */}
          <section className="cutover-card cutover-card--action">
            {convertError && (
              <div className="cutover-banner cutover-banner--danger">{convertError}</div>
            )}
            <button
              type="button"
              className="cutover-convert"
              onClick={handleConvert}
              disabled={!readyToConvert}
            >
              {converting ? 'Converting…' : 'Convert this drum'}
            </button>
            <label className="cutover-check">
              <input
                type="checkbox"
                checked={autoPrint}
                onChange={(e) => setAutoPrint(e.target.checked)}
              />
              <span>Print the label automatically after each conversion</span>
            </label>
            {receiptId && (
              <button type="button" className="link-button small" onClick={handleFinishLot}>
                Done with this lot
              </button>
            )}
          </section>
        </div>

        {/* ── Result + session ── */}
        <aside className="cutover-sweep__col cutover-sweep__col--side">
          {lastResult && (
            <section className="cutover-card cutover-result">
              <div className="cutover-result__label">Converted</div>
              <div className="cutover-result__serial">{lastResult.serial}</div>

              <div className="cutover-result__delta">
                <span className="cutover-result__delta-label">Receipt</span>
                <span className="cutover-result__delta-value">
                  {fmtQty(lastResult.receipt_quantity_before)}
                  {' → '}
                  {fmtQty(lastResult.receipt_quantity_after)} {lastResult.unit}
                </span>
              </div>
              <div className="cutover-result__delta">
                <span className="cutover-result__delta-label">Count</span>
                <span className="cutover-result__delta-value">
                  {fmtCount(lastResult.receipt_container_count_before)}
                  {' → '}
                  {fmtCount(lastResult.receipt_container_count_after)}{' '}
                  {containerUnitLabel(
                    SWEEP_CONTAINER_TYPE,
                    Number(lastResult.receipt_container_count_after ?? 0),
                  )}
                </span>
              </div>

              <div className="muted small">
                Intake {lastResult.intake_number} · row {lastResult.rowName} ·{' '}
                took {fmtQty(lastResult.taken)} {lastResult.unit}
              </div>

              {lastResult.container?.status === CONTAINER_STATUS.DAMAGED && (
                <div className="cutover-banner cutover-banner--warn">
                  Recorded as damaged — it will not be offered for staging.
                </div>
              )}
              {lastResult.container?.status === CONTAINER_STATUS.OPENED && (
                <div className="cutover-banner cutover-banner--warn">
                  Recorded as an opened drum with {fmtQty(lastResult.container?.remaining_qty)}{' '}
                  {lastResult.container?.qty_unit} remaining.
                </div>
              )}
              {lastResult.container?.is_held && (
                <div className="cutover-banner cutover-banner--warn">
                  Hold inherited from the legacy lot.
                </div>
              )}

              <div className="cutover-result__actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => setPrintBatch([lastResult.labelContainer])}
                >
                  Print label
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => { setLastResult(null); rowInputRef.current?.focus(); }}
                >
                  Next drum
                </button>
              </div>
            </section>
          )}

          <section className="cutover-card">
            <header className="cutover-card__header">
              <h3>This session</h3>
              <span className="muted small">
                {fmtCount(session.length)}{' '}
                {containerUnitLabel(SWEEP_CONTAINER_TYPE, session.length)}
              </span>
            </header>

            {session.length > 0 && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => setPrintBatch(session.map((s) => s.labelContainer))}
              >
                Reprint all {fmtCount(session.length)} labels
              </button>
            )}

            {session.length === 0 ? (
              <p className="muted small">Nothing converted yet.</p>
            ) : (
              <div className="table-wrapper">
                <table className="simple-table">
                  <thead>
                    <tr>
                      <th>Serial</th>
                      <th>Row</th>
                      <th>Took</th>
                      <th>At</th>
                    </tr>
                  </thead>
                  <tbody>
                    {session.map((entry) => (
                      <tr key={entry.key}>
                        <td>{entry.serial}</td>
                        <td>{entry.rowName}</td>
                        <td>{fmtQty(entry.taken)} {entry.unit}</td>
                        <td>{formatDateTime(entry.at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </aside>
      </div>

      {/* Hidden print root — revealed only by the print stylesheet. */}
      {printBatch && (
        <div className="cutover-print-root">
          {/* No `totalCount`: the sweep intake grows one drum at a time, so any
              denominator printed here would be a lie by the next drum. The label
              falls back to "NO. 17" rather than a wrong "17 of 40". */}
          <ContainerLabelSheet containers={printBatch} />
        </div>
      )}
    </div>
  );
};

export default CutoverSweepPage;
