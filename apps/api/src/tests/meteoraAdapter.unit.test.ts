import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  DynamicBondingCurveClient,
  deriveDbcPoolAddress,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

import {
  MAX_TRANSACTION_BYTES,
  createMeteoraAdapter,
  createMeteoraMetadataUploader,
  type MeteoraAdapterDeps,
} from "../services/launchpad/meteoraAdapter.js";
import {
  LaunchNotConfirmed,
  LaunchRefusal,
  type LaunchRefusalCode,
} from "../services/launchpad/launchRefusal.js";
import { presetSupplySplit } from "../services/launchpad/meteoraPresets.js";
import type { PrepareLaunchInput } from "../services/launchpad/types.js";

// Drives services/launchpad/meteoraAdapter.ts with a fake SDK client and
// fake chain calls: no network, and every keypair here is made in memory.

const BLOCKHASH = "11111111111111111111111111111111";
const OTHER_BLOCKHASH = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const LAST_VALID_BLOCK_HEIGHT = 4242;
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const METADATA_URI = "https://ipfs.io/ipfs/QmWATWQ7fVPP2EFGu71UkfnqhYXDYH566qy47CnJDgvs8u";

const creator = Keypair.fromSeed(new Uint8Array(32).fill(3));
const configKeypair = Keypair.fromSeed(new Uint8Array(32).fill(5));
const mintKeypair = Keypair.fromSeed(new Uint8Array(32).fill(6));
const feeClaimer = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey;
const leftoverReceiver = Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey;

interface Capture {
  calls: string[];
  params?: any;
  uploaded?: any;
  sent?: Uint8Array;
  confirmed?: { signature: string; sentWith: { blockhash: string; lastValidBlockHeight: number } };
}

// What the real createConfigAndPool asks for, in small: the payer, the
// config and the mint must all sign. `extraBytes` pads it for the size test.
function fakeLaunchTransaction(params: any, extraBytes = 0): Transaction {
  return new Transaction().add(
    new TransactionInstruction({
      programId: MEMO,
      keys: [
        { pubkey: params.payer, isSigner: true, isWritable: true },
        { pubkey: params.config, isSigner: true, isWritable: true },
        { pubkey: params.preCreatePoolParam.baseMint, isSigner: true, isWritable: true },
        { pubkey: params.feeClaimer, isSigner: false, isWritable: false },
        { pubkey: params.quoteMint, isSigner: false, isWritable: false },
      ],
      data: Buffer.alloc(extraBytes, 1),
    }),
  );
}

function makeAdapter(
  capture: Capture,
  overrides: Partial<MeteoraAdapterDeps> = {},
  extraBytes = 0,
) {
  // The adapter asks for the config's keypair first, then the mint's.
  const fresh = [configKeypair, mintKeypair];
  return createMeteoraAdapter({
    client: {
      partner: {
        createConfigAndPool: async (params) => {
          capture.calls.push("createConfigAndPool");
          capture.params = params;
          return fakeLaunchTransaction(params, extraBytes);
        },
      },
    },
    network: "devnet",
    feeClaimer,
    leftoverReceiver,
    uploadMetadata: async (metadata) => {
      capture.calls.push("uploadMetadata");
      capture.uploaded = metadata;
      return METADATA_URI;
    },
    getLatestBlockhash: async () => {
      capture.calls.push("getLatestBlockhash");
      return { blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT };
    },
    sendRawTransaction: async (raw) => {
      capture.calls.push("sendRawTransaction");
      capture.sent = raw;
      return "launch_signature";
    },
    confirmTransaction: async (signature, sentWith) => {
      capture.calls.push("confirmTransaction");
      capture.confirmed = { signature, sentWith };
    },
    generateKeypair: () => {
      const next = fresh.shift();
      if (!next) throw new Error("the adapter asked for a third keypair");
      return next;
    },
    ...overrides,
  });
}

