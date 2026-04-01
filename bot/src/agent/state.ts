export type Asset = "BTC" | "ETH";

export type TradeFeedback = {
  asset: Asset;
  pnl: number;
};

export type AgentState = {
  winRate: number;
  confidence: number;
  lastTrades: TradeFeedback[];
  performance: Record<Asset, number>;
};

export function createInitialState(): AgentState {
  return {
    winRate: 0.5,
    confidence: 0.5,
    lastTrades: [],
    performance: {
      BTC: 0,
      ETH: 0,
    },
  };
}

export function updateState(state: AgentState, feedback: TradeFeedback): void {
  state.lastTrades.push(feedback);

  // Keep memory bounded so state stays lightweight over long runtimes.
  if (state.lastTrades.length > 20) {
    state.lastTrades.shift();
  }

  state.performance[feedback.asset] += feedback.pnl;

  if (feedback.pnl > 0) {
    state.winRate += 0.02;
  } else {
    state.winRate -= 0.02;
  }

  state.winRate = Math.max(0, Math.min(1, state.winRate));

  // Confidence scales faster than winRate: amplify deviation from neutral
  const wins = state.lastTrades.filter(t => t.pnl > 0).length;
  const total = state.lastTrades.length;
  const recentWinRate = total > 0 ? wins / total : 0.5;
  state.confidence = Math.max(0.3, Math.min(1, 0.4 + recentWinRate * 0.6));
}
