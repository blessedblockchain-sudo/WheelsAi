import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCancelPayoutDeps,
  cancelPayout,
  isPayoutCancellable,
  payoutAvailability,
  payoutFailureMessage,
  payoutNotCancellableMessage,
  payoutsRunning,
  payoutView,
  PAYOUTS_UNAVAILABLE_MESSAGE,
} from "../services/payoutRequests.js";
import { PAYOUT_WAITING_MESSAGE } from "../services/payoutSentences.js";
import {
  fakeDb,
  ORG,
  OTHER_ORG,
  PAYOUT,
  payoutApp,
  payoutRow,
  routeDepsOver,
  standInClaim,
  type LedgerRow,
} from "./payoutFakes.js";

// A payout requested while the payout worker is off used to stay "pending"
// for ever, with the creator's earnings reserved inside it and no way to
// take it back. A request is now refused before anything is reserved while
// payouts are not running, and a pending payout can be cancelled: the row
// becomes cancelled and its amount returns to the earnings in one
// transaction, racing the worker's claim with exactly one winner.
//
// The request itself is in payoutReservation.unit.test.ts (the core) and
// payoutRoutes.unit.test.ts (the route). The worker's side of the race is
// tested with the worker; here its claim is a stand-in, one compare-and-set.

/** The one ledger row a cancelled payout leaves: its amount, put back. */
function cancelledRow(balanceAfter: bigint, over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    orgId: ORG,
    amountCents: 2500n,
    type: "payout_restored",
    referenceId: PAYOUT,
    description: "Payout cancelled, amount returned",
    balanceAfter,
    ...over,
  };
}

// ---------------------------------------------------------------
// One rule for "payouts are running"
// ---------------------------------------------------------------

test("payouts are running only with the switch on and the worker scheduled", () => {
  assert.equal(payoutsRunning({ PAYOUTS_ENABLED: true, PAYOUT_EXECUTOR_INTERVAL_MS: 60000 }), true);
  assert.equal(payoutsRunning({ PAYOUTS_ENABLED: true, PAYOUT_EXECUTOR_INTERVAL_MS: 0 }), false);
  assert.equal(payoutsRunning({ PAYOUTS_ENABLED: false, PAYOUT_EXECUTOR_INTERVAL_MS: 60000 }), false);
  assert.equal(payoutsRunning({ PAYOUTS_ENABLED: "true", PAYOUT_EXECUTOR_INTERVAL_MS: 60000 } as any), false);
  assert.equal(payoutsRunning({ PAYOUTS_ENABLED: true, PAYOUT_EXECUTOR_INTERVAL_MS: "60000" } as any), false);
  assert.equal(payoutsRunning(undefined as any), false);
});

test("availability fails closed when the settings cannot be read", () => {
  assert.deepEqual(payoutAvailability(() => ({ PAYOUTS_ENABLED: true, PAYOUT_EXECUTOR_INTERVAL_MS: 1 })), {
    available: true,
  });
  assert.deepEqual(
    payoutAvailability(() => {
      throw new Error("no settings");
    }),
    { available: false },
  );
});

test("GET /api/capabilities answers payouts.available by the same rule", async () => {
  const { buildCapabilitiesDeps } = await import("../routes/capabilitiesBindings.js");
  const cases = [
    { PAYOUTS_ENABLED: true, PAYOUT_EXECUTOR_INTERVAL_MS: 60000 },
    { PAYOUTS_ENABLED: true, PAYOUT_EXECUTOR_INTERVAL_MS: 0 },
    { PAYOUTS_ENABLED: false, PAYOUT_EXECUTOR_INTERVAL_MS: 60000 },
    { PAYOUTS_ENABLED: false, PAYOUT_EXECUTOR_INTERVAL_MS: 0 },
  ];
  for (const settings of cases) {
    const deps = buildCapabilitiesDeps({
      env: () => ({ ...settings, AGENT_GPU_ENABLED: false, JOB_RUNNER_CONCURRENCY: 0 }),
      availableFreeModels: () => [],
      emailConfigured: () => false,
      auth: async () => undefined,
    });
    assert.equal(deps.payouts(), payoutAvailability(() => settings).available);
  }
});

// ---------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------

