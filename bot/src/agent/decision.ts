import { AgentState, Asset } from "./state";

export type AgentObservation = {
  funding: Record<string, number>;   // asset → hourly funding rate
  volatility: number;
};

export type AgentDecision =
  | {
      action: "SKIP";
      asset: Asset;
      reason: string;
    }
  | {
      action: "TRADE";
      asset: Asset;
      confidence: number;
      momentum: number;
    };

const EWMA_ALPHA = 0.3;

export function decide(observation: AgentObservation, state: AgentState): AgentDecision {
  const fundingByAsset = observation.funding;
  const assets = Object.keys(fundingByAsset);

  if (assets.length === 0) {
    // Fallback to first trading asset from env, or "BTC" if unavailable
    const defaultAsset = (process.env.TRADING_ASSETS ?? "BTC").split(",")[0].trim();
    return { action: "SKIP", asset: defaultAsset, reason: "No assets in observation" };
  }

  // Update EWMA and momentum scores for each asset (side effect on state)
  for (const a of assets) {
    const funding = fundingByAsset[a];
    const prev = state.ewmaFunding[a] ?? 0;
    state.ewmaFunding[a] = EWMA_ALPHA * funding + (1 - EWMA_ALPHA) * prev;
    const ewma = state.ewmaFunding[a];
    state.momentumScore[a] = Math.max(
      -1,
      Math.min(1, (funding - ewma) / Math.max(Math.abs(ewma), 0.00001))
    );
  }

  // Pick the asset with the highest absolute funding rate
  const asset = assets.reduce(
    (best, a) => Math.abs(fundingByAsset[a]) > Math.abs(fundingByAsset[best] ?? 0) ? a : best,
    assets[0]
  );

  const momentum = state.momentumScore[asset] ?? 0;
  const performance = state.performance[asset] ?? 0;

  if (performance < 0 && momentum < -0.3) {
    return {
      action: "SKIP",
      asset,
      reason: `${asset} underperforming with negative momentum (${momentum.toFixed(2)})`,
    };
  }

  if (performance < 0) {
    return {
      action: "SKIP",
      asset,
      reason: `${asset} underperforming`,
    };
  }

  // Scale confidence by momentum: positive momentum boosts, negative dampens
  const momentumAdjustedConfidence = Math.max(
    0.2,
    Math.min(1.0, state.confidence + momentum * 0.15)
  );

  return {
    action: "TRADE",
    asset,
    confidence: momentumAdjustedConfidence,
    momentum,
  };
}

