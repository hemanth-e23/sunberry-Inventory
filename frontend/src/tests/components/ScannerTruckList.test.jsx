import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Browser test PART 4 (P8): the Receiving list led with never-touched and
// all-scanned trucks. Open trucks now come first (unloading, then not
// started); all-scanned ones fold behind "Show finished".

const trucks = vi.hoisted(() => ({ list: [] }));

vi.mock('../../api/lotReceivingApi', () => ({
  apiErrorMessage: (err, fallback) => err?.message || fallback,
  getRackFill: vi.fn(() => Promise.resolve({ rows: [] })),
  getTruck: vi.fn(),
  listReceivingSessions: vi.fn(() => Promise.resolve([])),
  listTrucks: vi.fn(() => Promise.resolve(trucks.list)),
  locateTruck: vi.fn(),
  newIdempotencyKey: () => 'k',
  orderIdFromTruckEndpoint: () => null,
  receiptIdFromEndpoint: () => null,
  resolveRow: vi.fn(),
  truckFinish: vi.fn(),
  truckRecount: vi.fn(),
  truckRemove: vi.fn(),
  truckScanEndpoint: (id) => `/lot-receiving/trucks/${id}/scan`,
}));
vi.mock('../../hooks/useLotScanQueue', () => ({
  isTerminal: () => true,
  useLotScanQueue: () => ({
    online: true, queue: [], send: vi.fn(), drain: vi.fn(), retry: vi.fn(),
    syncing: false, lastSyncError: null,
  }),
}));
vi.mock('../../utils/scannerFeedback', () => ({
  playErrorTone: vi.fn(), playSuccessTone: vi.fn(),
}));
vi.mock('../../components/scanner/ScannerLayout', () => ({
  default: ({ children, headerExtra }) => <div>{headerExtra}{children}</div>,
}));

import ScannerTruckReceiveFlow from '../../components/scanner/ScannerTruckReceiveFlow';

const line = (scanned, expected) => ({
  line_id: `l-${scanned}-${expected}`, product_name: 'QA TEST DRUM PUREE', lot_code: 'LOT',
  unit_label: 'drum', count_unit: 'drums', expected_count: expected, scanned_count: scanned, rows: [],
});
const truck = (id, number, date, scanned, expected) => ({
  order_id: id, order_number: number, expected_date: date, bol: `BOL-${number}`,
  lines: [line(scanned, expected)],
});

const renderList = () => render(
  <MemoryRouter initialEntries={['/forklift/lot-receiving']}>
    <Routes>
      <Route path="/forklift/lot-receiving" element={<ScannerTruckReceiveFlow />} />
    </Routes>
  </MemoryRouter>,
);

describe('Receiving truck list order (PART 4, P8)', () => {
  it('lists unloading trucks first, then not started, and folds the all-scanned ones', async () => {
    trucks.list = [
      truck('o5', 'IN-000005', '2026-08-01', 0, 70),
      truck('o18', 'IN-000018', '2026-09-30', 10, 10),
      truck('o12', 'IN-000012', '2026-09-01', 0, 40),
      truck('o30', 'IN-000030', '2026-10-01', 3, 10),
    ];
    renderList();
    await screen.findByText('IN-000030');
    const numbers = screen.getAllByText(/^IN-0000/).map((el) => el.textContent.trim());
    expect(numbers).toEqual(['IN-000030', 'IN-000012', 'IN-000005']);
    expect(screen.queryByText('IN-000018')).not.toBeInTheDocument();
    expect(screen.getByText('Unloading')).toBeInTheDocument();
    expect(screen.getAllByText('Not started')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: /Show finished \(1/ }));
    expect(screen.getByText('IN-000018')).toBeInTheDocument();
    expect(screen.getByText(/All scanned — tap to finish/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide finished trucks' })).toBeInTheDocument();
  });

  it('has no "Show finished" toggle when every truck is still open', async () => {
    trucks.list = [truck('o1', 'IN-000001', '2026-10-01', 0, 5)];
    renderList();
    await screen.findByText('IN-000001');
    expect(screen.queryByRole('button', { name: /Show finished/ })).not.toBeInTheDocument();
  });
});
