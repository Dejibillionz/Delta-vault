/**
 * Real Market Data Engine
 * Fetches live data from:
 *   - Pyth Network  → BTC/ETH spot prices
 *   - Drift Protocol → funding rates, mark prices, OI
 *   - Computed      → basis spreads
 */

import {
  DriftClient,
  convertToNumber,
  PRICE_PRECISION,
  BN,
  MarketType,
} from "@drift-labs/sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import { PythHttpClient, getPythProgramKeyForCluster } from "@pythnetwork/client";
import axios from "axios";
import WebSocket from "ws";
import { Logger } from "./logger";
import { debugLog } from "./logging";
 
// ─── Pyth price feed IDs (mainnet) ───────────────────────────────────────────
export const PYTH_FEED_IDS = {
  BTC: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
} as const;

// Pyth Solana mainnet price account pubkeys
const PYTH_PRICE_ACCOUNTS = {
  BTC: new PublicKey("GVXRSBjFk6e6J3NbVPXohDJetcTjaeeuykUpbQF8UoMU"),
  ETH: new PublicKey("JBu1AL4obBcCMqKBBxhpWCNUt136ijcuMZLFvTP7iWdB"),
} as const;

// Drift perp market indices
export const DRIFT_MARKET_INDEX = { BTC: 1, ETH: 2 } as const;

export interface LiveMarketSnapshot {
  asset: "BTC" | "ETH";
  timestamp: number;
  // Prices
  spotPrice: number;           // Pyth oracle
  perpPrice: number;           // Drift mark price
  indexPrice: number;          // Drift index price
  // Rates
  fundingRate: number;         // hourly rate (decimal)
  fundingRateAnnualized: number;
  nextFundingTime: number;     // unix ms
  // Spread
  basisSpread: number;         // (perp - spot) / spot
  basisUSD: number;            // absolute USD difference
  // Market depth
  openInterest: number;        // USD notional
  longShortRatio: number;      // long OI / total OI
  liquidityScore: number;      // 0–1
  // Confidence
  pythConfidence: number;      // Pyth price confidence interval
}

type SnapshotCallback = (snap: LiveMarketSnapshot) => void;

// ─── Real Market Data Engine ─────────────────────────────────────────────────
export class RealMarketDataEngine {
  private driftClient: DriftClient;
  private connection: Connection;
  private pythClient!: PythHttpClient;
  private logger: Logger;
  private store: Record<"BTC" | "ETH", LiveMarketSnapshot | null> = { BTC: null, ETH: null };
  private callbacks: SnapshotCallback[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private heliusWs: WebSocket | null = null;
  private network: string;

  constructor(driftClient: DriftClient, connection: Connection, logger: Logger, network: string) {
    this.driftClient = driftClient;
    this.connection = connection;
    this.logger = logger;
    this.network = network;

    // Pyth HTTP client — use the correct cluster based on network
    const pythCluster = network === "mainnet-beta" ? "mainnet-beta" : "devnet";
    const pythProgramKey = getPythProgramKeyForCluster(pythCluster as any);
    this.pythClient = new PythHttpClient(connection, pythProgramKey);
  }

  async start(): Promise<void> {
    this.logger.info("RealMarketDataEngine: starting...");
    await this.refreshAll();

    // Poll every 5 seconds
    this.pollTimer = setInterval(() => this.refreshAll().catch(e =>
      this.logger.error(`Market poll error: ${e.message}`)
    ), 5000);

    // Real-time Helius WebSocket for account change notifications
    this.startHeliusWebSocket();
    this.logger.info("RealMarketDataEngine: live data streaming started");
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heliusWs) this.heliusWs.close();
    this.logger.info("RealMarketDataEngine: stopped");
  }

  onUpdate(cb: SnapshotCallback): void { this.callbacks.push(cb); }
  getSnapshot(asset: "BTC" | "ETH"): LiveMarketSnapshot | null { return this.store[asset]; }

  // ─── Fetch all assets ───────────────────────────────────────────────────
  private async refreshAll(): Promise<void> {
    // Fetch Pyth prices in one batch call
    const pythData = await this.fetchPythPrices();
    await Promise.all(
      (["BTC", "ETH"] as const).map(a => this.refreshAsset(a, pythData[a]))
    );
  }

