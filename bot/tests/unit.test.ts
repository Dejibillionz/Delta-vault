/**
 * Basic unit tests — run with:  npm test
 * (npx ts-node tests/unit.test.ts)
 *
 * Tests the core logic layers without any network or blockchain dependencies.
 * Uses Node built-in assert — no test framework needed.
 */

import assert from "assert";
import { StrategyEngine } from "../src/strategyEngine";
import { EnhancedRiskEngine, MarketConditions } from "../src/enhancedRiskEngine";
import { getPositionSize } from "../src/agent/sizing";
import { createInitialState } from "../src/agent/state";
import { Logger } from "../src/logger";
import { FundingPersistencePredictor } from "../src/services/fundingPersistence";

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e: any) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

// Shared logger pointing to /tmp so tests don't create files in repo
const logger = new Logger("/tmp/delta-vault-test-logs");

// ── StrategyEngine tests ──────────────────────────────────────────────────────
console.log("\n── StrategyEngine ─────────────────────────────────────────");

const BASE_SNAP = {
  asset: "BTC",
  timestamp: Date.now(),
  spotPrice: 70_000,
  perpPrice: 70_000,
  indexPrice: 70_000,
  fundingRate: 0,
  fundingRateAnnualized: 0,
  nextFundingTime: Date.now() + 3_600_000,
  basisSpread: 0,
  basisUSD: 0,
  openInterest: 500_000,
  dailyVolumeUsd: 50_000_000,
  longShortRatio: 0.5,
  liquidityScore: 0.9,
  pythConfidence: 0.001,
  oiChangeRatePct: 0,
  atrPct: 0,
};

test("PARK_CAPITAL when funding near zero", () => {
  const eng = new StrategyEngine(logger);
  const sig = eng.evaluate({ ...BASE_SNAP, fundingRate: 0.0000005 }); // below 0.000001 threshold
  assert.strictEqual(sig.signal, "PARK_CAPITAL",
    `Expected PARK_CAPITAL, got ${sig.signal}`);
});

test("evaluate returns structured Signal object", () => {
  const eng = new StrategyEngine(logger);
  const sig = eng.evaluate({ ...BASE_SNAP, fundingRate: 0.0003 });
  assert.ok(typeof sig.signal === "string",   "signal must be a string");
  assert.ok(typeof sig.asset  === "string",   "asset must be a string");
  assert.ok(typeof sig.reason === "string",   "reason must be a string");
  assert.ok(typeof sig.suggestedSizeUSD === "number", "suggestedSizeUSD must be a number");
});

test("evaluate with high positive funding returns OPEN or accumulates toward OPEN", () => {
  const eng = new StrategyEngine(logger);
  const sig = eng.evaluate({ ...BASE_SNAP, fundingRate: 0.0003 });
  assert.ok(
    ["DELTA_NEUTRAL_OPEN", "PARK_CAPITAL", "NO_ACTION"].includes(sig.signal),
    `Unexpected signal: ${sig.signal}`
  );
});

test("evaluate with negative funding does not return positive-funding CLOSE", () => {
  const eng = new StrategyEngine(logger);
  const sig = eng.evaluate({ ...BASE_SNAP, fundingRate: -0.0003 });
  assert.notStrictEqual(sig.signal, "DELTA_NEUTRAL_CLOSE",
    "Negative-funding open should not produce a CLOSE signal");
});

test("shouldExitFundingBased returns structured result", () => {
  const eng = new StrategyEngine(logger);
  eng.setState("BTC", "DELTA_NEUTRAL");
  const result = eng.shouldExitFundingBased("BTC", 0.0003);
  assert.ok(typeof result.shouldClose === "boolean", "shouldClose must be boolean");
  assert.ok(typeof result.reason === "string",       "reason must be a string");
});

