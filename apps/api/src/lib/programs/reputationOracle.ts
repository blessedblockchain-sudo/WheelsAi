/**
 * Hand-rolled TypeScript client for the reputation-oracle Anchor program.
 *
 * Same wire-format conventions as agentTreasury.ts:
 *   bytes 0..8       sha256("global:<ix_name>")[..8]
 *   bytes 8..        borsh-encoded args, in declaration order
 *
 * Discriminators are pinned by unit tests
 * (`reputationOracleProgram.unit.test.ts`); regressions in Anchor's
 * discriminator scheme will fail loudly there before they ever hit a
 * tx.
 *
 * Args reference (from programs/reputation-oracle/src/lib.rs):
 *   initialize_oracle()                              → 8 bytes (disc only)
 *   add_attestor(attestor: Pubkey)                   → 8 + 32
 *   remove_attestor(attestor: Pubkey)                → 8 + 32
 *   transfer_admin(new_admin: Pubkey)                → 8 + 32
 *   initialize_agent_reputation()                    → 8 bytes (disc only)
 *   submit_attestation(uptime_seconds_delta: u64,
 *                      message_count_delta: u64,
 *                      score: u32,
 *                      unix_ts: i64)                 → 8 + 8 + 8 + 4 + 8
 *
 * Account-meta order MUST match the Rust `#[derive(Accounts)]` struct
 * field order exactly.
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

export const REPUTATION_ORACLE_PROGRAM_ID = new PublicKey(
  "DMa1sNwXF6mZ2vyGiuA4QZhXPb5Sk4tp9gdnXsscrEB5",
);

const ORACLE_CONFIG_SEED = Buffer.from("oracle");
const AGENT_REPUTATION_SEED = Buffer.from("agent");

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

export function deriveOracleConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ORACLE_CONFIG_SEED],
    REPUTATION_ORACLE_PROGRAM_ID,
  );
}

export function deriveAgentReputationPda(
  mint: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [AGENT_REPUTATION_SEED, mint.toBuffer()],
    REPUTATION_ORACLE_PROGRAM_ID,
  );
}

// ---------------------------------------------------------------------------
// Discriminator
// ---------------------------------------------------------------------------

function discriminator(ixName: string): Buffer {
  return createHash("sha256")
    .update(`global:${ixName}`)
    .digest()
    .subarray(0, 8);
}

const INITIALIZE_ORACLE_DISC = discriminator("initialize_oracle");
const ADD_ATTESTOR_DISC = discriminator("add_attestor");
const REMOVE_ATTESTOR_DISC = discriminator("remove_attestor");
const TRANSFER_ADMIN_DISC = discriminator("transfer_admin");
const INITIALIZE_AGENT_REPUTATION_DISC = discriminator(
  "initialize_agent_reputation",
);
const SUBMIT_ATTESTATION_DISC = discriminator("submit_attestation");

// ---------------------------------------------------------------------------
// Numeric encoding helpers
// ---------------------------------------------------------------------------

const U64_MAX = BigInt("18446744073709551615"); // 2^64 - 1
const I64_MIN = BigInt("-9223372036854775808");
const I64_MAX = BigInt("9223372036854775807");
const U32_MAX = 0xffffffff;

function encodeU64Le(value: bigint, fieldName: string): Buffer {
  if (value < BigInt(0)) {
    throw new Error(`${fieldName} must be >= 0`);
  }
  if (value > U64_MAX) {
    throw new Error(`${fieldName} overflows u64`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return buf;
}

function encodeI64Le(value: bigint, fieldName: string): Buffer {
  if (value < I64_MIN || value > I64_MAX) {
    throw new Error(`${fieldName} out of i64 range`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(value, 0);
  return buf;
}

function encodeU32Le(value: number, fieldName: string): Buffer {
  if (!Number.isInteger(value)) {
    throw new Error(`${fieldName} must be an integer`);
  }
  if (value < 0 || value > U32_MAX) {
    throw new Error(`${fieldName} out of u32 range`);
  }
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value, 0);
  return buf;
}

// ---------------------------------------------------------------------------
// initialize_oracle
// ---------------------------------------------------------------------------

export interface BuildInitializeOracleIxInput {
  /** Admin / payer; rent-pays the OracleConfig PDA and becomes admin. */
  admin: PublicKey;
}

