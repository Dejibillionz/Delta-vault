use anchor_lang::prelude::*;

pub mod vault;
pub mod strategy;
pub mod risk;
pub mod fees;

use vault::*;
use strategy::*;
use risk::*;
use fees::*;

declare_id!("FQ99NWkE3f6HUdMcG312FCWvAT4iR4DTrTb9JA8xi471");

/// Delta Vault — Adaptive Delta-Neutral Strategy
///
/// Architecture (per security review):
///
/// TRUST MODEL: This is a "trusted bot" model. The on-chain program
/// validates state but cannot prevent the bot from temporarily creating
/// exposed states between spot fill and perp hedge — true atomicity
/// across Jupiter + Drift is not possible with current Solana program
/// structure. For production with >$1M TVL, formal verification of vault.rs
/// math and an Immunefi bug bounty are recommended.
///
/// SECURITY IMPROVEMENTS (from audit):
/// - NAV confidence buffer (0.5% haircut on volatile spot positions)
/// - NAV staleness guard on deposit/withdraw
/// - Peak NAV tracking for accurate drawdown computation
/// - Pre-trade risk checks embedded in update_strategy
/// - 24hr timelock for bot key rotation
/// - Share-minting pattern for performance fees
/// - Epoch-gated fee collection (MEV-resistant)
/// - risk_oracle is a proper PDA (not unchecked AccountInfo)
#[program]
pub mod delta_vault {
    use super::*;

    // ── Vault lifecycle ──────────────────────────────────────────────────────
    pub fn initialize_vault(ctx: Context<InitializeVault>, params: VaultParams) -> Result<()> {
        vault::initialize(ctx, params)
    }

    pub fn deposit(ctx: Context<Deposit>, amount_usdc: u64) -> Result<()> {
        vault::deposit(ctx, amount_usdc)
    }

    pub fn withdraw(ctx: Context<Withdraw>, shares: u64) -> Result<()> {
        vault::withdraw(ctx, shares)
    }

    /// Bot calls this each strategy cycle to push fresh NAV on-chain.
    /// Must be called before deposit/withdraw if NAV is stale.
    pub fn update_nav(
        ctx: Context<UpdateNav>,
        btc_price_usdc: u64,
        eth_price_usdc: u64,
        perp_pnl: i64,
        spot_btc: u64,
        spot_eth: u64,
    ) -> Result<()> {
        vault::update_nav(ctx, btc_price_usdc, eth_price_usdc, perp_pnl, spot_btc, spot_eth)
    }

    // ── Strategy ─────────────────────────────────────────────────────────────
    /// Update strategy mode — includes pre-trade risk check inline.
    pub fn update_strategy(ctx: Context<UpdateStrategy>, mode: StrategyMode) -> Result<()> {
        strategy::update(ctx, mode)
    }

    /// Propose new bot key — starts 24hr timelock.
    pub fn propose_bot_rotation(ctx: Context<ProposeRotation>, new_bot: Pubkey) -> Result<()> {
        strategy::propose_bot_rotation(ctx, new_bot)
    }

    /// Execute rotation after 24hr timelock has elapsed.
    pub fn execute_bot_rotation(ctx: Context<ExecuteRotation>) -> Result<()> {
        strategy::execute_bot_rotation(ctx)
    }

    /// Cancel a pending rotation (emergency).
    pub fn cancel_bot_rotation(ctx: Context<CancelRotation>) -> Result<()> {
        strategy::cancel_bot_rotation(ctx)
    }

    // ── Risk ─────────────────────────────────────────────────────────────────
    /// Standalone risk check — reverts if any limit is breached.
    pub fn assert_risk_ok(ctx: Context<AssertRisk>) -> Result<()> {
        risk::assert_ok(ctx)
    }

    /// Bot writes drawdown/delta/pause state each cycle.
    pub fn update_risk_oracle(
        ctx: Context<UpdateRiskOracle>,
        drawdown_bps: u16,
        delta_bps: u16,
        execution_paused: u8,
    ) -> Result<()> {
        risk::update_oracle(ctx, drawdown_bps, delta_bps, execution_paused)
    }

    // ── Fees ─────────────────────────────────────────────────────────────────
    /// Collect management + performance fees. Epoch-gated (max once per day).
    /// Performance fees minted as shares (not USDC transfer).
    pub fn collect_fees(ctx: Context<CollectFees>, fee_collector: Pubkey) -> Result<()> {
        fees::collect(ctx, fee_collector)
    }
}
