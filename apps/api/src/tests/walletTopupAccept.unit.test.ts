/**
 * Drives acceptSignedTopupTransaction (services/walletTopup.ts): what
 * POST /topups/:id/submit accepts as "the transfer we prepared".
 *
 * Accepted: the prepared message byte for byte, or the same instructions
 * with nothing added but a wallet's own fee setting (ComputeBudget) and
 * guard (L2TEx...). Everything else is message_mismatch. The payer's
 * signature is checked over the bytes the wallet actually signed.
 *
 * Real web3.js on both sides; nothing here touches a network.
 */

import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import nacl from "tweetnacl";

import {
  acceptSignedTopupTransaction,
  buildTopupTransaction,
  signatureOfSignedTransaction,
  WALLET_ADDED_PROGRAM_IDS,
} from "../services/walletTopup.js";

const PAYER = Keypair.fromSeed(new Uint8Array(32).fill(21));
const STRANGER = Keypair.fromSeed(new Uint8Array(32).fill(22));
const DEPOSIT = Keypair.fromSeed(new Uint8Array(32).fill(23)).publicKey;
const BLOCKHASH = Keypair.fromSeed(new Uint8Array(32).fill(24)).publicKey.toBase58();
const OTHER_BLOCKHASH = Keypair.fromSeed(new Uint8Array(32).fill(25)).publicKey.toBase58();
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const GUARD_PROGRAM = new PublicKey("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
const TOPUP_ID = "11111111-2222-4333-8444-555555555555";

function prepared(asset: "SOL" | "USDC" = "SOL") {
  return buildTopupTransaction({
    asset,
    payerAddress: PAYER.publicKey.toBase58(),
    depositAddress: DEPOSIT.toBase58(),
    amountRaw: asset === "SOL" ? "250000000" : "50000000",
    topupId: TOPUP_ID,
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 1_000,
    usdcMint: DEVNET_USDC,
  });
}

function preparedInstructions(asset: "SOL" | "USDC" = "SOL"): TransactionInstruction[] {
  return Transaction.from(Buffer.from(prepared(asset).unsignedTxBase64, "base64"))
    .instructions;
}

/** A wallet that rebuilds the message around the prepared instructions. */
function rebuild(
  instructions: TransactionInstruction[],
  opts: { feePayer?: Keypair; blockhash?: string; signers?: Keypair[] } = {},
): string {
  const feePayer = opts.feePayer ?? PAYER;
  const tx = new Transaction({
    feePayer: feePayer.publicKey,
    blockhash: opts.blockhash ?? BLOCKHASH,
    lastValidBlockHeight: 1_000,
  });
  tx.add(...instructions);
  tx.sign(...(opts.signers ?? [feePayer]));
  return tx.serialize().toString("base64");
}

const feeLimit = () => ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
const feePrice = () => ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 });
const guard = (keys: TransactionInstruction["keys"] = []) =>
  new TransactionInstruction({
    programId: GUARD_PROGRAM,
    keys,
    data: Buffer.from([1, 2, 3, 4]),
  });

function accept(signedTxBase64: string, asset: "SOL" | "USDC" = "SOL") {
  return acceptSignedTopupTransaction({
    signedTxBase64,
    unsignedMessageB64: prepared(asset).unsignedMessageB64,
    payerAddress: PAYER.publicKey.toBase58(),
  });
}

function refusal(result: ReturnType<typeof accept>): string {
  assert.equal(result.ok, false, "expected a refusal");
  return result.ok ? "" : `${result.code}:${result.reason}`;
}

// ============================================
// Accepted
// ============================================

test("the prepared bytes, signed, are accepted as exact (SOL and USDC)", () => {
  for (const asset of ["SOL", "USDC"] as const) {
    const signed = rebuild(preparedInstructions(asset));
    const result = accept(signed, asset);
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.exact, true);
    assert.equal(result.addedInstructions, 0);
    assert.equal(result.rawTxBase64, signed);
    assert.equal(result.txSignatureB58, signatureOfSignedTransaction(signed));
  }
});

test("a wallet's fee setting, before and after, is accepted", () => {
  const ixs = preparedInstructions();
  const signed = rebuild([feeLimit(), feePrice(), ...ixs]);
  const result = accept(signed);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.exact, false);
  assert.equal(result.addedInstructions, 2);
  // What is broadcast is what the wallet signed, not what we prepared.
  assert.equal(result.rawTxBase64, signed);

  const tail = accept(rebuild([...ixs, feePrice()]));
  assert.ok(tail.ok && tail.addedInstructions === 1);
  const between = accept(rebuild([ixs[0]!, feePrice(), ...ixs.slice(1)]));
  assert.ok(between.ok && between.addedInstructions === 1);
});

