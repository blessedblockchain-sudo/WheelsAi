import "./unitEnv.js";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LEDGER_FILTERS,
  LEDGER_TYPES,
  SPEND_GROUPS,
  SPEND_GROUP_LABELS,
  ledgerTypeInfo,
} from "@wheelsai/shared/ledger";

import {
  BILLING_LEDGER_SENTENCES,
  EXPORT_MAX_ROWS,
  HOLD_NOTES,
  TRANSACTIONS_MAX_LIMIT,
  decodeCursor,
  encodeCursor,
  exportTransactions,
  listTransactions,
  parseUtcDay,
  readBalance,
  readHolds,
  readUsage,
  storedTypesOfFilter,
  utcMonthOf,
  type BillingLedgerDeps,
} from "../services/billingLedger.js";
import { buildBillingLedgerStore } from "../services/buildBillingLedgerDeps.js";
import {
  ORG,
  OTHER_ORG,
  ledgerRow,
  makeBillingDb,
  uuid,
  type StandInTables,
} from "./billingLedgerStandIn.js";

// services/billingLedger.ts and its store: what the Billing page reads.
// Every figure is the sum of rows that exist, for one organization, and
// "this month" is the UTC calendar month.

const NOW = new Date("2026-10-11T15:30:00.000Z");
const MONTH_START = new Date("2026-10-01T00:00:00.000Z");
const NEXT_MONTH = new Date("2026-11-01T00:00:00.000Z");
const at = (iso: string) => new Date(iso);
const ms = (base: Date, delta: number) => new Date(base.getTime() + delta);

function setup(seed: Partial<StandInTables> = {}, now: Date = NOW) {
  const standIn = makeBillingDb(seed);
  const deps: BillingLedgerDeps = {
    store: buildBillingLedgerStore(standIn.db),
    now: () => now,
  };
  return { ...standIn, deps };
}

// ============================================
// Held
// ============================================

/** One of everything that holds credits, and beside each what must not count. */
function heldSeed(): Partial<StandInTables> {
  return {
    creditBalance: [
      { orgId: ORG, balanceCents: 4_210n },
      { orgId: OTHER_ORG, balanceCents: 999_999n },
    ],
    deployment: [
      { id: uuid(1), orgId: ORG, name: "support-llm", reservationCents: 1_200n, reservationReleasedAt: null, createdAt: at("2026-10-02T10:00:00Z") },
      // Released: the hold went back.
      { id: uuid(2), orgId: ORG, name: "old-llm", reservationCents: 800n, reservationReleasedAt: at("2026-10-03T00:00:00Z"), createdAt: at("2026-10-01T10:00:00Z") },
      // A free tier, and a row from before reservations were stored.
      { id: uuid(3), orgId: ORG, name: "free-llm", reservationCents: 0n, reservationReleasedAt: null, createdAt: at("2026-10-01T10:00:00Z") },
      { id: uuid(4), orgId: ORG, name: "legacy-llm", reservationCents: null, reservationReleasedAt: null, createdAt: at("2026-10-01T10:00:00Z") },
      // Another organization's.
      { id: uuid(5), orgId: OTHER_ORG, name: "theirs", reservationCents: 7_777n, reservationReleasedAt: null, createdAt: at("2026-10-05T10:00:00Z") },
    ],
    agentDeployment: [
      { id: uuid(11), agent: { orgId: ORG, name: "Sales agent" }, reservationCents: 600n, reservationReleasedAt: null, createdAt: at("2026-10-04T10:00:00Z") },
      { id: uuid(12), agent: { orgId: ORG, name: "Stopped agent" }, reservationCents: 600n, reservationReleasedAt: at("2026-10-05T00:00:00Z"), createdAt: at("2026-10-04T10:00:00Z") },
      { id: uuid(13), agent: { orgId: OTHER_ORG, name: "Their agent" }, reservationCents: 5_555n, reservationReleasedAt: null, createdAt: at("2026-10-04T10:00:00Z") },
    ],
    trainingJob: [
      { id: uuid(21), orgId: ORG, name: "tone-v2", reservationCents: 900n, settledAt: null, createdAt: at("2026-10-06T10:00:00Z") },
      // Settled: what was not used already came back.
      { id: uuid(22), orgId: ORG, name: "tone-v1", reservationCents: 900n, settledAt: at("2026-10-05T00:00:00Z"), createdAt: at("2026-10-03T10:00:00Z") },
      { id: uuid(23), orgId: OTHER_ORG, name: "their-run", reservationCents: 3_333n, settledAt: null, createdAt: at("2026-10-06T10:00:00Z") },
    ],
    marketplaceRevenue: [
      { id: uuid(31), jobId: uuid(131), buyerId: ORG, publisherId: OTHER_ORG, type: "job", status: "pending", grossAmountCents: 2_500n, settledAt: null, createdAt: at("2026-10-08T10:00:00Z"), job: { terms: { title: "Logo in three colours" }, offering: { title: "Logo design" } } },
      // No title in the terms: the offering's title names it.
      { id: uuid(32), jobId: uuid(132), buyerId: ORG, publisherId: OTHER_ORG, type: "job", status: "pending", grossAmountCents: 100n, settledAt: null, createdAt: at("2026-10-07T10:00:00Z"), job: { terms: {}, offering: { title: "Copy edit" } } },
      // Accepted and refunded jobs hold nothing.
      { id: uuid(33), jobId: uuid(133), buyerId: ORG, publisherId: OTHER_ORG, type: "job", status: "settled", grossAmountCents: 4_000n, settledAt: at("2026-10-09T00:00:00Z"), createdAt: at("2026-10-08T10:00:00Z"), job: { terms: {}, offering: { title: "Done" } } },
      { id: uuid(34), jobId: uuid(134), buyerId: ORG, publisherId: OTHER_ORG, type: "job", status: "refunded", grossAmountCents: 4_000n, settledAt: null, createdAt: at("2026-10-08T10:00:00Z"), job: { terms: {}, offering: { title: "Refunded" } } },
      // A request in progress is not a hold.
      { id: uuid(35), jobId: null, buyerId: ORG, publisherId: OTHER_ORG, type: "per_request", status: "pending", grossAmountCents: 50n, settledAt: null, createdAt: at("2026-10-11T15:29:00Z"), job: null },
      // This organization is the PUBLISHER here: the buyer's money, not ours.
      { id: uuid(36), jobId: uuid(136), buyerId: OTHER_ORG, publisherId: ORG, type: "job", status: "pending", grossAmountCents: 6_666n, settledAt: null, createdAt: at("2026-10-08T10:00:00Z"), job: { terms: {}, offering: { title: "Their hire" } } },
    ],
    trialCharge: [
      { id: uuid(41), publisherId: ORG, status: "held", amountCents: 3n, createdAt: at("2026-10-11T15:28:00Z") },
      { id: uuid(42), publisherId: ORG, status: "held", amountCents: 4n, createdAt: at("2026-10-11T15:29:00Z") },
      { id: uuid(43), publisherId: ORG, status: "settled", amountCents: 5n, createdAt: at("2026-10-11T15:00:00Z") },
      { id: uuid(44), publisherId: ORG, status: "refunded", amountCents: 5n, createdAt: at("2026-10-11T15:00:00Z") },
      { id: uuid(45), publisherId: OTHER_ORG, status: "held", amountCents: 1_111n, createdAt: at("2026-10-11T15:00:00Z") },
    ],
  };
}

