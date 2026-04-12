# ◈ Delta Vault — Adaptive Delta-Neutral Vault Strategy

> Hyperliquid · Kamino · MarginFi · Solana · BTC + ETH + SOL + JTO · Mainnet-Ready

A production-ready delta-neutral vault strategy that generates stable yield through funding rate arbitrage, basis spread capture, cross-chain opportunity routing, and adaptive capital allocation — with zero directional price exposure.

---

## Strategy Overview

| Mode | Trigger | Action | Yield Source |
|------|---------|--------|--------------|
| **DELTA_NEUTRAL** | \|Funding rate\| > 0.01%/hr (mainnet) | Long spot (Jupiter) + short perp (Hyperliquid) | Funding payments |
| **BASIS_TRADE** | Basis spread > 1.0% (mainnet) | Buy spot + short futures | Spread convergence |
| **PARK_CAPITAL** | No opportunity | Deploy leftover to Kamino Finance (USDC lending) | Lending APY |
| **CROSS_CHAIN** | Better net edge on another chain (devnet only) | Bridge capital to best venue | Inter-venue funding arb |

**Bidirectional funding:** Positive funding → LONG spot + SHORT perp. Negative funding → SHORT spot (via MarginFi borrow) + LONG perp.
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
│Hyper-  │ │Signals │ │Drawdown  │ │Jupiter  │ │7-chain scan  │
│liquid  │ │Sizing  │ │Vol debounce│spot swap│ │Fee-adj edge  │
│        │ │Carryover│ │Warm-up  │ │Hyper-   │ │Cost model    │
│        │ │        │ │          │ │liquid   │ │              │
│        │ │        │ │          │ │perp     │ │              │
└────────┘ └────────┘ └──────────┘ └─────────┘ └──────────────┘
```

**Strategy loop:** Every 15 seconds (logs every 2 cycles ≈ 30s)
**Risk loop:** Every 10 seconds
**State API:** `http://localhost:3001` (polled by dashboard every 5s)

---

## Execution Flow — True Delta-Neutral

The bot uses **three DeFi protocols** to construct a fully delta-neutral position:

| Leg | Protocol | Method | Why |
|-----|----------|--------|-----|
| **Spot LONG** | Jupiter Aggregator | HTTP API swap (USDC → asset) | Best-price routing, no minimum order size |
| **Perp SHORT** | Hyperliquid | EIP-712 signed REST order | Deep perpetuals market with funding payments |
| **Lending yield** | Kamino Finance | USDC supply-side deposit | Earns ~4.5% APY on idle capital |
| **Negative-funding borrow** | MarginFi | Borrow asset → sell on Jupiter | Synthetic short for negative-funding regime |

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

Perp positions are closed via Hyperliquid reduce-only IOC orders. Spot positions are unwound via Jupiter reverse swap. MarginFi borrows are repaid before collateral is retrieved.

### Duplicate Position Guard

Before opening any new position, the bot checks if there's already an open position for that asset. If so, it logs a warning and skips:

```
[INFO] BTC: Position already open — skipping new DELTA_NEUTRAL_OPEN
```

---

## Features

### Capital Manager
Every cycle starts with a strict reserve-before-execute flow:

1. **Reserve** — allocate capital for each trade before execution
2. **Execute** — use only reserved amount (never hardcoded sizes)
3. **Release** — return reserved capital if execution fails or is skipped
4. **Lend** — deploy only remaining leftover capital to Kamino USDC lending

### Carryover Accumulation
Sub-minimum allocations accumulate across cycles and execute once meaningful:

- Allocation below `MIN_TRADE_SIZE` ($100) → **accumulated** into per-asset carryover
- Carryover + next cycle's allocation → **executes** once the sum crosses the minimum
- Signal gone quiet → carryover **decays by 25% per cycle** instead of hard resetting

### Cross-Chain Funding Arbitrage
The bot evaluates funding rates across 7 chains per cycle and routes capital to the highest net-yield venue after bridge + gas + slippage costs:

| Chain | Venue |
|-------|-------|
| Solana | Hyperliquid |
| Arbitrum | GMX |
| Base | — |
| Optimism | — |
| Polygon | — |
| Avalanche | — |
| BNB Chain | — |

> **Note:** On mainnet, non-Solana chain funding rates return zero (real API integrations pending). Cross-chain execution runs in simulation mode — only Solana/Hyperliquid trades are live.

### Adaptive AI Agent
A lightweight adaptive AI agent module observes funding conditions and gates per-cycle execution:

- Both BTC and ETH can trade simultaneously — the agent only blocks an asset if it explicitly decides to **SKIP** (underperforming)
- Applies dynamic max-size caps derived from confidence, win-rate, and volatility
- Emits structured `[AI AGENT]` logs each cycle
- Exposes agent state over the bot API for dashboard rendering

### Reverse Delta-Neutral (Negative Funding)
Delta-neutral execution is explicitly two-way and regime-aware:

