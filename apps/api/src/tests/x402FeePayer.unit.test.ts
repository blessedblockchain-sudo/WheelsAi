import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ComputeBudgetProgram, Keypair, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

import { usdcMintForNetwork } from "../lib/solanaAssets.js";
import { deriveCreatorKeypair } from "../services/creatorKeypairs.js";
import { derivePayoutKeypair } from "../services/payoutKeypair.js";
import { deriveTopupDepositKeypair } from "../services/topupKeypairs.js";
import { deriveTreasuryKeypair } from "../services/treasuryKeypairs.js";
import {
  X402_FEE_PAYER_INFO,
  X402_FEE_PAYER_SALT,
  deriveX402FeePayerKeypair,
  signAsFeePayer,
  type FeePayerSigned,
} from "../services/x402FeePayer.js";
import { X402_ERROR_REASONS as R, listingRequirements, makeX402Memo, type PaymentRequirements } from "../services/x402Wire.js";
import { aBlockhash, exactPayment, keypairOf, lighthouseInstruction, type ExactPaymentInput } from "./x402DoorStandIns.js";

// The fee payer of the x402 door: a wallet of its own, and a signature given
// only to a payment that passes every check, checked again on the very bytes
// it signs.

const MASTER_KEY = "m".repeat(32);
const FEE_PAYER = deriveX402FeePayerKeypair(MASTER_KEY);
const MINT = usdcMintForNetwork("devnet");
const TREASURY = keypairOf(7).publicKey;
const PAYER = keypairOf(3);
const LISTING = "4f8b1c2d-0000-4000-8000-00000000fee1";
const AMOUNT = 50_000n;
const { memo: MEMO } = makeX402Memo({
  listingId: LISTING,
  amount: AMOUNT.toString(),
  secret: "a-test-secret-of-some-length",
  nonceBytes: new Uint8Array(16).fill(4),
});

function requirementsFor(feePayer: Keypair): PaymentRequirements {
  return listingRequirements({
    network: "devnet",
    priceCents: 5n,
    asset: MINT.toBase58(),
    payTo: TREASURY.toBase58(),
    feePayer: feePayer.publicKey.toBase58(),
    memo: MEMO,
  });
}

const REQUIREMENTS = requirementsFor(FEE_PAYER);

function payment(over: Partial<ExactPaymentInput> = {}): string {
  return exactPayment({
    payer: PAYER,
    feePayer: FEE_PAYER.publicKey,
    payTo: TREASURY,
    mint: MINT,
    amount: AMOUNT,
    memo: MEMO,
    blockhash: aBlockhash(),
    ...over,
  });
}

function signed(result: ReturnType<typeof signAsFeePayer>): FeePayerSigned {
  assert.ok("txSignature" in result, `refused: ${"invalidReason" in result ? result.invalidReason : ""}`);
  return result;
}

// ============================================
// The wallet
// ============================================

test("the fee payer's salt and info are its own", () => {
  assert.equal(X402_FEE_PAYER_SALT, "wheelsai-x402-fee-payer-v1");
  assert.equal(X402_FEE_PAYER_INFO, "x402-fee-payer");
});

test("the same master key gives the same fee payer, and another key another", () => {
  assert.equal(deriveX402FeePayerKeypair(MASTER_KEY).publicKey.toBase58(), FEE_PAYER.publicKey.toBase58());
  assert.notEqual(deriveX402FeePayerKeypair("n".repeat(32)).publicKey.toBase58(), FEE_PAYER.publicKey.toBase58());
});

test("the fee payer is none of the other wallets of the same master key", () => {
  const ours = FEE_PAYER.publicKey.toBase58();
  // The per-row families are asked for the fee payer's own info as their id:
  // only the salt keeps them apart, which is what this holds.
  const others = {
    payout: derivePayoutKeypair(MASTER_KEY),
    treasury: deriveTreasuryKeypair({ masterKey: MASTER_KEY, treasuryId: X402_FEE_PAYER_INFO }),
    creator: deriveCreatorKeypair({ masterKey: MASTER_KEY, orgId: X402_FEE_PAYER_INFO }),
    topup: deriveTopupDepositKeypair({ masterKey: MASTER_KEY, orgId: X402_FEE_PAYER_INFO }),
  };
  for (const [name, keypair] of Object.entries(others)) {
    assert.notEqual(keypair.publicKey.toBase58(), ours, name);
  }
});

test("a master key under 32 characters is refused, and an empty one", () => {
  assert.throws(() => deriveX402FeePayerKeypair("k".repeat(31)), /at least 32 characters/);
  assert.throws(() => deriveX402FeePayerKeypair(""), /required/);
  assert.doesNotThrow(() => deriveX402FeePayerKeypair("k".repeat(32)));
});

// ============================================
// Signing
// ============================================

test("a real client's payment is signed in place: both signatures verify over the same message", () => {
  for (const legacy of [false, true]) {
    for (const lighthouse of [0, 2] as const) {
      const b64 = payment({ legacy, lighthouse });
      const before = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
      const result = signed(signAsFeePayer(b64, REQUIREMENTS, FEE_PAYER));

      const after = VersionedTransaction.deserialize(Buffer.from(result.signedTxB64, "base64"));
      const message = after.message.serialize();
      // The message is the one the payer signed, byte for byte.
      assert.deepEqual(Buffer.from(message), Buffer.from(before.message.serialize()));
      assert.ok(nacl.sign.detached.verify(message, after.signatures[0]!, FEE_PAYER.publicKey.toBytes()), "fee payer");
      assert.ok(nacl.sign.detached.verify(message, after.signatures[1]!, PAYER.publicKey.toBytes()), "payer");
      // The payer's signature is kept as it came.
      assert.deepEqual(Buffer.from(after.signatures[1]!), Buffer.from(before.signatures[1]!));
      assert.equal(result.payer, PAYER.publicKey.toBase58());
      assert.equal(result.txSignature, bs58.encode(after.signatures[0]!));
    }
  }
});

