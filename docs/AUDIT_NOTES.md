# Delta Vault — Audit Response Notes

This document responds to every finding raised in the architecture security review.
Each item includes the original concern, what was implemented, and what remains a known limitation.

---

## 1. NAV Calculation (`vault.rs`)

### Finding
NAV has three moving parts — USDC, spot BTC/ETH, perp PnL — and must account
for all three before any deposit or withdrawal. Oracle hiccups during NAV
calculation could give users unfair mint/burn rates.

### Implemented
- **Full NAV formula** in `VaultState::calculate_nav()`:
  `NAV = USDC + spot_BTC_value + spot_ETH_value + perp_PnL − borrowed_USDC`
- **Confidence buffer (0.5% haircut)** on volatile spot positions:
  ```rust
  let adj_btc = btc_price * (10_000 - nav_confidence_buffer_bps) / 10_000;
  ```
  Addresses the "gap between oracle price and executable price" concern.
- **NAV staleness guard**: deposit/withdraw both check
  `clock.unix_timestamp - nav_last_updated <= max_nav_staleness_s`.
  If the bot hasn't updated NAV within 60 seconds, all user transactions revert.
- **Peak NAV tracking** (`peak_nav_per_share`) for accurate drawdown calculation.
- **Cached NAV** updated by bot-callable `update_nav` instruction each cycle.

### Remaining Limitation
The `perp_unrealized_pnl` field is bot-written (off-chain computed from Drift).
Drift's perp P&L is not settled on-chain until position close. We trust the bot
to provide accurate values — this is the core trusted-bot tradeoff.

---

## 2. Risk Engine (`risk.rs`)

### Finding
`assert_risk_ok` should gate every trade instruction, not just be a standalone
check. Drawdown requires historical NAV tracking. Delta exposure requires
position aggregation.

### Implemented
- **`risk_oracle` is now a proper PDA** (not an unchecked `AccountInfo`):
  ```rust
  seeds = [b"risk_oracle", vault_state.key().as_ref()], bump
  ```
- **Pre-trade risk check embedded in `update_strategy`**: the strategy
  instruction checks `oracle.drawdown_bps`, `oracle.delta_bps`, and
  `oracle.execution_paused` before allowing any mode change.
- **`update_risk_oracle` instruction**: bot writes drawdown and delta bps
  each 10-second risk cycle, providing on-chain verifiable state.
- **Drawdown computed from `vault.peak_nav_per_share`**: persistent across
  transactions, not recalculated from scratch each time.
- **`RiskAlert` events emitted** when drawdown > 5% or delta > 3%.

### Remaining Limitation
As the audit correctly identifies, true real-time atomicity is impossible.
The bot can create a temporarily exposed state between Jupiter spot fill
and Drift perp hedge. `assert_risk_ok` enforces state checks but cannot
prevent intra-cycle exposure gaps. Mitigation: 10-second risk cycle
reduces the window of exposure.

---

## 3. Fee Collection (`fees.rs`)

### Finding
Permissionless fee collection could be exploited by MEV bots triggering
collection at suboptimal times.

### Implemented
- **Epoch gate**: `collect_fees` can only be called once per `fee_epoch_s`
  (default: 86,400s = 1 day). Any call before the epoch elapses reverts
  with `EpochNotElapsed`.
- **Authority-only collection**: restricted to `vault_state.authority` —
  not a permissionless crank.
- **Share-minting pattern for performance fees**: instead of transferring
  USDC, fee shares are minted to the fee collector. This:
  - Avoids reducing the USDC available for redemptions.
  - Aligns the fee collector's incentives with depositor returns.
  - Prevents NAV-deflation attacks via fee extraction.
- **HWM updated only after successful fee collection** (not before).

---

## 4. Bot Key Rotation (`strategy.rs`)

### Finding
If the authorized bot key is compromised, attacker can force any strategy.
No rotation mechanism was specified.

### Implemented
**24-hour timelock on bot key rotation**:

```rust
pub fn propose_bot_rotation(ctx, new_bot) {
    vault.pending_bot             = new_bot;
    vault.rotation_effective_time = clock.unix_timestamp + 86_400; // 24hr
}

pub fn execute_bot_rotation(ctx) {
    require!(clock.unix_timestamp >= vault.rotation_effective_time);
    vault.authorized_bot = vault.pending_bot;
}

pub fn cancel_bot_rotation(ctx) {
    // Emergency cancellation — authority can cancel at any time
    vault.pending_bot = Pubkey::default();
}
```

**Attack vector addressed**: a compromised bot key cannot immediately
be replaced with an attacker-controlled key. The 24-hour window allows
the vault authority to detect the malicious rotation proposal and cancel it.

---

## 5. Systemic Risk Responses

| Risk | Severity | Mitigation Implemented |
|------|----------|------------------------|
| Oracle manipulation | Medium | 0.5% confidence haircut, 60s staleness check |
| Stale NAV deposit/withdraw | High | `max_nav_staleness_s` enforced on every user tx |
| MEV fee collection | Low | Epoch gate (daily minimum interval) |
| Bot key compromise | High | 24hr rotation timelock + cancel instruction |
| Drawdown without on-chain tracking | Medium | `peak_nav_per_share` persisted in vault state |
| Perp PnL not settled on-chain | Medium | Known limitation — trusted bot model |
| Jupiter+Drift non-atomicity | High | Known limitation — intra-cycle risk window |

---

## 6. What Remains (Production Checklist)

Before deploying with real funds:

- [ ] **Deploy to devnet** and verify all PDA account structures
- [ ] **Wire up Anchor IDL** in `onChainSync.ts` (currently stubbed)
- [ ] **Formal verification** of `vault.rs` NAV math (overflow paths)
- [ ] **Immunefi bug bounty** — recommended for >$1M TVL
- [ ] **30-day public testnet** with incentivized exploit attempts
- [ ] **Audit fee parameters** — hardcoded vs. upgradeable decision
- [ ] **Withdrawal queue** — pro-rata vs. FCFS for large redemptions
- [ ] **Insurance fund** — backstop for tail risk events
- [ ] **Upgrade authority** — consider burning or moving to multisig

---

## 7. Trust Model Summary

This is a **trusted bot model**. The on-chain program:
- Validates state (drawdown, delta, oracle freshness) via the risk oracle PDA
- Enforces share price fairness via NAV staleness guards
- Protects key rotation via 24hr timelock
- Prevents fee abuse via epoch gating

But **cannot**:
- Guarantee atomic execution across Jupiter + Drift
- Independently compute real-time perp PnL on-chain
- Prevent a malicious bot from trading into a bad state between risk checks

For trustless operation, the architecture would require either:
- Drift + Jupiter integration in a single atomic instruction (not possible today)
- An on-chain order book matching both legs (prohibitively expensive on Solana)

This scoping is appropriate for a hackathon and early-stage vault.
For production scale, the above items in section 6 apply.
