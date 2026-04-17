/**
 * Cross-Chain Funding Aggregator
 * Collects funding rates from multiple venues.
 *
 * Primary:   Hyperliquid REST API (Solana chain entry)
 * Secondary: Binance Futures + Bybit Linear (real CEX data via CexFundingRates)
 *
 * Chain → venue mapping:
 *   solana             → Hyperliquid (real)
 *   bnb                → Binance Futures (real)
 *   arbitrum / base
 *   / optimism         → Bybit Linear (real — used as a liquid altchain proxy)
 *   polygon / avalanche → zeroed (no meaningful public perp API)
 */

import { HyperliquidExecutor } from "./hyperliquidExecution";
import { CexFundingRates } from "./cexFundingRates";
import { Logger } from "../logger";
import { CROSS_CHAIN_CONFIG } from "../config/crossChain";

type FundingByAsset = Record<string, number>;
type FundingByChain = Record<string, FundingByAsset>;

// ── Venue mapping ─────────────────────────────────────────────────────────────

type CexVenue = "binance" | "bybit" | null;

function chainToVenue(chain: string): CexVenue {
  if (chain === "bnb")                                   return "binance";
  if (["arbitrum", "base", "optimism"].includes(chain))  return "bybit";
  return null;   // polygon / avalanche → no real data → return zeros
}

function sanitizeFunding(rate: number): number {
  return Math.max(Math.min(rate, 0.005), -0.005);
}

/** Build per-asset funding map for a given chain using real CEX data. */
function cexChainFunding(
  cexRates: CexFundingRates,
  chain: string,
  assets: string[]
): FundingByAsset {
  const venue = chainToVenue(chain);
  const result: FundingByAsset = {};
  for (const asset of assets) {
    result[asset] = venue ? sanitizeFunding(cexRates.getRate(asset, venue)) : 0;
  }
  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getCrossChainFunding(
  hlExecutor: HyperliquidExecutor,
  logger: Logger,
  cexRates?: CexFundingRates,
  assets: string[] = (process.env.TRADING_ASSETS ?? "BTC,ETH,SOL,JTO").split(",").map(a => a.trim())
): Promise<FundingByChain> {
  try {
    // 1. Primary: Hyperliquid funding rates (Solana entry)
    const hlRates = await hlExecutor.getAllFundingRates();
    const solana: FundingByAsset = {};
    for (const asset of assets) {
      solana[asset] = sanitizeFunding(hlRates[asset] ?? 0);
    }

    // 2. Refresh CEX rates (cached internally — 2 min TTL)
    if (cexRates) await cexRates.refresh();

    // 3. Build non-Solana chain entries
    const nonSolana = CROSS_CHAIN_CONFIG.CHAINS.filter(chain => chain !== "solana");
    const nonSolanaMap: FundingByChain = {};
    for (const chain of nonSolana) {
      nonSolanaMap[chain] = cexRates
        ? cexChainFunding(cexRates, chain, assets)
        : Object.fromEntries(assets.map(a => [a, 0]));
    }

    logger.info(`[CrossChain] HL funding: ${JSON.stringify(solana)}`);

    return { solana, ...nonSolanaMap };
  } catch (err: any) {
    logger.error(`getCrossChainFunding: ${err.message}`);
    const fallback: FundingByChain = {};
    for (const chain of CROSS_CHAIN_CONFIG.CHAINS) {
      fallback[chain] = Object.fromEntries(assets.map(a => [a, 0]));
    }
    return fallback;
  }
}
