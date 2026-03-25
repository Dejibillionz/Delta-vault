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

export function estimateCosts({ amount }: { amount: number }): CostBreakdown {
  // Bridge fee: 0.3% of amount
  const bridgeCost = amount * 0.003;

  // Gas cost: 0.1% of amount (approximate)
  const gasCost = amount * 0.001;

  // Slippage: 0.15% of amount
  const slippage = amount * 0.0015;

  const totalCost = bridgeCost + gasCost + slippage;

  return {
    bridgeCost,
    gasCost,
    slippage,
    totalCost,
  };
}