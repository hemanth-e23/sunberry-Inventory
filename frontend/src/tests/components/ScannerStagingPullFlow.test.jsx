import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Browser test PART 3 (2026-10-02) — the gun's staging pull: B1 (FEFO prompt,
// a crashing scan parked as needs-attention), B3 (held lot on the cart), B9
// (offline rack switch, reasons, cache) and U1 (words). The queue and the API
// are stubbed; what is under test is what the worker sees and what is sent.

const api = vi.hoisted(() => ({
  getStagingPullRequest: vi.fn(),
  listStagingPullRequests: vi.fn(),
  submitStagingPull: vi.fn(),
  returnHeldStagingPull: vi.fn(),
  undoStagingPull: vi.fn(),
  resolveRow: vi.fn(),
}));
const queue = vi.hoisted(() => ({
  settled: null, send: vi.fn(), online: true, items: [], retryItem: vi.fn(), discard: vi.fn(),
}));
const probe = vi.hoisted(() => ({ result: true }));
const racks = vi.hoisted(() => ({ rows: [] }));

vi.mock('../../utils/scanQueue', async (importOriginal) => ({
  ...(await importOriginal()),
  probeServer: vi.fn(() => Promise.resolve(probe.result)),
}));
vi.mock('../../api/stagingPullApi', () => ({
  apiErrorMessage: (err, fallback) => err?.response?.data?.detail || err?.message || fallback,
  getStagingPullRequest: api.getStagingPullRequest,
  listStagingPullRequests: api.listStagingPullRequests,
  submitStagingPull: api.submitStagingPull,
  returnHeldStagingPull: api.returnHeldStagingPull,
  undoStagingPull: api.undoStagingPull,
  stagingPullScanEndpoint: (id) => `/staging-pull/requests/${id}/scan`,
  requestIdFromEndpoint: () => null,
}));
vi.mock('../../api/lotReceivingApi', () => ({
  getRackFill: vi.fn(() => Promise.resolve({ rows: [] })),
  newIdempotencyKey: (() => { let n = 0; return () => `key-${n += 1}`; })(),
  resolveRow: api.resolveRow,
}));
vi.mock('../../api/ingredientIntakeApi', () => ({
  listIngredientRows: vi.fn(() => Promise.resolve(racks.rows)),
}));
vi.mock('../../hooks/useScanQueue', () => ({
  useScanQueueCore: ({ onItemResult }) => {
    queue.settled = onItemResult;
    return {
      online: queue.online,
      queue: queue.items,
      send: queue.send,
      syncNow: vi.fn(),
      retry: vi.fn(),
      retryItem: queue.retryItem,
      discard: queue.discard,
      syncing: false,
      lastSyncError: null,
    };
  },
}));
vi.mock('../../context/AppDataContext', () => ({
  useAppData: () => ({ locations: [{ id: 'loc-prod', name: 'Production' }], subLocationMap: {} }),
}));
vi.mock('../../utils/scannerFeedback', () => ({
  playErrorTone: vi.fn(), playSuccessTone: vi.fn(),
}));
vi.mock('../../components/scanner/ScannerLayout', () => ({
  default: ({ children, headerExtra }) => <div>{headerExtra}{children}</div>,
}));

import ScannerStagingPullFlow from '../../components/scanner/ScannerStagingPullFlow';
import { pullRequestCacheKey, saveCached } from '../../utils/gunCache';

const ENDPOINT = '/staging-pull/requests/sr1/scan';
const D1 = { id: 'r-d1', name: 'QA-D1', barcode: 'QA-D1', storage_unit: 'drum', unit_capacity: 12 };
const STG = { id: 'r-stg', name: 'QA Staging', barcode: 'QA-STG' };

