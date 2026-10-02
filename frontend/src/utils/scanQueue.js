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
//   gateway down (502 / 503 / 504)
//       A proxy answered for a server that is not there. Treated exactly like a
//       transport error: stop the pass, keep the item pending.
//
//   server error (other 5xx / 408 / 429)
//       The server (or a dev proxy standing in for a dead one — Vite answers a
//       plain 500) could not take THIS item. The item stays `pending` but the
//       pass SKIPS IT AND KEEPS GOING. This matters: one poisoned scan used to
//       freeze every scan queued behind it. If the server was already known to
//       be unreachable the pass stops instead — every item would get the same.
//       Such an item is NEVER parked as failed (it used to be, after 8 tries —
//       about a minute of outage — which made a worker's scans look lost, P05).
//       It backs off on its own instead, and comes straight back the moment
//       anything gets through.
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

// Per-item back-off after a server error, for the BACKGROUND poll only and
// only while the server is otherwise answering (a poisoned item must not be
// hammered every 8 seconds all shift). Capped, never a give-up.
const ITEM_BACKOFF_MS = [8000, 16000, 30000, 60000, 120000, 300000];
export const itemBackoffMs = (serverErrors) => ITEM_BACKOFF_MS[
  Math.min(Math.max(0, (serverErrors || 1) - 1), ITEM_BACKOFF_MS.length - 1)
];

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

/**
 * A failed item that only failed because the server was not answering — never
 * one the server REFUSED (4xx). Those come back on their own; only a refusal
 * needs a person. Items parked by the old "gave up after N tries" rule are
 * recognised by their text so a gun upgraded mid-outage recovers too.
 */
const isRevivable = (it) => it.state === 'failed'
  && (it.failKind === 'server' || /gave up after \d+ tries/.test(it.lastError || ''));

export const reviveServerFailures = () => {
  const items = readAll();
  if (!items.some(isRevivable)) return 0;
  let n = 0;
  writeAll(items.map((it) => {
    if (!isRevivable(it)) return it;
    n += 1;
    return { ...it, state: 'pending', failKind: null, serverErrors: 0, nextAttemptAt: null };
  }));
  return n;
};

export const retryFailedScans = () => {
  const items = readAll().map((it) => (
    it.state === 'failed'
      ? { ...it, state: 'pending', lastError: null, serverErrors: 0, nextAttemptAt: null }
      : it
  ));
  writeAll(items);
};

/** No response at all: offline, DNS, timeout, CORS. The server was not reached. */
const isTransportError = (err) => !err || !err.response;

/** A proxy answering for a server that is not there. */
const isGatewayDown = (err) => [502, 503, 504].includes(err?.response?.status);

/**
 * "The gun cannot reach the server", for what the worker is TOLD. A dropped
 * connection and any 5xx read the same on the floor: the tester's outage (the
 * backend stopped behind the dev proxy) came back as 500s, and the screen said
 * "Request failed with status code 500" with no truck on it (P08).
 */
export const isUnreachableError = (err) => {
  if (!err) return false;
  if (!err.response) return true;
  return err.response.status >= 500;
};

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
  // Anything held back only by an outage goes again — the worker must never
  // have to find "Retry failed" after the wifi comes back (P09).
  reviveServerFailures();
  const wasUnreachable = connectivity.reachable === false;

  const sent = [];
  const failed = [];
  // Items tried in THIS pass. A skipped item stays pending, so without this the
  // loop would pick it up again immediately and spin forever.
  const attempted = new Set();
  let skipped = 0;
  let reachable = connectivity.reachable;
  let lastError = null;
  let anySent = false;
  let anyAnswered = false; // the server itself spoke (2xx or a 4xx refusal)
  let anyDown = false;     // something said "cannot reach" (transport / 5xx)

  try {
    while (true) {
      const items = readAll();
      // An item in its own back-off waits for the background poll — unless a
      // person asked, or the server was down and this is the pass that finds
      // out whether it is back (then everything goes, in order).
      const now = Date.now();
      const due = (it) => force || wasUnreachable || anySent
        || !it.nextAttemptAt || it.nextAttemptAt <= now;
      const next = items.find((it) => it.state === 'pending' && !attempted.has(it.id) && due(it));
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
        anySent = true;
        anyAnswered = true;
        lastError = null;
        sent.push({ item: next, response: resp.data });
        removeScan(next.id);
        safeCallback(onItemResult, next, resp.data, null);
        continue;
      } catch (err) {
        lastError = errorText(err);

        if (isTransportError(err) || isGatewayDown(err)) {
          // Server never answered — everything behind this item would fail the
          // same way. Stop the pass; the item stays pending for the next one.
          if (isTransportError(err)) lastError = 'Cannot reach the server (no connection)';
          reachable = false;
          anyDown = true;
          updateScan(next.id, { lastError });
          safeCallback(onItemResult, next, null, err);
          break;
        }

        if (isServerError(err)) {
          // Keep it pending — never give up on it — but move on to the rest of
          // the queue. One bad scan must not hold up the 25 good ones behind it.
          const serverErrors = (next.serverErrors || 0) + 1;
          if (err?.response?.status >= 500) anyDown = true;
          updateScan(next.id, {
            serverErrors,
            lastError,
            nextAttemptAt: Date.now() + itemBackoffMs(serverErrors),
          });
          skipped += 1;
          safeCallback(onItemResult, next, null, err);
          // Already known to be down and still down: the rest would get the
          // same answer. Stop rather than walk the whole queue every pass.
          if (wasUnreachable && !anyAnswered) break;
          continue;
        }

        // From here on the server itself answered, so it is reachable.
        reachable = true;
        anyAnswered = true;

        // Terminal error — server rejected (e.g., session closed, validation).
        // Park the item as failed so the operator can decide what to do.
        updateScan(next.id, { state: 'failed', failKind: 'terminal', lastError });
        failed.push({ item: next, error: err });
        safeCallback(onItemResult, next, null, err);
      }
    }
  } finally {
    drainInFlight = false;
    // Nothing got through and something said "down": unreachable, as far as the
    // worker is concerned, even if a proxy technically answered.
    if (anyDown && !anyAnswered) reachable = false;
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

/**
 * Something other than the queue learned whether the server is there — a direct
 * call (load the truck, remove a scan, finish) failing or succeeding. Feeds the
 * same connectivity the header and the OFFLINE banner read, so a remove that
 * could not reach the server turns the screen offline at once.
 */
export const noteReachability = (reachable, lastError = null) => {
  if (reachable) {
    if (connectivity.reachable === true) return;
    consecutiveUnreachable = 0;
    nextPollAllowedAt = 0;
    setConnectivity({ reachable: true, lastError: null, retryDelayMs: 0 });
  } else {
    setConnectivity({
      reachable: false,
      lastError: lastError || connectivity.lastError || 'Cannot reach the server',
    });
  }
};

/**
 * With nothing queued, nothing measures the connection — an OFFLINE banner
 * would stay up forever. A cheap GET answers "is it back?".
 */
export const probeServer = async () => {
  try {
    await apiClient.get('/health', { timeout: 8000 });
    noteReachability(true);
    return true;
  } catch (err) {
    if (isUnreachableError(err)) {
      noteReachability(false);
      return false;
    }
    // Any other answer (401, 404…) means a server is there.
    noteReachability(true);
    return true;
  }
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
