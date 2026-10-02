// The offline scan queue's failure policy.
//
// These cover the exact way a gun lost a shift of scans: the queue stopped on
// the first item it could not send and never got past it, and nothing on the
// device could force it through because every route to a send — the poll, the
// focus handler, the "Sync now" button — was gated on navigator.onLine.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../api/client', () => ({
  default: { post: vi.fn(), get: vi.fn() },
}));

import apiClient from '../api/client';
import {
  drainScanQueue,
  enqueueScan,
  getConnectivity,
  discardScan,
  isUnreachableError,
  listScans,
  PARK_AFTER_SERVER_ERRORS,
  retryScan,
  SERVER_FAULT_MESSAGE,
  noteReachability,
  retryFailedScans,
  updateScan,
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
  apiClient.get.mockReset();
  // Default: /health is a dead backend behind the dev proxy (a plain 500), so
  // a 500 everywhere still reads as an outage unless a test says otherwise.
  apiClient.get.mockRejectedValue(httpError(500));
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

    // A shift off-network. Each pass is forced so the back-off does not mask
    // what is being tested here: that nothing is ever dropped.
    for (let i = 0; i < 20; i += 1) await drainScanQueue({ force: true });
    expect(listScans()).toHaveLength(3);
    expect(listScans().every((i) => i.state === 'pending')).toBe(true);

    apiClient.post.mockResolvedValue({ data: { status: 'ok' } });

    // No one touches the gun — the background poll alone brings it back, once
    // the back-off window has passed.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61000);
    const result = await drainScanQueue();

    expect(result.sent).toHaveLength(3);
    expect(result.reachable).toBe(true);
    expect(listScans()).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it('never gives up on a scan the server answers 500 for — it backs off and stays queued', async () => {
    // Browser test U1: the backend stopped behind the dev proxy answered 500,
    // and after ~1 minute every scan read "gave up after 8 tries".
    queueScan('A');
    apiClient.post.mockRejectedValue(httpError(500));

    for (let i = 0; i < 20; i += 1) await drainScanQueue({ force: true });

    const [item] = listScans();
    expect(item.state).toBe('pending');
    expect(item.serverErrors).toBe(20);
    expect(item.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(getConnectivity().reachable).toBe(false);
  });

  it('treats 502/503/504 like no connection: stops the pass, keeps everything', async () => {
    queueScan('A');
    queueScan('B');
    apiClient.post.mockRejectedValue(httpError(503));

    const result = await drainScanQueue();

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(result.reachable).toBe(false);
    expect(listScans().every((i) => i.state === 'pending')).toBe(true);
  });

  it('once the server is known down, a 500 stops the pass instead of walking the queue', async () => {
    queueScan('A');
    queueScan('B');
    queueScan('C');
    apiClient.post.mockRejectedValue(httpError(500));

    await drainScanQueue({ force: true }); // learns it is down: all three tried
    expect(apiClient.post).toHaveBeenCalledTimes(3);
    await drainScanQueue({ force: true }); // still down: one probe, then stop
    expect(apiClient.post).toHaveBeenCalledTimes(4);

    // Back: the background poll sends ALL of them, back-off notwithstanding.
    apiClient.post.mockResolvedValue({ data: { status: 'ok' } });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61000);
    const result = await drainScanQueue();
    expect(result.sent).toHaveLength(3);
    expect(listScans()).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it('brings back scans parked by the old "gave up" rule on its own, but not refusals', async () => {
    const a = queueScan('A');
    const b = queueScan('B');
    updateScan(a.id, { state: 'failed', lastError: 'boom 500 (gave up after 8 tries)' });
    updateScan(b.id, { state: 'failed', failKind: 'terminal', lastError: 'Session closed' });
    apiClient.post.mockResolvedValue({ data: { status: 'ok' } });

    const result = await drainScanQueue();

    expect(result.sent.map((s) => s.item.payload.licence_number)).toEqual(['A']);
    expect(listScans().map((i) => [i.payload.licence_number, i.state])).toEqual([['B', 'failed']]);
  });

  it('a direct call that could not reach the server marks the gun offline', () => {
    noteReachability(false);
    expect(getConnectivity().reachable).toBe(false);
    noteReachability(true);
    expect(getConnectivity().reachable).toBe(true);
  });

  it('isUnreachableError: no response or any 5xx, never a 4xx', () => {
    expect(isUnreachableError(transportError())).toBe(true);
    expect(isUnreachableError(httpError(500))).toBe(true);
    expect(isUnreachableError(httpError(504))).toBe(true);
    expect(isUnreachableError(httpError(409))).toBe(false);
    expect(isUnreachableError(null)).toBe(false);
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

  it('slows the background poll when nothing answers, but never a forced sync', async () => {
    queueScan('A');
    apiClient.post.mockRejectedValue(transportError());

    await drainScanQueue();                 // first pass: attempts once
    expect(apiClient.post).toHaveBeenCalledTimes(1);

    const backedOff = await drainScanQueue(); // background poll, too soon
    expect(backedOff.backedOff).toBe(true);
    expect(apiClient.post).toHaveBeenCalledTimes(1);

    // The driver pressing "Sync now" is never made to wait.
    await drainScanQueue({ force: true });
    expect(apiClient.post).toHaveBeenCalledTimes(2);

    // And one good response puts the poll straight back to full speed.
    apiClient.post.mockResolvedValue({ data: { status: 'ok' } });
    await drainScanQueue({ force: true });
    expect(listScans()).toHaveLength(0);

    queueScan('B');
    await drainScanQueue();
    expect(apiClient.post).toHaveBeenCalledTimes(4);
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

describe('a scan the server keeps failing on while it is up (PART 3, B1)', () => {
  it('stays online and parks the scan as needs-attention after one retry', async () => {
    queueScan('A');
    apiClient.post.mockRejectedValue(httpError(500));
    apiClient.get.mockResolvedValue({ data: { status: 'healthy' } });
    const seen = [];
    const onItemResult = (item, resp, err) => seen.push([item.state, item.failKind, !!err]);

    const first = await drainScanQueue({ force: true, onItemResult });
    expect(first.reachable).toBe(true);                 // never "OFFLINE"
    expect(getConnectivity().reachable).toBe(true);
    expect(listScans()[0].state).toBe('pending');        // one automatic retry

    const second = await drainScanQueue({ force: true, onItemResult });
    expect(PARK_AFTER_SERVER_ERRORS).toBe(2);
    const [item] = listScans();
    expect(item.state).toBe('failed');
    expect(item.failKind).toBe('error');
    expect(item.lastError).toBe(SERVER_FAULT_MESSAGE);
    expect(item.errorDetail).toBe('boom 500');
    expect(second.reachable).toBe(true);
    expect(second.failed).toHaveLength(1);
    // The flow is told the scan is parked, so its row can say so.
    expect(seen.at(-1)).toEqual(['failed', 'error', true]);

    // Parked means parked: background passes do not keep hammering it.
    apiClient.post.mockClear();
    await drainScanQueue({ force: true });
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('counts another scan getting through as proof the server is up', async () => {
    queueScan('A');
    queueScan('B');
    apiClient.post.mockImplementation((_url, body) => (
      body.licence_number === 'A'
        ? Promise.reject(httpError(500))
        : Promise.resolve({ data: { status: 'ok' } })
    ));
    await drainScanQueue({ force: true });
    queueScan('C'); // the worker keeps scanning; C gets through
    await drainScanQueue({ force: true });
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(listScans().map((i) => [i.payload.licence_number, i.failKind])).toEqual([['A', 'error']]);
    expect(getConnectivity().reachable).toBe(true);
  });

  it('a 500 everywhere with /health down is still an outage — nothing parked', async () => {
    queueScan('A');
    apiClient.post.mockRejectedValue(httpError(500));
    for (let i = 0; i < 5; i += 1) await drainScanQueue({ force: true });
    expect(listScans()[0].state).toBe('pending');
    expect(getConnectivity().reachable).toBe(false);
  });

  it('Retry sends a parked scan again; Discard drops it', async () => {
    const a = queueScan('A');
    const b = queueScan('B');
    updateScan(a.id, { state: 'failed', failKind: 'error', lastError: SERVER_FAULT_MESSAGE });
    updateScan(b.id, { state: 'failed', failKind: 'error', lastError: SERVER_FAULT_MESSAGE });
    apiClient.post.mockResolvedValue({ data: { status: 'ok' } });

    // Not revived by itself — it needs a person.
    await drainScanQueue({ force: true });
    expect(apiClient.post).not.toHaveBeenCalled();

    retryScan(a.id);
    discardScan(b.id);
    const result = await drainScanQueue({ force: true });
    expect(result.sent.map((s) => s.item.payload.licence_number)).toEqual(['A']);
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

  it('a direct call that could not reach the server turns the gun offline even with an empty queue', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const { result } = renderHook(() => useScanQueueCore());
    expect(result.current.online).toBe(true);
    act(() => { noteReachability(false); });
    await waitFor(() => expect(result.current.online).toBe(false));
    act(() => { noteReachability(true); });
    await waitFor(() => expect(result.current.online).toBe(true));
    vi.restoreAllMocks();
  });

  it('sends the queue by itself the moment the server is back — nobody presses Retry', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    queueScan('A');
    apiClient.post.mockRejectedValue(transportError());
    const { result } = renderHook(() => useScanQueueCore());
    await waitFor(() => expect(result.current.online).toBe(false));

    apiClient.post.mockResolvedValue({ data: { status: 'ok' } });
    act(() => { noteReachability(true); }); // e.g. a GET elsewhere succeeded
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
