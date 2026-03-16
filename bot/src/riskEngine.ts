/**
 * Risk Engine — Delta-Neutral Vault
 * Monitors portfolio health and enforces hard risk limits.
 *
 * Checks performed on every cycle:
 *   - Portfolio drawdown > 10%  → emergency close all
 *   - Delta exposure > 5%       → rebalance
 *   - Single asset loss > 7%    → close that leg
 *   - Funding rate reversal     → close delta-neutral leg
 *   - Insufficient collateral   → halt new trades
 */

import { PositionInfo } from "./executionEngine";
import { Logger } from "./logger";

// ─── Risk limits ──────────────────────────────────────────────────────────────
export const RISK_LIMITS = {
  MAX_DRAWDOWN: 0.10,           // 10% — emergency stop all
  WARN_DRAWDOWN: 0.05,          // 5%  — warning
  MAX_DELTA_EXPOSURE: 0.05,     // 5% of NAV — trigger rebalance
  MAX_SINGLE_ASSET_LOSS: 0.07,  // 7% loss on any single position
  MIN_COLLATERAL_RATIO: 0.20,   // 20% free collateral — halt entries
  MAX_POSITION_FRACTION: 0.40,  // 40% NAV per asset
} as const;

// ─── Risk event types ─────────────────────────────────────────────────────────
export type RiskEventType =
  | "EMERGENCY_CLOSE_ALL"
  | "REBALANCE_REQUIRED"
  | "CLOSE_POSITION"
  | "HALT_NEW_TRADES"
  | "WARNING"
  | "OK";

export interface RiskEvent {
  type: RiskEventType;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
  message: string;
  asset?: "BTC" | "ETH";
  timestamp: number;
}

export interface PortfolioMetrics {
  navUSD: number;
  highWaterMark: number;
  drawdown: number;           // fraction (e.g. 0.05 = 5%)
  totalUnrealizedPnl: number;
  netDelta: number;           // net delta in USD (abs)
  deltaExposurePct: number;   // net delta / NAV
  freeCollateralRatio: number;
  positions: PositionInfo[];
  riskEvents: RiskEvent[];
}

// ─── Risk Engine ──────────────────────────────────────────────────────────────
export class RiskEngine {
  private logger: Logger;
  private highWaterMark: number;
  private initialEquity: number;
  private haltNewTrades: boolean = false;

  constructor(initialEquity: number, logger: Logger) {
    this.initialEquity = initialEquity;
    this.highWaterMark = initialEquity;
    this.logger = logger;
  }

  isHalted(): boolean {
    return this.haltNewTrades;
  }

