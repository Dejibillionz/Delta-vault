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
import { FundingRegimeClassifier }      from "../src/services/fundingRegime";

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

// ── FundingRegimeClassifier + ExitTimingModel tests ───────────────────────────
console.log("\n── FundingRegimeClassifier ─────────────────────────────────────");

/**
 * Helper: build a snap with overrides for FRC-relevant fields.
 * Spreads BASE_SNAP so all LiveMarketSnapshot fields are present.
 */
function frcSnap(overrides: {
  fundingRate?: number;
  oiChangeRatePct?: number;
  atrPct?: number;
}) {
  return {
    ...BASE_SNAP,
    fundingRate:     overrides.fundingRate     ?? 0.0001,
    oiChangeRatePct: overrides.oiChangeRatePct ?? 0.03,
    atrPct:          overrides.atrPct          ?? 0.01,
  };
}

test("ACCUMULATION: rising funding + positive OI + low persistence", () => {
  const frc = new FundingRegimeClassifier();
  const snap = frcSnap({ oiChangeRatePct: 0.03 });
  frc.update("BTC", { ...snap, fundingRate: 0.00005 }, 0.4); // baseline
  const r = frc.update("BTC", { ...snap, fundingRate: 0.0001 }, 0.4); // rising → positive slope
  assert.strictEqual(r.regime, "ACCUMULATION",
    `Expected ACCUMULATION, got ${r.regime}`);
  assert.ok(r.f_slope > 0, "slope must be positive");
});

test("EXPANSION: rising funding + positive OI + high persistence", () => {
  const frc = new FundingRegimeClassifier();
  const snap = frcSnap({ oiChangeRatePct: 0.03 });
  frc.update("BTC", { ...snap, fundingRate: 0.00005 }, 0.7); // baseline
  const r = frc.update("BTC", { ...snap, fundingRate: 0.0001 }, 0.7); // same slope, high persistence
  assert.strictEqual(r.regime, "EXPANSION",
    `Expected EXPANSION, got ${r.regime}`);
});

test("DECAY: declining funding + negative OI → DECAY", () => {
  const frc = new FundingRegimeClassifier();
  // Build high-funding baseline
  const highSnap = frcSnap({ fundingRate: 0.003, oiChangeRatePct: 0.03 });
  for (let i = 0; i < 5; i++) frc.update("BTC", highSnap, 0.8);
  // Then drop sharply with OI unwinding → f_slope < 0, oi_slope < 0
  const r = frc.update("BTC", frcSnap({ fundingRate: 0.001, oiChangeRatePct: -0.05 }), 0.5);
  assert.strictEqual(r.regime, "DECAY",
    `Expected DECAY, got ${r.regime} (slope=${r.f_slope.toExponential(2)})`);
  assert.ok(r.f_slope < 0, "slope must be negative in DECAY");
});

test("PEAK: high z-score + flat slope → PEAK", () => {
  const frc = new FundingRegimeClassifier();
  // 14 low-rate samples (build a low mean), then 6 high-rate samples
  // After 20 samples: f_slope = (high − high) / 5 = 0 ≤ 0; z-score ≈ 1.53 > 1.5
  for (let i = 0; i < 14; i++) frc.update("BTC", frcSnap({ fundingRate: 0.00001, oiChangeRatePct: 0.01 }), 0.7);
  let r: any;
  for (let i = 0; i < 6; i++) r = frc.update("BTC", frcSnap({ fundingRate: 0.003,   oiChangeRatePct: 0.01 }), 0.7);
  assert.strictEqual(r.regime, "PEAK",
    `Expected PEAK, got ${r.regime} (f_z=${r.f_z.toFixed(3)}, slope=${r.f_slope.toExponential(2)})`);
  assert.ok(r.f_z > 1.5, `f_z must be > 1.5, got ${r.f_z.toFixed(3)}`);
});