test("holds: one entry from each of the five sources, newest first, with the sentence of its kind", async () => {
  const { deps } = setup(heldSeed());
  const out = await readHolds(deps, ORG);

  assert.deepEqual(out.holds, [
    { kind: "try_it", id: "try_it", name: "Try it messages", amount: 0.07, since: "2026-10-11T15:28:00.000Z", note: HOLD_NOTES.try_it },
    { kind: "job", id: uuid(131), name: "Logo in three colours", amount: 25, since: "2026-10-08T10:00:00.000Z", note: HOLD_NOTES.job },
    { kind: "job", id: uuid(132), name: "Copy edit", amount: 1, since: "2026-10-07T10:00:00.000Z", note: HOLD_NOTES.job },
    { kind: "fine_tuning", id: uuid(21), name: "tone-v2", amount: 9, since: "2026-10-06T10:00:00.000Z", note: HOLD_NOTES.fine_tuning },
    { kind: "agent_deployment", id: uuid(11), name: "Sales agent", amount: 6, since: "2026-10-04T10:00:00.000Z", note: HOLD_NOTES.agent_deployment },
    { kind: "deployment", id: uuid(1), name: "support-llm", amount: 12, since: "2026-10-02T10:00:00.000Z", note: HOLD_NOTES.deployment },
  ]);
  // 12 + 6 + 9 + 25 + 1 + 0.07, from whole cents.
  assert.equal(out.total, 53.07);
});

test("holds: the sentences are the contract's, word for word", () => {
  assert.deepEqual(HOLD_NOTES, {
    deployment: "Held while this deployment runs. It comes back when the deployment stops.",
    agent_deployment: "Held while this agent runs on its own GPU. It comes back when it stops.",
    fine_tuning: "Held for this fine-tuning run. What the run does not use comes back when it ends.",
    job: "Held until you accept the work, or the job is refunded.",
    try_it: "Held for a few minutes while a Try it message you pay for is answered.",
  });
});

test("holds: nothing held is an empty list and a total of 0, and no Try it entry", async () => {
  const { deps } = setup({ creditBalance: [{ orgId: ORG, balanceCents: 100n }] });
  assert.deepEqual(await readHolds(deps, ORG), { holds: [], total: 0 });
});

test("holds: a thing with no name still has one", async () => {
  const { deps } = setup({
    deployment: [{ id: uuid(1), orgId: ORG, name: "  ", reservationCents: 100n, reservationReleasedAt: null, createdAt: NOW }],
    marketplaceRevenue: [
      { id: uuid(31), jobId: null, buyerId: ORG, type: "job", status: "pending", grossAmountCents: 200n, settledAt: null, createdAt: ms(NOW, -1), job: null },
    ],
  });
  const out = await readHolds(deps, ORG);
  assert.deepEqual(out.holds.map((h) => [h.kind, h.id, h.name]), [
    ["deployment", uuid(1), "Deployment"],
    // With no job row the escrow row's own id stands in.
    ["job", uuid(31), "Job"],
  ]);
});

test("balance: available is the balance, held is the total of the holds, total is both, pending is held", async () => {
  const { deps } = setup(heldSeed());
  const out = await readBalance(deps, ORG);
  assert.deepEqual(out, {
    balance: { available: 42.1, held: 53.07, total: 95.17, pending: 53.07 },
  });
  assert.equal(out.balance.held, (await readHolds(deps, ORG)).total);
});

test("balance: an organization with no balance row and nothing held reads all zeros", async () => {
  const { deps } = setup(heldSeed());
  assert.deepEqual(await readBalance(deps, uuid(900_003)), {
    balance: { available: 0, held: 0, total: 0, pending: 0 },
  });
});

test("balance and holds: the other organization reads its own, and only its own", async () => {
  const { deps } = setup(heldSeed());
  const theirs = await readHolds(deps, OTHER_ORG);
  assert.deepEqual(
    theirs.holds.map((h) => [h.kind, h.name, h.amount]).sort(),
    [
      ["agent_deployment", "Their agent", 55.55],
      ["deployment", "theirs", 77.77],
      ["fine_tuning", "their-run", 33.33],
      ["job", "Their hire", 66.66],
      ["try_it", "Try it messages", 11.11],
    ],
  );
  assert.equal((await readBalance(deps, OTHER_ORG)).balance.available, 9_999.99);
});

// ============================================
// This month
// ============================================