test("cancel restores the amount once, and a second cancel does nothing", async () => {
  const { state, db } = fakeDb([payoutRow()], { [ORG]: 300n });
  const deps = buildCancelPayoutDeps(db);

  const first = await cancelPayout(deps, { payoutId: PAYOUT, orgId: ORG });
  assert.equal(first.outcome, "cancelled");
  assert.equal(first.outcome === "cancelled" && first.payout.status, "cancelled");
  assert.equal(state.payouts[0]!.status, "cancelled");
  assert.equal(state.balances[ORG], 2800n);
  assert.equal(state.balanceWrites, 1);
  assert.deepEqual(state.ledger, [cancelledRow(2800n)]);

  const second = await cancelPayout(deps, { payoutId: PAYOUT, orgId: ORG });
  assert.deepEqual(second, { outcome: "not_cancellable", status: "cancelled" });
  assert.equal(state.balances[ORG], 2800n);
  assert.equal(state.balanceWrites, 1, "the balance is credited exactly once");
  assert.equal(state.payoutWrites, 1);
  assert.deepEqual(state.ledger, [cancelledRow(2800n)], "one ledger row, not two");
});

test("two cancels at once: one restores, the other writes nothing", async () => {
  const { state, db } = fakeDb([payoutRow()], { [ORG]: 0n });
  const deps = buildCancelPayoutDeps(db);
  const results = await Promise.all([
    cancelPayout(deps, { payoutId: PAYOUT, orgId: ORG }),
    cancelPayout(deps, { payoutId: PAYOUT, orgId: ORG }),
  ]);
  assert.deepEqual(results.map((r) => r.outcome).sort(), ["cancelled", "not_cancellable"]);
  assert.equal(state.balances[ORG], 2500n);
  assert.equal(state.balanceWrites, 1);
  assert.deepEqual(state.ledger, [cancelledRow(2500n)]);
});

test("cancel against the worker's claim: the claim wins, nothing is restored", async () => {
  const { state, db } = fakeDb([payoutRow()], { [ORG]: 0n });
  const claim = standInClaim(db);

  assert.equal(await claim(PAYOUT), true);
  const cancel = await cancelPayout(buildCancelPayoutDeps(db), { payoutId: PAYOUT, orgId: ORG });

  assert.deepEqual(cancel, { outcome: "not_cancellable", status: "processing" });
  assert.equal(state.payouts[0]!.status, "processing");
  assert.equal(state.balances[ORG], 0n, "a payout being sent is never also given back");
  assert.equal(state.balanceWrites, 0);
  assert.equal(state.ledger.length, 0);
});

test("cancel against the worker's claim: the cancel wins, the claim does nothing", async () => {
  const { state, db } = fakeDb([payoutRow()], { [ORG]: 0n });
  const claim = standInClaim(db);

  const cancel = await cancelPayout(buildCancelPayoutDeps(db), { payoutId: PAYOUT, orgId: ORG });
  assert.equal(cancel.outcome, "cancelled");
  assert.equal(await claim(PAYOUT), false, "a cancelled payout cannot be claimed");

  assert.equal(state.payouts[0]!.status, "cancelled");
  assert.equal(state.balances[ORG], 2500n);
  assert.equal(state.balanceWrites, 1);
  assert.deepEqual(state.ledger, [cancelledRow(2500n)]);
});

test("the claim lands between the cancel's read and its write: the cancel loses and writes nothing", async () => {
  const { state, db } = fakeDb([payoutRow()], { [ORG]: 0n });
  const claim = standInClaim(db);
  const deps = buildCancelPayoutDeps(db);

  // The cancel reads "pending"; the worker claims before the transaction.
  const racing = {
    ...deps,
    transaction: async <T>(fn: Parameters<typeof deps.transaction<T>>[0]) => {
      assert.equal(await claim(PAYOUT), true);
      return deps.transaction(fn);
    },
  };
  const cancel = await cancelPayout(racing, { payoutId: PAYOUT, orgId: ORG });

  assert.deepEqual(cancel, { outcome: "not_cancellable", status: "processing" });
  assert.equal(state.payouts[0]!.status, "processing");
  assert.equal(state.balances[ORG], 0n);
  assert.equal(state.balanceWrites, 0);
  assert.equal(state.ledger.length, 0);
});

