/**
 * Wallet Integration
 *
 * Two modes:
 *   1. SERVER (vault keypair)  — loads keypair from file/env for automated trading
 *   2. BROWSER (Phantom)       — connects Phantom for manual approvals / UI signing
 *
 * The vault bot uses SERVER mode for autonomous operation.
 * The dashboard UI uses BROWSER mode so operators can inspect & approve.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  SendOptions,
  Commitment,
} from "@solana/web3.js";
import { Wallet } from "@drift-labs/sdk";
import * as fs from "fs";
import * as bs58 from "bs58";
import { Logger } from "./logger";

// Declare window for browser compatibility (Phantom adapter)
declare const window: any;

// ─── Wallet info snapshot ────────────────────────────────────────────────────
export interface WalletInfo {
  address: string;
  usdcBalance: number;
  solBalance: number;
  connected: boolean;
  mode: "SERVER" | "PHANTOM";
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVER WALLET — used by the live bot
// Loads a keypair from disk or env var (base58-encoded private key)
// Extends Drift SDK's Wallet to ensure full compatibility
// ─────────────────────────────────────────────────────────────────────────────
export class ServerWallet extends Wallet {
  private logger: Logger;

  constructor(logger: Logger) {
    let keypair: Keypair;

    // Option A: load from keypair JSON file (array of bytes)
    const keypairPath = process.env.WALLET_KEYPAIR_PATH;
    if (keypairPath && fs.existsSync(keypairPath)) {
      const raw = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
      keypair = Keypair.fromSecretKey(Uint8Array.from(raw));
      logger.info(`ServerWallet loaded from file: ${keypairPath}`);
    }
    // Option B: load from base58 env var
    else if (process.env.WALLET_PRIVATE_KEY_BASE58) {
      const decoded = bs58.decode(process.env.WALLET_PRIVATE_KEY_BASE58);
      keypair = Keypair.fromSecretKey(decoded);
      logger.info("ServerWallet loaded from WALLET_PRIVATE_KEY_BASE58 env var");
    } else {
      throw new Error(
        "No wallet configured. Set WALLET_KEYPAIR_PATH or WALLET_PRIVATE_KEY_BASE58 in .env"
      );
    }

    // Initialize parent Wallet class with keypair
    // Cast to any to resolve version mismatch between @solana/web3.js versions
    super(keypair as any);

    this.logger = logger;
    this.logger.info(`Vault wallet address: ${this.publicKey.toBase58()}`);
  }

  getAddress(): string {
    return this.publicKey.toBase58();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHANTOM WALLET ADAPTER — used by the browser dashboard UI
// Connects to the Phantom browser extension via window.solana
// ─────────────────────────────────────────────────────────────────────────────

// NOTE: This section runs in the browser. Include in your frontend bundle.
// It is written as plain TypeScript that works in both Node (type-checks only)
// and browser environments.

export interface PhantomProvider {
  publicKey: PublicKey | null;
  isConnected: boolean;
  connect(): Promise<{ publicKey: PublicKey }>;
  disconnect(): Promise<void>;
  signTransaction(tx: Transaction | VersionedTransaction): Promise<Transaction | VersionedTransaction>;
  signAllTransactions(txs: (Transaction | VersionedTransaction)[]): Promise<(Transaction | VersionedTransaction)[]>;
  signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }>;
  on(event: string, cb: (...args: any[]) => void): void;
  off(event: string, cb: (...args: any[]) => void): void;
}

export class PhantomWalletAdapter {
  private provider: PhantomProvider | null = null;
  publicKey: PublicKey | null = null;
  isConnected: boolean = false;

  // ── Detect Phantom in browser ────────────────────────────────────────────
  static isAvailable(): boolean {
    if (typeof window === "undefined") return false;
    return !!(window as any).solana?.isPhantom;
  }

  static getProvider(): PhantomProvider | null {
    if (!PhantomWalletAdapter.isAvailable()) return null;
    return (window as any).solana as PhantomProvider;
  }

  // ── Connect ──────────────────────────────────────────────────────────────
  async connect(): Promise<string> {
    if (!PhantomWalletAdapter.isAvailable()) {
      throw new Error("Phantom wallet not found. Install it at https://phantom.app");
    }

    this.provider = PhantomWalletAdapter.getProvider()!;

    const resp = await this.provider.connect();
    this.publicKey = resp.publicKey;
    this.isConnected = true;

    // Listen for disconnect
    this.provider.on("disconnect", () => {
      this.isConnected = false;
      this.publicKey = null;
      console.log("Phantom disconnected");
    });

    // Listen for account change
    this.provider.on("accountChanged", (newKey: PublicKey) => {
      this.publicKey = newKey;
      console.log(`Phantom account changed: ${newKey.toBase58()}`);
    });

    console.log(`Phantom connected: ${this.publicKey!.toBase58()}`);
    return this.publicKey!.toBase58();
  }

  async disconnect(): Promise<void> {
    await this.provider?.disconnect();
    this.isConnected = false;
    this.publicKey = null;
  }

  async signTransaction(tx: Transaction | VersionedTransaction): Promise<Transaction | VersionedTransaction> {
    if (!this.provider || !this.isConnected) throw new Error("Phantom not connected");
    return this.provider.signTransaction(tx);
  }

  async signMessage(message: string): Promise<string> {
    if (!this.provider || !this.isConnected) throw new Error("Phantom not connected");
    const enc = new TextEncoder();
    const { signature } = await this.provider.signMessage(enc.encode(message));
    return Buffer.from(signature).toString("hex");
  }

  getAddress(): string {
    return this.publicKey?.toBase58() ?? "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WALLET MANAGER — resolves balances and status
// ─────────────────────────────────────────────────────────────────────────────
export class WalletManager {
  private connection: Connection;
  private logger: Logger;

  // USDC mint on Solana mainnet
  private static USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

  constructor(connection: Connection, logger: Logger) {
    this.connection = connection;
    this.logger = logger;
  }

  async getWalletInfo(address: string, mode: "SERVER" | "PHANTOM"): Promise<WalletInfo> {
    try {
      const pubkey = new PublicKey(address);

      // SOL balance
      const lamports = await this.connection.getBalance(pubkey, "confirmed");
      const solBalance = lamports / 1e9;

      // USDC balance via getTokenAccountsByOwner
      const tokenAccounts = await this.connection.getTokenAccountsByOwner(pubkey, {
        mint: WalletManager.USDC_MINT,
      });

      let usdcBalance = 0;
      if (tokenAccounts.value.length > 0) {
        const accountInfo = tokenAccounts.value[0].account;
        // Parse token account data (amount at offset 64, 8 bytes LE)
        const data = accountInfo.data;
        const amount = data.readBigUInt64LE(64);
        usdcBalance = Number(amount) / 1e6; // USDC has 6 decimals
      }

      this.logger.info(
        `Wallet ${address.slice(0, 8)}... | SOL: ${solBalance.toFixed(4)} | USDC: $${usdcBalance.toFixed(2)}`
      );

      return { address, usdcBalance, solBalance, connected: true, mode };
    } catch (err: any) {
      this.logger.error(`getWalletInfo failed: ${err.message}`);
      return { address, usdcBalance: 0, solBalance: 0, connected: false, mode };
    }
  }

  // Ensure wallet has enough SOL for transaction fees
  async checkSolForFees(address: string, minSol: number = 0.05): Promise<boolean> {
    const pubkey = new PublicKey(address);
    const lamports = await this.connection.getBalance(pubkey);
    const sol = lamports / 1e9;
    if (sol < minSol) {
      this.logger.warn(`Wallet has only ${sol.toFixed(4)} SOL — need ≥${minSol} for fees`);
      return false;
    }
    return true;
  }
}