test("the month is the UTC calendar month", () => {
  assert.deepEqual(utcMonthOf(at("2026-10-11T15:30:00Z")), {
    month: "2026-10",
    from: MONTH_START,
    to: NEXT_MONTH,
  });
  // The last and the first millisecond of a year.
  assert.equal(utcMonthOf(at("2026-12-31T23:59:59.999Z")).month, "2026-12");
  assert.deepEqual(utcMonthOf(at("2026-12-31T23:59:59.999Z")).to, at("2027-01-01T00:00:00Z"));
  assert.equal(utcMonthOf(at("2027-01-01T00:00:00.000Z")).month, "2027-01");
});

test("usage: a row one millisecond before the month's start is not this month's, the row at the start is", async () => {
  const { deps } = setup({
    creditTransaction: [
      ledgerRow({ type: "gpu_usage", amountCents: -1_000n, gpuSeconds: 7_200n, createdAt: ms(MONTH_START, -1) }),
      ledgerRow({ type: "gpu_usage", amountCents: -300n, gpuSeconds: 3_600n, createdAt: MONTH_START }),
      ledgerRow({ type: "gpu_usage", amountCents: -20n, gpuSeconds: 1_800n, createdAt: ms(MONTH_START, 1) }),
      // The month's other edge.
      ledgerRow({ type: "gpu_usage", amountCents: -4n, gpuSeconds: 900n, createdAt: ms(NEXT_MONTH, -1) }),
      ledgerRow({ type: "gpu_usage", amountCents: -50_000n, gpuSeconds: 36_000n, createdAt: NEXT_MONTH }),
    ],
    marketplaceRevenue: [
      { id: uuid(31), buyerId: ORG, type: "job", status: "settled", grossAmountCents: 10_000n, settledAt: ms(MONTH_START, -1), createdAt: MONTH_START },
      { id: uuid(32), buyerId: ORG, type: "job", status: "settled", grossAmountCents: 700n, settledAt: MONTH_START, createdAt: ms(MONTH_START, -5) },
    ],
    usageRecord: [
      { orgId: ORG, periodStart: ms(MONTH_START, -1), requestCount: 1_000, inputTokens: 1_000n, outputTokens: 1_000n },
      { orgId: ORG, periodStart: MONTH_START, requestCount: 3, inputTokens: 30n, outputTokens: 40n },
      { orgId: ORG, periodStart: NEXT_MONTH, requestCount: 5_000, inputTokens: 5_000n, outputTokens: 5_000n },
    ],
  });
  const { usage } = await readUsage(deps, ORG);
  assert.equal(usage.month, "2026-10");
  assert.equal(usage.spend.find((s) => s.group === "gpu")!.amount, 3.24);
  assert.equal(usage.spend.find((s) => s.group === "jobs")!.amount, 7);
  assert.equal(usage.currentMonth, 10.24);
  assert.equal(usage.gpuHours, (3_600 + 1_800 + 900) / 3600);
  assert.deepEqual([usage.requests, usage.inputTokens, usage.outputTokens], [3, 30, 40]);
});

test("usage: the month follows UTC, not the server's own clock zone", async () => {
  // 23:30 on 30 September in UTC is already October east of Greenwich.
  const { deps } = setup(
    {
      creditTransaction: [
        ledgerRow({ type: "usage", amountCents: -500n, createdAt: at("2026-09-30T23:00:00Z") }),
        ledgerRow({ type: "usage", amountCents: -9n, createdAt: at("2026-10-01T00:00:00Z") }),
      ],
    },
    at("2026-09-30T23:30:00Z"),
  );
  const { usage } = await readUsage(deps, ORG);
  assert.equal(usage.month, "2026-09");
  assert.equal(usage.currentMonth, 5);
});

test("usage: each heading is the net of its own rows, in the order and with the labels of the shared table", async () => {
  const day = (d: number) => at(`2026-10-${String(d).padStart(2, "0")}T12:00:00Z`);
  const { deps } = setup({
    creditTransaction: [
      // GPU time.
      ledgerRow({ type: "gpu_usage", amountCents: -1_250n, gpuSeconds: 5_400n, createdAt: day(2) }),
      ledgerRow({ type: "gpu_usage", amountCents: -250n, gpuSeconds: 1_800n, createdAt: day(3) }),
      // Inference: the charge, then its unused part back.
      ledgerRow({ type: "usage", amountCents: -400n, createdAt: day(2) }),
      ledgerRow({ type: "usage_release", amountCents: 150n, createdAt: day(2) }),
      // Fine-tuning: only what the run used. The hold and its release are not spending.
      ledgerRow({ type: "training_reservation", amountCents: -9_000n, createdAt: day(4) }),
      ledgerRow({ type: "training_reservation_release", amountCents: 9_000n, createdAt: day(5) }),
      ledgerRow({ type: "training_usage", amountCents: -1_500n, gpuSeconds: 600n, createdAt: day(5) }),
      // Paid use of listings, one refunded.
      ledgerRow({ type: "marketplace_usage", amountCents: -75n, createdAt: day(6) }),
      ledgerRow({ type: "marketplace_usage", amountCents: -25n, createdAt: day(6) }),
      ledgerRow({ type: "marketplace_refund", amountCents: 25n, createdAt: day(6) }),
      // Subscriptions.
      ledgerRow({ type: "marketplace_subscription", amountCents: -2_000n, createdAt: day(7) }),
      // Try it messages paid for, one refunded.
      ledgerRow({ type: "trial_usage", amountCents: -6n, createdAt: day(8) }),
      ledgerRow({ type: "trial_usage_refund", amountCents: 2n, createdAt: day(8) }),
      // Not spending: credits arriving, a deployment's hold, a job's escrow, a card refund.
      ledgerRow({ type: "purchase", amountCents: 50_000n, createdAt: day(1) }),
      ledgerRow({ type: "bonus", amountCents: 5_000n, createdAt: day(1) }),
      ledgerRow({ type: "deployment_reservation", amountCents: -1_200n, createdAt: day(2) }),
      ledgerRow({ type: "deployment_reservation_release", amountCents: 1_200n, createdAt: day(9) }),
      ledgerRow({ type: "marketplace_job", amountCents: -2_500n, createdAt: day(8) }),
      ledgerRow({ type: "marketplace_job_refund", amountCents: 2_500n, createdAt: day(9) }),
      ledgerRow({ type: "refund", amountCents: -1_000n, createdAt: day(9) }),
      ledgerRow({ type: "something_new", amountCents: -1n, createdAt: day(9) }),
      // Another organization's spending.
      ledgerRow({ orgId: OTHER_ORG, type: "gpu_usage", amountCents: -99_999n, gpuSeconds: 360_000n, createdAt: day(3) }),
    ],
    marketplaceRevenue: [
      { id: uuid(31), buyerId: ORG, type: "job", status: "settled", grossAmountCents: 4_000n, settledAt: day(9), createdAt: day(8) },
      { id: uuid(32), buyerId: OTHER_ORG, type: "job", status: "settled", grossAmountCents: 88_888n, settledAt: day(9), createdAt: day(8) },
    ],
  });

  const { usage } = await readUsage(deps, ORG);
  assert.deepEqual(usage.spend, [
    { group: "gpu", label: "GPU time", amount: 15 },
    { group: "inference", label: "Inference", amount: 2.5 },
    { group: "fine_tuning", label: "Fine-tuning", amount: 15 },
    { group: "paid_use", label: "Paid use of listings", amount: 0.75 },
    { group: "subscriptions", label: "Subscriptions", amount: 20 },
    { group: "jobs", label: "Jobs", amount: 40 },
    { group: "try_it", label: "Try it messages you paid for", amount: 0.04 },
  ]);
  assert.deepEqual(usage.spend.map((s) => s.group), [...SPEND_GROUPS]);
  for (const line of usage.spend) assert.equal(line.label, SPEND_GROUP_LABELS[line.group]);
  // The total is the sum of the headings, from whole cents.
  assert.equal(usage.currentMonth, 93.29);
  assert.equal(usage.gpuHours, (5_400 + 1_800 + 600) / 3600);
});

