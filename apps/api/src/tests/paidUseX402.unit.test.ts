import "./unitEnv.js";

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";

import { X402_FAILED_ON_CHAIN_REASON, X402_NEVER_LANDED_REASON } from "../services/buildX402PaymentsDeps.js";
import { TASK_MESSAGES } from "../services/agentTask.js";
import { computeContributorSplit } from "../services/contributorSplits.js";
import { CONFIDENTIAL_CHAT_RULES } from "../services/jobPrompt.js";
import { centsCrossed } from "../services/marketplaceMetering.js";
import { PAID_USE_MESSAGES, paidUseKeys, type PaidUseRefusal } from "../services/paidUse.js";
import {
  X402_PAYMENT_REQUIRED_HEADER,
  X402_PAYMENT_RESPONSE_HEADER,
  x402DoorKeys,
  type X402UseResult,
} from "../services/paidUseX402.js";
import { secondsLeftInUtcDay, utcDay } from "../services/publicChat.js";
import {
  X402_ANSWER_DEADLINE_MS,
  X402_DOOR_CONFIRM_MAX_MS,
  X402_DOOR_DEAD_TRUSTED_AFTER_MS,
  X402_DOOR_MESSAGES,
  X402_MAX_TIMEOUT_SECONDS,
  X402_SEND_BY_MS,
  X402_UNPAID_ANSWERS_PER_DAY,
} from "../services/x402DoorRules.js";
import { verifyExactSvmTransaction } from "../services/x402ExactSvm.js";
import { X402_CAIP2_NETWORKS, X402_ERROR_REASONS as R, readX402Memo } from "../services/x402Wire.js";
import {
  AGENT_ID,
  ANSWER,
  BUCKET,
  call as callDoor,
  CHAT_BODY,
  doorWorld,
  FEE_PAYER,
  FEE_PAYER_LAMPORTS,
  FREE_MODEL,
  HANDLE,
  INSTRUCTIONS,
  LEAK,
  LISTING_ID,
  MEMO_SECRET,
  MINT,
  pay,
  PAYER,
  PRICE_ATOMIC,
  PRICE_CENTS,
  readAll,
  requirementsNow,
  RESOURCE_URL,
  SELLER_ORG,
  TASK_FORM,
  TREASURY,
  type CallOptions,
  type DoorWorld,
} from "./paidUseX402Harness.js";
import {
  keypairOf,
  lighthouseInstruction,
  readPaymentRequired,
  readPaymentResponse,
  signWithNonce,
  withSignature,
} from "./x402DoorStandIns.js";

// One use of an agent paid from a wallet at a listing's x402 door, as a core
// with everything injected (services/paidUseX402.ts): the listing judged
// first, the payment checked before the model runs, nothing written before
// the claim, nothing that can land before the answer is made and checked
// whole, the fee payer's signature only after that, the answer released only
// once the chain confirmed and the sale was written, and a payment presented
// twice served once.

const DEVNET = X402_CAIP2_NETWORKS.devnet;

/** Every refusal any test saw, for the last test: each sentence is the door's own. */
const seen: PaidUseRefusal[] = [];

async function call<R = never>(world: DoorWorld, options: CallOptions<R> = {}): Promise<X402UseResult<R>> {
  const result = await callDoor(world, options);
  if (result.kind === "refusal") seen.push(result.refusal);
  return result;
}

function refused(result: X402UseResult<unknown>) {
  assert.equal(result.kind, "refusal", `expected a refusal, got ${result.kind}`);
  return result as Extract<X402UseResult<unknown>, { kind: "refusal" }>;
}

function answered(result: X402UseResult<unknown>) {
  assert.equal(
    result.kind,
    "answer",
    `expected an answer, got ${result.kind}: ${result.kind === "refusal" ? result.refusal.message : ""}`,
  );
  return result as Extract<X402UseResult<unknown>, { kind: "answer" }>;
}

/** The PAYMENT-REQUIRED of a refusal, decoded. */
function challengeOf(result: X402UseResult<unknown>) {
  const header = refused(result).headers[X402_PAYMENT_REQUIRED_HEADER];
  assert.ok(header, "a PAYMENT-REQUIRED header");
  return readPaymentRequired(header);
}

const rows = (world: DoorWorld) => [...world.db.payments.values()];
const only = (world: DoorWorld) => world.db.only();
const chainTouched = (trail: string[]) => trail.filter((step) => step.startsWith("chain:"));
const unpaidOf = async (world: DoorWorld, wallet = PAYER.publicKey.toBase58()) => ({
  wallet: await world.store.peek(x402DoorKeys.unpaidWalletDay(wallet, utcDay(new Date(world.nowMs)))),
  address: await world.store.peek(x402DoorKeys.unpaidAddressDay(BUCKET, utcDay(new Date(world.nowMs)))),
});

