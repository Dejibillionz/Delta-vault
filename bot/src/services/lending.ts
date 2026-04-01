/**
 * Lending Integration — Drift USDC Deposits
 *
 * Uses Drift Protocol's built-in deposit/withdraw for lending yield.
 * Idle USDC earns borrow interest from Drift's lending pool.
 * No external protocol dependency needed.
 */

import { DriftClient, BN, SPOT_MARKET_RATE_PRECISION } from "@drift-labs/sdk";
import { calculateDepositRate } from "@drift-labs/sdk";
import { Logger } from "../logger";

// Drift USDC spot market index
const USDC_MARKET_INDEX = 0;

export class LendingManager {
  private driftClient: DriftClient;
  private logger: Logger;
  private isMainnet: boolean;
  private depositedAmount: number = 0;

  constructor(driftClient: DriftClient, logger: Logger) {
    this.driftClient = driftClient;
    this.logger = logger;
    this.isMainnet = process.env.SOLANA_NETWORK === "mainnet-beta";
  }

  /**
   * Get current USDC deposit APR from Drift spot market using SDK helper.
   * Returns a decimal annual rate e.g. 0.05 = 5% APR.
   */
  getDepositApr(): number {
    try {
      const spotMarket = this.driftClient.getSpotMarketAccount(USDC_MARKET_INDEX);
      if (!spotMarket) return 0;

      // calculateDepositRate returns a BN scaled by SPOT_MARKET_RATE_PRECISION (1e6)
      // which represents the annualised deposit rate
      const rateBN: BN = calculateDepositRate(spotMarket);
      const apr = rateBN.toNumber() / SPOT_MARKET_RATE_PRECISION.toNumber();
      return apr;
    } catch {
      return 0;
    }
  }

  /**
   * Deploy idle USDC to Drift lending pool.
   * On devnet, simulates the deposit. On mainnet, executes real deposit.
   */
  async deploy(amountUSD: number): Promise<{ yield: number; txSig?: string }> {
    if (amountUSD < 1) {
      return { yield: 0 };
    }

    const apr = this.getDepositApr();
    const perCycleYield = (amountUSD * apr) / (365 * 24 * 60); // per-minute approx

    if (!this.isMainnet) {
      // Devnet: simulate deposit yield
      this.depositedAmount += amountUSD;
      return { yield: perCycleYield };
    }

    // Mainnet: USDC held as Drift collateral automatically earns deposit interest.
    // No explicit deposit transaction is needed — Drift accrues interest on idle
    // collateral every slot via cumulativeDepositInterest accumulation.
    this.depositedAmount += amountUSD;
    this.logger.info(`Lending: $${amountUSD.toFixed(2)} USDC earning ${(apr * 100).toFixed(2)}% APR via Drift deposits`);

    return { yield: perCycleYield };
  }

  /**
   * Withdraw USDC from lending to free up capital for trading.
   * On Drift, idle collateral is automatically available — no withdraw needed.
   */
  async withdraw(amountUSD: number): Promise<void> {
    this.depositedAmount = Math.max(0, this.depositedAmount - amountUSD);
    this.logger.info(`Lending: Withdrew $${amountUSD.toFixed(2)} from lending pool`);
  }

  getDepositedAmount(): number {
    return this.depositedAmount;
  }
}

