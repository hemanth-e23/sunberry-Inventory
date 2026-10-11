// Closing scan on Submit (FG pallet lifecycle §3.3). Once "Scan the last pallet
// at the wrapper" is up, only the closing scan or Skip may finish the submit —
// a second tap on Submit (or a scanner's Enter landing on the button) used to
// submit with neither recorded.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../api/client', () => ({ default: api }));
vi.mock('../../components/scanner/ScannerLayout', () => ({
  default: ({ children }) => <div>{children}</div>,
}));
vi.mock('../../hooks/useScanQueue', () => ({
  useScanQueue: () => ({
    online: true, pendingCount: 0, failedCount: 0, syncing: false, lastSyncError: null,
    countsForRequest: () => ({ pending: 0, failed: 0 }),
    enqueueScan: vi.fn(() => ({ id: 'q1', idempotency_key: 'k1' })),
    retryFailed: vi.fn(), dropFailed: vi.fn(), clearRequest: vi.fn(), drainNow: vi.fn(),
  }),
}));
vi.mock('../../utils/scannerFeedback', async (orig) => ({
  ...(await orig()), playErrorTone: vi.fn(), playSuccessTone: vi.fn(),
}));

import ScannerReceiptFlow from '../../components/scanner/ScannerReceiptFlow';

const LOT = 'MP28126L2';
const session = {
  id: 'fr-1', lot_number: LOT, product: { name: 'Lychee' },
  pallet_licences: [{
    id: 'pl-1', licence_number: `${LOT}-LYN128-001`, storage_row_id: 'row-1',
    cases: 50, is_partial: false, status: 'pending',
  }],
};

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockImplementation((url, cfg) => {
    if (url === '/scanner/requests' && cfg?.params?.status_filter === 'scanning') return Promise.resolve({ data: [session] });
    if (url === '/scanner/requests') return Promise.resolve({ data: [] });
    if (url === '/scanner/storage-rows') return Promise.resolve({ data: [{ id: 'row-1', name: 'Dock 1', available: 10 }] });
    return Promise.reject(new Error(url));
  });
  api.post.mockResolvedValue({ data: { status: 'ok' } });
});

describe('closing scan on submit', () => {
  it('a second Submit press does not skip the closing scan', async () => {
    render(<MemoryRouter><ScannerReceiptFlow /></MemoryRouter>);
    const submit = await screen.findByRole('button', { name: /Submit Line 2/ });

    await act(async () => { fireEvent.click(submit); });
    expect(screen.getByText('Scan the last pallet at the wrapper')).toBeInTheDocument();
    expect(submit).toBeDisabled();

    // Even if the press gets through (e.g. Enter on a focused button), nothing is submitted.
    await act(async () => { fireEvent.click(submit); });
    expect(api.post).not.toHaveBeenCalled();

    const input = screen.getByPlaceholderText('Scan the last pallet at the wrapper…');
    fireEvent.change(input, { target: { value: `${LOT}-LYN128-003` } });
    await act(async () => { fireEvent.submit(input.closest('form')); });

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/scanner/requests/fr-1/submit', {}));
    const urls = api.post.mock.calls.map((c) => c[0]);
    expect(urls[0]).toBe('/scanner/requests/fr-1/closing-scan');
    expect(api.post.mock.calls[0][1]).toMatchObject({ licence_number: `${LOT}-LYN128-003`, lot_number: LOT });
  });
});
