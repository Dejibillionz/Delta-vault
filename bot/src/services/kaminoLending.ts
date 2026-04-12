/**
 * KaminoManager
 * Replaces Drift lending (services/lending.ts) with Kamino Finance.
 *
 * Kamino Finance is a Solana lending protocol. In the delta-neutral strategy,
 * idle USDC is supplied to Kamino's USDC market to earn supply yield (~3–5% APR).
 *
 * Demo mode: fully simulated — no Kamino SDK calls required.
 * Live mode: requires @kamino-finance/klend-sdk + KAMINO_MARKET_ADDRESS + KAMINO_USDC_RESERVE_ADDRESS.
 *            Calls initializeLive() on startup to connect; falls back to demo on any error.
 */

import { Logger } from "../logger";

const DEMO_MODE = process.env.DEMO_MODE !== "false";

// ── Simulated constants ────────────────────────────────────────────────────────
// Realistic Solana USDC lending rate. Override via KAMINO_SIM_APR env var.
const SIM_SUPPLY_APR = parseFloat(process.env.KAMINO_SIM_APR ?? "0.045"); // 4.5%
const SIM_BORROW_APR = 0.055;    // 5.5% simulated borrow rate (for HF / leverage context)
const SIM_HEALTH_FACTOR = 2.0;
const CYCLE_SECONDS = 15;        // matches bot's CYCLE_MS
const SLOT_REFRESH_MS = 60_000;  // re-read slot every 60s

export interface KaminoState {
  depositedUsdc: number;
  borrowedUsdc: number;
  supplyAprPct: number;        // supply-side APR %
  borrowAprPct: number;        // borrow APR % (shown in logs, not used for yield in phase 1)
  healthFactor: number;        // 2.0+ = safe; < 1.25 = liquidation risk
  netYieldAnnualPct: number;   // = supplyAprPct (phase 1: supply-only)
}

// ── KaminoManager ──────────────────────────────────────────────────────────────
export class KaminoManager {
  private depositedAmount = 0;
  private cumulativeYield = 0;
  private logger: Logger;
  private marketAddress: string;
  private usdcReserveAddress: string;

  // Live-mode SDK state (null = demo / uninitialized)
  private kaminoSdk: any = null;
  private kaminoMarket: any = null;
  private usdcReserve: any = null;
  private solanaKit: any = null;
  private liveConnection: any = null;
  private liveWallet: any = null;
  private lastKnownSlot = 0n; // BigInt for SDK
  private slotRefreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(logger: Logger, initialDeposit = 0, connection?: any, wallet?: any) {
    this.logger = logger;
    this.marketAddress    = process.env.KAMINO_MARKET_ADDRESS        ?? "";
    this.usdcReserveAddress = process.env.KAMINO_USDC_RESERVE_ADDRESS ?? "";
    this.depositedAmount  = initialDeposit;
    this.liveConnection   = connection ?? null;
    this.liveWallet       = wallet ?? null;

    if (DEMO_MODE) {
      logger.info(`[KAMINO] Demo mode — simulated ${(SIM_SUPPLY_APR * 100).toFixed(1)}% supply APR`);
    }
  }

  /**
   * Attempt to connect to Kamino live market.
   * Falls back to demo mode on any SDK or network error.
   * Call right after marketEngine.start() on startup (live mode only).
   */
  async initializeLive(): Promise<void> {
    if (DEMO_MODE) return;
    if (!this.marketAddress) {
      this.logger.warn("[KAMINO] KAMINO_MARKET_ADDRESS not set — running demo mode");
      return;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.kaminoSdk = require("@kamino-finance/klend-sdk");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.solanaKit = require("@solana/kit");
    } catch {
      this.logger.warn("[KAMINO] @kamino-finance/klend-sdk or @solana/kit not installed — using demo mode");
      return;
    }

    try {
      const { KaminoMarket } = this.kaminoSdk;
      const { createSolanaRpc, address } = this.solanaKit;
      const rpcUrl = process.env.HELIUS_RPC_URL ?? "https://api.mainnet-beta.solana.com";
      const rpc    = createSolanaRpc(rpcUrl);

      this.kaminoMarket = await KaminoMarket.load(rpc, address(this.marketAddress), 400);
      this.logger.info(`[KAMINO] Market loaded: ${this.marketAddress}`);

      if (this.usdcReserveAddress) {
        this.usdcReserve = this.kaminoMarket.getReserveByAddress(address(this.usdcReserveAddress));
        if (this.usdcReserve) {
          this.logger.info(`[KAMINO] USDC reserve loaded ✓`);
        } else {
          this.logger.warn("[KAMINO] USDC reserve not found — check KAMINO_USDC_RESERVE_ADDRESS");
        }
      }

      // Cache current slot and refresh every 60s
      await this.refreshSlot(rpc);
      this.slotRefreshTimer = setInterval(() => this.refreshSlot(rpc), SLOT_REFRESH_MS);

      this.logger.info(`[KAMINO] Live mode active — APR from on-chain reserve`);
    } catch (err: any) {
      this.logger.warn(`[KAMINO] Live init failed: ${err.message} — falling back to demo mode`);
      this.kaminoMarket = null;
      this.usdcReserve  = null;
    }
  }

  private async refreshSlot(rpc: any): Promise<void> {
    try {
      const slot = await rpc.getSlot().send();
      this.lastKnownSlot = BigInt(slot);
    } catch { /* keep last known value */ }
  }

  // ── Core interface (matches LendingManager API) ───────────────────────────