test("usage: nothing this month is every heading at zero, not a missing heading", async () => {
  const { deps } = setup();
  const { usage } = await readUsage(deps, ORG);
  assert.deepEqual(usage, {
    month: "2026-10",
    currentMonth: 0,
    spend: SPEND_GROUPS.map((group) => ({ group, label: SPEND_GROUP_LABELS[group], amount: 0 })),
    gpuHours: 0,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
  });
  assert.deepEqual(Object.keys(usage).sort(), [
    "currentMonth", "gpuHours", "inputTokens", "month", "outputTokens", "requests", "spend",
  ]);
});

test("usage: a refund in a later month than its charge makes that heading negative", async () => {
  const { deps } = setup({
    creditTransaction: [
      ledgerRow({ type: "marketplace_usage", amountCents: -900n, createdAt: at("2026-09-29T12:00:00Z") }),
      ledgerRow({ type: "marketplace_refund", amountCents: 900n, createdAt: at("2026-10-02T12:00:00Z") }),
      ledgerRow({ type: "gpu_usage", amountCents: -200n, gpuSeconds: 60n, createdAt: at("2026-10-02T12:00:00Z") }),
    ],
  });
  const { usage } = await readUsage(deps, ORG);
  assert.equal(usage.spend.find((s) => s.group === "paid_use")!.amount, -9);
  assert.equal(usage.currentMonth, -7);
});

test("usage: a job counts when it is settled, not when it is hired", async () => {
  const hired = at("2026-10-03T12:00:00Z");
  const seed = (status: string, settledAt: Date | null): Partial<StandInTables> => ({
    creditTransaction: [ledgerRow({ type: "marketplace_job", amountCents: -2_500n, createdAt: hired })],
    marketplaceRevenue: [
      { id: uuid(31), buyerId: ORG, type: "job", status, grossAmountCents: 2_500n, settledAt, createdAt: hired },
    ],
  });
  const jobs = async (s: Partial<StandInTables>, now = NOW) =>
    (await readUsage(setup(s, now).deps, ORG)).usage.spend.find((x) => x.group === "jobs")!.amount;

  // Hired and held: nothing spent yet.
  assert.equal(await jobs(seed("pending", null)), 0);
  // Accepted this month.
  assert.equal(await jobs(seed("settled", at("2026-10-09T12:00:00Z"))), 25);
  // Refunded: never spent.
  assert.equal(await jobs(seed("refunded", null)), 0);
  // Hired in October, accepted in November: November's spending, not October's.
  const acceptedLater = seed("settled", at("2026-11-02T12:00:00Z"));
  assert.equal(await jobs(acceptedLater), 0);
  assert.equal(await jobs(acceptedLater, at("2026-11-20T00:00:00Z")), 25);
});

test("usage: paid use and subscriptions in escrow rows are not counted twice as jobs", async () => {
  const when = at("2026-10-03T12:00:00Z");
  const { deps } = setup({
    marketplaceRevenue: [
      { id: uuid(31), buyerId: ORG, type: "per_request", status: "settled", grossAmountCents: 300n, settledAt: when, createdAt: when },
      { id: uuid(32), buyerId: ORG, type: "subscription", status: "settled", grossAmountCents: 2_000n, settledAt: when, createdAt: when },
    ],
  });
  assert.equal((await readUsage(deps, ORG)).usage.currentMonth, 0);
});

