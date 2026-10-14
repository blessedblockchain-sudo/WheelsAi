import "./unitEnv.js";

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GENESIS_HASHES } from "../lib/solana.js";
import { usdcMintForNetwork } from "../lib/solanaAssets.js";
import { x402UsdcTokenAccount } from "../services/x402Decode.js";
import { X402_MAX_TIMEOUT_SECONDS } from "../services/x402DoorRules.js";
import {
  X402_CAIP2_NETWORKS,
  X402_ERROR_REASONS as R,
  X402_MEMO_CHARS,
  X402_MEMO_NONCE_BYTES,
  X402_VERSION,
  compareAccepted,
  encodePaymentRequired,
  encodePaymentResponse,
  listingRequirements,
  makeX402Memo,
  paymentRequired,
  readPaymentSignature,
  readX402Memo,
  x402Caip2Network,
  x402ResourceUrl,
  type PaymentRequirements,
  type SettlementResponse,
} from "../services/x402Wire.js";
import { keypairOf, paymentSignatureHeader, readPaymentRequired, readPaymentResponse } from "./x402DoorStandIns.js";

// The published x402 format, version 2, as the door speaks it: the three
// headers, the requirements of one use, the memo that binds a payment to a
// listing, and the client's echo compared with what the server builds.

const SECRET = "a-test-secret-of-some-length";
const LISTING = "4f8b1c2d-0000-4000-8000-00000000c0de";
const TREASURY = keypairOf(7).publicKey.toBase58();
const FEE_PAYER = keypairOf(9).publicKey.toBase58();
const NONCE_BYTES = new Uint8Array(6).fill(5);

function requirementsFor(network: "devnet" | "mainnet-beta", priceCents = 5n, memo?: string): PaymentRequirements {
  const amount = (priceCents * 10_000n).toString();
  return listingRequirements({
    network,
    priceCents,
    asset: usdcMintForNetwork(network).toBase58(),
    payTo: TREASURY,
    feePayer: FEE_PAYER,
    memo: memo ?? makeX402Memo({ listingId: LISTING, amount, secret: SECRET, nonceBytes: NONCE_BYTES }).memo,
  });
}

// ============================================
// Networks
// ============================================

