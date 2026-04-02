/**
 * Jupiter Swap Integration
 * Provides spot swap functionality via Jupiter aggregator
 * Used for delta-neutral spot leg (USDC ↔ BTC/ETH)
 */

import axios from "axios";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { ServerWallet } from "./walletIntegration";
import { Logger } from "./logger";

// Token mints on Solana mainnet
const TOKEN_MINTS = {
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  BTC:  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",  // Wrapped BTC (Portal)
  ETH:  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",  // Wrapped ETH (Portal)
  SOL:  "So11111111111111111111111111111111111111112",     // Wrapped SOL (native)
  JTO:  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",  // JTO governance token
};

// Token decimals on Solana
const TOKEN_DECIMALS: Record<string, number> = {
  USDC: 6, BTC: 8, ETH: 8, SOL: 9, JTO: 9,
};

// Mock prices for devnet/offline testing
const MOCK_PRICES: Record<string, number> = {
  USDC: 1, BTC: 68500, ETH: 2150, SOL: 170, JTO: 4.0,
};

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  outputAmount: number;
  slippageBps: number;
  priceImpactPct: number;
  routePlan: any[];
}

export interface SwapResult {
  txSig: string;
  inputAmount: number;
  outputAmount: number;
  slippagePct: number;
}

export class JupiterSwapper {
  private connection: Connection;
  private wallet: ServerWallet;
  private logger: Logger;
  private isMainnet: boolean;

  private readonly JUPITER_API = "https://quote-api.jup.ag/v6";
  private readonly SLIPPAGE_BPS = 100; // 1% slippage tolerance

  constructor(connection: Connection, wallet: ServerWallet, logger: Logger) {
    this.connection = connection;
    this.wallet = wallet;
    this.logger = logger;
    this.isMainnet = process.env.SOLANA_NETWORK === "mainnet-beta";
  }

  /**
   * Swap tokens via Jupiter
   * @param from Token to sell ("USDC", "BTC", "ETH", "SOL", or "JTO")
   * @param to Token to buy ("USDC", "BTC", "ETH", "SOL", or "JTO")
   * @param amount Amount in USD (always converted to from token)
   */
  async swap(
    from: keyof typeof TOKEN_MINTS,
    to: keyof typeof TOKEN_MINTS,
    amountUSD: number
  ): Promise<SwapResult> {
    try {
      // Step 1: Get quote
      const quote = await this.getQuote(from, to, amountUSD);
      this.logger.info(
        `Jupiter Quote: ${from}→${to} | in=${quote.inputAmount} | out=${quote.outputAmount} | impact=${quote.priceImpactPct.toFixed(3)}%`
      );

      // Check if this is a mock (devnet offline) — never allow on mainnet
      if (quote.routePlan[0]?.swapInfo?.label === "MOCK") {
        if (this.isMainnet) {
          throw new Error(`Jupiter API returned mock quote on mainnet — aborting ${from}→${to} swap`);
        }
        // Devnet only: simulate successful swap with fake tx sig
        const fakeTxSig = `MockTx_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        this.logger.trade(
          `Jupiter Swap (MOCK) ${from}→${to} | amount=$${amountUSD.toFixed(2)} | tx=${fakeTxSig}`
        );

        return {
          txSig: fakeTxSig,
          inputAmount: quote.inputAmount,
          outputAmount: quote.outputAmount,
          slippagePct: (quote.slippageBps / 100),
        };
      }

      // Step 2: Build swap transaction
      const swapTx = await this.buildSwapTx(quote);

      // Step 3: Sign transaction (cast to any to handle version mismatch)
      const signedTx = await this.wallet.signVersionedTransaction(swapTx as any);

      // Step 4: Submit transaction (cast to any)
      const txSig = await this.connection.sendTransaction(signedTx as any, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      // Step 5: Wait for confirmation
      await this.connection.confirmTransaction(txSig, "confirmed");

      this.logger.trade(
        `Jupiter Swap ${from}→${to} | amount=$${amountUSD.toFixed(2)} | tx=${txSig}`
      );

      return {
        txSig,
        inputAmount: quote.inputAmount,
        outputAmount: quote.outputAmount,
        slippagePct: (quote.slippageBps / 100),
      };
    } catch (err: any) {
      if (err.message === "MOCK_SWAP_OFFLINE") {
        if (this.isMainnet) {
          throw new Error(`Jupiter swap API unreachable on mainnet — aborting ${from}→${to}`);
        }
        // Devnet offline mode: simulate successful swap with price conversion
        const fakeTxSig = `MockTx_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        this.logger.info(`Jupiter offline mode: simulating ${from}→${to} swap with tx ${fakeTxSig}`);

        const fromPrice = MOCK_PRICES[from] ?? 1;
        const toPrice = MOCK_PRICES[to] ?? 1;
        const fromDecimals = TOKEN_DECIMALS[from] ?? 8;
        const toDecimals = TOKEN_DECIMALS[to] ?? 8;

        // amountUSD is in USD — convert to input token amount
        const inputTokens = amountUSD / fromPrice;  // e.g. $100 / $2150 = 0.0465 ETH
        const inputAmount = Math.floor(inputTokens * Math.pow(10, fromDecimals));
        // amountUSD is always in USD — don't multiply by fromPrice again
        const usdValue = amountUSD;
        const outputTokens = usdValue / toPrice;
        const outputAmount = Math.floor(outputTokens * 0.99 * Math.pow(10, toDecimals));

        return {
          txSig: fakeTxSig,
          inputAmount,
          outputAmount,
          slippagePct: 1.0,
        };
      }

      this.logger.error(
        `Jupiter swap ${from}→${to} failed: ${err.message}`
      );
      throw err;
    }
  }

