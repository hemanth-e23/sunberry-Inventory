import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import JsBarcode from 'jsbarcode';
import apiClient from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { formatDate } from '../../utils/dateUtils';
import './RowLabelPrintPage.css';

/**
 * Rack row label sheet — SPEC §8.3, audit B9.
 *
 * Nothing in the app printed `storage_rows.barcode` before this page, so the
 * column added by alembic u6v7w8x9y0z1 existed with nothing physical to scan.
 * §18.2 R-3 blocks every drum scan until row resolution succeeds, which means a
 * barn with no printed rack labels cannot receive a truck at all. This page is
 * the thing that gets the codes onto the racks.
 *
 * ── Why CODE128 and not the drums' QR ───────────────────────────────────────
 * `ContainerLabel.jsx` deliberately carries exactly ONE code and makes it a QR
 * (§5). A rack label is the opposite problem and gets the opposite answer:
 *
 *   • Read distance is set by the code's smallest feature. Stretched across a
 *     ~7in label a CODE128 gets an X-dimension of roughly 40 mil; a QR sized to
 *     the same label is a grid of ~25 modules whose individual module is far
 *     smaller. The operator is seated on a forklift several feet back and is not
 *     going to dismount to line up a QR.
 *   • The gun is a keyboard wedge — `ScannerReceiptFlow.jsx` reads into a focused
 *     `<input>` (line 611-618), so whatever the hardware decodes is simply typed.
 *     Any imager capable of the drum QR reads CODE128 without configuration.
 *
 * ASSUMPTION worth confirming against the actual scanner fleet: that the guns
 * are 2D imagers (Zebra-class), not 1D-only lasers. If any are 1D-only they read
 * this label fine and the DRUM label is the one that breaks — which is a
 * ContainerLabel problem, not this one.
 *
 * ── Why the client filters the list but never resolves a scan ───────────────
 * The row picker below filters client-side on a substring. That is NOT the
 * defect `resolve_row` exists to kill. The banned thing is a SCAN silently
 * binding a drum to whichever row a fuzzy client match happened to hit
 * (`ScannerReceiptFlow.jsx:321-332`). Here a human reads a list and ticks a box,
 * and picking the wrong one prints a label they can see is wrong. Scan
 * resolution stays server-side in `GET /api/ingredient-rows/resolve`, which
 * refuses to guess.
 */

/** Print sheet geometry. Two labels per Letter portrait page, i.e. half-letter
 *  each. Deliberately low density — the brief is legibility from a forklift. */
const LABELS_PER_PAGE = 2;

const ALL_LOCATIONS = '__all__';

/** Natural sort so "A-2" precedes "A-10" rather than following it. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * CODE128 rendered into an SVG.
 *
 * JsBarcode is imperative, so this runs in a layout effect against a ref. It
 * already emits a viewBox (`renderers/svg.js:148`); what it does NOT emit is a
 * `preserveAspectRatio`, so the default `xMidYMid meet` letterboxes the code
 * inside the CSS box and a short barcode ends up floating in the middle of the
 * label at a fraction of the available width. Forcing `none` stretches it to the
 * full label width, which is the whole point: read distance is set by the
 * X-dimension, so the bars want every inch there is. The horizontal scale stays
 * uniform across all bars, and bar HEIGHT has no bearing on decoding.
 *
 * The width/height attributes are dropped so nothing downstream re-derives an
 * intrinsic size from them; CSS already wins the cascade, this is belt-and-braces.
 */
const RowBarcode = ({ value }) => {
  const ref = useRef(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = '';
    if (!value) return;
    try {
      JsBarcode(el, String(value), {
        format: 'CODE128',
        width: 3,
        height: 120,
        displayValue: false,
        margin: 0,
        background: '#ffffff',
        lineColor: '#000000',
      });
      el.setAttribute('preserveAspectRatio', 'none');
      el.removeAttribute('width');
      el.removeAttribute('height');
    } catch {
      // Unencodable string — leave the code blank rather than throwing out of
      // render and taking the whole sheet down.
      el.innerHTML = '';
    }
  }, [value]);

  return (
    <svg
      ref={ref}
      className="row-label__barcode"
      shapeRendering="crispEdges"
      role="img"
      aria-label={value ? `Barcode ${value}` : 'No barcode assigned'}
    />
  );
};

/**
 * One rack label. Three things only, in the order a forklift operator needs
 * them: the row name huge, the path that tells them which barn they are in, and
 * the code. The human-readable code repeats under the bars so a failed scan can
 * still be keyed in.
 */
