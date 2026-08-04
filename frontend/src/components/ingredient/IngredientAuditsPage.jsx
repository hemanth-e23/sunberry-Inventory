import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import { getDashboardPath } from '../../App';
import SearchableSelect from '../SearchableSelect';
import {
  apiErrorMessage,
  getBagReconciliation,
  getCacheDrift,
  getCutoverReconciliation,
  getRowDrift,
  getWeighOutVariance,
} from '../../api/ingredientCutoverApi';
import {
  CONTAINER_TYPE,
  ROLES,
  containerUnitLabel,
  isIngredientType,
} from '../../constants';
import '../Shared.css';

/**
 * Ingredient audit dashboards — SPEC §6.1, §8.1, §10.3, §10.5, §15.
 *
 * Four reconciliations that all share one rule: **nothing here heals anything.**
 * Every panel is a read of two independently-written records put side by side,
 * and a discrepancy is displayed rather than corrected. That is the explicit
 * lesson of `storage_rows.occupied_pallets`, FG `warehouse_id` drift and
 * `raw_material_row_allocations` — quietly recomputing a cache is how those
 * bugs stayed invisible for years (§6.1 / IMPL-COMMENT 1, §18.8 C-3).
 *
 * No dedicated stylesheet: the tables and cards here are exactly the ones
 * Shared.css and InventoryActionsPage.css already define (both imported
 * globally by App.jsx), and the handful of drift highlights are inline — the
 * same approach HoldsTab.jsx uses for its status cards.
 */

// Mirrors backend APPROVAL_ROLES. The cache-drift audit is the only panel here
// that is role-restricted server-side.
const AUDIT_ROLES = [
  ROLES.SUPERVISOR,
  ROLES.ADMIN,
  ROLES.SUPERADMIN,
  ROLES.CORPORATE_ADMIN,
];

const TABS = [
  { key: 'cutover', label: 'Cutover reconciliation' },
  { key: 'cache', label: 'Cache drift' },
  { key: 'rows', label: 'Rows & variance' },
  { key: 'bags', label: 'Bag reconciliation' },
];

// Weigh-out variance thresholds (§10.5). Shrink on an expensive powder shows up
// as a few percent, so the amber band is deliberately tight.
const VARIANCE_WARN_PCT = 2;
const VARIANCE_ALERT_PCT = 5;

const S = {
  page: {
    width: '100%',
    minHeight: '100vh',
    background: '#f5f7fb',
    padding: '24px',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
  },
  bannerBase: {
    borderRadius: '10px',
    padding: '12px 14px',
    fontSize: '14px',
    border: '1px solid transparent',
  },
  ok: { background: '#f0fdf4', borderColor: '#bbf7d0', color: '#14532d' },
  warn: { background: '#fffbeb', borderColor: '#fde68a', color: '#78350f' },
  danger: { background: '#fef2f2', borderColor: '#fecaca', color: '#991b1b' },
  info: { background: '#eff6ff', borderColor: '#dbeafe', color: '#1e3a8a' },
  driftRow: { background: '#fef2f2' },
  watchRow: { background: '#fffbeb' },
  numeric: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  toolbar: { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' },
  filter: { minWidth: '260px' },
};

const banner = (tone) => ({ ...S.bannerBase, ...S[tone] });

/** Numbers only — `Date.toLocaleString` is banned, this is a Number. */
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

const fmtPct = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
};

