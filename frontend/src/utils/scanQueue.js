// Offline-resilient scan queue for the forklift scanner.
//
// Each enqueued item carries a client-generated idempotency_key the backend
// uses to dedupe retries. Items survive tab reload + auth refresh.
//
// Persistence: localStorage. Items are small JSON; no need for IndexedDB.
//
// Lifecycle of a queue item:
//   pending        → in localStorage, not yet flushed
//   syncing        → drain() in flight (transient, not persisted)
//   synced         → removed from queue once server confirms
//   failed         → persisted with lastError; no auto-retry until manually
//                    retried (e.g., 4xx returned by server, like a closed
//                    forklift session)
//
// Network errors (no response, 5xx, 408, 429) are retryable: item stays
// `pending` and the next drain pass will try again.

import apiClient from '../api/client';

const STORAGE_KEY = 'sunberry-scan-queue-v1';
const EVENT_NAME = 'sunberry-scan-queue:change';

const isBrowser = () => typeof window !== 'undefined';

const safeRandomId = () => {
  if (isBrowser() && window.crypto?.randomUUID) {
    return window.crypto.randomUUID().replace(/-/g, '');
  }
  // Fallback (older browsers): time + random
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 18)}`;
};

const readAll = () => {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

const writeAll = (items) => {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    window.dispatchEvent(new CustomEvent(EVENT_NAME));
  } catch {
    // localStorage quota or disabled — surface via a no-op; UI will see
    // the original array on next read attempt.
  }
};

export const listScans = () => readAll();

export const subscribeToScanQueue = (cb) => {
  if (!isBrowser()) return () => {};
  const onLocal = () => cb(readAll());
  // 'storage' fires across tabs; our custom event covers same-tab.
  const onStorage = (e) => { if (e.key === STORAGE_KEY) cb(readAll()); };
  window.addEventListener(EVENT_NAME, onLocal);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT_NAME, onLocal);
    window.removeEventListener('storage', onStorage);
  };
};

/**
 * Enqueue a scan request. Returns the queue item (with idempotency_key).
 * The caller can use idempotency_key as a stable handle to find the entry
 * later (e.g., for optimistic UI updates).
 *
 * `idempotencyKey` is optional and reuses a key from an earlier attempt. The
 * "row is full" confirm re-sends the same scan with the driver's answer on it;
 * carrying the original key keeps that a replay rather than a second pallet if
 * the first attempt actually landed and only its response was lost.
 */
export const enqueueScan = ({ requestId, payload, idempotencyKey }) => {
  const item = {
    id: safeRandomId(),
    idempotency_key: idempotencyKey || safeRandomId(),
    requestId,
    payload,
    addedAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
    state: 'pending', // pending | failed
  };
  const items = readAll();
  items.push(item);
  writeAll(items);
  return item;
};

export const removeScan = (id) => {
  const items = readAll().filter((it) => it.id !== id);
  writeAll(items);
};

export const updateScan = (id, patch) => {
  const items = readAll().map((it) => (it.id === id ? { ...it, ...patch } : it));
  writeAll(items);
};

export const retryFailedScans = () => {
  const items = readAll().map((it) => (
    it.state === 'failed' ? { ...it, state: 'pending', lastError: null } : it
  ));
  writeAll(items);
};

const isRetryableError = (err) => {
  if (!err) return true;
  if (!err.response) return true; // network / CORS / aborted
  const s = err.response.status;
  if (s >= 500) return true;
  if (s === 408 || s === 429) return true;
  return false;
};

let drainInFlight = false;

/**
 * Try to flush every pending item in order. Returns a summary:
 *   { sent: [{item, response}], failed: [{item, error}], remaining: number }
 * onItemResult is called per item with (item, result | null, error | null).
 */
export const drainScanQueue = async ({ onItemResult } = {}) => {
  if (drainInFlight) return { sent: [], failed: [], remaining: readAll().filter(i => i.state === 'pending').length };
  drainInFlight = true;

  const sent = [];
  const failed = [];

  try {
    while (true) {
      const items = readAll();
      const next = items.find((it) => it.state === 'pending');
      if (!next) break;

      // Mark attempts in storage so retries are auditable
      updateScan(next.id, { attempts: (next.attempts || 0) + 1 });

      try {
        const resp = await apiClient.post(
          `/scanner/requests/${next.requestId}/scan`,
          { ...next.payload, idempotency_key: next.idempotency_key },
        );
        sent.push({ item: next, response: resp.data });
        removeScan(next.id);
        onItemResult?.(next, resp.data, null);
      } catch (err) {
        if (isRetryableError(err)) {
          // Stop draining — likely offline. Leave the item pending; the
          // auto-drain on next online tick will pick it back up.
          updateScan(next.id, { lastError: err.message || 'Network error' });
          onItemResult?.(next, null, err);
          break;
        }
        // Terminal error — server rejected (e.g., session closed, validation).
        // Park the item as failed so the operator can decide what to do.
        updateScan(next.id, {
          state: 'failed',
          lastError: err.response?.data?.detail || err.message || 'Server error',
        });
        failed.push({ item: next, error: err });
        onItemResult?.(next, null, err);
      }
    }
  } finally {
    drainInFlight = false;
  }

  const remaining = readAll().filter((i) => i.state === 'pending').length;
  return { sent, failed, remaining };
};

/** Drop items belonging to a request id (e.g., when the session is closed). */
export const removeScansForRequest = (requestId) => {
  const items = readAll().filter((it) => it.requestId !== requestId);
  writeAll(items);
};

/** Wipe everything — for tests or admin use. */
export const clearScanQueue = () => writeAll([]);
