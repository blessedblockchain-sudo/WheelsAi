//! In-process integration tests for the reputation-oracle program.
//!
//! Uses LiteSVM (in-memory SVM, no validator process) and loads the
//! compiled BPF binary from `target/deploy/reputation_oracle.so`. Run
//! `cargo build-sbf --manifest-path programs/reputation-oracle/Cargo.toml`
//! before `cargo test -p reputation-oracle` so the .so exists.

use anchor_lang::AccountDeserialize;
use anchor_lang::InstructionData;
use anchor_lang::ToAccountMetas;
use litesvm::LiteSVM;
use solana_sdk::{
    instruction::Instruction,
    message::Message,
    native_token::LAMPORTS_PER_SOL,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program,
    transaction::Transaction,
};
use std::path::PathBuf;

use reputation_oracle::{
    accounts, instruction, AgentReputation, OracleConfig, AGENT_REPUTATION_SEED,
    MAX_ATTESTORS, ORACLE_CONFIG_SEED,
};

const PROGRAM_ID: Pubkey = reputation_oracle::ID;

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

fn program_so_path() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .expect("workspace root")
        .parent()
        .expect("monorepo root")
        .join("target")
        .join("deploy")
        .join("reputation_oracle.so")
}

fn boot_svm() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    let so = program_so_path();
    assert!(
        so.exists(),
        "BPF binary not found at {} — run `cargo build-sbf --manifest-path programs/reputation-oracle/Cargo.toml` first",
        so.display(),
    );
    svm.add_program_from_file(PROGRAM_ID, &so)
        .expect("load reputation_oracle.so");
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100 * LAMPORTS_PER_SOL)
        .expect("airdrop");
    (svm, payer)
}

fn derive_config() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[ORACLE_CONFIG_SEED], &PROGRAM_ID)
}

fn derive_agent(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[AGENT_REPUTATION_SEED, mint.as_ref()],
        &PROGRAM_ID,
    )
}

fn ix_initialize_oracle(admin: &Pubkey, config: &Pubkey) -> Instruction {
    let accounts = accounts::InitializeOracle {
        config: *config,
        admin: *admin,
        system_program: system_program::ID,
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: instruction::InitializeOracle {}.data(),
    }
}

fn ix_add_attestor(
    config: &Pubkey,
    admin: &Pubkey,
    attestor: Pubkey,
) -> Instruction {
    let accounts = accounts::ManageAttestors {
        config: *config,
        admin: *admin,
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: instruction::AddAttestor { attestor }.data(),
    }
}

fn ix_remove_attestor(
    config: &Pubkey,
    admin: &Pubkey,
    attestor: Pubkey,
) -> Instruction {
    let accounts = accounts::ManageAttestors {
        config: *config,
        admin: *admin,
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: instruction::RemoveAttestor { attestor }.data(),
    }
}

fn ix_propose_admin(
    config: &Pubkey,
    admin: &Pubkey,
    new_admin: Pubkey,
) -> Instruction {
    // Two-step rotation, step 1. Reuses the TransferAdmin accounts
    // struct (config + current admin signer); the instruction data
    // discriminator is sha256("global:propose_admin")[..8], which
    // `instruction::ProposeAdmin` computes for us.
    let accounts = accounts::TransferAdmin {
        config: *config,
        admin: *admin,
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: instruction::ProposeAdmin { new_admin }.data(),
    }
}

fn ix_accept_admin(config: &Pubkey, new_admin: &Pubkey) -> Instruction {
    // Two-step rotation, step 2: the proposed admin signs.
    let accounts = accounts::AcceptAdmin {
        config: *config,
        new_admin: *new_admin,
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: instruction::AcceptAdmin {}.data(),
    }
}

fn ix_initialize_agent(
    payer: &Pubkey,
    agent: &Pubkey,
    mint: &Pubkey,
) -> Instruction {
    let accounts = accounts::InitializeAgentReputation {
        agent: *agent,
        owner_token_mint: *mint,
        payer: *payer,
        system_program: system_program::ID,
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: instruction::InitializeAgentReputation {}.data(),
    }
}

