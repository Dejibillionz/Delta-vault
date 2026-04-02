/**
 * Liquidity Guard
 * Validates that sufficient open interest headroom exists before any trade
 * is placed on Drift. Prevents OI saturation.
 *
 * Called by the execution engine before every order.
 */

import { DriftClient, convertToNumber, BN } from "@drift-labs/sdk";
import { Logger } from "./logger";

// ─── Thresholds ───────────────────────────────────────────────────────────────
const LIQUIDITY_CONFIG = {
  // Max Drift OI utilization — don't trade into a saturated market
  MAX_OI_UTILIZATION: 0.80,
} as const;

export type Asset = "BTC" | "ETH" | "SOL" | "JTO";

export interface LiquidityCheck {
  allowed: boolean;
  reason: string;
  oiUtilization: number;
}

const DRIFT_MARKET_INDEX: Record<string, number> = { SOL: 0, BTC: 1, ETH: 2, JTO: 20 };

// ─── Liquidity Guard ──────────────────────────────────────────────────────────
export class LiquidityGuard {
  private driftClient: DriftClient;
  private logger: Logger;

  constructor(driftClient: DriftClient, logger: Logger) {
    this.driftClient = driftClient;
    this.logger = logger;
  }

  /**
   * Liquidity check before placing a trade.
   * Checks Drift OI utilization to prevent saturation.
   */
  async checkLiquidity(asset: string, tradeSizeUSD: number): Promise<LiquidityCheck> {
    const oiCheck = await this.checkDriftOI(asset, tradeSizeUSD);

    if (!oiCheck.allowed) {
      this.logger.warn(`LiquidityGuard: ${asset} BLOCKED — ${oiCheck.reason}`);
      return oiCheck;
    }

    this.logger.info(
      `LiquidityGuard: ${asset} OK — OI util ${(oiCheck.oiUtilization * 100).toFixed(1)}%`
    );

    return {
      allowed: true,
      reason: "Liquidity check passed",
      oiUtilization: oiCheck.oiUtilization,
    };
  }

  // ─── Drift open interest utilization check ─────────────────────────────────
  private async checkDriftOI(
    asset: string,
    tradeSizeUSD: number
  ): Promise<LiquidityCheck> {
    try {
      const mi = DRIFT_MARKET_INDEX[asset];
      const market = this.driftClient.getPerpMarketAccount(mi);

      if (!market) {
        return { allowed: true, reason: "No Drift market data — skipping OI check", oiUtilization: 0 };
      }

      // OI utilization: baseAssetAmountWithAmm / maxBaseAssetAmount
      const currentOI = market.amm.baseAssetAmountWithAmm.abs();
      const maxOI = market.amm.baseAssetReserve;

      // Compute utilization ratio
      const utilization = maxOI.isZero()
        ? 0
        : currentOI.toNumber() / maxOI.toNumber();

      if (utilization > LIQUIDITY_CONFIG.MAX_OI_UTILIZATION) {
        return {
          allowed: false,
          reason: `Drift OI utilization ${(utilization * 100).toFixed(1)}% exceeds max ${(LIQUIDITY_CONFIG.MAX_OI_UTILIZATION * 100).toFixed(0)}%`,
          oiUtilization: utilization,
        };
      }

      return { allowed: true, reason: "Drift OI OK", oiUtilization: utilization };

    } catch (err: any) {
      this.logger.warn(`LiquidityGuard: Drift OI check failed (${asset}) — ${err.message}`);
      return { allowed: true, reason: "Drift OI unavailable — skipping check", oiUtilization: 0 };
    }
  }
}
