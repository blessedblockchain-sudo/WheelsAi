//! agent-treasury — plan A2/A3.
//!
//! Each tokenized agent owns a treasury PDA. SOL flows in (from
//! Raydium-routed pump.fun trade fees, indexer-forwarded) and out
//! (to Nosana hosts, paying for compute). The platform's auto-pay
//! BullMQ workers sign `pay_nosana` instructions; the program
//! verifies the caller is the recorded `platform_authority` so a
//! random wallet can't drain the treasury.
//!
//! ## Account model
//!
//! ```text
//! Treasury {
//!   owner_token_mint:    Pubkey   // pump.fun mint that owns this treasury
//!   platform_authority:  Pubkey   // the wallet allowed to call pay_nosana
//!   total_paid_lamports: u64      // running total — read-only metric
//!   bump:                u8       // PDA bump for the treasury vault
//! }
//! ```
//!
//! The Treasury account stores _metadata_; the actual SOL balance lives
//! on the Treasury account itself (it's a system-owned vault for the
//! purposes of `transfer`). The PDA is derived from
//! `[b"treasury", owner_token_mint]` so each token has exactly one.
//!
//! ## Why platform_authority is on-chain
//!
//! Today the platform holds the auto-pay key (server-derived from
//! `WALLET_MASTER_KEY`). The on-chain check ensures that key — and
//! _only_ that key — can move funds out. Rotating it requires a
//! governance proposal (plan A9) once that program ships; until then,
//! the team multisig is the authority.
//!
//! ## Security
//!
//! - All SOL transfers go through `system_program::transfer` so we get
//!   the runtime's overflow checks for free.
//! - `pay_nosana` requires the platform_authority to be a signer.
//! - The treasury PDA signs the outbound transfer with seeds; nobody
//!   else can construct a CPI call that drains it.
//! - `withdraw_excess` is intentionally NOT implemented in v1 — there's
//!   no escape hatch yet, by design. If holders want a sweep mechanism
//!   it should land via governance, not as a back-door for the
//!   platform.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("9TF7xZpYYwbiiVmcJJs6RDmjDTpqoscYtWKhNBcMzM1n");

pub const TREASURY_SEED: &[u8] = b"treasury";
pub const TREASURY_CONFIG_SEED: &[u8] = b"config";

#[program]
pub mod agent_treasury {
    use super::*;

    /// Bootstrap the singleton program config. Whoever calls this
    /// becomes the admin (intended to be the ops multisig). One per
    /// program ID — run immediately after deploy, before any treasury
    /// exists. The admin gates `initialize_treasury`, which is what
    /// makes treasury creation front-run-proof (C1).
    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.pending_admin = Pubkey::default();
        config.bump = ctx.bumps.config;