test("shouldExitFundingBased does not close on stable positive funding", () => {
  const eng = new StrategyEngine(logger);
  eng.setState("BTC", "DELTA_NEUTRAL");
  const result = eng.shouldExitFundingBased("BTC", 0.0003);
  assert.strictEqual(result.shouldClose, false,
    "Should not close position on sustained positive funding");
});

test("setState resets state — no stale CLOSE after reset", () => {
  const eng = new StrategyEngine(logger);
  eng.setState("BTC", "DELTA_NEUTRAL");
  eng.setState("BTC", "NONE");
  const sig = eng.evaluate({ ...BASE_SNAP, fundingRate: 0.0003 });
  assert.notStrictEqual(sig.signal, "DELTA_NEUTRAL_CLOSE",
    "Should not emit CLOSE immediately after state reset");
});

test("evaluate uses asset from snapshot, not separate arg", () => {
  const eng = new StrategyEngine(logger);
  const sig = eng.evaluate({ ...BASE_SNAP, asset: "ETH", fundingRate: 0 });
  assert.strictEqual(sig.asset, "ETH", "Signal asset should match snapshot asset");
});

// ── EnhancedRiskEngine tests ──────────────────────────────────────────────────
console.log("\n── EnhancedRiskEngine ─────────────────────────────────────");

const INITIAL_EQUITY = 10_000;
const NORMAL_CONDITIONS: MarketConditions = {
  fundingRateVolatility: 0.05,
  solanaRpcLatencyMs: 100,
  hlLatencyMs: 0,
  oracleStalenessS: 5,
};
const EMPTY_POSITIONS: any[] = [];

function freshRisk() {
  return new EnhancedRiskEngine(INITIAL_EQUITY, logger);
}

test("NORMAL / low-severity on healthy conditions", () => {
  const re = freshRisk();
  const m = re.assess(INITIAL_EQUITY, INITIAL_EQUITY * 1.25, EMPTY_POSITIONS, NORMAL_CONDITIONS);
  assert.ok(["NORMAL", "ALERT_ONLY"].includes(m.worstAction),
    `Expected low-severity action, got ${m.worstAction}`);
});

test("EMERGENCY_CLOSE when drawdown exceeds 10%", () => {
  const re = freshRisk();
  const collapsed = INITIAL_EQUITY * 0.88; // 12% drawdown
  const m = re.assess(collapsed, collapsed * 1.25, EMPTY_POSITIONS, NORMAL_CONDITIONS);
  assert.strictEqual(m.worstAction, "EMERGENCY_CLOSE",
    `Expected EMERGENCY_CLOSE, got ${m.worstAction}`);
});

test("PAUSE_EXECUTION on high HL latency", () => {
  const re = freshRisk();
  const m = re.assess(INITIAL_EQUITY, INITIAL_EQUITY * 1.25, EMPTY_POSITIONS, {
    ...NORMAL_CONDITIONS, hlLatencyMs: 2500,
  });
  assert.ok(
    ["PAUSE_EXECUTION", "EMERGENCY_CLOSE"].includes(m.worstAction),
    `Expected PAUSE_EXECUTION, got ${m.worstAction}`
  );
});

test("HALT_NEW_TRADES when free collateral ratio falls below 20%", () => {
  const re = freshRisk();
  // free collateral = equity / collateral; 0.15 ratio = equity barely covers collateral
  const collateral = INITIAL_EQUITY / 0.15;
  const m = re.assess(INITIAL_EQUITY, collateral, EMPTY_POSITIONS, NORMAL_CONDITIONS);
  assert.ok(
    ["HALT_NEW_TRADES", "PAUSE_EXECUTION", "EMERGENCY_CLOSE"].includes(m.worstAction),
    `Expected halt action, got ${m.worstAction}`
  );
});