test("a wallet's guard instruction is accepted, with accounts of the transfer", () => {
  const ixs = preparedInstructions("USDC");
  const signed = rebuild([
    feeLimit(),
    ...ixs,
    guard([{ pubkey: PAYER.publicKey, isSigner: false, isWritable: false }]),
  ]);
  const result = accept(signed, "USDC");
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.addedInstructions, 2);
});

test("the two programs a wallet may add are exactly these", () => {
  assert.deepEqual(WALLET_ADDED_PROGRAM_IDS, [
    "ComputeBudget111111111111111111111111111111",
    "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95",
  ]);
});

test("a versioned message with no lookup tables is accepted", () => {
  const message = new TransactionMessage({
    payerKey: PAYER.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [feePrice(), ...preparedInstructions()],
  }).compileToV0Message();
  const vtx = new VersionedTransaction(message);
  vtx.sign([PAYER]);
  const result = accept(Buffer.from(vtx.serialize()).toString("base64"));
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.exact, false);
  assert.equal(result.addedInstructions, 1);
});

test("the signature is checked over the bytes the wallet signed", () => {
  const signed = rebuild([feePrice(), ...preparedInstructions()]);
  const vtx = VersionedTransaction.deserialize(Buffer.from(signed, "base64"));
  const result = accept(signed);
  assert.ok(result.ok);
  // Valid over the submitted message...
  assert.ok(
    nacl.sign.detached.verify(
      vtx.message.serialize(),
      vtx.signatures[0]!,
      PAYER.publicKey.toBytes(),
    ),
  );
  // ...and not over the prepared one, which is a different message.
  assert.ok(
    !nacl.sign.detached.verify(
      Buffer.from(prepared().unsignedMessageB64, "base64"),
      vtx.signatures[0]!,
      PAYER.publicKey.toBytes(),
    ),
  );
});

// ============================================
// Refused
// ============================================

test("an added instruction of any other program is a mismatch", () => {
  const extra = SystemProgram.transfer({
    fromPubkey: PAYER.publicKey,
    toPubkey: STRANGER.publicKey,
    lamports: 1n,
  });
  assert.equal(
    refusal(accept(rebuild([...preparedInstructions(), extra]))),
    "message_mismatch:instructions",
  );
});

test("the transfer repeated is a mismatch", () => {
  const ixs = preparedInstructions();
  assert.equal(
    refusal(accept(rebuild([ixs[0]!, ixs[0]!, ...ixs.slice(1)]))),
    "message_mismatch:instructions",
  );
});

test("a prepared instruction left out, or out of order, is a mismatch", () => {
  const ixs = preparedInstructions("USDC");
  assert.equal(ixs.length, 3);
  assert.equal(
    refusal(accept(rebuild([ixs[0]!, ixs[1]!, feePrice()]), "USDC")),
    "message_mismatch:instructions",
  );
  assert.equal(
    refusal(accept(rebuild([ixs[1]!, ixs[0]!, ixs[2]!]), "USDC")),
    "message_mismatch:instructions",
  );
  // Only the wallet's own instructions and none of ours.
  assert.equal(
    refusal(accept(rebuild([feeLimit(), feePrice()]), "USDC")),
    "message_mismatch:instructions",
  );
});

test("another amount, another recipient or another memo is a mismatch", () => {
  const ixs = preparedInstructions();
  const otherAmount = SystemProgram.transfer({
    fromPubkey: PAYER.publicKey,
    toPubkey: DEPOSIT,
    lamports: 1n,
  });
  const otherRecipient = SystemProgram.transfer({
    fromPubkey: PAYER.publicKey,
    toPubkey: STRANGER.publicKey,
    lamports: 250_000_000n,
  });
  const otherMemo = new TransactionInstruction({
    programId: ixs[1]!.programId,
    keys: [],
    data: Buffer.from("wheelsai-topup:99999999-8888-4777-8666-555555555555", "utf8"),
  });
  for (const changed of [
    [otherAmount, ixs[1]!],
    [otherRecipient, ixs[1]!],
    [ixs[0]!, otherMemo],
  ]) {
    assert.equal(
      refusal(accept(rebuild([feePrice(), ...changed]))),
      "message_mismatch:instructions",
    );
  }
});

