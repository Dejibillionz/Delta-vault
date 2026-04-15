# Delta Vault — Autonomous Delta-Neutral Trading Bot

**Production-ready autonomous market maker for Solana with institutional-grade risk management, cross-chain optimization, and dynamic capital allocation.**

---

## Overview

Delta Vault is a sophisticated **delta-neutral arbitrage engine** designed to extract funding rate yield while maintaining zero directional exposure to market price movements. Built on **Hyperliquid** for perpetual futures with integrated **Kamino & MarginFi** for stable lending yield, the bot operates a dual-income strategy: collect high funding rates through delta-neutral positioning (long spot + short perp) while parking idle capital in lending protocols that consistently deliver 4-5% APY.

**In plain English:** The bot profits from the difference between spot and futures prices without gambling on market direction. Your capital grows regardless of whether BTC goes up, down, or sideways.

---

## Architecture at a Glance

```
┌─────────────────────────────────────────────────────────┐
│            Delta Vault Orchestrator                      │
│  (15s strategy cycle + continuous risk monitoring)      │
└─────────────────────────────────────────────────────────┘
                          │
         ┌────────────────┼────────────────┐
         │                │                │
    ┌────▼────┐    ┌─────▼──────┐    ┌───▼─────────┐
    │Strategy │    │Risk Engine │    │Cross-Chain  │
    │Engine   │    │(10s cycle) │    │Optimizer    │
    │         │    │            │    │             │
    │• Funding│    │• Drawdown  │    │• Multi-chain│
    │  Rate   │    │  Monitor   │    │  Routing    │
    │  Arb    │    │• Latency   │    │• Fee Calcs  │
    │• Basis  │    │  Guards    │    │• Rebalance  │
    │  Trade  │    │• Collateral│    │             │
    │• Regime │    │  Checks    │    │             │
    │  Class  │    │            │    │             │
    └────┬────┘    └─────┬──────┘    └───┬─────────┘
         │                │               │
         └────────────────┼───────────────┘
                          │
         ┌────────────────┼────────────────┐
         │                │                │
    ┌────▼────────┐  ┌───▼────────┐  ┌───▼─────────┐
    │Hyperliquid  │  │Kamino/HL   │  │Jupiter      │
    │Executor     │  │Lending     │  │Spot Swap    │
    │             │  │            │  │             │
    │• Perp Longs │  │• Deposit   │  │• Rebalance  │
    │• Perp Shorts│  │• Withdraw  │  │• Portfolio  │
    │• Market Data│  │• Yield     │  │  Mgmt       │
    │• Funding    │  │            │  │             │
    │  Rates      │  │            │  │             │
    └─────────────┘  └────────────┘  └─────────────┘
```

---

## Core Features

### ⚡ **Delta-Neutral Arbitrage** 
The foundation of the strategy. Open a long spot position while simultaneously shorting an equivalent notional amount on Hyperliquid perps. Collect funding rate yields (typically 0.01–0.05% hourly = 8–40% APY) without directional risk.

**How it works:**
- Monitor funding rates across BTC, ETH, HYPE
- When funding exceeds threshold (configurable, default 0.5% APR), signal entry
- Buy spot at market, short perps at market
- Hold delta-neutral position while collecting hourly funding
- Exit when funding drops below profit target or hold duration expires

**Risk:** Market moves affect both legs equally (delta-neutral), but basis risk on execution causes minimal slippage.

---

### 🏛️ **Intelligent Capital Allocation**
Not all capital should be locked in trading. The bot splits your vault into two buckets:

| Component | Purpose | Yield | Risk |
|-----------|---------|-------|------|
| **Trading Capital (50-80%)** | Delta-neutral positions, funding rate collection | 8–40% APY | Low (hedged) |
| **Lending Capital (20-50%)** | Kamino, MarginFi stable yield | 4–5% APY | Very Low |

Each account preset auto-tunes bucket sizes. A `$20` account prioritizes lending (safer). A `$100k` enterprise vault maximizes trading while keeping 80% in lending for capital preservation.

