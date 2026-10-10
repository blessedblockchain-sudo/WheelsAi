import assert from "node:assert/strict";
import test from "node:test";

import { platformModelCostCents, platformModelCostMicros } from "../services/jobRunner.js";
import {
  centsCrossed,
  chargeMarketplaceRequest,
  refundMarketplaceRequest,
  settleMarketplaceRequest,
  type MarketplaceCharge,
  type MeteredInstall,
} from "../services/marketplaceMetering.js";

// The model cost of a paid use, taken from the creator's share at settle.
// What these pin: a copy, and a use with no model cost, issue exactly the
// statements metering always has; a cent leaves the creator's amount only
// when the listing's running total crosses one; no row gives up more than
// it has for the creator; and the total moves in the settle's transaction,
// once per charge.

/** A copy, as resolveInstallBilling returns it: no kind. */
const COPY: MeteredInstall = {
  installId: "ins_1",
  listingId: "lst_1",
  listingTitle: "Support Bot",
  publisherId: "org_pub",
  buyerId: "org_buyer",
  pricePerRequestCents: 5n,
};
const USE: MeteredInstall = { ...COPY, kind: "use" };
const SETTLED_AT = new Date("2026-10-14T12:00:00Z");
const now = () => SETTLED_AT;

interface Statement {
  model: string;
  op: string;
  args: unknown;
}

interface State {
  balance: bigint;
  ledger: Array<{ type: string; amountCents: bigint; referenceId: string }>;
  revenue: Map<string, { status: string; platformFee: bigint; creator: bigint; gross: bigint }>;
  publisher: { total: bigint; pending: bigint };
  install: { requests: bigint; spent: bigint };
  listing: { requests: bigint; useModelCostMicros: bigint };
}

/**
 * An in-memory database that records every statement, with transactions
 * that roll back what they wrote when they throw.
 */
function makeDb(opts: { balance?: bigint; startMicros?: bigint; failPublisherUpdate?: boolean } = {}) {
  let state: State = {
    balance: opts.balance ?? 1_000n,
    ledger: [],
    revenue: new Map(),
    publisher: { total: 0n, pending: 0n },
    install: { requests: 0n, spent: 0n },
    listing: { requests: 0n, useModelCostMicros: opts.startMicros ?? 0n },
  };
  const statements: Statement[] = [];
  let seq = 0;
  const record = (model: string, op: string, args: unknown) => statements.push({ model, op, args });

  const tx = {
    creditBalance: {
      updateMany: async (args: { where: { balanceCents: { gte: bigint } }; data: { balanceCents: { decrement: bigint } } }) => {
        record("creditBalance", "updateMany", args);
        if (state.balance < args.where.balanceCents.gte) return { count: 0 };
        state.balance -= args.data.balanceCents.decrement;
        return { count: 1 };
      },
      findUnique: async (args: unknown) => {
        record("creditBalance", "findUnique", args);
        return { balanceCents: state.balance };
      },
      update: async (args: { data: { balanceCents: { increment: bigint } } }) => {
        record("creditBalance", "update", args);
        state.balance += args.data.balanceCents.increment;
        return { balanceCents: state.balance };
      },
    },
    creditTransaction: {
      create: async (args: { data: { type: string; amountCents: bigint; referenceId: string } }) => {
        record("creditTransaction", "create", args);
        state.ledger.push({ type: args.data.type, amountCents: args.data.amountCents, referenceId: args.data.referenceId });
        return {};
      },
    },
    marketplaceRevenue: {
      create: async (args: {
        data: { status: string; platformFeeCents: bigint; creatorAmountCents: bigint; grossAmountCents: bigint };
      }) => {
        record("marketplaceRevenue", "create", args);
        const id = `rev_${++seq}`;
        state.revenue.set(id, {
          status: args.data.status,
          platformFee: args.data.platformFeeCents,
          creator: args.data.creatorAmountCents,
          gross: args.data.grossAmountCents,
        });
        return { id };
      },
      updateMany: async (args: { where: { id: string; status: string }; data: { status: string } }) => {
        record("marketplaceRevenue", "updateMany", args);
        const row = state.revenue.get(args.where.id);
        if (!row || row.status !== args.where.status) return { count: 0 };
        row.status = args.data.status;
        return { count: 1 };
      },
      update: async (args: {
        where: { id: string };
        data: { platformFeeCents: { increment: bigint }; creatorAmountCents: { decrement: bigint } };
      }) => {
        record("marketplaceRevenue", "update", args);
        const row = state.revenue.get(args.where.id)!;
        row.platformFee += args.data.platformFeeCents.increment;
        row.creator -= args.data.creatorAmountCents.decrement;
        return {};
      },
    },
    publisherProfile: {
      update: async (args: {
        data: { totalRevenueCents: { increment: bigint }; pendingPayoutCents: { increment: bigint } };
      }) => {
        record("publisherProfile", "update", args);
        if (opts.failPublisherUpdate) throw new Error("publisher profile is gone");
        state.publisher.total += args.data.totalRevenueCents.increment;
        state.publisher.pending += args.data.pendingPayoutCents.increment;
        return {};
      },
    },
    agentInstall: {
      update: async (args: { data: { totalRequests: { increment: bigint }; totalSpentCents: { increment: bigint } } }) => {
        record("agentInstall", "update", args);
        state.install.requests += args.data.totalRequests.increment;
        state.install.spent += args.data.totalSpentCents.increment;
        return {};
      },
    },
    agentListing: {
      update: async (args: {
        data: { totalRequests?: { increment: bigint }; useModelCostMicros?: { increment: bigint } };
      }) => {
        record("agentListing", "update", args);
        if (args.data.totalRequests) state.listing.requests += args.data.totalRequests.increment;
        if (args.data.useModelCostMicros) state.listing.useModelCostMicros += args.data.useModelCostMicros.increment;
        return { useModelCostMicros: state.listing.useModelCostMicros };
      },
    },
  };

  async function transaction<T>(fn: (t: typeof tx) => Promise<T>): Promise<T> {
    const before = structuredClone(state);
    try {
      return await fn(tx);
    } catch (err) {
      state = before;
      throw err;
    }
  }

  return {
    tx,
    statements,
    transaction,
    get state() {
      return state;
    },
  };
}

