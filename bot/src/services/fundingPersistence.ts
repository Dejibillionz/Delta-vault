/**
 * Funding Persistence Predictor (FPP)
 *
 * Answers: "Is this funding rate likely to stay profitable long enough to extract yield?"
 *
 * Outputs persistenceScore ∈ [0, 1] and expectedEdge (hourly rate units).
 * Gate 6 condition: expectedEdge * persistenceScore ≥ threshold AND persistenceScore ≥ min.
 *
 * Four-component signal stack (no ML — pure quant):
 *   trendScore     (35%) — is funding momentum continuing?
 *   stabilityScore (25%) — is funding predictable cycle-to-cycle?
 *   oiScore        (25%) — does OI support the funding direction?
 *   alignmentScore (15%) — does crowd positioning back the direction?
 *
 * Three hard filters applied after scoring:
 *   fakeSpike    → score = 0      (blow-off top: rate > 2× avg AND reversing)
 *   oiDivergence → score × 0.3   (smart money exiting while funding still positive)
 *   atrConflict  → score × 0.5   (rising volatility destroys persistence)
 */

import { LiveMarketSnapshot } from "./hyperliquidExecution";

// ── Tunable constants (env-var overridable) ────────────────────────────────────
const RING_SIZE          = parseInt(process.env.FPP_RING_SIZE          ?? "20");   // funding history depth
const SLOPE_WINDOW       = parseInt(process.env.FPP_SLOPE_WINDOW       ?? "5");    // samples for slope
const K_INTERVALS        = parseInt(process.env.FPP_K_INTERVALS        ?? "4");    // forward projection steps
const SIGMOID_SCALE      = parseFloat(process.env.FPP_SIGMOID_SCALE    ?? "2e-5"); // hourly-rate slope units
const OI_SCORE_CAP       = parseFloat(process.env.FPP_OI_SCORE_CAP     ?? "0.05"); // 5% OI change → score = 1
const OI_DIVERGE_THRESH  = parseFloat(process.env.FPP_OI_DIVERGE_THRESH ?? "0.03"); // OI drop % triggering kill
const ATR_CONFLICT_MULT  = parseFloat(process.env.FPP_ATR_CONFLICT_MULT ?? "2.0"); // ATR_TARGET × this = conflict
const ATR_TARGET_DEFAULT = parseFloat(process.env.ATR_TARGET_VOL_PCT    ?? "0.02"); // 2% price stdDev baseline
const FEE_EST_HOURLY     = parseFloat(process.env.AUTO_HALT_FEE_EST_APR ?? "0.003") / 8760;
const SPIKE_MIN_SAMPLES  = 5;   // minimum ring depth before fake-spike filter activates

// Component weights — must sum to 1.0
const W_TREND     = 0.35;
const W_STABILITY = 0.25;
const W_OI        = 0.25;
const W_ALIGNMENT = 0.15;

// ── Types ──────────────────────────────────────────────────────────────────────
export interface PersistenceComponents {
  trendScore:     number; // [0, 1] sigmoid of directed funding slope
  stabilityScore: number; // [0, 1] 1 - CV (coefficient of variation)
  oiScore:        number; // [0, 1] OI change supporting funding direction
  alignmentScore: number; // 0 or 1 — crowd positioning backs funding side
}

export interface PersistenceFilters {
  fakeSpike:    boolean; // blow-off top: rate >2× avg AND slope reversing
  oiDivergence: boolean; // OI dropping while funding positive (smart money out)
  atrConflict:  boolean; // ATR above conflict threshold (volatility kills persistence)
}

export interface PersistenceResult {
  persistenceScore: number;      // [0, 1] final score after filters
  expectedEdge:     number;      // projected net edge per hour (funding units, fee-adjusted)
  effectiveEdge:    number;      // expectedEdge × persistenceScore (drop-in for Gate 6)
  components:       PersistenceComponents;
  filters:          PersistenceFilters;
}

// ── Core predictor ─────────────────────────────────────────────────────────────
export class FundingPersistencePredictor {
  private readonly fundingRings = new Map<string, number[]>();
  private readonly lastResults  = new Map<string, PersistenceResult>();

  /**
   * Update the predictor with the latest snapshot for an asset.
   * Call once per strategy cycle per asset. Returns the computed result immediately.
   */
  update(asset: string, snap: LiveMarketSnapshot): PersistenceResult {
    const ring = this.fundingRings.get(asset) ?? [];
    ring.push(snap.fundingRate);
    if (ring.length > RING_SIZE) ring.shift();
    this.fundingRings.set(asset, ring);

    const result = this._compute(snap, ring);
    this.lastResults.set(asset, result);
    return result;
  }

