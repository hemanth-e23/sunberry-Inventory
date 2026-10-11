// Gun cycle check (FG pallet lifecycle §4.1): scan a row, see it grouped by
// product + lot, tap Not here, confirm once over 5 pallets, submit.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../api/client', () => ({ default: api }));
vi.mock('../../components/scanner/ScannerLayout', () => ({
  default: ({ children }) => <div>{children}</div>,
}));
vi.mock('../../utils/scannerFeedback', async (orig) => ({
  ...(await orig()), playErrorTone: vi.fn(), playSuccessTone: vi.fn(),
}));

import ScannerCycleCheckFlow from '../../components/scanner/ScannerCycleCheckFlow';

const LOT = 'MP28026L1';
const pallets = (lot, n) => Array.from({ length: n }, (_, i) => ({
  id: `${lot}-${i + 1}`, licence_number: `${lot}-MANGO-${String(i + 1).padStart(3, '0')}`,
  sequence: i + 1, cases: 40,
}));
const contents = {
  row: { id: 'row-1', name: 'FG-AJ11' },
  total_pallets: 7,
  groups: [
    { key: `p1|${LOT}`, product_name: 'Mango', lot_number: LOT, count: 1, cases: 40, pallets: pallets(LOT, 1) },
    { key: 'p1|MP28126L1', product_name: 'Mango', lot_number: 'MP28126L1', count: 6, cases: 240, pallets: pallets('MP28126L1', 6) },
  ],
};

const scan = async (value) => {
  const input = screen.getByLabelText('Scan');
  fireEvent.change(input, { target: { value } });
  await act(async () => { fireEvent.submit(input.closest('form')); });
};

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockImplementation((url) => {
    if (url === '/scanner/cycle-check/rows') return Promise.resolve({ data: [{ id: 'row-1', name: 'FG-AJ11', area_name: 'FG' }] });
    if (url === '/scanner/cycle-check/rows/row-1') return Promise.resolve({ data: contents });
    return Promise.reject(new Error(url));
  });
  api.post.mockResolvedValue({ data: { status: 'recorded', summary: {
    row_name: 'FG-AJ11', expected_pallets: 7, not_here: 6, moved_in: 0, found: 0, created: 0, scans: [],
  } } });
});

describe('gun cycle check', () => {
  it('groups the row, marks a group not here, and confirms over 5 pallets', async () => {
    render(<MemoryRouter><ScannerCycleCheckFlow /></MemoryRouter>);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/scanner/cycle-check/rows'));
    await scan('AJ11');                                   // without the FG- prefix
    expect(await screen.findByText('MP28126L1')).toBeInTheDocument();
    await scan(`${LOT}-MANGO-001`);                       // front pallet of the first group
    fireEvent.click(screen.getAllByText('Not here')[1]);  // the 6-pallet group
    await act(async () => { fireEvent.click(screen.getByText(/Submit row check/)); });
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByText('6 pallets not here — sure?')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByText('Yes, mark missing')); });
    expect(api.post).toHaveBeenCalledWith('/scanner/cycle-check/submit', {
      row_id: 'row-1',
      scanned: [`${LOT}-MANGO-001`],
      not_here_pallet_ids: pallets('MP28126L1', 6).map((p) => p.id),
      confirmed: true,
    });
    expect(await screen.findByText('Checked FG-AJ11')).toBeInTheDocument();
  });
});
