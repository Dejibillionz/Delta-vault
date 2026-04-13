/**
 * Funding Regime Classifier (FRC) + Exit Timing Model (ETM)
 *
 * FRC classifies each asset's position in the funding cycle:
 *   ACCUMULATION → EXPANSION → PEAK → DECAY → RESET
 *
 * ETM computes an exitScore ∈ [0, 1] from four weighted signals to front-run
 * funding collapse before it hits the P&L:
 *   exitScore > ETM_EXIT_FULL    → FULL_EXIT
 *   exitScore > ETM_EXIT_PARTIAL → REDUCE_50
 *   otherwise                   → HOLD
 *
 * Entry sizing by regime:
 *   EXPANSION   → 1.0× (full size, best zone)
 *   ACCUMULATION → 0.5× (early build-up, half size)
 *   PEAK / DECAY / RESET → blocked at entry gate in index.ts
 */

import { LiveMarketSnapshot } from "./hyperliquidExecution";
import { PersistenceResult } from "./fundingPersistence";

// ── Constants (env-var overridable) ─────────────────────────────────────────
const FRC_RING_SIZE             = parseInt(process.env.FRC_RING_SIZE             ?? "20");
const FRC_SLOPE_WINDOW          = parseInt(process.env.FRC_SLOPE_WINDOW          ?? "5");
const FRC_HIGH_Z                = parseFloat(process.env.FRC_HIGH_Z              ?? "1.5"); // z-score threshold for PEAK
const FRC_EXPANSION_MIN_PERSIST = parseFloat(process.env.FRC_EXPANSION_MIN_PERSIST ?? "0.6");

const ETM_EXIT_FULL          = parseFloat(process.env.ETM_EXIT_FULL          ?? "0.7");
const ETM_EXIT_PARTIAL       = parseFloat(process.env.ETM_EXIT_PARTIAL       ?? "0.5");
const ETM_PERSIST_DROP_WINDOW = parseInt(process.env.ETM_PERSIST_DROP_WINDOW ?? "3");  // ring depth for drop detection
// Normalizers: values at which the raw signal maps to score = 1.0
const ETM_SLOPE_NORM = parseFloat(process.env.ETM_SLOPE_NORM ?? "0.0001"); // ≈ 87.6% APR change per sample
const ETM_OI_NORM    = parseFloat(process.env.ETM_OI_NORM    ?? "0.05");  // 5% OI change

// ── Types ───────────────────────────────────────────────────────────────────
export type FundingRegime = "ACCUMULATION" | "EXPANSION" | "PEAK" | "DECAY" | "RESET";
export type ExitAction    = "HOLD" | "REDUCE_50" | "FULL_EXIT";

export interface RegimeResult {
  regime:   FundingRegime;
  f_z:      number;  // z-score of f_now vs recent history
  f_slope:  number;  // funding change per sample
  f_accel:  number;  // change in slope (second derivative)
}

export interface ExitSignal {
  exitScore:  number;      // [0, 1] — higher = stronger exit pressure
  action:     ExitAction;
  components: {
    negSlope:        number;  // [0,1] negative funding momentum
    negOi:           number;  // [0,1] OI unwinding
    persistenceDrop: number;  // [0,1] persistence score decline
    overextended:    number;  // [0,1] z-score elevation
  };
  reason: string;
}

// ── FundingRegimeClassifier ──────────────────────────────────────────────────
export class FundingRegimeClassifier {
  // Per-asset ring buffers
  private readonly fundingRings  = new Map<string, number[]>(); // raw funding history
  private readonly slopeRings    = new Map<string, number[]>(); // slope history → acceleration
  private readonly persistRings  = new Map<string, number[]>(); // persistence history → drop detection
  private readonly lastResults   = new Map<string, RegimeResult>();

  /**
   * Update ring buffers with the latest snapshot + FPP persistenceScore.
   * Call once per strategy cycle per asset, immediately after fpp.update().
   * Returns the classified regime and derived metrics.
   */
  update(asset: string, snap: LiveMarketSnapshot, persistenceScore: number): RegimeResult {
    const fNow = snap.fundingRate;
    const oi_slope = snap.oiChangeRatePct ?? 0;

    // ── Funding ring ──────────────────────────────────────────────────────
    const fRing = this.fundingRings.get(asset) ?? [];
    fRing.push(fNow);
    if (fRing.length > FRC_RING_SIZE) fRing.shift();
    this.fundingRings.set(asset, fRing);

    // ── Persistence ring ──────────────────────────────────────────────────
    const pRing = this.persistRings.get(asset) ?? [];
    pRing.push(persistenceScore);
    if (pRing.length > ETM_PERSIST_DROP_WINDOW + 1) pRing.shift();
    this.persistRings.set(asset, pRing);

    // ── Derived metrics ───────────────────────────────────────────────────
    const n    = fRing.length;
    const mean = fRing.reduce((s, v) => s + v, 0) / n;
    const std  = n >= 2
      ? Math.sqrt(fRing.reduce((s, v) => s + (v - mean) ** 2, 0) / n)
      : 0;
    const f_z = std > 0 ? (fNow - mean) / std : 0;

    // Funding slope: Δrate per sample over last SLOPE_WINDOW samples
    const sw      = Math.min(FRC_SLOPE_WINDOW, n - 1);
    const f_slope = sw > 0 ? (fRing[n - 1] - fRing[n - 1 - sw]) / sw : 0;

    // Acceleration: slope_now − slope_prev
    const sRing   = this.slopeRings.get(asset) ?? [];
    const f_accel = sRing.length > 0 ? f_slope - sRing[sRing.length - 1] : 0;
    sRing.push(f_slope);
    if (sRing.length > FRC_RING_SIZE) sRing.shift();
    this.slopeRings.set(asset, sRing);

    // ── Classify ──────────────────────────────────────────────────────────
    const regime = this._classify({ fNow, f_slope, f_accel, oi_slope, f_z, persistenceScore });

    const result: RegimeResult = { regime, f_z, f_slope, f_accel };
    this.lastResults.set(asset, result);
    return result;
  }

