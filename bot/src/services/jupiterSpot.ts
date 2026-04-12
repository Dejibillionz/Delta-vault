/**
 * jupiterSpot.ts
 * Jupiter V6 spot swap — the spot leg of the delta-neutral strategy.
 *
 * Flow: USDC → asset (buy spot)  on OPEN
 *       asset → USDC (sell spot) on CLOSE
 *
 * Devnet: Jupiter API is reachable but has no real liquidity.  On network errors
 * the quote call returns a mock, and the swap call throws "MOCK_SWAP_OFFLINE" so
 * callers can fall back to a simulated position.
 *
 * Mainnet safety: any mock path throws immediately if SOLANA_NETWORK=mainnet-beta.
 */

import axios from "axios";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { ServerWallet } from "../walletIntegration";
import { Logger } from "../logger";

// ── Token registry ─────────────────────────────────────────────────────────────
const JUPITER_API = "https://quote-api.jup.ag/v6";
const SLIPPAGE_BPS = 100; // 1 %

const TOKEN_MINTS: Record<string, string> = {
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  BTC:  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", // Portal wBTC
  ETH:  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // Portal wETH
  SOL:  "So11111111111111111111111111111111111111112",    // WSOL
  JTO:  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",  // JTO
};

const TOKEN_DECIMALS: Record<string, number> = {
  USDC: 6, BTC: 8, ETH: 8, SOL: 9, JTO: 9,
};

// ── Interfaces ────────────────────────────────────────────────────────────────
export interface SwapQuote {
  inputMint:      string;
  outputMint:     string;
  inputAmount:    number; // USD
  outputAmount:   number; // USD equivalent
  slippageBps:    number;
  priceImpactPct: number;
  routePlan:      any[];
}

export interface SwapResult {
  txSig:        string;
  inputAmount:  number; // USD spent
  outputAmount: number; // USD received (for USDC output) or tokens (for asset output)
  slippagePct:  number;
}

// ── JupiterSwapper ────────────────────────────────────────────────────────────
export class JupiterSwapper {
  private connection: Connection;
  private wallet:     ServerWallet;
  private logger:     Logger;
  private isMainnet:  boolean;

  constructor(connection: Connection, wallet: ServerWallet, logger: Logger) {
    this.connection = connection;
    this.wallet     = wallet;
    this.logger     = logger;
    this.isMainnet  = process.env.SOLANA_NETWORK === "mainnet-beta";
  }

  // ── Public entry ─────────────────────────────────────────────────────────────
  /**
   * Swap `amountUSD` of `from` token to `to` token.
   *
   * @param from      token symbol, e.g. "USDC" or "SOL"
   * @param to        token symbol
   * @param amountUSD USD value to swap (converted to raw amount internally)
   * @param spotPrice optional current price of `from` token in USD (used when from ≠ USDC)
   */
  async swap(
    from: string,
    to: string,
    amountUSD: number,
    spotPrice?: number
  ): Promise<SwapResult> {
    const quote = await this.getQuote(from, to, amountUSD, spotPrice);
    return this.executeSwap(quote, from, to);
  }

