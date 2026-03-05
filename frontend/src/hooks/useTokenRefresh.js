import { useEffect, useRef, useCallback } from 'react';

const REFRESH_BEFORE_MS = 10 * 60 * 1000; // attempt refresh 10 min before expiry

function getTokenExpiry(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp * 1000; // convert seconds to ms
  } catch {
    return null;
  }
}

/**
 * Silently refreshes the JWT token before it expires.
 * - Schedules a refresh 10 minutes before token expiry.
 * - On successful refresh: reschedules for the new token.
 * - On failed refresh (token already expired): calls onExpired().
 *
 * @param {boolean} isAuthenticated
 * @param {Function} onRefresh - async fn that refreshes the token, returns true/false
 * @param {Function} onExpired - called when token is expired and refresh failed
 */
export const useTokenRefresh = (isAuthenticated, onRefresh, onExpired) => {
  const timerRef = useRef(null);
  const onRefreshRef = useRef(onRefresh);
  const onExpiredRef = useRef(onExpired);
  const scheduleRef = useRef(null);

  // Keep refs up to date so callbacks never go stale
  useEffect(() => { onRefreshRef.current = onRefresh; }, [onRefresh]);
  useEffect(() => { onExpiredRef.current = onExpired; }, [onExpired]);

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
      const success = await onRefreshRef.current();
      if (success) {
        scheduleRef.current?.(); // reschedule with the new token
      } else {
        onExpiredRef.current();
      }
    }, delay);
  }, []);

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