test("usage: GPU hours come from gpuSeconds on the ledger only, whatever usage_records says", async () => {
  const when = at("2026-10-03T12:00:00Z");
  const ledger = [
    ledgerRow({ type: "gpu_usage", amountCents: -500n, gpuSeconds: 9_000n, createdAt: when }),
    ledgerRow({ type: "training_usage", amountCents: -100n, gpuSeconds: 1_800n, createdAt: when }),
    // A row with no gpuSeconds adds no hours.
    ledgerRow({ type: "gpu_usage", amountCents: -100n, gpuSeconds: null, createdAt: when }),
    ledgerRow({ type: "usage", amountCents: -100n, createdAt: when }),
  ];
  const withUsage = setup({
    creditTransaction: ledger,
    usageRecord: [
      { orgId: ORG, periodStart: when, requestCount: 12, inputTokens: 3_400n, outputTokens: 5_600n, computeSeconds: 999_999n, totalLatencyMs: 888_888_888n, costCents: 77_777n, actualCostCents: 66_666n },
    ],
  });
  const withoutUsage = setup({ creditTransaction: ledger });

  const a = (await readUsage(withUsage.deps, ORG)).usage;
  const b = (await readUsage(withoutUsage.deps, ORG)).usage;
  assert.equal(a.gpuHours, 3);
  assert.equal(b.gpuHours, 3);
  // usage_records moves the counts and nothing else: no cost is read from it.
  assert.deepEqual(a.spend, b.spend);
  assert.equal(a.currentMonth, 8);
  assert.equal(b.currentMonth, 8);
  assert.deepEqual([a.requests, a.inputTokens, a.outputTokens], [12, 3_400, 5_600]);
  assert.deepEqual([b.requests, b.inputTokens, b.outputTokens], [0, 0, 0]);
});

test("usage: rows stored in capitals count under their heading", async () => {
  const when = at("2026-10-03T12:00:00Z");
  const { deps } = setup({
    creditTransaction: [
      ledgerRow({ type: "USAGE", amountCents: -300n, createdAt: when }),
      ledgerRow({ type: "usage", amountCents: -200n, createdAt: when }),
    ],
  });
  assert.equal((await readUsage(deps, ORG)).usage.spend.find((s) => s.group === "inference")!.amount, 5);
});

test("no fixed share: the billing code holds no 0.7, 0.2 or 0.1, and none of the removed fields", () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const file of [
    "services/billingLedger.ts",
    "services/buildBillingLedgerDeps.ts",
    "routes/billingLedger.ts",
    "routes/billingLedgerBindings.ts",
    "routes/billing.ts",
  ]) {
    const text = readFileSync(path.join(src, file), "utf8");
    assert.doesNotMatch(text, /(?<![\d.])0?\.[127]0*(?![\d])/, `${file}: a fixed share`);
    for (const gone of ["avgCostPerHour", "computeCost", "requestsCost", "tokensCost", "metered", "costCents"]) {
      assert.ok(!text.includes(gone), `${file}: ${gone}`);
    }
  }
});

// ============================================
// The ledger, a page at a time
// ============================================

test("transactions: each row carries its stored type in lower case, its kind and label, both amounts signed", async () => {
  const { deps } = setup({
    creditTransaction: [
      ledgerRow({ id: uuid(1), type: "PURCHASE", amountCents: 5_000n, balanceAfter: 5_000n, description: "Credit purchase: $50", createdAt: at("2026-10-01T10:00:00Z") }),
      ledgerRow({ id: uuid(2), type: "gpu_usage", amountCents: -125n, balanceAfter: 4_875n, description: null, createdAt: at("2026-10-02T10:00:00Z") }),
      ledgerRow({ id: uuid(3), type: "mystery_fee", amountCents: -1n, balanceAfter: 4_874n, description: "  ", createdAt: at("2026-10-03T10:00:00Z") }),
    ],
  });
  const out = await listTransactions(deps, ORG, {});
  assert.deepEqual(out, {
    ok: true,
    nextCursor: null,
    transactions: [
      { id: uuid(3), amount: -0.01, type: "mystery_fee", kind: "other", label: "Mystery fee", description: "Mystery fee", balanceAfter: 48.74, createdAt: "2026-10-03T10:00:00.000Z" },
      // No stored text: the label stands in.
      { id: uuid(2), amount: -1.25, type: "gpu_usage", kind: "spent", label: "GPU time", description: "GPU time", balanceAfter: 48.75, createdAt: "2026-10-02T10:00:00.000Z" },
      { id: uuid(1), amount: 50, type: "purchase", kind: "added", label: "Credits added", description: "Credit purchase: $50", balanceAfter: 50, createdAt: "2026-10-01T10:00:00.000Z" },
    ],
  });
});

test("transactions: paging never repeats or skips a row when createdAt ties", async () => {
  // 23 rows over 4 moments: most pages end in the middle of a tie.
  const moments = [
    at("2026-10-05T10:00:00.000Z"),
    at("2026-10-05T10:00:00.001Z"),
    at("2026-10-06T10:00:00.000Z"),
    at("2026-10-07T10:00:00.000Z"),
  ];
  const rows = Array.from({ length: 23 }, (_, i) =>
    // Ids out of insertion order, so the order is the query's doing.
    ledgerRow({ id: uuid(((i * 7) % 23) + 1), type: "usage", amountCents: -BigInt(i + 1), createdAt: moments[i % 4]! }),
  );
  rows.push(ledgerRow({ orgId: OTHER_ORG, id: uuid(500), type: "usage", amountCents: -1n, createdAt: moments[1]! }));

  for (const limit of [1, 2, 3, 5, 7, 23, 50]) {
    const { deps } = setup({ creditTransaction: rows });
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const out = await listTransactions(deps, ORG, { limit: String(limit), cursor });
      assert.ok(out.ok);
      assert.ok(out.transactions.length <= limit);
      seen.push(...out.transactions.map((t) => `${t.createdAt} ${t.id}`));
      cursor = out.nextCursor ?? undefined;
      assert.ok(++pages <= 30, "paging ends");
    } while (cursor);

    assert.equal(seen.length, 23, `limit ${limit}: every row once`);
    assert.equal(new Set(seen).size, 23, `limit ${limit}: no row twice`);
    // createdAt then id, both descending.
    assert.deepEqual(seen, [...seen].sort().reverse(), `limit ${limit}: newest first`);
    assert.ok(!seen.some((s) => s.endsWith(uuid(500))), "another organization's row");
  }
});

