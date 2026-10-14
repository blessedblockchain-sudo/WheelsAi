import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { TOKEN_2022_PROGRAM_ID, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import nacl from "tweetnacl";

import { MEMO_PROGRAM_ID } from "../lib/memoProgram.js";
import { usdcMintForNetwork } from "../lib/solanaAssets.js";
import {
  LIGHTHOUSE_PROGRAM_ID,
  X402_MAX_COMPUTE_UNIT_LIMIT,
  X402_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  verifyExactSvmTransaction,
  type ExactSvmVerification,
} from "../services/x402ExactSvm.js";
import { X402_ERROR_REASONS as R, listingRequirements, makeX402Memo, type PaymentRequirements } from "../services/x402Wire.js";
import {
  aBlockhash,
  exactPayment,
  keypairOf,
  lighthouseInstruction,
  memoInstruction,
  signWithNonce,
  withSignature,
  withSPlusL,
  type ExactPaymentInput,
} from "./x402DoorStandIns.js";

// The checks of one payment in the published "exact" scheme on Solana, run
// against the transaction a real x402 client builds: for each check, a
// valid payment changed in exactly one way is refused with exactly its
// reference string, and every shape a real wallet sends passes.

const MINT = usdcMintForNetwork("devnet");
const TREASURY = keypairOf(7).publicKey;
const FEE_PAYER = keypairOf(9);
const PAYER = keypairOf(3);
const LISTING = "4f8b1c2d-0000-4000-8000-00000000c0de";
const AMOUNT = 50_000n;
const { memo: MEMO } = makeX402Memo({
  listingId: LISTING,
  amount: AMOUNT.toString(),
  secret: "a-test-secret-of-some-length",
  nonceBytes: new Uint8Array(6).fill(5),
});

const REQUIREMENTS: PaymentRequirements = listingRequirements({
  network: "devnet",
  priceCents: 5n,
  asset: MINT.toBase58(),
  payTo: TREASURY.toBase58(),
  feePayer: FEE_PAYER.publicKey.toBase58(),
  memo: MEMO,
});

function input(over: Partial<ExactPaymentInput> = {}): ExactPaymentInput {
  return {
    payer: PAYER,
    feePayer: FEE_PAYER.publicKey,
    payTo: TREASURY,
    mint: MINT,
    amount: AMOUNT,
    memo: MEMO,
    blockhash: aBlockhash(),
    ...over,
  };
}

function check(transactionB64: string, requirements = REQUIREMENTS, feePayer = FEE_PAYER.publicKey.toBase58()): ExactSvmVerification {
  return verifyExactSvmTransaction(transactionB64, requirements, { feePayer });
}

function refused(over: Partial<ExactPaymentInput>, reason: string, why: string) {
  const result = check(exactPayment(input(over)));
  assert.deepEqual(result, { isValid: false, invalidReason: reason }, why);
}

const SOURCE = getAssociatedTokenAddressSync(MINT, PAYER.publicKey);
const DESTINATION = getAssociatedTokenAddressSync(MINT, TREASURY, true);

// ============================================
// What passes
// ============================================

test("a real client's payment passes: version 0 and legacy, with 0, 1 and 2 Lighthouse instructions", () => {
  for (const legacy of [false, true]) {
    for (const lighthouse of [0, 1, 2] as const) {
      const blockhash = aBlockhash();
      const b64 = exactPayment(input({ legacy, lighthouse, blockhash }));
      const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
      // What a real client hands over: slot 0 empty, the payer's signature in slot 1.
      assert.equal(tx.message.header.numRequiredSignatures, 2);
      assert.ok(tx.signatures[0]!.every((b) => b === 0));
      const result = check(b64);
      assert.deepEqual(
        result,
        {
          isValid: true,
          payer: PAYER.publicKey.toBase58(),
          messageHash: createHash("sha256").update(tx.message.serialize()).digest("hex"),
          source: SOURCE.toBase58(),
          destination: DESTINATION.toBase58(),
          recentBlockhash: blockhash,
        },
        `legacy ${legacy}, lighthouse ${lighthouse}`,
      );
      // The payer is the transfer's authority, never keys[0] (the fee payer).
      assert.notEqual(result.isValid && result.payer, tx.message.staticAccountKeys[0]!.toBase58());
    }
  }
});

test("the numbers of the checker, each written once", () => {
  // The tests below use the constants, so a cap raised or an id mistyped
  // would pass them all: these hold the values themselves.
  assert.equal(X402_MAX_COMPUTE_UNIT_LIMIT, 200_000);
  assert.equal(X402_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS, 50_000n);
  assert.equal(LIGHTHOUSE_PROGRAM_ID, "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
});

test("the caps themselves pass, and a Lighthouse instruction may come before the Memo too", () => {
  assert.equal(check(exactPayment(input({ unitLimit: X402_MAX_COMPUTE_UNIT_LIMIT }))).isValid, true);
  assert.equal(check(exactPayment(input({ microLamports: X402_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS }))).isValid, true);
  // The stand-in appends a wallet's instructions after the Memo; a client may
  // also build them in first. [limit, price, transfer, Lighthouse, Memo].
  const lighthouseFirst = exactPayment(
    input({ change: (ixs) => [ixs[0]!, ixs[1]!, ixs[2]!, lighthouseInstruction(SOURCE), ixs[3]!] }),
  );
  assert.equal(check(lighthouseFirst).isValid, true);
});

test("Solflare's order passes: the Memo at [3], then two Lighthouse instructions, one of them at [5]", () => {
  const b64 = exactPayment(input({ lighthouse: 2 }));
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  const programs = tx.message.compiledInstructions.map((ix) => tx.message.staticAccountKeys[ix.programIdIndex]!.toBase58());
  assert.equal(programs.length, 6);
  assert.equal(programs[3], MEMO_PROGRAM_ID.toBase58());
  assert.equal(programs[4], "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
  assert.equal(programs[5], "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
  assert.equal(check(b64).isValid, true);
});

test("one message under another valid payer signature answers the same message hash", () => {
  const b64 = exactPayment(input());
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  const message = tx.message.serialize();
  const original = tx.signatures[1]!;

  const otherNonce = signWithNonce(message, PAYER, 123_456_789n);
  assert.notDeepEqual(Buffer.from(otherNonce), Buffer.from(original));
  // A valid signature of the same message.
  assert.equal(nacl.sign.detached.verify(message, otherNonce, PAYER.publicKey.toBytes()), true);
  const hashes = [b64, withSignature(b64, 1, otherNonce)].map((t) => {
    const result = check(t);
    assert.equal(result.isValid, true);
    return result.isValid ? result.messageHash : "";
  });
  assert.equal(new Set(hashes).size, 1);
  assert.equal(hashes[0], createHash("sha256").update(message).digest("hex"));
});

test("a payer signature whose S is not below the group's order is refused: the chain would refuse it", () => {
  const b64 = exactPayment(input());
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  const sPlusL = withSPlusL(tx.signatures[1]!);
  // tweetnacl accepts it, so only the check of S keeps it out.
  assert.equal(nacl.sign.detached.verify(tx.message.serialize(), sPlusL, PAYER.publicKey.toBytes()), true);
  assert.deepEqual(check(withSignature(b64, 1, sPlusL)), { isValid: false, invalidReason: R.transactionSimulationFailed });
});

// ============================================
// What is refused, one change at a time
// ============================================

test("bytes that do not decode", () => {
  const good = exactPayment(input());
  for (const bad of ["", "   ", "not base64 at all!", good.slice(0, 80), Buffer.from("hello").toString("base64")]) {
    assert.deepEqual(check(bad), { isValid: false, invalidReason: R.couldNotBeDecoded }, bad);
  }
  // Bytes after the transaction: what is checked must be exactly what was handed in.
  const trailing = Buffer.concat([Buffer.from(good, "base64"), Buffer.from([0])]).toString("base64");
  assert.deepEqual(check(trailing), { isValid: false, invalidReason: R.couldNotBeDecoded });
  assert.deepEqual(check(42 as unknown as string), { isValid: false, invalidReason: R.couldNotBeDecoded });
});

test("a lookup table", () => {
  // The mint loaded from a table: the reads below could not see it.
  refused({ lookupAddresses: [MINT] }, R.couldNotBeDecoded, "lookup table");
});

test("the signatures: a count other than two, a fee payer that is not ours, a slot 0 already signed, a payer signature that does not verify", () => {
  const third = keypairOf(21);
  refused(
    {
      change: (ixs) => [...ixs.slice(0, 3), lighthouseInstruction(SOURCE, 0, [{ pubkey: third.publicKey, isSigner: true, isWritable: false }]), ...ixs.slice(3)],
      signers: [PAYER, third],
    },
    R.missingFeePayer,
    "three required signatures",
  );
  // The old path's payment: the payer is its own fee payer and signs alone.
  refused({ feePayer: PAYER.publicKey }, R.missingFeePayer, "one required signature");

  const stranger = keypairOf(22);
  refused({ feePayer: stranger.publicKey }, R.feePayerNotManaged, "another fee payer");
  // Requirements that name another fee payer than the one handed in.
  const theirs = { ...REQUIREMENTS, extra: { ...REQUIREMENTS.extra, feePayer: stranger.publicKey.toBase58() } };
  assert.deepEqual(check(exactPayment(input()), theirs), { isValid: false, invalidReason: R.feePayerNotManaged });

  // Slot 0 already filled: signed by the fee payer's own key, so it could land as it is.
  refused({ signers: [PAYER, FEE_PAYER] }, R.invalidTransactionState, "a fee payer slot already signed");

  const good = exactPayment(input());
  const tx = VersionedTransaction.deserialize(Buffer.from(good, "base64"));
  const broken = new Uint8Array(tx.signatures[1]!);
  broken[10] = (broken[10] ?? 0) ^ 1;
  assert.deepEqual(check(withSignature(good, 1, broken)), { isValid: false, invalidReason: R.transactionSimulationFailed });
});

test("an instruction that cannot be resolved from the message's own accounts, or that runs as the fee payer", () => {
  refused(
    {
      compiled: (message) => {
        message.compiledInstructions[3]!.programIdIndex = message.staticAccountKeys.length + 4;
      },
    },
    R.couldNotBeDecoded,
    "program index outside the static keys",
  );
  refused(
    {
      compiled: (message) => {
        message.compiledInstructions[3]!.accountKeyIndexes = [message.staticAccountKeys.length + 1];
      },
    },
    R.couldNotBeDecoded,
    "account index outside the static keys",
  );
  refused(
    {
      compiled: (message) => {
        message.compiledInstructions[3]!.programIdIndex = 0;
      },
    },
    R.couldNotBeDecoded,
    "program index 0, the fee payer",
  );
});

test("a durable nonce", () => {
  const nonceAccount = keypairOf(30).publicKey;
  refused(
    {
      change: (ixs) => [
        SystemProgram.nonceAdvance({ noncePubkey: nonceAccount, authorizedPubkey: PAYER.publicKey }),
        ...ixs,
      ],
    },
    R.invalidTransactionState,
    "AdvanceNonce",
  );
});

test("the count of instructions", () => {
  refused({ change: (ixs) => [ixs[0]!, ixs[2]!] }, R.instructionsLength, "two");
  refused(
    {
      lighthouse: 2,
      change: (ixs) => [...ixs, memoInstruction("one more")],
    },
    R.instructionsLength,
    "seven",
  );
});

test("the compute budget: order, layout and caps", () => {
  refused({ change: (ixs) => [ixs[1]!, ixs[0]!, ...ixs.slice(2)] }, R.computeLimitInstruction, "price before limit");
  refused({ unitLimit: X402_MAX_COMPUTE_UNIT_LIMIT + 1 }, R.computeLimitInstruction, "a limit one over the cap");
  refused({ microLamports: X402_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS + 1n }, R.computePriceTooHigh, "a price one over the cap");
  const trailing = (ix: TransactionInstruction) =>
    new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data: Buffer.concat([ix.data, Buffer.from([0])]) });
  refused({ change: (ixs) => [trailing(ixs[0]!), ...ixs.slice(1)] }, R.computeLimitInstruction, "a limit with a trailing byte");
  refused({ change: (ixs) => [ixs[0]!, trailing(ixs[1]!), ...ixs.slice(2)] }, R.computePriceInstruction, "a price with a trailing byte");
  refused(
    { change: (ixs) => [ixs[0]!, ComputeBudgetProgram.requestHeapFrame({ bytes: 32 * 1024 }), ...ixs.slice(2)] },
    R.computePriceInstruction,
    "another compute budget instruction at [1]",
  );
});

test("the transfer: only a classic TransferChecked of 6 decimals with no multisig signers", () => {
  const destination = DESTINATION;
  refused(
    {
      change: (ixs) => [
        ixs[0]!,
        ixs[1]!,
        createTransferCheckedInstruction(SOURCE, MINT, destination, PAYER.publicKey, AMOUNT, 6, [], TOKEN_2022_PROGRAM_ID),
        ...ixs.slice(3),
      ],
    },
    R.noTransferInstruction,
    "Token-2022",
  );
  refused(
    {
      change: (ixs) => [
        ixs[0]!,
        ixs[1]!,
        createTransferCheckedInstruction(SOURCE, MINT, destination, PAYER.publicKey, AMOUNT, 9),
        ...ixs.slice(3),
      ],
    },
    R.noTransferInstruction,
    "nine decimals",
  );
  const multisig = keypairOf(40).publicKey;
  refused(
    {
      change: (ixs) => [
        ixs[0]!,
        ixs[1]!,
        createTransferCheckedInstruction(SOURCE, MINT, destination, multisig, AMOUNT, 6, [PAYER.publicKey]),
        ...ixs.slice(3),
      ],
    },
    R.noTransferInstruction,
    "a multisig transfer",
  );
  // The transfer's authority is not the wallet that signed slot 1.
  const signer = keypairOf(41);
  refused(
    {
      change: (ixs) => {
        const transfer = createTransferCheckedInstruction(SOURCE, MINT, destination, PAYER.publicKey, AMOUNT, 6);
        transfer.keys[3] = { pubkey: PAYER.publicKey, isSigner: false, isWritable: false };
        return [
          ixs[0]!,
          ixs[1]!,
          transfer,
          lighthouseInstruction(SOURCE, 0, [{ pubkey: signer.publicKey, isSigner: true, isWritable: false }]),
          ixs[3]!,
        ];
      },
      signers: [signer],
    },
    R.noTransferInstruction,
    "an authority that is not staticAccountKeys[1]",
  );
});

test("the instructions after the transfer: only Memo or Lighthouse at [3], [4] and [5]", () => {
  const other = SystemProgram.transfer({ fromPubkey: PAYER.publicKey, toPubkey: TREASURY, lamports: 1 });
  refused({ change: (ixs) => [...ixs.slice(0, 3), other, ixs[3]!] }, R.unknownFourthInstruction, "a fourth");
  refused({ change: (ixs) => [...ixs, other] }, R.unknownFifthInstruction, "a fifth");
  refused({ lighthouse: 1, change: (ixs) => [...ixs, other] }, R.unknownSixthInstruction, "a sixth");
  // Seven instructions are too many, even when each is a Lighthouse.
  refused({ lighthouse: 2, change: (ixs) => [...ixs, lighthouseInstruction(SOURCE, 9)] }, R.instructionsLength, "a seventh");
});

test("the memo: exactly one, and exactly the text asked for", () => {
  refused({ change: (ixs) => ixs.filter((_, i) => i !== 3).concat(lighthouseInstruction(SOURCE)) }, R.memoCount, "no Memo");
  refused({ change: (ixs) => [...ixs, memoInstruction(MEMO)] }, R.memoCount, "two Memos");
  refused({ memo: `${MEMO}x` }, R.memoMismatch, "a Memo with other bytes");
  refused(
    { change: (ixs) => [...ixs.slice(0, 3), new TransactionInstruction({ programId: ixs[3]!.programId, keys: [], data: Buffer.from([0xff, 0xfe]) })] },
    R.memoMismatch,
    "a Memo that is not UTF-8",
  );
  // A decoder would drop a leading byte-order mark and read exactly the memo.
  refused(
    {
      change: (ixs) => [
        ...ixs.slice(0, 3),
        new TransactionInstruction({
          programId: ixs[3]!.programId,
          keys: [],
          data: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(MEMO, "utf8")]),
        }),
      ],
    },
    R.memoMismatch,
    "a Memo with a byte-order mark before the memo",
  );
});