fn ix_submit_attestation(
    config: &Pubkey,
    agent: &Pubkey,
    attestor: &Pubkey,
    uptime_seconds_delta: u64,
    message_count_delta: u64,
    score: u32,
    unix_ts: i64,
) -> Instruction {
    let accounts = accounts::SubmitAttestation {
        config: *config,
        agent: *agent,
        attestor: *attestor,
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: instruction::SubmitAttestation {
            uptime_seconds_delta,
            message_count_delta,
            score,
            unix_ts,
        }
        .data(),
    }
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    extra_signers: &[&Keypair],
    instructions: &[Instruction],
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra_signers);
    let blockhash = svm.latest_blockhash();
    let message = Message::new(instructions, Some(&payer.pubkey()));
    let tx = Transaction::new(&signers, message, blockhash);
    svm.send_transaction(tx).map(|_| ())
}

fn fetch_config(svm: &LiteSVM, config: &Pubkey) -> OracleConfig {
    let acc = svm.get_account(config).expect("config account exists");
    OracleConfig::try_deserialize(&mut acc.data.as_slice()).expect("deserialize")
}

fn fetch_agent(svm: &LiteSVM, agent: &Pubkey) -> AgentReputation {
    let acc = svm.get_account(agent).expect("agent account exists");
    AgentReputation::try_deserialize(&mut acc.data.as_slice()).expect("deserialize")
}

fn bootstrap_oracle(svm: &mut LiteSVM, admin: &Keypair) -> Pubkey {
    let (config, _) = derive_config();
    send(svm, admin, &[], &[ix_initialize_oracle(&admin.pubkey(), &config)])
        .expect("init oracle");
    config
}

// ---------------------------------------------------------------------------
// Tests: initialize_oracle
// ---------------------------------------------------------------------------

#[test]
fn initialize_oracle_creates_singleton_config_with_caller_as_admin() {
    let (mut svm, admin) = boot_svm();
    let (config, _) = derive_config();
    send(&mut svm, &admin, &[], &[ix_initialize_oracle(&admin.pubkey(), &config)])
        .expect("init succeeds");

    let state = fetch_config(&svm, &config);
    assert_eq!(state.admin, admin.pubkey());
    assert_eq!(state.attestor_count, 0);
    assert_eq!(state.attestors, [Pubkey::default(); MAX_ATTESTORS]);
    assert_eq!(state.pending_admin, Pubkey::default());
}

#[test]
fn initialize_oracle_rejects_double_init() {
    let (mut svm, admin) = boot_svm();
    let (config, _) = derive_config();
    send(&mut svm, &admin, &[], &[ix_initialize_oracle(&admin.pubkey(), &config)])
        .expect("first init succeeds");

    // Second admin tries to re-init (different payer to avoid AlreadyProcessed).
    let admin2 = Keypair::new();
    svm.airdrop(&admin2.pubkey(), 10 * LAMPORTS_PER_SOL).unwrap();
    let err = send(
        &mut svm,
        &admin2,
        &[],
        &[ix_initialize_oracle(&admin2.pubkey(), &config)],
    );
    assert!(err.is_err(), "double init must fail");
}

// ---------------------------------------------------------------------------
// Tests: add_attestor / remove_attestor
// ---------------------------------------------------------------------------

#[test]
fn add_attestor_appends_to_whitelist() {
    let (mut svm, admin) = boot_svm();
    let config = bootstrap_oracle(&mut svm, &admin);
    let attestor = Pubkey::new_unique();

    send(
        &mut svm,
        &admin,
        &[],
        &[ix_add_attestor(&config, &admin.pubkey(), attestor)],
    )
    .expect("add attestor");

    let state = fetch_config(&svm, &config);
    assert_eq!(state.attestor_count, 1);
    assert_eq!(state.attestors[0], attestor);
    assert_eq!(state.attestors[1], Pubkey::default());
}

#[test]
fn add_attestor_rejects_duplicates() {
    let (mut svm, admin) = boot_svm();
    let config = bootstrap_oracle(&mut svm, &admin);
    let attestor = Pubkey::new_unique();

    send(
        &mut svm,
        &admin,
        &[],
        &[ix_add_attestor(&config, &admin.pubkey(), attestor)],
    )
    .expect("first add");

    let err = send(
        &mut svm,
        &admin,
        &[],
        &[ix_add_attestor(&config, &admin.pubkey(), attestor)],
    );
    assert!(err.is_err(), "duplicate add must fail");

    let state = fetch_config(&svm, &config);
    assert_eq!(state.attestor_count, 1);
}

