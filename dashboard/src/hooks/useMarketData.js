import { useEffect, useCallback } from "react";
import { useMarketDataContext } from "../contexts/MarketDataContext";

/**
 * Hook to manage market data fetching and updates
 * Handles live API sync from bot and Pyth feeds
 */
export const useMarketData = () => {
  const {
    prices,
    setPrices,
    funding,
    setFunding,
    basis,
    setBasis,
    liquidity,
    setLiquidity,
    conf,
    setConf,
    pythOn,
    setPythOn,
    pythTime,
    setPythTime,
  } = useMarketDataContext();

  // Live sync from bot API (http://localhost:3001)
  const syncBotApi = useCallback(async () => {
    try {
      const res = await fetch("http://localhost:3001", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (data?.prices) {
        setPrices && setPrices({
          BTC: data.prices.BTC ?? prices.BTC,
          ETH: data.prices.ETH ?? prices.ETH,
          SOL: data.prices.SOL ?? prices.SOL,
          JTO: data.prices.JTO ?? prices.JTO,
        });

        if (data.funding) {
          setFunding && setFunding(data.funding);
        }
        if (data.basis) {
          setBasis && setBasis(data.basis);
        }
      }
    } catch (err) {
      // Silently fail on API errors
    }
  }, [prices, setPrices, setFunding, setBasis]);

  // Set up polling
  useEffect(() => {
    syncBotApi();
    const interval = setInterval(syncBotApi, 5000); // Poll every 5s
    return () => clearInterval(interval);
  }, [syncBotApi]);

  return {
    prices,
    funding,
    basis,
    liquidity,
    conf,
    pythOn,
    pythTime,
  };
};