        emit!(ConfigInitialized {
            config: config.key(),
            admin: config.admin,
        });
        Ok(())
    }

    /// Two-step config-admin rotation, step 1: current admin proposes.
    pub fn propose_config_admin(
        ctx: Context<ManageConfig>,
        new_admin: Pubkey,
    ) -> Result<()> {
        require!(
            new_admin != Pubkey::default(),
            TreasuryError::InvalidAuthority,
        );
        let config = &mut ctx.accounts.config;
        config.pending_admin = new_admin;

        emit!(ConfigAdminProposed {
            config: config.key(),
            current_admin: config.admin,
            pending_admin: new_admin,
        });
        Ok(())
    }

    /// Two-step config-admin rotation, step 2: the proposed admin
    /// accepts by signing — a typo'd pubkey can never brick the config.
    pub fn accept_config_admin(ctx: Context<AcceptConfigAdmin>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(
            config.pending_admin != Pubkey::default()
                && config.pending_admin == ctx.accounts.new_admin.key(),
            TreasuryError::AuthorityMismatch,
        );
        let old_admin = config.admin;
        config.admin = config.pending_admin;
        config.pending_admin = Pubkey::default();

        emit!(ConfigAdminRotated {
            config: config.key(),
            old_admin,
            new_admin: config.admin,
        });
        Ok(())
    }

    /// Create the treasury PDA for a given token mint.
    ///
    /// One-shot: a token can only have one treasury. The PDA is
    /// system-owned (Anchor allocates it via `init`), so the SOL
    /// balance is just the lamports field on the account itself.
    ///
    /// Admin-gated (C1): the PDA seed (the mint) is public the moment a
    /// token launches, so a permissionless init was front-runnable — an
    /// attacker could record THEIR key as platform_authority and the
    /// fee router would deposit platform funds into an attacker-
    /// drainable vault. Only the config admin may create treasuries.
    pub fn initialize_treasury(
        ctx: Context<InitializeTreasury>,
        platform_authority: Pubkey,
    ) -> Result<()> {
        require!(
            platform_authority != Pubkey::default(),
            TreasuryError::InvalidAuthority,
        );
        let treasury = &mut ctx.accounts.treasury;
        treasury.owner_token_mint = ctx.accounts.owner_token_mint.key();
        treasury.platform_authority = platform_authority;
        treasury.total_paid_lamports = 0;
        treasury.total_received_lamports = 0;
        treasury.bump = ctx.bumps.treasury;
        treasury.pending_authority = Pubkey::default();

        emit!(TreasuryInitialized {
            treasury: treasury.key(),
            owner_token_mint: treasury.owner_token_mint,
            platform_authority,
        });

        Ok(())
    }

    /// Two-step platform-authority rotation, step 1: the CURRENT
    /// authority proposes a successor (C3). Without rotation, a
    /// WALLET_MASTER_KEY rotation (the standard response to a key
    /// compromise) would permanently strand every treasury's funds.
    pub fn propose_platform_authority(
        ctx: Context<ProposePlatformAuthority>,
        new_authority: Pubkey,
    ) -> Result<()> {
        require!(
            new_authority != Pubkey::default(),
            TreasuryError::InvalidAuthority,
        );
        let treasury = &mut ctx.accounts.treasury;
        treasury.pending_authority = new_authority;

        emit!(PlatformAuthorityProposed {
            treasury: treasury.key(),
            current_authority: treasury.platform_authority,
            pending_authority: new_authority,
        });
        Ok(())
    }

    /// Two-step platform-authority rotation, step 2: the proposed
    /// authority accepts by signing, proving the new key exists and is
    /// usable before the old one loses power.
    pub fn accept_platform_authority(
        ctx: Context<AcceptPlatformAuthority>,
    ) -> Result<()> {
        let treasury = &mut ctx.accounts.treasury;
        require!(
            treasury.pending_authority != Pubkey::default()
                && treasury.pending_authority == ctx.accounts.new_authority.key(),
            TreasuryError::AuthorityMismatch,
        );
        let old_authority = treasury.platform_authority;
        treasury.platform_authority = treasury.pending_authority;
        treasury.pending_authority = Pubkey::default();

        emit!(PlatformAuthorityRotated {
            treasury: treasury.key(),
            old_authority,
            new_authority: treasury.platform_authority,
        });
        Ok(())
    }

    /// Pay a Nosana host for compute consumed.
    ///
    /// `amount` is in lamports. Caller (`platform_authority`) must
    /// sign. Recipient is whatever pubkey the platform decided in
    /// `resolveNosanaRecipient`. Program enforces:
    ///
    ///   - signer is the recorded `platform_authority`
    ///   - treasury still has enough lamports (system_program::transfer
    ///     would also catch this, but we pre-check for a clearer error)
    ///   - the recipient is not the system program zero pubkey, since
    ///     that's the SDK's "no host yet" sentinel
    /// Deposit SOL into the treasury PDA.
    ///
    /// Any signer can call — fees flow IN, not out, so there's no
    /// privileged-caller constraint. The pump.fun fee router (the
    /// indexer-driven bot that watches Raydium V4 trade events and
    /// forwards 1% to the treasury) is the canonical caller; users
    /// can also call this directly to tip an agent.
    ///
    /// Why this is an instruction and not a bare system::transfer:
    ///   - It logs a typed event (FeeReceived) so the indexer + UI
    ///     can attribute deposits without scanning every transfer.
    ///   - It updates `total_received_lamports` on-chain so the
    ///     runway card can render "lifetime fees received" without
    ///     a tx-history scan.
    pub fn fee_receive(ctx: Context<FeeReceive>, amount: u64) -> Result<()> {
        require!(amount > 0, TreasuryError::ZeroAmount);

        let from_ai = ctx.accounts.from.to_account_info();
        let treasury_ai = ctx.accounts.treasury.to_account_info();
        let treasury_key = ctx.accounts.treasury.key();
        let from_key = ctx.accounts.from.key();

        // The `from` is a system-owned signer, so the standard
        // system_program::transfer works (no direct lamport mutation
        // needed; that pattern is for program-owned PDAs as the source).
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: from_ai,
                    to: treasury_ai,
                },
            ),
            amount,
        )?;

        let new_total = ctx
            .accounts
            .treasury
            .total_received_lamports
            .checked_add(amount)
            .ok_or(TreasuryError::Overflow)?;
        ctx.accounts.treasury.total_received_lamports = new_total;

        emit!(FeeReceived {
            treasury: treasury_key,
            from: from_key,
            amount_lamports: amount,
            total_received_lamports: new_total,
        });

        Ok(())
    }

    pub fn pay_nosana(ctx: Context<PayNosana>, amount: u64) -> Result<()> {
        require!(amount > 0, TreasuryError::ZeroAmount);
        require!(
            ctx.accounts.recipient.key() != Pubkey::default(),
            TreasuryError::InvalidRecipient,
        );

        let prior_total = ctx.accounts.treasury.total_paid_lamports;
        let treasury_key = ctx.accounts.treasury.key();
        let treasury_account_info = ctx.accounts.treasury.to_account_info();
        let recipient_account_info = ctx.accounts.recipient.to_account_info();

        // Account must keep enough lamports to remain rent-exempt; the
        // Treasury struct's allocation already covers this. We're only
        // refusing to pay out anything that would push us below the
        // existing data + rent reserve.
        let treasury_lamports = treasury_account_info.lamports();
        let rent_reserve = Rent::get()?.minimum_balance(Treasury::SIZE);
        require!(
            treasury_lamports
                .checked_sub(amount)
                .map(|remaining| remaining >= rent_reserve)
                .unwrap_or(false),
            TreasuryError::InsufficientBalance,
        );

        // Program-owned PDAs cannot be the `from` of system_program::transfer
        // (system_program refuses any source account that "carries data").
        // The canonical way to move SOL out of a program-owned account is
        // direct lamport mutation under the runtime's invariant that the
        // total lamports across all accounts in the tx must balance.
        **treasury_account_info.try_borrow_mut_lamports()? = treasury_lamports
            .checked_sub(amount)
            .ok_or(TreasuryError::InsufficientBalance)?;
        let recipient_lamports = recipient_account_info.lamports();
        **recipient_account_info.try_borrow_mut_lamports()? = recipient_lamports
            .checked_add(amount)
            .ok_or(TreasuryError::Overflow)?;

        let new_total = prior_total
            .checked_add(amount)
            .ok_or(TreasuryError::Overflow)?;
        ctx.accounts.treasury.total_paid_lamports = new_total;

        emit!(NosanaPayment {
            treasury: treasury_key,
            recipient: ctx.accounts.recipient.key(),
            amount_lamports: amount,
            total_paid_lamports: new_total,
        });

        Ok(())
    }
}

