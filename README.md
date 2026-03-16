# ◈ Delta Vault — Adaptive Delta-Neutral Vault Strategy

> **Hackathon Submission** · Drift Protocol · Solana · BTC + ETH

A production-ready delta-neutral vault strategy that generates stable yield through funding rate arbitrage, basis spread capture, and adaptive capital allocation — with zero directional price exposure.

---

## ⚠️ Simulation Mode

This project runs in **simulation mode** by default. No real funds are at risk. Connect a Phantom wallet and configure `.env` to go live on Drift Protocol mainnet.

---

## Strategy Overview

| Mode | Trigger | Action | Yield Source |
|------|---------|--------|--------------|
| **DELTA_NEUTRAL** | Funding rate > 0.01%/hr | Long spot + Short perp | Funding payments |
| **BASIS_TRADE** | Basis spread > 1.0% | Buy spot + Short futures | Spread convergence |
| **PARK_CAPITAL** | No opportunity | Deploy to stable yield | Lending APY |

**Historical Opportunity Range:** 8–25% APY (market-dependent)  
**Max Drawdown:** 10% hard stop  
**Net Delta:** ~0 (market-neutral)

> ⚠️ **Disclaimer:** Historical funding rates and basis spreads do not guarantee future returns. Yield is entirely dependent on prevailing market conditions, funding rate regimes, and liquidity. The 8–25% range reflects observed historical opportunity windows — actual results may be significantly lower or zero in low-volatility or negative-funding environments.

---

## Repository Structure

```
adaptive-delta-neutral-vault/
│
├── frontend/
│   ├── delta-neutral-bot.jsx          # Live trading dashboard
│   └── delta-vault-presentation.jsx   # Full presentation (3 tabs)
│
├── bot/
│   ├── package.json
│   ├── tsconfig.json
│   ├── .env.example
│   └── src/
│       ├── index.ts                   # Main orchestrator + bot loop
│       ├── realMarketData.ts          # Pyth Network + Helius live data
│       ├── strategyEngine.ts          # Signal generation + sizing
│       ├── executionEngine.ts         # Drift perp order placement
│       ├── liveExecution.ts           # Atomic dual-leg execution
│       ├── enhancedRiskEngine.ts      # Risk checks incl. congestion + oracle staleness
│       ├── liquidityGuard.ts          # Jupiter depth + Drift OI validation
│       ├── walletIntegration.ts       # Phantom + server keypair
│       ├── spotHedge.ts               # Jupiter spot swaps
│       └── logger.ts                  # Structured logging
│
├── programs/
│   └── delta_vault/                   # Anchor on-chain program (Rust)
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs                 # Program entry point
│           ├── vault.rs               # Deposit / withdraw logic
│           ├── strategy.rs            # Bot authorization + strategy mode
│           ├── risk.rs                # On-chain guardrails
│           └── fees.rs                # Management + performance fee accrual
│
├── docs/
│   └── strategy.md                    # Full strategy documentation
│
└── README.md
```

---

## Quick Start

### 1. Frontend (Dashboard)

Open `frontend/delta-vault-presentation.jsx` in any React environment (Claude.ai artifacts, CodeSandbox, StackBlitz, etc.).

The dashboard will:
- Automatically fetch **live BTC/ETH prices from Pyth Network**
- Simulate Drift funding rates and strategy decisions
- Show a **Connect Phantom** button for wallet integration

### 2. Bot (Server)

```bash
cd bot
npm install
cp .env.example .env
# Edit .env with your Helius API key and wallet keypair path
npm run dev
```

### Prerequisites

- Node.js 18+
- A funded Solana wallet (keypair JSON file)
- [Helius API key](https://helius.dev) (free tier works)
- USDC deposited as collateral on [Drift Protocol](https://drift.trade)

---

## Bot Architecture

```
┌─────────────────────────────────────────────┐
│              Main Orchestrator               │
│                 index.ts                     │
└────┬──────────┬──────────┬──────────────────┘
     │          │          │
┌────▼───┐ ┌───▼────┐ ┌───▼──────┐ ┌─────────┐
│ Market │ │Strategy│ │   Risk   │ │Execution│
│  Data  │ │ Engine │ │  Engine  │ │ Engine  │
│        │ │        │ │          │ │         │
│Pyth +  │ │Signals │ │Drawdown  │ │Drift    │
│Helius  │ │Sizing  │ │Delta exp │ │Jupiter  │
└────────┘ └────────┘ └──────────┘ └─────────┘
```

**Strategy loop:** Every 30 seconds  
**Risk loop:** Every 10 seconds  

---

## Risk Engine

| Check | Limit | Action |
|-------|-------|--------|
| Portfolio drawdown | > 10% | Emergency close all |
| Drawdown warning | > 5% | Alert + monitor |
| Delta exposure | > 5% NAV | Rebalance perp legs |
| Single asset loss | > 7% | Close that leg |
| Free collateral | < 20% | Halt new entries |
| Funding rate volatility | > 0.5 CV | Reduce position sizes 50% |
| Solana RPC latency | > 500ms | Pause execution |
| Oracle staleness | > 30s | Halt new positions |
| Jupiter pool depth | Trade > 0.5% of pool | Block trade |
| Price impact | > 0.5% | Block trade |
| Drift OI utilization | > 80% | Block trade |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Blockchain | Solana Mainnet-Beta |
| On-chain Program | Anchor Framework (Rust) |
| Perp DEX | Drift Protocol v2 |
| Spot Routing | Jupiter Aggregator v6 |
| Price Oracle | Pyth Network (Hermes API) |
| RPC Provider | Helius |
| Wallet | Phantom / Server Keypair |
| Language | TypeScript (bot) · React (frontend) · Rust (program) |
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