test("the fee payer moves nothing: in any instruction's accounts, as the source, as the authority", () => {
  refused(
    { change: (ixs) => [...ixs, lighthouseInstruction(FEE_PAYER.publicKey)] },
    R.feePayerTransferringFunds,
    "in a Lighthouse instruction's accounts",
  );
  refused(
    {
      change: (ixs) => [
        ixs[0]!,
        ixs[1]!,
        createTransferCheckedInstruction(FEE_PAYER.publicKey, MINT, DESTINATION, PAYER.publicKey, AMOUNT, 6),
        ixs[3]!,
      ],
    },
    R.feePayerTransferringFunds,
    "as the source",
  );
  refused(
    {
      change: (ixs) => [
        ixs[0]!,
        ixs[1]!,
        createTransferCheckedInstruction(getAssociatedTokenAddressSync(MINT, FEE_PAYER.publicKey), MINT, DESTINATION, FEE_PAYER.publicKey, AMOUNT, 6),
        // The payer still signs slot 1, so only the authority is wrong.
        lighthouseInstruction(SOURCE, 0, [{ pubkey: PAYER.publicKey, isSigner: true, isWritable: false }]),
        ixs[3]!,
      ],
    },
    R.feePayerTransferringFunds,
    "as the authority",
  );
});

test("what is paid, to whom: the mint, the destination, the amount exactly", () => {
  const otherMint = usdcMintForNetwork("mainnet-beta");
  refused({ mint: otherMint }, R.mintMismatch, "another mint");
  refused(
    {
      change: (ixs) => [
        ixs[0]!,
        ixs[1]!,
        // The treasury wallet itself, not its token account.
        createTransferCheckedInstruction(SOURCE, MINT, TREASURY, PAYER.publicKey, AMOUNT, 6),
        ixs[3]!,
      ],
    },
    R.recipientMismatch,
    "the wallet instead of its token account",
  );
  refused({ payTo: keypairOf(50).publicKey }, R.recipientMismatch, "another owner's token account");
  refused(
    {
      change: (ixs) => [
        ixs[0]!,
        ixs[1]!,
        // From payTo's own token account to itself: the right destination, and nothing paid.
        createTransferCheckedInstruction(DESTINATION, MINT, DESTINATION, PAYER.publicKey, AMOUNT, 6),
        ixs[3]!,
      ],
    },
    R.recipientMismatch,
    "payTo's account paying itself",
  );
  refused({ amount: AMOUNT + 1n }, R.amountMismatch, "one unit over");
  refused({ amount: AMOUNT - 1n }, R.amountMismatch, "one unit under");
});

test("requirements that cannot be met take no payment", () => {
  const good = exactPayment(input());
  assert.deepEqual(check(good, { ...REQUIREMENTS, amount: "0" }), { isValid: false, invalidReason: R.amountMismatch });
  assert.deepEqual(check(good, { ...REQUIREMENTS, amount: "5e4" }), { isValid: false, invalidReason: R.amountMismatch });
  assert.deepEqual(check(good, { ...REQUIREMENTS, payTo: "not an address" }), { isValid: false, invalidReason: R.recipientMismatch });
  assert.deepEqual(check(good, REQUIREMENTS, "not an address"), { isValid: false, invalidReason: R.feePayerNotManaged });
});

test("the checker never throws, whatever it is handed", () => {
  const good = exactPayment(input());
  for (const requirements of [null, {}, { extra: null }] as unknown as PaymentRequirements[]) {
    const result = check(good, requirements);
    assert.deepEqual(result, { isValid: false, invalidReason: R.unexpectedVerifyError });
  }
});
