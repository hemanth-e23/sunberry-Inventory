import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ConfirmDialog from '../../components/ConfirmDialog';

/**
 * The contract is `confirm(message, { title, confirmLabel })` — string first.
 *
 * Getting it backwards used to white-screen the whole application: React throws
 * on a raw object child, and the throw escapes to the app-level ErrorBoundary.
 * A mistyped confirmation must not take the warehouse offline.
 */
describe('ConfirmDialog', () => {
  const noop = () => {};

  it('renders a string message', () => {
    render(<ConfirmDialog message="Close this order?" onConfirm={noop} onCancel={noop} />);
    expect(screen.getByText('Close this order?')).toBeInTheDocument();
  });

  it('survives an options object passed where the message belongs', () => {
    // The exact mistake: confirm({ title, message, confirmText }).
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(
      <ConfirmDialog
        message={{ title: 'Zero out', message: 'Are you sure?', confirmText: 'Go' }}
        onConfirm={noop}
        onCancel={noop}
      />,
    )).not.toThrow();
    // And it surfaces the readable part rather than [object Object].
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('does not crash on an object with no message key', () => {
    expect(() => render(
      <ConfirmDialog message={{ foo: 1 }} onConfirm={noop} onCancel={noop} />,
    )).not.toThrow();
  });

  it('still accepts JSX', () => {
    render(
      <ConfirmDialog message={<strong>Careful</strong>} onConfirm={noop} onCancel={noop} />,
    );
    expect(screen.getByText('Careful')).toBeInTheDocument();
  });
});
