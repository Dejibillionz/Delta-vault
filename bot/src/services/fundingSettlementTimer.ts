/**
 * FundingSettlementTimer
 * Tracks the countdown to the next Hyperliquid funding settlement (every 8 hours).
 *
 * HL settles funding at 00:00, 08:00, 16:00 UTC. The actual nextFundingTime is
 * parsed from the API and stored in each LiveMarketSnapshot. This class reads
 * BTC's snapshot as a proxy for all markets (they share the same settlement clock).
 *
 * Usage in the strategy loop:
 *   - isInCaptureWindow() → true in the last N minutes before settlement
 *     → enter at full size to collect the imminent payment
 *   - isPostSettlement()  → true in the 10 minutes after settlement fires
 *     → tighten exit threshold (new period rate may be lower)
 *   - getEntryBoost()     → 1.0–1.25× multiplier applied to position sizing
 *   - getCountdownLabel() → "4m 23s" string for [SUMMARY] log line
 */

import { HLMarketDataEngine } from "./hyperliquidExecution";

const PERIOD_MS          = 8 * 60 * 60 * 1000;  // 8 hours in ms
const POST_WINDOW_MS     = 10 * 60 * 1000;       // 10 min post-settlement window

export class FundingSettlementTimer {
  private marketEngine: HLMarketDataEngine;
  private captureWindowMs: number;

  constructor(marketEngine: HLMarketDataEngine) {
    this.marketEngine   = marketEngine;
    this.captureWindowMs = parseInt(
      process.env.SETTLEMENT_CAPTURE_WINDOW_MS ?? "900000"  // default 15 min
    );
  }

  // ── Core helpers ──────────────────────────────────────────────────────────────

  /**
   * Milliseconds until the next funding settlement.
   * Reads from BTC snapshot nextFundingTime; falls back to UTC 8h boundary.
   */
  getNextSettlementMs(): number {
    const btcSnap = this.marketEngine.getSnapshot("BTC");
    const now     = Date.now();

    if (btcSnap && btcSnap.nextFundingTime > now) {
      return btcSnap.nextFundingTime - now;
    }

    // Fallback: compute from UTC 8h boundary (00:00 / 08:00 / 16:00)
    const periodProgress = now % PERIOD_MS;
    return PERIOD_MS - periodProgress;
  }

  /**
   * Milliseconds since the last funding settlement.
   */
  getTimeSinceSettlementMs(): number {
    return PERIOD_MS - this.getNextSettlementMs();
  }

  /** True when within the capture window (last N minutes before settlement). */
  isInCaptureWindow(): boolean {
    return this.getNextSettlementMs() <= this.captureWindowMs;
  }

  /** True in the 10 minutes immediately after settlement fires. */
  isPostSettlement(): boolean {
    return this.getTimeSinceSettlementMs() <= POST_WINDOW_MS;
  }

  /**
   * Entry size multiplier:
   * - 1.25× at T-0 (settlement imminent — capture the payment)
   * - 1.0×  at T-captureWindow (just entered the window)
   * - 1.0×  outside the window
   */
  getEntryBoost(): number {
    const msLeft = this.getNextSettlementMs();
    if (msLeft > this.captureWindowMs) return 1.0;
    const progress = 1 - msLeft / this.captureWindowMs;
    return 1.0 + 0.25 * progress;
  }

  /**
   * Outside-window penalty for opening new positions.
   * 0.7× — we prefer to hold capital until we're in the capture window.
   */
  getOutsideWindowPenalty(): number {
    return this.isInCaptureWindow() ? 1.0 : 0.7;
  }

  /** Human-readable countdown string, e.g. "4m 23s" or "7h 14m". */
  getCountdownLabel(): string {
    const ms   = this.getNextSettlementMs();
    const secs = Math.floor(ms / 1000);
    const hrs  = Math.floor(secs / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    const sec  = secs % 60;

    if (hrs > 0) return `${hrs}h ${mins}m`;
    return `${mins}m ${sec}s`;
  }

  /** Full status string for [SUMMARY] display. */
  getStatusLine(): string {
    const countdown = this.getCountdownLabel();
    if (this.isPostSettlement()) {
      return `Next settlement: ${countdown}  ⬤ POST-SETTLEMENT (tightened exits)`;
    }
    if (this.isInCaptureWindow()) {
      return `Next settlement: ${countdown}  ★ CAPTURE WINDOW (entering at boost ×${this.getEntryBoost().toFixed(2)})`;
    }
    return `Next settlement: ${countdown}`;
  }
}