const launchInput = (overrides: Partial<PrepareLaunchInput> = {}): PrepareLaunchInput => ({
  creatorPubkey: creator.publicKey.toBase58(),
  metadata: {
    name: "Eliza Token",
    symbol: "ELZ",
    imageUrl: "https://cdn.example.com/icon.png",
    description: "An agent token",
  },
  ...overrides,
});

function decode(base64: string): VersionedTransaction {
  return VersionedTransaction.deserialize(new Uint8Array(Buffer.from(base64, "base64")));
}

function encode(tx: VersionedTransaction): string {
  return Buffer.from(tx.serialize()).toString("base64");
}

const isEmpty = (signature: Uint8Array) => signature.every((byte) => byte === 0);

/** A check for assert.rejects: a refusal the creator can fix, with this code and status. */
function refusal(code: LaunchRefusalCode, sentence?: RegExp, status: 400 | 502 = 400) {
  return (err: unknown) => {
    assert.ok(err instanceof LaunchRefusal, `a LaunchRefusal, got ${String(err)}`);
    assert.equal(err.code, code);
    assert.equal(err.status, status);
    // The sentence is for a person: the code is not repeated in it.
    assert.ok(!err.message.includes(code), err.message);
    if (sentence) assert.match(err.message, sentence);
    return true;
  };
}

/** A prepared launch, and the same transaction signed by the creator as a wallet would. */
async function prepareAndSign(capture: Capture, adapter = makeAdapter(capture)) {
  const prepared = await adapter.prepareLaunch(launchInput());
  const signed = decode(prepared.partialSignedTxBase64);
  signed.sign([creator]);
  return { adapter, prepared, signedTxBase64: encode(signed) };
}

// ============================================
// prepareLaunch
// ============================================

test("prepareLaunch returns a transaction with the creator's slot empty and the other two signed", async () => {
  const capture: Capture = { calls: [] };
  const adapter = makeAdapter(capture);
  const result = await adapter.prepareLaunch(launchInput());

  assert.equal(adapter.id, "meteora");
  assert.equal(result.mintAddress, mintKeypair.publicKey.toBase58());
  assert.equal(result.creatorPubkey, creator.publicKey.toBase58());

  const tx = decode(result.partialSignedTxBase64);
  assert.equal(tx.version, 0);
  assert.equal(tx.message.header.numRequiredSignatures, 3);
  assert.equal(tx.signatures.length, 3);

  const keys = tx.message.staticAccountKeys.map((key) => key.toBase58());
  assert.equal(keys[0], creator.publicKey.toBase58(), "the creator pays");
  const signerOf = (address: string) => tx.signatures[keys.indexOf(address)]!;
  assert.equal(isEmpty(signerOf(creator.publicKey.toBase58())), true, "left for the wallet");
  assert.equal(isEmpty(signerOf(configKeypair.publicKey.toBase58())), false, "the config signed");
  assert.equal(isEmpty(signerOf(mintKeypair.publicKey.toBase58())), false, "the mint signed");
  assert.equal(tx.message.recentBlockhash, BLOCKHASH);
});

test("prepareLaunch's context carries the config, the derived pool, the preset and the message's hash", async () => {
  const capture: Capture = { calls: [] };
  const result = await makeAdapter(capture).prepareLaunch(launchInput());
  const tx = decode(result.partialSignedTxBase64);

  assert.deepEqual(result.context, {
    configKey: configKeypair.publicKey.toBase58(),
    poolAddress: deriveDbcPoolAddress(
      WSOL,
      mintKeypair.publicKey,
      configKeypair.publicKey,
    ).toBase58(),
    preset: "community",
    // What the community curve sells before it is full, and the rest.
    curveSupply: "799999986",
    reservedSupply: "200000014",
    messageHash: createHash("sha256").update(tx.message.serialize()).digest("hex"),
    lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
  });
  // It rides in the signed prepare token, so it must survive JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(result.context)), result.context);
});

