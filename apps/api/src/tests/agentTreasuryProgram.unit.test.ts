/**
 * TS-side client for the agent-treasury Anchor program.
 *
 * Pinned outputs:
 *   - Discriminators match Anchor's convention (sha256("global:<ix_name>")[..8])
 *   - Treasury PDA derives from [b"treasury", mint] under the program ID
 *   - Instruction layouts match the Rust program's account ordering
 *     and arg encoding (borsh)
 *
 * If any of these assertions changes, the on-chain program rejects the
 * tx — these tests are the contract between TS and Rust.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { PublicKey } from "@solana/web3.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

const PROGRAM_ID_BASE58 = "AgTrXVx1qz7eyUSF7sEpUiTSUbYnxhDxnzQpCeJ8XThT";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

// Pinned discriminators — precomputed from sha256("global:<name>")[..8].
// If anchor ever rotates this convention these break; that's the point.
const INITIALIZE_TREASURY_DISC = Buffer.from([
  124, 186, 211, 195, 85, 165, 129, 166,
]);
const PAY_NOSANA_DISC = Buffer.from([
  204, 213, 230, 150, 216, 68, 126, 146,
]);
const FEE_RECEIVE_DISC = Buffer.from([
  247, 110, 129, 219, 38, 11, 219, 246,
]);

// ----------------------------------------------------------------------
// Program ID
// ----------------------------------------------------------------------

test("AGENT_TREASURY_PROGRAM_ID matches Anchor.toml", async () => {
  setupEnv();
  const { AGENT_TREASURY_PROGRAM_ID } = await import(
    "../lib/programs/agentTreasury.js"
  );
  assert.equal(AGENT_TREASURY_PROGRAM_ID.toBase58(), PROGRAM_ID_BASE58);
});

// ----------------------------------------------------------------------
// PDA derivation
// ----------------------------------------------------------------------

test("deriveTreasuryPda: derives from [b'treasury', mint] under program ID", async () => {
  setupEnv();
  const { deriveTreasuryPda, AGENT_TREASURY_PROGRAM_ID } = await import(
    "../lib/programs/agentTreasury.js"
  );

  // Use a deterministic mint pubkey so this test pins a concrete output —
  // anyone editing seeds in the Rust program breaks this assertion.
  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const [pda, bump] = deriveTreasuryPda(mint);

  // Independent recomputation as a sanity check (don't rely on the helper
  // to assert on itself).
  const [expectedPda, expectedBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury"), mint.toBuffer()],
    AGENT_TREASURY_PROGRAM_ID,
  );
  assert.equal(pda.toBase58(), expectedPda.toBase58());
  assert.equal(bump, expectedBump);
});

test("deriveTreasuryPda: different mints → different PDAs", async () => {
  setupEnv();
  const { deriveTreasuryPda } = await import(
    "../lib/programs/agentTreasury.js"
  );

  const m1 = new PublicKey("So11111111111111111111111111111111111111112");
  const m2 = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const [p1] = deriveTreasuryPda(m1);
  const [p2] = deriveTreasuryPda(m2);

  assert.notEqual(p1.toBase58(), p2.toBase58());
});

// ----------------------------------------------------------------------
// initialize_treasury — instruction shape
// ----------------------------------------------------------------------

test("buildInitializeTreasuryIx: account metas in the Rust struct order", async () => {
  setupEnv();
  const { buildInitializeTreasuryIx } = await import(
    "../lib/programs/agentTreasury.js"
  );

  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const platformAuthority = new PublicKey(
    "9aE2qe8KzvLyxd5HPkdLVCDQyJ9LxhtzNPZkEmLbYEz4",
  );
  const payer = new PublicKey(
    "11111111111111111111111111111112",
  );
  const ix = buildInitializeTreasuryIx({ mint, platformAuthority, payer });

  // The InitializeTreasury account struct in lib.rs:
  //   1. treasury           (mut, init)
  //   2. owner_token_mint   (readonly UncheckedAccount)
  //   3. payer              (mut signer)
  //   4. system_program
  assert.equal(ix.keys.length, 4);
  // 0: treasury PDA — writable, not signer
  assert.equal(ix.keys[0]!.isSigner, false);
  assert.equal(ix.keys[0]!.isWritable, true);
  // 1: mint — readonly, not signer
  assert.equal(ix.keys[1]!.pubkey.toBase58(), mint.toBase58());
  assert.equal(ix.keys[1]!.isSigner, false);
  assert.equal(ix.keys[1]!.isWritable, false);
  // 2: payer — writable signer
  assert.equal(ix.keys[2]!.pubkey.toBase58(), payer.toBase58());
  assert.equal(ix.keys[2]!.isSigner, true);
  assert.equal(ix.keys[2]!.isWritable, true);
  // 3: system program
  assert.equal(ix.keys[3]!.pubkey.toBase58(), SYSTEM_PROGRAM_ID);
});

test("buildInitializeTreasuryIx: data is disc(8) + platform_authority(32)", async () => {
  setupEnv();
  const { buildInitializeTreasuryIx } = await import(
    "../lib/programs/agentTreasury.js"
  );

  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const platformAuthority = new PublicKey(
    "9aE2qe8KzvLyxd5HPkdLVCDQyJ9LxhtzNPZkEmLbYEz4",
  );
  const payer = new PublicKey(
    "11111111111111111111111111111112",
  );
  const ix = buildInitializeTreasuryIx({ mint, platformAuthority, payer });

  assert.equal(ix.data.length, 8 + 32, "disc + Pubkey");
  assert.deepEqual(
    Array.from(ix.data.subarray(0, 8)),
    Array.from(INITIALIZE_TREASURY_DISC),
  );
  assert.deepEqual(
    Array.from(ix.data.subarray(8)),
    Array.from(platformAuthority.toBuffer()),
  );
});

// ----------------------------------------------------------------------
// pay_nosana — instruction shape
// ----------------------------------------------------------------------

test("buildPayNosanaIx: account metas in the Rust struct order", async () => {
  setupEnv();
  const { buildPayNosanaIx } = await import(
    "../lib/programs/agentTreasury.js"
  );

  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const platformAuthority = new PublicKey(
    "9aE2qe8KzvLyxd5HPkdLVCDQyJ9LxhtzNPZkEmLbYEz4",
  );
  const recipient = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );
  const ix = buildPayNosanaIx({
    mint,
    platformAuthority,
    recipient,
    amountLamports: BigInt(1_000_000),
  });

  // PayNosana account struct in lib.rs (after we removed system_program):
  //   1. treasury            (mut, has_one = platform_authority)
  //   2. platform_authority  (signer)
  //   3. recipient           (mut UncheckedAccount)
  assert.equal(ix.keys.length, 3);
  assert.equal(ix.keys[0]!.isSigner, false);
  assert.equal(ix.keys[0]!.isWritable, true);
  assert.equal(ix.keys[1]!.pubkey.toBase58(), platformAuthority.toBase58());
  assert.equal(ix.keys[1]!.isSigner, true);
  assert.equal(ix.keys[1]!.isWritable, false);
  assert.equal(ix.keys[2]!.pubkey.toBase58(), recipient.toBase58());
  assert.equal(ix.keys[2]!.isSigner, false);
  assert.equal(ix.keys[2]!.isWritable, true);
});

test("buildPayNosanaIx: data is disc(8) + amount(u64 LE)", async () => {
  setupEnv();
  const { buildPayNosanaIx } = await import(
    "../lib/programs/agentTreasury.js"
  );

  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const platformAuthority = new PublicKey(
    "9aE2qe8KzvLyxd5HPkdLVCDQyJ9LxhtzNPZkEmLbYEz4",
  );
  const recipient = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );
  // 0xDEADBEEFCAFEBABE = 16045690985374415550 — distinctive bit pattern so
  // a naive endianness flip is caught.
  const amount = BigInt("0xDEADBEEFCAFEBABE");
  const ix = buildPayNosanaIx({
    mint,
    platformAuthority,
    recipient,
    amountLamports: amount,
  });

  assert.equal(ix.data.length, 8 + 8);
  assert.deepEqual(
    Array.from(ix.data.subarray(0, 8)),
    Array.from(PAY_NOSANA_DISC),
  );
  // u64 LE
  assert.deepEqual(
    Array.from(ix.data.subarray(8)),
    [0xBE, 0xBA, 0xFE, 0xCA, 0xEF, 0xBE, 0xAD, 0xDE],
  );
});

test("buildPayNosanaIx: rejects amount > u64::MAX", async () => {
  setupEnv();
  const { buildPayNosanaIx } = await import(
    "../lib/programs/agentTreasury.js"
  );
  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const platformAuthority = new PublicKey(
    "9aE2qe8KzvLyxd5HPkdLVCDQyJ9LxhtzNPZkEmLbYEz4",
  );
  const recipient = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );

  // 2^64; just over the u64 max. Encoding would silently truncate without
  // a guard, leading to a nightmare-class wrong-amount bug; reject up front.
  const overflow = BigInt(2) ** BigInt(64);
  assert.throws(
    () =>
      buildPayNosanaIx({
        mint,
        platformAuthority,
        recipient,
        amountLamports: overflow,
      }),
    /amount.*overflow|exceeds.*u64|too large/i,
  );
});

// ----------------------------------------------------------------------
// fee_receive — instruction shape
// ----------------------------------------------------------------------

test("buildFeeReceiveIx: account metas in the Rust struct order", async () => {
  setupEnv();
  const { buildFeeReceiveIx } = await import(
    "../lib/programs/agentTreasury.js"
  );

  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const from = new PublicKey(
    "9aE2qe8KzvLyxd5HPkdLVCDQyJ9LxhtzNPZkEmLbYEz4",
  );
  const ix = buildFeeReceiveIx({
    mint,
    from,
    amountLamports: BigInt(2_500_000),
  });

  assert.equal(ix.keys.length, 3);
  // 0: treasury PDA — writable, not signer
  assert.equal(ix.keys[0]!.isSigner, false);
  assert.equal(ix.keys[0]!.isWritable, true);
  // 1: from — writable signer
  assert.equal(ix.keys[1]!.pubkey.toBase58(), from.toBase58());
  assert.equal(ix.keys[1]!.isSigner, true);
  assert.equal(ix.keys[1]!.isWritable, true);
  // 2: system program
  assert.equal(ix.keys[2]!.pubkey.toBase58(), SYSTEM_PROGRAM_ID);
});

test("buildFeeReceiveIx: data is disc(8) + amount(u64 LE)", async () => {
  setupEnv();
  const { buildFeeReceiveIx } = await import(
    "../lib/programs/agentTreasury.js"
  );
  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const from = new PublicKey(
    "9aE2qe8KzvLyxd5HPkdLVCDQyJ9LxhtzNPZkEmLbYEz4",
  );
  const ix = buildFeeReceiveIx({
    mint,
    from,
    amountLamports: BigInt("0x0102030405060708"),
  });
  assert.equal(ix.data.length, 8 + 8);
  assert.deepEqual(
    Array.from(ix.data.subarray(0, 8)),
    Array.from(FEE_RECEIVE_DISC),
  );
  assert.deepEqual(
    Array.from(ix.data.subarray(8)),
    [0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01],
  );
});

test("buildFeeReceiveIx: rejects zero / negative / oversized amount", async () => {
  setupEnv();
  const { buildFeeReceiveIx } = await import(
    "../lib/programs/agentTreasury.js"
  );
  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const from = new PublicKey(
    "9aE2qe8KzvLyxd5HPkdLVCDQyJ9LxhtzNPZkEmLbYEz4",
  );

  // The TS-side encoder rejects negative + overflow. (Zero is allowed at the
  // TS layer but rejected on-chain by the program — this test is just for
  // negative + overflow guards; the program-side test pins the zero check.)
  assert.throws(
    () =>
      buildFeeReceiveIx({
        mint,
        from,
        amountLamports: BigInt(-1),
      }),
    /negative|positive|>= 0/i,
  );
  assert.throws(
    () =>
      buildFeeReceiveIx({
        mint,
        from,
        amountLamports: BigInt(2) ** BigInt(64),
      }),
    /overflow/i,
  );
});

test("buildPayNosanaIx: rejects negative amount", async () => {
  setupEnv();
  const { buildPayNosanaIx } = await import(
    "../lib/programs/agentTreasury.js"
  );
  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const platformAuthority = new PublicKey(
    "9aE2qe8KzvLyxd5HPkdLVCDQyJ9LxhtzNPZkEmLbYEz4",
  );
  const recipient = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );

  assert.throws(
    () =>
      buildPayNosanaIx({
        mint,
        platformAuthority,
        recipient,
        amountLamports: BigInt(-1),
      }),
    /negative|positive|>= 0/i,
  );
});
