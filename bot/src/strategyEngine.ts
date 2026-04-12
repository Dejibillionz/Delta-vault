/**
 * Strategy Engine — Delta-Neutral Vault
 * Evaluates market conditions and emits trade signals for BTC and ETH.
 *
 * Signal priority:
 *   1. DELTA_NEUTRAL — funding rate above threshold → collect funding
 *   2. BASIS_TRADE   — basis spread above threshold → capture convergence
 *   3. PARK_CAPITAL  — no opportunity → deploy to stable yield
 */

import { LiveMarketSnapshot } from "./services/hyperliquidExecution";
import { Logger } from "./logger";

// ─── Strategy thresholds ──────────────────────────────────────────────────────
const IS_MAINNET = process.env.SOLANA_NETWORK === "mainnet-beta";

export const THRESHOLDS = {
  // Minimum hourly funding rate to open delta-neutral position
  FUNDING_RATE_MIN: IS_MAINNET ? 0.0001 : 0.000001,      // mainnet: 0.01%/hr (~8.7% APR), devnet: 0.0001%/hr (~0.9% APR)

  // Minimum basis spread to execute basis trade
  BASIS_SPREAD_MIN: IS_MAINNET ? 0.01 : 0.005,           // mainnet: 1.0%, devnet: 0.5%

  // Funding rate below this → exit delta-neutral, too little yield
  FUNDING_RATE_EXIT: IS_MAINNET ? 0.00005 : 0.0000005,   // mainnet: 0.005%/hr, devnet: 0.00005%/hr

  // Basis spread below this → exit basis trade, convergence complete
  BASIS_SPREAD_EXIT: 0.003,       // 0.3%

  // Minimum liquidity score to trade
  MIN_LIQUIDITY_SCORE: IS_MAINNET ? 0.3 : 0.1,

  // Maximum position size as fraction of vault (per asset)
  MAX_POSITION_FRACTION: 0.4,
} as const;

export type SignalType =
  | "DELTA_NEUTRAL_OPEN"
  | "DELTA_NEUTRAL_CLOSE"
  | "BASIS_TRADE_OPEN"
  | "BASIS_TRADE_CLOSE"
  | "PARK_CAPITAL"
  | "NO_ACTION";

export interface Signal {
  asset: string;
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

export type AssetStrategyState = "DELTA_NEUTRAL" | "BASIS_TRADE" | "PARKED" | "NONE";

// Legacy interface kept for callers that destructure getState()
export interface ActiveState {
  [asset: string]: AssetStrategyState;
}

// Minimum ms funding must stay above threshold before entry (30s = 2 × 15s cycles)
const MOMENTUM_WINDOW_MS = 30_000;

// ─── Strategy Engine ──────────────────────────────────────────────────────────
export class StrategyEngine {
  private logger: Logger;
  private state: Record<string, AssetStrategyState> = {};
  private vaultEquity: number = 100_000;
  // Tracks the funding direction of the currently open delta-neutral position.
  // +1 = entered on positive funding (long spot / short perp)
  // -1 = entered on negative funding (short spot / long perp)
  private fundingDir: Record<string, 1 | -1> = {};
  private entryFundingRate: Record<string, number> = {};
  // Timestamp when funding first exceeded threshold (null = not yet/reset)
  private fundingMomentumSince: Record<string, number | null> = {};

  constructor(logger: Logger) {
    this.logger = logger;
  }

  setVaultEquity(equity: number): void {
    this.vaultEquity = equity;
  }

  getState(): ActiveState {
    return { ...this.state };
  }

  setState(asset: string, val: AssetStrategyState): void {
    this.state[asset] = val;
    // Reset momentum when explicitly set to NONE/PARKED
    if (val === "NONE" || val === "PARKED") {
      this.fundingMomentumSince[asset] = null;
    }
  }

  /**
   * Check if current funding rate warrants closing an open position
   */
  shouldExitFundingBased(
    asset: string,
    currentFundingRate: number
  ): { shouldClose: boolean; reason: string } {
    const dir = this.fundingDir[asset] ?? 1;
    const entryFR = this.entryFundingRate[asset] ?? 0;
    const effectiveFunding = currentFundingRate * dir;

    // Regime flipped
    if ((entryFR >= 0 && currentFundingRate < 0) || (entryFR < 0 && currentFundingRate >= 0)) {
      return {
        shouldClose: true,
        reason: `Regime flipped: entry=${pct(entryFR)} → current=${pct(currentFundingRate)}`,
      };
    }

    // Dropped below threshold
    if (effectiveFunding < THRESHOLDS.FUNDING_RATE_EXIT) {
      return {
        shouldClose: true,
        reason: `Effective funding ${pct(effectiveFunding)} below exit threshold ${pct(THRESHOLDS.FUNDING_RATE_EXIT)}`,
      };
    }

    return { shouldClose: false, reason: "Funding still favorable" };
  }

