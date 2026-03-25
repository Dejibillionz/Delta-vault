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

  // Cross-chain state
  let currentChain = "solana";
  let lastCrossChainTime = 0;

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
          const decision = evaluateCrossChain({
            currentChain,
            fundingRates: funding,
            capital: VAULT_EQUITY,
            lastExecutionTime: lastCrossChainTime,
            logger,
          });

          logger.info(`🌉 Cross-chain decision: ${JSON.stringify(decision)}`);

          if (decision.execute) {
            const result = await executeCrossChain({
              fromChain: currentChain,
              toChain: decision.bestChain!,
              amount: decision.allocation!,
              logger,
            });

            if (result.success) {
              currentChain = decision.bestChain!;
              lastCrossChainTime = Date.now();
              logger.info(`✅ Cross-chain move completed: ${currentChain}`);
            } else {
              logger.error(`❌ Cross-chain move failed`);
            }
          }
        } catch (err: any) {
          logger.error(`Cross-chain eval error: ${err.message}`);
        }
      }

      // ── Data Collection for Logging ──────────────────────────────────────────
      let marketData: any = {};
      let strategyData: any = { deltaCapital: 0, lendingCapital: 0 };
      let executionData: any = { executedTrade: false };
      let riskData: any = {};
      let lendingData: any = { deployed: 0, yieldEarned: 0 };
      let pnl = simulatedPnl;
      let mode = "BALANCED";

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

        const capitalPerAsset = VAULT_EQUITY / 2; // split between BTC and ETH
        const deltaCapitalAsset = capitalPerAsset * finalAllocation.delta;
        const lendingCapitalAsset = capitalPerAsset * finalAllocation.lending;

        // Accumulate for logging
        strategyData.deltaCapital += deltaCapitalAsset;
        strategyData.lendingCapital += lendingCapitalAsset;

        // Strategy state tracking
        if (finalAllocation.delta > 0.7) mode = "AGGRESSIVE";
        else if (finalAllocation.delta < 0.3) mode = "DEFENSIVE";

        // Execute both strategies
        if (deltaCapitalAsset > 1000) { // minimum trade size
          // Handle trade
          if (signal.signal === "DELTA_NEUTRAL_OPEN") {
            if (DEMO_MODE) {
              logger.trade(`[DEMO] ${asset} DELTA_NEUTRAL: spot long + perp short $${deltaCapitalAsset.toFixed(0)}`);
              strategyEngine.setState(asset, "DELTA_NEUTRAL");
              currentStrategies[asset] = "DELTA_NEUTRAL";
              // Store both legs
              positions.set(`${asset}_SPOT`, {
                asset,
                baseAmount: deltaCapitalAsset / snap.spotPrice,
                quoteAmount: deltaCapitalAsset,
                entryPrice: snap.spotPrice,
                markPrice: snap.spotPrice,
                unrealizedPnl: 0,
                direction: "LONG",
              });
              positions.set(`${asset}_PERP`, {
                asset,
                baseAmount: deltaCapitalAsset / snap.perpPrice,
                quoteAmount: deltaCapitalAsset,
                entryPrice: snap.perpPrice,
                markPrice: snap.perpPrice,
                unrealizedPnl: 0,
                direction: "SHORT",
              });
              await telegram.tradeOpened(asset, "DELTA_NEUTRAL", deltaCapitalAsset);
              executionData.executedTrade = true;
            }
          }
        }

        if (lendingCapitalAsset > 1000) {
          const yieldEarned = await deployToLending(asset, lendingCapitalAsset);
          lendingData.deployed += lendingCapitalAsset;
          lendingData.yieldEarned += yieldEarned;
        }

        // Update strategy state
        if (allocation.delta > allocation.lending) {
          strategyEngine.setState(asset, "DELTA_NEUTRAL");
          currentStrategies[asset] = "DELTA_NEUTRAL";
        } else {
          strategyEngine.setState(asset, "PARKED");
          currentStrategies[asset] = "LENDING";
        }

        if (!DEMO_MODE) {
          await handleSignalLive(signal, asset, execEngine, positions, logger);
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

      // [EXECUTION]
      console.log(`\n${chalk.green('[EXECUTION]')}`);
      if (executionData.executedTrade) {
        console.log(`${chalk.green('✔')} Delta-neutral position opened`);
      } else {
        console.log(`${chalk.gray('•')} No trade executed`);
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
  exec: LiveExecutionEngine,
  positions: Map<string, any>,
  logger: Logger
) {
  switch (signal.signal) {
    case "DELTA_NEUTRAL_OPEN":
    case "BASIS_TRADE_OPEN": {
      if (positions.has(`${asset}_SPOT`)) break;
      const type = signal.signal === "DELTA_NEUTRAL_OPEN" ? "DELTA_NEUTRAL" : "BASIS_TRADE";
      const pos  = await exec.openDeltaNeutral(asset, signal.suggestedSizeUSD, signal.metadata.fundingRate);
      if (pos) {
        positions.set(asset, pos);
        await telegram.tradeOpened(asset, type, signal.suggestedSizeUSD);
      }
      break;
    }
    case "DELTA_NEUTRAL_CLOSE":
    case "BASIS_TRADE_CLOSE": {
      if (!positions.has(`${asset}_SPOT`)) break;
      await exec.closeDeltaNeutral(asset);
      const spotPos = positions.get(`${asset}_SPOT`);
      const perpPos = positions.get(`${asset}_PERP`);
      const combinedPnl = (spotPos?.unrealizedPnl ?? 0) + (perpPos?.unrealizedPnl ?? 0);
      await telegram.tradeClosed(asset, combinedPnl);
      positions.delete(`${asset}_SPOT`);
      positions.delete(`${asset}_PERP`);
      break;
    }
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
main().catch(e => { logger.error(`Fatal: ${e.message}`); process.exit(1); });
