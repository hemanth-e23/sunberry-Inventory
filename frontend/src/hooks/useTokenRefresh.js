import { useEffect, useRef, useCallback } from 'react';

const REFRESH_BEFORE_MS = 10 * 60 * 1000; // attempt refresh 10 min before expiry
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000]; // 3 retries, then give up

function getTokenExpiry(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp * 1000; // convert seconds to ms
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Silently refreshes the JWT token before it expires.
 * - Schedules a refresh 10 minutes before token expiry.
 * - On failed refresh, retries 3 times with backoff (2s / 5s / 15s).
 * - On final failure (or token already expired), calls onExpired().
 * - On success, reschedules for the new token.
 */
export const useTokenRefresh = (isAuthenticated, onRefresh, onExpired) => {
  const timerRef = useRef(null);
  const onRefreshRef = useRef(onRefresh);
  const onExpiredRef = useRef(onExpired);
  const scheduleRef = useRef(null);

  useEffect(() => { onRefreshRef.current = onRefresh; }, [onRefresh]);
  useEffect(() => { onExpiredRef.current = onExpired; }, [onExpired]);

  const tryRefreshWithRetry = useCallback(async () => {
    // First attempt + retries
    if (await onRefreshRef.current()) return true;
    for (const delay of RETRY_DELAYS_MS) {
      await sleep(delay);
      if (await onRefreshRef.current()) return true;
    }
    return false;
  }, []);

  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    const token = localStorage.getItem('token');
    if (!token) return;

    const expiresAt = getTokenExpiry(token);
    if (!expiresAt) return;

    const msUntilExpiry = expiresAt - Date.now();

    if (msUntilExpiry <= 0) {
      onExpiredRef.current();
      return;
    }

    // Fire 10 min before expiry (or immediately if less than 10 min left)
    const delay = Math.max(0, msUntilExpiry - REFRESH_BEFORE_MS);

    timerRef.current = setTimeout(async () => {
      const success = await tryRefreshWithRetry();
      if (success) {
        scheduleRef.current?.();
      } else {
        onExpiredRef.current();
      }
    }, delay);
  }, [tryRefreshWithRetry]);

  scheduleRef.current = schedule;

  useEffect(() => {
    if (isAuthenticated) {
      schedule();
    } else {
      if (timerRef.current) clearTimeout(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isAuthenticated, schedule]);
};
