/**
 * Cross-Chain Decision Engine
 * Evaluates cross-chain funding arbitrage opportunities.
 */

import { CROSS_CHAIN_CONFIG } from "../config/crossChain";
import { estimateCosts } from "../services/costModel";
import { Logger } from "../logger";

export type FundingAsset = "BTC" | "ETH";

export interface CrossChainDecision {
  asset: FundingAsset;
  execute: boolean;
  currentChain: string;
  bestChain?: string;
  currentRate?: number;
  bestRate?: number;
  netEdge?: number;
  allocation?: number;
  expectedProfitUsd?: number;
  totalCostUsd?: number;
  totalCostPct?: number;
  reason: string;
}

export function evaluateCrossChain({
  asset,
  currentChain,
  fundingRates,
  capital,
  lastExecutionTime,
  logger,
}: {
  asset: FundingAsset;
  currentChain: string;
  fundingRates: Record<string, Record<string, number>>;
  capital: number;
  lastExecutionTime: number;
  logger: Logger;
}): CrossChainDecision {
  if (!CROSS_CHAIN_CONFIG.ENABLED) {
    return { asset, execute: false, currentChain, reason: "Cross-chain disabled" };
  }

  const now = Date.now();

  // Cooldown check
  if (now - lastExecutionTime < CROSS_CHAIN_CONFIG.COOLDOWN_MS) {
    return { asset, execute: false, currentChain, reason: "Cooldown active" };
  }

  const currentRate = fundingRates[currentChain]?.[asset] ?? 0;
  const allocation = capital * CROSS_CHAIN_CONFIG.MAX_ALLOCATION;
  const horizon = CROSS_CHAIN_CONFIG.PROFIT_HORIZON_HOURS;

  let bestChainOverall = currentChain;
  let bestRateOverall = currentRate;
  let bestNetEdge = -Infinity;
  let bestTotalCostUsd = 0;
  let bestTotalCostPct = 0;
  let bestExpectedProfitUsd = 0;

  for (const [chain, rates] of Object.entries(fundingRates)) {
    if (chain === currentChain) continue;

    const candidateRate = rates[asset] ?? 0;
    const edgePerHour = candidateRate - currentRate;
    const projectedCarryEdge = edgePerHour * horizon;

    const { totalCost } = estimateCosts({
      amount: allocation,
      fromChain: currentChain,
      toChain: chain,
    });
    const totalCostPct = allocation > 0 ? totalCost / allocation : 0;
    const netEdge = projectedCarryEdge - totalCostPct - CROSS_CHAIN_CONFIG.RISK_PENALTY;
    const expectedProfitUsd = allocation * netEdge;

    if (netEdge > bestNetEdge) {
      bestNetEdge = netEdge;
      bestChainOverall = chain;
      bestRateOverall = candidateRate;
      bestTotalCostUsd = totalCost;
      bestTotalCostPct = totalCostPct;
      bestExpectedProfitUsd = expectedProfitUsd;
    }
  }

  if (bestChainOverall === currentChain) {
    return {
      asset,
      execute: false,
      currentChain,
      currentRate,
      bestRate: currentRate,
      reason: "No alternative chain available",
    };
  }

  const execute = bestNetEdge > CROSS_CHAIN_CONFIG.MIN_NET_EDGE;

  logger.info(
    `Cross-chain eval (${asset}): current=${currentChain}, best=${bestChainOverall}, ` +
    `edgeRawHourly=${((bestRateOverall - currentRate) * 100).toFixed(4)}%, ` +
    `horizon=${horizon}h, cost=${(bestTotalCostPct * 100).toFixed(4)}%, ` +
    `net=${(bestNetEdge * 100).toFixed(4)}%, pnl=$${bestExpectedProfitUsd.toFixed(2)}, execute=${execute}`
  );

  return {
    asset,
    execute,
    currentChain,
    bestChain: bestChainOverall,
    currentRate,
    bestRate: bestRateOverall,
    netEdge: bestNetEdge,
    allocation,
    expectedProfitUsd: bestExpectedProfitUsd,
    totalCostUsd: bestTotalCostUsd,
    totalCostPct: bestTotalCostPct,
    reason: execute ? "Profitable" : "Edge too small after fees",
  };
}
