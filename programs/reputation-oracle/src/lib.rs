//! reputation-oracle — plan A4.
//!
//! On-chain agent reputation: third parties (the WheelsAI backend, and
//! eventually Nosana host nodes) post signed attestations about a
//! deployed agent's uptime / message count / aggregated score. The
//! pump.fun token-launch eligibility gate reads from this program
//! instead of trusting an off-chain database, so prospective holders
//! can verify the eligibility numbers themselves.
//!
//! ## Account model
//!
//! ```text
//! OracleConfig (singleton PDA, seeds = [b"oracle"])
//!   admin:            Pubkey      // can add/remove attestors, rotate admin
//!   attestor_count:   u8          // current count (≤ MAX_ATTESTORS)
//!   attestors:        [Pubkey; 5] // unused slots are Pubkey::default()
//!   bump:             u8
//!
//! AgentReputation (per-agent PDA, seeds = [b"agent", owner_token_mint])
//!   owner_token_mint:           Pubkey  // identity
//!   cumulative_uptime_seconds:  u64
//!   cumulative_message_count:   u64
//!   last_score:                 u32     // 0..=100, most recent attestation
//!   last_attestation_unix_ts:   i64
//!   attestation_count:          u32
//!   bump:                       u8
//! ```
//!
//! ## Why a whitelist instead of an open `submit_attestation`?
//!
//! Reputation drives token-launch eligibility, which drives real money.
//! An open submit would let anyone forge an agent's uptime to game the
//! gate. The whitelist is the MVP trust model: the platform's backend
//! key is the sole attestor at launch. Phase 2 extends the list to
//! include Nosana host node keys so attestations require a host
//! co-signature (the host actually saw the agent run).
//!
//! ## Why mutate the agent record in-place rather than store an array
//! of attestations?
//!
//! On-chain storage is expensive. Holders care about *current* uptime,
//! not history. Individual attestations are emitted as events; the
//! indexer reconstructs history off-chain if needed.
//!
//! ## Why no `read_score` instruction?
//!
//! Account deserialization IS the read interface. Clients fetch
//! AgentReputation by PDA and check the fields directly. An on-chain
//! "read" would be a CPI helper, not a user-facing call; deferred
//! until another program (e.g. governance) actually needs to read
//! eligibility on-chain.

use anchor_lang::prelude::*;

declare_id!("DMa1sNwXF6mZ2vyGiuA4QZhXPb5Sk4tp9gdnXsscrEB5");

pub const ORACLE_CONFIG_SEED: &[u8] = b"oracle";
pub const AGENT_REPUTATION_SEED: &[u8] = b"agent";
pub const MAX_ATTESTORS: usize = 5;

#[program]
pub mod reputation_oracle {
    use super::*;

    /// Bootstrap the singleton config. Whoever calls this becomes the
    /// admin (which is intended to be a multisig in production). One
    /// per program ID — the PDA derivation guarantees uniqueness.
    pub fn initialize_oracle(ctx: Context<InitializeOracle>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.attestor_count = 0;
        config.attestors = [Pubkey::default(); MAX_ATTESTORS];
        config.bump = ctx.bumps.config;

        emit!(OracleInitialized {
            config: config.key(),
            admin: config.admin,
        });
        Ok(())
    }

    /// Add a wallet to the attestor whitelist. Admin-only.
    /// Idempotent in the rejecting sense: duplicate insert fails so
    /// the caller knows.
    pub fn add_attestor(ctx: Context<ManageAttestors>, attestor: Pubkey) -> Result<()> {
        require!(
            attestor != Pubkey::default(),
            ReputationError::InvalidAttestor,
        );
        let config = &mut ctx.accounts.config;

        // Reject duplicates.
        for i in 0..(config.attestor_count as usize) {
            require!(
                config.attestors[i] != attestor,
                ReputationError::AttestorAlreadyExists,
            );
        }
        require!(
            (config.attestor_count as usize) < MAX_ATTESTORS,
            ReputationError::AttestorListFull,
        );

        let slot = config.attestor_count as usize;
        config.attestors[slot] = attestor;
        config.attestor_count = config
            .attestor_count
            .checked_add(1)
            .ok_or(ReputationError::Overflow)?;

        emit!(AttestorAdded {
            config: config.key(),
            attestor,
        });
        Ok(())
    }