type Db = ReturnType<typeof makeDb>;

async function charge(db: Db, install: MeteredInstall): Promise<MarketplaceCharge> {
  const result = await chargeMarketplaceRequest(db.tx as never, { install });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.charge;
}

const settle = (db: Db, c: MarketplaceCharge, modelCostMicros?: bigint) =>
  db.transaction((tx) => settleMarketplaceRequest(tx as never, { charge: c, now, modelCostMicros }));

/** The statements one function issued, without the ones before it. */
async function statementsOf(db: Db, run: () => Promise<unknown>): Promise<Statement[]> {
  const from = db.statements.length;
  await run();
  return db.statements.slice(from);
}

// The statements a settle issues today, written out: this list is the pin.
const TODAYS_SETTLE: Statement[] = [
  {
    model: "marketplaceRevenue",
    op: "updateMany",
    args: { where: { id: "rev_1", status: "pending" }, data: { status: "settled", settledAt: SETTLED_AT } },
  },
  {
    model: "publisherProfile",
    op: "update",
    args: { where: { orgId: "org_pub" }, data: { totalRevenueCents: { increment: 4n }, pendingPayoutCents: { increment: 4n } } },
  },
  {
    model: "agentInstall",
    op: "update",
    args: { where: { id: "ins_1" }, data: { totalRequests: { increment: 1n }, totalSpentCents: { increment: 5n } } },
  },
  {
    model: "agentListing",
    op: "update",
    args: { where: { id: "lst_1" }, data: { totalRequests: { increment: 1n } } },
  },
];

test("without the new arguments a settle issues exactly today's statements, and answers as it always has", async () => {
  const db = makeDb();
  const c = await charge(db, COPY);
  let result: unknown;
  const issued = await statementsOf(db, async () => {
    result = await settleMarketplaceRequest(db.tx as never, { charge: c, now });
  });
  assert.deepEqual(issued, TODAYS_SETTLE);
  // No modelCostCents key: the answer is the one the existing tests compare against.
  assert.deepEqual(result, { settled: true, creatorCents: 4n });
  assert.equal(db.state.listing.useModelCostMicros, 0n);
});

