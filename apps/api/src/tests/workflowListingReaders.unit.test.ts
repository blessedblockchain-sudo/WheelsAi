import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";

import { usedAgentsOf, type UsedAgentRow } from "../routes/openaiV1.js";

// A listing sells an agent OR a workflow. No workflow listing can be made
// yet, so each reader of a listing's agent is shown a row that has
// `agentId: null` and an `orchestrationId`, through the real services against
// an in-memory database. What these pin: the reader says what the listing
// sells, invents no agent, unit or page for a workflow, and refuses what
// only an agent's listing can do; and an agent's row reads as it always did,
// with `productKind: "agent"` beside it.

type Row = Record<string, any>;

const PUBLISHER = "org_pub";
const BUYER = "org_buyer";
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";

const listingRow = (id: string, over: Row = {}): Row => ({
  id,
  agentId: `agent_${id}`,
  orchestrationId: null,
  title: `Listing ${id}`,
  slug: id,
  shortDescription: "One line",
  longDescription: null,
  category: "research",
  iconUrl: null,
  screenshots: [],
  readme: null,
  sells: "use",
  useAllowedTools: ["calculator"],
  pricingModel: "per_request",
  pricePerRequestCents: 5n,
  monthlyPriceCents: null,
  publisherId: PUBLISHER,
  publisherName: "Pub",
  status: "published",
  isFeatured: false,
  totalInstalls: 3,
  activeInstalls: 2,
  avgRating: 0,
  reviewCount: 0,
  totalRequests: 0n,
  pausedSince: null,
  publishedAt: new Date(0),
  createdAt: new Date(0),
  updatedAt: new Date(0),
  agent: {
    id: `agent_${id}`,
    name: `Agent ${id}`,
    framework: "custom",
    agentKind: "task",
    tags: ["a"],
    publicHandle: `h-${id}`,
    orgId: PUBLISHER,
    modelConfig: {},
    entrypoint: "prompt",
    kindConfig: null,
    tools: [],
  },
  agentToken: null,
  ...over,
});

/** A listing that sells a workflow: no agent, and the workflow's id. */
const workflowRow = (id: string, over: Row = {}): Row =>
  listingRow(id, { agentId: null, orchestrationId: WORKFLOW_ID, agent: null, useAllowedTools: [], ...over });

const installRow = (listingId: string, over: Row = {}): Row => ({
  id: `ins_${listingId}`,
  listingId,
  buyerId: BUYER,
  kind: "use",
  status: "active",
  clonedAgentId: null,
  totalRequests: 0n,
  totalSpentCents: 0n,
  installedAt: new Date(0),
  acceptedPricingModel: "per_request",
  acceptedPricePerRequestCents: 5n,
  pricingAcceptedAt: new Date(0),
  ...over,
});

function makeWorld(opts: { listings: Row[]; installs?: Row[] }) {
  /** Every write and every read of an agent, by name. */
  const calls: string[] = [];
  const listingOf = (id: string) => opts.listings.find((l) => l.id === id)!;
  const find = (where: Row) =>
    opts.listings.find(
      (l) =>
        (where.id === undefined || l.id === where.id) &&
        (where.slug === undefined || l.slug === where.slug) &&
        (where.status === undefined || l.status === where.status) &&
        (where.publisherId === undefined || l.publisherId === where.publisherId),
    ) ?? null;
  const models: Row = {
    agentListing: {
      findMany: async () => opts.listings.map((l) => ({ ...l })),
      count: async () => opts.listings.length,
      findUnique: async ({ where }: Row) => {
        const row = find(where);
        return row ? { ...row } : null;
      },
      findFirst: async ({ where }: Row) => {
        const row = find(where);
        return row ? { ...row } : null;
      },
      update: async () => {
        calls.push("agentListing.update");
        throw new Error("a workflow's listing was written");
      },
      updateMany: async () => {
        calls.push("agentListing.updateMany");
        return { count: 1 };
      },
    },
    agent: {
      findFirst: async () => {
        calls.push("agent.findFirst");
        return null;
      },
      findUnique: async () => {
        calls.push("agent.findUnique");
        return null;
      },
      updateMany: async () => {
        calls.push("agent.updateMany");
        return { count: 0 };
      },
    },
    listingPlan: { findMany: async () => [] },
    // A publisher's profile, with every listing of the world as theirs.
    publisherProfile: {
      findUnique: async ({ where }: Row) => ({
        displayName: "Pub",
        slug: where.slug,
        org: { publishedListings: opts.listings.map((l) => ({ ...l })) },
      }),
    },
    agentInstall: {
      findMany: async ({ where }: Row) =>
        (opts.installs ?? [])
          .filter((i) => (where.buyerId === undefined || i.buyerId === where.buyerId) && where.listingId === undefined)
          .map((i) => ({ ...i, listing: { ...listingOf(i.listingId) } })),
      findUnique: async ({ where, include }: Row) => {
        const key = where.listingId_buyerId;
        const row = (opts.installs ?? []).find((i) => i.listingId === key.listingId && i.buyerId === key.buyerId);
        if (!row) return null;
        return include?.listing ? { ...row, listing: { ...listingOf(row.listingId) } } : { ...row };
      },
    },
    agentSubscription: {
      findMany: async () => [],
      findUnique: async () => null,
    },
    $transaction: async () => {
      calls.push("$transaction");
      throw new Error("a transaction was opened for a workflow's listing");
    },
  };
  return { models, calls };
}

