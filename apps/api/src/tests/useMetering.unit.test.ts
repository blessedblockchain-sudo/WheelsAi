import assert from "node:assert/strict";
import test from "node:test";

import { spendDay } from "../services/apiKeySpend.js";
import type { MeteredInstall } from "../services/marketplaceMetering.js";
import {
  chargeUse,
  refundUse,
  resolveUseBilling,
  settleUse,
  type UseBilling,
  type UseBillingInput,
  type UseBillingLicence,
  type UseBillingListing,
  type UseMeteringDeps,
} from "../services/useMetering.js";
import { earningsStandIn, type EarningsRow } from "./earningsStandIn.js";

// One paid use of a creator's agent. What these pin: only a per-use price is
// billable; a subscriber and the creator are never charged; a buyer is never
// charged more than they accepted; and a charge that an API key's caps
// refuse leaves no debit, no revenue row and no ledger line.

const NOW = new Date("2026-10-14T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const LISTING: UseBillingListing = {
  id: "lst_1",
  title: "Support Bot",
  publisherId: "org_pub",
  status: "published",
  sells: "use",
  pricingModel: "per_request",
  pricePerRequestCents: 5n,
  monthlyPriceCents: null,
};
const MONTHLY: UseBillingListing = { ...LISTING, pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 900n };
const FREE: UseBillingListing = { ...LISTING, pricingModel: "free", pricePerRequestCents: null };

const licence = (over: Partial<UseBillingLicence> = {}): UseBillingLicence => ({
  id: "ins_1",
  buyerId: "org_buyer",
  kind: "use",
  status: "active",
  acceptedPricingModel: "per_request",
  acceptedPricePerRequestCents: 5n,
  ...over,
});
const monthlyLicence = (over: Partial<UseBillingLicence> = {}) =>
  licence({ acceptedPricingModel: "monthly", acceptedPricePerRequestCents: null, ...over });
const paidMonth = { status: "active", currentPeriodEnd: new Date(NOW.getTime() + 10 * DAY), cancelAtPeriodEnd: false, endReason: null };
const overMonth = { status: "expired", currentPeriodEnd: new Date(NOW.getTime() - 2 * DAY), cancelAtPeriodEnd: false, endReason: null };

const resolve = (over: Partial<UseBillingInput> = {}): UseBilling =>
  resolveUseBilling({ callerOrgId: "org_buyer", listing: LISTING, licence: licence(), sub: null, ...over }, NOW);

const INSTALL: MeteredInstall = {
  installId: "ins_1",
  listingId: "lst_1",
  listingTitle: "Support Bot",
  publisherId: "org_pub",
  buyerId: "org_buyer",
  pricePerRequestCents: 5n,
  kind: "use",
};

// ============================================
// Resolution
// ============================================

test("a per-use licence at the accepted price is billable, as a use", () => {
  assert.deepEqual(resolve(), { kind: "billable", access: "listing_pricing", priceCents: 5n, install: INSTALL });
});

test("only per use is billable", () => {
  const kinds = (listing: UseBillingListing, lic: UseBillingLicence | null, sub: UseBillingInput["sub"] = null) =>
    resolve({ listing, licence: lic, sub }).kind;
  // Free: anyone, with a licence or without, in whatever state.
  assert.equal(kinds(FREE, null), "free");
  assert.equal(kinds(FREE, licence()), "free");
  assert.equal(kinds(FREE, licence({ status: "uninstalled" })), "free");
  assert.equal(kinds(FREE, licence({ kind: "copy" })), "free");
  // Monthly: runs inside a paid month, refused outside it, never billed per use.
  assert.equal(kinds(MONTHLY, monthlyLicence(), paidMonth), "subscribed");
  assert.equal(kinds(MONTHLY, monthlyLicence(), overMonth), "refused");
  assert.equal(kinds(MONTHLY, monthlyLicence(), null), "refused");
  // A per-use price of nothing is not a charge.
  assert.equal(kinds({ ...LISTING, pricePerRequestCents: 0n }, licence()), "free");
  assert.equal(kinds({ ...LISTING, pricePerRequestCents: null }, licence()), "free");
  // Token-gated use is not sold, so it is neither run nor billed.
  assert.equal(kinds({ ...LISTING, pricingModel: "tokenized" }, licence({ acceptedPricingModel: "tokenized" })), "refused");

  // Across every state, a charge target exists only for a per-use price on a listing that sells use.
  for (const listing of [LISTING, MONTHLY, FREE, { ...LISTING, status: "archived" }, { ...LISTING, sells: "copies" }]) {
    for (const lic of [null, licence(), monthlyLicence(), licence({ kind: "copy" }), licence({ status: "uninstalled" })]) {
      for (const sub of [null, paidMonth, overMonth]) {
        const billing = resolve({ listing, licence: lic, sub });
        if (billing.kind !== "billable") continue;
        assert.equal(listing.pricingModel, "per_request");
        assert.equal(listing.status, "published");
        assert.equal(listing.sells, "use");
        assert.equal(lic?.kind, "use");
        assert.equal(billing.install.kind, "use");
      }
    }
  }
});