  // ── Quote ─────────────────────────────────────────────────────────────────────
  private async getQuote(
    from: string,
    to: string,
    amountUSD: number,
    spotPrice?: number
  ): Promise<SwapQuote> {
    const inputMint  = TOKEN_MINTS[from];
    const outputMint = TOKEN_MINTS[to];
    if (!inputMint || !outputMint) {
      throw new Error(`Unknown token: ${from} or ${to}`);
    }

    // Convert USD amount to raw token units
    const price     = from === "USDC" ? 1 : (spotPrice ?? 1);
    const tokenAmt  = amountUSD / price;
    const decimals  = TOKEN_DECIMALS[from] ?? 6;
    const rawAmount = Math.round(tokenAmt * Math.pow(10, decimals));

    try {
      const resp = await axios.get(`${JUPITER_API}/quote`, {
        timeout: 8000,
        params: {
          inputMint,
          outputMint,
          amount: rawAmount,
          slippageBps:       SLIPPAGE_BPS,
          onlyDirectRoutes:  false,
          asLegacyTransaction: false,
        },
      });

      const data = resp.data;
      const outDecimals = TOKEN_DECIMALS[to] ?? 6;
      const outPrice    = to === "USDC" ? 1 : (spotPrice ?? 1);
      const outputAmt   = (Number(data.outAmount) / Math.pow(10, outDecimals)) * outPrice;

      return {
        inputMint,
        outputMint,
        inputAmount:    amountUSD,
        outputAmount:   outputAmt,
        slippageBps:    SLIPPAGE_BPS,
        priceImpactPct: parseFloat(data.priceImpactPct ?? "0"),
        routePlan:      data.routePlan ?? [],
      };
    } catch (err: any) {
      const isOffline = err.code === "ENOTFOUND" || err.code === "ECONNREFUSED";
      if (isOffline) {
        if (this.isMainnet) {
          throw new Error(`Jupiter quote unreachable on mainnet: ${err.message}`);
        }
        this.logger.warn(`Jupiter offline (devnet) — returning mock quote for ${from}→${to}`);
        return {
          inputMint, outputMint,
          inputAmount: amountUSD, outputAmount: amountUSD,
          slippageBps: SLIPPAGE_BPS, priceImpactPct: 0,
          routePlan: [{ swapInfo: { label: "MOCK" } }],
        };
      }
      throw err;
    }
  }

  // ── Execute swap ──────────────────────────────────────────────────────────────
  private async executeSwap(
    quote: SwapQuote,
    from: string,
    to: string
  ): Promise<SwapResult> {
    // If we got a mock quote, abort (can't send a real transaction)
    if (quote.routePlan?.[0]?.swapInfo?.label === "MOCK") {
      if (this.isMainnet) {
        throw new Error("MOCK_SWAP_OFFLINE: cannot simulate on mainnet");
      }
      throw new Error("MOCK_SWAP_OFFLINE");
    }

    const userPublicKey = this.wallet.publicKey.toBase58();

    // Build the swap transaction
    let swapTxBase64: string;
    try {
      const swapResp = await axios.post(
        `${JUPITER_API}/swap`,
        {
          quoteResponse:      quote,
          userPublicKey,
          wrapAndUnwrapSol:   true,
          computeUnitPriceMicroLamports: 100_000,
          asLegacyTransaction: false,
        },
        { timeout: 10_000 }
      );
      swapTxBase64 = swapResp.data.swapTransaction;
    } catch (err: any) {
      const isOffline = err.code === "ENOTFOUND" || err.code === "ECONNREFUSED";
      if (isOffline) {
        if (this.isMainnet) throw err;
        throw new Error("MOCK_SWAP_OFFLINE");
      }
      throw err;
    }

    // Deserialize, sign, send
    const txBytes = Buffer.from(swapTxBase64, "base64");
    const tx      = VersionedTransaction.deserialize(txBytes);
    const signed  = await this.wallet.signVersionedTransaction(tx);

    const txSig = await this.connection.sendTransaction(signed, {
      skipPreflight: false,
      maxRetries:    3,
    });

    const confirmation = await this.connection.confirmTransaction(txSig, "confirmed");
    if (confirmation.value.err) {
      throw new Error(`Swap tx failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    this.logger.info(
      `[JUPITER] ${from}→${to} $${quote.inputAmount.toFixed(2)} | ` +
      `impact ${quote.priceImpactPct.toFixed(3)}% | tx: ${txSig.slice(0, 12)}…`
    );

    return {
      txSig,
      inputAmount:  quote.inputAmount,
      outputAmount: quote.outputAmount,
      slippagePct:  SLIPPAGE_BPS / 100,
    };
  }
}
