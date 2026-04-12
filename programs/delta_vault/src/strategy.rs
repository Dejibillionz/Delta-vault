use anchor_lang::prelude::*;
use crate::vault::VaultState;
use crate::risk::{AssertRisk, assert_ok, RiskError, RiskOracle};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub enum StrategyMode {
    DeltaNeutral,
    BasisTrade,
    ParkCapital,
    EmergencyStop,
}

#[account]
pub struct StrategyState {
    pub vault:          Pubkey,
    pub current_mode:   StrategyMode,
    pub last_updated:   i64,
    pub authorized_bot: Pubkey,
    /// Net BTC perp position in base units (negative = short)
    pub btc_perp_position: i64,
    /// Net ETH perp position in base units (negative = short)
    pub eth_perp_position: i64,
    pub bump:           u8,
}

// ─── Update Strategy ──────────────────────────────────────────────────────────
/// Audit improvement: pre-trade risk check is embedded here.
///
/// Architecture note: True atomicity across Jupiter + Drift is impossible
/// (they are separate programs). This instruction updates on-chain state
/// to reflect bot intent. Actual swaps happen via separate CPI calls.
/// The risk check here guards against entering a new strategy mode
/// when the portfolio is already in a bad state.
#[derive(Accounts)]
pub struct UpdateStrategy<'info> {
    #[account(mut)]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        init_if_needed, payer = bot,
        space = 8 + std::mem::size_of::<StrategyState>(),
        seeds = [b"strategy", vault_state.key().as_ref()], bump,
    )]
    pub strategy_state: Account<'info, StrategyState>,

    /// Risk oracle — checked inline before strategy update
    #[account(
        seeds = [b"risk_oracle", vault_state.key().as_ref()],
        bump,
        constraint = risk_oracle.vault == vault_state.key() @ RiskError::InvalidOracle
    )]
    pub risk_oracle: Account<'info, RiskOracle>,

    #[account(
        mut,
        constraint = bot.key() == vault_state.authorized_bot @ StrategyError::UnauthorizedBot
    )]
    pub bot: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn update(ctx: Context<UpdateStrategy>, mode: StrategyMode) -> Result<()> {
    let clock = Clock::get()?;
    let oracle = &ctx.accounts.risk_oracle;

    // ── Pre-trade risk check (inline) ─────────────────────────────────────
    // Audit recommendation: assert_risk_ok must gate every trade instruction.
    // We replicate the key checks inline here to avoid requiring a separate
    // CPI call, which would need a separate account context.
    require!(oracle.execution_paused == 0, RiskError::ExecutionPaused);
    require!(
        clock.unix_timestamp - oracle.last_updated <= 60,
        RiskError::StaleOracle
    );
    // Allow EmergencyStop mode regardless of drawdown (it IS the response)
    if mode != StrategyMode::EmergencyStop {
        require!(
            oracle.drawdown_bps <= ctx.accounts.vault_state.params.max_drawdown_bps,
            RiskError::DrawdownExceeded
        );
        require!(
            oracle.delta_bps <= ctx.accounts.vault_state.params.max_delta_bps,
            RiskError::DeltaExceeded
        );
    }

    let strategy = &mut ctx.accounts.strategy_state;
    strategy.vault          = ctx.accounts.vault_state.key();
    strategy.current_mode   = mode.clone();
    strategy.last_updated   = clock.unix_timestamp;
    strategy.authorized_bot = ctx.accounts.bot.key();
    strategy.bump           = ctx.bumps.strategy_state;

    emit!(StrategyUpdated {
        vault: ctx.accounts.vault_state.key(),
        bot: ctx.accounts.bot.key(),
        mode: format!("{:?}", mode),
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

// ─── Bot Key Rotation — 24hr Timelock ─────────────────────────────────────────
/// Audit recommendation: bot key rotation must have a 24hr delay so that
/// a compromised key cannot immediately be replaced with an attacker key
/// without being observable on-chain.
///
/// Attack vector addressed: if authorized_bot is compromised, attacker
/// would need to wait 24 hours to complete rotation, giving the vault
/// authority time to cancel and set a new emergency bot.
#[derive(Accounts)]
pub struct ProposeRotation<'info> {
    #[account(
        mut,
        constraint = authority.key() == vault_state.authority @ StrategyError::Unauthorized
    )]
    pub vault_state: Account<'info, VaultState>,
    pub authority: Signer<'info>,
}

pub fn propose_bot_rotation(ctx: Context<ProposeRotation>, new_bot: Pubkey) -> Result<()> {
    let vault_key = ctx.accounts.vault_state.key();
    let vault = &mut ctx.accounts.vault_state;
    let clock = Clock::get()?;
    vault.pending_bot             = new_bot;
    vault.rotation_effective_time = clock.unix_timestamp + 86_400; // 24hr timelock
    emit!(BotRotationProposed {
        vault: vault_key,
        pending_bot: new_bot,
        effective_time: vault.rotation_effective_time,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteRotation<'info> {
    #[account(
        mut,
        constraint = authority.key() == vault_state.authority @ StrategyError::Unauthorized
    )]
    pub vault_state: Account<'info, VaultState>,
    pub authority: Signer<'info>,
}

pub fn execute_bot_rotation(ctx: Context<ExecuteRotation>) -> Result<()> {
    let vault_key = ctx.accounts.vault_state.key();
    let vault = &mut ctx.accounts.vault_state;
    let clock = Clock::get()?;
    require!(vault.pending_bot != Pubkey::default(), StrategyError::NoPendingRotation);
    require!(
        clock.unix_timestamp >= vault.rotation_effective_time,
        StrategyError::TimelockActive
    );
    let old_bot = vault.authorized_bot;
    vault.authorized_bot         = vault.pending_bot;
    vault.pending_bot             = Pubkey::default();
    vault.rotation_effective_time = 0;
    emit!(BotRotationExecuted {
        vault: vault_key,
        old_bot,
        new_bot: vault.authorized_bot,
    });
    Ok(())
}

/// Emergency: cancel a pending rotation (e.g. if authority detects compromise)
#[derive(Accounts)]
pub struct CancelRotation<'info> {
    #[account(
        mut,
        constraint = authority.key() == vault_state.authority @ StrategyError::Unauthorized
    )]
    pub vault_state: Account<'info, VaultState>,
    pub authority: Signer<'info>,
}

pub fn cancel_bot_rotation(ctx: Context<CancelRotation>) -> Result<()> {
    let vault = &mut ctx.accounts.vault_state;
    vault.pending_bot             = Pubkey::default();
    vault.rotation_effective_time = 0;
    emit!(BotRotationCancelled { vault: ctx.accounts.vault_state.key() });
    Ok(())
}

// ─── Events & Errors ──────────────────────────────────────────────────────────
#[event] pub struct StrategyUpdated       { pub vault: Pubkey, pub bot: Pubkey, pub mode: String, pub timestamp: i64 }
#[event] pub struct BotRotationProposed   { pub vault: Pubkey, pub pending_bot: Pubkey, pub effective_time: i64 }
#[event] pub struct BotRotationExecuted   { pub vault: Pubkey, pub old_bot: Pubkey, pub new_bot: Pubkey }
#[event] pub struct BotRotationCancelled  { pub vault: Pubkey }

#[error_code]
pub enum StrategyError {
    #[msg("Signer is not the authorized bot")]    UnauthorizedBot,
    #[msg("Signer is not the vault authority")]   Unauthorized,
    #[msg("No pending bot rotation")]             NoPendingRotation,
    #[msg("Rotation timelock still active")]      TimelockActive,
}