---

### 🔄 **Funding Regime Classification**
Not all funding rates are created equal. The bot classifies market regime in real-time:

- **EXPANSION** — Funding rising, volatility increasing → Larger positions, longer holds
- **PEAK** — Funding at local max → Reduce size, prepare exit
- **DECAY** — Funding falling → Trim positions, tighten stops
- **RESET** — Volatility shock, regime flip likely → Pause, rebalance capital

Each regime signals different position sizing and risk parameters. This prevents you from holding overlarge positions just before funding crashes.

---

### 🌍 **Cross-Chain Optimization** (Multi-Chain Funding Arbitrage)
Why choose one chain when you can route capital to the highest-yield chain dynamically?

**Feature:** Continuously evaluates funding rates across Solana and Base (Hyperliquid, Kamino). When one chain offers ≥1.5% edge after bridge costs, automatically rebalances spot and perp exposure.

```
Example:
─────────────────────────────────────────────────────────
Chain    BTC Funding  ETH Funding  Best Action
─────────────────────────────────────────────────────────
Solana   +0.008%      +0.005%      —
Base     +0.012%      +0.004%      Move BTC to Base
─────────────────────────────────────────────────────────
→ Bot routes $50k BTC spot/perp to Base
→ Saves bridge cost, captures 0.4% APR extra
→ Auto-rebalances daily
```

**Safety:** Costs modeled into decision (bridge fees, slippage). Moves only execute if net edge > 1.5%.

---

### 🤖 **AI Agent Decision Overlay**
Beyond pure math, the bot includes an optional AI observational layer that analyzes:
- Momentum trends (short-window price acceleration)
- Market regime shifts
- Volatility spikes vs. baseline

Agent confidence scores (0–1) inform position sizing. High confidence momentum → larger positions. Uncertain regime → smaller positions.

**Not a black-box.** Agent decisions are logged with reasoning; you can disable it (AI_AGENT_ENABLED=false) and run pure strategy.

---

### 📊 **Real-Time Funding Rate Scanner**
Continuously ranks all assets by funding rate attractiveness. Re-scans every 5 minutes, highlights:
- **Top Yield:** Which asset has best current funding?
- **Best Risk-Adjusted:** Highest funding relative to volatility?
- **Regime:** Is this funding sustainable or peak?

Helps you decide: *Should I rotate spot capital from SOL into BTC?*

---

### ⏰ **Funding Settlement Timer**
Hyperliquid settles funding every 1 hour. The bot counts down to settlement:

```
[SETTLEMENT] Next funding in 47 minutes 32 seconds
[FUNDING] Current hourly APR: +0.0042% (~3.7% yearly)
[EST_HOURLY_PNL] $12.43 / hour (assuming 2 positions held)
```

Helps you understand: *If I enter now, how long until I collect first funding?* Crucial for short-term traders.

---

## Safety & Risk Management

Delta Vault runs **dual safety loops** to protect capital:

### Layer 1: Strategy Level (15s Cycle)
The main strategy loop evaluates:
- ✅ Funding rate sufficient? (MIN_FUNDING_RATE_APR)
- ✅ Position size safe? (MAX_POSITION_SIZE_PERCENT)
- ✅ Trade minimum met? (MIN_TRADE_SIZE_FLOOR + MIN_TRADE_SIZE_PERCENT)
- ✅ Slippage acceptable? (MAX_SLIPPAGE_PERCENT)
- ✅ Basis spread profitable? (BASIS_SPREAD threshold)

If any check fails, trade is **rejected** before order submission.

### Layer 2: Risk Engine (10s Cycle)
Faster than strategy, runs continuously and has veto power:

