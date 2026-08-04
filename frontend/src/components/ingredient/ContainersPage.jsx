// Container register — SPEC §7 (lifecycle), §13 (every exit is a recorded
// action), §14 (holds), §18.6.
//
// One filtered, server-paginated list over GET /ingredient-containers plus a
// detail drawer that re-fetches the single container before offering any
// action, so nobody holds or disposes of a drum off a stale row.
//
// Containers are deliberately NOT in AppDataContext (audit D11): one row per
// physical drum is high-cardinality, and every view of them is filtered.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../context/ConfirmContext';
import { getDashboardPath } from '../../App';
import SearchableSelect from '../SearchableSelect';
import LotHoldModal from './LotHoldModal';
import { formatDateTime } from '../../utils/dateUtils';
import { formatCalendarDate } from '../../utils/labelPayload';
import {
  CONTAINER_AVAILABLE_STATUSES,
  CONTAINER_STATUS,
  DISPOSAL_REASON,
  ROLES,
  containerUnitLabel,
  isIngredientType,
} from '../../constants';
import {
  CONTAINER_PAGE_SIZE,
  apiErrorMessage,
  damageContainer,
  disposeContainer,
  getContainer,
  listContainers,
  listIngredientRows,
  markContainerMissing,
  moveContainer,
  newIdempotencyKey,
  setContainerHold,
} from '../../api/ingredientContainerApi';
import './ContainersPage.css';

// Mirrors backend APPROVAL_ROLES (app/constants.py) — built from ROLES so the
// strings live in exactly one place.
const APPROVAL_ROLES = new Set([
  ROLES.ADMIN,
  ROLES.SUPERADMIN,
  ROLES.CORPORATE_ADMIN,
  ROLES.SUPERVISOR,
]);

const AVAILABLE_STATUSES = new Set(CONTAINER_AVAILABLE_STATUSES);

const STATUS_ORDER = [
  CONTAINER_STATUS.PRINTED_UNAPPLIED,
  CONTAINER_STATUS.RECEIVED,
  CONTAINER_STATUS.IN_STOCK,
  CONTAINER_STATUS.STAGED,
  CONTAINER_STATUS.OPENED,
  CONTAINER_STATUS.EMPTY,
  CONTAINER_STATUS.SHIPPED,
  CONTAINER_STATUS.DAMAGED,
  CONTAINER_STATUS.DISPOSED,
  CONTAINER_STATUS.RETURNED_TO_VENDOR,
  CONTAINER_STATUS.MISSING,
  CONTAINER_STATUS.VOIDED,
];

// Derived from the enum value itself — no second copy of the status strings.
const humanize = (value) =>
  String(value || '')
    .split('_')
    .filter(Boolean)
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');

const HELD_OPTIONS = [
  { value: '', label: 'Held: any' },
  { value: 'true', label: 'On hold only' },
  { value: 'false', label: 'Not held' },
];

const EMPTY_FILTERS = {
  q: '',
  product_id: '',
  status: '',
  storage_row_id: '',
  vendor_lot: '',
  is_held: '',
};

// Never "cases" (§19.1). Uniform lists get their real unit; a mixed page falls
// back to the generic label rather than guessing.
const unitForItems = (items, count) => {
  const types = new Set((items || []).map((item) => item.container_type).filter(Boolean));
  return containerUnitLabel(types.size === 1 ? [...types][0] : null, count);
};

const quantityText = (container) => {
  if (!container) return '—';
  const unit = container.qty_unit || '';
  if (container.remaining_qty !== null && container.remaining_qty !== undefined) {
    return `${container.remaining_qty}${unit ? ` ${unit}` : ''}`;
  }
  if (container.net_weight !== null && container.net_weight !== undefined) {
    return `${container.net_weight}${unit ? ` ${unit}` : ''}`;
  }
  return '—';
};

const ContainersPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const { products, productCategories } = useAppData();

  const canDispose = APPROVAL_ROLES.has(user?.role);

  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [skip, setSkip] = useState(0);

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [rows, setRows] = useState([]);
  const [rowsError, setRowsError] = useState(null);

  const [detailSerial, setDetailSerial] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);

  const [actionForm, setActionForm] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);

  const [lotHoldOpen, setLotHoldOpen] = useState(false);

  const [ingredientOnly, setIngredientOnly] = useState(true);

  // ── product picker options ──────────────────────────────────────────────────

  const categoryTypeById = useMemo(() => {
    const map = {};
    (productCategories || []).forEach((category) => { map[category.id] = category.type; });
    return map;
  }, [productCategories]);

  const ingredientProducts = useMemo(
    () => (products || []).filter((product) => isIngredientType(categoryTypeById[product.categoryId])),
    [products, categoryTypeById],
  );

  // If no category is typed 'ingredient' in this environment the filter would
  // hide every product, so it falls back to the full list instead of silently
  // showing nothing.
  const ingredientFilterUsable = ingredientProducts.length > 0;
  const productOptions = useMemo(() => {
    const source = ingredientOnly && ingredientFilterUsable ? ingredientProducts : (products || []);
    return [...source]
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
      .map((product) => ({
        value: product.id,
        label: product.sid ? `${product.name} · ${product.sid}` : product.name,
      }));
  }, [ingredientOnly, ingredientFilterUsable, ingredientProducts, products]);

  const rowOptions = useMemo(
    () => rows.map((row) => ({
      value: row.id,
      label: row.path ? `${row.name} — ${row.path}` : row.name,
    })),
    [rows],
  );

  // ── data loading ────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    listIngredientRows()
      .then((response) => {
        if (cancelled) return;
        setRows(Array.isArray(response?.data) ? response.data : []);
        setRowsError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setRowsError(apiErrorMessage(error, 'Failed to load storage rows'));
      });
    return () => { cancelled = true; };
  }, []);

  const fetchPage = useCallback(async () => {
    setLoading(true);
    const params = { skip, limit: CONTAINER_PAGE_SIZE };
    Object.entries(filters).forEach(([key, value]) => {
      if (value === '' || value === null || value === undefined) return;
      if (key === 'is_held') params.is_held = value === 'true';
      else params[key] = typeof value === 'string' ? value.trim() : value;
    });
    try {
      const response = await listContainers(params);
      const data = response?.data || {};
      setItems(Array.isArray(data.items) ? data.items : []);
      setTotal(Number(data.total) || 0);
      setTruncated(Boolean(data.truncated));
      setLoadError(null);
    } catch (error) {
      setLoadError(apiErrorMessage(error, 'Failed to load containers'));
      setItems([]);
      setTotal(0);
      setTruncated(false);
    } finally {
      setLoading(false);
    }
  }, [filters, skip]);

  // Debounced so typing a serial or a vendor lot does not fire a request per
  // keystroke; chip and select changes just pay the same small delay.
  useEffect(() => {
    const handle = setTimeout(() => { fetchPage(); }, 300);
    return () => clearTimeout(handle);
  }, [fetchPage]);

  // Re-runs the current query as-is (after a mutation, or a failed load).
  const refresh = fetchPage;

  const updateFilter = (key, value) => {
    setSkip(0);
    setFilters((previous) => ({ ...previous, [key]: value }));
  };

  const clearFilters = () => {
    setSkip(0);
    setFilters(EMPTY_FILTERS);
  };

  const activeFilterCount = useMemo(
    () => Object.entries(filters).filter(([, value]) => value !== '').length,
    [filters],
  );

  // ── detail drawer ───────────────────────────────────────────────────────────

  const loadDetail = useCallback(async (serial) => {
    setDetailLoading(true);
    try {
      const response = await getContainer(serial);
      setDetail(response?.data || null);
      setDetailError(null);
    } catch (error) {
      setDetail(null);
      setDetailError(apiErrorMessage(error, 'Failed to load container'));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!detailSerial) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    loadDetail(detailSerial);
  }, [detailSerial, loadDetail]);

  const closeDrawer = () => {
    setDetailSerial(null);
    setActionForm(null);
  };

  const openAction = (type) => {
    setActionForm({
      type,
      reason: '',
      rowId: '',
      reasonCode: DISPOSAL_REASON.DAMAGED,
    });
  };

  const patchAction = (patch) => setActionForm((previous) => ({ ...previous, ...patch }));

  const afterMutation = async (message, type = 'success') => {
    addToast(message, type);
    setActionForm(null);
    refresh();
    if (detailSerial) await loadDetail(detailSerial);
  };

  const submitAction = async () => {
    if (!actionForm || !detail) return;
    const { type, reason, rowId, reasonCode } = actionForm;
    const serial = detail.serial;
    const trimmedReason = reason.trim();

    if (type === 'hold' && !trimmedReason) {
      addToast('A hold needs a reason.', 'error');
      return;
    }
    if (type === 'move' && !rowId) {
      addToast('Pick the row the container is moving to.', 'error');
      return;
    }
    if (type === 'damage' && !trimmedReason) {
      addToast('Say what the damage is.', 'error');
      return;
    }
    if (type === 'missing' && !trimmedReason) {
      addToast('Say where it was expected and what was found.', 'error');
      return;
    }

    setActionBusy(true);
    try {
      if (type === 'hold' || type === 'release') {
        await setContainerHold({
          serial,
          held: type === 'hold',
          reason: trimmedReason || undefined,
        });
        await afterMutation(
          type === 'hold' ? `${serial} placed on hold` : `${serial} released from hold`,
        );
      } else if (type === 'move') {
        const response = await moveContainer({
          serial,
          to_row_id: rowId,
          reason: trimmedReason || undefined,
          idempotency_key: newIdempotencyKey(),
        });
        const data = response?.data || {};
        await afterMutation(data.message || `${serial} moved`);
        // A full row still ACCEPTS the container — this is an advisory, never a
        // failure (§8.1).
        if (data.warning) {
          addToast(data.warning_detail || humanize(data.warning), 'warning');
        }
        (data.notices || []).forEach((notice) => addToast(notice, 'warning'));
      } else if (type === 'damage') {
        await damageContainer({
          serial,
          reason: trimmedReason,
          quarantine_row_id: rowId || undefined,
        });
        await afterMutation(`${serial} marked damaged`);
      } else if (type === 'dispose') {
        const ok = await confirm(
          `Dispose of ${serial}? This is the one exit with no physical counterparty to reconcile against.`,
          { title: 'Dispose container', confirmLabel: 'Dispose' },
        );
        if (!ok) { setActionBusy(false); return; }
        await disposeContainer({
          serial,
          reason_code: reasonCode,
          reason: trimmedReason || undefined,
        });
        await afterMutation(`${serial} disposed`);
      } else if (type === 'missing') {
        await markContainerMissing({ serial, reason: trimmedReason });
        await afterMutation(`${serial} marked missing`);
      }
    } catch (error) {
      addToast(apiErrorMessage(error, 'Action failed'), 'error');
    } finally {
      setActionBusy(false);
    }
  };

  // ── render helpers ──────────────────────────────────────────────────────────

  const pageUnit = unitForItems(items, total);
  const shownFrom = total === 0 ? 0 : skip + 1;
  const shownTo = skip + items.length;

  const renderStatusChip = (status) => (
    <span
      className={`container-status-chip${AVAILABLE_STATUSES.has(status) ? ' is-available' : ''}`}
      data-status={status}
    >
      {humanize(status)}
    </span>
  );

  const renderActionForm = () => {
    if (!actionForm) return null;
    const { type, reason, rowId, reasonCode } = actionForm;
    const titles = {
      hold: 'Place on hold',
      release: 'Release from hold',
      move: 'Move to another row',
      damage: 'Mark damaged',
      dispose: 'Dispose',
      missing: 'Mark missing',
    };
    const reasonRequired = type !== 'release' && type !== 'dispose';

    return (
      <div className="containers-action-form">
        <h4>{titles[type]}</h4>

        {type === 'move' && (
          <label className="containers-field">
            <span>Destination row</span>
            <SearchableSelect
              options={rowOptions}
              value={rowId}
              onChange={(value) => patchAction({ rowId: value })}
              placeholder="Pick a row"
              emptyLabel="Pick a row"
              required
            />
          </label>
        )}

        {type === 'damage' && (
          <label className="containers-field">
            <span>Quarantine row (optional)</span>
            <SearchableSelect
              options={rowOptions}
              value={rowId}
              onChange={(value) => patchAction({ rowId: value })}
              placeholder="Leave where it is"
              emptyLabel="Leave where it is"
            />
          </label>
        )}

        {type === 'dispose' && (
          <label className="containers-field">
            <span>Reason code</span>
            <select
              value={reasonCode}
              onChange={(event) => patchAction({ reasonCode: event.target.value })}
            >
              {Object.values(DISPOSAL_REASON).map((code) => (
                <option key={code} value={code}>{humanize(code)}</option>
              ))}
            </select>
          </label>
        )}

        <label className="containers-field">
          <span>
            {type === 'release' ? 'Reason (optional)' : 'Reason'}
            {reasonRequired ? <span className="containers-required"> *</span> : null}
          </span>
          <textarea
            rows={3}
            value={reason}
            onChange={(event) => patchAction({ reason: event.target.value })}
            placeholder={
              type === 'missing'
                ? 'Where it should have been, and what was found there'
                : 'Why'
            }
          />
        </label>

        <div className="containers-action-buttons">
          <button
            type="button"
            className="secondary-button"
            onClick={() => setActionForm(null)}
            disabled={actionBusy}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`secondary-button${type === 'dispose' || type === 'damage' ? ' danger' : ''}`}
            onClick={submitAction}
            disabled={actionBusy}
          >
            {actionBusy ? 'Working…' : titles[type]}
          </button>
        </div>
      </div>
    );
  };

  const renderDrawer = () => {
    if (!detailSerial) return null;
    return (
      <>
        <div
          className="containers-drawer-overlay"
          role="presentation"
          onClick={closeDrawer}
        />
        <aside className="containers-drawer" aria-label="Container detail">
          <header className="containers-drawer-header">
            <div>
              <h3>{detailSerial}</h3>
              {detail?.product_name ? <p className="muted small">{detail.product_name}</p> : null}
            </div>
            <button type="button" className="containers-icon-button" onClick={closeDrawer} aria-label="Close">
              ×
            </button>
          </header>

          <div className="containers-drawer-body">
            {detailLoading && <p className="muted">Loading…</p>}
            {detailError && <p className="containers-error">{detailError}</p>}

            {detail && (
              <>
                <div className="containers-detail-badges">
                  {renderStatusChip(detail.status)}
                  {detail.is_held && <span className="containers-held-badge">On hold</span>}
                  {AVAILABLE_STATUSES.has(detail.status) && !detail.is_held && (
                    <span className="containers-ok-badge">Available</span>
                  )}
                </div>

                {detail.is_held && (
                  <div className="containers-callout containers-callout--warn">
                    <strong>Held</strong>
                    <div>{detail.hold_reason || 'No reason recorded.'}</div>
                    <div className="muted small">
                      Held containers are blocked from staging and production scans.
                    </div>
                  </div>
                )}

                {detail.consumed_by_batch_uid && (
                  <div className="containers-callout containers-callout--info">
                    <strong>Consumed into batch</strong>
                    <div className="containers-mono">{detail.consumed_by_batch_uid}</div>
                    <div className="muted small">
                      Look this batch up in production to trace where the material ended up.
                    </div>
                  </div>
                )}

                <dl className="containers-detail-grid">
                  <div>
                    <dt>Sequence</dt>
                    <dd>#{detail.sequence}</dd>
                  </div>
                  <div>
                    <dt>Type</dt>
                    <dd>{containerUnitLabel(detail.container_type, 1)}</dd>
                  </div>
                  <div>
                    <dt>Quantity</dt>
                    <dd>{quantityText(detail)}</dd>
                  </div>
                  <div>
                    <dt>Net weight</dt>
                    <dd>
                      {detail.net_weight !== null && detail.net_weight !== undefined
                        ? `${detail.net_weight}${detail.qty_unit ? ` ${detail.qty_unit}` : ''}`
                        : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>Vendor lot</dt>
                    <dd className="containers-mono">{detail.vendor_lot || '—'}</dd>
                  </div>
                  <div>
                    <dt>BBD</dt>
                    <dd>{detail.bbd ? formatCalendarDate(detail.bbd) : '—'}</dd>
                  </div>
                  <div className="containers-detail-wide">
                    <dt>Location</dt>
                    <dd>
                      {detail.storage_row_name
                        ? `${detail.storage_row_name}${detail.location_path ? ` — ${detail.location_path}` : ''}`
                        : 'Not placed'}
                    </dd>
                  </div>
                  <div>
                    <dt>Pallet group</dt>
                    <dd className="containers-mono">{detail.pallet_group_id || '—'}</dd>
                  </div>
                  <div>
                    <dt>Staged for</dt>
                    <dd className="containers-mono">{detail.staged_for_request_id || '—'}</dd>
                  </div>
                  <div>
                    <dt>Scanned in</dt>
                    <dd>{detail.scanned_at ? formatDateTime(detail.scanned_at) : '—'}</dd>
                  </div>
                  <div>
                    <dt>Opened</dt>
                    <dd>{detail.opened_at ? formatDateTime(detail.opened_at) : '—'}</dd>
                  </div>
                  <div>
                    <dt>Label printed</dt>
                    <dd>{detail.created_at ? formatDateTime(detail.created_at) : '—'}</dd>
                  </div>
                  <div className="containers-detail-wide">
                    <dt>Intake</dt>
                    <dd className="containers-mono">{detail.intake_id || '—'}</dd>
                  </div>
                </dl>

                {actionForm ? renderActionForm() : (
                  <div className="containers-drawer-actions">
                    {detail.is_held ? (
                      <button type="button" className="secondary-button" onClick={() => openAction('release')}>
                        Release hold
                      </button>
                    ) : (
                      <button type="button" className="secondary-button" onClick={() => openAction('hold')}>
                        Hold
                      </button>
                    )}
                    <button type="button" className="secondary-button" onClick={() => openAction('move')}>
                      Move
                    </button>
                    <button type="button" className="secondary-button" onClick={() => openAction('damage')}>
                      Damage
                    </button>
                    <button type="button" className="secondary-button" onClick={() => openAction('missing')}>
                      Mark missing
                    </button>
                    {canDispose && (
                      <button type="button" className="secondary-button danger" onClick={() => openAction('dispose')}>
                        Dispose
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </aside>
      </>
    );
  };

  return (
    <div className="containers-page">
      <div className="page-header">
        <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
          ← Back to Dashboard
        </button>
      </div>

      <div className="page-content">
        <section className="panel">
          <div className="panel-header horizontal">
            <div>
              <h2>Ingredient Containers</h2>
              <p className="muted">Every serialized barrel and bag, wherever it is.</p>
            </div>
            <div className="panel-actions">
              <button type="button" className="secondary-button" onClick={() => setLotHoldOpen(true)}>
                Lot hold / release…
              </button>
              <button type="button" className="secondary-button" onClick={refresh} disabled={loading}>
                Refresh
              </button>
            </div>
          </div>

          {rowsError && <p className="containers-error">{rowsError}</p>}

          <div className="containers-filters">
            <div className="containers-filter-row">
              <label className="containers-field">
                <span>Serial</span>
                <input
                  type="text"
                  value={filters.q}
                  onChange={(event) => updateFilter('q', event.target.value)}
                  placeholder="Serial contains…"
                />
              </label>
              <label className="containers-field">
                <span>Vendor lot</span>
                <input
                  type="text"
                  value={filters.vendor_lot}
                  onChange={(event) => updateFilter('vendor_lot', event.target.value)}
                  placeholder="Exact vendor lot"
                />
              </label>
              <label className="containers-field">
                <span>Product</span>
                <SearchableSelect
                  options={productOptions}
                  value={filters.product_id}
                  onChange={(value) => updateFilter('product_id', value)}
                  placeholder="Any product"
                  emptyLabel="Any product"
                />
              </label>
              <label className="containers-field">
                <span>Row</span>
                <SearchableSelect
                  options={rowOptions}
                  value={filters.storage_row_id}
                  onChange={(value) => updateFilter('storage_row_id', value)}
                  placeholder="Any row"
                  emptyLabel="Any row"
                />
              </label>
              <label className="containers-field containers-field--narrow">
                <span>Hold</span>
                <select
                  value={filters.is_held}
                  onChange={(event) => updateFilter('is_held', event.target.value)}
                >
                  {HELD_OPTIONS.map((option) => (
                    <option key={option.value || 'any'} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="containers-chip-row">
              <button
                type="button"
                className={`containers-chip${filters.status === '' ? ' is-active' : ''}`}
                onClick={() => updateFilter('status', '')}
              >
                All statuses
              </button>
              {STATUS_ORDER.map((status) => (
                <button
                  key={status}
                  type="button"
                  className={
                    `containers-chip${filters.status === status ? ' is-active' : ''}`
                    + `${AVAILABLE_STATUSES.has(status) ? ' is-available' : ''}`
                  }
                  onClick={() => updateFilter('status', status)}
                >
                  {humanize(status)}
                </button>
              ))}
            </div>

            <div className="containers-filter-meta">
              <label className="containers-inline-check">
                <input
                  type="checkbox"
                  checked={ingredientOnly && ingredientFilterUsable}
                  disabled={!ingredientFilterUsable}
                  onChange={(event) => setIngredientOnly(event.target.checked)}
                />
                <span>Ingredient products only</span>
              </label>
              {!ingredientFilterUsable && (
                <span className="muted small">
                  No product category is typed as an ingredient here — showing all products.
                </span>
              )}
              {activeFilterCount > 0 && (
                <button type="button" className="link-button" onClick={clearFilters}>
                  Clear {activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'}
                </button>
              )}
            </div>
          </div>

          <div className="containers-count-bar">
            <span>
              {loading
                ? 'Loading…'
                : `Showing ${shownFrom === 0 ? 0 : `${shownFrom}–${shownTo}`} of ${total} ${pageUnit}`}
            </span>
            {truncated && (
              <span className="containers-truncated">
                More match this filter than fit on one page — page through or narrow the filters.
              </span>
            )}
          </div>

          {loadError && (
            <div className="containers-error-block">
              <p>{loadError}</p>
              <button type="button" className="secondary-button" onClick={refresh}>Try again</button>
            </div>
          )}

          {!loadError && !loading && items.length === 0 && (
            <div className="empty-state" style={{ padding: '40px', textAlign: 'center' }}>
              <p>No containers match these filters.</p>
            </div>
          )}

          {!loadError && items.length > 0 && (
            <div className="table-wrapper">
              <table className="simple-table containers-table">
                <thead>
                  <tr>
                    <th>Serial</th>
                    <th>Product</th>
                    <th>Status</th>
                    <th>Vendor lot</th>
                    <th>BBD</th>
                    <th>Location</th>
                    <th>Qty</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((container) => (
                    <tr
                      key={container.id || container.serial}
                      className={container.is_held ? 'containers-row-held' : undefined}
                    >
                      <td className="containers-mono">
                        {container.serial}
                        {container.is_held && <span className="containers-held-badge">Hold</span>}
                      </td>
                      <td>
                        {container.product_name || '—'}
                        <div className="muted small">
                          {containerUnitLabel(container.container_type, 1)} #{container.sequence}
                        </div>
                      </td>
                      <td>{renderStatusChip(container.status)}</td>
                      <td className="containers-mono">{container.vendor_lot || '—'}</td>
                      <td>{container.bbd ? formatCalendarDate(container.bbd) : '—'}</td>
                      <td>
                        {container.storage_row_name || 'Not placed'}
                        {container.location_path && (
                          <div className="muted small">{container.location_path}</div>
                        )}
                      </td>
                      <td>{quantityText(container)}</td>
                      <td>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => setDetailSerial(container.serial)}
                        >
                          Details
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!loadError && total > CONTAINER_PAGE_SIZE && (
            <div className="containers-pager">
              <button
                type="button"
                className="secondary-button"
                disabled={skip === 0 || loading}
                onClick={() => setSkip(Math.max(0, skip - CONTAINER_PAGE_SIZE))}
              >
                ← Previous
              </button>
              <span className="muted small">
                Page {Math.floor(skip / CONTAINER_PAGE_SIZE) + 1} of{' '}
                {Math.max(1, Math.ceil(total / CONTAINER_PAGE_SIZE))}
              </span>
              <button
                type="button"
                className="secondary-button"
                disabled={shownTo >= total || loading}
                onClick={() => setSkip(skip + CONTAINER_PAGE_SIZE)}
              >
                Next →
              </button>
            </div>
          )}
        </section>
      </div>

      {renderDrawer()}

      <LotHoldModal
        open={lotHoldOpen}
        onClose={() => setLotHoldOpen(false)}
        onCompleted={refresh}
      />
    </div>
  );
};

export default ContainersPage;
