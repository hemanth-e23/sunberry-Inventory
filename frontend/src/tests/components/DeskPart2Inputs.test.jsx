// Browser test PART 2: pallet quick entry + inline over-ask (U4, U5) and the
// sticker reprint dialog (U3).
import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import RmEntryQtyInput from '../../components/inventory/RmEntryQtyInput';
import PrintStickersDialog from '../../components/ingredient/PrintStickersDialog';

const bagRack = {
  key: 'k', isCounted: true, unitsPerPallet: 40,
  locationLabel: 'QA Barn / QA Dry Room / QA-P1',
  displayFactor: 55, displayUnit: 'bag', unit: 'lbs',
  fullUnits: 70, openUnits: 0, grossWeight: 70 * 55, available: 70 * 55,
};

const Harness = ({ entry }) => {
  const [v, setV] = useState('');
  return (
    <>
      <RmEntryQtyInput entry={entry} value={v} onChange={setV} disabled={false} />
      <output data-testid="value">{v}</output>
    </>
  );
};

describe('RmEntryQtyInput', () => {
  it('fills N pallets as N x units per pallet', () => {
    render(<Harness entry={bagRack} />);
    fireEvent.change(screen.getByLabelText('full pallets of 40 bags'), { target: { value: '1' } });
    expect(screen.getByTestId('value').textContent).toBe('40');
    expect(screen.getByLabelText('bags to take')).toHaveValue(40);
  });

  it('has no max attribute and explains an over-ask inline', () => {
    render(<Harness entry={bagRack} />);
    const box = screen.getByLabelText('bags to take');
    expect(box).not.toHaveAttribute('max');
    fireEvent.change(box, { target: { value: '80' } });
    expect(screen.getByRole('alert').textContent)
      .toBe('QA-P1 has only 70 bags free (3,850 lbs); you asked for 80 bags.');
  });

  it('offers no pallet entry for drums', () => {
    render(<Harness entry={{ ...bagRack, unitsPerPallet: 0, displayUnit: 'drum' }} />);
    expect(screen.queryByLabelText(/full pallets/)).toBeNull();
  });
});

describe('PrintStickersDialog reprint (U3)', () => {
  const lot = { productName: 'QA Mango Puree', lotCode: 'A-0925', unitLabel: 'drum', totalUnits: 6, onHandUnits: 27 };

  it('lets the worker choose how many, defaulting to what is on hand', () => {
    const onConfirm = vi.fn();
    render(<PrintStickersDialog open lot={lot} reprint onCancel={() => {}} onConfirm={onConfirm} />);
    expect(screen.getByText(/same code/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Print 27/ }));
    expect(onConfirm).toHaveBeenCalledWith({ count: 27, scope: 'unit' });
  });

  it('prints one for a torn sticker', () => {
    const onConfirm = vi.fn();
    render(<PrintStickersDialog open lot={lot} reprint onCancel={() => {}} onConfirm={onConfirm} />);
    // Touching the box (already showing 1) is choosing it.
    fireEvent.focus(screen.getByLabelText('How many drum stickers'));
    fireEvent.click(screen.getByRole('button', { name: /Print 1/ }));
    expect(onConfirm).toHaveBeenCalledWith({ count: 1, scope: 'unit' });
  });

  it('a first print (not a reprint) defaults to the delivery count with no same-code note', () => {
    const onConfirm = vi.fn();
    render(<PrintStickersDialog open lot={{ ...lot, onHandUnits: 0 }} onCancel={() => {}} onConfirm={onConfirm} />);
    expect(screen.queryByText(/same code/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Print 6/ }));
    expect(onConfirm).toHaveBeenCalledWith({ count: 6, scope: 'unit' });
  });
});