export function buildInitializeOracleIx(
  input: BuildInitializeOracleIxInput,
): TransactionInstruction {
  const [config] = deriveOracleConfigPda();
  return new TransactionInstruction({
    programId: REPUTATION_ORACLE_PROGRAM_ID,
    keys: [
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: input.admin, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(INITIALIZE_ORACLE_DISC),
  });
}

// ---------------------------------------------------------------------------
// add_attestor / remove_attestor
// ---------------------------------------------------------------------------

export interface BuildManageAttestorIxInput {
  admin: PublicKey;
  attestor: PublicKey;
}

export function buildAddAttestorIx(
  input: BuildManageAttestorIxInput,
): TransactionInstruction {
  const [config] = deriveOracleConfigPda();
  return new TransactionInstruction({
    programId: REPUTATION_ORACLE_PROGRAM_ID,
    keys: [
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: input.admin, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([ADD_ATTESTOR_DISC, input.attestor.toBuffer()]),
  });
}

export function buildRemoveAttestorIx(
  input: BuildManageAttestorIxInput,
): TransactionInstruction {
  const [config] = deriveOracleConfigPda();
  return new TransactionInstruction({
    programId: REPUTATION_ORACLE_PROGRAM_ID,
    keys: [
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: input.admin, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([REMOVE_ATTESTOR_DISC, input.attestor.toBuffer()]),
  });
}

// ---------------------------------------------------------------------------
// transfer_admin
// ---------------------------------------------------------------------------

export interface BuildTransferAdminIxInput {
  admin: PublicKey;
  newAdmin: PublicKey;
}

export function buildTransferAdminIx(
  input: BuildTransferAdminIxInput,
): TransactionInstruction {
  const [config] = deriveOracleConfigPda();
  return new TransactionInstruction({
    programId: REPUTATION_ORACLE_PROGRAM_ID,
    keys: [
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: input.admin, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([TRANSFER_ADMIN_DISC, input.newAdmin.toBuffer()]),
  });
}

// ---------------------------------------------------------------------------
// initialize_agent_reputation
// ---------------------------------------------------------------------------

export interface BuildInitializeAgentReputationIxInput {
  /** SPL Mint pubkey identifying the agent. */
  mint: PublicKey;
  /** Rent payer. */
  payer: PublicKey;
}

export function buildInitializeAgentReputationIx(
  input: BuildInitializeAgentReputationIxInput,
): TransactionInstruction {
  const [agent] = deriveAgentReputationPda(input.mint);
  return new TransactionInstruction({
    programId: REPUTATION_ORACLE_PROGRAM_ID,
    keys: [
      { pubkey: agent, isSigner: false, isWritable: true },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: input.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(INITIALIZE_AGENT_REPUTATION_DISC),
  });
}

// ---------------------------------------------------------------------------
// submit_attestation
// ---------------------------------------------------------------------------

export interface BuildSubmitAttestationIxInput {
  /** SPL Mint pubkey identifying the agent. */
  mint: PublicKey;
  /** Whitelisted attestor key (signs). */
  attestor: PublicKey;
  /** Delta of uptime seconds since the attestor's last observation. */
  uptimeSecondsDelta: bigint;
  /** Delta of message count since the attestor's last observation. */
  messageCountDelta: bigint;
  /** Snapshot score, 0..=100. */
  score: number;
  /** Attestor-claimed unix timestamp (must be ≥ last recorded). */
  unixTs: bigint;
}

export function buildSubmitAttestationIx(
  input: BuildSubmitAttestationIxInput,
): TransactionInstruction {
  if (input.score < 0 || input.score > 100) {
    throw new Error("submit_attestation score must be in 0..=100");
  }
  const [config] = deriveOracleConfigPda();
  const [agent] = deriveAgentReputationPda(input.mint);

  const data = Buffer.concat([
    SUBMIT_ATTESTATION_DISC,
    encodeU64Le(input.uptimeSecondsDelta, "uptime_seconds_delta"),
    encodeU64Le(input.messageCountDelta, "message_count_delta"),
    encodeU32Le(input.score, "score"),
    encodeI64Le(input.unixTs, "unix_ts"),
  ]);

  return new TransactionInstruction({
    programId: REPUTATION_ORACLE_PROGRAM_ID,
    keys: [
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: agent, isSigner: false, isWritable: true },
      { pubkey: input.attestor, isSigner: true, isWritable: false },
    ],
    data,
  });
}