type World = ReturnType<typeof makeWorld>;

async function withModels<T>(models: Row, body: () => Promise<T>): Promise<T> {
  const { prisma } = (await import("../lib/prisma.js")) as unknown as { prisma: Row };
  const originals: Row = {};
  for (const [name, fake] of Object.entries(models)) {
    originals[name] = prisma[name];
    prisma[name] = fake;
  }
  try {
    return await body();
  } finally {
    for (const [name, original] of Object.entries(originals)) prisma[name] = original;
  }
}

async function withWorld<T>(world: World, body: (svc: typeof import("../services/marketplace.js")) => Promise<T>): Promise<T> {
  const svc = await import("../services/marketplace.js");
  return withModels(world.models, () => body(svc));
}

test("a row that names a workflow or has no agent is a workflow's listing; any other is an agent's", async () => {
  const { listingProductKind } = await import("../services/marketplace.js");
  assert.equal(listingProductKind({ agentId: "a1", orchestrationId: null }), "agent");
  assert.equal(listingProductKind({ agentId: "a1" }), "agent");
  assert.equal(listingProductKind({ agentId: null, orchestrationId: WORKFLOW_ID }), "workflow");
  // A read that did not select the workflow's id still does not take a
  // listing with no agent for an agent's.
  assert.equal(listingProductKind({ agentId: null }), "workflow");
  assert.equal(listingProductKind({ orchestrationId: WORKFLOW_ID }), "workflow");
});

test("the public read of a workflow's listing: sold by the run, no agent, no Try it, and never the workflow's id", async () => {
  const world = makeWorld({ listings: [workflowRow("flow")] });
  await withWorld(world, async ({ getListingBySlug, getListingById, searchListings, getFeaturedListings, getPublisherProfile }) => {
    const reads = [
      (await getListingBySlug("flow"))!,
      (await getListingById("flow"))!,
      (await searchListings({})).listings[0]!,
      (await getFeaturedListings())[0]!,
      (await getPublisherProfile("pub"))!.listings[0]!,
    ];
    for (const read of reads) {
      assert.equal(read.productKind, "workflow");
      assert.equal(read.agentId, null);
      assert.equal(read.unit, "run");
      assert.deepEqual(read.trial, { enabled: false });
      assert.equal(read.agent, undefined);
      assert.equal(read.slug, "flow");
      assert.equal(read.pricePerRequestCents, 5);
      assert.equal("orchestrationId" in read, false);
      assert.equal("allowedTools" in read, false);
      assert.doesNotMatch(JSON.stringify(read), new RegExp(WORKFLOW_ID));
    }
  });
});

test("a workflow's unit is the run whatever agent a broken row carries, and is never worked out from a missing kind", async () => {
  // A row that names a workflow and, against the database's own check, an
  // agent too: it is still read as a workflow's, with none of the agent.
  const world = makeWorld({
    listings: [
      workflowRow("both", {
        agentId: "agent_x",
        agent: { id: "agent_x", framework: "custom", agentKind: "conversation", tags: [], publicHandle: "leak" },
      }),
    ],
  });
  await withWorld(world, async ({ getListingById }) => {
    const read = (await getListingById("both"))!;
    assert.equal(read.productKind, "workflow");
    assert.equal(read.unit, "run");
    assert.equal(read.agentId, null);
    assert.equal(read.agent, undefined);
    assert.deepEqual(read.trial, { enabled: false });
    assert.doesNotMatch(JSON.stringify(read), /leak|agent_x/);
  });
});

