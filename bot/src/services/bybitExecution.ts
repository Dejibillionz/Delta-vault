/**
 * BybitExecutor
 * Executes perpetual orders on Bybit Linear (USDT-margined) via the V5 REST API.
 *
 * Auth: HMAC SHA256 — preSignStr = timestamp + apiKey + recvWindow + body
 * Headers: X-BAPI-API-KEY, X-BAPI-SIGN, X-BAPI-SIGN-TYPE: 2, X-BAPI-TIMESTAMP, X-BAPI-RECV-WINDOW
 *
 * Requirements (live mode):
 *   - One-way position mode (NOT hedge mode) — set in Bybit account settings
 *   - Unified Trading Account with USDT margin
 *   - BYBIT_API_KEY + BYBIT_API_SECRET env vars
 *
 * Demo mode: whenever DEMO_MODE=true OR API creds are unset.
 * In demo mode all network calls are skipped; positions tracked in-memory.
 */

import axios from "axios";
import * as crypto from "crypto";
import { Logger } from "../logger";
import { getDecimals } from "../config/tokenConfig";

const BYBIT_BASE     = "https://api.bybit.com";
const RECV_WINDOW    = "5000";
const DEMO_MODE      = process.env.DEMO_MODE !== "false";
const DEMO_EQUITY    = parseFloat(process.env.DEMO_EQUITY ?? "10000");

// ── Types ──────────────────────────────────────────────────────────────────────

export interface BybitPositionInfo {
  asset: string;
  side: "LONG" | "SHORT";
  size: number;        // in base (tokens)
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
}

export interface BybitOrderResult {
  orderId: string;
  fillPrice: number;
  filledQty: number;
  slippagePct: number;
}

// ── Signing helper ─────────────────────────────────────────────────────────────