/** Counts `n` against a key of the limiter, as earlier requests would have. */
async function fill(world: DoorWorld, key: string, n: number) {
  for (let i = 0; i < n; i += 1) await world.store.consume([{ key, limit: 1_000_000, windowMs: 86_400_000 }]);
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 2_000 && !condition(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(condition(), "the condition came true");
}

const before = (trail: string[], first: string, second: string) => {
  const a = trail.indexOf(first);
  const b = trail.indexOf(second);
  assert.ok(a !== -1, `${first} happened`);
  assert.ok(b !== -1, `${second} happened`);
  assert.ok(a < b, `${first} before ${second}: ${trail.join(" ")}`);
};

// ============================================
// 1. The listing, judged first
// ============================================

test("a listing the door does not serve answers not_served, with nothing counted, read from the chain or written", async () => {
  const cases: Array<[string, Parameters<typeof doorWorld>[0], string?]> = [
    ["the switch off", { listing: { x402Enabled: false } }],
    ["the switch not read", { listing: { x402Enabled: undefined } }],
    ["a draft", { listing: { status: "draft" } }],
    ["monthly", { listing: { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 900n } }],
    ["free", { listing: { pricingModel: "free", pricePerRequestCents: null } }],
    ["copies", { listing: { sells: "copies" } }],
    ["under the floor", { listing: { pricePerRequestCents: 4n } }],
    ["a workflow's listing", { listing: { orchestrationId: "8a8b8c8d-0000-4000-8000-000000000001" } }],
    ["a private agent", { agent: { isPublic: false } }],
    ["a scheduled agent", { agent: { agentKind: "scheduled" } }],
    ["a graph agent", { agent: { entrypoint: "graph" } }],
    ["no listing", { listing: null }],
    ["an unknown handle", { agent: null }],
    ["another agent's listing", { listing: { agentId: "6a1f0c2e-0000-4000-8000-0000000000ff" } }],
  ];
  for (const [name, options] of cases) {
    const world = doorWorld(options);
    const paid = pay(world);
    for (const payment of [undefined, paid.header]) {
      let asked = false;
      let served = 0;
      const result = await call(world, {
        ...(payment !== undefined && { payment }),
        body: { not: "a body" },
        checkBody: () => {
          asked = true;
          return { ok: false, refused: "the route's own" };
        },
        onServed: () => (served += 1),
      });
      assert.deepEqual(result, { kind: "not_served" }, name);
      assert.equal(asked, false, `${name}: the body is not read before the listing is judged`);
      assert.equal(served, 0, `${name}: the route is never told it is served`);
    }
    assert.equal(await world.store.peek(x402DoorKeys.addressMinute(BUCKET, HANDLE)), 0, name);
    assert.equal(rows(world).length, 0, name);
    assert.deepEqual(chainTouched(world.trail), [], name);
    assert.equal(world.modelRuns, 0, name);
  }
});

test("a read of the agent or its listing that throws answers not_served, with nothing counted, read from the chain or written", async () => {
  for (const which of ["agent", "listing"] as const) {
    const world = doorWorld();
    if (which === "agent") {
      world.deps.loadAgentByHandle = async () => {
        throw new Error("the database is down");
      };
    } else {
      world.deps.loadListing = async () => {
        throw new Error("the database is down");
      };
    }
    let served = 0;
    const result = await call(world, { payment: pay(world).header, onServed: () => (served += 1) });
    assert.deepEqual(result, { kind: "not_served" }, which);
    assert.equal(served, 0, which);
    assert.equal(await world.store.peek(x402DoorKeys.addressMinute(BUCKET, HANDLE)), 0, which);
    assert.equal(rows(world).length, 0, which);
    assert.deepEqual(chainTouched(world.trail), [], which);
    assert.equal(world.modelRuns, 0, which);
    assert.ok(world.logs.some((line) => line.includes("answered as not served")), which);
  }
});

test("a credential never reaches the door: a request that carries one is not served, whatever it pays", async () => {
  const world = doorWorld();
  const paid = pay(world);
  for (const headers of [
    { authorization: "" },
    { authorization: "Bearer wheels_not_a_key" },
    { cookie: "theme=dark; wheelsai_token=s%3Aexpired" },
    { cookie: ["wheelsai_token=x"] },
    // The cookie parser trims the name, so spaces around it still name the session.
    { cookie: "theme=dark; wheelsai_token =x" },
  ]) {
    assert.deepEqual(await call(world, { payment: paid.header, headers }), { kind: "not_served" }, JSON.stringify(headers));
  }
  // Another cookie is not a credential.
  const other = await call(world, { headers: { cookie: "theme=dark" } });
  assert.equal(refused(other).refusal.code, "x402_payment_required");
  assert.equal(rows(world).length, 0);
});

test("a listing paused right now answers 503 with no 402; a pause that cannot be read is not available", async () => {
  const world = doorWorld();
  world.paused = true;
  const paused = refused(await call(world, { payment: pay(world).header }));
  assert.equal(paused.refusal.status, 503);
  assert.equal(paused.refusal.code, "agent_paused");
  assert.equal(paused.refusal.message, X402_DOOR_MESSAGES.paused);
  assert.deepEqual(paused.headers, {});

  world.paused = "throws";
  const unknown = refused(await call(world));
  assert.equal(unknown.refusal.status, 503);
  assert.equal(unknown.refusal.code, "x402_unavailable");
  assert.deepEqual(unknown.headers, {});
  assert.equal(rows(world).length, 0);
  assert.equal(world.modelRuns, 0);
});

// ============================================
// 2. The 402
// ============================================

test("no payment answers 402 whose PAYMENT-REQUIRED is the listing's requirements, field by field, with nothing written", async () => {
  const world = doorWorld();
  const result = await call(world);
  const { refusal } = refused(result);
  assert.equal(refusal.status, 402);
  assert.equal(refusal.code, "x402_payment_required");
  assert.equal(refusal.message, X402_DOOR_MESSAGES.paymentRequired(PRICE_CENTS, "message"));
  assert.equal(refusal.message, "Pay $0.10 in USDC from a Solana wallet for one message, as the PAYMENT-REQUIRED header of this answer says, or send an API key.");
  assert.equal(refusal.priceCents, 10);
  assert.equal(refusal.unit, "message");
  assert.equal(refusal.transaction, undefined);

  const required = challengeOf(result);
  assert.deepEqual(Object.keys(required), ["x402Version", "resource", "accepts"]);
  assert.equal(required.x402Version, 2);
  assert.deepEqual(required.resource, {
    url: RESOURCE_URL,
    description: "Reviews an essay in one answer.",
    mimeType: "application/json",
  });
  assert.equal(required.accepts.length, 1);
  const [accepts] = required.accepts;
  assert.equal(accepts.scheme, "exact");
  assert.equal(accepts.network, DEVNET);
  assert.equal(accepts.amount, PRICE_ATOMIC.toString());
  assert.equal(accepts.amount, "100000");
  assert.equal(accepts.asset, MINT.toBase58());
  // The wallet, never its token account.
  assert.equal(accepts.payTo, TREASURY.toBase58());
  assert.equal(accepts.maxTimeoutSeconds, X402_MAX_TIMEOUT_SECONDS);
  assert.equal(accepts.extra.feePayer, FEE_PAYER.publicKey.toBase58());
  assert.ok(readX402Memo(accepts.extra.memo, { listingId: LISTING_ID, amount: "100000", secret: MEMO_SECRET }));
  assert.ok(Buffer.byteLength(accepts.extra.memo) < 256);

  // Fresh each time: stateless, and nothing is written for a challenge.
  const again = challengeOf(await call(world));
  assert.notEqual(again.accepts[0].extra.memo, accepts.extra.memo);
  assert.equal(rows(world).length, 0);
  assert.deepEqual(chainTouched(world.trail), []);
  assert.equal(world.modelRuns, 0);
});

test("a task agent's 402 is for one run", async () => {
  const world = doorWorld({ agent: { agentKind: "task", kindConfig: TASK_FORM } });
  const { refusal } = refused(await call(world, { kind: "run", body: { input: { topic: "Tides" } } }));
  assert.equal(refusal.unit, "run");
  assert.equal(refusal.message, X402_DOOR_MESSAGES.paymentRequired(PRICE_CENTS, "run"));
});

test("a PAYMENT-SIGNATURE that cannot be read counts as no payment, and the 402 says why", async () => {
  const world = doorWorld();
  const paid = pay(world);
  const v1 = Buffer.from(JSON.stringify({ x402Version: 1, accepted: paid.requirements, payload: { transaction: paid.b64 } })).toString("base64");
  for (const [header, reason] of [
    ["not base64 at all!", R.invalidPayload],
    [Buffer.from("not json").toString("base64"), R.invalidPayload],
    [v1, R.invalidX402Version],
  ] as const) {
    const result = await call(world, { payment: header });
    assert.equal(refused(result).refusal.code, "x402_payment_required");
    assert.equal(challengeOf(result).error, reason);
  }
  assert.equal(rows(world).length, 0);
  assert.equal(world.modelRuns, 0);
});

test("each check of a payment refuses it with a fresh 402 whose error is its string, before the model, the chain or a write", async () => {
  const unknownProgram = Keypair.generate().publicKey;
  const cases: Array<[string, (world: DoorWorld) => ReturnType<typeof pay>, string?]> = [
    ["one atomic unit short", (w) => pay(w, { over: { amount: PRICE_ATOMIC - 1n } }), R.amountMismatch],
    ["an echo of another amount", (w) => pay(w, { accepted: { ...requirementsNow(), amount: "99999" } }), R.amountMismatch],
    ["an echo of another payTo", (w) => pay(w, { accepted: { ...requirementsNow(), payTo: keypairOf(5).publicKey.toBase58() } }), R.recipientMismatch],
    ["an echo of another price", (w) => pay(w, { requirements: requirementsNow(9n) }), R.amountMismatch],
    ["another mint", (w) => pay(w, { over: { mint: Keypair.generate().publicKey } })],
    ["another payTo on the chain", (w) => pay(w, { over: { payTo: keypairOf(5).publicKey } })],
    ["no memo", (w) => pay(w, { over: { change: (ixs) => ixs.slice(0, 3) } })],
    ["another memo", (w) => pay(w, { over: { memo: "wheelsai-x402:someone-else" } })],
    ["the fee payer in an instruction", (w) => pay(w, { over: { change: (ixs) => [...ixs, lighthouseInstruction(FEE_PAYER.publicKey)] } })],
    ["a lookup table", (w) => pay(w, { over: { lookupAddresses: [TREASURY, MINT] } })],
    ["a compute price over the cap", (w) => pay(w, { over: { microLamports: 50_001n } })],
    [
      "a fifth unknown instruction",
      (w) =>
        pay(w, {
          over: { change: (ixs) => [...ixs, new TransactionInstruction({ programId: unknownProgram, keys: [], data: Buffer.from([1]) })] },
        }),
    ],
  ];
  for (const [name, make, expected] of cases) {
    const world = doorWorld();
    const paid = make(world);
    // What the checker itself answers, for a case whose string is the checker's.
    const own = verifyExactSvmTransaction(paid.b64, paid.requirements, { feePayer: FEE_PAYER.publicKey.toBase58() });
    const reason = expected ?? (own.isValid ? "valid" : own.invalidReason);
    assert.notEqual(reason, "valid", name);
    const result = await call(world, { payment: paid.header });
    const { refusal } = refused(result);
    assert.equal(refusal.status, 402, name);
    assert.equal(refusal.code, "x402_payment_invalid", name);
    assert.equal(refusal.message, X402_DOOR_MESSAGES.paymentInvalid, name);
    assert.equal(refusal.priceCents, 10, name);
    const fresh = challengeOf(result);
    assert.equal(fresh.error, reason, name);
    assert.notEqual(fresh.accepts[0].extra.memo, paid.requirements.extra.memo, `${name}: a fresh challenge`);
    assert.equal(rows(world).length, 0, name);
    assert.equal(world.modelRuns, 0, name);
    assert.deepEqual(chainTouched(world.trail), [], name);
    assert.equal(await world.store.peek(x402DoorKeys.walletMinute(PAYER.publicKey.toBase58(), HANDLE)), 0, name);
  }
});

// ============================================
// 3. The limits, in their order
// ============================================

test("the address's minute is taken before the body is read", async () => {
  const world = doorWorld();
  for (let i = 0; i < 10; i += 1) {
    const bad = refused(await call(world, { body: { nope: 1 } }));
    assert.equal(bad.refusal.code, "invalid_request");
    assert.equal(bad.refusal.message, PAID_USE_MESSAGES.invalidChatBody);
  }
  const limited = refused(await call(world, { body: { nope: 1 } }));
  assert.equal(limited.refusal.status, 429);
  assert.equal(limited.refusal.code, "rate_limited");
  assert.equal(limited.refusal.message, X402_DOOR_MESSAGES.addressMinute);
  assert.ok((limited.refusal.retryAfterSeconds ?? 0) > 0);
  assert.deepEqual(limited.headers, {});
});

test("a route's own check of the body runs after the listing is judged, and its refusal is the route's", async () => {
  const world = doorWorld();
  const order: string[] = [];
  const result = await call(world, {
    checkBody: () => {
      order.push("body");
      return { ok: false, refused: { param: "tools" } };
    },
    onServed: () => order.push("served"),
  });
  assert.deepEqual(result, { kind: "body_refused", refused: { param: "tools" } });
  assert.deepEqual(order, ["served", "body"]);
  const passed = await call(world, { body: { anything: true }, checkBody: () => ({ ok: true, body: CHAT_BODY }) });
  assert.equal(refused(passed).refusal.code, "x402_payment_required");
});

test("a task agent's form is judged as paid use judges it; a run of a conversation agent is refused as paid use refuses it", async () => {
  const task = doorWorld({ agent: { agentKind: "task", kindConfig: TASK_FORM } });
  const invalid = refused(await call(task, { kind: "run", body: { input: { nope: "x" } } }));
  assert.equal(invalid.refusal.code, "input_invalid");
  assert.equal(invalid.refusal.status, 422);
  const chatAgent = doorWorld();
  const notTask = refused(await call(chatAgent, { kind: "run", body: { input: { topic: "x" } } }));
  assert.equal(notTask.refusal.code, "not_a_task_agent");
  assert.equal(notTask.refusal.message, TASK_MESSAGES.notATaskAgent);
});

test("the unpaid answers of a wallet or an address are read before the chain; past the limit nothing more is answered today", async () => {
  for (const which of ["wallet", "address"] as const) {
    const world = doorWorld();
    const day = utcDay(new Date(world.nowMs));
    const key =
      which === "wallet"
        ? x402DoorKeys.unpaidWalletDay(PAYER.publicKey.toBase58(), day)
        : x402DoorKeys.unpaidAddressDay(BUCKET, day);
    await fill(world, key, X402_UNPAID_ANSWERS_PER_DAY);
    world.chain.chain.readsFail = true;
    const result = refused(await call(world, { payment: pay(world).header }));
    assert.equal(result.refusal.status, 429, which);
    assert.equal(result.refusal.code, "x402_too_many_unpaid", which);
    assert.equal(result.refusal.message, X402_DOOR_MESSAGES.tooManyUnpaid, which);
    assert.equal(result.refusal.retryAfterSeconds, secondsLeftInUtcDay(new Date(world.nowMs)), which);
    assert.deepEqual(chainTouched(world.trail), [], which);
    assert.equal(rows(world).length, 0, which);
  }
});

test("the wallet's minute, the wallet's day and the address's day refuse before the chain", async () => {
  const wallet = PAYER.publicKey.toBase58();
  const cases: Array<[string, (world: DoorWorld) => string]> = [
    ["the wallet's minute", () => x402DoorKeys.walletMinute(wallet, HANDLE)],
    ["the wallet's day", (w) => x402DoorKeys.walletDay(wallet, HANDLE, utcDay(new Date(w.nowMs)))],
    ["the address's day", (w) => x402DoorKeys.addressDay(BUCKET, utcDay(new Date(w.nowMs)))],
  ];
  for (const [name, keyOf] of cases) {
    const world = doorWorld();
    await fill(world, keyOf(world), name === "the wallet's minute" ? 10 : 200);
    const result = refused(await call(world, { payment: pay(world).header }));
    assert.equal(result.refusal.status, 429, name);
    assert.equal(result.refusal.code, "rate_limited", name);
    assert.equal(result.refusal.message, X402_DOOR_MESSAGES.walletOrAddressDay, name);
    assert.deepEqual(chainTouched(world.trail), [], name);
    assert.equal(rows(world).length, 0, name);
  }
});

test("a limiter that cannot count refuses: at the address's minute, and at the unpaid answers' read", async () => {
  const down = doorWorld();
  down.limiterDown = true;
  const first = refused(await call(down, { payment: pay(down).header }));
  assert.equal(first.refusal.status, 503);
  assert.equal(first.refusal.code, "rate_limiter_unavailable");
  assert.equal(first.refusal.message, X402_DOOR_MESSAGES.cannotCount);
  assert.deepEqual(first.headers, {});

  const peek = doorWorld();
  peek.peekDown = true;
  const second = refused(await call(peek, { payment: pay(peek).header }));
  assert.equal(second.refusal.status, 503);
  assert.equal(second.refusal.code, "rate_limiter_unavailable");
  assert.deepEqual(chainTouched(peek.trail), []);
  for (const world of [down, peek]) {
    assert.equal(rows(world).length, 0);
    assert.equal(world.modelRuns, 0);
  }
});

test("a limiter that cannot count the wallet's minute, the wallet's day and the address's day refuses before the chain or a write", async () => {
  const world = doorWorld();
  world.consumeDownFor = (key) => key.startsWith("x4:w:");
  const result = refused(await call(world, { payment: pay(world).header }));
  assert.equal(result.refusal.status, 503);
  assert.equal(result.refusal.code, "rate_limiter_unavailable");
  assert.equal(result.refusal.message, X402_DOOR_MESSAGES.cannotCount);
  assert.deepEqual(result.headers, {});
  assert.equal(rows(world).length, 0);
  assert.deepEqual(chainTouched(world.trail), []);
  assert.equal(world.modelRuns, 0);
});

test("a limiter that cannot count the agent's minute ends the held row unsent, before the model", async () => {
  const world = doorWorld();
  world.consumeDownFor = (key) => key.startsWith("pu:a:m:");
  const result = refused(await call(world, { payment: pay(world).header }));
  assert.equal(result.refusal.status, 503);
  assert.equal(result.refusal.code, "rate_limiter_unavailable");
  assert.equal(result.refusal.message, X402_DOOR_MESSAGES.cannotCount);
  assert.equal(only(world).status, "failed");
  assert.equal(only(world).failureReason, "never_sent");
  assert.equal(world.modelRuns, 0);
  assert.ok(!world.trail.includes("sign"));
  assert.equal(world.chain.chain.sends.length, 0);
  assert.deepEqual(await unpaidOf(world), { wallet: 0, address: 0 });
});

test("the agent's minute across everyone is shared with buyers who have an account, and refuses before the model with nothing signed", async () => {
  // The very key paid use counts for buyers with an account, not a copy of it.
  assert.equal(x402DoorKeys.agentMinute(AGENT_ID), paidUseKeys.agentMinute(AGENT_ID));
  const world = doorWorld();
  await fill(world, paidUseKeys.agentMinute(AGENT_ID), 60);
  const result = refused(await call(world, { payment: pay(world).header }));
  assert.equal(result.refusal.status, 503);
  assert.equal(result.refusal.code, "x402_unavailable");
  assert.ok((result.refusal.retryAfterSeconds ?? 0) > 0);
  assert.equal(world.modelRuns, 0);
  assert.equal(only(world).status, "failed");
  assert.ok(!world.trail.includes("sign"));
  assert.equal(world.chain.chain.sends.length, 0);
});

// ============================================
// 4. The chain, read only
// ============================================

test("a fee payer under its floor, or a treasury with no USDC account, is not available; nothing is written", async () => {
  for (const [name, options] of [
    ["the fee payer under its floor", { feePayerLamports: 9_999_999n }],
    ["no treasury account", { treasuryAccount: false }],
  ] as const) {
    const world = doorWorld(options);
    const result = refused(await call(world, { payment: pay(world).header }));
    assert.equal(result.refusal.status, 503, name);
    assert.equal(result.refusal.code, "x402_unavailable", name);
    assert.equal(result.refusal.message, X402_DOOR_MESSAGES.unavailable, name);
    assert.deepEqual(result.headers, {}, name);
    assert.equal(rows(world).length, 0, name);
    assert.equal(world.modelRuns, 0, name);
    assert.ok(world.logs.some((line) => line.includes("x402 door not available")), name);
  }
});

test("a payer with no USDC account, too little USDC, or an expired blockhash would not go through: 402, before anything is written", async () => {
  const cases: Array<[string, (world: DoorWorld) => string]> = [
    [
      "no payer account",
      (w) => {
        const paid = pay(w);
        // The payer's associated token account, as the stand-in opened it.
        w.chain.close(getAssociatedTokenAddressSync(MINT, PAYER.publicKey, true));
        return paid.header;
      },
    ],
    ["too little USDC", (w) => pay(w, { usdc: PRICE_ATOMIC - 1n }).header],
    [
      "an expired blockhash",
      (w) => {
        const paid = pay(w);
        w.chain.advance(151);
        return paid.header;
      },
    ],
  ];
  for (const [name, make] of cases) {
    const world = doorWorld();
    const result = await call(world, { payment: make(world) });
    const { refusal } = refused(result);
    assert.equal(refusal.status, 402, name);
    assert.equal(refusal.code, "x402_payment_invalid", name);
    assert.equal(refusal.message, X402_DOOR_MESSAGES.wouldNotGoThrough, name);
    assert.equal(challengeOf(result).error, R.transactionSimulationFailed, name);
    assert.equal(rows(world).length, 0, name);
    assert.equal(world.modelRuns, 0, name);
  }
});

test("a simulation is of the payment as it stands, and a chain that cannot be read is not available", async () => {
  const world = doorWorld();
  answered(await call(world, { payment: pay(world).header }));
  assert.deepEqual(world.chain.chain.simulations.map((s) => s.config), [
    { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" },
  ]);

  const down = doorWorld();
  const paid = pay(down);
  down.chain.chain.readsFail = true;
  const result = refused(await call(down, { payment: paid.header }));
  assert.equal(result.refusal.status, 503);
  assert.equal(result.refusal.code, "x402_unavailable");
  assert.equal(rows(down).length, 0);
});

// ============================================
// 5. One delivered use
// ============================================

test("a delivered use: held, submitted, verified; the model runs before the send, and the answer is released after the chain and the sale", async () => {
  const world = doorWorld();
  const treasuryBefore = world.chain.usdcOf(TREASURY);
  const payerUsdcBefore = 10_000_000n;
  let heldWhileAnswering: Record<string, unknown> | null = null;
  world.model.onRun = () => {
    const row = only(world);
    heldWhileAnswering = { status: row.status, txSignature: row.txSignature, signedTxB64: row.signedTxB64 };
  };
  const paid = pay(world);
  const result = answered(await call(world, { payment: paid.header }));

  // While the answer was made, the row held nothing that can land.
  assert.deepEqual(heldWhileAnswering, { status: "held", txSignature: null, signedTxB64: null });
  const row = only(world);
  assert.equal(row.status, "verified");
  assert.equal(row.listingId, LISTING_ID);
  assert.equal(row.orgId, SELLER_ORG);
  assert.equal(row.network, "solana:devnet");
  assert.equal(row.amountRaw, "100000");
  assert.equal(row.payerAddress, PAYER.publicKey.toBase58());
  assert.equal(row.payeeAddress, TREASURY.toBase58());
  assert.equal(row.requestId, readX402Memo(paid.requirements.extra.memo, { listingId: LISTING_ID, amount: "100000", secret: MEMO_SECRET })?.nonce);
  assert.deepEqual(
    world.db.writes.filter((w) => w.startsWith(`payment:${row.id}:`)),
    [`payment:${row.id}:held`, `payment:${row.id}:submitted`, `payment:${row.id}:verified`],
  );

  // The order: claim, model, signature, submitted, send, the chain's yes, the sale, the release.
  const order = ["claim:held", "model", "sign", "submitted", "send", "fate:landed_ok", "sale", "returned:answer"];
  for (let i = 1; i < order.length; i += 1) before(world.trail, order[i - 1]!, order[i]!);

  // What the caller is told.
  assert.equal(result.text, ANSWER);
  assert.equal(result.useKind, "chat");
  assert.deepEqual(result.billing, { chargedCents: 10, balanceCents: null, access: "listing_pricing" });
  assert.equal(result.stream, null);
  assert.deepEqual(result.headers, { [X402_PAYMENT_RESPONSE_HEADER]: result.paymentResponse });
  const response = readPaymentResponse(result.paymentResponse);
  assert.deepEqual(response, {
    success: true,
    payer: PAYER.publicKey.toBase58(),
    transaction: row.txSignature,
    network: DEVNET,
    amount: "100000",
  });

  // The money: the USDC moved on the chain, and one sale, 90 and 10.
  assert.equal(world.chain.usdcOf(TREASURY), (treasuryBefore ?? 0n) + PRICE_ATOMIC);
  assert.equal(world.chain.usdcOf(PAYER.publicKey), payerUsdcBefore - PRICE_ATOMIC);
  assert.equal(world.db.revenues.length, 1);
  const [revenue] = world.db.revenues;
  assert.equal(revenue!.buyerId, null);
  assert.equal(revenue!.installId, null);
  assert.equal(revenue!.payerWallet, PAYER.publicKey.toBase58());
  assert.equal(revenue!.x402PaymentId, row.id);
  assert.equal(revenue!.type, "x402");
  assert.equal(revenue!.status, "settled");
  assert.equal(revenue!.grossAmountCents, 10n);
  assert.equal(revenue!.platformFeeCents, 1n);
  assert.equal(revenue!.creatorAmountCents, 9n);
  assert.deepEqual(
    world.db.earnings.map((e) => [e.orgId, e.type, e.amountCents, e.referenceId]),
    [[SELLER_ORG, "sale", 9n, revenue!.id]],
  );
  assert.equal(world.db.listings.get(LISTING_ID)!.totalRequests, 1n);
  // Never anyone's credits.
  assert.equal(world.db.balances.size, 0);
  assert.equal(world.db.ledger.length, 0);
  // The unpaid counters are untouched by a use that was paid.
  assert.deepEqual(await unpaidOf(world), { wallet: 0, address: 0 });
});

test("the answer is made as a buyer's paid answer is made, in the creator's organization, within what is left of 30 seconds", async () => {
  const world = doorWorld();
  const arrivedAt = new Date(world.nowMs - 4_000);
  answered(await call(world, { payment: pay(world).header, arrivedAt }));
  const [input] = world.chatInputs;
  assert.ok(input);
  assert.equal(input.caller, "public");
  assert.equal(input.source, "paid");
  assert.equal(input.orgId, SELLER_ORG);
  assert.deepEqual(input.agent, { id: AGENT_ID });
  assert.equal(input.hideSourceTitles, true);
  assert.equal(input.maxToolRounds, 4);
  assert.equal(input.systemAddendum, CONFIDENTIAL_CHAT_RULES);
  // The outbound tool the listing does not name is left out.
  assert.deepEqual(input.toolAllowlist, ["calculator"]);
  assert.deepEqual(input.messages, CHAT_BODY.messages);
  assert.equal(input.deadlineMs, X402_ANSWER_DEADLINE_MS - 4_000);
});

test("a task run at the door: the form's brief is what the model is asked, and the answer is a run", async () => {
  const world = doorWorld({ agent: { agentKind: "task", kindConfig: TASK_FORM } });
  const result = answered(await call(world, { kind: "run", body: { input: { topic: "Tides" }, stream: false }, payment: pay(world).header }));
  assert.equal(result.useKind, "run");
  const [input] = world.chatInputs;
  assert.notEqual(input!.systemAddendum, CONFIDENTIAL_CHAT_RULES);
  assert.match(String(input!.messages[0]!.content), /Tides/);
});

test("a stream is the whole answer replayed after the confirmation and the sale, and nothing before", async () => {
  const world = doorWorld();
  const result = answered(await call(world, { body: { ...CHAT_BODY, stream: true }, payment: pay(world).header }));
  before(world.trail, "fate:landed_ok", "returned:answer");
  before(world.trail, "sale", "returned:answer");
  assert.ok(result.stream);
  const text = await readAll(result.stream.stream);
  const events = text.split("\n\n").filter((event) => event.startsWith("data:"));
  assert.deepEqual(JSON.parse(events[0]!.slice(5)), {
    wheelsai: { billing: { chargedCents: 10, balanceCents: null, access: "listing_pricing" } },
  });
  const deltas = events
    .slice(1)
    .map((event) => event.slice(5).trim())
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data).choices?.[0]?.delta?.content ?? "")
    .join("");
  assert.equal(deltas, ANSWER);
  assert.ok(!text.includes(FREE_MODEL));
});

