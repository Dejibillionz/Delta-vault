# ◈ Delta Vault — Adaptive Delta-Neutral Vault Strategy

> **Hackathon Submission** · Drift Protocol · Solana · BTC + ETH

A production-ready delta-neutral vault strategy that generates stable yield through funding rate arbitrage, basis spread capture, cross-chain opportunity routing, and adaptive capital allocation — with zero directional price exposure.

---

## ⚠️ Simulation Mode

This project runs in **simulation mode** by default. No real funds are at risk. Configure `.env` to go live on Drift Protocol devnet or mainnet.

---

## Strategy Overview

| Mode | Trigger | Action | Yield Source |
|------|---------|--------|--------------|
| **DELTA_NEUTRAL** | \|Funding rate\| > 0.001%/hr | Long/short spot + opposite perp | Funding payments |
| **BASIS_TRADE** | Basis spread > 0.5% | Buy spot + short futures | Spread convergence |
| **PARK_CAPITAL** | No opportunity | Deploy leftover to stable yield | Lending APY |
| **CROSS_CHAIN** | Better net edge on another chain | Bridge capital to best venue | Inter-venue funding arb |

**Bidirectional funding:** Positive funding → LONG spot + SHORT perp. Negative funding → SHORT spot + LONG perp.  
**Historical Opportunity Range:** 8–25% APY (market-dependent)  
**Max Drawdown:** 10% hard stop  
**Net Delta:** ~0 (market-neutral)

> ⚠️ **Disclaimer:** Historical funding rates and basis spreads do not guarantee future returns. Yield is entirely dependent on prevailing market conditions, funding rate regimes, and liquidity. The 8–25% range reflects observed historical opportunity windows — actual results may be significantly lower or zero in low-volatility or negative-funding environments.

---

## New Features

### 🏦 Capital Manager
Every cycle starts with a strict reserve-before-execute flow:

1. **Reserve** — allocate capital for each trade before execution
2. **Execute** — use only reserved amount (never hardcoded sizes)
3. **Release** — return reserved capital if execution fails or is skipped
4. **Lend** — deploy only remaining leftover capital to stable yield

A dedicated `[CAPITAL]` section is printed each cycle:
```
[CAPITAL]
Starting: $250000.00
Reserved For Trades: $1953.00
Released From Failed/Skipped: $0.00
Remaining Before Lending: $248047.00
Lent (Leftover): $248047.00
Remaining After Lending: $0.00
CarryOver BTC: $0.00 | ETH: $412.00 | Total: $412.00
```

### 📈 Carryover Accumulation
Sub-minimum allocations are no longer discarded. Instead they accumulate across cycles and execute once meaningful:

- Allocation below `MIN_TRADE_SIZE` ($1,000) → **accumulated** into per-asset carryover
- Carryover + next cycle's allocation → **executes** once the sum crosses the minimum
- Signal gone quiet → carryover **decays by 25% per cycle** (`CARRYOVER_DECAY = 0.75`) instead of hard resetting
- Carryover below $1 → **expires** cleanly with a log event

### 🌉 Cross-Chain Funding Arbitrage
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

Decisions are fee-adjusted over a configurable projection horizon. A cross-chain move only executes when `expectedProfitUSD > 0` after all costs.

### 📊 Live Dashboard Sync
The bot serves a real-time JSON state endpoint at `http://localhost:3001`. The dashboard polls it every 5 seconds and renders actual bot state instead of simulated values:

- Prices, funding rates, basis
- Open positions (per-leg: spot + perp)
- Execution events
- Lending by asset
- Capital manager state (reserved, lent, carryover)
- Cross-chain decisions and funding map