const mango = (extra = {}) => ({
  id: 'it-mango', ingredient_name: 'QA Mango Puree', sid: 'SID-M', unit: 'lbs',
  quantity_needed: 3000, quantity_fulfilled: 0, pending_qty: 1004, remaining_qty: 1996,
  unit_label: 'drum', unit_labels: ['drum'],
  pending_units: [{ unit_label: 'drum', units: 2, open_units: 0 }],
  staged_units: [],
  cart_lots: [{ lot_code: 'LOT-A1', lot_name: 'A-0801', unit_label: 'drum', units: 2, open_units: 0, quantity: 1004, is_held: false }],
  held_lots: [],
  lots: [{ lot_code: 'LOT-A1', vendor_lot: 'A-0801', unit_label: 'drum' },
    { lot_code: 'LOT-A9', vendor_lot: 'A-0925', unit_label: 'drum' }],
  suggestion: {
    lot_number: 'A-0801', lot_code: 'LOT-A1', expiration_date: '2026-11-30', unit_label: 'drum',
    open_units: 0, racks: [{ storage_row_id: 'r-d1', storage_row_name: 'QA-D1', available_units: 2, held_units: 0 }],
  },
  ...extra,
});
const ascorbic = (extra = {}) => ({
  id: 'it-asc', ingredient_name: 'Ascorbic', sid: 'SID-A', unit: 'lbs',
  quantity_needed: 550, quantity_fulfilled: 0, pending_qty: 0, remaining_qty: 550,
  unit_label: 'bag', unit_labels: ['bag'], pending_units: [], staged_units: [], cart_lots: [],
  held_lots: [], lots: [{ lot_code: 'LOT-C', vendor_lot: 'C-0901', unit_label: 'bag' }],
  suggestion: null,
  ...extra,
});
const requestOf = (items) => ({
  id: 'sr1', product_name: 'QA Nectar', formula_name: null, production_date: '2026-10-03',
  status: 'in_progress', items,
});

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/forklift/staging-pull/:requestId" element={<ScannerStagingPullFlow />} />
      <Route path="/forklift/staging-pull" element={<ScannerStagingPullFlow />} />
    </Routes>
  </MemoryRouter>,
);

const scan = (text) => {
  const input = screen.getByPlaceholderText(/Scan/);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.submit(input.closest('form'));
};

const settle = (item, response, error) => act(() => {
  queue.settled({ endpoint: ENDPOINT, ...item }, response, error);
});

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  window.localStorage.clear();
  queue.online = true;
  queue.items = [];
  queue.retryItem.mockReset();
  queue.discard.mockReset();
  probe.result = true;
  racks.rows = [D1, STG];
  queue.send.mockReset();
  queue.send.mockImplementation(({ endpoint, payload, idempotencyKey }) => ({
    idempotency_key: idempotencyKey || `q-${queue.send.mock.calls.length}`, endpoint, payload,
  }));
});

describe('staging pull — request list (U1)', () => {
  it('shows formatted totals and plain status words, no "Formula unknown"', async () => {
    api.listStagingPullRequests.mockResolvedValue([{
      id: 'sr1', product_name: 'QA Nectar', formula_name: null, production_date: '2026-10-03',
      status: 'in_progress', item_count: 3, needed_qty: 89754.66, fulfilled_qty: 22776,
      pending_qty: 0, unit: 'lbs',
    }]);
    renderAt('/forklift/staging-pull');
    expect(await screen.findByText('22,776 of 89,754.66 lbs staged')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.queryByText(/IN_PROGRESS|in_progress/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Formula unknown/)).not.toBeInTheDocument();
  });
});