test("the model's cost is taken from the creator's share as a settled use's is", async () => {
  const world = doorWorld();
  world.modelCostMicros = 1_500_000n;
  answered(await call(world, { payment: pay(world).header }));
  const crossed = centsCrossed(1_500_000n, 1_500_000n);
  assert.equal(crossed, 1n);
  const [revenue] = world.db.revenues;
  assert.equal(revenue!.platformFeeCents, 1n + crossed);
  assert.equal(revenue!.creatorAmountCents, 9n - crossed);
  assert.equal(world.db.listings.get(LISTING_ID)!.useModelCostMicros, 1_500_000n);
  assert.equal(world.db.earnings[0]!.amountCents, 9n - crossed);
});

test("a door sale with a contributor pays the contributor's share as a settled sale pays it", async () => {
  const contributor = { orgId: "c0c0c0c0-0000-4000-8000-00000000c0c0", userId: "user-contributor", bps: 2_000 };
  const world = doorWorld({ contributor });
  answered(await call(world, { payment: pay(world).header }));
  const split = computeContributorSplit(9n, [contributor.bps]);
  const [revenue] = world.db.revenues;
  assert.deepEqual(
    world.db.earnings.map((e) => [e.orgId, e.type, e.amountCents, e.referenceId]),
    [
      [contributor.orgId, "contributor_share", split.amounts[0], revenue!.id],
      [SELLER_ORG, "sale", split.publisherCents, revenue!.id],
    ],
  );
  assert.equal(split.amounts[0], 1n);
  assert.equal(split.publisherCents, 8n);
  assert.ok(world.trail.includes("contributor_earning:1"));
});

