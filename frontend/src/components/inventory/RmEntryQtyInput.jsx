import React from 'react';
import { overAskMessage, pluralizeUnit, singularUnit } from '../../utils/rowSources';

/**
 * Quantity box for one (lot x rack) entry on the RM Transfer / Adjustment
 * forms.
 *
 * - No `max` attribute: the browser's "Value must be less than or equal to 4"
 *   bubble said nothing about drums, pounds or why. An over-ask is shown
 *   inline instead, in words (browser test PART 2, U5); submit re-checks.
 * - Bags/boxes that ride a pallet get a "pallets" quick entry: N pallets
 *   fills N x units-per-pallet into the units box (U4). Loose units can still
 *   be typed directly.
 */
const RmEntryQtyInput = ({ entry, value, onChange, disabled }) => {
  const upp = Number(entry.unitsPerPallet) || 0;
  const unitWord = pluralizeUnit(singularUnit(entry.displayUnit || 'units'));
  const showPallets = !disabled && entry.isCounted && upp > 1;
  const units = Number(value || 0);
  // Show the pallet figure only when the units are a whole number of pallets;
  // anything else was typed as loose units.
  const palletValue = units > 0 && Number.isInteger(units / upp) ? String(units / upp) : '';
  const overAsk = disabled ? null : overAskMessage(entry, value);

  return (
    <>
      <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="number"
          min="0"
          step="any"
          disabled={disabled}
          value={disabled ? '' : value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0"
          aria-label={`${unitWord} to take`}
          aria-invalid={overAsk ? 'true' : undefined}
          style={{ flex: '1 1 6rem' }}
        />
        {showPallets && (
          <>
            <span className="muted small">{unitWord}, or</span>
            <input
              type="number"
              min="0"
              step="1"
              value={palletValue}
              onChange={(e) => {
                const n = e.target.value;
                onChange(n === '' ? '' : String(Math.max(0, Math.floor(Number(n) || 0)) * upp));
              }}
              placeholder="0"
              aria-label={`full pallets of ${upp} ${unitWord}`}
              style={{ flex: '0 1 5rem' }}
            />
            <span className="muted small">pallets of {upp}</span>
          </>
        )}
      </span>
      {overAsk && (
        <span className="form-error small" role="alert" style={{ display: 'block', marginTop: 4 }}>
          {overAsk}
        </span>
      )}
    </>
  );
};

export default RmEntryQtyInput;