test("the public read of an agent's listing is what it was, with productKind agent beside it", async () => {
  const world = makeWorld({ listings: [listingRow("alpha")] });
  await withWorld(world, async ({ getListingById }) => {
    assert.deepEqual(await getListingById("alpha"), {
      id: "alpha",
      productKind: "agent",
      agentId: "agent_alpha",
      title: "Listing alpha",
      slug: "alpha",
      shortDescription: "One line",
      longDescription: null,
      category: "research",
      iconUrl: null,
      screenshots: [],
      readme: null,
      sells: "use",
      unit: "run",
      hasToken: false,
      pricingModel: "per_request",
      pricePerRequestCents: 5,
      monthlyPriceCents: null,
      publisherId: PUBLISHER,
      publisherName: "Pub",
      status: "published",
      isFeatured: false,
      totalInstalls: 3,
      activeInstalls: 2,
      avgRating: 0,
      reviewCount: 0,
      totalRequests: 0,
      publishedAt: new Date(0),
      createdAt: new Date(0),
      updatedAt: new Date(0),
      trial: { enabled: true },
      agent: {
        id: "agent_alpha",
        framework: "custom",
        agentKind: "task",
        tags: ["a"],
        handle: "h-alpha",
        slug: undefined,
        isPublic: undefined,
      },
    });
  });
  // The unit of an agent still follows its kind and its pricing.
  const kinds = makeWorld({
    listings: [
      listingRow("chat", { agent: { ...listingRow("chat").agent, agentKind: "conversation" } }),
      listingRow("month", { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 900n }),
      listingRow("free", { pricingModel: "free", pricePerRequestCents: null }),
      listingRow("draft", { status: "draft" }),
    ],
  });
  await withWorld(kinds, async ({ getListingById }) => {
    assert.equal((await getListingById("chat"))!.unit, "message");
    assert.equal((await getListingById("month"))!.unit, "month");
    assert.equal((await getListingById("free"))!.unit, null);
    assert.deepEqual((await getListingById("draft"))!.trial, { enabled: false });
  });
});

test("my listings: the owner of a workflow's listing is told which workflow, and an agent's listing says null", async () => {
  const world = makeWorld({ listings: [workflowRow("flow"), listingRow("alpha")] });
  await withWorld(world, async ({ getMyListings }) => {
    const [flow, alpha] = await getMyListings(PUBLISHER);
    assert.equal(flow!.productKind, "workflow");
    assert.equal(flow!.orchestrationId, WORKFLOW_ID);
    assert.equal(flow!.agentId, null);
    assert.equal(flow!.unit, "run");
    assert.equal(flow!.agent, undefined);
    assert.deepEqual(flow!.trial, { enabled: false });
    assert.deepEqual(flow!.allowedTools, []);
    // No agent, so no model of its own to be paused on.
    assert.equal(flow!.paused, null);

    assert.equal(alpha!.productKind, "agent");
    assert.equal(alpha!.orchestrationId, null);
    assert.equal(alpha!.agentId, "agent_alpha");
    assert.deepEqual(alpha!.allowedTools, ["calculator"]);
    assert.equal(alpha!.agent!.handle, "h-alpha");
    // The owner's view of an agent's listing, key by key: what it was, with productKind after the id and
    // orchestrationId after the agent. A key added to it or dropped from it fails here.
    assert.deepEqual(Object.keys(alpha!), [
      "id", "productKind", "agentId", "title", "slug", "shortDescription", "longDescription", "category", "iconUrl",
      "screenshots", "readme", "sells", "unit", "hasToken", "pricingModel", "pricePerRequestCents",
      "monthlyPriceCents", "publisherId", "publisherName", "status", "isFeatured", "totalInstalls", "activeInstalls",
      "avgRating", "reviewCount", "totalRequests", "publishedAt", "createdAt", "updatedAt", "trial", "agent",
      "orchestrationId", "allowedTools", "buyers", "plans", "paused",
    ]);
  });
});

