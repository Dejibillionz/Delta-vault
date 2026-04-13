/**
 * Funding Regime Classifier (FRC) + Exit Timing Model (ETM)
 *
 * FRC classifies each asset's position in the funding cycle:
 *   ACCUMULATION → EXPANSION → PEAK_EARLY → PEAK → DECAY → RESET
 *
 * Refinements over v1:
 *   1. Hysteresis band at EXPANSION/ACCUMULATION boundary (0.55/0.65) prevents oscillation
 *   2. PEAK_EARLY regime (z > 1.2 + f_accel < 0) front-runs exhaustion before slope flattens
 *   3. EMA smoothing (α=0.2) on exitScore prevents single-cycle noise from triggering exits
 *   4. Re-entry cooldown after REDUCE_50 — blocks size increase for N cycles to avoid churn
 *   5. Persistence override — ACCUMULATION at persistence > 0.75 gets full size (strong early trend)
 *
 * ETM exit thresholds:
 *   FULL_EXIT  if regime=DECAY  OR  exitScoreSmoothed > ETM_EXIT_FULL
 *   REDUCE_50  if exitScoreSmoothed > ETM_EXIT_PARTIAL
 *   HOLD       otherwise
 */

import { LiveMarketSnapshot } from "./hyperliquidExecution";
import { PersistenceResult } from "./fundingPersistence";

// ── Constants (env-var overridable) ─────────────────────────────────────────

// Hysteresis thresholds for EXPANSION/ACCUMULATION boundary
const FRC_EXPANSION_ENTER = parseFloat(process.env.FRC_EXPANSION_ENTER ?? "0.65"); // need this to upgrade
const FRC_EXPANSION_EXIT  = parseFloat(process.env.FRC_EXPANSION_EXIT  ?? "0.55"); // drop below here to downgrade
// PEAK_EARLY: early warning before full PEAK (blocks entries, no forced exit)
const FRC_PEAK_EARLY_Z    = parseFloat(process.env.FRC_PEAK_EARLY_Z    ?? "1.2");
// Standard PEAK threshold (full entry block + ETM active)
const FRC_HIGH_Z          = parseFloat(process.env.FRC_HIGH_Z          ?? "1.5");

const FRC_RING_SIZE       = parseInt(process.env.FRC_RING_SIZE       ?? "20");
const FRC_SLOPE_WINDOW    = parseInt(process.env.FRC_SLOPE_WINDOW    ?? "5");

// ETM: EMA smoothing to filter single-cycle noise
const ETM_EMA_ALPHA          = parseFloat(process.env.ETM_EMA_ALPHA          ?? "0.2");
const ETM_EXIT_FULL          = parseFloat(process.env.ETM_EXIT_FULL          ?? "0.7");
const ETM_EXIT_PARTIAL       = parseFloat(process.env.ETM_EXIT_PARTIAL       ?? "0.5");
const ETM_PERSIST_DROP_WINDOW = parseInt(process.env.ETM_PERSIST_DROP_WINDOW ?? "3");
const ETM_SLOPE_NORM         = parseFloat(process.env.ETM_SLOPE_NORM         ?? "0.0001");
const ETM_OI_NORM            = parseFloat(process.env.ETM_OI_NORM            ?? "0.05");

// Reduce cooldown: cycles to block re-entry after REDUCE_50
const FRC_REDUCE_COOLDOWN_CYCLES = parseInt(process.env.FRC_REDUCE_COOLDOWN_CYCLES ?? "3");

// ── Types ───────────────────────────────────────────────────────────────────
export type FundingRegime =
  | "ACCUMULATION"
  | "EXPANSION"
  | "PEAK_EARLY"    // z > FRC_PEAK_EARLY_Z + decelerating: block entries, no forced exit
  | "PEAK"          // z > FRC_HIGH_Z + stalling: block entries, ETM active
  | "DECAY"         // slope↓ + OI↓: force FULL_EXIT
  | "RESET";

export type ExitAction = "HOLD" | "REDUCE_50" | "FULL_EXIT";

export interface RegimeResult {
  regime:   FundingRegime;
  f_z:      number;  // z-score of f_now vs recent history
  f_slope:  number;  // funding change per sample
  f_accel:  number;  // change in slope (second derivative)
}

