// React hook over scanQueue.js. Adds:
//   - connectivity state derived from real send outcomes (see below)
//   - automatic drain on online + tab visibility + interval
//   - state-snapshot of the queue exposed for UI badges
//
// The drain is NEVER gated on navigator.onLine. On a scanner gun that flag is
// unreliable — WebViews, captive portals and sleep/wake can leave it stuck
// false long after the wifi is back. It used to gate both the auto-drain and
// the "Sync now" button, so a stuck flag meant a queue that could not be
// flushed by any means: scans piled up all shift and the driver had no way to
// push them through. Now the POST itself is the connectivity test, and what it
// reports is what the header chip shows.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  drainScanQueue,
  enqueueScan,
  getConnectivity,
  listScans,
  removeScan,
  removeScansForRequest,
  retryFailedScans,
  subscribeToConnectivity,
  subscribeToScanQueue,
} from '../utils/scanQueue';

const POLL_MS = 8000;

/**
 * Shared queue engine. Every scanner flow uses this — one storage key, one
 * retry policy, one drain loop, one definition of "are we connected".
 *
 * onItemResult(item, response | null, error | null) fires per settled item.
 */
export const useScanQueueCore = ({ onItemResult } = {}) => {
  const [navigatorOnline, setNavigatorOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [queue, setQueue] = useState(() => listScans());
  const [conn, setConn] = useState(() => getConnectivity());
  const onItemResultRef = useRef(onItemResult);

  useEffect(() => { onItemResultRef.current = onItemResult; }, [onItemResult]);

  // Subscribe to queue changes (cross-tab + same-tab) and to send outcomes
  useEffect(() => subscribeToScanQueue((next) => setQueue(next)), []);
  useEffect(() => subscribeToConnectivity((next) => setConn(next)), []);

  // navigator.onLine is still worth listening to: when it flips true that is a
  // good moment to try. It just never gets to VETO a send.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const goOnline = () => setNavigatorOnline(true);
    const goOffline = () => setNavigatorOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  const runDrain = useCallback((force) => drainScanQueue({
    force,
    onItemResult: (item, response, error) => onItemResultRef.current?.(item, response, error),
  }), []);

  // The background poll, which the transport back-off is allowed to throttle.
  const drain = useCallback(() => runDrain(false), [runDrain]);
  // Anything a person did. Never throttled: when someone presses Sync now, or
  // opens the app, or scans, they get an attempt right then.
  const syncNow = useCallback(() => runDrain(true), [runDrain]);

  // Try on mount, whenever the browser claims we are back, and on focus.
  useEffect(() => { syncNow(); }, [syncNow, navigatorOnline]);
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onVis = () => { if (!document.hidden) syncNow(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [syncNow]);

  // Periodic poll — this is the one that actually recovers a gun whose `online`
  // event never fired, which is exactly why it must not be gated on
  // navigator.onLine the way it used to be.
  useEffect(() => {
    const t = setInterval(drain, POLL_MS);
    return () => clearInterval(t);
  }, [drain]);

  const pendingCount = queue.filter((it) => it.state === 'pending').length;
  const failedCount = queue.filter((it) => it.state === 'failed').length;

  // What the operator is shown. Measured reachability wins whenever we have it
  // and there is queued work keeping it fresh (a pass runs every 8s); with an
  // empty queue nothing is being measured, so fall back to the browser's claim.
  const online = (pendingCount > 0 && conn.reachable !== null)
    ? conn.reachable
    : navigatorOnline;

  const send = useCallback(({ requestId, payload, endpoint, idempotencyKey }) => {
    const item = enqueueScan({ requestId, payload, endpoint, idempotencyKey });
    // Try immediately so the common case (online) feels synchronous.
    syncNow();
    return item;
  }, [syncNow]);

  const retry = useCallback(() => {
    retryFailedScans();
    return syncNow();
  }, [syncNow]);

  return {
    online,
    navigatorOnline,
    queue,
    pendingCount,
    failedCount,
    syncing: conn.syncing,
    lastSyncError: conn.lastError,
    lastSyncAt: conn.lastAttemptAt,
    retryDelayMs: conn.retryDelayMs,
    drain,
    syncNow,
    send,
    retry,
    dropFailed: removeScan,
    clearRequest: removeScansForRequest,
  };
};

export const useScanQueue = ({ onSynced, onFailed } = {}) => {
  const onSyncedRef = useRef(onSynced);
  const onFailedRef = useRef(onFailed);
  useEffect(() => { onSyncedRef.current = onSynced; }, [onSynced]);
  useEffect(() => { onFailedRef.current = onFailed; }, [onFailed]);

  const onItemResult = useCallback((item, response, error) => {
    if (response) onSyncedRef.current?.(item, response);
    if (error) onFailedRef.current?.(item, error);
  }, []);

  const core = useScanQueueCore({ onItemResult });
  const { queue } = core;

  // Per-session counts so each line's submit is gated only by its own scans.
  const countsForRequest = useCallback((requestId) => {
    let pending = 0;
    let failed = 0;
    for (const it of queue) {
      if (it.requestId !== requestId) continue;
      if (it.state === 'pending') pending += 1;
      else if (it.state === 'failed') failed += 1;
    }
    return { pending, failed };
  }, [queue]);

  return {
    online: core.online,
    queue,
    pendingCount: core.pendingCount,
    failedCount: core.failedCount,
    syncing: core.syncing,
    lastSyncError: core.lastSyncError,
    lastSyncAt: core.lastSyncAt,
    retryDelayMs: core.retryDelayMs,
    countsForRequest,
    // `endpoint` is forwarded now; flows no longer need a private copy of this
    // hook just to reach a non-default path.
    enqueueScan: core.send,
    retryFailed: core.retry,
    dropFailed: core.dropFailed,
    clearRequest: core.clearRequest,
    drainNow: core.syncNow,
  };
};
