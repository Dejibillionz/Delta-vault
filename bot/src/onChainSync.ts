/**
 * On-Chain Sync — pushes live NAV and risk state to Solana each cycle.
 *
 * The vault's deposit/withdraw instructions gate on:
 *   1. nav_last_updated < max_nav_staleness_s (default 60s)
 *   2. risk_oracle.last_updated < 60s
 *
 * This module is called by the main bot loop after each risk assessment
 * to keep both accounts fresh.
 */

import {
  DriftClient,
  convertToNumber,
  PRICE_PRECISION,
  QUOTE_PRECISION,
  BN,
} from "@drift-labs/sdk";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { AnchorProvider, Program, Idl, BN as AnchorBN } from "@coral-xyz/anchor";
import { ServerWallet } from "./walletIntegration";
import { PortfolioMetrics } from "./enhancedRiskEngine";
import { LiveMarketSnapshot } from "./realMarketData";
import { Logger } from "./logger";

// ── Config ────────────────────────────────────────────────────────────────────
const VAULT_PROGRAM_ID = new PublicKey(
  process.env.VAULT_PROGRAM_ID ?? "DeLtAVauLt11111111111111111111111111111111111"
);

export class OnChainSync {
  private connection: Connection;
  private wallet: ServerWallet;
  private driftClient: DriftClient;
  private logger: Logger;
  private vaultPda: PublicKey;
  private lastNavUpdate: number = 0;
  private lastRiskUpdate: number = 0;

  // Min ms between on-chain updates (avoid spam + unnecessary tx fees)
  private readonly NAV_UPDATE_INTERVAL_MS  = 25_000;  // 25s
  private readonly RISK_UPDATE_INTERVAL_MS = 10_000;  // 10s

  constructor(
    connection: Connection,
    wallet: ServerWallet,
    driftClient: DriftClient,
    logger: Logger
  ) {
    this.connection  = connection;
    this.wallet      = wallet;
    this.driftClient = driftClient;
    this.logger      = logger;

    // Derive vault PDA
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), wallet.publicKey.toBuffer()],
      VAULT_PROGRAM_ID
    );
    this.vaultPda = pda;
    this.logger.info(`OnChainSync: vault PDA = ${pda.toBase58()}`);
  }

  // ── Push NAV update on-chain ──────────────────────────────────────────────
  async pushNavUpdate(
    btcSnapshot: LiveMarketSnapshot,
    ethSnapshot: LiveMarketSnapshot
  ): Promise<void> {
    const now = Date.now();
    if (now - this.lastNavUpdate < this.NAV_UPDATE_INTERVAL_MS) return;

    try {
      // BTC/ETH spot prices in USDC (6 dec) from Pyth
      const btcPriceUsdc = Math.round(btcSnapshot.spotPrice * 1_000_000);
      const ethPriceUsdc = Math.round(ethSnapshot.spotPrice * 1_000_000);

      // Aggregate unrealized PnL from all open Drift perp positions
      const perpPnl = await this.getAggregatedPerpPnl();

      // Spot holdings from Drift spot positions
      const { btcAmount, ethAmount } = await this.getSpotHoldings();

      this.logger.info(
        `OnChainSync: pushing NAV — BTC=${usd(btcSnapshot.spotPrice)} ` +
        `ETH=${usd(ethSnapshot.spotPrice)} perpPnL=${usd(perpPnl / 1e6)}`
      );

      // Build and send update_nav instruction
      // (In production: use @coral-xyz/anchor Program.methods().updateNav())
      await this.sendVaultInstruction("update_nav", {
        btcPriceUsdc: new AnchorBN(btcPriceUsdc),
        ethPriceUsdc: new AnchorBN(ethPriceUsdc),
        perpPnl:      new AnchorBN(perpPnl),
        spotBtc:      new AnchorBN(btcAmount),
        spotEth:      new AnchorBN(ethAmount),
      });

      this.lastNavUpdate = now;
    } catch (err: any) {
      this.logger.error(`OnChainSync.pushNavUpdate failed: ${err.message}`);
    }
  }

  // ── Push risk oracle update on-chain ─────────────────────────────────────
  async pushRiskUpdate(metrics: PortfolioMetrics): Promise<void> {
    const now = Date.now();
    if (now - this.lastRiskUpdate < this.RISK_UPDATE_INTERVAL_MS) return;

    try {
      const drawdownBps = Math.min(
        Math.round(metrics.drawdown * 10_000),
        65_535 // u16 max
      );
      const deltaBps = Math.min(
        Math.round(metrics.deltaExposurePct * 10_000),
        65_535
      );
      const paused = (metrics.worstAction === "PAUSE_EXECUTION" ||
                      metrics.worstAction === "EMERGENCY_CLOSE") ? 1 : 0;

      this.logger.debug(
        `OnChainSync: pushing risk — drawdown=${drawdownBps}bps ` +
        `delta=${deltaBps}bps paused=${paused}`
      );

      await this.sendVaultInstruction("update_risk_oracle", {
        drawdownBps: drawdownBps,
        deltaBps:    deltaBps,
        executionPaused: paused,
      });

      this.lastRiskUpdate = now;
    } catch (err: any) {
      this.logger.error(`OnChainSync.pushRiskUpdate failed: ${err.message}`);
    }
  }

  // ── Aggregate perp PnL from Drift ────────────────────────────────────────
  private async getAggregatedPerpPnl(): Promise<number> {
    try {
      const user = this.driftClient.getUser();
      const pnl  = convertToNumber(
        user.getUnrealizedPNL(true),
        QUOTE_PRECISION
      );
      // Convert to USDC 6-dec integer
      return Math.round(pnl * 1_000_000);
    } catch {
      return 0;
    }
  }

  // ── Get spot holdings from Drift spot positions ───────────────────────────
  private async getSpotHoldings(): Promise<{ btcAmount: number; ethAmount: number }> {
    try {
      const user = this.driftClient.getUser();
      // Spot market indices: 0=USDC, 1=SOL, 2=BTC, 3=ETH (mainnet)
      const btcRaw = user.getTokenAmount(2);
      const ethRaw = user.getTokenAmount(3);
      return {
        btcAmount: Math.max(0, btcRaw.toNumber()),
        ethAmount: Math.max(0, ethRaw.toNumber()),
      };
    } catch {
      return { btcAmount: 0, ethAmount: 0 };
    }
  }

  // ── Generic vault instruction sender ─────────────────────────────────────
  // In production this would use the generated Anchor IDL + Program client.
  // Stubbed here as a placeholder — wire up with actual IDL after deployment.
  private async sendVaultInstruction(
    _instructionName: string,
    _args: Record<string, any>
  ): Promise<string> {
    // TODO: Replace stub with:
    //   const program = new Program(IDL, VAULT_PROGRAM_ID, provider);
    //   const txSig = await program.methods[instructionName](...args)
    //     .accounts({ vaultState: this.vaultPda, bot: this.wallet.publicKey, ... })
    //     .rpc();
    //   return txSig;
    this.logger.debug(`[STUB] sendVaultInstruction: ${_instructionName}`);
    return "stub_tx_sig";
  }
}

const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