test("a licence for a workflow's listing is answered with no agent, its product and the listing's slug", async () => {
  const world = makeWorld({
    listings: [workflowRow("flow"), listingRow("alpha")],
    installs: [installRow("flow"), installRow("alpha")],
  });
  await withWorld(world, async ({ getMyInstalls, checkInstallStatus, readUseState }) => {
    const [flow, alpha] = await getMyInstalls(BUYER);
    assert.equal(flow!.agent, null);
    assert.equal(flow!.productKind, "workflow");
    assert.equal(flow!.slug, "flow");
    assert.equal(flow!.listing.productKind, "workflow");
    assert.equal(flow!.listing.unit, "run");
    assert.equal(flow!.access, "listing_pricing");
    // An agent's licence: the agent as before, and the two new fields.
    assert.deepEqual(alpha!.agent, { handle: "h-alpha", name: "Agent alpha", agentKind: "task" });
    assert.equal(alpha!.productKind, "agent");
    assert.equal(alpha!.slug, "alpha");

    const status = await checkInstallStatus("flow", BUYER);
    assert.equal(status.install!.agent, null);
    assert.equal(status.install!.productKind, "workflow");
    assert.equal(status.install!.slug, "flow");
    const agentStatus = await checkInstallStatus("alpha", BUYER);
    assert.deepEqual(agentStatus.install!.agent, { handle: "h-alpha", name: "Agent alpha", agentKind: "task" });
    assert.equal(agentStatus.install!.productKind, "agent");

    // What a start, a plan start and a move answer with.
    const state = await readUseState(workflowRow("flow") as any, BUYER);
    assert.equal(state.agent, null);
    assert.equal(state.productKind, "workflow");
    assert.equal(state.slug, "flow");
    assert.equal(state.access, "listing_pricing");
    const agentState = await readUseState(listingRow("alpha") as any, BUYER);
    assert.deepEqual(agentState.agent, { handle: "h-alpha", name: "Agent alpha", agentKind: "task" });
    assert.equal(agentState.productKind, "agent");
    assert.equal(agentState.slug, "alpha");
  });
});

test("Try it has nothing to describe for a workflow's listing", async () => {
  const world = makeWorld({ listings: [workflowRow("flow"), listingRow("alpha")] });
  await withWorld(world, async ({ getListingTrialPreview }) => {
    assert.equal(await getListingTrialPreview("flow"), null);
    const agent = await getListingTrialPreview("alpha");
    assert.equal(agent!.id, "alpha");
    assert.equal(agent!.agentKind, "task");
    assert.equal(agent!.agentEntrypoint, "prompt");
  });
});

test("the edit and the publish of a workflow's listing are never an agent's: no agent is looked for, and a workflow that is gone writes nothing", async () => {
  for (const status of ["draft", "published"]) {
    const world = makeWorld({ listings: [workflowRow("flow", { status })] });
    // The workflow behind the listing is no longer in the publisher's organization.
    world.models.orchestration = { findFirst: async () => null };
    await withWorld(world, async ({ updateListing, publishListing, ListingError }) => {
      const notFound = (err: unknown) => {
        assert.ok(err instanceof ListingError, String(err));
        assert.deepEqual([err.status, err.code, err.message], [404, "workflow_not_found", "Workflow not found."]);
        return true;
      };
      await assert.rejects(updateListing("flow", PUBLISHER, { title: "New", pricePerRequestCents: 9, publish: true }), notFound);
      await assert.rejects(updateListing("flow", PUBLISHER, { title: "Only the title" }), notFound);
      // A published listing has nothing to publish; a draft asks the workflow first.
      if (status === "published") assert.equal((await publishListing("flow", PUBLISHER))!.id, "flow");
      else await assert.rejects(publishListing("flow", PUBLISHER), notFound);
    });
    // No write, no transaction, and no agent looked for to stand in for one.
    assert.deepEqual(world.calls, []);
  }
});

test("a copy of a workflow's listing is refused: the listing sells use, and a row that says otherwise has nothing to copy", async () => {
  const world = makeWorld({ listings: [workflowRow("flow"), workflowRow("broken", { sells: "copies" })] });
  await withWorld(world, async ({ installAgent, InstallRefusedError }) => {
    await assert.rejects(installAgent("flow", BUYER), (err: unknown) => {
      assert.ok(err instanceof InstallRefusedError);
      assert.equal((err as { code?: string }).code, "sells_use");
      return true;
    });
    await assert.rejects(installAgent("broken", BUYER), /This agent is not available for installation/);
  });
  assert.deepEqual(world.calls, []);
});