const RowLabel = ({ row, printedOn }) => {
  const name = (row.name || '—').toUpperCase();
  const path = row.path || row.location_name || '';

  return (
    <section className="row-label">
      <div className="row-label__path">{path.toUpperCase()}</div>

      {/* Stretched SVG text so a 2-character and a 10-character row name both
          fill the label. Idiom from PalletStickerLayout.jsx:78-95. */}
      <div className="row-label__name-wrap">
        <svg
          className="row-label__name-svg"
          viewBox="0 0 1000 200"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`Row ${name}`}
        >
          <text
            x="500"
            y="168"
            textAnchor="middle"
            fontSize="200"
            fontWeight="900"
            fill="#000000"
            textLength={name.length > 5 ? 1000 : undefined}
            lengthAdjust="spacingAndGlyphs"
          >
            {name}
          </text>
        </svg>
      </div>

      <div className="row-label__code-block">
        {row.barcode ? (
          <>
            <RowBarcode value={row.barcode} />
            <div className="row-label__code-text">{row.barcode}</div>
          </>
        ) : (
          <div className="row-label__missing">NO BARCODE ASSIGNED</div>
        )}
      </div>

      <div className="row-label__footer">
        <span>{path}</span>
        <span>{printedOn}</span>
      </div>
    </section>
  );
};

