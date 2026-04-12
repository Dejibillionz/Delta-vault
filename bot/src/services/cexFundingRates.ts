/**
 * CexFundingRates
 * Fetches per-hour funding rates from Binance Futures and Bybit Linear in one call each.
 * Both APIs are public — no API key required.
 *
 * Rates are normalised to per-hour (same unit as Hyperliquid) so they're directly comparable.
 * Binance / Bybit express rates per-8h → divide by 8.
 *
 * Used by FundingRateScanner to compute the HL premium over CEX venues:
 *   hlPremium > 0  → HL pays more → rate is likely to persist (good)
 *   hlPremium < 0  → CEX pays more → HL rate may snap back (risky)
 */

import axios from "axios";
import { Logger } from "../logger";

export type CexVenue = "binance" | "bybit";

// Symbol mapping: HL asset → CEX symbol format
function toBinanceSymbol(asset: string): string {
  return `${asset}USDT`;
}
function toBybitSymbol(asset: string): string {
  return `${asset}USDT`;
}
function fromBinanceSymbol(symbol: string): string | null {
  if (!symbol.endsWith("USDT")) return null;
  return symbol.slice(0, -4);
}
function fromBybitSymbol(symbol: string): string | null {
  if (!symbol.endsWith("USDT")) return null;
  return symbol.slice(0, -4);
}

export class CexFundingRates {
  private logger: Logger;
  private binanceRates: Map<string, number> = new Map(); // asset → per-hour rate
  private bybitRates:   Map<string, number> = new Map();
  private lastRefresh  = 0;
  private CACHE_MS     = 120_000; // refresh at most every 2 min (CEX rates change every 8h)

  constructor(logger: Logger) {
    this.logger = logger;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /** Fetch latest rates from Binance + Bybit. Cached for 2 min. */
  async refresh(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRefresh < this.CACHE_MS) return;
    this.lastRefresh = now;

    await Promise.allSettled([
      this.fetchBinance(),
      this.fetchBybit(),
    ]);
  }

  /** Per-hour funding rate for an asset on a given venue. Returns 0 if unknown. */
  getRate(asset: string, venue: CexVenue): number {
    return venue === "binance"
      ? (this.binanceRates.get(asset) ?? 0)
      : (this.bybitRates.get(asset)   ?? 0);
  }

  /**
   * HL premium over best CEX rate (both expressed per-hour).
   * Positive = HL pays more → sustainable.
   * Negative = CEX pays more → HL funding may be a temporary blip.
   */
  getHlPremium(asset: string, hlRatePerHour: number): number {
    const bestCex = Math.max(
      Math.abs(this.binanceRates.get(asset) ?? 0),
      Math.abs(this.bybitRates.get(asset)   ?? 0),
    );
    return Math.abs(hlRatePerHour) - bestCex;
  }

  /**
   * Score multiplier for the scanner composite score based on HL premium.
   * +10% max boost when HL premium ≥ 50% APR above best CEX.
   * −20% max penalty when CEX premium ≥ 50% APR above HL.
   */
  getScoringMultiplier(asset: string, hlRatePerHour: number): number {
    const premiumPerHour = this.getHlPremium(asset, hlRatePerHour);
    const premiumApr     = premiumPerHour * 8760;
    // clamp: +0.10 at +50% APR premium, -0.20 at -50% APR premium
    const raw = premiumApr / 0.5; // normalise at 50% APR
    return 1 + Math.max(-0.20, Math.min(0.10, raw * 0.10));
  }

  /** Summary string for logging (top 5 assets by Binance rate). */
  getSummary(assets: string[]): string {
    return assets
      .map(a => {
        const b = (this.binanceRates.get(a) ?? 0) * 8760 * 100;
        const y = (this.bybitRates.get(a)   ?? 0) * 8760 * 100;
        return `${a}: BN${b.toFixed(1)}% BY${y.toFixed(1)}%`;
      })
      .join("  ");
  }

  // ── Fetch helpers ─────────────────────────────────────────────────────────────

  private async fetchBinance(): Promise<void> {
    try {
      const res = await axios.get(
        "https://fapi.binance.com/fapi/v1/premiumIndex",
        { timeout: 5000 }
      );
      const data = res.data as { symbol: string; lastFundingRate: string }[];
      this.binanceRates.clear();
      for (const item of data) {
        const asset = fromBinanceSymbol(item.symbol);
        if (!asset) continue;
        // Binance lastFundingRate is per-8h; divide by 8 for per-hour
        this.binanceRates.set(asset, parseFloat(item.lastFundingRate ?? "0") / 8);
      }
    } catch (err: any) {
      this.logger.warn(`[CEX] Binance fetch failed: ${err.message}`);
    }
  }

  private async fetchBybit(): Promise<void> {
    try {
      const res = await axios.get(
        "https://api.bybit.com/v5/market/tickers?category=linear",
        { timeout: 5000 }
      );
      const list = res.data?.result?.list as { symbol: string; fundingRate: string }[] ?? [];
      this.bybitRates.clear();
      for (const item of list) {
        const asset = fromBybitSymbol(item.symbol);
        if (!asset) continue;
        // Bybit fundingRate is per-8h; divide by 8 for per-hour
        this.bybitRates.set(asset, parseFloat(item.fundingRate ?? "0") / 8);
      }
    } catch (err: any) {
      this.logger.warn(`[CEX] Bybit fetch failed: ${err.message}`);
    }
  }
}
