/**
 * Enhanced Risk Engine
 * Runs on a 10-second cycle — faster than the 30s strategy loop.
 *
 * Checks:
 *   Original:
 *     - Portfolio drawdown > 10%  → EMERGENCY_CLOSE
 *     - Delta exposure > 5%       → REBALANCE
 *     - Single asset loss > 7%    → CLOSE_POSITION
 *     - Free collateral < 20%     → HALT_NEW_TRADES
 *
 *   New additions:
 *     - Funding rate volatility > 0.5  → REDUCE_SIZE  (funding chaos)
 *     - Solana congestion > 500ms      → PAUSE_EXECUTION (network issues)
 *     - Oracle staleness > 30s         → HALT_NEW_POSITIONS
 */

import { PositionInfo } from "./executionEngine";
import { Logger } from "./logger";

// ─── Risk limits ──────────────────────────────────────────────────────────────
export const RISK_LIMITS = {
  // Portfolio-level
  MAX_DRAWDOWN:            0.10,   // 10% — emergency stop
  WARN_DRAWDOWN:           0.05,   // 5%  — warning
  MAX_DELTA_EXPOSURE:      0.05,   // 5% of NAV — rebalance
  MAX_SINGLE_ASSET_LOSS:   0.07,   // 7% — close that leg
  MIN_COLLATERAL_RATIO:    0.20,   // 20% free collateral — halt entries

  // New: market conditions
  MAX_FUNDING_VOLATILITY:  0.20,   // Relative funding jump > 0.2 = chaotic
  MAX_SOLANA_LATENCY_MS:   500,    // RPC round-trip > 500ms = congested
  MAX_ORACLE_STALENESS_S:  30,     // Pyth price age > 30s = stale

  // Position sizing reduction when conditions are adverse
  REDUCE_SIZE_FACTOR:      0.50,   // Cut position sizes by 50% in adverse conditions
  FUNDING_VOL_WARMUP_SAMPLES: 4,   // Wait for enough smoothed samples before volatility checks
} as const;

// ─── Risk action types ────────────────────────────────────────────────────────
export type RiskAction =
  | "NORMAL"
  | "EMERGENCY_CLOSE"
  | "REBALANCE"
  | "CLOSE_POSITION"
  | "HALT_NEW_TRADES"
  | "REDUCE_SIZE"
  | "PAUSE_EXECUTION"
  | "HALT_NEW_POSITIONS"
  | "WARNING";

export interface RiskEvent {
  action: RiskAction;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
  message: string;
  asset?: "BTC" | "ETH";
  timestamp: number;
}

export interface MarketConditions {
  fundingRateVolatility: number;  // std dev / mean of recent funding rates
  solanaLatencyMs: number;        // RPC ping in ms
  oracleStalenessS: number;       // Seconds since last Pyth price update
}

export interface PortfolioMetrics {
  navUSD: number;
  highWaterMark: number;
  drawdown: number;
  totalUnrealizedPnl: number;
  netDelta: number;
  deltaExposurePct: number;
  freeCollateralRatio: number;
  positions: PositionInfo[];
  riskEvents: RiskEvent[];
  worstAction: RiskAction;
  sizingMultiplier: number;        // 1.0 = normal, 0.5 = halved
}

// ─── Enhanced Risk Engine ─────────────────────────────────────────────────────
export class EnhancedRiskEngine {
  private logger: Logger;
  private highWaterMark: number;
  private haltNewTrades: boolean = false;
  private pauseExecution: boolean = false;
  private recentFundingRates: Record<string, number[]> = { BTC: [], ETH: [] };
  private smoothedFunding: Record<string, number> = { BTC: 0, ETH: 0 };
  private fundingSizeReduced: boolean = false;

  constructor(initialEquity: number, logger: Logger) {
    this.highWaterMark = initialEquity;
    this.logger = logger;
  }

  // ── Record a funding rate observation for volatility calculation ────────────
  recordFundingRate(asset: string, rate: number): void {
    const sanitized = this.sanitizeFunding(rate);
    const history = this.recentFundingRates[asset] ?? [];
    const smoothed = this.smoothFunding(asset, sanitized, history.length === 0);
    history.push(smoothed);
    if (history.length > 20) history.shift(); // keep last 20 smoothed readings
    this.recentFundingRates[asset] = history;
  }

  isHalted(): boolean { return this.haltNewTrades; }
  isPaused(): boolean { return this.pauseExecution; }
  getSizingMultiplier(): number { return this.pauseExecution ? 0 : (this.haltNewTrades ? 0 : 1); }

