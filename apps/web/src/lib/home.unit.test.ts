/**
 * What Home says. Run with:
 *   cd apps/web && npx tsx --test src/lib/home.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { BillingRails } from "./api";
import {
  HOME_BUILD_MORE,
  accountSteps,
  agentLinks,
  canAddCredits,
  cutOffByLeaving,
  fundingDetail,
  newestAgents,
  nextSteps,
} from "./home";
import { buildNav } from "./nav";

function rails(over: Partial<BillingRails> = {}): BillingRails {
  return {
    stripeCheckout: false,
    mockCheckout: false,
    wallet: false,
    walletAssets: [],
    network: "devnet",
    ...over,
  };
}

const CREATE = "/dashboard/agents/new";
const chat = { id: "a1", agentKind: "conversation", createdAt: "2026-10-01T00:00:00Z" };
const task = { id: "a2", agentKind: "task", createdAt: "2026-10-05T00:00:00Z" };
const scheduled = { id: "a3", agentKind: "scheduled", createdAt: "2026-10-03T00:00:00Z" };

function summary(steps: ReturnType<typeof nextSteps>) {
  return steps.map((step) => [step.id, step.done, step.href]);
}

test("with no agent, the four steps are not done and all open the create screen", () => {
  assert.deepEqual(summary(nextSteps({ agents: [] })), [
    ["create", false, CREATE],
    ["try", false, CREATE],
    ["share", false, CREATE],
    ["earn", false, CREATE],
  ]);
  // A listing or a link read for nobody's agent ticks nothing.
  const steps = nextSteps({ agents: [], used: true, linkState: "on", listings: [{ status: "published" }] });
  assert.deepEqual(steps.map((step) => step.done), [false, false, false, false]);
});

test("with one agent, Create is done and the others link to its tabs", () => {
  assert.deepEqual(summary(nextSteps({ agents: [chat], used: false, linkState: "off", listings: [] })), [
    ["create", true, CREATE],
    ["try", false, "/dashboard/agents/a1?tab=chat"],
    ["share", false, "/dashboard/agents/a1?tab=share"],
    ["earn", false, "/dashboard/agents/a1?tab=sell"],
  ]);
});

test("a first use ticks Try; an unknown one does not", () => {
  const done = (used: boolean | null | undefined) => nextSteps({ agents: [chat], used })[1]!.done;
  assert.equal(done(true), true);
  assert.equal(done(false), false);
  assert.equal(done(null), false);
  assert.equal(done(undefined), false);
});

test("a link that is on ticks Share and not Earn", () => {
  const steps = nextSteps({ agents: [chat], used: true, linkState: "on", listings: [] });
  assert.deepEqual(steps.map((step) => step.done), [true, true, true, false]);
  for (const state of ["off", "paused", "view_only", null]) {
    assert.equal(nextSteps({ agents: [chat], linkState: state })[2]!.done, false, String(state));
  }
});

test("an agent on sale ticks Share and Earn; a draft listing ticks neither", () => {
  const onSale = nextSteps({ agents: [chat], linkState: "off", listings: [{ agentId: "a1", status: "published" }] });
  assert.deepEqual(onSale.map((step) => step.done), [true, false, true, true]);
  const draft = nextSteps({ agents: [chat], linkState: "off", listings: [{ agentId: "a1", status: "draft" }] });
  assert.deepEqual(draft.map((step) => step.done), [true, false, false, false]);
  // Listings that could not be read promise nothing.
  assert.equal(nextSteps({ agents: [chat], listings: null })[3]!.done, false);
});

test("the steps link to the newest agent, whatever order the list came in", () => {
  const steps = nextSteps({ agents: [chat, scheduled, task] });
  assert.equal(steps[1]!.href, "/dashboard/agents/a2?tab=run");
  assert.equal(steps[2]!.href, "/dashboard/agents/a2?tab=share");
  assert.equal(steps[3]!.href, "/dashboard/agents/a2?tab=sell");
  assert.deepEqual(newestAgents([chat, scheduled, task]).map((agent) => agent.id), ["a2", "a3", "a1"]);
  assert.deepEqual(newestAgents([chat, scheduled, task], 2).map((agent) => agent.id), ["a2", "a3"]);
  // With no dates, the order the server gave is kept (it sends the newest first).
  assert.deepEqual(newestAgents([{ id: "x" }, { id: "y" }]).map((agent) => agent.id), ["x", "y"]);
});

test("the links of a row are the kind's first tab, Share and Sell", () => {
  assert.deepEqual(agentLinks(chat).first, { label: "Chat", href: "/dashboard/agents/a1?tab=chat" });
  assert.deepEqual(agentLinks(task).first, { label: "Run", href: "/dashboard/agents/a2?tab=run" });
  assert.deepEqual(agentLinks(scheduled).first, { label: "Runs", href: "/dashboard/agents/a3?tab=runs" });
  assert.deepEqual(agentLinks(task).share, { label: "Share", href: "/dashboard/agents/a2?tab=share" });
  assert.deepEqual(agentLinks(task).sell, { label: "Sell", href: "/dashboard/agents/a2?tab=sell" });
  // An agent from before kinds existed, or of a kind this build does not know, is a chat.
  assert.equal(agentLinks({ id: "old" }).first.href, "/dashboard/agents/old?tab=chat");
  assert.equal(agentLinks({ id: "new", agentKind: "something-new" }).first.label, "Chat");
});

test("Try says where to try each kind", () => {
  assert.match(nextSteps({ agents: [chat] })[1]!.detail, /Chat tab/);
  assert.match(nextSteps({ agents: [task] })[1]!.detail, /Run tab/);
  assert.match(nextSteps({ agents: [scheduled] })[1]!.detail, /Runs tab/);
});

test("verify your email is a thing to do only when a link can be sent", () => {
  const base = { hasEmail: true, emailVerified: false, emailDelivery: true, rails: null, creditCents: 0 };
  assert.deepEqual(accountSteps(base).map((step) => step.id), ["verify"]);
  assert.equal(accountSteps(base)[0]!.href, "/dashboard/settings");
  // Email cannot be sent, or the capabilities could not be read.
  assert.deepEqual(accountSteps({ ...base, emailDelivery: false }), []);
  assert.deepEqual(accountSteps({ ...base, emailDelivery: null }), []);
  // Already verified, not yet known, or an account with no email address.
  assert.deepEqual(accountSteps({ ...base, emailVerified: true }), []);
  assert.deepEqual(accountSteps({ ...base, emailVerified: null }), []);
  assert.deepEqual(accountSteps({ ...base, hasEmail: false }), []);
});

test("fund your account names only the ways of paying that are live", () => {
  assert.equal(fundingDetail(rails({ stripeCheckout: true })), "Add credits by card.");
  assert.equal(
    fundingDetail(rails({ wallet: true, walletAssets: ["SOL", "USDC"] })),
    "Add credits from a wallet, in SOL or USDC.",
  );
  assert.equal(
    fundingDetail(rails({ stripeCheckout: true, wallet: true, walletAssets: ["USDC"] })),
    "Add credits by card, or from a wallet, in USDC.",
  );
  // A wallet rail with nothing to pay in is not a way to pay.
  assert.equal(fundingDetail(rails({ wallet: true })), null);
  assert.equal(fundingDetail(rails({ proSubscription: true })), null);
});

test("with no live way to pay, or rails that could not be read, nobody is sent to pay", () => {
  const base = { hasEmail: true, emailVerified: true, emailDelivery: true, creditCents: 0 };
  assert.deepEqual(accountSteps({ ...base, rails: rails() }), []);
  assert.deepEqual(accountSteps({ ...base, rails: null }), []);
  assert.equal(canAddCredits(rails()), false);
  assert.equal(canAddCredits(null), false);
  assert.equal(canAddCredits(undefined), false);
  assert.equal(canAddCredits(rails({ mockCheckout: true })), true);

  const [fund] = accountSteps({ ...base, rails: rails({ stripeCheckout: true }) });
  assert.deepEqual([fund?.id, fund?.done, fund?.href], ["fund", false, "/dashboard/billing"]);
  assert.equal(accountSteps({ ...base, rails: rails({ stripeCheckout: true }), creditCents: 500 })[0]!.done, true);
});

test("the other things to build open where the menu's Workflows and Models items open", () => {
  assert.deepEqual(
    HOME_BUILD_MORE.map((entry) => [entry.title, entry.primary.href]),
    [
      ["Build a workflow", "/dashboard/orchestrations"],
      ["Deploy or fine-tune a model", "/dashboard/models"],
    ],
  );
  const menu = buildNav({ tokenUi: false }).flatMap((group) => group.items);
  assert.equal(HOME_BUILD_MORE[0]!.primary.href, menu.find((item) => item.id === "workflows")?.href);
  assert.equal(HOME_BUILD_MORE[1]!.primary.href, menu.find((item) => item.id === "models")?.href);
  assert.match(HOME_BUILD_MORE[1]!.second, /Nosana GPUs, billed per second/);
  assert.match(HOME_BUILD_MORE[1]!.second, /OpenAI-compatible API/);
});

test("a request dropped while leaving is not a failure; an answer from the server is", () => {
  assert.equal(cutOffByLeaving(new TypeError("Failed to fetch"), true), true);
  assert.equal(cutOffByLeaving(new TypeError("Failed to fetch"), false), false);
  assert.equal(cutOffByLeaving({ status: 500 }, true), false);
  assert.equal(cutOffByLeaving({ status: 500 }, false), false);
});
