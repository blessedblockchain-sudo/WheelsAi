import assert from "node:assert/strict";
import test from "node:test";
import {
  Keypair,
  TransactionMessage,
  VersionedTransaction,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/pumpfunTxBuilder.ts — two pure functions
// that wrap pumpportal.fun's /api/trade-local protocol so the orchestrator
// can stay simple:
//
//   buildPumpfunCreateRequest({creatorPubkey, mintPubkey, name, symbol, uri, ...})
//     → JSON body to POST to /api/trade-local
//
//   deserializePumpfunUnsignedTx(bytes)
//     → VersionedTransaction (unsigned)
//
// Both are pure: no fetch, no signing, no Connection. Tests cover validation
// and round-trip safety so the side-effect layer (network + signing) is a
// thin shell.

// ============================================
// buildPumpfunCreateRequest
// ============================================

test("buildPumpfunCreateRequest produces the trade-local body shape pumpportal expects", async () => {
  setupEnv();
  const { buildPumpfunCreateRequest } = await import(
    "../services/pumpfunTxBuilder.js"
  );
  const creator = Keypair.generate();
  const mint = Keypair.generate();

  const body = buildPumpfunCreateRequest({
    creatorPubkey: creator.publicKey.toBase58(),
    mintPubkey: mint.publicKey.toBase58(),
    name: "Test Coin",
    symbol: "TEST",
    uri: "ipfs://Qm...",
  });

  assert.equal(body.action, "create");
  assert.equal(body.publicKey, creator.publicKey.toBase58());
  assert.equal(body.mint, mint.publicKey.toBase58());
  assert.deepEqual(body.tokenMetadata, {
    name: "Test Coin",
    symbol: "TEST",
    uri: "ipfs://Qm...",
  });
  // Defaults that pumpportal requires.
  assert.equal(body.denominatedInSol, "true");
  assert.equal(body.amount, 0);
  assert.equal(body.pool, "pump");
  assert.ok(typeof body.slippage === "number");
  assert.ok(typeof body.priorityFee === "number");
});

test("buildPumpfunCreateRequest forwards optional social fields when present", async () => {
  const { buildPumpfunCreateRequest } = await import(
    "../services/pumpfunTxBuilder.js"
  );
  const creator = Keypair.generate();
  const mint = Keypair.generate();

  const body = buildPumpfunCreateRequest({
    creatorPubkey: creator.publicKey.toBase58(),
    mintPubkey: mint.publicKey.toBase58(),
    name: "x",
    symbol: "X",
    uri: "ipfs://Qm",
    twitter: "https://x.com/test",
    telegram: "https://t.me/test",
    website: "https://test.dev",
  });
  assert.equal(body.tokenMetadata.twitter, "https://x.com/test");
  assert.equal(body.tokenMetadata.telegram, "https://t.me/test");
  assert.equal(body.tokenMetadata.website, "https://test.dev");
});

test("buildPumpfunCreateRequest omits optional social fields when not provided", async () => {
  const { buildPumpfunCreateRequest } = await import(
    "../services/pumpfunTxBuilder.js"
  );
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const body = buildPumpfunCreateRequest({
    creatorPubkey: creator.publicKey.toBase58(),
    mintPubkey: mint.publicKey.toBase58(),
    name: "x",
    symbol: "X",
    uri: "ipfs://Qm",
  });
  assert.ok(!("twitter" in body.tokenMetadata));
  assert.ok(!("telegram" in body.tokenMetadata));
  assert.ok(!("website" in body.tokenMetadata));
});

test("buildPumpfunCreateRequest accepts a creator's initial buy amount", async () => {
  const { buildPumpfunCreateRequest } = await import(
    "../services/pumpfunTxBuilder.js"
  );
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const body = buildPumpfunCreateRequest({
    creatorPubkey: creator.publicKey.toBase58(),
    mintPubkey: mint.publicKey.toBase58(),
    name: "x",
    symbol: "X",
    uri: "ipfs://Qm",
    initialBuySol: 0.5,
  });
  assert.equal(body.amount, 0.5);
});

// ============================================
// Validation
// ============================================

test("buildPumpfunCreateRequest rejects empty name", async () => {
  const { buildPumpfunCreateRequest } = await import(
    "../services/pumpfunTxBuilder.js"
  );
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  assert.throws(
    () =>
      buildPumpfunCreateRequest({
        creatorPubkey: creator.publicKey.toBase58(),
        mintPubkey: mint.publicKey.toBase58(),
        name: "",
        symbol: "X",
        uri: "ipfs://Qm",
      }),
    /name/i,
  );
});

test("buildPumpfunCreateRequest rejects symbol shorter than 1 or longer than 10 chars", async () => {
  const { buildPumpfunCreateRequest } = await import(
    "../services/pumpfunTxBuilder.js"
  );
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  for (const symbol of ["", "ABCDEFGHIJK"]) {
    assert.throws(
      () =>
        buildPumpfunCreateRequest({
          creatorPubkey: creator.publicKey.toBase58(),
          mintPubkey: mint.publicKey.toBase58(),
          name: "x",
          symbol,
          uri: "ipfs://Qm",
        }),
      /symbol/i,
      `should reject symbol='${symbol}'`,
    );
  }
});

test("buildPumpfunCreateRequest requires a non-empty uri (IPFS metadata is mandatory upstream)", async () => {
  const { buildPumpfunCreateRequest } = await import(
    "../services/pumpfunTxBuilder.js"
  );
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  assert.throws(
    () =>
      buildPumpfunCreateRequest({
        creatorPubkey: creator.publicKey.toBase58(),
        mintPubkey: mint.publicKey.toBase58(),
        name: "x",
        symbol: "X",
        uri: "",
      }),
    /uri/i,
  );
});

test("buildPumpfunCreateRequest rejects malformed pubkeys", async () => {
  const { buildPumpfunCreateRequest } = await import(
    "../services/pumpfunTxBuilder.js"
  );
  const creator = Keypair.generate();
  assert.throws(
    () =>
      buildPumpfunCreateRequest({
        creatorPubkey: "not-a-pubkey",
        mintPubkey: creator.publicKey.toBase58(),
        name: "x",
        symbol: "X",
        uri: "ipfs://Qm",
      }),
    /pubkey/i,
  );
});

test("buildPumpfunCreateRequest rejects negative initialBuy", async () => {
  const { buildPumpfunCreateRequest } = await import(
    "../services/pumpfunTxBuilder.js"
  );
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  assert.throws(
    () =>
      buildPumpfunCreateRequest({
        creatorPubkey: creator.publicKey.toBase58(),
        mintPubkey: mint.publicKey.toBase58(),
        name: "x",
        symbol: "X",
        uri: "ipfs://Qm",
        initialBuySol: -0.1,
      }),
    /initialBuy/i,
  );
});

// ============================================
// deserializePumpfunUnsignedTx
// ============================================

test("deserializePumpfunUnsignedTx round-trips a valid VersionedTransaction byte buffer", async () => {
  setupEnv();
  const { deserializePumpfunUnsignedTx } = await import(
    "../services/pumpfunTxBuilder.js"
  );
  // Build a concrete unsigned tx so we have a real byte buffer to feed in.
  const payer = Keypair.generate();
  const dest = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: dest.publicKey,
        lamports: 1000,
      }),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const bytes = tx.serialize();

  const result = deserializePumpfunUnsignedTx(bytes);
  assert.ok(result instanceof VersionedTransaction);
  // No signatures yet (round-trip preserved the unsigned state).
  assert.equal(result.signatures.every((s) => s.every((b) => b === 0)), true);
  // Same payer key survived the round-trip.
  const decompiled = TransactionMessage.decompile(result.message);
  assert.equal(decompiled.payerKey.toBase58(), payer.publicKey.toBase58());
});