test("claim and cancel fired together: exactly one of them happens", async () => {
  for (const order of ["cancel-first", "claim-first"] as const) {
    const { state, db } = fakeDb([payoutRow()], { [ORG]: 0n });
    const claimPayout = standInClaim(db);
    const deps = buildCancelPayoutDeps(db);
    const cancel = () => cancelPayout(deps, { payoutId: PAYOUT, orgId: ORG });
    const claim = () => claimPayout(PAYOUT);

    const [a, b] =
      order === "cancel-first" ? await Promise.all([cancel(), claim()]) : await Promise.all([claim(), cancel()]);
    const cancelResult = (order === "cancel-first" ? a : b) as Awaited<ReturnType<typeof cancel>>;
    const claimed = (order === "cancel-first" ? b : a) as boolean;

    const cancelled = cancelResult.outcome === "cancelled";
    assert.notEqual(cancelled, claimed, `${order}: exactly one winner`);
    assert.equal(state.payouts[0]!.status, cancelled ? "cancelled" : "processing");
    assert.equal(state.balances[ORG], cancelled ? 2500n : 0n);
    assert.equal(state.balanceWrites, cancelled ? 1 : 0);
    assert.deepEqual(state.ledger, cancelled ? [cancelledRow(2500n)] : []);
  }
});

test("another organization cannot cancel: not found, nothing changes", async () => {
  const { state, db } = fakeDb([payoutRow()], { [ORG]: 0n, [OTHER_ORG]: 0n });
  const result = await cancelPayout(buildCancelPayoutDeps(db), { payoutId: PAYOUT, orgId: OTHER_ORG });
  assert.deepEqual(result, { outcome: "not_found" });
  assert.equal(state.payouts[0]!.status, "pending");
  assert.deepEqual(state.balances, { [ORG]: 0n, [OTHER_ORG]: 0n });
  assert.equal(state.balanceWrites + state.payoutWrites, 0);
  assert.equal(state.ledger.length, 0);
});

test("a lookup that forgot the organization still cannot hand a payout across", async () => {
  let wrote = false;
  const result = await cancelPayout(
    {
      findPayout: async () => payoutRow(),
      transaction: async () => {
        wrote = true;
        throw new Error("must not open a transaction");
      },
    },
    { payoutId: PAYOUT, orgId: OTHER_ORG },
  );
  assert.deepEqual(result, { outcome: "not_found" });
  assert.equal(wrote, false);
});

test("an unknown payout is not found", async () => {
  const { db } = fakeDb([], { [ORG]: 0n });
  assert.deepEqual(
    await cancelPayout(buildCancelPayoutDeps(db), { payoutId: PAYOUT, orgId: ORG }),
    { outcome: "not_found" },
  );
});

test("a payout that is being sent or is finished is not cancellable", async () => {
  for (const status of ["processing", "completed", "failed", "cancelled"]) {
    const { state, db } = fakeDb([payoutRow({ status })], { [ORG]: 0n });
    const result = await cancelPayout(buildCancelPayoutDeps(db), { payoutId: PAYOUT, orgId: ORG });
    assert.deepEqual(result, { outcome: "not_cancellable", status });
    assert.equal(state.balanceWrites + state.payoutWrites, 0);
    assert.equal(state.ledger.length, 0);
  }
});

test("if the earnings cannot be restored the cancel rolls back: the payout stays pending", async () => {
  // No balance row for the organization: the restore throws.
  const { state, db } = fakeDb([payoutRow()], {});
  await assert.rejects(cancelPayout(buildCancelPayoutDeps(db), { payoutId: PAYOUT, orgId: ORG }));
  assert.equal(state.payouts[0]!.status, "pending", "never cancelled without its amount given back");
  assert.equal(state.ledger.length, 0);
});

test("an amount that cannot be read is never put on a balance", async () => {
  for (const amountCents of [0n, -5n, 2500 as unknown as bigint, null as unknown as bigint]) {
    const { state, db } = fakeDb([payoutRow({ amountCents })], { [ORG]: 0n });
    await assert.rejects(cancelPayout(buildCancelPayoutDeps(db), { payoutId: PAYOUT, orgId: ORG }));
    assert.equal(state.payouts[0]!.status, "pending");
    assert.equal(state.balances[ORG], 0n);
    assert.equal(state.ledger.length, 0);
  }
});

// ---------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------