test("transactions: a page that ends exactly at the last row has no next cursor", async () => {
  const rows = [1, 2, 3, 4].map((n) =>
    ledgerRow({ id: uuid(n), type: "usage", amountCents: -1n, createdAt: at(`2026-10-0${n}T00:00:00Z`) }),
  );
  const { deps } = setup({ creditTransaction: rows });
  const first = await listTransactions(deps, ORG, { limit: "2" });
  assert.ok(first.ok && first.nextCursor);
  const second = await listTransactions(deps, ORG, { limit: "2", cursor: first.nextCursor });
  assert.ok(second.ok);
  assert.deepEqual(second.transactions.map((t) => t.id), [uuid(2), uuid(1)]);
  assert.equal(second.nextCursor, null);
});

test("transactions: each filter answers its kinds, and finds rows stored in capitals", async () => {
  const when = (n: number) => at(`2026-10-${String(n).padStart(2, "0")}T00:00:00Z`);
  const types = [...Object.keys(LEDGER_TYPES), "PURCHASE", "BONUS", "USAGE", "REFUND", "never_heard_of"];
  const { deps } = setup({
    creditTransaction: types.map((type, i) => ledgerRow({ type, amountCents: 1n, createdAt: when(i + 1) })),
  });

  const stored = async (filter?: string) => {
    const out = await listTransactions(deps, ORG, { filter, limit: "200" });
    assert.ok(out.ok);
    return out.transactions;
  };

  for (const [filter, kinds] of Object.entries(LEDGER_FILTERS)) {
    const got = await stored(filter);
    const want = types.filter((type) => (kinds as readonly string[]).includes(ledgerTypeInfo(type).kind));
    assert.deepEqual(got.map((t) => t.type).sort(), want.map((t) => t.toLowerCase()).sort(), filter);
    assert.ok(got.every((t) => (kinds as readonly string[]).includes(t.kind)), filter);
  }

  // The capitals are found under the filter of their kind.
  assert.equal((await stored("added")).filter((t) => t.type === "purchase").length, 2);
  assert.equal((await stored("added")).filter((t) => t.type === "bonus").length, 2);
  assert.equal((await stored("added")).filter((t) => t.type === "refund").length, 2);
  assert.equal((await stored("spent")).filter((t) => t.type === "usage").length, 2);
  assert.ok((await stored("held")).some((t) => t.type === "marketplace_job"));

  // No filter, and an empty one: everything, the unknown type included.
  assert.equal((await stored()).length, types.length);
  assert.equal((await stored("")).length, types.length);
  assert.ok((await stored()).some((t) => t.type === "never_heard_of" && t.kind === "other"));

  assert.ok(storedTypesOfFilter("added").includes("PURCHASE"));
  assert.ok(storedTypesOfFilter("added").includes("purchase"));
});

test("transactions: a filter pages with its own cursor", async () => {
  const rows = Array.from({ length: 9 }, (_, i) =>
    ledgerRow({ id: uuid(i + 1), type: i % 3 === 0 ? "PURCHASE" : "usage", amountCents: 1n, createdAt: at("2026-10-05T10:00:00Z") }),
  );
  const { deps } = setup({ creditTransaction: rows });
  const first = await listTransactions(deps, ORG, { filter: "added", limit: "2" });
  assert.ok(first.ok && first.nextCursor);
  assert.deepEqual(first.transactions.map((t) => t.id), [uuid(7), uuid(4)]);
  const second = await listTransactions(deps, ORG, { filter: "added", limit: "2", cursor: first.nextCursor });
  assert.ok(second.ok);
  assert.deepEqual(second.transactions.map((t) => t.id), [uuid(1)]);
  assert.equal(second.nextCursor, null);
});

test("transactions: the limit is 1 to 200 and 50 when absent; anything else is refused", async () => {
  const rows = Array.from({ length: 205 }, (_, i) =>
    ledgerRow({ type: "usage", amountCents: -1n, createdAt: ms(MONTH_START, i) }),
  );
  const { deps, calls } = setup({ creditTransaction: rows });
  const count = async (limit?: unknown) => {
    const out = await listTransactions(deps, ORG, { limit });
    return out.ok ? out.transactions.length : out.code;
  };

  assert.equal(await count(), 50);
  assert.equal(await count(""), 50);
  assert.equal(await count("1"), 1);
  assert.equal(await count("200"), 200);
  assert.equal(TRANSACTIONS_MAX_LIMIT, 200);

  const before = calls.length;
  for (const bad of ["0", "201", "-1", "1.5", "abc", "1e2", " 5", "99999", ["5", "6"], 5, "0x10"]) {
    assert.equal(await count(bad), "invalid_request", String(bad));
  }
  assert.equal(calls.length, before, "a refused request reads nothing");
});

test("transactions: a cursor or a filter that cannot be read is refused, and reads nothing", async () => {
  const { deps, calls } = setup({
    creditTransaction: [ledgerRow({ type: "usage", amountCents: -1n, createdAt: NOW })],
  });
  const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
  for (const cursor of [
    "not a cursor",
    "%%%",
    b64("hello"),
    b64(`abc.${uuid(1)}`),
    b64("1760000000000.not-a-uuid"),
    b64(`1760000000000.${uuid(1)}'; DROP TABLE x;--`),
    b64(`.${uuid(1)}`),
    "x".repeat(500),
    ["a", "b"],
    7,
  ]) {
    assert.deepEqual(await listTransactions(deps, ORG, { cursor }), { ok: false, code: "invalid_request" }, String(cursor));
  }
  for (const filter of ["all", "ADDED", "spent ", "other", "__proto__", "constructor", ["added"], 1]) {
    assert.deepEqual(await listTransactions(deps, ORG, { filter }), { ok: false, code: "invalid_request" }, String(filter));
  }
  assert.equal(calls.length, 0);

  const cursor = encodeCursor({ createdAt: NOW, id: uuid(1) });
  assert.deepEqual(decodeCursor(cursor), { createdAt: NOW, id: uuid(1) });
  assert.match(cursor, /^[A-Za-z0-9_-]+$/, "safe in a URL as it is");
});