test("a copy with a model cost, and a use with none, also issue exactly today's statements", async () => {
  const cases: Array<{ install: MeteredInstall; modelCostMicros?: bigint; name: string }> = [
    { install: { ...COPY, kind: "copy" }, name: "kind copy" },
    // A copy runs on the buyer's own allowance: a model cost is not the creator's to repay.
    { install: COPY, modelCostMicros: 3_000_000n, name: "no kind, with a cost" },
    { install: { ...COPY, kind: "copy" }, modelCostMicros: 3_000_000n, name: "kind copy, with a cost" },
    { install: USE, name: "use, no cost" },
    // The creator's own model key costs the platform nothing.
    { install: USE, modelCostMicros: 0n, name: "use, zero cost" },
    { install: USE, modelCostMicros: -5n, name: "use, a negative cost" },
  ];
  for (const { install, modelCostMicros, name } of cases) {
    const db = makeDb();
    const c = await charge(db, install);
    let result: unknown;
    const issued = await statementsOf(db, async () => {
      result = await settleMarketplaceRequest(db.tx as never, { charge: c, now, modelCostMicros });
    });
    assert.deepEqual(issued, TODAYS_SETTLE, name);
    assert.deepEqual(result, { settled: true, creatorCents: 4n }, name);
    assert.equal(db.state.listing.useModelCostMicros, 0n, name);
    assert.equal(db.state.publisher.pending, 4n, name);
  }
});

test("the charge and the refund of a use are the statements of a copy, but for the words of the ledger line", async () => {
  // Everything that moves money is the same statement; only what Billing
  // history calls the line differs (pinned on its own below).
  const unworded = (db: Db) =>
    db.statements.map((s) =>
      s.model === "creditTransaction"
        ? { ...s, args: { data: { ...(s.args as { data: object }).data, description: "" } } }
        : s,
    );
  const copy = makeDb();
  const use = makeDb();
  const copyCharge = await charge(copy, COPY);
  const useCharge = await charge(use, USE);
  assert.deepEqual(unworded(use), unworded(copy));

  await refundMarketplaceRequest(copy.tx as never, { charge: copyCharge, reason: "model timeout" });
  await refundMarketplaceRequest(use.tx as never, { charge: useCharge, reason: "model timeout" });
  assert.deepEqual(unworded(use), unworded(copy));
  assert.equal(use.state.balance, 1_000n);
  assert.deepEqual(
    use.state.ledger.map((row) => [row.type, row.amountCents]),
    [
      ["marketplace_usage", -5n],
      ["marketplace_refund", 5n],
    ],
  );
});

test("a cent moves only when the running total crosses one", async () => {
  const db = makeDb();
  // Three delivered 5-cent uses, each costing 0.4 of a cent on the platform's keys.
  const results = [];
  for (let i = 0; i < 3; i++) {
    results.push(await settle(db, await charge(db, USE), 400_000n));
  }
  assert.deepEqual(results, [
    { settled: true, creatorCents: 4n, modelCostCents: 0n },
    { settled: true, creatorCents: 4n, modelCostCents: 0n },
    // 1,200,000 millionths: the total has just crossed its first cent.
    { settled: true, creatorCents: 3n, modelCostCents: 1n },
  ]);
  assert.equal(db.state.listing.useModelCostMicros, 1_200_000n);
  assert.deepEqual(
    [...db.state.revenue.values()].map((row) => [row.platformFee, row.creator]),
    [
      [1n, 4n],
      [1n, 4n],
      [2n, 3n],
    ],
  );
  // Rounding up per use would have taken a cent from each: 9 for the creator, not 11.
  assert.equal(db.state.publisher.pending, 11n);
  assert.equal(db.state.publisher.total, 11n);
  // Every row still adds up, and every cent the creator can withdraw came from the buyer.
  for (const row of db.state.revenue.values()) assert.equal(row.platformFee + row.creator, row.gross);
  assert.equal(db.state.publisher.pending + 4n, 1_000n - db.state.balance);
  // What the buyer paid, and the counters, do not depend on the model cost.
  assert.equal(db.state.install.spent, 15n);
  assert.equal(db.state.install.requests, 3n);
  assert.equal(db.state.listing.requests, 3n);
});

