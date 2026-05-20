import assert from "node:assert/strict";
import test from "node:test";
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  preparePumpfunCreate,
  broadcastSignedPumpfunCreate,
} from "../services/preparePumpfunCreate.js";
import type { PumpfunCreateRequestBody } from "../services/pumpfunTxBuilder.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Mirrors the submitPumpfunCreate test fixture: a real
// SystemProgram.createAccount tx so both creator (fee payer) and mint
// (new account) appear as required signers — exercises the real signer
// slot semantics.
const VALID_BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";

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

function buildBody(creator: Keypair, mint: Keypair): PumpfunCreateRequestBody {
  return {
    action: "create",
    publicKey: creator.publicKey.toBase58(),
    mint: mint.publicKey.toBase58(),
    tokenMetadata: {
      name: "Test",
      symbol: "TST",
      uri: "https://example.com/x.png",
    },
    denominatedInSol: "true",
    amount: 0,
    slippage: 10,
    priorityFee: 0.00005,
    pool: "pump",
  };
}

setupEnv();

// ============================================
// preparePumpfunCreate
// ============================================

test("preparePumpfunCreate signs mint only and leaves creator slot empty", async () => {
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const unsignedBytes = buildUnsignedTxBytes(creator, mint);
  const { calls, fetchFn } = fakePumpportalOk(unsignedBytes);

  const result = await preparePumpfunCreate(
    { body: buildBody(creator, mint), mintKeypair: mint },
    { fetchFn },
  );

  assert.equal(result.mintAddress, mint.publicKey.toBase58());
  assert.equal(result.creatorPubkey, creator.publicKey.toBase58());
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://pumpportal.fun/api/trade-local");

  // Deserialize the returned partial-signed tx and verify slot state:
  //   slot 0 (creator/fee payer) → empty (all zeros)
  //   slot 1 (mint) → signed (non-zero)
  const raw = new Uint8Array(Buffer.from(result.partialSignedTxBase64, "base64"));
  const tx = VersionedTransaction.deserialize(raw);
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const creatorIdx = keys.indexOf(creator.publicKey.toBase58());
  const mintIdx = keys.indexOf(mint.publicKey.toBase58());
  assert.ok(creatorIdx >= 0, "creator slot must exist");
  assert.ok(mintIdx >= 0, "mint slot must exist");
  const creatorSig = tx.signatures[creatorIdx]!;
  const mintSig = tx.signatures[mintIdx]!;
  assert.ok(
    creatorSig.every((b) => b === 0),
    "creator signature slot must be empty after preparePumpfunCreate",
  );
  assert.ok(
    !mintSig.every((b) => b === 0),
    "mint signature slot must be populated after preparePumpfunCreate",
  );
});

test("preparePumpfunCreate rejects mint/body mismatch", async () => {
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const wrongMint = Keypair.generate();
  const { fetchFn } = fakePumpportalOk(buildUnsignedTxBytes(creator, mint));

  await assert.rejects(
    preparePumpfunCreate(
      { body: buildBody(creator, mint), mintKeypair: wrongMint },
      { fetchFn },
    ),
    /mint keypair\/body mint mismatch/,
  );
});

test("preparePumpfunCreate surfaces pumpportal non-2xx with a snippet", async () => {
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const fetchFn: typeof fetch = async () =>
    ({
      ok: false,
      status: 502,
      async text() {
        return "upstream timed out";
      },
    }) as any;

  await assert.rejects(
    preparePumpfunCreate(
      { body: buildBody(creator, mint), mintKeypair: mint },
      { fetchFn },
    ),
    /pumpportal_local: returned 502/,
  );
});

// ============================================
// broadcastSignedPumpfunCreate
// ============================================

async function prepareAndCreatorSign(
  creator: Keypair,
  mint: Keypair,
): Promise<string> {
  const unsignedBytes = buildUnsignedTxBytes(creator, mint);
  const { fetchFn } = fakePumpportalOk(unsignedBytes);
  const prep = await preparePumpfunCreate(
    { body: buildBody(creator, mint), mintKeypair: mint },
    { fetchFn },
  );
  // Simulate the browser wallet adapter: deserialize, add creator
  // signature, reserialize. Standard partial-sign flow.
  const raw = new Uint8Array(Buffer.from(prep.partialSignedTxBase64, "base64"));
  const tx = VersionedTransaction.deserialize(raw);
  tx.sign([creator]);
  return Buffer.from(tx.serialize()).toString("base64");
}