  // ─── Fetch Pyth prices via Hermes REST API ──────────────────────────────
  private async fetchPythPrices(): Promise<Record<"BTC" | "ETH", { price: number; confidence: number }>> {
    try {
      const ids = Object.values(PYTH_FEED_IDS).join("&ids[]=");
      const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${ids}`;
      const res = await axios.get(url, { timeout: 8000 });

      const result: Record<string, { price: number; confidence: number }> = { BTC: { price: 0, confidence: 0 }, ETH: { price: 0, confidence: 0 } };

      for (const parsed of res.data.parsed ?? []) {
        const asset = Object.entries(PYTH_FEED_IDS).find(([, id]) => id === "0x" + parsed.id)?.[0];
        if (!asset) continue;
        const exp = parsed.price.expo;
        result[asset] = {
          price: parsed.price.price * Math.pow(10, exp),
          confidence: parsed.price.conf * Math.pow(10, exp),
        };
      }

      return result as any;
    } catch (err: any) {
      this.logger.warn(`Pyth Hermes fetch failed: ${err.message} — falling back to Drift oracle`);
      return { BTC: { price: 0, confidence: 0 }, ETH: { price: 0, confidence: 0 } };
    }
  }

  // ─── Refresh a single asset ─────────────────────────────────────────────
  private async refreshAsset(
    asset: "BTC" | "ETH",
    pyth: { price: number; confidence: number }
  ): Promise<void> {
    try {
      const mi = DRIFT_MARKET_INDEX[asset];
      const market = this.driftClient.getPerpMarketAccount(mi);
      if (!market) throw new Error(`No Drift market data for ${asset}`);

      // Mark price (TWAP)
      const perpPrice = convertToNumber(market.amm.lastMarkPriceTwap, PRICE_PRECISION);

      // Index price (oracle price used for funding)
      const indexPrice = convertToNumber(market.amm.historicalOracleData.lastOraclePrice, PRICE_PRECISION);

      // Use Pyth spot price; fall back to Drift index price
      const spotPrice = pyth.price > 0 ? pyth.price : indexPrice;

      // Funding rate: lastFundingRate is the hourly rate in PRICE_PRECISION (as percentage)
      const fundingRate = convertToNumber(market.amm.lastFundingRate, PRICE_PRECISION) / 1e6;
      const fundingRateAnnualized = fundingRate * 24 * 365;

      // Next funding timestamp
      const nextFundingTime = market.amm.lastFundingRate.toNumber() * 1000;

      // Basis
      const basisSpread = spotPrice > 0 ? (perpPrice - spotPrice) / spotPrice : 0;
      const basisUSD = perpPrice - spotPrice;

      // Open interest
      const baseOI = convertToNumber(market.amm.baseAssetAmountWithAmm.abs(), new BN(1e9));
      const openInterest = baseOI * perpPrice;

      // Long/short ratio from AMM imbalance
      const longOI = convertToNumber(market.amm.baseAssetAmountLong, new BN(1e9));
      const shortOI = convertToNumber(market.amm.baseAssetAmountShort.abs(), new BN(1e9));
      const totalOI = longOI + shortOI;
      const longShortRatio = totalOI > 0 ? longOI / totalOI : 0.5;

      // Network-aware liquidity score.
      // Devnet OI is ~$1-5M vs mainnet ~$50M+, so cap is scaled accordingly.
      // On devnet we also apply a minimum floor of 0.15 so that markets with
      // near-zero OI (like ETH devnet) still register as tradeable for testing.
      const isDevnet = process.env.SOLANA_NETWORK !== 'mainnet-beta';
      const oiCap = isDevnet ? 2_000_000 : 50_000_000;
      const rawScore = Math.min(Math.sqrt(openInterest / oiCap), 1);
      const liquidityScore = isDevnet ? Math.max(rawScore, 0.15) : rawScore;

      const snap: LiveMarketSnapshot = {
        asset, timestamp: Date.now(),
        spotPrice, perpPrice, indexPrice,
        fundingRate, fundingRateAnnualized, nextFundingTime,
        basisSpread, basisUSD,
        openInterest, longShortRatio, liquidityScore,
        pythConfidence: pyth.confidence,
      };

      this.store[asset] = snap;
      this.callbacks.forEach(cb => cb(snap));

      debugLog(
        `${asset} | spot=${usd(spotPrice)} | perp=${usd(perpPrice)} | ` +
        `FR=${pct(fundingRate)} | basis=${pct(basisSpread, 2)} | OI=${usd(openInterest)}`
      );
    } catch (err: any) {
      this.logger.error(`refreshAsset(${asset}): ${err.message}`);
    }
  }

  // ─── Helius WebSocket — subscribe to Pyth price accounts ───────────────
  private startHeliusWebSocket(): void {
    const wsUrl = process.env.HELIUS_WS_URL;
    if (!wsUrl) return;

    this.heliusWs = new WebSocket(wsUrl);

    this.heliusWs.on("open", () => {
      this.logger.info("Helius WS connected");
      Object.entries(PYTH_PRICE_ACCOUNTS).forEach(([asset, pubkey], i) => {
        this.heliusWs!.send(JSON.stringify({
          jsonrpc: "2.0", id: i + 1,
          method: "accountSubscribe",
          params: [pubkey.toBase58(), { encoding: "base64", commitment: "confirmed" }],
        }));
        this.logger.info(`Subscribed to Pyth ${asset} price account`);
      });
    });

    this.heliusWs.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.method === "accountNotification") {
          // Trigger immediate refresh on oracle update
          this.refreshAll().catch(e => this.logger.error(`WS refresh: ${e.message}`));
        }
      } catch { /* ignore */ }
    });

    this.heliusWs.on("close", () => {
      this.logger.warn("Helius WS closed — reconnecting in 5s");
      setTimeout(() => this.startHeliusWebSocket(), 5000);
    });

    this.heliusWs.on("error", err => this.logger.error(`Helius WS error: ${err.message}`));
  }
}

const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n: number, d = 4) => (n * 100).toFixed(d) + "%";