### 🛡️ Improved Risk Engine
| Improvement | Detail |
|-------------|--------|
| Funding clamped | ±0.5% max (`sanitizeFunding`) |
| Smoothed funding | EMA with α=0.2, initialized to first sample (no startup spike) |
| Relative volatility | `abs(current - prev) / max(abs(prev), 0.0001)` instead of raw std-dev/mean |
| Lower threshold | 0.5 → **0.2** for earlier detection |
| Debounced warning | `REDUCE_SIZE` fires once on entry, clears once normalized (no 10s spam) |
| Warm-up guard | Volatility check suppressed until ≥4 smoothed samples collected |

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
│       ├── liveExecution.ts           # Atomic dual-leg execution (short-perp / long-perp)
│       ├── enhancedRiskEngine.ts      # Risk checks + smoothed funding volatility + debounce
│       ├── liquidityGuard.ts          # Jupiter depth + Drift OI validation
│       ├── walletIntegration.ts       # Server keypair
│       ├── spotHedge.ts               # Jupiter spot swaps
│       ├── logger.ts                  # Structured logging
│       ├── config/
│       │   └── crossChain.ts          # Cross-chain chains list + cooldown + horizon config
│       ├── services/
│       │   ├── crossChainFunding.ts   # Multi-chain funding aggregator (clamped + normalized)
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
# Edit .env with your Helius API key and wallet keypair
npm run dev
```

### Prerequisites

- Node.js 18+
- A funded Solana wallet (keypair JSON file or base58 private key)
- [Helius API key](https://helius.dev) (free tier works)
- USDC deposited as collateral on [Drift Protocol](https://drift.trade)

---

## Bot Architecture

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
│Pyth +  │ │Signals │ │Drawdown  │ │Drift    │ │7-chain scan  │
│Helius  │ │Sizing  │ │Vol debounce│Jupiter │ │Fee-adj edge  │
│        │ │Carryover│ │Warm-up  │ │Carryover│ │Cost model    │
└────────┘ └────────┘ └──────────┘ └─────────┘ └──────────────┘
```

**Strategy loop:** Every 30 seconds  
**Risk loop:** Every 10 seconds  
**State API:** `http://localhost:3001` (polled by dashboard every 5s)

---

## Risk Engine

| Check | Limit | Action |
|-------|-------|--------|
| Portfolio drawdown | > 10% | Emergency close all |
| Drawdown warning | > 5% | Alert + monitor |
| Delta exposure | > 5% NAV | Rebalance perp legs |
| Single asset loss | > 7% | Close that leg |
| Free collateral | < 20% | Halt new entries |
| Funding rate volatility | > 0.2 relative jump (smoothed, clamped) | Reduce position sizes 50% — once per event |
| Solana RPC latency | > 500ms | Pause execution |
| Oracle staleness | > 30s | Halt new positions |
| Jupiter pool depth | Trade > 0.5% of pool | Block trade |
| Price impact | > 0.5% | Block trade |
| Drift OI utilization | > 80% | Block trade |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Blockchain | Solana (devnet / mainnet-beta) |
| On-chain Program | Anchor Framework (Rust) |
| Perp DEX | Drift Protocol v2 |
| Spot Routing | Jupiter Aggregator v6 |
| Price Oracle | Pyth Network (Hermes API) |
| RPC Provider | Helius |
| Wallet | Server Keypair (base58) |
| Cross-Chain | Arbitrum · Base · Optimism · Polygon · Avalanche · BNB |
| Dashboard | Vite + React (live polling bot state API) |
| Language | TypeScript (bot) · React (dashboard) · Rust (program) |
| Runtime | Node.js 18+ |

---

## Security

- **Never commit** your `keypair.json` or `.env` file
- Use a **dedicated hot wallet** with only the capital you intend to deploy
- Add `keypair.json` and `.env` to `.gitignore` (already included)
- Consider a [Squads multisig](https://squads.so) for larger vault sizes

---

## Disclaimer

This project is a **hackathon submission and proof of concept**. It runs in simulation mode by default. Nothing in this repository constitutes financial advice.

**Past funding rates and basis spreads do not guarantee future returns.** The historical opportunity range of 8–25% APY reflects periods of elevated market activity. In low-volatility or bear-market conditions, funding rates can turn negative, eliminating or reversing yield. Use at your own risk.