test("high drawdown warning (5–10%) produces WARNING or above", () => {
  const re = freshRisk();
  const equity07 = INITIAL_EQUITY * 0.93; // 7% drawdown
  const m = re.assess(equity07, equity07 * 1.25, EMPTY_POSITIONS, NORMAL_CONDITIONS);
  assert.ok(
    ["ALERT_ONLY", "WARNING", "HALT_NEW_TRADES", "PAUSE_EXECUTION", "EMERGENCY_CLOSE"].includes(m.worstAction),
    `Expected at least a warning-level action, got ${m.worstAction}`
  );
});

test("CLOSE_POSITION when single asset loss > 7%", () => {
  const re = freshRisk();
  const positions = [{
    asset: "BTC" as const, unrealizedPnl: -800, quoteAmount: 10_000,
    direction: "LONG" as const, markPrice: 70_000, entryPrice: 70_000,
  }];
  const m = re.assess(INITIAL_EQUITY, INITIAL_EQUITY * 1.25, positions, NORMAL_CONDITIONS);
  assert.ok(
    ["CLOSE_POSITION", "HALT_NEW_TRADES", "PAUSE_EXECUTION", "EMERGENCY_CLOSE"].includes(m.worstAction),
    `Expected a close action for losing position, got ${m.worstAction}`
  );
});

test("PortfolioMetrics has expected fields", () => {
  const re = freshRisk();
  const m = re.assess(INITIAL_EQUITY, INITIAL_EQUITY * 1.25, EMPTY_POSITIONS, NORMAL_CONDITIONS);
  assert.ok(typeof m.drawdown         === "number",  "drawdown must be a number");
  assert.ok(typeof m.navUSD           === "number",  "navUSD must be a number");
  assert.ok(typeof m.sizingMultiplier === "number",  "sizingMultiplier must be a number");
  assert.ok(Array.isArray(m.riskEvents),             "riskEvents must be an array");
  assert.ok(typeof m.worstAction      === "string",  "worstAction must be a string");
});

test("formatReport returns non-empty string mentioning the action", () => {
  const re = freshRisk();
  const m = re.assess(INITIAL_EQUITY, INITIAL_EQUITY * 1.25, EMPTY_POSITIONS, NORMAL_CONDITIONS);
  const report = re.formatReport(m);
  assert.ok(report.length > 0, "formatReport should return non-empty text");
});

test("sizingMultiplier = 1.0 on healthy conditions", () => {
  const re = freshRisk();
  const m = re.assess(INITIAL_EQUITY, INITIAL_EQUITY * 1.25, EMPTY_POSITIONS, NORMAL_CONDITIONS);
  assert.strictEqual(m.sizingMultiplier, 1.0,
    `Expected 1.0 sizing multiplier on normal conditions, got ${m.sizingMultiplier}`);
});

// ── Agent sizing tests ────────────────────────────────────────────────────────
console.log("\n── Agent: getPositionSize ──────────────────────────────────");

test("returns at least MIN_SIZE ($30) regardless of confidence", () => {
  const state = createInitialState();
  const size = getPositionSize({ ...state, confidence: 0 }, 0);
  assert.ok(size >= 30, `Expected >= 30, got ${size}`);
});

test("scales up when win rate > 60%", () => {
  const state = createInitialState();
  const low  = getPositionSize({ ...state, winRate: 0.50, confidence: 1.0 }, 0);
  const high = getPositionSize({ ...state, winRate: 0.65, confidence: 1.0 }, 0);
  assert.ok(high > low, `High win-rate size (${high}) should exceed low win-rate (${low})`);
});

test("halves size on high volatility (> 1)", () => {
  const state = createInitialState();
  const normal = getPositionSize({ ...state, confidence: 1.0 }, 0.5);
  const vol    = getPositionSize({ ...state, confidence: 1.0 }, 1.5);
  assert.ok(vol < normal, `High-vol size (${vol}) should be < normal (${normal})`);
});

// ── FundingPersistencePredictor tests ────────────────────────────────────────
console.log("\n── FundingPersistencePredictor ─────────────────────────────");