#[test]
fn add_attestor_rejects_non_admin() {
    let (mut svm, admin) = boot_svm();
    let config = bootstrap_oracle(&mut svm, &admin);

    let rando = Keypair::new();
    svm.airdrop(&rando.pubkey(), LAMPORTS_PER_SOL).unwrap();

    let err = send(
        &mut svm,
        &rando,
        &[],
        &[ix_add_attestor(&config, &rando.pubkey(), Pubkey::new_unique())],
    );
    assert!(err.is_err(), "non-admin add must fail");
}

#[test]
fn add_attestor_rejects_when_list_full() {
    let (mut svm, admin) = boot_svm();
    let config = bootstrap_oracle(&mut svm, &admin);

    for _ in 0..MAX_ATTESTORS {
        send(
            &mut svm,
            &admin,
            &[],
            &[ix_add_attestor(&config, &admin.pubkey(), Pubkey::new_unique())],
        )
        .expect("add ok");
    }
    let err = send(
        &mut svm,
        &admin,
        &[],
        &[ix_add_attestor(&config, &admin.pubkey(), Pubkey::new_unique())],
    );
    assert!(err.is_err(), "overflow add must fail");

    let state = fetch_config(&svm, &config);
    assert_eq!(state.attestor_count as usize, MAX_ATTESTORS);
}

#[test]
fn remove_attestor_compacts_array() {
    let (mut svm, admin) = boot_svm();
    let config = bootstrap_oracle(&mut svm, &admin);

    let a = Pubkey::new_unique();
    let b = Pubkey::new_unique();
    let c = Pubkey::new_unique();
    for k in [a, b, c] {
        send(
            &mut svm,
            &admin,
            &[],
            &[ix_add_attestor(&config, &admin.pubkey(), k)],
        )
        .expect("add");
    }

    // Remove the middle one — last (c) should swap into b's slot.
    send(
        &mut svm,
        &admin,
        &[],
        &[ix_remove_attestor(&config, &admin.pubkey(), b)],
    )
    .expect("remove middle");

    let state = fetch_config(&svm, &config);
    assert_eq!(state.attestor_count, 2);
    assert_eq!(state.attestors[0], a);
    assert_eq!(state.attestors[1], c);
    assert_eq!(state.attestors[2], Pubkey::default());
}

#[test]
fn remove_attestor_rejects_unknown() {
    let (mut svm, admin) = boot_svm();
    let config = bootstrap_oracle(&mut svm, &admin);

    let err = send(
        &mut svm,
        &admin,
        &[],
        &[ix_remove_attestor(
            &config,
            &admin.pubkey(),
            Pubkey::new_unique(),
        )],
    );
    assert!(err.is_err(), "remove of unknown must fail");
}

// ---------------------------------------------------------------------------
// Tests: propose_admin / accept_admin (two-step rotation)
// ---------------------------------------------------------------------------

#[test]
fn propose_then_accept_admin_rotates_authority() {
    let (mut svm, admin) = boot_svm();
    let config = bootstrap_oracle(&mut svm, &admin);

    let new_admin = Keypair::new();
    svm.airdrop(&new_admin.pubkey(), LAMPORTS_PER_SOL).unwrap();

    // Step 1: current admin proposes.
    send(
        &mut svm,
        &admin,
        &[],
        &[ix_propose_admin(&config, &admin.pubkey(), new_admin.pubkey())],
    )
    .expect("propose");

    let state = fetch_config(&svm, &config);
    assert_eq!(state.admin, admin.pubkey(), "propose must not rotate yet");
    assert_eq!(state.pending_admin, new_admin.pubkey());

    // Old admin keeps power until accept: add_attestor still works.
    let interim_attestor = Pubkey::new_unique();
    send(
        &mut svm,
        &admin,
        &[],
        &[ix_add_attestor(&config, &admin.pubkey(), interim_attestor)],
    )
    .expect("old admin still has power before accept");

    // Step 2: the proposed admin accepts.
    send(
        &mut svm,
        &new_admin,
        &[],
        &[ix_accept_admin(&config, &new_admin.pubkey())],
    )
    .expect("accept");

    let state = fetch_config(&svm, &config);
    assert_eq!(state.admin, new_admin.pubkey());
    assert_eq!(
        state.pending_admin,
        Pubkey::default(),
        "pending cleared after accept",
    );

    // Old admin can no longer add attestors.
    let err = send(
        &mut svm,
        &admin,
        &[],
        &[ix_add_attestor(&config, &admin.pubkey(), Pubkey::new_unique())],
    );
    assert!(err.is_err(), "old admin must lose authority after accept");

    // New admin succeeds.
    let attestor = Pubkey::new_unique();
    send(
        &mut svm,
        &new_admin,
        &[],
        &[ix_add_attestor(&config, &new_admin.pubkey(), attestor)],
    )
    .expect("new admin can add");
}

