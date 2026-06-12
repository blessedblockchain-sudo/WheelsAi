/**
 * Hand-rolled TypeScript client for the agent-treasury Anchor program.
 *
 * No `@coral-xyz/anchor` dependency — Anchor's wire format is simple
 * enough (8-byte sha256 discriminator + borsh-encoded args) that pulling
 * in the full SDK isn't worth the bundle size or the version-skew risk.
 * Tests in `agentTreasuryProgram.unit.test.ts` pin the discriminator
 * bytes against the program's `[program]` mod name + instruction names
 * — if anchor ever rotates that scheme, those tests fail loudly.
 *
 * Anchor instruction wire format (per ix):
 *   bytes 0..8       sha256("global:<ix_name>")[..8]   (LE bytes as-is)
 *   bytes 8..        borsh-encoded args, in declaration order
 *
 * Args reference (from programs/agent-treasury/src/lib.rs):
 *   initialize_config()                                → 8 bytes (disc only)
 *   initialize_treasury(platform_authority: Pubkey)    → 8 + 32 bytes
 *   propose_platform_authority(new_authority: Pubkey)  → 8 + 32 bytes
 *   accept_platform_authority()                        → 8 bytes (disc only)
 *   pay_nosana(amount: u64)                            → 8 + 8 bytes (LE)
 *   fee_receive(amount: u64)                           → 8 + 8 bytes (LE)
 *
 * Account-meta order MUST match the Rust `#[derive(Accounts)]` struct
 * field order exactly; the program will reject a mis-ordered tx with
 * `InstructionError::InvalidAccountData`.
 */

import { createHash } from "node:crypto";

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const AGENT_TREASURY_PROGRAM_ID = new PublicKey(
  "9TF7xZpYYwbiiVmcJJs6RDmjDTpqoscYtWKhNBcMzM1n",
);

const TREASURY_SEED = Buffer.from("treasury");
const TREASURY_CONFIG_SEED = Buffer.from("config");

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

/**
 * Derive the treasury PDA for a given token mint. Matches the Rust
 * `seeds = [TREASURY_SEED, owner_token_mint.key().as_ref()]`.
 */
export function deriveTreasuryPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [TREASURY_SEED, mint.toBuffer()],
    AGENT_TREASURY_PROGRAM_ID,
  );
}

/**
 * Derive the singleton TreasuryConfig PDA. Matches the Rust
 * `seeds = [TREASURY_CONFIG_SEED]` (i.e. `[b"config"]`). One per
 * program ID; holds the admin that gates `initialize_treasury` (C1).
 */
export function deriveTreasuryConfigPda(
  programId: PublicKey = AGENT_TREASURY_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([TREASURY_CONFIG_SEED], programId);
}

// ---------------------------------------------------------------------------
// Discriminator
// ---------------------------------------------------------------------------

function discriminator(ixName: string): Buffer {
  // Anchor's snake_case ix name; sha256("global:<name>")[..8].
  return createHash("sha256")
    .update(`global:${ixName}`)
    .digest()
    .subarray(0, 8);
}

// Cached at module load — these never change for a given program build.
const INITIALIZE_TREASURY_DISC = discriminator("initialize_treasury");
const PAY_NOSANA_DISC = discriminator("pay_nosana");
const FEE_RECEIVE_DISC = discriminator("fee_receive");
const INITIALIZE_CONFIG_DISC = discriminator("initialize_config");
const PROPOSE_PLATFORM_AUTHORITY_DISC = discriminator(
  "propose_platform_authority",
);
const ACCEPT_PLATFORM_AUTHORITY_DISC = discriminator(
  "accept_platform_authority",
);

// ---------------------------------------------------------------------------
// initialize_config
// ---------------------------------------------------------------------------

export interface BuildInitializeConfigIxInput {
  /** Caller becomes the config admin; also pays the config PDA's rent. */
  admin: PublicKey;
}

