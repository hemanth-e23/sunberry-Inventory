// React hook over scanQueue.js. Adds:
//   - online/offline state derived from navigator.onLine + events
//   - automatic drain on online + tab visibility + interval
//   - state-snapshot of the queue exposed for UI badges
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  drainScanQueue,
  enqueueScan,
  listScans,
  removeScan,
  retryFailedScans,
  subscribeToScanQueue,
} from '../utils/scanQueue';

const POLL_MS = 8000;

export const useScanQueue = ({ onSynced, onFailed } = {}) => {
  const [online, setOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [queue, setQueue] = useState(() => listScans());
  const onSyncedRef = useRef(onSynced);
  const onFailedRef = useRef(onFailed);

  useEffect(() => { onSyncedRef.current = onSynced; }, [onSynced]);
  useEffect(() => { onFailedRef.current = onFailed; }, [onFailed]);

  // Subscribe to queue changes (cross-tab + same-tab)
  useEffect(() => subscribeToScanQueue((next) => setQueue(next)), []);

  // Online/offline events
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  const drain = useCallback(async () => {
    if (!online) return;
    await drainScanQueue({
      onItemResult: (item, response, error) => {
        if (response) onSyncedRef.current?.(item, response);
        if (error) onFailedRef.current?.(item, error);
      },
    });
  }, [online]);

  // Drain whenever online flips true OR tab regains focus
  useEffect(() => { drain(); }, [drain, online]);
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onVis = () => { if (!document.hidden) drain(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [drain]);

  // Periodic poll — covers cases where online event didn't fire (some
  // captive portals re-route silently) or where a 5xx wants a retry.
  useEffect(() => {
    const t = setInterval(drain, POLL_MS);
    return () => clearInterval(t);
  }, [drain]);

  const enqueue = useCallback(({ requestId, payload }) => {
    const item = enqueueScan({ requestId, payload });
    // Try immediately so the common case (online) feels synchronous.
    drain();
    return item;
  }, [drain]);

  const retry = useCallback(() => {
    retryFailedScans();
    drain();
  }, [drain]);

  const dropFailed = useCallback((id) => removeScan(id), []);

  const pendingCount = queue.filter((it) => it.state === 'pending').length;
  const failedCount = queue.filter((it) => it.state === 'failed').length;

  return {
    online,
    queue,
    pendingCount,
    failedCount,
    enqueueScan: enqueue,
    retryFailed: retry,
    dropFailed,
    drainNow: drain,
  };
};