#[test]
fn accept_admin_without_pending_proposal_fails() {
    let (mut svm, admin) = boot_svm();
    let config = bootstrap_oracle(&mut svm, &admin);

    let opportunist = Keypair::new();
    svm.airdrop(&opportunist.pubkey(), LAMPORTS_PER_SOL).unwrap();

    // No propose_admin happened — pending_admin is Pubkey::default().
    let err = send(
        &mut svm,
        &opportunist,
        &[],
        &[ix_accept_admin(&config, &opportunist.pubkey())],
    );
    assert!(err.is_err(), "accept with no pending proposal must fail");

    let state = fetch_config(&svm, &config);
    assert_eq!(state.admin, admin.pubkey(), "admin unchanged");
    assert_eq!(state.pending_admin, Pubkey::default());
}

#[test]
fn accept_admin_by_non_pending_key_fails() {
    let (mut svm, admin) = boot_svm();
    let config = bootstrap_oracle(&mut svm, &admin);

    let new_admin = Keypair::new();
    let mallory = Keypair::new();
    svm.airdrop(&mallory.pubkey(), LAMPORTS_PER_SOL).unwrap();

    send(
        &mut svm,
        &admin,
        &[],
        &[ix_propose_admin(&config, &admin.pubkey(), new_admin.pubkey())],
    )
    .expect("propose");

    // mallory ≠ pending_admin — accept must fail.
    let err = send(
        &mut svm,
        &mallory,
        &[],
        &[ix_accept_admin(&config, &mallory.pubkey())],
    );
    assert!(err.is_err(), "accept by a key != pending must fail");

    let state = fetch_config(&svm, &config);
    assert_eq!(state.admin, admin.pubkey(), "admin unchanged");
    assert_eq!(
        state.pending_admin,
        new_admin.pubkey(),
        "pending proposal untouched",
    );
}

#[test]
fn propose_admin_by_non_admin_fails() {
    let (mut svm, admin) = boot_svm();
    let config = bootstrap_oracle(&mut svm, &admin);

    let rando = Keypair::new();
    svm.airdrop(&rando.pubkey(), LAMPORTS_PER_SOL).unwrap();

    let err = send(
        &mut svm,
        &rando,
        &[],
        &[ix_propose_admin(&config, &rando.pubkey(), rando.pubkey())],
    );
    assert!(err.is_err(), "non-admin propose must fail");

    let state = fetch_config(&svm, &config);
    assert_eq!(state.pending_admin, Pubkey::default(), "no proposal recorded");
}

// ---------------------------------------------------------------------------
// Tests: initialize_agent_reputation + submit_attestation
// ---------------------------------------------------------------------------

#[test]
fn initialize_agent_creates_zeroed_record() {
    let (mut svm, payer) = boot_svm();
    let config = bootstrap_oracle(&mut svm, &payer);
    let _ = config;

    let mint = Pubkey::new_unique();
    let (agent_pda, _) = derive_agent(&mint);
    send(
        &mut svm,
        &payer,
        &[],
        &[ix_initialize_agent(&payer.pubkey(), &agent_pda, &mint)],
    )
    .expect("init agent");

    let state = fetch_agent(&svm, &agent_pda);
    assert_eq!(state.owner_token_mint, mint);
    assert_eq!(state.cumulative_uptime_seconds, 0);
    assert_eq!(state.cumulative_message_count, 0);
    assert_eq!(state.last_score, 0);
    assert_eq!(state.attestation_count, 0);
}