// ============================================
// 6. No answer: nothing is signed or sent
// ============================================

test("a withheld answer, a failed answer and an answer past 30 seconds each leave the row failed, with nothing signed or sent", async () => {
  const cases: Array<[string, (world: DoorWorld) => void, number, string, string, boolean]> = [
    ["withheld", (w) => (w.model.answer = LEAK), 502, "answer_withheld", X402_DOOR_MESSAGES.withheld, true],
    [
      "failed",
      (w) =>
        (w.model.outcome = { ok: false, error: `the provider of ${FREE_MODEL} failed`, toolCalls: [], code: "provider_error" }),
      502,
      "model_error",
      X402_DOOR_MESSAGES.modelFailed,
      false,
    ],
    ["thrown", (w) => (w.model.throws = new Error(`${FREE_MODEL} for ${SELLER_ORG} blew up`)), 502, "model_error", X402_DOOR_MESSAGES.modelFailed, false],
    ["past 30 seconds", (w) => (w.model.takesMs = X402_ANSWER_DEADLINE_MS + 1_000), 504, "answer_timed_out", X402_DOOR_MESSAGES.tooSlow, true],
    [
      "the deadline",
      (w) => (w.model.outcome = { ok: false, error: "deadline", toolCalls: [], code: "deadline" }),
      504,
      "answer_timed_out",
      X402_DOOR_MESSAGES.tooSlow,
      true,
    ],
  ];
  for (const [name, arrange, status, code, message, unpaid] of cases) {
    const world = doorWorld();
    arrange(world);
    const result = refused(await call(world, { payment: pay(world).header }));
    assert.equal(result.refusal.status, status, name);
    assert.equal(result.refusal.code, code, name);
    assert.equal(result.refusal.message, message, name);
    assert.deepEqual(result.headers, {}, name);
    const row = only(world);
    assert.equal(row.status, "failed", name);
    assert.equal(row.failureReason, code, name);
    assert.equal(row.txSignature, null, name);
    assert.equal(row.signedTxB64, null, name);
    assert.ok(!world.trail.includes("sign"), name);
    assert.equal(world.chain.chain.sends.length, 0, name);
    assert.equal(world.db.revenues.length, 0, name);
    // A prompt can provoke the first two; a model that failed is not the payer's doing.
    assert.deepEqual(await unpaidOf(world), unpaid ? { wallet: 1, address: 1 } : { wallet: 0, address: 0 }, name);
  }
});

