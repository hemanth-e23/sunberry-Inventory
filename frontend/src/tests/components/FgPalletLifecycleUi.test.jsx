// FG pallet lifecycle — what the people at the screens see:
// §2.1/§2.2 forklift review labels and the Not Produced reason, §3.3 the
// closing-scan prompt, §5 the pallet-based lot trace.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../context/ConfirmContext', () => ({
  useConfirm: () => ({ confirm: () => Promise.resolve(true) }),
}));
vi.mock('../../context/ToastContext', () => ({
  useToast: () => ({ addToast: () => {} }),
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'sup', role: 'supervisor' } }),
}));
const appData = vi.hoisted(() => ({
  productionShifts: [], productionLines: [], storageAreas: [], locations: [],
  approveForkliftRequest: vi.fn(), updateForkliftRequest: vi.fn(), removePalletLicence: vi.fn(),
  updatePalletLicence: vi.fn(), addPalletToForkliftRequest: vi.fn(),
  markPalletsNotProduced: vi.fn(() => Promise.resolve({ success: true, data: { count: 1 } })),
  fetchForkliftRequests: vi.fn(),
}));
vi.mock('../../context/AppDataContext', () => ({ useAppData: () => appData }));

import ForkliftTab from '../../components/approvals/ForkliftTab';
import ClosingPrompt from '../../components/scanner/ClosingPrompt';
import FgPalletTrace from '../../components/reports/FgPalletTrace';

const LOT = 'MP28026L1';
const pl = (seq, status, extra = {}) => ({
  id: `pl-${seq}`, licence_number: `${LOT}-MANGO-${String(seq).padStart(3, '0')}`, sequence: seq,
  status, cases: 40, is_partial: false, storage_row_id: 'row-1', product_id: 'p1', lot_number: LOT, ...extra,
});

const request = (over = {}) => ({
  id: 'fr-1', product_id: 'p1', product: { name: 'Mango' }, lot_number: LOT, status: 'submitted',
  cases_per_pallet: 40, total_cases: 120, scanned_by: 'fk', shift_id: 's1',
  pallet_licences: [pl(1, 'pending'), pl(2, 'shipped'), pl(4, 'pending')],
  covered_sequences_by_prefix: { [`${LOT}-MANGO`]: [] },
  pallet_notes: { 'pl-2': '🚚 Moyel shuttle · trailer T-12' },
  missing_after_last_scan: { [`${LOT}-MANGO`]: [`${LOT}-MANGO-005`] },
  closing_status: { [LOT]: 'closed' },
  ...over,
});

const renderTab = (fr) => render(
  <ForkliftTab pendingForkliftRequests={[fr]} productLookup={{}} rowLookup={{ 'row-1': 'FG-01' }}
    lineLookup={{}} userNameMap={{}} />,
);

describe('forklift review', () => {
  it('shows a shuttled pallet on its trailer, not as Pending', () => {
    renderTab(request());
    expect(screen.getByText('🚚 Moyel shuttle · trailer T-12')).toBeInTheDocument();
    expect(screen.getAllByText('Pending')).toHaveLength(2);
  });

  it('labels an emptied pallet and offers no Fix for it', () => {
    renderTab(request({ pallet_licences: [pl(1, 'pending'), pl(3, 'emptied', { cases: 0 })] }));
    expect(screen.getByText('Emptied (0 cases)')).toBeInTheDocument();
    expect(screen.getAllByText('Pending')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Fix' })).toHaveLength(1);
  });

  it('lists numbers after the last scan, labelled', () => {
    renderTab(request());
    expect(screen.getByText(/MANGO-005/)).toBeInTheDocument();
    expect(screen.getByText('after last scan')).toBeInTheDocument();
  });

  it('flags a lot whose closing scan was skipped', () => {
    renderTab(request({ closing_status: { [LOT]: 'skipped' } }));
    expect(screen.getByText(`${LOT}: Not closed — last pallet unknown`)).toBeInTheDocument();
  });

  it('Skip — Not Produced asks for a reason before it marks anything', async () => {
    renderTab(request());
    // #003 is a middle gap.
    const skipButtons = screen.getAllByText('Skip — Not Produced');
    fireEvent.click(skipButtons[0]);
    const mark = screen.getByText('Mark Not Produced');
    expect(mark).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Not produced reason'), { target: { value: 'other' } });
    expect(mark).toBeDisabled();                       // "other" needs a note
    fireEvent.change(screen.getByLabelText('Not produced note'), { target: { value: 'line jam' } });
    expect(mark).not.toBeDisabled();
    await act(async () => { fireEvent.click(mark); });
    expect(appData.markPalletsNotProduced).toHaveBeenCalledWith(
      'fr-1', [`${LOT}-MANGO-003`], { reasonCode: 'other', note: 'line jam' },
    );
  });
});

describe('closing-scan prompt', () => {
  afterEach(() => vi.useRealTimers());
  it('shows Skip only after the countdown, never the last number', () => {
    vi.useFakeTimers();
    const onSkip = vi.fn();
    render(<ClosingPrompt reason="submit" onSkip={onSkip} busy={false} />);
    expect(screen.getByText('Scan the last pallet at the wrapper')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip (10)' })).toBeDisabled();
    const tick = (n) => { for (let i = 0; i < n; i += 1) act(() => { vi.advanceTimersByTime(1000); }); };
    tick(3);
    expect(screen.getByRole('button', { name: 'Skip (7)' })).toBeDisabled();
    tick(7);
    const skip = screen.getByRole('button', { name: 'Skip' });
    expect(skip).not.toBeDisabled();
    fireEvent.click(skip);
    expect(onSkip).toHaveBeenCalled();
  });
});

describe('pallet-based lot trace', () => {
  const bucket = (pallets, cases, items = []) => ({ pallets, cases, items });
  const lot = {
    product_id: 'p1', product_name: 'Mango', product_code: 'FCC-M', lot_number: LOT,
    produced: { pallets: 5, cases: 200 },
    shipped: bucket(1, 40, [{ licence_number: `${LOT}-MANGO-001`, sequence: 1, cases: 40, order_number: 'SO-1', by: 'FK', at: null }]),
    shuttle: bucket(1, 40, [{ licence_number: `${LOT}-MANGO-002`, sequence: 2, cases: 40, trailer_number: 'T9' }]),
    adjusted: bucket(0, 5), missing: bucket(1, 40), pending: bucket(0, 0),
    in_stock: bucket(2, 75), not_produced: bucket(1, 0),
    in_stock_by_row: [{ row_name: 'FG-01', pallets: 2, cases: 75 }],
    found_history: [], balanced: true, difference: { pallets: 0, cases: 0 },
    books: { receipt_on_hand: 75, receipt_produced: 200, receipts: 1, on_hand_difference: 0 },
  };
  it('shows the balance and opens a line to its pallets', () => {
    render(<FgPalletTrace lot={lot} />);
    expect(screen.getByText('✅ balanced')).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Moyel shuttle \(trailers\)/));
    expect(screen.getByText(/Trailer T9/)).toBeInTheDocument();
  });
  it('shows the difference when it does not balance', () => {
    render(<FgPalletTrace lot={{ ...lot, balanced: false, difference: { pallets: 1, cases: 40 } }} />);
    expect(screen.getByText('Off by 1 pallets / 40 cases')).toBeInTheDocument();
  });
});
