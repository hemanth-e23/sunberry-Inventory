import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Tags,
} from 'lucide-react';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import { useToast } from '../../context/ToastContext';
import Modal from '../Modal';
import SearchableSelect from '../SearchableSelect';
import IntakeCreateForm, { AddLotLineForm } from './IntakeCreateForm';
import IntakeLabelPrint from './IntakeLabelPrint';
import {
  CONTAINER_STATUS,
  INTAKE_STATUS,
  ROLES,
  containerUnitLabel,
} from '../../constants';
import { formatDate, formatDateTime, toDateKey } from '../../utils/dateUtils';
// BBD is a calendar date and must not be timezone-shifted — see the note in
// IntakeCreateForm.jsx and the labelPayload.js header. Instants (receipt date,
// submitted/approved timestamps) go through dateUtils as normal.
import { formatCalendarDate, toCalendarKey } from '../../utils/labelPayload';
import {
  LABEL_SCOPE,
  addIntakeLot,
  apiErrorMessage,
  closeShort,
  getIntake,
  getLabelSheet,
  listIntakeContainers,
  listIntakes,
  mintSerials,
  submitIntake,
  updateIntake,
  updateIntakeLot,
  voidIntake,
} from '../../api/ingredientDeskApi';
import '../Shared.css';
import './IngredientIntakesPage.css';

/**
 * Ingredient intakes — the desk side of receiving (SPEC §8.1-8.2, §5).
 *
 * One component serves both the list and the detail because they are one route
 * family and share the status vocabulary, the count formatting and the print
 * plumbing; `useParams()` picks which one renders.
 *
 * ── The count-unit rule ─────────────────────────────────────────────────────
 * Every count on this screen is rendered with an explicit container unit and
 * the word "cases" appears nowhere (§6.3, acceptance criterion §19.1). The
 * intake-level unit comes from the server's `count_unit`; per-lot counts use
 * `containerUnitLabel(lot.container_type, n)`. Neither is ever derived from
 * `Receipt.unit`, which is the column default that leaked "80 cases" onto
 * ingredient screens in the first place.
 */

const INTAKES_SEGMENT = '/ingredient-intakes';

const PAGE_SIZE = 50;

/** Statuses in which the intake is still editable (§8: "while open"). */
const OPEN_STATUSES = [INTAKE_STATUS.RECORDED, INTAKE_STATUS.SUBMITTED];

/** Roles the server accepts for voiding an intake that already has scans. */
const APPROVAL_ROLES = [
  ROLES.SUPERVISOR,
  ROLES.ADMIN,
  ROLES.CORPORATE_ADMIN,
  ROLES.SUPERADMIN,
];

const STATUS_BADGE = {
  [INTAKE_STATUS.RECORDED]: 'badge-info',
  [INTAKE_STATUS.SUBMITTED]: 'badge-warning',
  [INTAKE_STATUS.APPROVED]: 'badge-success',
  [INTAKE_STATUS.REJECTED]: 'badge-danger',
  [INTAKE_STATUS.VOIDED]: 'ing-badge--voided',
};

const STATUS_LABEL = {
  [INTAKE_STATUS.RECORDED]: 'Recorded',
  [INTAKE_STATUS.SUBMITTED]: 'Submitted',
  [INTAKE_STATUS.APPROVED]: 'Approved',
  [INTAKE_STATUS.REJECTED]: 'Rejected',
  [INTAKE_STATUS.VOIDED]: 'Voided',
};

/** `legacy_sweep` → "legacy sweep". Never compared against, only displayed, so
 *  a source the frontend has not heard of still renders sanely. */
const humanize = (value) =>
  String(value || '').replace(/_/g, ' ').trim() || '—';

/** Count + unit, always. `count_unit` is what the server sends ("barrels"). */
const countText = (count, unit) => `${count ?? 0} ${unit || containerUnitLabel(undefined, count)}`;

/** Per-lot counts derive their unit from the lot's own container type. */
const lotCountText = (count, containerType) =>
  `${count ?? 0} ${containerUnitLabel(containerType, count)}`;

/**
 * Where this route family is mounted. The app namespaces every page under a
 * role prefix (`/warehouse/…`, `/supervisor/…`, `/admin/…`), so links are
 * derived from the live pathname rather than hard-coded — the same component
 * then works under whichever prefixes the lead wires up.
 */
const basePathOf = (pathname) => {
  const index = pathname.indexOf(INTAKES_SEGMENT);
  return index >= 0
    ? pathname.slice(0, index + INTAKES_SEGMENT.length)
    : INTAKES_SEGMENT;
};

/** Sibling desk page under the same role prefix. `/warehouse/ingredient-intakes`
 *  → `/warehouse/ingredient-rows/labels`. */
const siblingPath = (basePath, segment) =>
  `${basePath.slice(0, basePath.length - INTAKES_SEGMENT.length)}${segment}`;

const ROW_LABELS_SEGMENT = '/ingredient-rows/labels';