test("prepareLaunch builds one config-and-pool call: the creator pays and creates, the platform's addresses are named", async () => {
  const capture: Capture = { calls: [] };
  await makeAdapter(capture).prepareLaunch(launchInput());

  assert.deepEqual(capture.calls, ["uploadMetadata", "createConfigAndPool", "getLatestBlockhash"]);
  const params = capture.params;
  assert.equal(params.payer.toBase58(), creator.publicKey.toBase58());
  assert.equal(params.preCreatePoolParam.poolCreator.toBase58(), creator.publicKey.toBase58());
  assert.equal(params.feeClaimer.toBase58(), feeClaimer.toBase58());
  assert.equal(params.leftoverReceiver.toBase58(), leftoverReceiver.toBase58());
  assert.equal(params.quoteMint.toBase58(), WSOL.toBase58());
  assert.equal(params.config.toBase58(), configKeypair.publicKey.toBase58());
  assert.equal(params.preCreatePoolParam.baseMint.toBase58(), mintKeypair.publicKey.toBase58());
  assert.equal(params.preCreatePoolParam.name, "Eliza Token");
  assert.equal(params.preCreatePoolParam.symbol, "ELZ");
  assert.equal(params.preCreatePoolParam.uri, METADATA_URI, "the uploaded metadata, not the picture");
  // The default preset is community: 70% of fees to the creator, nothing locked.
  assert.equal(params.creatorTradingFeePercentage, 70);
  assert.equal(params.lockedVesting.amountPerPeriod.toString(), "0");
  assert.equal(capture.uploaded.imageUrl, "https://cdn.example.com/icon.png");
});

test("prepareLaunch passes the chosen preset on", async () => {
  const capture: Capture = { calls: [] };
  const result = await makeAdapter(capture).prepareLaunch(launchInput({ preset: "committed" }));
  assert.equal(result.context.preset, "committed");
  // The supply split saved with the token is the chosen curve's own.
  const split = presetSupplySplit("committed");
  assert.equal(result.context.curveSupply, split.curveSupply.toString());
  assert.equal(result.context.reservedSupply, split.reservedSupply.toString());
  assert.notEqual(result.context.curveSupply, "799999986");
  assert.equal(capture.params.creatorTradingFeePercentage, 50);
  assert.notEqual(capture.params.lockedVesting.amountPerPeriod.toString(), "0");
});

test("prepareLaunch refuses a preset it does not know, before anything is uploaded", async () => {
  const capture: Capture = { calls: [] };
  await assert.rejects(
    makeAdapter(capture).prepareLaunch(launchInput({ preset: "moonshot" })),
    refusal("invalid_preset", /"moonshot" is not a curve that can be chosen here/),
  );
  assert.deepEqual(capture.calls, []);
});

test("prepareLaunch offers the rehearsal preset on devnet and refuses it on mainnet", async () => {
  const onDevnet: Capture = { calls: [] };
  const result = await makeAdapter(onDevnet).prepareLaunch(launchInput({ preset: "rehearsal" }));
  assert.equal(result.context.preset, "rehearsal");

  const onMainnet: Capture = { calls: [] };
  await assert.rejects(
    makeAdapter(onMainnet, { network: "mainnet-beta" }).prepareLaunch(
      launchInput({ preset: "rehearsal" }),
    ),
    refusal("invalid_preset"),
  );
  assert.deepEqual(onMainnet.calls, []);
});

