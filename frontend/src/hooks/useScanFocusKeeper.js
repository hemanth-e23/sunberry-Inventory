import { useEffect } from 'react';

// Keeps a keyboard-wedge gun's scan box focused (browser test F7).
//
// A gun "types" the sticker and presses Enter into whatever has focus. When
// nothing does — the page just loaded, a button was tapped, a card re-rendered —
// the scan goes nowhere and the worker sees nothing at all. Three guards:
//   * focus the box whenever the hook is (re-)enabled
//   * a focusout that leaves focus on <body> puts it back
//   * a printable key landing OUTSIDE any text field moves focus to the box
//     first, so that keystroke and the rest of the scan land in it. Focusing in
//     keydown is enough: the browser delivers the character to the newly
//     focused input. Enter alone is left alone so a focused button still works.

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'number', 'tel', 'email', 'password', 'url']);

/** True for elements that take typed text themselves — never steal from them. */
export const takesText = (el) => {
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag !== 'input') return false;
  return TEXT_INPUT_TYPES.has(String(el.type || 'text').toLowerCase());
};

/** True when this keydown should be redirected into the scan box. */
export const shouldRedirectKey = (event, input) => {
  if (!input || !event) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (typeof event.key !== 'string' || event.key.length !== 1) return false;
  const target = event.target;
  if (target === input) return false;
  return !takesText(target);
};

export const useScanFocusKeeper = (inputRef, enabled) => {
  useEffect(() => {
    if (!enabled) return undefined;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    let timer = null;
    const onFocusOut = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const active = document.activeElement;
        if (!active || active === document.body) inputRef.current?.focus();
      }, 50);
    };
    const onKeyDown = (event) => {
      if (shouldRedirectKey(event, inputRef.current)) inputRef.current.focus();
    };
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [inputRef, enabled]);
};