/** Minimal snap builder — only fields the FPP reads */
function fppSnap(overrides: {
  fundingRate?: number;
  oiChangeRatePct?: number;
  longShortRatio?: number;
  atrPct?: number;
}) {
  return {
    ...BASE_SNAP,
    fundingRate:     overrides.fundingRate     ?? 0.0001,
    oiChangeRatePct: overrides.oiChangeRatePct ?? 0,
    longShortRatio:  overrides.longShortRatio  ?? 0.5,
    atrPct:          overrides.atrPct          ?? 0.01,
  };
}

/** Warm the FPP ring with N identical samples, return last result. */
function warmFpp(fpp: FundingPersistencePredictor, asset: string, snap: any, n: number) {
  let r = fpp.update(asset, snap);
  for (let i = 1; i < n; i++) r = fpp.update(asset, snap);
  return r;
}

test("persistenceScore is in [0, 1] after single update", () => {
  const fpp = new FundingPersistencePredictor();
  const r = fpp.update("BTC", fppSnap({ fundingRate: 0.0001 }));
  assert.ok(r.persistenceScore >= 0 && r.persistenceScore <= 1,
    `persistenceScore out of range: ${r.persistenceScore}`);
});

test("stable positive funding produces high stabilityScore (> 0.5)", () => {
  const fpp = new FundingPersistencePredictor();
  const snap = fppSnap({ fundingRate: 0.0002, oiChangeRatePct: 0.04 });
  const r = warmFpp(fpp, "BTC", snap, 20);
  assert.ok(r.components.stabilityScore > 0.5,
    `Expected stabilityScore > 0.5, got ${r.components.stabilityScore}`);
});

test("OI rising + positive funding → oiScore > 0", () => {
  const fpp = new FundingPersistencePredictor();
  const r = fpp.update("ETH", fppSnap({ fundingRate: 0.0001, oiChangeRatePct: 0.05 }));
  assert.ok(r.components.oiScore > 0,
    `Expected oiScore > 0 when OI rising + funding positive, got ${r.components.oiScore}`);
});

test("OI falling while funding positive → oiDivergence filter fires", () => {
  const fpp = new FundingPersistencePredictor();
  // oiSlope < -0.03 triggers OI divergence kill (×0.3)
  const r = fpp.update("SOL", fppSnap({ fundingRate: 0.0002, oiChangeRatePct: -0.06 }));
  assert.ok(r.filters.oiDivergence,
    "Expected oiDivergence=true when OI dropping 6% with positive funding");
  // Score should be reduced — oiDivergence multiplies by 0.3
  const rNormal = fpp.update("SOL", fppSnap({ fundingRate: 0.0002, oiChangeRatePct: 0.0 }));
  assert.ok(r.persistenceScore < rNormal.persistenceScore,
    `OI divergence score (${r.persistenceScore}) should be < normal (${rNormal.persistenceScore})`);
});

test("ATR above conflict level → atrConflict fires, score halved", () => {
  const fpp = new FundingPersistencePredictor();
  const snap = fppSnap({ fundingRate: 0.0002, oiChangeRatePct: 0.03 });
  const rNormal = fpp.update("BTC", { ...snap, atrPct: 0.01 }); // below ATR_TARGET(0.02)×2
  const rConflict = fpp.update("BTC", { ...snap, atrPct: 0.05 }); // above 0.02×2=0.04 → conflict
  assert.ok(rConflict.filters.atrConflict,
    "Expected atrConflict=true when ATR is 5% (above 0.02*2 = 4% threshold)");
  assert.ok(rConflict.persistenceScore < rNormal.persistenceScore,
    `Conflict score (${rConflict.persistenceScore}) should be < normal (${rNormal.persistenceScore})`);
});

test("bullish crowd + positive funding → alignmentScore = 1", () => {
  const fpp = new FundingPersistencePredictor();
  const r = fpp.update("BTC", fppSnap({ fundingRate: 0.0002, longShortRatio: 0.65 }));
  assert.strictEqual(r.components.alignmentScore, 1,
    `Expected alignmentScore=1 for bullish crowd + positive funding, got ${r.components.alignmentScore}`);
});