    /// Remove a wallet from the whitelist. Admin-only. Compacts the
    /// array by swapping the removed slot with the last filled slot,
    /// so iteration in submit_attestation stays bounded by
    /// attestor_count rather than MAX_ATTESTORS.
    pub fn remove_attestor(
        ctx: Context<ManageAttestors>,
        attestor: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let count = config.attestor_count as usize;

        let mut found_index: Option<usize> = None;
        for i in 0..count {
            if config.attestors[i] == attestor {
                found_index = Some(i);
                break;
            }
        }
        let idx = found_index.ok_or(ReputationError::AttestorNotFound)?;

        let last = count - 1;
        if idx != last {
            config.attestors[idx] = config.attestors[last];
        }
        config.attestors[last] = Pubkey::default();
        config.attestor_count = (count - 1) as u8;

        emit!(AttestorRemoved {
            config: config.key(),
            attestor,
        });
        Ok(())
    }

    /// Rotate the admin key. Old admin must sign; new admin is the
    /// argument. Useful when moving from single-key bootstrap to a
    /// multisig without redeploying the program.
    pub fn transfer_admin(
        ctx: Context<TransferAdmin>,
        new_admin: Pubkey,
    ) -> Result<()> {
        require!(
            new_admin != Pubkey::default(),
            ReputationError::InvalidAttestor,
        );
        let config = &mut ctx.accounts.config;
        let old_admin = config.admin;
        config.admin = new_admin;

        emit!(AdminTransferred {
            config: config.key(),
            old_admin,
            new_admin,
        });
        Ok(())
    }

    /// One-time per-agent: allocate the AgentReputation PDA for a
    /// given token mint. Anyone can pay rent — the account is
    /// program-owned and the mint pubkey is the only identifier.
    pub fn initialize_agent_reputation(
        ctx: Context<InitializeAgentReputation>,
    ) -> Result<()> {
        let agent = &mut ctx.accounts.agent;
        agent.owner_token_mint = ctx.accounts.owner_token_mint.key();
        agent.cumulative_uptime_seconds = 0;
        agent.cumulative_message_count = 0;
        agent.last_score = 0;
        agent.last_attestation_unix_ts = 0;
        agent.attestation_count = 0;
        agent.bump = ctx.bumps.agent;

        emit!(AgentReputationInitialized {
            agent: agent.key(),
            owner_token_mint: agent.owner_token_mint,
        });
        Ok(())
    }

    /// Whitelisted attestor posts a fresh observation about an agent.
    ///
    /// `uptime_seconds_delta` and `message_count_delta` are *deltas
    /// since the last attestation by this same attestor* — the program
    /// adds them onto the cumulative counters. `score` (0..=100) is a
    /// snapshot, not a delta, so the latest attestor's opinion wins.
    /// `unix_ts` is the attestor-claimed timestamp; the program does
    /// not validate it against the Solana clock (different timebase,
    /// and host clocks are inherently mistrusted). We do require it
    /// be ≥ the previous `last_attestation_unix_ts` to prevent
    /// trivially-replayed older attestations from polluting state.
    pub fn submit_attestation(
        ctx: Context<SubmitAttestation>,
        uptime_seconds_delta: u64,
        message_count_delta: u64,
        score: u32,
        unix_ts: i64,
    ) -> Result<()> {
        require!(score <= 100, ReputationError::ScoreOutOfRange);

        let config = &ctx.accounts.config;
        let attestor_key = ctx.accounts.attestor.key();

        // Linear scan; bounded by MAX_ATTESTORS (5) so trivially OK.
        let mut authorized = false;
        for i in 0..(config.attestor_count as usize) {
            if config.attestors[i] == attestor_key {
                authorized = true;
                break;
            }
        }
        require!(authorized, ReputationError::UnauthorizedAttestor);

        let agent = &mut ctx.accounts.agent;
        require!(
            unix_ts >= agent.last_attestation_unix_ts,
            ReputationError::StaleAttestation,
        );

        agent.cumulative_uptime_seconds = agent
            .cumulative_uptime_seconds
            .checked_add(uptime_seconds_delta)
            .ok_or(ReputationError::Overflow)?;
        agent.cumulative_message_count = agent
            .cumulative_message_count
            .checked_add(message_count_delta)
            .ok_or(ReputationError::Overflow)?;
        agent.last_score = score;
        agent.last_attestation_unix_ts = unix_ts;
        agent.attestation_count = agent
            .attestation_count
            .checked_add(1)
            .ok_or(ReputationError::Overflow)?;

        emit!(AttestationSubmitted {
            agent: agent.key(),
            attestor: attestor_key,
            uptime_seconds_delta,
            message_count_delta,
            score,
            unix_ts,
            cumulative_uptime_seconds: agent.cumulative_uptime_seconds,
            cumulative_message_count: agent.cumulative_message_count,
            attestation_count: agent.attestation_count,
        });
        Ok(())
    }
}

