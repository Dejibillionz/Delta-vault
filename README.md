# ◈ Delta Vault — Adaptive Delta-Neutral Vault Strategy

> Drift Protocol · Solana · BTC + ETH · Mainnet-Ready

A production-ready delta-neutral vault strategy that generates stable yield through funding rate arbitrage, basis spread capture, cross-chain opportunity routing, and adaptive capital allocation — with zero directional price exposure.

---

## Strategy Overview

| Mode | Trigger | Action | Yield Source |
|------|---------|--------|--------------|
| **DELTA_NEUTRAL** | \|Funding rate\| > 0.01%/hr (mainnet) | Long spot (Jupiter) + short perp (Drift) | Funding payments |
| **BASIS_TRADE** | Basis spread > 1.0% (mainnet) | Buy spot + short futures | Spread convergence |
| **PARK_CAPITAL** | No opportunity | Deploy leftover to Drift lending pool | Lending APY |
| **CROSS_CHAIN** | Better net edge on another chain (devnet only) | Bridge capital to best venue | Inter-venue funding arb |

**Bidirectional funding:** Positive funding → LONG spot + SHORT perp. Negative funding → SHORT spot + LONG perp.
**Historical Opportunity Range:** 8–25% APY (market-dependent)
**Max Drawdown:** 10% hard stop
**Net Delta:** ~0 (market-neutral)

> **Disclaimer:** Historical funding rates and basis spreads do not guarantee future returns. Yield is entirely dependent on prevailing market conditions, funding rate regimes, and liquidity.

---

## Core Architecture

```
┌──────────────────────────────────────────────────────────┐
│                   Main Orchestrator                       │
│                      index.ts                             │
│          Capital Manager · Carryover · State API          │
└────┬──────────┬───────────┬──────────┬───────────────────┘
     │          │           │          │
┌────▼───┐ ┌───▼────┐ ┌────▼─────┐ ┌──▼──────┐ ┌──────────────┐
│ Market │ │Strategy│ │  Risk    │ │Execution│ │ Cross-Chain  │
│  Data  │ │ Engine │ │  Engine  │ │ Engine  │ │  Decision    │
│        │ │        │ │          │ │         │ │              │
│Pyth +  │ │Signals │ │Drawdown  │ │Jupiter  │ │7-chain scan  │
│Helius  │ │Sizing  │ │Vol debounce│spot swap│ │Fee-adj edge  │
│        │ │Carryover│ │Warm-up  │ │Drift    │ │Cost model    │
│        │ │        │ │          │ │perp     │ │              │
└────────┘ └────────┘ └──────────┘ └─────────┘ └──────────────┘
```

**Strategy loop:** Every 30 seconds
**Risk loop:** Every 10 seconds
**State API:** `http://localhost:3001` (polled by dashboard every 5s)

---

## Execution Flow — True Delta-Neutral

The bot uses **two separate DEXs** for the two legs of a delta-neutral position:

| Leg | DEX | Method | Why |
|-----|-----|--------|-----|
| **Spot LONG** | Jupiter Aggregator | HTTP API swap (USDC → BTC/ETH) | No minimum order size — works with any vault size |
| **Perp SHORT** | Drift Protocol | `placePerpOrder()` market order | Native Solana perp DEX with funding rate collection |

Drift spot markets require ~1 BTC minimum ($68k+), which is impractical for smaller vaults. Jupiter has no minimums, so the bot routes spot through Jupiter and perps through Drift.

### Position Closing

Positions are closed when any of these conditions are met:

| Condition | Threshold | Urgency |
|-----------|-----------|---------|
| Max hold time | > 4 hours | Medium |
| Profit target | > 1% of notional | Medium |
| Funding regime flip | Entry direction reversed | High |
| Effective funding decay | < 0.005%/hr after 30min | Medium |
| Funding depleted | Next cycle return < $0.50 | Low |
| Emergency drawdown | Portfolio drawdown > 10% | Critical |