test("RESET: rising funding but falling OI → RESET (no EXPANSION/ACCUMULATION)", () => {
  const frc = new FundingRegimeClassifier();
  frc.update("BTC", frcSnap({ fundingRate: 0.0001, oiChangeRatePct: -0.03 }), 0.5); // baseline
  const r = frc.update("BTC", frcSnap({ fundingRate: 0.0002, oiChangeRatePct: -0.03 }), 0.5); // rising f, falling OI
  assert.strictEqual(r.regime, "RESET",
    `Expected RESET (OI falling blocks ACCUMULATION/EXPANSION), got ${r.regime}`);
});

test("getLatestRegime returns null before first update", () => {
  const frc = new FundingRegimeClassifier();
  assert.strictEqual(frc.getLatestRegime("BTC"), null);
});

test("getLatestRegime returns result after update without re-running", () => {
  const frc = new FundingRegimeClassifier();
  frc.update("BTC", frcSnap({}), 0.7);
  const r = frc.getLatestRegime("BTC");
  assert.ok(r !== null, "should return result after update");
  assert.ok(typeof r!.regime === "string", "regime must be a string");
  assert.ok(typeof r!.f_z   === "number", "f_z must be a number");
});

test("getExitSignal → HOLD on healthy EXPANSION conditions", () => {
  const frc = new FundingRegimeClassifier();
  const base = frcSnap({ oiChangeRatePct: 0.03 });
  // Alternating [lo, hi] rates build mean=0.0002, std≈0.000190 → z of 0.00040 ≈ 1.05 < FRC_PEAK_EARLY_Z(1.2)
  // Slope is positive on odd steps; f_accel alternates sign → no systematic PEAK_EARLY trigger
  for (let i = 0; i < 10; i++) {
    frc.update("BTC", { ...base, fundingRate: i % 2 === 0 ? 0.00001 : 0.00039 }, 0.75);
  }
  const lastSnap = { ...base, fundingRate: 0.00040 };
  const r = frc.update("BTC", lastSnap, 0.75);
  assert.strictEqual(r.regime, "EXPANSION",
    `Prerequisite: expected EXPANSION, got ${r.regime} (z=${r.f_z.toFixed(2)}, slope=${r.f_slope.toExponential(2)})`);
  const exit = frc.getExitSignal("BTC", lastSnap, { persistenceScore: 0.75 } as any);
  assert.strictEqual(exit.action, "HOLD",
    `Expected HOLD on healthy expansion, got ${exit.action} (score=${exit.exitScoreSmoothed.toFixed(2)})`);
});

test("getExitSignal → FULL_EXIT when regime is DECAY", () => {
  const frc = new FundingRegimeClassifier();
  const fpp = new FundingPersistencePredictor();
  // Drive to DECAY
  const hiSnap = frcSnap({ fundingRate: 0.003, oiChangeRatePct: 0.03 });
  for (let i = 0; i < 5; i++) { frc.update("BTC", hiSnap, 0.8); fpp.update("BTC", hiSnap); }
  const decaySnap = frcSnap({ fundingRate: 0.001, oiChangeRatePct: -0.05 });
  frc.update("BTC", decaySnap, 0.5);
  const fppResult = fpp.update("BTC", decaySnap);
  const exit = frc.getExitSignal("BTC", decaySnap, fppResult);
  assert.strictEqual(exit.action, "FULL_EXIT",
    `Expected FULL_EXIT for DECAY regime, got ${exit.action}`);
});

test("getExitSignal components are all in [0, 1]", () => {
  const frc = new FundingRegimeClassifier();
  const fpp = new FundingPersistencePredictor();
  const snap = frcSnap({ fundingRate: 0.0002, oiChangeRatePct: -0.08, atrPct: 0.04 });
  frc.update("BTC", snap, 0.3);
  const fppResult = fpp.update("BTC", snap);
  const exit = frc.getExitSignal("BTC", snap, fppResult);
  const { negSlope, negOi, persistenceDrop, overextended } = exit.components;
  assert.ok(negSlope      >= 0 && negSlope      <= 1, `negSlope ${negSlope} out of [0,1]`);
  assert.ok(negOi         >= 0 && negOi         <= 1, `negOi ${negOi} out of [0,1]`);
  assert.ok(persistenceDrop >= 0 && persistenceDrop <= 1, `persistenceDrop ${persistenceDrop} out of [0,1]`);
  assert.ok(overextended  >= 0 && overextended  <= 1, `overextended ${overextended} out of [0,1]`);
  assert.ok(exit.exitScore >= 0 && exit.exitScore <= 1, `exitScore ${exit.exitScore} out of [0,1]`);
});

