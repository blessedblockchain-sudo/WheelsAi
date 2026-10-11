/**
 * Drives apps/api/src/services/x402Decode.ts: a signed transaction read as
 * an x402 payment, from its bytes alone.
 *
 * Every transaction here is built and signed in the test with keys made in
 * the test. Nothing is sent anywhere: the module under test is pure.
 *
 * Pinning:
 *   - USDC by plain `transfer` and by `transferChecked` to the treasury's
 *     token account is accepted (the old code read the MINT of a checked
 *     transfer as its destination and refused every one);
 *   - the wrong mint, the wrong decimals, the wallet itself, another
 *     account, another mint's account, another token program and a unit
 *     short are refused;
 *   - SOL to the treasury is accepted; another address or a lamport short
 *     is refused;
 *   - version 0 is accepted, lookup tables are refused;
 *   - every required signature must be present and valid;
 *   - the amount answered is the instruction's own, and two transfers do
 *     not add up; a wallet's compute-budget and memo instructions change
 *     nothing.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import "./unitEnv.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createTransferCheckedInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
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
import bs58 from "bs58";

import { MEMO_PROGRAM_ID } from "../lib/memoProgram.js";
import { decodeX402Payment, x402UsdcTokenAccount } from "../services/x402Decode.js";
import type { DecodeX402Refusal, DecodeX402Result, X402PaymentWanted } from "../services/x402Types.js";

const payer = Keypair.generate();
const treasury = Keypair.generate().publicKey;
const usdcMint = Keypair.generate().publicKey;
const otherMint = Keypair.generate().publicKey;
const stranger = Keypair.generate().publicKey;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

const payerUsdc = getAssociatedTokenAddressSync(usdcMint, payer.publicKey);
const treasuryUsdc = getAssociatedTokenAddressSync(usdcMint, treasury);
const treasuryOtherMint = getAssociatedTokenAddressSync(otherMint, treasury);

function want(asset: "USDC" | "SOL", minAmountRaw: bigint): X402PaymentWanted {
  return { asset, payTo: treasury.toBase58(), usdcMint: usdcMint.toBase58(), minAmountRaw };
}

/** A legacy transaction, signed by the payer and any further signers. */
function legacy(instructions: TransactionInstruction[], signers: Keypair[] = [payer]): string {
  const tx = new Transaction();
  tx.feePayer = signers[0]!.publicKey;
  tx.recentBlockhash = BLOCKHASH;
  tx.add(...instructions);
  tx.sign(...signers);
  return tx.serialize().toString("base64");
}

/** A version 0 transaction, with or without address lookup tables. */
function v0(instructions: TransactionInstruction[], tables: AddressLookupTableAccount[] = []): string {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions,
  }).compileToV0Message(tables);
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  return Buffer.from(tx.serialize()).toString("base64");
}

const plainUsdc = (amount: bigint, destination: PublicKey = treasuryUsdc): TransactionInstruction =>
  createTransferInstruction(payerUsdc, destination, payer.publicKey, amount);

const checkedUsdc = (
  amount: bigint,
  opts: { destination?: PublicKey; mint?: PublicKey; decimals?: number; programId?: PublicKey } = {}
): TransactionInstruction =>
  createTransferCheckedInstruction(
    payerUsdc,
    opts.mint ?? usdcMint,
    opts.destination ?? treasuryUsdc,
    payer.publicKey,
    amount,
    opts.decimals ?? 6,
    [],
    opts.programId ?? TOKEN_PROGRAM_ID
  );

const sol = (lamports: bigint, to: PublicKey = treasury): TransactionInstruction =>
  SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports });

const memo = (text: string): TransactionInstruction =>
  new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(text, "utf8") });

function accepted(result: DecodeX402Result) {
  assert.equal(result.ok, true, result.ok ? "" : `refused: ${result.reason}`);
  if (!result.ok) throw new Error("unreachable");
  return result.payment;
}

function refused(result: DecodeX402Result, reason: DecodeX402Refusal): void {
  assert.deepEqual(result, { ok: false, reason });
}

// ---------------------------------------------------------------------------
// USDC
// ---------------------------------------------------------------------------

