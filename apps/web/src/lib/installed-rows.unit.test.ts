/**
 * The rows of Installed: agents you use, and copies you own. Run with:
 *   cd apps/web && npx tsx --test src/lib/installed-rows.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { MarketplaceInstallAccess, MarketplaceListing, MarketplaceSubscription } from "./api";
import {
  INSTALLED_WORDS,
  installedConfirm,
  installedRow,
  shortDay,
  type InstalledLicence,
} from "./installed-rows";

const FMT = { timeZone: "UTC", locale: "en-US" };

function listing(over: Partial<MarketplaceListing> = {}): MarketplaceListing {
  return {
    id: "l1",
    agentId: "a1",
    title: "Support Bot",
    slug: "support-bot",
    shortDescription: "Answers questions.",
    longDescription: null,
    category: "support",
    iconUrl: null,
    screenshots: [],
    readme: null,
    pricingModel: "per_request",
    pricePerRequestCents: 5,
    monthlyPriceCents: null,
    sells: "use",
    unit: "message",
    publisherId: "p1",
    publisherName: "Acme",
    status: "published",
    isFeatured: false,
    totalInstalls: 3,
    activeInstalls: 2,
    avgRating: 4.5,
    reviewCount: 2,
    totalRequests: 100,
    publishedAt: "2026-10-01T12:00:00.000Z",
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:00:00.000Z",
    ...over,
  };
}

const MONTHLY = { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 900, unit: "month" } as const;

function sub(over: Partial<MarketplaceSubscription> = {}): MarketplaceSubscription {
  return {
    id: "s1",
    listingId: "l1",
    status: "active",
    currentPeriodStart: "2026-10-13T12:00:00.000Z",
    currentPeriodEnd: "2026-11-12T12:00:00.000Z",
    cancelAtPeriodEnd: false,
    cancelledAt: null,
    hasAccess: true,
    graceEndsAt: null,
    priceCents: 900,
    endReason: null,
    ...over,
  };
}

function using(over: Partial<InstalledLicence> = {}): InstalledLicence {
  return {
    id: "i1",
    listingId: "l1",
    kind: "use",
    clonedAgentId: null,
    agent: { handle: "support-bot", name: "Support Bot", agentKind: "conversation" },
    status: "active",
    totalRequests: 37,
    totalSpentCents: 185,
    installedAt: "2026-10-02T12:00:00.000Z",
    access: "listing_pricing",
    acceptedPricing: { pricingModel: "per_request", pricePerRequestCents: 5, acceptedAt: "2026-10-02T12:00:00.000Z" },
    listing: listing(),
    subscription: null,
    ...over,
  };
}

function copy(over: Partial<InstalledLicence> = {}): InstalledLicence {
  return using({
    kind: "copy",
    clonedAgentId: "c1",
    listing: listing({ sells: "copies", unit: null }),
    ...over,
  });
}

const labels = (row: { actions: Array<{ label: string }> }) => row.actions.map((a) => a.label);

const ACCESSES: MarketplaceInstallAccess[] = [
  "subscribed",
  "listing_pricing",
  "unlisted",
  "subscription_lapsed",
  "pricing_changed",
  "uninstalled",
  "none",
  "not_offered",
  "plan_ended",
];

/** Every shape a use licence can be in, by access. */
function useCases(): Array<{ name: string; install: InstalledLicence }> {
  const cases: Array<{ name: string; install: InstalledLicence }> = [];
  for (const access of ACCESSES) {
    cases.push({ name: `${access}, per use`, install: using({ access }) });
    cases.push({
      name: `${access}, monthly`,
      install: using({
        access,
        listing: listing(MONTHLY),
        acceptedPricing: { pricingModel: "monthly", pricePerRequestCents: null, acceptedAt: null },
        subscription: sub(access === "subscribed" ? {} : { status: "expired", hasAccess: false }),
      }),
    });
    cases.push({ name: `${access}, free`, install: using({ access, listing: listing({ pricingModel: "free", pricePerRequestCents: null, unit: null }) }) });
    cases.push({ name: `${access}, archived`, install: using({ access, listing: listing({ status: "archived" }) }) });
    cases.push({ name: `${access}, now sells copies`, install: using({ access, listing: listing({ sells: "copies", unit: null }) }) });
    cases.push({ name: `${access}, no page`, install: using({ access, agent: { handle: null, name: "Support Bot", agentKind: "conversation" } }) });
  }
  return cases;
}