  /** Supply-side APR as decimal (e.g. 0.045 = 4.5%). */
  getDepositApr(): number {
    if (!DEMO_MODE && this.usdcReserve && this.lastKnownSlot > 0n) {
      try {
        return this.usdcReserve.totalSupplyAPY(this.lastKnownSlot);
      } catch { /* fall through */ }
    }
    return SIM_SUPPLY_APR;
  }

  /** Deploy idle capital into Kamino USDC supply. Returns yield earned this cycle. */
  async deploy(amountUSD: number): Promise<{ yield: number; txSig?: string }> {
    if (amountUSD <= 0) return { yield: 0 };

    const apr       = this.getDepositApr();
    const cycleYield = amountUSD * apr / (365 * 24 * (3600 / CYCLE_SECONDS));

    if (DEMO_MODE || !this.kaminoMarket || !this.liveWallet || !this.liveConnection) {
      this.depositedAmount += amountUSD;
      this.cumulativeYield += cycleYield;
      return { yield: cycleYield };
    }

    // Live path: build and send Kamino deposit transaction
    try {
      const { KaminoAction } = this.kaminoSdk;
      const { address }      = this.solanaKit;
      const amountLamports   = BigInt(Math.round(amountUSD * 1_000_000)); // USDC 6 decimals

      const depositAction = await KaminoAction.buildDepositTxns(
        this.kaminoMarket,
        amountLamports,
        address(this.usdcReserveAddress),
        this.liveWallet.publicKey,
        /* obligation */ null
      );

      const allIxs = [
        ...depositAction.setupIxs,
        ...depositAction.lendingIxs,
        ...depositAction.cleanupIxs,
      ];

      const txSig = await this.sendTransactions(allIxs);
      this.depositedAmount += amountUSD;
      this.cumulativeYield += cycleYield;
      this.logger.info(`[KAMINO] Deposited $${amountUSD.toFixed(2)} — tx ${txSig}`);
      return { yield: cycleYield, txSig };
    } catch (err: any) {
      this.logger.warn(`[KAMINO] live deposit failed: ${err.message} — tracking in demo mode`);
      this.depositedAmount += amountUSD;
      this.cumulativeYield += cycleYield;
      return { yield: cycleYield };
    }
  }

  /** Withdraw capital from Kamino supply. */
  async withdraw(amountUSD: number): Promise<void> {
    this.depositedAmount = Math.max(0, this.depositedAmount - amountUSD);

    if (DEMO_MODE || !this.kaminoMarket || !this.liveWallet || !this.liveConnection) return;

    try {
      const { KaminoAction } = this.kaminoSdk;
      const { address }      = this.solanaKit;
      const amountLamports   = BigInt(Math.round(amountUSD * 1_000_000));

      const withdrawAction = await KaminoAction.buildWithdrawTxns(
        this.kaminoMarket,
        amountLamports,
        address(this.usdcReserveAddress),
        this.liveWallet.publicKey,
        /* obligation */ null
      );

      const allIxs = [
        ...withdrawAction.setupIxs,
        ...withdrawAction.lendingIxs,
        ...withdrawAction.cleanupIxs,
      ];

      const txSig = await this.sendTransactions(allIxs);
      this.logger.info(`[KAMINO] Withdrew $${amountUSD.toFixed(2)} — tx ${txSig}`);
    } catch (err: any) {
      this.logger.warn(`[KAMINO] live withdraw failed: ${err.message}`);
    }
  }

  /** Build + sign + send a list of Solana instructions via @solana/kit pipeline. */
  private async sendTransactions(instructions: any[]): Promise<string> {
    const { createTransactionMessage, setTransactionMessageFeePayerSigner,
            appendTransactionMessageInstructions, signTransactionMessageWithSigners,
            getBase64EncodedWireTransaction } = this.solanaKit;

    const rpc = this.solanaKit.createSolanaRpc(process.env.HELIUS_RPC_URL ?? "");
    const latestBlockhash = await rpc.getLatestBlockhash().send();

    let tx = createTransactionMessage({ version: 0 });
    tx = setTransactionMessageFeePayerSigner(this.liveWallet, tx);
    tx = appendTransactionMessageInstructions(instructions, tx);
    tx = { ...tx, lifetimeConstraint: latestBlockhash.value };

    const signed = await signTransactionMessageWithSigners(tx);
    const wire   = getBase64EncodedWireTransaction(signed);
    const sig    = await rpc.sendTransaction(wire, { encoding: "base64" }).send();
    return String(sig);
  }

  /** Total USDC currently deposited. */
  getDepositedAmount(): number {
    return this.depositedAmount;
  }

  /** Cumulative yield earned so far (USD). */
  getCumulativeYield(): number {
    return this.cumulativeYield;
  }

  /** Kamino health factor (relevant when borrowing; ≥ 2.0 = safe in supply-only mode). */
  getHealthFactor(): number {
    return SIM_HEALTH_FACTOR; // supply-only means no liquidation risk
  }

  /** Full Kamino market state snapshot for dashboard / logs. */
  async getMarketState(): Promise<KaminoState> {
    const apr = this.getDepositApr();
    return {
      depositedUsdc:     this.depositedAmount,
      borrowedUsdc:      0,             // phase 1: supply-only, no borrowing
      supplyAprPct:      apr * 100,
      borrowAprPct:      SIM_BORROW_APR * 100,
      healthFactor:      this.getHealthFactor(),
      netYieldAnnualPct: apr * 100,
    };
  }
}
