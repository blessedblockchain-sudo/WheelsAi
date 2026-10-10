import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { buildPayoutExecutorTickDeps } from "../services/buildPayoutExecutorTickDeps.js";
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
  type CancelPayoutDb,
  type PayoutRow,
} from "../services/payoutRequests.js";

// A payout requested while the payout worker is off used to stay "pending"
// for ever, with the creator's earnings reserved inside it and no way to
// take it back. A request is now refused before anything is reserved while
// payouts are not running, and a pending payout can be cancelled: the row
// becomes cancelled and its amount returns to the earnings in one
// transaction, racing the executor's claim with exactly one winner.

const ORG = "7f5c1d9e-2a3b-4c5d-8e9f-0a1b2c3d4e5f";
const OTHER_ORG = "11111111-2222-4333-8444-555555555555";
const PAYOUT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function payoutRow(over: Partial<PayoutRow> = {}): PayoutRow {
  return {
    id: PAYOUT,
    publisherId: ORG,
    amountCents: 2500n,
    payoutMethod: "credits",
    payoutAddress: null,
    status: "pending",
    txSignature: null,
    grossRevenueCents: 2778n,
    platformFeeCents: 278n,
    periodStart: new Date("2026-09-10T00:00:00Z"),
    periodEnd: new Date("2026-10-10T00:00:00Z"),
    requestedAt: new Date("2026-10-10T00:00:00Z"),
    processedAt: null,
    failureReason: null,
    ...over,
  };
}

/** An earnings_transactions row, as the earnings ledger writes it. */
type LedgerRow = {
  orgId: string;
  amountCents: bigint;
  type: string;
  referenceId: string | null;
  description: string | null;
  balanceAfter: bigint;
};

/**
 * An in-memory creator_payouts + publisher_profiles + earnings_transactions
 * set. Transactions are serialised the way row locks serialise them and
 * commit or roll back as a whole; every balance write is counted.
 */