test("the row is moved by one statement, after the total and before the creator is credited", async () => {
  const db = makeDb({ startMicros: 900_000n });
  const c = await charge(db, USE);
  const issued = await statementsOf(db, () => settle(db, c, 250_000n));
  assert.deepEqual(
    issued.map((s) => `${s.model}.${s.op}`),
    [
      "marketplaceRevenue.updateMany",
      "agentListing.update",
      "marketplaceRevenue.update",
      "publisherProfile.update",
      "agentInstall.update",
      "agentListing.update",
    ],
  );
  assert.deepEqual(issued[1]!.args, {
    where: { id: "lst_1" },
    data: { useModelCostMicros: { increment: 250_000n } },
    select: { useModelCostMicros: true },
  });
  assert.deepEqual(issued[2]!.args, {
    where: { id: "rev_1" },
    data: { platformFeeCents: { increment: 1n }, creatorAmountCents: { decrement: 1n } },
  });
  assert.deepEqual(issued[3]!.args, {
    where: { orgId: "org_pub" },
    data: { totalRevenueCents: { increment: 3n }, pendingPayoutCents: { increment: 3n } },
  });

  // A settle that crosses no cent does not touch the revenue row again.
  const next = await charge(db, USE);
  const quiet = await statementsOf(db, () => settle(db, next, 100_000n));
  assert.equal(quiet.some((s) => s.model === "marketplaceRevenue" && s.op === "update"), false);
});

test("a row never gives up more than it has for the creator", async () => {
  const db = makeDb();
  // One 5-cent use whose run cost 9 cents: the creator's 4 cents go, and no more.
  const result = await settle(db, await charge(db, USE), 9_000_000n);
  assert.deepEqual(result, { settled: true, creatorCents: 0n, modelCostCents: 4n });
  const row = db.state.revenue.get("rev_1")!;
  assert.deepEqual([row.platformFee, row.creator, row.gross], [5n, 0n, 5n]);
  assert.equal(db.state.publisher.pending, 0n);
  assert.equal(db.state.publisher.total, 0n);
  // The whole cost is on the total, so the cents this row could not cover are not taken from the next one.
  assert.equal(db.state.listing.useModelCostMicros, 9_000_000n);
  const after = await settle(db, await charge(db, USE), 100_000n);
  assert.deepEqual(after, { settled: true, creatorCents: 4n, modelCostCents: 0n });
});

test("settle after refund and refund after settle do nothing, and the total moves once per charge", async () => {
  const settledFirst = makeDb();
  const a = await charge(settledFirst, USE);
  await settle(settledFirst, a, 1_500_000n);
  const before = structuredClone(settledFirst.state);

  const again = await statementsOf(settledFirst, async () => {
    assert.deepEqual(await settle(settledFirst, a, 1_500_000n), { settled: false, reason: "not_pending" });
  });
  // The compare-and-set, and nothing after it.
  assert.deepEqual(again.map((s) => `${s.model}.${s.op}`), ["marketplaceRevenue.updateMany"]);
  const lateRefund = await refundMarketplaceRequest(settledFirst.tx as never, { charge: a, reason: "late" });
  assert.deepEqual(lateRefund, { refunded: false, reason: "not_pending" });
  assert.deepEqual(settledFirst.state, before);
  assert.equal(settledFirst.state.listing.useModelCostMicros, 1_500_000n);

  const refundedFirst = makeDb();
  const b = await charge(refundedFirst, USE);
  await refundMarketplaceRequest(refundedFirst.tx as never, { charge: b, reason: "no answer" });
  const lateSettle = await settle(refundedFirst, b, 1_500_000n);
  assert.deepEqual(lateSettle, { settled: false, reason: "not_pending" });
  // A use that was refunded repays no model cost and credits nobody.
  assert.equal(refundedFirst.state.listing.useModelCostMicros, 0n);
  assert.equal(refundedFirst.state.publisher.pending, 0n);
  assert.equal(refundedFirst.state.balance, 1_000n);
  assert.equal(refundedFirst.state.revenue.get("rev_1")!.status, "refunded");
});

