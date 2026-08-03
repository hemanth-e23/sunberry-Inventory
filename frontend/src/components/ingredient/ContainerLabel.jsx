import React, { useMemo } from 'react';
import QRCode from 'qrcode';
import { toDateKey } from '../../utils/dateUtils';
import {
  encodeContainerPayload,
  formatCalendarDate,
  groupContainersByLot,
} from '../../utils/labelPayload';
import './ContainerLabel.css';

/**
 * Ingredient container label — SPEC §5. 4" × 6", one per physical barrel/bag,
 * printed at trailer receipt and applied to frozen drums.
 *
 * Differences from the finished-goods sticker
 * (`components/palletizer/PalletStickerLayout.jsx`), all deliberate:
 *
 *  1. EXACTLY ONE scannable code. The FG template carries a CODE128 barcode AND
 *     a QR; on a drum that is a mis-scan hazard (§5 retires it for ingredients).
 *  2. `errorCorrectionLevel: 'Q'` instead of the FG `'M'` (audit D12). Frozen
 *     drums mean abrasion, condensation and frost over the label; Q recovers
 *     ~25% damage vs M's ~15%.
 *  3. The QR is rendered as a vector `<path>` from the SYNCHRONOUS
 *     `QRCode.create()` rather than the async `QRCode.toCanvas()`. Two reasons:
 *     an 80-label batch print has no promise to wait on, so the caller can fire
 *     `window.print()` on the next frame without racing 80 canvases; and vector
 *     modules stay crisp on a direct-thermal printer where a 360px raster
 *     scaled to ~1.5in does not.
 *
 * Presentational only — no fetching, no routing, no print trigger. The caller
 * renders a `<ContainerLabelSheet>` into a hidden print root and calls
 * `window.print()` on a timeout once the DOM has painted (idiom:
 * `components/palletizer/PalletizerKioskPage.jsx:97-101`).
 *
 * ── Expected `container` shape ───────────────────────────────────────────────
 * A `Container` row plus display fields joined server-side. Read directly:
 *
 *   serial, sequence, vendor_lot, bbd, net_weight, qty_unit, container_type,
 *   intake_lot_id                       — Container columns
 *   product_name, product_sid           — from Product (`products.sid`, §4.3)
 *   vendor_name                         — from the intake's Vendor (§4.3: vendor
 *                                         is inherited from the intake)
 *   receipt_date                        — the intake's receipt date
 *   intake_total                        — container count on the intake, for
 *                                         "17 of 80"
 *   lot_unknown                         — IntakeLot flag; prints LOT UNKNOWN
 *
 * ASSUMED, not verified — these names come from the spec, not from a schema
 * file this agent owns. Aliases are accepted for each (see `readField`) and the
 * label degrades to "—" rather than crashing if a field is absent. `bbd` and
 * `vendor_lot` are denormalized onto `Container` itself, so they are the two
 * that are certain.
 */

// Divergence from the FG sticker's 'M' — see header note 2.
export const QR_ERROR_CORRECTION_LEVEL = 'Q';

// Quiet zone in QR modules, drawn inside the SVG. Deliberately smaller than the
// 4-module standard: the label stock is white and `.container-label__qr` adds
// ~0.1in of white padding, so the physical quiet zone is satisfied by the paper
// while every module stays as large as the box allows. Module size, not quiet
// zone, is what a handheld struggles with on a frosted drum.
const QR_QUIET_ZONE = 2;

const EMPTY = '—';

/** First non-empty value among a list of candidate keys. */
const readField = (source, keys) => {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return undefined;
};

/** Trailing-zero-free number for the NET line. `500`, not `500.0`. */
const formatQty = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return String(Number(n.toFixed(3)));
};

/**
 * QR module matrix → a single SVG path, horizontal runs merged.
 * Returns null on bad input so a broken payload blanks one code instead of
 * throwing out of render and killing the whole print stack.
 */
const buildQrPath = (value) => {
  if (!value) return null;
  try {
    const qr = QRCode.create(String(value), {
      errorCorrectionLevel: QR_ERROR_CORRECTION_LEVEL,
    });
    const { size, data } = qr.modules;
    let d = '';
    for (let y = 0; y < size; y += 1) {
      let x = 0;
      while (x < size) {
        if (!data[y * size + x]) {
          x += 1;
        } else {
          let run = 1;
          while (x + run < size && data[y * size + x + run]) run += 1;
          d += `M${x} ${y}h${run}v1h-${run}z`;
          x += run;
        }
      }
    }
    return { size, d };
  } catch {
    return null;
  }
};