const RowLabelPrintPage = () => {
  const { addToast } = useToast();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [assigning, setAssigning] = useState(false);

  const [query, setQuery] = useState('');
  const [locationId, setLocationId] = useState(ALL_LOCATIONS);
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  // Printing hides the rest of the SPA. The rules are scoped to a body class
  // rather than written as a bare `body *` block, because this stylesheet stays
  // loaded for the whole session and an unscoped rule would blank every OTHER
  // print in the app (pallet tags, BOL, ship-out docs). Same reasoning as the
  // named `@page` in ContainerLabel.css:202-205.
  useEffect(() => {
    document.body.classList.add('row-label-print-mode');
    return () => document.body.classList.remove('row-label-print-mode');
  }, []);

  const loadRows = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // Fetched unfiltered, once. The endpoint accepts q/location_id, but the
      // barn dropdown has to be built from the COMPLETE set or it would only
      // ever offer the barns matching the current search. Row counts are in the
      // hundreds, so the filtering below is instant and costs no round trips.
      const { data } = await apiClient.get('/ingredient-rows/');
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.response?.data?.detail || err.message || 'Failed to load storage rows.');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  const locationOptions = useMemo(() => {
    const seen = new Map();
    rows.forEach((row) => {
      if (row.location_id && !seen.has(row.location_id)) {
        seen.set(row.location_id, row.location_name || row.location_id);
      }
    });
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) =>
      collator.compare(a.name, b.name)
    );
  }, [rows]);

  const visibleRows = useMemo(() => {
    const needle = query.trim().toUpperCase();
    return rows
      .filter((row) => {
        if (locationId !== ALL_LOCATIONS && row.location_id !== locationId) return false;
        if (!needle) return true;
        return (
          (row.name || '').toUpperCase().includes(needle) ||
          (row.barcode || '').toUpperCase().includes(needle) ||
          (row.path || '').toUpperCase().includes(needle)
        );
      })
      .sort(
        (a, b) =>
          collator.compare(a.path || '', b.path || '') ||
          collator.compare(a.name || '', b.name || '')
      );
  }, [rows, query, locationId]);

  // Selection survives filtering — a user can tick rows in one barn, switch the
  // filter, tick more, and print both. Only rows still present in the fetched
  // set are ever printed.
  const selectedRows = useMemo(
    () => visibleRows.filter((row) => selectedIds.has(row.id)),
    [visibleRows, selectedIds]
  );

  const printableRows = useMemo(
    () => rows.filter((row) => selectedIds.has(row.id)),
    [rows, selectedIds]
  );

  const unlabelled = useMemo(
    () => printableRows.filter((row) => !row.barcode),
    [printableRows]
  );

  const allVisibleSelected =
    visibleRows.length > 0 && visibleRows.every((row) => selectedIds.has(row.id));

  const toggleRow = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleRows.forEach((row) => next.delete(row.id));
      else visibleRows.forEach((row) => next.add(row.id));
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const handleAssignBarcodes = async () => {
    if (unlabelled.length === 0) return;
    setAssigning(true);
    try {
      const { data } = await apiClient.post('/ingredient-rows/assign-barcodes', {
        row_ids: unlabelled.map((row) => row.id),
      });
      const assigned = data?.assigned_count ?? 0;
      const skipped = data?.skipped_count ?? 0;
      if (assigned > 0) {
        addToast(
          `Assigned ${assigned} barcode${assigned === 1 ? '' : 's'}.`,
          'success'
        );
      }
      if (skipped > 0) {
        // A row whose name has no letters or digits cannot be given a code that
        // means anything — say which ones rather than silently printing blanks.
        const names = (data.skipped || []).map((s) => s.name || s.id).join(', ');
        addToast(`${skipped} row(s) could not be labelled: ${names}`, 'warning');
      }
      await loadRows();
    } catch (err) {
      addToast(
        err.response?.data?.detail || err.message || 'Failed to assign barcodes.',
        'error'
      );
    } finally {
      setAssigning(false);
    }
  };

  const handlePrint = () => {
    if (printableRows.length === 0) return;
    window.print();
  };

  const printedOn = formatDate(new Date());
  const canPrint = printableRows.length > 0 && unlabelled.length === 0;

  return (
    <div className="row-label-page">
      <header className="row-label-page__header">
        <div>
          <h1>Row Barcode Labels</h1>
          <p className="row-label-page__subtitle">
            Print rack labels so the forklift can scan a row before receiving drums.
          </p>
        </div>
        <div className="row-label-page__actions">
          <button
            type="button"
            className="row-label-page__btn"
            onClick={loadRows}
            disabled={loading}
          >
            Refresh
          </button>
          <button
            type="button"
            className="row-label-page__btn row-label-page__btn--primary"
            onClick={handlePrint}
            disabled={!canPrint}
            title={
              printableRows.length === 0
                ? 'Select at least one row'
                : unlabelled.length > 0
                  ? 'Assign barcodes to the selected rows first'
                  : undefined
            }
          >
            Print {printableRows.length > 0 ? `(${printableRows.length})` : ''}
          </button>
        </div>
      </header>

      {error && <div className="row-label-page__error">{error}</div>}

      <section className="row-label-page__controls">
        <label className="row-label-page__field">
          <span>Barn / Location</span>
          <select
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
          >
            <option value={ALL_LOCATIONS}>All locations</option>
            {locationOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.name}
              </option>
            ))}
          </select>
        </label>

        <label className="row-label-page__field row-label-page__field--grow">
          <span>Search rows</span>
          <input
            type="text"
            value={query}
            placeholder="Row name or barcode"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        <div className="row-label-page__field-actions">
          <button type="button" className="row-label-page__btn" onClick={toggleAllVisible}>
            {allVisibleSelected ? 'Deselect all' : 'Select all'}
          </button>
          <button
            type="button"
            className="row-label-page__btn"
            onClick={clearSelection}
            disabled={selectedIds.size === 0}
          >
            Clear
          </button>
        </div>
      </section>

      {unlabelled.length > 0 && (
        <div className="row-label-page__warning">
          <span>
            {unlabelled.length} selected row{unlabelled.length === 1 ? ' has' : 's have'} no
            barcode. A label with no code is not scannable, so printing is blocked until
            they are assigned.
          </span>
          <button
            type="button"
            className="row-label-page__btn row-label-page__btn--primary"
            onClick={handleAssignBarcodes}
            disabled={assigning}
          >
            {assigning ? 'Assigning…' : 'Assign barcodes'}
          </button>
        </div>
      )}

      <section className="row-label-page__list">
        {loading ? (
          <p className="row-label-page__empty">Loading rows…</p>
        ) : visibleRows.length === 0 ? (
          <p className="row-label-page__empty">
            No rows match. Rows appear here regardless of pallet capacity, so an empty
            list means none exist in your warehouse yet.
          </p>
        ) : (
          <table className="row-label-page__table">
            <thead>
              <tr>
                <th scope="col" className="row-label-page__check-col">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    aria-label="Select all visible rows"
                  />
                </th>
                <th scope="col">Row</th>
                <th scope="col">Location</th>
                <th scope="col">Barcode</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr
                  key={row.id}
                  className={selectedIds.has(row.id) ? 'is-selected' : undefined}
                >
                  <td className="row-label-page__check-col">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(row.id)}
                      onChange={() => toggleRow(row.id)}
                      aria-label={`Select row ${row.name}`}
                    />
                  </td>
                  <td className="row-label-page__row-name">{row.name}</td>
                  <td>{row.path}</td>
                  <td>
                    {row.barcode ? (
                      <code className="row-label-page__code">{row.barcode}</code>
                    ) : (
                      <span className="row-label-page__none">not assigned</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="row-label-page__preview">
        <h2>
          Preview{' '}
          <span className="row-label-page__count">
            {printableRows.length} label{printableRows.length === 1 ? '' : 's'}
            {printableRows.length > 0 &&
              ` · ${Math.ceil(printableRows.length / LABELS_PER_PAGE)} page${
                Math.ceil(printableRows.length / LABELS_PER_PAGE) === 1 ? '' : 's'
              }`}
          </span>
        </h2>
        {printableRows.length === 0 ? (
          <p className="row-label-page__empty">
            Select rows above to preview their labels.
          </p>
        ) : (
          <div className="row-label-sheet">
            {printableRows.map((row) => (
              <RowLabel key={row.id} row={row} printedOn={printedOn} />
            ))}
          </div>
        )}
      </section>

      {/* Selection count is derived from the fetched set, not the filtered view,
          so this reassures the user that rows hidden by the current filter are
          still queued. */}
      {selectedRows.length !== printableRows.length && (
        <p className="row-label-page__hint">
          {printableRows.length - selectedRows.length} selected row(s) are hidden by the
          current filter and will still print.
        </p>
      )}
    </div>
  );
};

export default RowLabelPrintPage;
