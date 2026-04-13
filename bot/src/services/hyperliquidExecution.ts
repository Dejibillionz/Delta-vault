/**
 * HyperliquidExecutor
 * Replaces Drift perp execution. Uses Hyperliquid REST API for:
 *   - Live funding rate data (replaces driftClient.getPerpMarketAccount)
 *   - Perp order placement: SHORT/LONG via EIP-712 signed actions
 *   - Equity/position reads
 *
 * In DEMO_MODE all network calls are skipped; positions are tracked in-memory.
 */

import axios from "axios";
import { ethers } from "ethers";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import { Logger } from "../logger";

const HL_BASE = process.env.HYPERLIQUID_API_URL ?? "https://api.hyperliquid.xyz";
const DEMO_MODE = process.env.DEMO_MODE !== "false";
const DEMO_EQUITY = parseFloat(process.env.DEMO_EQUITY ?? "10000");

// ── Types ──────────────────────────────────────────────────────────────────────
export interface PositionInfo {
  asset: string;
  side: "LONG" | "SHORT";
  size: number;         // base quantity
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  fundingAccrued: number;
}

export interface HlMarketSnapshot {
  asset: string;
  fundingRatePerHour: number;   // signed decimal, e.g. 0.000125 = 0.0125%/hr
  markPrice: number;
  openInterest: number;
}

export interface HlOrderResult {
  orderId: string;
  fillPrice: number;
  filledSize: number;
  slippagePct: number;
}

// ── EIP-712 / Phantom Agent signing ───────────────────────────────────────────
// Hyperliquid uses a custom "phantom agent" pattern: the action bytes are hashed,
// then combined with the nonce and vault flag, and the resulting digest is signed
// as an EIP-191 personal message.

function buildActionHash(actionBytes: Uint8Array, nonce: number, isVault: boolean): Uint8Array {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64BE(BigInt(nonce));
  const vaultFlag = Buffer.from([isVault ? 1 : 0]);
  const actionHash = ethers.keccak256(actionBytes);
  const combined = Buffer.concat([
    Buffer.from(actionHash.slice(2), "hex"),
    nonceBuf,
    vaultFlag,
  ]);
  return ethers.getBytes(ethers.keccak256(combined));
}

async function signAction(
  wallet: ethers.Wallet,
  action: object,
  nonce: number
): Promise<{ r: string; s: string; v: number }> {
  const actionBytes = Buffer.from(msgpackEncode(action));
  const digest = buildActionHash(actionBytes, nonce, false);
  const sig = await wallet.signMessage(digest);
  const { r, s, v } = ethers.Signature.from(sig);
  return { r, s, v };
}

// ── HyperliquidExecutor ────────────────────────────────────────────────────────
export class HyperliquidExecutor {
  private wallet: ethers.Wallet | null = null;
  private logger: Logger;
  private positions: Map<string, PositionInfo> = new Map();
  private demoEquity: number = DEMO_EQUITY;

  constructor(logger: Logger) {
    this.logger = logger;
    if (!DEMO_MODE) {
      const pk = process.env.EVM_PRIVATE_KEY;
      if (!pk) {
        logger.warn("[HL] EVM_PRIVATE_KEY not set — Hyperliquid live orders disabled");
      } else {
        this.wallet = new ethers.Wallet(pk);
        logger.info(`[HL] Wallet: ${this.wallet.address}`);
      }
    }
  }

  // ── Funding rate data ───────────────────────────────────────────────────────

  /** Returns signed per-hour funding rate for one asset. */
  async getFundingRate(asset: string): Promise<number> {
    const rates = await this.getAllFundingRates();
    return rates[asset] ?? 0;
  }