describe('staging pull — one request', () => {
  it('lines show containers, the scan unit, and "Pull open" only for drums', async () => {
    api.getStagingPullRequest.mockResolvedValue(requestOf([ascorbic()]));
    renderAt('/forklift/staging-pull/sr1');
    await screen.findByText('Ascorbic');
    expect(screen.getByText('bag')).toBeInTheDocument();           // "Each scan is 1 bag"
    expect(screen.queryByText(/Pull open/)).not.toBeInTheDocument();
  });

  it('a drum line shows drums on the cart and offers "Pull open drum"', async () => {
    api.getStagingPullRequest.mockResolvedValue(requestOf([mango()]));
    renderAt('/forklift/staging-pull/sr1');
    await screen.findByText('QA Mango Puree');
    expect(screen.getByText(/on cart \(2 drums\)/)).toBeInTheDocument();
    expect(screen.getByText('Pull open drum')).toBeInTheDocument();
    expect(screen.getByText(/best by 11\/30\/2026/)).toBeInTheDocument();
  });

  it('a held lot says ON HOLD on its line', async () => {
    api.getStagingPullRequest.mockResolvedValue(requestOf([mango({
      suggestion: null,
      held_lots: [{ lot_code: 'LOT-A9', lot_name: 'A-0925', hold_reason: 'foreign matter', unit_label: 'drum', units: 26 }],
    })]));
    renderAt('/forklift/staging-pull/sr1');
    expect(await screen.findByText(/ON HOLD: lot A-0925 \(foreign matter\) — 26 drums on racks/)).toBeInTheDocument();
  });

  it('B1: the FEFO question is asked, and "Pull it anyway" replays the same key', async () => {
    api.getStagingPullRequest.mockResolvedValue(requestOf([mango()]));
    api.resolveRow.mockResolvedValue(D1);
    renderAt('/forklift/staging-pull/sr1');
    await screen.findByText('QA Mango Puree');
    scan('QA-D1');
    await screen.findByText('← QA-D1');
    scan('SB2|LOT-A9|A-0925|20270301');
    const sent = queue.send.mock.calls[0][0];
    expect(sent.payload.lot_code_hint).toBe('LOT-A9');
    const key = queue.send.mock.results[0].value.idempotency_key;
    settle({ idempotency_key: key, payload: sent.payload }, {
      status: 'needs_confirm', warning: 'not_fefo_lot', lot_code: 'LOT-A9', vendor_lot: 'A-0925',
      message: 'Lot A-0801 is older (best by 11/30/2026) on QA-D1 and should go first. Pull lot A-0925 anyway?',
    });
    expect(screen.getAllByText(/Pull lot A-0925 anyway\?/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/not_fefo_lot/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Pull it anyway'));
    const replay = queue.send.mock.calls[1][0];
    expect(replay.idempotencyKey).toBe(key);
    expect(replay.payload.allow_mismatch).toBe(true);
  });

  it('B1: a scan the server keeps failing on is "needs attention" with Retry and Discard', async () => {
    api.getStagingPullRequest.mockResolvedValue(requestOf([mango()]));
    const parked = {
      id: 'p1', idempotency_key: 'k1', endpoint: ENDPOINT, state: 'failed', failKind: 'error',
      lastError: 'The server could not record this scan.', errorDetail: "'str' object has no attribute 'strftime'",
      payload: { code: 'SB2|LOT-A9|A-0925|20270301', display: 'Lot A-0925 ← QA-D4' },
    };
    queue.items = [parked];
    renderAt('/forklift/staging-pull/sr1');
    await screen.findByText('1 scan needs attention');
    expect(screen.getByText('Lot A-0925 ← QA-D4')).toBeInTheDocument();
    expect(screen.queryByText(/OFFLINE/)).not.toBeInTheDocument();
    expect(screen.getByText(/needs attention first/)).toBeInTheDocument(); // why Submit is grey
    fireEvent.click(screen.getByText('Retry'));
    expect(queue.retryItem).toHaveBeenCalledWith('p1');
    fireEvent.click(screen.getByText('Discard'));
    expect(queue.discard).toHaveBeenCalledWith('p1');
  });

  it('B9: offline, a rack label switches the rack from the saved list', async () => {
    api.getStagingPullRequest.mockResolvedValue(requestOf([mango()]));
    api.resolveRow.mockResolvedValue(D1);
    renderAt('/forklift/staging-pull/sr1');
    await screen.findByText('QA Mango Puree');
    scan('QA-D1');
    await screen.findByText('← QA-D1');
    // The wifi drops mid-shift: the resolve call gets no response at all.
    api.resolveRow.mockRejectedValue(new Error('Network Error'));
    scan('QA-STG');
    expect(await screen.findByText('← QA Staging')).toBeInTheDocument();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('B9: offline, an unknown bare code is refused loudly and the rack is NOT kept silently', async () => {
    api.getStagingPullRequest.mockResolvedValue(requestOf([mango()]));
    api.resolveRow.mockResolvedValue(D1);
    renderAt('/forklift/staging-pull/sr1');
    await screen.findByText('QA Mango Puree');
    scan('QA-D1');
    await screen.findByText('← QA-D1');
    api.resolveRow.mockRejectedValue(new Error('Network Error'));
    scan('QA-D9');
    // N6: a stop panel titled as a RACK, and the Recent pulls row is not "Lot …".
    expect(await screen.findByRole('heading', { name: 'Rack "QA-D9" not found' })).toBeInTheDocument();
    expect(screen.getAllByText(/so the rack was NOT changed — still QA-D1/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Rack "QA-D9"$/)).toBeInTheDocument();
    expect(screen.queryByText(/Lot QA-D9/)).not.toBeInTheDocument();
    expect(queue.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('OK — nothing was pulled'));
    expect(screen.queryByRole('heading', { name: 'Rack "QA-D9" not found' })).not.toBeInTheDocument();
  });

  it('N6: offline, a real rack scanned by its NAME resolves from the saved list', async () => {
    racks.rows = [D1, { id: 'r-p1', name: 'QA-P1', barcode: 'PAW-QA-P1', storage_unit: 'bag' }];
    api.getStagingPullRequest.mockResolvedValue(requestOf([mango()]));
    api.resolveRow.mockResolvedValue(D1);
    renderAt('/forklift/staging-pull/sr1');
    await screen.findByText('QA Mango Puree');
    scan('QA-D1');
    await screen.findByText('← QA-D1');
    api.resolveRow.mockRejectedValue(new Error('Network Error'));
    scan('QA-P1');
    expect(await screen.findByText('← QA-P1')).toBeInTheDocument();
    expect(screen.queryByText(/not found/)).not.toBeInTheDocument();
    racks.rows = [];
  });

  it('N6: offline, a name two racks share is refused loudly, never picked', async () => {
    racks.rows = [D1, { id: 'a', name: 'A-12', barcode: 'B1-A-12' }, { id: 'b', name: 'A-12', barcode: 'B2-A-12' }];
    api.getStagingPullRequest.mockResolvedValue(requestOf([mango()]));
    api.resolveRow.mockResolvedValue(D1);
    renderAt('/forklift/staging-pull/sr1');
    await screen.findByText('QA Mango Puree');
    scan('QA-D1');
    await screen.findByText('← QA-D1');
    api.resolveRow.mockRejectedValue(new Error('Network Error'));
    scan('A-12');
    expect(await screen.findByRole('heading', { name: 'Rack "A-12" — which one?' })).toBeInTheDocument();
    expect(screen.getByText('← QA-D1')).toBeInTheDocument();
    racks.rows = [];
  });

  it('B9: Submit greyed while offline says why', async () => {
    queue.online = false;
    queue.items = [{ id: 'q1', idempotency_key: 'k', endpoint: ENDPOINT, state: 'pending', payload: { lot_code_hint: 'LOT-A1', units: 1 } }];
    api.getStagingPullRequest.mockResolvedValue(requestOf([mango()]));
    renderAt('/forklift/staging-pull/sr1');
    await screen.findByText('QA Mango Puree');
    expect(screen.getByText('Submit to staging…')).toBeDisabled();
    expect(screen.getByText(/Offline — 1 scan is saved on this gun/)).toBeInTheDocument();
    // The queued drum counts on its line.
    expect(screen.getByText(/\+ 1 drum waiting to send/)).toBeInTheDocument();
  });

  it('B9: a reload with no wifi shows the request saved on the gun, not a bare 500', async () => {
    saveCached(pullRequestCacheKey('sr1'), requestOf([mango()]));
    api.getStagingPullRequest.mockRejectedValue(new Error('Network Error'));
    renderAt('/forklift/staging-pull/sr1');
    expect(await screen.findByText('QA Mango Puree')).toBeInTheDocument();
    expect(screen.getByText(/Showing this pull as saved on the gun/)).toBeInTheDocument();
    expect(screen.queryByText(/status code 500/)).not.toBeInTheDocument();
  });

  it('B3: a lot held while on the cart stops submit; one press puts it back', async () => {
    api.getStagingPullRequest.mockResolvedValue(requestOf([mango()]));
    api.submitStagingPull.mockResolvedValue({
      status: 'lot_held', held_lots: [{ lot_name: 'A-0801' }],
      message: 'Lot A-0801 went ON HOLD (swab) while 2 drums were on the cart. They cannot be staged — put them back on QA-D1. Nothing was submitted.',
    });
    api.returnHeldStagingPull.mockResolvedValue({ status: 'returned', message: '2 drums of lot A-0801 back on QA-D1 (still on hold).' });
    renderAt('/forklift/staging-pull/sr1');
    await screen.findByText('QA Mango Puree');
    fireEvent.click(screen.getByText('Submit to staging…'));
    fireEvent.change(screen.getByDisplayValue('Select staging location…'), { target: { value: 'loc-prod' } });
    // Per product, never one pound total across products.
    expect(screen.getByText(/2 drums \(1,004 lbs\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Submit the cart to staging'));
    expect((await screen.findAllByText(/went ON HOLD \(swab\)/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText(/I put them back/));
    await waitFor(() => expect(api.returnHeldStagingPull).toHaveBeenCalledWith('sr1'));
  });

  it('U1: the multiplier goes back to 1 when the next product is pulled', async () => {
    api.getStagingPullRequest.mockResolvedValue(requestOf([mango(), ascorbic()]));
    api.resolveRow.mockResolvedValue(D1);
    renderAt('/forklift/staging-pull/sr1');
    await screen.findByText('Ascorbic');
    scan('QA-D1');
    await screen.findByText('← QA-D1');
    const units = screen.getByLabelText('Units per scan');
    settle({ idempotency_key: 'a', payload: {} }, {
      status: 'ok', item_id: 'it-mango', units: 1, unit_label: 'drum', message: '1 drum of lot A-0801 pulled.',
    });
    fireEvent.change(units, { target: { value: '9' } });
    expect(units.value).toBe('9');
    settle({ idempotency_key: 'b', payload: {} }, {
      status: 'ok', item_id: 'it-asc', units: 9, unit_label: 'bag', message: '9 bags of lot C-0901 pulled.',
    });
    expect(units.value).toBe('1');
    expect(screen.getByText(/New product — each scan is back to 1/)).toBeInTheDocument();
  });
});