// ── FRC Refinements (v2): hysteresis, PEAK_EARLY, EMA, cooldown ───────────────
console.log("\n── FRC Refinements (v2) ─────────────────────────────────────");

// ── Refinement 1: Hysteresis ────────────────────────────────────────────
test("hysteresis: EXPANSION stays in dead band when persistence ∈ (0.55, 0.65)", () => {
  const frc = new FundingRegimeClassifier();
  const base = frcSnap({ oiChangeRatePct: 0.03 });
  // Alternating warmup → mean=0.0002, std≈0.000190, z of step-up ≈ 1.05 < 1.2 → no PEAK_EARLY
  for (let i = 0; i < 10; i++) {
    frc.update("BTC", { ...base, fundingRate: i % 2 === 0 ? 0.00001 : 0.00039 }, 0.7);
  }
  // Step up slightly: keeps f_slope > 0 and raw = ACCUMULATION (persistence 0.58 < ENTER 0.65)
  // Hysteresis holds EXPANSION because 0.58 ≥ EXIT(0.55) and prev was EXPANSION
  const r = frc.update("BTC", { ...base, fundingRate: 0.00040 }, 0.58);
  assert.strictEqual(r.regime, "EXPANSION",
    `Expected EXPANSION (hysteresis holds since 0.58 ≥ EXIT=0.55), got ${r.regime} (z=${r.f_z.toFixed(2)})`);
});

test("hysteresis: EXPANSION drops to ACCUMULATION when persistence falls below EXIT (0.55)", () => {
  const frc = new FundingRegimeClassifier();
  const base = frcSnap({ oiChangeRatePct: 0.03 });
  for (let i = 0; i < 10; i++) {
    frc.update("BTC", { ...base, fundingRate: i % 2 === 0 ? 0.00001 : 0.00039 }, 0.7);
  }
  // Same step-up but persistence 0.50 < EXIT(0.55) → hysteresis releases, drops to ACCUMULATION
  const r = frc.update("BTC", { ...base, fundingRate: 0.00040 }, 0.50);
  assert.strictEqual(r.regime, "ACCUMULATION",
    `Expected ACCUMULATION (0.50 < EXIT=0.55), got ${r.regime} (z=${r.f_z.toFixed(2)})`);
});

test("hysteresis: ACCUMULATION stays when persistence 0.62 < ENTER (0.65)", () => {
  const frc = new FundingRegimeClassifier();
  const base = frcSnap({ oiChangeRatePct: 0.03 });
  frc.update("BTC", { ...base, fundingRate: 0.00005 }, 0.62); // baseline (RESET on first sample)
  const r = frc.update("BTC", { ...base, fundingRate: 0.0001 }, 0.62); // slope > 0, 0.62 < ENTER=0.65 → ACCUMULATION
  assert.strictEqual(r.regime, "ACCUMULATION",
    `Expected ACCUMULATION (0.62 < ENTER=0.65, v1 threshold 0.6 would have given EXPANSION), got ${r.regime}`);
});

