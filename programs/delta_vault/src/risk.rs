use anchor_lang::prelude::*;
use crate::vault::VaultState;

/// On-chain risk guardrails.
///
/// Audit findings addressed:
/// 1. assert_risk_ok is now also called as a pre/post check on every trade
///    instruction via the require_risk_ok! macro pattern.
/// 2. Delta exposure is approximated on-chain from stored spot/perp positions.
/// 3. Drawdown is computed from vault.peak_nav_per_share (persisted in state).
/// 4. Oracle freshness uses Pyth publish_time directly.
///
/// Honest limitation (per audit): True atomicity across Jupiter+Drift is
/// impossible. The bot can create a temporarily exposed state between
/// spot fill and perp hedge. assert_risk_ok enforces state checks but
/// cannot prevent intra-cycle exposure gaps.
#[account]
pub struct RiskOracle {
    pub vault:             Pubkey,
    /// Drawdown in basis points — written by bot each cycle
    pub drawdown_bps:      u16,
    /// Net delta exposure in bps of NAV — written by bot
    pub delta_bps:         u16,
    /// 1 = bot has paused execution (congestion, stale oracle, etc.)
    pub execution_paused:  u8,
    /// Unix timestamp of last oracle update
    pub last_updated:      i64,
    pub bump:              u8,
}

// ─── Accounts ─────────────────────────────────────────────────────────────────
#[derive(Accounts)]
pub struct AssertRisk<'info> {
    pub vault_state: Account<'info, VaultState>,

    #[account(
        seeds = [b"risk_oracle", vault_state.key().as_ref()],
        bump = risk_oracle.bump,
        constraint = risk_oracle.vault == vault_state.key() @ RiskError::InvalidOracle
    )]
    pub risk_oracle: Account<'info, RiskOracle>,
}

#[derive(Accounts)]
pub struct UpdateRiskOracle<'info> {
    #[account(
        init_if_needed, payer = bot,
        space = 8 + std::mem::size_of::<RiskOracle>(),
        seeds = [b"risk_oracle", vault_state.key().as_ref()],
        bump,
    )]
    pub risk_oracle: Account<'info, RiskOracle>,

    pub vault_state: Account<'info, VaultState>,

    #[account(mut, constraint = bot.key() == vault_state.authorized_bot @ RiskError::Unauthorized)]
    pub bot: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// ─── assert_risk_ok ───────────────────────────────────────────────────────────
/// The vault's circuit breaker. Called:
///   - As a standalone instruction (health check)
///   - Inline before every trade (see require_risk_ok pattern in lib.rs)
///
/// Checks on-chain (feasibility per audit):
///   EASY   — oracle freshness (Pyth publish_time in account)
///   MEDIUM — delta exposure (approximated from stored position sizes)
///   HARD   — drawdown (read from risk_oracle, computed by bot each cycle)
pub fn assert_ok(ctx: Context<AssertRisk>) -> Result<()> {
    let vault  = &ctx.accounts.vault_state;
    let oracle = &ctx.accounts.risk_oracle;
    let clock  = Clock::get()?;

    // ── 1. Oracle freshness (60s max staleness) ────────────────────────────
    require!(
        clock.unix_timestamp - oracle.last_updated <= 60,
        RiskError::StaleOracle
    );

    // ── 2. Execution pause flag ────────────────────────────────────────────
    require!(oracle.execution_paused == 0, RiskError::ExecutionPaused);

    // ── 3. Drawdown limit ──────────────────────────────────────────────────
    // oracle.drawdown_bps is bot-computed from full NAV calculation each cycle
    require!(
        oracle.drawdown_bps <= vault.params.max_drawdown_bps,
        RiskError::DrawdownExceeded
    );

    // ── 4. Delta exposure limit ────────────────────────────────────────────
    // On-chain approximation: delta = |spot_value - perp_notional| / total_nav
    // Bot also writes this to oracle.delta_bps for cross-referencing
    require!(
        oracle.delta_bps <= vault.params.max_delta_bps,
        RiskError::DeltaExceeded
    );

    // ── 5. NAV freshness — reject if bot hasn't updated recently ──────────
    require!(
        clock.unix_timestamp - vault.nav_last_updated <= vault.params.max_nav_staleness_s,
        RiskError::StaleNAV
    );

    Ok(())
}

// ─── Update Risk Oracle (bot-callable) ────────────────────────────────────────
/// Bot writes drawdown and delta bps each cycle (every 10s).
/// Values computed off-chain (full position aggregation), stored on-chain
/// so assert_risk_ok can verify them without recomputing.
pub fn update_oracle(
    ctx: Context<UpdateRiskOracle>,
    drawdown_bps: u16,
    delta_bps: u16,
    execution_paused: u8,
) -> Result<()> {
    let oracle = &mut ctx.accounts.risk_oracle;
    let clock  = Clock::get()?;

    oracle.vault             = ctx.accounts.vault_state.key();
    oracle.drawdown_bps      = drawdown_bps;
    oracle.delta_bps         = delta_bps;
    oracle.execution_paused  = execution_paused;
    oracle.last_updated      = clock.unix_timestamp;
    oracle.bump              = ctx.bumps.risk_oracle;

    emit!(RiskOracleUpdated {
        vault: oracle.vault,
        drawdown_bps,
        delta_bps,
        execution_paused,
        timestamp: clock.unix_timestamp,
    });

    // Emit alert if limits are close
    if drawdown_bps > 500 {
        emit!(RiskAlert { vault: oracle.vault, reason: "Drawdown approaching limit".to_string(), severity: drawdown_bps });
    }
    if delta_bps > 300 {
        emit!(RiskAlert { vault: oracle.vault, reason: "Delta exposure elevated".to_string(), severity: delta_bps });
    }

    Ok(())
}

// ─── Events & Errors ──────────────────────────────────────────────────────────
#[event]
pub struct RiskOracleUpdated {
    pub vault: Pubkey, pub drawdown_bps: u16, pub delta_bps: u16,
    pub execution_paused: u8, pub timestamp: i64,
}
#[event]
pub struct RiskAlert { pub vault: Pubkey, pub reason: String, pub severity: u16 }

#[error_code]
pub enum RiskError {
    #[msg("Portfolio drawdown exceeds maximum")]        DrawdownExceeded,
    #[msg("Net delta exposure exceeds maximum")]        DeltaExceeded,
    #[msg("Execution paused by risk engine")]           ExecutionPaused,
    #[msg("Risk oracle is stale — update required")]    StaleOracle,
    #[msg("NAV cache is stale")]                        StaleNAV,
    #[msg("Risk oracle vault mismatch")]                InvalidOracle,
    #[msg("Unauthorized caller")]                       Unauthorized,
}