test("a subscriber is never charged, whatever the listing says now", () => {
  for (const listing of [
    MONTHLY,
    // The creator moved to per use mid-month: the month is honoured, not billed again.
    LISTING,
    { ...MONTHLY, status: "archived" },
    { ...MONTHLY, sells: "copies" },
  ]) {
    assert.deepEqual(resolve({ listing, licence: monthlyLicence(), sub: paidMonth }), {
      kind: "subscribed",
      access: "subscribed",
    });
  }
});

// A plan: the subscription row carries a count of included uses, and a copy
// of the terms the buyer agreed to.
const planLicence = (over: Partial<UseBillingLicence> = {}) =>
  licence({ acceptedPricingModel: null, acceptedPricePerRequestCents: null, ...over });
const planMonth = {
  ...paidMonth,
  id: "sub_1",
  planId: "plan_1",
  currentPeriodStart: new Date(NOW.getTime() - 20 * DAY),
  includedUses: 500,
  usedInPeriod: 12,
  carriedUses: 30,
  extraUsePriceCents: 4n as bigint | null,
};

test("a subscriber on a plan gets the plan, with the terms on their row and never the listing's", () => {
  const expected = {
    subscriptionId: "sub_1",
    planId: "plan_1",
    includedUses: 500,
    usedInPeriod: 12,
    carriedUses: 30,
    extraUsePriceCents: 4n,
    periodStart: planMonth.currentPeriodStart,
    periodEnd: planMonth.currentPeriodEnd,
  };
  // The listing's price per use is 5 cents, then 50: the extra price agreed is 4, and stays 4.
  for (const listing of [LISTING, { ...LISTING, pricePerRequestCents: 50n }]) {
    const billing = resolve({ listing, licence: planLicence(), sub: planMonth });
    assert.deepEqual(billing, {
      kind: "plan",
      access: "subscribed",
      plan: expected,
      extraInstall: { ...INSTALL, pricePerRequestCents: 4n },
    });
  }
  // Used up is still the plan: the count decides, where a use is taken.
  const usedUp = resolve({ licence: planLicence(), sub: { ...planMonth, usedInPeriod: 530 } });
  assert.equal(usedUp.kind, "plan");
  if (usedUp.kind === "plan") assert.equal(usedUp.plan.usedInPeriod, 530);
});

test("a plan that stops has nothing to charge past the count, and neither has one on a listing no longer sold", () => {
  const stops = resolve({ licence: planLicence(), sub: { ...planMonth, extraUsePriceCents: null } });
  assert.equal(stops.kind, "plan");
  if (stops.kind === "plan") {
    assert.equal(stops.plan.extraUsePriceCents, null);
    assert.equal(stops.extraInstall, null);
  }
  for (const listing of [{ ...LISTING, status: "archived" }, { ...LISTING, sells: "copies" }]) {
    const billing = resolve({ listing, licence: planLicence(), sub: planMonth });
    // The period that was paid for is honoured.
    assert.equal(billing.kind, "plan");
    if (billing.kind !== "plan") throw new Error("unreachable");
    // What was agreed is still told as it was agreed, and nothing more is sold.
    assert.equal(billing.plan.extraUsePriceCents, 4n);
    assert.equal(billing.extraInstall, null);
  }
});

test("a plan row read without its id, its period start or its counts does not run", () => {
  for (const missing of ["id", "currentPeriodStart", "usedInPeriod", "carriedUses"] as const) {
    const sub = { ...planMonth, [missing]: undefined };
    assert.throws(() => resolve({ licence: planLicence(), sub }), /without its id, period start or counts/, missing);
  }
});

test("a plan that ended is refused with the choice, and charged per use only on the buyer's own agreement", () => {
  const over = { ...planMonth, status: "cancelled", currentPeriodEnd: new Date(NOW.getTime() - DAY) };
  const billing = resolve({ licence: planLicence(), sub: over });
  assert.deepEqual(billing, {
    kind: "refused",
    reason: "plan_ended",
    status: 402,
    code: "plan_ended",
    message: "Your plan ended. Choose a plan or pay per use to keep using it.",
    access: "plan_ended",
  });
  // The extra price of the plan that ended is not a price per use the buyer agreed to.
  const stillOpen = resolve({ licence: planLicence(), sub: { ...planMonth, currentPeriodEnd: new Date(NOW.getTime() - 4 * DAY) } });
  assert.equal(stillOpen.kind, "refused");
  // A buyer who accepted 5 cents a use themselves pays that, at the listing's price.
  const agreed = resolve({ licence: licence(), sub: over });
  assert.equal(agreed.kind, "billable");
  if (agreed.kind === "billable") assert.equal(agreed.priceCents, 5n);
});

