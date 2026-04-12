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
  SYSVAR_RENT_PUBKEY,
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

export function findShareMintPda(vault: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("share_mint"), vault.toBuffer()],
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

    // anchor 0.31.x: Program(idl, provider) — programId comes from idl.address.
    // Override idl.address with VAULT_PROGRAM_ID env var if provided.
    const idlWithAddr = { ...idl, address: this.programId.toBase58() } as Idl;
    this.program     = new Program(idlWithAddr, this.provider);
    this.isAvailable = true;
    this.logger.info(
      `AnchorClient ready — program: ${this.programId.toBase58()}\n` +
      `  vault PDA:       ${this.vaultPda.toBase58()}\n` +
      `  risk oracle PDA: ${this.riskOraclePda.toBase58()}\n` +
      `  NOTE: vault must be initialized on-chain before updateNav will succeed`
    );
  }

  ready(): boolean {
    if (process.env.DEMO_MODE === "true") return false; // no SOL in demo — skip on-chain
    return this.isAvailable && this.program !== null;
  }

  // ── async startup check — call once after construction ─────────────────────
  // Verifies the program is deployed; disables on-chain sync silently if not.
  async checkDeployed(): Promise<void> {
    if (!this.isAvailable) return;
    try {
      const info = await this.provider.connection.getAccountInfo(this.programId);
      if (!info) {
        this.logger.warn(
          `AnchorClient: program ${this.programId.toBase58()} not found on-chain — on-chain NAV sync disabled.\n` +
          `  Deploy with: anchor deploy --provider.cluster devnet`
        );
        this.isAvailable = false;
      }
    } catch { /* keep isAvailable as-is on RPC error */ }
  }

  // ── Initialize vault if it doesn't exist yet ────────────────────────────────
  // Call once on startup after checkDeployed(). Safe to call repeatedly —
  // no-ops if vault PDA already exists.
  async initializeVaultIfNeeded(usdcMint: PublicKey): Promise<void> {
    if (!this.ready()) return;
    const existing = await this.getVaultState();
    if (existing) {
      this.logger.info(`AnchorClient: vault already initialized at ${this.vaultPda.toBase58()}`);
      return;
    }
    try {
      const [shareMintPda] = findShareMintPda(this.vaultPda, this.programId);
      const txSig = await this.program!.methods
        .initializeVault({
          managementFeeBps: 200,
          performanceFeeBps: 2000,
          maxDrawdownBps: 1000,
          maxDeltaBps: 500,
          minDepositUsdc: new BN(10_000_000),
          navConfidenceBufferBps: 50,
          maxNavStalenessS: new BN(120),
        })
        .accounts({
          vaultState:    this.vaultPda,
          authority:     this.provider.wallet.publicKey,
          usdcMint,
          shareMint:     shareMintPda,
          systemProgram: SystemProgram.programId,
          tokenProgram:  TOKEN_PROGRAM_ID,
          rent:          SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      this.logger.info(`initializeVault tx: ${txSig}`);
    } catch (err: any) {
      this.logger.error(`initializeVault failed: ${err.message}`);
    }
  }

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
      const logs: string[] = err?.getLogs?.() ?? err?.logs ?? [];
      const detail = logs.length ? `\n  Logs:\n  ${logs.join("\n  ")}` : "";
      this.logger.error(`updateNav failed: ${err.message}${detail}`);
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
      const logs: string[] = err?.getLogs?.() ?? err?.logs ?? [];
      const detail = logs.length ? `\n  Logs:\n  ${logs.join("\n  ")}` : "";
      this.logger.error(`updateRiskOracle failed: ${err.message}${detail}`);
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
      const logs: string[] = err?.getLogs?.() ?? err?.logs ?? [];
      const detail = logs.length ? `\n  Logs:\n  ${logs.join("\n  ")}` : "";
      this.logger.error(`updateStrategy failed: ${err.message}${detail}`);
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
      return await (this.program!.account as any).vaultState.fetch(this.vaultPda);
    } catch { return null; }
  }

  async getRiskOracleState(): Promise<any | null> {
    if (!this.ready()) return null;
    try {
      return await (this.program!.account as any).riskOracle.fetch(this.riskOraclePda);
    } catch { return null; }
  }

  getVaultPda(): PublicKey   { return this.vaultPda; }
  getProgramId(): PublicKey  { return this.programId; }

  // ── deposit ─────────────────────────────────────────────────────────────────
  /**
   * Deposit USDC into the vault. The signer (depositor) is the bot wallet.
   * @param amountUsdc  Raw USDC amount in lamports (6 decimals). E.g. $100 → 100_000_000.
   */
  async deposit(amountUsdc: number): Promise<string | null> {
    if (!this.ready()) return null;
    try {
      const txSig = await this.program!.methods
        .deposit(new BN(Math.round(amountUsdc)))
        .accounts({
          vaultState:    this.vaultPda,
          depositor:     this.provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      this.logger.trade(`deposit ${amountUsdc / 1e6} USDC tx: ${txSig}`);
      return txSig;
    } catch (err: any) {
      const logs: string[] = err?.getLogs?.() ?? err?.logs ?? [];
      const detail = logs.length ? `\n  Logs:\n  ${logs.join("\n  ")}` : "";
      this.logger.error(`deposit failed: ${err.message}${detail}`);
      return null;
    }
  }

  // ── withdraw ────────────────────────────────────────────────────────────────
  /**
   * Burn shares and withdraw USDC. The signer (depositor) is the bot wallet.
   * @param shares  Number of shares to burn (6-decimal fixed-point, same precision as USDC).
   */
  async withdraw(shares: number): Promise<string | null> {
    if (!this.ready()) return null;
    try {
      const txSig = await this.program!.methods
        .withdraw(new BN(Math.round(shares)))
        .accounts({
          vaultState:    this.vaultPda,
          depositor:     this.provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      this.logger.trade(`withdraw ${shares} shares tx: ${txSig}`);
      return txSig;
    } catch (err: any) {
      const logs: string[] = err?.getLogs?.() ?? err?.logs ?? [];
      const detail = logs.length ? `\n  Logs:\n  ${logs.join("\n  ")}` : "";
      this.logger.error(`withdraw failed: ${err.message}${detail}`);
      return null;
    }
  }

  // ── getVaultStats ───────────────────────────────────────────────────────────
  async getVaultStats(): Promise<{ nav: number; totalShares: number; navPerShare: number } | null> {
    const state = await this.getVaultState();
    if (!state) return null;
    const nav         = Number(state.nav ?? 0);
    const totalShares = Number(state.totalShares ?? 0);
    const navPerShare = totalShares > 0 ? nav / totalShares : 1_000_000; // 1 USDC default
    return { nav, totalShares, navPerShare };
  }
}
