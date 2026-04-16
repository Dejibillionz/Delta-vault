import { useEffect, useCallback, useRef } from "react";
import { useMarketDataContext } from "../contexts/MarketDataContext";
import { useDebounce } from "./useDebounce";

/**
 * Optimized market data hook with debouncing
 * Batches updates: instead of updating every 2.5s,
 * batches them every 5s to reduce re-renders by 50%
 */
export const useMarketDataWithDebounce = (batchIntervalMs = 5000) => {
  const context = useMarketDataContext();
  const batchRef = useRef({
    prices: null,
    funding: null,
    basis: null,
  });
  const pendingRef = useRef(false);

  // Debounced batch apply
  const applyBatch = useDebounce(
    () => {
      if (batchRef.current.prices) {
        context.setPrices(batchRef.current.prices);
        batchRef.current.prices = null;
      }
      if (batchRef.current.funding) {
        context.setFunding(batchRef.current.funding);
        batchRef.current.funding = null;
      }
      if (batchRef.current.basis) {
        context.setBasis(batchRef.current.basis);
        batchRef.current.basis = null;
      }
      pendingRef.current = false;
    },
    batchIntervalMs,
    false
  );

  // Queue updates into batch
  const updateMarketData = useCallback(
    (prices, funding, basis) => {
      batchRef.current = { prices, funding, basis };
      if (!pendingRef.current) {
        pendingRef.current = true;
        applyBatch();
      }
    },
    [applyBatch]
  );

  // Fetch from bot API and batch
  useEffect(() => {
    const fetchBotData = async () => {
      try {
        const res = await fetch("http://localhost:3001", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();

        if (data?.prices) {
          updateMarketData(
            {
              BTC: data.prices.BTC ?? context.prices.BTC,
              ETH: data.prices.ETH ?? context.prices.ETH,
              SOL: data.prices.SOL ?? context.prices.SOL,
              JTO: data.prices.JTO ?? context.prices.JTO,
            },
            data.funding || context.funding,
            data.basis || context.basis
          );
        }
      } catch (err) {
        // Silently fail
      }
    };

    fetchBotData();
    const interval = setInterval(fetchBotData, batchIntervalMs);
    return () => clearInterval(interval);
  }, [context, updateMarketData, batchIntervalMs]);

  return {
    prices: context.prices,
    funding: context.funding,
    basis: context.basis,
    liquidity: context.liquidity,
    conf: context.conf,
  };
};