test("deserializePumpfunUnsignedTx throws on garbage bytes", async () => {
  const { deserializePumpfunUnsignedTx } = await import(
    "../services/pumpfunTxBuilder.js"
  );
  assert.throws(
    () => deserializePumpfunUnsignedTx(new Uint8Array([0xff, 0xff, 0xff])),
    /pumpfun.*deserialize/i,
  );
});

test("deserializePumpfunUnsignedTx throws on empty input", async () => {
  const { deserializePumpfunUnsignedTx } = await import(
    "../services/pumpfunTxBuilder.js"
  );
  assert.throws(
    () => deserializePumpfunUnsignedTx(new Uint8Array(0)),
    /empty|deserialize/i,
  );
});

// ============================================
// extractMintFromTx — convenience for the orchestrator after signing
// ============================================

test("extractMintFromCreateRequest returns the mint pubkey we put in (round-trip)", async () => {
  const { buildPumpfunCreateRequest, extractMintFromCreateRequest } = await import(
    "../services/pumpfunTxBuilder.js"
  );
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const body = buildPumpfunCreateRequest({
    creatorPubkey: creator.publicKey.toBase58(),
    mintPubkey: mint.publicKey.toBase58(),
    name: "x",
    symbol: "X",
    uri: "ipfs://Qm",
  });
  const extracted = extractMintFromCreateRequest(body);
  assert.equal(extracted, mint.publicKey.toBase58());
  // PublicKey survives validation
  new PublicKey(extracted);
});
