/**
 * Cross-Chain Funding Aggregator
 * Collects funding rates from multiple chains (Solana/Drift, Arbitrum/GMX).
 */

import { DriftClient } from "@drift-labs/sdk";
import { Logger } from "../logger";
import { CROSS_CHAIN_CONFIG } from "../config/crossChain";

type FundingByAsset = { BTC: number; ETH: number };
type FundingByChain = Record<string, FundingByAsset>;

// Mock chain feeds — DEVNET ONLY (returns zero on mainnet to disable cross-chain arb)
async function getMockFunding(chain: string): Promise<FundingByAsset> {
  if (process.env.SOLANA_NETWORK === "mainnet-beta") {
    return { BTC: 0, ETH: 0 };
  }
  const MOCK: Record<string, FundingByAsset> = {
    arbitrum: { BTC: 0.00015, ETH: 0.00012 },
    base: { BTC: 0.00022, ETH: 0.00019 },
    optimism: { BTC: 0.00018, ETH: 0.00016 },
    polygon: { BTC: 0.00011, ETH: 0.00014 },
    avalanche: { BTC: 0.00013, ETH: 0.00010 },
    bnb: { BTC: 0.00020, ETH: 0.00017 },
  };
  return MOCK[chain] ?? { BTC: 0, ETH: 0 };
}

// Drift funding rates (existing)
async function getDriftFunding(driftClient: DriftClient): Promise<FundingByAsset> {
  const marketIndex = { BTC: 1, ETH: 2 };
  const rates: { BTC: number; ETH: number } = { BTC: 0, ETH: 0 };

  for (const [asset, idx] of Object.entries(marketIndex)) {
    const market = driftClient.getPerpMarketAccount(idx);
    if (market) {
      // lastFundingRate is raw integer; convert to decimal funding rate.
      // Equivalent to: convertToNumber(raw, 1e6) / 1e6
      const rate = market.amm.lastFundingRate.toNumber() / 1e12;
      rates[asset as "BTC" | "ETH"] = rate;
    }
  }

  return rates;
}

function normalizeDriftFunding(raw: number): number {
  // Drift rate is already scaled in getDriftFunding(), so do not rescale again.
  return raw;
}

function sanitizeFunding(rate: number): number {
  // clamp extreme values
  return Math.max(Math.min(rate, 0.005), -0.005);
}

function normalizeFunding(raw: number): number {
  return sanitizeFunding(normalizeDriftFunding(raw));
}

export async function getCrossChainFunding(driftClient: DriftClient, logger: Logger): Promise<FundingByChain> {
  try {
    const solanaRaw = await getDriftFunding(driftClient);
    const nonSolanaChains = CROSS_CHAIN_CONFIG.CHAINS.filter(chain => chain !== "solana");

    const mockedRates = await Promise.all(nonSolanaChains.map(chain => getMockFunding(chain)));
    const nonSolanaMap: FundingByChain = {};
    nonSolanaChains.forEach((chain, i) => {
      nonSolanaMap[chain] = mockedRates[i];
    });

    // Log raw values for debugging
    logger.info(`RAW Drift funding: ${JSON.stringify(solanaRaw)}`);
    logger.info(`RAW Non-Solana funding: ${JSON.stringify(nonSolanaMap)}`);

    // Normalize funding rates
    const solana = {
      BTC: normalizeFunding(solanaRaw.BTC),
      ETH: normalizeFunding(solanaRaw.ETH),
    };
    const normalizedOthers: FundingByChain = {};
    for (const [chain, rates] of Object.entries(nonSolanaMap)) {
      normalizedOthers[chain] = {
        BTC: normalizeFunding(rates.BTC),
        ETH: normalizeFunding(rates.ETH),
      };
    }

    const fundingByChain: FundingByChain = {
      solana,
      ...normalizedOthers,
    };

    logger.info(`Cross-chain funding map: ${JSON.stringify(fundingByChain)}`);
    return fundingByChain;
  } catch (err: any) {
    logger.error(`getCrossChainFunding: ${err.message}`);
    const fallback: FundingByChain = {};
    for (const chain of CROSS_CHAIN_CONFIG.CHAINS) {
      fallback[chain] = { BTC: 0, ETH: 0 };
    }
    return fallback;
  }
}
