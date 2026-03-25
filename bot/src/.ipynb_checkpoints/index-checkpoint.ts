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

import { Logger }                                    from "./logger";
import { RealMarketDataEngine, LiveMarketSnapshot }  from "./realMarketData";
import { StrategyEngine, Signal }                    from "./strategyEngine";
import { EnhancedRiskEngine, MarketConditions }      from "./enhancedRiskEngine";
import { LiveExecutionEngine }                       from "./liveExecution";
import { LiquidityGuard }                            from "./liquidityGuard";
import { AnchorVaultClient }                         from "./anchorClient";
import { telegram }                                  from "./telegramAlerts";
import { ServerWallet }                              from "./walletIntegration";

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
  const marketEngine   = new RealMarketDataEngine(driftClient, connection, logger);
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

      const metrics = riskEngine.assess(VAULT_EQUITY, VAULT_EQUITY * 0.8, Array.from(positions.values()), conditions);
      logger.debug(riskEngine.formatReport(metrics));

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
    logger.info(`─── Cycle #${tick} ───`);

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

      // Per-asset strategy
      for (const asset of ["BTC", "ETH"] as const) {
        const snap = marketEngine.getSnapshot(asset);
        if (!snap) { logger.warn(`${asset}: no snapshot`); continue; }

        logger.info(
          `${asset} | $${snap.spotPrice.toFixed(0)} | ` +
          `FR ${(snap.fundingRate * 100).toFixed(4)}% | ` +
          `basis ${(snap.basisSpread * 100).toFixed(2)}%`
        );

        riskEngine.recordFundingRate(asset, snap.fundingRate);

        // Liquidity check
        const liq = await liquidityGuard.checkLiquidity(asset, 10_000);
        if (!liq.allowed) {
          logger.warn(`${asset}: blocked by liquidity guard — ${liq.reason}`);
          continue;
        }

        // Signal
        const signal = strategyEngine.evaluate(snap);
        logger.info(`${asset}: ${signal.signal} — ${signal.reason}`);

        // Update on-chain strategy state
        const modeMap: Record<string, "DeltaNeutral" | "BasisTrade" | "ParkCapital"> = {
          DELTA_NEUTRAL_OPEN: "DeltaNeutral",
          DELTA_NEUTRAL_CLOSE: "ParkCapital",
          BASIS_TRADE_OPEN:   "BasisTrade",
          BASIS_TRADE_CLOSE:  "ParkCapital",
          PARK_CAPITAL:       "ParkCapital",
        };
        if (modeMap[signal.signal]) {
          await anchorClient.updateStrategy(modeMap[signal.signal]);
        }

        if (DEMO_MODE) {
          // Demo mode: log intent, send Telegram, but don't place orders
          if (signal.signal === "DELTA_NEUTRAL_OPEN") {
            logger.trade(`[DEMO] ${asset} DELTA_NEUTRAL: spot long + perp short $${signal.suggestedSizeUSD.toFixed(0)}`);
            await telegram.tradeOpened(asset, "DELTA_NEUTRAL", signal.suggestedSizeUSD);
          } else if (signal.signal === "BASIS_TRADE_OPEN") {
            logger.trade(`[DEMO] ${asset} BASIS_TRADE: $${signal.suggestedSizeUSD.toFixed(0)}`);
            await telegram.tradeOpened(asset, "BASIS_TRADE", signal.suggestedSizeUSD);
          } else if (signal.signal.endsWith("_CLOSE")) {
            logger.trade(`[DEMO] ${asset} closing position`);
            await telegram.tradeClosed(asset, 0);
          }
        } else {
          await handleSignalLive(signal, asset, execEngine, positions, logger);
        }
      }

      // Telegram cycle summary (every 10 cycles)
      await telegram.cycleUpdate({
        tick,
        nav:       VAULT_EQUITY,
        pnl:       0,
        positions: positions.size,
        btcSignal: strategyEngine.getState()?.BTC ?? "—",
        ethSignal: strategyEngine.getState()?.ETH ?? "—",
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
      if (positions.has(asset)) break;
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
      if (!positions.has(asset)) break;
      await exec.closeDeltaNeutral(asset);
      const pos = positions.get(asset);
      await telegram.tradeClosed(asset, pos?.unrealizedPnl ?? 0);
      positions.delete(asset);
      break;
    }
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
main().catch(e => { logger.error(`Fatal: ${e.message}`); process.exit(1); });