// ============================================
// The ledger as a file
// ============================================

const exportSeed = (): Partial<StandInTables> => ({
  creditTransaction: [
    ledgerRow({ id: uuid(1), type: "purchase", amountCents: 5_000n, balanceAfter: 5_000n, description: "Credit purchase: $50", createdAt: at("2026-10-01T00:00:00.000Z") }),
    ledgerRow({ id: uuid(2), type: "gpu_usage", amountCents: -125n, balanceAfter: 4_875n, description: "GPU usage (a4000 x1, 500s)", createdAt: at("2026-10-05T08:00:00.000Z") }),
    ledgerRow({ id: uuid(3), type: "marketplace_usage", amountCents: -5n, balanceAfter: 4_870n, description: '=HYPERLINK("http://evil.example","pay, now")', createdAt: at("2026-10-11T15:00:00.000Z") }),
    ledgerRow({ id: uuid(4), type: "BONUS", amountCents: 500n, balanceAfter: 5_370n, description: null, createdAt: at("2026-10-11T23:59:59.999Z") }),
    // Outside the default range on both sides.
    ledgerRow({ id: uuid(5), type: "usage", amountCents: -1n, balanceAfter: 1n, description: "September", createdAt: at("2026-09-30T23:59:59.999Z") }),
    ledgerRow({ id: uuid(6), type: "usage", amountCents: -2n, balanceAfter: 2n, description: "Tomorrow", createdAt: at("2026-10-12T00:00:00.000Z") }),
    ledgerRow({ orgId: OTHER_ORG, id: uuid(7), type: "purchase", amountCents: 99_900n, balanceAfter: 99_900n, description: "Theirs", createdAt: at("2026-10-05T09:00:00.000Z") }),
  ],
});

test("export: with no dates, the current UTC month up to today, oldest first, with the contract's columns", async () => {
  const { deps } = setup(exportSeed());
  const out = await exportTransactions(deps, ORG, {});
  assert.ok(out.ok);
  assert.equal(out.filename, "wheelsai-credits-2026-10-01-to-2026-10-11.csv");
  assert.equal(out.rows, 4);
  assert.deepEqual(out.csv.split("\r\n"), [
    "Date (UTC),Type,What,Description,Amount (USD),Balance after (USD)",
    "2026-10-01T00:00:00.000Z,purchase,Credits added,Credit purchase: $50,50,50",
    // A spent amount keeps its own minus sign: it is a number, not text.
    '2026-10-05T08:00:00.000Z,gpu_usage,GPU time,"GPU usage (a4000 x1, 500s)",-1.25,48.75',
    // A description a spreadsheet would run as a formula is made plain text.
    '2026-10-11T15:00:00.000Z,marketplace_usage,Paid use,"\'=HYPERLINK(""http://evil.example"",""pay, now"")",-0.05,48.7',
    // The stored type as it is stored; no description is an empty cell.
    "2026-10-11T23:59:59.999Z,BONUS,Bonus credits,,5,53.7",
    "",
  ]);
  assert.ok(!out.csv.includes("Theirs"));
  assert.ok(!out.csv.includes("'-"), "a negative amount is never prefixed");
});

test("export: both days are included, in UTC", async () => {
  const { deps } = setup(exportSeed());
  const ids = async (from: string, to: string) => {
    const out = await exportTransactions(deps, ORG, { from, to });
    assert.ok(out.ok);
    return { filename: out.filename, dates: out.csv.trim().split("\r\n").slice(1).map((l) => l.slice(0, 24)) };
  };

  assert.deepEqual(await ids("2026-09-30", "2026-10-01"), {
    filename: "wheelsai-credits-2026-09-30-to-2026-10-01.csv",
    dates: ["2026-09-30T23:59:59.999Z", "2026-10-01T00:00:00.000Z"],
  });
  // One day: from its first millisecond to its last.
  assert.deepEqual((await ids("2026-10-11", "2026-10-11")).dates, [
    "2026-10-11T15:00:00.000Z",
    "2026-10-11T23:59:59.999Z",
  ]);
  assert.deepEqual((await ids("2026-10-12", "2026-10-12")).dates, ["2026-10-12T00:00:00.000Z"]);
  // A range with no rows is a file with only its header.
  const empty = await exportTransactions(deps, ORG, { from: "2025-01-01", to: "2025-01-31" });
  assert.ok(empty.ok);
  assert.equal(empty.csv, "Date (UTC),Type,What,Description,Amount (USD),Balance after (USD)\r\n");
});

test("export: rows of the same moment keep one order", async () => {
  const when = at("2026-10-05T10:00:00Z");
  const { deps } = setup({
    creditTransaction: [3, 1, 2].map((n) =>
      ledgerRow({ id: uuid(n), type: "usage", amountCents: -BigInt(n), description: `row ${n}`, createdAt: when }),
    ),
  });
  const out = await exportTransactions(deps, ORG, {});
  assert.ok(out.ok);
  assert.deepEqual(out.csv.trim().split("\r\n").slice(1).map((l) => l.split(",")[3]), ["row 1", "row 2", "row 3"]);
});

test("export: dates that cannot be read, the wrong way round, or only one of the two are refused", async () => {
  const { deps, calls } = setup(exportSeed());
  for (const query of [
    { from: "2026-10-01" },
    { to: "2026-10-01" },
    { from: "2026-10-02", to: "2026-10-01" },
    { from: "2026-02-30", to: "2026-03-01" },
    { from: "2026-13-01", to: "2026-13-02" },
    { from: "10/01/2026", to: "10/02/2026" },
    { from: "2026-10-01T00:00:00Z", to: "2026-10-02" },
    { from: "yesterday", to: "today" },
    { from: ["2026-10-01", "2026-10-02"], to: "2026-10-03" },
    { from: "2026-10-01", to: "" },
  ]) {
    assert.deepEqual(await exportTransactions(deps, ORG, query), { ok: false, code: "invalid_range" }, JSON.stringify(query));
  }
  assert.equal(calls.length, 0, "a refused range reads nothing");
  assert.equal(parseUtcDay("2028-02-29")?.toISOString(), "2028-02-29T00:00:00.000Z");
  assert.equal(parseUtcDay("2026-02-29"), null);
});