const fmtSigned = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${fmtQty(n)}`;
};

/**
 * One audit fetch: status, data, error, and a manual reload.
 *
 * `fetcher` must be stable (a module-level API function or a useCallback) —
 * an inline arrow would re-run the effect on every render.
 */
const useAuditPanel = (fetcher, enabled) => {
  const [state, setState] = useState({ loading: false, data: null, error: '', status: null });
  const seq = useRef(0);

  const load = useCallback(async () => {
    const current = ++seq.current;
    setState((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const { data } = await fetcher();
      if (current !== seq.current) return;
      setState({ loading: false, data, error: '', status: null });
    } catch (err) {
      if (current !== seq.current) return;
      setState({
        loading: false,
        data: null,
        error: apiErrorMessage(err, 'Could not run this audit.'),
        status: err?.response?.status ?? null,
      });
    }
  }, [fetcher]);

  useEffect(() => {
    if (enabled) load();
  }, [enabled, load]);

  return { ...state, reload: load };
};

const PanelShell = ({ title, description, panel, children, extraActions }) => (
  <section className="panel">
    <div className="panel-header">
      <div className="panel-title">
        <h3>{title}</h3>
      </div>
      <div className="panel-actions" style={S.toolbar}>
        {extraActions}
        <button type="button" className="secondary-button" onClick={panel.reload} disabled={panel.loading}>
          {panel.loading ? 'Running…' : 'Re-run'}
        </button>
      </div>
    </div>

    {description && <p className="muted small">{description}</p>}

    {panel.error && (
      <div style={banner('danger')}>
        {panel.status === 403
          ? `${panel.error} — this audit is restricted to supervisors and above.`
          : panel.error}
      </div>
    )}

    {panel.loading && !panel.data && <p className="muted small">Running…</p>}

    {/* A re-run keeps the previous result on screen rather than blanking the
        table — the operator is usually comparing before and after. */}
    {!panel.error && panel.data && children}
  </section>
);

// ─── Cutover reconciliation (§15.3, §18.8 C-3) ────────────────────────────────

/**
 * Classify one reconciliation row.
 *
 * The endpoint reports `legacy_remaining`, `serialized_remaining` and their sum;
 * it does NOT carry the pre-sweep expectation, so there is no arithmetic
 * "expected" to diff against. What CAN be judged from the row alone is the two
 * physically impossible shapes §18.8 C-3 names, plus the dual-mode state that is
 * legitimate but worth eyeballing.
 */
const classifyCutoverRow = (row) => {
  const legacy = Number(row.legacy_remaining || 0);
  const serialized = Number(row.serialized_remaining || 0);
  const combined = Number(row.combined || 0);
  const converted = Number(row.converted_containers || 0);

  if (legacy < 0 || serialized < 0) {
    return { tone: 'drift', note: 'Negative remaining — a write path oversubtracted.' };
  }
  if (converted > 0 && combined <= 0) {
    return {
      tone: 'drift',
      note: `${fmtCount(converted)} ${row.count_unit} still exist but nothing remains on the books.`,
    };
  }
  if (converted === 0 && legacy > 0) {
    return { tone: 'watch', note: 'Sweep intake exists but nothing was converted.' };
  }
  if (legacy > 0 && converted > 0) {
    return { tone: 'watch', note: 'Dual-mode: this lot is live in both systems.' };
  }
  return { tone: 'ok', note: '' };
};

const CutoverPanel = ({ enabled }) => {
  const panel = useAuditPanel(getCutoverReconciliation, enabled);
  // Memoized so the `|| []` fallback is not a fresh array on every render, which
  // would defeat the classification memo below.
  const rows = useMemo(() => panel.data?.rows || [], [panel.data]);

  const classified = useMemo(
    () => rows.map((row) => ({ row, verdict: classifyCutoverRow(row) })),
    [rows],
  );
  const driftCount = classified.filter((r) => r.verdict.tone === 'drift').length;

  return (
    <PanelShell
      title="Cutover reconciliation"
      description="Per swept lot: legacy remaining + serialized remaining = combined. Reported, never auto-healed — a discrepancy means a write path is wrong or material moved without being scanned, and correcting it here would hide that."
      panel={panel}
    >
      {rows.length === 0 ? (
        <div style={banner('info')}>No legacy lots have been swept yet.</div>
      ) : (
        <>
          <div style={banner(driftCount ? 'danger' : 'ok')}>
            {driftCount
              ? `${fmtCount(driftCount)} of ${fmtCount(rows.length)} swept lots do not add up — investigate before converting more.`
              : `${fmtCount(rows.length)} swept lots, all internally consistent.`}
          </div>

          <div className="table-wrapper">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>Intake</th>
                  <th>Lot</th>
                  <th style={S.numeric}>Legacy remaining</th>
                  <th style={S.numeric}>Serialized remaining</th>
                  <th style={S.numeric}>Combined</th>
                  <th style={S.numeric}>Converted</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {classified.map(({ row, verdict }) => (
                  <tr
                    key={row.receipt_id}
                    style={verdict.tone === 'drift' ? S.driftRow : verdict.tone === 'watch' ? S.watchRow : undefined}
                  >
                    <td>{row.intake_number || '—'}</td>
                    <td>{row.lot_number || 'UNKNOWN'}</td>
                    <td style={S.numeric}>{fmtQty(row.legacy_remaining)} {row.unit}</td>
                    <td style={S.numeric}>{fmtQty(row.serialized_remaining)} {row.unit}</td>
                    <td style={S.numeric}><strong>{fmtQty(row.combined)} {row.unit}</strong></td>
                    <td style={S.numeric}>
                      {fmtCount(row.converted_containers)} {row.count_unit}
                    </td>
                    <td>{verdict.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="muted small">
            Quantities are not totalled across rows: each lot carries its own unit and adding
            lbs to kg would invent a number. Highlighted rows are the two shapes §18.8 C-3
            names — negative remainders, and containers that exist with nothing left on the books.
          </p>
        </>
      )}
    </PanelShell>
  );
};

// ─── Cache drift (§6.1) ───────────────────────────────────────────────────────

const CacheDriftPanel = ({ enabled, allowed }) => {
  const fetcher = useCallback(() => getCacheDrift(500), []);
  const panel = useAuditPanel(fetcher, enabled && allowed);

  if (!allowed) {
    return (
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title"><h3>Cache drift</h3></div>
        </div>
        <div style={banner('warn')}>
          The container-state vs. ledger audit is restricted to supervisors and above.
        </div>
      </section>
    );
  }

  const rows = panel.data?.rows || [];
  const drifted = Number(panel.data?.drifted ?? 0);

  return (
    <PanelShell
      title="Cache drift — container state vs. its own ledger"
      description="containers.status / storage_row_id are the authoritative state; container_events is the audit trail written in the same transaction. They are two independently-written records, so a disagreement is a write-path bug, not routine drift. Nothing is recomputed or repaired here."
      panel={panel}
    >
      {drifted === 0 ? (
        <div style={banner('ok')}>
          <strong>Ledger and state agree.</strong>{' '}
          {fmtCount(panel.data?.checked)} containers checked, 0 drifted.
        </div>
      ) : (
        <>
          <div style={banner('danger')}>
            <strong>{fmtCount(drifted)} containers disagree with their own ledger.</strong>{' '}
            A non-empty result means a write path is wrong. Do not correct these by hand
            until the cause is known — the mismatch is the only evidence of it.
          </div>

          <div className="table-wrapper">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>Serial</th>
                  <th>Cached status</th>
                  <th>Ledger status</th>
                  <th>Cached row</th>
                  <th>Ledger row</th>
                  <th style={S.numeric}>Last event seq</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.container_id} style={S.driftRow}>
                    <td>{row.serial}</td>
                    <td>{row.cached_status || '—'}</td>
                    <td>{row.ledger_status || '—'}</td>
                    <td>{row.cached_row_id || '—'}</td>
                    <td>{row.ledger_row_id || '—'}</td>
                    <td style={S.numeric}>{fmtCount(row.last_event_seq)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className="muted small">
        {fmtCount(panel.data?.checked)} containers checked
        {panel.data?.truncated
          ? ' — TRUNCATED at the 500-container limit, so this is not the whole estate. Re-run after clearing what is listed.'
          : '.'}
      </p>
    </PanelShell>
  );
};

// ─── Row drift + weigh-out variance (§8.1, §10.5) ─────────────────────────────

const RowDriftPanel = ({ enabled }) => {
  const panel = useAuditPanel(getRowDrift, enabled);
  const rows = panel.data?.rows || [];

  return (
    <PanelShell
      title="Row drift — the walk-list"
      description="Rows holding more containers than their stated capacity. Capacity is a soft prompt at the point of work, never a block, so over-fill is accepted on the floor and surfaced here instead of stopping a forklift mid-unload. Rows with capacity 0 (no opinion) are excluded by design."
      panel={panel}
    >
      {rows.length === 0 ? (
        <div style={banner('ok')}>No row is over its stated capacity.</div>
      ) : (
        <div className="table-wrapper">
          <table className="simple-table">
            <thead>
              <tr>
                <th>Row</th>
                <th style={S.numeric}>Capacity</th>
                <th style={S.numeric}>Occupied</th>
                <th style={S.numeric}>Over by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.storage_row_id} style={S.watchRow}>
                  <td>{row.storage_row_name || row.storage_row_id}</td>
                  <td style={S.numeric}>{fmtCount(row.capacity)}</td>
                  <td style={S.numeric}>{fmtCount(row.occupied)} {row.count_unit}</td>
                  <td style={S.numeric}><strong>+{fmtCount(row.over_by)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PanelShell>
  );
};

const VariancePanel = ({ enabled, productOptions, productLookup }) => {
  const [productId, setProductId] = useState('');
  const fetcher = useCallback(
    () => getWeighOutVariance(productId || undefined),
    [productId],
  );
  const panel = useAuditPanel(fetcher, enabled);
  const rows = panel.data?.rows || [];

  const alerts = rows.filter(
    (r) => Math.abs(Number(r.variance_pct || 0)) >= VARIANCE_ALERT_PCT,
  ).length;

  return (
    <PanelShell
      title="Weigh-out variance"
      description="Per opened or emptied container: what the ledger says was drawn against the container's stated net weight. On expensive powders this is the shrink detector, and it is where every clamped over-draw surfaces. Sorted by absolute variance."
      panel={panel}
      extraActions={(
        <div style={S.filter}>
          <SearchableSelect
            options={productOptions}
            value={productId}
            onChange={setProductId}
            placeholder="All ingredient products"
            searchPlaceholder="Filter by product…"
            emptyLabel="All ingredient products"
          />
        </div>
      )}
    >
      {rows.length === 0 ? (
        <div style={banner('info')}>No opened or emptied containers to weigh out yet.</div>
      ) : (
        <>
          <div style={banner(alerts ? 'danger' : 'ok')}>
            {alerts
              ? `${fmtCount(alerts)} of ${fmtCount(rows.length)} containers are off by ${VARIANCE_ALERT_PCT}% or more.`
              : `${fmtCount(rows.length)} containers, none off by ${VARIANCE_ALERT_PCT}% or more.`}
          </div>

          <div className="table-wrapper">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>Serial</th>
                  <th>Product</th>
                  <th>Lot</th>
                  <th style={S.numeric}>Net</th>
                  <th style={S.numeric}>Drawn</th>
                  <th style={S.numeric}>Remaining</th>
                  <th style={S.numeric}>Variance</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const pct = Math.abs(Number(row.variance_pct || 0));
                  const rowStyle = pct >= VARIANCE_ALERT_PCT
                    ? S.driftRow
                    : pct >= VARIANCE_WARN_PCT
                      ? S.watchRow
                      : undefined;
                  return (
                    <tr key={row.serial} style={rowStyle}>
                      <td>{row.serial}</td>
                      <td>{productLookup[row.product_id]?.name || '—'}</td>
                      <td>{row.vendor_lot || 'UNKNOWN'}</td>
                      <td style={S.numeric}>{fmtQty(row.net_weight)} {row.qty_unit}</td>
                      <td style={S.numeric}>{fmtQty(row.total_drawn)} {row.qty_unit}</td>
                      <td style={S.numeric}>{fmtQty(row.remaining_qty)} {row.qty_unit}</td>
                      <td style={S.numeric}>
                        <strong>{fmtSigned(row.variance)}</strong> ({fmtPct(row.variance_pct)})
                      </td>
                      <td>{row.status}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="muted small">
            A positive variance means more was drawn than the drum was supposed to hold — the
            scale is the truth and a running batch is never stopped over a bookkeeping number,
            so the remainder clamps at zero and the difference lands here.
          </p>
        </>
      )}
    </PanelShell>
  );
};

// ─── Bag reconciliation (§10.3) ───────────────────────────────────────────────

const BagsPanel = ({ enabled }) => {
  const fetcher = useCallback(() => getBagReconciliation(), []);
  const panel = useAuditPanel(fetcher, enabled);
  const rows = panel.data?.rows || [];

  const brokenInvariant = rows.filter(
    (r) => Number(r.unapplied || 0) + Number(r.activated || 0) !== Number(r.minted || 0),
  ).length;
  const offExpected = rows.filter((r) => Number(r.variance_vs_expected || 0) !== 0).length;

  return (
    <PanelShell
      title="Bag reconciliation"
      description="Per bag lot line: unapplied + activated = minted. Activation moves a single row between two statuses, so this can only fail if something outside the activation path created or deleted containers — it is the one place a lost or duplicated sticker stack shows up."
      panel={panel}
    >
      {rows.length === 0 ? (
        <div style={banner('info')}>No bag lots have been minted yet.</div>
      ) : (
        <>
          <div style={banner(brokenInvariant ? 'danger' : 'ok')}>
            {brokenInvariant
              ? `${fmtCount(brokenInvariant)} lot lines break the unapplied + activated = minted invariant.`
              : 'unapplied + activated = minted holds on every lot line.'}
          </div>

          {offExpected > 0 && (
            <div style={banner('warn')}>
              {fmtCount(offExpected)} lot lines were minted at a different count than the intake
              expected — usually a short or over receipt that was never dispositioned.
            </div>
          )}

          <div className="table-wrapper">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>Lot</th>
                  <th style={S.numeric}>Unapplied</th>
                  <th style={S.numeric}>Activated</th>
                  <th style={S.numeric}>Minted</th>
                  <th style={S.numeric}>Expected</th>
                  <th style={S.numeric}>Variance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const sum = Number(row.unapplied || 0) + Number(row.activated || 0);
                  const broken = sum !== Number(row.minted || 0);
                  const off = Number(row.variance_vs_expected || 0) !== 0;
                  return (
                    <tr
                      key={row.intake_lot_id}
                      style={broken ? S.driftRow : off ? S.watchRow : undefined}
                    >
                      <td>{row.vendor_lot || 'UNKNOWN'}</td>
                      <td style={S.numeric}>
                        {fmtCount(row.unapplied)}{' '}
                        {containerUnitLabel(CONTAINER_TYPE.BAG, row.unapplied)}
                      </td>
                      <td style={S.numeric}>
                        {fmtCount(row.activated)}{' '}
                        {containerUnitLabel(CONTAINER_TYPE.BAG, row.activated)}
                      </td>
                      <td style={S.numeric}>
                        <strong>{fmtCount(row.minted)} {row.count_unit}</strong>
                      </td>
                      <td style={S.numeric}>{fmtCount(row.expected_count)}</td>
                      <td style={S.numeric}>
                        {Number(row.variance_vs_expected || 0) === 0
                          ? '—'
                          : <strong>{fmtSigned(row.variance_vs_expected)}</strong>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </PanelShell>
  );
};

// ─── Page ─────────────────────────────────────────────────────────────────────

const IngredientAuditsPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { products, categories } = useAppData();
  const [activeTab, setActiveTab] = useState('cutover');

  const canRunRestricted = AUDIT_ROLES.includes(user?.role);

  const categoryLookup = useMemo(() => {
    const map = {};
    categories.forEach((c) => { map[c.id] = c; });
    return map;
  }, [categories]);

  const productLookup = useMemo(() => {
    const map = {};
    products.forEach((p) => { map[p.id] = p; });
    return map;
  }, [products]);

  const productOptions = useMemo(
    () => products
      .filter((p) => isIngredientType(categoryLookup[p.categoryId]?.type))
      .map((p) => ({ value: p.id, label: String(p.name || 'Unknown') })),
    [products, categoryLookup],
  );

  return (
    <div style={S.page}>
      <div className="page-header">
        <button onClick={() => navigate(getDashboardPath(user?.role))} className="back-button">
          &larr; Back to Dashboard
        </button>
        <div className="header-content">
          <h2>Ingredient Audits</h2>
          <p className="muted">
            Four reconciliations over the serialized ingredient estate. Every one of them
            reports; none of them repairs.
          </p>
        </div>
      </div>

      <div className="tabs">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`tab-button ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="tab-panel">
        {activeTab === 'cutover' && <CutoverPanel enabled />}
        {activeTab === 'cache' && <CacheDriftPanel enabled allowed={canRunRestricted} />}
        {activeTab === 'rows' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <RowDriftPanel enabled />
            <VariancePanel enabled productOptions={productOptions} productLookup={productLookup} />
          </div>
        )}
        {activeTab === 'bags' && <BagsPanel enabled />}
      </div>
    </div>
  );
};

export default IngredientAuditsPage;