export interface ExitSignal {
  exitScore:         number;  // raw score [0, 1]
  exitScoreSmoothed: number;  // EMA-smoothed score [0, 1] — this drives action
  action:            ExitAction;
  components: {
    negSlope:        number;
    negOi:           number;
    persistenceDrop: number;
    overextended:    number;
  };
  reason: string;
}

// ── FundingRegimeClassifier ──────────────────────────────────────────────────
export class FundingRegimeClassifier {
  // Per-asset ring buffers
  private readonly fundingRings  = new Map<string, number[]>(); // raw funding history
  private readonly slopeRings    = new Map<string, number[]>(); // slope history → acceleration
  private readonly persistRings  = new Map<string, number[]>(); // persistence history → drop detection

  // ETM state (mutated by getExitSignal)
  private readonly exitScoreEMA  = new Map<string, number>();   // smoothed exit score per asset
  private readonly reduceCooldown = new Map<string, number>();  // cycles remaining after REDUCE_50

  // Classifier state
  private readonly lastResults   = new Map<string, RegimeResult>();

  /**
   * Update ring buffers with the latest snapshot + FPP persistenceScore.
   * Call once per strategy cycle per asset, immediately after fpp.update().
   * Returns the classified regime and derived metrics.
   */
  update(asset: string, snap: LiveMarketSnapshot, persistenceScore: number): RegimeResult {
    const fNow     = snap.fundingRate;
    const oi_slope = snap.oiChangeRatePct ?? 0;

    // ── Decrement reduce cooldown (counts down every cycle) ───────────────
    const cd = this.reduceCooldown.get(asset) ?? 0;
    if (cd > 0) this.reduceCooldown.set(asset, cd - 1);

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

    const sw      = Math.min(FRC_SLOPE_WINDOW, n - 1);
    const f_slope = sw > 0 ? (fRing[n - 1] - fRing[n - 1 - sw]) / sw : 0;

    const sRing   = this.slopeRings.get(asset) ?? [];
    const f_accel = sRing.length > 0 ? f_slope - sRing[sRing.length - 1] : 0;
    sRing.push(f_slope);
    if (sRing.length > FRC_RING_SIZE) sRing.shift();
    this.slopeRings.set(asset, sRing);

    // ── Classify raw regime ───────────────────────────────────────────────
    const rawRegime = this._classify({ fNow, f_slope, f_accel, oi_slope, f_z, persistenceScore });

    // ── Apply hysteresis at EXPANSION/ACCUMULATION boundary ──────────────
    const prevRegime = this.lastResults.get(asset)?.regime;
    const regime     = this._applyHysteresis(rawRegime, prevRegime, persistenceScore);

    const result: RegimeResult = { regime, f_z, f_slope, f_accel };
    this.lastResults.set(asset, result);
    return result;
  }

  /**
   * Compute exit pressure for an asset with an open position.
   * Applies EMA smoothing to filter noise — mutates exitScoreEMA state.
   * Sets reduceCooldown when action is REDUCE_50.
   * Call AFTER update() in the same cycle.
   */
  getExitSignal(asset: string, snap: LiveMarketSnapshot, fppResult: PersistenceResult): ExitSignal {
    const last     = this.lastResults.get(asset);
    const regime   = last?.regime  ?? "RESET";
    const f_z      = last?.f_z     ?? 0;
    const f_slope  = last?.f_slope ?? 0;
    const oi_slope = snap.oiChangeRatePct ?? 0;

    // ── Persistence drop ─────────────────────────────────────────────────
    const pRing  = this.persistRings.get(asset) ?? [];
    const prevP  = pRing.length > 1 ? pRing[0] : fppResult.persistenceScore;
    const rawDrop = Math.max(0, prevP - fppResult.persistenceScore);
    const persistenceDrop = Math.min(1, rawDrop / 0.3); // 30% drop → score = 1

    // ── Component scores [0, 1] ──────────────────────────────────────────
    const negSlope     = Math.min(1, Math.max(0, -f_slope    / ETM_SLOPE_NORM));
    const negOi        = Math.min(1, Math.max(0, -oi_slope   / ETM_OI_NORM));
    const overextended = Math.min(1, Math.max(0, f_z / 3));

    const exitScore = Math.min(1,
      0.30 * negSlope       +
      0.25 * negOi          +
      0.25 * persistenceDrop +
      0.20 * overextended
    );

    // ── EMA smoothing: α=0.2 (~75s effective window at 15s cycles) ───────
    const prevEMA = this.exitScoreEMA.get(asset) ?? exitScore;
    const exitScoreSmoothed = ETM_EMA_ALPHA * exitScore + (1 - ETM_EMA_ALPHA) * prevEMA;
    this.exitScoreEMA.set(asset, exitScoreSmoothed);

    // ── Action: DECAY always → FULL_EXIT; otherwise use smoothed score ───
    const action: ExitAction =
      regime === "DECAY"                         ? "FULL_EXIT" :
      exitScoreSmoothed >= ETM_EXIT_FULL         ? "FULL_EXIT" :
      exitScoreSmoothed >= ETM_EXIT_PARTIAL      ? "REDUCE_50" :
      "HOLD";

    // Set cooldown when reducing — blocks re-entry for N cycles
    if (action === "REDUCE_50") {
      this.reduceCooldown.set(asset, FRC_REDUCE_COOLDOWN_CYCLES);
    }

    // ── Reason string ────────────────────────────────────────────────────
    const parts: string[] = [];
    if (regime === "DECAY")       parts.push("regime=DECAY");
    if (negSlope > 0.5)           parts.push(`slope↓${negSlope.toFixed(2)}`);
    if (negOi > 0.5)              parts.push(`OI↓${negOi.toFixed(2)}`);
    if (persistenceDrop > 0.5)    parts.push(`persist↓${rawDrop.toFixed(2)}`);
    if (overextended > 0.5)       parts.push(`z=${f_z.toFixed(1)}`);

    return {
      exitScore,
      exitScoreSmoothed,
      action,
      components: { negSlope, negOi, persistenceDrop, overextended },
      reason: parts.join(", ") || "stable",
    };
  }