// A free trial: a plan row agreed at a price of nothing. 20 uses, 3 of them used.
const trialDays = {
  ...planMonth,
  planId: "plan_trial",
  priceCents: 0n,
  cancelAtPeriodEnd: true,
  includedUses: 20,
  usedInPeriod: 3,
  carriedUses: 0,
  extraUsePriceCents: null as bigint | null,
};
const extraOf = (billing: UseBilling) => {
  assert.equal(billing.kind, "plan");
  if (billing.kind !== "plan") throw new Error("unreachable");
  return billing.extraInstall;
};

test("past a free trial's uses nothing is charged to a buyer who agreed to no price per use, whatever the trial's row says", () => {
  for (const usedInPeriod of [3, 20, 25]) {
    for (const extraUsePriceCents of [null, 4n]) {
      const billing = resolve({ licence: planLicence(), sub: { ...trialDays, usedInPeriod, extraUsePriceCents } });
      assert.equal(extraOf(billing), null);
      // The row is told as it was read: the take compares it again.
      if (billing.kind === "plan") assert.equal(billing.plan.extraUsePriceCents, extraUsePriceCents);
    }
  }
  // An agreement to something else is not an agreement to a price per use.
  for (const lic of [
    monthlyLicence(),
    licence({ acceptedPricingModel: "free", acceptedPricePerRequestCents: null }),
    // A price with no pricing model beside it was never agreed to as a price per use.
    licence({ acceptedPricingModel: null, acceptedPricePerRequestCents: 5n }),
    // Agreed, on a licence that non-payment has suspended.
    licence({ status: "suspended" }),
  ]) {
    assert.equal(extraOf(resolve({ licence: lic, sub: { ...trialDays, usedInPeriod: 20 } })), null);
  }
});

test("past a free trial's uses a buyer who agreed per use is charged what the same licence would be with no subscription at all", () => {
  // The listing's price is what they accepted, and then lower: the listing's price, never the trial row's.
  for (const listing of [LISTING, { ...LISTING, pricePerRequestCents: 3n }]) {
    const alone = resolve({ listing, licence: licence(), sub: null });
    assert.equal(alone.kind, "billable");
    if (alone.kind !== "billable") throw new Error("unreachable");
    for (const usedInPeriod of [3, 20]) {
      for (const extraUsePriceCents of [null, 4n, 99n]) {
        const billing = resolve({ listing, licence: licence(), sub: { ...trialDays, usedInPeriod, extraUsePriceCents } });
        // Still the trial: its own uses come first, and are taken where a use is taken.
        assert.equal(billing.kind === "plan" && billing.access, "subscribed");
        assert.deepEqual(extraOf(billing), alone.install);
        assert.deepEqual(extraOf(billing), { ...INSTALL, pricePerRequestCents: listing.pricePerRequestCents });
      }
    }
  }
});

test("a price that went up past what the buyer agreed to is not charged past a trial: the trial's uses run, then the price is put to them", () => {
  const raised = { ...LISTING, pricePerRequestCents: 50n };
  // While a use of the trial is left it runs, and nothing can be charged after it.
  const running = resolve({ listing: raised, licence: licence(), sub: trialDays });
  assert.equal(extraOf(running), null);
  // Gone: the refusal the same licence gets with no subscription at all.
  const alone = resolve({ listing: raised, licence: licence(), sub: null });
  for (const usedInPeriod of [20, 21]) {
    const gone = resolve({ listing: raised, licence: licence(), sub: { ...trialDays, usedInPeriod } });
    assert.deepEqual(gone, alone);
    assert.deepEqual(gone, {
      kind: "refused",
      reason: "pricing_changed",
      status: 409,
      code: "pricing_changed",
      message: "The owner changed the price to $0.50 per message. You agreed to $0.05. Nothing is charged until you accept the new price.",
      access: "pricing_changed",
    });
  }
  // A listing that is no longer sold: the trial's days are honoured and nothing more is sold on it.
  for (const listing of [{ ...LISTING, status: "archived" }, { ...LISTING, sells: "copies" }]) {
    for (const usedInPeriod of [3, 20]) {
      assert.equal(extraOf(resolve({ listing, licence: licence(), sub: { ...trialDays, usedInPeriod } })), null);
    }
  }
});