test("a use row never links to /dashboard/agents/, whatever its access", () => {
  for (const { name, install } of useCases()) {
    // Even if a stale copy id were on the row, it is not where a use row goes.
    const row = installedRow({ ...install, clonedAgentId: "c9" }, FMT);
    assert.doesNotMatch(JSON.stringify(row), /\/dashboard\/agents\//, name);
    const open = row.actions.find((a) => a.id === "open");
    if (install.agent.handle) {
      assert.equal(row.openHref, "/a/support-bot", name);
      assert.deepEqual(open, { id: "open", label: "Open", href: "/a/support-bot" }, name);
    } else {
      assert.equal(row.openHref, null, name);
      assert.equal(open, undefined, name);
    }
  }
});

test("every access of a use row has exactly one line, the badge and its actions", () => {
  for (const { name, install } of useCases()) {
    const row = installedRow(install, FMT);
    assert.equal(row.badge, "You use it", name);
    assert.ok(row.line && row.line.text.length > 0, name);
    assert.doesNotMatch(row.line.text, /—|undefined|null|NaN/, name);
    const ids = row.actions.map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length, `${name}: no action twice`);
    // Always: the listing, a review, and the way out.
    assert.ok(ids.includes("view_listing"), name);
    assert.ok(ids.includes("review"), name);
    assert.deepEqual(row.actions.at(-1), { id: "uninstall", label: "Stop using", destructive: true }, name);
    // Never a copy's words.
    assert.doesNotMatch(JSON.stringify(row), /Uninstall|View Agent|Resubscribe|[Yy]our copy/, name);
    // Stopping always asks first.
    assert.ok(installedConfirm(install, "uninstall", FMT), name);
    // A price is agreed to only on a button that names it.
    for (const id of ["accept_pricing", "resubscribe"] as const) {
      if (!ids.includes(id)) continue;
      const dialog = installedConfirm(install, id, FMT);
      assert.ok(dialog, `${name}: ${id} asks first`);
      assert.match(dialog.confirmLabel, /\$\d+\.\d\d/, `${name}: ${id} names the price`);
    }
  }
});

test("use, per message: the price, the uses and what was spent", () => {
  const row = installedRow(using(), FMT);
  assert.deepEqual(row.line, { text: "$0.05 per message. 37 uses, $1.85 spent.", tone: "ok" });
  assert.equal(row.priceLabel, "$0.05 per message");
  assert.equal(row.usage, null);
  assert.deepEqual(labels(row), ["Open", "View Listing", "Write Review", "Stop using"]);
  assert.deepEqual(row.terms, { pricingModel: "per_request", pricePerRequestCents: 5, monthlyPriceCents: null });
});

test("use, a task agent counts runs; one use is singular; a free one says so", () => {
  const task = installedRow(using({ listing: listing({ unit: "run", pricePerRequestCents: 10 }), totalRequests: 1, totalSpentCents: 10 }), FMT);
  assert.equal(task.line?.text, "$0.10 per run. 1 use, $0.10 spent.");
  const free = installedRow(using({ listing: listing({ pricingModel: "free", pricePerRequestCents: null, unit: null }), totalSpentCents: 0 }), FMT);
  assert.equal(free.line?.text, "Free to use. 37 uses.");
  assert.equal(free.priceLabel, "Free");
});

test("use, subscribed: renews at the price agreed, and renewal can be cancelled", () => {
  const install = using({ access: "subscribed", listing: listing({ ...MONTHLY, monthlyPriceCents: 1200 }), subscription: sub() });
  const row = installedRow(install, FMT);
  // The listing now asks $12.00; the renewal charges the $9.00 agreed.
  assert.deepEqual(row.line, { text: "Renews 12 Nov at $9.00 a month.", tone: "ok" });
  assert.equal(row.priceLabel, "$9.00 a month");
  assert.deepEqual(labels(row), ["Open", "View Listing", "Cancel renewal", "Write Review", "Stop using"]);
  assert.deepEqual(row.usage, { count: "37 uses", spent: "$1.85 spent" });
});

test("use, renewal cancelled: access to the end of the month, and renewal can be turned back on", () => {
  const install = using({ access: "subscribed", listing: listing(MONTHLY), subscription: sub({ cancelAtPeriodEnd: true }) });
  const row = installedRow(install, FMT);
  assert.deepEqual(row.line, { text: "Cancelled. You keep access until 12 Nov.", tone: "warn" });
  assert.deepEqual(labels(row), ["Open", "View Listing", "Resume renewal", "Write Review", "Stop using"]);
});