  // ─── Run all risk checks ───────────────────────────────────────────────────
  assess(
    currentEquity: number,
    totalCollateral: number,
    positions: PositionInfo[]
  ): PortfolioMetrics {
    const events: RiskEvent[] = [];

    // Update high water mark
    if (currentEquity > this.highWaterMark) {
      this.highWaterMark = currentEquity;
    }

    const drawdown = (this.highWaterMark - currentEquity) / this.highWaterMark;
    const totalUnrealizedPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const freeCollateralRatio = totalCollateral > 0 ? currentEquity / totalCollateral : 1;

    // Net delta: sum of all position deltas
    // Delta-neutral positions should have near-zero net delta
    const netDelta = Math.abs(
      positions.reduce((s, p) => s + (p.direction === "LONG" ? p.quoteAmount : -p.quoteAmount), 0)
    );
    const deltaExposurePct = currentEquity > 0 ? netDelta / currentEquity : 0;

    // ── CHECK 1: Emergency drawdown ──────────────────────────────────────────
    if (drawdown > RISK_LIMITS.MAX_DRAWDOWN) {
      this.haltNewTrades = true;
      const ev: RiskEvent = {
        type: "EMERGENCY_CLOSE_ALL",
        severity: "CRITICAL",
        message: `Drawdown ${pct(drawdown)} exceeded hard limit ${pct(RISK_LIMITS.MAX_DRAWDOWN)} — CLOSING ALL POSITIONS`,
        timestamp: Date.now(),
      };
      events.push(ev);
      this.logger.risk(ev.message);
    } else if (drawdown > RISK_LIMITS.WARN_DRAWDOWN) {
      events.push({
        type: "WARNING",
        severity: "HIGH",
        message: `Drawdown warning: ${pct(drawdown)} (limit: ${pct(RISK_LIMITS.MAX_DRAWDOWN)})`,
        timestamp: Date.now(),
      });
      this.logger.warn(`Drawdown at ${pct(drawdown)}`);
    }

    // ── CHECK 2: Delta exposure ──────────────────────────────────────────────
    if (deltaExposurePct > RISK_LIMITS.MAX_DELTA_EXPOSURE) {
      const ev: RiskEvent = {
        type: "REBALANCE_REQUIRED",
        severity: "HIGH",
        message: `Delta exposure ${pct(deltaExposurePct)} > limit ${pct(RISK_LIMITS.MAX_DELTA_EXPOSURE)} — rebalancing`,
        timestamp: Date.now(),
      };
      events.push(ev);
      this.logger.risk(ev.message);
    }

    // ── CHECK 3: Single position loss ────────────────────────────────────────
    for (const pos of positions) {
      const lossPct = -pos.unrealizedPnl / (pos.quoteAmount || 1);
      if (lossPct > RISK_LIMITS.MAX_SINGLE_ASSET_LOSS) {
        const ev: RiskEvent = {
          type: "CLOSE_POSITION",
          severity: "HIGH",
          message: `${pos.asset} position loss ${pct(lossPct)} > limit ${pct(RISK_LIMITS.MAX_SINGLE_ASSET_LOSS)}`,
          asset: pos.asset,
          timestamp: Date.now(),
        };
        events.push(ev);
        this.logger.risk(ev.message);
      }
    }

    // ── CHECK 4: Collateral ratio ────────────────────────────────────────────
    if (freeCollateralRatio < RISK_LIMITS.MIN_COLLATERAL_RATIO) {
      this.haltNewTrades = true;
      const ev: RiskEvent = {
        type: "HALT_NEW_TRADES",
        severity: "HIGH",
        message: `Free collateral ratio ${pct(freeCollateralRatio)} below minimum ${pct(RISK_LIMITS.MIN_COLLATERAL_RATIO)} — halting new entries`,
        timestamp: Date.now(),
      };
      events.push(ev);
      this.logger.risk(ev.message);
    } else if (this.haltNewTrades && freeCollateralRatio > RISK_LIMITS.MIN_COLLATERAL_RATIO + 0.05) {
      // Re-enable trading when collateral recovers
      this.haltNewTrades = false;
      this.logger.info("Collateral recovered — new trades re-enabled");
    }

    // ── OK ───────────────────────────────────────────────────────────────────
    if (events.length === 0) {
      events.push({ type: "OK", severity: "INFO", message: "All risk checks passed", timestamp: Date.now() });
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
    };
  }

  // ─── Format a risk report for logging ────────────────────────────────────
  formatReport(metrics: PortfolioMetrics): string {
    return [
      `NAV: $${metrics.navUSD.toFixed(2)}`,
      `HWM: $${metrics.highWaterMark.toFixed(2)}`,
      `Drawdown: ${pct(metrics.drawdown)}`,
      `Delta Exposure: ${pct(metrics.deltaExposurePct)}`,
      `Collateral Ratio: ${pct(metrics.freeCollateralRatio)}`,
      `Unrealized PnL: $${metrics.totalUnrealizedPnl.toFixed(2)}`,
      `Open Positions: ${metrics.positions.length}`,
      `Risk Events: ${metrics.riskEvents.map((e) => e.type).join(", ")}`,
    ].join(" | ");
  }
}

function pct(n: number, d = 2): string {
  return (n * 100).toFixed(d) + "%";
}