  /** Returns funding rates for all traded assets (BTC, ETH, SOL, JTO). */
  async getAllFundingRates(): Promise<Record<string, number>> {
    try {
      const res = await axios.post(
        `${HL_BASE}/info`,
        { type: "metaAndAssetCtxs" },
        { timeout: 5000 }
      );
      const [meta, assetCtxs] = res.data as [{ universe: { name: string }[] }, { funding: string }[]];
      const rates: Record<string, number> = {};
      meta.universe.forEach((u, i) => {
        const ctx = assetCtxs[i];
        if (ctx?.funding !== undefined) {
          rates[u.name] = parseFloat(ctx.funding);
        }
      });
      return rates;
    } catch (err: any) {
      this.logger.warn(`[HL] getAllFundingRates failed: ${err.message}`);
      return this.simulatedFundingRates();
    }
  }

  /**
   * Returns mark price, oracle price, funding, OI, daily volume, and next funding time
   * in one API call. Used by HLMarketDataEngine and FundingRateScanner.
   */
  async getAllMarketData(): Promise<Record<string, {
    markPx: number; oraclePx: number; fundingRate: number;
    openInterestTokens: number; dailyVolumeUsd: number; nextFundingTime: number;
    premium: number;
  }>> {
    try {
      const res = await axios.post(
        `${HL_BASE}/info`,
        { type: "metaAndAssetCtxs" },
        { timeout: 5000 }
      );
      const [meta, assetCtxs] = res.data as [
        { universe: { name: string }[] },
        { markPx: string; oraclePx: string; funding: string; openInterest: string; dayNtlVlm: string; nextFundingTime: string; premium: string }[]
      ];
      const result: Record<string, {
        markPx: number; oraclePx: number; fundingRate: number;
        openInterestTokens: number; dailyVolumeUsd: number; nextFundingTime: number;
        premium: number;
      }> = {};
      meta.universe.forEach((u, i) => {
        const ctx = assetCtxs[i];
        if (ctx) {
          result[u.name] = {
            markPx:               parseFloat(ctx.markPx        ?? "0"),
            oraclePx:             parseFloat(ctx.oraclePx      ?? ctx.markPx ?? "0"),
            fundingRate:          parseFloat(ctx.funding        ?? "0"),
            openInterestTokens:   parseFloat(ctx.openInterest  ?? "0"),
            dailyVolumeUsd:       parseFloat(ctx.dayNtlVlm     ?? "0"),
            nextFundingTime:      parseInt(ctx.nextFundingTime  ?? "0", 10),
            premium:              parseFloat(ctx.premium        ?? "0"),
          };
        }
      });
      return result;
    } catch (err: any) {
      this.logger.warn(`[HL] getAllMarketData failed: ${err.message}`);
      return {};
    }
  }

  /** Returns mark price for one asset from Hyperliquid. */
  async getMarkPrice(asset: string): Promise<number> {
    try {
      const res = await axios.post(
        `${HL_BASE}/info`,
        { type: "metaAndAssetCtxs" },
        { timeout: 5000 }
      );
      const [meta, assetCtxs] = res.data as [{ universe: { name: string }[] }, { markPx: string }[]];
      const idx = meta.universe.findIndex(u => u.name === asset);
      if (idx >= 0) return parseFloat(assetCtxs[idx].markPx ?? "0");
      return 0;
    } catch {
      return this.simulatedPrice(asset);
    }
  }

  // ── Order placement ─────────────────────────────────────────────────────────

  /** Open a SHORT perp position (delta-neutral hedge, earns positive funding). */
  async openShort(asset: string, usdNotional: number, cachedMarkPrice?: number): Promise<HlOrderResult> {
    const markPrice = cachedMarkPrice ?? await this.getMarkPrice(asset);
    const size = usdNotional / Math.max(markPrice, 1);

    if (DEMO_MODE) {
      this.positions.set(asset, {
        asset, side: "SHORT", size, entryPrice: markPrice,
        markPrice, unrealizedPnl: 0, fundingAccrued: 0,
      });
      this.logger.info(`[HL] DEMO SHORT ${asset}  size=${size.toFixed(4)}  notional=$${usdNotional.toFixed(2)}  @ $${markPrice.toFixed(2)}`);
      return { orderId: `demo-short-${Date.now()}`, fillPrice: markPrice, filledSize: size, slippagePct: 0 };
    }

    return this.placeOrder(asset, false, size, markPrice);
  }

