import React, { useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { shouldRedirectKey, takesText, useScanFocusKeeper } from '../hooks/useScanFocusKeeper';

// Browser test PART 1, F7: the first scan after the Receiving list loaded went
// nowhere because nothing put focus back on the scan box.

const Harness = ({ enabled = true }) => {
  const ref = useRef(null);
  useScanFocusKeeper(ref, enabled);
  return (
    <div>
      <input ref={ref} aria-label="scan" />
      <button type="button">Next scan is single</button>
      <input aria-label="qty" type="number" />
    </div>
  );
};

describe('takesText / shouldRedirectKey', () => {
  it('leaves typed text alone in a text field, steals it from a button or the page', () => {
    const scan = document.createElement('input');
    const other = document.createElement('input');
    const button = document.createElement('button');
    const checkbox = Object.assign(document.createElement('input'), { type: 'checkbox' });
    expect(takesText(other)).toBe(true);
    expect(takesText(button)).toBe(false);
    expect(takesText(checkbox)).toBe(false);
    expect(shouldRedirectKey({ key: 'S', target: button }, scan)).toBe(true);
    expect(shouldRedirectKey({ key: 'S', target: document.body }, scan)).toBe(true);
    expect(shouldRedirectKey({ key: 'S', target: other }, scan)).toBe(false);
    expect(shouldRedirectKey({ key: 'S', target: scan }, scan)).toBe(false);
  });

  it('never redirects Enter alone or a shortcut', () => {
    const scan = document.createElement('input');
    expect(shouldRedirectKey({ key: 'Enter', target: document.body }, scan)).toBe(false);
    expect(shouldRedirectKey({ key: 'c', ctrlKey: true, target: document.body }, scan)).toBe(false);
  });
});

describe('useScanFocusKeeper', () => {
  it('moves focus to the scan box when a scan starts on a button', () => {
    render(<Harness />);
    const button = screen.getByRole('button');
    button.focus();
    fireEvent.keyDown(button, { key: 'S' });
    expect(document.activeElement).toBe(screen.getByLabelText('scan'));
  });

  it('does not take a keystroke meant for another field', () => {
    render(<Harness />);
    const qty = screen.getByLabelText('qty');
    qty.focus();
    fireEvent.keyDown(qty, { key: '3' });
    expect(document.activeElement).toBe(qty);
  });

  it('does nothing while disabled (a dialog is open)', () => {
    render(<Harness enabled={false} />);
    const button = screen.getByRole('button');
    button.focus();
    fireEvent.keyDown(button, { key: 'S' });
    expect(document.activeElement).toBe(button);
  });
});
