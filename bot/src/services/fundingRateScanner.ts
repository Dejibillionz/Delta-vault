/**
 * FundingRateScanner
 * Scans all Hyperliquid markets every N minutes (default 5) and selects the
 * top K by composite score: 50% funding APR + 30% stability + 20% liquidity.
 *
 * updateCycle() is called every 15s — zero API calls, just EWMA bookkeeping.
 * shouldRescan() → scan() fires the ranked selection on the configured interval.
 */

import { HLMarketDataEngine } from "./hyperliquidExecution";
import { CexFundingRates } from "./cexFundingRates";
import { Logger } from "../logger";

// ── Options & interfaces ───────────────────────────────────────────────────────

export interface FundingRateScannerOptions {
  topN: number;              // assets to select (default 6)
  minDailyVolumeUsd: number; // $5M filter
  minOiUsd: number;          // $1M filter
  rankIntervalMs: number;    // re-rank every 300s
  blacklist: Set<string>;    // assets always excluded
}

export interface AssetScanEntry {
  asset: string;
  ewmaFundingApr: number;    // EWMA absolute hourly rate × 8760
  fundingScore: number;      // 0–1 (capped at 200% APR)
  stabilityScore: number;    // 0–1 (CV-based consistency)
  liquidityScore: number;    // 0–1 (volume + OI blend)
  compositeScore: number;    // weighted sum × trend × CEX multipliers
  dailyVolumeUsd: number;
  openInterestUsd: number;
  selected: boolean;
  trendDirection: 'rising' | 'stable' | 'falling';
  hlPremiumApr: number;      // HL funding rate − best CEX, annualised (signed)
  oiVelocityPct: number;     // OI change rate over last 4 snapshots (negative = unwinding)
}

export interface ScanResult {
  selectedAssets: string[];
  added: string[];
  dropped: string[];
  changed: boolean;
  entries: AssetScanEntry[];
}

// ── Constants ──────────────────────────────────────────────────────────────────

const EWMA_ALPHA     = 0.15;
const MAX_RING       = 20;
const TREND_RING     = 5;    // EWMA samples kept for slope/trend detection
const DEFAULT_ASSETS = ["BTC", "ETH", "SOL", "JTO"];

// ── FundingRateScanner ─────────────────────────────────────────────────────────

export class FundingRateScanner {
  private marketEngine: HLMarketDataEngine;
  private logger: Logger;
  private opts: FundingRateScannerOptions;

  // Per-asset ring buffers of |hourlyRate| samples
  private ringSamples: Map<string, number[]> = new Map();
  // EWMA of absolute hourly funding rate
  private ewmaFunding: Map<string, number> = new Map();
  // Last TREND_RING EWMA values per asset (for slope)
  private trendHistory: Map<string, number[]> = new Map();
  // Optional CEX rate comparison engine
  private cexRates: CexFundingRates | null = null;
  // Current selected top-N
  private selected: string[] = [];
  // Timestamp of last full scan
  private lastScanTs = 0;