test("asked whether a workflow's listing can have a token, the answer is no, before anything of an agent is read", async () => {
  const { checkTokenEligibility, TOKEN_AGENT_LISTING_ONLY_MESSAGE } = await import("../services/agentToken.js");
  assert.equal(TOKEN_AGENT_LISTING_ONLY_MESSAGE, "A token can be launched for an agent's listing only.");
  const read: string[] = [];
  const models: Row = {
    agentListing: { findUnique: async () => ({ id: "flow", publisherId: PUBLISHER, status: "published", agent: null }) },
    agentToken: { findUnique: async () => (read.push("agentToken"), null) },
    publisherProfile: { findUnique: async () => (read.push("publisherProfile"), { reputationScore: 100 }) },
    agentDeployment: { findMany: async () => (read.push("agentDeployment"), []) },
    x402Payment: { count: async () => (read.push("x402Payment"), 0) },
  };
  // A gate of 0 and 0 would pass any agent's listing: the refusal is this rule's alone.
  const gate = { minReputation: 0, minDeploymentAgeDays: 0 };
  await withModels(models, async () => {
    assert.deepEqual(await checkTokenEligibility("flow", PUBLISHER, gate), {
      eligible: false,
      reasons: ["A token can be launched for an agent's listing only."],
    });
    // Somebody else's listing is still told only that it is not theirs.
    assert.deepEqual((await checkTokenEligibility("flow", "org_other", gate)).reasons, [
      "Agent listing does not belong to your organization",
    ]);
  });
  assert.deepEqual(read, []);

  // The same gate lets an agent's listing through.
  models.agentListing.findUnique = async () => ({
    id: "alpha",
    publisherId: PUBLISHER,
    status: "published",
    agent: { id: "agent_alpha", deployments: [] },
  });
  await withModels(models, async () => {
    assert.equal((await checkTokenEligibility("alpha", PUBLISHER, gate)).eligible, true);
  });
});

test("no token is written for a listing with no agent", async () => {
  const { persistAgentTokenWithTreasury } = await import("../routes/tokenLaunchPartialSignBindings.js");
  const written: string[] = [];
  const tx = (agent: Row | null) => ({
    agentListing: { findUnique: async () => ({ id: "flow", title: "Flow", iconUrl: null, agent }) },
    agentToken: { create: async () => (written.push("agentToken"), { id: "tok", creatorLockupEnd: null }) },
    agentTreasury: { create: async () => (written.push("agentTreasury"), { id: "tre" }) },
  });
  const input = { agentListingId: "flow", orgId: PUBLISHER } as any;
  await withModels({ $transaction: async (fn: (t: Row) => unknown) => fn(tx(null)) }, async () => {
    await assert.rejects(persistAgentTokenWithTreasury(input), /has no agent; a token is launched for an agent's listing only/);
  });
  assert.deepEqual(written, []);
  // An agent of another organization is refused as it was.
  await withModels({ $transaction: async (fn: (t: Row) => unknown) => fn(tx({ orgId: "org_other" })) }, async () => {
    await assert.rejects(persistAgentTokenWithTreasury(input), /does not match input\.orgId/);
  });
  assert.deepEqual(written, []);
});

test("/v1/models: a licence for a workflow among licences for agents lists the agents and does not throw", () => {
  const now = new Date("2026-10-14T00:00:00Z");
  const row = (handle: string | null, agent: UsedAgentRow["listing"]["agent"] = { publicHandle: handle }): UsedAgentRow => ({
    kind: "use",
    status: "active",
    installedAt: new Date("2026-10-01T00:00:00Z"),
    acceptedPricingModel: "per_request",
    acceptedPricePerRequestCents: 5n,
    listingId: `lst-${handle ?? "none"}`,
    listing: { status: "published", sells: "use", pricingModel: "per_request", pricePerRequestCents: 5n, agent },
  });
  const used = usedAgentsOf([row("first"), row(null, null), row("second")], [], now);
  assert.deepEqual(
    used.map((agent) => agent.handle),
    ["first", "second"],
  );
});

test("the listing an agent's paid use and public link load is never a row with no agent", async () => {
  const { buildAgentPublicLinkDeps } = await import("../services/buildAgentPublicLinkDeps.js");
  const { buildPaidUseDeps } = await import("../services/buildPaidUseDeps.js");
  const base = {
    id: "lst",
    slug: "lst",
    title: "T",
    publisherId: PUBLISHER,
    status: "published",
    sells: "use",
    pricingModel: "per_request",
    pricePerRequestCents: 5n,
    monthlyPriceCents: null,
    useAllowedTools: [],
  };
  for (const [agentId, expected] of [
    [null, null],
    ["agent_1", { ...base, agentId: "agent_1" }],
  ] as const) {
    const row = { ...base, agentId };
    const fake = { agentListing: { findFirst: async () => ({ ...row }), findUnique: async () => ({ ...row }) } };
    const link = buildAgentPublicLinkDeps({ prisma: fake as any });
    assert.deepEqual(await link.useListing(link.db as any, "agent_1"), expected);
    await withModels({ agentListing: fake.agentListing }, async () => {
      assert.deepEqual(await buildPaidUseDeps().loadListing("agent_1"), expected);
    });
  }
});
