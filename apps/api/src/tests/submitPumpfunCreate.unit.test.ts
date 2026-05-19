import assert from "node:assert/strict";
import test from "node:test";
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/submitPumpfunCreate.ts — the side-effect
// orchestrator that finishes A1: composes the pumpportal HTTP call, the
// existing deserializer, signing, and RPC submission. With this in place
// the launch route's `submitPumpfunCreate` dep is wired end-to-end.
//
// IO injected: fetchFn (HTTP), sendRawTransaction (Solana RPC).

const VALID_BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";

// Build a concrete unsigned VersionedTransaction so the fake pumpportal
// endpoint has real bytes to return. Real pump.fun create-tx requires both
// the creator (fee payer) AND the mint (new account) to sign — we mirror
// that by using SystemProgram.createAccount, which structurally requires
// both signers, so tx.sign([creator, mint]) actually exercises both
// signature slots.
function buildUnsignedTxBytes(creator: Keypair, mint: Keypair): Uint8Array {
  const message = new TransactionMessage({
    payerKey: creator.publicKey,
    recentBlockhash: VALID_BLOCKHASH,
    instructions: [
      SystemProgram.createAccount({
        fromPubkey: creator.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: 1_500_000,
        space: 82,
        programId: SystemProgram.programId,
      }),
    ],
  }).compileToV0Message();
  return new VersionedTransaction(message).serialize();
}

function fakePumpportalOk(bytes: Uint8Array) {
  const calls: Array<{ url: string; init: any }> = [];
  const fetchFn: typeof fetch = async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async arrayBuffer() {
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        );
      },
      async text() {
        return "binary";
      },
    } as any;
  };
  return { calls, fetchFn };
}

function happyDeps(creator: Keypair, mint: Keypair) {
  const bytes = buildUnsignedTxBytes(creator, mint);
  const fakePumpportal = fakePumpportalOk(bytes);
  const rpcCalls: Uint8Array[] = [];
  const sendRawTransaction = async (raw: Uint8Array) => {
    rpcCalls.push(raw);
    return "rpc_signature_xyz";
  };
  return {
    bytes,
    fetchFn: fakePumpportal.fetchFn,
    fetchCalls: fakePumpportal.calls,
    sendRawTransaction,
    rpcCalls,
  };
}

function buildHappyBody(creator: Keypair, mint: Keypair) {
  return {
    action: "create" as const,
    publicKey: creator.publicKey.toBase58(),
    mint: mint.publicKey.toBase58(),
    tokenMetadata: {
      name: "Eliza",
      symbol: "ELIZA",
      uri: "ipfs://Qm...",
    },
    denominatedInSol: "true" as const,
    amount: 0,
    slippage: 10,
    priorityFee: 0.00005,
    pool: "pump" as const,
  };
}

// ============================================
// Happy path
// ============================================

test("submitPumpfunCreate POSTs to pumpportal /api/trade-local with the body as JSON", async () => {
  setupEnv();
  const { submitPumpfunCreate } = await import(
    "../services/submitPumpfunCreate.js"
  );
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const body = buildHappyBody(creator, mint);
  const { fetchFn, fetchCalls, sendRawTransaction } = happyDeps(creator, mint);

  await submitPumpfunCreate(
    { body, creatorKeypair: creator, mintKeypair: mint },
    { fetchFn, sendRawTransaction },
  );

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0]!.url, "https://pumpportal.fun/api/trade-local");
  assert.equal(fetchCalls[0]!.init.method, "POST");
  assert.equal(fetchCalls[0]!.init.headers["Content-Type"], "application/json");
  const sent = JSON.parse(fetchCalls[0]!.init.body);
  assert.equal(sent.action, "create");
  assert.equal(sent.mint, mint.publicKey.toBase58());
});

test("submitPumpfunCreate signs the unsigned tx with both creator and mint keypairs", async () => {
  const { submitPumpfunCreate } = await import(
    "../services/submitPumpfunCreate.js"
  );
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const body = buildHappyBody(creator, mint);
  const { fetchFn, sendRawTransaction, rpcCalls } = happyDeps(creator, mint);

  await submitPumpfunCreate(
    { body, creatorKeypair: creator, mintKeypair: mint },
    { fetchFn, sendRawTransaction },
  );

  assert.equal(rpcCalls.length, 1);
  // The submitted bytes should deserialize to a VersionedTransaction whose
  // signatures are populated (non-zero) for the signers.
  const submitted = VersionedTransaction.deserialize(rpcCalls[0]!);
  assert.ok(
    submitted.signatures[0]!.some((b) => b !== 0),
    "primary signer signature should be non-zero after sign()",
  );
});

