/**
 * Spot Hedge — Jupiter Aggregator (Solana)
 * Opens spot LONG positions to hedge perp SHORTs for delta-neutral trades.
 * Uses Jupiter v6 API for best-route swaps.
 */

import axios from "axios";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import * as fs from "fs";
import { Logger } from "./logger";

// ─── Token mint addresses (Solana mainnet) ────────────────────────────────────
const MINTS = {
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  BTC:  "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E",  // Wrapped BTC (wBTC)
  ETH:  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",  // Wrapped ETH (wETH)
} as const;

const DECIMALS = { USDC: 6, BTC: 8, ETH: 8 } as const;

export type SpotAsset = "BTC" | "ETH";

export interface SwapResult {
  success: boolean;
  txSig?: string;
  inputAmount: number;
  outputAmount: number;
  priceImpactPct: number;
  error?: string;
}

// ─── Spot Hedge Engine ────────────────────────────────────────────────────────
export class SpotHedgeEngine {
  private connection: Connection;
  private keypair: Keypair;
  private logger: Logger;
  private jupiterApiUrl = "https://quote-api.jup.ag/v6";

  constructor(logger: Logger) {
    this.logger = logger;

    const rpcUrl = process.env.HELIUS_RPC_URL;
    if (!rpcUrl) throw new Error("HELIUS_RPC_URL not set");
    this.connection = new Connection(rpcUrl, "confirmed");

    const keypairPath = process.env.WALLET_KEYPAIR_PATH;
    if (!keypairPath) throw new Error("WALLET_KEYPAIR_PATH not set");
    const raw = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
    this.keypair = Keypair.fromSecretKey(Uint8Array.from(raw));
  }

  // ─── Buy spot (USDC → asset) ──────────────────────────────────────────────
  async buySpot(asset: SpotAsset, usdcAmount: number): Promise<SwapResult> {
    this.logger.trade(`SpotHedge: Buying ${asset} spot for $${usdcAmount.toFixed(2)} USDC`);
    return this.swap("USDC", asset, usdcAmount);
  }

  // ─── Sell spot (asset → USDC) ─────────────────────────────────────────────
  async sellSpot(asset: SpotAsset, usdcAmount: number): Promise<SwapResult> {
    this.logger.trade(`SpotHedge: Selling ${asset} spot for ~$${usdcAmount.toFixed(2)} USDC`);
    return this.swap(asset, "USDC", usdcAmount);
  }

  // ─── Core swap via Jupiter ────────────────────────────────────────────────
  private async swap(
    fromAsset: keyof typeof MINTS,
    toAsset: keyof typeof MINTS,
    amount: number
  ): Promise<SwapResult> {
    const inputMint = MINTS[fromAsset];
    const outputMint = MINTS[toAsset];
    const inputDecimals = DECIMALS[fromAsset];
    const amountRaw = Math.floor(amount * Math.pow(10, inputDecimals));

    try {
      // Step 1: Get best route quote
      const quoteRes = await axios.get(`${this.jupiterApiUrl}/quote`, {
        params: {
          inputMint,
          outputMint,
          amount: amountRaw,
          slippageBps: 50,           // 0.5% max slippage
          onlyDirectRoutes: false,
          asLegacyTransaction: false,
        },
        timeout: 10000,
      });

      const quote = quoteRes.data;
      const priceImpactPct = parseFloat(quote.priceImpactPct ?? "0");

      if (priceImpactPct > 1.0) {
        const msg = `Price impact too high: ${priceImpactPct.toFixed(2)}% — aborting swap`;
        this.logger.warn(msg);
        return { success: false, inputAmount: amount, outputAmount: 0, priceImpactPct, error: msg };
      }

      // Step 2: Get serialized swap transaction
      const swapRes = await axios.post(`${this.jupiterApiUrl}/swap`, {
        quoteResponse: quote,
        userPublicKey: this.keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      }, { timeout: 10000 });

      const { swapTransaction } = swapRes.data;

      // Step 3: Deserialize, sign, and send
      const txBuf = Buffer.from(swapTransaction, "base64");
      const tx = VersionedTransaction.deserialize(txBuf);
      tx.sign([this.keypair]);

      const txSig = await this.connection.sendTransaction(tx, {
        skipPreflight: false,
        maxRetries: 3,
      });

      // Step 4: Confirm
      const confirmation = await this.connection.confirmTransaction(txSig, "confirmed");
      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }

      const outputDecimals = DECIMALS[toAsset];
      const outputAmount = parseInt(quote.outAmount) / Math.pow(10, outputDecimals);

      this.logger.trade(`Swap confirmed: ${fromAsset}→${toAsset} tx: ${txSig}`);
      return { success: true, txSig, inputAmount: amount, outputAmount, priceImpactPct };

    } catch (err: any) {
      const msg = err?.response?.data?.error ?? err.message ?? "Unknown error";
      this.logger.error(`Swap failed (${fromAsset}→${toAsset}): ${msg}`);
      return { success: false, inputAmount: amount, outputAmount: 0, priceImpactPct: 0, error: msg };
    }
  }

  // ─── Get a quote without executing ───────────────────────────────────────
  async getQuote(from: keyof typeof MINTS, to: keyof typeof MINTS, amount: number) {
    const inputMint = MINTS[from];
    const outputMint = MINTS[to];
    const amountRaw = Math.floor(amount * Math.pow(10, DECIMALS[from]));

    const res = await axios.get(`${this.jupiterApiUrl}/quote`, {
      params: { inputMint, outputMint, amount: amountRaw, slippageBps: 50 },
    });
    return res.data;
  }
}