// Every reason the executor records, plus the shapes a send error takes.
const RAW_REASONS = [
  "missing payout address",
  "invalid payout address",
  "crypto payouts not configured (no payout wallet)",
  "unsupported payout method: paypal",
  'prior payout tx failed on-chain: {"InstructionError":[0,{"Custom":1}]}',
  'payout tx failed on-chain: {"InstructionError":[2,"InsufficientFunds"]}',
  "payout tx did not sign",
  "failed to send transaction: Transaction simulation failed: Blockhash not found",
  "429 Too Many Requests: https://api.mainnet-beta.solana.com",
  'PrismaClientKnownRequestError: Invalid `prisma.creatorPayout.updateMany()` invocation P2002',
  "connect ECONNREFUSED 127.0.0.1:8899",
  "",
];

test("a failure sentence never contains the raw reason", () => {
  const leaks = /tx\b|on-chain|InstructionError|Custom|prisma|P2002|ECONNREFUSED|https?:|blockhash|simulation|configured|\{|\}|\d{3}/i;
  for (const reason of RAW_REASONS) {
    const sentence = payoutFailureMessage(reason);
    assert.ok(sentence.length > 0);
    if (reason !== "") assert.ok(!sentence.includes(reason), `leaks: ${reason}`);
    assert.doesNotMatch(sentence, leaks, `leaks a processor word: ${reason} -> ${sentence}`);
    assert.ok(!sentence.includes("—"), "no em dash");
    assert.match(sentence, /back in your earnings/);
  }
});

test("known reasons get their own sentence; anything else gets the general one", () => {
  const general = payoutFailureMessage("something nobody has seen before");
  assert.equal(general, "This payout could not be sent. The amount is back in your earnings. You can request it again.");
  assert.equal(payoutFailureMessage(null), general);
  assert.equal(payoutFailureMessage(undefined), general);
  assert.equal(payoutFailureMessage(""), general);
  assert.equal(payoutFailureMessage({ err: "x" } as any), general);

  assert.match(payoutFailureMessage("missing payout address"), /no wallet address/);
  assert.match(payoutFailureMessage("invalid payout address"), /not valid/);
  assert.match(payoutFailureMessage("crypto payouts not configured (no payout wallet)"), /not available right now/);
  assert.match(payoutFailureMessage("unsupported payout method: paypal"), /not supported/);
  assert.doesNotMatch(payoutFailureMessage("unsupported payout method: paypal"), /paypal/);
  assert.match(payoutFailureMessage("payout tx did not sign"), /did not go through/);
  assert.match(payoutFailureMessage('payout tx failed on-chain: {"x":1}'), /did not go through/);
});

test("the not-cancellable sentences are plain and say where the money is", () => {
  assert.match(payoutNotCancellableMessage("processing"), /already being sent/);
  assert.match(payoutNotCancellableMessage("completed"), /already sent/);
  assert.match(payoutNotCancellableMessage("cancelled"), /already cancelled/);
  assert.match(payoutNotCancellableMessage("failed"), /back in your earnings/);
  assert.equal(payoutNotCancellableMessage("???"), "This payout can no longer be cancelled.");
});

// ---------------------------------------------------------------
// The list
// ---------------------------------------------------------------

test("the list says cancellable only for a pending payout", () => {
  assert.equal(isPayoutCancellable("pending"), true);
  for (const status of ["processing", "completed", "failed", "cancelled", "", "PENDING"]) {
    assert.equal(isPayoutCancellable(status), false);
    assert.equal(payoutView(payoutRow({ status })).cancellable, false);
  }
  assert.equal(payoutView(payoutRow()).cancellable, true);
});

