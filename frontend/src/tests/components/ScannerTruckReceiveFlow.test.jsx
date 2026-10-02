import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Browser test PART 1 (2026-10-01) — the truck screen on the gun: F7b, F11,
// F13, F15. The queue and the API are stubbed; what is under test is what the
// worker sees and what the screen sends.

const api = vi.hoisted(() => ({
  getTruck: vi.fn(),
  truckFinish: vi.fn(),
  truckRecount: vi.fn(),
  truckRemove: vi.fn(),
  resolveRow: vi.fn(),
}));
const queue = vi.hoisted(() => ({ settled: null, send: vi.fn() }));

vi.mock('../../api/lotReceivingApi', () => ({
  apiErrorMessage: (err, fallback) => err?.message || fallback,
  getTruck: api.getTruck,
  listReceivingSessions: vi.fn(() => Promise.resolve([])),
  listTrucks: vi.fn(() => Promise.resolve([])),
  locateTruck: vi.fn(),
  newIdempotencyKey: (() => { let n = 0; return () => `key-${n += 1}`; })(),
  orderIdFromTruckEndpoint: () => null,
  receiptIdFromEndpoint: () => null,
  resolveRow: api.resolveRow,
  truckFinish: api.truckFinish,
  truckRecount: api.truckRecount,
  truckRemove: api.truckRemove,
  truckScanEndpoint: (id) => `/lot-receiving/trucks/${id}/scan`,
}));
vi.mock('../../api/ingredientIntakeApi', () => ({
  listIngredientRows: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../hooks/useLotScanQueue', () => ({
  isTerminal: () => true,
  useLotScanQueue: (onSettled) => {
    queue.settled = onSettled;
    return {
      online: true, queue: [], send: queue.send, drain: vi.fn(), retry: vi.fn(),
      syncing: false, lastSyncError: null,
    };
  },
}));
vi.mock('../../utils/scannerFeedback', () => ({
  playErrorTone: vi.fn(), playSuccessTone: vi.fn(),
}));
vi.mock('../../components/scanner/ScannerLayout', () => ({
  default: ({ children, headerExtra }) => <div>{headerExtra}{children}</div>,
}));

import ScannerTruckReceiveFlow from '../../components/scanner/ScannerTruckReceiveFlow';

const bagLine = {
  line_id: 'l-bag', product_name: 'ASCORBIC ACID (SB)', lot_code: 'LOT-C', vendor_lot: 'C-0901',
  unit_label: 'bag', count_unit: 'bags', units_per_pallet: 40, expected_count: 80, scanned_count: 0, rows: [],
};
const boxLine = {
  line_id: 'l-box', product_name: 'Citric Acid (SB)', lot_code: 'LOT-D', vendor_lot: 'D-0801',
  unit_label: 'box', count_unit: 'boxes', units_per_pallet: 40, expected_count: 40, scanned_count: 0, rows: [],
};
const drumLine = {
  line_id: 'l-drum', product_name: 'QA Mango Puree', lot_code: 'LOT-B', vendor_lot: 'B-0910',
  unit_label: 'drum', count_unit: 'drums', units_per_pallet: 1, expected_count: 14, scanned_count: 12,
  rows: [{ storage_row_id: 'r-d3', storage_row_name: 'QA-D3', count: 12 }],
};
const truckOf = (lines, extra = {}) => ({
  order_id: 'o1', order_number: 'IN-000022', lines, totals: [], pending_recounts: [], flags: [], ...extra,
});

const renderTruck = () => render(
  <MemoryRouter initialEntries={['/forklift/lot-receiving/truck/o1']}>
    <Routes>
      <Route path="/forklift/lot-receiving/truck/:orderId" element={<ScannerTruckReceiveFlow />} />
      <Route path="/forklift/lot-receiving" element={<div>truck list</div>} />
    </Routes>
  </MemoryRouter>,
);