#[test]
fn submit_attestation_updates_cumulative_fields() {
    let (mut svm, admin) = boot_svm();
    let config = bootstrap_oracle(&mut svm, &admin);

    let attestor_kp = Keypair::new();
    svm.airdrop(&attestor_kp.pubkey(), LAMPORTS_PER_SOL).unwrap();
    send(
        &mut svm,
        &admin,
        &[],
        &[ix_add_attestor(&config, &admin.pubkey(), attestor_kp.pubkey())],
    )
    .expect("add attestor");

    let mint = Pubkey::new_unique();
    let (agent_pda, _) = derive_agent(&mint);
    send(
        &mut svm,
        &admin,
        &[],
        &[ix_initialize_agent(&admin.pubkey(), &agent_pda, &mint)],
    )
    .expect("init agent");

    send(
        &mut svm,
        &attestor_kp,
        &[],
        &[ix_submit_attestation(
            &config,
            &agent_pda,
            &attestor_kp.pubkey(),
            3_600,
            12,
            85,
            1_000,
        )],
    )
    .expect("first attestation");

    send(
        &mut svm,
        &attestor_kp,
        &[],
        &[ix_submit_attestation(
            &config,
            &agent_pda,
            &attestor_kp.pubkey(),
            7_200,
            20,
            72,
            2_000,
        )],
    )
    .expect("second attestation");

    let state = fetch_agent(&svm, &agent_pda);
    assert_eq!(state.cumulative_uptime_seconds, 10_800);
    assert_eq!(state.cumulative_message_count, 32);
    assert_eq!(state.last_score, 72);
    assert_eq!(state.last_attestation_unix_ts, 2_000);
    assert_eq!(state.attestation_count, 2);
}

#[test]
fn submit_attestation_rejects_unauthorized_signer() {
    let (mut svm, admin) = boot_svm();
    let config = bootstrap_oracle(&mut svm, &admin);

    let mint = Pubkey::new_unique();
    let (agent_pda, _) = derive_agent(&mint);
    send(
        &mut svm,
        &admin,
        &[],
        &[ix_initialize_agent(&admin.pubkey(), &agent_pda, &mint)],
    )
    .unwrap();

    let attacker = Keypair::new();
    svm.airdrop(&attacker.pubkey(), LAMPORTS_PER_SOL).unwrap();
    let err = send(
        &mut svm,
        &attacker,
        &[],
        &[ix_submit_attestation(
            &config,
            &agent_pda,
            &attacker.pubkey(),
            100,
            1,
            50,
            1_000,
        )],
    );
    assert!(err.is_err(), "non-attestor submit must fail");

    // Account remains untouched.
    let state = fetch_agent(&svm, &agent_pda);
    assert_eq!(state.attestation_count, 0);
}

#[test]
fn submit_attestation_rejects_score_above_100() {
    let (mut svm, admin) = boot_svm();
    let config = bootstrap_oracle(&mut svm, &admin);

    let attestor_kp = Keypair::new();
    svm.airdrop(&attestor_kp.pubkey(), LAMPORTS_PER_SOL).unwrap();
    send(
        &mut svm,
        &admin,
        &[],
        &[ix_add_attestor(&config, &admin.pubkey(), attestor_kp.pubkey())],
    )
    .unwrap();

    let mint = Pubkey::new_unique();
    let (agent_pda, _) = derive_agent(&mint);
    send(
        &mut svm,
        &admin,
        &[],
        &[ix_initialize_agent(&admin.pubkey(), &agent_pda, &mint)],
    )
    .unwrap();

    let err = send(
        &mut svm,
        &attestor_kp,
        &[],
        &[ix_submit_attestation(
            &config,
            &agent_pda,
            &attestor_kp.pubkey(),
            10,
            1,
            101,
            1_000,
        )],
    );
    assert!(err.is_err(), "score > 100 must fail");
}

