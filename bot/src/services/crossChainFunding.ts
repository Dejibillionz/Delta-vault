/**
 * Cross-Chain Funding Aggregator
 * Collects funding rates from multiple chains (Solana/Drift, Arbitrum/GMX).
 */

import { DriftClient } from "@drift-labs/sdk";
import { Connection } from "@solana/web3.js";
import { Logger } from "../logger";

// Mock GMX funding rates (replace with real GMX SDK/API)
async function getGmxFunding(): Promise<{ BTC: number; ETH: number }> {
  // GMX funding rates are typically in basis points per hour
  // Mocking higher rates on Arbitrum for demo
  return {
    BTC: 0.00015, // 0.015% per hour
    ETH: 0.00012, // 0.012% per hour
  };
}

// Drift funding rates (existing)
async function getDriftFunding(driftClient: DriftClient): Promise<{ BTC: number; ETH: number }> {
  const marketIndex = { BTC: 1, ETH: 2 };
  const rates: { BTC: number; ETH: number } = { BTC: 0, ETH: 0 };

  for (const [asset, idx] of Object.entries(marketIndex)) {
    const market = driftClient.getPerpMarketAccount(idx);
    if (market) {
      const rate = market.amm.lastFundingRate.toNumber() / 1e6; // convert from PRICE_PRECISION
      rates[asset as "BTC" | "ETH"] = rate;
    }
  }

  return rates;
}

function normalizeDriftFunding(raw: number): number {
  return raw / 1e6; // try this first
}

function sanitizeFunding(rate: number): number {
  // clamp extreme values
  return Math.max(Math.min(rate, 0.01), -0.01);
}

function normalizeFunding(raw: number): number {
  return sanitizeFunding(normalizeDriftFunding(raw));
}

export async function getCrossChainFunding(driftClient: DriftClient, logger: Logger): Promise<{
  solana: { BTC: number; ETH: number };
  arbitrum: { BTC: number; ETH: number };
}> {
  try {
    const [solanaRaw, arbitrumRaw] = await Promise.all([
      getDriftFunding(driftClient),
      getGmxFunding(),
    ]);

    // Log raw values for debugging
    logger.info(`RAW Drift funding: ${JSON.stringify(solanaRaw)}`);
    logger.info(`RAW GMX funding: ${JSON.stringify(arbitrumRaw)}`);

    // Normalize funding rates
    const solana = {
      BTC: normalizeFunding(solanaRaw.BTC),
      ETH: normalizeFunding(solanaRaw.ETH),
    };
    const arbitrum = {
      BTC: normalizeFunding(arbitrumRaw.BTC),
      ETH: normalizeFunding(arbitrumRaw.ETH),
    };

    logger.info(`Cross-chain funding: Solana=${JSON.stringify(solana)}, Arbitrum=${JSON.stringify(arbitrum)}`);
    return { solana, arbitrum };
  } catch (err: any) {
    logger.error(`getCrossChainFunding: ${err.message}`);
    return { solana: { BTC: 0, ETH: 0 }, arbitrum: { BTC: 0, ETH: 0 } };
  }
}
