import React, { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useAppData } from '../../context/AppDataContext';
import { useToast } from '../../context/ToastContext';
import SearchableSelect from '../SearchableSelect';
import {
  CONTAINER_TYPE,
  containerUnitLabel,
  isIngredientType,
} from '../../constants';
import { getTodayDateKey } from '../../utils/dateUtils';
// BBD is a CALENDAR DATE, not an instant. `dateUtils.toDateKey` would shift a
// `2027-02-15T00:00:00Z` best-by-date to 2027-02-14 in any US warehouse
// timezone — the same trap labelPayload.js documents at length and the reason
// it owns a lexical calendar reader. Instants (receipt date) still go through
// dateUtils.
import { PAYLOAD_DELIMITER, toCalendarKey } from '../../utils/labelPayload';
import { apiErrorMessage, createIntake } from '../../api/ingredientDeskApi';
import './IngredientIntakesPage.css';

/**
 * Check-in from the BOL — SPEC §8 step 1.
 *
 * The desk types what the paperwork claims; nothing here is a physical count.
 * The truck being short (I-1), over (I-3) or split differently than the BOL
 * said (I-4) is all handled later on the detail screen, so this form
 * deliberately has no "are you sure" gates on the numbers.
 */

const WEIGHT_UNITS = ['lbs', 'kg'];

const CONTAINER_TYPE_OPTIONS = [
  { value: CONTAINER_TYPE.BARREL, label: 'Barrel' },
  { value: CONTAINER_TYPE.BAG, label: 'Bag' },
];

/** A blank lot line. Kept module-private; both consumers below build lines
 *  through the components in this file rather than passing shapes around. */