// ============================================================================
// Account structs
// ============================================================================

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = TreasuryConfig::SIZE,
        seeds = [TREASURY_CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, TreasuryConfig>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ManageConfig<'info> {
    #[account(
        mut,
        seeds = [TREASURY_CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TreasuryError::AuthorityMismatch,
    )]
    pub config: Account<'info, TreasuryConfig>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptConfigAdmin<'info> {
    #[account(
        mut,
        seeds = [TREASURY_CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, TreasuryConfig>,

    pub new_admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitializeTreasury<'info> {
    #[account(
        seeds = [TREASURY_CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ TreasuryError::AuthorityMismatch,
    )]
    pub config: Account<'info, TreasuryConfig>,

    /// The config admin must co-sign treasury creation (C1).
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = Treasury::SIZE,
        seeds = [TREASURY_SEED, owner_token_mint.key().as_ref()],
        bump,
    )]
    pub treasury: Account<'info, Treasury>,

    /// CHECK: only used as a seed; we never read it. Could be the SPL
    /// Mint account but we don't deserialize it — the platform is the
    /// caller and the mint is just an identifier.
    pub owner_token_mint: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProposePlatformAuthority<'info> {
    #[account(
        mut,
        seeds = [TREASURY_SEED, treasury.owner_token_mint.as_ref()],
        bump = treasury.bump,
        has_one = platform_authority @ TreasuryError::AuthorityMismatch,
    )]
    pub treasury: Account<'info, Treasury>,

    pub platform_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptPlatformAuthority<'info> {
    #[account(
        mut,
        seeds = [TREASURY_SEED, treasury.owner_token_mint.as_ref()],
        bump = treasury.bump,
    )]
    pub treasury: Account<'info, Treasury>,

    pub new_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct FeeReceive<'info> {
    #[account(
        mut,
        seeds = [TREASURY_SEED, treasury.owner_token_mint.as_ref()],
        bump = treasury.bump,
    )]
    pub treasury: Account<'info, Treasury>,

    /// The depositor — pays the SOL out and the tx fee. No
    /// authority check; anyone can fund a treasury.
    #[account(mut)]
    pub from: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PayNosana<'info> {
    #[account(
        mut,
        seeds = [TREASURY_SEED, treasury.owner_token_mint.as_ref()],
        bump = treasury.bump,
        has_one = platform_authority @ TreasuryError::AuthorityMismatch,
    )]
    pub treasury: Account<'info, Treasury>,

    pub platform_authority: Signer<'info>,

    /// CHECK: any system-owned account is a valid SOL recipient. The
    /// platform looks up the Nosana host pubkey via the SDK, so we
    /// trust the caller's selection but refuse the zero-pubkey
    /// sentinel. Direct lamport mutation (program-owned source can't be
    /// the `from` of system_program::transfer), so no system_program
    /// CPI is needed in PayNosana.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
}

