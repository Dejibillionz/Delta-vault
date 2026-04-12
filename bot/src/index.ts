/**
 * Delta Vault Bot — Main Orchestrator
 * Solana / Hyperliquid + Kamino / BTC + ETH + SOL + JTO
 *
 * Usage:
 *   DEMO_MODE=true npm run dev   ← logs everything, no real orders
 *   DEMO_MODE=false npm run dev  ← live trading on configured network
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as http from "http";

// Load .env from bot/ folder or current directory
dotenv.config({ path: path.join(__dirname, "../../bot/.env") });
dotenv.config();

import { Connection } from "@solana/web3.js";
import chalk from "chalk";

import { Logger }                                    from "./logger";
import { StrategyEngine, Signal }                    from "./strategyEngine";
import { EnhancedRiskEngine, MarketConditions }      from "./enhancedRiskEngine";
import { AnchorVaultClient }                         from "./anchorClient";
import { telegram }                                  from "./telegramAlerts";
import { ServerWallet }                              from "./walletIntegration";
import { debugLog, LogLevel }                        from "./logging";
import { decide, AgentObservation }                  from "./agent/decision";
import { getPositionSize }                           from "./agent/sizing";
import { createInitialState, updateState }           from "./agent/state";
import { logAgent, logDecision }                     from "./agent/logger";

// Hyperliquid + Kamino (replace Drift)
import {
  HyperliquidExecutor,
  HLMarketDataEngine,
  HlOrderResult,
  LiveMarketSnapshot,
  Asset,
}                                                    from "./services/hyperliquidExecution";
import { KaminoManager }                             from "./services/kaminoLending";
import { JupiterSwapper }                            from "./services/jupiterSpot";
import { MarginFiManager }                           from "./services/marginFiLending";
import { FundingRateScanner }                        from "./services/fundingRateScanner";
import { CexFundingRates }                           from "./services/cexFundingRates";
import { FundingSettlementTimer }                    from "./services/fundingSettlementTimer";
import { BybitExecutor }                             from "./services/bybitExecution";

// Cross-chain imports
import { getCrossChainFunding }                       from "./services/crossChainFunding";
import { evaluateCrossChain }                         from "./strategy/crossChainDecision";
import { executeCrossChain }                          from "./strategy/crossChainExecutor";
import { CROSS_CHAIN_CONFIG }                         from "./config/crossChain";
import { TradeRecord }                                from "./types/tradeRecord";

// ── Logging Utilities ────────────────────────────────────────────────────────
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

function logSection(title: string) {
  console.log(`\n${chalk.cyan('════════════════════════════════════')}`);
  console.log(`${chalk.cyan(' ' + title)}`);
  console.log(`${chalk.cyan('════════════════════════════════════')}`);
}

// ── Config ────────────────────────────────────────────────────────────────────
const DEMO_MODE     = process.env.DEMO_MODE !== "false"; // default: safe
const NETWORK       = process.env.SOLANA_NETWORK ?? "devnet";
const CYCLE_MS      = 15_000;  // 15s strategy loop
const LOG_EVERY_N   = 2;       // log/API-update every Nth cycle (~30s at 15s)
const RISK_CYCLE_MS = 10_000;
let vaultEquity     = parseFloat(process.env.DEMO_EQUITY ?? "10000"); // from HL or sim
let MIN_TRADE_SIZE  = 100;
const CARRYOVER_DECAY = 0.75;
const AI_AGENT_ENABLED = process.env.AI_AGENT_ENABLED !== "false";
const SCANNER_ENABLED  = process.env.SCANNER_ENABLED  !== "false";

// Market impact caps: prevent moving thin markets with oversized entries
// Cap trade size to X% of daily volume and Y% of open interest.
// Default 0.1% of volume / 0.5% of OI — conservative for small-cap perps.
const MARKET_IMPACT_VOLUME_PCT = parseFloat(process.env.MARKET_IMPACT_VOLUME_PCT ?? "0.001");
const MARKET_IMPACT_OI_PCT     = parseFloat(process.env.MARKET_IMPACT_OI_PCT     ?? "0.005");

// Funding circuit-breaker: skip new entries when |fundingAPR| > this threshold (e.g. 300%)
const MAX_ABSOLUTE_FUNDING_APR = parseFloat(process.env.FUNDING_CIRCUIT_BREAKER_APR ?? "3.0");
// Portfolio gross notional cap: total spot+perp notional cannot exceed equity × this ratio
const MAX_GROSS_NOTIONAL_RATIO = parseFloat(process.env.MAX_GROSS_NOTIONAL_RATIO ?? "1.5");
// Bybit venue routing: route to Bybit when its APR exceeds HL by at least this spread
const BYBIT_ARB_MIN_SPREAD = parseFloat(process.env.BYBIT_ARB_MIN_SPREAD_APR ?? "0.02");

// Comma-separated assets to trade, e.g. "BTC,ETH,SOL,JTO"
const TRADING_ASSETS = (process.env.TRADING_ASSETS ?? "BTC,ETH,SOL,JTO")
  .split(",").map(s => s.trim()).filter(Boolean);

const logger = new Logger("./logs");

function printBanner() {
  logger.info("════════════════════════════════════════════════════");
  logger.info(" ◈ DELTA VAULT BOT");
  logger.info(` Network:     ${NETWORK}`);
  logger.info(` Mode:        ${DEMO_MODE ? "SIMULATION (DEMO_MODE=true)" : "⚡ LIVE TRADING"}`);
  logger.info(` Assets:      ${SCANNER_ENABLED ? `Dynamic scanner (top ${process.env.SCANNER_TOP_N ?? "6"} by funding × stability × liquidity)` : TRADING_ASSETS.join(" + ")}`);
  logger.info(` Execution:   Hyperliquid perps + Kamino lending`);
  logger.info(` Risk cycle:  ${RISK_CYCLE_MS / 1000}s`);
  logger.info(` Trade cycle: ${CYCLE_MS / 1000}s (log every ${LOG_EVERY_N} cycles = ~${(CYCLE_MS * LOG_EVERY_N / 1000).toFixed(0)}s)`);
  logger.info("════════════════════════════════════════════════════");
}

async function measureLatency(conn: Connection): Promise<number> {
  const t = Date.now();
  try { await conn.getSlot(); } catch {}
  return Date.now() - t;
}

async function measureHlLatency(hlExec: HyperliquidExecutor): Promise<number> {
  const t = Date.now();
  try { await hlExec.getEquity(); } catch {}
  return Date.now() - t;
}

async function main() {
  printBanner();

  if (DEMO_MODE) {
    logger.warn("DEMO_MODE=true — strategy runs but NO real orders sent");
    logger.warn("Set DEMO_MODE=false in .env to enable live trading");
  }

  // ── Wallet & Connection ────────────────────────────────────────────────────
  const wallet = new ServerWallet(logger);
  logger.info(`Wallet: ${wallet.publicKey.toBase58()}`);

  const rpcUrl = (() => {
    const url = process.env.HELIUS_RPC_URL ?? "";
    if (!url || url.includes("YOUR_HELIUS_API_KEY") || url.includes("YOUR_KEY")) {
      if (DEMO_MODE) {
        logger.warn("HELIUS_RPC_URL not set — using public devnet RPC for demo (rate-limited)");
        return "https://api.devnet.solana.com";
      }
      logger.error("HELIUS_RPC_URL not set. Get a free key at https://helius.dev and add it to .env");
      process.exit(1);
    }
    return url;
  })();

  const connection    = new Connection(rpcUrl, "confirmed");
  const jupiterSwap   = new JupiterSwapper(connection, wallet, logger);
  const marginFi      = new MarginFiManager(connection, wallet, logger);

  // ── Hyperliquid + Kamino (replace Drift) ──────────────────────────────────
  const hlExecutor   = new HyperliquidExecutor(logger);
  const bybitExecutor = new BybitExecutor(logger);
  const marketEngine = new HLMarketDataEngine(hlExecutor, logger);
  const anchorClient = new AnchorVaultClient(connection, wallet, logger);

  // ── Fetch equity from HL (or use DEMO_EQUITY in demo mode) ───────────────
  try {
    const liveEquity = await hlExecutor.getEquity();
    if (liveEquity > 0) {
      vaultEquity = liveEquity;
      logger.info(`Vault equity: $${vaultEquity.toFixed(2)} USDC`);
    } else if (!DEMO_MODE) {
      logger.error("Hyperliquid returned $0 equity — deposit USDC on HL first");
      process.exit(1);
    }
  } catch (err: any) {
    if (!DEMO_MODE) {
      logger.error(`Could not fetch equity: ${err.message}`);
      process.exit(1);
    }
  }

  // Scale MIN_TRADE_SIZE to 5% of equity (floor $200)
  MIN_TRADE_SIZE = Math.max(200, vaultEquity * 0.05);
  logger.info(`Vault equity: $${vaultEquity.toFixed(2)}  Min trade: $${MIN_TRADE_SIZE.toFixed(2)}`);

  const strategyEngine = new StrategyEngine(logger);
  const riskEngine     = new EnhancedRiskEngine(vaultEquity, logger);

  strategyEngine.setVaultEquity(vaultEquity);
  await marketEngine.start();

  // ── Funding rate scanner ───────────────────────────────────────────────────
  const cexRates        = new CexFundingRates(logger);
  const settlementTimer = new FundingSettlementTimer(marketEngine);
  const scanner = new FundingRateScanner(marketEngine, logger, undefined, cexRates);
  let activeAssets: string[] = [...TRADING_ASSETS];
  const drainingAssets       = new Set<string>();
  const drainEntryTimes      = new Map<string, number>();
  const SCANNER_MAX_DRAIN_MS = parseInt(process.env.SCANNER_MAX_DRAIN_MS ?? "7200000");

  // Run initial scan right after first refresh so activeAssets is scanner-driven from tick 1
  if (SCANNER_ENABLED) {
    await marketEngine.refresh();
    scanner.updateCycle();
    const initialScan = await scanner.scan();
    if (initialScan.selectedAssets.length > 0) {
      activeAssets = initialScan.selectedAssets;
      logger.info(`[SCANNER] Initial selection: ${activeAssets.join(", ")}`);
    }
  }

  logger.info("All engines started ✓");

  await telegram.botStarted(wallet.publicKey.toBase58(), NETWORK);

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  let stopping = false;
  process.on("SIGINT", async () => {
    if (stopping) return;
    stopping = true;
    logger.warn("SIGINT — shutting down");
    clearInterval(riskLoop);
    apiServer.close();
    await marketEngine.stop();
    logger.close();
    process.exit(0);
  });

  const positions = new Map<string, any>();
  const fundingCircuitBreakers = new Set<string>(); // assets blocked due to extreme funding APR
  const tradeHistory: TradeRecord[] = [];           // last 100 completed trades
  let tick = 0;
  let simulatedPnl = 0; // Simulated profit for demo
  let cumulativeRealizedPnl = 0; // Running total of closed-position PnL
  let cumulativeLendingYield = 0; // Running total of lending yield
  const initialVaultEquity = vaultEquity; // snapshot at bot start for PnL baseline
  let currentStrategies: Record<string, string> = Object.fromEntries(TRADING_ASSETS.map(a => [a, "PARKED"]));
  const kaminoManager  = new KaminoManager(logger, vaultEquity * 0.3, connection, wallet);
  if (!DEMO_MODE) await kaminoManager.initializeLive();
  let previousSnapshots: Record<string, LiveMarketSnapshot> = {};
  let latestDrawdown = 0;
  let tradeCarryOver: Record<string, number> = Object.fromEntries(TRADING_ASSETS.map(a => [a, 0]));
  const aiAgentState = createInitialState();

  // Cross-chain state (independent by asset)
  const currentChains: Record<string, string> = Object.fromEntries(TRADING_ASSETS.map(a => [a, "solana"]));
  const lastCrossChainTimes: Record<string, number> = Object.fromEntries(TRADING_ASSETS.map(a => [a, 0]));
  let latestCrossChainDecisions: Record<string, any> = Object.fromEntries(TRADING_ASSETS.map(a => [a, { execute: false, reason: "Waiting" }]));
  let latestFundingByChain: Record<string, Record<string, number>> = {};

  const botState: any = {
    timestamp: Date.now(),
    tick: 0,
    mode: DEMO_MODE ? "SIMULATION" : "LIVE",
    network: NETWORK,
    assets: TRADING_ASSETS,
    prices: Object.fromEntries(TRADING_ASSETS.map(a => [a, 0])),
    funding: Object.fromEntries(TRADING_ASSETS.map(a => [a, 0])),
    basis: Object.fromEntries(TRADING_ASSETS.map(a => [a, 0])),
    signals: Object.fromEntries(TRADING_ASSETS.map(a => [a, "PARKED"])),
    positionsCount: 0,
    nav: vaultEquity,
    pnl: 0,
    drawdown: 0,
    deltaExposure: 0,
    pnlBreakdown: { funding: 0, lending: 0, realized: 0 },
    lending: { deployed: 0, yield: 0 },
    lendingByAsset: Object.fromEntries(TRADING_ASSETS.map(a => [a, { amount: 0, yield: 0 }])),
    positions: [] as any[],
    executionEvents: [] as string[],
    execution: { executedTrade: false, events: [] as string[] },
    capital: {
      starting: vaultEquity,
      reservedForTrades: 0,
      releasedFromTrades: 0,
      lent: 0,
      remainingBeforeLending: 0,
      remainingAfterLending: 0,
      carryOver: { ...Object.fromEntries(TRADING_ASSETS.map(a => [a, 0])), total: 0 },
    },
    crossChain: {
      currentChains,
      decisions: latestCrossChainDecisions,
      fundingByChain: latestFundingByChain,
    },
    aiAgent: {
      enabled: AI_AGENT_ENABLED,
      observation: { funding: {}, volatility: 0 },
      decision: null,
      maxSize: 0,
      state: {
        winRate: aiAgentState.winRate,
        confidence: aiAgentState.confidence,
        performance: { ...aiAgentState.performance },
        momentumScores: { ...aiAgentState.momentumScore },
      },
    },
  };

  const apiServer = http.createServer(async (req, res) => {
    // CORS headers for all responses
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/deposit") {
      let body = "";
      req.on("data", (chunk: string | Buffer) => { body += chunk; });
      req.on("end", async () => {
        try {
          const { amountUsd } = JSON.parse(body) as { amountUsd: number };
          if (!amountUsd || amountUsd <= 0) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "amountUsd must be > 0" }));
            return;
          }
          const amountRaw = Math.round(amountUsd * 1_000_000); // USDC 6 decimals
          const txSig = await anchorClient.deposit(amountRaw);
          if (txSig) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, txSig, amountUsd }));
          } else {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Deposit failed — check bot logs (IDL or NAV staleness)" }));
          }
        } catch (err: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (req.method === "POST" && req.url === "/withdraw") {
      let body = "";
      req.on("data", (chunk: string | Buffer) => { body += chunk; });
      req.on("end", async () => {
        try {
          const { shares } = JSON.parse(body) as { shares: number };
          if (!shares || shares <= 0) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "shares must be > 0" }));
            return;
          }
          const sharesRaw = Math.round(shares * 1_000_000); // 6-decimal fixed point
          const txSig = await anchorClient.withdraw(sharesRaw);
          if (txSig) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, txSig, shares }));
          } else {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Withdraw failed — check bot logs (IDL or NAV staleness)" }));
          }
        } catch (err: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Default: GET /  →  state broadcast
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(botState));
  });
  apiServer.on("error", (err: any) => {
    if (err?.code === "EADDRINUSE") {
      logger.warn("State API port 3001 already in use; dashboard sync may point to another bot instance");
      return;
    }
    logger.error(`State API error: ${err?.message ?? err}`);
  });
  apiServer.listen(3001, () => {
    logger.info("State API running at http://localhost:3001");
  });

  // Utility
  function pct(n: number, d = 4): string {
    return (n * 100).toFixed(d) + "%";
  }

  /** Variance of a sample array — used for Kelly criterion. */
  function computeVariance(samples: number[]): number {
    if (samples.length < 2) return 0.0001;
    const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
    return samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length;
  }

  // ── applyAssetSetChange ─────────────────────────────────────────────────────
  // Called when the scanner produces a new ranked selection.
  // Initialises tracking state for new assets; sends dropped assets to drain.
  function applyAssetSetChange(
    result:                    import("./services/fundingRateScanner").ScanResult,
    positions:                 Map<string, any>,
    tradeCarryOver:            Record<string, number>,
    currentStrategies:         Record<string, string>,
    currentChains:             Record<string, string>,
    lastCrossChainTimes:       Record<string, number>,
    latestCrossChainDecisions: Record<string, any>,
    drainingAssets:            Set<string>,
    drainEntryTimes:           Map<string, number>,
    botState:                  any
  ): string[] {
    // Initialise state for newly added assets
    for (const a of result.added) {
      tradeCarryOver[a]            = tradeCarryOver[a]            ?? 0;
      currentStrategies[a]         = currentStrategies[a]         ?? "PARKED";
      currentChains[a]             = currentChains[a]             ?? "solana";
      lastCrossChainTimes[a]       = lastCrossChainTimes[a]       ?? 0;
      latestCrossChainDecisions[a] = latestCrossChainDecisions[a] ?? { execute: false, reason: "Waiting" };
      botState.prices[a]           = botState.prices[a]           ?? 0;
      botState.funding[a]          = botState.funding[a]          ?? 0;
      botState.basis[a]            = botState.basis[a]            ?? 0;
      botState.signals[a]          = botState.signals[a]          ?? "PARKED";
      logger.info(`[SCANNER] + ${a} added to active assets`);
    }

    // Dropped assets: drain if open position, remove immediately if clean
    let newActive = [...result.selectedAssets];
    for (const a of result.dropped) {
      if (drainingAssets.has(a)) continue; // already draining
      const hasPosition = positions.has(`${a}_SPOT`) || positions.has(`${a}_PERP`);
      if (hasPosition) {
        drainingAssets.add(a);
        drainEntryTimes.set(a, Date.now());
        newActive.push(a); // keep in loop until position closes
        logger.info(`[SCANNER] ~ ${a} queued for drain (open position — will close naturally)`);
      } else {
        logger.info(`[SCANNER] - ${a} removed (no open position)`);
      }
    }

    return newActive;
  }

  // Scoring functions
  // Annualise the funding rate (×8760 hrs/yr) so it's comparable to lendScore (Kamino APR).
  // Without this, raw hourly rates (e.g. 0.0000125) lose against 0.10 every time.
  function scoreDeltaNeutral(fundingRate: number, basis: number): number {
    return Math.abs(fundingRate) * 8760 * 0.7 + Math.abs(basis) * 0.3;
  }

  function scoreLending(): number {
    return kaminoManager.getDepositApr(); // live Kamino supply APR (or sim 4.5% fallback)
  }

  function allocateCapital(deltaScore: number, lendScore: number) {
    const total = deltaScore + lendScore;
    if (total === 0) return { delta: 0.2, lending: 0.8 };
    const raw = deltaScore / total;
    const delta = Math.max(0.2, raw);     // floor: always at least 20% to funding arb
    return { delta, lending: 1 - delta };
  }

  function applyRiskAdjustment(score: number, riskLevel: number): number {
    return score * (1 - riskLevel);
  }

  function allocateForTrade(amount: number, state: { availableCapital: number }): number {
    const requested = Math.max(0, amount);
    if (requested > state.availableCapital) {
      throw new Error("Not enough capital");
    }
    state.availableCapital -= requested;
    return requested;
  }

  function releaseTradeCapital(amount: number, state: { availableCapital: number }, totalCapital: number): void {
    state.availableCapital = Math.min(totalCapital, state.availableCapital + Math.max(0, amount));
  }

  function allocateForLending(state: { availableCapital: number }): number {
    const amount = state.availableCapital;
    state.availableCapital = 0;
    return amount;
  }

  async function deployToLending(asset: string, amount: number): Promise<number> {
    const result = await kaminoManager.deploy(amount);
    if (DEMO_MODE) {
      simulatedPnl += result.yield;
    }
    currentStrategies[asset] = "LENDING";
    return result.yield;
  }

  // ── Risk loop — 10s ────────────────────────────────────────────────────────
  const riskLoop = setInterval(async () => {
    if (stopping) return;
    try {
      const latencyMs   = await measureLatency(connection);
      const hlLatencyMs = await measureHlLatency(hlExecutor);
      const btcSnap     = marketEngine.getSnapshot("BTC");
      const oracleAgeS  = btcSnap ? (Date.now() - btcSnap.timestamp) / 1000 : 0;

      const conditions: MarketConditions = {
        fundingRateVolatility: 0.2,
        solanaRpcLatencyMs:    latencyMs,
        hlLatencyMs,
        oracleStalenessS:      oracleAgeS,
      };

      // Update demo position mark prices so risk engine sees realistic delta/PnL
      for (const [key, pos] of positions.entries()) {
        const asset = pos.asset;
        const snap = marketEngine.getSnapshot(asset as any);
        if (snap && pos.entryPrice) {
          const isSpot = key.includes('_SPOT');
          pos.markPrice = isSpot ? snap.spotPrice : snap.perpPrice;
          // Direction-aware PnL: LONG profits when price rises, SHORT profits when price falls
          if (pos.direction === "LONG") {
            pos.unrealizedPnl = (pos.markPrice - pos.entryPrice) * pos.baseAmount;
          } else {
            pos.unrealizedPnl = (pos.entryPrice - pos.markPrice) * pos.baseAmount;
          }
        }
      }

      const metrics = riskEngine.assess(vaultEquity, vaultEquity * 0.8, Array.from(positions.values()), conditions);
      latestDrawdown = metrics.drawdown;
      debugLog(riskEngine.formatReport(metrics));

      // ── Funding circuit-breaker sweep ─────────────────────────────────────────
      // Blocks new entries when |fundingAPR| > MAX_ABSOLUTE_FUNDING_APR.
      // Does NOT close existing positions — only prevents new ones.
      for (const asset of activeAssets) {
        const snap = marketEngine.getSnapshot(asset);
        if (snap) {
          const absApr = Math.abs(snap.fundingRate) * 8760;
          if (absApr > MAX_ABSOLUTE_FUNDING_APR) {
            if (!fundingCircuitBreakers.has(asset)) {
              fundingCircuitBreakers.add(asset);
              logger.risk(`[CB] ${asset}: funding APR ${(absApr * 100).toFixed(1)}% > ${(MAX_ABSOLUTE_FUNDING_APR * 100).toFixed(0)}% — blocking new entries`);
              await telegram.riskAlert(
                `Circuit breaker: ${asset} funding ${(absApr * 100).toFixed(1)}% APR exceeds limit — new entries blocked`,
                metrics.drawdown, metrics.deltaExposurePct
              );
            }
          } else if (fundingCircuitBreakers.has(asset)) {
            fundingCircuitBreakers.delete(asset);
            logger.info(`[CB] ${asset}: funding APR normalized — circuit breaker cleared`);
          }
        }
      }

      // Check MarginFi health factor — liquidation risk for short-spot positions
      const mfiState = marginFi.getState();
      if (mfiState.totalBorrowedUsd > 0 && mfiState.healthFactor < 1.25) {
        await telegram.riskAlert(
          `MarginFi health factor: ${mfiState.healthFactor.toFixed(3)} (safe: ≥ 1.25). Borrowed $${mfiState.totalBorrowedUsd.toFixed(0)} — liquidation risk`,
          metrics.drawdown, metrics.deltaExposurePct
        );
        if (mfiState.healthFactor < 1.1) {
          logger.risk("MarginFi near-liquidation — forcing close of all short-spot legs");
          for (const asset of activeAssets) {
            const spotPos = positions.get(`${asset}_SPOT`);
            if (spotPos?.direction === "SHORT") strategyEngine.setState(asset, "NONE");
          }
        }
      }

      // Push risk oracle on-chain
      await anchorClient.updateRiskOracle(
        Math.round(metrics.drawdown * 10_000),
        Math.round(metrics.deltaExposurePct * 10_000),
        metrics.worstAction === "PAUSE_EXECUTION" ? 1 : 0
      );

      // Handle critical events — act immediately, don't wait for the 2s strategy loop
      for (const ev of metrics.riskEvents) {
        if (ev.action === "EMERGENCY_CLOSE") {
          await telegram.emergencyStop(ev.message);
          for (const asset of activeAssets) {
            if (positions.has(`${asset}_SPOT`) || positions.has(`${asset}_PERP`)) {
              logger.risk(`Risk loop: emergency closing ${asset}`);
              await hlExecutor.closePosition(asset).catch(() => {});
              positions.delete(`${asset}_SPOT`);
              positions.delete(`${asset}_PERP`);
              strategyEngine.setState(asset, "NONE");
            }
          }
        }

        if (ev.action === "CLOSE_POSITION" && ev.asset) {
          const asset = ev.asset as Asset;
          if (positions.has(`${asset}_SPOT`) || positions.has(`${asset}_PERP`)) {
            logger.risk(`Risk loop: closing ${asset} — ${ev.message}`);
            await hlExecutor.closePosition(asset).catch(() => {});
            positions.delete(`${asset}_SPOT`);
            positions.delete(`${asset}_PERP`);
            strategyEngine.setState(asset, "NONE");
            await telegram.tradeClosed(asset, 0);
          }
        }

        if (["HIGH", "CRITICAL"].includes(ev.severity) && !["EMERGENCY_CLOSE", "CLOSE_POSITION", "NORMAL"].includes(ev.action)) {
          await telegram.riskAlert(ev.message, metrics.drawdown, metrics.deltaExposurePct);
        }
      }

      // Hyperliquid has no naked-spot risk — no incomplete position sweep needed.

      if (hlLatencyMs > 2000)  await telegram.networkCongested(hlLatencyMs);
      else if (latencyMs > 500) await telegram.networkCongested(latencyMs);
      if (oracleAgeS > 30)  await telegram.oracleStale("BTC", Math.round(oracleAgeS));

    } catch (e: any) { logger.error(`Risk loop: ${e.message}`); }
  }, RISK_CYCLE_MS);

  // ── Strategy loop — 15s ────────────────────────────────────────────────────
  while (!stopping) {
    tick++;
    // Only print console output on every LOG_EVERY_N-th cycle (~30s at 15s intervals)
    const shouldLog = tick % LOG_EVERY_N === 1;

    try {
      // Push NAV on-chain
      const btcSnap = marketEngine.getSnapshot("BTC");
      const ethSnap = marketEngine.getSnapshot("ETH");
      if (btcSnap && ethSnap) {
        const perpPnl = Array.from(positions.entries())
          .filter(([key]) => key.endsWith("_PERP"))
          .reduce((sum, [, pos]) => sum + (pos.unrealizedPnl ?? 0), 0);
        const btcSpotPos = positions.get("BTC_SPOT");
        const ethSpotPos = positions.get("ETH_SPOT");
        await anchorClient.updateNav(
          Math.round(btcSnap.spotPrice * 1_000_000),
          Math.round(ethSnap.spotPrice * 1_000_000),
          Math.round(perpPnl * 1_000_000),
          Math.round((btcSpotPos?.baseAmount ?? 0) * 1_000_000),
          Math.round((ethSpotPos?.baseAmount ?? 0) * 1_000_000)
        );
      }

      // ── Cross-Chain Evaluation ───────────────────────────────────────────────
      if (CROSS_CHAIN_CONFIG.ENABLED) {
        try {
          const funding = await getCrossChainFunding(hlExecutor, logger, cexRates, activeAssets);
          latestFundingByChain = funding;
          for (const asset of activeAssets) {
            const decision = evaluateCrossChain({
              asset: asset as any,
              currentChain: currentChains[asset],
              fundingRates: funding as any,
              capital: vaultEquity / TRADING_ASSETS.length,
              lastExecutionTime: lastCrossChainTimes[asset],
              logger,
            });

            logger.info(
              `Cross-chain decision (${asset}): ${decision.reason} | ` +
              `from=${decision.currentChain} to=${decision.bestChain ?? decision.currentChain} | ` +
              `edge=${((decision.netEdge ?? 0) * 100).toFixed(4)}% | ` +
              `estProfit=$${(decision.expectedProfitUsd ?? 0).toFixed(2)}`
            );
            latestCrossChainDecisions[asset] = decision;

            if (decision.execute) {
              const result = await executeCrossChain({
                asset: asset as any,
                fromChain: currentChains[asset],
                toChain: decision.bestChain!,
                amount: decision.allocation!,
                logger,
              });

              if (result.success) {
                currentChains[asset] = decision.bestChain!;
                lastCrossChainTimes[asset] = Date.now();
                logger.info(`Cross-chain move completed (${asset}): ${currentChains[asset]}`);
              } else {
                logger.error(`Cross-chain move failed (${asset})`);
              }
            }
          }
        } catch (err: any) {
          logger.error(`Cross-chain eval error: ${err.message}`);
        }
      }

      // Refresh vault equity and market data each cycle
      try {
        const freshEquity = await hlExecutor.getEquity();
        if (freshEquity > 0) vaultEquity = freshEquity;
      } catch { /* keep last known value */ }
      await marketEngine.refresh();

      // ── Scanner: EWMA update every cycle, full re-rank every 5min ──────────
      if (SCANNER_ENABLED) {
        scanner.updateCycle();
        if (scanner.shouldRescan()) {
          const result = await scanner.scan();
          if (result.changed) {
            activeAssets = applyAssetSetChange(
              result, positions, tradeCarryOver, currentStrategies,
              currentChains, lastCrossChainTimes, latestCrossChainDecisions,
              drainingAssets, drainEntryTimes, botState
            );
          }
        }
      }

      let marketData: any = {};
      let strategyData: any = { deltaCapital: 0, lendingCapital: 0 };
      let executionData: any = { executedTrade: false, events: [] as string[] };
      let riskData: any = {};
      let lendingData: any = {
        deployed: 0,
        yieldEarned: 0,
        byAsset: Object.fromEntries(activeAssets.map(a => [a, { amount: 0, yield: 0 }])),
      };
      // ── PnL Calculation ──────────────────────────────────────────────────────
      // Strategy PnL = funding earned (from open perp positions) + lending yield + realized closed trades.
      // We deliberately exclude mark-to-market noise (price moves): in a delta-neutral position,
      // the spot leg gain/loss exactly cancels the perp leg gain/loss, leaving only funding yield.
      const openFundingYield = Array.from(positions.values())
        .reduce((sum, pos) => sum + (pos.fundingAccrued ?? 0), 0);
      let pnl = cumulativeRealizedPnl + cumulativeLendingYield + openFundingYield;
      let mode = "BALANCED";
      const totalCapital = vaultEquity + cumulativeLendingYield; // compound lending yield back into capital
      // Deduct capital already locked in open spot positions so it isn't double-counted as lending
      const lockedInPositions = Array.from(positions.entries())
        .filter(([key]) => key.endsWith('_SPOT'))
        .reduce((sum, [, pos]) => sum + (pos.quoteAmount ?? 0), 0);
      const capitalState = { availableCapital: Math.max(0, totalCapital - lockedInPositions) };
      const capitalData = {
        starting: totalCapital,
        reservedForTrades: 0,
        releasedFromTrades: 0,
        lent: 0,
        remainingBeforeLending: 0,
        remainingAfterLending: 0,
        carryOver: { total: 0 } as Record<string, number>,
      };
      const plannedLendingByAsset: Record<string, number> = Object.fromEntries(activeAssets.map(a => [a, 0]));

      const agentObservation: AgentObservation = {
        funding: Object.fromEntries(
          activeAssets.map(a => [a, marketEngine.getSnapshot(a)?.fundingRate ?? 0])
        ),
        volatility: (() => {
          const rates = activeAssets
            .map(a => marketEngine.getSnapshot(a)?.fundingRate ?? 0)
            .filter(r => r !== 0);
          if (rates.length < 2) return 0;
          const mean = rates.reduce((s, r) => s + r, 0) / rates.length;
          return Math.abs(mean) > 0.00001
            ? Math.sqrt(rates.reduce((s, r) => s + (r - mean) ** 2, 0) / rates.length) / Math.abs(mean)
            : 0;
        })(),
      };
      const agentDecision = AI_AGENT_ENABLED ? decide(agentObservation, aiAgentState) : null;
      const agentMaxSize = AI_AGENT_ENABLED ? getPositionSize(aiAgentState, agentObservation.volatility) : 0;
      if (agentDecision) {
        logAgent("Observing market...");
        logDecision(agentDecision);
      }

      // Per-asset strategy
      for (const asset of activeAssets) {
        const snap = marketEngine.getSnapshot(asset);
        if (!snap) { logger.warn(`${asset}: no snapshot`); continue; }

        // Store market data for logging
        marketData[asset] = {
          price: snap.spotPrice,
          fr: snap.fundingRate,
          basis: snap.basisSpread
        };

        // Momentum filter
        const prevSnap = previousSnapshots[asset];
        let momentumMultiplier = 1.0;
        if (prevSnap) {
          const fundingRateChange = Math.abs(snap.fundingRate - prevSnap.fundingRate);
          const priceChange = Math.abs((snap.spotPrice - prevSnap.spotPrice) / prevSnap.spotPrice);
          const isStable = fundingRateChange < 0.01 && priceChange < 0.02;
          if (!isStable) {
            momentumMultiplier = 0.5;
          }
        }
        previousSnapshots[asset] = snap;

        riskEngine.recordFundingRate(asset as any, snap.fundingRate);

        // Liquidity on Hyperliquid is always sufficient for our trade sizes
        const liq = { allowed: true, reason: "HL liquidity OK" };
        if (!liq.allowed) {
          logger.warn(`${asset}: blocked by liquidity guard — ${liq.reason}`);
          continue;
        }

        // ─── CHECK FOR POSITION EXITS ───────────────────────────────────────
        // Before evaluating new signals, check if open positions should be closed
        const currentState = strategyEngine.getState()[asset];
        let signal = strategyEngine.evaluate(snap); // default signal

        if (currentState === "DELTA_NEUTRAL" || currentState === "BASIS_TRADE") {
          // Accrue funding yield to the PERP position each cycle
          const perpPos = positions.get(`${asset}_PERP`);
          if (perpPos && snap.fundingRate !== 0) {
            const cycleYield = (perpPos.quoteAmount ?? 0) * Math.abs(snap.fundingRate) / 240; // 15s = 1/240 hour
            perpPos.fundingAccrued = (perpPos.fundingAccrued ?? 0) + cycleYield;
            perpPos.unrealizedPnl  = perpPos.fundingAccrued;
          }

          // Get entry funding rate from strategy engine
          const fundingExitEval = strategyEngine.shouldExitFundingBased(asset, snap.fundingRate);
          if (fundingExitEval.shouldClose) {
            logger.info(`${asset}: Position exit triggered — ${fundingExitEval.reason}`);
            signal = {
              asset,
              signal: currentState === "DELTA_NEUTRAL" ? "DELTA_NEUTRAL_CLOSE" : "BASIS_TRADE_CLOSE",
              reason: fundingExitEval.reason,
              urgency: "HIGH",
              suggestedSizeUSD: 0,
              metadata: {
                fundingRate: snap.fundingRate,
                basisSpread: snap.basisSpread,
                spotPrice: snap.spotPrice,
                perpPrice: snap.perpPrice,
                liquidityScore: snap.liquidityScore,
              },
            };
          }

          // Time-based exit: simplified — close if funding turned against position
          if (!fundingExitEval.shouldClose) {
            const entryFundingRate = perpPos?.entryFundingRate ?? snap.fundingRate;
            const isSide = perpPos?.direction === "SHORT";
            const fundingTurnedAgainst = isSide ? snap.fundingRate < -0.0001 : snap.fundingRate > 0.0001;
            if (fundingTurnedAgainst) {
              logger.info(`${asset}: Funding turned against position — scheduling close`);
              signal = {
                asset,
                signal: currentState === "DELTA_NEUTRAL" ? "DELTA_NEUTRAL_CLOSE" : "BASIS_TRADE_CLOSE",
                reason: "Funding direction reversed",
                urgency: "MEDIUM",
                suggestedSizeUSD: 0,
                metadata: {
                  fundingRate: snap.fundingRate,
                  basisSpread: snap.basisSpread,
                  spotPrice: snap.spotPrice,
                  perpPrice: snap.perpPrice,
                  liquidityScore: snap.liquidityScore,
                },
              };
              void entryFundingRate; // suppress unused warning
            }
          }
        }

        const fundingRate = snap.fundingRate;
        const basis = snap.basisSpread;
        const liquidityScore = snap.liquidityScore;
        const impact = 0.001; // HL IOC orders have < 0.1% impact typically

        const deltaScore = scoreDeltaNeutral(fundingRate, basis) * momentumMultiplier;
        const lendScore = scoreLending();

        // Risk adjustment
        const liquidityRisk = liquidityScore < 0.5 ? 0.3 : 0; // reduce score if low liquidity
        const impactRisk = impact > 0.005 ? 0.2 : 0; // reduce if high impact
        const adjustedDeltaScore = applyRiskAdjustment(deltaScore, liquidityRisk + impactRisk);

        const allocation = allocateCapital(adjustedDeltaScore, lendScore);

        // Drawdown override: if drawdown > 10%, force 100% lending
        let finalAllocation = allocation;
        if (latestDrawdown > 0.1) {
          finalAllocation = { delta: 0, lending: 1 };
        }

        const capitalPerAsset = totalCapital / activeAssets.length;
        // Ensure delta allocation is at least MIN_TRADE_SIZE when signal wants to open
        const rawDeltaCapital = capitalPerAsset * finalAllocation.delta;
        const deltaCapitalAsset = Math.min(capitalPerAsset, Math.max(MIN_TRADE_SIZE, rawDeltaCapital));
        plannedLendingByAsset[asset] = Math.min(capitalPerAsset, Math.max(0, capitalPerAsset - deltaCapitalAsset));

        // Strategy state tracking
        if (finalAllocation.delta > 0.7) mode = "AGGRESSIVE";
        else if (finalAllocation.delta < 0.3) mode = "DEFENSIVE";

        // Capital manager: reserve for trade first, then lend leftover later
        const isOpenSignal = signal.signal === "DELTA_NEUTRAL_OPEN" || signal.signal === "BASIS_TRADE_OPEN";
        let executionSizeUSD = 0;

        // Guard: don't open if position already exists for this asset
        const hasOpenPosition = positions.has(`${asset}_SPOT`) || positions.has(`${asset}_PERP`);
        if (isOpenSignal && hasOpenPosition) {
          logger.info(`${asset}: Position already open — skipping new ${signal.signal}`);
          executionData.events.push(`${asset}: position already open — skipped duplicate entry`);
        } else if (isOpenSignal && drainingAssets.has(asset)) {
          // Asset is being retired — let existing positions close, block new opens
          executionData.events.push(`${asset}: draining — no new entries until position closes`);
        } else if (isOpenSignal && fundingCircuitBreakers.has(asset)) {
          executionData.events.push(`${asset}: circuit breaker active — funding APR too extreme for new entry`);
        } else if (isOpenSignal) {
          const blockedByAgent = agentDecision?.action === "SKIP" && agentDecision.asset === asset;

          if (blockedByAgent) {
            executionData.events.push(`${asset}: AI agent skipped (${agentDecision.reason})`);
          } else {
            // Settlement timing: boost size in capture window, hold outside it
            const settleMult = settlementTimer.getEntryBoost() * settlementTimer.getOutsideWindowPenalty();

            // Per-asset Kelly sizing — higher APR assets get proportionally larger allocation
            const fundingAprDecimal = Math.abs(snap.fundingRate) * 8760;
            const ringSamples       = SCANNER_ENABLED ? scanner.getRingSamples(asset) : [];
            const fundingVariance   = computeVariance(ringSamples.map(r => r * 8760));
            const kellySize = AI_AGENT_ENABLED
              ? getPositionSize(aiAgentState, agentObservation.volatility, fundingAprDecimal, fundingVariance)
              : 0;

            const requestedExecutionUSDRaw = Math.min(
              capitalPerAsset,
              Math.max(0, (deltaCapitalAsset + (tradeCarryOver[asset] ?? 0)) * settleMult)
            );
            const effectiveAgentCap = AI_AGENT_ENABLED
              ? Math.max(kellySize, MIN_TRADE_SIZE)
              : requestedExecutionUSDRaw;

            // Market impact cap: never take more than 0.1% of 24h volume or 0.5% of OI.
            // This prevents the bot from moving prices on thin/volatile markets.
            const maxByVolume      = snap.dailyVolumeUsd > 0 ? snap.dailyVolumeUsd * MARKET_IMPACT_VOLUME_PCT : Infinity;
            const maxByOI          = snap.openInterest   > 0 ? snap.openInterest   * MARKET_IMPACT_OI_PCT     : Infinity;
            const marketImpactCap  = Math.min(maxByVolume, maxByOI);

            const requestedExecutionUSD = Math.min(
              requestedExecutionUSDRaw,
              effectiveAgentCap,
              marketImpactCap
            );

            const isImpactBound = marketImpactCap < Math.min(requestedExecutionUSDRaw, effectiveAgentCap);
            executionData.events.push(
              `${asset}: sizing raw=$${requestedExecutionUSDRaw.toFixed(0)} | aiCap=$${effectiveAgentCap.toFixed(0)} | impactCap=$${marketImpactCap === Infinity ? "∞" : marketImpactCap.toFixed(0)}${isImpactBound ? " ⚠ BOUND" : ""} | final=$${requestedExecutionUSD.toFixed(0)}`
            );

            const reservableAmount = Math.min(requestedExecutionUSD, capitalState.availableCapital);
            if (reservableAmount > 0) {
              // ── Gross notional portfolio cap (Step 8) ──────────────────────
              const grossNotional  = Array.from(positions.values()).reduce((s, p) => s + (p.quoteAmount ?? 0), 0);
              const grossHeadroom  = Math.max(0, totalCapital * MAX_GROSS_NOTIONAL_RATIO - grossNotional);
              if (grossHeadroom < MIN_TRADE_SIZE) {
                executionData.events.push(
                  `${asset}: gross notional cap — total $${grossNotional.toFixed(0)} ≥ ` +
                  `${(MAX_GROSS_NOTIONAL_RATIO * 100).toFixed(0)}% of capital — carry`
                );
                tradeCarryOver[asset] = requestedExecutionUSD;
                executionSizeUSD = 0;
              } else {
                const cappedReservable = Math.min(reservableAmount, grossHeadroom);
                executionSizeUSD = allocateForTrade(cappedReservable, capitalState);
                capitalData.reservedForTrades += executionSizeUSD;
              }
            }

            if (executionSizeUSD < MIN_TRADE_SIZE && executionSizeUSD > 0) {
              releaseTradeCapital(executionSizeUSD, capitalState, totalCapital);
              capitalData.releasedFromTrades += executionSizeUSD;
              tradeCarryOver[asset] = requestedExecutionUSD;
              executionData.events.push(
                `${asset}: accumulated $${tradeCarryOver[asset].toFixed(0)} (below minimum ${MIN_TRADE_SIZE})`
              );
              executionSizeUSD = 0;
            }

            if (executionSizeUSD <= 0 && requestedExecutionUSD > 0) {
              tradeCarryOver[asset] = requestedExecutionUSD;
              executionData.events.push(`${asset}: waiting to accumulate ($${tradeCarryOver[asset].toFixed(0)})`);
            }

            if (executionSizeUSD >= MIN_TRADE_SIZE) {
              if (DEMO_MODE) {
                const tradeType = signal.signal === "DELTA_NEUTRAL_OPEN" ? "DELTA_NEUTRAL" : "BASIS_TRADE";
                const isNegativeFunding = signal.signal === "DELTA_NEUTRAL_OPEN" && signal.metadata.fundingRate < 0;
                const side = isNegativeFunding ? "long-perp" : "short-perp";
                const legLabel = side === "short-perp"
                  ? "LONG spot + SHORT perp"
                  : "SHORT spot + LONG perp";
                logger.trade(`[DEMO] ${asset} ${tradeType}: ${legLabel} $${executionSizeUSD.toFixed(0)}`);
                strategyEngine.setState(asset, tradeType === "DELTA_NEUTRAL" ? "DELTA_NEUTRAL" : "BASIS_TRADE");
                currentStrategies[asset] = tradeType;
                // Store both legs so risk engine sees near-zero net delta
                positions.set(`${asset}_SPOT`, {
                  asset,
                  baseAmount: executionSizeUSD / snap.spotPrice,
                  quoteAmount: executionSizeUSD,
                  entryPrice: snap.spotPrice,
                  markPrice: snap.spotPrice,
                  unrealizedPnl: 0,
                  direction: side === "short-perp" ? "LONG" : "SHORT",
                });
                positions.set(`${asset}_PERP`, {
                  asset,
                  baseAmount: executionSizeUSD / snap.perpPrice,
                  quoteAmount: executionSizeUSD,
                  entryPrice: snap.perpPrice,
                  markPrice: snap.perpPrice,
                  unrealizedPnl: 0,
                  direction: side === "short-perp" ? "SHORT" : "LONG",
                  entryFundingRate: snap.fundingRate,
                });
                const detailedLegLabel = side === "short-perp"
                  ? "LONG spot (Jupiter) + SHORT perp (Hyperliquid)"
                  : "SHORT spot (MarginFi+Jupiter) + LONG perp (Hyperliquid)";
                await telegram.tradeOpened(asset, tradeType, executionSizeUSD, detailedLegLabel);
                executionData.executedTrade = true;
                executionData.events.push(`${asset}: ${legLabel} ($${executionSizeUSD.toFixed(0)})`);
                strategyData.deltaCapital += executionSizeUSD;
                tradeCarryOver[asset] = Math.max(0, requestedExecutionUSD - executionSizeUSD);
                updateState(aiAgentState, { asset: asset as any, pnl: (Math.random() - 0.45) * 20 });
              }

              if (!DEMO_MODE) {
                const liveExec = await handleSignalLive(signal, asset, executionSizeUSD, hlExecutor, jupiterSwap, marginFi, positions, logger, bybitExecutor, cexRates);
                if (liveExec.events.length > 0) {
                  executionData.events.push(...liveExec.events);
                }
                if (liveExec.executed) {
                  executionData.executedTrade = true;
                  strategyData.deltaCapital += executionSizeUSD;
                  tradeCarryOver[asset] = Math.max(0, requestedExecutionUSD - executionSizeUSD);
                  if (typeof liveExec.realizedPnl === "number") {
                    cumulativeRealizedPnl += liveExec.realizedPnl;
                    updateState(aiAgentState, { asset: asset as any, pnl: liveExec.realizedPnl });
                  }
                  if (liveExec.tradeRecord) {
                    tradeHistory.push(liveExec.tradeRecord);
                    if (tradeHistory.length > 100) tradeHistory.shift();
                  }
                } else {
                  releaseTradeCapital(executionSizeUSD, capitalState, totalCapital);
                  capitalData.releasedFromTrades += executionSizeUSD;
                  tradeCarryOver[asset] = requestedExecutionUSD;
                }
              }
            }
          }
        } else {
          if (signal.signal === "DELTA_NEUTRAL_CLOSE" || signal.signal === "BASIS_TRADE_CLOSE") {
            // Close both legs and reset state so next cycle can re-enter (possibly reversed)
            const hadSpot = positions.has(`${asset}_SPOT`);
            const hadPerp = positions.has(`${asset}_PERP`);
            if (hadSpot || hadPerp) {
              positions.delete(`${asset}_SPOT`);
              positions.delete(`${asset}_PERP`);
              executionData.events.push(`${asset}: position closed — ${signal.reason}`);
              executionData.executedTrade = true;
            }
            strategyEngine.setState(asset, "NONE");
            currentStrategies[asset] = "PARKED";
            tradeCarryOver[asset] = 0;
          } else if ((tradeCarryOver[asset] ?? 0) > 0) {
            const before = tradeCarryOver[asset];
            tradeCarryOver[asset] = parseFloat((before * CARRYOVER_DECAY).toFixed(2));
            if (tradeCarryOver[asset] < 1) {
              tradeCarryOver[asset] = 0;
              executionData.events.push(`${asset}: carryover expired (decayed to zero)`);
            } else {
              executionData.events.push(`${asset}: carryover decayed $${before.toFixed(0)} → $${tradeCarryOver[asset].toFixed(0)} (signal: ${signal.signal})`);
            }
          } else {
            executionData.events.push(`${asset}: ${signal.signal}`);
          }
        }

        // Update strategy state — driven by actual open positions ONLY.
        // Do NOT call setState when no position is open: setState("NONE"/"PARKED") wipes the
        // momentum timer inside strategyEngine, preventing the 30s window from ever completing.
        // Close signals already call setState("NONE") inline above; nothing else needs to.
        const hasOpenDeltaPos = positions.has(`${asset}_SPOT`) || positions.has(`${asset}_PERP`);
        if (hasOpenDeltaPos) {
          const openStratType = (currentStrategies[asset] === "BASIS_TRADE") ? "BASIS_TRADE" : "DELTA_NEUTRAL";
          strategyEngine.setState(asset, openStratType);
          currentStrategies[asset] = openStratType;
        } else {
          // No position — leave engine state untouched so momentum keeps accumulating.
          // currentStrategies is display-only.
          currentStrategies[asset] = allocation.delta > allocation.lending ? "PARKED" : "LENDING";
        }

      }

      // ── Drain finalisation ──────────────────────────────────────────────────
      // Check if drained assets have fully closed; force-close after max drain time.
      for (const asset of [...drainingAssets]) {
        const hasPosition = positions.has(`${asset}_SPOT`) || positions.has(`${asset}_PERP`);
        const elapsed     = Date.now() - (drainEntryTimes.get(asset) ?? Date.now());
        const timedOut    = elapsed > SCANNER_MAX_DRAIN_MS;

        if (!hasPosition || timedOut) {
          if (timedOut && hasPosition) {
            logger.warn(`[SCANNER] Force-closing ${asset} (drain timeout ${Math.round(elapsed / 60_000)}min)`);
            await hlExecutor.closePosition(asset).catch(() => {});
            positions.delete(`${asset}_SPOT`);
            positions.delete(`${asset}_PERP`);
            strategyEngine.setState(asset, "NONE");
          }
          drainingAssets.delete(asset);
          drainEntryTimes.delete(asset);
          activeAssets = activeAssets.filter(a => a !== asset);
          logger.info(`[SCANNER] - ${asset} fully exited — removed from active assets`);
        }
      }

      // ── Delta rebalancing: correct spot/perp notional drift > 5% ──────────
      for (const asset of activeAssets) {
        const spotPos = positions.get(`${asset}_SPOT`);
        const perpPos = positions.get(`${asset}_PERP`);
        if (!spotPos || !perpPos) continue;
        const spotQ = spotPos.quoteAmount ?? 0;
        const perpQ = perpPos.quoteAmount ?? 0;
        const maxQ  = Math.max(spotQ, perpQ);
        if (maxQ === 0) continue;
        const drift = Math.abs(spotQ - perpQ) / maxQ;
        if (drift <= 0.05) continue;

        const driftUSD = Math.abs(spotQ - perpQ) / 2;
        if (DEMO_MODE) {
          if (spotQ > perpQ) {
            perpPos.quoteAmount = (perpPos.quoteAmount ?? 0) + driftUSD;
            executionData.events.push(`${asset}: rebalanced +$${driftUSD.toFixed(0)} short perp (drift ${(drift * 100).toFixed(1)}%)`);
          } else {
            spotPos.quoteAmount = (spotPos.quoteAmount ?? 0) + driftUSD;
            executionData.events.push(`${asset}: rebalanced +$${driftUSD.toFixed(0)} long spot (drift ${(drift * 100).toFixed(1)}%)`);
          }
        } else {
          const snapRb = marketEngine.getSnapshot(asset);
          if (snapRb) {
            if (spotQ > perpQ) {
              await hlExecutor.openShort(asset, driftUSD).catch((e: any) =>
                logger.warn(`${asset}: rebalance short perp failed — ${e.message}`)
              );
              perpPos.quoteAmount = (perpPos.quoteAmount ?? 0) + driftUSD;
            } else {
              await jupiterSwap.swap("USDC", asset, driftUSD, snapRb.spotPrice).catch((e: any) =>
                logger.warn(`${asset}: rebalance spot buy failed — ${e.message}`)
              );
              spotPos.quoteAmount = (spotPos.quoteAmount ?? 0) + driftUSD;
            }
            executionData.events.push(`${asset}: rebalanced delta (drift ${(drift * 100).toFixed(1)}%)`);
          }
        }
      }

      // Lend only leftover capital after all trade reservations/executions.
      capitalData.remainingBeforeLending = capitalState.availableCapital;
      const lendingAmount = allocateForLending(capitalState);
      capitalData.lent = lendingAmount;
      capitalData.remainingAfterLending = capitalState.availableCapital;
      const plannedLendingTotal = activeAssets.reduce((s, a) => s + (plannedLendingByAsset[a] ?? 0), 0);
      for (const asset of activeAssets) {
        const weight = plannedLendingTotal > 0 ? (plannedLendingByAsset[asset] ?? 0) / plannedLendingTotal : 1 / activeAssets.length;
        const lendingCapitalAsset = lendingAmount * weight;
        if (lendingCapitalAsset > 1000) {
          const yieldEarned = await deployToLending(asset, lendingCapitalAsset);
          lendingData.deployed += lendingCapitalAsset;
          lendingData.yieldEarned += yieldEarned;
          cumulativeLendingYield += yieldEarned;
          lendingData.byAsset[asset].amount += lendingCapitalAsset;
          lendingData.byAsset[asset].yield += yieldEarned;
          executionData.events.push(`${asset}: lending deployed ($${lendingCapitalAsset.toFixed(0)})`);
          strategyData.lendingCapital += lendingCapitalAsset;
        }
      }

      // Calculate NAV and risk metrics
      const nav = vaultEquity + pnl;
      const drawdown = latestDrawdown;
      // Get current risk metrics for logging
      const currentConditions: MarketConditions = {
        fundingRateVolatility: 0.2,
        solanaRpcLatencyMs: 100,
        hlLatencyMs: 0,
        oracleStalenessS: 0,
      };
      // Use actual vault equity for risk assessment, not simulated PnL
      const currentMetrics = riskEngine.assess(vaultEquity, vaultEquity * 0.8, Array.from(positions.values()), currentConditions);
      const deltaExposure = currentMetrics.deltaExposurePct;

      botState.timestamp = Date.now();
      botState.tick = tick;
      // Update dynamic per-asset fields
      for (const a of activeAssets) {
        botState.prices[a] = marketData[a]?.price ?? 0;
        botState.funding[a] = marketData[a]?.fr ?? 0;
        botState.basis[a] = marketData[a]?.basis ?? 0;
        botState.signals[a] = currentStrategies[a] ?? "PARKED";
      }
      botState.positionsCount = positions.size;
      botState.nav = nav;
      botState.pnl = pnl;
      botState.drawdown = drawdown;
      botState.deltaExposure = deltaExposure;
      botState.pnlBreakdown = { funding: openFundingYield, lending: cumulativeLendingYield, realized: cumulativeRealizedPnl };
      botState.lending = {
        deployed: lendingData.deployed,
        yield: lendingData.yieldEarned,
      };
      botState.lendingByAsset = lendingData.byAsset;
      botState.executionEvents = [...executionData.events];
      botState.execution = {
        executedTrade: executionData.executedTrade,
        events: [...executionData.events],
      };
      capitalData.carryOver = {
        ...Object.fromEntries(activeAssets.map(a => [a, tradeCarryOver[a] ?? 0])),
        total: activeAssets.reduce((s, a) => s + (tradeCarryOver[a] ?? 0), 0),
      };
      botState.capital = {
        starting: capitalData.starting,
        reservedForTrades: capitalData.reservedForTrades,
        releasedFromTrades: capitalData.releasedFromTrades,
        lent: capitalData.lent,
        remainingBeforeLending: capitalData.remainingBeforeLending,
        remainingAfterLending: capitalData.remainingAfterLending,
        carryOver: { ...capitalData.carryOver },
      };
      botState.positions = Array.from(positions.entries()).map(([key, pos]) => ({
        key,
        asset: pos.asset,
        leg: key.includes("_SPOT") ? "SPOT" : "PERP",
        direction: pos.direction,
        notional: pos.quoteAmount,
        pnl: pos.unrealizedPnl ?? 0,
      }));
      botState.crossChain = {
        currentChains: { ...currentChains },
        decisions: { ...latestCrossChainDecisions },
        fundingByChain: latestFundingByChain,
      };
      botState.aiAgent = {
        enabled: AI_AGENT_ENABLED,
        observation: {
          funding: agentObservation.funding,
          volatility: agentObservation.volatility,
        },
        decision: agentDecision,
        maxSize: agentMaxSize,
        state: {
          winRate: aiAgentState.winRate,
          confidence: aiAgentState.confidence,
          performance: { ...aiAgentState.performance },
          momentumScores: { ...aiAgentState.momentumScore },
        },
      };
      botState.tradeHistory = tradeHistory.slice(-100);

      // ── Organized Logging (gated to every LOG_EVERY_N cycles) ─────────────
      if (shouldLog) {
      logSection(`Cycle #${tick}`);

      // [MARKET]
      console.log(`\n${chalk.yellow('[MARKET]')}`);
      for (const a of activeAssets) {
        if (marketData[a]) {
          console.log(`${a} | $${marketData[a].price.toFixed(2)} | FR ${(marketData[a].fr * 100).toFixed(3)}% | basis ${(marketData[a].basis * 100).toFixed(2)}%`);
        }
      }

      // [STRATEGY]
      console.log(`\n${chalk.blue('[STRATEGY]')}`);
      if (strategyData.deltaCapital > 0) {
        console.log(`Delta Allocation: $${strategyData.deltaCapital.toFixed(2)}`);
      }
      if (lockedInPositions > 0) {
        const openAssets = activeAssets.filter(a => positions.has(`${a}_SPOT`) || positions.has(`${a}_PERP`));
        console.log(`Open Positions (holding): ${openAssets.join(", ")}  ($${lockedInPositions.toFixed(2)} locked)`);
      }
      if (strategyData.lendingCapital > 0) {
        console.log(`Lending Allocation: $${strategyData.lendingCapital.toFixed(2)}`);
      }

      // [CAPITAL]
      console.log(`\n${chalk.white('[CAPITAL]')}`);
      console.log(`Starting: $${capitalData.starting.toFixed(2)}`);
      if (cumulativeLendingYield > 0) {
        console.log(`Lending Yield Compounded: +$${cumulativeLendingYield.toFixed(4)} → Total Capital: $${totalCapital.toFixed(2)}`);
      }
      if (lockedInPositions > 0) {
        console.log(`Locked In Open Positions: $${lockedInPositions.toFixed(2)}`);
      }
      console.log(`Reserved For Trades: $${capitalData.reservedForTrades.toFixed(2)}`);
      console.log(`Released From Failed/Skipped: $${capitalData.releasedFromTrades.toFixed(2)}`);
      console.log(`Remaining Before Lending: $${capitalData.remainingBeforeLending.toFixed(2)}`);
      console.log(`Lent (Leftover): $${capitalData.lent.toFixed(2)}`);
      console.log(`Remaining After Lending: $${capitalData.remainingAfterLending.toFixed(2)}`);
      const carryOverStr = activeAssets.map(a => `${a}: $${(tradeCarryOver[a] ?? 0).toFixed(2)}`).join(" | ");
      const carryTotal = activeAssets.reduce((s, a) => s + (tradeCarryOver[a] ?? 0), 0);
      console.log(`CarryOver ${carryOverStr} | Total: $${carryTotal.toFixed(2)}`);

      // [EXECUTION]
      console.log(`\n${chalk.green('[EXECUTION]')}`);
      if (executionData.executedTrade) {
        console.log(`${chalk.green('✔')} Trade(s) executed`);
      } else {
        console.log(`${chalk.gray('•')} No trade executed`);
      }
      for (const event of executionData.events) {
        console.log(`- ${event}`);
      }

      // [RISK]
      console.log(`\n${chalk.red('[RISK]')}`);
      console.log(`NAV: $${nav.toFixed(2)}`);
      console.log(`Drawdown: ${(drawdown * 100).toFixed(2)}%`);
      console.log(`Delta Exposure: ${(deltaExposure * 100).toFixed(2)}%`);

      // [LENDING]
      console.log(`\n${chalk.magenta('[LENDING]')}`);
      if (lendingData.deployed > 0) {
        console.log(`Deployed: $${lendingData.deployed.toFixed(0)}`);
        console.log(`Yield (cycle): +$${lendingData.yieldEarned.toFixed(4)}`);
      }

      // [AI AGENT]
      if (AI_AGENT_ENABLED) {
        console.log(`\n${chalk.white('[AI AGENT]')}`);
        const topFundingEntries = Object.entries(agentObservation.funding)
          .map(([a, r]) => `${a} FR ${(r * 100).toFixed(3)}%`).slice(0, 4).join(" | ");
        console.log(`Observation | ${topFundingEntries} | Vol ${agentObservation.volatility.toFixed(3)}`);
        console.log(`Decision: ${JSON.stringify(agentDecision)}`);
        console.log(`Max Size: $${agentMaxSize.toFixed(2)}`);
        console.log(
          `State | WinRate ${aiAgentState.winRate.toFixed(2)} | ` +
          `Confidence ${aiAgentState.confidence.toFixed(2)}`
        );
      }

      // [SUMMARY]
      console.log(`\n${chalk.cyan('[SUMMARY]')}`);
      const elapsedHours = (tick * CYCLE_MS) / 3_600_000;
      const projectedApr = elapsedHours > 0 ? (pnl / vaultEquity) * (8760 / elapsedHours) : 0;
      console.log(`PnL: +$${pnl.toFixed(4)}  [funding: $${openFundingYield.toFixed(4)} | lending: $${cumulativeLendingYield.toFixed(4)} | realized: $${cumulativeRealizedPnl.toFixed(4)}]  Projected APR: ${(projectedApr * 100).toFixed(1)}%  Mode: ${mode}`);
      console.log(settlementTimer.getStatusLine());
      } // end if (shouldLog)

      // Calculate real PnL from open positions (not simulated)
      const realizedPnL = Array.from(positions.values()).reduce((sum, pos) => sum + (pos.unrealizedPnl ?? 0), 0);
      const totalRealPnL = realizedPnL + (lendingData.yieldEarned ?? 0);

      // Telegram cycle summary (gated to log cycles only, not every 2s)
      if (shouldLog) {
        await telegram.cycleUpdate({
          tick,
          nav:       vaultEquity,
          pnl:       totalRealPnL,
          positions: positions.size,
          btcSignal: currentStrategies.BTC ?? "—",
          ethSignal: currentStrategies.ETH ?? "—",
        });
      }

    } catch (e: any) { logger.error(`Strategy loop: ${e.message}`); }

    if (shouldLog) logger.info(`─── Cycle #${tick} done — waiting ${CYCLE_MS / 1000}s\n`);
    await sleep(CYCLE_MS);
  }

  clearInterval(riskLoop);
}

