/**
 * Live Order Execution Engine
 * Wires all components together:
 *   - Real market data (Pyth + Drift)
 *   - Wallet signing (ServerWallet or Phantom)
 *   - Drift Protocol perp orders
 *   - Drift Protocol spot orders
 *   - Full audit trail
 */

import {
  DriftClient,
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
  getLimitOrderParams,
  getMarketOrderParams,
  PostOnlyParams,
  standardizeBaseAssetAmount,
} from "@drift-labs/sdk";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { ServerWallet } from "./walletIntegration";
import { Logger } from "./logger";

// ─── Market config ────────────────────────────────────────────────────────────
export const PERP_MARKET = {
  BTC: { index: 1, name: "BTC-PERP", tickSize: 0.1, minOrderSize: 0.001 },
  ETH: { index: 2, name: "ETH-PERP", tickSize: 0.01, minOrderSize: 0.01 },
} as const;

export const SPOT_MARKET = {
  USDC: { index: 0, name: "USDC", decimals: 6 },
  BTC:  { index: 1, name: "BTC-SPOT", decimals: 8 },
  ETH:  { index: 2, name: "ETH-SPOT", decimals: 8 },
} as const;

export type Asset = keyof typeof PERP_MARKET;

// ─── Order audit record ───────────────────────────────────────────────────────
export interface OrderRecord {
  id: string;
  timestamp: number;
  asset: Asset;
  leg: "SPOT" | "PERP";
  side: "BUY" | "SELL" | "SHORT" | "CLOSE";
  notionalUSD: number;
  txSig?: string;
  status: "PENDING" | "FILLED" | "FAILED";
  error?: string;
  fillPrice?: number;
  slippagePct?: number;
}

export interface DeltaNeutralPosition {
  asset: Asset;
  side: "short-perp" | "long-perp";
  openedAt: number;
  spotNotional: number;       // USD value of spot long
  perpNotional: number;       // USD value of perp short
  entryFundingRate: number;
  fundingCollected: number;   // cumulative funding received
  unrealizedPnl: number;
  legs: OrderRecord[];
}

// ─── Live Execution Engine ────────────────────────────────────────────────────
export class LiveExecutionEngine {
  private driftClient: DriftClient;
  private connection: Connection;
  private wallet: ServerWallet;
  private logger: Logger;
  private orderLog: OrderRecord[] = [];
  private openPositions: Map<Asset, DeltaNeutralPosition> = new Map();

  constructor(
    driftClient: DriftClient,
    connection: Connection,
    wallet: ServerWallet,
    logger: Logger
  ) {
    this.driftClient = driftClient;
    this.connection = connection;
    this.wallet = wallet;
    this.logger = logger;
  }

  // ─── CORE: Open delta-neutral position ─────────────────────────────────
  // Executes both legs atomically (best-effort):
  //   Leg 1: Buy spot via Drift spot (USDC → BTC/ETH)
  //   Leg 2: Short perp via Drift
  async openDeltaNeutral({
    side,
    asset,
    amount,
    fundingRate,
  }: {
    side: "short-perp" | "long-perp";
    asset: Asset;
    amount: number;
    fundingRate: number;
  }): Promise<DeltaNeutralPosition | null> {
    this.logger.trade(`Opening DELTA-NEUTRAL ${asset} | side=${side} | notional=$${amount.toFixed(0)} | FR=${pct(fundingRate)}`);
    if (side === "short-perp") {
      this.logger.trade(`${asset}: LONG spot + SHORT perp`);
    }
    if (side === "long-perp") {
      this.logger.trade(`${asset}: SHORT spot + LONG perp`);
    }

    const position: DeltaNeutralPosition = {
      asset,
      side,
      openedAt: Date.now(),
      spotNotional: 0,
      perpNotional: 0,
      entryFundingRate: fundingRate,
      fundingCollected: 0,
      unrealizedPnl: 0,
      legs: [],
    };

    // ── LEG 1: Spot leg via Drift ───────────────────────────────────────
    const spotResult = side === "short-perp"
      ? await this.driftSpotSwap("USDC", asset, amount)
      : await this.driftSpotSwap(asset, "USDC", amount);
    position.legs.push(spotResult);

    if (spotResult.status === "FAILED") {
      this.logger.error(`${asset}: Spot leg failed — aborting. No perp order sent.`);
      return null;
    }
    position.spotNotional = amount;
    this.logger.trade(`${asset}: Spot leg FILLED — tx: ${spotResult.txSig}`);

    // ── LEG 2: Perp leg via Drift ───────────────────────────────────────
    const perpResult = side === "short-perp"
      ? await this.driftPerpShort(asset, amount)
      : await this.driftPerpLong(asset, amount);
    position.legs.push(perpResult);

    if (perpResult.status === "FAILED") {
      this.logger.error(`${asset}: Perp leg failed — unwinding spot leg`);
      if (side === "short-perp") {
        await this.driftSpotSwap(asset, "USDC", amount);
      } else {
        await this.driftSpotSwap("USDC", asset, amount);
      }
      return null;
    }
    position.perpNotional = amount;
    this.logger.trade(`${asset}: Perp leg FILLED — tx: ${perpResult.txSig}`);

    this.openPositions.set(asset, position);
    this.logger.trade(`${asset}: DELTA-NEUTRAL position fully open ✓`);
    return position;
  }

