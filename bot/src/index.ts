/**
 * Delta Vault Bot — Main Orchestrator
 * Solana / Drift Protocol / BTC + ETH
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

import { Connection, PublicKey } from "@solana/web3.js";
import { DriftClient } from "@drift-labs/sdk";
import chalk from "chalk";

import { Logger }                                    from "./logger";
import { RealMarketDataEngine, LiveMarketSnapshot }  from "./realMarketData";
import { StrategyEngine, Signal }                    from "./strategyEngine";
import { EnhancedRiskEngine, MarketConditions }      from "./enhancedRiskEngine";
import { LiveExecutionEngine, Asset }               from "./liveExecution";
import { LiquidityGuard }                            from "./liquidityGuard";
import { AnchorVaultClient }                         from "./anchorClient";
import { telegram }                                  from "./telegramAlerts";
import { ServerWallet }                              from "./walletIntegration";
import { THRESHOLDS }                                from "./strategyEngine";
import { debugLog, LogLevel }                        from "./logging";
import { decide, AgentObservation }                  from "./agent/decision";
import { getPositionSize }                           from "./agent/sizing";
import { createInitialState, updateState }           from "./agent/state";
import { logAgent, logDecision }                     from "./agent/logger";

// Cross-chain imports
import { getCrossChainFunding }                       from "./services/crossChainFunding";
import { LendingManager }                             from "./services/lending";
import { evaluateCrossChain }                         from "./strategy/crossChainDecision";
import { executeCrossChain }                          from "./strategy/crossChainExecutor";
import { CROSS_CHAIN_CONFIG }                         from "./config/crossChain";

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
let vaultEquity     = 0; // fetched from Drift at startup
let MIN_TRADE_SIZE  = 100; // Drift spot minimum is $100 USDC; recalculated after equity fetch
const CARRYOVER_DECAY = 0.75; // Retain 75% of carryover per cycle when signal is absent
const AI_AGENT_ENABLED = process.env.AI_AGENT_ENABLED !== "false";

// Comma-separated assets to trade, e.g. "BTC,ETH,SOL,JTO"
const TRADING_ASSETS = (process.env.TRADING_ASSETS ?? "BTC,ETH,SOL,JTO")
  .split(",").map(s => s.trim()).filter(Boolean) as Asset[];

const logger = new Logger("./logs");

function printBanner() {
  logger.info("════════════════════════════════════════════════════");
  logger.info(" ◈ DELTA VAULT BOT");
  logger.info(` Network:     ${NETWORK}`);
  logger.info(` Mode:        ${DEMO_MODE ? "SIMULATION (DEMO_MODE=true)" : "⚡ LIVE TRADING"}`);
  logger.info(` Assets:      ${TRADING_ASSETS.join(" + ")}`);
  logger.info(` Risk cycle:  ${RISK_CYCLE_MS / 1000}s`);
  logger.info(` Trade cycle: ${CYCLE_MS / 1000}s (log every ${LOG_EVERY_N} cycles = ~${(CYCLE_MS * LOG_EVERY_N / 1000).toFixed(0)}s)`);
  logger.info("════════════════════════════════════════════════════");
}

async function measureLatency(conn: Connection): Promise<number> {
  const t = Date.now();
  try { await conn.getSlot(); } catch {}
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

  const rpcUrl = process.env.HELIUS_RPC_URL ?? "";
  if (!rpcUrl || rpcUrl.includes("YOUR_HELIUS_API_KEY")) {
    logger.error("HELIUS_RPC_URL not set. Run: node scripts/setup-devnet.js");
    process.exit(1);
  }

  const connection    = new Connection(rpcUrl, "confirmed");
  const driftClient = new DriftClient({
    connection: connection as any,
    wallet,
    programID: new PublicKey(process.env.DRIFT_PROGRAM_ID ?? "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"),
    accountSubscription: { type: "websocket" },
    env: NETWORK === "mainnet-beta" ? "mainnet-beta" : "devnet",
  });

  await driftClient.subscribe();
  logger.info("DriftClient subscribed ✓");

  // ── Engines ────────────────────────────────────────────────────────────────
  const marketEngine   = new RealMarketDataEngine(driftClient, connection, logger, NETWORK);
  const liquidityGuard = new LiquidityGuard(driftClient, logger);
  const execEngine     = new LiveExecutionEngine(driftClient, connection, wallet, logger);
  const anchorClient   = new AnchorVaultClient(connection, wallet, logger);

  // ── Fetch live USDC balance from Drift account ─────────────────────────────
  // Retry up to 5×2s: handles RPC jitter and WebSocket hydration lag after subscribe()
  let liveEquity = 0;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      liveEquity = await execEngine.getEquity();
      if (liveEquity > 0) break;
      logger.warn(`Equity fetch attempt ${attempt}/5 returned $0 — waiting for account hydration...`);
    } catch (err: any) {
      logger.warn(`Equity fetch attempt ${attempt}/5 failed: ${err.message}`);
    }
    if (attempt < 5) await new Promise(r => setTimeout(r, 2000));
  }

  if (liveEquity <= 0) {
    logger.error("Could not fetch equity after 5 attempts — deposit USDC on Drift first");
    process.exit(1);
  }

  vaultEquity = liveEquity;
  logger.info(`Live vault equity: $${vaultEquity.toFixed(2)} USDC`);

  // Scale MIN_TRADE_SIZE to 2% of equity (floor: Drift spot minimum $100)
  MIN_TRADE_SIZE = Math.max(100, vaultEquity * 0.02);
  logger.info(`Min trade size: $${MIN_TRADE_SIZE.toFixed(2)} (2% of equity, Drift spot minimum $100)`);

  const strategyEngine = new StrategyEngine(logger);
  const riskEngine     = new EnhancedRiskEngine(vaultEquity, logger);

  strategyEngine.setVaultEquity(vaultEquity);
  await marketEngine.start();
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
    await driftClient.unsubscribe();
    logger.close();
    process.exit(0);
  });

  const positions = new Map<string, any>();
  let tick = 0;
  let simulatedPnl = 0; // Simulated profit for demo
  let cumulativeRealizedPnl = 0; // Running total of closed-position PnL
  let cumulativeLendingYield = 0; // Running total of lending yield
  const initialVaultEquity = vaultEquity; // snapshot at bot start for PnL baseline
  let currentStrategies: Record<string, string> = Object.fromEntries(TRADING_ASSETS.map(a => [a, "PARKED"]));
  const lendingManager = new LendingManager(driftClient, logger);
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
      observation: { btcFunding: 0, ethFunding: 0, volatility: 0 },
      decision: null,
      maxSize: 0,
      state: {
        winRate: aiAgentState.winRate,
        confidence: aiAgentState.confidence,
        performance: { ...aiAgentState.performance },
      },
    },
  };

  const apiServer = http.createServer((_, res) => {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
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

  // Scoring functions
  function scoreDeltaNeutral(fundingRate: number, basis: number): number {
    return Math.abs(fundingRate) * 0.7 + Math.abs(basis) * 0.3;
  }

  function scoreLending(): number {
    return 0.05; // baseline safe yield (5%)
  }

  function allocateCapital(deltaScore: number, lendScore: number) {
    const total = deltaScore + lendScore;
    if (total === 0) return { delta: 0, lending: 1 };
    return {
      delta: deltaScore / total,
      lending: lendScore / total,
    };
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
    const result = await lendingManager.deploy(amount);
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
      const latencyMs  = await measureLatency(connection);
      const btcSnap    = marketEngine.getSnapshot("BTC");
      const oracleAgeS = btcSnap ? (Date.now() - btcSnap.timestamp) / 1000 : 0;

      const conditions: MarketConditions = {
        fundingRateVolatility: 0.2,
        solanaLatencyMs:       latencyMs,
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
          for (const asset of TRADING_ASSETS) {
            if (positions.has(`${asset}_SPOT`) || positions.has(`${asset}_PERP`)) {
              logger.risk(`Risk loop: emergency closing ${asset}`);
              await execEngine.closeDeltaNeutral(asset);
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
            await execEngine.closeDeltaNeutral(asset);
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

      // Sweep any incomplete (naked spot) positions left from failed perp orders
      const incomplete = execEngine.getIncompletePositions();
      for (const asset of incomplete) {
        logger.risk(`${asset}: INCOMPLETE position detected (naked spot) — unwinding via risk loop`);
        await execEngine.closeDeltaNeutral(asset);
        positions.delete(`${asset}_SPOT`);
        positions.delete(`${asset}_PERP`);
        strategyEngine.setState(asset, "NONE");
      }

      if (latencyMs > 500)  await telegram.networkCongested(latencyMs);
      if (oracleAgeS > 30)  await telegram.oracleStale("BTC", Math.round(oracleAgeS));

    } catch (e: any) { logger.error(`Risk loop: ${e.message}`); }
  }, RISK_CYCLE_MS);

  // ── Strategy loop — 2s ─────────────────────────────────────────────────────
  while (!stopping) {
    tick++;
    // Only print console output on every LOG_EVERY_N-th cycle (~30s at 2s intervals)
    const shouldLog = tick % LOG_EVERY_N === 1;

    try {
      // Push NAV on-chain
      const btcSnap = marketEngine.getSnapshot("BTC");
      const ethSnap = marketEngine.getSnapshot("ETH");
      if (btcSnap && ethSnap) {
        await anchorClient.updateNav(
          Math.round(btcSnap.spotPrice * 1_000_000),
          Math.round(ethSnap.spotPrice * 1_000_000),
          0, 0, 0
        );
      }

      // ── Cross-Chain Evaluation ───────────────────────────────────────────────
      if (CROSS_CHAIN_CONFIG.ENABLED) {
        try {
          const funding = await getCrossChainFunding(driftClient, logger);
          latestFundingByChain = funding;
          for (const asset of TRADING_ASSETS) {
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

      // ── Data Collection for Logging ──────────────────────────────────────────
      // Refresh vault equity from Drift each cycle so PnL reflects real changes
      try {
        const freshEquity = await execEngine.getEquity();
        if (freshEquity > 0) vaultEquity = freshEquity;
      } catch { /* keep last known value */ }

      let marketData: any = {};
      let strategyData: any = { deltaCapital: 0, lendingCapital: 0 };
      let executionData: any = { executedTrade: false, events: [] as string[] };
      let riskData: any = {};
      let lendingData: any = {
        deployed: 0,
        yieldEarned: 0,
        byAsset: Object.fromEntries(TRADING_ASSETS.map(a => [a, { amount: 0, yield: 0 }])),
      };
      // ── PnL Calculation ──────────────────────────────────────────────────────
      // Strategy PnL = funding earned (from open perp positions) + lending yield + realized closed trades.
      // We deliberately exclude mark-to-market noise (price moves): in a delta-neutral position,
      // the spot leg gain/loss exactly cancels the perp leg gain/loss, leaving only funding yield.
      const openFundingYield = Array.from(execEngine.getOpenPositions().values())
        .reduce((sum, pos) => sum + pos.fundingCollected, 0);
      let pnl = cumulativeRealizedPnl + cumulativeLendingYield + openFundingYield;
      let mode = "BALANCED";
      const totalCapital = vaultEquity;
      const capitalState = { availableCapital: totalCapital };
      const capitalData = {
        starting: totalCapital,
        reservedForTrades: 0,
        releasedFromTrades: 0,
        lent: 0,
        remainingBeforeLending: 0,
        remainingAfterLending: 0,
        carryOver: { total: 0 } as Record<string, number>,
      };
      const plannedLendingByAsset: Record<string, number> = Object.fromEntries(TRADING_ASSETS.map(a => [a, 0]));

      const agentObservation: AgentObservation = {
        btcFunding: btcSnap?.fundingRate ?? 0,
        ethFunding: ethSnap?.fundingRate ?? 0,
        volatility:
          Math.abs((btcSnap?.fundingRate ?? 0) - (ethSnap?.fundingRate ?? 0)) /
          Math.max(Math.abs((btcSnap?.fundingRate ?? 0) + (ethSnap?.fundingRate ?? 0)) / 2, 0.0001),
      };
      const agentDecision = AI_AGENT_ENABLED ? decide(agentObservation, aiAgentState) : null;
      const agentMaxSize = AI_AGENT_ENABLED ? getPositionSize(aiAgentState, agentObservation.volatility) : 0;
      if (agentDecision) {
        logAgent("Observing market...");
        logDecision(agentDecision);
      }

      // Per-asset strategy
      for (const asset of TRADING_ASSETS) {
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

        // Liquidity check
        const liq = await liquidityGuard.checkLiquidity(asset, 10_000);
        if (!liq.allowed) {
          logger.warn(`${asset}: blocked by liquidity guard — ${liq.reason}`);
          continue;
        }

        // ─── CHECK FOR POSITION EXITS ───────────────────────────────────────
        // Before evaluating new signals, check if open positions should be closed
        const currentState = strategyEngine.getState()[asset];
        let signal = strategyEngine.evaluate(snap); // default signal

        if (currentState === "DELTA_NEUTRAL" || currentState === "BASIS_TRADE") {
          // Update position's PnL (reads from Drift user account)
          execEngine.updatePositionPnL(asset, snap.fundingRate);

          // Sync funding-collected (strategy yield) back to the positions map
          // We use fundingCollected (not unrealizedPnl) to avoid MTM noise from price moves.
          // In a perfectly delta-neutral position, spot MTM and perp MTM cancel — only funding remains.
          const openPos = execEngine.getOpenPositions().get(asset);
          const fundingYield = openPos?.fundingCollected ?? 0;
          const perpPos = positions.get(`${asset}_PERP`);
          if (perpPos) perpPos.unrealizedPnl = fundingYield;
          // Spot pnl already updated direction-correctly by the risk loop; leave it alone

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

          // Also check time-based and profit-taking exits via execution engine
          if (!fundingExitEval.shouldClose) {
            const openPositions = execEngine.getOpenPositions();
            const pos = openPositions.get(asset);
            const entryFundingRate = pos?.entryFundingRate ?? snap.fundingRate;

            const timeExitEval = execEngine.evaluatePositionExit(asset, snap.fundingRate, entryFundingRate);
            if (timeExitEval.shouldClose) {
              logger.info(`${asset}: Position exit triggered — ${timeExitEval.reason}`);
              signal = {
                asset,
                signal: currentState === "DELTA_NEUTRAL" ? "DELTA_NEUTRAL_CLOSE" : "BASIS_TRADE_CLOSE",
                reason: timeExitEval.reason,
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
            }
          }
        }

        const fundingRate = snap.fundingRate;
        const basis = snap.basisSpread;
        const liquidityScore = snap.liquidityScore;
        const impact = 0.001; // Drift spot has < 0.1% impact typically

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

        const capitalPerAsset = totalCapital / TRADING_ASSETS.length;
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
        } else if (isOpenSignal) {
          const blockedByAgent = (agentDecision?.action === "SKIP");

          if (blockedByAgent) {
            executionData.events.push(`${asset}: AI agent skipped (${agentDecision.reason})`);
          } else {
            const requestedExecutionUSDRaw = Math.min(
              capitalPerAsset,
              Math.max(0, deltaCapitalAsset + (tradeCarryOver[asset] ?? 0))
            );
            const effectiveAgentCap = AI_AGENT_ENABLED
              ? Math.max(agentMaxSize, MIN_TRADE_SIZE)
              : requestedExecutionUSDRaw;
            const requestedExecutionUSD = AI_AGENT_ENABLED
              ? Math.min(requestedExecutionUSDRaw, effectiveAgentCap)
              : requestedExecutionUSDRaw;

            executionData.events.push(
              `${asset}: sizing raw=$${requestedExecutionUSDRaw.toFixed(0)} | aiCap=$${effectiveAgentCap.toFixed(0)} | final=$${requestedExecutionUSD.toFixed(0)}`
            );

            const reservableAmount = Math.min(requestedExecutionUSD, capitalState.availableCapital);
            if (reservableAmount > 0) {
              executionSizeUSD = allocateForTrade(reservableAmount, capitalState);
              capitalData.reservedForTrades += executionSizeUSD;
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
                });
                await telegram.tradeOpened(asset, tradeType, executionSizeUSD);
                executionData.executedTrade = true;
                executionData.events.push(`${asset}: ${legLabel} ($${executionSizeUSD.toFixed(0)})`);
                strategyData.deltaCapital += executionSizeUSD;
                tradeCarryOver[asset] = Math.max(0, requestedExecutionUSD - executionSizeUSD);
                updateState(aiAgentState, { asset: asset as any, pnl: (Math.random() - 0.45) * 20 });
              }

              if (!DEMO_MODE) {
                const liveExec = await handleSignalLive(signal, asset, executionSizeUSD, execEngine, positions, logger);
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
          strategyEngine.setState(asset, "DELTA_NEUTRAL");
          currentStrategies[asset] = "DELTA_NEUTRAL";
        } else {
          // No position — leave engine state untouched so momentum keeps accumulating.
          // currentStrategies is display-only.
          currentStrategies[asset] = allocation.delta > allocation.lending ? "PARKED" : "LENDING";
        }

      }

      // Lend only leftover capital after all trade reservations/executions.
      capitalData.remainingBeforeLending = capitalState.availableCapital;
      const lendingAmount = allocateForLending(capitalState);
      capitalData.lent = lendingAmount;
      capitalData.remainingAfterLending = capitalState.availableCapital;
      const plannedLendingTotal = TRADING_ASSETS.reduce((s, a) => s + (plannedLendingByAsset[a] ?? 0), 0);
      for (const asset of TRADING_ASSETS) {
        const weight = plannedLendingTotal > 0 ? (plannedLendingByAsset[asset] ?? 0) / plannedLendingTotal : 1 / TRADING_ASSETS.length;
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
        solanaLatencyMs: 100,
        oracleStalenessS: 0,
      };
      // Use actual vault equity for risk assessment, not simulated PnL
      const currentMetrics = riskEngine.assess(vaultEquity, vaultEquity * 0.8, Array.from(positions.values()), currentConditions);
      const deltaExposure = currentMetrics.deltaExposurePct;

      botState.timestamp = Date.now();
      botState.tick = tick;
      // Update dynamic per-asset fields
      for (const a of TRADING_ASSETS) {
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
        ...Object.fromEntries(TRADING_ASSETS.map(a => [a, tradeCarryOver[a] ?? 0])),
        total: TRADING_ASSETS.reduce((s, a) => s + (tradeCarryOver[a] ?? 0), 0),
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
          btcFunding: agentObservation.btcFunding,
          ethFunding: agentObservation.ethFunding,
          volatility: agentObservation.volatility,
        },
        decision: agentDecision,
        maxSize: agentMaxSize,
        state: {
          winRate: aiAgentState.winRate,
          confidence: aiAgentState.confidence,
          performance: { ...aiAgentState.performance },
        },
      };

      // ── Organized Logging (gated to every LOG_EVERY_N cycles) ─────────────
      if (shouldLog) {
      logSection(`Cycle #${tick}`);

      // [MARKET]
      console.log(`\n${chalk.yellow('[MARKET]')}`);
      for (const a of TRADING_ASSETS) {
        if (marketData[a]) {
          console.log(`${a} | $${marketData[a].price.toFixed(2)} | FR ${(marketData[a].fr * 100).toFixed(3)}% | basis ${(marketData[a].basis * 100).toFixed(2)}%`);
        }
      }

      // [STRATEGY]
      console.log(`\n${chalk.blue('[STRATEGY]')}`);
      if (strategyData.deltaCapital > 0) {
        console.log(`Delta Allocation: $${strategyData.deltaCapital.toFixed(2)}`);
      }
      if (strategyData.lendingCapital > 0) {
        console.log(`Lending Allocation: $${strategyData.lendingCapital.toFixed(2)}`);
      }

      // [CAPITAL]
      console.log(`\n${chalk.white('[CAPITAL]')}`);
      console.log(`Starting: $${capitalData.starting.toFixed(2)}`);
      console.log(`Reserved For Trades: $${capitalData.reservedForTrades.toFixed(2)}`);
      console.log(`Released From Failed/Skipped: $${capitalData.releasedFromTrades.toFixed(2)}`);
      console.log(`Remaining Before Lending: $${capitalData.remainingBeforeLending.toFixed(2)}`);
      console.log(`Lent (Leftover): $${capitalData.lent.toFixed(2)}`);
      console.log(`Remaining After Lending: $${capitalData.remainingAfterLending.toFixed(2)}`);
      const carryOverStr = TRADING_ASSETS.map(a => `${a}: $${(tradeCarryOver[a] ?? 0).toFixed(2)}`).join(" | ");
      const carryTotal = TRADING_ASSETS.reduce((s, a) => s + (tradeCarryOver[a] ?? 0), 0);
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
        console.log(
          `Observation | BTC FR ${(agentObservation.btcFunding * 100).toFixed(3)}% | ` +
          `ETH FR ${(agentObservation.ethFunding * 100).toFixed(3)}% | ` +
          `Vol ${agentObservation.volatility.toFixed(3)}`
        );
        console.log(`Decision: ${JSON.stringify(agentDecision)}`);
        console.log(`Max Size: $${agentMaxSize.toFixed(2)}`);
        console.log(
          `State | WinRate ${aiAgentState.winRate.toFixed(2)} | ` +
          `Confidence ${aiAgentState.confidence.toFixed(2)}`
        );
      }

      // [SUMMARY]
      console.log(`\n${chalk.cyan('[SUMMARY]')}`);
      console.log(`PnL: +$${pnl.toFixed(2)} | Mode: ${mode}`);
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
  exec: LiveExecutionEngine,
  positions: Map<string, any>,
  logger: Logger
): Promise<{ executed: boolean; events: string[]; realizedPnl?: number }> {
  const events: string[] = [];
  let executed = false;
  let realizedPnl: number | undefined = undefined;

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
      const type = signal.signal === "DELTA_NEUTRAL_OPEN" ? "DELTA_NEUTRAL" : "BASIS_TRADE";
      const side = signal.metadata.fundingRate < 0 ? "long-perp" : "short-perp";
      const pos  = await exec.openDeltaNeutral({
        side,
        asset,
        amount: executionSizeUSD,
        fundingRate: signal.metadata.fundingRate,
      });
      if (pos) {
        positions.set(`${asset}_SPOT`, pos);
        await telegram.tradeOpened(asset, type, executionSizeUSD);
        executed = true;
        events.push(`${asset}: ${type} opened ($${executionSizeUSD.toFixed(0)})`);
      } else {
        events.push(`${asset}: ${type} open failed`);
      }
      break;
    }
    case "DELTA_NEUTRAL_CLOSE":
    case "BASIS_TRADE_CLOSE": {
      if (!positions.has(`${asset}_SPOT`)) {
        events.push(`${asset}: no open position to close`);
        break;
      }
      await exec.closeDeltaNeutral(asset);
      const spotPos = positions.get(`${asset}_SPOT`);
      const perpPos = positions.get(`${asset}_PERP`);
      const combinedPnl = (spotPos?.unrealizedPnl ?? 0) + (perpPos?.unrealizedPnl ?? 0);
      realizedPnl = combinedPnl;
      await telegram.tradeClosed(asset, combinedPnl);
      positions.delete(`${asset}_SPOT`);
      positions.delete(`${asset}_PERP`);
      executed = true;
      events.push(`${asset}: position closed (PnL $${combinedPnl.toFixed(2)})`);
      break;
    }
    default: {
      events.push(`${asset}: ${signal.signal}`);
      break;
    }
  }

  return { executed, events, realizedPnl };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
main().catch(e => { logger.error(`Fatal: ${e.message}`); process.exit(1); });
