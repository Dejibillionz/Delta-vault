# Delta Vault — Hackathon Demo Checklist

Step-by-step guide for the day of the presentation.
Estimated total setup time: **30–60 minutes** (first time), **5 minutes** (repeat).

---

## Before the Day

### ✅ One-time setup (do this now)

- [ ] **Get a Helius API key** — free at https://helius.dev (2 min)
- [ ] **Run setup script:**
  ```bash
  cd repo
  node scripts/setup-devnet.js
  ```
  This generates your wallet, airdrops SOL, creates USDC account, writes .env

- [ ] **Add Helius key to .env:**
  ```
  HELIUS_RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY_HERE
  HELIUS_WS_URL=wss://devnet.helius-rpc.com/?api-key=YOUR_KEY_HERE
  ```

- [ ] **Install bot dependencies:**
  ```bash
  cd bot && npm install
  ```

- [ ] **Test bot starts without errors:**
  ```bash
  npm run dev
  # You should see: "◈ DELTA VAULT BOT" banner + "[HL] Demo mode" + Kamino/MarginFi init logs
  # DEMO_MODE=true so no real orders
  ```

- [ ] **Set up Telegram alerts (optional but impressive for demo):**
  1. Message @BotFather on Telegram → `/newbot` → copy the token
  2. Message @userinfobot → copy your chat ID
  3. Add to .env:
     ```
     TELEGRAM_BOT_TOKEN=123456:ABC-DEF-GHI...
     TELEGRAM_CHAT_ID=987654321
     ```
  4. Restart bot — you'll get a "Delta Vault Bot Started" message

- [ ] **Build Anchor program (optional but impressive):**
  ```bash
  # Requires: cargo, anchor-cli
  npm install -g @coral-xyz/anchor-cli
  cd programs/delta_vault
  anchor build
  anchor deploy --provider.cluster devnet
  # Copy the program ID printed to Anchor.toml and bot/.env VAULT_PROGRAM_ID
  cp target/idl/delta_vault.json bot/src/idl/delta_vault.json
  ```

---

## Day of Presentation

### 30 minutes before

- [ ] Open the dashboard in a browser tab (Claude.ai artifact or CodeSandbox)
- [ ] Start the bot in a terminal: `cd bot && npm run dev`
- [ ] Confirm `⬤ HL LIVE` badge appears in the dashboard
- [ ] Confirm BTC/ETH prices are updating (not stuck)
- [ ] If Telegram is set up: confirm you received the startup message
- [ ] Have the presentation deck open in PowerPoint

### During the demo

**Slide flow:**
1. **Slide 1** — Title + SIMULATION MODE badge → explain this is the safe mode
2. **Slide 2** — Strategy overview + disclaimer → 8–25% historical range
3. **Slide 3** — Delta-neutral thesis + yield calculation
4. **Slide 4** — Capital flow diagram
5. **Switch to live dashboard** ← the money moment
   - Show `⬤ HL LIVE` with real BTC/ETH prices
   - Hit **▶ START BOT** → watch signals populate in real time
   - Point to the Activity Log showing `[TRADE]` and `[INFO]` lines
   - Show the 4 engine sections all working
6. **Slide 5** — Strategy modes (use real signals from dashboard as example)
7. **Slide 6** — Risk engine (point to the live gauges on dashboard)
8. **Slide 7** — Anchor program (mention the on-chain guardrails)
9. **Slide 8** — Security audit improvements (the 24hr timelock, NAV staleness, epoch fees)
10. **Slide 9** — Bot code (quick)
11. **Slide 10** — Architecture
12. **Slide 11** — Repo structure (show GitHub link)
13. **Slide 12** — Performance + verification
14. **Slide 13** — Conclusion

### The key line to say at the dashboard moment:

> "Most vault strategies are just code on a slide.
> This one is actually running.
> The prices you're seeing are live from Hyperliquid.
> The strategy is evaluating real funding rates from Hyperliquid's perpetuals market.
> And the on-chain risk guardrails are already deployed to devnet."

---

## What Judges Will Ask

**"Is this live trading?"**
→ "The dashboard runs in simulation mode — no real funds at risk —
  but it's connected to live Hyperliquid funding rate data and Jupiter spot prices.
  DEMO_MODE=false switches it to live execution."

**"What's the actual APY?"**
→ "8–25% is the historical opportunity range we've observed in Hyperliquid's
  funding rate data. We deliberately don't call it a target — funding rates
  are entirely market-dependent and can go to zero in low-volatility periods.
  The strategy only enters positions when the rate exceeds our 0.01%/hr threshold."

**"Where's the smart contract?"**
→ "The Anchor program is in programs/delta_vault/ — five modules covering
  deposit/withdraw with NAV staleness guards, on-chain risk guardrails,
  a 24-hour bot rotation timelock, and epoch-gated fee collection.
  It's deployed on devnet at [your program ID]."

**"Why can't you guarantee atomicity across Jupiter and Hyperliquid?"**
→ "They're on separate networks — Jupiter is Solana, Hyperliquid is its own L1.
  You can't compose them in a single atomic transaction.
  Our mitigation is the 10-second risk loop: any delta breach triggers
  rebalancing before the next trade cycle."

---

## Emergency Backup Plan

If the bot crashes or Hyperliquid prices don't load:
- The dashboard still works in simulation mode (toggle off DEMO_MODE)
- The PnL history charts and gauges still animate
- The presentation deck has everything you need as standalone content
- The GitHub repo is the deliverable — the running demo is the bonus

---

## GitHub Submission Checklist

- [ ] Push repo to GitHub: `git init && git add . && git commit -m "Delta Vault hackathon submission" && git push`
- [ ] Make repo public
- [ ] Add a description: "Adaptive delta-neutral vault — Hyperliquid perps + Jupiter spot + Kamino lending on Solana"
- [ ] Add topics: `solana`, `hyperliquid`, `jupiter`, `kamino`, `defi`, `delta-neutral`, `anchor`, `hackathon`
- [ ] Pin the README.md — it has the full architecture overview

---

## File Locations Quick Reference

| What | Where |
|------|-------|
| Dashboard (open this) | `frontend/delta-vault-presentation.jsx` |
| Bot entry point | `bot/src/index.ts` |
| Environment config | `bot/.env` (copy from `.env.example`) |
| Setup script | `scripts/setup-devnet.js` |
| Anchor program | `programs/delta_vault/src/` |
| Audit notes | `docs/AUDIT_NOTES.md` |
| Strategy docs | `docs/strategy.md` |
| Presentation deck | `DeltaVault-v2.pptx` |
