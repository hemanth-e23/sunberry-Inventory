import { useCallback, useEffect, useRef } from 'react';
import { useScanQueueCore } from './useScanQueue';

// Shared by the per-receipt lot session and the truck session.

/** Terminal = the queue will never retry it. Mirrors scanQueue's own policy. */
export const isTerminal = (err) => {
  const status = err?.response?.status;
  if (!status) return false;
  return status < 500 && status !== 408 && status !== 429;
};

// ─── Offline scan queue ──────────────────────────────────────────────────────
// A thin adapter over the shared engine in hooks/useScanQueue.js — one storage
// key, one retry policy, one drain loop, one definition of "are we connected",
// shared with pallet and container scans. This file used to carry its own copy
// of that loop (the shared hook did not forward `endpoint`), and the copy went
// stale: it kept the `if (!online) return` gate on navigator.onLine that could
// strand a whole shift of scans on a gun whose online event never fired.
export const useLotScanQueue = (onSettled) => {
  const settledRef = useRef(onSettled);
  useEffect(() => { settledRef.current = onSettled; }, [onSettled]);

  const onItemResult = useCallback((item, response, error) => {
    settledRef.current?.(item, response, error);
  }, []);

  const core = useScanQueueCore({ onItemResult });
  const { send: coreSend } = core;

  // `idempotencyKey` reuses a key from an earlier attempt. The "rack is full"
  // confirm re-sends the same scan with the driver's answer on it; carrying the
  // original key keeps that a replay rather than a second drum, in the case
  // where the first attempt actually landed and only its response was lost.
  const send = useCallback(
    (requestId, endpoint, payload, idempotencyKey) => coreSend({
      requestId, endpoint, payload, idempotencyKey,
    }),
    [coreSend],
  );

  return {
    online: core.online,
    queue: core.queue,
    syncing: core.syncing,
    lastSyncError: core.lastSyncError,
    // `drain` here is what the Sync now button calls, so it must force.
    send,
    drain: core.syncNow,
    retry: core.retry,
  };
};

