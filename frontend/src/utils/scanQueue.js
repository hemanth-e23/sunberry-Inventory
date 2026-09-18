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
// Three kinds of outcome, and they are NOT the same thing:
//
//   transport error (no response at all — offline, DNS, timeout, CORS)
//       The server was never reached. The item stays `pending` and the pass
//       stops: nothing behind it can go through either, so trying is waste.
//
//   server error (5xx / 408 / 429)
//       The server answered, it just could not take THIS item. The item stays
//       `pending` but the pass SKIPS IT AND KEEPS GOING. This matters: one
//       poisoned scan used to freeze every scan queued behind it — the loop
//       broke on the head item every pass, so a driver could put 26 pallets in
//       the queue that would never go, no matter how good the wifi got. After
//       MAX_SERVER_ERROR_ATTEMPTS such attempts the item is parked as `failed`
//       so it becomes visible instead of silently pending forever.
//
//   terminal error (other 4xx — closed session, validation)
//       Parked as `failed` immediately for the operator to resolve.
//
// Connectivity is derived from those outcomes, not from navigator.onLine. On a
// scanner gun navigator.onLine lies (WebView, captive portal, sleep/wake), and
// the queue must never be gated on a flag that can get stuck false — that is
// what made "Sync now" do nothing at all.

import apiClient from '../api/client';

const STORAGE_KEY = 'sunberry-scan-queue-v1';
const EVENT_NAME = 'sunberry-scan-queue:change';
const CONNECTIVITY_EVENT = 'sunberry-scan-queue:connectivity';

// A drain that somehow never settles must not lock the queue for the rest of
// the shift. After this long, a fresh drain is allowed to start anyway.
const DRAIN_STUCK_MS = 90000;

// How many times a server error (5xx/408/429) may hold an item pending before
// it is parked as failed. Transport errors never count toward this — a gun off
// the network for a whole shift must not poison its own queue.
const MAX_SERVER_ERROR_ATTEMPTS = 8;

// Back-off for the BACKGROUND poll only, indexed by consecutive passes that
// could not reach the server at all. A gun that cannot resolve the API host was
// hammering it every 8s — over a thousand attempts in an afternoon, which is
// both pointless and a good way to get an IP rate-limited by the edge. Anything
// a human does (Sync now, opening the app, a fresh scan) still tries instantly:
// this throttles waiting, never acting.
const TRANSPORT_BACKOFF_MS = [8000, 8000, 16000, 30000, 60000];

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

// ─── Connectivity, measured rather than assumed ──────────────────────────────
//
//   reachable   true  — the server answered our last attempt (even with a 4xx)
//               false — the last attempt never reached it
//               null  — nothing has been attempted yet; caller should fall back
//                       to navigator.onLine
//   syncing     a drain pass is running right now
//   lastError   why the last attempt failed, for the operator to read

let connectivity = {
  reachable: null,
  syncing: false,
  lastAttemptAt: null,
  lastError: null,
  retryDelayMs: 0,
};

export const getConnectivity = () => connectivity;

const setConnectivity = (patch) => {
  connectivity = { ...connectivity, ...patch };
  if (isBrowser()) window.dispatchEvent(new CustomEvent(CONNECTIVITY_EVENT));
};

export const subscribeToConnectivity = (cb) => {
  if (!isBrowser()) return () => {};
  const onChange = () => cb(connectivity);
  window.addEventListener(CONNECTIVITY_EVENT, onChange);
  return () => window.removeEventListener(CONNECTIVITY_EVENT, onChange);
};

/**
 * Enqueue a scan request. Returns the queue item (with idempotency_key).
 * The caller can use idempotency_key as a stable handle to find the entry
 * later (e.g., for optimistic UI updates).
 *
 * `endpoint` is optional and defaults to the forklift pallet-scan path, so every
 * pre-existing caller is unchanged. Ingredient container scans pass their own
 * path. Keeping ONE queue (one storage key, one retry policy, one drain loop) is
 * what makes the "device dies mid-session, any device resumes" guarantee hold
 * across both flows — a second queue would need all of that duplicated and kept
 * in sync.
 *
 * `idempotencyKey` is optional and reuses a key from an earlier attempt. The
 * "row is full" confirm re-sends the same scan with the driver's answer on it;
 * carrying the original key keeps that a replay rather than a second pallet if
 * the first attempt actually landed and only its response was lost.
 */
export const enqueueScan = ({ requestId, payload, endpoint, idempotencyKey }) => {
  const item = {
    id: safeRandomId(),
    idempotency_key: idempotencyKey || safeRandomId(),
    requestId,
    endpoint: endpoint || null,
    payload,
    addedAt: new Date().toISOString(),
    attempts: 0,
    serverErrors: 0,
    lastAttemptAt: null,
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
    it.state === 'failed'
      ? { ...it, state: 'pending', lastError: null, serverErrors: 0 }
      : it
  ));
  writeAll(items);
};

/** No response at all: offline, DNS, timeout, CORS. The server was not reached. */
const isTransportError = (err) => !err || !err.response;

/** Server answered but wants us to try again later. */
const isServerError = (err) => {
  const s = err?.response?.status;
  return s >= 500 || s === 408 || s === 429;
};

const errorText = (err) => (
  err?.response?.data?.detail || err?.message || 'Unknown error'
);

// A callback from the UI must never be able to abort the drain — a throw in a
// React state updater used to take the rest of the queue down with it.
const safeCallback = (cb, ...cbArgs) => {
  try {
    cb?.(...cbArgs);
  } catch {
    /* the queue's job is to flush; UI bookkeeping failures are not fatal */
  }
};

