# Account Size Presets Guide

The Delta Vault bot now includes **4 preset configurations** optimized for different account sizes. This allows you to run the bot without modifying the core code.

## Quick Start for $20 Account

Edit `bot/.env` and uncomment:

```bash
CONFIG_PROFILE=SMALL
```

Then run:
```bash
npm run dev
```

You'll see at startup:
```
[CONFIG] Loaded preset: SMALL
[CONFIG] Description: Optimized for accounts under $500 (tight risk, frequent small trades)
```

---

## Available Presets

### SMALL - Accounts Under $500

**Best for:** Testing, small accounts, frequent trades

```bash
CONFIG_PROFILE=SMALL
```

**Settings:**
- Min trade: $5 (floor: $5, 20% of equity)
- Max position: 15% of equity
- Max drawdown: 10%
- Funding threshold: 1% APR
- Capital split: 50% trading / 50% lending
- Max hold: 3 hours
- Cross-chain: **Disabled** (too expensive)

---

### MEDIUM - Accounts $500-$5,000

**Best for:** Most live traders

```bash
CONFIG_PROFILE=MEDIUM
```

**Settings:**
- Min trade: $20 (floor: $20, 10% of equity)
- Max position: 20% of equity
- Max drawdown: 10%
- Funding threshold: 0.5% APR
- Capital split: 60% trading / 40% lending
- Max hold: 4 hours
- Cross-chain: Enabled (requires 2% edge)

---

### LARGE - Accounts $5,000+

**Best for:** Large traders, maximize APR

```bash
CONFIG_PROFILE=LARGE
```

**Settings:**
- Min trade: $100 (floor: $100, 5% of equity)
- Max position: 30% of equity
- Max drawdown: 15%
- Funding threshold: 0.3% APR
- Capital split: 70% trading / 30% lending
- Max hold: 6 hours
- Cross-chain: Enabled (requires 1% edge)

---

### PRODUCTION - Enterprise Vaults ($100k+)

**Best for:** Institutional vaults, capital preservation

```bash
CONFIG_PROFILE=PRODUCTION
```

**Settings:**
- Min trade: $500 (floor: $500, 2% of equity)
- Max position: 15% of equity (capped)
- Max drawdown: 8% (conservative)
- Funding threshold: 0.5% APR (high bar)
- Capital split: 80% lending / 20% trading
- Max hold: 4 hours (strict)
- Cross-chain: **Disabled** (use dedicated routes)

---

## How Presets Work

1. **Startup Priority:**
   ```
   CONFIG_PROFILE (if set) → overrides all .env values
   |
   Individual .env values (if no preset)
   |
   Default hardcoded values
   ```

2. **Override Specific Settings:**
   Even with a preset active, you can override individual settings:
   ```bash
   CONFIG_PROFILE=SMALL
   MIN_TRADE_SIZE_FLOOR=10      # Override just this one
   ```

3. **No Changes to Original Bot:**
   - Original code unchanged
   - Presets are additive (don't modify bot behavior unless active)
   - Can switch presets anytime by editing `.env` and restarting

---

## For Your $20 Live Test

**Recommended setup:**

```bash
# bot/.env

CONFIG_PROFILE=SMALL

# Optional overrides:
# MIN_TRADE_SIZE_FLOOR=5       # Allow $5 trades
# MAX_DRAWDOWN_PERCENT=0.15    # More room for $20 account

DEMO_MODE=false                # Switch to live when ready
DEMO_EQUITY=20                 # Your actual starting capital
```

**What happens:**
- Bot limits: min $5 trades, 15% max position, 10% drawdown stop
- Capital: 50% lending (4.5% yield), 50% trading
- Cross-chain disabled (saves fees)
- Telegram alerts enabled

---

## Troubleshooting

**Q: Preset not loading?**
```bash
# Make sure format is exactly:
CONFIG_PROFILE=SMALL    # ← uppercase, no spaces
```

**Q: Want to use custom settings?**
```bash
# Just comment out CONFIG_PROFILE:
# CONFIG_PROFILE=SMALL

# And set individual .env values instead
MIN_TRADE_SIZE_FLOOR=25
MAX_POSITION_SIZE_PERCENT=0.18
```

**Q: Can I create a custom preset?**

Yes! Edit `bot/src/presets.ts` and add your own:

```typescript
CUSTOM: {
  name: "CUSTOM",
  description: "Your description",
  settings: {
    MIN_TRADE_SIZE_FLOOR: 10,
    MAX_POSITION_SIZE_PERCENT: 0.25,
    // ... other settings
  },
}
```

Then use:
```bash
CONFIG_PROFILE=CUSTOM
```

---

## Summary

| Preset | Account Size | Use Case | Min Trade | Cross-Chain |
|--------|-------------|----------|-----------|------------|
| **SMALL** | <$500 | Testing, small accounts | $5 | ❌ No |
| **MEDIUM** | $500-$5k | Most users | $20 | ✅ Yes |
| **LARGE** | $5k+ | Maximize APR | $100 | ✅ Yes |
| **PRODUCTION** | $100k+ | Enterprise | $500 | ❌ No |

Choose one preset and start trading! No code changes needed. 🚀