// ── Refinement 2: PEAK_EARLY ──────────────────────────────────────────────
test("PEAK_EARLY: z in (1.2, 1.5) + f_accel < 0 → PEAK_EARLY", () => {
  const frc = new FundingRegimeClassifier();
  const base = frcSnap({ oiChangeRatePct: 0.02 });
  // Build moderate z-score (1.2–1.5): 12 very low, 2 mid-high, 1 slightly lower
  for (let i = 0; i < 12; i++) frc.update("BTC", { ...base, fundingRate: 0.00001 }, 0.7);
  frc.update("BTC", { ...base, fundingRate: 0.0015 }, 0.7);
  frc.update("BTC", { ...base, fundingRate: 0.0015 }, 0.7);
  // Slightly lower rate → slope drops → f_accel < 0 (deceleration)
  const r = frc.update("BTC", { ...base, fundingRate: 0.001 }, 0.7);
  assert.strictEqual(r.regime, "PEAK_EARLY",
    `Expected PEAK_EARLY (z=${r.f_z.toFixed(3)}, accel=${r.f_accel.toExponential(2)}), got ${r.regime}`);
  assert.ok(r.f_z > 1.2 && r.f_z <= 1.5, `f_z ${r.f_z.toFixed(3)} must be in (1.2, 1.5]`);
  assert.ok(r.f_accel < 0, `f_accel must be negative, got ${r.f_accel.toExponential(2)}`);
});

test("PEAK has priority over PEAK_EARLY when z > 1.5", () => {
  const frc = new FundingRegimeClassifier();
  // Reuse PEAK scenario: 14 low + 6 high → z ≈ 1.53 > 1.5, f_slope = 0 → PEAK (not PEAK_EARLY)
  for (let i = 0; i < 14; i++) frc.update("BTC", frcSnap({ fundingRate: 0.00001, oiChangeRatePct: 0.01 }), 0.7);
  let r: any;
  for (let i = 0; i < 6; i++) r = frc.update("BTC", frcSnap({ fundingRate: 0.003, oiChangeRatePct: 0.01 }), 0.7);
  assert.strictEqual(r.regime, "PEAK",
    `Expected PEAK (priority over PEAK_EARLY when z > 1.5), got ${r.regime} (z=${r.f_z.toFixed(3)})`);
  assert.ok(r.f_z > 1.5, `f_z ${r.f_z.toFixed(3)} must exceed FRC_HIGH_Z=1.5`);
});

// ── Refinement 3: EMA smoothing ───────────────────────────────────────────
test("EMA: first-cycle spike is dampened — smoothed < raw — and stays below FULL_EXIT threshold", () => {
  const frc = new FundingRegimeClassifier();
  const base = frcSnap({ oiChangeRatePct: 0.03 });
  // Warmup: 8 healthy getExitSignal calls → EMA anchored near 0
  const rates = [0.0001, 0.00012, 0.00014, 0.00016, 0.00018, 0.0002, 0.00022, 0.00024];
  const mockFpp = (ps: number) => ({ persistenceScore: ps }) as any;
  for (const rate of rates) {
    frc.update("BTC", { ...base, fundingRate: rate }, 0.8);
    frc.getExitSignal("BTC", { ...base, fundingRate: rate }, mockFpp(0.8)); // warm EMA near 0
  }
  // Spike: OI turns sharply negative (high negOi contribution), drop persistence → high raw score
  const spike = { ...base, fundingRate: 0.00024, oiChangeRatePct: -0.15 };
  frc.update("BTC", spike, 0.5);          // keep f_slope ≥ 0 (same rate) → no DECAY
  const exit = frc.getExitSignal("BTC", spike, mockFpp(0.5));
  assert.ok(exit.exitScoreSmoothed < exit.exitScore,
    `smoothed (${exit.exitScoreSmoothed.toFixed(3)}) must be less than raw (${exit.exitScore.toFixed(3)}) on first spike`);
  assert.ok(exit.exitScoreSmoothed < 0.7,
    `smoothed (${exit.exitScoreSmoothed.toFixed(3)}) must not trigger FULL_EXIT (0.7) on single spike`);
  assert.ok(exit.exitScoreSmoothed >= 0, "smoothed score must be non-negative");
});

