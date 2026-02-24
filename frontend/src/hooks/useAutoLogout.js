import { useEffect, useRef, useCallback } from 'react';

/**
 * Custom hook for auto-logout functionality
 * Logs out user after 30 minutes of inactivity
 * Resets timer on user activity (mouse movement, clicks, keyboard, scroll, etc.)
 * 
 * @param {Function} logout - Logout function from AuthContext
 * @param {boolean} isAuthenticated - Whether user is authenticated
 * @param {number} timeoutMinutes - Timeout in minutes (default: 30)
 */
export const useAutoLogout = (logout, isAuthenticated, timeoutMinutes = 30) => {
  const timeoutRef = useRef(null);
  const lastActivityRef = useRef(Date.now());
  const throttleTimerRef = useRef(null);

  // Clear timeout function
  const clearTimeout = useCallback(() => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  // Reset timer function
  const resetTimer = useCallback(() => {
    clearTimeout();
    
    if (!isAuthenticated || timeoutMinutes == null || timeoutMinutes <= 0) {
      return;
    }

    // Set new timeout
    const timeoutMs = timeoutMinutes * 60 * 1000; // Convert minutes to milliseconds
    lastActivityRef.current = Date.now();
    
    timeoutRef.current = window.setTimeout(() => {
      // Timeout expired - logout user and redirect to login
      logout();
      // Use window.location for navigation since we're outside Router context
      window.location.href = '/login';
    }, timeoutMs);
  }, [isAuthenticated, logout, timeoutMinutes, clearTimeout]);

  // Handle user activity
  const handleActivity = useCallback(() => {
    if (isAuthenticated) {
      resetTimer();
    }
  }, [isAuthenticated, resetTimer]);

  // Setup activity listeners
  useEffect(() => {
    if (!isAuthenticated) {
      clearTimeout();
      return;
    }

    // Initial timer setup
    resetTimer();

    // List of events that indicate user activity
    const events = [
      'mousedown',
      'mousemove',
      'keypress',
      'scroll',
      'touchstart',
      'click',
      'keydown'
    ];

    // Add event listeners with throttling to avoid excessive resets
    const throttledHandleActivity = () => {
      if (throttleTimerRef.current) {
        return;
      }
      
      throttleTimerRef.current = setTimeout(() => {
        handleActivity();
        throttleTimerRef.current = null;
      }, 1000); // Throttle to once per second
    };

    events.forEach(event => {
      document.addEventListener(event, throttledHandleActivity, { passive: true });
    });

    // Also listen for visibility change (tab focus)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isAuthenticated) {
        resetTimer();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Cleanup
    return () => {
      clearTimeout();
      events.forEach(event => {
        document.removeEventListener(event, throttledHandleActivity);
      });
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
    };
  }, [isAuthenticated, resetTimer, handleActivity, clearTimeout]);

  // Reset timer when authentication state changes
  useEffect(() => {
    if (isAuthenticated) {
      resetTimer();
    } else {
      clearTimeout();
    }
  }, [isAuthenticated, resetTimer, clearTimeout]);
};