test("broadcastSignedPumpfunCreate forwards fully-signed bytes to RPC", async () => {
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const signedBase64 = await prepareAndCreatorSign(creator, mint);

  const rpcCalls: Uint8Array[] = [];
  const sendRawTransaction = async (raw: Uint8Array) => {
    rpcCalls.push(raw);
    return "rpc_sig_ok";
  };

  const result = await broadcastSignedPumpfunCreate(
    {
      signedTxBase64: signedBase64,
      expectedMintAddress: mint.publicKey.toBase58(),
      expectedCreatorPubkey: creator.publicKey.toBase58(),
    },
    { sendRawTransaction },
  );

  assert.equal(result.txSignature, "rpc_sig_ok");
  assert.equal(result.mintAddress, mint.publicKey.toBase58());
  assert.equal(rpcCalls.length, 1);
});

test("broadcastSignedPumpfunCreate rejects an unsigned creator slot", async () => {
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  // Only the prepare step ran; creator slot is still empty.
  const unsignedBytes = buildUnsignedTxBytes(creator, mint);
  const { fetchFn } = fakePumpportalOk(unsignedBytes);
  const prep = await preparePumpfunCreate(
    { body: buildBody(creator, mint), mintKeypair: mint },
    { fetchFn },
  );

  const sendRawTransaction = async () => "should_not_be_called";
  await assert.rejects(
    broadcastSignedPumpfunCreate(
      {
        signedTxBase64: prep.partialSignedTxBase64,
        expectedMintAddress: mint.publicKey.toBase58(),
        expectedCreatorPubkey: creator.publicKey.toBase58(),
      },
      { sendRawTransaction },
    ),
    /signer slot 0 .* unsigned/,
  );
});

test("broadcastSignedPumpfunCreate rejects mint-mismatch tampering", async () => {
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const signedBase64 = await prepareAndCreatorSign(creator, mint);
  const sendRawTransaction = async () => "rpc_sig";

  await assert.rejects(
    broadcastSignedPumpfunCreate(
      {
        signedTxBase64: signedBase64,
        // Different mint pubkey — tampering.
        expectedMintAddress: Keypair.generate().publicKey.toBase58(),
        expectedCreatorPubkey: creator.publicKey.toBase58(),
      },
      { sendRawTransaction },
    ),
    /does not reference expected mint/,
  );
});

test("broadcastSignedPumpfunCreate rejects creator-mismatch tampering", async () => {
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const signedBase64 = await prepareAndCreatorSign(creator, mint);
  const sendRawTransaction = async () => "rpc_sig";

  await assert.rejects(
    broadcastSignedPumpfunCreate(
      {
        signedTxBase64: signedBase64,
        expectedMintAddress: mint.publicKey.toBase58(),
        expectedCreatorPubkey: Keypair.generate().publicKey.toBase58(),
      },
      { sendRawTransaction },
    ),
    /does not reference expected creator/,
  );
});

test("broadcastSignedPumpfunCreate rejects empty / invalid base64", async () => {
  const sendRawTransaction = async () => "rpc_sig";
  await assert.rejects(
    broadcastSignedPumpfunCreate(
      {
        signedTxBase64: "",
        expectedMintAddress: Keypair.generate().publicKey.toBase58(),
        expectedCreatorPubkey: Keypair.generate().publicKey.toBase58(),
      },
      { sendRawTransaction },
    ),
    /signed tx is empty/,
  );
});

test("broadcastSignedPumpfunCreate wraps RPC failure with context", async () => {
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const signedBase64 = await prepareAndCreatorSign(creator, mint);
  const sendRawTransaction = async () => {
    throw new Error("blockhash not found");
  };

  await assert.rejects(
    broadcastSignedPumpfunCreate(
      {
        signedTxBase64: signedBase64,
        expectedMintAddress: mint.publicKey.toBase58(),
        expectedCreatorPubkey: creator.publicKey.toBase58(),
      },
      { sendRawTransaction },
    ),
    /rpc_submit: blockhash not found/,
  );
});