test("prepareLaunch refuses a first buy and says where it is made", async () => {
  const capture: Capture = { calls: [] };
  await assert.rejects(
    makeAdapter(capture).prepareLaunch(launchInput({ initialBuySol: 0.5 })),
    refusal("first_buy_not_supported", /The first buy is made on the token's page after the launch/),
  );
  assert.deepEqual(capture.calls, []);

  // A first buy of nothing is no first buy.
  const zero: Capture = { calls: [] };
  await makeAdapter(zero).prepareLaunch(launchInput({ initialBuySol: 0 }));
  assert.ok(zero.calls.includes("createConfigAndPool"));
});

test("prepareLaunch refuses a token with no picture", async () => {
  for (const imageUrl of ["", "   "]) {
    const capture: Capture = { calls: [] };
    await assert.rejects(
      makeAdapter(capture).prepareLaunch(
        launchInput({ metadata: { ...launchInput().metadata, imageUrl } }),
      ),
      refusal("picture_required"),
    );
    assert.deepEqual(capture.calls, []);
  }
});

test("prepareLaunch refuses a name or a symbol longer in bytes than the chain holds, before anything is uploaded", async () => {
  // 20 characters the route lets through, 40 bytes on chain.
  const accented = String.fromCharCode(0xe9).repeat(20);
  const longName: Capture = { calls: [] };
  await assert.rejects(
    makeAdapter(longName).prepareLaunch(
      launchInput({ metadata: { ...launchInput().metadata, name: accented } }),
    ),
    refusal("name_too_long", /The token's name is 40 bytes and the chain holds 32/),
  );
  assert.deepEqual(longName.calls, []);

  // 6 characters, 12 bytes.
  const longSymbol: Capture = { calls: [] };
  await assert.rejects(
    makeAdapter(longSymbol).prepareLaunch(
      launchInput({ metadata: { ...launchInput().metadata, symbol: accented.slice(0, 6) } }),
    ),
    refusal("symbol_too_long", /The token's symbol is 12 bytes and the chain holds 10/),
  );
  assert.deepEqual(longSymbol.calls, []);

  // Exactly at the limit is let through.
  const atLimit: Capture = { calls: [] };
  await makeAdapter(atLimit).prepareLaunch(
    launchInput({
      metadata: { ...launchInput().metadata, name: accented.slice(0, 16), symbol: accented.slice(0, 5) },
    }),
  );
  assert.ok(atLimit.calls.includes("createConfigAndPool"));
});

test("prepareLaunch refuses a transaction over 1,232 bytes, and says it is the metadata's link", async () => {
  // A message that fits on its own and is too long once three signatures
  // are counted: the error says how long.
  const justOver: Capture = { calls: [] };
  await assert.rejects(
    makeAdapter(justOver, {}, 900).prepareLaunch(launchInput()),
    refusal(
      "metadata_link_too_long",
      /The launch is 1[23]\d\d bytes and one transaction holds 1232\. It is the link to the token's uploaded metadata that is too long, not the name or the symbol/,
    ),
  );
  // A message too long to encode at all is refused with the same code.
  const farOver: Capture = { calls: [] };
  await assert.rejects(
    makeAdapter(farOver, {}, 1500).prepareLaunch(launchInput()),
    refusal(
      "metadata_link_too_long",
      /The launch does not fit in one transaction of 1232 bytes\. It is the link/,
    ),
  );
});

test("with the real SDK, a metadata link that is too long is what the refusal names", async () => {
  const connection = new Connection("http://127.0.0.1:9", "confirmed");
  (connection as any).getAccountInfo = async () => ({
    owner: TOKEN_PROGRAM,
    data: Buffer.alloc(82),
    lamports: 1,
    executable: false,
  });
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const capture: Capture = { calls: [] };
  const adapter = makeAdapter(capture, {
    client,
    // The chain holds 200 bytes of link; the transaction has room for fewer.
    uploadMetadata: async () => `https://ipfs.io/ipfs/${"Q".repeat(179)}`,
  });
  await assert.rejects(
    adapter.prepareLaunch(
      launchInput({
        metadata: { ...launchInput().metadata, name: "A".repeat(32), symbol: "ABCDEFGHIJ" },
      }),
    ),
    refusal("metadata_link_too_long"),
  );
});

test("prepareLaunch passes on a picture link the fetch refused, and gives a failed upload its own code", async () => {
  // Refused by the fetch (services/fetchImageBytes.ts): the creator's to fix.
  const refused: Capture = { calls: [] };
  await assert.rejects(
    makeAdapter(refused, {
      uploadMetadata: async () => {
        throw new LaunchRefusal("picture_link_refused", "The picture's link cannot be used.");
      },
    }).prepareLaunch(launchInput()),
    refusal("picture_link_refused"),
  );
  assert.deepEqual(refused.calls, [], "nothing was built");

  // Anything else that stops the upload: a 502 of its own, not the creator's doing.
  const failed: Capture = { calls: [] };
  await assert.rejects(
    makeAdapter(failed, {
      uploadMetadata: async () => {
        throw new Error("pumpfun_ipfs: upload returned 503 ()");
      },
    }).prepareLaunch(launchInput()),
    refusal("picture_upload_failed", /could not be uploaded \(pumpfun_ipfs: upload returned 503/, 502),
  );
  assert.deepEqual(failed.calls, []);
});

test("prepareLaunch refuses a transaction that wants a signature nobody here can give", async () => {
  const capture: Capture = { calls: [] };
  const stranger = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey;
  const adapter = makeAdapter(capture, {
    client: {
      partner: {
        createConfigAndPool: async (params) => {
          const tx = fakeLaunchTransaction(params);
          tx.instructions[0]!.keys.push({ pubkey: stranger, isSigner: true, isWritable: false });
          return tx;
        },
      },
    },
  });
  await assert.rejects(adapter.prepareLaunch(launchInput()), /unexpected_signers/);
});

// With the real SDK building the transaction. The SDK reads one account
// while it builds (the quote mint, to learn which token program owns it),
// so that single read is answered here and every other call would throw.
test("the real SDK's launch fits in one transaction for every preset, with three signatures", async () => {
  const connection = new Connection("http://127.0.0.1:9", "confirmed");
  (connection as any).getAccountInfo = async (address: PublicKey) => {
    assert.equal(address.toBase58(), WSOL.toBase58(), "the only account the build reads");
    return { owner: TOKEN_PROGRAM, data: Buffer.alloc(82), lamports: 1, executable: false };
  };
  const client = new DynamicBondingCurveClient(connection, "confirmed");

  const sizes: number[] = [];
  for (const preset of ["community", "committed", "long", "rehearsal"]) {
    const capture: Capture = { calls: [] };
    const adapter = makeAdapter(capture, { client });
    const result = await adapter.prepareLaunch(
      launchInput({
        preset,
        // The longest name and symbol the launch route lets through.
        metadata: { ...launchInput().metadata, name: "A".repeat(32), symbol: "ABCDEFGHIJ" },
      }),
    );
    const tx = decode(result.partialSignedTxBase64);
    const size = tx.serialize().length;
    assert.ok(size <= MAX_TRANSACTION_BYTES, `${preset}: ${size} bytes`);
    sizes.push(size);
    assert.equal(tx.message.header.numRequiredSignatures, 3, preset);
    assert.equal(isEmpty(tx.signatures[0]!), true, preset);
    assert.equal(isEmpty(tx.signatures[1]!), false, preset);
    assert.equal(isEmpty(tx.signatures[2]!), false, preset);
    // The pool the context names is one of the accounts the transaction creates.
    const keys = tx.message.staticAccountKeys.map((key) => key.toBase58());
    assert.ok(keys.includes(result.context.poolAddress as string), `${preset}: the derived pool`);
    assert.ok(keys.includes(feeClaimer.toBase58()), preset);
    assert.ok(keys.includes(leftoverReceiver.toBase58()), preset);
    // No compute-budget instruction: it would cost bytes the launch does
    // not have, and a transaction the server signed first is left alone
    // by the wallet anyway.
    const programs = tx.message.compiledInstructions.map(
      (instruction) => keys[instruction.programIdIndex],
    );
    assert.ok(!programs.includes(COMPUTE_BUDGET), `${preset}: no compute-budget instruction`);
  }
  // Every preset has the same accounts and the same shape of data, so the
  // size does not depend on which one was picked.
  assert.equal(new Set(sizes).size, 1, sizes.join(", "));
});

// ============================================
// broadcastLaunch
// ============================================

test("broadcastLaunch sends and confirms the transaction that was prepared", async () => {
  const capture: Capture = { calls: [] };
  const { adapter, prepared, signedTxBase64 } = await prepareAndSign(capture);
  capture.calls.length = 0;

  const result = await adapter.broadcastLaunch({
    signedTxBase64,
    expectedMintAddress: prepared.mintAddress,
    expectedCreatorPubkey: prepared.creatorPubkey,
    context: prepared.context,
  });

  assert.deepEqual(result, {
    mintAddress: mintKeypair.publicKey.toBase58(),
    txSignature: "launch_signature",
  });
  assert.deepEqual(capture.calls, ["sendRawTransaction", "confirmTransaction"]);
  assert.equal(Buffer.from(capture.sent!).toString("base64"), signedTxBase64);
  assert.deepEqual(capture.confirmed, {
    signature: "launch_signature",
    sentWith: { blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT },
  });
});

test("broadcastLaunch refuses a changed message, and never sends it", async () => {
  const capture: Capture = { calls: [] };
  const { adapter, prepared } = await prepareAndSign(capture);
  capture.calls.length = 0;

  // The same accounts and signers, fully signed, on another blockhash: a
  // valid transaction, and not the one that was built.
  const original = decode(prepared.partialSignedTxBase64);
  const message = TransactionMessage.decompile(original.message);
  message.recentBlockhash = OTHER_BLOCKHASH;
  const changed = new VersionedTransaction(message.compileToV0Message());
  changed.sign([creator, configKeypair, mintKeypair]);

  await assert.rejects(
    adapter.broadcastLaunch({
      signedTxBase64: encode(changed),
      expectedMintAddress: prepared.mintAddress,
      expectedCreatorPubkey: prepared.creatorPubkey,
      context: prepared.context,
    }),
    /not the one that was prepared/,
  );
  assert.deepEqual(capture.calls, []);
});

test("broadcastLaunch refuses an added instruction, and never sends it", async () => {
  const capture: Capture = { calls: [] };
  const { adapter, prepared } = await prepareAndSign(capture);
  capture.calls.length = 0;

  const original = decode(prepared.partialSignedTxBase64);
  const message = TransactionMessage.decompile(original.message);
  message.instructions.push(
    new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from("extra") }),
  );
  const changed = new VersionedTransaction(message.compileToV0Message());
  changed.sign([creator, configKeypair, mintKeypair]);

  await assert.rejects(
    adapter.broadcastLaunch({
      signedTxBase64: encode(changed),
      expectedMintAddress: prepared.mintAddress,
      expectedCreatorPubkey: prepared.creatorPubkey,
      context: prepared.context,
    }),
    /not the one that was prepared/,
  );
  assert.deepEqual(capture.calls, []);
});

test("broadcastLaunch refuses a missing signature, and never sends it", async () => {
  const capture: Capture = { calls: [] };
  const { adapter, prepared } = await prepareAndSign(capture);
  capture.calls.length = 0;

  // The transaction exactly as prepare returned it: the creator never signed.
  await assert.rejects(
    adapter.broadcastLaunch({
      signedTxBase64: prepared.partialSignedTxBase64,
      expectedMintAddress: prepared.mintAddress,
      expectedCreatorPubkey: prepared.creatorPubkey,
      context: prepared.context,
    }),
    /not signed by everyone who must sign it/,
  );
  assert.deepEqual(capture.calls, []);
});

test("broadcastLaunch refuses the prepared transaction with bytes added after it, and never sends it", async () => {
  const capture: Capture = { calls: [] };
  const { adapter, prepared, signedTxBase64 } = await prepareAndSign(capture);
  capture.calls.length = 0;

  // The message and every signature are the right ones, so the hash agrees;
  // what would be sent is not only that transaction.
  const signed = Buffer.from(signedTxBase64, "base64");
  const padded = Buffer.concat([signed, Buffer.from([9, 9, 9, 9, 9])]);

  await assert.rejects(
    adapter.broadcastLaunch({
      signedTxBase64: padded.toString("base64"),
      expectedMintAddress: prepared.mintAddress,
      expectedCreatorPubkey: prepared.creatorPubkey,
      context: prepared.context,
    }),
    /bytes that are not part of it/,
  );
  assert.deepEqual(capture.calls, []);
});

test("broadcastLaunch refuses a transaction with one signature taken out, and never sends it", async () => {
  const capture: Capture = { calls: [] };
  const { adapter, prepared, signedTxBase64 } = await prepareAndSign(capture);
  capture.calls.length = 0;

  // Two signatures where the message asks for three: the count byte says
  // two and the last signature is cut out.
  const signed = Buffer.from(signedTxBase64, "base64");
  const cut = Buffer.concat([Buffer.from([2]), signed.subarray(1, 1 + 64 * 2), signed.subarray(1 + 64 * 3)]);

  await assert.rejects(
    adapter.broadcastLaunch({
      signedTxBase64: cut.toString("base64"),
      expectedMintAddress: prepared.mintAddress,
      expectedCreatorPubkey: prepared.creatorPubkey,
      context: prepared.context,
    }),
    /wrong number of signatures|cannot be read|bytes that are not part of it/,
  );
  assert.deepEqual(capture.calls, []);
});

test("broadcastLaunch refuses the same launch paid for by another wallet, and never sends it", async () => {
  const capture: Capture = { calls: [] };
  const { adapter, prepared } = await prepareAndSign(capture);
  capture.calls.length = 0;

  const stranger = Keypair.fromSeed(new Uint8Array(32).fill(12));
  const original = decode(prepared.partialSignedTxBase64);
  const message = TransactionMessage.decompile(original.message);
  message.payerKey = stranger.publicKey;
  const changed = new VersionedTransaction(message.compileToV0Message());
  changed.sign([stranger, creator, configKeypair, mintKeypair]);

  await assert.rejects(
    adapter.broadcastLaunch({
      signedTxBase64: encode(changed),
      expectedMintAddress: prepared.mintAddress,
      expectedCreatorPubkey: prepared.creatorPubkey,
      context: prepared.context,
    }),
    /not the one that was prepared/,
  );
  assert.deepEqual(capture.calls, []);
});

test("broadcastLaunch refuses a mint or a creator other than the transaction's", async () => {
  const capture: Capture = { calls: [] };
  const { adapter, prepared, signedTxBase64 } = await prepareAndSign(capture);
  capture.calls.length = 0;
  const other = Keypair.fromSeed(new Uint8Array(32).fill(11)).publicKey.toBase58();

  await assert.rejects(
    adapter.broadcastLaunch({
      signedTxBase64,
      expectedMintAddress: other,
      expectedCreatorPubkey: prepared.creatorPubkey,
      context: prepared.context,
    }),
    /does not create the expected mint/,
  );
  await assert.rejects(
    adapter.broadcastLaunch({
      signedTxBase64,
      expectedMintAddress: prepared.mintAddress,
      expectedCreatorPubkey: other,
      context: prepared.context,
    }),
    /not paid for by the expected creator/,
  );
  assert.deepEqual(capture.calls, []);
});

test("broadcastLaunch refuses a context it did not write, and bytes that are no transaction", async () => {
  const capture: Capture = { calls: [] };
  const { adapter, prepared, signedTxBase64 } = await prepareAndSign(capture);
  capture.calls.length = 0;
  const base = {
    expectedMintAddress: prepared.mintAddress,
    expectedCreatorPubkey: prepared.creatorPubkey,
  };

  await assert.rejects(
    adapter.broadcastLaunch({ ...base, signedTxBase64, context: {} }),
    /not prepared by the meteora launchpad/,
  );
  await assert.rejects(
    adapter.broadcastLaunch({ ...base, signedTxBase64: "", context: prepared.context }),
    /empty/,
  );
  await assert.rejects(
    adapter.broadcastLaunch({
      ...base,
      signedTxBase64: Buffer.from("not a transaction").toString("base64"),
      context: prepared.context,
    }),
    /cannot be read|not the one that was prepared/,
  );
  assert.deepEqual(capture.calls, []);
});

test("broadcastLaunch reports a refused send as rpc_submit", async () => {
  const capture: Capture = { calls: [] };
  const adapter = makeAdapter(capture, {
    sendRawTransaction: async () => {
      throw new Error("blockhash not found");
    },
  });
  const { prepared, signedTxBase64 } = await prepareAndSign(capture, adapter);
  await assert.rejects(
    adapter.broadcastLaunch({
      signedTxBase64,
      expectedMintAddress: prepared.mintAddress,
      expectedCreatorPubkey: prepared.creatorPubkey,
      context: prepared.context,
    }),
    /rpc_submit: blockhash not found/,
  );
  assert.ok(!capture.calls.includes("confirmTransaction"));
});

test("broadcastLaunch carries the signature when a sent launch is not confirmed", async () => {
  const capture: Capture = { calls: [] };
  const adapter = makeAdapter(capture, {
    confirmTransaction: async () => {
      throw new Error("block height exceeded");
    },
  });
  const { prepared, signedTxBase64 } = await prepareAndSign(capture, adapter);
  await assert.rejects(
    adapter.broadcastLaunch({
      signedTxBase64,
      expectedMintAddress: prepared.mintAddress,
      expectedCreatorPubkey: prepared.creatorPubkey,
      context: prepared.context,
    }),
    (err: unknown) => {
      assert.ok(err instanceof LaunchNotConfirmed, String(err));
      // As a member, for /launch/reconcile, and still in the sentence.
      assert.equal(err.signature, "launch_signature");
      assert.match(
        err.message,
        /not_confirmed: the launch was sent as launch_signature .*block height exceeded/,
      );
      return true;
    },
  );
  assert.ok(capture.calls.includes("sendRawTransaction"));
});

// ============================================
// The production metadata upload
// ============================================

test("the metadata upload fetches the picture, uploads it with the metadata and returns the metadata's address", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const hits: string[] = [];
  let form: FormData | undefined;
  const fetchFn = (async (url: any, init: any) => {
    const address = String(url);
    hits.push(address);
    if (address.includes("/api/ipfs")) {
      form = init.body as FormData;
      return new Response(JSON.stringify({ metadataUri: METADATA_URI }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
  }) as unknown as typeof fetch;

  const uri = await createMeteoraMetadataUploader(fetchFn)({
    name: "Eliza Token",
    symbol: "ELZ",
    imageUrl: "https://cdn.example.com/icon.png",
    description: "  ",
  });

  assert.equal(uri, METADATA_URI);
  assert.deepEqual(hits, ["https://cdn.example.com/icon.png", "https://pump.fun/api/ipfs"]);
  assert.equal(form?.get("name"), "Eliza Token");
  assert.equal(form?.get("symbol"), "ELZ");
  assert.equal(form?.get("description"), "Eliza Token", "an empty description falls back to the name");
  assert.ok(form?.get("file"), "the picture's bytes are in the upload");
});

test("the metadata upload passes on a picture link that is not a web address, and requests nothing", async () => {
  let requests = 0;
  const fetchFn = (async () => {
    requests += 1;
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;

  await assert.rejects(
    createMeteoraMetadataUploader(fetchFn)({
      name: "Eliza Token",
      symbol: "ELZ",
      imageUrl: "file:///etc/passwd",
      description: "An agent token",
    }),
    refusal("picture_link_refused"),
  );
  assert.equal(requests, 0);
});
