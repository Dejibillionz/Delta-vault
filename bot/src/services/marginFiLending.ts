/**
 * marginFiLending.ts
 * MarginFi V2 — borrow leg of the negative-funding delta-neutral strategy.
 *
 * When funding is negative (shorts pay longs) the bot earns yield by:
 *   1. Depositing USDC collateral into MarginFi
 *   2. Borrowing the asset (SOL/ETH/BTC/JTO) against that collateral
 *   3. Selling the borrowed tokens on Jupiter  → synthetic short spot
 *   4. Longing the perp on Hyperliquid         → delta hedge
 *
 * Net edge = |fundingRate| × 8760 − borrowRateAnnual  (must be > MIN_NET_EDGE)
 *
 * Demo mode: fully simulated — no MarginFi SDK calls.
 * Live mode: requires @mrgnlabs/marginfi-client-v2 (optional dep, loaded at runtime).
 */

import { Connection } from "@solana/web3.js";
import { ServerWallet } from "../walletIntegration";
import { Logger } from "../logger";

const DEMO_MODE    = process.env.DEMO_MODE !== "false";
const MARGINFI_ENV = process.env.MARGINFI_ENV ?? "development";

// ── Net-edge gate ─────────────────────────────────────────────────────────────
// Only open a negative-funding trade when funding yield exceeds borrow cost by
// this margin (annualised).  2% = protects against rate drift and tx fees.
const MIN_NET_EDGE = 0.02;

// Collateral ratio: borrow $N notional requires $N × COLLATERAL_RATIO USDC locked.
// 125% = 80% LTV (standard for MarginFi blue-chip markets).
const COLLATERAL_RATIO = 1.25;

// ── Simulated borrow rates (annual, demo) ─────────────────────────────────────
const SIM_BORROW_RATES: Record<string, number> = {
  BTC: 0.02,   // 2%   — deep market, high liquidity
  ETH: 0.03,   // 3%
  SOL: 0.05,   // 5%
  JTO: 0.10,   // 10%  — thin market
};

// ── Interfaces ────────────────────────────────────────────────────────────────
export interface BorrowRecord {
  asset:            string;
  tokenAmount:      number;   // tokens borrowed
  usdNotional:      number;   // USD value at borrow time
  collateralLocked: number;   // USDC locked as collateral
  entryPrice:       number;   // asset price at borrow time
  borrowRateAnnual: number;   // APR as decimal (e.g. 0.05 = 5%)
  openedAt:         number;   // Date.now() at open
}

export interface MarginFiState {
  borrowedByAsset:    Record<string, BorrowRecord>;
  totalCollateral:    number;   // USDC locked across all borrows
  totalBorrowedUsd:   number;
  healthFactor:       number;   // > 1.25 = safe
  simulatedRates:     Record<string, number>;  // asset → annual borrow rate
}

// ── MarginFiManager ───────────────────────────────────────────────────────────
export class MarginFiManager {
  private connection: Connection;
  private wallet:     ServerWallet;
  private logger:     Logger;
  private sdk:        any = null;

  private borrows = new Map<string, BorrowRecord>();

  constructor(connection: Connection, wallet: ServerWallet, logger: Logger) {
    this.connection = connection;
    this.wallet     = wallet;
    this.logger     = logger;

    if (!DEMO_MODE) {
      this.tryLoadSdk();
    } else {
      const rates = Object.entries(SIM_BORROW_RATES)
        .map(([a, r]) => `${a} ${(r * 100).toFixed(0)}%`)
        .join(", ");
      logger.info(`[MARGINFI] Demo mode — simulated borrow rates: ${rates}`);
    }
  }