  /** Open a LONG perp position (earns funding when longs pay shorts — negative rate). */
  async openLong(asset: string, usdNotional: number, cachedMarkPrice?: number): Promise<HlOrderResult> {
    const markPrice = cachedMarkPrice ?? await this.getMarkPrice(asset);
    const size = usdNotional / Math.max(markPrice, 1);

    if (DEMO_MODE) {
      this.positions.set(asset, {
        asset, side: "LONG", size, entryPrice: markPrice,
        markPrice, unrealizedPnl: 0, fundingAccrued: 0,
      });
      this.logger.info(`[HL] DEMO LONG ${asset}  size=${size.toFixed(4)}  notional=$${usdNotional.toFixed(2)}  @ $${markPrice.toFixed(2)}`);
      return { orderId: `demo-long-${Date.now()}`, fillPrice: markPrice, filledSize: size, slippagePct: 0 };
    }

    return this.placeOrder(asset, true, size, markPrice);
  }

  /** Close any open position for an asset (reduce-only). */
  async closePosition(asset: string, currentMarkPrice?: number): Promise<HlOrderResult> {
    const pos = this.positions.get(asset);
    if (!pos) return { orderId: "no-position", fillPrice: 0, filledSize: 0, slippagePct: 0 };

    if (DEMO_MODE) {
      this.positions.delete(asset);
      this.logger.info(`[HL] DEMO close ${pos.side} ${asset}`);
      return { orderId: `demo-close-${Date.now()}`, fillPrice: pos.markPrice, filledSize: pos.size, slippagePct: 0 };
    }

    const isBuy = pos.side === "SHORT"; // close short = buy back
    // Use a slippage-aware limit price for the IOC order so it doesn't get rejected
    const refPrice = currentMarkPrice ?? pos.markPrice ?? pos.entryPrice;
    const limitPrice = isBuy ? refPrice * 1.02 : refPrice * 0.98;
    return this.placeOrder(asset, isBuy, pos.size, limitPrice, true);
  }

  // ── Account state ───────────────────────────────────────────────────────────

  /** Total account equity in USD. */
  async getEquity(): Promise<number> {
    if (DEMO_MODE) return this.demoEquity;

    if (!this.wallet) return 0;
    try {
      const res = await axios.post(
        `${HL_BASE}/info`,
        { type: "clearinghouseState", user: this.wallet.address },
        { timeout: 5000 }
      );
      return parseFloat(res.data?.marginSummary?.accountValue ?? "0");
    } catch (err: any) {
      this.logger.warn(`[HL] getEquity failed: ${err.message}`);
      return this.demoEquity;
    }
  }

  /** Sync open positions from Hyperliquid. */
  async syncPositions(): Promise<void> {
    if (DEMO_MODE || !this.wallet) return;
    try {
      const res = await axios.post(
        `${HL_BASE}/info`,
        { type: "clearinghouseState", user: this.wallet.address },
        { timeout: 5000 }
      );
      this.positions.clear();
      for (const pos of res.data?.assetPositions ?? []) {
        const p = pos.position;
        if (!p || parseFloat(p.szi) === 0) continue;
        const size = Math.abs(parseFloat(p.szi));
        const side: "LONG" | "SHORT" = parseFloat(p.szi) > 0 ? "LONG" : "SHORT";
        this.positions.set(p.coin, {
          asset: p.coin, side, size,
          entryPrice: parseFloat(p.entryPx ?? "0"),
          markPrice: parseFloat(p.positionValue ?? "0") / size,
          unrealizedPnl: parseFloat(p.unrealizedPnl ?? "0"),
          fundingAccrued: parseFloat(p.cumFunding?.allTime ?? "0"),
        });
      }
    } catch (err: any) {
      this.logger.warn(`[HL] syncPositions failed: ${err.message}`);
    }
  }

  getOpenPositions(): Map<string, PositionInfo> {
    return this.positions;
  }

