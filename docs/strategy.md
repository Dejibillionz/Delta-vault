# Delta Vault — Strategy Documentation

## Overview

The Adaptive Delta-Neutral Vault captures yield from perpetual futures market inefficiencies on Solana while maintaining near-zero directional price exposure.

Capital is accepted in USDC and deployed across three strategy modes depending on market conditions.

> ⚠️ **Disclaimer:** Historical funding rates and basis spreads do not guarantee future returns. The yield ranges described in this document reflect observed historical opportunity windows on Drift Protocol. Actual returns are entirely market-dependent. In low-volatility or negative-funding environments, yield may be significantly lower or zero. This is not financial advice.

---

## Strategy Thesis

Perpetual futures markets create funding rate imbalances between long and short traders.

When the market is bullish (positive funding), long holders pay short holders a recurring fee every hour. The vault exploits this by:

1. Buying the asset **spot** (via Jupiter) → creates a long position
2. Shorting the same asset **perpetual** (via Drift) → creates a short of equal size

The two legs cancel out all price direction exposure (net delta ≈ 0), leaving only the funding yield as profit.

When funding drops below the threshold, capital rotates into **basis trades** where the futures price converges toward spot price over time.

When neither opportunity is attractive, idle capital is **parked in stable yield** until conditions improve.

---

## Decision Logic

```typescript
if (fundingRate > 0.0001) {
  // 0.01%/hr minimum → ~87.6% APR on the funding alone
  return "DELTA_NEUTRAL"
}

if (basisSpread > 0.01) {
  // 1% spread → profitable convergence trade
  return "BASIS_TRADE"
}

return "PARK_CAPITAL"
```

---

## Mode 1: Delta-Neutral (Funding Arbitrage)

**Trigger:** Hourly funding rate > 0.01%

**Execution:**
- Open spot LONG via Jupiter (USDC → BTC or ETH)
- Open perp SHORT of equal size via Drift Protocol

**Yield source:** Funding payments flow from long perpetual holders to the vault's short position every hour.

**Example (BTC, $100K notional, 0.01%/hr funding):**
- Hourly yield: $10
- Daily yield: $240
- Monthly yield: ~$7,300
- Annualized APR: ~87.6% *(historical example only — actual rates vary significantly)*

> **Note:** This example uses a 0.01%/hr funding rate. Historical opportunity range across market cycles: **8–25% APY** (market-dependent). Rates can fall to zero or turn negative in bearish or low-volatility conditions. Past funding rates do not guarantee future returns.

**Exit conditions:**
- Funding rate drops below 0.005%/hr exit threshold
- Risk engine drawdown/delta limit triggered

---

## Mode 2: Basis Trade (Spread Arbitrage)

**Trigger:** (perpPrice - spotPrice) / spotPrice > 1.0%

**Execution:**
- Buy asset spot via Jupiter
- Short the equivalent perpetual on Drift

**Yield source:** When futures trade at a premium to spot, they converge over time. The vault captures this convergence.

**Example:**
- Spot BTC: $68,000
- Futures BTC: $69,000
- Basis: 1.47%
- Action: Buy spot at $68K, short futures at $69K
- Profit when they converge: ~$1,000 per BTC

**Exit conditions:**
- Basis spread narrows below 0.3% exit threshold
- Position held until convergence

---

## Mode 3: Capital Parking

**Trigger:** No funding or basis opportunity above thresholds

**Execution:**
- USDC sits idle or is deployed to a low-risk lending protocol
- Bot continues scanning every 30 seconds

**Yield source:** Lending APY (e.g. marginfi, Solend)

---

## Risk Management

### Hard Limits

| Limit | Value | Action |
|-------|-------|--------|
| Max portfolio drawdown | 10% | Emergency close ALL positions |
| Drawdown warning level | 5% | Alert, heightened monitoring |
| Max net delta exposure | 5% of NAV | Trigger rebalance |
| Max single asset loss | 7% | Close that position's legs |
| Min free collateral ratio | 20% | Halt all new position entries |

### Risk Engine Cadence

- **Strategy loop:** Every 30 seconds
- **Risk check loop:** Every 10 seconds (3x faster)

This ensures risk limits are enforced well before the next strategy cycle.

### Delta Neutrality

Delta is measured as the net directional exposure in USD as a percentage of NAV.

For delta-neutral positions (equal spot long + perp short), delta ≈ 0.

For basis trades, a small residual delta may exist until both legs are fully executed. The risk engine monitors and rebalances if this exceeds 5%.

---

## Position Sizing

Positions are sized proportionally to signal strength:

**Delta-neutral:** Size scales from 25% to 100% of the max allocation based on the funding rate multiple above threshold.

**Basis trade:** Size scales from 20% to 80% of max allocation based on basis spread multiple above threshold.

**Max per-asset allocation:** 40% of vault NAV

---

## Execution Flow

```
Signal detected
       │
       ▼
LEG 1: Jupiter swap (USDC → spot asset)
       │
       ├── Failed? → Abort, no perp order sent
       │
       ▼
LEG 2: Drift placePerpOrder(SHORT)
       │
       ├── Failed? → Unwind spot leg via Jupiter
       │
       ▼
Position recorded, monitoring begins
```

Both legs are executed atomically (best-effort). If either fails, the other is automatically unwound to prevent one-sided exposure.

---

## Infrastructure

| Component | Details |
|-----------|---------|
| RPC | Helius mainnet-beta (WebSocket + REST) |
| Price oracle | Pyth Network Hermes API |
| Perp exchange | Drift Protocol v2 |
| Spot routing | Jupiter Aggregator v6 |
| Solana network | Mainnet-Beta |
| Deployment | AWS EC2 / Node.js + PM2 |

---

## Future Improvements

- AI-based opportunity scanning across all Drift markets
- Dynamic risk adjustment based on volatility regime
- Multi-asset expansion (SOL, AVAX, ARB)
- Automated portfolio optimization using Kelly criterion
- On-chain vault smart contract with permissionless deposits
- Telegram / Discord alert integration