test("a payout in the list keeps every field it had, plus cancellable, and a plain failure sentence", () => {
  const raw = 'payout tx failed on-chain: {"InstructionError":[0,{"Custom":1}]}';
  const failed = payoutView(
    payoutRow({ status: "failed", failureReason: raw, payoutMethod: "crypto_sol", payoutAddress: "Wa11et" }),
  );
  assert.deepEqual(Object.keys(failed), [
    "id",
    "amountCents",
    "payoutMethod",
    "payoutAddress",
    "status",
    "txSignature",
    "grossRevenueCents",
    "platformFeeCents",
    "periodStart",
    "periodEnd",
    "requestedAt",
    "processedAt",
    "failureReason",
    "cancellable",
    "message",
  ]);
  assert.equal(failed.amountCents, 2500);
  assert.equal(failed.grossRevenueCents, 2778);
  assert.equal(failed.platformFeeCents, 278);
  assert.equal(failed.failureReason, payoutFailureMessage(raw));
  assert.equal(failed.message, payoutFailureMessage(raw), "a failed payout's message is its failure sentence");
  assert.ok(!JSON.stringify(failed).includes("InstructionError"));

  // It did not fail: no sentence, whatever the column holds.
  assert.equal(payoutView(payoutRow()).failureReason, null);
  assert.equal(payoutView(payoutRow({ status: "completed", failureReason: "stale text" })).failureReason, null);
  assert.equal(payoutView(payoutRow({ status: "cancelled" })).failureReason, null);
  // It failed and no reason was recorded: still a sentence.
  assert.equal(payoutView(payoutRow({ status: "failed" })).failureReason, payoutFailureMessage(null));
});

test("message: the waiting sentence for a held pending payout, the failure sentence for a failed one, else null", () => {
  // Pending and not held: nothing to say.
  assert.equal(payoutView(payoutRow()).message, null);
  assert.equal(payoutView(payoutRow({ waitingReason: null })).message, null);
  // Pending and held, whatever is holding it: one sentence, and still cancellable.
  for (const waitingReason of ["wallet_low", "daily_limit_reached", "price_unavailable", "chain_unavailable", "a code from later"]) {
    const held = payoutView(payoutRow({ payoutMethod: "crypto_usdc", waitingReason }));
    assert.equal(held.message, PAYOUT_WAITING_MESSAGE);
    assert.equal(held.message, "This payout is waiting to be sent. You can cancel it and keep your earnings.");
    assert.equal(held.cancellable, true);
    assert.equal(held.failureReason, null);
    assert.ok(!JSON.stringify(held).includes(waitingReason), "the code itself is not sent");
  }
  // A waiting reason left on a row that has moved on says nothing.
  for (const status of ["processing", "completed", "cancelled"]) {
    assert.equal(payoutView(payoutRow({ status, waitingReason: "wallet_low" })).message, null);
  }
  // Failed with a code: the code's sentence, in both fields, and never the recorded text.
  const raw = 'SendTransactionError: {"InstructionError":[0,{"Custom":1}]}';
  const failed = payoutView(payoutRow({ status: "failed", failureCode: "could_not_send", failureReason: raw }));
  assert.equal(
    failed.message,
    "This payout could not be sent to that wallet address. The amount is back in your earnings.",
  );
  assert.equal(failed.failureReason, failed.message);
  assert.ok(!JSON.stringify(failed).includes("InstructionError"));
  assert.ok(!("failureCode" in failed) && !("waitingReason" in failed));
  // Failed with no code (an older row): the older matcher.
  const older = payoutView(payoutRow({ status: "failed", failureReason: "invalid payout address" }));
  assert.match(older.message!, /not valid/);
  assert.equal(older.failureReason, older.message);
});

// ---------------------------------------------------------------
// Routes: availability, the cancel, the list
// ---------------------------------------------------------------

test("POST /payouts while payouts are off: 503, the balance is left and nothing is read or written", async () => {
  const { state, db } = fakeDb([], { [ORG]: 2500n });
  const { routeDeps, chainReads } = routeDepsOver(db, { running: false });
  let ran = false;
  const app = await payoutApp({
    ...routeDeps,
    requestPayout: async (input) => {
      ran = true;
      return routeDeps.requestPayout(input);
    },
  });
  try {
    // Even a body that would be refused answers 503 first: nothing is looked at.
    for (const payload of [{ payoutMethod: "credits" }, { payoutMethod: "crypto_sol" }, {}]) {
      const res = await app.inject({ method: "POST", url: "/payouts", payload });
      assert.equal(res.statusCode, 503);
      assert.deepEqual(res.json(), { error: "payouts_unavailable", message: PAYOUTS_UNAVAILABLE_MESSAGE });
    }
    assert.equal(
      PAYOUTS_UNAVAILABLE_MESSAGE,
      "Payouts are temporarily unavailable. Nothing was reserved and your earnings are unchanged. Try again later.",
    );
    assert.equal(ran, false, "the payout service does not run at all");
    assert.equal(chainReads.length, 0);
    assert.equal(state.balanceWrites + state.payoutInserts, 0);
    assert.equal(state.balances[ORG], 2500n);
    assert.equal(state.payouts.length, 0);
  } finally {
    await app.close();
  }
});