  getPosition(asset: string): PositionInfo | undefined {
    return this.positions.get(asset);
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private async placeOrder(
    asset: string,
    isBuy: boolean,
    size: number,
    limitPrice: number,
    reduceOnly = false
  ): Promise<HlOrderResult> {
    if (!this.wallet) throw new Error("[HL] No wallet — set EVM_PRIVATE_KEY");

    const nonce = Date.now();
    const action = {
      type: "order",
      orders: [{
        a: asset,
        b: isBuy,
        p: limitPrice > 0 ? limitPrice.toString() : "0",
        s: size.toFixed(6),
        r: reduceOnly,
        t: { limit: { tif: "Ioc" } },
      }],
      grouping: "na",
    };

    const { r, s, v } = await signAction(this.wallet, action, nonce);
    const payload = { action, nonce, signature: { r, s, v } };

    const res = await axios.post(`${HL_BASE}/exchange`, payload, { timeout: 10_000 });

    if (res.data?.status !== "ok") {
      throw new Error(`[HL] Order rejected: ${JSON.stringify(res.data)}`);
    }

    const statusObj = res.data?.response?.data?.statuses?.[0];
    const oid = statusObj?.resting?.oid ?? statusObj?.filled?.oid ?? "filled";
    const fillPrice = parseFloat(statusObj?.filled?.avgPx ?? String(limitPrice));
    const filledSize = parseFloat(statusObj?.filled?.totalSz ?? String(size));
    const slippagePct = limitPrice > 0 ? Math.abs(fillPrice - limitPrice) / limitPrice : 0;

    this.logger.info(`[HL] Order OK  ${isBuy ? "BUY" : "SELL"} ${asset}  size=${size.toFixed(4)}  fill=$${fillPrice.toFixed(4)}  slip=${(slippagePct * 100).toFixed(3)}%  oid=${oid}`);
    return { orderId: String(oid), fillPrice, filledSize, slippagePct };
  }

  /** Simulated funding rates for demo mode (~11%/yr ≈ Hyperliquid typical). */
  private simulatedFundingRates(): Record<string, number> {
    const base = 0.000125; // ~11%/yr per-hour
    const jitter = (seed: number) => base + (Math.sin(Date.now() / 60_000 + seed) * 0.000030);
    return {
      BTC: jitter(1),
      ETH: jitter(2),
      SOL: jitter(3),
      JTO: jitter(4) + 0.000020, // JTO slightly higher
    };
  }

  private simulatedPrice(asset: string): number {
    const prices: Record<string, number> = {
      BTC: 71_000, ETH: 3_800, SOL: 182, JTO: 4.5,
    };
    return prices[asset] ?? 100;
  }
}

// ── Asset type (replaces liveExecution.ts export) ─────────────────────────────
export type Asset = string;

// ── HLMarketDataEngine ────────────────────────────────────────────────────────
// Drop-in replacement for RealMarketDataEngine.
// Builds LiveMarketSnapshot-compatible objects from Hyperliquid data so the
// existing strategyEngine / riskEngine / agentDecision code needs zero changes.

export interface LiveMarketSnapshot {
  asset: string;
  timestamp: number;
  spotPrice: number;
  perpPrice: number;
  indexPrice: number;
  fundingRate: number;
  fundingRateAnnualized: number;
  nextFundingTime: number;
  basisSpread: number;
  basisUSD: number;
  openInterest: number;
  dailyVolumeUsd: number;
  longShortRatio: number;
  liquidityScore: number;
  pythConfidence: number;
  oiChangeRatePct: number;   // (latestOI − oldestOI) / oldestOI over last 4 samples
  atrPct: number;            // price stdDev / mean over last 24 samples (~6h at 15s cycles)
}

export class HLMarketDataEngine {
  private executor: HyperliquidExecutor;
  private logger: Logger;
  private store: Map<string, LiveMarketSnapshot> = new Map();
  private lastFetch = 0;
  private CACHE_MS = 10_000; // re-fetch every 10s max
  private oiHistory: Map<string, number[]> = new Map(); // asset → ring of last 4 OI-USD values
  private priceHistory: Map<string, number[]> = new Map(); // asset → ring of last 24 markPx values

