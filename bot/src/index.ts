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
import { DriftClient, BulkAccountLoader } from "@drift-labs/sdk";
import chalk from "chalk";

import { Logger }                                    from "./logger";
import { RealMarketDataEngine, LiveMarketSnapshot }  from "./realMarketData";
import { StrategyEngine, Signal }                    from "./strategyEngine";
import { EnhancedRiskEngine, MarketConditions }      from "./enhancedRiskEngine";
import { LiveExecutionEngine }                       from "./liveExecution";
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
const CYCLE_MS      = 30_000;
const RISK_CYCLE_MS = 10_000;
const VAULT_EQUITY  = 250_000;
const MIN_TRADE_SIZE = 1_000;
const CARRYOVER_DECAY = 0.75; // Retain 75% of carryover per cycle when signal is absent
const AI_AGENT_ENABLED = process.env.AI_AGENT_ENABLED !== "false";

const logger = new Logger("./logs");

function printBanner() {
  logger.info("════════════════════════════════════════════════════");
  logger.info(" ◈ DELTA VAULT BOT");
  logger.info(` Network:     ${NETWORK}`);
  logger.info(` Mode:        ${DEMO_MODE ? "SIMULATION (DEMO_MODE=true)" : "⚡ LIVE TRADING"}`);
  logger.info(` Assets:      BTC + ETH`);
  logger.info(` Risk cycle:  ${RISK_CYCLE_MS / 1000}s`);
  logger.info(` Trade cycle: ${CYCLE_MS / 1000}s`);
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
  const accountLoader = new BulkAccountLoader(connection as any, "confirmed", 1000);
  const driftClient = new DriftClient({
  connection: connection as any,
    wallet:    wallet as any,
    programID: new PublicKey(process.env.DRIFT_PROGRAM_ID ?? "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"),
    accountSubscription: { type: "polling", accountLoader },
    env: NETWORK === "mainnet-beta" ? "mainnet-beta" : "devnet",
  });

  await driftClient.subscribe();
  logger.info("DriftClient subscribed ✓");

  // ── Engines ────────────────────────────────────────────────────────────────
  const marketEngine   = new RealMarketDataEngine(driftClient, connection, logger, NETWORK);
  const strategyEngine = new StrategyEngine(logger);
  const riskEngine     = new EnhancedRiskEngine(VAULT_EQUITY, logger);
  const liquidityGuard = new LiquidityGuard(driftClient, logger);
  const execEngine     = new LiveExecutionEngine(driftClient, connection, wallet, logger);
  const anchorClient   = new AnchorVaultClient(connection, wallet, logger);

  strategyEngine.setVaultEquity(VAULT_EQUITY);
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
  let currentStrategies: Record<string, string> = { BTC: "PARKED", ETH: "PARKED" };
  let previousSnapshots: Record<string, LiveMarketSnapshot> = {};
  let latestDrawdown = 0;
  let tradeCarryOver: Record<"BTC" | "ETH", number> = { BTC: 0, ETH: 0 };
  const aiAgentState = createInitialState();

  // Cross-chain state (independent by asset)
  const currentChains: Record<"BTC" | "ETH", string> = { BTC: "solana", ETH: "solana" };
  const lastCrossChainTimes: Record<"BTC" | "ETH", number> = { BTC: 0, ETH: 0 };
  let latestCrossChainDecisions: Record<"BTC" | "ETH", any> = {
    BTC: { execute: false, reason: "Waiting" },
    ETH: { execute: false, reason: "Waiting" },
  };
  let latestFundingByChain: Record<string, { BTC: number; ETH: number }> = {};

  const botState: any = {
    timestamp: Date.now(),
    tick: 0,
    mode: DEMO_MODE ? "SIMULATION" : "LIVE",
    network: NETWORK,
    prices: { BTC: 0, ETH: 0 },
    funding: { BTC: 0, ETH: 0 },
    basis: { BTC: 0, ETH: 0 },
    signals: { BTC: "PARKED", ETH: "PARKED" },
    positionsCount: 0,
    nav: VAULT_EQUITY,
    pnl: 0,
    drawdown: 0,
    deltaExposure: 0,
    lending: { deployed: 0, yield: 0 },
    lendingByAsset: { BTC: { amount: 0, yield: 0 }, ETH: { amount: 0, yield: 0 } },
    positions: [] as any[],
    executionEvents: [] as string[],
    execution: { executedTrade: false, events: [] as string[] },
    capital: {
      starting: VAULT_EQUITY,
      reservedForTrades: 0,
      releasedFromTrades: 0,
      lent: 0,
      remainingBeforeLending: 0,
      remainingAfterLending: 0,
      carryOver: { BTC: 0, ETH: 0, total: 0 },
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
    // simulate yield
    const apy = 0.08; // 8% yearly
    const perCycleYield = (amount * apy) / (365 * 24 * 60); // per minute approx
    simulatedPnl += perCycleYield;
    currentStrategies[asset] = "LENDING";
    return perCycleYield;
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
          // Use appropriate price for each leg
          const isSpot = key.includes('_SPOT');
          pos.markPrice = isSpot ? snap.spotPrice : snap.perpPrice;
          pos.unrealizedPnl = (pos.entryPrice - pos.markPrice) * pos.baseAmount;
        }
      }

      const metrics = riskEngine.assess(VAULT_EQUITY, VAULT_EQUITY * 0.8, Array.from(positions.values()), conditions);
      latestDrawdown = metrics.drawdown;
      debugLog(riskEngine.formatReport(metrics));

      // Push risk oracle on-chain
      await anchorClient.updateRiskOracle(
        Math.round(metrics.drawdown * 10_000),
        Math.round(metrics.deltaExposurePct * 10_000),
        metrics.worstAction === "PAUSE_EXECUTION" ? 1 : 0
      );

      // Handle critical events
      for (const ev of metrics.riskEvents) {
        if (ev.action === "EMERGENCY_CLOSE") {
          await telegram.emergencyStop(ev.message);
          if (!DEMO_MODE) await execEngine.emergencyCloseAll();
        }
        if (["HIGH", "CRITICAL"].includes(ev.severity) && ev.action !== "NORMAL") {
          await telegram.riskAlert(ev.message, metrics.drawdown, metrics.deltaExposurePct);
        }
      }

      if (latencyMs > 500)  await telegram.networkCongested(latencyMs);
      if (oracleAgeS > 30)  await telegram.oracleStale("BTC", Math.round(oracleAgeS));

    } catch (e: any) { logger.error(`Risk loop: ${e.message}`); }
  }, RISK_CYCLE_MS);

  // ── Strategy loop — 30s ────────────────────────────────────────────────────
  while (!stopping) {
    tick++;

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
          for (const asset of ["BTC", "ETH"] as const) {
            const decision = evaluateCrossChain({
              asset,
              currentChain: currentChains[asset],
              fundingRates: funding,
              capital: VAULT_EQUITY / 2,
              lastExecutionTime: lastCrossChainTimes[asset],
              logger,
            });

            logger.info(
              `🌉 Cross-chain decision (${asset}): ${decision.reason} | ` +
              `from=${decision.currentChain} to=${decision.bestChain ?? decision.currentChain} | ` +
              `edge=${((decision.netEdge ?? 0) * 100).toFixed(4)}% | ` +
              `estProfit=$${(decision.expectedProfitUsd ?? 0).toFixed(2)}`
            );
            latestCrossChainDecisions[asset] = decision;

            if (decision.execute) {
              const result = await executeCrossChain({
                asset,
                fromChain: currentChains[asset],
                toChain: decision.bestChain!,
                amount: decision.allocation!,
                logger,
              });

              if (result.success) {
                currentChains[asset] = decision.bestChain!;
                lastCrossChainTimes[asset] = Date.now();
                logger.info(`✅ Cross-chain move completed (${asset}): ${currentChains[asset]}`);
              } else {
                logger.error(`❌ Cross-chain move failed (${asset})`);
              }
            }
          }
        } catch (err: any) {
          logger.error(`Cross-chain eval error: ${err.message}`);
        }
      }

      // ── Data Collection for Logging ──────────────────────────────────────────
      let marketData: any = {};
      let strategyData: any = { deltaCapital: 0, lendingCapital: 0 };
      let executionData: any = { executedTrade: false, events: [] as string[] };
      let riskData: any = {};
      let lendingData: any = { deployed: 0, yieldEarned: 0, byAsset: { BTC: { amount: 0, yield: 0 }, ETH: { amount: 0, yield: 0 } } };
      let pnl = simulatedPnl;
      let mode = "BALANCED";
      const totalCapital = VAULT_EQUITY;
      const capitalState = { availableCapital: totalCapital };
      const capitalData = {
        starting: totalCapital,
        reservedForTrades: 0,
        releasedFromTrades: 0,
        lent: 0,
        remainingBeforeLending: 0,
        remainingAfterLending: 0,
        carryOver: { BTC: 0, ETH: 0, total: 0 },
      };
      const plannedLendingByAsset: Record<"BTC" | "ETH", number> = { BTC: 0, ETH: 0 };

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
      for (const asset of ["BTC", "ETH"] as const) {
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

        riskEngine.recordFundingRate(asset, snap.fundingRate);

        // Liquidity check
        const liq = await liquidityGuard.checkLiquidity(asset, 10_000);
        if (!liq.allowed) {
          logger.warn(`${asset}: blocked by liquidity guard — ${liq.reason}`);
          continue;
        }

        // Signal
        const signal = strategyEngine.evaluate(snap);

        const fundingRate = snap.fundingRate;
        const basis = snap.basisSpread;
        const liquidityScore = snap.liquidityScore;
        const impact = liq.estimatedImpactPct;

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

        const capitalPerAsset = totalCapital / 2; // split between BTC and ETH
        const deltaCapitalAsset = Math.min(capitalPerAsset, Math.max(0, capitalPerAsset * finalAllocation.delta));
        plannedLendingByAsset[asset] = Math.min(capitalPerAsset, Math.max(0, capitalPerAsset * finalAllocation.lending));

        // Strategy state tracking
        if (finalAllocation.delta > 0.7) mode = "AGGRESSIVE";
        else if (finalAllocation.delta < 0.3) mode = "DEFENSIVE";

        // Capital manager: reserve for trade first, then lend leftover later
        const isOpenSignal = signal.signal === "DELTA_NEUTRAL_OPEN" || signal.signal === "BASIS_TRADE_OPEN";
        let executionSizeUSD = 0;
        if (isOpenSignal) {
          const blockedByAgent =
            (agentDecision?.action === "SKIP") ||
            (agentDecision?.action === "TRADE" && agentDecision.asset !== asset);

          if (blockedByAgent) {
            if (agentDecision?.action === "SKIP") {
              executionData.events.push(`${asset}: AI agent skipped (${agentDecision.reason})`);
            } else if (agentDecision?.action === "TRADE") {
              executionData.events.push(`${asset}: AI agent selected ${agentDecision.asset}`);
            }
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
                updateState(aiAgentState, { asset, pnl: (Math.random() - 0.45) * 20 });
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
                    updateState(aiAgentState, { asset, pnl: liveExec.realizedPnl });
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

        // Update strategy state — driven by actual open positions, NOT just allocation ratios.
        // This ensures a CLOSE signal's state reset isn't overwritten by a blanket setState call.
        const hasOpenDeltaPos = positions.has(`${asset}_SPOT`) || positions.has(`${asset}_PERP`);
        if (hasOpenDeltaPos) {
          strategyEngine.setState(asset, "DELTA_NEUTRAL");
          currentStrategies[asset] = "DELTA_NEUTRAL";
        } else if (allocation.delta > allocation.lending) {
          // Allocation wants delta exposure but no position yet — stay NONE so engine can enter next cycle
          strategyEngine.setState(asset, "NONE");
          currentStrategies[asset] = "PARKED";
        } else {
          strategyEngine.setState(asset, "PARKED");
          currentStrategies[asset] = "LENDING";
        }

      }

      // Lend only leftover capital after all trade reservations/executions.
      capitalData.remainingBeforeLending = capitalState.availableCapital;
      const lendingAmount = allocateForLending(capitalState);
      capitalData.lent = lendingAmount;
      capitalData.remainingAfterLending = capitalState.availableCapital;
      const plannedLendingTotal = plannedLendingByAsset.BTC + plannedLendingByAsset.ETH;
      for (const asset of ["BTC", "ETH"] as const) {
        const weight = plannedLendingTotal > 0 ? plannedLendingByAsset[asset] / plannedLendingTotal : 0.5;
        const lendingCapitalAsset = lendingAmount * weight;
        if (lendingCapitalAsset > 1000) {
          const yieldEarned = await deployToLending(asset, lendingCapitalAsset);
          lendingData.deployed += lendingCapitalAsset;
          lendingData.yieldEarned += yieldEarned;
          lendingData.byAsset[asset].amount += lendingCapitalAsset;
          lendingData.byAsset[asset].yield += yieldEarned;
          executionData.events.push(`${asset}: lending deployed ($${lendingCapitalAsset.toFixed(0)})`);
          strategyData.lendingCapital += lendingCapitalAsset;
        }
      }

      // Calculate NAV and risk metrics
      const nav = VAULT_EQUITY + pnl;
      const drawdown = latestDrawdown;
      // Get current risk metrics for logging
      const currentConditions: MarketConditions = {
        fundingRateVolatility: 0.2,
        solanaLatencyMs: 100,
        oracleStalenessS: 0,
      };
      const currentMetrics = riskEngine.assess(nav, VAULT_EQUITY * 0.8, Array.from(positions.values()), currentConditions);
      const deltaExposure = currentMetrics.deltaExposurePct;

      botState.timestamp = Date.now();
      botState.tick = tick;
      botState.prices = {
        BTC: marketData.BTC?.price ?? 0,
        ETH: marketData.ETH?.price ?? 0,
      };
      botState.funding = {
        BTC: marketData.BTC?.fr ?? 0,
        ETH: marketData.ETH?.fr ?? 0,
      };
      botState.basis = {
        BTC: marketData.BTC?.basis ?? 0,
        ETH: marketData.ETH?.basis ?? 0,
      };
      botState.signals = {
        BTC: currentStrategies.BTC ?? "PARKED",
        ETH: currentStrategies.ETH ?? "PARKED",
      };
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
        BTC: tradeCarryOver.BTC,
        ETH: tradeCarryOver.ETH,
        total: tradeCarryOver.BTC + tradeCarryOver.ETH,
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

      // ── Organized Logging ───────────────────────────────────────────────────
      logSection(`Cycle #${tick}`);

      // [MARKET]
      console.log(`\n${chalk.yellow('[MARKET]')}`);
      if (marketData.BTC) {
        console.log(`BTC | $${marketData.BTC.price.toFixed(0)} | FR ${(marketData.BTC.fr * 100).toFixed(3)}% | basis ${(marketData.BTC.basis * 100).toFixed(2)}%`);
      }
      if (marketData.ETH) {
        console.log(`ETH | $${marketData.ETH.price.toFixed(0)} | FR ${(marketData.ETH.fr * 100).toFixed(3)}% | basis ${(marketData.ETH.basis * 100).toFixed(2)}%`);
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
      console.log(`CarryOver BTC: $${tradeCarryOver.BTC.toFixed(2)} | ETH: $${tradeCarryOver.ETH.toFixed(2)} | Total: $${(tradeCarryOver.BTC + tradeCarryOver.ETH).toFixed(2)}`);

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
          `Confidence ${aiAgentState.confidence.toFixed(2)} | ` +
          `Perf BTC $${aiAgentState.performance.BTC.toFixed(2)} | ` +
          `Perf ETH $${aiAgentState.performance.ETH.toFixed(2)}`
        );
      }

      // [SUMMARY]
      console.log(`\n${chalk.cyan('[SUMMARY]')}`);
      console.log(`PnL: +$${pnl.toFixed(2)} | Mode: ${mode}`);

      // Simulate profit accumulation for demo
      simulatedPnl += Math.random() * 5;

      // Telegram cycle summary (every 10 cycles)
      await telegram.cycleUpdate({
        tick,
        nav:       VAULT_EQUITY,
        pnl:       simulatedPnl,
        positions: positions.size,
        btcSignal: currentStrategies.BTC ?? "—",
        ethSignal: currentStrategies.ETH ?? "—",
      });

    } catch (e: any) { logger.error(`Strategy loop: ${e.message}`); }

    logger.info(`─── Cycle #${tick} done — waiting ${CYCLE_MS / 1000}s\n`);
    await sleep(CYCLE_MS);
  }

  clearInterval(riskLoop);
}

async function handleSignalLive(
  signal: Signal,
  asset: "BTC" | "ETH",
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
        positions.set(asset, pos);
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