  constructor(
    marketEngine: HLMarketDataEngine,
    logger: Logger,
    opts?: Partial<FundingRateScannerOptions>,
    cexRates?: CexFundingRates
  ) {
    this.marketEngine = marketEngine;
    this.logger       = logger;
    this.cexRates     = cexRates ?? null;
    this.opts = {
      topN:              parseInt(process.env.SCANNER_TOP_N                ?? "6"),
      minDailyVolumeUsd: parseFloat(process.env.SCANNER_MIN_DAILY_VOLUME_USD ?? "5000000"),
      minOiUsd:          parseFloat(process.env.SCANNER_MIN_OI_USD           ?? "1000000"),
      rankIntervalMs:    parseInt(process.env.SCANNER_RANK_INTERVAL_MS       ?? "300000"),
      blacklist:         new Set(
        (process.env.SCANNER_BLACKLIST ?? "").split(",").filter(Boolean)
      ),
      ...opts,
    };
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Called every strategy cycle (~15s). Updates EWMA ring buffers from
   * stored market snapshots. Zero API calls — ~1ms.
   */
  updateCycle(): void {
    const snapshots = this.marketEngine.getAllSnapshots();
    for (const [asset, snap] of snapshots) {
      const rate = Math.abs(snap.fundingRate);
      const ring = this.ringSamples.get(asset) ?? [];
      ring.push(rate);
      if (ring.length > MAX_RING) ring.shift();
      this.ringSamples.set(asset, ring);

      const prev     = this.ewmaFunding.get(asset) ?? rate;
      const newEwma  = EWMA_ALPHA * rate + (1 - EWMA_ALPHA) * prev;
      this.ewmaFunding.set(asset, newEwma);

      // Track last TREND_RING EWMA values for slope detection
      const th = this.trendHistory.get(asset) ?? [];
      th.push(newEwma);
      if (th.length > TREND_RING) th.shift();
      this.trendHistory.set(asset, th);
    }
  }

  /** True when a full re-rank is due. */
  shouldRescan(): boolean {
    return Date.now() - this.lastScanTs >= this.opts.rankIntervalMs;
  }

  /**
   * Full re-rank across all stored snapshots.
   * Applies safety filters, scores each asset, selects top N.
   * Prints a ranked table to the console.
   * Returns what changed vs the previous selection.
   */
  async scan(): Promise<ScanResult> {
    this.lastScanTs = Date.now();

    // Refresh CEX rates if available (cached internally — ~2 min TTL)
    if (this.cexRates) await this.cexRates.refresh();

    const snapshots = this.marketEngine.getAllSnapshots();
    const entries: AssetScanEntry[] = [];

    for (const [asset, snap] of snapshots) {
      // Safety filters
      if (this.opts.blacklist.has(asset))                    continue;
      if (snap.dailyVolumeUsd < this.opts.minDailyVolumeUsd) continue;
      if (snap.openInterest   < this.opts.minOiUsd)          continue;

      const ewmaRate = this.ewmaFunding.get(asset) ?? Math.abs(snap.fundingRate);
      const ewmaApr  = ewmaRate * 8760;

      // Funding score: normalised at 200% APR cap
      const fundingScore = Math.min(ewmaApr / 2.0, 1.0);

      // Stability score: coefficient-of-variation approach
      const ring           = this.ringSamples.get(asset) ?? [];
      const stabilityScore = this.computeStability(ring);

      // Liquidity score: $500M daily vol + $100M OI normalisers
      const volNorm        = Math.min(snap.dailyVolumeUsd / 500_000_000, 1);
      const oiNorm         = Math.min(snap.openInterest   / 100_000_000, 1);
      const liquidityScore = 0.6 * volNorm + 0.4 * oiNorm;

      // Trend multiplier (rising: 1.10, stable: 1.00, falling: 0.85)
      const trend          = this.getTrend(asset);
      const trendMult      = trend.direction === 'rising'  ? 1.10 :
                             trend.direction === 'falling' ? 0.85 : 1.00;

      // CEX premium multiplier (+10% max boost / −20% max penalty)
      const cexMult        = this.cexRates
        ? this.cexRates.getScoringMultiplier(asset, snap.fundingRate)
        : 1.0;
      const hlPremiumApr   = this.cexRates
        ? this.cexRates.getHlPremium(asset, snap.fundingRate) * 8760
        : 0;

      // OI velocity multiplier (fast OI drop = unwind risk → penalty)
      const oiVelocityPct = snap.oiChangeRatePct ?? 0;
      const oiVelMult     = oiVelocityPct < -0.05 ? 0.80 :
                            oiVelocityPct < -0.02 ? 0.90 : 1.00;

      // Composite: 50% funding | 30% stability | 20% liquidity — then trend + CEX + OI velocity
      const compositeScore =
        (0.50 * fundingScore + 0.30 * stabilityScore + 0.20 * liquidityScore)
        * trendMult * cexMult * oiVelMult;

      entries.push({
        asset,
        ewmaFundingApr:  ewmaApr,
        fundingScore,
        stabilityScore,
        liquidityScore,
        compositeScore,
        dailyVolumeUsd:  snap.dailyVolumeUsd,
        openInterestUsd: snap.openInterest,
        selected:        false,
        trendDirection:  trend.direction,
        hlPremiumApr,
        oiVelocityPct,
      });
    }

    // Sort descending by composite score
    entries.sort((a, b) => b.compositeScore - a.compositeScore);

    // If no assets survived filters (API unreachable or demo with zero volumes),
    // keep current selection unchanged — or fall back to defaults on first run.
    if (entries.length === 0) {
      const fallback = this.selected.length > 0 ? this.selected : [...DEFAULT_ASSETS];
      this.logger.warn("[SCANNER] No assets passed filters — keeping previous selection");
      return {
        selectedAssets: fallback,
        added: [],
        dropped: [],
        changed: false,
        entries: [],
      };
    }

    const newSelected = entries.slice(0, this.opts.topN).map(e => e.asset);
    for (const e of entries) {
      if (newSelected.includes(e.asset)) e.selected = true;
    }

    // Compute delta vs previous
    const prevSet = new Set(this.selected);
    const newSet  = new Set(newSelected);
    const added   = newSelected.filter(a => !prevSet.has(a));
    const dropped = this.selected.filter(a => !newSet.has(a));
    const changed = added.length > 0 || dropped.length > 0;

    this.selected = newSelected;
    this.printRankTable(entries, added, dropped);

    return { selectedAssets: [...newSelected], added, dropped, changed, entries };
  }

  /** Current top-N asset list (returns a copy). */
  getTopAssets(): string[] {
    return [...this.selected];
  }

  // ── Scoring helpers ───────────────────────────────────────────────────────────

  /**
   * Coefficient-of-variation stability: 1 / (1 + stdDev / mean).
   * Returns 0.5 if fewer than 2 samples (insufficient warmup).
   */
  computeStability(samples: number[]): number {
    if (samples.length < 2) return 0.5;
    const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
    if (mean === 0) return 0.5;
    const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length;
    const stdDev   = Math.sqrt(variance);
    return 1 / (1 + stdDev / mean);
  }

  /**
   * Least-squares slope over the last TREND_RING EWMA samples.
   * Returns direction and strength relative to mean.
   */
  getTrend(asset: string): { slope: number; direction: 'rising' | 'stable' | 'falling'; strengthPct: number } {
    const history = this.trendHistory.get(asset) ?? [];
    if (history.length < 2) return { slope: 0, direction: 'stable', strengthPct: 0 };

    const n = history.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
      sumX  += i;
      sumY  += history[i];
      sumXY += i * history[i];
      sumX2 += i * i;
    }
    const denom = n * sumX2 - sumX * sumX;
    const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;

    const mean       = sumY / n;
    const strengthPct = mean > 0 ? Math.abs(slope / mean) * 100 : 0;
    // Threshold: slope greater than 2% of mean per sample is a meaningful trend
    const threshold  = mean * 0.02;
    const direction: 'rising' | 'stable' | 'falling' =
      slope >  threshold ? 'rising'  :
      slope < -threshold ? 'falling' :
      'stable';

    return { slope, direction, strengthPct };
  }