test("the caller leaving before the send sends nothing and counts an unpaid answer", async () => {
  const world = doorWorld();
  const caller = new AbortController();
  world.model.onRun = () => caller.abort();
  const result = refused(await call(world, { payment: pay(world).header, signal: caller.signal }));
  assert.equal(result.refusal.status, 499);
  assert.equal(result.refusal.code, "client_closed_request");
  assert.equal(result.refusal.message, X402_DOOR_MESSAGES.callerLeft);
  assert.equal(only(world).status, "failed");
  assert.equal(only(world).failureReason, "client_closed_request");
  assert.equal(world.chain.chain.sends.length, 0);
  assert.ok(!world.trail.includes("sign"));
  assert.deepEqual(await unpaidOf(world), { wallet: 1, address: 1 });
});

test("more than 45 seconds after the request arrived, nothing is signed or sent", async () => {
  const world = doorWorld();
  // It arrived 20 s ago; the answer is ready in time, and the read before the send is slow.
  const arrivedAt = new Date(world.nowMs - 20_000);
  world.model.takesMs = 9_000;
  world.onBlockhashCheck = (n) => {
    if (n === 1) world.elapse(X402_SEND_BY_MS - 29_000 + 1_000);
  };
  const result = refused(await call(world, { payment: pay(world).header, arrivedAt }));
  assert.equal(result.refusal.status, 504);
  assert.equal(result.refusal.code, "answer_timed_out");
  assert.equal(only(world).status, "failed");
  assert.equal(only(world).failureReason, "answer_timed_out");
  assert.ok(!world.trail.includes("sign"));
  assert.equal(world.chain.chain.sends.length, 0);
  // The answer was made: it counts as an unpaid answer.
  assert.deepEqual(await unpaidOf(world), { wallet: 1, address: 1 });
});

test("the caller leaving after the answer was made, while the blockhash is read before the send, sends nothing", async () => {
  const world = doorWorld();
  const caller = new AbortController();
  world.onBlockhashCheck = (n) => {
    if (n === 1) caller.abort();
  };
  const result = refused(await call(world, { payment: pay(world).header, signal: caller.signal }));
  assert.equal(result.refusal.status, 499);
  assert.equal(result.refusal.code, "client_closed_request");
  assert.equal(result.refusal.message, X402_DOOR_MESSAGES.callerLeft);
  assert.equal(only(world).status, "failed");
  assert.equal(only(world).failureReason, "client_closed_request");
  assert.equal(world.modelRuns, 1);
  assert.ok(!world.trail.includes("sign"));
  assert.equal(world.chain.chain.sends.length, 0);
  assert.deepEqual(await unpaidOf(world), { wallet: 1, address: 1 });
});