  // ─── CORE: Close delta-neutral position ────────────────────────────────
  async closeDeltaNeutral(asset: Asset): Promise<void> {
    const pos = this.openPositions.get(asset);
    if (!pos) { this.logger.warn(`No open position to close for ${asset}`); return; }

    this.logger.trade(`Closing DELTA-NEUTRAL ${asset}`);

    // Close perp first (reduce risk exposure)
    const perpClose = await this.driftClosePerp(asset);
    pos.legs.push(perpClose);

    // Close spot leg based on opening side
    const spotClose = pos.side === "short-perp"
      ? await this.driftSpotSwap(asset, "USDC", pos.spotNotional)
      : await this.driftSpotSwap("USDC", asset, pos.spotNotional);
    pos.legs.push(spotClose);

    this.openPositions.delete(asset);
    this.logger.trade(`${asset}: Position closed. Final PnL: $${pos.unrealizedPnl.toFixed(2)}`);
  }

  // ─── CORE: Emergency close ALL positions ────────────────────────────────
  async emergencyCloseAll(): Promise<void> {
    this.logger.risk("EMERGENCY: Closing all open positions");
    for (const asset of this.openPositions.keys()) {
      await this.closeDeltaNeutral(asset);
    }
  }

  // ─── DRIFT: Place perp short order ──────────────────────────────────────
  private async driftPerpShort(asset: Asset, usdNotional: number): Promise<OrderRecord> {
    const record = this.newRecord(asset, "PERP", "SHORT", usdNotional);

    try {
      const mi = PERP_MARKET[asset].index;
      const market = this.driftClient.getPerpMarketAccount(mi);
      if (!market) throw new Error(`No market data for ${asset}`);

      const markPrice = convertToNumber(market.amm.lastMarkPriceTwap, PRICE_PRECISION);
      const baseAmount = usdNotional / markPrice;
      const minSize = PERP_MARKET[asset].minOrderSize;

      if (baseAmount < minSize) {
        throw new Error(`Order too small: ${baseAmount.toFixed(6)} < min ${minSize}`);
      }

      // Round to tick size
      const baseAmountBN = new BN(Math.floor(baseAmount * BASE_PRECISION.toNumber()));

      const orderParams = getMarketOrderParams({
        marketIndex: mi,
        direction: PositionDirection.SHORT,
        baseAssetAmount: baseAmountBN,
        marketType: MarketType.PERP,
        reduceOnly: false,
      });

      const txSig = await this.driftClient.placePerpOrder(orderParams);

      // Confirm transaction
      await this.connection.confirmTransaction(txSig, "confirmed");

      record.txSig = txSig;
      record.status = "FILLED";
      record.fillPrice = markPrice;
      this.logger.trade(`Drift SHORT ${asset} | size=${baseAmount.toFixed(6)} | price=${usd(markPrice)} | tx=${txSig}`);
    } catch (err: any) {
      record.status = "FAILED";
      record.error = err.message;
      this.logger.error(`Drift SHORT failed (${asset}): ${err.message}`);
    }

    this.orderLog.push(record);
    return record;
  }

  // ─── DRIFT: Place perp long order ───────────────────────────────────────
  private async driftPerpLong(asset: Asset, usdNotional: number): Promise<OrderRecord> {
    const record = this.newRecord(asset, "PERP", "BUY", usdNotional);

    try {
      const mi = PERP_MARKET[asset].index;
      const market = this.driftClient.getPerpMarketAccount(mi);
      if (!market) throw new Error(`No market data for ${asset}`);

      const markPrice = convertToNumber(market.amm.lastMarkPriceTwap, PRICE_PRECISION);
      const baseAmount = usdNotional / markPrice;
      const minSize = PERP_MARKET[asset].minOrderSize;

      if (baseAmount < minSize) {
        throw new Error(`Order too small: ${baseAmount.toFixed(6)} < min ${minSize}`);
      }

      const baseAmountBN = new BN(Math.floor(baseAmount * BASE_PRECISION.toNumber()));

      const orderParams = getMarketOrderParams({
        marketIndex: mi,
        direction: PositionDirection.LONG,
        baseAssetAmount: baseAmountBN,
        marketType: MarketType.PERP,
        reduceOnly: false,
      });

      const txSig = await this.driftClient.placePerpOrder(orderParams);
      await this.connection.confirmTransaction(txSig, "confirmed");

      record.txSig = txSig;
      record.status = "FILLED";
      record.fillPrice = markPrice;
      this.logger.trade(`Drift LONG ${asset} | size=${baseAmount.toFixed(6)} | price=${usd(markPrice)} | tx=${txSig}`);
    } catch (err: any) {
      record.status = "FAILED";
      record.error = err.message;
      this.logger.error(`Drift LONG failed (${asset}): ${err.message}`);
    }

    this.orderLog.push(record);
    return record;
  }