  // ── Main assessment ──────────────────────────────────────────────────────────
  assess(
    currentEquity: number,
    totalCollateral: number,
    positions: PositionInfo[],
    conditions: MarketConditions
  ): PortfolioMetrics {
    const events: RiskEvent[] = [];
    let sizingMultiplier = 1.0;

    // Update high water mark
    if (currentEquity > this.highWaterMark) this.highWaterMark = currentEquity;

    const drawdown = (this.highWaterMark - currentEquity) / this.highWaterMark;
    const totalUnrealizedPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const freeCollateralRatio = totalCollateral > 0 ? currentEquity / totalCollateral : 1;
    // For delta-neutral positions, spot long + perp short cancel out.
    // We sum signed exposure: LONG = +notional, SHORT = -notional.
    // A perfectly hedged position gives 0. We take abs() of the net.
    const signedDelta = positions.reduce(
      (s, p) => s + (p.direction === "LONG" ? p.quoteAmount : -p.quoteAmount), 0
    );
    const netDelta = Math.abs(signedDelta);
    // Cap at total notional to prevent >100% readings
    const totalNotional = positions.reduce((s, p) => s + p.quoteAmount, 0);
    const cappedDelta = Math.min(netDelta, totalNotional);
    const deltaExposurePct = currentEquity > 0 ? cappedDelta / currentEquity : 0;

    // ── CHECK 1: Emergency drawdown ──────────────────────────────────────────
    if (drawdown > RISK_LIMITS.MAX_DRAWDOWN) {
      this.haltNewTrades = true;
      this.logEvent(events, "EMERGENCY_CLOSE", "CRITICAL",
        `Drawdown ${pct(drawdown)} exceeded hard limit ${pct(RISK_LIMITS.MAX_DRAWDOWN)} — CLOSING ALL POSITIONS`);
    } else if (drawdown > RISK_LIMITS.WARN_DRAWDOWN) {
      this.logEvent(events, "WARNING", "HIGH",
        `Drawdown warning: ${pct(drawdown)} (limit: ${pct(RISK_LIMITS.MAX_DRAWDOWN)})`);
    }

    // ── CHECK 2: Delta exposure ──────────────────────────────────────────────
    if (deltaExposurePct > RISK_LIMITS.MAX_DELTA_EXPOSURE) {
      this.logEvent(events, "REBALANCE", "HIGH",
        `Delta exposure ${pct(deltaExposurePct)} > ${pct(RISK_LIMITS.MAX_DELTA_EXPOSURE)} — triggering rebalance`);
    }

    // ── CHECK 3: Single position loss ────────────────────────────────────────
    for (const pos of positions) {
      const lossPct = -pos.unrealizedPnl / (pos.quoteAmount || 1);
      if (lossPct > RISK_LIMITS.MAX_SINGLE_ASSET_LOSS) {
        this.logEvent(events, "CLOSE_POSITION", "HIGH",
          `${pos.asset} position loss ${pct(lossPct)} > ${pct(RISK_LIMITS.MAX_SINGLE_ASSET_LOSS)}`,
          pos.asset as any);
      }
    }

    // ── CHECK 4: Collateral ratio ────────────────────────────────────────────
    if (freeCollateralRatio < RISK_LIMITS.MIN_COLLATERAL_RATIO) {
      this.haltNewTrades = true;
      this.logEvent(events, "HALT_NEW_TRADES", "HIGH",
        `Collateral ratio ${pct(freeCollateralRatio)} below minimum ${pct(RISK_LIMITS.MIN_COLLATERAL_RATIO)}`);
    } else if (this.haltNewTrades && freeCollateralRatio > RISK_LIMITS.MIN_COLLATERAL_RATIO + 0.05) {
      this.haltNewTrades = false;
      this.logger.info("RiskEngine: Collateral recovered — new trades re-enabled");
    }

    // ── CHECK 5 (NEW): Funding rate volatility ───────────────────────────────
    const fundingVolatility = this.computeFundingVolatility();
    if (fundingVolatility > RISK_LIMITS.MAX_FUNDING_VOLATILITY) {
      sizingMultiplier *= RISK_LIMITS.REDUCE_SIZE_FACTOR;
      if (!this.fundingSizeReduced) {
        this.fundingSizeReduced = true;
        this.logEvent(events, "REDUCE_SIZE", "MEDIUM",
          `Funding rate volatility ${fundingVolatility.toFixed(2)} > ${RISK_LIMITS.MAX_FUNDING_VOLATILITY} — reducing position sizes by 50%`);
      }
    } else if (this.fundingSizeReduced) {
      this.fundingSizeReduced = false;
      this.logger.info(
        `RiskEngine: Funding volatility normalized (${fundingVolatility.toFixed(2)}) — size reduction cleared`
      );
    }

    // ── CHECK 6 (NEW): Solana network congestion ─────────────────────────────
    if (conditions.solanaLatencyMs > RISK_LIMITS.MAX_SOLANA_LATENCY_MS) {
      this.pauseExecution = true;
      this.logEvent(events, "PAUSE_EXECUTION", "HIGH",
        `Solana RPC latency ${conditions.solanaLatencyMs}ms > ${RISK_LIMITS.MAX_SOLANA_LATENCY_MS}ms — pausing execution`);
    } else if (this.pauseExecution && conditions.solanaLatencyMs < RISK_LIMITS.MAX_SOLANA_LATENCY_MS * 0.7) {
      this.pauseExecution = false;
      this.logger.info("RiskEngine: Network congestion cleared — execution resumed");
    }

    // ── CHECK 7 (NEW): Oracle staleness ─────────────────────────────────────
    if (conditions.oracleStalenessS > RISK_LIMITS.MAX_ORACLE_STALENESS_S) {
      this.logEvent(events, "HALT_NEW_POSITIONS", "HIGH",
        `Oracle data is ${conditions.oracleStalenessS}s stale (max ${RISK_LIMITS.MAX_ORACLE_STALENESS_S}s) — halting new entries`);
    }

    // ── Priority: determine worst action ────────────────────────────────────
    const ACTION_PRIORITY: RiskAction[] = [
      "EMERGENCY_CLOSE", "PAUSE_EXECUTION", "HALT_NEW_TRADES",
      "HALT_NEW_POSITIONS", "CLOSE_POSITION", "REBALANCE",
      "REDUCE_SIZE", "WARNING", "NORMAL",
    ];
    const worstAction = events.length > 0
      ? ACTION_PRIORITY.find(a => events.some(e => e.action === a)) ?? "NORMAL"
      : "NORMAL";

    if (events.length === 0) {
      events.push({ action: "NORMAL", severity: "INFO", message: "All risk checks passed", timestamp: Date.now() });
    }

    return {
      navUSD: currentEquity,
      highWaterMark: this.highWaterMark,
      drawdown,
      totalUnrealizedPnl,
      netDelta,
      deltaExposurePct,
      freeCollateralRatio,
      positions,
      riskEvents: events,
      worstAction,
      sizingMultiplier,
    };
  }