test("use, a renewal that did not go through says how much and by when", () => {
  const install = using({
    access: "subscribed",
    listing: listing(MONTHLY),
    subscription: sub({ status: "past_due", graceEndsAt: "2026-11-15T12:00:00.000Z" }),
  });
  assert.equal(
    installedRow(install, FMT).line?.text,
    "Your renewal of $9.00 did not go through. Add credits before 15 Nov to keep access.",
  );
});

test("use, a subscriber of an agent that is no longer offered keeps the month and is not renewed", () => {
  const shapes = [
    using({ access: "subscribed", listing: listing({ ...MONTHLY, status: "archived" }), subscription: sub() }),
    using({ access: "subscribed", listing: listing({ ...MONTHLY, sells: "copies" }), subscription: sub() }),
    using({ access: "subscribed", listing: listing(MONTHLY), subscription: sub({ endReason: "use_ended" }) }),
  ];
  for (const install of shapes) {
    const row = installedRow(install, FMT);
    assert.deepEqual(row.line, { text: "No longer offered. You keep access until 12 Nov.", tone: "warn" });
    assert.deepEqual(labels(row), ["Open", "View Listing", "Write Review", "Stop using"]);
  }
});

test("use, a subscriber whose agent left monthly pricing keeps the month", () => {
  const install = using({ access: "subscribed", subscription: sub() });
  const row = installedRow(install, FMT);
  assert.equal(
    row.line?.text,
    "The owner changed how this agent is sold. You keep access until 12 Nov. After that, nothing is charged until you accept the new price.",
  );
  assert.deepEqual(labels(row), ["Open", "View Listing", "Write Review", "Stop using"]);
});

test("use, a higher price: both prices, and an acceptance that names the new one", () => {
  const install = using({ access: "pricing_changed", listing: listing({ pricePerRequestCents: 8 }) });
  const row = installedRow(install, FMT);
  assert.deepEqual(row.line, {
    text: "The owner changed the price to $0.08 per message. You agreed to $0.05. Nothing is charged until you accept the new price.",
    tone: "bad",
  });
  assert.deepEqual(labels(row), ["Open", "View Listing", "Accept new price", "Write Review", "Stop using"]);
  assert.deepEqual(row.terms, { pricingModel: "per_request", pricePerRequestCents: 8, monthlyPriceCents: null });
  assert.deepEqual(installedConfirm(install, "accept_pricing", FMT), {
    title: "Accept the new price for Support Bot?",
    description:
      "Each message costs $0.08, paid from your credits. It is charged when you send it and refunded if the agent does not answer. You can stop at any time.",
    confirmLabel: "Accept $0.08 per message",
  });
});

test("use, now sold by the month: nothing is charged until you subscribe", () => {
  const install = using({ access: "pricing_changed", listing: listing(MONTHLY) });
  const row = installedRow(install, FMT);
  assert.equal(row.line?.text, "This agent is now sold by the month ($9.00). Nothing is charged until you subscribe.");
  assert.ok(labels(row).includes("Accept new price"));
  assert.deepEqual(row.terms, { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 900 });
  assert.deepEqual(installedConfirm(install, "accept_pricing", FMT), {
    title: "Subscribe to Support Bot?",
    description:
      "Charges $9.00 from your credits now and every 30 days. Cancel at any time and keep access until the month you paid for ends.",
    confirmLabel: "Subscribe for $9.00 a month",
  });
});

test("use, a subscriber's agent is now sold per message", () => {
  const install = using({
    access: "pricing_changed",
    acceptedPricing: { pricingModel: "monthly", pricePerRequestCents: null, acceptedAt: null },
    subscription: sub({ status: "expired", hasAccess: false, endReason: "pricing_changed" }),
  });
  assert.equal(
    installedRow(install, FMT).line?.text,
    "This agent is now sold per message ($0.05). Nothing is charged until you accept the new price.",
  );
});

test("use, an ended subscription: subscribe again, at the price on the row", () => {
  const install = using({
    access: "subscription_lapsed",
    listing: listing(MONTHLY),
    subscription: sub({ status: "expired", hasAccess: false }),
  });
  const row = installedRow(install, FMT);
  assert.deepEqual(row.line, { text: "Your subscription has ended. Subscribe again to keep using it.", tone: "bad" });
  assert.deepEqual(labels(row), ["Open", "View Listing", "Subscribe again", "Write Review", "Stop using"]);
  assert.equal(installedConfirm(install, "resubscribe", FMT)?.confirmLabel, "Subscribe for $9.00 a month");
});

