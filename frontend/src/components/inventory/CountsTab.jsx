import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ClipboardList, Package, Printer } from 'lucide-react';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../context/ConfirmContext';
import { formatDate } from '../../utils/dateUtils';
import Modal from '../Modal';
import LotLabelPrint from '../ingredient/LotLabelPrint';
import {
  apiErrorMessage, countRow, createOpeningBalance, getCutoverStatus,
  listLotsOnHand, listUnlabelledLots, previewZeroOut, printLotLabels, runZeroOut,
} from '../../api/lotReceivingApi';
import { listIngredientRows } from '../../api/ingredientIntakeApi';
import '../MasterDataPage.css';

/**
 * Counts — entering physical stock by hand, and the one-time cutover.
 *
 * Lives as a tab on Inventory Actions rather than as its own nav item. Counting
 * a rack IS an inventory action, and the ask was explicitly to adjust the
 * screens that exist rather than grow the sidebar.
 *
 * ── The cutover, in three steps ────────────────────────────────────────────
 *
 * **1. Zero out.** Old ingredient receipts KEEP their records — past batches
 * were consumed from them, and deleting the rows would empty the recall trace
 * for every pre-cutover batch — but their remaining quantity goes to zero.
 *
 * **2. Enter today's stock by hand.** One entry per (lot, rack). This is the
 * only honest way to do it: the pallet numbers in the old allocation JSON have
 * no fixed ratio to drums, and nothing anywhere recorded that a drum was opened.
 * The as-received count is shown as a HINT and never as a default — it is frozen
 * at delivery, so using it would restore stock production already consumed.
 *
 * **3. Sticker lazily.** Stock sits with a known count and no sticker. Stickers
 * go on at first staging, and on demand from the list below for a slow mover
 * that would otherwise sit unstickered for months. Nobody is asked to bring
 * every drum out of the barn for a stickering weekend.
 *
 * After the cutover this tab keeps its job: it is where a physical count is
 * recorded, which is the first flow in this system that can legitimately
 * INCREASE stock.
 */

const emptyEntry = () => ({
  product_id: '',
  // Only used in 'set' mode: a recount replaces ONE lot on ONE rack, so it has
  // to name which lot. An opening balance resolves the lot from the details.
  material_lot_id: '',
  vendor_id: '',
  vendor_lot: '',
  bbd: '',
  storage_row_id: '',
  full_units: '',
  unit_label: 'drum',
  weight_per_unit: '',
  weight_unit: 'lbs',
  open_units: '',
  open_remaining_qty: '',
});

