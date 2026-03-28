import { AgentState } from "./state";

const BASE_SIZE = 1_000;

export function getPositionSize(state: AgentState, volatility: number): number {
  let size = BASE_SIZE;

  if (state.winRate > 0.6) {
    size *= 1.5;
  }

  if (volatility > 1) {
    size *= 0.5;
  }

  size *= state.confidence;

  return Math.max(size, 0);
}