const StatusPill = ({ status }) => (
  <span className={`badge ${STATUS_BADGE[status] || 'badge-info'}`}>
    {STATUS_LABEL[status] || humanize(status)}
  </span>
);

/** Short/over/damaged flags, shared by the list row and the detail header. */
const IntakeFlags = ({ intake }) => {
  const unit = intake.count_unit;
  return (
    <>
      {intake.short_count > 0 && (
        <span className="badge badge-warning">Short {countText(intake.short_count, unit)}</span>
      )}
      {intake.over_received && <span className="badge badge-warning">Over-received</span>}
      {intake.damaged_count > 0 && (
        <span className="badge badge-danger">{countText(intake.damaged_count, unit)} damaged</span>
      )}
    </>
  );
};

// ─── reason dialog ───────────────────────────────────────────────────────────

/**
 * A reason is required by the server on close-short and void, so it is captured
 * in a real dialog. `window.prompt` is banned here for the same reason
 * `window.confirm` is: it is unstyleable, unlabelled and blocks the tab.
 */
const ReasonDialog = ({ title, prompt, confirmLabel, busy, onConfirm, onCancel }) => {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();

  return (
    <Modal isOpen title={title} onClose={onCancel} size="md">
      <form
        className="ing-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed) onConfirm(trimmed);
        }}
      >
        <p className="muted">{prompt}</p>
        <label className="ing-lotline__field">
          <span>Reason <span className="required">*</span></span>
          <textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
            autoFocus
          />
        </label>
        <div className="form-actions">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={busy || !trimmed}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
};

// ─── mint dialog ─────────────────────────────────────────────────────────────

