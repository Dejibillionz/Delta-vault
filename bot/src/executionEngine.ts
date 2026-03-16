/**
 * Execution Engine — Drift Protocol (Solana)
 * Handles order placement, position management, and rebalancing
 * for BTC and ETH delta-neutral vault strategy.
 */

import {
  DriftClient,
  BulkAccountLoader,
  Wallet,
  PerpMarkets,
  SpotMarkets,
  OrderType,
  PositionDirection,
  MarketType,
  BN,
  convertToNumber,
  PRICE_PRECISION,
  BASE_PRECISION,
  QUOTE_PRECISION,
  PerpMarketAccount,
  UserAccount,
  getLimitOrderParams,
  getMarketOrderParams,
  PostOnlyParams,
} from "@drift-labs/sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as dotenv from "dotenv";
import { Logger } from "./logger";

dotenv.config();

// ─── Market index constants for Drift v2 mainnet ─────────────────────────────
export const MARKET_INDEX = {
  BTC: 1,  // BTC-PERP
  ETH: 2,  // ETH-PERP
} as const;

export type Asset = keyof typeof MARKET_INDEX;

export interface PositionInfo {
  asset: Asset;
  baseAmount: number;      // in base asset units
  quoteAmount: number;     // USD notional
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  direction: "LONG" | "SHORT";
}

export interface OrderResult {
  success: boolean;
  txSig?: string;
  error?: string;
}

// ─── Execution Engine ─────────────────────────────────────────────────────────
export class ExecutionEngine {
  private client!: DriftClient;
  private connection: Connection;
  private wallet: Wallet;
  private logger: Logger;
  private initialized = false;

  constructor(logger: Logger) {
    this.logger = logger;

    const rpcUrl = process.env.HELIUS_RPC_URL;
    if (!rpcUrl) throw new Error("HELIUS_RPC_URL not set in environment");

    this.connection = new Connection(rpcUrl, {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 30000,
    });

    const keypairPath = process.env.WALLET_KEYPAIR_PATH;
    if (!keypairPath) throw new Error("WALLET_KEYPAIR_PATH not set");

    const raw = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
    const keypair = Keypair.fromSecretKey(Uint8Array.from(raw));
    this.wallet = new Wallet(keypair);

    this.logger.info(`Wallet loaded: ${keypair.publicKey.toBase58()}`);
  }

  async initialize(): Promise<void> {
    const accountLoader = new BulkAccountLoader(this.connection, "confirmed", 1000);

    this.client = new DriftClient({
      connection: this.connection,
      wallet: this.wallet,
      programID: new PublicKey(process.env.DRIFT_PROGRAM_ID ?? "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"),
      accountSubscription: {
        type: "polling",
        accountLoader,
      },
      env: "mainnet-beta",
    });

    await this.client.subscribe();
    this.initialized = true;
    this.logger.info("DriftClient initialized and subscribed");
  }

  async shutdown(): Promise<void> {
    if (this.client) await this.client.unsubscribe();
    this.logger.info("DriftClient unsubscribed");
  }