  /** Expose raw ring buffer for external Kelly variance computation. */
  getRingSamples(asset: string): number[] {
    return [...(this.ringSamples.get(asset) ?? [])];
  }

  // ── Console output ────────────────────────────────────────────────────────────

  private printRankTable(entries: AssetScanEntry[], added: string[], dropped: string[]): void {
    const top = entries.slice(0, 15);
    const lines: string[] = [
      `[SCANNER] ══════════════════════════════════════════════════════════════════`,
      `  Rank  Asset         APR%  T   CEX±%   Stab   Vol($M)    OI($M)    OI%     Score`,
    ];

    top.forEach((e, i) => {
      const rank    = String(i + 1).padStart(5);
      const name    = e.asset.padEnd(12);
      const apr     = (e.ewmaFundingApr * 100).toFixed(1).padStart(7);
      const arrow   = e.trendDirection === 'rising'  ? '↑' :
                      e.trendDirection === 'falling' ? '↓' : '→';
      const cexSign  = e.hlPremiumApr >= 0 ? '+' : '';
      const cexStr   = `${cexSign}${(e.hlPremiumApr * 100).toFixed(1)}`;
      const stab    = e.stabilityScore.toFixed(2).padStart(6);
      const vol     = (e.dailyVolumeUsd  / 1_000_000).toFixed(1).padStart(9);
      const oi      = (e.openInterestUsd / 1_000_000).toFixed(1).padStart(9);
      const oiSign  = e.oiVelocityPct >= 0 ? '+' : '';
      const oiVel   = `${oiSign}${(e.oiVelocityPct * 100).toFixed(1)}%`.padStart(7);
      const score   = e.compositeScore.toFixed(3).padStart(9);
      const star    = e.selected ? "  ★" : "";
      lines.push(`  ${rank}  ${name}  ${apr}%  ${arrow}  ${cexStr.padStart(6)}%  ${stab}  ${vol}  ${oi}  ${oiVel}  ${score}${star}`);
    });

    lines.push(`  Selected:  ${this.selected.join(", ") || "(none)"}`);

    if (added.length > 0 || dropped.length > 0) {
      const parts: string[] = [];
      if (added.length)   parts.push(`+ ${added.join(" ")}`);
      if (dropped.length) parts.push(`- ${dropped.join(" ")}`);
      lines.push(`  Changes:   ${parts.join("    ")}`);
    }

    const nextSec = Math.round(this.opts.rankIntervalMs / 1000);
    lines.push(`  Next rescan in: ${nextSec}s`);
    lines.push(`[SCANNER] ══════════════════════════════════════════════════════════════════`);

    for (const line of lines) this.logger.info(line);
  }
}