test("a blockhash that expired while the answer was made sends nothing: 402 with PAYMENT-RESPONSE success false, and an unpaid answer counted", async () => {
  const world = doorWorld();
  const paid = pay(world);
  // 10 blocks of life left at the checks; the answer takes 5 seconds (12 blocks).
  world.chain.advance(140);
  world.model.takesMs = 5_000;
  const result = refused(await call(world, { payment: paid.header }));
  assert.equal(result.refusal.status, 402);
  assert.equal(result.refusal.code, "x402_payment_failed");
  assert.equal(result.refusal.message, X402_DOOR_MESSAGES.expired);
  assert.deepEqual(readPaymentResponse(result.headers[X402_PAYMENT_RESPONSE_HEADER]!), {
    success: false,
    errorReason: R.transactionFailed,
    transaction: "",
    network: DEVNET,
  });
  assert.equal(only(world).status, "failed");
  assert.equal(only(world).failureReason, "expired");
  assert.ok(!world.trail.includes("sign"));
  assert.equal(world.chain.chain.sends.length, 0);
  assert.deepEqual(await unpaidOf(world), { wallet: 1, address: 1 });
});

// ============================================
// 7. After the send
// ============================================

test("a payment the chain refuses releases nothing, credits nobody, and counts an unpaid answer", async () => {
  const world = doorWorld();
  world.chain.chain.fate = "landed_failed";
  const result = refused(await call(world, { payment: pay(world).header }));
  assert.equal(result.refusal.status, 402);
  assert.equal(result.refusal.code, "x402_payment_failed");
  assert.equal(result.refusal.message, X402_DOOR_MESSAGES.chainRefused);
  assert.deepEqual(readPaymentResponse(result.headers[X402_PAYMENT_RESPONSE_HEADER]!), {
    success: false,
    errorReason: R.transactionFailed,
    transaction: "",
    network: DEVNET,
  });
  assert.equal(only(world).status, "failed");
  assert.equal(only(world).failureReason, X402_FAILED_ON_CHAIN_REASON);
  assert.ok(!world.trail.includes("sale"));
  assert.equal(world.db.revenues.length, 0);
  assert.equal(world.db.earnings.length, 0);
  assert.deepEqual(await unpaidOf(world), { wallet: 1, address: 1 });
});

test("a send the node refuses at preflight still counts as sent, and the wait believes 'dead' only 20 seconds after the send", async () => {
  const world = doorWorld();
  const paid = pay(world);
  // The blockhash has a few seconds of life left at the send, so it reads dead long before 20 seconds.
  world.chain.advance(140);
  world.model.takesMs = 1_000;
  world.chain.chain.send = "refused";
  const result = refused(await call(world, { payment: paid.header }));
  assert.equal(result.refusal.status, 402);
  assert.equal(result.refusal.code, "x402_payment_failed");
  assert.equal(result.refusal.message, X402_DOOR_MESSAGES.expired);
  assert.ok(world.events.some((event) => event.event === "send_error"));
  assert.ok(world.trail.includes("send"));
  const row = only(world);
  assert.equal(row.status, "failed");
  assert.equal(row.failureReason, X402_NEVER_LANDED_REASON);
  // Dead was read, and not believed, several times before it was.
  assert.ok(world.trail.filter((step) => step === "fate:dead").length > 5);
  const waited = world.nowMs - row.submittedAt!.getTime();
  assert.ok(waited >= X402_DOOR_DEAD_TRUSTED_AFTER_MS, `waited ${waited} ms`);
  assert.ok(waited < X402_DOOR_DEAD_TRUSTED_AFTER_MS + 2_000, `waited ${waited} ms`);
  assert.deepEqual(await unpaidOf(world), { wallet: 1, address: 1 });
  assert.equal(world.db.revenues.length, 0);
});

test("no confirmation within 2 minutes answers 504 with the transaction, and leaves the row submitted for the worker", async () => {
  const world = doorWorld({ blocksPerSecond: 0 });
  world.chain.chain.fate = "never";
  const result = refused(await call(world, { payment: pay(world).header }));
  const row = only(world);
  assert.equal(result.refusal.status, 504);
  assert.equal(result.refusal.code, "x402_payment_unconfirmed");
  assert.equal(result.refusal.message, X402_DOOR_MESSAGES.unconfirmed);
  assert.equal(result.refusal.transaction, row.txSignature);
  assert.ok(row.txSignature);
  assert.equal(row.status, "submitted");
  assert.ok(world.nowMs - row.submittedAt!.getTime() >= X402_DOOR_CONFIRM_MAX_MS - 1_000);
  assert.equal(world.db.revenues.length, 0);
});

test("confirmed after the caller left: unserved, no sale, nobody credited", async () => {
  const world = doorWorld();
  const caller = new AbortController();
  world.onSend = () => caller.abort();
  const result = refused(await call(world, { payment: pay(world).header, signal: caller.signal }));
  const row = only(world);
  assert.equal(row.status, "unserved");
  assert.equal(result.refusal.code, "x402_payment_unserved");
  assert.equal(result.refusal.transaction, row.txSignature);
  assert.equal(world.db.revenues.length, 0);
  assert.equal(world.db.earnings.length, 0);
  assert.ok(!world.trail.includes("sale"));
  // It landed: the USDC is in the treasury, and the operator is told.
  assert.equal(world.chain.usdcOf(TREASURY), PRICE_ATOMIC);
  assert.ok(world.logs.some((line) => line.includes("was not served")));
});

test("a sale that cannot be written marks the payment unserved and answers 502 with the transaction", async () => {
  const world = doorWorld();
  world.db.profiles.delete(SELLER_ORG);
  const result = refused(await call(world, { payment: pay(world).header }));
  const row = only(world);
  assert.equal(result.refusal.status, 502);
  assert.equal(result.refusal.code, "x402_payment_unserved");
  assert.equal(result.refusal.message, X402_DOOR_MESSAGES.unserved);
  assert.equal(result.refusal.transaction, row.txSignature);
  assert.equal(row.status, "unserved");
  // The sale's transaction rolled back whole.
  assert.equal(world.db.revenues.length, 0);
  assert.equal(world.db.earnings.length, 0);
  assert.equal(world.db.listings.get(LISTING_ID)!.totalRequests, 0n);
});

test("a sale that finds its payment no longer submitted writes nothing, and the answer is not released", async () => {
  const world = doorWorld();
  world.deps.recordSale = async () => ({ written: false });
  const result = refused(await call(world, { payment: pay(world).header }));
  assert.equal(result.refusal.status, 502);
  assert.equal(result.refusal.code, "x402_payment_unserved");
  assert.equal(result.refusal.transaction, only(world).txSignature);
  assert.equal(only(world).status, "unserved");
  assert.ok(world.logs.some((line) => line.includes("was not served")));
});

// ============================================
// 8. Shutdown
// ============================================

test("a shutdown before the send stops the use with nothing sent; one after the send stops neither the wait nor the sale", async () => {
  const early = doorWorld();
  early.model.onRun = () => void early.inFlight.cancelAll(10);
  const stopped = refused(await call(early, { payment: pay(early).header }));
  assert.equal(stopped.refusal.status, 503);
  assert.equal(stopped.refusal.code, "x402_unavailable");
  assert.equal(only(early).status, "failed");
  assert.equal(only(early).failureReason, "never_sent");
  assert.equal(early.chain.chain.sends.length, 0);
  assert.deepEqual(await unpaidOf(early), { wallet: 0, address: 0 });
  // Once shutdown began, no new use is admitted.
  const after = refused(await call(early, { payment: pay(early).header }));
  assert.equal(after.refusal.code, "x402_unavailable");
  assert.equal(rows(early).length, 1);

  // Between the answer and the send: still nothing is signed.
  const between = doorWorld();
  between.onBlockhashCheck = (n) => {
    if (n === 1) void between.inFlight.cancelAll(10);
  };
  const stoppedBetween = refused(await call(between, { payment: pay(between).header }));
  assert.equal(stoppedBetween.refusal.code, "x402_unavailable");
  assert.equal(only(between).failureReason, "never_sent");
  assert.equal(between.modelRuns, 1);
  assert.ok(!between.trail.includes("sign"));
  assert.equal(between.chain.chain.sends.length, 0);

  const late = doorWorld();
  late.onSend = () => void late.inFlight.cancelAll(10);
  answered(await call(late, { payment: pay(late).header }));
  assert.equal(only(late).status, "verified");
  assert.equal(late.db.revenues.length, 1);
});