test("the running total is updated in the same transaction as the settle", async () => {
  const db = makeDb({ startMicros: 900_000n, failPublisherUpdate: true });
  const c = await charge(db, USE);
  await assert.rejects(settle(db, c, 250_000n), /publisher profile is gone/);
  // The settle did not commit, so neither did its model cost: the charge is
  // still pending, the row is whole, and a retry will cross the cent once.
  assert.equal(db.state.listing.useModelCostMicros, 900_000n);
  const row = db.state.revenue.get("rev_1")!;
  assert.deepEqual([row.status, row.platformFee, row.creator], ["pending", 1n, 4n]);
});

test("the whole cents a total has just crossed", () => {
  assert.equal(centsCrossed(400_000n, 400_000n), 0n);
  assert.equal(centsCrossed(999_999n, 1n), 0n);
  assert.equal(centsCrossed(1_000_000n, 1n), 1n);
  assert.equal(centsCrossed(1_200_000n, 400_000n), 1n);
  assert.equal(centsCrossed(3_100_000n, 2_200_000n), 3n);
  assert.equal(centsCrossed(5_000_000n, 0n), 0n);
  assert.equal(centsCrossed(5_000_000n, -1n), 0n);
  // A total smaller than what was just added is not a total: take nothing.
  assert.equal(centsCrossed(10n, 2_000_000n), 0n);
  // Whatever the steps, the cents taken add up to the whole cents of the total.
  let total = 0n;
  let taken = 0n;
  for (const step of [1n, 999_998n, 1n, 123_456n, 4_000_000n, 876_544n, 1n]) {
    total += step;
    taken += centsCrossed(total, step);
  }
  assert.equal(taken, total / 1_000_000n);
});