function fakeDb(rows: PayoutRow[], balances: Record<string, bigint>) {
  const state = {
    payouts: rows.map((r) => ({ ...r })),
    balances: { ...balances },
    ledger: [] as LedgerRow[],
    balanceWrites: 0,
    payoutWrites: 0,
  };
  type Draft = { payouts: PayoutRow[]; balances: Record<string, bigint>; ledger: LedgerRow[] };

  const client = (draft: () => Draft) => ({
    creatorPayout: {
      findFirst: async ({ where }: any) =>
        draft().payouts.find((p) => p.id === where.id && p.publisherId === where.publisherId) ?? null,
      updateMany: async ({ where, data }: any) => {
        const statuses: string[] = typeof where.status === "string" ? [where.status] : where.status.in;
        const hit = draft().payouts.filter(
          (p) =>
            p.id === where.id &&
            (where.publisherId === undefined || p.publisherId === where.publisherId) &&
            statuses.includes(p.status),
        );
        for (const p of hit) Object.assign(p, data);
        state.payoutWrites += hit.length;
        return { count: hit.length };
      },
    },
    publisherProfile: {
      // What the earnings ledger uses to put an amount back. A restore is
      // not income: it must never add to lifetime revenue.
      updateMany: async ({ where, data }: any) => {
        const d = draft();
        assert.deepEqual(Object.keys(data), ["pendingPayoutCents"], "a restore changes the balance only");
        assert.equal(where.pendingPayoutCents, undefined, "a restore is not conditional on the balance");
        if (!(where.orgId in d.balances)) return { count: 0 };
        d.balances[where.orgId] = d.balances[where.orgId]! + data.pendingPayoutCents.increment;
        state.balanceWrites += 1;
        return { count: 1 };
      },
      findUnique: async ({ where }: any) => {
        const d = draft();
        return where.orgId in d.balances ? { pendingPayoutCents: d.balances[where.orgId]! } : null;
      },
      update: async () => {
        throw new Error("the balance changes only through the earnings ledger");
      },
    },
    earningsTransaction: {
      create: async ({ data }: any) => {
        draft().ledger.push({ ...data });
        return data;
      },
    },
  });

  let chain: Promise<unknown> = Promise.resolve();
  const db = {
    // Outside a transaction a write lands at once, as a single statement does.
    ...client(() => state),
    $transaction: (fn: (tx: any) => Promise<unknown>) => {
      const run = chain.then(async () => {
        const draft: Draft = {
          payouts: state.payouts.map((p) => ({ ...p })),
          balances: { ...state.balances },
          ledger: [...state.ledger],
        };
        const result = await fn(client(() => draft));
        state.payouts = draft.payouts; // commit
        state.balances = draft.balances;
        state.ledger = draft.ledger;
        return result;
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
  return { state, db: db as unknown as CancelPayoutDb };
}

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

/** The executor's own claim (pending → processing), bound to the same rows. */
function executorOver(db: CancelPayoutDb) {
  return buildPayoutExecutorTickDeps({ prisma: db, connection: {}, usdcMint: {} } as any);
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

test("cancel against the executor's claim: the claim wins, nothing is restored", async () => {
  const { state, db } = fakeDb([payoutRow()], { [ORG]: 0n });
  const executor = executorOver(db);

  assert.equal(await executor.claim(PAYOUT), true);
  const cancel = await cancelPayout(buildCancelPayoutDeps(db), { payoutId: PAYOUT, orgId: ORG });

  assert.deepEqual(cancel, { outcome: "not_cancellable", status: "processing" });
  assert.equal(state.payouts[0]!.status, "processing");
  assert.equal(state.balances[ORG], 0n, "a payout being sent is never also given back");
  assert.equal(state.balanceWrites, 0);
  assert.equal(state.ledger.length, 0);
});

test("cancel against the executor's claim: the cancel wins, the claim does nothing", async () => {
  const { state, db } = fakeDb([payoutRow()], { [ORG]: 0n });
  const executor = executorOver(db);

  const cancel = await cancelPayout(buildCancelPayoutDeps(db), { payoutId: PAYOUT, orgId: ORG });
  assert.equal(cancel.outcome, "cancelled");
  assert.equal(await executor.claim(PAYOUT), false, "a cancelled payout cannot be claimed");

  assert.equal(state.payouts[0]!.status, "cancelled");
  assert.equal(state.balances[ORG], 2500n);
  assert.equal(state.balanceWrites, 1);
  assert.deepEqual(state.ledger, [cancelledRow(2500n)]);

  // A tick that loaded the row while it was still pending and then fails it
  // must not restore a second time.
  await executor.failAndRestore({ ...payoutRow(), status: "pending" } as any, "invalid payout address");
  assert.equal(state.payouts[0]!.status, "cancelled");
  assert.equal(state.balances[ORG], 2500n);
  assert.equal(state.balanceWrites, 1);
  assert.deepEqual(state.ledger, [cancelledRow(2500n)], "no second ledger row");
});

test("the executor fails a payout: the amount is restored once, with one ledger row", async () => {
  for (const status of ["pending", "processing"]) {
    const { state, db } = fakeDb([payoutRow({ status })], { [ORG]: 300n });
    const executor = executorOver(db);
    const loaded = { ...payoutRow({ status }) } as any;

    await executor.failAndRestore(loaded, "invalid payout address");
    assert.equal(state.payouts[0]!.status, "failed");
    assert.equal(state.payouts[0]!.failureReason, "invalid payout address");
    assert.equal(state.balances[ORG], 2800n);
    assert.equal(state.balanceWrites, 1);
    assert.deepEqual(state.ledger, [
      cancelledRow(2800n, { description: "Payout failed, amount returned" }),
    ]);

    // A retry of the same failure, and a cancel after it, restore nothing more.
    await executor.failAndRestore(loaded, "invalid payout address");
    const cancel = await cancelPayout(buildCancelPayoutDeps(db), { payoutId: PAYOUT, orgId: ORG });
    assert.deepEqual(cancel, { outcome: "not_cancellable", status: "failed" });
    assert.equal(state.balances[ORG], 2800n);
    assert.equal(state.balanceWrites, 1, "the balance is credited exactly once");
    assert.equal(state.ledger.length, 1);
  }
});

test("if the earnings cannot be restored the executor's failure rolls back: the payout is not failed", async () => {
  // No balance row for the organization: the restore throws.
  const { state, db } = fakeDb([payoutRow({ status: "processing" })], {});
  const executor = executorOver(db);
  await assert.rejects(executor.failAndRestore({ ...payoutRow({ status: "processing" }) } as any, "invalid payout address"));
  assert.equal(state.payouts[0]!.status, "processing", "never failed without its amount given back");
  assert.equal(state.payouts[0]!.failureReason, null);
  assert.equal(state.ledger.length, 0);
});

test("the claim lands between the cancel's read and its write: the cancel loses and writes nothing", async () => {
  const { state, db } = fakeDb([payoutRow()], { [ORG]: 0n });
  const executor = executorOver(db);
  const deps = buildCancelPayoutDeps(db);

  // The cancel reads "pending"; the executor claims before the transaction.
  const racing = {
    ...deps,
    transaction: async <T>(fn: Parameters<typeof deps.transaction<T>>[0]) => {
      assert.equal(await executor.claim(PAYOUT), true);
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
    const executor = executorOver(db);
    const deps = buildCancelPayoutDeps(db);
    const cancel = () => cancelPayout(deps, { payoutId: PAYOUT, orgId: ORG });
    const claim = () => executor.claim(PAYOUT);

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
  ]);
  assert.equal(failed.amountCents, 2500);
  assert.equal(failed.grossRevenueCents, 2778);
  assert.equal(failed.platformFeeCents, 278);
  assert.equal(failed.failureReason, payoutFailureMessage(raw));
  assert.ok(!JSON.stringify(failed).includes("InstructionError"));

  // It did not fail: no sentence, whatever the column holds.
  assert.equal(payoutView(payoutRow()).failureReason, null);
  assert.equal(payoutView(payoutRow({ status: "completed", failureReason: "stale text" })).failureReason, null);
  assert.equal(payoutView(payoutRow({ status: "cancelled" })).failureReason, null);
  // It failed and no reason was recorded: still a sentence.
  assert.equal(payoutView(payoutRow({ status: "failed" })).failureReason, payoutFailureMessage(null));
});

// ---------------------------------------------------------------
// Routes
// ---------------------------------------------------------------

async function marketplaceApp(orgId = ORG) {
  const Fastify = (await import("fastify")).default;
  const sensible = await import("@fastify/sensible");
  const { marketplaceRoutes } = await import("../routes/marketplace.js");
  const app = Fastify();
  await app.register(sensible.default);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as unknown as { auth: unknown }).auth = { userId: "u1", orgId, type: "jwt", role: "owner" };
  });
  await app.register(marketplaceRoutes);
  return app;
}

/** Swaps the global Prisma models the payout routes touch, and the two payout settings. */
async function withWorld<T>(
  input: { rows: PayoutRow[]; balances: Record<string, bigint>; running: boolean },
  run: (world: { state: ReturnType<typeof fakeDb>["state"]; requestWrites: () => number }) => Promise<T>,
): Promise<T> {
  const { prisma } = await import("@wheelsai/db");
  const { env } = await import("../config/env.js");
  const p = prisma as any;
  const e = env as any;
  const saved = {
    member: p.orgMember.findUnique,
    subscription: p.orgSubscription.findUnique,
    publisherProfile: p.publisherProfile,
    creatorPayout: p.creatorPayout,
    $transaction: p.$transaction,
    enabled: e.PAYOUTS_ENABLED,
    interval: e.PAYOUT_EXECUTOR_INTERVAL_MS,
  };
  const { state, db } = fakeDb(input.rows, input.balances);
  const fake = db as any;
  let requestWrites = 0;
  p.orgMember.findUnique = async () => ({ role: "owner" });
  // An API key's call is metered against the plan; a plan that cannot be
  // read lets the call through without a counter, so no database or Redis.
  p.orgSubscription.findUnique = async () => {
    throw new Error("no plan lookup in this test");
  };
  p.publisherProfile = {
    ...fake.publisherProfile,
    findUnique: async ({ where }: any) =>
      where.orgId in state.balances ? { orgId: where.orgId, pendingPayoutCents: state.balances[where.orgId] } : null,
    updateMany: async () => {
      requestWrites += 1;
      return { count: 0 };
    },
  };
  p.creatorPayout = {
    ...fake.creatorPayout,
    findMany: async ({ where }: any) => state.payouts.filter((row) => row.publisherId === where.publisherId),
    create: async () => {
      requestWrites += 1;
      throw new Error("no payout row may be written here");
    },
  };
  p.$transaction = (fn: any) => {
    // requestPayout's own transaction: it reaches the stubs above.
    if (fn.length === 1 && String(fn).includes("reserved")) {
      requestWrites += 1;
      return fn(p);
    }
    return fake.$transaction(fn);
  };
  e.PAYOUTS_ENABLED = input.running;
  e.PAYOUT_EXECUTOR_INTERVAL_MS = input.running ? 60000 : 0;
  try {
    return await run({ state, requestWrites: () => requestWrites });
  } finally {
    p.orgMember.findUnique = saved.member;
    p.orgSubscription.findUnique = saved.subscription;
    p.publisherProfile = saved.publisherProfile;
    p.creatorPayout = saved.creatorPayout;
    p.$transaction = saved.$transaction;
    e.PAYOUTS_ENABLED = saved.enabled;
    e.PAYOUT_EXECUTOR_INTERVAL_MS = saved.interval;
  }
}

test("POST /payouts while payouts are off: 503, the balance is left and nothing is written", async () => {
  await withWorld({ rows: [], balances: { [ORG]: 2500n }, running: false }, async ({ state, requestWrites }) => {
    const { prisma } = await import("@wheelsai/db");
    const p = prisma as any;
    let read = false;
    const findUnique = p.publisherProfile.findUnique;
    p.publisherProfile.findUnique = async (args: unknown) => {
      read = true;
      return findUnique(args);
    };

    const app = await marketplaceApp();
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
      assert.equal(read, false, "the payout service does not run at all");
      assert.equal(requestWrites(), 0);
      assert.equal(state.balances[ORG], 2500n);
      assert.equal(state.payouts.length, 0);
    } finally {
      await app.close();
    }
  });
});

test("POST /payouts while payouts are running goes on to the payout service, as before", async () => {
  // Below the minimum: the service's own refusal shows the guard let it through.
  await withWorld({ rows: [], balances: { [ORG]: 900n }, running: true }, async ({ state }) => {
    const app = await marketplaceApp();
    try {
      const res = await app.inject({ method: "POST", url: "/payouts", payload: { payoutMethod: "credits" } });
      assert.equal(res.statusCode, 400);
      assert.match(res.json().message, /Minimum payout amount/);
      assert.equal(state.balances[ORG], 900n);
    } finally {
      await app.close();
    }
  });
});

test("POST /payouts/:id/cancel works while payouts are off: 200, then 409, the amount restored once", async () => {
  await withWorld({ rows: [payoutRow()], balances: { [ORG]: 0n }, running: false }, async ({ state }) => {
    const app = await marketplaceApp();
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
});

test("POST /payouts/:id/cancel: 409 once it is being sent, 404 for unknown, foreign and malformed ids", async () => {
  const sending = payoutRow({ status: "processing" });
  const foreign = payoutRow({ id: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee", publisherId: OTHER_ORG });
  await withWorld(
    { rows: [sending, foreign], balances: { [ORG]: 0n, [OTHER_ORG]: 0n }, running: true },
    async ({ state }) => {
      const app = await marketplaceApp();
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
    },
  );
});

test("an API key and a plain member cannot cancel a payout", async () => {
  await withWorld({ rows: [payoutRow()], balances: { [ORG]: 0n }, running: true }, async ({ state }) => {
    const Fastify = (await import("fastify")).default;
    const sensible = await import("@fastify/sensible");
    const { marketplaceRoutes } = await import("../routes/marketplace.js");
    const { prisma } = await import("@wheelsai/db");
    const cases: Array<{ principal: Record<string, unknown>; role: string; status: number }> = [
      { principal: { userId: null, orgId: ORG, type: "api_key", scopes: ["*"] }, role: "owner", status: 401 },
      { principal: { userId: "u1", orgId: ORG, type: "jwt", role: "member" }, role: "member", status: 403 },
    ];
    for (const { principal, role, status } of cases) {
      (prisma as any).orgMember.findUnique = async () => ({ role });
      const app = Fastify();
      await app.register(sensible.default);
      app.decorateRequest("auth", null);
      app.addHook("onRequest", async (request) => {
        (request as unknown as { auth: unknown }).auth = principal;
      });
      await app.register(marketplaceRoutes);
      const res = await app.inject({ method: "POST", url: `/payouts/${PAYOUT}/cancel` });
      assert.equal(res.statusCode, status);
      await app.close();
    }
    assert.equal(state.payouts[0]!.status, "pending");
    assert.equal(state.balanceWrites, 0);
  });
});

test("GET /payouts: cancellable only while pending, and failureReason is a sentence, never the recorded text", async () => {
  const raw = 'payout tx failed on-chain: {"InstructionError":[0,{"Custom":1}]}';
  const rows = [
    payoutRow({ id: "00000000-0000-4000-8000-000000000001", status: "pending" }),
    payoutRow({ id: "00000000-0000-4000-8000-000000000002", status: "processing" }),
    payoutRow({ id: "00000000-0000-4000-8000-000000000003", status: "completed" }),
    payoutRow({ id: "00000000-0000-4000-8000-000000000004", status: "failed", failureReason: raw }),
    payoutRow({ id: "00000000-0000-4000-8000-000000000005", status: "cancelled" }),
  ];
  await withWorld({ rows, balances: { [ORG]: 0n }, running: false }, async () => {
    const app = await marketplaceApp();
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
      assert.ok(!res.body.includes("InstructionError"));
      assert.ok(!res.body.includes("on-chain"));
    } finally {
      await app.close();
    }
  });
});