test("use, a plan that ended: its sentence, the way to the agent's page, and nothing to accept here", () => {
  const install = using({
    access: "plan_ended",
    acceptedPricing: { pricingModel: null, pricePerRequestCents: null, acceptedAt: null },
    subscription: sub({ status: "expired", hasAccess: false }),
  });
  const row = installedRow(install, FMT);
  assert.equal(INSTALLED_WORDS.planEnded, "Your plan ended. Choose a plan or pay per use to keep using it.");
  assert.deepEqual(row.line, { text: INSTALLED_WORDS.planEnded, tone: "bad" });
  // Choosing happens on the agent's page: the row links there and offers nothing it could not do.
  assert.deepEqual(row.actions[0], { id: "open", label: "Open", href: "/a/support-bot" });
  assert.deepEqual(labels(row), ["Open", "View Listing", "Write Review", "Stop using"]);
  // The listing's price per use, never the month of the plan that is over.
  assert.equal(row.priceLabel, installedRow(using(), FMT).priceLabel);
  assert.doesNotMatch(row.priceLabel, /a month/);
  assert.equal(installedConfirm(install, "uninstall", FMT)?.description, "It leaves this list. You are not charged again.");
  // The agent left the market in between: there is nothing to choose.
  const gone = installedRow({ ...install, listing: listing({ status: "archived" }) }, FMT);
  assert.deepEqual(gone.line, { text: INSTALLED_WORDS.notOffered, tone: "bad" });
});

test("use, no longer offered: nothing to accept, nothing charged again", () => {
  for (const install of [
    using({ access: "not_offered", listing: listing({ status: "archived" }) }),
    using({ access: "not_offered", listing: listing({ sells: "copies", unit: null }) }),
    using({ access: "pricing_changed", listing: listing({ status: "archived" }) }),
    using({ access: "subscription_lapsed", listing: listing({ ...MONTHLY, sells: "copies" }) }),
  ]) {
    const row = installedRow(install, FMT);
    assert.deepEqual(row.line, { text: "No longer offered. You will not be charged again.", tone: "bad" });
    assert.deepEqual(labels(row), ["Open", "View Listing", "Write Review", "Stop using"]);
    assert.equal(installedConfirm(install, "accept_pricing", FMT), null);
    assert.equal(installedConfirm(install, "resubscribe", FMT), null);
  }
});

test("stopping a subscription says the month is not refunded, and how to keep it", () => {
  const install = using({ access: "subscribed", listing: listing(MONTHLY), subscription: sub() });
  assert.deepEqual(installedConfirm(install, "uninstall", FMT), {
    title: "Stop using Support Bot?",
    description:
      "This ends your subscription now. The month you paid for (until 12 Nov) is not refunded. To keep access until then, cancel renewal instead.",
    confirmLabel: "Stop using",
    destructive: true,
  });
  // Renewal already cancelled: there is nothing to cancel instead.
  const cancelled = using({ access: "subscribed", listing: listing(MONTHLY), subscription: sub({ cancelAtPeriodEnd: true }) });
  assert.equal(
    installedConfirm(cancelled, "uninstall", FMT)?.description,
    "This ends your access now. The month you paid for (until 12 Nov) is not refunded.",
  );
});

test("stopping while a renewal is being retried names no month that is already over", () => {
  const install = using({
    access: "subscribed",
    listing: listing(MONTHLY),
    subscription: sub({ status: "past_due", graceEndsAt: "2026-11-15T12:00:00.000Z" }),
  });
  assert.equal(
    installedConfirm(install, "uninstall", FMT)?.description,
    "This ends your subscription and your access now. You are not charged again.",
  );
});

test("use, an ended subscription to an agent that is free now: no price to accept, and the line says so", () => {
  const install = using({
    access: "pricing_changed",
    status: "suspended",
    listing: listing({ pricingModel: "free", pricePerRequestCents: null, unit: null }),
    acceptedPricing: { pricingModel: "monthly", pricePerRequestCents: null, acceptedAt: null },
    subscription: sub({ status: "expired", hasAccess: false }),
  });
  const row = installedRow(install, FMT);
  assert.deepEqual(row.line, { text: "This agent is now free to use on its page.", tone: "ok" });
  assert.deepEqual(labels(row), ["Open", "View Listing", "Write Review", "Stop using"]);
});

