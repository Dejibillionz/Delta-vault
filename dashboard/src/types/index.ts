/**
 * Domain Types for Delta Vault Dashboard
 * Core interfaces and types for the application
 */

// ── Market Data ─────────────────────────────────────────────────────────────
export type Asset = "BTC" | "ETH" | "SOL" | "JTO";
export type SignalType =
  | "DELTA_NEUTRAL_OPEN"
  | "DELTA_NEUTRAL_CLOSE"
  | "BASIS_TRADE_OPEN"
  | "BASIS_TRADE_CLOSE"
  | "PARK_CAPITAL"
  | "NO_ACTION";

export interface MarketTick {
  prices: Record<Asset, number>;
  funding: Record<Asset, number>;
  basis: Record<Asset, number>;
  liquidity: Record<Asset, number>;
  conf: Record<Asset, number>;
  timestamp: number;
}

export interface PriceData {
  BTC: number;
  ETH: number;
  SOL: number;
  JTO: number;
}

export interface FundingData extends PriceData {}
export interface BasisData extends PriceData {}
export interface LiquidityData extends PriceData {}
export interface ConfidenceData extends PriceData {}

// ── Strategy ─────────────────────────────────────────────────────────────────
export interface Signal {
  asset: Asset;
  signal: SignalType;
  reason: string;
  urgency: "HIGH" | "MEDIUM" | "LOW";
}

export interface Position {
  id: string;
  asset: Asset;
  type: "DELTA_NEUTRAL" | "BASIS_TRADE" | "LENDING";
  size: number;
  notional: number;
  pnl: number;
  opened: string;
  legs: number;
  delta?: number;
}

export interface Order {
  id: string;
  time: string;
  asset: Asset;
  side: "BUY" | "SELL";
  type: string;
  size: number;
  status: "PENDING" | "FILLED" | "FAILED";
}

// ── Lending ─────────────────────────────────────────────────────────────────
export interface LendingPosition {
  amount: number;
  yield: number;
}

export interface LendingData {
  BTC: LendingPosition;
  ETH: LendingPosition;
  SOL: LendingPosition;
  JTO: LendingPosition;
}

// ── Vault Metrics ────────────────────────────────────────────────────────────
export interface VaultMetrics {
  nav: number; // Net Asset Value
  pnl: number; // Realized PnL
  drawdown: number; // Max drawdown %
  delta: number; // Delta exposure %
  hwm: number; // High Water Mark
  totalUnrealizedPnl: number;
  equityTarget: number;
}

export interface PnLBreakdown {
  funding: number;
  lending: number;
  realized: number;
}

// ── Risk ─────────────────────────────────────────────────────────────────────
export type RiskAction =
  | "NORMAL"
  | "EMERGENCY_CLOSE"
  | "REBALANCE"
  | "CLOSE_POSITION"
  | "HALT_NEW_TRADES"
  | "REDUCE_SIZE"
  | "PAUSE_EXECUTION"
  | "HALT_NEW_POSITIONS"
  | "WARNING";

export interface RiskEvent {
  action: RiskAction;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
  message: string;
  asset?: Asset;
  timestamp: number;
}

// ── Cross-Chain ─────────────────────────────────────────────────────────────
export type Chain = "solana" | "base" | "arbitrum" | "optimism" | "polygon" | "avalanche" | "bnb";

export interface CrossChainDecision {
  asset: Asset;
  execute: boolean;
  reason: string;
  currentChain: Chain;
  bestChain?: Chain;
  netEdge: number;
  expectedProfitUsd: number;
  totalCostPct: number;
}

export interface FundingByChain {
  [chain: string]: Record<Asset, number>;
}

// ── AI Agent ─────────────────────────────────────────────────────────────────
export interface AIAgentState {
  enabled: boolean;
  mode: "Aggressive" | "Neutral" | "Conservative";
  confidence: number;
  lastDecision: string;
  reason: string;
  fundingSummary: string;
  crossChainSignal: boolean;
  riskLevel: "Low" | "Medium" | "High";
  momentumScores: Record<Asset, number>;
}

// ── Logging ─────────────────────────────────────────────────────────────────
export type LogType = "INFO" | "TRADE" | "RISK" | "WARN" | "SYS" | "PYTH";

export interface LogEntry {
  id: number;
  type: LogType;
  msg: string;
  time: string;
}

// ── UI State ─────────────────────────────────────────────────────────────────
export interface DvModal {
  open: boolean;
  tab: "deposit" | "withdraw";
  amount: string;
  status: "idle" | "pending" | "success" | "error";
  txSig: string;
  error: string;
}

export interface UIState {
  running: boolean;
  tab: "dashboard" | "architecture" | "how";
  liveSync: boolean;
  liveSyncErr: string;
  logs: LogEntry[];
  riskFlags: RiskEvent[];
  tick: number;
  dvModal: DvModal;
}

// ── Wallet ──────────────────────────────────────────────────────────────────
export interface WalletState {
  connected: boolean;
  address: string;
  loading: boolean;
}