test("model cost in millionths of a cent is not rounded up to a cent, and the cents are what they were", () => {
  const rates = { inputCentsPerMTok: 15, outputCentsPerMTok: 60 };
  assert.equal(platformModelCostMicros({ inputTokens: 0, outputTokens: 0 }, rates), 0n);
  // One input token: 15 millionths of a cent, where the job runner charges a whole cent.
  assert.equal(platformModelCostMicros({ inputTokens: 1, outputTokens: 0 }, rates), 15n);
  assert.equal(platformModelCostCents({ inputTokens: 1, outputTokens: 0 }, rates), 1n);
  assert.equal(platformModelCostMicros({ inputTokens: 1_200, outputTokens: 400 }, rates), 42_000n);
  assert.equal(platformModelCostMicros({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, rates), 75_000_000n);
  assert.equal(platformModelCostMicros({ inputTokens: 5_000, outputTokens: 2_000 }, { inputCentsPerMTok: 0, outputCentsPerMTok: 0 }), 0n);
  assert.equal(platformModelCostMicros({ inputTokens: -5, outputTokens: -1 }, rates), 0n);
  assert.equal(platformModelCostMicros({ inputTokens: Number.NaN, outputTokens: 1 }, rates), 0n);
  assert.equal(platformModelCostMicros({ inputTokens: Number.POSITIVE_INFINITY, outputTokens: 1 }, rates), 0n);

  // The whole-cent figure, against the formula it had before it was expressed through the millionths.
  const before = (usage: { inputTokens: number; outputTokens: number }, r: typeof rates) => {
    const micro =
      Math.max(0, usage.inputTokens) * Math.max(0, r.inputCentsPerMTok) +
      Math.max(0, usage.outputTokens) * Math.max(0, r.outputCentsPerMTok);
    if (!Number.isFinite(micro) || micro <= 0) return 0n;
    return BigInt(Math.ceil(micro / 1_000_000));
  };
  const tokens = [0, 1, 7, 999, 1_000, 16_666, 16_667, 66_666, 66_667, 1_000_000, 13_333_333, 250_000_000, -3];
  const allRates = [rates, { inputCentsPerMTok: 0, outputCentsPerMTok: 0 }, { inputCentsPerMTok: 300, outputCentsPerMTok: 1_500 }, { inputCentsPerMTok: 2.5, outputCentsPerMTok: 7.5 }, { inputCentsPerMTok: 100_000, outputCentsPerMTok: 100_000 }];
  for (const r of allRates) {
    for (const inputTokens of tokens) {
      for (const outputTokens of tokens) {
        const usage = { inputTokens, outputTokens };
        assert.equal(platformModelCostCents(usage, r), before(usage, r), JSON.stringify({ usage, r }));
      }
    }
  }
});

test("a use's ledger lines read as Billing history words them; a copy's are as they were", async () => {
  const descriptions = (db: Db) =>
    db.statements
      .filter((s) => s.model === "creditTransaction")
      .map((s) => (s.args as { data: { description: string } }).data.description);

  for (const install of [COPY, { ...COPY, kind: "copy" as const }]) {
    const db = makeDb();
    const charged = await db.transaction((tx) => chargeMarketplaceRequest(tx as never, { install }));
    assert.ok(charged.ok);
    await db.transaction((tx) =>
      refundMarketplaceRequest(tx as never, { charge: charged.charge, reason: "upstream timeout" }),
    );
    assert.deepEqual(descriptions(db), [
      "Marketplace request — Support Bot",
      "Marketplace request refunded — Support Bot (upstream timeout)",
    ]);
  }

  const db = makeDb();
  const charged = await db.transaction((tx) => chargeMarketplaceRequest(tx as never, { install: USE }));
  assert.ok(charged.ok);
  await db.transaction((tx) =>
    refundMarketplaceRequest(tx as never, { charge: charged.charge, reason: "upstream timeout" }),
  );
  // The reason stays in the logs: a buyer's statement names the agent only.
  assert.deepEqual(descriptions(db), ["Paid use: Support Bot", "Paid use refunded: Support Bot"]);
  assert.deepEqual(
    db.state.ledger.map((l) => l.type),
    ["marketplace_usage", "marketplace_refund"],
  );
});

test("a copy whose licence row became a use licence keeps billing as a copy, in a copy's words", async () => {
  // startUsing on an active copy licence turns that ONE row into kind "use"
  // and leaves clonedAgentId set, so the buyer's copy is still metered by
  // it. The copy path finds the row by the copy it runs and never reads the
  // row's kind: what it charges is a copy's request.
  const { resolveInstallBilling } = await import("../services/marketplaceMetering.js");
  const selects: unknown[] = [];
  const lookup = {
    agentInstall: {
      findFirst: async (args: { where: unknown; select: Record<string, unknown> }) => {
        selects.push(args);
        return {
          id: "ins_1",
          listingId: "lst_1",
          buyerId: "org_buyer",
          status: "active",
          // The row as it is stored now. Returned whether or not it is asked for.
          kind: "use",
          clonedAgentId: "agent_copy",
          acceptedPricingModel: "per_request",
          acceptedPricePerRequestCents: 5n,
          listing: {
            title: "Support Bot",
            status: "published",
            sells: "use",
            publisherId: "org_pub",
            pricingModel: "per_request",
            pricePerRequestCents: 5n,
            agentToken: null,
          },
        };
      },
    },
  };
  const billing = await resolveInstallBilling(lookup as never, { agentId: "agent_copy", orgId: "org_buyer" });
  assert.equal(billing.kind, "billable");
  assert.ok(billing.kind === "billable");
  // Found by the copy, for its buyer; the row's kind is not part of the question.
  assert.deepEqual((selects[0] as { where: unknown }).where, { clonedAgentId: "agent_copy", buyerId: "org_buyer" });
  assert.equal("kind" in (selects[0] as { select: object }).select, false);
  assert.deepEqual(billing.install, { ...COPY });
  assert.equal(billing.install.kind, undefined);

  const db = makeDb();
  const taken = await charge(db, billing.install);
  // A copy's request repays no model cost, whatever the settle is told.
  assert.deepEqual(await settle(db, taken, 9_000_000n), { settled: true, creatorCents: 4n });
  assert.equal(db.state.listing.useModelCostMicros, 0n);
  const refundable = await charge(db, billing.install);
  await refundMarketplaceRequest(db.tx as never, { charge: refundable, reason: "model timeout" });
  assert.deepEqual(
    db.statements
      .filter((s) => s.model === "creditTransaction")
      .map((s) => (s.args as { data: { description: string } }).data.description),
    [
      "Marketplace request — Support Bot",
      "Marketplace request — Support Bot",
      "Marketplace request refunded — Support Bot (model timeout)",
    ],
  );
});
