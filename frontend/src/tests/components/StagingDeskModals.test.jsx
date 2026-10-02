// Browser test PART 3: Mark Used shows the hold and drums; Return offers
// every active rack, defaulting to the original.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const post = vi.fn(() => Promise.resolve({ data: {} }));
vi.mock('../../api/client', () => ({ default: { post: (...a) => post(...a), get: vi.fn() } }));
vi.mock('../../context/ToastContext', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('../../context/AppDataContext', () => ({
  useAppData: () => ({
    locations: [{ id: 'barn', name: 'QA Barn' }],
    subLocationMap: {},
    locationsTree: [{ id: 'barn', name: 'QA Barn', subLocations: [
      { id: 'drums', name: 'QA Drum Room', rows: [{ id: 'd1', name: 'QA-D1' }, { id: 'd4', name: 'QA-D4' }] },
    ] }],
  }),
}));

import MarkUsedModal from '../../components/staging/MarkUsedModal';
import ReturnModal from '../../components/staging/ReturnModal';

beforeEach(() => post.mockClear());

describe('MarkUsedModal', () => {
  const held = {
    staging_item_id: 'si-1', lot_number: 'A-0925', quantity_staged: 502, available: 502,
    is_held: true, hold_message: 'Lot A-0925 is ON HOLD — foreign matter.',
    staged_unit_weight: 502, unit_label: 'drum', weight_unit: 'lbs',
  };

  it('flags a held lot and refuses to submit it', () => {
    render(<MarkUsedModal requestId="sr" item={{ id: 'i', ingredient_name: 'Mango' }}
      details={[held]} onClose={() => {}} />);
    expect(screen.getByRole('alert').textContent).toContain('ON HOLD');
    expect(screen.getByLabelText('Quantity used, lot A-0925')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Used' }));
    expect(post).not.toHaveBeenCalled();
  });

  it('shows drums next to lbs', () => {
    render(<MarkUsedModal requestId="sr" item={{ id: 'i', ingredient_name: 'Mango' }}
      details={[{ ...held, is_held: false, hold_message: null }]} onClose={() => {}} />);
    expect(screen.getAllByText(/1 drum/).length).toBeGreaterThan(0);
  });
});

describe('ReturnModal', () => {
  const detail = {
    staging_item_id: 'si-1', lot_number: 'A-0925', available: 210, is_counted: true,
    weight_per_unit: 502, weight_unit: 'lbs', unit_label: 'drum',
    original_storage_row_id: 'd4', original_storage_row_name: 'QA-D4',
    origin_rows: [{ storage_row_id: 'd4', storage_row_name: 'QA-D4', units: 1 }],
  };

  it('offers any active rack, defaulting to the original, and returns there', async () => {
    render(<ReturnModal requestId="sr" item={{ id: 'i', ingredient_name: 'Mango' }}
      details={[detail]} onClose={() => {}} />);
    const select = screen.getByLabelText(/Return to Rack/);
    expect(select).toHaveValue('d4');
    expect(screen.getByRole('option', { name: /QA-D1/ })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'd1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Return' }));
    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    const [, body] = post.mock.calls[0];
    expect(body).toMatchObject({ to_storage_row_id: 'd1', to_location_id: 'barn', to_sub_location_id: 'drums' });
  });
});
