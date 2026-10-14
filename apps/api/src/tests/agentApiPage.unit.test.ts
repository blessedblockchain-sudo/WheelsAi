import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { createPublicAgentRoutes, type PublicAgentDetail } from "../routes/publicAgent.js";
import { AGENT_API_REFUSALS, agentApiPageOf, type AgentApiX402Cluster } from "../services/agentApiPage.js";
import { PAID_USE_LIMITS, PAID_USE_MESSAGES } from "../services/paidUse.js";
import { PAID_USE_PER_BUYER_PER_DAY, PAID_USE_PER_BUYER_PER_MINUTE } from "../services/publicPageState.js";
import { PLAN_USAGE_HEADER_NAMES, USAGE_HEADER_NAMES } from "../services/usageHeaders.js";
import { useDecision } from "../services/useAccess.js";
import { X402_ANSWER_DEADLINE_MS } from "../services/x402DoorRules.js";

// GET /a/:handle/api (routes/publicAgent.ts) and services/agentApiPage.ts:
// what the API page of a listing draws, for anybody, signed in or not.

const PLANS = [
  { id: "plan_starter", name: "Starter", priceCents: 900n, includedUses: 500, extraUsePriceCents: 4n },
  { id: "plan_team", name: "Team", priceCents: 2_900n, includedUses: 2_000, extraUsePriceCents: null },
];

/**
 * The agent's public page as a loader hands it over, with everything a
 * careless loader could carry beside it: none of it may reach the API page.
 */
function page(
  paid: Record<string, unknown> | null = {},
  over: { agentKind?: string; state?: string } = {},
): PublicAgentDetail {
  return {
    agent: {
      name: "Eliza",
      slug: "eliza-internal-slug",
      framework: "elizaos",
      createdAt: new Date("2026-04-20T00:00:00Z"),
      description: "Talks through anything you bring.",
      handle: "eliza",
      agentKind: over.agentKind ?? "conversation",
      orgId: "ORG_NEVER_SHOWN",
      systemPrompt: "PROMPT_NEVER_SHOWN",
      modelConfig: { model: "MODEL_NEVER_SHOWN", maxTokens: 91919 },
    },
    use: {
      state: over.state ?? "paid",
      key: "pk_NEVER_SHOWN",
      transcriptsStored: true,
      paid:
        paid === null
          ? null
          : {
              listingId: "listing_use",
              listingSlug: "eliza-for-hire",
              pricingModel: "per_request",
              priceCents: 5n,
              unit: "message",
              perMinute: PAID_USE_PER_BUYER_PER_MINUTE,
              perDay: PAID_USE_PER_BUYER_PER_DAY,
              transcriptsStored: true,
              sendsRequests: true,
              plans: PLANS.map((plan) => ({ ...plan, subscribers: 73737, status: "active", position: 1 })),
              publisherId: "PUBLISHER_NEVER_SHOWN",
              publisherName: "Creator Org Ltd",
              buyers: 71717,
              activeInstalls: 81818,
              totalTokens: 61616,
              ...paid,
            },
      chat: { maxMessages: 20, maxMessageChars: 4000, maxTotalChars: 16000 },
    },
    treasury: { address: "PDA111", balanceLamports: 1n, cumulativeComputePaidLamports: 2n },
    uptime: { totalComputeSeconds: 5_400n, totalRequests: 51515 },
    eligibility: { eligible: true },
    deployments: [{ gpuTier: "4090", replicas: 2, status: "running" }],
    channels: [],
    recentPayments: [],
  } as unknown as PublicAgentDetail;
}

async function makeApp(
  detail: PublicAgentDetail | null,
  publicApiUrl?: string | null,
  x402Door?: () => AgentApiX402Cluster | null,
) {
  const asked: string[] = [];
  const app = Fastify();
  await app.register(
    createPublicAgentRoutes({
      loadPublicAgent: async (handle) => {
        asked.push(handle);
        return detail;
      },
      publicApiUrl,
      ...(x402Door && { x402Door }),
    }),
  );
  return { app, asked };
}

/** What must never be in the answer, whatever the loader carried. */
const NEVER = [
  "NEVER_SHOWN",
  "Creator Org",
  "publisher",
  "orgId",
  "token",
  "elizaos",
  "eliza-internal-slug",
  "71717",
  "81818",
  "73737",
  "61616",
  "51515",
  "91919",
  "subscribers",
  "buyers",
  "installs",
  "treasury",
  "PDA111",
];