// ============================================
// 8b. A dependency that throws
// ============================================

test("a claim that throws is not available, with no row and the model never run", async () => {
  const world = doorWorld();
  world.deps.payments.insertHeld = async () => {
    throw new Error("the database is down");
  };
  const result = refused(await call(world, { payment: pay(world).header }));
  assert.equal(result.refusal.status, 503);
  assert.equal(result.refusal.code, "x402_unavailable");
  assert.equal(result.refusal.message, X402_DOOR_MESSAGES.unavailable);
  assert.equal(rows(world).length, 0);
  assert.equal(world.modelRuns, 0);
  assert.ok(!world.trail.includes("sign"));
});

test("a dependency that throws after the claim ends the row unsent before the send, and leaves it submitted after", async () => {
  // Before the send, each ending fails the held row with nothing signed or sent.
  // The last field: the harness's own signer is in place, so a signature would show in the trail.
  const beforeSend: Array<[string, (world: DoorWorld) => void, string, boolean]> = [
    [
      "the answer maker throws",
      (w) => {
        w.deps.makeAnswer = async () => {
          throw new Error("boom");
        };
      },
      "never_sent",
      true,
    ],
    [
      "the signer throws",
      (w) => {
        w.deps.signAsFeePayer = () => {
          throw new Error("the key could not be read");
        };
      },
      "never_sent",
      false,
    ],
    [
      "the signer refuses a payment that passed its checks",
      (w) => {
        w.deps.signAsFeePayer = () => ({ invalidReason: R.feePayerTransferringFunds });
      },
      "never_sent",
      false,
    ],
    [
      "the blockhash read before the send throws",
      (w) => {
        w.onBlockhashCheck = (n) => {
          if (n === 1) w.chain.chain.readsFail = true;
        };
      },
      "chain_unreadable",
      true,
    ],
  ];
  for (const [name, arrange, reason, harnessSigner] of beforeSend) {
    const world = doorWorld();
    arrange(world);
    const result = refused(await call(world, { payment: pay(world).header }));
    assert.equal(result.refusal.status, 503, name);
    assert.equal(result.refusal.code, "x402_unavailable", name);
    assert.equal(result.refusal.message, X402_DOOR_MESSAGES.unavailable, name);
    assert.equal(result.refusal.transaction, undefined, name);
    const row = only(world);
    assert.equal(row.status, "failed", name);
    assert.equal(row.failureReason, reason, name);
    assert.equal(row.txSignature, null, name);
    assert.equal(row.signedTxB64, null, name);
    if (harnessSigner) assert.ok(!world.trail.includes("sign"), name);
    assert.ok(!world.trail.includes("submitted"), name);
    assert.equal(world.chain.chain.sends.length, 0, name);
    assert.equal(world.db.revenues.length, 0, name);
    assert.deepEqual(await unpaidOf(world), { wallet: 0, address: 0 }, name);
  }

  // After the send, a payment that may have landed is never called failed.
  const world = doorWorld();
  world.chain.chain.fate = "landed_failed";
  world.deps.payments.markSentFailed = async () => {
    throw new Error("the database is down");
  };
  const result = refused(await call(world, { payment: pay(world).header }));
  const row = only(world);
  assert.equal(result.refusal.status, 504);
  assert.equal(result.refusal.code, "x402_payment_unconfirmed");
  assert.equal(result.refusal.message, X402_DOOR_MESSAGES.unconfirmed);
  assert.ok(!/nothing was charged/i.test(result.refusal.message));
  assert.ok(row.txSignature);
  assert.equal(result.refusal.transaction, row.txSignature);
  assert.equal(row.status, "submitted");
  assert.equal(world.chain.chain.sends.length, 1);
  assert.equal(world.db.revenues.length, 0);
  assert.equal(world.db.earnings.length, 0);
});

// ============================================
// 9. One payment, one answer
// ============================================

test("a second payment from a wallet whose first is still open is refused 429, with the model never run for it", async () => {
  const world = doorWorld();
  let release!: () => void;
  world.model.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = call(world, { payment: pay(world).header });
  await until(() => world.modelRuns === 1);
  const second = refused(await call(world, { payment: pay(world).header }));
  assert.equal(second.refusal.status, 429);
  assert.equal(second.refusal.code, "rate_limited");
  assert.equal(second.refusal.message, X402_DOOR_MESSAGES.walletStillOpen);
  assert.equal(second.refusal.retryAfterSeconds, X402_SEND_BY_MS / 1000);
  assert.equal(world.modelRuns, 1);
  release();
  answered(await first);
  assert.equal(world.modelRuns, 1);
  assert.equal(world.db.revenues.length, 1);
  assert.equal(rows(world).length, 1);
});

test("one message under two valid payer signatures runs the model once; the second is presented twice before the chain is read", async () => {
  const world = doorWorld();
  const paid = pay(world);
  const message = VersionedTransaction.deserialize(Buffer.from(paid.b64, "base64")).message.serialize();
  const otherB64 = withSignature(paid.b64, 1, signWithNonce(message, PAYER, 7_777n));
  assert.notEqual(otherB64, paid.b64);
  const feePayer = FEE_PAYER.publicKey.toBase58();
  const one = verifyExactSvmTransaction(paid.b64, paid.requirements, { feePayer });
  const two = verifyExactSvmTransaction(otherB64, paid.requirements, { feePayer });
  assert.ok(one.isValid && two.isValid);
  assert.equal(one.messageHash, two.messageHash);

  answered(await call(world, { payment: paid.header }));
  const mark = world.trail.length;
  const result = await call(world, { payment: Buffer.from(JSON.stringify({ x402Version: 2, accepted: paid.requirements, payload: { transaction: otherB64 } })).toString("base64") });
  const { refusal } = refused(result);
  assert.equal(refusal.status, 402);
  assert.equal(refusal.code, "x402_payment_invalid");
  assert.equal(refusal.message, X402_DOOR_MESSAGES.presentedTwice);
  assert.equal(challengeOf(result).error, R.duplicateSettlement);
  assert.deepEqual(chainTouched(world.trail.slice(mark)), []);
  assert.equal(world.modelRuns, 1);
  assert.equal(world.chain.chain.sends.length, 1);
  assert.equal(world.db.revenues.length, 1);
});

test("a resend of a used payment is refused as presented twice before any limit is spent or the chain is read", async () => {
  const world = doorWorld();
  const paid = pay(world);
  answered(await call(world, { payment: paid.header }));
  const mark = world.trail.length;
  const wallet = PAYER.publicKey.toBase58();
  const minuteBefore = await world.store.peek(x402DoorKeys.walletMinute(wallet, HANDLE));
  const result = await call(world, { payment: paid.header });
  assert.equal(refused(result).refusal.message, X402_DOOR_MESSAGES.presentedTwice);
  assert.equal(challengeOf(result).error, R.duplicateSettlement);
  assert.deepEqual(chainTouched(world.trail.slice(mark)), []);
  assert.equal(await world.store.peek(x402DoorKeys.walletMinute(wallet, HANDLE)), minuteBefore);
  assert.equal(world.modelRuns, 1);
  assert.equal(world.chain.chain.sends.length, 1);
});

test("the same PAYMENT-SIGNATURE twice at once runs the model once and is sold once", async () => {
  const world = doorWorld();
  const paid = pay(world);
  const results = await Promise.all([call(world, { payment: paid.header }), call(world, { payment: paid.header })]);
  const kinds = results.map((result) => result.kind).sort();
  assert.deepEqual(kinds, ["answer", "refusal"]);
  const refusal = results.find((result) => result.kind === "refusal")!;
  assert.equal(refused(refusal).refusal.message, X402_DOOR_MESSAGES.presentedTwice);
  assert.equal(world.modelRuns, 1);
  assert.equal(world.chain.chain.sends.length, 1);
  assert.equal(world.db.revenues.length, 1);
  assert.equal(rows(world).length, 1);
});