test("a paid plan is what it was for a buyer who agreed per use: the extra price on its row, or it stops", () => {
  const paid = { ...planMonth, priceCents: 900n };
  // The listing's price per use is 5 cents: the extra price agreed with the plan is 4.
  assert.deepEqual(extraOf(resolve({ licence: licence(), sub: paid })), { ...INSTALL, pricePerRequestCents: 4n });
  for (const usedInPeriod of [12, 530, 600]) {
    assert.equal(extraOf(resolve({ licence: licence(), sub: { ...paid, usedInPeriod, extraUsePriceCents: null } })), null);
  }
  // A row read without its price is a paid plan, not a trial.
  assert.equal(extraOf(resolve({ licence: licence(), sub: { ...trialDays, priceCents: undefined, usedInPeriod: 20 } })), null);
});

test("a subscriber whose row has no count gets exactly what they got before plans", () => {
  const noCount = { ...paidMonth, includedUses: null, planId: null, usedInPeriod: 0, carriedUses: 0, extraUsePriceCents: null };
  for (const listing of [MONTHLY, LISTING, { ...MONTHLY, status: "archived" }]) {
    for (const sub of [paidMonth, noCount]) {
      assert.deepEqual(resolve({ listing, licence: monthlyLicence(), sub }), { kind: "subscribed", access: "subscribed" });
    }
  }
  // Ended, it is a lapsed month or a changed price, as before: never "your plan ended".
  for (const sub of [overMonth, { ...overMonth, includedUses: null }]) {
    const lapsed = resolve({ listing: MONTHLY, licence: monthlyLicence(), sub });
    assert.equal(lapsed.kind === "refused" && lapsed.reason, "subscription_lapsed");
    const changed = resolve({ listing: LISTING, licence: monthlyLicence(), sub });
    assert.equal(changed.kind === "refused" && changed.reason, "pricing_changed");
  }
});

test("the caller's own listing is never billable", () => {
  for (const listing of [LISTING, MONTHLY, FREE, { ...LISTING, status: "archived" }]) {
    for (const lic of [null, licence({ buyerId: "org_pub" }), monthlyLicence({ buyerId: "org_pub" })]) {
      for (const sub of [null, paidMonth]) {
        const billing = resolve({ callerOrgId: "org_pub", listing, licence: lic, sub });
        assert.equal(billing.kind, "refused");
        assert.deepEqual(
          billing.kind === "refused" && [billing.reason, billing.status, billing.code],
          ["own_agent", 409, "own_agent"],
        );
      }
    }
  }
});

test("the price charged is the listing's when it went down, and nothing is charged when it went up", () => {
  const agreedTen = licence({ acceptedPricePerRequestCents: 10n });
  // Down to 8: the lower price applies at once.
  const down = resolve({ listing: { ...LISTING, pricePerRequestCents: 8n }, licence: agreedTen });
  assert.equal(down.kind, "billable");
  assert.equal(down.kind === "billable" && down.priceCents, 8n);
  assert.equal(down.kind === "billable" && down.install.pricePerRequestCents, 8n);
  // Unchanged: what was accepted.
  const same = resolve({ listing: { ...LISTING, pricePerRequestCents: 10n }, licence: agreedTen });
  assert.equal(same.kind === "billable" && same.priceCents, 10n);
  // Up to 12: refused, with both prices, and no charge target at all.
  const up = resolve({ listing: { ...LISTING, pricePerRequestCents: 12n }, licence: agreedTen });
  assert.deepEqual(up, {
    kind: "refused",
    reason: "pricing_changed",
    status: 409,
    code: "pricing_changed",
    message:
      "The owner changed the price to $0.12 per message. You agreed to $0.10. Nothing is charged until you accept the new price.",
    access: "pricing_changed",
  });
  const upRun = resolve({ listing: { ...LISTING, pricePerRequestCents: 12n }, licence: agreedTen, unit: "run" });
  assert.match(upRun.kind === "refused" ? upRun.message : "", /\$0\.12 per run/);
  // No price was ever charged above the accepted one, at any pair of prices.
  for (let accepted = 1n; accepted <= 12n; accepted++) {
    for (let price = 1n; price <= 12n; price++) {
      const billing = resolve({
        listing: { ...LISTING, pricePerRequestCents: price },
        licence: licence({ acceptedPricePerRequestCents: accepted }),
      });
      assert.equal(billing.kind, price <= accepted ? "billable" : "refused");
      if (billing.kind === "billable") assert.equal(billing.priceCents, price);
    }
  }
});