  private tryLoadSdk(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.sdk = require("@mrgnlabs/marginfi-client-v2");
      this.logger.info("[MARGINFI] marginfi-client-v2 loaded ✓");
    } catch {
      this.logger.warn("[MARGINFI] @mrgnlabs/marginfi-client-v2 not installed — using demo mode");
    }
  }

  // ── Profitability gate ────────────────────────────────────────────────────────

  /**
   * Returns true when the funding yield (annualised) exceeds the borrow cost
   * by at least MIN_NET_EDGE (2%).  Call before opening a negative-funding trade.
   */
  isTradeViable(asset: string, fundingRatePerHour: number): boolean {
    const fundingAnnual = Math.abs(fundingRatePerHour) * 8760;
    const borrowAnnual  = this.getBorrowRate(asset);
    const netEdge       = fundingAnnual - borrowAnnual;
    this.logger.info(
      `[MARGINFI] ${asset} edge check: funding ${(fundingAnnual * 100).toFixed(2)}% − ` +
      `borrow ${(borrowAnnual * 100).toFixed(2)}% = net ${(netEdge * 100).toFixed(2)}% ` +
      `(min ${(MIN_NET_EDGE * 100).toFixed(0)}%)`
    );
    return netEdge >= MIN_NET_EDGE;
  }

  /** Annual borrow rate as a decimal for a given asset. */
  getBorrowRate(asset: string): number {
    if (DEMO_MODE || !this.sdk) return SIM_BORROW_RATES[asset] ?? 0.08;
    // Live: read from MarginFi bank — use sim until fully wired
    return SIM_BORROW_RATES[asset] ?? 0.08;
  }

  // ── Borrow (open short-spot leg) ──────────────────────────────────────────────

  /**
   * Deposit USDC collateral and borrow `usdNotional` worth of `asset` tokens.
   * Returns the token amount borrowed and USDC collateral locked.
   */
  async borrowAsset(
    asset: string,
    usdNotional: number,
    assetPrice: number
  ): Promise<{ tokenAmount: number; collateralLocked: number }> {
    const collateralLocked = usdNotional * COLLATERAL_RATIO;
    const tokenAmount      = usdNotional / assetPrice;
    const borrowRate       = this.getBorrowRate(asset);

    if (DEMO_MODE || !this.sdk) {
      const record: BorrowRecord = {
        asset,
        tokenAmount,
        usdNotional,
        collateralLocked,
        entryPrice:       assetPrice,
        borrowRateAnnual: borrowRate,
        openedAt:         Date.now(),
      };
      this.borrows.set(asset, record);
      this.logger.info(
        `[MARGINFI] [DEMO] borrowed ${tokenAmount.toFixed(6)} ${asset} ` +
        `($${usdNotional.toFixed(2)}) | collateral $${collateralLocked.toFixed(2)} USDC ` +
        `| rate ${(borrowRate * 100).toFixed(1)}% APR`
      );
      return { tokenAmount, collateralLocked };
    }

    // ── Live path ──────────────────────────────────────────────────────────────
    try {
      const { MarginfiClient, getConfig } = this.sdk;
      const config = getConfig(MARGINFI_ENV);
      const client = await MarginfiClient.fetch(config, this.wallet, this.connection);

      // Get existing account or create one
      const accounts = await client.getMarginfiAccountsForAuthority(this.wallet.publicKey);
      const account  = accounts.length > 0
        ? accounts[0]
        : await client.createMarginfiAccount();

      const usdcBank  = client.getBankByTokenSymbol("USDC");
      const assetBank = client.getBankByTokenSymbol(asset);
      if (!usdcBank || !assetBank) {
        throw new Error(`[MARGINFI] Bank not found for USDC or ${asset}`);
      }

      // Deposit USDC collateral
      await account.deposit(collateralLocked, usdcBank);

      // Borrow asset tokens
      await account.borrow(tokenAmount, assetBank);

      const record: BorrowRecord = {
        asset, tokenAmount, usdNotional, collateralLocked,
        entryPrice: assetPrice, borrowRateAnnual: borrowRate,
        openedAt: Date.now(),
      };
      this.borrows.set(asset, record);
      this.logger.info(
        `[MARGINFI] live borrow: ${tokenAmount.toFixed(6)} ${asset} ` +
        `| collateral $${collateralLocked.toFixed(2)} USDC`
      );
      return { tokenAmount, collateralLocked };
    } catch (err: any) {
      this.logger.error(`[MARGINFI] borrow failed: ${err.message}`);
      throw err;
    }
  }

  // ── Repay (close short-spot leg) ──────────────────────────────────────────────

  /**
   * Repay the borrowed asset and withdraw USDC collateral.
   * Returns interest paid (USD).
   */
  async repayBorrow(asset: string, tokenAmount: number): Promise<number> {
    const record = this.borrows.get(asset);
    const interestPaid = record
      ? record.usdNotional * record.borrowRateAnnual *
        ((Date.now() - record.openedAt) / (365 * 24 * 3600 * 1000))
      : 0;

    if (DEMO_MODE || !this.sdk) {
      this.borrows.delete(asset);
      this.logger.info(
        `[MARGINFI] [DEMO] repaid ${tokenAmount.toFixed(6)} ${asset} ` +
        `| interest $${interestPaid.toFixed(4)}`
      );
      return interestPaid;
    }

    // ── Live path ──────────────────────────────────────────────────────────────
    try {
      const { MarginfiClient, getConfig } = this.sdk;
      const config   = getConfig(MARGINFI_ENV);
      const client   = await MarginfiClient.fetch(config, this.wallet, this.connection);
      const accounts = await client.getMarginfiAccountsForAuthority(this.wallet.publicKey);
      if (accounts.length === 0) throw new Error("No MarginFi account found");

      const account   = accounts[0];
      const assetBank = client.getBankByTokenSymbol(asset);
      const usdcBank  = client.getBankByTokenSymbol("USDC");
      if (!assetBank || !usdcBank) throw new Error(`Bank not found for ${asset} or USDC`);

      await account.repay(tokenAmount, assetBank);
      if (record) await account.withdraw(record.collateralLocked, usdcBank);

      this.borrows.delete(asset);
      this.logger.info(
        `[MARGINFI] live repay: ${tokenAmount.toFixed(6)} ${asset} ` +
        `| interest $${interestPaid.toFixed(4)}`
      );
      return interestPaid;
    } catch (err: any) {
      this.logger.error(`[MARGINFI] repay failed: ${err.message}`);
      throw err;
    }
  }

  /** Returns the current borrow record for an asset, or null. */
  getBorrow(asset: string): BorrowRecord | null {
    return this.borrows.get(asset) ?? null;
  }

  /** Full state snapshot for dashboard / logs. */
  getState(): MarginFiState {
    const borrowed: Record<string, BorrowRecord> = {};
    let totalCollateral = 0;
    let totalBorrowedUsd = 0;
    for (const [asset, rec] of this.borrows) {
      borrowed[asset]  = rec;
      totalCollateral  += rec.collateralLocked;
      totalBorrowedUsd += rec.usdNotional;
    }
    // Health factor: collateral / borrowed (simplified; real calc uses liquidation thresholds)
    const healthFactor = totalBorrowedUsd > 0
      ? (totalCollateral / COLLATERAL_RATIO) / totalBorrowedUsd * COLLATERAL_RATIO
      : 99;

    return {
      borrowedByAsset:  borrowed,
      totalCollateral,
      totalBorrowedUsd,
      healthFactor,
      simulatedRates:   { ...SIM_BORROW_RATES },
    };
  }
}