test("the CAIP-2 ids are \"solana:\" and the first 32 characters of each cluster's genesis hash", () => {
  assert.equal(X402_CAIP2_NETWORKS.devnet, `solana:${GENESIS_HASHES.devnet.slice(0, 32)}`);
  assert.equal(X402_CAIP2_NETWORKS["mainnet-beta"], `solana:${GENESIS_HASHES["mainnet-beta"].slice(0, 32)}`);
  // The values the published reference uses.
  assert.equal(x402Caip2Network("devnet"), "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
  assert.equal(x402Caip2Network("mainnet-beta"), "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
});

// ============================================
// The 402
// ============================================

test("the 402 of one use, devnet and mainnet, decodes field by field", () => {
  for (const network of ["devnet", "mainnet-beta"] as const) {
    const requirements = requirementsFor(network);
    const value = encodePaymentRequired(
      paymentRequired({
        url: x402ResourceUrl("https://api.example.test/", "/api/a/reviewer/chat"),
        description: "Reviews a pull request in one message.",
        requirements,
      }),
    );
    const memo = makeX402Memo({ listingId: LISTING, amount: "50000", secret: SECRET, nonceBytes: NONCE_BYTES }).memo;
    assert.deepEqual(readPaymentRequired(value), {
      x402Version: 2,
      resource: {
        url: "https://api.example.test/api/a/reviewer/chat",
        description: "Reviews a pull request in one message.",
        mimeType: "application/json",
      },
      accepts: [
        {
          scheme: "exact",
          network: network === "devnet" ? "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" : "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          // 5 cents is 50,000 atomic units of USDC (6 decimals), as a string.
          amount: "50000",
          asset:
            network === "devnet"
              ? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
              : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          payTo: TREASURY,
          maxTimeoutSeconds: 180,
          extra: { feePayer: FEE_PAYER, memo },
        },
      ],
    });
    // payTo is the wallet, never its token account.
    assert.notEqual(requirements.payTo, x402UsdcTokenAccount(TREASURY, requirements.asset));
    assert.equal(requirements.maxTimeoutSeconds, X402_MAX_TIMEOUT_SECONDS);
  }
});

test("a 402 that refuses a payment carries the reason in error", () => {
  const value = encodePaymentRequired(
    paymentRequired({ url: "https://api.example.test/api/a/x/chat", description: "d", requirements: requirementsFor("devnet"), error: R.memoMismatch }),
  );
  const decoded = readPaymentRequired(value);
  assert.equal(decoded.error, "invalid_exact_svm_payload_memo_mismatch");
  assert.deepEqual(Object.keys(decoded), ["x402Version", "error", "resource", "accepts"]);
});

test("a price of no cents is never asked for", () => {
  for (const priceCents of [0n, -5n, 5 as unknown as bigint]) {
    assert.throws(() => requirementsFor("devnet", priceCents, "m"));
  }
  assert.equal(requirementsFor("devnet", 12n).amount, "120000");
});

// ============================================
// PAYMENT-RESPONSE
// ============================================

test("PAYMENT-RESPONSE: a success and a failure decode, and a failure names its network", () => {
  const network = x402Caip2Network("devnet");
  const success: SettlementResponse = { success: true, payer: "PayerWallet", transaction: "5igSig", network, amount: "50000" };
  assert.deepEqual(readPaymentResponse(encodePaymentResponse(success)), success);

  const failure: SettlementResponse = { success: false, errorReason: R.transactionFailed, transaction: "", network };
  assert.deepEqual(readPaymentResponse(encodePaymentResponse(failure)), {
    success: false,
    errorReason: "transaction_failed",
    transaction: "",
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  });

  // Field by field: nothing handed in beside the published fields reaches the payer.
  const extra = { ...failure, orgId: "a-seller" } as SettlementResponse;
  assert.equal("orgId" in readPaymentResponse(encodePaymentResponse(extra)), false);

  // @ts-expect-error network is required, on a failure too.
  const missing: SettlementResponse = { success: false, transaction: "" };
  assert.ok(missing);
});

// ============================================
// PAYMENT-SIGNATURE
// ============================================

test("PAYMENT-SIGNATURE: a client's header reads back whole", () => {
  const accepted = requirementsFor("devnet");
  const header = paymentSignatureHeader(accepted, "AQID");
  const read = readPaymentSignature({ "payment-signature": header });
  assert.deepEqual(read, { kind: "payment", payment: { x402Version: X402_VERSION, accepted, payload: { transaction: "AQID" } } });
});

test("PAYMENT-SIGNATURE: absent, not base64, not JSON, of version 1, or malformed each reads as no payment, with its reason", () => {
  const accepted = requirementsFor("devnet");
  const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64");
  const cases: Array<[string, Record<string, string | string[] | undefined>, unknown]> = [
    ["absent", {}, { kind: "none" }],
    // The version 1 header is not read: there is no X-PAYMENT fallback.
    ["only X-PAYMENT", { "x-payment": paymentSignatureHeader(accepted, "AQID") }, { kind: "none" }],
    ["empty", { "payment-signature": "" }, { kind: "unreadable", reason: "invalid_payload" }],
    ["not base64", { "payment-signature": "{not base64}" }, { kind: "unreadable", reason: "invalid_payload" }],
    ["not JSON", { "payment-signature": b64("hello, world") }, { kind: "unreadable", reason: "invalid_payload" }],
    ["JSON, not an object", { "payment-signature": b64([1, 2]) }, { kind: "unreadable", reason: "invalid_payload" }],
    ["version 1", { "payment-signature": paymentSignatureHeader(accepted, "AQID", 1) }, { kind: "unreadable", reason: "invalid_x402_version" }],
    ["no version", { "payment-signature": b64({ accepted, payload: { transaction: "AQID" } }) }, { kind: "unreadable", reason: "invalid_x402_version" }],
    ["no transaction", { "payment-signature": b64({ x402Version: 2, accepted, payload: {} }) }, { kind: "unreadable", reason: "invalid_payload" }],
    ["no accepted", { "payment-signature": b64({ x402Version: 2, payload: { transaction: "AQID" } }) }, { kind: "unreadable", reason: "invalid_payload" }],
    ["two headers", { "payment-signature": [paymentSignatureHeader(accepted, "AQID"), paymentSignatureHeader(accepted, "AQID")] }, { kind: "unreadable", reason: "invalid_payload" }],
    ["too long", { "payment-signature": "A".repeat(20_000) }, { kind: "unreadable", reason: "invalid_payload" }],
  ];
  for (const [name, headers, want] of cases) {
    assert.deepEqual(readPaymentSignature(headers), want, name);
  }
});

// ============================================
// The memo
// ============================================

test("the memo binds a payment to its listing and amount, under a MAC with its own label", () => {
  const { memo, nonce } = makeX402Memo({ listingId: LISTING, amount: "50000", secret: SECRET, nonceBytes: NONCE_BYTES });
  assert.equal(nonce, Buffer.from(NONCE_BYTES).toString("base64url"));
  const mac = createHmac("sha256", SECRET).update(`wheelsai-x402-memo-v1:${LISTING}:${nonce}:50000`).digest().subarray(0, 12);
  assert.equal(memo, Buffer.concat([Buffer.from(NONCE_BYTES), mac]).toString("base64url"));

  assert.deepEqual(readX402Memo(memo, { listingId: LISTING, amount: "50000", secret: SECRET }), { nonce });
  assert.equal(readX402Memo(memo, { listingId: LISTING, amount: "60000", secret: SECRET }), null, "another amount");
  assert.equal(readX402Memo(memo, { listingId: "another-listing", amount: "50000", secret: SECRET }), null, "another listing");
  assert.equal(readX402Memo(memo, { listingId: LISTING, amount: "50000", secret: `${SECRET}x` }), null, "another secret");
  assert.equal(readX402Memo(`${memo.slice(0, -1)}A`, { listingId: LISTING, amount: "50000", secret: SECRET }), null, "a bad MAC");
  assert.equal(readX402Memo(`${memo}A`, { listingId: LISTING, amount: "50000", secret: SECRET }), null, "longer");
  assert.equal(readX402Memo(memo.slice(0, -1), { listingId: LISTING, amount: "50000", secret: SECRET }), null, "shorter");
  assert.equal(readX402Memo(`${memo.slice(0, -1)}+`, { listingId: LISTING, amount: "50000", secret: SECRET }), null, "not base64url");
  assert.equal(readX402Memo(42, { listingId: LISTING, amount: "50000", secret: SECRET }), null);
  // A MAC with no label of its own (the secret's other uses) does not stand for one.
  const unlabelled = createHmac("sha256", SECRET).update(`${LISTING}:${nonce}:50000`).digest().subarray(0, 12);
  const forged = Buffer.concat([Buffer.from(NONCE_BYTES), unlabelled]).toString("base64url");
  assert.equal(readX402Memo(forged, { listingId: LISTING, amount: "50000", secret: SECRET }), null);

  // Each challenge has a fresh nonce.
  const a = makeX402Memo({ listingId: LISTING, amount: "50000", secret: SECRET });
  const b = makeX402Memo({ listingId: LISTING, amount: "50000", secret: SECRET });
  assert.notEqual(a.nonce, b.nonce);
  assert.match(a.nonce, /^[A-Za-z0-9_-]{8}$/);
});

test("the memo is short enough for a standard client's compute limit", () => {
  // The reference client sets 20,000 compute units and the Memo program costs
  // about 350 a byte: measured on the local test validator, a TransferChecked
  // with a 32-byte memo used 19,249 units and with a 96-byte one 41,848. A
  // memo over 32 bytes is one no standard client could pay.
  const { memo } = makeX402Memo({ listingId: LISTING, amount: "50000", secret: SECRET });
  assert.equal(X402_MEMO_CHARS, 24);
  assert.equal(X402_MEMO_NONCE_BYTES, 6);
  assert.equal(memo.length, X402_MEMO_CHARS);
  assert.ok(Buffer.byteLength(memo, "utf8") <= 32);
  assert.throws(() => makeX402Memo({ listingId: LISTING, amount: "50000", secret: SECRET, nonceBytes: new Uint8Array(16) }));
});

// ============================================
// The client's echo
// ============================================

test("compareAccepted: the echo of the 402 is accepted, with its memo and nonce", () => {
  // The 402 was built a moment ago with one nonce; the requirements of now have another.
  const echoed = requirementsFor("devnet");
  const now = requirementsFor("devnet", 5n, makeX402Memo({ listingId: LISTING, amount: "50000", secret: SECRET }).memo);
  assert.notEqual(echoed.extra.memo, now.extra.memo);
  const result = compareAccepted(JSON.parse(JSON.stringify(echoed)), now, { listingId: LISTING, secret: SECRET });
  assert.deepEqual(result, {
    ok: true,
    requirements: { ...now, extra: { feePayer: FEE_PAYER, memo: echoed.extra.memo } },
    nonce: Buffer.from(NONCE_BYTES).toString("base64url"),
  });
});

test("compareAccepted: each field changed alone is refused with its string, and nothing is taken from the echo", () => {
  const ours = requirementsFor("devnet");
  const other = keypairOf(60).publicKey.toBase58();
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["scheme", { scheme: "upto" }, R.unsupportedScheme],
    ["network", { network: x402Caip2Network("mainnet-beta") }, R.networkMismatch],
    ["network by the old name", { network: "solana-devnet" }, R.networkMismatch],
    ["amount one unit over", { amount: "50001" }, R.amountMismatch],
    ["amount as a number", { amount: 50000 }, R.amountMismatch],
    ["asset", { asset: usdcMintForNetwork("mainnet-beta").toBase58() }, R.mintMismatch],
    ["payTo", { payTo: other }, R.recipientMismatch],
    ["payTo as its token account", { payTo: x402UsdcTokenAccount(TREASURY, ours.asset) }, R.recipientMismatch],
    ["maxTimeoutSeconds", { maxTimeoutSeconds: 600 }, R.invalidPayload],
    ["no extra", { extra: undefined }, R.missingFeePayer],
    ["no fee payer", { extra: { memo: ours.extra.memo } }, R.missingFeePayer],
    ["another fee payer", { extra: { ...ours.extra, feePayer: other } }, R.feePayerNotManaged],
    ["no memo", { extra: { feePayer: FEE_PAYER } }, R.memoMismatch],
    [
      "a memo of another listing",
      { extra: { ...ours.extra, memo: makeX402Memo({ listingId: "6a0f0000-0000-4000-8000-000000000001", amount: "50000", secret: SECRET }).memo } },
      R.memoMismatch,
    ],
    ["a memo with a bad MAC", { extra: { ...ours.extra, memo: `${ours.extra.memo.slice(0, -2)}AA` } }, R.memoMismatch],
    [
      "a memo for another amount",
      { extra: { ...ours.extra, memo: makeX402Memo({ listingId: LISTING, amount: "60000", secret: SECRET }).memo } },
      R.memoMismatch,
    ],
    ["a memo of another server", { extra: { ...ours.extra, memo: makeX402Memo({ listingId: LISTING, amount: "50000", secret: "another-secret" }).memo } }, R.memoMismatch],
  ];
  for (const [name, change, reason] of cases) {
    const accepted = { ...ours, ...change };
    assert.deepEqual(compareAccepted(accepted, ours, { listingId: LISTING, secret: SECRET }), { ok: false, reason }, name);
  }
  for (const accepted of [null, "exact", [ours]]) {
    assert.deepEqual(compareAccepted(accepted, ours, { listingId: LISTING, secret: SECRET }), { ok: false, reason: R.invalidPayload });
  }
});

test("compareAccepted: a price change between the 402 and the retry is a mismatch", () => {
  const at402 = requirementsFor("devnet", 5n);
  const now = requirementsFor("devnet", 6n);
  assert.deepEqual(compareAccepted(at402, now, { listingId: LISTING, secret: SECRET }), { ok: false, reason: R.amountMismatch });
});

// ============================================
// In the source
// ============================================

const SERVICES = fileURLToPath(new URL("../services/", import.meta.url));
const PURE = ["x402Wire.ts", "x402ExactSvm.ts", "x402DoorRules.ts"];

test("in the source: the three files are pure, with no byte offsets", () => {
  for (const name of PURE) {
    const source = readFileSync(join(SERVICES, name), "utf8");
    assert.equal(/process\.env|config\/env|lib\/solana\.js|new Connection|getSolanaConnection/.test(source), false, name);
    assert.equal(/readBigUInt64LE|readUInt8|\.data\[\d/.test(source), false, `${name} reads bytes by offset`);
    assert.ok([...source].every((ch) => ch.charCodeAt(0) < 128), `${name} is ASCII`);
  }
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "tests" || entry.startsWith(".") ? [] : sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

test("in the source: a reference error string is written as a literal in x402Wire.ts only", () => {
  const strings = Object.values(R);
  // The door's core, and every file that builds a PAYMENT-RESPONSE, names
  // a reason only through X402_ERROR_REASONS.
  const src = fileURLToPath(new URL("../", import.meta.url));
  const responders = sourceFiles(src)
    .filter((path) => !path.endsWith(join("services", "x402Wire.ts")))
    .filter((path) => readFileSync(path, "utf8").includes("encodePaymentResponse("));
  assert.ok(responders.includes(join(SERVICES, "paidUseX402.ts")), "the door's core builds PAYMENT-RESPONSE");
  const files = new Set([
    ...PURE.filter((n) => n !== "x402Wire.ts").map((name) => join(SERVICES, name)),
    join(SERVICES, "paidUseX402.ts"),
    ...responders,
  ]);
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    for (const value of strings) {
      assert.equal(new RegExp(`["'\`]${value}["'\`]`).test(source), false, `${path} writes "${value}"`);
    }
  }
  // The strings of the Solana scheme are the door's alone: no other file of
  // the API writes one.
  const distinctive = strings.filter((value) => value.startsWith("invalid_exact_svm_") || value === "fee_payer_not_managed_by_facilitator");
  for (const path of sourceFiles(src)) {
    if (path.endsWith(join("services", "x402Wire.ts"))) continue;
    const source = readFileSync(path, "utf8");
    for (const value of distinctive) {
      assert.equal(source.includes(value), false, `${path} writes "${value}"`);
    }
  }
});