test("each refusal carries its status, its code and plain words", () => {
  const refusal = (over: Partial<UseBillingInput>) => {
    const billing = resolve(over);
    assert.equal(billing.kind, "refused");
    if (billing.kind !== "refused") throw new Error("unreachable");
    assert.equal(billing.code, billing.reason);
    // Product voice: no raw codes, no dashes standing in for punctuation.
    assert.doesNotMatch(billing.message, /_|—/);
    return [billing.reason, billing.status, billing.message];
  };
  assert.deepEqual(refusal({ licence: null }), [
    "use_not_started",
    403,
    "You have not started using this agent. Start on its page, or ask an owner or admin of your organization to start.",
  ]);
  // A copy holder has not agreed to pay for use.
  assert.equal(refusal({ licence: licence({ kind: "copy" }) })[0], "use_not_started");
  assert.equal(refusal({ licence: licence({ status: "uninstalled" }) })[0], "use_not_started");
  // Somebody else's licence row is no licence.
  assert.equal(refusal({ licence: licence({ buyerId: "org_other" }) })[0], "use_not_started");

  assert.deepEqual(refusal({ listing: MONTHLY, licence: monthlyLicence(), sub: overMonth }), [
    "subscription_lapsed",
    402,
    "Your subscription has ended. Subscribe again to keep using it.",
  ]);
  assert.deepEqual(refusal({ listing: MONTHLY }), [
    "pricing_changed",
    409,
    "This agent is now sold by the month ($9.00). Nothing is charged until you subscribe.",
  ]);
  assert.deepEqual(refusal({ listing: LISTING, licence: monthlyLicence(), sub: overMonth }), [
    "pricing_changed",
    409,
    "This agent is now sold per message ($0.05). Nothing is charged until you accept the new price.",
  ]);
  for (const listing of [{ ...LISTING, status: "archived" }, { ...LISTING, sells: "copies" }]) {
    assert.deepEqual(refusal({ listing }), [
      "not_offered",
      409,
      "This agent is no longer offered. You will not be charged again.",
    ]);
    // Never started, and nothing to start: there are no terms to show.
    assert.deepEqual(refusal({ listing, licence: null }), ["not_for_sale", 409, "Use of this agent is not for sale."]);
  }
  // A month that has run out on a listing that stopped selling use is over, not free.
  assert.equal(
    refusal({ listing: { ...MONTHLY, status: "archived" }, licence: monthlyLicence(), sub: overMonth })[0],
    "not_offered",
  );
});

// ============================================
// Charge
// ============================================

interface State {
  balances: Record<string, bigint>;
  revenue: Array<{ id: string; status: string; type: string; gross: bigint; platformFee: bigint; creator: bigint; installId: string }>;
  ledger: Array<{ orgId: string; type: string; amountCents: bigint; referenceId: string; balanceAfter: bigint }>;
  apiKeys: Record<string, { orgId: string; maxJobPriceCents: bigint | null; maxUsePriceCents: bigint | null; dailySpendCapCents: bigint | null }>;
  windows: Record<string, bigint>;
  publisherPending: bigint;
  /** The creator's ledger: one row for every change to what they are owed. */
  earnings: EarningsRow[];
  installSpent: bigint;
  listing: { requests: bigint; useModelCostMicros: bigint };
}

