/**
 * anchorClient.ts
 * Wires the bot to the deployed Delta Vault Anchor program.
 *
 * Replaces the stub in onChainSync.ts with real on-chain calls.
 * After running `anchor build`, copy the generated IDL from
 * target/idl/delta_vault.json into bot/src/idl/delta_vault.json.
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  AnchorProvider,
  Program,
  BN,
  Idl,
  web3,
} from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { ServerWallet } from "./walletIntegration";
import { Logger } from "./logger";

// ── IDL loading ───────────────────────────────────────────────────────────────
// After `anchor build`, copy target/idl/delta_vault.json to bot/src/idl/
// The IDL describes all instructions, accounts, and types.
function loadIdl(): Idl | null {
  const idlPath = path.join(__dirname, "idl", "delta_vault.json");
  if (!fs.existsSync(idlPath)) {
    return null; // IDL not yet generated — anchor build hasn't been run
  }
  return JSON.parse(fs.readFileSync(idlPath, "utf-8")) as Idl;
}

// ── PDA helpers ───────────────────────────────────────────────────────────────
export function findVaultPda(authority: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), authority.toBuffer()],
    programId
  );
}

export function findRiskOraclePda(vault: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("risk_oracle"), vault.toBuffer()],
    programId
  );
}

export function findStrategyPda(vault: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("strategy"), vault.toBuffer()],
    programId
  );
}

export function findFeesPda(vault: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("fees"), vault.toBuffer()],
    programId
  );
}

// ── Anchor Client ─────────────────────────────────────────────────────────────
export class AnchorVaultClient {
  private program: Program | null = null;
  private provider: AnchorProvider;
  private programId: PublicKey;
  private logger: Logger;
  private vaultPda: PublicKey;
  private riskOraclePda: PublicKey;
  private isAvailable: boolean = false;

  constructor(
    connection: Connection,
    wallet: ServerWallet,
    logger: Logger
  ) {
    this.logger    = logger;
    this.programId = new PublicKey(
      process.env.VAULT_PROGRAM_ID ?? "11111111111111111111111111111111"
    );

    // Build Anchor provider
    this.provider = new AnchorProvider(
      connection,
      wallet as any,
      { commitment: "confirmed", skipPreflight: false }
    );

    // Derive PDAs
    [this.vaultPda]      = findVaultPda(wallet.publicKey, this.programId);
    [this.riskOraclePda] = findRiskOraclePda(this.vaultPda, this.programId);

    // Load IDL
    const idl = loadIdl();
    if (!idl) {
      this.logger.warn(
        "AnchorClient: IDL not found at bot/src/idl/delta_vault.json\n" +
        "  Run: cd programs/delta_vault && anchor build\n" +
        "  Then: cp target/idl/delta_vault.json bot/src/idl/delta_vault.json\n" +
        "  On-chain sync will be disabled until IDL is available."
      );
      return;
    }

    this.program     = new Program(idl, this.programId, this.provider);
    this.isAvailable = true;
    this.logger.info(
      `AnchorClient ready — program: ${this.programId.toBase58()}\n` +
      `  vault PDA:       ${this.vaultPda.toBase58()}\n` +
      `  risk oracle PDA: ${this.riskOraclePda.toBase58()}`
    );
  }

  ready(): boolean { return this.isAvailable && this.program !== null; }

  // ── update_nav ──────────────────────────────────────────────────────────────
  async updateNav(
    btcPriceUsdc: number,
    ethPriceUsdc: number,
    perpPnl: number,
    spotBtc: number,
    spotEth: number
  ): Promise<string | null> {
    if (!this.ready()) return null;
    try {
      const txSig = await this.program!.methods
        .updateNav(
          new BN(Math.round(btcPriceUsdc)),
          new BN(Math.round(ethPriceUsdc)),
          new BN(Math.round(perpPnl)),
          new BN(Math.round(spotBtc)),
          new BN(Math.round(spotEth))
        )
        .accounts({
          vaultState: this.vaultPda,
          bot: this.provider.wallet.publicKey,
        })
        .rpc();

      this.logger.trade(`updateNav tx: ${txSig}`);
      return txSig;
    } catch (err: any) {
      this.logger.error(`updateNav failed: ${err.message}`);
      return null;
    }
  }

  // ── update_risk_oracle ──────────────────────────────────────────────────────
  async updateRiskOracle(
    drawdownBps: number,
    deltaBps: number,
    executionPaused: number
  ): Promise<string | null> {
    if (!this.ready()) return null;
    try {
      const txSig = await this.program!.methods
        .updateRiskOracle(drawdownBps, deltaBps, executionPaused)
        .accounts({
          riskOracle:  this.riskOraclePda,
          vaultState:  this.vaultPda,
          bot:         this.provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      this.logger.trade(`updateRiskOracle tx: ${txSig}`);
      return txSig;
    } catch (err: any) {
      this.logger.error(`updateRiskOracle failed: ${err.message}`);
      return null;
    }
  }

  // ── update_strategy ─────────────────────────────────────────────────────────
  async updateStrategy(mode: "DeltaNeutral" | "BasisTrade" | "ParkCapital" | "EmergencyStop"): Promise<string | null> {
    if (!this.ready()) return null;
    try {
      const [strategyPda]  = findStrategyPda(this.vaultPda, this.programId);
      const modeArg = { [mode.charAt(0).toLowerCase() + mode.slice(1)]: {} };

      const txSig = await this.program!.methods
        .updateStrategy(modeArg as any)
        .accounts({
          vaultState:    this.vaultPda,
          strategyState: strategyPda,
          riskOracle:    this.riskOraclePda,
          bot:           this.provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      this.logger.trade(`updateStrategy(${mode}) tx: ${txSig}`);
      return txSig;
    } catch (err: any) {
      this.logger.error(`updateStrategy failed: ${err.message}`);
      return null;
    }
  }

  // ── assert_risk_ok ──────────────────────────────────────────────────────────
  async assertRiskOk(): Promise<boolean> {
    if (!this.ready()) return true; // pass if program not deployed yet
    try {
      await this.program!.methods
        .assertRiskOk()
        .accounts({
          vaultState:  this.vaultPda,
          riskOracle:  this.riskOraclePda,
        })
        .rpc();
      return true;
    } catch (err: any) {
      this.logger.risk(`assertRiskOk FAILED: ${err.message}`);
      return false;
    }
  }

  // ── Read vault state ────────────────────────────────────────────────────────
  async getVaultState(): Promise<any | null> {
    if (!this.ready()) return null;
    try {
      return await this.program!.account.vaultState.fetch(this.vaultPda);
    } catch { return null; }
  }

  async getRiskOracleState(): Promise<any | null> {
    if (!this.ready()) return null;
    try {
      return await this.program!.account.riskOracle.fetch(this.riskOraclePda);
    } catch { return null; }
  }

  getVaultPda(): PublicKey   { return this.vaultPda; }
  getProgramId(): PublicKey  { return this.programId; }
}
