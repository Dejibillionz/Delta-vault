import { useCallback, useRef, useEffect } from "react";
import { MarketDataContext } from "../contexts/MarketDataContext";

/**
 * Hook for live syncing with bot API
 * Batches updates and handles retry logic
 */
export const useLiveSync = () => {
  const syncAttempts = useRef(0);
  const maxRetries = 3;

  const sync = useCallback(async () => {
    try {
      const res = await fetch("http://localhost:3001", {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      syncAttempts.current = 0; // Reset on success
      return data;
    } catch (err) {
      syncAttempts.current++;
      if (syncAttempts.current < maxRetries) {
        // Retry with backoff
        const delay = Math.min(1000 * Math.pow(2, syncAttempts.current), 5000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return sync();
      }
      return null;
    }
  }, []);

  return { sync, isConnected: syncAttempts.current === 0 };
};

/**
 * Hook for strategy signal evaluation
 * Evaluates funding rates, basis spreads, regime conditions
 */
export const useStrategySignals = ({
  fundingRate,
  fundingThreshold,
  basisSpread,
  basisThreshold,
  capital,
}) => {
  return {
    shouldTradeDeltaNeutral: fundingRate > fundingThreshold,
    shouldTradeBasis: basisSpread > basisThreshold,
    fundingAPR: fundingRate * 365 * 100,
    expectedHourlyPnl: (capital * fundingRate) / 100,
  };
};