| Monitor | Threshold | Action |
|---------|-----------|--------|
| **Portfolio Drawdown** | > 10% | 🛑 EMERGENCY_CLOSE all positions |
| **Delta Exposure** | > 5% of NAV | ⚖️ REBALANCE positions |
| **Single Asset Loss** | > 7% unrealized | ❌ CLOSE that leg |
| **Free Collateral** | < 20% | 🚫 HALT_NEW_TRADES |
| **Funding Volatility** | > 20% relative jump | 📉 REDUCE_SIZE 50% |
| **Network Latency** | Solana RPC > 500ms | ⏸️ PAUSE execution |
| **Hyperliquid Latency** | API > 2s round-trip | 🔇 HALT orders |
| **Oracle Staleness** | Price > 30s old | 🛑 STOP new positions |

**Example:** You're in a $50k delta-neutral position. Suddenly, Hyperliquid API times out (>2s). Risk engine **pauses all new orders** until API recovers. Existing positions held, but no new entries triggered risk.

---

### Circuit Breakers

1. **Funding Rate Circuit Breaker:** If any asset's APR exceeds 300% (extreme regime), new entries blocked until normalization.

2. **Market Impact Cap:** No single trade can exceed 0.1% of 24h volume or 0.5% of open interest (prevents moving thin markets).

3. **Gross Notional Cap:** Total spot + perp notional ≤ equity × 1.5x leverage (prevents over-leverage).

---

## Configuration: Pick Your Profile

Choose a preset tuned for your account size. **Zero code changes required.**

| Profile | Account Size | Ideal Use Case | Min Trade | Max Position |
|---------|--------------|----------------|-----------|--------------|
| **SMALL** | <$500 | Testing, microaccounts, learning | $5 | 15% equity |
| **MEDIUM** | $500–$5k | Most live traders | $20 | 20% equity |
| **LARGE** | $5k–$100k | Professional traders | $100 | 30% equity |
| **PRODUCTION** | >$100k | Enterprise vaults, capital preservation | $500 | 15% equity |

**Activate with one line:**
```bash
CONFIG_PROFILE=SMALL npm run dev
```

See [PRESET_GUIDE.md](./PRESET_GUIDE.md) for detailed breakdowns of each preset.

---

## Quick Start

### Prerequisites
- Node.js 18+
- Hyperliquid testnet or mainnet API keys
- Solana devnet / mainnet RPC endpoint
- ~$20–$1,000 initial capital (or use DEMO_MODE)

### Installation
```bash
cd bot
npm install
```

### Configuration
```bash
# bot/.env
SOLANA_NETWORK=mainnet-beta          # or devnet
HYPERLIQUID_API_KEY=your_key
HYPERLIQUID_SECRET=your_secret
HYPERLIQUID_WALLET=your_address

# For $20 account
CONFIG_PROFILE=SMALL
DEMO_MODE=true                       # Start in dry-run
DEMO_EQUITY=20
```

### Run
```bash
# Dry-run (logs trades, no real orders)
npm run dev

# Live (requires DEMO_MODE=false)
DEMO_MODE=false npm run dev
```

### Monitor
- **Terminal:** Full strategy logs, position updates, funding rates
- **Telegram:** (Optional) Real-time alerts on trades, risk events, funding changes
- **HTTP API:** `http://localhost:3000/status` — JSON snapshot of vault state

---

## Execution Flow

```
┌─ Every 15 seconds ───────────────────────────────────────┐
│                                                            │
│  1. Fetch market data (Hyperliquid funding, Kamino yields)│
│  2. Run strategy (evaluate funding, basis, regime)       │
│  3. Generate signal (DELTA_NEUTRAL_OPEN, BASIS_TRADE, …) │
│  4. Size position (Kelly fraction, preset config)        │
│  5. Check risk engine (10s checks) — block if unsafe     │
│  6. Submit orders (spot + perp simultaneously)           │
│  7. Monitor execution (fill rates, slippage)             │
│  8. Log cycle (market snapshot, PnL, next actions)       │
│                                                            │
└─────────────────────────────────────────────────────────┘

┌─ Every 10 seconds (concurrent) ──────────────────────────┐
│                                                            │
│  Risk Monitor:                                            │
│  • Check portfolio drawdown, delta, collateral ratio     │
│  • Monitor network / exchange latency                    │
│  • Evaluate funding volatility                           │
│  • Take protective actions (halt, reduce, close)         │
│                                                            │
└─────────────────────────────────────────────────────────┘

┌─ Every 5 minutes ────────────────────────────────────────┐
│                                                            │
│  Scanner rescan:                                         │
│  • Rank all assets by funding rate, volatility           │
│  • Identify regime transitions (EXPANSION → DECAY)       │
│  • Suggest capital allocation shifts                     │
│                                                            │
└─────────────────────────────────────────────────────────┘

┌─ Every 30 seconds ───────────────────────────────────────┐
│                                                            │
│  API updates:                                            │
│  • POST vault state to external dashboard (optional)     │
│  • Send Telegram alerts if configured                    │
│  • Log full cycle summary (professional format)          │
│                                                            │
└─────────────────────────────────────────────────────────┘
```