  /**
   * Get swap quote from Jupiter (or mock for devnet)
   */
  private async getQuote(
    from: keyof typeof TOKEN_MINTS,
    to: keyof typeof TOKEN_MINTS,
    amountUSD: number
  ): Promise<SwapQuote> {
    const inputMint = TOKEN_MINTS[from];
    const outputMint = TOKEN_MINTS[to];

    // Convert USD amount to token amount using per-token decimals
    const decimals = TOKEN_DECIMALS[from] ?? 8;
    const fromPrice = MOCK_PRICES[from] ?? 1;
    const inputTokens = amountUSD / fromPrice;
    const inputAmount = Math.floor(inputTokens * Math.pow(10, decimals));

    const params = {
      inputMint,
      outputMint,
      amount: inputAmount.toString(),
      slippageBps: this.SLIPPAGE_BPS,
      onlyDirectRoutes: false,
      asLegacyTransaction: false,
    };

    try {
      const response = await axios.get(`${this.JUPITER_API}/quote`, {
        params,
        timeout: 10000,
      });

      const data = response.data;

      return {
        inputMint,
        outputMint,
        inputAmount: parseInt(data.inAmount),
        outputAmount: parseInt(data.outAmount),
        slippageBps: data.slippageBps,
        priceImpactPct: parseFloat(data.priceImpactPct) || 0,
        routePlan: data.routePlan,
      };
    } catch (err: any) {
      // Fallback: Mock quote for devnet/offline testing ONLY
      if ((err.code === "ENOTFOUND" || err.message.includes("Network")) && !this.isMainnet) {
        this.logger.info(`Jupiter API unavailable, using mock quote for ${from}→${to}`);

        // Mock: convert between tokens using approximate prices, then apply 1% slippage
        const toPrice = MOCK_PRICES[to] ?? 1;
        const toDecimals = TOKEN_DECIMALS[to] ?? 8;

        // amountUSD is already in USD — convert directly to output tokens
        const outputTokens = amountUSD / toPrice;
        const mockOutputAmount = Math.floor(outputTokens * 0.99 * Math.pow(10, toDecimals)); // 1% slippage

        return {
          inputMint,
          outputMint,
          inputAmount,
          outputAmount: mockOutputAmount,
          slippageBps: this.SLIPPAGE_BPS,
          priceImpactPct: 1.0,
          routePlan: [{ swapInfo: { label: "MOCK" } }],
        };
      }
      this.logger.error(`Jupiter quote failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Build swap transaction from quote
   */
  private async buildSwapTx(quote: SwapQuote): Promise<VersionedTransaction> {
    const userPublicKey = this.wallet.publicKey;

    const swapParams = {
      quoteResponse: {
        inAmount: quote.inputAmount.toString(),
        outAmount: quote.outputAmount.toString(),
        outAmountMin: Math.floor(
          quote.outputAmount * (1 - this.SLIPPAGE_BPS / 10000)
        ).toString(),
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        otherAmountThreshold: Math.floor(
          quote.outputAmount * (1 - this.SLIPPAGE_BPS / 10000)
        ).toString(),
        swapMode: "ExactIn",
        slippageBps: this.SLIPPAGE_BPS,
        priceImpactPct: quote.priceImpactPct.toString(),
        routePlan: quote.routePlan,
      },
      userPublicKey: userPublicKey.toBase58(),
      wrapUnwrapSOL: true,
      prioritizationFeeLamports: 1000,
    };

    try {
      const response = await axios.post(
        `${this.JUPITER_API}/swap`,
        swapParams,
        { timeout: 10000 }
      );

      const swapTxBase64 = response.data.swapTransaction;
      const swapTxBuf = Buffer.from(swapTxBase64, "base64");
      const tx = VersionedTransaction.deserialize(swapTxBuf);

      return tx;
    } catch (err: any) {
      // Fallback: Mock transaction for devnet/offline testing ONLY
      if ((err.code === "ENOTFOUND" || err.message.includes("Network")) && !this.isMainnet) {
        this.logger.info(`Jupiter swap API unavailable, creating mock transaction`);

        // For devnet testing, we'll skip the actual transaction building
        // and instead return a placeholder that will be handled specially
        // This allows the bot logic to proceed without network access
        throw new Error("MOCK_SWAP_OFFLINE");
      }
      this.logger.error(`Jupiter swap transaction build failed: ${err.message}`);
      throw err;
    }
  }
}
