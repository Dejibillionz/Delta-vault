/**
 * Live Order Execution Engine
 * Wires all components together:
 *   - Real market data (Pyth + Drift)
 *   - Wallet signing (ServerWallet or Phantom)
 *   - Drift Protocol perp orders
 *   - Jupiter spot swaps
 *   - Full audit trail
 */

import {
  DriftClient,
  BulkAccountLoader,
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
import axios from "axios";
import { ServerWallet } from "./walletIntegration";
import { Logger } from "./logger";

// ─── Market config ────────────────────────────────────────────────────────────
export const PERP_MARKET = {
  BTC: { index: 1, name: "BTC-PERP", tickSize: 0.1, minOrderSize: 0.001 },
  ETH: { index: 2, name: "ETH-PERP", tickSize: 0.01, minOrderSize: 0.01 },
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

  // Jupiter v6 API
  private JUPITER_API = "https://quote-api.jup.ag/v6";

  // Token mints
  private MINTS = {
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    BTC:  "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E",
    ETH:  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  } as const;

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
  //   Leg 1: Buy spot via Jupiter  (USDC → BTC/ETH)
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

    // ── LEG 1: Spot leg via Jupiter ─────────────────────────────────────
    const spotResult = side === "short-perp"
      ? await this.jupiterSwap("USDC", asset, amount)
      : await this.jupiterSwap(asset, "USDC", amount);
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
        await this.jupiterSwap(asset, "USDC", amount);
      } else {
        await this.jupiterSwap("USDC", asset, amount);
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
      ? await this.jupiterSwap(asset, "USDC", pos.spotNotional)
      : await this.jupiterSwap("USDC", asset, pos.spotNotional);
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

  // ─── JUPITER: Swap tokens ─────────────────────────────────────────────────
  private async jupiterSwap(
    from: keyof typeof this.MINTS,
    to: keyof typeof this.MINTS,
    usdAmount: number
  ): Promise<OrderRecord> {
    const side = from === "USDC" ? "BUY" : "SELL";
    const record = this.newRecord(
      (from === "USDC" ? to : from) as Asset,
      "SPOT", side, usdAmount
    );

    try {
      const DECIMALS: Record<string, number> = { USDC: 6, BTC: 8, ETH: 8 };
      const inputMint = this.MINTS[from];
      const outputMint = this.MINTS[to];
      const amountRaw = Math.floor(usdAmount * Math.pow(10, DECIMALS[from]));

      // 1. Get best route
      const quoteRes = await axios.get(`${this.JUPITER_API}/quote`, {
        params: {
          inputMint, outputMint,
          amount: amountRaw,
          slippageBps: 50,
          onlyDirectRoutes: false,
        },
        timeout: 10000,
      });

      const quote = quoteRes.data;
      const impact = parseFloat(quote.priceImpactPct ?? "0");

      // Reject if price impact > 0.5%
      if (impact > 0.5) {
        throw new Error(`Price impact too high: ${impact.toFixed(2)}%`);
      }

      // 2. Get swap transaction
      const swapRes = await axios.post(`${this.JUPITER_API}/swap`, {
        quoteResponse: quote,
        userPublicKey: this.wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      }, { timeout: 10000 });

      // 3. Sign and send
      const { swapTransaction } = swapRes.data;
      const { VersionedTransaction } = await import("@solana/web3.js");
      const txBuf = Buffer.from(swapTransaction, "base64");
      const tx = VersionedTransaction.deserialize(txBuf);
      tx.sign([this.wallet["keypair"] as any]); // access keypair for signing

      const txSig = await this.connection.sendTransaction(tx, { maxRetries: 3 });
      const conf = await this.connection.confirmTransaction(txSig, "confirmed");

      if (conf.value.err) throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);

      const outAmt = parseInt(quote.outAmount) / Math.pow(10, DECIMALS[to]);
      record.txSig = txSig;
      record.status = "FILLED";
      record.slippagePct = impact;
      record.fillPrice = to === "USDC" ? usdAmount / outAmt : outAmt / usdAmount;
      this.logger.trade(`Jupiter ${from}→${to} | in=$${usdAmount.toFixed(0)} | impact=${impact.toFixed(3)}% | tx=${txSig}`);
    } catch (err: any) {
      record.status = "FAILED";
      record.error = err.message;
      this.logger.error(`Jupiter swap ${from}→${to} failed: ${err.message}`);
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