/** An in-memory database whose transactions roll back everything they wrote when they throw. */
function makeDb(opts: { balance?: bigint; perUse?: bigint | null; perDay?: bigint | null } = {}) {
  let state: State = {
    balances: { org_buyer: opts.balance ?? 100n },
    revenue: [],
    ledger: [],
    apiKeys: {
      key_1: {
        orgId: "org_buyer",
        maxJobPriceCents: null,
        maxUsePriceCents: opts.perUse === undefined ? 10n : opts.perUse,
        dailySpendCapCents: opts.perDay === undefined ? 100n : opts.perDay,
      },
    },
    windows: {},
    publisherPending: 0n,
    earnings: [],
    installSpent: 0n,
    listing: { requests: 0n, useModelCostMicros: 0n },
  };
  const counts = { transactions: 0, writes: 0 };
  const windowKey = (apiKeyId: string, day: Date) => `${apiKeyId}|${day.toISOString()}`;

  const tx = {
    creditBalance: {
      updateMany: async (args: { where: { orgId: string; balanceCents: { gte: bigint } }; data: { balanceCents: { decrement: bigint } } }) => {
        const balance = state.balances[args.where.orgId] ?? 0n;
        if (balance < args.where.balanceCents.gte) return { count: 0 };
        counts.writes++;
        state.balances[args.where.orgId] = balance - args.data.balanceCents.decrement;
        return { count: 1 };
      },
      findUnique: async (args: { where: { orgId: string } }) => ({ balanceCents: state.balances[args.where.orgId] ?? 0n }),
      update: async (args: { where: { orgId: string }; data: { balanceCents: { increment: bigint } } }) => {
        counts.writes++;
        state.balances[args.where.orgId] = (state.balances[args.where.orgId] ?? 0n) + args.data.balanceCents.increment;
        return { balanceCents: state.balances[args.where.orgId]! };
      },
    },
    creditTransaction: {
      create: async (args: { data: State["ledger"][number] }) => {
        counts.writes++;
        state.ledger.push({
          orgId: args.data.orgId,
          type: args.data.type,
          amountCents: args.data.amountCents,
          referenceId: args.data.referenceId,
          balanceAfter: args.data.balanceAfter,
        });
        return {};
      },
    },
    marketplaceRevenue: {
      create: async (args: {
        data: { status: string; type: string; grossAmountCents: bigint; platformFeeCents: bigint; creatorAmountCents: bigint; installId: string };
      }) => {
        counts.writes++;
        const id = `rev_${state.revenue.length + 1}`;
        state.revenue.push({
          id,
          status: args.data.status,
          type: args.data.type,
          gross: args.data.grossAmountCents,
          platformFee: args.data.platformFeeCents,
          creator: args.data.creatorAmountCents,
          installId: args.data.installId,
        });
        return { id };
      },
      updateMany: async (args: { where: { id: string; status: string }; data: { status: string } }) => {
        const row = state.revenue.find((r) => r.id === args.where.id);
        if (!row || row.status !== args.where.status) return { count: 0 };
        counts.writes++;
        row.status = args.data.status;
        return { count: 1 };
      },
      update: async (args: { where: { id: string }; data: { platformFeeCents: { increment: bigint }; creatorAmountCents: { decrement: bigint } } }) => {
        counts.writes++;
        const row = state.revenue.find((r) => r.id === args.where.id)!;
        row.platformFee += args.data.platformFeeCents.increment;
        row.creator -= args.data.creatorAmountCents.decrement;
        return {};
      },
    },
    apiKey: {
      findUnique: async (args: { where: { id: string } }) => state.apiKeys[args.where.id] ?? null,
    },
    apiKeySpendWindow: {
      createMany: async (args: { data: Array<{ apiKeyId: string; day: Date }> }) => {
        for (const row of args.data) {
          counts.writes++;
          state.windows[windowKey(row.apiKeyId, row.day)] ??= 0n;
        }
        return { count: args.data.length };
      },
      updateMany: async (args: { where: { apiKeyId: string; day: Date; spentCents: { lte: bigint } }; data: { spentCents: { increment: bigint } } }) => {
        const key = windowKey(args.where.apiKeyId, args.where.day);
        const spent = state.windows[key];
        if (spent === undefined || spent > args.where.spentCents.lte) return { count: 0 };
        counts.writes++;
        state.windows[key] = spent + args.data.spentCents.increment;
        return { count: 1 };
      },
    },
    // The creator is credited through the ledger (moveEarnings): the change
    // to the balance and the row for it are both writes.
    ...earningsStandIn({
      pending: () => state.publisherPending,
      add: (_orgId, pending) => {
        counts.writes++;
        state.publisherPending += pending;
      },
      write: (row) => {
        counts.writes++;
        state.earnings.push(row);
      },
    }),
    agentInstall: {
      update: async (args: { data: { totalSpentCents: { increment: bigint } } }) => {
        counts.writes++;
        state.installSpent += args.data.totalSpentCents.increment;
        return {};
      },
    },
    agentListing: {
      update: async (args: { data: { totalRequests?: { increment: bigint }; useModelCostMicros?: { increment: bigint } } }) => {
        counts.writes++;
        if (args.data.totalRequests) state.listing.requests += args.data.totalRequests.increment;
        if (args.data.useModelCostMicros) state.listing.useModelCostMicros += args.data.useModelCostMicros.increment;
        return { useModelCostMicros: state.listing.useModelCostMicros };
      },
    },
  };

  const deps: UseMeteringDeps = {
    now: () => NOW,
    async transaction(fn) {
      counts.transactions++;
      const before = structuredClone(state);
      try {
        return await fn(tx as never);
      } catch (err) {
        state = before;
        throw err;
      }
    },
  };
  return {
    deps,
    counts,
    get state() {
      return state;
    },
    spentToday: () => state.windows[windowKey("key_1", spendDay(NOW))],
  };
}

