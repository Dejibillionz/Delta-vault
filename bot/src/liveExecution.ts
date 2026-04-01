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
import { JupiterSwapper } from "./jupiterSwap";

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
  private jupiterSwapper: JupiterSwapper;
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
    this.jupiterSwapper = new JupiterSwapper(connection, wallet, logger);
  }

  // ─── CORE: Open delta-neutral position ─────────────────────────────────
  // Executes both legs atomically (best-effort):
  //   Leg 1: Buy spot via Drift spot (USDC → BTC/ETH) — ONLY if we have enough USDC for Drift minimum
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

    // ── LEG 1: Spot leg via Jupiter ───────────────────────────────────────
    // Jupiter allows swaps at any size with no minimums, unlike Drift
    const spotLeg = side === "short-perp"
      ? await this.jupiterSpotSwap("USDC", asset, amount)
      : await this.jupiterSpotSwap(asset, "USDC", amount);
    position.legs.push(spotLeg);

    if (spotLeg.status === "FAILED") {
      this.logger.error(`${asset}: Spot leg failed — aborting. No perp order sent.`);
      return null;
    }
    position.spotNotional = amount;
    this.logger.trade(`${asset}: Spot leg FILLED — tx: ${spotLeg.txSig}`);


    // ── LEG 2: Perp leg via Drift ───────────────────────────────────────
    const perpResult = side === "short-perp"
      ? await this.driftPerpShort(asset, amount)
      : await this.driftPerpLong(asset, amount);
    position.legs.push(perpResult);

    if (perpResult.status === "FAILED") {
      this.logger.error(`${asset}: Perp leg failed.`);
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

    // Close spot leg only if it was opened (spotNotional > 0)
    if (pos.spotNotional > 0) {
      const spotClose = pos.side === "short-perp"
        ? await this.jupiterSpotSwap(asset, "USDC", pos.spotNotional)
        : await this.jupiterSpotSwap("USDC", asset, pos.spotNotional);
      pos.legs.push(spotClose);
    }

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
      const market = this.driftClient.getPerpMarketAccount(mi);
      if (!market) throw new Error(`No market data for ${asset}`);

      // Get current position to determine close direction
      const user = this.driftClient.getUser();
      const pos = user.getPerpPosition(mi);

      if (!pos || pos.baseAssetAmount === 0) {
        record.status = "FILLED";
        record.error = "No open position";
        this.logger.trade(`Drift CLOSE ${asset}: no open position`);
        return record;
      }

      // Close by placing opposite order with reduceOnly
      const closeDirection = pos.baseAssetAmount > 0 ? PositionDirection.SHORT : PositionDirection.LONG;
      const closeAmount = new BN(Math.abs(pos.baseAssetAmount));

      const orderParams = getMarketOrderParams({
        marketIndex: mi,
        direction: closeDirection,
        baseAssetAmount: closeAmount,
        marketType: MarketType.PERP,
        reduceOnly: true,
      });

      const txSig = await this.driftClient.placePerpOrder(orderParams);
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
  private async jupiterSpotSwap(
    from: "USDC" | "BTC" | "ETH",
    to: "USDC" | "BTC" | "ETH",
    usdAmount: number
  ): Promise<OrderRecord> {
    const side = from === "USDC" ? "BUY" : "SELL";
    const asset = from === "USDC" ? to : from;
    const record = this.newRecord(asset as Asset, "SPOT", side, usdAmount);

    try {
      // Execute swap via Jupiter
      const swapResult = await this.jupiterSwapper.swap(from, to, usdAmount);

      // Record successful swap
      record.txSig = swapResult.txSig;
      record.status = "FILLED";
      record.slippagePct = swapResult.slippagePct;
      record.fillPrice = 1; // Price data from Jupiter would be needed for accuracy

      this.logger.trade(
        `Jupiter Spot ${from}→${to} | amount=$${usdAmount.toFixed(0)} | slippage=${record.slippagePct.toFixed(2)}% | tx=${swapResult.txSig}`
      );
    } catch (err: any) {
      record.status = "FAILED";
      record.error = err.message;
      this.logger.error(`Jupiter spot swap ${from}→${to} failed: ${err.message}`);
    }

    this.orderLog.push(record);
    return record;
  }

  // ─── Position Exit Evaluation ──────────────────────────────────────────
  /**
   * Evaluate if a position should be closed based on:
   * 1. Time-based: max hold time exceeded
   * 2. Profit-taking: target profit reached
   * 3. Min funding: effective rate drops below minimum
   */
  evaluatePositionExit(
    asset: Asset,
    currentFundingRate: number,
    entryFundingRate: number
  ): { shouldClose: boolean; reason: string } {
    const pos = this.openPositions.get(asset);
    if (!pos) return { shouldClose: false, reason: "No position" };

    const ageMs = Date.now() - pos.openedAt;
    const ageHours = ageMs / (1000 * 60 * 60);

    // 1. Max hold time: 4 hours (prevents position from running too long)
    if (ageHours > 4) {
      return { shouldClose: true, reason: `Position held for ${ageHours.toFixed(1)}h (max 4h)` };
    }

    // 2. Profit-taking: close after 1% profit on notional
    if (pos.unrealizedPnl > pos.perpNotional * 0.01) {
      return {
        shouldClose: true,
        reason: `Profit target hit: PnL $${pos.unrealizedPnl.toFixed(2)} (1% of $${pos.perpNotional.toFixed(0)})`,
      };
    }

    // 3. Funding regime flipped: effective funding reversed
    const entryDir = entryFundingRate >= 0 ? 1 : -1;
    const currentDir = currentFundingRate >= 0 ? 1 : -1;
    if (entryDir !== currentDir) {
      return {
        shouldClose: true,
        reason: `Funding regime flipped: entry=${pct(entryFundingRate)} vs current=${pct(currentFundingRate)}`,
      };
    }

    // 4. Effective funding dropped below minimum threshold (0.005% per hour)
    const effectiveFunding = currentFundingRate * entryDir;
    const MIN_FUNDING_EXIT = 0.00005;
    if (effectiveFunding < MIN_FUNDING_EXIT && ageHours > 0.5) {
      return {
        shouldClose: true,
        reason: `Effective funding ${pct(effectiveFunding)} below minimum (0.005%), held ${ageHours.toFixed(1)}h`,
      };
    }

    // 5. Funding urgency: close if we're only holding another 5 min of funding
    const estimatedNextFunding = currentFundingRate / 8; // hourly / 8 = per 7.5min
    const nextCycleReturn = pos.perpNotional * estimatedNextFunding;
    if (ageHours > 0.25 && nextCycleReturn < 0.5) {
      // Less than $0.50 funding next cycle
      return {
        shouldClose: true,
        reason: `Funding depleted: next cycle return only $${nextCycleReturn.toFixed(2)}`,
      };
    }

    return { shouldClose: false, reason: "Position conditions favorable" };
  }

  /**
   * Update position's unrealized PnL based on current market conditions
   */
  updatePositionPnL(asset: Asset, fundingRate: number): void {
    const pos = this.openPositions.get(asset);
    if (!pos) return;

    const ageMs = Date.now() - pos.openedAt;
    const ageHours = ageMs / (1000 * 60 * 60);

    // Funding collected = position notional × funding rate × hours held
    pos.fundingCollected = pos.perpNotional * fundingRate * ageHours;

    // Set unrealizedPnl to funding collected (delta-neutral has no directional PnL)
    pos.unrealizedPnl = pos.fundingCollected;
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