---

## Real-World Example

**Setup:** $500 account, MEDIUM preset, live trading

```
09:05:12 [CYCLE] Starting cycle #437...
09:05:12 [MARKET] BTC: spot=$42,567, perp=$42,581 (+0.03%), funding=+0.0042% hourly
09:05:12 [MARKET] ETH: spot=$2,267, perp=$2,269 (+0.09%), funding=+0.0053% hourly
09:05:13 [SIGNAL] BTC: DELTA_NEUTRAL_OPEN | funding=+0.0042% (8.4% APR) exceeds threshold=0.005%
09:05:13 [SIGNAL] ETH: DELTA_NEUTRAL_OPEN | funding=+0.0053% (10.7% APR) exceeds threshold=0.005%

09:05:13 [POSITION_SIZE] BTC: $125 (25% of $500 capital) | perp notional: $125 short
09:05:13 [POSITION_SIZE] ETH: $100 (20% of $500 capital) | perp notional: $100 short

09:05:14 [EXECUTE] Submitting spot BUY: 0.00293 BTC @ market
09:05:14 [EXECUTE] Submitting perp SHORT: 0.003 BTC @ market
09:05:15 [FILL] Spot filled: 0.00293 BTC @ $42,578 (slippage: +$32)
09:05:15 [FILL] Perp filled: 0.003 BTC @ $42,575 (slippage: -$9)
09:05:15 [FUNDING] Next settlement: 47 minutes 32 seconds
09:05:15 [EST_HOURLY_PNL] $0.22 next hour (all positions combined)

[PORTFOLIO]
  Capital: $500.00
  Lending (Kamino): $200.00 @ 4.2% APY
  Trading (delta-neutral): $200.00 notional
  Cash: $100.00 (dry powder for rebalance)
  Total unrealized PnL: -$18.32 (due to entry slippage; will recover via funding)

[NEXT_ACTIONS]
  • Monitor funding settlement (47m 32s)
  • Check if regime transitions (currently EXPANSION)
  • Rebalance if delta > 5% (currently 0.1%)
```

---

## Advanced Features

### Bybit Venue Routing
When Bybit's funding rate exceeds Hyperliquid's by ≥0.2% APR AND Bybit has sufficient liquidity, route perp orders to Bybit and collect the spread arbitrage in addition to standard funding.

### Positive Funding Rate Persistence
A machine learning model (trained on historical Hyperliquid funding data) predicts: *Will funding stay positive for the next hour?*

High confidence → hold positions longer. Low confidence → tighter stop losses. Reduces whipsaws.

### Solana Congestion Detection
Before submitting Kamino deposit/withdrawal orders, check Solana RPC latency and recent slot times. If network is congested (>500ms latency), delay Kamino rebalancing until network recovers. Prevents expensive failed txs.

### Professional Logging
Output is formatted for senior traders & risk teams:
- **Sections** for market data, capital allocation, risk
- **Tables** for cross-chain evaluations, funding summaries
- **Color coding** for urgency (green = safe, yellow = warning, red = critical)
- **Timestamps** with millisecond precision for audit trails

---

## Monitoring & Observability

