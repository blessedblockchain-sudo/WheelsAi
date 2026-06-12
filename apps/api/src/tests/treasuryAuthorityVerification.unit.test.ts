/**
 * C2 pins: per-treasury authority derivation parity + the on-chain
 * platform_authority reader.
 *
 * 1. Derivation parity — the bootstrap script (scripts/
 *    bootstrap-treasury.ts) records the authority it derives via
 *    makeTreasurySignerProvider(masterKey)(treasuryId); the payment
 *    worker (queues/payment-submit.queue.ts) signs pay_nosana with the
 *    keypair from the same provider. Both must agree with the raw
 *    deriveTreasuryKeypair HKDF for the same (masterKey, treasuryId),
 *    or the worker can never move the funds the bootstrap pointed at
 *    its key.
 *
 * 2. readTreasuryPlatformAuthority — decodes platform_authority at
 *    offset 40 (8 disc + 32 owner_token_mint) of a Treasury account,
 *    returning null for missing accounts / wrong discriminators /
 *    short data. This is what the worker + bootstrap use to detect
 *    hijacked or misconfigured treasuries before signing anything.
 */

import assert from "node:assert/strict";
import test from "node:test";

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
const MASTER_KEY = "test-master-key-0123456789abcdef-0123456789abcdef";

// ----------------------------------------------------------------------
// Derivation parity (C2)
// ----------------------------------------------------------------------

test("C2 parity: makeTreasurySignerProvider derives the same keypair as deriveTreasuryKeypair for the same masterKey + treasuryId", async () => {
  setupEnv();
  const { deriveTreasuryKeypair, makeTreasurySignerProvider } = await import(
    "../services/treasuryKeypairs.js"
  );

  const provider = makeTreasurySignerProvider({ masterKey: MASTER_KEY });

  for (const treasuryId of ["treas_1", "treas_2", "cuid_clxyz12340000"]) {
    // Path A: what the bootstrap script records on-chain (it wires
    // makeTreasurySignerProvider with WALLET_MASTER_KEY).
    const bootstrapDerived = provider(treasuryId).publicKey;
    // Path B: the raw HKDF derivation underlying the worker's signer.
    const workerDerived = deriveTreasuryKeypair({
      masterKey: MASTER_KEY,
      treasuryId,
    }).publicKey;
    assert.equal(
      bootstrapDerived.toBase58(),
      workerDerived.toBase58(),
      `derivation diverged for treasuryId=${treasuryId}`,
    );
  }
});

test("C2 parity: different treasuryIds and masterKeys yield different authorities", async () => {
  setupEnv();
  const { makeTreasurySignerProvider } = await import(
    "../services/treasuryKeypairs.js"
  );
  const providerA = makeTreasurySignerProvider({ masterKey: MASTER_KEY });
  const providerB = makeTreasurySignerProvider({
    masterKey: "another-master-key-0123456789abcdef-0123456789",
  });

  assert.notEqual(
    providerA("treas_1").publicKey.toBase58(),
    providerA("treas_2").publicKey.toBase58(),
    "same key, different treasuryId must differ",
  );
  assert.notEqual(
    providerA("treas_1").publicKey.toBase58(),
    providerB("treas_1").publicKey.toBase58(),
    "different masterKey, same treasuryId must differ (rotation changes every authority)",
  );
});

// ----------------------------------------------------------------------
// readTreasuryPlatformAuthority
// ----------------------------------------------------------------------

/** Synthetic Treasury account data: pinned discriminator + mint(32) +
 * authority(32) + zero padding out to the on-chain SIZE (153). */
async function makeTreasuryData(authority: PublicKey): Promise<Buffer> {
  const { TREASURY_ACCOUNT_DISCRIMINATOR } = await import(
    "../services/isPdaAccountInitialized.js"
  );
  const mint = Keypair.generate().publicKey;
  const data = Buffer.alloc(153);
  TREASURY_ACCOUNT_DISCRIMINATOR.copy(data, 0);
  mint.toBuffer().copy(data, 8);
  authority.toBuffer().copy(data, 40);
  return data;
}

function connectionWith(data: Buffer | null) {
  return {
    getAccountInfo: async () =>
      data === null
        ? null
        : {
            data,
            lamports: 1_000_000,
            executable: false,
            owner: PublicKey.default,
            rentEpoch: 0,
          },
  } as any;
}

test("readTreasuryPlatformAuthority: decodes platform_authority at offset 40", async () => {
  setupEnv();
  const { readTreasuryPlatformAuthority } = await import(
    "../services/isPdaAccountInitialized.js"
  );
  const authority = Keypair.generate().publicKey;
  const data = await makeTreasuryData(authority);

  const result = await readTreasuryPlatformAuthority(
    connectionWith(data),
    PDA,
  );
  assert.ok(result, "expected a decoded authority");
  assert.equal(result!.toBase58(), authority.toBase58());
});

test("readTreasuryPlatformAuthority: missing account → null", async () => {
  setupEnv();
  const { readTreasuryPlatformAuthority } = await import(
    "../services/isPdaAccountInitialized.js"
  );
  const result = await readTreasuryPlatformAuthority(
    connectionWith(null),
    PDA,
  );
  assert.equal(result, null);
});

test("readTreasuryPlatformAuthority: wrong discriminator → null", async () => {
  setupEnv();
  const { readTreasuryPlatformAuthority } = await import(
    "../services/isPdaAccountInitialized.js"
  );
  const authority = Keypair.generate().publicKey;
  const data = await makeTreasuryData(authority);
  // Corrupt the discriminator — an incidental lamport bag / different
  // program's account at the PDA must NOT decode as a Treasury.
  data[0] = data[0]! ^ 0xff;

  const result = await readTreasuryPlatformAuthority(
    connectionWith(data),
    PDA,
  );
  assert.equal(result, null);
});

test("readTreasuryPlatformAuthority: data shorter than 72 bytes → null (defensive)", async () => {
  setupEnv();
  const { readTreasuryPlatformAuthority, TREASURY_ACCOUNT_DISCRIMINATOR } =
    await import("../services/isPdaAccountInitialized.js");
  // Right discriminator but truncated before the authority field ends.
  const data = Buffer.alloc(71);
  TREASURY_ACCOUNT_DISCRIMINATOR.copy(data, 0);

  const result = await readTreasuryPlatformAuthority(
    connectionWith(data),
    PDA,
  );
  assert.equal(result, null);
});

test("TREASURY_CONFIG_ACCOUNT_DISCRIMINATOR matches sha256('account:TreasuryConfig')[..8]", async () => {
  setupEnv();
  const { createHash } = await import("node:crypto");
  const { TREASURY_CONFIG_ACCOUNT_DISCRIMINATOR } = await import(
    "../services/isPdaAccountInitialized.js"
  );
  const expected = createHash("sha256")
    .update("account:TreasuryConfig")
    .digest()
    .subarray(0, 8);
  assert.deepEqual(
    Array.from(TREASURY_CONFIG_ACCOUNT_DISCRIMINATOR),
    Array.from(expected),
  );
});