const scan = (text) => {
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.submit(input.closest('form'));
};

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  queue.send.mockReset();
  queue.send.mockImplementation((requestId, endpoint, payload, key) => ({
    idempotency_key: key || `q-${queue.send.mock.calls.length}`, endpoint, payload,
  }));
});

describe('ScannerTruckReceiveFlow — truck screen', () => {
  it('uses the truck\'s own unit words, never "drums" on a bag/box truck', async () => {
    api.getTruck.mockResolvedValue(truckOf([bagLine, boxLine]));
    renderTruck();
    expect(await screen.findByText(/bags and boxes are blocked/)).toBeInTheDocument();
    expect(screen.queryByText(/drums are blocked/)).not.toBeInTheDocument();
    expect(screen.getAllByText('1 scan = 40 bags').length).toBe(1);
  });

  it('a sticker scanned with no rack is refused out loud and listed in Recent scans', async () => {
    api.getTruck.mockResolvedValue(truckOf([bagLine]));
    renderTruck();
    await screen.findByText(/bags are blocked/);
    scan('SB2|LOT-C|C-0901|20270301');
    expect(queue.send).not.toHaveBeenCalled();
    expect(await screen.findAllByText(/Not put away — scan the rack first/)).not.toHaveLength(0);
    expect(screen.getByText('Lot C-0901')).toBeInTheDocument();
  });

  it('an unknown sticker stops the worker with a dialog, not just a list row', async () => {
    api.getTruck.mockResolvedValue(truckOf([bagLine]));
    renderTruck();
    await screen.findByText(/bags are blocked/);
    act(() => {
      queue.settled(
        { endpoint: '/lot-receiving/trucks/o1/scan', idempotency_key: 'x1', payload: {} },
        { status: 'unknown_lot', message: 'No lot with this sticker is expected on IN-000022.' },
      );
    });
    expect(screen.getByRole('dialog')).toHaveTextContent('Not expected on this truck');
    fireEvent.click(screen.getByText(/OK — nothing was put away/));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('the over-paperwork stop names the line\'s unit and what a pallet scan adds', async () => {
    api.getTruck.mockResolvedValue(truckOf([bagLine]));
    renderTruck();
    await screen.findByText(/bags are blocked/);
    act(() => {
      queue.settled(
        { endpoint: '/lot-receiving/trucks/o1/scan', idempotency_key: 'x2', payload: { est_units: 40 } },
        { status: 'needs_confirm_over', message: 'Paperwork says 80 bags…', units: 40, count_unit: 'bags' },
      );
    });
    expect(screen.getByText('Stop — this scan adds 40 bags')).toBeInTheDocument();
    expect(screen.getByText('Yes, put away 40 bags')).toBeInTheDocument();
  });

  it('flags a header total that hides per-line differences', async () => {
    api.getTruck.mockResolvedValue(truckOf([
      { ...drumLine, line_id: 'a', expected_count: 8, scanned_count: 9 },
      { ...drumLine, line_id: 'b', expected_count: 14, scanned_count: 13 },
    ], { totals: [{ unit: 'drum', expected: 22, scanned: 22 }] }));
    renderTruck();
    expect(await screen.findByText('22 of 22 drums')).toBeInTheDocument();
    expect(screen.getByText('· 1 line over, 1 short')).toBeInTheDocument();
  });

  it('a lower recount is read back before it is booked, then Finish carries on', async () => {
    const pending = [{
      line_id: 'l-drum', storage_row_id: 'r-d3', storage_row_name: 'QA-D3', scanned: 12,
      product_name: 'QA Mango Puree', lot_code: 'LOT-B', vendor_lot: 'B-0910', count_unit: 'drums',
    }];
    api.getTruck.mockResolvedValue(truckOf([drumLine]));
    api.truckFinish
      .mockResolvedValueOnce({ status: 'needs_recount', truck: truckOf([drumLine], { pending_recounts: pending }) })
      .mockResolvedValueOnce({
        status: 'needs_confirm',
        lines: [{ ...drumLine, scanned_count: 11, difference: -3 }],
        truck: truckOf([drumLine]),
      });
    api.truckRecount.mockResolvedValue({ status: 'corrected', message: 'QA-D3 corrected', truck: truckOf([drumLine]) });
    renderTruck();
    await screen.findByText(/drums are blocked/);

    fireEvent.click(screen.getByText('Finish truck'));
    expect(await screen.findByText('Count QA-D3')).toBeInTheDocument();
    fireEvent.click(screen.getByText('No'));
    fireEvent.change(screen.getByPlaceholderText('How many are really there?'), { target: { value: '11' } });
    fireEvent.click(screen.getByText('Save count'));

    expect(screen.getByText('You scanned 12, you counted 11 — 1 drum missing?')).toBeInTheDocument();
    expect(api.truckRecount).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Confirm my count'));
    await waitFor(() => expect(api.truckRecount).toHaveBeenCalledWith('o1', {
      storage_row_id: 'r-d3', counts: [{ line_id: 'l-drum', actual: 11 }],
    }));
    // Finish resumes on its own and its next question is a dialog.
    await waitFor(() => expect(api.truckFinish).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('The counts do not match the paperwork')).toBeInTheDocument();
  });

  it('Recount goes back to the count instead of booking it', async () => {
    const pending = [{
      line_id: 'l-drum', storage_row_id: 'r-d3', storage_row_name: 'QA-D3', scanned: 12,
      product_name: 'QA Mango Puree', lot_code: 'LOT-B', vendor_lot: 'B-0910', count_unit: 'drums',
    }];
    api.getTruck.mockResolvedValue(truckOf([drumLine]));
    api.truckFinish.mockResolvedValue({ status: 'needs_recount', truck: truckOf([drumLine], { pending_recounts: pending }) });
    renderTruck();
    await screen.findByText(/drums are blocked/);
    fireEvent.click(screen.getByText('Finish truck'));
    await screen.findByText('Count QA-D3');
    fireEvent.click(screen.getByText('No'));
    fireEvent.change(screen.getByPlaceholderText('How many are really there?'), { target: { value: '13' } });
    fireEvent.click(screen.getByText('Save count'));
    expect(screen.getByText(/1 drum more than scanned/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Recount'));
    expect(screen.getByText('Count QA-D3')).toBeInTheDocument();
    expect(api.truckRecount).not.toHaveBeenCalled();
  });

  it('books N loose units in one step, each its own single scan and key', async () => {
    api.getTruck.mockResolvedValue(truckOf([bagLine]));
    api.resolveRow.mockResolvedValue({ id: 'r-p1', name: 'QA-P1' });
    renderTruck();
    await screen.findByText(/bags are blocked/);
    scan('QA-QA-P1');
    expect(await screen.findByText('→ QA-P1')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Loose…'));
    fireEvent.change(screen.getByPlaceholderText('How many loose?'), { target: { value: '3' } });
    fireEvent.click(screen.getByText('Book 3 bags loose'));

    expect(queue.send).toHaveBeenCalledTimes(3);
    queue.send.mock.calls.forEach(([, , payload, key]) => {
      expect(payload).toMatchObject({ lot_code: 'LOT-C', storage_row_id: 'r-p1', single: true, est_units: 1 });
      expect(key).toBeUndefined();   // the queue mints a fresh key per unit
    });
  });

  it('Remove a scan leads with the vendor lot and pluralises', async () => {
    api.getTruck.mockResolvedValue(truckOf([{
      ...drumLine, rows: [{ storage_row_id: 'r-d4', storage_row_name: 'QA-D4', count: 1 }],
    }]));
    renderTruck();
    await screen.findByText(/drums are blocked/);
    fireEvent.click(screen.getByText('Remove a scan'));
    expect(screen.getByText('−1 · Lot B-0910 @ QA-D4')).toBeInTheDocument();
    expect(screen.getByText(/1 drum there now/)).toBeInTheDocument();
  });
});
