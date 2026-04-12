use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

/// Vault state account — stores all configuration and current NAV.
///
/// Architecture note (from security review):
/// NAV has three moving parts: USDC balance, spot asset values, perp PnL.
/// All three must be reflected before any deposit/withdraw.
/// We cache NAV per share (updated by bot) and enforce staleness on user txns.
#[account]
pub struct VaultState {
    pub authority:              Pubkey,
    pub usdc_mint:              Pubkey,
    pub share_mint:             Pubkey,

    // ── Position state (bot-maintained) ──────────────────────────────────────
    /// USDC held in vault escrow (6 decimals)
    pub usdc_balance:           u64,
    /// Spot BTC held (8 decimals, e.g. 100_000_000 = 1 BTC)
    pub spot_btc_amount:        u64,
    /// Spot ETH held (8 decimals)
    pub spot_eth_amount:        u64,
    /// Unrealized perp PnL — signed USDC (6 dec). Negative = loss.
    pub perp_unrealized_pnl:    i64,
    /// USDC borrowed for leverage (0 if none)
    pub borrowed_usdc:          u64,

    // ── NAV cache ─────────────────────────────────────────────────────────────
    /// Cached NAV per share (scaled 1e6). $1.00 = 1_000_000.
    pub cached_nav_per_share:   u64,
    /// Unix timestamp of last NAV update
    pub nav_last_updated:       i64,
    /// All-time peak NAV per share (for drawdown calculation)
    pub peak_nav_per_share:     u64,

    // ── Share accounting ──────────────────────────────────────────────────────
    pub total_shares:           u64,
    /// HWM for performance fee (NAV per share, scaled 1e6)
    pub high_water_mark:        u64,

    // ── Bot authorization with 24hr rotation timelock ─────────────────────────
    pub authorized_bot:         Pubkey,
    pub pending_bot:            Pubkey,
    pub rotation_effective_time: i64,

    pub params:                 VaultParams,
    pub bump:                   u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct VaultParams {
    pub management_fee_bps:     u16,   // e.g. 200 = 2% annual
    pub performance_fee_bps:    u16,   // e.g. 2000 = 20%
    pub max_drawdown_bps:       u16,   // e.g. 1000 = 10%
    pub max_delta_bps:          u16,   // e.g. 500 = 5%
    pub min_deposit_usdc:       u64,   // 6 dec, e.g. 10_000_000 = $10
    /// Confidence haircut on volatile spot positions (bps).
    /// Audit note: prevents oracle-manipulation mints by applying
    /// a small discount: adjusted_price = price * (10000 - buffer) / 10000
    pub nav_confidence_buffer_bps: u16, // e.g. 50 = 0.5%
    /// Max age of cached NAV before deposit/withdraw rejected (seconds)
    pub max_nav_staleness_s:    i64,   // e.g. 60
}

// ─── NAV Calculation ──────────────────────────────────────────────────────────
impl VaultState {
    /// Total NAV = USDC + spot_BTC_value + spot_ETH_value + perp_PnL − debt
    /// Prices in USDC (6 dec). BTC/ETH amounts in their native decimals (8).
    ///
    /// Confidence buffer (audit recommendation): we apply a haircut to spot
    /// values to create a gap between oracle price and executable price,
    /// protecting against oracle-manipulation sandwich attacks on deposits.
    pub fn calculate_nav(&self, btc_price: u64, eth_price: u64) -> Result<u64> {
        let buf = self.params.nav_confidence_buffer_bps as u64;
        let denom = 10_000u64;

        // Haircut: adjusted = price * (10000 - buffer) / 10000
        let adj_btc = btc_price
            .checked_mul(denom.checked_sub(buf).ok_or(VaultError::MathOverflow)?)
            .ok_or(VaultError::MathOverflow)?
            .checked_div(denom).ok_or(VaultError::MathOverflow)?;

        let adj_eth = eth_price
            .checked_mul(denom.checked_sub(buf).ok_or(VaultError::MathOverflow)?)
            .ok_or(VaultError::MathOverflow)?
            .checked_div(denom).ok_or(VaultError::MathOverflow)?;

        // BTC value: amount (8 dec) * price (6 dec) / 1e8 = value (6 dec)
        let btc_val = (self.spot_btc_amount as u128)
            .checked_mul(adj_btc as u128).ok_or(VaultError::MathOverflow)?
            .checked_div(100_000_000u128).ok_or(VaultError::MathOverflow)? as u64;

        let eth_val = (self.spot_eth_amount as u128)
            .checked_mul(adj_eth as u128).ok_or(VaultError::MathOverflow)?
            .checked_div(100_000_000u128).ok_or(VaultError::MathOverflow)? as u64;

        // Gross assets
        let gross = self.usdc_balance
            .checked_add(btc_val).ok_or(VaultError::MathOverflow)?
            .checked_add(eth_val).ok_or(VaultError::MathOverflow)?;

        // Add/subtract perp PnL (signed)
        let with_pnl = if self.perp_unrealized_pnl >= 0 {
            gross.checked_add(self.perp_unrealized_pnl as u64)
                 .ok_or(VaultError::MathOverflow)?
        } else {
            gross.saturating_sub((-self.perp_unrealized_pnl) as u64)
        };

        // Subtract liabilities
        Ok(with_pnl.saturating_sub(self.borrowed_usdc))
    }