  /** Returns remaining reduce-cooldown cycles for this asset (0 = no cooldown). */
  getReduceCooldown(asset: string): number {
    return this.reduceCooldown.get(asset) ?? 0;
  }

  /** Returns the last cached regime result without updating state. */
  getLatestRegime(asset: string): RegimeResult | null {
    return this.lastResults.get(asset) ?? null;
  }

  // ── Core classification (priority order: DECAY → PEAK → PEAK_EARLY → EXPANSION → ACCUMULATION → RESET)
  private _classify(d: {
    fNow: number; f_slope: number; f_accel: number;
    oi_slope: number; f_z: number; persistenceScore: number;
  }): FundingRegime {
    const { f_slope, f_accel, oi_slope, f_z, persistenceScore } = d;

    // 1. DECAY — most urgent: funding falling + OI unwinding
    if (f_slope < 0 && oi_slope <= 0)
      return "DECAY";

    // 2. PEAK — high z-score + momentum stalling or reversing
    if (f_z > FRC_HIGH_Z && (f_slope <= 0 || f_accel < 0))
      return "PEAK";

    // 3. PEAK_EARLY — z > 1.2 + decelerating: front-runs exhaustion before slope flattens
    if (f_z > FRC_PEAK_EARLY_Z && f_accel < 0)
      return "PEAK_EARLY";

    // 4. EXPANSION — persistence confirmed (hysteresis applied in update())
    if (f_slope > 0 && oi_slope > 0 && persistenceScore >= FRC_EXPANSION_ENTER)
      return "EXPANSION";

    // 5. ACCUMULATION — early signals without persistence confirmation
    if (f_slope > 0 && oi_slope > 0)
      return "ACCUMULATION";

    // 6. RESET — ambiguous or near-zero activity
    return "RESET";
  }

  // ── Hysteresis at EXPANSION/ACCUMULATION boundary ──────────────────────
  private _applyHysteresis(
    raw: FundingRegime,
    prev: FundingRegime | undefined,
    persistence: number,
  ): FundingRegime {
    // Dangerous regimes (PEAK/PEAK_EARLY/DECAY/RESET) override immediately — no hysteresis
    if (raw !== "EXPANSION" && raw !== "ACCUMULATION") return raw;

    if (prev === "EXPANSION") {
      // Stay in EXPANSION unless persistence drops below exit threshold (0.55)
      return persistence >= FRC_EXPANSION_EXIT ? "EXPANSION" : raw;
    }

    if (prev === "ACCUMULATION") {
      // Only upgrade to EXPANSION if persistence meets the higher enter threshold (0.65)
      if (raw === "EXPANSION" && persistence < FRC_EXPANSION_ENTER) return "ACCUMULATION";
    }

    return raw;
  }
}