test("x402Decode: a plain USDC transfer to the treasury's token account is accepted", () => {
  const signed = legacy([plainUsdc(549n)]);
  const payment = accepted(decodeX402Payment(signed, want("USDC", 549n)));
  assert.equal(payment.asset, "USDC");
  assert.equal(payment.amountRaw, 549n);
  assert.equal(payment.payer, payer.publicKey.toBase58());
  assert.equal(payment.recentBlockhash, BLOCKHASH);
  assert.equal(payment.signedTxB64, signed);
  // The signature is the transaction's first, base58.
  const first = Transaction.from(Buffer.from(signed, "base64")).signature;
  assert.ok(first);
  assert.equal(payment.signature, bs58.encode(first));
});

test("x402Decode: a checked USDC transfer is accepted (its second account is the mint, its third the destination)", () => {
  const ix = checkedUsdc(549n);
  assert.equal(ix.keys[1]?.pubkey.toBase58(), usdcMint.toBase58());
  assert.equal(ix.keys[2]?.pubkey.toBase58(), treasuryUsdc.toBase58());
  const payment = accepted(decodeX402Payment(legacy([ix]), want("USDC", 549n)));
  assert.equal(payment.amountRaw, 549n);
  assert.equal(payment.asset, "USDC");
});

test("x402Decode: a checked transfer naming another mint, or other decimals, is refused", () => {
  refused(decodeX402Payment(legacy([checkedUsdc(549n, { mint: otherMint })]), want("USDC", 549n)), "no_payment");
  refused(decodeX402Payment(legacy([checkedUsdc(549n, { decimals: 9 })]), want("USDC", 549n)), "no_payment");
  refused(decodeX402Payment(legacy([checkedUsdc(549n, { decimals: 0 })]), want("USDC", 549n)), "no_payment");
});

test("x402Decode: USDC sent to the wallet itself, to another account, or to another mint's account is refused", () => {
  for (const destination of [treasury, stranger, payerUsdc, treasuryOtherMint, usdcMint]) {
    refused(decodeX402Payment(legacy([plainUsdc(549n, destination)]), want("USDC", 549n)), "no_payment");
    refused(decodeX402Payment(legacy([checkedUsdc(549n, { destination })]), want("USDC", 549n)), "no_payment");
  }
  // The other mint's account, with the other mint named: still not USDC.
  refused(
    decodeX402Payment(
      legacy([checkedUsdc(549n, { destination: treasuryOtherMint, mint: otherMint })]),
      want("USDC", 549n)
    ),
    "no_payment"
  );
});

test("x402Decode: a USDC transfer one unit short is refused, and the exact amount is not", () => {
  refused(decodeX402Payment(legacy([plainUsdc(548n)]), want("USDC", 549n)), "amount_too_low");
  refused(decodeX402Payment(legacy([checkedUsdc(548n)]), want("USDC", 549n)), "amount_too_low");
  refused(decodeX402Payment(legacy([plainUsdc(0n)]), want("USDC", 1n)), "amount_too_low");
  accepted(decodeX402Payment(legacy([plainUsdc(549n)]), want("USDC", 549n)));
  accepted(decodeX402Payment(legacy([checkedUsdc(549n)]), want("USDC", 549n)));
});

test("x402Decode: a transfer through another token program is not a USDC payment", () => {
  refused(
    decodeX402Payment(legacy([checkedUsdc(549n, { programId: TOKEN_2022_PROGRAM_ID })]), want("USDC", 549n)),
    "no_payment"
  );
});

test("x402Decode: the token account the 402 names is the one the decode accepts", () => {
  assert.equal(x402UsdcTokenAccount(treasury.toBase58(), usdcMint.toBase58()), treasuryUsdc.toBase58());
});

// ---------------------------------------------------------------------------
// SOL
// ---------------------------------------------------------------------------

test("x402Decode: a SOL transfer to the treasury is accepted", () => {
  const signed = legacy([sol(5_490n)]);
  const payment = accepted(decodeX402Payment(signed, want("SOL", 5_490n)));
  assert.equal(payment.asset, "SOL");
  assert.equal(payment.amountRaw, 5_490n);
  assert.equal(payment.payer, payer.publicKey.toBase58());
  assert.equal(payment.signedTxB64, signed);
});