export function buildInitializeConfigIx(
  input: BuildInitializeConfigIxInput,
): TransactionInstruction {
  const [config] = deriveTreasuryConfigPda();
  return new TransactionInstruction({
    programId: AGENT_TREASURY_PROGRAM_ID,
    keys: [
      // Order MUST match the Rust InitializeConfig struct:
      //   1. config (mut, init)
      //   2. admin  (mut signer, payer)
      //   3. system_program
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: input.admin, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(INITIALIZE_CONFIG_DISC),
  });
}

// ---------------------------------------------------------------------------
// initialize_treasury
// ---------------------------------------------------------------------------

export interface BuildInitializeTreasuryIxInput {
  /** SPL Mint pubkey owning this treasury (used as PDA seed). */
  mint: PublicKey;
  /** The wallet allowed to call pay_nosana. */
  platformAuthority: PublicKey;
  /** Config admin; must co-sign treasury creation (C1 front-run fix). */
  admin: PublicKey;
  /** Tx-fee payer; pays rent for the treasury account creation. */
  payer: PublicKey;
}

export function buildInitializeTreasuryIx(
  input: BuildInitializeTreasuryIxInput,
): TransactionInstruction {
  const [treasury] = deriveTreasuryPda(input.mint);
  const [config] = deriveTreasuryConfigPda();

  const data = Buffer.concat([
    INITIALIZE_TREASURY_DISC,
    input.platformAuthority.toBuffer(),
  ]);

  return new TransactionInstruction({
    programId: AGENT_TREASURY_PROGRAM_ID,
    keys: [
      // Order MUST match the Rust InitializeTreasury struct:
      //   1. config            (readonly, has_one = admin)
      //   2. admin             (signer, readonly)
      //   3. treasury          (mut, init)
      //   4. owner_token_mint  (readonly UncheckedAccount)
      //   5. payer             (mut signer)
      //   6. system_program
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: input.admin, isSigner: true, isWritable: false },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: input.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// propose_platform_authority / accept_platform_authority (C3 rotation)
// ---------------------------------------------------------------------------

export interface BuildProposePlatformAuthorityIxInput {
  /** SPL Mint pubkey owning the treasury PDA. */
  mint: PublicKey;
  /** Current platform_authority — must sign (has_one). */
  platformAuthority: PublicKey;
  /** Proposed successor authority. */
  newAuthority: PublicKey;
}

export function buildProposePlatformAuthorityIx(
  input: BuildProposePlatformAuthorityIxInput,
): TransactionInstruction {
  const [treasury] = deriveTreasuryPda(input.mint);
  return new TransactionInstruction({
    programId: AGENT_TREASURY_PROGRAM_ID,
    keys: [
      // Order MUST match the Rust ProposePlatformAuthority struct:
      //   1. treasury            (mut, has_one = platform_authority)
      //   2. platform_authority  (signer)
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: input.platformAuthority, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([
      PROPOSE_PLATFORM_AUTHORITY_DISC,
      input.newAuthority.toBuffer(),
    ]),
  });
}

export interface BuildAcceptPlatformAuthorityIxInput {
  /** SPL Mint pubkey owning the treasury PDA. */
  mint: PublicKey;
  /** The pending authority — must sign and match treasury.pending_authority. */
  newAuthority: PublicKey;
}

export function buildAcceptPlatformAuthorityIx(
  input: BuildAcceptPlatformAuthorityIxInput,
): TransactionInstruction {
  const [treasury] = deriveTreasuryPda(input.mint);
  return new TransactionInstruction({
    programId: AGENT_TREASURY_PROGRAM_ID,
    keys: [
      // Order MUST match the Rust AcceptPlatformAuthority struct:
      //   1. treasury       (mut)
      //   2. new_authority  (signer)
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: input.newAuthority, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(ACCEPT_PLATFORM_AUTHORITY_DISC),
  });
}

// ---------------------------------------------------------------------------
// pay_nosana
// ---------------------------------------------------------------------------

export interface BuildPayNosanaIxInput {
  mint: PublicKey;
  platformAuthority: PublicKey;
  recipient: PublicKey;
  amountLamports: bigint;
}

const U64_MAX = BigInt("18446744073709551615"); // 2^64 - 1

function encodeU64Le(value: bigint): Buffer {
  if (value < BigInt(0)) {
    throw new Error("pay_nosana amount must be >= 0");
  }
  if (value > U64_MAX) {
    throw new Error("pay_nosana amount overflows u64");
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return buf;
}

// ---------------------------------------------------------------------------
// fee_receive
// ---------------------------------------------------------------------------

export interface BuildFeeReceiveIxInput {
  /** SPL mint that owns the treasury PDA. */
  mint: PublicKey;
  /** Depositor; signs the tx and pays out the SOL. Any signer is allowed. */
  from: PublicKey;
  amountLamports: bigint;
}

export function buildFeeReceiveIx(
  input: BuildFeeReceiveIxInput,
): TransactionInstruction {
  const [treasury] = deriveTreasuryPda(input.mint);
  const data = Buffer.concat([
    FEE_RECEIVE_DISC,
    encodeU64Le(input.amountLamports),
  ]);

  return new TransactionInstruction({
    programId: AGENT_TREASURY_PROGRAM_ID,
    keys: [
      // Order MUST match the Rust FeeReceive struct:
      //   1. treasury  (mut, PDA)
      //   2. from      (mut signer)
      //   3. system_program
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: input.from, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildPayNosanaIx(
  input: BuildPayNosanaIxInput,
): TransactionInstruction {
  const [treasury] = deriveTreasuryPda(input.mint);
  const data = Buffer.concat([
    PAY_NOSANA_DISC,
    encodeU64Le(input.amountLamports),
  ]);

  return new TransactionInstruction({
    programId: AGENT_TREASURY_PROGRAM_ID,
    keys: [
      // Order MUST match the Rust PayNosana struct.
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: input.platformAuthority, isSigner: true, isWritable: false },
      { pubkey: input.recipient, isSigner: false, isWritable: true },
    ],
    data,
  });
}