  private sanitizeFunding(rate: number): number {
    return Math.max(Math.min(rate, 0.005), -0.005);
  }

  private smoothFunding(asset: string, newValue: number, isFirstSample = false): number {
    if (isFirstSample) {
      this.smoothedFunding[asset] = newValue;
      return newValue;
    }
    const previous = this.smoothedFunding[asset] ?? 0;
    const smoothed = 0.8 * previous + 0.2 * newValue;
    this.smoothedFunding[asset] = smoothed;
    return smoothed;
  }

  private calculateFundingVolatility(current: number, previous: number): number {
    const diff = Math.abs(current - previous);
    const base = Math.max(Math.abs(previous), 0.0001);
    return diff / base;
  }

  // ── Compute funding rate volatility (relative jump, smoothed) ───────────────
  private computeFundingVolatility(): number {
    const perAssetVols: number[] = [];
    for (const history of Object.values(this.recentFundingRates)) {
      if (history.length < RISK_LIMITS.FUNDING_VOL_WARMUP_SAMPLES) continue;
      const previous = history[history.length - 2];
      const current = history[history.length - 1];
      perAssetVols.push(this.calculateFundingVolatility(current, previous));
    }
    if (perAssetVols.length === 0) return 0;
    return perAssetVols.reduce((sum, v) => sum + v, 0) / perAssetVols.length;
  }

  private logEvent(
    events: RiskEvent[],
    action: RiskAction,
    severity: RiskEvent["severity"],
    message: string,
    asset?: "BTC" | "ETH"
  ): void {
    events.push({ action, severity, message, asset, timestamp: Date.now() });
    const logFn = severity === "CRITICAL" || severity === "HIGH"
      ? this.logger.risk.bind(this.logger)
      : this.logger.warn.bind(this.logger);
    logFn(`RiskEngine [${action}]: ${message}`);
  }

  formatReport(metrics: PortfolioMetrics): string {
    return [
      `NAV: $${metrics.navUSD.toFixed(2)}`,
      `HWM: $${metrics.highWaterMark.toFixed(2)}`,
      `Drawdown: ${pct(metrics.drawdown)}`,
      `Delta: ${pct(metrics.deltaExposurePct)}`,
      `Collateral: ${pct(metrics.freeCollateralRatio)}`,
      `PnL: $${metrics.totalUnrealizedPnl.toFixed(2)}`,
      `Sizing: ${(metrics.sizingMultiplier * 100).toFixed(0)}%`,
      `Action: ${metrics.worstAction}`,
    ].join(" | ");
  }
}

const pct = (n: number, d = 2) => (n * 100).toFixed(d) + "%";