test("submitPumpfunCreate returns the mint address from the body and the rpc signature", async () => {
  const { submitPumpfunCreate } = await import(
    "../services/submitPumpfunCreate.js"
  );
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const body = buildHappyBody(creator, mint);
  const { fetchFn, sendRawTransaction } = happyDeps(creator, mint);

  const result = await submitPumpfunCreate(
    { body, creatorKeypair: creator, mintKeypair: mint },
    { fetchFn, sendRawTransaction },
  );
  assert.equal(result.mintAddress, mint.publicKey.toBase58());
  assert.equal(result.txSignature, "rpc_signature_xyz");
});

// ============================================
// Validation (caller bug catchers)
// ============================================

test("submitPumpfunCreate throws when mintKeypair pubkey doesn't match body.mint", async () => {
  const { submitPumpfunCreate } = await import(
    "../services/submitPumpfunCreate.js"
  );
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const wrongMint = Keypair.generate();
  const body = buildHappyBody(creator, mint);
  const { fetchFn, sendRawTransaction } = happyDeps(creator, mint);

  await assert.rejects(
    () =>
      submitPumpfunCreate(
        { body, creatorKeypair: creator, mintKeypair: wrongMint },
        { fetchFn, sendRawTransaction },
      ),
    /mint.*mismatch|keypair/i,
  );
});

test("submitPumpfunCreate throws when creatorKeypair pubkey doesn't match body.publicKey", async () => {
  const { submitPumpfunCreate } = await import(
    "../services/submitPumpfunCreate.js"
  );
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const wrongCreator = Keypair.generate();
  const body = buildHappyBody(creator, mint);
  const { fetchFn, sendRawTransaction } = happyDeps(creator, mint);

  await assert.rejects(
    () =>
      submitPumpfunCreate(
        { body, creatorKeypair: wrongCreator, mintKeypair: mint },
        { fetchFn, sendRawTransaction },
      ),
    /creator.*mismatch|keypair/i,
  );
});

// ============================================
// Failure surfaces
// ============================================

test("submitPumpfunCreate throws labeled error on pumpportal non-2xx", async () => {
  const { submitPumpfunCreate } = await import(
    "../services/submitPumpfunCreate.js"
  );
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const body = buildHappyBody(creator, mint);

  const fetchFn: typeof fetch = async () =>
    ({
      ok: false,
      status: 503,
      async text() {
        return "pumpportal down";
      },
      async arrayBuffer() {
        return new ArrayBuffer(0);
      },
    } as any);

  await assert.rejects(
    () =>
      submitPumpfunCreate(
        { body, creatorKeypair: creator, mintKeypair: mint },
        { fetchFn, sendRawTransaction: async () => "x" },
      ),
    /pumpportal_local.*503/,
  );
});

test("submitPumpfunCreate surfaces RPC errors as labeled rpc_submit errors", async () => {
  const { submitPumpfunCreate } = await import(
    "../services/submitPumpfunCreate.js"
  );
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const body = buildHappyBody(creator, mint);
  const bytes = buildUnsignedTxBytes(creator, mint);
  const { fetchFn } = fakePumpportalOk(bytes);

  await assert.rejects(
    () =>
      submitPumpfunCreate(
        { body, creatorKeypair: creator, mintKeypair: mint },
        {
          fetchFn,
          sendRawTransaction: async () => {
            throw new Error("blockhash not found");
          },
        },
      ),
    /rpc_submit.*blockhash/,
  );
});

test("submitPumpfunCreate throws when pumpportal returns empty bytes", async () => {
  const { submitPumpfunCreate } = await import(
    "../services/submitPumpfunCreate.js"
  );
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const body = buildHappyBody(creator, mint);

  const fetchFn: typeof fetch = async () =>
    ({
      ok: true,
      status: 200,
      async arrayBuffer() {
        return new ArrayBuffer(0);
      },
      async text() {
        return "";
      },
    } as any);

  await assert.rejects(
    () =>
      submitPumpfunCreate(
        { body, creatorKeypair: creator, mintKeypair: mint },
        { fetchFn, sendRawTransaction: async () => "x" },
      ),
    /empty|deserialize/i,
  );
});
