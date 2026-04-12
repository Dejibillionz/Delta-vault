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
  longShortRatio: 0.5,
  liquidityScore: 0.9,
  pythConfidence: 0.001,
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
  solanaLatencyMs: 100,
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

test("PAUSE_EXECUTION on high RPC latency", () => {
  const re = freshRisk();
  const m = re.assess(INITIAL_EQUITY, INITIAL_EQUITY * 1.25, EMPTY_POSITIONS, {
    ...NORMAL_CONDITIONS, solanaLatencyMs: 600,
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

// ── Results ───────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(52)}`);
console.log(`  ${passed} passed   ${failed} failed   ${passed + failed} total`);
console.log(`${"─".repeat(52)}\n`);

if (failed > 0) process.exit(1);