// ============================================================================
// State
// ============================================================================

#[account]
pub struct Treasury {
    pub owner_token_mint: Pubkey,
    pub platform_authority: Pubkey,
    pub total_paid_lamports: u64,
    pub total_received_lamports: u64,
    pub bump: u8,
    /// Two-step rotation: the proposed next platform_authority, or
    /// Pubkey::default() when no rotation is pending. Appended after
    /// `bump` so pre-rotation accounts (zeroed padding) deserialize as
    /// "no pending rotation".
    pub pending_authority: Pubkey,
}

impl Treasury {
    /// Used: 8 (discriminator) + 32 + 32 + 8 + 8 + 1 + 32 = 121.
    /// Total allocation is 153 — the remainder is forward-compat
    /// padding so new fields don't require a migration.
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 8 + 1 + 64;
}

#[account]
pub struct TreasuryConfig {
    pub admin: Pubkey,
    /// Two-step rotation: proposed next admin, or Pubkey::default().
    pub pending_admin: Pubkey,
    pub bump: u8,
}

impl TreasuryConfig {
    /// 8 (discriminator) + 32 + 32 + 1 = 73, padded for forward-compat.
    pub const SIZE: usize = 8 + 32 + 32 + 1 + 64;
}

// ============================================================================
// Events
// ============================================================================

#[event]
pub struct TreasuryInitialized {
    pub treasury: Pubkey,
    pub owner_token_mint: Pubkey,
    pub platform_authority: Pubkey,
}

#[event]
pub struct NosanaPayment {
    pub treasury: Pubkey,
    pub recipient: Pubkey,
    pub amount_lamports: u64,
    pub total_paid_lamports: u64,
}

#[event]
pub struct FeeReceived {
    pub treasury: Pubkey,
    pub from: Pubkey,
    pub amount_lamports: u64,
    pub total_received_lamports: u64,
}

#[event]
pub struct ConfigInitialized {
    pub config: Pubkey,
    pub admin: Pubkey,
}

#[event]
pub struct ConfigAdminProposed {
    pub config: Pubkey,
    pub current_admin: Pubkey,
    pub pending_admin: Pubkey,
}

#[event]
pub struct ConfigAdminRotated {
    pub config: Pubkey,
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}

#[event]
pub struct PlatformAuthorityProposed {
    pub treasury: Pubkey,
    pub current_authority: Pubkey,
    pub pending_authority: Pubkey,
}

#[event]
pub struct PlatformAuthorityRotated {
    pub treasury: Pubkey,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

// ============================================================================
// Errors
// ============================================================================

#[error_code]
pub enum TreasuryError {
    #[msg("amount must be > 0")]
    ZeroAmount,
    #[msg("recipient cannot be the system program zero pubkey")]
    InvalidRecipient,
    #[msg("treasury balance below rent reserve after transfer")]
    InsufficientBalance,
    #[msg("signer is not the recorded platform_authority")]
    AuthorityMismatch,
    #[msg("integer overflow on total_paid_lamports")]
    Overflow,
    #[msg("authority pubkey cannot be the default zero pubkey")]
    InvalidAuthority,
}