test("x402Decode: a SOL transfer to another address, or a lamport short, is refused", () => {
  refused(decodeX402Payment(legacy([sol(5_490n, stranger)]), want("SOL", 5_490n)), "no_payment");
  refused(decodeX402Payment(legacy([sol(5_490n, treasuryUsdc)]), want("SOL", 5_490n)), "no_payment");
  refused(decodeX402Payment(legacy([sol(5_489n)]), want("SOL", 5_490n)), "amount_too_low");
});

test("x402Decode: the asset paid must be the asset asked for", () => {
  refused(decodeX402Payment(legacy([sol(5_490n)]), want("USDC", 549n)), "no_payment");
  refused(decodeX402Payment(legacy([plainUsdc(549n)]), want("SOL", 549n)), "no_payment");
  refused(decodeX402Payment(legacy([checkedUsdc(549n)]), want("SOL", 549n)), "no_payment");
});

test("x402Decode: another System Program instruction to the treasury is not a transfer", () => {
  const assign = SystemProgram.assign({ accountPubkey: payer.publicKey, programId: treasury });
  refused(decodeX402Payment(legacy([assign]), want("SOL", 1n)), "no_payment");
  refused(decodeX402Payment(legacy([memo("pay the treasury 5490")]), want("SOL", 1n)), "no_payment");
});

// ---------------------------------------------------------------------------
// The amount
// ---------------------------------------------------------------------------

test("x402Decode: the amount read is the instruction's own, more than the minimum included", () => {
  assert.equal(accepted(decodeX402Payment(legacy([plainUsdc(1_000_000n)]), want("USDC", 549n))).amountRaw, 1_000_000n);
  assert.equal(accepted(decodeX402Payment(legacy([checkedUsdc(700n)]), want("USDC", 549n))).amountRaw, 700n);
  assert.equal(accepted(decodeX402Payment(legacy([sol(9_999n)]), want("SOL", 5_490n))).amountRaw, 9_999n);
  // Past what a float holds exactly.
  const large = 9_007_199_254_740_993n;
  assert.equal(accepted(decodeX402Payment(legacy([plainUsdc(large)]), want("USDC", 549n))).amountRaw, large);
});

test("x402Decode: two transfers to us do not add up; one instruction must carry the amount", () => {
  refused(decodeX402Payment(legacy([plainUsdc(300n), checkedUsdc(300n)]), want("USDC", 549n)), "amount_too_low");
  refused(decodeX402Payment(legacy([sol(3_000n), sol(3_000n)]), want("SOL", 5_490n)), "amount_too_low");
  // With one that carries it, that one is the amount read, wherever it sits.
  assert.equal(
    accepted(decodeX402Payment(legacy([plainUsdc(10n), checkedUsdc(600n), plainUsdc(20n)]), want("USDC", 549n)))
      .amountRaw,
    600n
  );
  // A transfer elsewhere beside the payment changes nothing.
  assert.equal(
    accepted(decodeX402Payment(legacy([sol(1n, stranger), sol(5_490n)]), want("SOL", 5_490n))).amountRaw,
    5_490n
  );
});

test("x402Decode: a wallet's compute-budget and memo instructions change nothing", () => {
  const extras = (payment: TransactionInstruction): TransactionInstruction[] => [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
    payment,
    memo("deployment:dep_1;request:req_1"),
  ];
  for (const build of [legacy, v0]) {
    assert.equal(accepted(decodeX402Payment(build(extras(plainUsdc(549n))), want("USDC", 549n))).amountRaw, 549n);
    assert.equal(accepted(decodeX402Payment(build(extras(checkedUsdc(549n))), want("USDC", 549n))).amountRaw, 549n);
    assert.equal(accepted(decodeX402Payment(build(extras(sol(5_490n))), want("SOL", 5_490n))).amountRaw, 5_490n);
    // They do not make a short payment enough, or a missing one present.
    refused(decodeX402Payment(build(extras(plainUsdc(548n))), want("USDC", 549n)), "amount_too_low");
    refused(decodeX402Payment(build(extras(sol(5_490n, stranger))), want("SOL", 5_490n)), "no_payment");
  }
});

// ---------------------------------------------------------------------------
// Versions and lookup tables
// ---------------------------------------------------------------------------