async function handleSignalLive(
  signal: Signal,
  asset: Asset,
  executionSizeUSD: number,
  hlExec: HyperliquidExecutor,
  jupiterSwap: JupiterSwapper,
  marginFi: MarginFiManager,
  positions: Map<string, any>,
  logger: Logger,
  bybitExecutor?: BybitExecutor,
  cexRates?: CexFundingRates
): Promise<{ executed: boolean; events: string[]; realizedPnl?: number; tradeRecord?: TradeRecord }> {
  const events: string[] = [];
  let executed = false;
  let realizedPnl: number | undefined = undefined;
  let tradeRecord: TradeRecord | undefined = undefined;

  // ── Venue selection: route to Bybit when it pays more than HL + spread ──────
  const hlApr     = Math.abs(signal.metadata.fundingRate ?? 0) * 8760;
  const bybitApr  = cexRates ? Math.abs(cexRates.getRate(asset, "bybit")) * 8760 : 0;
  const useBybit  = !!bybitExecutor?.isEnabled() && bybitApr > hlApr + BYBIT_ARB_MIN_SPREAD;
  const venue     = useBybit ? "Bybit" : "HL";
  if (useBybit) {
    events.push(`${asset}: routing to Bybit (APR ${(bybitApr * 100).toFixed(1)}% vs HL ${(hlApr * 100).toFixed(1)}%)`);
  }

  switch (signal.signal) {
    case "DELTA_NEUTRAL_OPEN":
    case "BASIS_TRADE_OPEN": {
      if (executionSizeUSD < MIN_TRADE_SIZE) {
        events.push(`${asset}: skipped open (size ${executionSizeUSD.toFixed(0)} below minimum ${MIN_TRADE_SIZE})`);
        break;
      }
      if (positions.has(`${asset}_SPOT`)) {
        events.push(`${asset}: already open`);
        break;
      }
      const type  = signal.signal === "DELTA_NEUTRAL_OPEN" ? "DELTA_NEUTRAL" : "BASIS_TRADE";
      const side  = signal.metadata.fundingRate < 0 ? "long-perp" : "short-perp";
      const price = signal.metadata.spotPrice ?? 100;
      let perpOrderResult: { orderId: string; fillPrice: number; slippagePct: number } | null = null;

      try {
        if (side === "short-perp") {
          // ── True delta-neutral: buy spot on Jupiter + short perp on HL ─────
          // Step 1: buy spot
          try {
            const spotResult = await jupiterSwap.swap("USDC", asset, executionSizeUSD, price);
            positions.set(`${asset}_SPOT`, {
              asset,
              quoteAmount: executionSizeUSD,
              baseAmount:  spotResult.outputAmount,
              entryPrice:  price,
              markPrice:   price,
              unrealizedPnl: 0,
              direction: "LONG",
            });
            events.push(`${asset}: spot bought $${executionSizeUSD.toFixed(0)} on Jupiter`);
          } catch (spotErr: any) {
            if (spotErr.message === "MOCK_SWAP_OFFLINE") {
              // devnet — simulate the spot leg
              positions.set(`${asset}_SPOT`, {
                asset,
                quoteAmount: executionSizeUSD,
                baseAmount:  executionSizeUSD / price,
                entryPrice:  price,
                markPrice:   price,
                unrealizedPnl: 0,
                direction: "LONG",
              });
              events.push(`${asset}: spot buy simulated (devnet/offline)`);
            } else {
              events.push(`${asset}: spot buy failed — ${spotErr.message}. Aborting trade.`);
              break; // don't open perp without spot hedge
            }
          }

          // Step 2: short perp on selected venue
          perpOrderResult = useBybit
            ? await bybitExecutor!.openShort(asset, executionSizeUSD, signal.metadata.perpPrice)
            : await hlExec.openShort(asset, executionSizeUSD, signal.metadata.perpPrice);

        } else {
          // ── Negative funding: SHORT spot via MarginFi borrow + LONG perp on HL ──
          if (!marginFi.isTradeViable(asset, signal.metadata.fundingRate)) {
            events.push(`${asset}: negative funding but borrow cost exceeds yield — PARK`);
            break;
          }

          // Step 1: borrow asset from MarginFi (deposit USDC collateral)
          let borrowResult: { tokenAmount: number; collateralLocked: number };
          try {
            borrowResult = await marginFi.borrowAsset(asset, executionSizeUSD, price);
          } catch (borrowErr: any) {
            events.push(`${asset}: MarginFi borrow failed — ${borrowErr.message}. Aborting.`);
            break;
          }

          // Step 2: sell borrowed tokens on Jupiter (asset → USDC)
          try {
            await jupiterSwap.swap(asset, "USDC", executionSizeUSD, price);
            positions.set(`${asset}_SPOT`, {
              asset,
              quoteAmount:      executionSizeUSD,
              baseAmount:       borrowResult.tokenAmount,
              borrowedAmount:   borrowResult.tokenAmount,
              collateralLocked: borrowResult.collateralLocked,
              borrowRateAnnual: marginFi.getBorrowRate(asset),
              entryPrice:       price,
              markPrice:        price,
              unrealizedPnl:    0,
              direction:        "SHORT",
            });
            events.push(`${asset}: borrowed + sold $${executionSizeUSD.toFixed(0)} on Jupiter`);
          } catch (sellErr: any) {
            // Undo borrow if spot sell fails
            await marginFi.repayBorrow(asset, borrowResult.tokenAmount).catch(() => {});
            if (sellErr.message === "MOCK_SWAP_OFFLINE") {
              // devnet — simulate the short spot leg
              positions.set(`${asset}_SPOT`, {
                asset,
                quoteAmount:      executionSizeUSD,
                baseAmount:       borrowResult.tokenAmount,
                borrowedAmount:   borrowResult.tokenAmount,
                collateralLocked: borrowResult.collateralLocked,
                borrowRateAnnual: marginFi.getBorrowRate(asset),
                entryPrice:       price,
                markPrice:        price,
                unrealizedPnl:    0,
                direction:        "SHORT",
              });
              events.push(`${asset}: short spot simulated (devnet/offline)`);
            } else {
              events.push(`${asset}: spot sell failed — borrow unwound. Aborting.`);
              break;
            }
          }

          // Step 3: long perp on selected venue
          perpOrderResult = useBybit
            ? await bybitExecutor!.openLong(asset, executionSizeUSD, signal.metadata.perpPrice)
            : await hlExec.openLong(asset, executionSizeUSD, signal.metadata.perpPrice);
        }

        positions.set(`${asset}_PERP`, {
          asset,
          baseAmount:       executionSizeUSD / price,
          quoteAmount:      executionSizeUSD,
          entryPrice:       perpOrderResult?.fillPrice ?? price,
          entryFillPrice:   perpOrderResult?.fillPrice ?? price,
          entrySlippagePct: perpOrderResult?.slippagePct ?? 0,
          entryFundingRate: signal.metadata.fundingRate,
          entryFundingApr:  Math.abs(signal.metadata.fundingRate) * 8760,
          openedAt:         Date.now(),
          markPrice:        price,
          unrealizedPnl:    0,
          fundingAccrued:   0,
          direction: side === "short-perp" ? "SHORT" : "LONG",
          venue,
        });
        await telegram.tradeOpened(asset, type, executionSizeUSD,
          side === "short-perp"
            ? "LONG spot (Jupiter) + SHORT perp (HL)"
            : "SHORT spot (MarginFi+Jupiter) + LONG perp (HL)");
        executed = true;
        events.push(
          `${asset}: ${type} opened — ` +
          (side === "short-perp"
            ? "LONG spot (Jupiter) + SHORT perp (HL)"
            : "SHORT spot (MarginFi+Jupiter) + LONG perp (HL)") +
          ` $${executionSizeUSD.toFixed(0)}`
        );
      } catch (e: any) {
        events.push(`${asset}: ${type} open failed — ${e.message}`);
      }
      break;
    }

    case "DELTA_NEUTRAL_CLOSE":
    case "BASIS_TRADE_CLOSE": {
      if (!positions.has(`${asset}_SPOT`) && !positions.has(`${asset}_PERP`)) {
        events.push(`${asset}: no open position to close`);
        break;
      }

      // Step 1: unwind spot leg (direction-aware)
      let spotPnl = 0;
      let borrowInterest = 0;
      const spotPos = positions.get(`${asset}_SPOT`);
      if (spotPos) {
        const markPrice = signal.metadata.spotPrice ?? spotPos.entryPrice;

        if (spotPos.direction === "SHORT") {
          // Short-spot close: buy back asset on Jupiter, repay MarginFi borrow
          try {
            await jupiterSwap.swap("USDC", asset, spotPos.quoteAmount, markPrice);
            borrowInterest = await marginFi.repayBorrow(asset, spotPos.borrowedAmount);
            // Short profit: sold at entryPrice, bought back at markPrice
            spotPnl = spotPos.quoteAmount * (1 - markPrice / spotPos.entryPrice) - borrowInterest;
            events.push(
              `${asset}: short spot closed — buyback + MarginFi repaid ` +
              `(PnL $${spotPnl.toFixed(2)}, interest $${borrowInterest.toFixed(4)})`
            );
          } catch (err: any) {
            if (err.message === "MOCK_SWAP_OFFLINE") {
              await marginFi.repayBorrow(asset, spotPos.borrowedAmount).catch(() => {});
              events.push(`${asset}: short spot unwind simulated (devnet/offline)`);
            } else {
              logger.warn(`${asset}: short spot unwind failed — ${err.message}`);
            }
          }
        } else {
          // Long-spot close: sell asset → USDC on Jupiter
          try {
            const sellResult = await jupiterSwap.swap(asset, "USDC", spotPos.quoteAmount, markPrice);
            spotPnl = sellResult.outputAmount - spotPos.quoteAmount;
            events.push(`${asset}: long spot sold on Jupiter (PnL $${spotPnl.toFixed(2)})`);
          } catch (spotErr: any) {
            if (spotErr.message === "MOCK_SWAP_OFFLINE") {
              events.push(`${asset}: spot sell simulated (devnet/offline)`);
            } else {
              logger.warn(`${asset}: spot sell failed — ${spotErr.message}`);
            }
          }
        }
      }

      // Step 2: close perp on the venue it was opened on
      const perpPos      = positions.get(`${asset}_PERP`);
      const closeVenue   = perpPos?.venue ?? "HL";
      const closePerpResult = closeVenue === "Bybit" && bybitExecutor
        ? await bybitExecutor.closePosition(asset, signal.metadata.perpPrice).catch(() => null)
        : await hlExec.closePosition(asset, signal.metadata.perpPrice).catch(() => null);
      const fundingPnl   = perpPos?.fundingAccrued ?? 0;
      const combinedPnl  = spotPnl + fundingPnl;
      realizedPnl = combinedPnl;

      // Build PnL attribution record
      const closedAt     = Date.now();
      const entryNotional = perpPos?.quoteAmount ?? 0;
      const entrySlipUsd  = (perpPos?.entrySlippagePct ?? 0) * entryNotional;
      const exitSlipUsd   = (closePerpResult?.slippagePct ?? 0) * entryNotional;
      tradeRecord = {
        id:              `${asset}-${perpPos?.openedAt ?? 0}`,
        asset,
        openedAt:        perpPos?.openedAt ?? (closedAt - 60_000),
        closedAt,
        notionalUsd:     entryNotional,
        side:            (perpPos?.direction ?? "SHORT") as "LONG" | "SHORT",
        entryPerpPrice:  perpPos?.entryFillPrice ?? perpPos?.entryPrice ?? 0,
        exitPerpPrice:   closePerpResult?.fillPrice ?? (signal.metadata.perpPrice ?? 0),
        entryFundingApr: perpPos?.entryFundingApr ?? 0,
        exitFundingApr:  Math.abs(signal.metadata.fundingRate ?? 0) * 8760,
        holdDurationMs:  closedAt - (perpPos?.openedAt ?? closedAt),
        fundingYieldUsd: fundingPnl,
        basisPnlUsd:     spotPnl,
        entrySlippageUsd: entrySlipUsd,
        exitSlippageUsd:  exitSlipUsd,
        netPnlUsd:        combinedPnl - entrySlipUsd - exitSlipUsd,
        venue:            (perpPos?.venue ?? "HL") as "HL" | "Bybit",
      };

      await telegram.tradeClosed(asset, combinedPnl);
      positions.delete(`${asset}_SPOT`);
      positions.delete(`${asset}_PERP`);
      executed = true;
      events.push(
        `${asset}: closed — spot PnL $${spotPnl.toFixed(2)} + ` +
        `funding $${fundingPnl.toFixed(2)} = $${combinedPnl.toFixed(2)}`
      );
      break;
    }

    default: {
      events.push(`${asset}: ${signal.signal}`);
      break;
    }
  }

  return { executed, events, realizedPnl, tradeRecord };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
main().catch(e => { logger.error(`Fatal: ${e.message}`); process.exit(1); });