// ============================================================================
// Account structs
// ============================================================================

#[derive(Accounts)]
pub struct InitializeOracle<'info> {
    #[account(
        init,
        payer = admin,
        space = OracleConfig::SIZE,
        seeds = [ORACLE_CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, OracleConfig>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ManageAttestors<'info> {
    #[account(
        mut,
        seeds = [ORACLE_CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ReputationError::AdminMismatch,
    )]
    pub config: Account<'info, OracleConfig>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct TransferAdmin<'info> {
    #[account(
        mut,
        seeds = [ORACLE_CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ReputationError::AdminMismatch,
    )]
    pub config: Account<'info, OracleConfig>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitializeAgentReputation<'info> {
    #[account(
        init,
        payer = payer,
        space = AgentReputation::SIZE,
        seeds = [AGENT_REPUTATION_SEED, owner_token_mint.key().as_ref()],
        bump,
    )]
    pub agent: Account<'info, AgentReputation>,

    /// CHECK: only used as a seed; we never deserialize.
    pub owner_token_mint: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitAttestation<'info> {
    #[account(
        seeds = [ORACLE_CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, OracleConfig>,

    #[account(
        mut,
        seeds = [AGENT_REPUTATION_SEED, agent.owner_token_mint.as_ref()],
        bump = agent.bump,
    )]
    pub agent: Account<'info, AgentReputation>,

    pub attestor: Signer<'info>,
}

// ============================================================================
// State
// ============================================================================

#[account]
pub struct OracleConfig {
    pub admin: Pubkey,
    pub attestor_count: u8,
    pub attestors: [Pubkey; MAX_ATTESTORS],
    pub bump: u8,
}

impl OracleConfig {
    // 8 (disc) + 32 (admin) + 1 (count) + 5*32 (attestors) + 1 (bump) = 202
    // + 64 padding for forward-compat
    pub const SIZE: usize = 8 + 32 + 1 + (32 * MAX_ATTESTORS) + 1 + 64;
}

#[account]
pub struct AgentReputation {
    pub owner_token_mint: Pubkey,
    pub cumulative_uptime_seconds: u64,
    pub cumulative_message_count: u64,
    pub last_score: u32,
    pub last_attestation_unix_ts: i64,
    pub attestation_count: u32,
    pub bump: u8,
}

impl AgentReputation {
    // 8 + 32 + 8 + 8 + 4 + 8 + 4 + 1 = 73 + 64 padding
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 4 + 8 + 4 + 1 + 64;
}

// ============================================================================
// Events
// ============================================================================

#[event]
pub struct OracleInitialized {
    pub config: Pubkey,
    pub admin: Pubkey,
}

#[event]
pub struct AttestorAdded {
    pub config: Pubkey,
    pub attestor: Pubkey,
}

#[event]
pub struct AttestorRemoved {
    pub config: Pubkey,
    pub attestor: Pubkey,
}

#[event]
pub struct AdminTransferred {
    pub config: Pubkey,
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}

#[event]
pub struct AgentReputationInitialized {
    pub agent: Pubkey,
    pub owner_token_mint: Pubkey,
}

#[event]
pub struct AttestationSubmitted {
    pub agent: Pubkey,
    pub attestor: Pubkey,
    pub uptime_seconds_delta: u64,
    pub message_count_delta: u64,
    pub score: u32,
    pub unix_ts: i64,
    pub cumulative_uptime_seconds: u64,
    pub cumulative_message_count: u64,
    pub attestation_count: u32,
}

// ============================================================================
// Errors
// ============================================================================

#[error_code]
pub enum ReputationError {
    #[msg("attestor pubkey cannot be the default zero pubkey")]
    InvalidAttestor,
    #[msg("attestor already in whitelist")]
    AttestorAlreadyExists,
    #[msg("attestor whitelist is full")]
    AttestorListFull,
    #[msg("attestor not found in whitelist")]
    AttestorNotFound,
    #[msg("signer is not the recorded admin")]
    AdminMismatch,
    #[msg("signer is not in the attestor whitelist")]
    UnauthorizedAttestor,
    #[msg("score must be in 0..=100")]
    ScoreOutOfRange,
    #[msg("attestation timestamp is older than the latest recorded attestation")]
    StaleAttestation,
    #[msg("integer overflow")]
    Overflow,
}
