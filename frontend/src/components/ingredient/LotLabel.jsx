import React, { useMemo } from 'react';
import { toDateKey } from '../../utils/dateUtils';
import { encodeLotPayload, formatCalendarDate } from '../../utils/labelPayload';
import { BigCodeText, LabelField, QrCode } from './ContainerLabel';
import './ContainerLabel.css';

/**
 * The lot sticker. 4" × 6", and EVERY unit of a lot wears an identical one.
 *
 * That is the whole design, and it is why this file is so much shorter than
 * `ContainerLabel.jsx`. There is no serial, no "17 of 80", no sequence, and no
 * print ordering problem — a reprint is trivially the same sticker again, where
 * the per-drum design needed a locked counter to guarantee it.
 *
 * Per-drum serials were tried and rejected for reasons that are physical, not
 * technical:
 *
 *  * At month end a count that disagrees by one drum forces "which serial do I
 *    remove?", which has no answer when the drums are interchangeable.
 *  * A third-party warehouse will not apply our stickers, and a great deal of
 *    material sits at one before it ever reaches a plant.
 *  * Material gets redirected between plants at short notice, so a serial minted
 *    at Plant A is meaningless at Plant B — and nobody can re-sticker a load at
 *    every stop.
 *
 * The QR carries `lot_code` and nothing else that a reader should trust.
 * Everything else on the sticker is human-readable context printed as text.
 * That is what stops a printed label from ever going stale: an approved BBD
 * extension moves `bbd_current` and the lot code still points at the right lot.
 *
 * Reuses `ContainerLabel.css` and the QR/text primitives from its sibling
 * deliberately — the physical problem is identical (a frosted drum in a freezer)
 * and two tunings of the same error-correction level would drift apart.
 *
 * Presentational only: no fetching, no routing, no print trigger. The caller
 * renders a `<LotLabelSheet>` into a hidden print root and calls
 * `window.print()` once the DOM has painted.
 */

const EMPTY = '—';

const readField = (source, keys) => {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return undefined;
};

/** "bag" -> "BAGS". The unit words are a fixed short list. */
const pluralUnit = (unit) => {
  const u = String(unit || 'unit').toUpperCase();
  return u.endsWith('S') ? u : `${u}S`;
};

const formatQty = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return String(Number(n.toFixed(3)));
};

const LotLabel = ({ label }) => {
  const source = label || {};

  const lotCode = readField(source, ['lot_code', 'lotCode']);
  const productName = readField(source, ['product_name', 'productName']);
  const sid = readField(source, ['product_sid', 'sid', 'productSid']);
  const vendorName = readField(source, ['vendor_name', 'vendorName']);
  const vendorLot = readField(source, ['vendor_lot', 'vendorLot']);
  const lotUnknown = Boolean(readField(source, ['lot_unknown', 'lotUnknown']));
  const bbd = readField(source, ['bbd', 'best_by_date']);
  const netWeight = readField(source, ['net_weight', 'netWeight', 'weight_per_unit']);
  const weightUnit = readField(source, ['weight_unit', 'qty_unit', 'weightUnit']);
  const unitLabel = readField(source, ['unit_label', 'unitLabel']);
  const packScope = readField(source, ['pack_scope', 'packScope']) || 'unit';
  const receiptDate = readField(source, ['receipt_date', 'receiptDate']);

  // The payload never carries a lot number the sticker does not print. A
  // `lot_unknown` line goes out with an empty lot segment even if a stale value
  // is hanging off the row, so the QR and the printed LOT line cannot disagree.
  const payload = useMemo(() => {
    try {
      return encodeLotPayload({
        lot_code: lotCode,
        vendor_lot: lotUnknown ? '' : vendorLot,
        bbd,
      });
    } catch {
      // A lot with no code cannot be labelled. Blank one code rather than
      // throwing a whole print run off the page.
      return '';
    }
  }, [lotCode, vendorLot, lotUnknown, bbd]);

  const netLine = netWeight === undefined
    ? ''
    : `${formatQty(netWeight)}${weightUnit ? ` ${String(weightUnit).toUpperCase()}` : ''}`;

  return (
    <div className="container-label">
      <div className="container-label__product">
        {String(productName || 'UNKNOWN PRODUCT').toUpperCase()}
      </div>
      <div className="container-label__rule" />

      <div className="container-label__qr">
        <QrCode payload={payload} />
      </div>
      <div className="container-label__rule" />

      {/* THE VENDOR'S OWN LOT NUMBER in the big slot — the one thing a person
          on a dock recognises, because it is what the manufacturer printed on
          the drum. The system's code is machine-only and appears small at the
          bottom; putting it here was the mistake that made a warehouse worker
          ask why we had invented a second lot number. */}
      <BigCodeText serial={lotUnknown ? 'LOT UNKNOWN' : vendorLot} />
      <div className="container-label__sequence">
        <span className="container-label__sequence-rule" />
        {/* THE ONE THING THAT DIFFERS between a pallet sticker and a unit
            sticker. Same lot, same code, same QR — scanning either resolves to
            the same material, because a bag does not become something else by
            coming off a pallet. This band exists so a person can see at a glance
            whether they hold one bag or a wrapped pallet of them.

            Deliberately NO COUNT on the pallet form. "PALLET · 50 BAGS" would
            start lying the moment somebody took one, and nobody re-labels a
            pallet per bag. The count lives in the system, where it can change.

            The word must never read "cases" — that is what a defaulted
            Receipt.unit produced on an 80-barrel receipt. */}
        <span className="container-label__sequence-text">
          {packScope === 'pallet'
            ? `PALLET OF ${pluralUnit(unitLabel)}`
            : String(unitLabel || 'UNIT').toUpperCase()}
        </span>
        <span className="container-label__sequence-rule" />
      </div>
      <div className="container-label__rule" />

      <div className="container-label__grid">
        {/* SID and BBD lead: after the lot number they are the two things
            anybody asks about. The lot number itself is no longer repeated here
            — it is the big text above. */}
        <LabelField label="SID" value={sid} />
        {/* The CURRENT best-by. An approved extension is the one case where
            stickers are reprinted and reapplied, and this date is the reason. */}
        <LabelField label="BBD" value={formatCalendarDate(bbd)} />
        <LabelField label="Vendor" value={vendorName} />
        <LabelField label="Net" value={netLine} />
        {/* RCV is a real INSTANT, so it goes through dateUtils to reach the
            warehouse calendar day, then prints zero-padded to match the BBD
            sitting beside it. Two adjacent dates in different formats on a
            food-safety label is a misread waiting to happen. */}
        <LabelField label="RCV" value={formatCalendarDate(toDateKey(receiptDate))} />
      </div>

      {/* The system's code, small. Nobody needs to read it — the QR carries it —
          but printing it costs nothing and answers "which lot is this really?"
          without a lookup when somebody is diagnosing a mis-scan. */}
      <div className="container-label__code">{lotCode}</div>
    </div>
  );
};

/**
 * A stack of identical stickers for batch printing.
 *
 * No lot dividers and no ordering: a sheet is one lot by construction, because
 * a print request is (lot, count). Each label is its own printed page — see the
 * `page-break-after` rules in ContainerLabel.css.
 */
export const LotLabelSheet = ({ sheet }) => {
  const labels = sheet?.labels || [];
  return (
    <div className="container-label-sheet">
      {labels.map((label, index) => (
        // Index as key is correct here and nowhere else: the labels ARE
        // identical, so there is no per-item identity to key on. That is the
        // model, not a shortcut.
        <LotLabel key={index} label={label} />
      ))}
    </div>
  );
};

export default LotLabel;