test("stopping a per-use or free agent never mentions a refund", () => {
  const perUse = installedConfirm(using(), "uninstall", FMT);
  assert.equal(perUse?.description, "You are not charged again. You can start using it again on its page.");
  const free = installedConfirm(
    using({ listing: listing({ pricingModel: "free", pricePerRequestCents: null, unit: null }) }),
    "uninstall",
    FMT,
  );
  assert.equal(free?.description, "It leaves this list. You can start using it again on its page.");
  const gone = installedConfirm(using({ access: "not_offered", listing: listing({ status: "archived" }) }), "uninstall", FMT);
  assert.equal(gone?.description, "It leaves this list. You are not charged again.");
});

test("dates are short and follow the time zone given", () => {
  assert.equal(shortDay("2026-11-12T12:00:00.000Z", { timeZone: "UTC" }), "12 Nov");
  assert.equal(shortDay("2026-11-12T23:30:00.000Z", { timeZone: "Europe/Berlin" }), "13 Nov");
});

// ---------------------------------------------------------------------------
// A copy: what Installed showed before use could be sold
// ---------------------------------------------------------------------------

test("copy, per request: the row Installed has always shown", () => {
  const row = installedRow(copy({ totalRequests: 1204 }), FMT);
  assert.deepEqual(row, {
    kind: "copy",
    badge: "Your copy",
    priceLabel: "$0.0500/req",
    line: null,
    openHref: "/dashboard/agents/c1",
    usage: { count: "1,204 requests", spent: "$1.85 spent" },
    actions: [
      { id: "open", label: "View Agent", href: "/dashboard/agents/c1" },
      { id: "view_listing", label: "View Listing", href: "/marketplace/support-bot", newTab: true },
      { id: "review", label: "Write Review" },
      { id: "uninstall", label: "Uninstall", destructive: true },
    ],
    terms: { pricingModel: "per_request", pricePerRequestCents: 5, monthlyPriceCents: null },
  });
});

test("copy: price badges as before", () => {
  const badge = (over: Partial<MarketplaceListing>, more: Partial<InstalledLicence> = {}) =>
    installedRow(copy({ listing: listing({ sells: "copies", unit: null, ...over }), ...more }), FMT).priceLabel;
  assert.equal(badge({ pricingModel: "free", pricePerRequestCents: null }), "Free");
  assert.equal(badge({ pricingModel: "tokenized", pricePerRequestCents: null }), "Token Gated");
  assert.equal(badge({ ...MONTHLY, unit: null }), "$9.00/mo");
  // A subscriber sees the price they agreed to, not the listing's new one.
  assert.equal(
    badge({ ...MONTHLY, unit: null, monthlyPriceCents: 1200 }, { access: "subscribed", subscription: sub() }),
    "$9.00/mo",
  );
});

test("copy, subscribed: the lines and the renewal actions as before", () => {
  const monthly = listing({ sells: "copies", ...MONTHLY, unit: null });
  const renews = installedRow(copy({ access: "subscribed", listing: monthly, subscription: sub() }), FMT);
  assert.deepEqual(renews.line, { text: "Renews Nov 12, 2026 at $9.00/mo", tone: "ok" });
  assert.deepEqual(labels(renews), ["View Agent", "View Listing", "Cancel renewal", "Write Review", "Uninstall"]);

  const cancelled = installedRow(
    copy({ access: "subscribed", listing: monthly, subscription: sub({ cancelAtPeriodEnd: true }) }),
    FMT,
  );
  assert.deepEqual(cancelled.line, { text: "Cancelled. Access ends Nov 12, 2026.", tone: "warn" });
  assert.deepEqual(labels(cancelled), ["View Agent", "View Listing", "Resume renewal", "Write Review", "Uninstall"]);

  const pastDue = installedRow(
    copy({
      access: "subscribed",
      listing: monthly,
      subscription: sub({ status: "past_due", graceEndsAt: "2026-11-15T12:00:00.000Z" }),
    }),
    FMT,
  );
  assert.equal(pastDue.line?.text, "Renewal at $9.00/mo failed: add credits before Nov 15, 2026 to keep access.");

  const unpriced = installedRow(
    copy({ access: "subscribed", listing: monthly, subscription: sub({ priceCents: null }) }),
    FMT,
  );
  assert.equal(
    unpriced.line?.text,
    "Paid until Nov 12, 2026. You will be asked to confirm the price before it renews.",
  );

  const moved = installedRow(copy({ access: "subscribed", subscription: sub() }), FMT);
  assert.equal(
    moved.line?.text,
    "The publisher changed this agent's pricing. Your subscription at $9.00/mo runs until Nov 12, 2026; after that it pauses until you accept the new pricing.",
  );
  assert.deepEqual(labels(moved), ["View Agent", "View Listing", "Write Review", "Uninstall"]);
});