const MintDialog = ({ lot, busy, onConfirm, onCancel }) => {
  const remaining = Math.max(0, (lot.expected_count || 0) - (lot.minted_count || 0));
  const [count, setCount] = useState(() => String(remaining || 1));
  const parsed = Number(count);
  const valid = Number.isInteger(parsed) && parsed > 0;
  const overRun = valid && parsed > remaining;

  return (
    <Modal isOpen title="Mint serials" onClose={onCancel} size="md">
      <form
        className="ing-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onConfirm(parsed);
        }}
      >
        <p className="muted">
          <strong>{lot.product_name || 'Product'}</strong>
          {lot.vendor_lot ? ` · lot ${lot.vendor_lot}` : ''} — expecting{' '}
          {lotCountText(lot.expected_count, lot.container_type)}, {lot.minted_count || 0} already
          minted.
        </p>
        <label className="ing-lotline__field">
          <span>How many to mint <span className="required">*</span></span>
          <input
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            value={count}
            onChange={(e) => setCount(e.target.value)}
            disabled={busy}
            autoFocus
          />
        </label>
        {overRun && (
          <p className="ing-form__notice">
            That is more than the {lotCountText(remaining, lot.container_type)} still expected on
            this line. Allowed — an over-received truck (I-3) mints the extra serials here and the
            intake is flagged for approval.
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={busy || !valid}>
            {busy ? 'Minting…' : 'Mint & print'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

// ─── lot edit dialog (I-8) ───────────────────────────────────────────────────

const LotEditDialog = ({ lot, busy, onConfirm, onCancel }) => {
  const [form, setForm] = useState(() => ({
    vendor_lot: lot.vendor_lot || '',
    lot_unknown: Boolean(lot.lot_unknown),
    bbd: toCalendarKey(lot.bbd),
    expected_count: String(lot.expected_count ?? ''),
    brix: lot.brix === null || lot.brix === undefined ? '' : String(lot.brix),
    net_weight_per_container:
      lot.net_weight_per_container === null || lot.net_weight_per_container === undefined
        ? ''
        : String(lot.net_weight_per_container),
    weight_unit: lot.weight_unit || '',
  }));
  const [error, setError] = useState('');

  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));

  const handleSubmit = (e) => {
    e.preventDefault();
    const expected = Number(form.expected_count);
    if (!Number.isInteger(expected) || expected < 0) {
      setError('Expected count must be a whole number.');
      return;
    }
    if (!form.lot_unknown && !form.vendor_lot.trim()) {
      setError('Enter the vendor lot, or tick "Lot unknown".');
      return;
    }
    if (form.bbd && !toCalendarKey(form.bbd)) {
      setError('BBD is not a valid date.');
      return;
    }
    setError('');
    onConfirm({
      vendor_lot: form.lot_unknown ? null : form.vendor_lot.trim() || null,
      lot_unknown: form.lot_unknown,
      bbd: toCalendarKey(form.bbd) || null,
      expected_count: expected,
      brix: form.brix === '' ? null : Number(form.brix),
      net_weight_per_container:
        form.net_weight_per_container === '' ? null : Number(form.net_weight_per_container),
      weight_unit: form.weight_unit || null,
    });
  };

  return (
    <Modal isOpen title="Edit lot line" onClose={onCancel} size="lg">
      <form className="ing-form" onSubmit={handleSubmit}>
        <p className="ing-form__notice">
          Changing the vendor lot or BBD rewrites this line&apos;s container <strong>records</strong>,
          not the stickers already on the drums. Lookup is the source of truth, so a drum
          self-corrects the moment it is scanned (I-8) — never correct a lot by writing on a
          label. Reprint the stack below if the printed text also has to match.
        </p>

        <div className="ing-lotline__grid">
          <label className="ing-lotline__field">
            <span>Vendor lot</span>
            <input
              type="text"
              value={form.lot_unknown ? '' : form.vendor_lot}
              onChange={(e) => set({ vendor_lot: e.target.value })}
              disabled={busy || form.lot_unknown}
            />
          </label>

          <label className="ing-lotline__field ing-lotline__field--check">
            <input
              type="checkbox"
              checked={form.lot_unknown}
              onChange={(e) => set({ lot_unknown: e.target.checked })}
              disabled={busy}
            />
            <span>Lot unknown</span>
          </label>

          <label className="ing-lotline__field">
            <span>BBD</span>
            <input
              type="date"
              value={form.bbd}
              onChange={(e) => set({ bbd: e.target.value })}
              disabled={busy}
            />
          </label>

          <label className="ing-lotline__field">
            <span>Expected count</span>
            <input
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              value={form.expected_count}
              onChange={(e) => set({ expected_count: e.target.value })}
              disabled={busy}
            />
            <small className="muted">
              Counted in {containerUnitLabel(lot.container_type, 2)} (I-4: fix a wrong per-lot
              split here).
            </small>
          </label>

          <label className="ing-lotline__field">
            <span>Net weight / container</span>
            <input
              type="number"
              min="0"
              step="any"
              value={form.net_weight_per_container}
              onChange={(e) => set({ net_weight_per_container: e.target.value })}
              disabled={busy}
            />
          </label>

          <label className="ing-lotline__field">
            <span>Weight unit</span>
            <input
              type="text"
              value={form.weight_unit}
              onChange={(e) => set({ weight_unit: e.target.value })}
              disabled={busy}
            />
          </label>

          <label className="ing-lotline__field">
            <span>Brix</span>
            <input
              type="number"
              min="0"
              step="any"
              value={form.brix}
              onChange={(e) => set({ brix: e.target.value })}
              disabled={busy}
            />
          </label>
        </div>

        {error && <p className="ing-form__error">{error}</p>}

        <div className="form-actions">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? 'Saving…' : 'Save lot line'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

// ─── serial multi-picker (reprint scope=selection) ───────────────────────────

const SerialPickerDialog = ({ intakeId, busy, onPrint, onCancel }) => {
  const [query, setQuery] = useState('');
  const [containers, setContainers] = useState([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(() => new Set());

  // Search is served by the API rather than filtered in the browser: the list
  // is capped at MAX_CONTAINER_PAGE, so a client-side filter over one page
  // would silently hide matches on a big intake — a search box that lies.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const { data } = await listIntakeContainers({ intakeId, q: query.trim() });
        if (cancelled) return;
        setContainers(data?.items || []);
        setTotal(data?.total || 0);
        setTruncated(Boolean(data?.truncated));
        setError('');
      } catch (err) {
        if (cancelled) return;
        setError(apiErrorMessage(err, 'Failed to load containers.'));
        setContainers([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [intakeId, query]);

  const toggle = (serial) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(serial)) next.delete(serial);
      else next.add(serial);
      return next;
    });

  const allShownSelected =
    containers.length > 0 && containers.every((c) => selected.has(c.serial));

  const toggleAllShown = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      containers.forEach((c) => (allShownSelected ? next.delete(c.serial) : next.add(c.serial)));
      return next;
    });

  return (
    <Modal isOpen title="Reprint selected serials" onClose={onCancel} size="xl">
      <div className="ing-form">
        <label className="ing-lotline__field">
          <span>Search serials</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Part of a serial"
            disabled={busy}
          />
        </label>

        {truncated && (
          <p className="ing-form__notice ing-form__notice--warn">
            Showing the first {containers.length} of {total} containers on this intake. The rest
            are not on screen — narrow the search to reach them.
          </p>
        )}

        {error && <p className="ing-form__error">{error}</p>}

        <div className="ing-table-wrap">
          {loading ? (
            <p className="muted">Loading containers…</p>
          ) : containers.length === 0 ? (
            <p className="muted">
              No containers match. Serials only exist once a lot line has been minted.
            </p>
          ) : (
            <table className="simple-table">
              <thead>
                <tr>
                  <th scope="col" className="ing-check-col">
                    <input
                      type="checkbox"
                      checked={allShownSelected}
                      onChange={toggleAllShown}
                      aria-label="Select all shown serials"
                    />
                  </th>
                  <th scope="col">Serial</th>
                  <th scope="col">No.</th>
                  <th scope="col">Lot</th>
                  <th scope="col">Status</th>
                  <th scope="col">Location</th>
                </tr>
              </thead>
              <tbody>
                {containers.map((c) => (
                  <tr key={c.serial} className={selected.has(c.serial) ? 'is-selected' : undefined}>
                    <td className="ing-check-col">
                      <input
                        type="checkbox"
                        checked={selected.has(c.serial)}
                        onChange={() => toggle(c.serial)}
                        aria-label={`Select ${c.serial}`}
                      />
                    </td>
                    <td><code>{c.serial}</code></td>
                    <td>{c.sequence}</td>
                    <td>{c.vendor_lot || <span className="muted">unknown</span>}</td>
                    <td>
                      {humanize(c.status)}
                      {c.status === CONTAINER_STATUS.PRINTED_UNAPPLIED && (
                        <span className="muted small"> · not yet scanned</span>
                      )}
                    </td>
                    <td>{c.location_path || c.storage_row_name || <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="form-actions">
          <span className="muted small ing-form__actions-note">
            {selected.size} selected
          </span>
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => onPrint([...selected])}
            disabled={busy || selected.size === 0}
          >
            <Printer size={16} /> Print {selected.size || ''}
          </button>
        </div>
      </div>
    </Modal>
  );
};

// ─── header edit ─────────────────────────────────────────────────────────────

const HeaderEditForm = ({ intake, vendorOptions, busy, onSave, onCancel }) => {
  const initial = useMemo(
    () => ({
      vendor_id: intake.vendor_id || '',
      bol: intake.bol || '',
      purchase_order: intake.purchase_order || '',
      receipt_date: toDateKey(intake.receipt_date),
      notes: intake.notes || '',
    }),
    [intake],
  );
  const [form, setForm] = useState(initial);
  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));

  const handleSubmit = (e) => {
    e.preventDefault();
    // Only the fields the user actually touched are sent. The router applies
    // `exclude_unset`, so an untouched receipt_date is left as the stored
    // instant instead of being rewritten to midnight of the same day.
    const patch = {};
    Object.keys(initial).forEach((key) => {
      if (form[key] !== initial[key]) patch[key] = form[key] === '' ? null : form[key];
    });
    onSave(patch);
  };

  return (
    <form className="ing-form" onSubmit={handleSubmit}>
      <div className="ing-form__grid">
        <label className="ing-lotline__field">
          <span>Vendor</span>
          <SearchableSelect
            options={vendorOptions}
            value={form.vendor_id}
            onChange={(value) => set({ vendor_id: value })}
            placeholder="Select vendor"
            searchPlaceholder="Search vendors..."
            disabled={busy}
          />
        </label>
        <label className="ing-lotline__field">
          <span>BOL</span>
          <input type="text" value={form.bol} onChange={(e) => set({ bol: e.target.value })} disabled={busy} />
        </label>
        <label className="ing-lotline__field">
          <span>Purchase order</span>
          <input
            type="text"
            value={form.purchase_order}
            onChange={(e) => set({ purchase_order: e.target.value })}
            disabled={busy}
          />
        </label>
        <label className="ing-lotline__field">
          <span>Receipt date</span>
          <input
            type="date"
            value={form.receipt_date}
            onChange={(e) => set({ receipt_date: e.target.value })}
            disabled={busy}
          />
        </label>
        <label className="ing-lotline__field ing-lotline__field--wide">
          <span>Notes</span>
          <textarea rows={2} value={form.notes} onChange={(e) => set({ notes: e.target.value })} disabled={busy} />
        </label>
      </div>
      <div className="form-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? 'Saving…' : 'Save header'}
        </button>
      </div>
    </form>
  );
};

// ─── list ────────────────────────────────────────────────────────────────────

const IntakeList = ({ basePath }) => {
  const navigate = useNavigate();
  const { addToast } = useToast();

  const [status, setStatus] = useState('');
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  // Read inside `load` so appending a page does not have to put `items` in the
  // callback's deps — which would rebuild it on every fetch and re-fire the
  // effect below in a loop.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const load = useCallback(
    async ({ append = false } = {}) => {
      setLoading(true);
      try {
        const { data } = await listIntakes({
          status,
          skip: append ? itemsRef.current.length : 0,
          limit: PAGE_SIZE,
        });
        const page = data?.items || [];
        setItems((prev) => (append ? [...prev, ...page] : page));
        setTotal(data?.total || 0);
        setTruncated(Boolean(data?.truncated));
        setError('');
      } catch (err) {
        setError(apiErrorMessage(err, 'Failed to load intakes.'));
        if (!append) setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [status],
  );

  useEffect(() => {
    load();
  }, [load]);

  const statusChips = useMemo(
    () => [
      { value: '', label: 'All' },
      ...Object.values(INTAKE_STATUS).map((value) => ({
        value,
        label: STATUS_LABEL[value] || humanize(value),
      })),
    ],
    [],
  );

  const handleCreated = (intake) => {
    setCreating(false);
    if (intake?.id) navigate(`${basePath}/${intake.id}`);
    else load();
  };

  return (
    <div className="page-content ing-intakes">
      <header className="page-header">
        <div>
          <h1 className="page-title">Ingredient Intakes</h1>
          <p className="page-subtitle">
            Check a truck in from its BOL, mint and print drum labels, then track it through
            receiving.
          </p>
        </div>
        <div className="panel-actions">
          <Link className="secondary-button" to={siblingPath(basePath, ROW_LABELS_SEGMENT)}>
            <Tags size={16} /> Row labels
          </Link>
          <button type="button" className="secondary-button" onClick={() => load()} disabled={loading}>
            <RefreshCw size={16} /> Refresh
          </button>
          <button type="button" className="primary-button" onClick={() => setCreating(true)}>
            <Plus size={16} /> New check-in
          </button>
        </div>
      </header>

      <div className="ing-chips" role="group" aria-label="Filter by status">
        {statusChips.map((chip) => (
          <button
            key={chip.value || 'all'}
            type="button"
            className={`ing-chip${status === chip.value ? ' is-active' : ''}`}
            onClick={() => setStatus(chip.value)}
            aria-pressed={status === chip.value}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {error && <p className="ing-form__error">{error}</p>}

      <section className="panel">
        <div className="ing-table-wrap">
          <table className="simple-table">
            <thead>
              <tr>
                <th scope="col">Intake</th>
                <th scope="col">Vendor</th>
                <th scope="col">Received</th>
                <th scope="col">Status</th>
                <th scope="col">Scanned</th>
                <th scope="col">Flags</th>
              </tr>
            </thead>
            <tbody>
              {items.map((intake) => (
                <tr key={intake.id}>
                  <td>
                    <Link className="ing-link" to={`${basePath}/${intake.id}`}>
                      {intake.intake_number || intake.id}
                    </Link>
                    <div className="muted small">{humanize(intake.source)}</div>
                  </td>
                  <td>{intake.vendor_name || <span className="muted">—</span>}</td>
                  <td>{formatDate(intake.receipt_date)}</td>
                  <td><StatusPill status={intake.status} /></td>
                  <td>
                    {intake.scanned_count ?? 0}/{intake.expected_count ?? 0}{' '}
                    {intake.count_unit || containerUnitLabel(undefined, intake.expected_count)}
                  </td>
                  <td className="ing-flags"><IntakeFlags intake={intake} /></td>
                </tr>
              ))}
              {items.length === 0 && !loading && (
                <tr>
                  <td colSpan={6} className="muted">
                    No intakes {status ? `with status "${STATUS_LABEL[status] || humanize(status)}"` : 'yet'}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <footer className="ing-list__footer">
          {/* §18.9: a bounded list has to say what it dropped. */}
          <span className="muted small">
            {truncated
              ? `Showing ${items.length} of ${total} intakes`
              : `${items.length} intake${items.length === 1 ? '' : 's'}`}
          </span>
          {truncated && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => load({ append: true })}
              disabled={loading}
            >
              {loading ? 'Loading…' : 'Load more'}
            </button>
          )}
        </footer>
      </section>

      {creating && (
        <Modal isOpen title="New ingredient check-in" onClose={() => setCreating(false)} size="xxl">
          <IntakeCreateForm
            onCreated={handleCreated}
            onCancel={() => {
              setCreating(false);
              addToast('Check-in discarded.', 'info');
            }}
          />
        </Modal>
      )}
    </div>
  );
};

// ─── detail ──────────────────────────────────────────────────────────────────

const IntakeDetail = ({ intakeId, basePath }) => {
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const { user } = useAuth();
  const { vendors } = useAppData();

  const [intake, setIntake] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingHeader, setEditingHeader] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [printSheet, setPrintSheet] = useState(null);

  const vendorOptions = useMemo(
    () => (vendors || [])
      .filter((v) => v.active !== false)
      .map((v) => ({ value: v.id, label: String(v.name || 'Unnamed vendor') }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [vendors],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await getIntake(intakeId);
      setIntake(data);
      setError('');
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to load the intake.'));
      setIntake(null);
    } finally {
      setLoading(false);
    }
  }, [intakeId]);

  useEffect(() => {
    load();
  }, [load]);

  const isOpen = Boolean(intake) && OPEN_STATUSES.includes(intake.status);
  const canApprove = APPROVAL_ROLES.includes(user?.role);

  /** Fetch a LabelSheet and hand it to the hidden print root. */
  const runPrint = useCallback(
    async (params) => {
      setBusy(true);
      try {
        const { data } = await getLabelSheet(intakeId, params);
        if (!data?.labels?.length) {
          addToast('Nothing to print — no serials have been minted for that scope yet.', 'warning');
          return;
        }
        setPrintSheet(data);
      } catch (err) {
        addToast(apiErrorMessage(err, 'Failed to build the label sheet.'), 'error');
      } finally {
        setBusy(false);
      }
    },
    [intakeId, addToast],
  );

  const handleMint = async (lot, count) => {
    setBusy(true);
    try {
      const { data } = await mintSerials(intakeId, lot.id, count);
      setDialog(null);
      addToast(
        `Minted ${lotCountText(data?.labels?.length ?? count, lot.container_type)}.`,
        'success',
      );
      if (data?.labels?.length) setPrintSheet(data);
      await load();
    } catch (err) {
      addToast(apiErrorMessage(err, 'Failed to mint serials.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleAddLot = async (payload) => {
    setBusy(true);
    try {
      const { data } = await addIntakeLot(intakeId, payload);
      setIntake(data);
      setDialog(null);
      addToast('Lot line added.', 'success');
    } catch (err) {
      addToast(apiErrorMessage(err, 'Failed to add the lot line.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleEditLot = async (lotId, payload) => {
    setBusy(true);
    try {
      const { data } = await updateIntakeLot(intakeId, lotId, payload);
      setIntake(data);
      setDialog(null);
      addToast('Lot line updated. Container records were corrected; printed labels were not.', 'success');
    } catch (err) {
      addToast(apiErrorMessage(err, 'Failed to update the lot line.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleHeaderSave = async (patch) => {
    if (Object.keys(patch).length === 0) {
      setEditingHeader(false);
      return;
    }
    setBusy(true);
    try {
      const { data } = await updateIntake(intakeId, patch);
      setIntake(data);
      setEditingHeader(false);
      addToast('Intake header updated.', 'success');
    } catch (err) {
      addToast(apiErrorMessage(err, 'Failed to update the intake.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitIntake = async () => {
    const outstanding = (intake.expected_count || 0) - (intake.scanned_count || 0);
    const ok = await confirm(
      outstanding > 0
        ? `${countText(outstanding, intake.count_unit)} of this intake have not been scanned yet. `
          + 'Submit for approval anyway? Use "Received short" first if the truck was genuinely short.'
        : 'Submit this intake for approval?',
      { title: 'Submit intake', confirmLabel: 'Submit' },
    );
    if (!ok) return;
    setBusy(true);
    try {
      const { data } = await submitIntake(intakeId);
      setIntake(data);
      addToast('Intake submitted for approval.', 'success');
    } catch (err) {
      addToast(apiErrorMessage(err, 'Failed to submit the intake.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleCloseShort = async (reason) => {
    setBusy(true);
    try {
      const { data } = await closeShort(intakeId, reason);
      setIntake(data);
      setDialog(null);
      addToast('Short receipt recorded. Unapplied serials are still live.', 'success');
    } catch (err) {
      addToast(apiErrorMessage(err, 'Failed to record the short receipt.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleVoid = async (reason) => {
    setBusy(true);
    try {
      const { data } = await voidIntake(intakeId, reason);
      setIntake(data);
      setDialog(null);
      addToast('Intake voided. Its serials are burned and will not scan again.', 'success');
    } catch (err) {
      addToast(apiErrorMessage(err, 'Failed to void the intake.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (loading && !intake) {
    return (
      <div className="page-content">
        <p className="muted">Loading intake…</p>
      </div>
    );
  }

  if (!intake) {
    return (
      <div className="page-content">
        <Link className="back-button" to={basePath}>
          <ArrowLeft size={16} /> All intakes
        </Link>
        <p className="ing-form__error">{error || 'Intake not found.'}</p>
      </div>
    );
  }

  const unit = intake.count_unit;

  return (
    <div className="page-content ing-intake">
      <Link className="back-button" to={basePath}>
        <ArrowLeft size={16} /> All intakes
      </Link>

      <header className="page-header">
        <div>
          <h1 className="page-title">
            {intake.intake_number || intake.id} <StatusPill status={intake.status} />
          </h1>
          <p className="page-subtitle">
            {intake.vendor_name || 'No vendor'} · received {formatDate(intake.receipt_date)} ·{' '}
            {humanize(intake.source)}
          </p>
          <div className="ing-flags"><IntakeFlags intake={intake} /></div>
        </div>
        <div className="panel-actions">
          <button type="button" className="secondary-button" onClick={load} disabled={busy || loading}>
            <RefreshCw size={16} /> Refresh
          </button>
          {isOpen && !editingHeader && (
            <button type="button" className="secondary-button" onClick={() => setEditingHeader(true)}>
              <Pencil size={16} /> Edit header
            </button>
          )}
        </div>
      </header>

      {error && <p className="ing-form__error">{error}</p>}

      {/* ── header ───────────────────────────────────────────────────────── */}
      <section className="panel">
        <div className="panel-header"><h2>Check-in</h2></div>
        {editingHeader ? (
          <HeaderEditForm
            intake={intake}
            vendorOptions={vendorOptions}
            busy={busy}
            onSave={handleHeaderSave}
            onCancel={() => setEditingHeader(false)}
          />
        ) : (
          <dl className="ing-facts">
            <div><dt>Vendor</dt><dd>{intake.vendor_name || '—'}</dd></div>
            <div><dt>BOL</dt><dd>{intake.bol || '—'}</dd></div>
            <div><dt>Purchase order</dt><dd>{intake.purchase_order || '—'}</dd></div>
            <div><dt>Receipt date</dt><dd>{formatDate(intake.receipt_date)}</dd></div>
            <div><dt>Expected</dt><dd>{countText(intake.expected_count, unit)}</dd></div>
            <div><dt>Minted</dt><dd>{countText(intake.minted_count, unit)}</dd></div>
            <div><dt>Scanned</dt><dd>{countText(intake.scanned_count, unit)}</dd></div>
            <div><dt>Created</dt><dd>{formatDateTime(intake.created_at)}</dd></div>
            {intake.submitted_at && (
              <div><dt>Submitted</dt><dd>{formatDateTime(intake.submitted_at)}</dd></div>
            )}
            {intake.approved_at && (
              <div><dt>Approved</dt><dd>{formatDateTime(intake.approved_at)}</dd></div>
            )}
            {intake.notes && (
              <div className="ing-facts__wide"><dt>Notes</dt><dd>{intake.notes}</dd></div>
            )}
            {intake.short_reason && (
              <div className="ing-facts__wide"><dt>Short reason</dt><dd>{intake.short_reason}</dd></div>
            )}
            {intake.rejection_reason && (
              <div className="ing-facts__wide">
                <dt>Rejected</dt>
                <dd>
                  {formatDateTime(intake.rejected_at)} — {intake.rejection_reason}
                  {intake.rejection_disposition && ` (${humanize(intake.rejection_disposition)})`}
                </dd>
              </div>
            )}
            {intake.void_reason && (
              <div className="ing-facts__wide">
                <dt>Voided</dt>
                <dd>{formatDateTime(intake.voided_at)} — {intake.void_reason}</dd>
              </div>
            )}
          </dl>
        )}
      </section>

      {/* ── lot lines ────────────────────────────────────────────────────── */}
      <section className="panel">
        <div className="panel-header">
          <h2>Lot lines</h2>
          <div className="panel-actions">
            {isOpen && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => setDialog({ type: 'addLot' })}
                disabled={busy}
              >
                <Plus size={16} /> Add lot line
              </button>
            )}
            <button
              type="button"
              className="secondary-button"
              onClick={() => runPrint({ scope: LABEL_SCOPE.INTAKE })}
              disabled={busy}
            >
              <Printer size={16} /> Reprint whole intake
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setDialog({ type: 'serials' })}
              disabled={busy}
            >
              <Printer size={16} /> Reprint selected serials…
            </button>
          </div>
        </div>

        <div className="ing-table-wrap">
          <table className="simple-table">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Type</th>
                <th scope="col">Vendor lot</th>
                <th scope="col">BBD</th>
                <th scope="col">Expected</th>
                <th scope="col">Minted</th>
                <th scope="col">Scanned</th>
                <th scope="col">Net / container</th>
                <th scope="col">Brix</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(intake.lots || []).map((lot) => (
                <tr key={lot.id}>
                  <td>
                    {lot.product_name || lot.product_id}
                    {lot.product_sid && <div className="muted small">SID {lot.product_sid}</div>}
                  </td>
                  <td>{containerUnitLabel(lot.container_type, 1)}</td>
                  <td>
                    {lot.lot_unknown
                      ? <span className="badge badge-warning">Unknown</span>
                      : (lot.vendor_lot || <span className="muted">—</span>)}
                  </td>
                  <td>{lot.bbd ? formatCalendarDate(lot.bbd) : <span className="muted">—</span>}</td>
                  <td>{lotCountText(lot.expected_count, lot.container_type)}</td>
                  <td>{lotCountText(lot.minted_count, lot.container_type)}</td>
                  <td>{lotCountText(lot.scanned_count, lot.container_type)}</td>
                  <td>
                    {lot.net_weight_per_container
                      ? `${lot.net_weight_per_container} ${lot.weight_unit || ''}`.trim()
                      : <span className="muted">—</span>}
                  </td>
                  <td>{lot.brix ?? <span className="muted">—</span>}</td>
                  <td className="row-actions">
                    {isOpen && (
                      <button
                        type="button"
                        onClick={() => setDialog({ type: 'mint', lot })}
                        disabled={busy}
                      >
                        Mint
                      </button>
                    )}
                    {isOpen && (
                      <button
                        type="button"
                        onClick={() => setDialog({ type: 'editLot', lot })}
                        disabled={busy}
                      >
                        Edit
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => runPrint({ scope: LABEL_SCOPE.LOT, lotId: lot.id })}
                      disabled={busy}
                    >
                      Reprint
                    </button>
                  </td>
                </tr>
              ))}
              {(intake.lots || []).length === 0 && (
                <tr><td colSpan={10} className="muted">This intake has no lot lines.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── where the drums went ─────────────────────────────────────────── */}
      <section className="panel">
        <div className="panel-header"><h2>Row breakdown</h2></div>
        {(intake.row_breakdown || []).length === 0 ? (
          <p className="muted">
            Nothing scanned into a row yet. Rows are set by the forklift scanning a rack
            barcode during the unload — the desk never assigns one.
          </p>
        ) : (
          <div className="ing-table-wrap">
            <table className="simple-table">
              <thead>
                <tr>
                  <th scope="col">Row</th>
                  <th scope="col">Location</th>
                  <th scope="col">In row</th>
                </tr>
              </thead>
              <tbody>
                {intake.row_breakdown.map((row) => (
                  <tr key={row.storage_row_id}>
                    <td>{row.storage_row_name || row.storage_row_id}</td>
                    <td>{row.location_path || <span className="muted">—</span>}</td>
                    <td>{countText(row.count, unit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── lifecycle ────────────────────────────────────────────────────── */}
      <section className="panel">
        <div className="panel-header"><h2>Lifecycle</h2></div>
        <div className="ing-lifecycle">
          {intake.status === INTAKE_STATUS.RECORDED && (
            <>
              <button type="button" className="primary-button" onClick={handleSubmitIntake} disabled={busy}>
                Submit for approval
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setDialog({ type: 'short' })}
                disabled={busy}
              >
                Received short
              </button>
            </>
          )}
          {OPEN_STATUSES.includes(intake.status) && (
            <button
              type="button"
              className="secondary-button ing-danger"
              onClick={() => setDialog({ type: 'void' })}
              disabled={busy}
            >
              Void intake
            </button>
          )}
          {!OPEN_STATUSES.includes(intake.status) && (
            <p className="muted">
              This intake is {STATUS_LABEL[intake.status] || humanize(intake.status)} — no desk
              actions remain. Labels can still be reprinted at any time.
            </p>
          )}
        </div>
        {OPEN_STATUSES.includes(intake.status) && (
          <p className="muted small">
            Received short leaves unapplied serials live, so drums found in the trailer the next
            day still scan and the short count corrects itself (I-1/I-2). Voiding burns every
            serial on this intake — and an intake with scans can only be voided by a supervisor
            {canApprove ? '' : ', which your role is not'}.
          </p>
        )}
      </section>

      {/* ── dialogs ──────────────────────────────────────────────────────── */}
      {dialog?.type === 'mint' && (
        <MintDialog
          lot={dialog.lot}
          busy={busy}
          onConfirm={(count) => handleMint(dialog.lot, count)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.type === 'editLot' && (
        <LotEditDialog
          lot={dialog.lot}
          busy={busy}
          onConfirm={(payload) => handleEditLot(dialog.lot.id, payload)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.type === 'addLot' && (
        <Modal isOpen title="Add lot line" onClose={() => setDialog(null)} size="xl">
          <AddLotLineForm
            onSubmit={handleAddLot}
            onCancel={() => setDialog(null)}
            submitting={busy}
          />
        </Modal>
      )}
      {dialog?.type === 'serials' && (
        <SerialPickerDialog
          intakeId={intakeId}
          busy={busy}
          onPrint={(serials) => {
            setDialog(null);
            runPrint({ scope: LABEL_SCOPE.SELECTION, serials });
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.type === 'short' && (
        <ReasonDialog
          title="Received short"
          prompt={
            `Paperwork says ${countText(intake.expected_count, unit)}; `
            + `${countText(intake.scanned_count, unit)} have been scanned. `
            + 'Unapplied serials stay live, so a late-found drum still scans normally.'
          }
          confirmLabel="Record short receipt"
          busy={busy}
          onConfirm={handleCloseShort}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.type === 'void' && (
        <ReasonDialog
          title="Void intake"
          prompt={
            'Every serial on this intake is burned and will be rejected if it is ever scanned. '
            + 'Use this for a duplicate or wrong-product truck (I-5/I-6/I-10), not for a short load.'
          }
          confirmLabel="Void intake"
          busy={busy}
          onConfirm={handleVoid}
          onCancel={() => setDialog(null)}
        />
      )}

      {printSheet && (
        <IntakeLabelPrint sheet={printSheet} onDone={() => setPrintSheet(null)} />
      )}
    </div>
  );
};

// ─── route entry ─────────────────────────────────────────────────────────────

const IngredientIntakesPage = () => {
  const { intakeId } = useParams();
  const { pathname } = useLocation();
  const basePath = useMemo(() => basePathOf(pathname), [pathname]);

  return intakeId
    ? <IntakeDetail intakeId={intakeId} basePath={basePath} />
    : <IntakeList basePath={basePath} />;
};

export default IngredientIntakesPage;