test("a session's use is one debit, one pending revenue row and one ledger line, in one transaction", async () => {
  const db = makeDb();
  const result = await chargeUse(db.deps, { install: INSTALL });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(db.counts.transactions, 1);
  assert.equal(db.state.balances.org_buyer, 95n);
  assert.deepEqual(db.state.revenue, [
    { id: "rev_1", status: "pending", type: "per_request", gross: 5n, platformFee: 1n, creator: 4n, installId: "ins_1" },
  ]);
  assert.deepEqual(db.state.ledger, [
    { orgId: "org_buyer", type: "marketplace_usage", amountCents: -5n, referenceId: "rev_1", balanceAfter: 95n },
  ]);
  // No key paid, so no key's day was touched.
  assert.deepEqual(db.state.windows, {});
  assert.equal(result.charge.revenueId, "rev_1");
  assert.equal(result.charge.install.kind, "use");
  // Nothing reaches the creator until the answer is delivered.
  assert.equal(db.state.publisherPending, 0n);
});

test("a key's use reserves its price on the key's day, in the same transaction as the debit", async () => {
  const db = makeDb();
  const result = await chargeUse(db.deps, { install: INSTALL, apiKeyId: "key_1" });
  assert.equal(result.ok, true);
  assert.equal(db.counts.transactions, 1);
  assert.equal(db.state.balances.org_buyer, 95n);
  assert.equal(db.spentToday(), 5n);
  assert.equal(db.state.revenue.length, 1);
  assert.equal(db.state.ledger.length, 1);
});

test("a refused key reservation leaves no debit, no row and no ledger line", async () => {
  const cases = [
    { name: "over the per-use cap", db: makeDb({ perUse: 4n }), code: "api_key_use_price_cap_exceeded" },
    { name: "over the day", db: makeDb({ perDay: 4n }), code: "api_key_daily_cap_exceeded" },
    { name: "no use cap on the key", db: makeDb({ perUse: null }), code: "api_key_spend_caps_missing" },
    { name: "no daily cap on the key", db: makeDb({ perDay: null }), code: "api_key_spend_caps_missing" },
  ];
  for (const { name, db, code } of cases) {
    const before = structuredClone(db.state);
    const result = await chargeUse(db.deps, { install: INSTALL, apiKeyId: "key_1" });
    assert.equal(result.ok, false, name);
    if (result.ok) throw new Error("unreachable");
    assert.deepEqual([result.reason, result.status, result.code], ["api_key_cap", 403, code], name);
    assert.doesNotMatch(result.message, /_|—/, name);
    // The debit was made and then rolled back with the reservation that refused it.
    assert.ok(db.counts.writes > 0, name);
    assert.deepEqual(db.state, before, name);
    assert.equal(db.state.balances.org_buyer, 100n, name);
    assert.equal(db.state.revenue.length, 0, name);
    assert.equal(db.state.ledger.length, 0, name);
    assert.equal(db.spentToday(), undefined, name);
  }

  // The day fills, and the use after it is refused whole.
  const db = makeDb({ perUse: 5n, perDay: 10n });
  await chargeUse(db.deps, { install: INSTALL, apiKeyId: "key_1" });
  await chargeUse(db.deps, { install: INSTALL, apiKeyId: "key_1" });
  const third = await chargeUse(db.deps, { install: INSTALL, apiKeyId: "key_1" });
  assert.equal(!third.ok && third.code, "api_key_daily_cap_exceeded");
  assert.equal(db.state.balances.org_buyer, 90n);
  assert.equal(db.state.revenue.length, 2);
  assert.equal(db.state.ledger.length, 2);
  assert.equal(db.spentToday(), 10n);
});

test("too few credits is a refusal that touches nothing", async () => {
  for (const apiKeyId of [undefined, "key_1"]) {
    const db = makeDb({ balance: 4n });
    const before = structuredClone(db.state);
    const result = await chargeUse(db.deps, { install: INSTALL, apiKeyId });
    assert.deepEqual(result, {
      ok: false,
      reason: "insufficient_credits",
      status: 402,
      code: "insufficient_credits",
      message: "You do not have enough credits for this message ($0.05). Nothing was charged. Add credits to continue.",
      requiredCents: 5n,
      balanceCents: 4n,
    });
    assert.deepEqual(db.state, before);
    // Not rolled back: never written. The key's day is not asked for either.
    assert.equal(db.counts.writes, 0);
    assert.equal(db.spentToday(), undefined);
  }
  const run = await chargeUse(makeDb({ balance: 0n }).deps, { install: INSTALL, unit: "run" });
  assert.match(!run.ok ? run.message : "", /for this run \(\$0\.05\)/);
});