  /** Return the most recently computed result without updating history. */
  getLatestResult(asset: string): PersistenceResult | null {
    return this.lastResults.get(asset) ?? null;
  }

  /** Convenience: best effectiveEdge across a list of assets (uses cached results). */
  bestEffectiveEdge(assets: string[]): number {
    return assets.reduce((best, a) => {
      const r = this.lastResults.get(a);
      return r ? Math.max(best, r.effectiveEdge) : best;
    }, 0);
  }

  private _compute(snap: LiveMarketSnapshot, ring: number[]): PersistenceResult {
    const fNow = snap.fundingRate;
    const n    = ring.length;

    // ── Basic statistics over funding history ──────────────────────────────────
    const mean        = ring.reduce((s, v) => s + v, 0) / n;
    const avgAbsFunding = ring.reduce((s, v) => s + Math.abs(v), 0) / n;
    const fStd        = n >= 2
      ? Math.sqrt(ring.reduce((s, v) => s + (v - mean) ** 2, 0) / n)
      : 0;

    // Slope: change per sample over last SLOPE_WINDOW samples
    const sw      = Math.min(SLOPE_WINDOW, n - 1);
    const rawSlope = sw > 0 ? (ring[n - 1] - ring[n - 1 - sw]) / sw : 0;

    // Directed slope: positive when funding is strengthening (works for both +/- funding)
    const dirSlope = Math.sign(fNow || 1) * rawSlope;

    // ── Component scores ──────────────────────────────────────────────────────

    // 1. Trend: sigmoid of directed slope — scores how well momentum supports persistence
    const trendScore = sigmoid(dirSlope / SIGMOID_SCALE);

    // 2. Stability: 1 − coefficient_of_variation (low stdDev/mean → high stability)
    //    Cap CV at 1.0 to bound the score; guard against zero-mean division.
    const cv = avgAbsFunding > 1e-10 ? Math.min(1, fStd / avgAbsFunding) : 1;
    const stabilityScore = Math.max(0, 1 - cv);

    // 3. OI score: OI growing in direction that supports funding → higher persistence
    //    oiChangeRatePct is fractional change (e.g. 0.05 = OI up 5%)
    const oiSlope = snap.oiChangeRatePct ?? 0;
    const oiDirected = fNow >= 0 ? oiSlope : -oiSlope; // want OI ↑ for positive, ↓ for negative
    const oiScore = Math.max(0, Math.min(1, oiDirected / OI_SCORE_CAP));

    // 4. Alignment: crowd positioning backs the funding side
    //    longShortRatio > 0.55 = bullish crowd; positive funding (longs pay) persists when crowd long
    const priceBullish = (snap.longShortRatio ?? 0.5) > 0.55;
    const alignmentScore = (fNow > 0 && priceBullish) || (fNow < 0 && !priceBullish) ? 1 : 0;

    // ── Raw score ─────────────────────────────────────────────────────────────
    let persistence = W_TREND     * trendScore
                    + W_STABILITY * stabilityScore
                    + W_OI        * oiScore
                    + W_ALIGNMENT * alignmentScore;

    // ── Filters ───────────────────────────────────────────────────────────────

    // A. Fake spike: current rate > 2× average AND already reversing (blow-off top)
    const fakeSpike = n >= SPIKE_MIN_SAMPLES
      && avgAbsFunding > 0
      && Math.abs(fNow) > 2 * avgAbsFunding
      && (fNow > 0 ? rawSlope < 0 : rawSlope > 0);

    // B. OI divergence: positive funding but OI falling fast (smart money leaving)
    const oiDivergence = fNow > 0 && oiSlope < -OI_DIVERGE_THRESH;

    // C. ATR conflict: volatility spiking → execution risk kills persistence
    const atrConflict = (snap.atrPct ?? 0) > ATR_TARGET_DEFAULT * ATR_CONFLICT_MULT;

    if (fakeSpike)    persistence = 0;
    if (oiDivergence) persistence *= 0.3;
    if (atrConflict)  persistence *= 0.5;

    persistence = clamp01(persistence);

    // ── Expected edge projection ──────────────────────────────────────────────
    // Project funding K intervals forward using current slope
    const projectedFunding = fNow + rawSlope * K_INTERVALS;
    const expectedEdge     = Math.abs(projectedFunding) - FEE_EST_HOURLY;
    const effectiveEdge    = Math.max(0, expectedEdge) * persistence;

    return {
      persistenceScore: persistence,
      expectedEdge,
      effectiveEdge,
      components: { trendScore, stabilityScore, oiScore, alignmentScore },
      filters:    { fakeSpike, oiDivergence, atrConflict },
    };
  }
}

// ── Math helpers ──────────────────────────────────────────────────────────────
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