test("copy, a changed price, a lapsed subscription and an unlisted agent as before", () => {
  const changed = copy({ access: "pricing_changed", listing: listing({ sells: "copies", unit: null, pricePerRequestCents: 8 }) });
  const changedRow = installedRow(changed, FMT);
  assert.deepEqual(changedRow.line, {
    text: "The publisher changed this agent's pricing (you agreed to $0.0500/req; it is now $0.0800/req). It is paused, and nothing is charged, until you accept the new pricing.",
    tone: "bad",
  });
  assert.deepEqual(labels(changedRow), ["View Agent", "View Listing", "Accept new pricing", "Write Review", "Uninstall"]);
  assert.deepEqual(installedConfirm(changed, "accept_pricing", FMT), {
    title: "Accept the new pricing for Support Bot?",
    description:
      "The publisher changed this agent's pricing to: $0.0800/req. Accepting turns your copy back on under that pricing.",
    confirmLabel: "Accept new pricing",
  });
  const toMonthly = copy({ access: "pricing_changed", listing: listing({ sells: "copies", ...MONTHLY, unit: null }) });
  assert.equal(
    installedConfirm(toMonthly, "accept_pricing", FMT)?.description,
    "The publisher now charges $9.00/mo. Accepting starts a new subscription and charges the first month from your credits now.",
  );

  const unsold = installedRow(
    copy({ access: "pricing_changed", listing: listing({ sells: "copies", unit: null, status: "archived" }) }),
    FMT,
  );
  assert.equal(unsold.line?.text, "Paused. This agent is no longer sold on the marketplace.");
  assert.deepEqual(labels(unsold), ["View Agent", "View Listing", "Write Review", "Uninstall"]);

  const lapsed = copy({ access: "subscription_lapsed", listing: listing({ sells: "copies", ...MONTHLY, unit: null }) });
  const lapsedRow = installedRow(lapsed, FMT);
  assert.deepEqual(lapsedRow.line, { text: "Subscription lapsed. Resubscribe to use this agent again.", tone: "bad" });
  assert.deepEqual(labels(lapsedRow), ["View Agent", "View Listing", "Resubscribe", "Write Review", "Uninstall"]);
  // Resubscribing a copy has never asked first.
  assert.equal(installedConfirm(lapsed, "resubscribe", FMT), null);
  assert.equal(
    installedRow(copy({ access: "subscription_lapsed", listing: listing({ sells: "copies", ...MONTHLY, unit: null, status: "archived" }) }), FMT).line?.text,
    "Subscription ended. This agent is no longer sold on the marketplace.",
  );

  assert.deepEqual(installedRow(copy({ access: "unlisted" }), FMT).line, {
    text: "No longer sold on the marketplace. Your copy keeps running at no charge.",
    tone: "ok",
  });
});

test("copy: uninstalling asks as before", () => {
  assert.deepEqual(installedConfirm(copy(), "uninstall", FMT), {
    title: "Uninstall Support Bot?",
    description: "Its copy in your workspace stops working. You can reinstall it later.",
    confirmLabel: "Uninstall",
    destructive: true,
  });
  const monthly = copy({ access: "subscribed", listing: listing({ sells: "copies", ...MONTHLY, unit: null }), subscription: sub() });
  assert.equal(
    installedConfirm(monthly, "uninstall", FMT)?.description,
    "This ends your subscription now, and the current period (paid until Nov 12, 2026) is not refunded. To keep access until the period ends, cancel renewal instead.",
  );
  const moved = copy({ access: "subscribed", subscription: sub() });
  assert.equal(
    installedConfirm(moved, "uninstall", FMT)?.description,
    "You have paid for access until Nov 12, 2026. Uninstalling gives that up without a refund, and the publisher has since changed the pricing: reinstalling would be under the new pricing ($0.0500/req).",
  );
});

test("a copy whose agent is gone has no Open, and the words are the plan's", () => {
  const row = installedRow(copy({ clonedAgentId: null }), FMT);
  assert.equal(row.openHref, null);
  assert.equal(row.actions.some((a) => a.id === "open"), false);
  assert.equal(INSTALLED_WORDS.header, "Agents you use, and copies you own.");
  assert.equal(INSTALLED_WORDS.use, "You use it");
  assert.equal(INSTALLED_WORDS.copy, "Your copy");
});