test("x402Decode: a version 0 transaction is accepted", () => {
  const signedUsdc = v0([checkedUsdc(549n)]);
  assert.equal(VersionedTransaction.deserialize(Buffer.from(signedUsdc, "base64")).version, 0);
  const usdc = accepted(decodeX402Payment(signedUsdc, want("USDC", 549n)));
  assert.equal(usdc.amountRaw, 549n);
  assert.equal(usdc.payer, payer.publicKey.toBase58());
  assert.equal(usdc.recentBlockhash, BLOCKHASH);
  assert.equal(usdc.signedTxB64, signedUsdc);
  assert.equal(
    usdc.signature,
    bs58.encode(VersionedTransaction.deserialize(Buffer.from(signedUsdc, "base64")).signatures[0]!)
  );
  assert.equal(accepted(decodeX402Payment(v0([plainUsdc(549n)]), want("USDC", 549n))).amountRaw, 549n);
  assert.equal(accepted(decodeX402Payment(v0([sol(5_490n)]), want("SOL", 5_490n))).amountRaw, 5_490n);
});

test("x402Decode: a transaction that uses address lookup tables is refused", () => {
  const table = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: BigInt("18446744073709551615"),
      lastExtendedSlot: 1,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: [treasuryUsdc, treasury, usdcMint],
    },
  });
  const signedUsdc = v0([checkedUsdc(549n)], [table]);
  assert.ok(
    VersionedTransaction.deserialize(Buffer.from(signedUsdc, "base64")).message.addressTableLookups.length > 0,
    "the test transaction does load from a table"
  );
  refused(decodeX402Payment(signedUsdc, want("USDC", 549n)), "uses_lookup_tables");
  refused(decodeX402Payment(v0([sol(5_490n)], [table]), want("SOL", 5_490n)), "uses_lookup_tables");
});

test("x402Decode: a transaction on a durable nonce is refused: it would not die with its blockhash", () => {
  const advance = SystemProgram.nonceAdvance({
    noncePubkey: Keypair.generate().publicKey,
    authorizedPubkey: payer.publicKey,
  });
  for (const build of [legacy, v0]) {
    refused(decodeX402Payment(build([advance, sol(5_490n)]), want("SOL", 5_490n)), "no_payment");
    refused(decodeX402Payment(build([advance, checkedUsdc(549n)]), want("USDC", 549n)), "no_payment");
    refused(decodeX402Payment(build([advance, plainUsdc(549n)]), want("USDC", 549n)), "no_payment");
    // Wherever the instruction sits.
    refused(decodeX402Payment(build([sol(5_490n), advance]), want("SOL", 5_490n)), "no_payment");
    // The same payment without it is taken.
    accepted(decodeX402Payment(build([sol(5_490n)]), want("SOL", 5_490n)));
  }
});

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

test("x402Decode: an unsigned transaction is refused", () => {
  const tx = new Transaction();
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = BLOCKHASH;
  tx.add(plainUsdc(549n));
  const unsigned = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  refused(decodeX402Payment(unsigned, want("USDC", 549n)), "bad_signature");

  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [sol(5_490n)],
  }).compileToV0Message();
  const unsignedV0 = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
  refused(decodeX402Payment(unsignedV0, want("SOL", 5_490n)), "bad_signature");
});

test("x402Decode: a wrongly signed transaction is refused", () => {
  // Signed by someone who is not the fee payer.
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [checkedUsdc(549n)],
  }).compileToV0Message();
  const forged = new VersionedTransaction(message);
  const impostor = Keypair.generate();
  const other = new VersionedTransaction(
    new TransactionMessage({
      payerKey: impostor.publicKey,
      recentBlockhash: BLOCKHASH,
      instructions: [sol(1n)],
    }).compileToV0Message()
  );
  other.sign([impostor]);
  forged.signatures[0] = other.signatures[0]!;
  refused(decodeX402Payment(Buffer.from(forged.serialize()).toString("base64"), want("USDC", 549n)), "bad_signature");

  // A good signature, then the amount changed after signing.
  const bytes = Buffer.from(legacy([sol(5_490n)]), "base64");
  const tampered = Buffer.from(bytes);
  tampered[tampered.length - 8] = (tampered[tampered.length - 8]! + 1) & 0xff;
  assert.notDeepEqual(tampered, bytes);
  refused(decodeX402Payment(tampered.toString("base64"), want("SOL", 5_490n)), "bad_signature");

  // One flipped bit in the signature.
  const flipped = Buffer.from(bytes);
  flipped[5] = flipped[5]! ^ 0x01;
  refused(decodeX402Payment(flipped.toString("base64"), want("SOL", 5_490n)), "bad_signature");
});