const blankLine = () => ({
  key: `line-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  product_id: '',
  container_type: CONTAINER_TYPE.BARREL,
  vendor_lot: '',
  lot_unknown: false,
  bbd: '',
  expected_count: '',
  brix: '',
  net_weight_per_container: '',
  weight_unit: WEIGHT_UNITS[0],
});

const isBlankNumber = (value) => value === '' || value === null || value === undefined;

/** First validation failure for one lot line, or `''`. */
const lotLineError = (line) => {
  if (!line.product_id) return 'Pick a product for every lot line.';

  const count = Number(line.expected_count);
  if (isBlankNumber(line.expected_count) || !Number.isInteger(count) || count < 1) {
    return 'Expected count must be a whole number of at least 1.';
  }

  const vendorLot = String(line.vendor_lot || '').trim();
  if (!line.lot_unknown && !vendorLot) {
    return 'Enter the vendor lot, or tick "Lot unknown".';
  }
  // Same guard the backend applies at intake. The 2D payload does not escape
  // its delimiter (labelPayload.js), so one pipe here would shift every field
  // on every sticker printed from this line.
  if (vendorLot.includes(PAYLOAD_DELIMITER)) {
    return `A vendor lot cannot contain "${PAYLOAD_DELIMITER}" — it is the label payload delimiter.`;
  }

  if (line.bbd && !toCalendarKey(line.bbd)) return 'BBD is not a valid date.';

  if (!isBlankNumber(line.brix) && !Number.isFinite(Number(line.brix))) {
    return 'Brix must be a number.';
  }
  if (
    !isBlankNumber(line.net_weight_per_container)
    && !(Number.isFinite(Number(line.net_weight_per_container))
      && Number(line.net_weight_per_container) > 0)
  ) {
    return 'Net weight per container must be a positive number.';
  }
  return '';
};

/** Form line → `IntakeLotCreate` body. `category_id` is omitted on purpose: the
 *  server takes it from the product, so the two can never disagree. */
const toLotPayload = (line) => {
  const vendorLot = String(line.vendor_lot || '').trim();
  return {
    product_id: line.product_id,
    container_type: line.container_type,
    vendor_lot: line.lot_unknown ? null : vendorLot || null,
    lot_unknown: Boolean(line.lot_unknown),
    bbd: toCalendarKey(line.bbd) || null,
    expected_count: Number(line.expected_count),
    brix: isBlankNumber(line.brix) ? null : Number(line.brix),
    net_weight_per_container: isBlankNumber(line.net_weight_per_container)
      ? null
      : Number(line.net_weight_per_container),
    weight_unit: line.weight_unit || null,
  };
};

/** Ingredient products, as SearchableSelect options. */
const useIngredientProductOptions = () => {
  const { products, categories } = useAppData();

  return useMemo(() => {
    const typeById = new Map((categories || []).map((c) => [c.id, c.type]));
    return (products || [])
      .filter((p) => p.active !== false && isIngredientType(typeById.get(p.categoryId)))
      .map((p) => ({
        value: p.id,
        label: p.sid ? `${p.name} · ${p.sid}` : String(p.name || 'Unnamed product'),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [products, categories]);
};

// ─── one lot line's fields ───────────────────────────────────────────────────

const LotLineFields = ({ line, productOptions, onChange, disabled }) => {
  const set = (patch) => onChange({ ...line, ...patch });
  const count = Number(line.expected_count);
  const unit = containerUnitLabel(
    line.container_type,
    Number.isFinite(count) ? count : 2,
  );

  return (
    <div className="ing-lotline__grid">
      <label className="ing-lotline__field ing-lotline__field--wide">
        <span>Product <span className="required">*</span></span>
        <SearchableSelect
          options={productOptions}
          value={line.product_id}
          onChange={(value) => set({ product_id: value })}
          placeholder="Select ingredient product"
          searchPlaceholder="Search ingredients..."
          disabled={disabled}
        />
      </label>

      <label className="ing-lotline__field">
        <span>Container type <span className="required">*</span></span>
        <select
          value={line.container_type}
          onChange={(e) => set({ container_type: e.target.value })}
          disabled={disabled}
        >
          {CONTAINER_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </label>

      <label className="ing-lotline__field">
        <span>Expected count <span className="required">*</span></span>
        <input
          type="number"
          min="1"
          step="1"
          inputMode="numeric"
          value={line.expected_count}
          onChange={(e) => set({ expected_count: e.target.value })}
          disabled={disabled}
        />
        <small className="muted">Counted in {unit} — never cases.</small>
      </label>

      <label className="ing-lotline__field">
        <span>Vendor lot {!line.lot_unknown && <span className="required">*</span>}</span>
        <input
          type="text"
          value={line.lot_unknown ? '' : line.vendor_lot}
          onChange={(e) => set({ vendor_lot: e.target.value })}
          placeholder={line.lot_unknown ? 'Unknown' : 'e.g. 389641'}
          disabled={disabled || line.lot_unknown}
        />
      </label>

      <label className="ing-lotline__field ing-lotline__field--check">
        <input
          type="checkbox"
          checked={Boolean(line.lot_unknown)}
          onChange={(e) => set({ lot_unknown: e.target.checked })}
          disabled={disabled}
        />
        <span>Lot unknown</span>
      </label>

      <label className="ing-lotline__field">
        <span>BBD</span>
        <input
          type="date"
          value={line.bbd || ''}
          onChange={(e) => set({ bbd: e.target.value })}
          disabled={disabled}
        />
      </label>

      <label className="ing-lotline__field">
        <span>Net weight / container</span>
        <input
          type="number"
          min="0"
          step="any"
          value={line.net_weight_per_container}
          onChange={(e) => set({ net_weight_per_container: e.target.value })}
          disabled={disabled}
        />
      </label>

      <label className="ing-lotline__field">
        <span>Weight unit</span>
        <select
          value={line.weight_unit || ''}
          onChange={(e) => set({ weight_unit: e.target.value })}
          disabled={disabled}
        >
          {WEIGHT_UNITS.map((u) => (
            <option key={u} value={u}>{u}</option>
          ))}
        </select>
      </label>

      <label className="ing-lotline__field">
        <span>Brix</span>
        <input
          type="number"
          min="0"
          step="any"
          value={line.brix}
          onChange={(e) => set({ brix: e.target.value })}
          disabled={disabled}
        />
      </label>
    </div>
  );
};

// ─── add-a-lot-line, for the detail screen (I-4) ─────────────────────────────

/**
 * Standalone lot-line editor used by the detail page when the per-lot split on
 * the BOL turns out to be wrong and a line has to be added to an open intake.
 * Shares this file's validation and payload shaping with the create form so the
 * two cannot drift.
 */
export const AddLotLineForm = ({ onSubmit, onCancel, submitting }) => {
  const productOptions = useIngredientProductOptions();
  const [line, setLine] = useState(blankLine);
  const [error, setError] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    const problem = lotLineError(line);
    if (problem) {
      setError(problem);
      return;
    }
    setError('');
    onSubmit(toLotPayload(line));
  };

  return (
    <form className="ing-form" onSubmit={handleSubmit}>
      {productOptions.length === 0 && (
        <p className="ing-form__notice ing-form__notice--warn">
          No products sit in an ingredient-type category, so there is nothing to add.
        </p>
      )}
      <LotLineFields
        line={line}
        productOptions={productOptions}
        onChange={setLine}
        disabled={submitting}
      />
      {error && <p className="ing-form__error">{error}</p>}
      <div className="form-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className="primary-button" disabled={submitting}>
          {submitting ? 'Adding…' : 'Add lot line'}
        </button>
      </div>
    </form>
  );
};

// ─── check-in ────────────────────────────────────────────────────────────────

const IntakeCreateForm = ({ onCreated, onCancel }) => {
  const { vendors } = useAppData();
  const { addToast } = useToast();
  const productOptions = useIngredientProductOptions();

  const [vendorId, setVendorId] = useState('');
  const [bol, setBol] = useState('');
  const [purchaseOrder, setPurchaseOrder] = useState('');
  const [receiptDate, setReceiptDate] = useState(() => getTodayDateKey());
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState(() => [blankLine()]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const vendorOptions = useMemo(
    () => (vendors || [])
      .filter((v) => v.active !== false)
      .map((v) => ({ value: v.id, label: String(v.name || 'Unnamed vendor') }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [vendors],
  );

  const expectedTotal = useMemo(
    () => lines.reduce((sum, line) => {
      const n = Number(line.expected_count);
      return sum + (Number.isFinite(n) && n > 0 ? n : 0);
    }, 0),
    [lines],
  );

  // The intake-level unit only makes sense when every line agrees; a mixed
  // truck falls back to the neutral word rather than picking a side.
  const totalUnit = useMemo(() => {
    const types = new Set(lines.map((l) => l.container_type));
    return containerUnitLabel(types.size === 1 ? [...types][0] : undefined, expectedTotal);
  }, [lines, expectedTotal]);

  const updateLine = (key, next) =>
    setLines((prev) => prev.map((line) => (line.key === key ? { ...next, key } : line)));

  const addLine = () => setLines((prev) => [...prev, blankLine()]);

  const removeLine = (key) =>
    setLines((prev) => (prev.length <= 1 ? prev : prev.filter((line) => line.key !== key)));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (lines.length === 0) {
      setError('An intake needs at least one lot line.');
      return;
    }
    for (let i = 0; i < lines.length; i += 1) {
      const problem = lotLineError(lines[i]);
      if (problem) {
        setError(`Lot line ${i + 1}: ${problem}`);
        return;
      }
    }
    setError('');
    setSubmitting(true);
    try {
      // `source` is omitted — the server defaults it to a truck receipt.
      // 'legacy_sweep' intakes are created by the cutover flow, never here.
      const { data } = await createIntake({
        vendor_id: vendorId || null,
        bol: bol.trim() || null,
        purchase_order: purchaseOrder.trim() || null,
        receipt_date: receiptDate || null,
        notes: notes.trim() || null,
        lots: lines.map(toLotPayload),
      });
      addToast(`Intake ${data?.intake_number || ''} created.`.trim(), 'success');
      onCreated?.(data);
    } catch (err) {
      const message = apiErrorMessage(err, 'Failed to create the intake.');
      setError(message);
      addToast(message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="ing-form" onSubmit={handleSubmit}>
      {productOptions.length === 0 && (
        <p className="ing-form__notice ing-form__notice--warn">
          No active products sit in an ingredient-type category, so no lot line can be
          saved. Add the products to an <strong>ingredient</strong> category in Master
          Data first — serialized intakes are ingredient-only by design.
        </p>
      )}

      <div className="ing-form__grid">
        <label className="ing-lotline__field">
          <span>Vendor</span>
          <SearchableSelect
            options={vendorOptions}
            value={vendorId}
            onChange={setVendorId}
            placeholder="Select vendor"
            searchPlaceholder="Search vendors..."
            disabled={submitting}
          />
        </label>

        <label className="ing-lotline__field">
          <span>BOL</span>
          <input
            type="text"
            value={bol}
            onChange={(e) => setBol(e.target.value)}
            placeholder="Bill of lading"
            disabled={submitting}
          />
        </label>

        <label className="ing-lotline__field">
          <span>Purchase order</span>
          <input
            type="text"
            value={purchaseOrder}
            onChange={(e) => setPurchaseOrder(e.target.value)}
            disabled={submitting}
          />
        </label>

        <label className="ing-lotline__field">
          <span>Receipt date</span>
          <input
            type="date"
            value={receiptDate}
            onChange={(e) => setReceiptDate(e.target.value)}
            disabled={submitting}
          />
        </label>

        <label className="ing-lotline__field ing-lotline__field--wide">
          <span>Notes</span>
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={submitting}
          />
        </label>
      </div>

      <div className="ing-form__section-head">
        <h3>Lot lines</h3>
        <span className="muted small">
          Expected total: <strong>{expectedTotal} {totalUnit}</strong>
        </span>
      </div>

      {lines.map((line, index) => (
        <section key={line.key} className="ing-lotline">
          <header className="ing-lotline__head">
            <span className="ing-lotline__index">Lot line {index + 1}</span>
            {lines.length > 1 && (
              <button
                type="button"
                className="ing-icon-button"
                onClick={() => removeLine(line.key)}
                disabled={submitting}
                aria-label={`Remove lot line ${index + 1}`}
              >
                <Trash2 size={16} />
              </button>
            )}
          </header>
          <LotLineFields
            line={line}
            productOptions={productOptions}
            onChange={(next) => updateLine(line.key, next)}
            disabled={submitting}
          />
        </section>
      ))}

      <button type="button" className="secondary-button" onClick={addLine} disabled={submitting}>
        <Plus size={16} /> Add lot line
      </button>

      {error && <p className="ing-form__error">{error}</p>}

      <div className="form-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className="primary-button" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create intake'}
        </button>
      </div>
    </form>
  );
};

export default IntakeCreateForm;
