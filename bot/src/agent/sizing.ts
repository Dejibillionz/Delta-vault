import { AgentState } from "./state";

const BASE_SIZE       = 3_000;
const MIN_SIZE        = 30;
const RISK_FREE_APR   = 0.05;   // 5% hurdle rate
const HALF_KELLY      = 0.5;    // half-Kelly safety multiplier
const MIN_KELLY_FRAC  = 0.03;   // never risk less than 3% of capital per asset
const MAX_KELLY_FRAC  = 0.50;   // never risk more than 50% per asset

/**
 * Returns recommended position size in USD.
 *
 * When fundingAprDecimal + fundingVariance are supplied, uses the half-Kelly
 * Criterion to size proportionally to edge/variance:
 *   edge     = max(0, fundingAPR - riskFree)
 *   f*       = (edge / variance) × HALF_KELLY
 *   size     = clamp(f*, MIN, MAX) × BASE_SIZE
 *
 * Falls back to the original heuristic (winRate / volatility / confidence)
 * when funding stats are unavailable.
 */
export function getPositionSize(
  state: AgentState,
  volatility: number,
  fundingAprDecimal?: number,  // e.g. 0.167 for 16.7% APR
  fundingVariance?: number,    // annualised sample variance of |fundingRate| ring buffer
): number {
  if (fundingAprDecimal !== undefined && fundingVariance !== undefined) {
    // ── Half-Kelly path ──────────────────────────────────────────────────────
    const edge         = Math.max(0, fundingAprDecimal - RISK_FREE_APR);
    const safeVariance = Math.max(fundingVariance, 0.0001);       // floor to avoid ÷0
    const kellyFrac    = (edge / safeVariance) * HALF_KELLY;
    const clampedFrac  = Math.max(MIN_KELLY_FRAC, Math.min(MAX_KELLY_FRAC, kellyFrac));

    let size = BASE_SIZE * clampedFrac / 0.25; // normalise so frac=0.25 ≈ old BASE_SIZE

    // Apply confidence and volatility dampeners on top of Kelly
    size *= state.confidence;
    if (volatility > 1) size *= 0.7;

    return Math.max(size, MIN_SIZE);
  }

  // ── Legacy heuristic path (backward-compatible) ───────────────────────────
  let size = BASE_SIZE;
  if (state.winRate > 0.6) size *= 1.5;
  if (volatility > 1)      size *= 0.5;
  size *= state.confidence;
  return Math.max(size, MIN_SIZE);
}