let drainInFlight = false;
let drainStartedAt = 0;
let consecutiveUnreachable = 0;
let nextPollAllowedAt = 0;

/**
 * Try to flush every pending item. Returns a summary:
 *   { sent, failed, skipped, remaining, reachable, lastError }
 * onItemResult is called per item with (item, result | null, error | null).
 *
 * Deliberately NOT gated on navigator.onLine — the attempt itself is the
 * connectivity check, and it fails in milliseconds when there is no network.
 *
 * `force` bypasses the transport back-off. Pass it for anything a person did.
 */
export const drainScanQueue = async ({ onItemResult, force = false } = {}) => {
  const pendingCount = () => readAll().filter((i) => i.state === 'pending').length;

  if (!force && Date.now() < nextPollAllowedAt) {
    return {
      sent: [],
      failed: [],
      skipped: 0,
      remaining: pendingCount(),
      reachable: connectivity.reachable,
      lastError: connectivity.lastError,
      backedOff: true,
    };
  }

  if (drainInFlight && Date.now() - drainStartedAt < DRAIN_STUCK_MS) {
    return {
      sent: [],
      failed: [],
      skipped: 0,
      remaining: pendingCount(),
      reachable: connectivity.reachable,
      lastError: connectivity.lastError,
      alreadyRunning: true,
    };
  }

  drainInFlight = true;
  drainStartedAt = Date.now();
  setConnectivity({ syncing: true });

  const sent = [];
  const failed = [];
  // Items tried in THIS pass. A skipped item stays pending, so without this the
  // loop would pick it up again immediately and spin forever.
  const attempted = new Set();
  let skipped = 0;
  let reachable = connectivity.reachable;
  let lastError = null;

  try {
    while (true) {
      const items = readAll();
      const next = items.find((it) => it.state === 'pending' && !attempted.has(it.id));
      if (!next) break;
      attempted.add(next.id);

      // Mark attempts in storage so retries are auditable
      updateScan(next.id, {
        attempts: (next.attempts || 0) + 1,
        lastAttemptAt: new Date().toISOString(),
      });

      try {
        // Items enqueued before `endpoint` existed have it null/undefined and
        // fall back to the forklift pallet-scan path they were queued for.
        const resp = await apiClient.post(
          next.endpoint || `/scanner/requests/${next.requestId}/scan`,
          { ...next.payload, idempotency_key: next.idempotency_key },
        );
        reachable = true;
        lastError = null;
        sent.push({ item: next, response: resp.data });
        removeScan(next.id);
        safeCallback(onItemResult, next, resp.data, null);
        continue;
      } catch (err) {
        lastError = errorText(err);

        if (isTransportError(err)) {
          // Server never answered — everything behind this item would fail the
          // same way. Stop the pass; the item stays pending for the next one.
          reachable = false;
          updateScan(next.id, { lastError });
          safeCallback(onItemResult, next, null, err);
          break;
        }

        // From here on the server DID answer, so the network itself is fine.
        reachable = true;

        if (isServerError(err)) {
          const serverErrors = (next.serverErrors || 0) + 1;
          if (serverErrors >= MAX_SERVER_ERROR_ATTEMPTS) {
            // Stop retrying quietly — park it where the operator can see it.
            updateScan(next.id, {
              state: 'failed',
              serverErrors,
              lastError: `${lastError} (gave up after ${serverErrors} tries)`,
            });
            failed.push({ item: next, error: err });
          } else {
            // Keep it pending, but move on to the rest of the queue. One bad
            // scan must not hold up the 25 good ones behind it.
            updateScan(next.id, { serverErrors, lastError });
            skipped += 1;
          }
          safeCallback(onItemResult, next, null, err);
          continue;
        }

        // Terminal error — server rejected (e.g., session closed, validation).
        // Park the item as failed so the operator can decide what to do.
        updateScan(next.id, { state: 'failed', lastError });
        failed.push({ item: next, error: err });
        safeCallback(onItemResult, next, null, err);
      }
    }
  } finally {
    drainInFlight = false;
    if (reachable === false) {
      // Nothing answered. Slow the background poll down, step by step.
      const step = TRANSPORT_BACKOFF_MS[
        Math.min(consecutiveUnreachable, TRANSPORT_BACKOFF_MS.length - 1)
      ];
      consecutiveUnreachable += 1;
      nextPollAllowedAt = Date.now() + step;
    } else if (reachable === true) {
      // The server spoke to us — back to full speed immediately.
      consecutiveUnreachable = 0;
      nextPollAllowedAt = 0;
    }
    setConnectivity({
      syncing: false,
      reachable,
      lastAttemptAt: new Date().toISOString(),
      lastError,
      retryDelayMs: reachable === false
        ? TRANSPORT_BACKOFF_MS[
          Math.min(consecutiveUnreachable - 1, TRANSPORT_BACKOFF_MS.length - 1)
        ]
        : 0,
    });
  }

  return {
    sent,
    failed,
    skipped,
    remaining: pendingCount(),
    reachable,
    lastError,
  };
};

/** Drop items belonging to a request id (e.g., when the session is closed). */
export const removeScansForRequest = (requestId) => {
  const items = readAll().filter((it) => it.requestId !== requestId);
  writeAll(items);
};

/** Wipe everything — for tests or admin use. */
export const clearScanQueue = () => writeAll([]);

/** Reset module-level state between tests. */
export const __resetScanQueueForTests = () => {
  drainInFlight = false;
  drainStartedAt = 0;
  consecutiveUnreachable = 0;
  nextPollAllowedAt = 0;
  connectivity = {
    reachable: null, syncing: false, lastAttemptAt: null, lastError: null, retryDelayMs: 0,
  };
  writeAll([]);
};