function assertNothingLeaks(body: string) {
  // The one place the word "model" belongs is the name of the field that
  // carries the model id a/<handle>, and the pricing model.
  const text = body.replaceAll('"model":', "").replaceAll('"pricingModel":', "");
  assert.equal(/model/i.test(text), false, "the answer names a model");
  for (const never of NEVER) {
    assert.equal(body.toLowerCase().includes(never.toLowerCase()), false, `the answer carries ${never}`);
  }
}

test("a listing with plans: the address, the model id, the price per use, the plans, the limits, the headers and the refusals", async () => {
  const { app, asked } = await makeApp(page(), "https://api.example.test/");
  const res = await app.inject({ method: "GET", url: "/a/eliza/api" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(asked, ["eliza"]);
  const body = res.json();
  assert.deepEqual(
    { ...body, refusals: undefined },
    {
      handle: "eliza",
      name: "Eliza",
      agentKind: "conversation",
      listingId: "listing_use",
      listingSlug: "eliza-for-hire",
      baseUrl: "https://api.example.test",
      model: "a/eliza",
      endpoints: [
        { use: "openai", method: "POST", path: "/v1/chat/completions" },
        { use: "chat", method: "POST", path: "/api/a/eliza/chat" },
        { use: "access", method: "GET", path: "/api/a/eliza/access" },
      ],
      pricingModel: "per_request",
      unit: "message",
      priceCents: 5,
      plans: [
        { id: "plan_starter", name: "Starter", priceCents: 900, includedUses: 500, extraUsePriceCents: 4 },
        { id: "plan_team", name: "Team", priceCents: 2900, includedUses: 2000, extraUsePriceCents: null },
      ],
      // This listing offers no free trial (tests/trialReads.unit.test.ts has one that does).
      trial: null,
      limits: { perMinute: 10, perDayWithoutPlan: 200 },
      usageHeaders: {
        always: ["x-wheelsai-charged-cents", "x-wheelsai-balance-cents"],
        onPlan: [
          "x-wheelsai-plan",
          "x-wheelsai-plan-limit",
          "x-wheelsai-plan-used",
          "x-wheelsai-plan-remaining",
          "x-wheelsai-plan-reset",
          "x-wheelsai-plan-warning",
        ],
      },
      refusals: undefined,
      // Paying from a wallet is not usable: this server was given no door.
      x402: null,
    },
  );
  assert.deepEqual(
    body.refusals.map((r: { code: string; status: number }) => [r.code, r.status]),
    [
      ["use_not_started", 403],
      ["pricing_changed", 409],
      ["plan_ended", 402],
      ["plan_used_up", 429],
      ["insufficient_credits", 402],
      ["api_key_use_price_cap_exceeded", 403],
      ["api_key_daily_cap_exceeded", 403],
      ["rate_limited", 429],
      ["agent_paused", 503],
    ],
  );
  assertNothingLeaks(res.body);
  await app.close();
});

test("a listing with no plan: the same page with an empty list of plans", async () => {
  const { app } = await makeApp(page({ plans: [] }));
  const res = await app.inject({ method: "GET", url: "/a/eliza/api" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.plans, []);
  assert.equal(body.priceCents, 5);
  assert.equal(body.model, "a/eliza");
  // No public address was given: the page uses the one it reached the API at.
  assert.equal(body.baseUrl, null);
  // A plan can still be met by somebody who is on one that was ended.
  assert.deepEqual(body.usageHeaders.onPlan, [...PLAN_USAGE_HEADER_NAMES]);
  assertNothingLeaks(res.body);
  await app.close();
});

test("a listing sold by the month: the price is for a month of access, with no plans, no plan headers and no refusal about a plan or a charge per use", async () => {
  // A loader that carried plans beside a monthly price: none is offered.
  const { app } = await makeApp(page({ pricingModel: "monthly", priceCents: 1_500n, unit: "month" }));
  const res = await app.inject({ method: "GET", url: "/a/eliza/api" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.pricingModel, "monthly");
  assert.equal(body.unit, "month");
  assert.equal(body.priceCents, 1500);
  assert.deepEqual(body.plans, []);
  assert.deepEqual(body.limits, { perMinute: 10, perDayWithoutPlan: 200 });
  assert.deepEqual(body.usageHeaders, {
    always: ["x-wheelsai-charged-cents", "x-wheelsai-balance-cents"],
    onPlan: [],
  });
  assert.deepEqual(
    body.refusals.map((r: { code: string; status: number }) => [r.code, r.status]),
    [
      ["use_not_started", 403],
      ["pricing_changed", 409],
      ["subscription_lapsed", 402],
      ["rate_limited", 429],
      ["agent_paused", 503],
    ],
  );
  // It is still called the same way.
  assert.equal(body.model, "a/eliza");
  assertNothingLeaks(res.body);
  await app.close();
});

test("a task is run from its form's answers: no model id and no OpenAI address", async () => {
  const { app } = await makeApp(page({ unit: "run" }, { agentKind: "task" }));
  const res = await app.inject({ method: "GET", url: "/a/eliza/api" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.model, null);
  assert.equal(body.unit, "run");
  assert.deepEqual(body.endpoints, [
    { use: "run", method: "POST", path: "/api/a/eliza/run" },
    { use: "access", method: "GET", path: "/api/a/eliza/access" },
  ]);
  assert.equal(res.body.includes("/v1/"), false);
  await app.close();
});

test("404 for an unknown handle, exactly as the public agent read answers it", async () => {
  const { app } = await makeApp(null);
  const api = await app.inject({ method: "GET", url: "/a/missing/api" });
  const read = await app.inject({ method: "GET", url: "/a/missing" });
  assert.equal(api.statusCode, 404);
  assert.equal(api.statusCode, read.statusCode);
  assert.deepEqual(api.json(), read.json());
  await app.close();
});

test("404 for a listing that is not published, and for an agent whose use is not sold at a price", async () => {
  // A listing that is not published, or sells copies, or is free, gives the
  // page no terms: its state is whatever the public link says.
  for (const state of ["on", "paused", "view_only"]) {
    const { app } = await makeApp(page(null, { state }));
    const res = await app.inject({ method: "GET", url: "/a/eliza/api" });
    assert.equal(res.statusCode, 404, state);
    assert.deepEqual(res.json(), { error: "agent_not_found" });
    // The page itself is there: only the API page is not.
    assert.equal((await app.inject({ method: "GET", url: "/a/eliza" })).statusCode, 200);
    await app.close();
  }
  // Terms left on a page that is not in the paid state are not a sale.
  for (const state of ["on", "view_only"]) {
    const { app } = await makeApp(page({}, { state }));
    assert.equal((await app.inject({ method: "GET", url: "/a/eliza/api" })).statusCode, 404, state);
    await app.close();
  }
  // The paid state with no terms.
  const { app } = await makeApp(page(null));
  assert.equal((await app.inject({ method: "GET", url: "/a/eliza/api" })).statusCode, 404);
  await app.close();
});

test("404 for a self-running agent: it sells results read on its page, and answers no call", async () => {
  const { app } = await makeApp(page({ pricingModel: "monthly", priceCents: 1_500n, unit: "month" }, { agentKind: "scheduled" }));
  assert.equal((await app.inject({ method: "GET", url: "/a/eliza/api" })).statusCode, 404);
  await app.close();
});

test("no sign-in is asked for, and the base address is told only when it is one", async () => {
  assert.equal(agentApiPageOf(page(), { publicApiUrl: "https://api.example.test///" })?.baseUrl, "https://api.example.test");
  assert.equal(agentApiPageOf(page(), { publicApiUrl: "http://localhost:4000" })?.baseUrl, "http://localhost:4000");
  for (const notOne of ["", "   ", "api.example.test", "javascript:alert(1)", null, undefined]) {
    assert.equal(agentApiPageOf(page(), { publicApiUrl: notOne })?.baseUrl, null, String(notOne));
  }
  const { app } = await makeApp(page());
  const res = await app.inject({ method: "GET", url: "/a/eliza/api" });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test("a handle is written into a path as one segment", () => {
  const odd = page();
  (odd.agent as { handle: string }).handle = "a b/c";
  const built = agentApiPageOf(odd)!;
  assert.equal(built.endpoints[1]!.path, "/api/a/a%20b%2Fc/chat");
});

test("the refusals: the statuses the code answers with, one plain sentence each", () => {
  const listing = { pricingModel: "per_request", pricePerRequestCents: 5n };
  const statusOf = (code: string) => AGENT_API_REFUSALS.find((r) => r.code === code)!.status;
  for (const access of ["none", "pricing_changed", "subscription_lapsed", "plan_ended"] as const) {
    const decision = useDecision(access, listing);
    assert.equal(decision.runs, false);
    if (!decision.runs) assert.equal(statusOf(decision.code), decision.status, decision.code);
  }
  assert.equal(AGENT_API_REFUSALS.find((r) => r.code === "agent_paused")!.message, PAID_USE_MESSAGES.paused);
  assert.equal(new Set(AGENT_API_REFUSALS.map((r) => r.code)).size, AGENT_API_REFUSALS.length);
  for (const refusal of AGENT_API_REFUSALS) {
    assert.ok(refusal.message.endsWith("."), refusal.code);
    // Plain words: no dash, no code inside a sentence, nothing of tokens or the model.
    assert.doesNotMatch(refusal.message, /[\u2013\u2014]/, refusal.code);
    assert.doesNotMatch(refusal.message, /_|token|model|unlimited/i, refusal.code);
  }
});

test("the header names are the ones a paid answer carries", () => {
  const built = agentApiPageOf(page())!;
  assert.deepEqual([...built.usageHeaders.always, ...built.usageHeaders.onPlan], [...USAGE_HEADER_NAMES]);
});

test("the free trial on offer is told beside the plans, as its id, its uses and its days; null with none, and for a listing sold by the month", async () => {
  const TRIAL = { id: "plan_trial", includedUses: 20, name: "Free trial", status: "active", position: 0, subscribers: 73737 };
  const offered = await makeApp(page({ trial: TRIAL }));
  const res = await offered.app.inject({ method: "GET", url: "/a/eliza/api" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().trial, { id: "plan_trial", includedUses: 20, days: 7 });
  // The paid plans are exactly what they are without a trial.
  const plain = await makeApp(page());
  const plainBody = (await plain.app.inject({ method: "GET", url: "/a/eliza/api" })).json();
  assert.equal(plainBody.trial, null);
  assert.deepEqual(res.json().plans, plainBody.plans);
  assertNothingLeaks(res.body);
  await offered.app.close();
  await plain.app.close();

  // A loader that carried a trial beside a monthly price: none is offered.
  const monthly = await makeApp(page({ pricingModel: "monthly", priceCents: 1_500n, unit: "month", trial: TRIAL }));
  assert.equal((await monthly.app.inject({ method: "GET", url: "/a/eliza/api" })).json().trial, null);
  await monthly.app.close();
});

// ============================================
// Paying from a wallet, with no key (the x402 door)
// ============================================

/** Devnet as the door's 402 names it: the CAIP-2 id and the USDC mint of the cluster. */
const DEVNET: AgentApiX402Cluster = {
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};
const doorOpen = () => DEVNET;

/** What the loader reads for the door's serve test: a listing it serves, unless told otherwise. */
function withDoor(listing: Record<string, unknown> = {}, agent: Record<string, unknown> = {}) {
  return {
    x402Door: {
      listing: {
        agentId: "agent_1",
        orchestrationId: null,
        status: "published",
        sells: "use",
        pricingModel: "per_request",
        pricePerRequestCents: 5n,
        x402Enabled: true,
        ...listing,
      },
      agent: { isPublic: true, agentKind: "conversation", entrypoint: "chat", ...agent },
    },
  };
}

/** What the switch and the door's reads must never show, as they are. */
const DOOR_NEVER = ["x402Enabled", "x402Door", "entrypoint", "orchestrationId", "isPublic", "agent_1"];

test("paying from a wallet: told field by field while the door is usable and serves the listing, beside the same page", async () => {
  const { app } = await makeApp(page(withDoor()), "https://api.example.test", doorOpen);
  const res = await app.inject({ method: "GET", url: "/a/eliza/api" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.x402, {
    priceCents: 5,
    unit: "message",
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    answerWithinSeconds: 30,
    limits: { walletPerMinute: 10, walletPerDay: 200, addressPerMinute: 10 },
  });
  // The numbers are the door's own constants, never a second set.
  assert.equal(body.x402.answerWithinSeconds, X402_ANSWER_DEADLINE_MS / 1000);
  assert.deepEqual(body.x402.limits, {
    walletPerMinute: PAID_USE_LIMITS.perBuyerPerMinute,
    walletPerDay: PAID_USE_LIMITS.perBuyerPerDay,
    addressPerMinute: PAID_USE_LIMITS.perBuyerPerMinute,
  });
  // Everything else is the page without the door: the door's refusals are not in its list.
  const closed = await makeApp(page(withDoor()), "https://api.example.test");
  const closedBody = (await closed.app.inject({ method: "GET", url: "/a/eliza/api" })).json();
  assert.equal(closedBody.x402, null);
  assert.deepEqual({ ...body, x402: null }, closedBody);
  assert.equal(body.refusals.some((r: { code: string }) => r.code.startsWith("x402")), false);
  assertNothingLeaks(res.body);
  for (const never of DOOR_NEVER) assert.equal(res.body.includes(never), false, never);
  await app.close();
  await closed.app.close();
});

test("paying from a wallet for a task: one run at the listing's price", async () => {
  const built = agentApiPageOf(page({ unit: "run", priceCents: 25n, ...withDoor({ pricePerRequestCents: 25n }, { agentKind: "task" }) }, { agentKind: "task" }), {
    x402: DEVNET,
  })!;
  assert.equal(built.x402?.unit, "run");
  assert.equal(built.x402?.priceCents, 25);
  assert.equal(built.x402?.network, DEVNET.network);
});

test("no door is told while the door is closed, its state cannot be read, or nothing of the door was read", async () => {
  // Closed: no binding, a binding that says not usable, a binding that throws.
  for (const door of [undefined, () => null, () => { throw new Error("settings unreadable"); }]) {
    const { app } = await makeApp(page(withDoor()), null, door);
    const res = await app.inject({ method: "GET", url: "/a/eliza/api" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().x402, null);
    await app.close();
  }
  // Usable, but the loader did not read what the door's test needs.
  assert.equal(agentApiPageOf(page(), { x402: DEVNET })?.x402, null);
  assert.equal(agentApiPageOf(page(withDoor()))?.x402, null);
  assert.equal(agentApiPageOf(page(withDoor()), { x402: null })?.x402, null);
});

test("no door is told for a listing the door does not serve: the switch off, sold by the month, under the floor, a graph, a workflow, a private agent", () => {
  const notServed: Array<[string, Record<string, unknown>]> = [
    ["the switch is off", withDoor({ x402Enabled: false })],
    ["sold by the month", { pricingModel: "monthly", priceCents: 1_500n, unit: "month", ...withDoor({ pricingModel: "monthly", pricePerRequestCents: null }) }],
    ["under the floor", { priceCents: 4n, ...withDoor({ pricePerRequestCents: 4n }) }],
    ["a draft", withDoor({ status: "draft" })],
    ["answered by its graph", withDoor({}, { entrypoint: "graph" })],
    ["a workflow's listing", withDoor({ agentId: null, orchestrationId: "wf_1" })],
    ["a private agent", withDoor({}, { isPublic: false })],
  ];
  for (const [why, paid] of notServed) {
    const built = agentApiPageOf(page(paid), { x402: DEVNET });
    assert.ok(built, why);
    assert.equal(built.x402, null, why);
  }
  // The same listing with the switch on is served: the cases above differ by one fact each.
  assert.notEqual(agentApiPageOf(page(withDoor()), { x402: DEVNET })?.x402, null);
});

test("GET /a/:handle answers what it did: nothing of the door, whatever the loader read for it", async () => {
  const { app } = await makeApp(page(withDoor()), null, doorOpen);
  const plain = await makeApp(page());
  const res = await app.inject({ method: "GET", url: "/a/eliza" });
  const before = await plain.app.inject({ method: "GET", url: "/a/eliza" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), before.json());
  assert.deepEqual(Object.keys(res.json().use.paid), [
    "listingId",
    "listingSlug",
    "pricingModel",
    "priceCents",
    "unit",
    "perMinute",
    "perDay",
    "transcriptsStored",
    "sendsRequests",
    "plans",
    "trial",
  ]);
  assert.equal(/x402/i.test(res.body), false);
  for (const never of DOOR_NEVER) assert.equal(res.body.includes(never), false, never);
  await app.close();
  await plain.app.close();
});