    /// NAV per share, scaled 1e6. $1.00 = 1_000_000.
    pub fn nav_per_share(&self, btc_price: u64, eth_price: u64) -> Result<u64> {
        if self.total_shares == 0 {
            return Ok(1_000_000);
        }
        let nav = self.calculate_nav(btc_price, eth_price)?;
        Ok((nav as u128)
            .checked_mul(1_000_000).ok_or(VaultError::MathOverflow)?
            .checked_div(self.total_shares as u128).ok_or(VaultError::MathOverflow)? as u64)
    }

    /// Current drawdown vs all-time peak NAV per share, in basis points.
    pub fn drawdown_bps(&self, btc_price: u64, eth_price: u64) -> Result<u16> {
        if self.peak_nav_per_share == 0 { return Ok(0); }
        let nav_ps = self.nav_per_share(btc_price, eth_price)?;
        if nav_ps >= self.peak_nav_per_share { return Ok(0); }
        let drop = self.peak_nav_per_share - nav_ps;
        Ok(((drop as u128 * 10_000) / self.peak_nav_per_share as u128) as u16)
    }
}

// ─── Initialize ───────────────────────────────────────────────────────────────
#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init, payer = authority,
        space = 8 + std::mem::size_of::<VaultState>() + 128,
        seeds = [b"vault", authority.key().as_ref()], bump
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)] pub authority: Signer<'info>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init, payer = authority,
        seeds = [b"share_mint", vault_state.key().as_ref()], bump,
        mint::decimals = 6, mint::authority = vault_state,
    )]
    pub share_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn initialize(ctx: Context<InitializeVault>, params: VaultParams) -> Result<()> {
    let vault_key = ctx.accounts.vault_state.key();
    let vault = &mut ctx.accounts.vault_state;
    let clock = Clock::get()?;
    vault.authority              = ctx.accounts.authority.key();
    vault.usdc_mint              = ctx.accounts.usdc_mint.key();
    vault.share_mint             = ctx.accounts.share_mint.key();
    vault.usdc_balance           = 0;
    vault.spot_btc_amount        = 0;
    vault.spot_eth_amount        = 0;
    vault.perp_unrealized_pnl    = 0;
    vault.borrowed_usdc          = 0;
    vault.cached_nav_per_share   = 1_000_000;
    vault.nav_last_updated       = clock.unix_timestamp;
    vault.peak_nav_per_share     = 1_000_000;
    vault.total_shares           = 0;
    vault.high_water_mark        = 1_000_000;
    vault.authorized_bot         = ctx.accounts.authority.key();
    vault.pending_bot            = Pubkey::default();
    vault.rotation_effective_time = 0;
    vault.params                 = params;
    vault.bump                   = ctx.bumps.vault_state;
    emit!(VaultInitialized { vault: vault_key, authority: vault.authority });
    Ok(())
}

// ─── Update NAV Cache ─────────────────────────────────────────────────────────
/// Bot calls this each cycle to push fresh prices + perp PnL on-chain.
/// Deposit/Withdraw both check nav_last_updated against max_nav_staleness_s.
#[derive(Accounts)]
pub struct UpdateNav<'info> {
    #[account(mut, seeds = [b"vault", vault_state.authority.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(constraint = bot.key() == vault_state.authorized_bot @ VaultError::Unauthorized)]
    pub bot: Signer<'info>,
}