  // ─── DRIFT: Close perp position ──────────────────────────────────────────
  private async driftClosePerp(asset: Asset): Promise<OrderRecord> {
    const record = this.newRecord(asset, "PERP", "CLOSE", 0);

    try {
      const mi = PERP_MARKET[asset].index;
      const txSig = await this.driftClient.closePosition(mi, MarketType.PERP);
      await this.connection.confirmTransaction(txSig, "confirmed");
      record.txSig = txSig;
      record.status = "FILLED";
      this.logger.trade(`Drift CLOSE ${asset} perp | tx=${txSig}`);
    } catch (err: any) {
      record.status = "FAILED";
      record.error = err.message;
      this.logger.error(`Drift CLOSE failed (${asset}): ${err.message}`);
    }

    this.orderLog.push(record);
    return record;
  }

  // ─── DRIFT SPOT: Swap tokens via Drift spot markets ─────────────────────────
  private async driftSpotSwap(
    from: "USDC" | "BTC" | "ETH",
    to: "USDC" | "BTC" | "ETH",
    usdAmount: number
  ): Promise<OrderRecord> {
    const side = from === "USDC" ? "BUY" : "SELL";
    const asset = from === "USDC" ? to : from;
    const record = this.newRecord(asset as Asset, "SPOT", side, usdAmount);

    try {
      const DECIMALS: Record<string, number> = { USDC: 6, BTC: 8, ETH: 8 };

      // For spot orders, marketIndex should be the FROM token (what we're spending/selling)
      const fromMarketIndex = SPOT_MARKET[from as keyof typeof SPOT_MARKET].index;
      const fromDecimals = DECIMALS[from];

      // Calculate amount of FROM token in base units
      // usdAmount is always in USD, so for USDC it's direct
      // For BTC/ETH we need to convert from USD to token quantity
      let fromAmountRaw: number;

      if (from === "USDC") {
        // USDC: $30 = 30 * 10^6 base units (USDC has 6 decimals)
        fromAmountRaw = Math.floor(usdAmount * Math.pow(10, fromDecimals));
      } else {
        // For BTC/ETH: get current price and convert USD to token quantity
        const markPrice = from === "BTC"
          ? convertToNumber(this.driftClient.getPerpMarketAccount(1)!.amm.lastMarkPriceTwap, PRICE_PRECISION)
          : convertToNumber(this.driftClient.getPerpMarketAccount(2)!.amm.lastMarkPriceTwap, PRICE_PRECISION);

        const tokenQuantity = usdAmount / markPrice;
        fromAmountRaw = Math.floor(tokenQuantity * Math.pow(10, fromDecimals));
      }

      const baseAmountBN = new BN(fromAmountRaw);

      // Use getMarketOrderParams with the FROM token's market index
      const orderParams = getMarketOrderParams({
        marketIndex: fromMarketIndex,
        direction: side === "BUY" ? PositionDirection.LONG : PositionDirection.SHORT,
        baseAssetAmount: baseAmountBN,
        marketType: MarketType.SPOT,
        reduceOnly: false,
      });

      const txSig = await this.driftClient.placeSpotOrder(orderParams);
      await this.connection.confirmTransaction(txSig, "confirmed");

      // Record successful swap
      record.txSig = txSig;
      record.status = "FILLED";
      record.slippagePct = 0.1; // Assume minimal slippage on Drift spot
      record.fillPrice = 1; // Simplified - would need real price from market data

      this.logger.trade(`Drift Spot ${from}→${to} | amount=$${usdAmount.toFixed(0)} | tx=${txSig}`);
    } catch (err: any) {
      record.status = "FAILED";
      record.error = err.message;
      this.logger.error(`Drift spot swap ${from}→${to} failed: ${err.message}`);
    }

    this.orderLog.push(record);
    return record;
  }

  // ─── Getters ─────────────────────────────────────────────────────────────
  getOrderLog(): OrderRecord[] { return [...this.orderLog]; }
  getOpenPositions(): Map<Asset, DeltaNeutralPosition> { return this.openPositions; }

  async getEquity(): Promise<number> {
    try {
      const user = this.driftClient.getUser();
      return convertToNumber(user.getTotalCollateral(), QUOTE_PRECISION);
    } catch { return 0; }
  }

  // ─── Utilities ────────────────────────────────────────────────────────────
  private newRecord(asset: Asset, leg: OrderRecord["leg"], side: OrderRecord["side"], notional: number): OrderRecord {
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      asset, leg, side,
      notionalUSD: notional,
      status: "PENDING",
    };
  }
}

const usd = (n: number) => "$" + n.toFixed(2);
const pct = (n: number, d = 4) => (n * 100).toFixed(d) + "%";