test("after three unpaid answers in a day, the wallet's fourth payment is refused before the model; so is another wallet's from that address", async () => {
  const world = doorWorld();
  world.model.answer = LEAK;
  for (let i = 0; i < X402_UNPAID_ANSWERS_PER_DAY; i += 1) {
    assert.equal(refused(await call(world, { payment: pay(world).header })).refusal.code, "answer_withheld");
  }
  assert.equal(world.modelRuns, 3);
  const fourth = refused(await call(world, { payment: pay(world).header }));
  assert.equal(fourth.refusal.status, 429);
  assert.equal(fourth.refusal.code, "x402_too_many_unpaid");
  const otherWallet = refused(await call(world, { payment: pay(world, { payer: keypairOf(11) }).header }));
  assert.equal(otherWallet.refusal.code, "x402_too_many_unpaid");
  assert.equal(world.modelRuns, 3);
  assert.equal(world.chain.chain.sends.length, 0);
});

// ============================================
// 10. What a caller is never told
// ============================================

test("no answer, refusal or header holds the creator's organization, the model, a node's or the database's words, or the fee payer's balance", async () => {
  const NODE_WORDS = `node says ${SELLER_ORG} ${FREE_MODEL} relation x402_payments`;
  const texts: string[] = [];
  const record = async (result: X402UseResult<unknown>) => {
    texts.push(JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
    if (result.kind === "refusal") {
      for (const value of Object.values(result.headers)) texts.push(Buffer.from(value, "base64").toString("utf8"));
    }
    if (result.kind === "answer") {
      texts.push(Buffer.from(result.paymentResponse, "base64").toString("utf8"));
      if (result.stream) texts.push(await readAll(result.stream.stream));
    }
  };

  // A simulation the node refuses in its own words.
  const sim = doorWorld();
  const simulate = sim.chain.connection.simulateTransaction;
  sim.chain.connection.simulateTransaction = async (tx, config) => {
    const answer = await simulate(tx, config);
    return { ...answer, value: { ...answer.value, err: NODE_WORDS } };
  };
  await record(await call(sim, { payment: pay(sim).header }));

  // A model that throws naming everything.
  const model = doorWorld();
  model.model.throws = new Error(NODE_WORDS);
  await record(await call(model, { payment: pay(model).header }));

  // A send that throws in the node's words, delivered as a stream.
  const send = doorWorld();
  const sendRaw = send.chain.connection.sendRawTransaction;
  send.chain.connection.sendRawTransaction = async (raw, opts) => {
    await sendRaw(raw, opts);
    throw new Error(NODE_WORDS);
  };
  await record(await call(send, { body: { ...CHAT_BODY, stream: true }, payment: pay(send).header }));

  // A sale the database refuses in its own words.
  const sale = doorWorld();
  sale.deps.recordSale = async () => {
    throw new Error(NODE_WORDS);
  };
  await record(await call(sale, { payment: pay(sale).header }));

  // A fee payer under its floor, and a chain that cannot be read.
  const poor = doorWorld({ feePayerLamports: 1_234_567n });
  await record(await call(poor, { payment: pay(poor).header }));
  const unreadable = doorWorld();
  const paidThere = pay(unreadable);
  unreadable.chain.chain.readsFail = true;
  await record(await call(unreadable, { payment: paidThere.header }));

  const whole = texts.join("\n");
  for (const secret of [
    SELLER_ORG,
    FREE_MODEL,
    "node says",
    "relation",
    "marigold",
    INSTRUCTIONS.slice(0, 40),
    String(FEE_PAYER_LAMPORTS),
    "1234567",
    "lamports",
    "stand-in",
  ]) {
    assert.ok(!whole.includes(secret), `a caller was told "${secret}"`);
  }
  for (const world of [sim, send, poor]) {
    const left = world.chain.lamportsOf(FEE_PAYER.publicKey);
    if (left !== null) assert.ok(!whole.includes(left.toString()));
  }
  // The operator was told, in the log.
  assert.ok(sim.logs.some((line) => line.includes("node says")));
});

test("every sentence a refusal at the door carried is the door's own, and none speaks of a refund or a credit balance", () => {
  assert.ok(seen.length > 50, `refusals seen: ${seen.length}`);
  const strings = (values: readonly unknown[]) => values.filter((value): value is string => typeof value === "string");
  const door = new Set<string>([
    ...strings(Object.values(X402_DOOR_MESSAGES)),
    X402_DOOR_MESSAGES.paymentRequired(PRICE_CENTS, "message"),
    X402_DOOR_MESSAGES.paymentRequired(PRICE_CENTS, "run"),
  ]);
  // The body's refusals are paid use's, word for word, by the rules.
  const body = new Set<string>([PAID_USE_MESSAGES.invalidChatBody, PAID_USE_MESSAGES.invalidTaskBody, ...strings(Object.values(TASK_MESSAGES))]);
  for (const refusal of seen) {
    const bodyCode = ["invalid_request", "input_invalid", "input_too_large", "not_a_task_agent"].includes(refusal.code);
    assert.ok(bodyCode ? body.has(refusal.message) : door.has(refusal.message), `${refusal.code}: ${refusal.message}`);
    assert.ok(!/refund|credit balance/i.test(refusal.message), refusal.message);
    assert.equal(refusal.refundedCents, undefined, refusal.code);
  }
});

// ============================================
// 11. In the source
// ============================================

const SERVICES = fileURLToPath(new URL("../services/", import.meta.url));
const CORE = join(SERVICES, "paidUseX402.ts");

test("in the source: the core calls nothing of paid use's money, of a deployment's payment or of a refund", () => {
  const source = readFileSync(CORE, "utf8");
  for (const name of [
    "runPaidUse",
    "runPaidChat",
    "runPaidTask",
    "beginUseMetering",
    "loadLicence",
    "resolveUseBilling",
    "readBalance",
    "peekKeySpend",
    "chargeMarketplaceRequest",
    "settleMarketplaceRequest",
    "takeX402Payment",
    "decodeX402Payment",
    "returnX402Payment",
    "writeTranscript",
    "X402_REFUSAL_MESSAGES",
    "couldNotAnswer",
    "restartedMidway",
    "notEnoughCredits",
  ]) {
    assert.equal(source.includes(name), false, `paidUseX402.ts names ${name}`);
  }
  // Of paid use's sentences, only the two of a body it cannot read.
  const sentences = [...source.matchAll(/PAID_USE_MESSAGES\.(\w+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(sentences)].sort(), ["invalidChatBody", "invalidTaskBody"]);
  // No sentence of a refund; the one meter it could ever meet is closed, never kept.
  assert.equal(/refunded|credit balance/i.test(source), false, "no sentence of a refund");
  assert.deepEqual(source.match(/\.refund\(/g), [".refund("]);
  assert.ok([...source].every((ch) => ch.charCodeAt(0) < 128), "plain ASCII");
});

test("in the source: the core imports nothing that reads the settings, the database or the chain", () => {
  const seenFiles = new Set<string>();
  const offenders: string[] = [];
  const walk = (file: string) => {
    if (seenFiles.has(file)) return;
    seenFiles.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^(?:import|export)\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gms)) {
      if (match[1]) continue;
      const spec = match[2]!;
      if (/config\/env|lib\/prisma|@wheelsai\/db|lib\/solana\.js|utils\/logger/.test(spec)) offenders.push(`${file} imports ${spec}`);
      if (!spec.startsWith(".")) continue;
      const next = resolve(dirname(file), spec).replace(/\.js$/, ".ts");
      if (existsSync(next)) walk(next);
    }
    if (/process\.env|getSolanaConnection|new Connection\(/.test(source.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ""))) {
      offenders.push(`${file} reads the environment or the chain`);
    }
  };
  walk(CORE);
  assert.ok(seenFiles.size > 10, "the walk followed the imports");
  assert.deepEqual(offenders, []);
});