pub fn update_nav(
    ctx: Context<UpdateNav>,
    btc_price_usdc: u64,
    eth_price_usdc: u64,
    perp_pnl: i64,
    spot_btc: u64,
    spot_eth: u64,
) -> Result<()> {
    let vault_key = ctx.accounts.vault_state.key();
    let vault = &mut ctx.accounts.vault_state;
    let clock = Clock::get()?;
    vault.perp_unrealized_pnl = perp_pnl;
    vault.spot_btc_amount      = spot_btc;
    vault.spot_eth_amount      = spot_eth;
    vault.nav_last_updated     = clock.unix_timestamp;
    let nav_ps = vault.nav_per_share(btc_price_usdc, eth_price_usdc)?;
    vault.cached_nav_per_share = nav_ps;
    if nav_ps > vault.peak_nav_per_share { vault.peak_nav_per_share = nav_ps; }
    if nav_ps > vault.high_water_mark    { vault.high_water_mark    = nav_ps; }
    emit!(NavUpdated { vault: vault_key, nav_per_share: nav_ps, timestamp: clock.unix_timestamp });
    Ok(())
}

// ─── Deposit ──────────────────────────────────────────────────────────────────
#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut, seeds = [b"vault", vault_state.authority.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)] pub depositor: Signer<'info>,
    #[account(mut, constraint = depositor_usdc.owner == depositor.key())]
    pub depositor_usdc: Account<'info, TokenAccount>,
    #[account(mut, constraint = vault_usdc.mint == vault_state.usdc_mint)]
    pub vault_usdc: Account<'info, TokenAccount>,
    #[account(mut, constraint = depositor_shares.mint == vault_state.share_mint)]
    pub depositor_shares: Account<'info, TokenAccount>,
    #[account(mut, constraint = share_mint.key() == vault_state.share_mint)]
    pub share_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

pub fn deposit(ctx: Context<Deposit>, amount_usdc: u64) -> Result<()> {
    let vault_state_info = ctx.accounts.vault_state.to_account_info();
    let vault = &mut ctx.accounts.vault_state;
    let clock = Clock::get()?;
    require!(amount_usdc >= vault.params.min_deposit_usdc, VaultError::BelowMinDeposit);
    require!(amount_usdc > 0, VaultError::ZeroAmount);
    // Stale NAV guard — protects depositors from unfair share price
    require!(
        clock.unix_timestamp - vault.nav_last_updated <= vault.params.max_nav_staleness_s,
        VaultError::StaleNAV
    );
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(),
        Transfer { from: ctx.accounts.depositor_usdc.to_account_info(),
                   to: ctx.accounts.vault_usdc.to_account_info(),
                   authority: ctx.accounts.depositor.to_account_info() });
    token::transfer(cpi_ctx, amount_usdc)?;
    let shares_to_mint = if vault.total_shares == 0 || vault.cached_nav_per_share == 0 {
        amount_usdc
    } else {
        (amount_usdc as u128)
            .checked_mul(1_000_000).ok_or(VaultError::MathOverflow)?
            .checked_div(vault.cached_nav_per_share as u128).ok_or(VaultError::MathOverflow)? as u64
    };
    require!(shares_to_mint > 0, VaultError::ZeroShares);
    let seeds = &[b"vault", vault.authority.as_ref(), &[vault.bump]];
    let signer = &[&seeds[..]];
    let mint_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(),
        anchor_spl::token::MintTo { mint: ctx.accounts.share_mint.to_account_info(),
            to: ctx.accounts.depositor_shares.to_account_info(),
            authority: vault_state_info.clone() }, signer);
    anchor_spl::token::mint_to(mint_ctx, shares_to_mint)?;
    vault.usdc_balance = vault.usdc_balance.checked_add(amount_usdc).ok_or(VaultError::MathOverflow)?;
    vault.total_shares = vault.total_shares.checked_add(shares_to_mint).ok_or(VaultError::MathOverflow)?;
    emit!(DepositEvent { depositor: ctx.accounts.depositor.key(), amount_usdc, shares_minted: shares_to_mint, nav_per_share: vault.cached_nav_per_share });
    Ok(())
}