- Positive funding: **LONG spot (Jupiter) + SHORT perp (Hyperliquid)**
- Negative funding: **BORROW asset (MarginFi) → SELL spot (Jupiter) + LONG perp (Hyperliquid)**
- Profitability gate: `|fundingRate| × 8760 − borrowRate > 2%` before opening negative-funding trades
- Exit logic is direction-aware (uses effective funding, not raw sign)
- Funding regime flips trigger close/reverse behavior

### Live Dashboard
The bot serves a real-time JSON state endpoint at `http://localhost:3001`. The React dashboard polls it every 5 seconds and renders:

- Prices, funding rates, basis spreads
- Open positions (per-leg: spot + perp)
- Execution events and position status
- Lending by asset (Kamino APR)
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
│       ├── strategyEngine.ts          # Bidirectional signal generation + symmetric sizing
│       ├── enhancedRiskEngine.ts      # Risk checks + smoothed funding volatility + debounce
│       ├── anchorClient.ts            # Anchor on-chain program client (NAV/risk oracle)
│       ├── walletIntegration.ts       # Standalone ServerWallet (Solana keypair)
│       ├── telegramAlerts.ts          # Real-time Telegram notifications
│       ├── logger.ts                  # Structured logging
│       ├── agent/                     # AI agent module
│       │   ├── decision.ts            # Decision logic
│       │   ├── sizing.ts              # Dynamic position sizing
│       │   ├── state.ts               # Rolling state tracking
│       │   └── logger.ts              # Agent-specific logging
│       ├── config/
│       │   └── crossChain.ts          # Cross-chain chains list + cooldown + horizon config
│       ├── services/
│       │   ├── hyperliquidExecution.ts  # Hyperliquid perp orders + funding data + market snapshots
│       │   ├── jupiterSpot.ts           # Jupiter V6 spot swaps (buy/sell USDC ↔ asset)
│       │   ├── kaminoLending.ts         # Kamino Finance USDC lending (supply-side yield)
│       │   ├── marginFiLending.ts       # MarginFi borrow leg (negative-funding short-spot hedge)
│       │   ├── crossChainFunding.ts     # Multi-chain funding aggregator (clamped + normalized)
│       │   └── costModel.ts             # Route-aware bridge + gas + slippage cost model
│       └── strategy/
│           ├── crossChainDecision.ts    # Per-asset best-chain selection (fee-adjusted net edge)
│           └── crossChainExecutor.ts    # Cross-chain move execution wrapper
│
├── programs/
│   └── delta_vault/                   # Anchor on-chain program (Rust)
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs
│           ├── vault.rs               # Deposit / withdraw + NAV staleness guard
│           ├── strategy.rs            # Bot authorization + 24hr rotation timelock
│           ├── risk.rs                # On-chain guardrails + risk oracle PDA
│           └── fees.rs                # Epoch-gated management + performance fees
│
├── frontend/                          # Standalone presentation components (legacy)
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
# Edit .env — set HELIUS_RPC_URL, WALLET_PRIVATE_KEY_BASE58
# For live trading: set EVM_PRIVATE_KEY (Hyperliquid signing)
npm run dev
```

### 3. Build the Vault Program (optional — enables on-chain sync)

```bash
# Install toolchain (once)
cargo install --git https://github.com/coral-xyz/anchor --tag v0.29.0 anchor-cli --locked

# Build and copy IDL
cd programs/delta_vault
anchor build
cp target/idl/delta_vault.json ../../bot/src/idl/delta_vault.json

# Deploy to devnet
anchor deploy --provider.cluster devnet
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
- [Helius API key](https://helius.dev) — devnet key for testing, mainnet for live trading
- EVM private key for Hyperliquid order signing (live mode only)
- ~4 SOL in the deployer wallet for vault program deployment (one-time, optional)

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

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Blockchain | Solana (devnet / mainnet-beta) |
| On-chain Program | Anchor Framework 0.29 (Rust) |
| Perp DEX | Hyperliquid (EIP-712 signed REST API) |
| Spot DEX | Jupiter Aggregator V6 (HTTP API) |
| USDC Lending | Kamino Finance (supply-side, ~4.5% APR) |
| Borrow (neg. funding) | MarginFi V2 (125% collateral ratio, 80% LTV) |
| RPC Provider | Helius |
| Wallet | Standalone ServerWallet (Solana keypair) |
| Cross-Chain | Arbitrum · Base · Optimism · Polygon · Avalanche · BNB |
| Dashboard | Vite + React 19 (live polling bot state API) |
| Language | TypeScript (bot) · React JSX (dashboard) · Rust (program) |
| Runtime | Node.js 18+ |

---

## Security

- **Never commit** your `keypair.json` or `.env` file
- Use a **dedicated hot wallet** with only the capital you intend to deploy
- Add `keypair.json` and `.env` to `.gitignore` (already included)
- The Anchor program enforces a **24-hour timelock** for bot key rotation
- Consider a [Squads multisig](https://squads.so) for larger vault sizes

---

## Disclaimer

This project is a **proof of concept**. Run on devnet first. Nothing in this repository constitutes financial advice.

**Past funding rates and basis spreads do not guarantee future returns.** The historical opportunity range of 8–25% APY reflects periods of elevated market activity. In low-volatility or bear-market conditions, funding rates can turn negative, eliminating or reversing yield. Use at your own risk.
