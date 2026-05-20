/**
 * TS-side client for the reputation-oracle Anchor program.
 *
 * Same contract guarantees as agentTreasuryProgram.unit.test.ts —
 * discriminators, PDA derivation, instruction layouts. If any of these
 * assertions changes, the on-chain program rejects the tx, so these
 * tests are the wire-format pin between TS and Rust.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { PublicKey } from "@solana/web3.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ??
    "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

const PROGRAM_ID_BASE58 = "DMa1sNwXF6mZ2vyGiuA4QZhXPb5Sk4tp9gdnXsscrEB5";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

// Pinned discriminators — sha256("global:<name>")[..8].
const INITIALIZE_ORACLE_DISC = Buffer.from([
  144, 223, 131, 120, 196, 253, 181, 99,
]);
const ADD_ATTESTOR_DISC = Buffer.from([
  255, 223, 149, 157, 30, 86, 140, 155,
]);
const REMOVE_ATTESTOR_DISC = Buffer.from([
  108, 232, 239, 229, 84, 249, 29, 22,
]);
const TRANSFER_ADMIN_DISC = Buffer.from([
  42, 242, 66, 106, 228, 10, 111, 156,
]);
const INITIALIZE_AGENT_REPUTATION_DISC = Buffer.from([
  172, 124, 66, 185, 57, 229, 118, 26,
]);
const SUBMIT_ATTESTATION_DISC = Buffer.from([
  238, 220, 255, 105, 183, 211, 40, 83,
]);

// Convenience pubkeys used across tests.
const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const ADMIN = new PublicKey("9aE2qe8KzvLyxd5HPkdLVCDQyJ9LxhtzNPZkEmLbYEz4");
const ATTESTOR = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const PAYER = new PublicKey("11111111111111111111111111111112");
const NEW_ADMIN = new PublicKey(
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
);

// ---------------------------------------------------------------------------
// Program ID
// ---------------------------------------------------------------------------

test("REPUTATION_ORACLE_PROGRAM_ID matches Anchor.toml", async () => {
  setupEnv();
  const { REPUTATION_ORACLE_PROGRAM_ID } = await import(
    "../lib/programs/reputationOracle.js"
  );
  assert.equal(REPUTATION_ORACLE_PROGRAM_ID.toBase58(), PROGRAM_ID_BASE58);
});

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

test("deriveOracleConfigPda: derives from [b'oracle'] under program ID", async () => {
  setupEnv();
  const { deriveOracleConfigPda, REPUTATION_ORACLE_PROGRAM_ID } = await import(
    "../lib/programs/reputationOracle.js"
  );
  const [pda, bump] = deriveOracleConfigPda();
  const [expected, expectedBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("oracle")],
    REPUTATION_ORACLE_PROGRAM_ID,
  );
  assert.equal(pda.toBase58(), expected.toBase58());
  assert.equal(bump, expectedBump);
});

test("deriveAgentReputationPda: derives from [b'agent', mint] under program ID", async () => {
  setupEnv();
  const { deriveAgentReputationPda, REPUTATION_ORACLE_PROGRAM_ID } =
    await import("../lib/programs/reputationOracle.js");
  const [pda, bump] = deriveAgentReputationPda(MINT);
  const [expected, expectedBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), MINT.toBuffer()],
    REPUTATION_ORACLE_PROGRAM_ID,
  );
  assert.equal(pda.toBase58(), expected.toBase58());
  assert.equal(bump, expectedBump);
});

test("deriveAgentReputationPda: different mints → different PDAs", async () => {
  setupEnv();
  const { deriveAgentReputationPda } = await import(
    "../lib/programs/reputationOracle.js"
  );
  const m2 = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const [p1] = deriveAgentReputationPda(MINT);
  const [p2] = deriveAgentReputationPda(m2);
  assert.notEqual(p1.toBase58(), p2.toBase58());
});

// ---------------------------------------------------------------------------
// initialize_oracle
// ---------------------------------------------------------------------------

test("buildInitializeOracleIx: account metas in Rust struct order", async () => {
  setupEnv();
  const { buildInitializeOracleIx } = await import(
    "../lib/programs/reputationOracle.js"
  );
  const ix = buildInitializeOracleIx({ admin: ADMIN });
  // InitializeOracle: 1. config (mut, init), 2. admin (mut signer), 3. system_program
  assert.equal(ix.keys.length, 3);
  assert.equal(ix.keys[0]!.isSigner, false);
  assert.equal(ix.keys[0]!.isWritable, true);
  assert.equal(ix.keys[1]!.pubkey.toBase58(), ADMIN.toBase58());
  assert.equal(ix.keys[1]!.isSigner, true);
  assert.equal(ix.keys[1]!.isWritable, true);
  assert.equal(ix.keys[2]!.pubkey.toBase58(), SYSTEM_PROGRAM_ID);
});

test("buildInitializeOracleIx: data is disc only (no args)", async () => {
  setupEnv();
  const { buildInitializeOracleIx } = await import(
    "../lib/programs/reputationOracle.js"
  );
  const ix = buildInitializeOracleIx({ admin: ADMIN });
  assert.equal(ix.data.length, 8);
  assert.deepEqual(
    Array.from(ix.data),
    Array.from(INITIALIZE_ORACLE_DISC),
  );
});

// ---------------------------------------------------------------------------
// add_attestor / remove_attestor
// ---------------------------------------------------------------------------

test("buildAddAttestorIx: account metas + data shape", async () => {
  setupEnv();
  const { buildAddAttestorIx } = await import(
    "../lib/programs/reputationOracle.js"
  );
  const ix = buildAddAttestorIx({ admin: ADMIN, attestor: ATTESTOR });
  // ManageAttestors: 1. config (mut), 2. admin (signer, ro)
  assert.equal(ix.keys.length, 2);
  assert.equal(ix.keys[0]!.isWritable, true);
  assert.equal(ix.keys[0]!.isSigner, false);
  assert.equal(ix.keys[1]!.pubkey.toBase58(), ADMIN.toBase58());
  assert.equal(ix.keys[1]!.isSigner, true);
  assert.equal(ix.keys[1]!.isWritable, false);

  // disc(8) + attestor(32) = 40
  assert.equal(ix.data.length, 8 + 32);
  assert.deepEqual(
    Array.from(ix.data.subarray(0, 8)),
    Array.from(ADD_ATTESTOR_DISC),
  );
  assert.deepEqual(
    Array.from(ix.data.subarray(8)),
    Array.from(ATTESTOR.toBuffer()),
  );
});

test("buildRemoveAttestorIx: data uses remove_attestor disc", async () => {
  setupEnv();
  const { buildRemoveAttestorIx } = await import(
    "../lib/programs/reputationOracle.js"
  );
  const ix = buildRemoveAttestorIx({ admin: ADMIN, attestor: ATTESTOR });
  assert.equal(ix.data.length, 8 + 32);
  assert.deepEqual(
    Array.from(ix.data.subarray(0, 8)),
    Array.from(REMOVE_ATTESTOR_DISC),
  );
  assert.deepEqual(
    Array.from(ix.data.subarray(8)),
    Array.from(ATTESTOR.toBuffer()),
  );
});

// ---------------------------------------------------------------------------
// transfer_admin
// ---------------------------------------------------------------------------

test("buildTransferAdminIx: data is disc + new_admin pubkey", async () => {
  setupEnv();
  const { buildTransferAdminIx } = await import(
    "../lib/programs/reputationOracle.js"
  );
  const ix = buildTransferAdminIx({ admin: ADMIN, newAdmin: NEW_ADMIN });
  assert.equal(ix.keys.length, 2);
  assert.equal(ix.keys[1]!.pubkey.toBase58(), ADMIN.toBase58());
  assert.equal(ix.keys[1]!.isSigner, true);
  assert.equal(ix.data.length, 8 + 32);
  assert.deepEqual(
    Array.from(ix.data.subarray(0, 8)),
    Array.from(TRANSFER_ADMIN_DISC),
  );
  assert.deepEqual(
    Array.from(ix.data.subarray(8)),
    Array.from(NEW_ADMIN.toBuffer()),
  );
});

// ---------------------------------------------------------------------------
// initialize_agent_reputation
// ---------------------------------------------------------------------------

test("buildInitializeAgentReputationIx: account metas + data shape", async () => {
  setupEnv();
  const { buildInitializeAgentReputationIx } = await import(
    "../lib/programs/reputationOracle.js"
  );
  const ix = buildInitializeAgentReputationIx({ mint: MINT, payer: PAYER });
  // InitializeAgentReputation: 1. agent (mut init), 2. owner_token_mint, 3. payer (mut signer), 4. system_program
  assert.equal(ix.keys.length, 4);
  assert.equal(ix.keys[0]!.isWritable, true);
  assert.equal(ix.keys[0]!.isSigner, false);
  assert.equal(ix.keys[1]!.pubkey.toBase58(), MINT.toBase58());
  assert.equal(ix.keys[1]!.isSigner, false);
  assert.equal(ix.keys[1]!.isWritable, false);
  assert.equal(ix.keys[2]!.pubkey.toBase58(), PAYER.toBase58());
  assert.equal(ix.keys[2]!.isSigner, true);
  assert.equal(ix.keys[2]!.isWritable, true);
  assert.equal(ix.keys[3]!.pubkey.toBase58(), SYSTEM_PROGRAM_ID);

  assert.equal(ix.data.length, 8);
  assert.deepEqual(
    Array.from(ix.data),
    Array.from(INITIALIZE_AGENT_REPUTATION_DISC),
  );
});

// ---------------------------------------------------------------------------
// submit_attestation
// ---------------------------------------------------------------------------

test("buildSubmitAttestationIx: account metas in Rust struct order", async () => {
  setupEnv();
  const { buildSubmitAttestationIx } = await import(
    "../lib/programs/reputationOracle.js"
  );
  const ix = buildSubmitAttestationIx({
    mint: MINT,
    attestor: ATTESTOR,
    uptimeSecondsDelta: BigInt(3600),
    messageCountDelta: BigInt(12),
    score: 85,
    unixTs: BigInt(1_700_000_000),
  });
  // SubmitAttestation: 1. config (readonly), 2. agent (mut), 3. attestor (signer ro)
  assert.equal(ix.keys.length, 3);
  assert.equal(ix.keys[0]!.isSigner, false);
  assert.equal(ix.keys[0]!.isWritable, false);
  assert.equal(ix.keys[1]!.isSigner, false);
  assert.equal(ix.keys[1]!.isWritable, true);
  assert.equal(ix.keys[2]!.pubkey.toBase58(), ATTESTOR.toBase58());
  assert.equal(ix.keys[2]!.isSigner, true);
  assert.equal(ix.keys[2]!.isWritable, false);
});

test("buildSubmitAttestationIx: data layout is disc(8) + u64 + u64 + u32 + i64", async () => {
  setupEnv();
  const { buildSubmitAttestationIx } = await import(
    "../lib/programs/reputationOracle.js"
  );
  // Distinctive bit patterns so naive endianness flips would surface.
  const uptime = BigInt("0x0102030405060708");
  const messages = BigInt("0x1112131415161718");
  const score = 0x2122_2324; // u32 with high bits, > 100 — we'll use a smaller score test below.
  // Note: score must be in 0..=100 by program contract, but the TS-side
  // encoder permits up to U32_MAX (program rejects). We use score=100 here.
  const safeScore = 100;
  const unix = BigInt("0x4142434445464748");
  void score;

  const ix = buildSubmitAttestationIx({
    mint: MINT,
    attestor: ATTESTOR,
    uptimeSecondsDelta: uptime,
    messageCountDelta: messages,
    score: safeScore,
    unixTs: unix,
  });

  // 8 (disc) + 8 (u64) + 8 (u64) + 4 (u32) + 8 (i64) = 36
  assert.equal(ix.data.length, 8 + 8 + 8 + 4 + 8);

  assert.deepEqual(
    Array.from(ix.data.subarray(0, 8)),
    Array.from(SUBMIT_ATTESTATION_DISC),
  );
  // u64 LE for uptime
  assert.deepEqual(
    Array.from(ix.data.subarray(8, 16)),
    [0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01],
  );
  // u64 LE for messages
  assert.deepEqual(
    Array.from(ix.data.subarray(16, 24)),
    [0x18, 0x17, 0x16, 0x15, 0x14, 0x13, 0x12, 0x11],
  );
  // u32 LE for score (100 = 0x64)
  assert.deepEqual(
    Array.from(ix.data.subarray(24, 28)),
    [0x64, 0x00, 0x00, 0x00],
  );
  // i64 LE for unix_ts
  assert.deepEqual(
    Array.from(ix.data.subarray(28, 36)),
    [0x48, 0x47, 0x46, 0x45, 0x44, 0x43, 0x42, 0x41],
  );
});

test("buildSubmitAttestationIx: rejects score > 100", async () => {
  setupEnv();
  const { buildSubmitAttestationIx } = await import(
    "../lib/programs/reputationOracle.js"
  );
  assert.throws(
    () =>
      buildSubmitAttestationIx({
        mint: MINT,
        attestor: ATTESTOR,
        uptimeSecondsDelta: BigInt(1),
        messageCountDelta: BigInt(1),
        score: 101,
        unixTs: BigInt(1),
      }),
    /score.*0\.\.=100|0..=100/i,
  );
});

test("buildSubmitAttestationIx: rejects negative deltas", async () => {
  setupEnv();
  const { buildSubmitAttestationIx } = await import(
    "../lib/programs/reputationOracle.js"
  );
  assert.throws(
    () =>
      buildSubmitAttestationIx({
        mint: MINT,
        attestor: ATTESTOR,
        uptimeSecondsDelta: BigInt(-1),
        messageCountDelta: BigInt(0),
        score: 50,
        unixTs: BigInt(1),
      }),
    /uptime.*>= 0|negative/i,
  );
  assert.throws(
    () =>
      buildSubmitAttestationIx({
        mint: MINT,
        attestor: ATTESTOR,
        uptimeSecondsDelta: BigInt(0),
        messageCountDelta: BigInt(-1),
        score: 50,
        unixTs: BigInt(1),
      }),
    /message.*>= 0|negative/i,
  );
});

test("buildSubmitAttestationIx: rejects u64 overflow on deltas", async () => {
  setupEnv();
  const { buildSubmitAttestationIx } = await import(
    "../lib/programs/reputationOracle.js"
  );
  const overflow = BigInt(2) ** BigInt(64);
  assert.throws(
    () =>
      buildSubmitAttestationIx({
        mint: MINT,
        attestor: ATTESTOR,
        uptimeSecondsDelta: overflow,
        messageCountDelta: BigInt(0),
        score: 50,
        unixTs: BigInt(1),
      }),
    /overflow/i,
  );
});

test("buildSubmitAttestationIx: rejects i64 out-of-range unix_ts", async () => {
  setupEnv();
  const { buildSubmitAttestationIx } = await import(
    "../lib/programs/reputationOracle.js"
  );
  const overflow = BigInt("9223372036854775808"); // i64 max + 1
  assert.throws(
    () =>
      buildSubmitAttestationIx({
        mint: MINT,
        attestor: ATTESTOR,
        uptimeSecondsDelta: BigInt(0),
        messageCountDelta: BigInt(0),
        score: 50,
        unixTs: overflow,
      }),
    /out of i64 range/i,
  );
});

// ---------------------------------------------------------------------------
// All discriminators distinct (catches name typos)
// ---------------------------------------------------------------------------

test("all reputation-oracle discriminators are distinct", () => {
  const discs = [
    INITIALIZE_ORACLE_DISC,
    ADD_ATTESTOR_DISC,
    REMOVE_ATTESTOR_DISC,
    TRANSFER_ADMIN_DISC,
    INITIALIZE_AGENT_REPUTATION_DISC,
    SUBMIT_ATTESTATION_DISC,
  ].map((b) => b.toString("hex"));
  const set = new Set(discs);
  assert.equal(set.size, discs.length);
});