test("a charge is refused for the creator's own organization and for a copy, before any statement", async () => {
  const db = makeDb();
  const own = await chargeUse(db.deps, { install: { ...INSTALL, buyerId: "org_pub" } });
  assert.deepEqual([own.ok, !own.ok && own.reason, !own.ok && own.status], [false, "own_agent", 409]);
  // A copy is metered by its own path; handing one here is a bug, not a charge.
  await assert.rejects(chargeUse(db.deps, { install: { ...INSTALL, kind: "copy" } }), /not for use/);
  const { kind: _kind, ...noKind } = INSTALL;
  await assert.rejects(chargeUse(db.deps, { install: noKind }), /not for use/);
  assert.equal(db.counts.transactions, 0);
  assert.equal(db.counts.writes, 0);
});

test("an error that is not a cap refusal is not swallowed, and still rolls the debit back", async () => {
  const db = makeDb();
  const failing: UseMeteringDeps = {
    ...db.deps,
    transaction: (fn) =>
      db.deps.transaction(async (tx) => {
        await fn(tx);
        throw new Error("connection lost at commit");
      }),
  };
  await assert.rejects(chargeUse(failing, { install: INSTALL, apiKeyId: "key_1" }), /connection lost/);
  assert.equal(db.state.balances.org_buyer, 100n);
  assert.equal(db.state.revenue.length, 0);
  assert.equal(db.state.ledger.length, 0);
  assert.equal(db.spentToday(), undefined);
});

// ============================================
// Settle and refund
// ============================================

async function charged(db: ReturnType<typeof makeDb>) {
  const result = await chargeUse(db.deps, { install: INSTALL, apiKeyId: "key_1" });
  if (!result.ok) throw new Error("unreachable");
  return result.charge;
}

test("a delivered use settles once, with the model cost it noted", async () => {
  const db = makeDb();
  const first = await charged(db);
  assert.deepEqual(await settleUse(db.deps, { charge: first, modelCostMicros: 600_000n }), {
    settled: true,
    creatorCents: 4n,
    modelCostCents: 0n,
  });
  const second = await charged(db);
  assert.deepEqual(await settleUse(db.deps, { charge: second, modelCostMicros: 600_000n }), {
    settled: true,
    creatorCents: 3n,
    modelCostCents: 1n,
  });
  assert.equal(db.state.listing.useModelCostMicros, 1_200_000n);
  assert.equal(db.state.publisherPending, 7n);
  // One ledger row per settle, for what the creator was credited after the
  // model cost, each against its revenue row.
  assert.deepEqual(
    db.state.earnings.map((row) => [row.orgId, row.type, row.amountCents, row.referenceId, row.balanceAfter]),
    [
      ["org_pub", "sale", 4n, db.state.revenue[0]!.id, 4n],
      ["org_pub", "sale", 3n, db.state.revenue[1]!.id, 7n],
    ],
  );
  assert.deepEqual(db.state.revenue.map((r) => [r.status, r.platformFee, r.creator]), [
    ["settled", 1n, 4n],
    ["settled", 2n, 3n],
  ]);
  assert.equal(db.state.installSpent, 10n);

  // Again, and a refund after it: nothing moves.
  const before = structuredClone(db.state);
  assert.deepEqual(await settleUse(db.deps, { charge: second, modelCostMicros: 600_000n }), {
    settled: false,
    reason: "not_pending",
  });
  assert.deepEqual(await refundUse(db.deps, { charge: second, reason: "late" }), { refunded: false, reason: "not_pending" });
  assert.deepEqual(db.state, before);

  // On the creator's own model key there is no cost, and the creator keeps the whole share.
  const third = await charged(db);
  assert.deepEqual(await settleUse(db.deps, { charge: third }), { settled: true, creatorCents: 4n });
});

test("a use with no answer is refunded once, and the key's day is not given back", async () => {
  const db = makeDb();
  const c = await charged(db);
  assert.deepEqual(await refundUse(db.deps, { charge: c, reason: "no answer" }), { refunded: true, amountCents: 5n });
  assert.equal(db.state.balances.org_buyer, 100n);
  assert.deepEqual(
    db.state.ledger.map((row) => [row.type, row.amountCents, row.referenceId, row.balanceAfter]),
    [
      ["marketplace_usage", -5n, "rev_1", 95n],
      ["marketplace_refund", 5n, "rev_1", 100n],
    ],
  );
  assert.equal(db.state.revenue[0]!.status, "refunded");
  // As for a job: the cap bounds what a key can commit in a day.
  assert.equal(db.spentToday(), 5n);

  const before = structuredClone(db.state);
  assert.deepEqual(await refundUse(db.deps, { charge: c, reason: "again" }), { refunded: false, reason: "not_pending" });
  assert.deepEqual(await settleUse(db.deps, { charge: c, modelCostMicros: 5_000_000n }), {
    settled: false,
    reason: "not_pending",
  });
  assert.deepEqual(db.state, before);
  assert.equal(db.state.publisherPending, 0n);
  assert.equal(db.state.listing.useModelCostMicros, 0n);
});