  constructor(executor: HyperliquidExecutor, logger: Logger) {
    this.executor = executor;
    this.logger = logger;
  }

  /** No-op: compatibility with RealMarketDataEngine lifecycle. */
  async start(): Promise<void> {
    this.logger.info("HLMarketDataEngine — fetching from Hyperliquid");
    await this.refresh();
  }

  async stop(): Promise<void> { /* nothing to tear down */ }

  getSnapshot(asset: string): LiveMarketSnapshot | null {
    return this.store.get(asset) ?? null;
  }

  /** Returns a copy of all stored market snapshots (used by FundingRateScanner). */
  getAllSnapshots(): Map<string, LiveMarketSnapshot> {
    return new Map(this.store);
  }

  /** Refresh all snapshots. Called manually each strategy cycle. */
  async refresh(): Promise<void> {
    const now = Date.now();
    if (now - this.lastFetch < this.CACHE_MS) return;
    this.lastFetch = now;

    try {
      const marketData = await this.executor.getAllMarketData();
      for (const [asset, data] of Object.entries(marketData)) {
        const { markPx, oraclePx, fundingRate, openInterestTokens, dailyVolumeUsd, nextFundingTime, premium } = data;
        const spotPrice  = oraclePx > 0 ? oraclePx : markPx;
        const perpPrice  = markPx;
        const basisSpread = spotPrice > 0 ? (perpPrice - spotPrice) / spotPrice : 0;
        const annualized  = fundingRate * 8760;
        // premium (mark/oracle − 1) as a long/short ratio proxy
        const premiumClamp = Math.max(-0.5, Math.min(0.5, premium / 0.02));
        const longShortRatio = 0.5 + premiumClamp * 0.5;
        // OI velocity: push current OI USD into 4-sample ring, compute rate of change
        const oiUsd = openInterestTokens * (spotPrice > 0 ? spotPrice : 1);
        const oiRing = this.oiHistory.get(asset) ?? [];
        oiRing.push(oiUsd);
        if (oiRing.length > 4) oiRing.shift();
        this.oiHistory.set(asset, oiRing);
        const oiChangeRatePct = oiRing.length >= 2
          ? (oiRing[oiRing.length - 1] - oiRing[0]) / Math.max(oiRing[0], 1)
          : 0;

        // ATR proxy: stdDev / mean of last 24 mark prices (~6h at 15s cycles)
        const pxRing = this.priceHistory.get(asset) ?? [];
        pxRing.push(markPx);
        if (pxRing.length > 24) pxRing.shift();
        this.priceHistory.set(asset, pxRing);
        let atrPct = 0;
        if (pxRing.length >= 2) {
          const pxMean = pxRing.reduce((s, v) => s + v, 0) / pxRing.length;
          const pxStd  = Math.sqrt(pxRing.reduce((s, v) => s + (v - pxMean) ** 2, 0) / pxRing.length);
          atrPct = pxMean > 0 ? pxStd / pxMean : 0;
        }

        this.store.set(asset, {
          asset,
          timestamp:              now,
          spotPrice,
          perpPrice,
          indexPrice:             spotPrice,
          fundingRate,
          fundingRateAnnualized:  annualized,
          nextFundingTime:        data.nextFundingTime > 0 ? data.nextFundingTime : now + 8 * 3_600_000,
          basisSpread,
          basisUSD:               basisSpread * spotPrice,
          openInterest:           oiUsd,
          dailyVolumeUsd,
          longShortRatio,
          liquidityScore:         0.9,  // HL is highly liquid
          pythConfidence:         0.001,
          oiChangeRatePct,
          atrPct,
        });
      }
    } catch (err: any) {
      this.logger.warn(`HLMarketDataEngine.refresh: ${err.message}`);
    }
  }
}