test("x402Decode: every required signature must be there, and the payer is the fee payer", () => {
  // The fee payer pays the fee; another wallet owns the tokens and signs too.
  const owner = Keypair.generate();
  const ownerUsdc = getAssociatedTokenAddressSync(usdcMint, owner.publicKey);
  const ix = createTransferCheckedInstruction(ownerUsdc, usdcMint, treasuryUsdc, owner.publicKey, 549n, 6);

  const both = legacy([ix], [payer, owner]);
  const payment = accepted(decodeX402Payment(both, want("USDC", 549n)));
  assert.equal(payment.payer, payer.publicKey.toBase58());
  assert.equal(payment.signature, bs58.encode(Transaction.from(Buffer.from(both, "base64")).signature!));

  // The same transaction with only the fee payer's signature.
  const tx = new Transaction();
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = BLOCKHASH;
  tx.add(ix);
  tx.partialSign(payer);
  const half = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  refused(decodeX402Payment(half, want("USDC", 549n)), "bad_signature");
});

// ---------------------------------------------------------------------------
// Things that are not transactions, and wants that cannot be met
// ---------------------------------------------------------------------------

test("x402Decode: what is not a transaction is refused and nothing is thrown", () => {
  const junk: unknown[] = [
    "",
    "   ",
    "not base64 at all!",
    "AAAA",
    Buffer.from("hello world, this is not a transaction").toString("base64"),
    Buffer.alloc(300, 0xff).toString("base64"),
    bs58.encode(Buffer.from(legacy([sol(5_490n)]), "base64")),
    undefined,
    null,
    42,
    {},
  ];
  for (const input of junk) {
    const result = decodeX402Payment(input as string, want("SOL", 5_490n));
    assert.equal(result.ok, false, `accepted ${String(input).slice(0, 20)}`);
    if (!result.ok) assert.ok(["not_a_transaction", "bad_signature"].includes(result.reason), result.reason);
  }
  refused(decodeX402Payment("", want("SOL", 1n)), "not_a_transaction");
  refused(decodeX402Payment("not base64 at all!", want("SOL", 1n)), "not_a_transaction");
  // A good transaction cut short.
  const good = legacy([sol(5_490n)]);
  refused(decodeX402Payment(good.slice(0, 80), want("SOL", 5_490n)), "not_a_transaction");
});

test("x402Decode: a want that cannot be met takes no payment", () => {
  const signed = legacy([sol(5_490n)]);
  refused(decodeX402Payment(signed, want("SOL", 0n)), "no_payment");
  refused(decodeX402Payment(signed, want("SOL", -1n)), "no_payment");
  refused(decodeX402Payment(signed, { ...want("SOL", 1n), minAmountRaw: 1 as unknown as bigint }), "no_payment");
  refused(decodeX402Payment(signed, { ...want("SOL", 1n), payTo: "not an address" }), "no_payment");
  refused(decodeX402Payment(signed, { ...want("SOL", 1n), usdcMint: "" }), "no_payment");
  refused(decodeX402Payment(signed, { ...want("SOL", 1n), asset: "NOS" as "SOL" }), "no_payment");
});

test("x402Decode: the module is pure: no settings, no connection, no byte offsets into token data", () => {
  const source = readFileSync(new URL("../services/x402Decode.ts", import.meta.url), "utf8");
  assert.equal(/process\.env|config\/env|lib\/solana\.js|new Connection|getSolanaConnection/.test(source), false);
  assert.equal(/readBigUInt64LE|readUInt8|\.data\[\d/.test(source), false, "reads instruction bytes by offset");
  assert.ok(/decodeTransferCheckedInstruction/.test(source) && /decodeTransferInstruction/.test(source));
});