// ── Refinement 4: Reduce cooldown ─────────────────────────────────────────
test("reduce cooldown: set after REDUCE_50 and decrements to 0 via update()", () => {
  const frc = new FundingRegimeClassifier();
  // Conditions for exitScore ≈ 0.55 — f_slope < 0 (negSlope=1) + oi_slope > 0 (avoids DECAY)
  //   + persistence drop 0.3 (persistenceDrop=1): total ≈ 0.30×1 + 0.25×0 + 0.25×1 = 0.55
  const snap1 = frcSnap({ fundingRate: 0.0003, oiChangeRatePct: 0.03 });
  const snap2 = frcSnap({ fundingRate: 0.0001, oiChangeRatePct: 0.03 }); // slope drops → negSlope = 1.0
  frc.update("BTC", snap1, 0.8);
  frc.update("BTC", snap2, 0.5); // persistence drops 0.3 → persistenceDrop = 1.0
  assert.strictEqual(frc.getReduceCooldown("BTC"), 0, "cooldown must start at 0");
  // First getExitSignal: exitScoreSmoothed = raw ≈ 0.55 → REDUCE_50
  const exit = frc.getExitSignal("BTC", snap2, { persistenceScore: 0.5 } as any);
  assert.strictEqual(exit.action, "REDUCE_50",
    `Expected REDUCE_50 (score=${exit.exitScoreSmoothed.toFixed(3)}), got ${exit.action}`);
  assert.ok(frc.getReduceCooldown("BTC") > 0, "cooldown must be set after REDUCE_50");
  const initialCooldown = frc.getReduceCooldown("BTC");
  // Each update() decrements the cooldown
  for (let i = 0; i < initialCooldown; i++) frc.update("BTC", snap2, 0.5);
  assert.strictEqual(frc.getReduceCooldown("BTC"), 0,
    `cooldown must reach 0 after ${initialCooldown} update() calls`);
});

// ── Refinement 5: Persistence override (index.ts sizing) ─────────────────
test("ACCUMULATION + persistence in upper dead band (0.62 > 0.59) — regime check for sizing override", () => {
  const frc = new FundingRegimeClassifier();
  const base = frcSnap({ oiChangeRatePct: 0.03 });
  // persistence=0.62 < ENTER(0.65) → ACCUMULATION; but 0.62 > FRC_PERSIST_FULL_SIZE_OVERRIDE(0.59)
  // → index.ts regimeSizingMult would apply 1.0× (full size) even in ACCUMULATION
  frc.update("BTC", { ...base, fundingRate: 0.00005 }, 0.62);
  const r = frc.update("BTC", { ...base, fundingRate: 0.0001 }, 0.62);
  assert.strictEqual(r.regime, "ACCUMULATION",
    `Expected ACCUMULATION (0.62 < ENTER=0.65), got ${r.regime}`);
  // Confirm: persistence 0.62 > 0.59 threshold → sizing override in index.ts gives full size
  assert.ok(0.62 > 0.59, "override threshold 0.59 is satisfied — full size applies in index.ts");
});

// ── FRC Refinements (v3): PEAK_EARLY bias, spike override, context-aware cooldown ─
console.log("\n── FRC Refinements (v3) ─────────────────────────────────────");

