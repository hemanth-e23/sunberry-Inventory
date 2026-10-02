import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Browser re-check of PART 2/3 (2026-10-02), N2 on the walk-in screen: after
// "One bag — book 1" the next scan on that rack must not silently book a
// pallet. The queue and the API are stubbed.

const api = vi.hoisted(() => ({ getReceivingSession: vi.fn(), resolveRow: vi.fn() }));
const queue = vi.hoisted(() => ({ send: vi.fn(), online: true }));

vi.mock('../../api/lotReceivingApi', () => ({
  apiErrorMessage: (err, fallback) => err?.message || fallback,
  getRackFill: vi.fn(() => Promise.resolve({ rows: [] })),
  getReceivingSession: api.getReceivingSession,
  lotScanEndpoint: (id) => `/lot-receiving/sessions/${id}/scan`,
  newIdempotencyKey: (() => { let n = 0; return () => `key-${n += 1}`; })(),
  resolveRow: api.resolveRow,
  submitReceivingSession: vi.fn(),
  undoLastScan: vi.fn(),
}));
vi.mock('../../api/ingredientIntakeApi', () => ({
  listIngredientRows: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../hooks/useLotScanQueue', () => ({
  isTerminal: () => true,
  useLotScanQueue: () => ({
    online: queue.online, queue: [], send: queue.send, drain: vi.fn(), retry: vi.fn(),
    syncing: false, lastSyncError: null,
  }),
}));
vi.mock('../../utils/scannerFeedback', () => ({
  playErrorTone: vi.fn(), playSuccessTone: vi.fn(),
}));
vi.mock('../../components/scanner/ScannerLayout', () => ({
  default: ({ children, headerExtra }) => <div>{headerExtra}{children}</div>,
}));

import ScannerLotReceiveFlow from '../../components/scanner/ScannerLotReceiveFlow';

const session = {
  receipt_id: 'rc1', product_name: 'ASCORBIC ACID (SB)', vendor_lot: 'C-1002', lot_code: 'LOT-C',
  count_unit: 'bags', units_per_pallet: 40, expected_count: 80, scanned_count: 0, rows: [],
};

const renderFlow = () => render(
  <MemoryRouter initialEntries={['/forklift/lot-receiving/rc1']}>
    <Routes>
      <Route path="/forklift/lot-receiving/:receiptId" element={<ScannerLotReceiveFlow />} />
    </Routes>
  </MemoryRouter>,
);

const scan = (text) => {
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.submit(input.closest('form'));
};

beforeEach(() => {
  window.localStorage.clear();
  api.getReceivingSession.mockReset();
  api.resolveRow.mockReset();
  queue.send.mockReset();
  queue.send.mockImplementation((id, endpoint, payload, key) => ({
    idempotency_key: key || `q-${queue.send.mock.calls.length}`, endpoint, payload,
  }));
});

describe('ScannerLotReceiveFlow — pallet or bag (N2)', () => {
  it('"One bag" sticks on that rack until the pallet button is tapped; then a pallet is asked about', async () => {
    api.getReceivingSession.mockResolvedValue(session);
    api.resolveRow.mockImplementation((code) => (code === 'QA-P1'
      ? Promise.resolve({ id: 'r-p1', name: 'QA-P1' })
      : Promise.reject(Object.assign(new Error('nf'), { response: { status: 404 } }))));
    renderFlow();
    await screen.findByText('a pallet');
    scan('QA-P1');
    await screen.findAllByText(/QA-P1/);

    scan('SB2|LOT-C|C-1002|20270301');
    expect(screen.getByText('Pallet sticker, or one bag?')).toBeInTheDocument();
    fireEvent.click(screen.getByText('One bag — book 1'));
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send.mock.calls[0][2].units).toBeUndefined(); // one bag
    expect(screen.getByText('ONE BAG PER SCAN on QA-P1')).toBeInTheDocument();

    // Next scan (the bag is now on the rack): one bag again, no question.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    scan('SB2|LOT-C|C-1002|20270301');
    expect(queue.send).toHaveBeenCalledTimes(2);
    expect(queue.send.mock.calls[1][2].units).toBeUndefined();

    // Back to pallets deliberately: the next pallet scan there is asked first.
    fireEvent.click(screen.getByText('a pallet'));
    expect(screen.queryByText('ONE BAG PER SCAN on QA-P1')).not.toBeInTheDocument();
    scan('SB2|LOT-C|C-1002|20270301');
    expect(screen.getByText('Pallet sticker, or one bag?')).toBeInTheDocument();
    expect(queue.send).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByText('PALLET sticker — book 40 bags'));
    expect(queue.send.mock.calls[2][2].units).toBe(40);
  });
});