  // ─── Open delta-neutral position ──────────────────────────────────────────
  // Simultaneously opens a perp SHORT on Drift.
  // The spot LONG should be opened via Jupiter (see spotHedge.ts).
  async openPerpShort(asset: Asset, usdNotional: number): Promise<OrderResult> {
    this.assertInitialized();
    const marketIndex = MARKET_INDEX[asset];
    const markPrice = await this.getMarkPrice(asset);
    const baseAmount = usdNotional / markPrice;

    // Convert to Drift BN precision
    const baseAmountBN = new BN(baseAmount * BASE_PRECISION.toNumber());

    this.logger.trade(`Opening PERP SHORT: ${asset} $${usdNotional.toFixed(2)} @ ~${markPrice.toFixed(2)}`);

    try {
      const orderParams = getMarketOrderParams({
        marketIndex,
        direction: PositionDirection.SHORT,
        baseAssetAmount: baseAmountBN,
        marketType: MarketType.PERP,
        reduceOnly: false,
      });

      const txSig = await this.client.placePerpOrder(orderParams);
      this.logger.trade(`Perp SHORT placed — tx: ${txSig}`);
      return { success: true, txSig };
    } catch (err: any) {
      this.logger.error(`Failed to place perp short: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ─── Close a perp position ────────────────────────────────────────────────
  async closePerpPosition(asset: Asset): Promise<OrderResult> {
    this.assertInitialized();
    const marketIndex = MARKET_INDEX[asset];

    this.logger.trade(`Closing PERP position: ${asset}`);
    try {
      const txSig = await this.client.closePosition(marketIndex, MarketType.PERP);
      this.logger.trade(`Perp position closed — tx: ${txSig}`);
      return { success: true, txSig };
    } catch (err: any) {
      this.logger.error(`Failed to close perp position: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ─── Close all open positions (emergency) ────────────────────────────────
  async closeAllPositions(): Promise<void> {
    this.logger.risk("EMERGENCY: Closing ALL positions");
    for (const asset of Object.keys(MARKET_INDEX) as Asset[]) {
      const pos = await this.getPerpPosition(asset);
      if (pos) {
        await this.closePerpPosition(asset);
      }
    }
  }

  // ─── Rebalance perp to restore delta neutrality ───────────────────────────
  async rebalancePerpPosition(asset: Asset, targetDelta: number): Promise<OrderResult> {
    this.assertInitialized();
    const pos = await this.getPerpPosition(asset);
    if (!pos) {
      this.logger.warn(`No position to rebalance for ${asset}`);
      return { success: false, error: "No position found" };
    }

    const currentDelta = pos.baseAmount; // net delta in base units
    const deltaAdjustment = targetDelta - currentDelta;

    if (Math.abs(deltaAdjustment) < 0.001) {
      this.logger.info(`${asset} delta within tolerance — no rebalance needed`);
      return { success: true };
    }

    const direction = deltaAdjustment > 0 ? PositionDirection.LONG : PositionDirection.SHORT;
    const baseAmountBN = new BN(Math.abs(deltaAdjustment) * BASE_PRECISION.toNumber());
    const marketIndex = MARKET_INDEX[asset];

    this.logger.trade(`Rebalancing ${asset}: adjusting delta by ${deltaAdjustment.toFixed(6)}`);

    try {
      const orderParams = getMarketOrderParams({
        marketIndex,
        direction,
        baseAssetAmount: baseAmountBN,
        marketType: MarketType.PERP,
        reduceOnly: false,
      });
      const txSig = await this.client.placePerpOrder(orderParams);
      this.logger.trade(`Rebalance order placed — tx: ${txSig}`);
      return { success: true, txSig };
    } catch (err: any) {
      this.logger.error(`Rebalance failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ─── Fetch current perp position ─────────────────────────────────────────
  async getPerpPosition(asset: Asset): Promise<PositionInfo | null> {
    this.assertInitialized();
    const marketIndex = MARKET_INDEX[asset];
    const user = this.client.getUser();
    const position = user.getPerpPosition(marketIndex);
    if (!position || position.baseAssetAmount.isZero()) return null;

    const markPrice = await this.getMarkPrice(asset);
    const baseAmount = convertToNumber(position.baseAssetAmount, BASE_PRECISION);
    const entryPrice = convertToNumber(position.quoteAssetAmount, QUOTE_PRECISION) / Math.abs(baseAmount);
    const unrealizedPnl = convertToNumber(
      user.getUnrealizedPNL(true, marketIndex, MarketType.PERP),
      QUOTE_PRECISION
    );

    return {
      asset,
      baseAmount,
      quoteAmount: Math.abs(baseAmount) * markPrice,
      entryPrice,
      markPrice,
      unrealizedPnl,
      direction: baseAmount > 0 ? "LONG" : "SHORT",
    };
  }

  // ─── Get mark price from Drift oracle ─────────────────────────────────────
  async getMarkPrice(asset: Asset): Promise<number> {
    this.assertInitialized();
    const marketIndex = MARKET_INDEX[asset];
    const market = this.client.getPerpMarketAccount(marketIndex);
    if (!market) throw new Error(`No market data for ${asset}`);
    return convertToNumber(market.amm.lastMarkPriceTwap, PRICE_PRECISION);
  }

  // ─── Get funding rate for a market ────────────────────────────────────────
  async getFundingRate(asset: Asset): Promise<number> {
    this.assertInitialized();
    const marketIndex = MARKET_INDEX[asset];
    const market = this.client.getPerpMarketAccount(marketIndex);
    if (!market) throw new Error(`No market data for ${asset}`);

    // lastFundingRate is per-slot — convert to hourly rate
    const rawRate = convertToNumber(market.amm.lastFundingRate, PRICE_PRECISION);
    return rawRate;
  }

  // ─── Get vault USDC balance ───────────────────────────────────────────────
  async getUSDCBalance(): Promise<number> {
    this.assertInitialized();
    const user = this.client.getUser();
    const balance = user.getTokenAmount(0); // spot market index 0 = USDC
    return convertToNumber(balance, QUOTE_PRECISION);
  }

  // ─── Get total collateral / equity ────────────────────────────────────────
  async getTotalCollateral(): Promise<number> {
    this.assertInitialized();
    const user = this.client.getUser();
    return convertToNumber(user.getTotalCollateral(), QUOTE_PRECISION);
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("ExecutionEngine not initialized — call initialize() first");
  }
}
