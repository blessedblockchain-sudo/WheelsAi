/**
 * Drives apps/api/src/services/readAgentReputationFromChain.ts.
 *
 * Pinning:
 *   - The account discriminator matches sha256("account:AgentReputation")[..8]
 *   - Layout is disc(8) + ownerTokenMint(32) + cumulativeUptime(u64 LE) +
 *     cumulativeMessageCount(u64 LE) + lastScore(u32 LE) +
 *     lastAttestationUnixTs(i64 LE) + attestationCount(u32 LE) + bump(u8)
 *   - Missing account → null (PDA not yet initialized)
 *   - Wrong discriminator → null (not our account, never panic)
 *   - Truncated data → null (defensive against partial reads)
 *
 * If the on-chain Rust account layout drifts, these tests fail before
 * the eligibility gate ever consults a malformed account.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

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

const MINT = new PublicKey("So11111111111111111111111111111111111111112");

function discriminator() {
  return createHash("sha256")
    .update("account:AgentReputation")
    .digest()
    .subarray(0, 8);
}

function encodeAccount(opts: {
  mint?: PublicKey;
  uptime?: bigint;
  msgCount?: bigint;
  lastScore?: number;
  lastTs?: bigint;
  attestationCount?: number;
  bump?: number;
  withPadding?: boolean;
}) {
  const mint = opts.mint ?? MINT;
  const buf = Buffer.alloc(opts.withPadding === false ? 73 : 137); // include padding by default
  let off = 0;
  discriminator().copy(buf, off);
  off += 8;
  mint.toBuffer().copy(buf, off);
  off += 32;
  buf.writeBigUInt64LE(opts.uptime ?? BigInt(0), off);
  off += 8;
  buf.writeBigUInt64LE(opts.msgCount ?? BigInt(0), off);
  off += 8;
  buf.writeUInt32LE(opts.lastScore ?? 0, off);
  off += 4;
  buf.writeBigInt64LE(opts.lastTs ?? BigInt(0), off);
  off += 8;
  buf.writeUInt32LE(opts.attestationCount ?? 0, off);
  off += 4;
  buf.writeUInt8(opts.bump ?? 255, off);
  return buf;
}

test("readAgentReputationFromChain: returns null when account doesn't exist", async () => {
  setupEnv();
  const { readAgentReputationFromChain } = await import(
    "../services/readAgentReputationFromChain.js"
  );
  const r = await readAgentReputationFromChain(
    { mint: MINT },
    { connection: { getAccountInfo: async () => null } as any },
  );
  assert.equal(r, null);
});

test("readAgentReputationFromChain: decodes full layout (with padding)", async () => {
  setupEnv();
  const { readAgentReputationFromChain } = await import(
    "../services/readAgentReputationFromChain.js"
  );
  const data = encodeAccount({
    uptime: BigInt(72_000),
    msgCount: BigInt(123),
    lastScore: 87,
    lastTs: BigInt(1_700_000_000),
    attestationCount: 5,
    bump: 251,
  });
  const r = await readAgentReputationFromChain(
    { mint: MINT },
    {
      connection: {
        getAccountInfo: async () => ({ data, lamports: 0, executable: false, owner: MINT, rentEpoch: 0 }),
      } as any,
    },
  );
  assert.ok(r);
  assert.equal(r!.ownerTokenMint, MINT.toBase58());
  assert.equal(r!.cumulativeUptimeSeconds, BigInt(72_000));
  assert.equal(r!.cumulativeMessageCount, BigInt(123));
  assert.equal(r!.lastScore, 87);
  assert.equal(r!.lastAttestationUnixTs, BigInt(1_700_000_000));
  assert.equal(r!.attestationCount, 5);
  assert.equal(r!.bump, 251);
});

test("readAgentReputationFromChain: decodes without padding (minimum 73 bytes)", async () => {
  setupEnv();
  const { readAgentReputationFromChain } = await import(
    "../services/readAgentReputationFromChain.js"
  );
  const data = encodeAccount({
    uptime: BigInt(60),
    msgCount: BigInt(1),
    lastScore: 100,
    lastTs: BigInt(42),
    attestationCount: 1,
    bump: 200,
    withPadding: false,
  });
  assert.equal(data.length, 73);
  const r = await readAgentReputationFromChain(
    { mint: MINT },
    {
      connection: {
        getAccountInfo: async () => ({ data, lamports: 0, executable: false, owner: MINT, rentEpoch: 0 }),
      } as any,
    },
  );
  assert.ok(r);
  assert.equal(r!.lastScore, 100);
  assert.equal(r!.cumulativeUptimeSeconds, BigInt(60));
});

test("readAgentReputationFromChain: wrong discriminator → null (defensive)", async () => {
  setupEnv();
  const { readAgentReputationFromChain } = await import(
    "../services/readAgentReputationFromChain.js"
  );
  const data = encodeAccount({});
  // Scramble disc.
  data[0] = 0;
  const r = await readAgentReputationFromChain(
    { mint: MINT },
    {
      connection: {
        getAccountInfo: async () => ({ data, lamports: 0, executable: false, owner: MINT, rentEpoch: 0 }),
      } as any,
    },
  );
  assert.equal(r, null);
});

test("readAgentReputationFromChain: truncated account → null (no panic)", async () => {
  setupEnv();
  const { readAgentReputationFromChain } = await import(
    "../services/readAgentReputationFromChain.js"
  );
  const data = Buffer.alloc(20); // way too short
  discriminator().copy(data, 0);
  const r = await readAgentReputationFromChain(
    { mint: MINT },
    {
      connection: {
        getAccountInfo: async () => ({ data, lamports: 0, executable: false, owner: MINT, rentEpoch: 0 }),
      } as any,
    },
  );
  assert.equal(r, null);
});

test("readAgentReputationFromChain: fetches the PDA derived from the mint", async () => {
  setupEnv();
  const { readAgentReputationFromChain } = await import(
    "../services/readAgentReputationFromChain.js"
  );
  const { deriveAgentReputationPda } = await import(
    "../lib/programs/reputationOracle.js"
  );
  const [expectedPda] = deriveAgentReputationPda(MINT);
  let observed: PublicKey | null = null;
  await readAgentReputationFromChain(
    { mint: MINT },
    {
      connection: {
        getAccountInfo: async (k: PublicKey) => {
          observed = k;
          return null;
        },
      } as any,
    },
  );
  assert.equal(
    (observed as PublicKey | null)?.toBase58() ?? "",
    expectedPda.toBase58(),
  );
});
