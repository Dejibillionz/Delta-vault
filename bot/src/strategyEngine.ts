/**
 * Strategy Engine — Delta-Neutral Vault
 * Evaluates market conditions and emits trade signals for BTC and ETH.
 *
 * Signal priority:
 *   1. DELTA_NEUTRAL — funding rate above threshold → collect funding
 *   2. BASIS_TRADE   — basis spread above threshold → capture convergence
 *   3. PARK_CAPITAL  — no opportunity → deploy to stable yield
 */

import { MarketSnapshot } from "./marketDataEngine";
import { Logger } from "./logger";

// ─── Strategy thresholds ──────────────────────────────────────────────────────
export const THRESHOLDS = {
  // Minimum hourly funding rate to open delta-neutral position
  FUNDING_RATE_MIN: 0.0001,       // 0.01% per hour = ~0.87% APR

  // Minimum basis spread to execute basis trade
  BASIS_SPREAD_MIN: 0.01,         // 1%

  // Funding rate below this → exit delta-neutral, too little yield
  FUNDING_RATE_EXIT: 0.00005,     // 0.005% per hour

  // Basis spread below this → exit basis trade, convergence complete
  BASIS_SPREAD_EXIT: 0.003,       // 0.3%

  // Minimum liquidity score required to enter (0–1)
  MIN_LIQUIDITY_SCORE: 0.3,

  // Maximum position size as fraction of vault (per asset)
  MAX_POSITION_FRACTION: 0.4,
} as const;

// ─── Signal types ─────────────────────────────────────────────────────────────
export type SignalType =
  | "DELTA_NEUTRAL_OPEN"
  | "DELTA_NEUTRAL_CLOSE"
  | "BASIS_TRADE_OPEN"
  | "BASIS_TRADE_CLOSE"
  | "PARK_CAPITAL"
  | "NO_ACTION";

export interface Signal {
  asset: "BTC" | "ETH";
  signal: SignalType;
  reason: string;
  urgency: "HIGH" | "MEDIUM" | "LOW";
  suggestedSizeUSD: number;    // recommended notional in USD
  metadata: {
    fundingRate: number;
    basisSpread: number;
    spotPrice: number;
    perpPrice: number;
    liquidityScore: number;
  };
}

export interface ActiveState {
  BTC: "DELTA_NEUTRAL" | "BASIS_TRADE" | "PARKED" | "NONE";
  ETH: "DELTA_NEUTRAL" | "BASIS_TRADE" | "PARKED" | "NONE";
}

// ─── Strategy Engine ──────────────────────────────────────────────────────────
export class StrategyEngine {
  private logger: Logger;
  private state: ActiveState = { BTC: "NONE", ETH: "NONE" };
  private vaultEquity: number = 100_000; // updated externally

  constructor(logger: Logger) {
    this.logger = logger;
  }

  setVaultEquity(equity: number): void {
    this.vaultEquity = equity;
  }

  getState(): ActiveState {
    return { ...this.state };
  }

  setState(asset: "BTC" | "ETH", val: ActiveState["BTC"]): void {
    this.state[asset] = val;
  }