const CountsTab = () => {
  const { products, vendors, categoryLookup } = useAppData();
  const { user } = useAuth();
  const { addToast } = useToast();
  const { confirm } = useConfirm();

  const [status, setStatus] = useState(null);
  const [preview, setPreview] = useState(null);
  const [unlabelled, setUnlabelled] = useState([]);
  const [countableLots, setCountableLots] = useState([]);
  const [rows, setRows] = useState([]);
  const [entry, setEntry] = useState(emptyEntry());
  const [busy, setBusy] = useState(false);
  const [showZeroOut, setShowZeroOut] = useState(false);
  const [sheet, setSheet] = useState(null);
  const [lastEntry, setLastEntry] = useState(null);
  // 'add' -> opening balance (ADDITIVE). 'set' -> physical count (ABSOLUTE).
  //
  // These are genuinely different operations and the difference is destructive
  // if you get it wrong. During the cutover you walk a barn and ADD what you
  // find, rack by rack; afterwards you RECOUNT a rack and the new figure
  // REPLACES the old one. Posting a recount to the additive endpoint doubles the
  // stock — the system says 40, the counter finds 40, and the rack becomes 80.
  const [mode, setMode] = useState('add');

  const canZeroOut = ['superadmin', 'admin', 'corporate_admin'].includes(user?.role);

  const ingredientProducts = useMemo(() => {
    const isIngredient = (p) => {
      const category = categoryLookup?.[p.categoryId || p.category_id];
      const type = category?.type;
      return type === 'ingredient' || type === 'raw' || type === 'raw-material';
    };
    return (products || []).filter(isIngredient);
  }, [products, categoryLookup]);

  const load = useCallback(async () => {
    try {
      const [s, u, l] = await Promise.all([
        getCutoverStatus(), listUnlabelledLots(), listLotsOnHand(),
      ]);
      setStatus(s);
      setUnlabelled(Array.isArray(u) ? u : []);
      setCountableLots(Array.isArray(l) ? l : []);
    } catch (error) {
      addToast(apiErrorMessage(error, 'Could not load count status'), 'error');
    }
  }, [addToast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let cancelled = false;
    listIngredientRows()
      .then((data) => { if (!cancelled) setRows(Array.isArray(data) ? data : []); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, []);

  const openZeroOut = async () => {
    setBusy(true);
    try {
      setPreview(await previewZeroOut());
      setShowZeroOut(true);
    } catch (error) {
      addToast(apiErrorMessage(error, 'Could not load the preview'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const doZeroOut = async () => {
    const ok = await confirm({
      title: 'Zero out ingredient receipts',
      message: `${preview?.receipt_count || 0} receipts will drop to zero and be marked depleted. `
        + 'The records are kept — nothing is deleted — but this cannot be undone by pressing '
        + 'something else. Only do it once every rack has been walked and is ready to be entered.',
      confirmText: 'Zero them out',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = await runZeroOut('Lot-model cutover');
      setShowZeroOut(false);
      addToast(`${result.zeroed} receipts zeroed`, 'success');
      await load();
    } catch (error) {
      addToast(apiErrorMessage(error, 'Could not run the zero-out'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const submitEntry = async () => {
    if (!entry.product_id || !entry.storage_row_id) {
      addToast('Product and rack are both needed.', 'error');
      return;
    }
    // A count of ZERO is meaningful in 'set' mode ("this rack is empty") and
    // meaningless in 'add' mode, so the guard differs by mode.
    if (mode === 'add' && !Number(entry.full_units)) {
      addToast('Enter how many are on the rack.', 'error');
      return;
    }

    if (mode === 'set') {
      if (!entry.material_lot_id) {
        addToast('Pick the lot you counted — a recount replaces one lot on one rack.', 'error');
        return;
      }
      setBusy(true);
      try {
        const result = await countRow({
          material_lot_id: entry.material_lot_id,
          storage_row_id: entry.storage_row_id,
          full_units: Number(entry.full_units) || 0,
          open_units: Number(entry.open_units) || 0,
          open_remaining_qty: Number(entry.open_remaining_qty) || 0,
          note: 'Physical count',
        });
        setLastEntry({ ...result, unit_label: result.unit_label, counted: true });
        addToast(
          result.variance === 0
            ? `${result.counted_units} ${result.unit_label}s — matches the system`
            : `${result.counted_units} counted, system said ${result.system_units}`
              + ` (${result.variance > 0 ? '+' : ''}${result.variance})`,
          result.variance === 0 ? 'success' : 'warning',
        );
        await load();
      } catch (error) {
        addToast(apiErrorMessage(error, 'Could not record that count'), 'error');
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    try {
      const { material_lot_id: _ignored, ...fields } = entry;
      const result = await createOpeningBalance({
        ...fields,
        full_units: Number(entry.full_units) || 0,
        open_units: Number(entry.open_units) || 0,
        open_remaining_qty: Number(entry.open_remaining_qty) || 0,
        weight_per_unit: entry.weight_per_unit === '' ? null : Number(entry.weight_per_unit),
        vendor_id: entry.vendor_id || null,
        bbd: entry.bbd || null,
      });
      setLastEntry(result);
      // Keep the product, vendor, lot and weight: the next entry is almost
      // always the SAME lot in the next rack along. Only the rack and the count
      // are cleared, which is the pair that actually changes as you walk a barn.
      setEntry((prev) => ({ ...prev, storage_row_id: '', full_units: '', open_units: '', open_remaining_qty: '' }));
      addToast(
        `${result.full_units} ${result.unit_label}s in ${result.storage_row_name} · ${result.lot_code}`,
        'success',
      );
      await load();
    } catch (error) {
      addToast(apiErrorMessage(error, 'Could not record that count'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const printFor = async (lot) => {
    setBusy(true);
    try {
      setSheet(await printLotLabels(lot.material_lot_id, lot.full_units + lot.open_units));
      await load();
    } catch (error) {
      addToast(apiErrorMessage(error, 'Could not print stickers'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tab-panel">
      {status && (
        <section className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <h2><ClipboardList size={18} /> Where the cutover is</h2>
              <span className="muted">
                {status.step === 'zero_out' && 'Step 1 — old receipts still hold stock.'}
                {status.step === 'opening_balances' && 'Step 2 — enter what is physically on the racks.'}
                {status.step === 'labelling' && 'Step 3 — stock is counted; stickers go on as material is used.'}
                {status.step === 'complete' && 'Done. This tab is now where physical counts get recorded.'}
              </span>
            </div>
            {canZeroOut && status.legacy_receipts_with_stock > 0 && (
              <button type="button" className="secondary-button" onClick={openZeroOut} disabled={busy}>
                Review zero-out
              </button>
            )}
          </div>
          <div className="muted" style={{ padding: '0 16px 12px' }}>
            {status.legacy_receipts_with_stock} legacy receipt
            {status.legacy_receipts_with_stock === 1 ? '' : 's'} still holding stock ·{' '}
            {status.counted_lots} lot{status.counted_lots === 1 ? '' : 's'} counted ·{' '}
            {status.lots_awaiting_labels} awaiting stickers
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <h2><Package size={18} /> Record a count</h2>
            <span className="muted">
              One entry per lot per rack. Count whole {entry.unit_label}s — pounds
              are worked out from them, never the other way round.
            </span>
          </div>
        </div>

        {/* ADD vs SET is not a preference, it is two different operations, and
            picking the wrong one is destructive. Walking a barn during the
            cutover ADDS what you find, rack by rack. Recounting a rack REPLACES
            what was recorded. Posting a recount to the additive path doubles the
            stock: the system says 40, the counter finds 40, the rack becomes 80. */}
        <div className="tabs" style={{ margin: '0 16px' }}>
          <button
            type="button"
            className={`tab-button ${mode === 'add' ? 'active' : ''}`}
            onClick={() => setMode('add')}
          >
            Add what I found
          </button>
          <button
            type="button"
            className={`tab-button ${mode === 'set' ? 'active' : ''}`}
            onClick={() => setMode('set')}
          >
            Recount a rack
          </button>
        </div>
        <p className="muted" style={{ padding: '8px 16px 0' }}>
          {mode === 'add'
            ? 'Adds to what is already recorded for this lot on this rack — the cutover pass.'
            : 'Replaces what is recorded for one lot on one rack, and shows the difference.'}
        </p>

        <div className="form-grid" style={{ padding: 16 }}>
          {mode === 'set' ? (
            <label style={{ gridColumn: '1 / -1' }}>
              <span>
                Which lot did you count?{' '}
                <span className="muted">a recount replaces one lot on one rack</span>
              </span>
              <select
                value={entry.material_lot_id}
                onChange={(e) => {
                  const lot = countableLots.find((l) => l.material_lot_id === e.target.value);
                  setEntry({
                    ...entry,
                    material_lot_id: e.target.value,
                    product_id: lot?.product_id || entry.product_id,
                    unit_label: lot?.unit_label || entry.unit_label,
                  });
                }}
              >
                <option value="">—</option>
                {countableLots.map((l) => (
                  <option key={l.material_lot_id} value={l.material_lot_id}>
                    {l.product_name} · {l.lot_unknown ? 'lot unknown' : l.vendor_lot}
                    {' · '}{l.lot_code}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              <span>Product</span>
              <select
                value={entry.product_id}
                onChange={(e) => setEntry({ ...entry, product_id: e.target.value })}
              >
                <option value="">—</option>
                {ingredientProducts.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
          )}
          <label style={mode === 'set' ? { display: 'none' } : undefined}>
            <span>Vendor</span>
            <select
              value={entry.vendor_id}
              onChange={(e) => setEntry({ ...entry, vendor_id: e.target.value })}
            >
              <option value="">—</option>
              {(vendors || []).map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </label>
          <label style={mode === 'set' ? { display: 'none' } : undefined}>
            <span>Vendor lot <span className="muted">printed on the drum</span></span>
            <input
              value={entry.vendor_lot}
              onChange={(e) => setEntry({ ...entry, vendor_lot: e.target.value })}
            />
          </label>
          <label style={mode === 'set' ? { display: 'none' } : undefined}>
            <span>BBD</span>
            <input
              type="date"
              value={entry.bbd}
              onChange={(e) => setEntry({ ...entry, bbd: e.target.value })}
            />
          </label>
          <label>
            <span>Rack</span>
            <select
              value={entry.storage_row_id}
              onChange={(e) => setEntry({ ...entry, storage_row_id: e.target.value })}
            >
              <option value="">—</option>
              {rows.map((r) => (
                <option key={r.id} value={r.id}>{r.name} · {r.path}</option>
              ))}
            </select>
          </label>
          <label style={mode === 'set' ? { display: 'none' } : undefined}>
            <span>Unit</span>
            <select
              value={entry.unit_label}
              onChange={(e) => setEntry({ ...entry, unit_label: e.target.value })}
            >
              <option value="drum">Drums</option>
              <option value="bag">Bags</option>
              <option value="tote">Totes</option>
              <option value="pail">Pails</option>
              <option value="box">Boxes</option>
            </select>
          </label>
          <label>
            <span>{mode === 'set' ? 'How many are actually there' : 'How many sealed'}</span>
            <input
              type="number"
              min="0"
              value={entry.full_units}
              onChange={(e) => setEntry({ ...entry, full_units: e.target.value })}
            />
          </label>
          <label style={mode === 'set' ? { display: 'none' } : undefined}>
            <span>Weight each <span className="muted">pounds come from this</span></span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={entry.weight_per_unit}
              onChange={(e) => setEntry({ ...entry, weight_per_unit: e.target.value })}
            />
          </label>
          {/* Opened units are counted separately and their remaining weight is a
              SUM across them — attributing it to one specific drum is exactly the
              per-item identity this model exists to avoid. */}
          <label>
            <span>Opened <span className="muted">partials, usually in a cooler</span></span>
            <input
              type="number"
              min="0"
              value={entry.open_units}
              onChange={(e) => setEntry({ ...entry, open_units: e.target.value })}
            />
          </label>
          <label>
            <span>Left in them <span className="muted">total across the opened ones</span></span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={entry.open_remaining_qty}
              onChange={(e) => setEntry({ ...entry, open_remaining_qty: e.target.value })}
              disabled={!Number(entry.open_units)}
            />
          </label>
        </div>

        <div style={{ padding: '0 16px 16px', display: 'flex', gap: 10, alignItems: 'center' }}>
          <button type="button" className="primary-button" onClick={submitEntry} disabled={busy}>
            {busy ? 'Saving…' : (mode === 'set' ? 'Record the count' : 'Add it')}
          </button>
          {lastEntry && (
            <span className="muted">
              {lastEntry.counted ? (
                <>
                  Counted {lastEntry.counted_units} {lastEntry.unit_label}s in{' '}
                  {lastEntry.storage_row_name} — system said {lastEntry.system_units}
                  {lastEntry.variance !== 0 && (
                    <strong style={{ color: '#b45309' }}>
                      {' '}({lastEntry.variance > 0 ? '+' : ''}{lastEntry.variance})
                    </strong>
                  )}
                </>
              ) : (
                <>
                  Last: {lastEntry.full_units} {lastEntry.unit_label}s in{' '}
                  {lastEntry.storage_row_name} ({lastEntry.derived_weight}{' '}
                  {lastEntry.weight_unit || ''}) · {lastEntry.lot_code}
                </>
              )}
            </span>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <h2><Printer size={18} /> Lots with no stickers yet</h2>
            <span className="muted">
              These shrink on their own as material is staged and stickered. Print
              here for a slow mover that would otherwise sit unstickered for months.
            </span>
          </div>
        </div>

        {unlabelled.length === 0 ? (
          <p className="muted" style={{ padding: '0 16px 16px' }}>
            Nothing waiting.
          </p>
        ) : (
          <div style={{ padding: '0 16px 16px' }}>
            {unlabelled.map((lot) => (
              <div
                key={lot.material_lot_id}
                style={{
                  display: 'flex', gap: 12, alignItems: 'center',
                  padding: '8px 0', borderTop: '1px solid #e5e7eb', flexWrap: 'wrap',
                }}
              >
                <div style={{ flex: 1, minWidth: 200 }}>
                  <strong>{lot.product_name}</strong>{' '}
                  <span className="muted">
                    {lot.lot_unknown ? 'lot unknown' : `lot ${lot.vendor_lot}`}
                    {lot.bbd ? ` · BBD ${formatDate(lot.bbd)}` : ''}
                    {lot.vendor_name ? ` · ${lot.vendor_name}` : ''}
                  </span>
                  {lot.needs_review && (
                    <div style={{ color: '#b45309', fontSize: '0.8rem' }}>
                      <AlertTriangle size={12} /> Flagged for review — no stickers
                      print until somebody resolves it.
                    </div>
                  )}
                </div>
                <span className="muted">
                  {lot.full_units} {lot.unit_label}
                  {lot.full_units === 1 ? '' : 's'} across {lot.row_count} rack
                  {lot.row_count === 1 ? '' : 's'}
                </span>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => printFor(lot)}
                  disabled={busy || lot.needs_review}
                >
                  Print {lot.full_units + lot.open_units}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <Modal
        isOpen={showZeroOut}
        onClose={() => setShowZeroOut(false)}
        title="Zero out ingredient receipts"
        size="lg"
      >
        {preview && (
          <div>
            <p>
              This is <strong>step 1 of the cutover</strong>. Every ingredient
              receipt below drops to zero and is marked depleted. The records are
              KEPT — past batches were consumed from them and deleting the rows
              would empty the recall trace for every pre-cutover batch.
            </p>
            <p className="muted">
              Only run it once the racks have been walked and you are ready to
              enter what is physically there. Raw material and packaging are not
              touched.
            </p>

            <div style={{ margin: '12px 0' }}>
              <strong>
                {preview.receipt_count} receipt{preview.receipt_count === 1 ? '' : 's'}
                {' · '}{preview.total_quantity} total
              </strong>
            </div>

            {preview.products.map((p) => (
              <div
                key={p.product_id}
                style={{
                  display: 'flex', justifyContent: 'space-between', gap: 12,
                  padding: '6px 0', borderTop: '1px solid #e5e7eb',
                }}
              >
                <span>{p.product_name}</span>
                <span className="muted">
                  {p.receipts} receipt{p.receipts === 1 ? '' : 's'} · {p.quantity} {p.unit || ''}
                  {/* A HINT, never a default. This is the count frozen at
                      delivery — using it as an opening balance would restore
                      stock production already consumed. */}
                  {p.as_received_units_hint > 0
                    && ` · ${p.as_received_units_hint} arrived originally`}
                </span>
              </div>
            ))}

            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button type="button" className="secondary-button" onClick={() => setShowZeroOut(false)}>
                Cancel
              </button>
              <button type="button" className="primary-button" onClick={doZeroOut} disabled={busy}>
                {busy ? 'Running…' : 'Zero them out'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {sheet && <LotLabelPrint sheet={sheet} onDone={() => setSheet(null)} />}
    </div>
  );
};

export default CountsTab;
