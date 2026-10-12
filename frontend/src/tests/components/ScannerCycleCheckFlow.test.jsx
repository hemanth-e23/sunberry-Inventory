// Gun cycle check (FG pallet lifecycle §4.1) as a count SESSION: scan a row,
// see it grouped by product + lot, tap Not here, confirm once over 5 pallets,
// Next row … Finish count. Find Pallet explains why and confirms creating the
// first pallet of a lot the system has never seen.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../api/client', () => ({ default: api }));
vi.mock('../../components/scanner/ScannerLayout', () => ({
  default: ({ children }) => <div>{children}</div>,
}));
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'fk-1' } }) }));
vi.mock('../../utils/scannerFeedback', async (orig) => ({
  ...(await orig()), playErrorTone: vi.fn(), playSuccessTone: vi.fn(),
}));

import ScannerCycleCheckFlow from '../../components/scanner/ScannerCycleCheckFlow';

const LOT = 'MP28026L1';
const STORE_KEY = 'sb.cycleCheck.session.fk-1';
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
const contents2 = {
  row: { id: 'row-2', name: 'FG-AJ12' },
  total_pallets: 1,
  groups: [{ key: 'p1|MP27926L1', product_name: 'Mango', lot_number: 'MP27926L1', count: 1, cases: 40, pallets: pallets('MP27926L1', 1) }],
};
const ROWS = [{ id: 'row-1', name: 'FG-AJ11', area_name: 'FG' }, { id: 'row-2', name: 'FG-AJ12', area_name: 'FG' }];

const recorded = (row, extra = {}) => ({ data: {
  status: 'recorded', session_id: 'cs-aaaaaaaaaaaa', session_started_at: '2026-10-12T13:00:00+00:00',
  summary: { row_name: row, expected_pallets: 7, not_here: 0, moved_in: 0, found: 0, created: 0, variancesCount: 0, scans: [], ...extra },
} });

const scan = async (value) => {
  const input = screen.getByLabelText('Scan');
  fireEvent.change(input, { target: { value } });
  await act(async () => { fireEvent.submit(input.closest('form')); });
};
const click = async (el) => { await act(async () => { fireEvent.click(el); }); };
const mount = async () => {
  render(<MemoryRouter><ScannerCycleCheckFlow /></MemoryRouter>);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/scanner/cycle-check/rows'));
};

beforeEach(() => {
  window.localStorage.clear();
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockImplementation((url) => {
    if (url === '/scanner/cycle-check/rows') return Promise.resolve({ data: ROWS });
    if (url === '/scanner/cycle-check/rows/row-1') return Promise.resolve({ data: contents });
    if (url === '/scanner/cycle-check/rows/row-2') return Promise.resolve({ data: contents2 });
    return Promise.reject(new Error(url));
  });
});

