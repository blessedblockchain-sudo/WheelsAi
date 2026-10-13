/**
 * What a listing's price card says and which button it shows. Run with:
 *   cd apps/web && npx tsx --test src/lib/listing-cta.unit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  copyPriceText,
  listingCountText,
  listingCta,
  listingInstallStats,
  plansFromCentsOf,
  plansFromLine,
  priceTextForUse,
  priceWithPlans,
  usesAgent,
  type ListingCtaInput,
  type ListingCtaInstall,
} from "./listing-cta";

type Listing = ListingCtaInput["listing"];

function listing(over: Partial<Listing> = {}): Listing {
  return {
    slug: "support-bot",
    sells: "use",
    pricingModel: "per_request",
    pricePerRequestCents: 5,
    monthlyPriceCents: null,
    unit: "message",
    agent: { handle: "support-bot" },
    ...over,
  };
}

function install(over: Partial<ListingCtaInstall> = {}): ListingCtaInstall {
  return { installed: true, kind: "use", access: "listing_pricing", clonedAgentId: null, ...over };
}

const MODELS = ["free", "per_request", "monthly", "tokenized"] as const;

function priced(model: (typeof MODELS)[number], sells: "use" | "copies"): Listing {
  return listing({
    sells,
    pricingModel: model,
    pricePerRequestCents: model === "per_request" ? 5 : null,
    monthlyPriceCents: model === "monthly" ? 900 : null,
    unit: sells === "copies" ? null : model === "per_request" ? "message" : model === "monthly" ? "month" : null,
  });
}

test("use, per message: the price, its line, the button and the line under it", () => {
  const cta = listingCta({ listing: listing(), authed: false, install: null });
  assert.equal(cta.sellsUse, true);
  assert.equal(cta.price, "$0.05");
  assert.equal(cta.priceNote, "$0.05 per message, charged as you go.");
  assert.deepEqual(cta.button, {
    type: "link",
    label: "Use this agent",
    href: "/a/support-bot",
    tone: "primary",
    icon: "play",
  });
  assert.equal(cta.footnote, "You use it on its page. You do not get a copy.");
  assert.equal(cta.status, null);
});

test("use, a task agent is priced per run", () => {
  const cta = listingCta({ listing: listing({ unit: "run", pricePerRequestCents: 10 }), authed: true, install: null });
  assert.equal(cta.priceNote, "$0.10 per run, charged as you go.");
});

test("use, monthly: charged from credits, cancel at any time", () => {
  const cta = listingCta({ listing: priced("monthly", "use"), authed: true, install: null });
  assert.equal(cta.price, "$9.00");
  assert.equal(cta.priceNote, "$9.00 a month from your credits. Cancel at any time.");
  assert.equal(cta.button?.label, "Use this agent");
});

test("use, free: says it is free to use on its page", () => {
  const cta = listingCta({ listing: priced("free", "use"), authed: false, install: null });
  assert.equal(cta.price, "Free");
  assert.equal(cta.priceIsFree, true);
  assert.equal(cta.priceNote, "Free to use on its page.");
  assert.equal(cta.button?.label, "Use this agent");
});

test("use: every pricing model, signed out or in, opens the agent's page and never installs", () => {
  for (const model of MODELS) {
    for (const authed of [false, true]) {
      for (const state of [null, install({ installed: false, kind: null, access: null })]) {
        const cta = listingCta({ listing: priced(model, "use"), authed, install: state });
        assert.ok(cta.button && cta.button.type === "link", `${model} has a link`);
        assert.equal(cta.button.href, "/a/support-bot");
        assert.equal(cta.button.label, "Use this agent");
        assert.equal(cta.status, null);
        assert.equal(cta.footnote, "You use it on its page. You do not get a copy.");
        assert.doesNotMatch(JSON.stringify(cta), /[Ii]nstall|\/dashboard\/agents\//);
      }
    }
  }
});

test("use, already in use: 'You use this agent.' with Open in place of the button", () => {
  for (const access of ["subscribed", "listing_pricing"] as const) {
    const cta = listingCta({ listing: listing(), authed: true, install: install({ access }) });
    assert.equal(cta.status, "You use this agent.");
    assert.deepEqual(cta.button, {
      type: "link",
      label: "Open",
      href: "/a/support-bot",
      tone: "success",
      icon: "check",
    });
  }
});

test("use, a licence that cannot run a use is not 'in use'", () => {
  for (const access of ["pricing_changed", "subscription_lapsed", "not_offered", "none", "uninstalled"] as const) {
    const cta = listingCta({ listing: listing(), authed: true, install: install({ access }) });
    assert.equal(cta.status, null, access);
    assert.equal(cta.button?.label, "Use this agent", access);
  }
  // Signed out: an install answer left over from an earlier session is not believed.
  assert.equal(listingCta({ listing: listing(), authed: false, install: install() }).status, null);
  assert.equal(usesAgent(null), false);
});

test("use, someone who kept a copy from before can still open it", () => {
  const cta = listingCta({
    listing: listing(),
    authed: true,
    install: install({ kind: "copy", clonedAgentId: "c1" }),
  });
  assert.equal(cta.status, null);
  assert.equal(cta.button?.label, "Use this agent");
  assert.deepEqual(cta.secondary, { label: "Open your copy", href: "/dashboard/agents/c1" });
});

test("use, an agent with no page has no button", () => {
  const cta = listingCta({ listing: listing({ agent: { handle: null } }), authed: true, install: null });
  assert.equal(cta.button, null);
});

test("copies: the price and its line are what the page has always shown", () => {
  const expected = {
    free: ["Free", null],
    per_request: ["$0.0500 per request", "Pay only for what you use"],
    monthly: ["$9.00/month", "Billed monthly"],
    tokenized: ["Token Gated", "Free until this agent's token launches, then for token holders"],
  } as const;
  for (const model of MODELS) {
    const cta = listingCta({ listing: priced(model, "copies"), authed: false, install: null });
    assert.equal(cta.sellsUse, false);
    assert.equal(cta.price, expected[model][0]);
    assert.equal(cta.priceNote, expected[model][1]);
    assert.equal(cta.priceIsFree, model === "free");
    assert.equal(cta.status, null);
    assert.equal(cta.secondary, null);
  }
});

test("copies, signed out: sign in to install, for every pricing model", () => {
  for (const model of MODELS) {
    const cta = listingCta({ listing: priced(model, "copies"), authed: false, install: null });
    assert.deepEqual(cta.button, {
      type: "link",
      label: "Sign in to install",
      href: "/login?next=/marketplace/support-bot",
      tone: "primary",
      icon: "play",
    });
    assert.equal(cta.footnote, "Sign in to install this agent to your account.");
  }
});

test("copies, signed in and not installed: the install button and its line", () => {
  const none = install({ installed: false, kind: null, access: null });
  const free = listingCta({ listing: priced("free", "copies"), authed: true, install: none });
  assert.deepEqual(free.button, { type: "install", label: "Install Agent", disabled: false });
  assert.equal(free.footnote, "Installs a private copy of this agent into your workspace.");

  const perRequest = listingCta({ listing: priced("per_request", "copies"), authed: true, install: none });
  assert.deepEqual(perRequest.button, { type: "install", label: "Install Agent", disabled: false });

  const monthly = listingCta({ listing: priced("monthly", "copies"), authed: true, install: none });
  assert.deepEqual(monthly.button, { type: "install", label: "Subscribe · $9.00/month", disabled: false });
  assert.equal(
    monthly.footnote,
    "Charges $9.00 from your credits now and every 30 days. Cancel anytime from Installed.",
  );

  const token = listingCta({ listing: priced("tokenized", "copies"), authed: true, install: none, tokenSymbol: "BOT" });
  assert.equal(token.footnote, "Requires at least 1 BOT in a wallet linked to your organization.");
  const noToken = listingCta({ listing: priced("tokenized", "copies"), authed: true, install: none });
  assert.equal(noToken.footnote, "Installs a private copy of this agent into your workspace.");
});

test("copies: the button waits for the install answer and while a request is sent", () => {
  const loading = listingCta({ listing: priced("free", "copies"), authed: true, install: null });
  assert.deepEqual(loading.button, { type: "install", label: "Install Agent", disabled: true });
  const none = install({ installed: false, kind: null, access: null });
  const sending = listingCta({ listing: priced("free", "copies"), authed: true, install: none, installing: true });
  assert.deepEqual(sending.button, { type: "install", label: "Installing…", disabled: true });
  const subscribing = listingCta({
    listing: priced("monthly", "copies"),
    authed: true,
    install: none,
    installing: true,
  });
  assert.deepEqual(subscribing.button, { type: "install", label: "Subscribing…", disabled: true });
});

test("copies, installed: opens the copy, or Installed when the copy is not known", () => {
  for (const model of MODELS) {
    const cta = listingCta({
      listing: priced(model, "copies"),
      authed: true,
      install: install({ kind: "copy", clonedAgentId: "c1" }),
    });
    assert.deepEqual(cta.button, {
      type: "link",
      label: "Installed — Open in Dashboard",
      href: "/dashboard/agents/c1",
      tone: "success",
      icon: "check",
    });
    assert.equal(cta.footnote, "Installed as a private copy in your workspace.");
  }
  const unknown = listingCta({
    listing: priced("free", "copies"),
    authed: true,
    install: install({ kind: "copy", clonedAgentId: null }),
  });
  assert.equal(unknown.button?.type === "link" && unknown.button.href, "/dashboard/marketplace/installs");
});

test("copies, while the organization still uses the agent: not called installed, and told to stop using first", () => {
  // The listing sold use, the organization started, and the listing went back to copies.
  const cta = listingCta({
    listing: priced("per_request", "copies"),
    authed: true,
    install: install({ kind: "use", clonedAgentId: null, access: "not_offered" }),
  });
  assert.equal(cta.status, "You use this agent.");
  assert.deepEqual(cta.button, {
    type: "link",
    label: "Open Installed",
    href: "/dashboard/marketplace/installs",
    tone: "primary",
    icon: "play",
  });
  assert.equal(cta.footnote, "You already use this agent on its page. Stop using it before you install a copy.");
  assert.doesNotMatch(JSON.stringify(cta), /private copy|Installed —/);
});

test("prices with their unit, for a card", () => {
  assert.equal(priceTextForUse(priced("per_request", "use")), "$0.05 per message");
  assert.equal(priceTextForUse(listing({ unit: "run" })), "$0.05 per run");
  assert.equal(priceTextForUse(listing({ unit: null })), "$0.05 per use");
  assert.equal(priceTextForUse(priced("monthly", "use")), "$9.00 a month");
  assert.equal(priceTextForUse(priced("free", "use")), "Free");
  assert.equal(copyPriceText(priced("per_request", "copies")), "$0.0500 per request");
});

test("the count: installs for copies, the people using it now for use", () => {
  const counts = { totalInstalls: 1204, activeInstalls: 37 };
  assert.equal(listingCountText({ sells: "copies", ...counts }, "en-US"), "1,204 installs");
  assert.equal(listingCountText({ sells: "use", ...counts }, "en-US"), "37 using it");
  assert.deepEqual(listingInstallStats({ sells: "copies", ...counts }, "en-US"), [
    { key: "installs", label: "Total Installs", value: "1,204" },
    { key: "active", label: "Active Users", value: "37" },
  ]);
  assert.deepEqual(listingInstallStats({ sells: "use", ...counts }, "en-US"), [
    { key: "using", label: "People using it", value: "37" },
  ]);
});

// ============================================
// A listing that offers plans
// ============================================

const STARTER = { id: "p1", name: "Starter", priceCents: 900, includedUses: 500, extraUsePriceCents: 4 };
const PRO = { id: "p3", name: "Pro", priceCents: 2900, includedUses: 2000, extraUsePriceCents: null };

test("the smallest plan price: said by the search, or measured from the plans a read carries", () => {
  assert.equal(plansFromCentsOf({ plansFromCents: 900 }), 900);
  assert.equal(plansFromCentsOf({ plans: [PRO, STARTER] }), 900);
  // What the search said wins over a list beside it.
  assert.equal(plansFromCentsOf({ plansFromCents: 500, plans: [PRO] }), 500);
  // No plans, and a read that did not say.
  assert.equal(plansFromCentsOf({ plansFromCents: null }), null);
  assert.equal(plansFromCentsOf({ plans: [] }), null);
  assert.equal(plansFromCentsOf({}), null);
  assert.equal(plansFromCentsOf({ plansFromCents: 0 }), null);
  assert.equal(plansFromCentsOf({ plansFromCents: Number.NaN, plans: [STARTER] }), 900);
});

test("a card of the featured row says its plans as a card of the search does", () => {
  // The featured row sends what the search sends: the smallest plan price, and no list of plans.
  const featured = listing({ plansFromCents: 900 });
  assert.equal(featured.plans, undefined);
  assert.deepEqual(priceWithPlans(featured), {
    from: "From $0.05 a message",
    plans: "Plans from $9.00 for 30 days.",
    line: "From $0.05 a message. Plans from $9.00 for 30 days.",
  });
  // A featured listing with no plans is the card it was.
  assert.equal(priceWithPlans(listing({ plansFromCents: null })), null);
  assert.equal(priceWithPlans(listing()), null);
});

test("the marketplace draws the featured row with the card of the search, plans line included", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const page = readFileSync(join(here, "..", "app/marketplace/page.tsx"), "utf8");
  // One card for both rows, and it takes the plans line from this file.
  assert.match(page, /const withPlans = priceWithPlans\(listing\);/);
  assert.match(page, /\{withPlans && <p [^>]*>\{withPlans\.plans\}<\/p>\}/);
  const row = page.slice(page.indexOf("{featuredListings.map((listing) => ("), page.indexOf("Trending Tokens Section"));
  assert.match(row, /<AgentCard\s+key=\{listing\.id\}\s+listing=\{listing\}/);
  assert.equal(page.split("function AgentCard(").length, 2);
  // The page writes no sentence about plans of its own.
  assert.equal(/Plans from|for 30 days/.test(page), false);
});

test("use with plans: 'From $0.05 a message. Plans from $9.00 for 30 days.'", () => {
  assert.equal(plansFromLine(900), "Plans from $9.00 for 30 days.");
  assert.deepEqual(priceWithPlans(listing({ plans: [STARTER, PRO] })), {
    from: "From $0.05 a message",
    plans: "Plans from $9.00 for 30 days.",
    line: "From $0.05 a message. Plans from $9.00 for 30 days.",
  });
  // A card reads it from the search.
  assert.equal(priceWithPlans(listing({ plansFromCents: 900, unit: "run" }))?.line, "From $0.05 a run. Plans from $9.00 for 30 days.");

  const cta = listingCta({ listing: listing({ plans: [STARTER, PRO] }), authed: false, install: null });
  assert.equal(cta.price, "$0.05");
  assert.equal(cta.priceNote, "From $0.05 a message. Plans from $9.00 for 30 days.");
  // Nothing else on the card changes: it still opens the agent's page, where a plan is chosen.
  const plain = listingCta({ listing: listing(), authed: false, install: null });
  assert.deepEqual({ ...cta, priceNote: null }, { ...plain, priceNote: null });
});

test("a listing with no plans reads exactly as before plans existed", () => {
  const before = listingCta({ listing: listing(), authed: false, install: null });
  assert.equal(before.priceNote, "$0.05 per message, charged as you go.");
  for (const none of [{ plans: [] }, { plansFromCents: null }, { plans: undefined }]) {
    assert.equal(priceWithPlans(listing(none)), null);
    assert.deepEqual(listingCta({ listing: listing(none), authed: false, install: null }), before);
  }
});

test("plans are said only for use sold per request", () => {
  // Copies have no plans, and neither has a month or a free listing, whatever an answer carries.
  for (const model of MODELS) {
    assert.equal(priceWithPlans({ ...priced(model, "copies"), plansFromCents: 900 }), null, model);
    if (model !== "per_request") assert.equal(priceWithPlans({ ...priced(model, "use"), plansFromCents: 900 }), null, model);
  }
  const copies = { listing: priced("per_request", "copies"), authed: false, install: null };
  assert.deepEqual(listingCta({ ...copies, listing: { ...copies.listing, plansFromCents: 900 } }), listingCta(copies));
});

test("the words of plans on the marketplace never say what a buyer is not told", () => {
  const said = priceWithPlans(listing({ plans: [STARTER, PRO] }))!;
  for (const sentence of [said.from, said.plans, said.line]) {
    assert.equal(/[\u2013\u2014]/.test(sentence), false, sentence);
    assert.doesNotMatch(sentence, /unlimited|trial|subscriber|people|token|organization/i, sentence);
  }
});