test("an added instruction that changes an account's flags is a mismatch", () => {
  // The mint is read-only in the prepared transfer. A guard instruction
  // that names it writable changes what the transfer's accounts may do.
  const ixs = preparedInstructions("USDC");
  const widened = guard([
    { pubkey: new PublicKey(DEVNET_USDC), isSigner: false, isWritable: true },
  ]);
  assert.equal(
    refusal(accept(rebuild([...ixs, widened]), "USDC")),
    "message_mismatch:instructions",
  );
});

test("a second required signature is a mismatch", () => {
  const second = guard([
    { pubkey: STRANGER.publicKey, isSigner: true, isWritable: false },
  ]);
  const signed = rebuild([...preparedInstructions(), second], {
    signers: [PAYER, STRANGER],
  });
  assert.equal(refusal(accept(signed)), "message_mismatch:signer_count");
});

test("another fee payer is a mismatch", () => {
  const signed = rebuild(
    [
      SystemProgram.transfer({
        fromPubkey: STRANGER.publicKey,
        toPubkey: DEPOSIT,
        lamports: 250_000_000n,
      }),
      preparedInstructions()[1]!,
    ],
    { feePayer: STRANGER },
  );
  assert.equal(refusal(accept(signed)), "message_mismatch:fee_payer");
});

test("another blockhash is a mismatch", () => {
  const signed = rebuild([feePrice(), ...preparedInstructions()], {
    blockhash: OTHER_BLOCKHASH,
  });
  assert.equal(refusal(accept(signed)), "message_mismatch:blockhash");
});

test("an address lookup table is a mismatch", () => {
  const table = new AddressLookupTableAccount({
    key: Keypair.fromSeed(new Uint8Array(32).fill(26)).publicKey,
    state: {
      deactivationSlot: BigInt("18446744073709551615"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: [DEPOSIT],
    },
  });
  const message = new TransactionMessage({
    payerKey: PAYER.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: preparedInstructions(),
  }).compileToV0Message([table]);
  assert.equal(message.addressTableLookups.length, 1, "the table is used");
  const vtx = new VersionedTransaction(message);
  vtx.sign([PAYER]);
  assert.equal(
    refusal(accept(Buffer.from(vtx.serialize()).toString("base64"))),
    "message_mismatch:lookup_tables",
  );
});

test("a signature made for the prepared bytes does not carry to a changed message", () => {
  const original = VersionedTransaction.deserialize(
    Buffer.from(rebuild(preparedInstructions()), "base64"),
  );
  const changed = VersionedTransaction.deserialize(
    Buffer.from(rebuild([feePrice(), ...preparedInstructions()]), "base64"),
  );
  changed.signatures[0] = original.signatures[0]!;
  assert.equal(
    refusal(accept(Buffer.from(changed.serialize()).toString("base64"))),
    "message_mismatch:invalid_signature",
  );
});

test("a signature by another key is a mismatch, on exact and on rebuilt bytes", () => {
  for (const instructions of [
    preparedInstructions(),
    [feePrice(), ...preparedInstructions()],
  ]) {
    const vtx = VersionedTransaction.deserialize(
      Buffer.from(rebuild(instructions), "base64"),
    );
    vtx.signatures[0] = nacl.sign.detached(vtx.message.serialize(), STRANGER.secretKey);
    assert.equal(
      refusal(accept(Buffer.from(vtx.serialize()).toString("base64"))),
      "message_mismatch:invalid_signature",
    );
  }
});

test("unsigned or unreadable bytes are unreadable_transaction", () => {
  assert.equal(
    refusal(accept(prepared().unsignedTxBase64)),
    "unreadable_transaction:missing_signature",
  );
  assert.equal(
    refusal(accept(Buffer.from("not a transaction").toString("base64"))),
    "unreadable_transaction:unparseable",
  );
  assert.equal(refusal(accept("")), "unreadable_transaction:unparseable");
});

test("signatureOfSignedTransaction reads the signature and nothing else", () => {
  const signed = rebuild(preparedInstructions());
  const again = rebuild(preparedInstructions());
  // Signing is deterministic: the same bytes give the same signature.
  assert.equal(signatureOfSignedTransaction(signed), signatureOfSignedTransaction(again));
  assert.notEqual(
    signatureOfSignedTransaction(signed),
    signatureOfSignedTransaction(rebuild([feePrice(), ...preparedInstructions()])),
  );
  assert.equal(signatureOfSignedTransaction(prepared().unsignedTxBase64), null);
  assert.equal(signatureOfSignedTransaction("%%%"), null);
});