// ─── Withdraw ─────────────────────────────────────────────────────────────────
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, seeds = [b"vault", vault_state.authority.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)] pub withdrawer: Signer<'info>,
    #[account(mut, constraint = withdrawer_shares.owner == withdrawer.key())]
    pub withdrawer_shares: Account<'info, TokenAccount>,
    #[account(mut, constraint = withdrawer_usdc.owner == withdrawer.key())]
    pub withdrawer_usdc: Account<'info, TokenAccount>,
    #[account(mut)] pub vault_usdc: Account<'info, TokenAccount>,
    #[account(mut, constraint = share_mint.key() == vault_state.share_mint)]
    pub share_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

pub fn withdraw(ctx: Context<Withdraw>, shares: u64) -> Result<()> {
    let vault_state_info = ctx.accounts.vault_state.to_account_info();
    let vault = &mut ctx.accounts.vault_state;
    let clock = Clock::get()?;
    require!(shares > 0, VaultError::ZeroAmount);
    require!(shares <= ctx.accounts.withdrawer_shares.amount, VaultError::InsufficientShares);
    require!(vault.total_shares > 0, VaultError::NoShares);
    require!(
        clock.unix_timestamp - vault.nav_last_updated <= vault.params.max_nav_staleness_s,
        VaultError::StaleNAV
    );
    let usdc_to_return = (shares as u128)
        .checked_mul(vault.cached_nav_per_share as u128).ok_or(VaultError::MathOverflow)?
        .checked_div(1_000_000).ok_or(VaultError::MathOverflow)? as u64;
    require!(usdc_to_return > 0, VaultError::ZeroAmount);
    require!(usdc_to_return <= ctx.accounts.vault_usdc.amount, VaultError::InsufficientLiquidity);
    let seeds = &[b"vault", vault.authority.as_ref(), &[vault.bump]];
    let signer = &[&seeds[..]];
    anchor_spl::token::burn(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(),
        anchor_spl::token::Burn { mint: ctx.accounts.share_mint.to_account_info(),
            from: ctx.accounts.withdrawer_shares.to_account_info(),
            authority: vault_state_info.clone() }, signer), shares)?;
    token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(),
        Transfer { from: ctx.accounts.vault_usdc.to_account_info(),
            to: ctx.accounts.withdrawer_usdc.to_account_info(),
            authority: vault_state_info.clone() }, signer), usdc_to_return)?;
    vault.usdc_balance = vault.usdc_balance.saturating_sub(usdc_to_return);
    vault.total_shares = vault.total_shares.checked_sub(shares).ok_or(VaultError::MathOverflow)?;
    emit!(WithdrawEvent { withdrawer: ctx.accounts.withdrawer.key(), shares_burned: shares, usdc_returned: usdc_to_return, nav_per_share: vault.cached_nav_per_share });
    Ok(())
}

// ─── Events ───────────────────────────────────────────────────────────────────
#[event] pub struct VaultInitialized { pub vault: Pubkey, pub authority: Pubkey }
#[event] pub struct NavUpdated       { pub vault: Pubkey, pub nav_per_share: u64, pub timestamp: i64 }
#[event] pub struct DepositEvent     { pub depositor: Pubkey, pub amount_usdc: u64, pub shares_minted: u64, pub nav_per_share: u64 }
#[event] pub struct WithdrawEvent    { pub withdrawer: Pubkey, pub shares_burned: u64, pub usdc_returned: u64, pub nav_per_share: u64 }

// ─── Errors ───────────────────────────────────────────────────────────────────
#[error_code]
pub enum VaultError {
    #[msg("Deposit below minimum")]                 BelowMinDeposit,
    #[msg("Amount must be > 0")]                    ZeroAmount,
    #[msg("Shares calculated as zero")]             ZeroShares,
    #[msg("Insufficient shares")]                   InsufficientShares,
    #[msg("No shares in circulation")]              NoShares,
    #[msg("Insufficient vault liquidity")]          InsufficientLiquidity,
    #[msg("Math overflow")]                         MathOverflow,
    #[msg("NAV cache is stale — bot must update")]  StaleNAV,
    #[msg("Unauthorized caller")]                   Unauthorized,
}