test("the transaction's id is the base58 of signature 0, the fee payer's", () => {
  const result = signed(signAsFeePayer(payment(), REQUIREMENTS, FEE_PAYER));
  const tx = VersionedTransaction.deserialize(Buffer.from(result.signedTxB64, "base64"));
  assert.equal(result.txSignature, bs58.encode(tx.signatures[0]!));
  assert.notEqual(result.txSignature, bs58.encode(tx.signatures[1]!));
  assert.ok(tx.signatures[0]!.some((b) => b !== 0));
});

test("a payment that fails one check gets no signature and no bytes", () => {
  const cases: Array<[string, string, string]> = [
    // The layout, the money and the fee payer: across the list.
    [
      "the price bid is over the cap",
      payment({ microLamports: 50_001n }),
      R.computePriceTooHigh,
    ],
    ["one atomic unit short", payment({ amount: AMOUNT - 1n }), R.amountMismatch],
    [
      "the fee payer in a Lighthouse instruction's accounts",
      payment({ change: (ixs) => [...ixs, lighthouseInstruction(FEE_PAYER.publicKey)] }),
      R.feePayerTransferringFunds,
    ],
    [
      "a fifth instruction that moves the fee payer's SOL",
      payment({
        change: (ixs) => [
          ...ixs,
          SystemProgram.transfer({ fromPubkey: FEE_PAYER.publicKey, toPubkey: PAYER.publicKey, lamports: 1 }),
        ],
      }),
      R.unknownFifthInstruction,
    ],
    [
      "a compute limit with a trailing byte",
      payment({
        change: (ixs) => {
          const limit = ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 });
          limit.data = Buffer.concat([limit.data, Buffer.from([0])]);
          return [limit, ...ixs.slice(1)];
        },
      }),
      R.computeLimitInstruction,
    ],
    ["the memo of another payment", payment({ memo: `${MEMO}x` }), R.memoMismatch],
  ];
  for (const [why, b64, reason] of cases) {
    const result = signAsFeePayer(b64, REQUIREMENTS, FEE_PAYER);
    assert.deepEqual(result, { invalidReason: reason }, why);
    // No bytes of any kind come back with a refusal.
    assert.deepEqual(Object.keys(result), ["invalidReason"], why);
  }
});

test("a fee payer slot already filled is refused and not signed over", () => {
  const b64 = payment({ signers: [PAYER, FEE_PAYER] });
  assert.deepEqual(signAsFeePayer(b64, REQUIREMENTS, FEE_PAYER), { invalidReason: R.invalidTransactionState });
});

test("a keypair that is not the requirements' fee payer signs nothing", () => {
  const stranger = keypairOf(11);
  // The payment was built for our fee payer: a stranger's key is refused.
  assert.deepEqual(signAsFeePayer(payment(), REQUIREMENTS, stranger), { invalidReason: R.feePayerNotManaged });
  // Requirements that name the stranger while the transaction names ours:
  // the check refuses before anything is signed.
  assert.deepEqual(signAsFeePayer(payment(), requirementsFor(stranger), stranger), { invalidReason: R.feePayerNotManaged });
  // Requirements that name ours, a key that is not ours.
  assert.deepEqual(signAsFeePayer(payment(), REQUIREMENTS, Keypair.generate()), { invalidReason: R.feePayerNotManaged });
});

test("bytes that are not a transaction are refused, never thrown", () => {
  assert.deepEqual(signAsFeePayer("not base64 at all!", REQUIREMENTS, FEE_PAYER), { invalidReason: R.couldNotBeDecoded });
  assert.deepEqual(signAsFeePayer("", REQUIREMENTS, FEE_PAYER), { invalidReason: R.couldNotBeDecoded });
});

// ============================================
// In the source
// ============================================

const SRC = fileURLToPath(new URL("../", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry.startsWith(".") || entry === "node_modules" ? [] : sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

test("in the source: the fee payer is derived only where it signs, its test and the door's binding, which signs nothing itself", () => {
  const allowed = new Set([
    join(SRC, "services", "x402FeePayer.ts"),
    join(SRC, "tests", "x402FeePayer.unit.test.ts"),
    join(SRC, "services", "buildPaidUseX402Deps.ts"),
  ]);
  const binding = join(SRC, "services", "buildPaidUseX402Deps.ts");
  const files = sourceFiles(SRC);
  assert.ok(files.length > 100, "the walk found the source");
  for (const path of files) {
    if (path === binding) {
      // The binding may hold the keypair, but the key signs only inside
      // signAsFeePayer, which checks again the exact bytes it signs.
      assert.equal(
        /\.sign\(|partialSign|addSignature|nacl\.sign|signTransaction/.test(readFileSync(path, "utf8")),
        false,
        "the door's binding hands the keypair to signAsFeePayer and signs nothing itself",
      );
    }
    if (allowed.has(path)) continue;
    assert.equal(readFileSync(path, "utf8").includes("deriveX402FeePayerKeypair"), false, path);
  }
});

test("in the source: the fee payer's file reads no settings and is plain ASCII", () => {
  const source = readFileSync(join(SRC, "services", "x402FeePayer.ts"), "utf8");
  assert.equal(/process\.env|config\/env|lib\/solana\.js|new Connection|getSolanaConnection/.test(source), false);
  assert.ok([...source].every((ch) => ch.charCodeAt(0) < 128));
});
