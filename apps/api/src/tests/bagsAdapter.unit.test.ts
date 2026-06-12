import assert from "node:assert/strict";
import test from "node:test";
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import { createBagsAdapter } from "../services/launchpad/bagsAdapter.js";

const BLOCKHASH = "11111111111111111111111111111111";
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const configPayer = Keypair.fromSeed(new Uint8Array(32).fill(1));
const feeClaimer = Keypair.fromSeed(new Uint8Array(32).fill(2));
const creator = Keypair.fromSeed(new Uint8Array(32).fill(3));
const mint = Keypair.fromSeed(new Uint8Array(32).fill(4));
const configKey = Keypair.fromSeed(new Uint8Array(32).fill(5)).publicKey;

// A v0 tx that references `mint` (non-signer) with `payer` as the sole
// signer. Used to fake both the config tx and a browser-signed launch tx.
function txReferencing(payer: PublicKey, ref: PublicKey): VersionedTransaction {
  const ix = new TransactionInstruction({
    programId: MEMO,
    keys: [{ pubkey: ref, isSigner: false, isWritable: false }],
    data: Buffer.from([]),
  });
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: BLOCKHASH,
    instructions: [ix],
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

function makeSdk(calls: string[], capture: any = {}) {
  return {
    tokenLaunch: {
      createTokenInfoAndMetadata: async (params: any) => {
        calls.push("createTokenInfoAndMetadata");
        capture.metaParams = params;
        return {
          tokenMint: mint.publicKey.toBase58(),
          tokenMetadata: "ipfs://QmMeta",
          tokenLaunch: {},
        };
      },
      createLaunchTransaction: async (params: any) => {
        calls.push("createLaunchTransaction");
        capture.launchParams = params;
        return txReferencing(creator.publicKey, mint.publicKey);
      },
    },
    config: {
      createBagsFeeShareConfig: async (args: any) => {
        calls.push("createBagsFeeShareConfig");
        capture.cfgArgs = args;
        return {
          transactions: [txReferencing(configPayer.publicKey, mint.publicKey)],
          bundles: [],
          meteoraConfigKey: configKey,
        };
      },
    },
  };
}

function makeAdapter(calls: string[], capture: any = {}) {
  return createBagsAdapter({
    sdk: makeSdk(calls, capture) as any,
    configPayer,
    feeClaimerPubkey: feeClaimer.publicKey,
    sendRawTransaction: async () => {
      calls.push("sendRawTransaction");
      return "sig";
    },
    confirmTransaction: async () => {
      calls.push("confirmTransaction");
    },
  });
}

test("prepareLaunch runs metadata → config (signed+sent) → launch in order", async () => {
  const calls: string[] = [];
  const capture: any = {};
  const adapter = makeAdapter(calls, capture);

  const result = await adapter.prepareLaunch({
    creatorPubkey: creator.publicKey.toBase58(),
    metadata: {
      name: "Eliza",
      symbol: "ELZ",
      imageUrl: "https://cdn.example.com/icon.png",
      description: "agent token",
    },
    initialBuySol: 0.01,
  });

  // Config must be signed + confirmed before the launch tx is built.
  assert.deepEqual(calls, [
    "createTokenInfoAndMetadata",
    "createBagsFeeShareConfig",
    "sendRawTransaction",
    "confirmTransaction",
    "createLaunchTransaction",
  ]);

  // 100% fee share to the platform fee wallet.
  assert.equal(capture.cfgArgs.feeClaimers.length, 1);
  assert.equal(capture.cfgArgs.feeClaimers[0].userBps, 10_000);
  assert.equal(
    capture.cfgArgs.feeClaimers[0].user.toBase58(),
    feeClaimer.publicKey.toBase58(),
  );
  assert.equal(
    capture.cfgArgs.payer.toBase58(),
    configPayer.publicKey.toBase58(),
  );

  // Launch tx targets the user wallet + the config we just created.
  assert.equal(
    capture.launchParams.launchWallet.toBase58(),
    creator.publicKey.toBase58(),
  );
  assert.equal(capture.launchParams.configKey.toBase58(), configKey.toBase58());
  assert.equal(capture.launchParams.initialBuyLamports, 10_000_000); // 0.01 SOL

  assert.equal(result.mintAddress, mint.publicKey.toBase58());
  assert.equal(result.creatorPubkey, creator.publicKey.toBase58());
  assert.equal(result.context.configKey, configKey.toBase58());
  assert.equal(result.context.feeClaimer, feeClaimer.publicKey.toBase58());
  assert.ok(result.partialSignedTxBase64.length > 0);
});

test("prepareLaunch applies the initial-buy floor", async () => {
  const calls: string[] = [];
  const capture: any = {};
  const adapter = createBagsAdapter({
    sdk: makeSdk(calls, capture) as any,
    configPayer,
    feeClaimerPubkey: feeClaimer.publicKey,
    initialBuyLamportsFloor: 5_000_000,
    sendRawTransaction: async () => "sig",
    confirmTransaction: async () => {},
  });
  await adapter.prepareLaunch({
    creatorPubkey: creator.publicKey.toBase58(),
    metadata: {
      name: "Eliza",
      symbol: "ELZ",
      imageUrl: "https://cdn.example.com/icon.png",
      description: "agent token",
    },
    // No initial buy → floor applies.
  });
  assert.equal(capture.launchParams.initialBuyLamports, 5_000_000);
});

test("broadcastLaunch accepts a signed tx referencing the mint + creator", async () => {
  const calls: string[] = [];
  const adapter = makeAdapter(calls);

  const tx = txReferencing(creator.publicKey, mint.publicKey);
  tx.sign([creator]);
  const signedTxBase64 = Buffer.from(tx.serialize()).toString("base64");

  const out = await adapter.broadcastLaunch({
    signedTxBase64,
    expectedMintAddress: mint.publicKey.toBase58(),
    expectedCreatorPubkey: creator.publicKey.toBase58(),
    context: { configKey: configKey.toBase58() },
  });
  assert.equal(out.mintAddress, mint.publicKey.toBase58());
  assert.equal(out.txSignature, "sig");
});

test("broadcastLaunch rejects a tx that doesn't reference the expected mint", async () => {
  const adapter = makeAdapter([]);
  const tx = txReferencing(creator.publicKey, feeClaimer.publicKey); // wrong ref
  tx.sign([creator]);
  const signedTxBase64 = Buffer.from(tx.serialize()).toString("base64");

  await assert.rejects(
    adapter.broadcastLaunch({
      signedTxBase64,
      expectedMintAddress: mint.publicKey.toBase58(),
      expectedCreatorPubkey: creator.publicKey.toBase58(),
      context: {},
    }),
    /does not reference expected mint/,
  );
});

test("broadcastLaunch rejects an unsigned creator slot", async () => {
  const adapter = makeAdapter([]);
  const tx = txReferencing(creator.publicKey, mint.publicKey); // not signed
  const signedTxBase64 = Buffer.from(tx.serialize()).toString("base64");

  await assert.rejects(
    adapter.broadcastLaunch({
      signedTxBase64,
      expectedMintAddress: mint.publicKey.toBase58(),
      expectedCreatorPubkey: creator.publicKey.toBase58(),
      context: {},
    }),
    /creator signer slot is unsigned/,
  );
});