#[test]
fn submit_attestation_rejects_stale_timestamp() {
    let (mut svm, admin) = boot_svm();
    let config = bootstrap_oracle(&mut svm, &admin);

    let attestor_kp = Keypair::new();
    svm.airdrop(&attestor_kp.pubkey(), LAMPORTS_PER_SOL).unwrap();
    send(
        &mut svm,
        &admin,
        &[],
        &[ix_add_attestor(&config, &admin.pubkey(), attestor_kp.pubkey())],
    )
    .unwrap();

    let mint = Pubkey::new_unique();
    let (agent_pda, _) = derive_agent(&mint);
    send(
        &mut svm,
        &admin,
        &[],
        &[ix_initialize_agent(&admin.pubkey(), &agent_pda, &mint)],
    )
    .unwrap();

    send(
        &mut svm,
        &attestor_kp,
        &[],
        &[ix_submit_attestation(
            &config,
            &agent_pda,
            &attestor_kp.pubkey(),
            100,
            1,
            80,
            5_000,
        )],
    )
    .expect("first attestation at ts=5000");

    let err = send(
        &mut svm,
        &attestor_kp,
        &[],
        &[ix_submit_attestation(
            &config,
            &agent_pda,
            &attestor_kp.pubkey(),
            100,
            1,
            70,
            4_999,
        )],
    );
    assert!(err.is_err(), "stale attestation must fail");

    let state = fetch_agent(&svm, &agent_pda);
    assert_eq!(state.last_attestation_unix_ts, 5_000);
    assert_eq!(state.attestation_count, 1);
}

#[test]
fn submit_attestation_succeeds_on_equal_timestamp() {
    let (mut svm, admin) = boot_svm();
    let config = bootstrap_oracle(&mut svm, &admin);

    let attestor_kp = Keypair::new();
    svm.airdrop(&attestor_kp.pubkey(), LAMPORTS_PER_SOL).unwrap();
    send(
        &mut svm,
        &admin,
        &[],
        &[ix_add_attestor(&config, &admin.pubkey(), attestor_kp.pubkey())],
    )
    .unwrap();

    let mint = Pubkey::new_unique();
    let (agent_pda, _) = derive_agent(&mint);
    send(
        &mut svm,
        &admin,
        &[],
        &[ix_initialize_agent(&admin.pubkey(), &agent_pda, &mint)],
    )
    .unwrap();

    send(
        &mut svm,
        &attestor_kp,
        &[],
        &[ix_submit_attestation(
            &config,
            &agent_pda,
            &attestor_kp.pubkey(),
            10,
            1,
            50,
            1_000,
        )],
    )
    .unwrap();

    // Equal timestamp permitted (per program comment).
    send(
        &mut svm,
        &attestor_kp,
        &[],
        &[ix_submit_attestation(
            &config,
            &agent_pda,
            &attestor_kp.pubkey(),
            5,
            2,
            55,
            1_000,
        )],
    )
    .expect("equal timestamp permitted");

    let state = fetch_agent(&svm, &agent_pda);
    assert_eq!(state.attestation_count, 2);
    assert_eq!(state.cumulative_uptime_seconds, 15);
    assert_eq!(state.cumulative_message_count, 3);
    assert_eq!(state.last_score, 55);
}

#[test]
fn removed_attestor_can_no_longer_submit() {
    let (mut svm, admin) = boot_svm();
    let config = bootstrap_oracle(&mut svm, &admin);

    let attestor_kp = Keypair::new();
    svm.airdrop(&attestor_kp.pubkey(), LAMPORTS_PER_SOL).unwrap();
    send(
        &mut svm,
        &admin,
        &[],
        &[ix_add_attestor(&config, &admin.pubkey(), attestor_kp.pubkey())],
    )
    .unwrap();

    let mint = Pubkey::new_unique();
    let (agent_pda, _) = derive_agent(&mint);
    send(
        &mut svm,
        &admin,
        &[],
        &[ix_initialize_agent(&admin.pubkey(), &agent_pda, &mint)],
    )
    .unwrap();

    // Submit once successfully.
    send(
        &mut svm,
        &attestor_kp,
        &[],
        &[ix_submit_attestation(
            &config,
            &agent_pda,
            &attestor_kp.pubkey(),
            10,
            1,
            50,
            1_000,
        )],
    )
    .unwrap();

    // Admin revokes.
    send(
        &mut svm,
        &admin,
        &[],
        &[ix_remove_attestor(&config, &admin.pubkey(), attestor_kp.pubkey())],
    )
    .unwrap();

    let err = send(
        &mut svm,
        &attestor_kp,
        &[],
        &[ix_submit_attestation(
            &config,
            &agent_pda,
            &attestor_kp.pubkey(),
            10,
            1,
            60,
            2_000,
        )],
    );
    assert!(err.is_err(), "revoked attestor must lose ability to submit");
}
