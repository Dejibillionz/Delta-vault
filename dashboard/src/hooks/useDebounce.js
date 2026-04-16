import { useRef, useCallback, useEffect } from "react";

/**
 * useDebounce - Debounce a callback with optional immediate execution
 * Perfect for batching rapid API updates (market data, funding rates)
 *
 * @param {Function} callback - Function to debounce
 * @param {number} delay - Delay in milliseconds
 * @param {boolean} immediate - Fire immediately on first call
 * @returns {Function} Debounced function
 */
export const useDebounce = (callback, delay = 300, immediate = false) => {
  const timeoutRef = useRef(null);
  const hasRunRef = useRef(false);

  const debounced = useCallback(
    (...args) => {
      // Clear previous timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      // Fire immediately on first call if enabled
      if (immediate && !hasRunRef.current) {
        callback(...args);
        hasRunRef.current = true;
        return;
      }

      // Schedule delayed call
      timeoutRef.current = setTimeout(() => {
        callback(...args);
        hasRunRef.current = false;
      }, delay);
    },
    [callback, delay, immediate]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return debounced;
};

/**
 * useThrottle - Throttle a callback (max once per timeframe)
 * Better than debounce when you need periodic updates
 *
 * @param {Function} callback
 * @param {number} delay
 * @returns {Function} Throttled function
 */
export const useThrottle = (callback, delay = 300) => {
  const lastRunRef = useRef(Date.now());

  const throttled = useCallback(
    (...args) => {
      const now = Date.now();
      if (now - lastRunRef.current >= delay) {
        callback(...args);
        lastRunRef.current = now;
      }
    },
    [callback, delay]
  );

  return throttled;
};
