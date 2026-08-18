import React, { useEffect, useRef } from 'react';
import { LotLabelSheet } from './LotLabel';
import './IngredientIntakesPage.css';

/**
 * Fires a batch print of identical lot stickers.
 *
 * Mount it with a sheet, it prints, it calls `onDone`. The parent clears its
 * sheet state in `onDone`, which unmounts this and takes the labels back out of
 * the DOM — so nothing here has to reset itself between jobs.
 *
 * Three load-bearing tricks, all inherited from `IntakeLabelPrint` and all
 * learned the hard way:
 *
 * **A hidden print root plus a timeout.** `window.print()` is synchronous and
 * blocking, so calling it in the same tick as the state update prints the
 * PREVIOUS DOM. The timeout lets React commit and the browser paint first.
 * 250ms matches the palletizer kiosk, which has been printing pallet tags on
 * this hardware for a year. The QR codes are safe on a timer because `LotLabel`
 * renders them synchronously as SVG paths — a 40-sticker batch has no pending
 * canvases to race.
 *
 * **A body class.** The print CSS has to blank the surrounding SPA chrome, and
 * `IngredientIntakesPage.css` stays loaded for the rest of the session, so those
 * rules are scoped to `body.ingredient-label-print-mode`. An unscoped `body *`
 * block would blank every OTHER print in the app — pallet tags, BOL, ship-out
 * documents.
 *
 * **The effect is keyed on `sheet`, not `[]`.** A second print while this
 * component is still mounted replaces `sheet` without remounting, and an empty
 * dep array would leave the timer armed from the FIRST sheet — printing the old
 * stack, or nothing at all if that timer had already fired.
 */

/** Kept in sync with the `body.ingredient-label-print-mode` rules in
 *  IngredientIntakesPage.css. */
const PRINT_MODE_CLASS = 'ingredient-label-print-mode';

const PRINT_DELAY_MS = 250;

const LotLabelPrint = ({ sheet, onDone }) => {
  // `onDone` is usually an inline arrow, so it is a new function every render.
  // Held in a ref so the print effect can keep a stable dep list.
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
    // Cleared on unmount — and in React StrictMode's double-invoke, which would
    // otherwise queue two prints.
    return () => clearTimeout(timer);
  }, [sheet]);

  return (
    <div className="ing-print-root" aria-hidden="true">
      {/* No lot dividers and no ordering: a sheet is one lot by construction,
          because a print request is (lot, count). Every sticker on it is
          identical, which is the entire model. */}
      <LotLabelSheet sheet={sheet} />
    </div>
  );
};

export default LotLabelPrint;