  // ─── Evaluate market snapshot → emit signal ──────────────────────────────
  evaluate(snapshot: LiveMarketSnapshot): Signal {
    const { asset, fundingRate, basisSpread, liquidityScore, spotPrice, perpPrice } = snapshot;
    const currentState = this.state[asset] ?? "NONE";

    const meta = { fundingRate, basisSpread, spotPrice, perpPrice, liquidityScore };
    const maxSize = this.vaultEquity * THRESHOLDS.MAX_POSITION_FRACTION;

    // ── EXIT CONDITIONS ──────────────────────────────────────────────────────

    if (currentState === "DELTA_NEUTRAL") {
      const dir = this.fundingDir[asset] ?? 1;
      const effectiveFunding = fundingRate * dir;
      const regimeFlipped = effectiveFunding < -(THRESHOLDS.FUNDING_RATE_MIN * 2);
      if (regimeFlipped || effectiveFunding < THRESHOLDS.FUNDING_RATE_EXIT) {
        const reason = regimeFlipped
          ? `Funding regime flipped — reversing to ${dir < 0 ? "LONG spot + SHORT perp" : "SHORT spot + LONG perp"}`
          : `Effective funding ${pct(effectiveFunding)} fell below exit threshold — closing`;
        this.logger.info(`${asset} ${reason}`);
        // Reset momentum so re-entry requires a fresh 30s window
        this.fundingMomentumSince[asset] = null;
        return { asset, signal: "DELTA_NEUTRAL_CLOSE", reason, urgency: regimeFlipped ? "HIGH" : "MEDIUM", suggestedSizeUSD: 0, metadata: meta };
      }
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
      // 1. Delta-neutral: collect funding (both positive and negative funding)
      if (
        Math.abs(fundingRate) > THRESHOLDS.FUNDING_RATE_MIN &&
        liquidityScore >= THRESHOLDS.MIN_LIQUIDITY_SCORE
      ) {
        // ── Funding momentum filter: sustained signal for MOMENTUM_WINDOW_MS ──
        const now = Date.now();
        if (!this.fundingMomentumSince[asset]) {
          this.fundingMomentumSince[asset] = now;
        }
        const elapsedMs = now - (this.fundingMomentumSince[asset] as number);

        if (elapsedMs < MOMENTUM_WINDOW_MS) {
          const remainS = Math.ceil((MOMENTUM_WINDOW_MS - elapsedMs) / 1000);
          return {
            asset,
            signal: "NO_ACTION",
            reason: `Funding momentum building — ${remainS}s remaining (need ${MOMENTUM_WINDOW_MS / 1000}s sustained)`,
            urgency: "LOW",
            suggestedSizeUSD: 0,
            metadata: meta,
          };
        }

        // Momentum confirmed — open position
        this.fundingDir[asset] = fundingRate >= 0 ? 1 : -1;
        this.entryFundingRate[asset] = fundingRate;
        const size = this.sizeDeltaNeutral(fundingRate, maxSize);
        const fundingDirection = fundingRate >= 0 ? "positive" : "negative";
        this.logger.trade(
          `${asset} SIGNAL: DELTA_NEUTRAL_OPEN — ${fundingDirection} FR=${pct(fundingRate)}, size=$${size.toFixed(0)} (momentum confirmed ${Math.floor(elapsedMs / 1000)}s)`
        );
        return {
          asset,
          signal: "DELTA_NEUTRAL_OPEN",
          reason: fundingRate >= 0
            ? `Positive funding ${pct(fundingRate)} > threshold ${pct(THRESHOLDS.FUNDING_RATE_MIN)} (LONG spot + SHORT perp)`
            : `Negative funding ${pct(fundingRate)} < -threshold ${pct(THRESHOLDS.FUNDING_RATE_MIN)} (SHORT spot + LONG perp)`,
          urgency: Math.abs(fundingRate) > THRESHOLDS.FUNDING_RATE_MIN * 3 ? "HIGH" : "MEDIUM",
          suggestedSizeUSD: size,
          metadata: meta,
        };
      } else {
        // Funding dropped below threshold — reset momentum timer
        this.fundingMomentumSince[asset] = null;
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
    const ratio = Math.min(Math.abs(fundingRate) / (THRESHOLDS.FUNDING_RATE_MIN * 5), 1);
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