Perp positions are closed via `placePerpOrder()` with `reduceOnly: true` (not the SDK's `closePosition()` which has serialization bugs). Spot positions are unwound via Jupiter reverse swap.

### Duplicate Position Guard

Before opening any new position, the bot checks if there's already an open position for that asset. If so, it logs a warning and skips:

```
[INFO] BTC: Position already open — skipping new DELTA_NEUTRAL_OPEN
```

This prevents stacking multiple positions on the same asset.

---

## Features

### Capital Manager
Every cycle starts with a strict reserve-before-execute flow:

1. **Reserve** — allocate capital for each trade before execution
2. **Execute** — use only reserved amount (never hardcoded sizes)
3. **Release** — return reserved capital if execution fails or is skipped
4. **Lend** — deploy only remaining leftover capital to stable yield

### Carryover Accumulation
Sub-minimum allocations accumulate across cycles and execute once meaningful:

- Allocation below `MIN_TRADE_SIZE` ($100) → **accumulated** into per-asset carryover
- Carryover + next cycle's allocation → **executes** once the sum crosses the minimum
- Signal gone quiet → carryover **decays by 25% per cycle** instead of hard resetting

### Cross-Chain Funding Arbitrage
The bot evaluates funding rates across 7 chains per cycle and routes capital to the highest net-yield venue after bridge + gas + slippage costs:

| Chain | Venue |
|-------|-------|
| Solana | Drift Protocol |
| Arbitrum | GMX |
| Base | — |
| Optimism | — |
| Polygon | — |
| Avalanche | — |
| BNB Chain | — |

> **Note:** On mainnet, non-Solana chain funding rates return zero (real API integrations pending). Cross-chain execution runs in simulation mode — only Solana/Drift trades are live.

### Adaptive AI Agent
A lightweight adaptive AI agent module observes funding conditions and gates per-cycle execution:

- Both BTC and ETH can trade simultaneously — the agent only blocks an asset if it explicitly decides to **SKIP** (underperforming). It no longer picks one asset over the other.
- Applies dynamic max-size caps derived from confidence, win-rate, and volatility
- Emits structured `[AI AGENT]` logs each cycle
- Exposes agent state over the bot API for dashboard rendering

### Reverse Delta-Neutral (Negative Funding)
Delta-neutral execution is explicitly two-way and regime-aware:

- Positive funding: **LONG spot + SHORT perp**
- Negative funding: **SHORT spot + LONG perp**
- Exit logic is direction-aware (uses effective funding, not raw sign)
- Funding regime flips trigger close/reverse behavior

### Live Dashboard
The bot serves a real-time JSON state endpoint at `http://localhost:3001`. The React dashboard polls it every 5 seconds and renders:

- Prices, funding rates, basis spreads
- Open positions (per-leg: spot + perp)
- Execution events and position status
- Lending by asset
- Capital manager state (reserved, lent, carryover)
- Cross-chain decisions and funding map
- AI agent mode, confidence, and decisions

---

## Repository Structure

```
delta-vault/
│
├── dashboard/                         # Vite + React live dashboard
│   └── src/App.jsx                    # Live polling + capital/cross-chain panels
│
├── bot/
│   ├── package.json
│   ├── tsconfig.json
│   ├── .env.example
│   └── src/
│       ├── index.ts                   # Main orchestrator + capital manager + bot loop
│       ├── realMarketData.ts          # Pyth Network + Helius live data
│       ├── strategyEngine.ts          # Bidirectional signal generation + symmetric sizing
│       ├── executionEngine.ts         # Drift perp order placement
│       ├── liveExecution.ts           # Jupiter spot + Drift perp dual-leg execution
│       ├── enhancedRiskEngine.ts      # Risk checks + smoothed funding volatility + debounce
│       ├── riskEngine.ts              # Core risk engine (drawdown, delta, collateral)
│       ├── liquidityGuard.ts          # Jupiter depth + Drift OI validation
│       ├── walletIntegration.ts       # Server keypair (extends Drift SDK Wallet)
│       ├── logger.ts                  # Structured logging
│       ├── agent/                     # AI agent module
│       │   ├── agent.ts              # Agent orchestrator
│       │   ├── decision.ts           # Decision logic
│       │   ├── sizing.ts             # Dynamic position sizing
│       │   ├── state.ts              # Rolling state tracking
│       │   └── logger.ts             # Agent-specific logging
│       ├── config/
│       │   └── crossChain.ts          # Cross-chain chains list + cooldown + horizon config
│       ├── services/
│       │   ├── crossChainFunding.ts   # Multi-chain funding aggregator (clamped + normalized)
│       │   ├── lending.ts             # Drift USDC deposit lending (uses calculateDepositRate)
│       │   └── costModel.ts           # Route-aware bridge + gas + slippage cost model
│       └── strategy/
│           ├── crossChainDecision.ts  # Per-asset best-chain selection (fee-adjusted net edge)
│           └── crossChainExecutor.ts  # Cross-chain move execution wrapper
│
├── programs/
│   └── delta_vault/                   # Anchor on-chain program (Rust)
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs
│           ├── vault.rs               # Deposit / withdraw logic
│           ├── strategy.rs            # Bot authorization + strategy mode
│           ├── risk.rs                # On-chain guardrails
│           └── fees.rs                # Management + performance fee accrual
│
├── frontend/                          # Standalone presentation components
│
├── docs/
│   └── strategy.md
│
└── README.md
```

---

## Quick Start

### 1. Dashboard

```bash
cd dashboard
npm install
npm run dev        # http://localhost:5173
```

The dashboard polls the bot state API automatically. Falls back to simulation mode if the bot is not running.

### 2. Bot

```bash
cd bot
npm install
cp .env.example .env
# Edit .env — set HELIUS_RPC_URL, HELIUS_WS_URL, WALLET_PRIVATE_KEY_BASE58
npm run dev
```

### 3. Build the Vault Program (optional — enables on-chain sync)

```bash
# Install toolchain (once)
cargo install --git https://github.com/coral-xyz/anchor --tag v0.29.0 anchor-cli --locked

# Build
anchor build

# Copy IDL to bot
cp target/idl/delta_vault.json bot/src/idl/delta_vault.json

# Deploy to devnet
anchor deploy --provider.cluster devnet

# Deploy to mainnet-beta
anchor deploy --provider.cluster mainnet-beta --provider.wallet ./keypair.json
```

Set the resulting program ID in `.env`:
```
VAULT_PROGRAM_ID=<your deployed program ID>
```

### 4. Enable Secret-Scan Hook (Recommended)

```bash
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit
```

### Prerequisites

- Node.js 18+
- A funded Solana wallet (keypair JSON file or base58 private key in `.env`)
- [Helius API key](https://helius.dev) — mainnet key required for live trading
- USDC deposited as collateral on [Drift Protocol](https://drift.trade) (mainnet)
- ~4 SOL in the deployer wallet for vault program deployment (one-time)

---

## Risk Engine

| Check | Limit | Action |
|-------|-------|--------|
| Portfolio drawdown | > 10% | Emergency close all |
| Drawdown warning | > 5% | Alert + monitor |
| Delta exposure | > 5% NAV | Rebalance perp legs |
| Single asset loss | > 7% | Close that leg |
| Free collateral | < 20% | Halt new entries |
| Funding rate volatility | > 0.2 relative jump (smoothed, clamped) | Reduce position sizes 50% |
| Solana RPC latency | > 500ms | Pause execution |
| Oracle staleness | > 30s | Halt new positions |
| Drift OI utilization | > 80% | Block trade |

**Drawdown is calculated using actual vault equity from Drift collateral**, not simulated PnL. This prevents false emergency triggers.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Blockchain | Solana (devnet / mainnet-beta) |
| On-chain Program | Anchor Framework (Rust) |
| Perp DEX | Drift Protocol v2 |
| Spot DEX | Jupiter Aggregator (HTTP API) |
| Price Oracle | Pyth Network (Hermes API) |
| RPC Provider | Helius |
| Wallet | Server Keypair (extends Drift SDK Wallet) |
| Cross-Chain | Arbitrum · Base · Optimism · Polygon · Avalanche · BNB |
| Dashboard | Vite + React 19 (live polling bot state API) |
| Language | TypeScript (bot) · React JSX (dashboard) · Rust (program) |
| Runtime | Node.js 18+ |

---

## Security

- **Never commit** your `keypair.json` or `.env` file
- Use a **dedicated hot wallet** with only the capital you intend to deploy
- Add `keypair.json` and `.env` to `.gitignore` (already included)
- Consider a [Squads multisig](https://squads.so) for larger vault sizes

---

## Disclaimer

This project is a **proof of concept**. Run on devnet first. Nothing in this repository constitutes financial advice.

**Past funding rates and basis spreads do not guarantee future returns.** The historical opportunity range of 8–25% APY reflects periods of elevated market activity. In low-volatility or bear-market conditions, funding rates can turn negative, eliminating or reversing yield. Use at your own risk.