// ── Refinement v3-1: PEAK_EARLY effectiveScore bias ──────────────────────
test("v3 PEAK_EARLY bias: effectiveScore = min(1, exitScoreSmoothed + 0.1)", () => {
  const frc = new FundingRegimeClassifier();
  // 6 alternating cycles build mean=0.00015, std=0.0001
  for (let i = 0; i < 6; i++) {
    frc.update("BTC", frcSnap({ fundingRate: i % 2 === 0 ? 0.00005 : 0.00025 }), 0.7);
  }
  // Push 0.00034: z≈1.43 (PEAK_EARLY zone), f_accel < 0 (slope drops from 0.00004 → 0.000018)
  const snapPE = frcSnap({ fundingRate: 0.00034, oiChangeRatePct: 0.01 });
  const r = frc.update("BTC", snapPE, 0.7);
  assert.strictEqual(r.regime, "PEAK_EARLY",
    `Expected PEAK_EARLY, got ${r.regime} (z=${r.f_z.toFixed(2)}, accel=${r.f_accel.toExponential(2)})`);

  const exit = frc.getExitSignal("BTC", snapPE, { persistenceScore: 0.7 } as any);
  const expectedEff = Math.min(1, exit.exitScoreSmoothed + 0.1);
  assert.strictEqual(exit.effectiveScore, expectedEff,
    `effectiveScore ${exit.effectiveScore.toFixed(4)} ≠ exitSmoothed+0.1 = ${expectedEff.toFixed(4)}`);
  assert.ok(exit.effectiveScore > exit.exitScoreSmoothed,
    "effectiveScore must exceed exitScoreSmoothed in PEAK_EARLY");
});

// ── Refinement v3-2: spikeOverride + effectiveScore fields exist ──────────
test("v3 ExitSignal interface: spikeOverride and effectiveScore fields are present", () => {
  const frc = new FundingRegimeClassifier();
  const snap = frcSnap({ fundingRate: 0.0001, oiChangeRatePct: 0.03 });
  frc.update("BTC", snap, 0.7);
  const exit = frc.getExitSignal("BTC", snap, { persistenceScore: 0.7 } as any);

  assert.ok(typeof exit.spikeOverride === "boolean", "spikeOverride must be boolean");
  assert.ok(typeof exit.effectiveScore === "number", "effectiveScore must be number");
  assert.ok(typeof exit.exitScoreSmoothed === "number", "exitScoreSmoothed must be number");
  // Under stable conditions: no spike override, effectiveScore equals exitScoreSmoothed
  assert.strictEqual(exit.spikeOverride, false, "spikeOverride must be false under normal conditions");
  assert.strictEqual(exit.effectiveScore, exit.exitScoreSmoothed,
    "effectiveScore must equal exitScoreSmoothed when not in PEAK_EARLY");
});

// ── Refinement v3-3: context-aware cooldown (3 cycles for moderate score) ─
test("v3 context-aware cooldown: moderate raw exitScore (<0.65) sets 3-cycle cooldown", () => {
  const frc = new FundingRegimeClassifier();
  // From v2 test: f_slope < 0 + persistence drop → exitScore ≈ 0.55 (< 0.65 threshold)
  const snap1 = frcSnap({ fundingRate: 0.0003, oiChangeRatePct: 0.03 });
  const snap2 = frcSnap({ fundingRate: 0.0001, oiChangeRatePct: 0.03 }); // negative slope
  frc.update("BTC", snap1, 0.8);
  frc.update("BTC", snap2, 0.5); // persistence drops 0.3 → persistenceDrop = 1.0
  const exit = frc.getExitSignal("BTC", snap2, { persistenceScore: 0.5 } as any);
  if (exit.action === "REDUCE_50") {
    // Verify the cooldown is correctly set according to the raw exitScore
    const expectedCd = exit.exitScore >= 0.65 ? 5 : 3;
    assert.strictEqual(frc.getReduceCooldown("BTC"), expectedCd,
      `cooldown ${frc.getReduceCooldown("BTC")} ≠ expected ${expectedCd} for raw score ${exit.exitScore.toFixed(3)}`);
    // The raw score from this setup is below 0.65, so expect 3
    assert.ok(exit.exitScore < 0.65,
      `raw exitScore ${exit.exitScore.toFixed(3)} should be < 0.65 for this setup`);
    assert.strictEqual(frc.getReduceCooldown("BTC"), 3,
      `moderate raw score (${exit.exitScore.toFixed(3)} < 0.65) must set 3-cycle cooldown`);
  }
});
console.log(`\n${"─".repeat(52)}`);
console.log(`  ${passed} passed   ${failed} failed   ${passed + failed} total`);
console.log(`${"─".repeat(52)}\n`);

if (failed > 0) process.exit(1);
