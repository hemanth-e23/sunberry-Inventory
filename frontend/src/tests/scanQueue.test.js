// The offline scan queue's failure policy.
//
// These cover the exact way a gun lost a shift of scans: the queue stopped on
// the first item it could not send and never got past it, and nothing on the
// device could force it through because every route to a send — the poll, the
// focus handler, the "Sync now" button — was gated on navigator.onLine.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('../api/client', () => ({
  default: { post: vi.fn() },
}));

import apiClient from '../api/client';
import {
  drainScanQueue,
  enqueueScan,
  listScans,
  retryFailedScans,
  __resetScanQueueForTests,
} from '../utils/scanQueue';
import { useScanQueueCore } from '../hooks/useScanQueue';

const httpError = (status) => Object.assign(new Error(`Request failed ${status}`), {
  response: { status, data: { detail: `boom ${status}` } },
});

const transportError = () => new Error('Network Error'); // no .response

const queueScan = (licence) => enqueueScan({
  requestId: 'req-1',
  payload: { licence_number: licence, storage_row_id: 'row-1' },
});

beforeEach(() => {
  __resetScanQueueForTests();
  apiClient.post.mockReset();
});

describe('drainScanQueue', () => {
  it('does not let one un-sendable scan block the ones behind it', async () => {
    queueScan('A');
    queueScan('B');
    queueScan('C');

    // The head item is permanently broken server-side; the other two are fine.
    apiClient.post.mockImplementation((_url, body) => (
      body.licence_number === 'A'
        ? Promise.reject(httpError(500))
        : Promise.resolve({ data: { status: 'ok' } })
    ));

    const result = await drainScanQueue();

    expect(result.sent.map((s) => s.item.payload.licence_number)).toEqual(['B', 'C']);
    expect(result.skipped).toBe(1);
    // A is still queued for another try — skipped, never dropped.
    expect(listScans().map((i) => i.payload.licence_number)).toEqual(['A']);
    expect(listScans()[0].state).toBe('pending');
  });

  it('stops the pass when the server cannot be reached at all', async () => {
    queueScan('A');
    queueScan('B');
    apiClient.post.mockRejectedValue(transportError());

    const result = await drainScanQueue();

    // One attempt, then stop — the rest would fail identically.
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(result.reachable).toBe(false);
    // Nothing is lost: both scans survive for the next pass.
    expect(listScans()).toHaveLength(2);
    expect(listScans().every((i) => i.state === 'pending')).toBe(true);
  });

  it('keeps every scan through a long outage, then flushes them all', async () => {
    for (const licence of ['A', 'B', 'C']) queueScan(licence);
    apiClient.post.mockRejectedValue(transportError());

    for (let i = 0; i < 20; i += 1) await drainScanQueue(); // a shift off-network
    expect(listScans()).toHaveLength(3);
    expect(listScans().every((i) => i.state === 'pending')).toBe(true);

    apiClient.post.mockResolvedValue({ data: { status: 'ok' } });
    const result = await drainScanQueue();

    expect(result.sent).toHaveLength(3);
    expect(result.reachable).toBe(true);
    expect(listScans()).toHaveLength(0);
  });

  it('parks a scan the server keeps rejecting so it stops being invisible', async () => {
    queueScan('A');
    apiClient.post.mockRejectedValue(httpError(500));

    for (let i = 0; i < 8; i += 1) await drainScanQueue();

    const [item] = listScans();
    expect(item.state).toBe('failed');
    expect(item.lastError).toContain('gave up');
  });

  it('parks a 4xx immediately — a closed session is not worth retrying', async () => {
    queueScan('A');
    apiClient.post.mockRejectedValue(httpError(400));

    await drainScanQueue();

    const [item] = listScans();
    expect(item.state).toBe('failed');
    expect(item.lastError).toBe('boom 400');
    // …and "Retry failed" puts it back in play.
    retryFailedScans();
    expect(listScans()[0].state).toBe('pending');
  });

  it('recovers when a send never settles instead of wedging for the shift', async () => {
    // The real wedge: a POST that gets a 401, and the token refresh behind it
    // hangs with no timeout. The drain's await never returns, so `drainInFlight`
    // never clears and every later pass — poll, focus, "Sync now" — no-ops.
    queueScan('A');
    apiClient.post.mockImplementationOnce(() => new Promise(() => {})); // never settles

    drainScanQueue(); // deliberately not awaited: it never resolves
    await Promise.resolve();

    const blocked = await drainScanQueue();
    expect(blocked.alreadyRunning).toBe(true); // correct while it is fresh
    expect(listScans()).toHaveLength(1);

    // Past the watchdog window a new pass is allowed through regardless.
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 91000);
    apiClient.post.mockResolvedValue({ data: { status: 'ok' } });

    const recovered = await drainScanQueue();
    expect(recovered.sent).toHaveLength(1);
    expect(listScans()).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it('survives a UI callback that throws mid-pass', async () => {
    queueScan('A');
    queueScan('B');
    apiClient.post.mockResolvedValue({ data: { status: 'ok' } });

    const result = await drainScanQueue({
      onItemResult: () => { throw new Error('a React setState blew up'); },
    });

    expect(result.sent).toHaveLength(2);
    expect(listScans()).toHaveLength(0);
  });
});

describe('useScanQueueCore', () => {
  it('sends even when the browser claims to be offline', async () => {
    // A gun whose `online` event never fired after the wifi came back. The old
    // hook returned early here and the queue sat there all shift.
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    queueScan('A');
    apiClient.post.mockResolvedValue({ data: { status: 'ok' } });

    renderHook(() => useScanQueueCore());

    await waitFor(() => expect(listScans()).toHaveLength(0));
    vi.restoreAllMocks();
  });

  it('reports offline from a failed send, not from navigator', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    queueScan('A');
    apiClient.post.mockRejectedValue(transportError());

    const { result } = renderHook(() => useScanQueueCore());

    await waitFor(() => expect(result.current.online).toBe(false));
    expect(result.current.pendingCount).toBe(1);
    vi.restoreAllMocks();
  });
});
