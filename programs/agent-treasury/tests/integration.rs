//! In-process integration tests for the agent-treasury program.
//!
//! Uses LiteSVM (in-memory SVM, no validator process) and loads the
//! compiled BPF binary from `target/deploy/agent_treasury.so`. Run
//! `cargo build-sbf --manifest-path programs/agent-treasury/Cargo.toml`
//! before `cargo test -p agent-treasury` so the .so exists.
//!
//! These tests cover the two implemented instructions plus the
//! security/edge-case branches the program guards against.

use anchor_lang::prelude::AccountMeta;
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

use agent_treasury::{accounts, instruction, Treasury, TREASURY_SEED};

const PROGRAM_ID: Pubkey = agent_treasury::ID;

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

fn program_so_path() -> PathBuf {
    // CARGO_MANIFEST_DIR points at programs/agent-treasury/. Walk up two levels
    // to the workspace root, then into target/deploy.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .expect("workspace root")
        .parent()
        .expect("monorepo root")
        .join("target")
        .join("deploy")
        .join("agent_treasury.so")
}

fn boot_svm() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    let so = program_so_path();
    assert!(
        so.exists(),
        "BPF binary not found at {} — run `cargo build-sbf --manifest-path programs/agent-treasury/Cargo.toml` first",
        so.display(),
    );
    svm.add_program_from_file(PROGRAM_ID, &so)
        .expect("load agent_treasury.so");
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100 * LAMPORTS_PER_SOL)
        .expect("airdrop");
    (svm, payer)
}

fn derive_treasury(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[TREASURY_SEED, mint.as_ref()], &PROGRAM_ID)
}

fn ix_initialize(
    payer: &Pubkey,
    mint: &Pubkey,
    treasury: &Pubkey,
    platform_authority: Pubkey,
) -> Instruction {
    let accounts = accounts::InitializeTreasury {
        treasury: *treasury,
        owner_token_mint: *mint,
        payer: *payer,
        system_program: system_program::ID,
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: instruction::InitializeTreasury { platform_authority }.data(),
    }
}

fn ix_fee_receive(
    treasury: &Pubkey,
    from: &Pubkey,
    amount: u64,
) -> Instruction {
    let accounts = accounts::FeeReceive {
        treasury: *treasury,
        from: *from,
        system_program: system_program::ID,
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: instruction::FeeReceive { amount }.data(),
    }
}

fn ix_pay_nosana(
    treasury: &Pubkey,
    platform_authority: &Pubkey,
    recipient: &Pubkey,
    amount: u64,
) -> Instruction {
    let accounts = accounts::PayNosana {
        treasury: *treasury,
        platform_authority: *platform_authority,
        recipient: *recipient,
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: instruction::PayNosana { amount }.data(),
    }
}