test("bearish crowd + negative funding → alignmentScore = 1", () => {
  const fpp = new FundingPersistencePredictor();
  const r = fpp.update("BTC", fppSnap({ fundingRate: -0.0002, longShortRatio: 0.40 }));
  assert.strictEqual(r.components.alignmentScore, 1,
    `Expected alignmentScore=1 for bearish crowd + negative funding, got ${r.components.alignmentScore}`);
});

test("rising funding slope → trendScore > 0.5", () => {
  const fpp = new FundingPersistencePredictor();
  // Warm up at low rate, then escalate to create positive slope
  for (let i = 0; i < 5; i++) fpp.update("BTC", fppSnap({ fundingRate: 0.00005 }));
  const r = fpp.update("BTC", fppSnap({ fundingRate: 0.0003 })); // big jump → positive directed slope
  assert.ok(r.components.trendScore > 0.5,
    `Expected trendScore > 0.5 when funding rising sharply, got ${r.components.trendScore}`);
});

test("falling funding slope → trendScore < 0.5", () => {
  const fpp = new FundingPersistencePredictor();
  // Warm at high rate, then drop
  for (let i = 0; i < 5; i++) fpp.update("BTC", fppSnap({ fundingRate: 0.0003 }));
  const r = fpp.update("BTC", fppSnap({ fundingRate: 0.00005 })); // big drop → negative directed slope
  assert.ok(r.components.trendScore < 0.5,
    `Expected trendScore < 0.5 when funding falling, got ${r.components.trendScore}`);
});

test("effectiveEdge = persistenceScore × max(0, expectedEdge)", () => {
  const fpp = new FundingPersistencePredictor();
  const r = warmFpp(fpp, "BTC", fppSnap({ fundingRate: 0.0002, oiChangeRatePct: 0.03 }), 10);
  // effectiveEdge should equal max(0, expectedEdge) * persistenceScore (within float tolerance)
  const expected = Math.max(0, r.expectedEdge) * r.persistenceScore;
  assert.ok(Math.abs(r.effectiveEdge - expected) < 1e-12,
    `effectiveEdge (${r.effectiveEdge}) ≠ max(0,edge)×score (${expected})`);
});

test("bestEffectiveEdge returns 0 when no updates exist", () => {
  const fpp = new FundingPersistencePredictor();
  assert.strictEqual(fpp.bestEffectiveEdge(["BTC", "ETH"]), 0,
    "Expected 0 for fresh predictor with no history");
});

test("bestEffectiveEdge picks max across assets", () => {
  const fpp = new FundingPersistencePredictor();
  fpp.update("BTC", fppSnap({ fundingRate: 0.00005, oiChangeRatePct: 0 }));
  fpp.update("ETH", fppSnap({ fundingRate: 0.0005,  oiChangeRatePct: 0.03, longShortRatio: 0.65 }));
  const best = fpp.bestEffectiveEdge(["BTC", "ETH"]);
  const btcEdge = fpp.getLatestResult("BTC")!.effectiveEdge;
  const ethEdge = fpp.getLatestResult("ETH")!.effectiveEdge;
  assert.strictEqual(best, Math.max(btcEdge, ethEdge),
    `Expected max(${btcEdge}, ${ethEdge}) = ${Math.max(btcEdge, ethEdge)}, got ${best}`);
});

test("getLatestResult returns null before first update", () => {
  const fpp = new FundingPersistencePredictor();
  assert.strictEqual(fpp.getLatestResult("BTC"), null);
});

// ── Results ───────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(52)}`);
console.log(`  ${passed} passed   ${failed} failed   ${passed + failed} total`);
console.log(`${"─".repeat(52)}\n`);

if (failed > 0) process.exit(1);
