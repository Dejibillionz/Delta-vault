import { useEffect, useCallback } from "react";
import { useMarketDataContext } from "../contexts/MarketDataContext";

const PYTH_HERMES = "https://hermes.pyth.network/v2/updates/price/latest";
const PYTH_IDS = {
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
};

/**
 * Hook for Pyth price feed polling
 * Fetches live BTC/ETH prices from Pyth Hermes
 */
export const usePythFeed = () => {
  const { setPrices, setConf, setPythOn, setPythTime } = useMarketDataContext();

  const fetchPyth = useCallback(async () => {
    try {
      const resp = await fetch(PYTH_HERMES);
      const json = await resp.json();
      const out = {};

      for (const [asset, id] of Object.entries(PYTH_IDS)) {
        const item = json.parsed?.data?.find(
          (p: any) => p.id === id
        );
        if (!item) continue;

        const e = item.price.expo;
        out[asset] = {
          price: item.price.price * 10 ** e,
          conf: item.price.conf * 10 ** e,
        };
      }

      if (Object.keys(out).length > 0) {
        setPrices?.((p: any) => ({
          BTC: out.BTC?.price ?? p.BTC,
          ETH: out.ETH?.price ?? p.ETH,
        }));
        setConf?.({
          BTC: out.BTC?.conf ?? 0,
          ETH: out.ETH?.conf ?? 0,
        });
        setPythOn?.(true);
        setPythTime?.(new Date().toTimeString().slice(0, 8));
      }
    } catch (err) {
      // Silently fail on Pyth errors
    }
  }, [setPrices, setConf, setPythOn, setPythTime]);

  // Poll Pyth every 12 seconds
  useEffect(() => {
    fetchPyth();
    const interval = setInterval(fetchPyth, 12000);
    return () => clearInterval(interval);
  }, [fetchPyth]);
};