fn fund_treasury(svm: &mut LiteSVM, payer: &Keypair, treasury: &Pubkey, lamports: u64) {
    let ix =
        solana_sdk::system_instruction::transfer(&payer.pubkey(), treasury, lamports);
    let tx = Transaction::new(
        &[payer],
        Message::new(&[ix], Some(&payer.pubkey())),
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("fund treasury");
}

fn read_treasury(svm: &LiteSVM, treasury: &Pubkey) -> Treasury {
    let acct = svm.get_account(treasury).expect("treasury account");
    Treasury::try_deserialize(&mut acct.data.as_slice()).expect("treasury deser")
}

// ---------------------------------------------------------------------------
// initialize_treasury
// ---------------------------------------------------------------------------

#[test]
fn initialize_treasury_records_metadata() {
    let (mut svm, payer) = boot_svm();
    let mint = Keypair::new().pubkey();
    let platform_authority = Keypair::new().pubkey();
    let (treasury, _bump) = derive_treasury(&mint);

    let ix = ix_initialize(&payer.pubkey(), &mint, &treasury, platform_authority);
    let tx = Transaction::new(
        &[&payer],
        Message::new(&[ix], Some(&payer.pubkey())),
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("initialize");

    let state = read_treasury(&svm, &treasury);
    assert_eq!(state.owner_token_mint, mint);
    assert_eq!(state.platform_authority, platform_authority);
    assert_eq!(state.total_paid_lamports, 0);
}

#[test]
fn initialize_treasury_twice_fails() {
    let (mut svm, payer) = boot_svm();
    let mint = Keypair::new().pubkey();
    let authority = Keypair::new().pubkey();
    let (treasury, _) = derive_treasury(&mint);

    let ix = ix_initialize(&payer.pubkey(), &mint, &treasury, authority);
    let tx = Transaction::new(
        &[&payer],
        Message::new(&[ix], Some(&payer.pubkey())),
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("first initialize");

    // Use a fresh payer so the second tx's signature is necessarily
    // distinct — otherwise litesvm dedups on the duplicate hash and we
    // get AlreadyProcessed rather than the program-level error we
    // actually want to verify.
    let payer2 = Keypair::new();
    svm.airdrop(&payer2.pubkey(), 10 * LAMPORTS_PER_SOL).unwrap();
    let ix2 = ix_initialize(&payer2.pubkey(), &mint, &treasury, authority);
    let tx2 = Transaction::new(
        &[&payer2],
        Message::new(&[ix2], Some(&payer2.pubkey())),
        svm.latest_blockhash(),
    );
    let err = svm.send_transaction(tx2).expect_err("second init must fail");
    let msg = format!("{err:?}");
    assert!(
        msg.contains("already in use") || msg.contains("0x0"),
        "expected an account-already-initialized error, got: {msg}",
    );
}

// ---------------------------------------------------------------------------
// fee_receive
// ---------------------------------------------------------------------------

#[test]
fn fee_receive_credits_treasury_and_increments_total() {
    let (mut svm, payer) = boot_svm();
    let mint = Keypair::new().pubkey();
    let authority = Keypair::new().pubkey();
    let depositor = Keypair::new();
    let (treasury, _) = derive_treasury(&mint);

    // Initialize the treasury.
    let init = ix_initialize(&payer.pubkey(), &mint, &treasury, authority);
    svm.send_transaction(Transaction::new(
        &[&payer],
        Message::new(&[init], Some(&payer.pubkey())),
        svm.latest_blockhash(),
    ))
    .unwrap();

    // Snapshot the treasury's balance after init (rent-exempt reserve).
    let pre_balance = svm.get_account(&treasury).unwrap().lamports;

    // Fund the depositor and have them call fee_receive.
    svm.airdrop(&depositor.pubkey(), 5 * LAMPORTS_PER_SOL).unwrap();
    let amount = 2 * LAMPORTS_PER_SOL;
    let fee_ix = ix_fee_receive(&treasury, &depositor.pubkey(), amount);
    svm.send_transaction(Transaction::new(
        &[&depositor],
        Message::new(&[fee_ix], Some(&depositor.pubkey())),
        svm.latest_blockhash(),
    ))
    .expect("fee_receive");

    let post_balance = svm.get_account(&treasury).unwrap().lamports;
    assert_eq!(post_balance, pre_balance + amount, "lamports should increase by amount");

    let state = read_treasury(&svm, &treasury);
    assert_eq!(state.total_received_lamports, amount);
    assert_eq!(state.total_paid_lamports, 0, "fee_receive must not touch total_paid");
}

#[test]
fn fee_receive_zero_amount_is_rejected() {
    let (mut svm, payer) = boot_svm();
    let mint = Keypair::new().pubkey();
    let authority = Keypair::new().pubkey();
    let depositor = Keypair::new();
    let (treasury, _) = derive_treasury(&mint);

    let init = ix_initialize(&payer.pubkey(), &mint, &treasury, authority);
    svm.send_transaction(Transaction::new(
        &[&payer],
        Message::new(&[init], Some(&payer.pubkey())),
        svm.latest_blockhash(),
    ))
    .unwrap();
    svm.airdrop(&depositor.pubkey(), LAMPORTS_PER_SOL).unwrap();

    let fee_ix = ix_fee_receive(&treasury, &depositor.pubkey(), 0);
    let err = svm
        .send_transaction(Transaction::new(
            &[&depositor],
            Message::new(&[fee_ix], Some(&depositor.pubkey())),
            svm.latest_blockhash(),
        ))
        .expect_err("zero-amount must fail");
    assert!(format!("{err:?}").contains("ZeroAmount"));
}

#[test]
fn fee_receive_does_not_require_authority() {
    // Anyone can deposit — the platform_authority is only enforced for
    // outflows (pay_nosana). Use an entirely unrelated keypair as the
    // depositor and confirm it succeeds.
    let (mut svm, payer) = boot_svm();
    let mint = Keypair::new().pubkey();
    let real_authority = Keypair::new().pubkey();
    let unrelated = Keypair::new();
    let (treasury, _) = derive_treasury(&mint);

    let init = ix_initialize(&payer.pubkey(), &mint, &treasury, real_authority);
    svm.send_transaction(Transaction::new(
        &[&payer],
        Message::new(&[init], Some(&payer.pubkey())),
        svm.latest_blockhash(),
    ))
    .unwrap();
    svm.airdrop(&unrelated.pubkey(), LAMPORTS_PER_SOL).unwrap();

    let fee_ix = ix_fee_receive(&treasury, &unrelated.pubkey(), 1_000_000);
    svm.send_transaction(Transaction::new(
        &[&unrelated],
        Message::new(&[fee_ix], Some(&unrelated.pubkey())),
        svm.latest_blockhash(),
    ))
    .expect("unrelated depositor should still succeed");
}

// ---------------------------------------------------------------------------
// pay_nosana — happy path
// ---------------------------------------------------------------------------

#[test]
fn pay_nosana_transfers_to_recipient_and_increments_total() {
    let (mut svm, payer) = boot_svm();
    let mint = Keypair::new().pubkey();
    let authority = Keypair::new();
    let recipient = Keypair::new().pubkey();
    let (treasury, _) = derive_treasury(&mint);

    // initialize
    let init = ix_initialize(&payer.pubkey(), &mint, &treasury, authority.pubkey());
    let tx = Transaction::new(
        &[&payer],
        Message::new(&[init], Some(&payer.pubkey())),
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("init");

    // fund the treasury PDA
    fund_treasury(&mut svm, &payer, &treasury, 5 * LAMPORTS_PER_SOL);

    // also fund the authority so it can pay tx fees
    svm.airdrop(&authority.pubkey(), LAMPORTS_PER_SOL).unwrap();

    let amount = LAMPORTS_PER_SOL; // 1 SOL
    let pay = ix_pay_nosana(&treasury, &authority.pubkey(), &recipient, amount);
    let tx = Transaction::new(
        &[&authority],
        Message::new(&[pay], Some(&authority.pubkey())),
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("pay_nosana");

    let recipient_balance = svm.get_account(&recipient).map(|a| a.lamports).unwrap_or(0);
    assert_eq!(recipient_balance, amount, "recipient should receive exactly amount");

    let state = read_treasury(&svm, &treasury);
    assert_eq!(state.total_paid_lamports, amount);
}

// ---------------------------------------------------------------------------
// pay_nosana — guards
// ---------------------------------------------------------------------------

#[test]
fn pay_nosana_zero_amount_is_rejected() {
    let (mut svm, payer) = boot_svm();
    let mint = Keypair::new().pubkey();
    let authority = Keypair::new();
    let recipient = Keypair::new().pubkey();
    let (treasury, _) = derive_treasury(&mint);

    let init = ix_initialize(&payer.pubkey(), &mint, &treasury, authority.pubkey());
    svm.send_transaction(Transaction::new(
        &[&payer],
        Message::new(&[init], Some(&payer.pubkey())),
        svm.latest_blockhash(),
    ))
    .unwrap();
    fund_treasury(&mut svm, &payer, &treasury, LAMPORTS_PER_SOL);
    svm.airdrop(&authority.pubkey(), LAMPORTS_PER_SOL).unwrap();

    let pay = ix_pay_nosana(&treasury, &authority.pubkey(), &recipient, 0);
    let tx = Transaction::new(
        &[&authority],
        Message::new(&[pay], Some(&authority.pubkey())),
        svm.latest_blockhash(),
    );
    let err = svm.send_transaction(tx).expect_err("zero-amount must fail");
    assert!(format!("{err:?}").contains("ZeroAmount") ||
            format!("{err:?}").contains("0x1770"),
            "expected ZeroAmount error, got: {err:?}");
}

#[test]
fn pay_nosana_with_wrong_authority_is_rejected() {
    let (mut svm, payer) = boot_svm();
    let mint = Keypair::new().pubkey();
    let real_authority = Keypair::new();
    let imposter = Keypair::new();
    let recipient = Keypair::new().pubkey();
    let (treasury, _) = derive_treasury(&mint);

    let init = ix_initialize(&payer.pubkey(), &mint, &treasury, real_authority.pubkey());
    svm.send_transaction(Transaction::new(
        &[&payer],
        Message::new(&[init], Some(&payer.pubkey())),
        svm.latest_blockhash(),
    ))
    .unwrap();
    fund_treasury(&mut svm, &payer, &treasury, LAMPORTS_PER_SOL);
    svm.airdrop(&imposter.pubkey(), LAMPORTS_PER_SOL).unwrap();

    let pay = ix_pay_nosana(&treasury, &imposter.pubkey(), &recipient, 1000);
    let tx = Transaction::new(
        &[&imposter],
        Message::new(&[pay], Some(&imposter.pubkey())),
        svm.latest_blockhash(),
    );
    let err = svm.send_transaction(tx).expect_err("imposter must fail");
    let msg = format!("{err:?}");
    // has_one constraint emits HasOne or AuthorityMismatch depending on
    // anchor version; both are correct.
    assert!(
        msg.contains("AuthorityMismatch")
            || msg.contains("HasOne")
            || msg.contains("0x1773")
            || msg.contains("ConstraintHasOne")
            || msg.contains("ConstraintRaw"),
        "expected authority mismatch, got: {msg}",
    );
}

#[test]
fn pay_nosana_with_zero_pubkey_recipient_is_rejected() {
    let (mut svm, payer) = boot_svm();
    let mint = Keypair::new().pubkey();
    let authority = Keypair::new();
    let zero = Pubkey::default();
    let (treasury, _) = derive_treasury(&mint);

    let init = ix_initialize(&payer.pubkey(), &mint, &treasury, authority.pubkey());
    svm.send_transaction(Transaction::new(
        &[&payer],
        Message::new(&[init], Some(&payer.pubkey())),
        svm.latest_blockhash(),
    ))
    .unwrap();
    fund_treasury(&mut svm, &payer, &treasury, LAMPORTS_PER_SOL);
    svm.airdrop(&authority.pubkey(), LAMPORTS_PER_SOL).unwrap();

    // The system program is at pubkey 11111…111 — but the assertion is on
    // Pubkey::default() so passing it as the *recipient* triggers the guard.
    // We pass the SystemProgram account meta here; the program checks the
    // value of recipient.key() against Pubkey::default().
    let pay = Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(treasury, false),
            AccountMeta::new_readonly(authority.pubkey(), true),
            AccountMeta::new(zero, false),
        ],
        data: instruction::PayNosana { amount: 1000 }.data(),
    };
    let tx = Transaction::new(
        &[&authority],
        Message::new(&[pay], Some(&authority.pubkey())),
        svm.latest_blockhash(),
    );
    let err = svm
        .send_transaction(tx)
        .expect_err("zero-pubkey recipient must fail");
    let msg = format!("{err:?}");
    assert!(
        msg.contains("InvalidRecipient") || msg.contains("0x1771"),
        "expected InvalidRecipient, got: {msg}",
    );
}

#[test]
fn pay_nosana_above_balance_is_rejected() {
    let (mut svm, payer) = boot_svm();
    let mint = Keypair::new().pubkey();
    let authority = Keypair::new();
    let recipient = Keypair::new().pubkey();
    let (treasury, _) = derive_treasury(&mint);

    let init = ix_initialize(&payer.pubkey(), &mint, &treasury, authority.pubkey());
    svm.send_transaction(Transaction::new(
        &[&payer],
        Message::new(&[init], Some(&payer.pubkey())),
        svm.latest_blockhash(),
    ))
    .unwrap();
    // Don't add any extra funding — treasury holds only the rent reserve from
    // its `init` allocation. Asking for 1 SOL drains below rent and must be
    // refused by our pre-check.
    svm.airdrop(&authority.pubkey(), LAMPORTS_PER_SOL).unwrap();

    let pay = ix_pay_nosana(&treasury, &authority.pubkey(), &recipient, LAMPORTS_PER_SOL);
    let tx = Transaction::new(
        &[&authority],
        Message::new(&[pay], Some(&authority.pubkey())),
        svm.latest_blockhash(),
    );
    let err = svm.send_transaction(tx).expect_err("over-pay must fail");
    let msg = format!("{err:?}");
    assert!(
        msg.contains("InsufficientBalance") || msg.contains("0x1772"),
        "expected InsufficientBalance, got: {msg}",
    );
}
