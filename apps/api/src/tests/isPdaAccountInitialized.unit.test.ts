/**
 * Drives apps/api/src/services/isPdaAccountInitialized.ts.
 *
 * Pinned guarantees:
 *   - getAccountInfo returns null → not initialized
 *   - account exists but data shorter than 8 bytes → not initialized (defensive)
 *   - discriminator mismatch → not initialized (incidental lamport bag at
 *     this PDA does NOT count as "our account exists")
 *   - discriminator match → initialized
 *   - The exported discriminator constants match sha256("account:<Name>")[..8]
 *     so a Rust rename of the account struct breaks this test before
 *     a bootstrap script can silently skip a real init.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import { Keypair, PublicKey } from "@solana/web3.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ??
    "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

const PDA = Keypair.generate().publicKey;

function disc(name: string): Buffer {
  return createHash("sha256")
    .update(`account:${name}`)
    .digest()
    .subarray(0, 8);
}

test("isPdaAccountInitialized: getAccountInfo returns null → false", async () => {
  setupEnv();
  const { isPdaAccountInitialized, TREASURY_ACCOUNT_DISCRIMINATOR } =
    await import("../services/isPdaAccountInitialized.js");
  const r = await isPdaAccountInitialized(
    { pda: PDA, expectedDiscriminator: TREASURY_ACCOUNT_DISCRIMINATOR },
    { connection: { getAccountInfo: async () => null } as any },
  );
  assert.equal(r, false);
});

test("isPdaAccountInitialized: account exists with matching discriminator → true", async () => {
  setupEnv();
  const { isPdaAccountInitialized, TREASURY_ACCOUNT_DISCRIMINATOR } =
    await import("../services/isPdaAccountInitialized.js");
  const data = Buffer.alloc(100);
  TREASURY_ACCOUNT_DISCRIMINATOR.copy(data, 0);
  const r = await isPdaAccountInitialized(
    { pda: PDA, expectedDiscriminator: TREASURY_ACCOUNT_DISCRIMINATOR },
    {
      connection: {
        getAccountInfo: async () => ({
          data,
          lamports: 1_000_000,
          executable: false,
          owner: PublicKey.default,
          rentEpoch: 0,
        }),
      } as any,
    },
  );
  assert.equal(r, true);
});

test("isPdaAccountInitialized: account exists with wrong discriminator → false", async () => {
  setupEnv();
  const { isPdaAccountInitialized, TREASURY_ACCOUNT_DISCRIMINATOR } =
    await import("../services/isPdaAccountInitialized.js");
  const data = Buffer.alloc(100); // all zeros — won't match disc
  const r = await isPdaAccountInitialized(
    { pda: PDA, expectedDiscriminator: TREASURY_ACCOUNT_DISCRIMINATOR },
    {
      connection: {
        getAccountInfo: async () => ({
          data,
          lamports: 1_000_000,
          executable: false,
          owner: PublicKey.default,
          rentEpoch: 0,
        }),
      } as any,
    },
  );
  assert.equal(r, false);
});

test("isPdaAccountInitialized: data shorter than 8 bytes → false (defensive)", async () => {
  setupEnv();
  const { isPdaAccountInitialized, TREASURY_ACCOUNT_DISCRIMINATOR } =
    await import("../services/isPdaAccountInitialized.js");
  const r = await isPdaAccountInitialized(
    { pda: PDA, expectedDiscriminator: TREASURY_ACCOUNT_DISCRIMINATOR },
    {
      connection: {
        getAccountInfo: async () => ({
          data: Buffer.alloc(4),
          lamports: 1_000_000,
          executable: false,
          owner: PublicKey.default,
          rentEpoch: 0,
        }),
      } as any,
    },
  );
  assert.equal(r, false);
});

test("Treasury / AgentReputation / OracleConfig discriminator constants match sha256('account:<Name>')[..8]", async () => {
  setupEnv();
  const {
    TREASURY_ACCOUNT_DISCRIMINATOR,
    AGENT_REPUTATION_ACCOUNT_DISCRIMINATOR,
    ORACLE_CONFIG_ACCOUNT_DISCRIMINATOR,
  } = await import("../services/isPdaAccountInitialized.js");
  assert.deepEqual(
    Array.from(TREASURY_ACCOUNT_DISCRIMINATOR),
    Array.from(disc("Treasury")),
  );
  assert.deepEqual(
    Array.from(AGENT_REPUTATION_ACCOUNT_DISCRIMINATOR),
    Array.from(disc("AgentReputation")),
  );
  assert.deepEqual(
    Array.from(ORACLE_CONFIG_ACCOUNT_DISCRIMINATOR),
    Array.from(disc("OracleConfig")),
  );
});
