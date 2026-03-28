import { AgentDecision, AgentObservation, decide } from "./decision";
import { getPositionSize } from "./sizing";
import { AgentState, TradeFeedback, updateState } from "./state";
import { logAgent, logDecision } from "./logger";

export async function runAgentCycle({
  state,
  observation,
  executeTrade,
}: {
  state: AgentState;
  observation: AgentObservation;
  executeTrade: (input: { asset: "BTC" | "ETH"; size: number }) => Promise<{ pnl: number }>;
}): Promise<{ decision: AgentDecision; size: number | null; feedback?: TradeFeedback }> {
  logAgent("Observing market...");

  const decision = decide(observation, state);
  logDecision(decision);

  if (decision.action !== "TRADE") {
    logAgent(`Skipping -> ${decision.reason}`);
    return { decision, size: null };
  }

  const size = getPositionSize(state, observation.volatility);
  if (size < 1_000) {
    logAgent("Trade below minimum size -> skipping");
    return { decision, size };
  }

  logAgent(
    `Executing ${decision.asset} trade with size $${size.toFixed(2)} (confidence: ${state.confidence.toFixed(2)})`
  );

  const result = await executeTrade({
    asset: decision.asset,
    size,
  });

  logAgent(`Trade result PnL: ${result.pnl}`);

  const feedback = {
    asset: decision.asset,
    pnl: result.pnl,
  };
  updateState(state, feedback);

  logAgent(`Updated winRate: ${state.winRate.toFixed(2)}, confidence: ${state.confidence.toFixed(2)}`);

  return { decision, size, feedback };
}