  // ─── Evaluate market snapshot → emit signal ──────────────────────────────
  evaluate(snapshot: MarketSnapshot): Signal {
    const { asset, fundingRate, basisSpread, liquidityScore, spotPrice, perpPrice } = snapshot;
    const currentState = this.state[asset];

    const meta = { fundingRate, basisSpread, spotPrice, perpPrice, liquidityScore };
    const maxSize = this.vaultEquity * THRESHOLDS.MAX_POSITION_FRACTION;

    // ── EXIT CONDITIONS ──────────────────────────────────────────────────────

    if (currentState === "DELTA_NEUTRAL" && fundingRate < THRESHOLDS.FUNDING_RATE_EXIT) {
      this.logger.info(`${asset} funding dropped below exit threshold — signaling close`);
      return {
        asset,
        signal: "DELTA_NEUTRAL_CLOSE",
        reason: `Funding rate ${pct(fundingRate)} fell below exit threshold ${pct(THRESHOLDS.FUNDING_RATE_EXIT)}`,
        urgency: "MEDIUM",
        suggestedSizeUSD: 0,
        metadata: meta,
      };
    }

    if (currentState === "BASIS_TRADE" && basisSpread < THRESHOLDS.BASIS_SPREAD_EXIT) {
      this.logger.info(`${asset} basis converged — signaling close`);
      return {
        asset,
        signal: "BASIS_TRADE_CLOSE",
        reason: `Basis ${pct(basisSpread, 2)} converged below exit threshold ${pct(THRESHOLDS.BASIS_SPREAD_EXIT, 2)}`,
        urgency: "MEDIUM",
        suggestedSizeUSD: 0,
        metadata: meta,
      };
    }

    // ── ENTRY CONDITIONS ─────────────────────────────────────────────────────

    if (currentState === "NONE" || currentState === "PARKED") {
      // 1. Delta-neutral: collect funding
      if (
        fundingRate > THRESHOLDS.FUNDING_RATE_MIN &&
        liquidityScore >= THRESHOLDS.MIN_LIQUIDITY_SCORE
      ) {
        const size = this.sizeDeltaNeutral(fundingRate, maxSize);
        this.logger.trade(
          `${asset} SIGNAL: DELTA_NEUTRAL_OPEN — FR=${pct(fundingRate)}, size=$${size.toFixed(0)}`
        );
        return {
          asset,
          signal: "DELTA_NEUTRAL_OPEN",
          reason: `Funding rate ${pct(fundingRate)} > threshold ${pct(THRESHOLDS.FUNDING_RATE_MIN)}`,
          urgency: fundingRate > THRESHOLDS.FUNDING_RATE_MIN * 3 ? "HIGH" : "MEDIUM",
          suggestedSizeUSD: size,
          metadata: meta,
        };
      }

      // 2. Basis trade: capture spread convergence
      if (
        basisSpread > THRESHOLDS.BASIS_SPREAD_MIN &&
        liquidityScore >= THRESHOLDS.MIN_LIQUIDITY_SCORE
      ) {
        const size = this.sizeBasisTrade(basisSpread, maxSize);
        this.logger.trade(
          `${asset} SIGNAL: BASIS_TRADE_OPEN — basis=${pct(basisSpread, 2)}, size=$${size.toFixed(0)}`
        );
        return {
          asset,
          signal: "BASIS_TRADE_OPEN",
          reason: `Basis spread ${pct(basisSpread, 2)} > ${pct(THRESHOLDS.BASIS_SPREAD_MIN, 2)} threshold`,
          urgency: "MEDIUM",
          suggestedSizeUSD: size,
          metadata: meta,
        };
      }

      // 3. Park capital
      return {
        asset,
        signal: "PARK_CAPITAL",
        reason: `No opportunity — FR=${pct(fundingRate)}, basis=${pct(basisSpread, 2)}, liq=${liquidityScore.toFixed(2)}`,
        urgency: "LOW",
        suggestedSizeUSD: 0,
        metadata: meta,
      };
    }

    // Holding a position — no new signal
    return {
      asset,
      signal: "NO_ACTION",
      reason: `Holding ${currentState} — conditions unchanged`,
      urgency: "LOW",
      suggestedSizeUSD: 0,
      metadata: meta,
    };
  }

  // ─── Position sizing ──────────────────────────────────────────────────────
  // Scale size proportionally to funding rate strength (Kelly-like)
  private sizeDeltaNeutral(fundingRate: number, maxSize: number): number {
    const ratio = Math.min(fundingRate / (THRESHOLDS.FUNDING_RATE_MIN * 5), 1);
    return Math.max(1000, maxSize * (0.25 + 0.75 * ratio));
  }

  // Scale size proportionally to basis spread
  private sizeBasisTrade(basisSpread: number, maxSize: number): number {
    const ratio = Math.min(basisSpread / (THRESHOLDS.BASIS_SPREAD_MIN * 3), 1);
    return Math.max(1000, maxSize * (0.2 + 0.6 * ratio));
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function pct(n: number, d = 4): string {
  return (n * 100).toFixed(d) + "%";
}