test("export: past 100,000 rows the range is refused; exactly 100,000 is a file", async () => {
  assert.equal(EXPORT_MAX_ROWS, 100_000);
  const row = { id: uuid(1), amountCents: -1n, type: "usage", description: null, balanceAfter: 0n, createdAt: MONTH_START };
  const withRows = (count: number): BillingLedgerDeps => {
    const store = buildBillingLedgerStore(makeBillingDb().db);
    return {
      now: () => NOW,
      store: {
        ...store,
        // The store is asked for one row more than a file carries, and no more.
        ledgerInRange: async ({ take }) => {
          assert.equal(take, EXPORT_MAX_ROWS + 1);
          return Array.from({ length: Math.min(count, take) }, () => row);
        },
      },
    };
  };
  assert.deepEqual(await exportTransactions(withRows(100_001), ORG, {}), { ok: false, code: "range_too_large" });
  assert.deepEqual(await exportTransactions(withRows(250_000), ORG, {}), { ok: false, code: "range_too_large" });
  const full = await exportTransactions(withRows(100_000), ORG, {});
  assert.ok(full.ok);
  assert.equal(full.rows, 100_000);
});

// ============================================
// Scoping, and the sentences
// ============================================

test("scoping: every query the store sends names the organization, on the column that owns the row", async () => {
  const { deps, calls } = setup(heldSeed());
  await readBalance(deps, ORG);
  await readHolds(deps, ORG);
  await readUsage(deps, ORG);
  await listTransactions(deps, ORG, {});
  await listTransactions(deps, ORG, { filter: "spent", cursor: encodeCursor({ createdAt: NOW, id: uuid(1) }) });
  await exportTransactions(deps, ORG, {});
  await exportTransactions(deps, ORG, { from: "2026-01-01", to: "2026-12-31" });

  const ownerOf = (table: string, where: Record<string, unknown>): unknown => {
    if (table === "agentDeployment") return (where.agent as { orgId?: unknown } | undefined)?.orgId;
    if (table === "marketplaceRevenue") return where.buyerId;
    if (table === "trialCharge") return where.publisherId;
    return where.orgId;
  };
  // 6 for the balance, 5 for the holds, 3 for the month, 2 lists, 2 files.
  assert.equal(calls.length, 18);
  const tables = new Set<string>();
  for (const call of calls) {
    tables.add(call.table);
    // At the top level of the where: an OR beside it cannot widen it.
    assert.equal(ownerOf(call.table, call.args.where ?? {}), ORG, `${call.table}.${call.op}`);
  }
  assert.deepEqual([...tables].sort(), [
    "agentDeployment", "creditBalance", "creditTransaction", "deployment",
    "marketplaceRevenue", "trainingJob", "trialCharge", "usageRecord",
  ]);
  // A job's escrow is always asked for by type: a per-request row never answers.
  for (const call of calls.filter((c) => c.table === "marketplaceRevenue")) {
    assert.equal(call.args.where?.type, "job");
  }
});

test("scoping: two organizations with the same shape of data read different answers", async () => {
  const when = at("2026-10-03T12:00:00Z");
  const { deps } = setup({
    creditBalance: [{ orgId: ORG, balanceCents: 100n }, { orgId: OTHER_ORG, balanceCents: 200n }],
    creditTransaction: [
      ledgerRow({ orgId: ORG, id: uuid(1), type: "gpu_usage", amountCents: -10n, gpuSeconds: 3_600n, createdAt: when }),
      ledgerRow({ orgId: OTHER_ORG, id: uuid(2), type: "gpu_usage", amountCents: -20n, gpuSeconds: 7_200n, createdAt: when }),
    ],
    usageRecord: [
      { orgId: ORG, periodStart: when, requestCount: 1, inputTokens: 1n, outputTokens: 1n },
      { orgId: OTHER_ORG, periodStart: when, requestCount: 2, inputTokens: 2n, outputTokens: 2n },
    ],
  });
  for (const [org, cents, hours, id] of [[ORG, 0.1, 1, uuid(1)], [OTHER_ORG, 0.2, 2, uuid(2)]] as const) {
    const { usage } = await readUsage(deps, org);
    assert.equal(usage.currentMonth, cents);
    assert.equal(usage.gpuHours, hours);
    assert.equal(usage.requests, hours);
    const list = await listTransactions(deps, org, {});
    assert.ok(list.ok);
    assert.deepEqual(list.transactions.map((t) => t.id), [id]);
    const file = await exportTransactions(deps, org, {});
    assert.ok(file.ok);
    assert.equal(file.rows, 1);
  }
  // A cursor from one organization opens nothing of another's.
  const cursor = encodeCursor({ createdAt: ms(when, 1), id: uuid(9) });
  const peek = await listTransactions(deps, ORG, { cursor });
  assert.ok(peek.ok);
  assert.deepEqual(peek.transactions.map((t) => t.id), [uuid(1)]);
});

test("sentences: plain, short, and with no em dash", () => {
  assert.equal(BILLING_LEDGER_SENTENCES.invalid_request, "That list could not be read. Reload the page and try again.");
  assert.equal(BILLING_LEDGER_SENTENCES.invalid_range, "Choose a start date and an end date, with the start first.");
  assert.equal(
    BILLING_LEDGER_SENTENCES.range_too_large,
    "That range holds more rows than one file can carry. Choose a shorter range.",
  );
  assert.equal(BILLING_LEDGER_SENTENCES.billing_unavailable, "Billing could not be read. Try again in a moment.");
  for (const sentence of [...Object.values(BILLING_LEDGER_SENTENCES), ...Object.values(HOLD_NOTES)]) {
    assert.doesNotMatch(sentence, /[–—]/);
    assert.ok(sentence.length <= 100, sentence);
  }
});
