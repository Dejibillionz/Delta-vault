/**
 * Cross-Chain Decision Engine
 * Evaluates cross-chain funding arbitrage opportunities.
 */

import { CROSS_CHAIN_CONFIG } from "../config/crossChain";
import { estimateCosts, CostBreakdown } from "../services/costModel";
import { Logger } from "../logger";

export interface CrossChainDecision {
  execute: boolean;
  bestChain?: string;
  netEdge?: number;
  allocation?: number;
  reason: string;
}

export function evaluateCrossChain({
  currentChain,
  fundingRates,
  capital,
  lastExecutionTime,
  logger,
}: {
  currentChain: string;
  fundingRates: Record<string, Record<string, number>>;
  capital: number;
  lastExecutionTime: number;
  logger: Logger;
}): CrossChainDecision {
  if (!CROSS_CHAIN_CONFIG.ENABLED) {
    return { execute: false, reason: "Cross-chain disabled" };
  }

  const now = Date.now();

  // Cooldown check
  if (now - lastExecutionTime < CROSS_CHAIN_CONFIG.COOLDOWN_MS) {
    return { execute: false, reason: "Cooldown active" };
  }

  // Use BTC only for now (simpler)
  const currentRate = fundingRates[currentChain]?.BTC ?? 0;
  let bestChainOverall = currentChain;
  let bestRateOverall = currentRate;

  for (const [chain, rates] of Object.entries(fundingRates)) {
    const rate = rates.BTC ?? 0;
    if (rate > bestRateOverall) {
      bestRateOverall = rate;
      bestChainOverall = chain;
    }
  }

  if (bestChainOverall === currentChain) {
    return { execute: false, reason: "Already optimal" };
  }

  const allocation = capital * CROSS_CHAIN_CONFIG.MAX_ALLOCATION;
  const { totalCost } = estimateCosts({ amount: allocation });

  // Add edge trigger for cross-chain moves
  const netEdge = bestRateOverall - currentRate - totalCost - CROSS_CHAIN_CONFIG.RISK_PENALTY;

  // Execute if net edge > 0.2% (20 bps)
  const execute = netEdge > 0.002;

  logger.info(
    `Cross-chain eval: current=${currentChain}, best=${bestChainOverall}, ` +
    `edge=${(netEdge * 100).toFixed(4)}%, cost=${(totalCost * 100).toFixed(4)}%, ` +
    `net=${(netEdge * 100).toFixed(4)}%, execute=${execute}`
  );

  return {
    execute,
    bestChain: bestChainOverall,
    netEdge,
    allocation,
    reason: execute ? "Profitable" : "Edge too small after fees",
  };
}
