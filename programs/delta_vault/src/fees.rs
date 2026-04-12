use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::vault::VaultState;

const SECONDS_PER_YEAR: u64 = 365 * 24 * 3_600;

/// Fee accrual state per vault.
///
/// Audit improvements:
/// 1. Fees are accrued continuously (time-weighted) and collected on
///    scheduled epochs OR on withdrawal — not permissionlessly crankable
///    by MEV bots at any time.
/// 2. Performance fee uses share-minting pattern (not direct USDC transfer)
///    so fee collector participates in future NAV alongside depositors.
/// 3. last_fee_accrual timestamp prevents double-collection.
/// 4. collect_fees is restricted to authority OR triggered on withdrawal
///    (epoch-gated, defined by fee_epoch_s param).
#[account]
pub struct FeeState {
    pub vault:              Pubkey,
    pub fee_collector:      Pubkey,
    pub last_fee_accrual:   i64,
    pub fee_epoch_s:        i64,   // minimum seconds between fee collections
    pub total_mgmt_fees:    u64,   // USDC lifetime
    pub total_perf_fees:    u64,   // USDC-equivalent lifetime (via share minting)
    pub bump:               u8,
}

#[derive(Accounts)]
pub struct CollectFees<'info> {
    #[account(mut)]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        init_if_needed, payer = authority,
        space = 8 + std::mem::size_of::<FeeState>(),
        seeds = [b"fees", vault_state.key().as_ref()], bump,
    )]
    pub fee_state: Account<'info, FeeState>,

    #[account(
        mut,
        constraint = authority.key() == vault_state.authority @ FeeError::Unauthorized
    )]
    pub authority: Signer<'info>,

    #[account(mut)] pub vault_usdc: Account<'info, TokenAccount>,
    #[account(mut)] pub fee_collector_usdc: Account<'info, TokenAccount>,
    #[account(mut, constraint = fee_collector_shares.mint == vault_state.share_mint)]
    pub fee_collector_shares: Account<'info, TokenAccount>,
    #[account(mut, constraint = share_mint.key() == vault_state.share_mint)]
    pub share_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn collect(ctx: Context<CollectFees>, fee_collector: Pubkey) -> Result<()> {
    let vault_state_info = ctx.accounts.vault_state.to_account_info();
    let vault     = &mut ctx.accounts.vault_state;
    let fee_state = &mut ctx.accounts.fee_state;
    let clock     = Clock::get()?;

    // ── Epoch gate — prevents MEV bots triggering fee collection at will ──
    // Fee collection can only happen once per fee_epoch_s (default: 1 day).
    let epoch = if fee_state.fee_epoch_s == 0 { 86_400i64 } else { fee_state.fee_epoch_s };
    require!(
        clock.unix_timestamp - fee_state.last_fee_accrual >= epoch,
        FeeError::EpochNotElapsed
    );

    fee_state.fee_collector = fee_collector;
    fee_state.vault         = vault.key();

    let elapsed = (clock.unix_timestamp - fee_state.last_fee_accrual).max(0) as u64;

    // ── Management fee (continuous, pro-rata USDC) ─────────────────────────
    // mgmt_fee = assets * annual_rate_bps * elapsed / (10_000 * SECONDS_PER_YEAR)
    let mgmt_fee = (vault.usdc_balance as u128)
        .checked_mul(vault.params.management_fee_bps as u128)
        .ok_or(FeeError::MathOverflow)?
        .checked_mul(elapsed as u128)
        .ok_or(FeeError::MathOverflow)?
        .checked_div(10_000u128 * SECONDS_PER_YEAR as u128)
        .unwrap_or(0) as u64;

    // ── Performance fee (HWM, via share minting) ──────────────────────────
    // Audit recommendation: mint fee shares rather than transferring USDC.
    // This aligns the fee collector with vault performance going forward,
    // and avoids reducing the USDC available for redemption.
    //
    // fee_shares = profit_shares * perf_fee_bps / 10_000
    let nav_ps = vault.cached_nav_per_share;
    let (perf_fee_usdc_equiv, fee_shares_to_mint) = if nav_ps > vault.high_water_mark {
        let gain_per_share = nav_ps - vault.high_water_mark;

        // Total profit in USDC terms
        let total_profit = (gain_per_share as u128)
            .checked_mul(vault.total_shares as u128)
            .ok_or(FeeError::MathOverflow)?
            .checked_div(1_000_000)
            .unwrap_or(0) as u64;

        // Perf fee as USDC equivalent
        let perf_fee_usdc = (total_profit as u128)
            .checked_mul(vault.params.performance_fee_bps as u128)
            .ok_or(FeeError::MathOverflow)?
            .checked_div(10_000)
            .unwrap_or(0) as u64;

        // Convert to shares at current NAV
        let shares = if nav_ps > 0 {
            (perf_fee_usdc as u128)
                .checked_mul(1_000_000)
                .ok_or(FeeError::MathOverflow)?
                .checked_div(nav_ps as u128)
                .unwrap_or(0) as u64
        } else { 0 };

        (perf_fee_usdc, shares)
    } else {
        (0, 0)
    };

    // Transfer USDC management fee
    if mgmt_fee > 0 && mgmt_fee <= ctx.accounts.vault_usdc.amount {
        let seeds = &[b"vault", vault.authority.as_ref(), &[vault.bump]];
        let signer = &[&seeds[..]];
        token::transfer(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.vault_usdc.to_account_info(),
                to:        ctx.accounts.fee_collector_usdc.to_account_info(),
                authority: vault_state_info.clone(),
            }, signer), mgmt_fee)?;
        vault.usdc_balance = vault.usdc_balance.saturating_sub(mgmt_fee);
        fee_state.total_mgmt_fees += mgmt_fee;
    }

    // Mint performance fee shares to fee collector
    if fee_shares_to_mint > 0 {
        let seeds = &[b"vault", vault.authority.as_ref(), &[vault.bump]];
        let signer = &[&seeds[..]];
        anchor_spl::token::mint_to(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::MintTo {
                mint:      ctx.accounts.share_mint.to_account_info(),
                to:        ctx.accounts.fee_collector_shares.to_account_info(),
                authority: vault_state_info.clone(),
            }, signer), fee_shares_to_mint)?;
        vault.total_shares = vault.total_shares
            .checked_add(fee_shares_to_mint)
            .ok_or(FeeError::MathOverflow)?;
        fee_state.total_perf_fees += perf_fee_usdc_equiv;
    }

    // Update HWM only after successful fee collection
    if nav_ps > vault.high_water_mark {
        vault.high_water_mark = nav_ps;
    }
    fee_state.last_fee_accrual = clock.unix_timestamp;

    emit!(FeesCollected {
        vault: vault.key(),
        mgmt_fee_usdc: mgmt_fee,
        perf_fee_shares: fee_shares_to_mint,
        perf_fee_usdc_equiv,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

// ─── Events & Errors ──────────────────────────────────────────────────────────
#[event]
pub struct FeesCollected {
    pub vault: Pubkey, pub mgmt_fee_usdc: u64,
    pub perf_fee_shares: u64, pub perf_fee_usdc_equiv: u64, pub timestamp: i64,
}

#[error_code]
pub enum FeeError {
    #[msg("Only vault authority can collect fees")]         Unauthorized,
    #[msg("Fee epoch has not elapsed yet")]                 EpochNotElapsed,
    #[msg("Math overflow in fee calculation")]              MathOverflow,
}