### Terminal Output
```
17:21:03 [INFO  ] [CrossChain] Evaluation Summary:
  ASSET    │ ROUTE          │ NET_EDGE   │ EST_PNL  │ ACTION
  BTC      │ solana→base    │ -1.024%    │ $-10     │ —
  ETH      │ solana→base    │ -0.988%    │ $-10     │ —
  HYPE     │ undefined→base │ -1.028%    │ $-10     │ —
```

### HTTP Status Endpoint
```bash
curl http://localhost:3000/status | jq .

{
  "vault_equity": 499.82,
  "positions": [
    {
      "asset": "BTC",
      "spot_side": "LONG",
      "spot_amount": 0.00293,
      "perp_side": "SHORT",
      "perp_amount": 0.003,
      "delta": 0.0001,
      "unrealized_pnl": -18.32
    }
  ],
  "risk_status": "NORMAL",
  "next_funding_settlement": "2026-04-15T17:52:00Z"
}
```

### Telegram Alerts (Optional)
- New positions opened/closed
- Risk events (drawdown warnings, collateral low)
- Funding rate spikes
- Regime transitions

---

## Deployment

### Development
```bash
npm run dev
```

### Production (Ubuntu/Docker)
```bash
docker build -t delta-vault .
docker run -d \
  --env-file .env \
  -p 3000:3000 \
  --restart always \
  delta-vault
```

### Systemd (Ubuntu)
```bash
sudo tee /etc/systemd/system/delta-vault.service <<EOF
[Unit]
Description=Delta Vault Trading Bot
After=network.target

[Service]
Type=simple
User=trader
WorkingDirectory=/opt/delta-vault/bot
ExecStart=/usr/bin/npm run dev
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable delta-vault
sudo systemctl start delta-vault
```

---

## Testing

### Unit Tests
```bash
npm test
```

### Demo Mode (Risk-Free)
```bash
DEMO_MODE=true npm run dev
```
All orders logged but not submitted. Simulates your strategy without real capital.

### Testnet
```bash
SOLANA_NETWORK=devnet npm run dev
```

---

## Troubleshooting

### "No trades opening"
1. Check funding rates: `grep SIGNAL logs.txt` — funding must exceed MIN_FUNDING_RATE_APR
2. Check risk engine: `grep "HALT\|REDUCE" logs.txt` — might be blocked by safety checks
3. Verify collateral: Free collateral > 20% is required

### "Trades execute but lose money immediately"
This is **normal in the first cycle.** Spot + perp entry slippage costs ~0.05–0.1% on entry. This is recovered via funding over 1–4 hours. Don't panic.

### "Connection refused (Hyperliquid API)"
Check internet connection and API key validity:
```bash
curl -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '{"type":"fundingHistory","coin":"BTC"}'
```

---

## Risk Disclaimer

**Delta Vault is an automated trading bot.** While designed with institutional-grade safety checks, no trading system is risk-free.

- **Market Risk:** Basis risk on entry/exit slippage
- **Liquidation Risk:** Over-leverage or extreme price moves can force closes
- **Smart Contract Risk:** Hyperliquid, Kamino, MarginFi are mature but audited code can have bugs
- **Operational Risk:** Network outages, exchange downtime, API failures

**Best Practices:**
- Start with DEMO_MODE=true
- Begin with small capital ($100–$1k)
- Monitor first 24 hours closely
- Set up Telegram alerts
- Use SMALL or MEDIUM preset initially
- Keep 20% collateral buffer (bot enforces this)

---

## License

Proprietary. For authorized users only.

---

## Support

- **Docs:** See [PRESET_GUIDE.md](./PRESET_GUIDE.md) for account configuration
- **Logs:** Check `bot/logs/` for detailed execution history
- **API:**  `/status` endpoint for vault metrics  
- **Alerts:** Telegram integration for real-time notifications

---

**Built for disciplined traders who want to automate funding rate arbitrage safely.**

🚀 Start with `CONFIG_PROFILE=SMALL npm run dev` and watch your capital compound.