const QrCode = ({ payload }) => {
  const qr = useMemo(() => buildQrPath(payload), [payload]);

  if (!qr) return <div className="container-label__qr-fallback" />;

  const span = qr.size + QR_QUIET_ZONE * 2;
  return (
    <svg
      className="container-label__qr-svg"
      viewBox={`0 0 ${span} ${span}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={payload}
    >
      <rect x="0" y="0" width={span} height={span} fill="#ffffff" />
      <g transform={`translate(${QR_QUIET_ZONE} ${QR_QUIET_ZONE})`}>
        <path d={qr.d} fill="#000000" />
      </g>
    </svg>
  );
};

/**
 * Serial as stretched SVG text so it always fills the label width and stays
 * readable at 6 feet (§5) whatever the serial's length. Idiom lifted from
 * `PalletStickerLayout.jsx:78-95`.
 */
const SerialText = ({ serial }) => {
  const text = (serial || EMPTY).toUpperCase();
  return (
    <svg
      className="container-label__serial-svg"
      viewBox="0 0 1000 150"
      width="100%"
      role="img"
      aria-label={text}
    >
      <text
        x="0"
        y="126"
        fontSize="150"
        fontWeight="900"
        textLength="1000"
        lengthAdjust="spacingAndGlyphs"
        fill="#000000"
      >
        {text}
      </text>
    </svg>
  );
};

const Field = ({ label, value }) => (
  <div className="container-label__field">
    <span className="container-label__field-label">{label}</span>
    <span className="container-label__field-value">{value || EMPTY}</span>
  </div>
);

const ContainerLabel = ({ container, totalCount }) => {
  const source = container || {};

  const serial = readField(source, ['serial']);
  const sequence = readField(source, ['sequence']);
  const productName = readField(source, ['product_name', 'productName']);
  const sid = readField(source, ['product_sid', 'sid', 'productSid']);
  const vendorName = readField(source, ['vendor_name', 'vendorName']);
  const vendorLot = readField(source, ['vendor_lot', 'vendorLot']);
  const lotUnknown = Boolean(readField(source, ['lot_unknown', 'lotUnknown']));
  const bbd = readField(source, ['bbd', 'best_by_date']);
  const netWeight = readField(source, ['net_weight', 'netWeight']);
  const qtyUnit = readField(source, ['qty_unit', 'weight_unit', 'qtyUnit']);
  const receiptDate = readField(source, ['receipt_date', 'intake_receipt_date', 'receiptDate']);

  // The payload never carries a lot the label does not print. A `lot_unknown`
  // line goes out with an empty lot segment even if a stale `vendor_lot` is
  // still hanging off the row, so the QR and the printed LOT line can never
  // disagree; production falls back to lookup, which is the source of truth
  // anyway. Built from the resolved locals rather than the raw object so the
  // memo keys on the four values that actually matter.
  const payload = useMemo(() => {
    try {
      return encodeContainerPayload({
        serial,
        vendor_lot: lotUnknown ? '' : vendorLot,
        bbd,
      });
    } catch {
      // A container with no serial cannot be labelled. Render the blank code
      // rather than throwing a whole batch print off the page.
      return '';
    }
  }, [serial, vendorLot, lotUnknown, bbd]);

  // A reprint stack is often a SUBSET of the intake, so the denominator has to
  // come from the intake — never from the length of the array being printed.
  // Missing denominator prints the bare number instead of a wrong "17 of 5".
  const total = Number(totalCount ?? readField(source, ['intake_total', 'intake_total_containers', 'total_count']));
  const seqLabel = sequence === undefined
    ? EMPTY
    : String(sequence);
  const sequenceLine = Number.isFinite(total) && total > 0
    ? `${seqLabel} of ${total}`
    : `NO. ${seqLabel}`;

  const netLine = netWeight === undefined
    ? ''
    : `${formatQty(netWeight)}${qtyUnit ? ` ${String(qtyUnit).toUpperCase()}` : ''}`;

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

      <SerialText serial={serial} />
      <div className="container-label__sequence">
        <span className="container-label__sequence-rule" />
        <span className="container-label__sequence-text">{sequenceLine}</span>
        <span className="container-label__sequence-rule" />
      </div>
      <div className="container-label__rule" />

      <div className="container-label__grid">
        <Field label="SID" value={sid} />
        <Field label="Vendor" value={vendorName} />
        <Field label="Lot" value={lotUnknown ? 'UNKNOWN' : vendorLot} />
        <Field label="BBD" value={formatCalendarDate(bbd)} />
        <Field label="Net" value={netLine} />
        {/* RCV is a real INSTANT (when the truck landed), so the timezone math
            must go through dateUtils — `toDateKey` resolves it to the warehouse
            calendar day. Only the presentation is local: `dateUtils.formatDate`
            renders `8/3/2026`, but §5 specifies `RCV 08/03/2026`, zero-padded to
            match the BBD sitting directly beside it in this grid. Two adjacent
            dates in different formats on a food-safety label is a misread
            waiting to happen. BBD above is a calendar date and never goes
            through dateUtils at all — see the labelPayload.js header. */}
        <Field label="RCV" value={formatCalendarDate(toDateKey(receiptDate))} />
      </div>
    </div>
  );
};

/**
 * A stack of labels for batch printing.
 *
 * Ordered into per-lot stacks (§5). A divider sheet prints BETWEEN stacks so a
 * worker cannot carry the boundary onto the wrong drum; a single-lot print gets
 * none. Each label and each divider is its own printed page — see the
 * `page-break-after` rules in ContainerLabel.css.
 */
export const ContainerLabelSheet = ({ containers, totalCount, showLotDividers = true }) => {
  const groups = useMemo(() => groupContainersByLot(containers), [containers]);

  return (
    <div className="container-label-sheet">
      {groups.map((group, index) => (
        <React.Fragment key={group.intakeLotId || '__no_lot__'}>
          {showLotDividers && index > 0 && (
            <div className="container-label container-label--divider">
              <div className="container-label__divider-heading">LOT BREAK</div>
              <div className="container-label__divider-lot">
                {(group.vendorLot || 'UNKNOWN LOT').toUpperCase()}
              </div>
              <div className="container-label__divider-count">
                {group.containers.length} label{group.containers.length === 1 ? '' : 's'} follow
              </div>
            </div>
          )}
          {group.containers.map((item) => (
            <ContainerLabel
              key={item.id || item.serial}
              container={item}
              totalCount={totalCount}
            />
          ))}
        </React.Fragment>
      ))}
    </div>
  );
};

export default ContainerLabel;
