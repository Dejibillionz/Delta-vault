/**
 * Cross-Chain Cost Model
 * Estimates bridge, gas, and slippage costs for cross-chain moves.
 */

export interface CostBreakdown {
  bridgeCost: number;
  gasCost: number;
  slippage: number;
  totalCost: number;
}

const ROUTE_MULTIPLIER: Record<string, number> = {
  "solana->arbitrum": 1.00,
  "solana->base":     0.95,
  "solana->optimism": 0.98,
  "solana->polygon":  1.05,
  "solana->avalanche":1.08,
  "solana->bnb":      1.12,
};

export function estimateCosts({
  amount,
  fromChain,
  toChain,
}: {
  amount: number;
  fromChain?: string;
  toChain?: string;
}): CostBreakdown {
  const routeKey   = `${fromChain ?? "solana"}->${toChain ?? "arbitrum"}`;
  const routeFactor = ROUTE_MULTIPLIER[routeKey] ?? 1.0;

  // Base assumptions (tunable): bridge 0.30%, gas 0.10%, slippage 0.15%
  const bridgeCost = amount * 0.003 * routeFactor;
  const gasCost    = amount * 0.001 * routeFactor;
  const slippage   = amount * 0.0015 * routeFactor;

  return { bridgeCost, gasCost, slippage, totalCost: bridgeCost + gasCost + slippage };
}