describe('gun cycle check session', () => {
  it('confirms over 5 not-here pallets, saves on Next row and carries the session id', async () => {
    api.post
      .mockResolvedValueOnce(recorded('FG-AJ11', { not_here: 6, variancesCount: 1 }))
      .mockResolvedValueOnce(recorded('FG-AJ12'));
    await mount();
    await scan('AJ11');                                   // without the FG- prefix
    expect(await screen.findByText('MP28126L1')).toBeInTheDocument();
    await scan(`${LOT}-MANGO-001`);                       // front pallet of the first group
    fireEvent.click(screen.getAllByText('Not here')[1]);  // the 6-pallet group
    await click(screen.getByText(/Next row/));
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByText('6 pallets not here — sure?')).toBeInTheDocument();
    await click(screen.getByText('Yes, mark missing'));
    expect(api.post).toHaveBeenCalledWith('/scanner/cycle-check/submit', {
      row_id: 'row-1',
      scanned: [`${LOT}-MANGO-001`],
      not_here_pallet_ids: pallets('MP28126L1', 6).map((p) => p.id),
      confirmed: true,
      session_id: null,
    });
    // Back to "scan the next row", with the saved row's result on screen.
    expect(await screen.findByText('Scan the next row.')).toBeInTheDocument();
    expect(screen.getByText('FG-AJ11 saved')).toBeInTheDocument();
    expect(screen.getByTestId('cc-sessionbar')).toHaveTextContent('1 row · 0 OK');

    await scan('FG-AJ12');
    expect(await screen.findByText('MP27926L1')).toBeInTheDocument();
    await click(screen.getByText(/Finish count/));        // saves the row on screen, ends the walk
    expect(api.post).toHaveBeenLastCalledWith('/scanner/cycle-check/submit', expect.objectContaining({
      row_id: 'row-2', session_id: 'cs-aaaaaaaaaaaa',
    }));
    const done = await screen.findByTestId('cc-finished');
    expect(done).toHaveTextContent('2rows checked');
    expect(done).toHaveTextContent('1OK');
    expect(done).toHaveTextContent('1with differences');
    expect(done).toHaveTextContent('Not here (now missing): 6');
    expect(window.localStorage.getItem(STORE_KEY)).toBeNull();
  });

  it('survives a reload mid-row: the session and the marks come back', async () => {
    window.localStorage.setItem(STORE_KEY, JSON.stringify({
      id: 'cs-bbbbbbbbbbbb', startedAt: '2026-10-12T13:00:00Z', lastAt: Date.now(),
      rows: [{ row_name: 'FG-AJ10', ok: true, not_here: 0, found: 0, moved_in: 0, created: 0, messages: [] }],
      draft: { row: ROWS[0], scanned: [`${LOT}-MANGO-001`], groupNotHere: [], palletNotHere: ['MP28126L1-2'] },
    }));
    api.post.mockResolvedValueOnce({ data: { ...recorded('FG-AJ11').data, session_id: 'cs-bbbbbbbbbbbb' } });
    await mount();
    expect(await screen.findByText('MP28126L1')).toBeInTheDocument();
    expect(screen.getByTestId('cc-sessionbar')).toHaveTextContent('1 row · 1 OK');
    await click(screen.getByText(/Next row/));
    expect(api.post).toHaveBeenCalledWith('/scanner/cycle-check/submit', {
      row_id: 'row-1', scanned: [`${LOT}-MANGO-001`], not_here_pallet_ids: ['MP28126L1-2'],
      confirmed: true, session_id: 'cs-bbbbbbbbbbbb',
    });
    expect(await screen.findByTestId('cc-sessionbar')).toHaveTextContent('2 rows · 2 OK');
  });

  it('starts a new walk after the idle gap', async () => {
    window.localStorage.setItem(STORE_KEY, JSON.stringify({
      id: 'cs-cccccccccccc', lastAt: Date.now() - 61 * 60 * 1000, rows: [{ row_name: 'X', ok: true }], draft: null,
    }));
    await mount();
    expect(screen.queryByTestId('cc-sessionbar')).toBeNull();
    expect(screen.getByText('Scan the row you want to check.')).toBeInTheDocument();
  });
});

describe('Find Pallet', () => {
  it('shows why a sticker is not in the system and needs a confirm tap to create a new lot', async () => {
    const lookup = {
      licence_number: 'MP29926L1-MANGO-004', exists: false, status: null, actions: ['create_here'],
      confirm_create: true, product_name: 'Mango', lot_number: 'MP29926L1', sequence: 4, history: [],
      message: 'No pallet of this lot is in the system (Mango, lot MP29926L1) — check the product and lot on the sticker before creating.',
    };
    api.get.mockImplementation((url) => {
      if (url === '/scanner/cycle-check/rows') return Promise.resolve({ data: ROWS });
      if (url === '/scanner/cycle-check/rows/row-1') return Promise.resolve({ data: contents });
      if (url === '/scanner/cycle-check/find') return Promise.resolve({ data: lookup });
      return Promise.reject(new Error(url));
    });
    api.post.mockResolvedValue({ data: { ...lookup, exists: true, status: 'in_stock', actions: ['move_here'], confirm_create: false, message: 'In stock in FG-AJ11 · lot MP29926L1.' } });
    await mount();
    await scan('AJ11');
    await click(screen.getByText('Find Pallet'));
    await scan('MP29926L1-MANGO-004');
    expect(await screen.findByText(/No pallet of this lot is in the system/)).toBeInTheDocument();
    await click(screen.getByText(/Create in stock in this row/));
    expect(api.post).not.toHaveBeenCalled();
    await click(screen.getByText('Yes, create it in FG-AJ11'));
    expect(api.post).toHaveBeenCalledWith('/scanner/cycle-check/find', {
      licence_number: 'MP29926L1-MANGO-004', action: 'create_here', row_id: 'row-1', confirmed: true,
    });
    // The row check in progress is still there after Find Pallet.
    await click(screen.getByText('Row check'));
    expect(screen.getByText('MP28126L1')).toBeInTheDocument();
  });
});