function hmacSha256(secret: string, data: string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

function buildHeaders(apiKey: string, apiSecret: string, body: string): Record<string, string> {
  const ts  = Date.now().toString();
  const preSign = ts + apiKey + RECV_WINDOW + body;
  const sig = hmacSha256(apiSecret, preSign);
  return {
    "Content-Type":          "application/json",
    "X-BAPI-API-KEY":        apiKey,
    "X-BAPI-SIGN":           sig,
    "X-BAPI-SIGN-TYPE":      "2",
    "X-BAPI-TIMESTAMP":      ts,
    "X-BAPI-RECV-WINDOW":    RECV_WINDOW,
  };
}

// ── BybitExecutor ──────────────────────────────────────────────────────────────

export class BybitExecutor {
  private apiKey: string | null;
  private apiSecret: string | null;
  private logger: Logger;
  private positions: Map<string, BybitPositionInfo> = new Map();
  private demoEquity = DEMO_EQUITY;
  private live: boolean;

  constructor(logger: Logger) {
    this.logger    = logger;
    this.apiKey    = process.env.BYBIT_API_KEY    ?? null;
    this.apiSecret = process.env.BYBIT_API_SECRET ?? null;
    this.live      = !DEMO_MODE && !!this.apiKey && !!this.apiSecret;

    if (DEMO_MODE) {
      logger.info("[BYBIT] Demo mode — no live orders will be sent");
    } else if (!this.live) {
      logger.warn("[BYBIT] BYBIT_API_KEY / BYBIT_API_SECRET not set — Bybit disabled (demo only)");
    } else {
      logger.info("[BYBIT] Live mode enabled");
    }
  }

  /** True when live Bybit execution is possible. */
  isEnabled(): boolean {
    return this.live;
  }

  // ── Order placement ─────────────────────────────────────────────────────────

  /** Open a SHORT perp position on Bybit Linear. */
  async openShort(asset: string, usdNotional: number, cachedMarkPrice?: number): Promise<BybitOrderResult> {
    const markPrice = cachedMarkPrice ?? await this.getMarkPrice(asset);
    const qty       = this.toQty(usdNotional / Math.max(markPrice, 1), asset);

    if (!this.live) {
      this.positions.set(asset, { asset, side: "SHORT", size: qty, entryPrice: markPrice, markPrice, unrealizedPnl: 0 });
      this.logger.info(`[BYBIT] DEMO SHORT ${asset}  qty=${qty}  notional=$${usdNotional.toFixed(2)}  @ $${markPrice.toFixed(2)}`);
      return { orderId: `bybit-demo-short-${Date.now()}`, fillPrice: markPrice, filledQty: qty, slippagePct: 0 };
    }

    return this.placeOrder(asset, "Sell", qty, markPrice);
  }

  /** Open a LONG perp position on Bybit Linear. */
  async openLong(asset: string, usdNotional: number, cachedMarkPrice?: number): Promise<BybitOrderResult> {
    const markPrice = cachedMarkPrice ?? await this.getMarkPrice(asset);
    const qty       = this.toQty(usdNotional / Math.max(markPrice, 1), asset);

    if (!this.live) {
      this.positions.set(asset, { asset, side: "LONG", size: qty, entryPrice: markPrice, markPrice, unrealizedPnl: 0 });
      this.logger.info(`[BYBIT] DEMO LONG ${asset}  qty=${qty}  notional=$${usdNotional.toFixed(2)}  @ $${markPrice.toFixed(2)}`);
      return { orderId: `bybit-demo-long-${Date.now()}`, fillPrice: markPrice, filledQty: qty, slippagePct: 0 };
    }

    return this.placeOrder(asset, "Buy", qty, markPrice);
  }

  /** Close open position for an asset (reduce-only, IOC). */
  async closePosition(asset: string, currentMarkPrice?: number): Promise<BybitOrderResult> {
    const pos = this.positions.get(asset);
    if (!pos) return { orderId: "no-position", fillPrice: 0, filledQty: 0, slippagePct: 0 };

    if (!this.live) {
      this.positions.delete(asset);
      this.logger.info(`[BYBIT] DEMO close ${pos.side} ${asset}`);
      return { orderId: `bybit-demo-close-${Date.now()}`, fillPrice: pos.markPrice, filledQty: pos.size, slippagePct: 0 };
    }

    const side  = pos.side === "SHORT" ? "Buy" : "Sell"; // close short = buy
    const price = currentMarkPrice ?? pos.markPrice ?? pos.entryPrice;
    return this.placeOrder(asset, side, pos.size, price, true);
  }

  // ── Account state ───────────────────────────────────────────────────────────

  async getEquity(): Promise<number> {
    if (!this.live) return this.demoEquity;
    try {
      const ts  = Date.now().toString();
      const qs  = `accountType=UNIFIED`;
      const sig = hmacSha256(this.apiSecret!, ts + this.apiKey! + RECV_WINDOW + qs);
      const res = await axios.get(`${BYBIT_BASE}/v5/account/wallet-balance?${qs}`, {
        headers: {
          "X-BAPI-API-KEY":     this.apiKey!,
          "X-BAPI-SIGN":        sig,
          "X-BAPI-SIGN-TYPE":   "2",
          "X-BAPI-TIMESTAMP":   ts,
          "X-BAPI-RECV-WINDOW": RECV_WINDOW,
        },
        timeout: 5000,
      });
      const list = res.data?.result?.list ?? [];
      return parseFloat(list[0]?.totalEquity ?? "0");
    } catch (err: any) {
      this.logger.warn(`[BYBIT] getEquity failed: ${err.message}`);
      return this.demoEquity;
    }
  }

  getPosition(asset: string): BybitPositionInfo | undefined {
    return this.positions.get(asset);
  }

  getOpenPositions(): Map<string, BybitPositionInfo> {
    return this.positions;
  }

  // ── Mark price (from public ticker) ────────────────────────────────────────

  async getMarkPrice(asset: string): Promise<number> {
    try {
      const symbol = `${asset}USDT`;
      const res    = await axios.get(
        `${BYBIT_BASE}/v5/market/tickers?category=linear&symbol=${symbol}`,
        { timeout: 5000 }
      );
      const item = res.data?.result?.list?.[0];
      return parseFloat(item?.lastPrice ?? "0");
    } catch {
      return this.simulatedPrice(asset);
    }
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private async placeOrder(
    asset: string,
    side: "Buy" | "Sell",
    qty: number,
    refPrice: number,
    reduceOnly = false
  ): Promise<BybitOrderResult> {
    const symbol = `${asset}USDT`;
    const body = JSON.stringify({
      category:      "linear",
      symbol,
      side,
      orderType:     "Market",
      qty:           String(qty),
      timeInForce:   "ImmediateOrCancel",
      positionIdx:   0, // one-way mode
      reduceOnly,
    });

    const headers = buildHeaders(this.apiKey!, this.apiSecret!, body);
    const res     = await axios.post(`${BYBIT_BASE}/v5/order/create`, body, { headers, timeout: 10_000 });

    if (res.data?.retCode !== 0) {
      throw new Error(`[BYBIT] Order rejected: ${res.data?.retMsg ?? JSON.stringify(res.data)}`);
    }

    const orderId = res.data?.result?.orderId ?? "unknown";

    // Poll for fill price (~500ms after submit)
    await new Promise(r => setTimeout(r, 500));
    const fillPrice = await this.getFillPrice(orderId, symbol, refPrice);
    const slippagePct = refPrice > 0 ? Math.abs(fillPrice - refPrice) / refPrice : 0;

    this.logger.info(`[BYBIT] Order OK  ${side} ${asset}  qty=${qty}  fill=$${fillPrice.toFixed(4)}  slip=${(slippagePct * 100).toFixed(3)}%  oid=${orderId}`);
    return { orderId, fillPrice, filledQty: qty, slippagePct };
  }

  private async getFillPrice(orderId: string, symbol: string, fallback: number): Promise<number> {
    try {
      const ts  = Date.now().toString();
      const qs  = `category=linear&symbol=${symbol}&orderId=${orderId}`;
      const sig = hmacSha256(this.apiSecret!, ts + this.apiKey! + RECV_WINDOW + qs);
      const res = await axios.get(`${BYBIT_BASE}/v5/order/realtime?${qs}`, {
        headers: {
          "X-BAPI-API-KEY":     this.apiKey!,
          "X-BAPI-SIGN":        sig,
          "X-BAPI-SIGN-TYPE":   "2",
          "X-BAPI-TIMESTAMP":   ts,
          "X-BAPI-RECV-WINDOW": RECV_WINDOW,
        },
        timeout: 5000,
      });
      const item = res.data?.result?.list?.[0];
      return parseFloat(item?.avgPrice ?? String(fallback));
    } catch {
      return fallback;
    }
  }

  /** Round qty to asset-specific decimal precision for Bybit. */
  private toQty(rawQty: number, asset: string): number {
    const decimals = this.getQtyDecimals(asset);
    const factor   = Math.pow(10, decimals);
    return Math.floor(rawQty * factor) / factor;
  }

  getQtyDecimals(asset: string): number {
    // Try to get from centralized token config first
    const configDecimals = getDecimals(asset);
    if (configDecimals !== undefined) {
      return Math.max(0, 8 - configDecimals); // Bybit uses qty precision (e.g., BTC=8 decimals → 3 qty decimals)
    }
    // Fallback for unknown assets
    return 2;
  }

  private simulatedPrice(asset: string): number {
    // Base prices for demo mode (should approximate current market)
    const prices: Record<string, number> = {
      BTC: 71_000, ETH: 3_800, SOL: 182, JTO: 4.5,
    };
    // For unknown assets, use a reasonable fallback
    return prices[asset] ?? 100;
  }
}