test("POST /payouts/:id/cancel works while payouts are off: 200, then 409, the amount restored once", async () => {
  const { state, db } = fakeDb([payoutRow()], { [ORG]: 0n });
  const app = await payoutApp(routeDepsOver(db, { running: false }).routeDeps);
  try {
    const res = await app.inject({ method: "POST", url: `/payouts/${PAYOUT}/cancel` });
    assert.equal(res.statusCode, 200);
    const { payout } = res.json();
    assert.equal(payout.id, PAYOUT);
    assert.equal(payout.status, "cancelled");
    assert.equal(payout.amountCents, 2500);
    assert.equal(payout.payoutMethod, "credits");
    assert.equal(payout.cancellable, false);
    assert.equal(payout.failureReason, null);
    assert.equal(payout.message, null);
    assert.equal(typeof payout.requestedAt, "string");
    assert.equal(state.balances[ORG], 2500n);

    const again = await app.inject({ method: "POST", url: `/payouts/${PAYOUT}/cancel` });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error, "payout_not_cancellable");
    assert.equal(again.json().message, payoutNotCancellableMessage("cancelled"));
    assert.equal(state.balances[ORG], 2500n);
    assert.equal(state.balanceWrites, 1);
    assert.deepEqual(state.ledger, [cancelledRow(2500n)]);

    const list = await app.inject({ method: "GET", url: "/payouts" });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().payouts[0].status, "cancelled");
    assert.equal(list.json().payouts[0].cancellable, false);
  } finally {
    await app.close();
  }
});

