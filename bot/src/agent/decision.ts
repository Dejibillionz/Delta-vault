import { AgentState, Asset } from "./state";

export type AgentObservation = {
  btcFunding: number;
  ethFunding: number;
  volatility: number;
};

export type AgentDecision =
  | {
      action: "SKIP";
      reason: string;
    }
  | {
      action: "TRADE";
      asset: Asset;
      confidence: number;
    };

export function decide(observation: AgentObservation, state: AgentState): AgentDecision {
  const { btcFunding, ethFunding } = observation;
  const asset: Asset = btcFunding > ethFunding ? "BTC" : "ETH";

  if (state.performance[asset] < 0) {
    return {
      action: "SKIP",
      reason: `${asset} underperforming`,
    };
  }

  return {
    action: "TRADE",
    asset,
    confidence: state.confidence,
  };
}