  /**
   * Compute exit pressure for an asset with an open position.
   * Uses the most recent regime + ring data — does not update any state.
   * Call AFTER update() in the same cycle.
   */
  getExitSignal(asset: string, snap: LiveMarketSnapshot, fppResult: PersistenceResult): ExitSignal {
    const last    = this.lastResults.get(asset);
    const regime  = last?.regime  ?? "RESET";
    const f_z     = last?.f_z     ?? 0;
    const f_slope = last?.f_slope ?? 0;
    const oi_slope = snap.oiChangeRatePct ?? 0;

    // ── Persistence drop ─────────────────────────────────────────────────
    // Compare current persistenceScore to earliest value in the drop-window ring
    const pRing = this.persistRings.get(asset) ?? [];
    const prevP  = pRing.length > 1 ? pRing[0] : fppResult.persistenceScore;
    const rawDrop = Math.max(0, prevP - fppResult.persistenceScore);
    // Normalize: a drop of 0.3 (30%) maps to persistenceDrop = 1.0
    const persistenceDrop = Math.min(1, rawDrop / 0.3);

    // ── Component scores (all [0, 1]) ────────────────────────────────────
    const negSlope    = Math.min(1, Math.max(0, -f_slope    / ETM_SLOPE_NORM));
    const negOi       = Math.min(1, Math.max(0, -oi_slope   / ETM_OI_NORM));
    const overextended = Math.min(1, Math.max(0, f_z / 3));  // z=3 maps to score=1

    // ── Weighted exit score ───────────────────────────────────────────────
    const exitScore = Math.min(1,
      0.30 * negSlope    +
      0.25 * negOi       +
      0.25 * persistenceDrop +
      0.20 * overextended
    );

    // DECAY regime overrides score — exit unconditionally
    const action: ExitAction =
      regime === "DECAY"             ? "FULL_EXIT" :
      exitScore >= ETM_EXIT_FULL     ? "FULL_EXIT" :
      exitScore >= ETM_EXIT_PARTIAL  ? "REDUCE_50" :
      "HOLD";

    // ── Reason string ─────────────────────────────────────────────────────
    const parts: string[] = [];
    if (regime === "DECAY")       parts.push("regime=DECAY");
    if (negSlope > 0.5)           parts.push(`slope↓${negSlope.toFixed(2)}`);
    if (negOi > 0.5)              parts.push(`OI↓${negOi.toFixed(2)}`);
    if (persistenceDrop > 0.5)    parts.push(`persist↓${rawDrop.toFixed(2)}`);
    if (overextended > 0.5)       parts.push(`z=${f_z.toFixed(1)}`);

    return {
      exitScore,
      action,
      components: { negSlope, negOi, persistenceDrop, overextended },
      reason: parts.join(", ") || "stable",
    };
  }

  /** Returns the last cached regime result without updating state. */
  getLatestRegime(asset: string): RegimeResult | null {
    return this.lastResults.get(asset) ?? null;
  }

  // ── Core classification (pure function) ─────────────────────────────────
  private _classify(d: {
    fNow: number; f_slope: number; f_accel: number;
    oi_slope: number; f_z: number; persistenceScore: number;
  }): FundingRegime {
    const { f_slope, f_accel, oi_slope, f_z, persistenceScore } = d;

    // Priority order: DECAY first (most urgent exit condition)
    if (f_slope < 0 && oi_slope <= 0)
      return "DECAY";

    // PEAK: high z-score AND momentum stalling or reversing
    if (f_z > FRC_HIGH_Z && (f_slope <= 0 || f_accel < 0))
      return "PEAK";

    // EXPANSION: rising funding + rising OI + persistence confirmed
    if (f_slope > 0 && oi_slope > 0 && persistenceScore >= FRC_EXPANSION_MIN_PERSIST)
      return "EXPANSION";

    // ACCUMULATION: early signals, persistence not yet confirmed
    if (f_slope > 0 && oi_slope > 0)
      return "ACCUMULATION";

    // RESET: near-zero or ambiguous activity
    return "RESET";
  }
}