test("a payout the worker is holding can be cancelled: its amount comes back once", async () => {
  const held = payoutRow({ payoutMethod: "crypto_usdc", waitingReason: "wallet_low" });
  const { state, db } = fakeDb([held], { [ORG]: 0n });
  const app = await payoutApp(routeDepsOver(db).routeDeps);
  try {
    const list = await app.inject({ method: "GET", url: "/payouts" });
    assert.equal(list.json().payouts[0].message, PAYOUT_WAITING_MESSAGE);
    assert.equal(list.json().payouts[0].cancellable, true);

    const res = await app.inject({ method: "POST", url: `/payouts/${PAYOUT}/cancel` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().payout.status, "cancelled");
    assert.equal(res.json().payout.message, null);
    assert.equal(state.balances[ORG], 2500n);
    assert.equal(state.balanceWrites, 1);
  } finally {
    await app.close();
  }
});

test("POST /payouts/:id/cancel: 409 once it is being sent, 404 for unknown, foreign and malformed ids", async () => {
  const sending = payoutRow({ status: "processing" });
  const foreign = payoutRow({ id: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee", publisherId: OTHER_ORG });
  const { state, db } = fakeDb([sending, foreign], { [ORG]: 0n, [OTHER_ORG]: 0n });
  const app = await payoutApp(routeDepsOver(db).routeDeps);
  try {
    const busy = await app.inject({ method: "POST", url: `/payouts/${PAYOUT}/cancel` });
    assert.equal(busy.statusCode, 409);
    assert.deepEqual(busy.json(), {
      error: "payout_not_cancellable",
      message: "This payout is already being sent and can no longer be cancelled.",
    });

    for (const id of [foreign.id, "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee", "not-an-id"]) {
      const res = await app.inject({ method: "POST", url: `/payouts/${id}/cancel` });
      assert.equal(res.statusCode, 404, id);
      assert.equal(res.json().error, "payout_not_found");
    }
    assert.equal(state.payouts[1]!.status, "pending", "the other organization's payout is untouched");
    assert.equal(state.balanceWrites + state.payoutWrites, 0);
  } finally {
    await app.close();
  }
});

test("an API key and a plain member cannot cancel a payout", async () => {
  const { state, db } = fakeDb([payoutRow()], { [ORG]: 0n });
  const cases: Array<{ principal: Record<string, unknown>; role: string; status: number }> = [
    { principal: { userId: null, orgId: ORG, type: "api_key", scopes: ["*"] }, role: "owner", status: 401 },
    { principal: { userId: "u1", orgId: ORG, type: "jwt", role: "member" }, role: "member", status: 403 },
  ];
  for (const { principal, role, status } of cases) {
    const app = await payoutApp(routeDepsOver(db).routeDeps, principal, role);
    const res = await app.inject({ method: "POST", url: `/payouts/${PAYOUT}/cancel` });
    assert.equal(res.statusCode, status);
    await app.close();
  }
  assert.equal(state.payouts[0]!.status, "pending");
  assert.equal(state.balanceWrites, 0);
});

test("a cancel that fails in the database answers a fixed sentence, never the error's text", async () => {
  const { state, db } = fakeDb([payoutRow()], {}); // no balance row: the restore throws
  const app = await payoutApp(routeDepsOver(db).routeDeps);
  try {
    const res = await app.inject({ method: "POST", url: `/payouts/${PAYOUT}/cancel` });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.json(), {
      error: "internal_error",
      message: "Something went wrong on our side. Try again shortly.",
    });
    assert.ok(!res.body.includes("restored") && !res.body.includes(PAYOUT));
    assert.equal(state.payouts[0]!.status, "pending", "rolled back: still pending, still cancellable");
  } finally {
    await app.close();
  }
});

test("GET /payouts: cancellable only while pending, and failureReason is a sentence, never the recorded text", async () => {
  const raw = 'payout tx failed on-chain: {"InstructionError":[0,{"Custom":1}]}';
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 10, 0, 10 - minute));
  const rows = [
    payoutRow({ id: "00000000-0000-4000-8000-000000000001", status: "pending", requestedAt: at(1) }),
    payoutRow({ id: "00000000-0000-4000-8000-000000000002", status: "processing", requestedAt: at(2) }),
    payoutRow({ id: "00000000-0000-4000-8000-000000000003", status: "completed", requestedAt: at(3) }),
    payoutRow({ id: "00000000-0000-4000-8000-000000000004", status: "failed", failureReason: raw, requestedAt: at(4) }),
    payoutRow({ id: "00000000-0000-4000-8000-000000000005", status: "cancelled", requestedAt: at(5) }),
    payoutRow({ id: "00000000-0000-4000-8000-000000000006", publisherId: OTHER_ORG, requestedAt: at(0) }),
  ];
  const { db } = fakeDb(rows, { [ORG]: 0n });
  // A signed-in member may read the history; payouts being off changes nothing.
  const app = await payoutApp(
    routeDepsOver(db, { running: false }).routeDeps,
    { userId: "u2", orgId: ORG, type: "jwt", role: "member" },
    "member",
  );
  try {
    const res = await app.inject({ method: "GET", url: "/payouts" });
    assert.equal(res.statusCode, 200);
    const { payouts } = res.json();
    assert.deepEqual(
      payouts.map((p: any) => [p.status, p.cancellable]),
      [
        ["pending", true],
        ["processing", false],
        ["completed", false],
        ["failed", false],
        ["cancelled", false],
      ],
    );
    assert.deepEqual(
      payouts.map((p: any) => p.failureReason),
      [null, null, null, payoutFailureMessage(raw), null],
    );
    assert.deepEqual(
      payouts.map((p: any) => p.message),
      [null, null, null, payoutFailureMessage(raw), null],
    );
    assert.ok(!res.body.includes("InstructionError"));
    assert.ok(!res.body.includes("on-chain"));
  } finally {
    await app.close();
  }
});

test("GET /payouts needs a signed-in caller, and a database error is a fixed sentence", async () => {
  const { state, db } = fakeDb([payoutRow()], { [ORG]: 0n });
  const anonymous = await payoutApp(routeDepsOver(db).routeDeps, null);
  assert.equal((await anonymous.inject({ method: "GET", url: "/payouts" })).statusCode, 401);
  await anonymous.close();

  state.payoutsBroken = new Error("Invalid `prisma.creatorPayout.findMany()` invocation: P1001 at db.internal:5432");
  const app = await payoutApp(routeDepsOver(db).routeDeps);
  try {
    const res = await app.inject({ method: "GET", url: "/payouts" });
    assert.equal(res.statusCode, 500);
    assert.equal(res.json().error, "internal_error");
    assert.ok(!/prisma|P1001|5432/i.test(res.body));
  } finally {
    await app.close();
  }
});
