import { useEffect, useRef, useCallback } from 'react';

/**
 * Auto-logout after `timeoutMinutes` of true inactivity (no mouse / key / touch / scroll).
 * - Real throttle: first activity in a window resets the timer immediately, subsequent
 *   events are ignored for 1s (cheap; reset is the same operation either way).
 * - Activity is tracked by a wall-clock timestamp so a tab going to background
 *   doesn't get a "free" 30 minutes when it returns — we logout if real elapsed
 *   idle exceeded the timeout while hidden.
 * - Disabled when timeoutMinutes is null/0 (used for forklift role).
 */
export const useAutoLogout = (logout, isAuthenticated, timeoutMinutes = 30) => {
  const timerRef = useRef(null);
  const lastActivityRef = useRef(Date.now());
  const logoutRef = useRef(logout);

  useEffect(() => { logoutRef.current = logout; }, [logout]);

  const cancelTimer = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const doLogout = useCallback(() => {
    logoutRef.current?.();
    window.location.href = '/login';
  }, []);

  const armTimer = useCallback((delayMs) => {
    cancelTimer();
    timerRef.current = window.setTimeout(doLogout, delayMs);
  }, [cancelTimer, doLogout]);

  useEffect(() => {
    if (!isAuthenticated || timeoutMinutes == null || timeoutMinutes <= 0) {
      cancelTimer();
      return;
    }

    const timeoutMs = timeoutMinutes * 60 * 1000;

    // Initial arm
    lastActivityRef.current = Date.now();
    armTimer(timeoutMs);

    // Real throttle — reset immediately on the first event in each 1s window
    let throttleUntil = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now < throttleUntil) return;
      throttleUntil = now + 1000;
      lastActivityRef.current = now;
      armTimer(timeoutMs);
    };

    const events = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click', 'keydown'];
    events.forEach((e) => document.addEventListener(e, onActivity, { passive: true }));

    // On tab return: don't grant a fresh 30 min — compute remaining time from
    // last real activity. If we already passed the threshold while hidden, log out.
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      const elapsed = Date.now() - lastActivityRef.current;
      if (elapsed >= timeoutMs) {
        doLogout();
      } else {
        armTimer(timeoutMs - elapsed);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelTimer();
      events.forEach((e) => document.removeEventListener(e, onActivity));
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [isAuthenticated, timeoutMinutes, armTimer, cancelTimer, doLogout]);
};
