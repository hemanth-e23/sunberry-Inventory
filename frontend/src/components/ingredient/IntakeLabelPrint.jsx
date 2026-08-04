import React, { useEffect, useRef } from 'react';
import { ContainerLabelSheet } from './ContainerLabel';
import './IngredientIntakesPage.css';

/**
 * Fires a batch label print for a `LabelSheet` payload — SPEC §5.
 *
 * Mount it with a sheet, it prints, it calls `onDone`. The parent clears its
 * sheet state in `onDone`, which unmounts this and takes the labels back out of
 * the DOM — so nothing here has to reset itself between jobs.
 *
 * ── Why a hidden print root plus a timeout ──────────────────────────────────
 * Idiom copied from `palletizer/PalletizerKioskPage.jsx:97-101`. `window.print()`
 * is synchronous and blocking: calling it in the same tick as the state update
 * prints the PREVIOUS DOM. The timeout lets React commit and the browser paint
 * first. 250ms matches the kiosk, which has been printing pallet tags on this
 * hardware for a year.
 *
 * The QR codes are safe to print on a timer because `ContainerLabel` renders
 * them synchronously as SVG paths — an 80-label batch has no pending canvases
 * to race (see the ContainerLabel header).
 *
 * ── Why a body class ────────────────────────────────────────────────────────
 * The print CSS has to blank the surrounding SPA chrome. `IngredientIntakesPage.css`
 * stays loaded for the rest of the session, so those rules are scoped to
 * `body.ingredient-label-print-mode` — an unscoped `body *` block would blank
 * every OTHER print in the app (pallet tags, BOL, ship-out docs). Same trap the
 * named `@page` in ContainerLabel.css:202-205 avoids.
 */

/** Kept in sync with the `body.ingredient-label-print-mode` rules in
 *  IngredientIntakesPage.css. */
const PRINT_MODE_CLASS = 'ingredient-label-print-mode';

const PRINT_DELAY_MS = 250;

const IntakeLabelPrint = ({ sheet, onDone }) => {
  // `onDone` is usually an inline arrow, so it is a new function every render.
  // Held in a ref so the print effect can keep an empty dep list and fire
  // exactly once per mount instead of re-arming on every parent render.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    document.body.classList.add(PRINT_MODE_CLASS);
    return () => document.body.classList.remove(PRINT_MODE_CLASS);
  }, []);

  useEffect(() => {
    if (!sheet) return undefined;
    const timer = setTimeout(() => {
      window.print();
      onDoneRef.current?.();
    }, PRINT_DELAY_MS);
    // Cleared on unmount — and in React StrictMode's double-invoke, which
    // would otherwise queue two prints.
    return () => clearTimeout(timer);
    // Keyed on the sheet, not []: a second reprint while this component is
    // still mounted replaces `sheet` without remounting, and an empty dep array
    // would leave the timer armed from the FIRST sheet — printing the old
    // stack, or nothing at all if that timer had already fired.
  }, [sheet]);

  const labels = sheet?.labels || [];

  return (
    <div className="ing-print-root" aria-hidden="true">
      {/* Lot ordering and the between-stack divider sheets are the sheet
          component's job (`groupContainersByLot`), so the server's
          `lot_boundaries` needs no handling here. `intake_total` rides on each
          label, which is what makes "17 of 80" correct on a partial reprint —
          the denominator must never come from the length of this array. */}
      <ContainerLabelSheet containers={labels} />
    </div>
  );
};

export default IntakeLabelPrint;
