import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";

// installAgent against an in-memory database. What these pin: subscribing
// on an install that is already active never charges twice, a request
// that read a stale clone id cannot orphan a clone, a pricing change needs
// the buyer's explicit acceptance, and the installs list reports the
// agreed price and the access the billing path will actually apply.

const DAY = 24 * 60 * 60 * 1000;
const LISTING_ID = "lst_1";
const BUYER = "org_buyer";

type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond) return cond.in.includes(v);
      if ("not" in cond) return v !== cond.not;
    }
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    return v === cond;
  });
}

function makeWorld(opts: {
  pricingModel: string;
  monthlyPriceCents?: bigint | null;
  pricePerRequestCents?: bigint | null;
  listingStatus?: string;
  install?: { status: string; clonedAgentId: string | null };
  sub?: Row;
  agents?: string[];
  balance?: bigint;
  /** Extra fields of the listed agent (entrypoint, graph). */
  sourceAgent?: Row;
}) {
  const state = {
    listing: {
      id: LISTING_ID,
      title: "Research Analyst",
      publisherId: "org_pub",
      status: opts.listingStatus ?? "published",
      pricingModel: opts.pricingModel,
      monthlyPriceCents: opts.monthlyPriceCents ?? null,
      pricePerRequestCents: opts.pricePerRequestCents ?? null,
      totalInstalls: 0,
      activeInstalls: 0,
      agent: {
        id: "agent_src",
        name: "Analyst",
        slug: "analyst",
        tags: [],
        framework: "mastra",
        ...(opts.sourceAgent ?? {}),
      },
    } as Row,
    installs: (opts.install
      ? [{ id: "ins_1", listingId: LISTING_ID, buyerId: BUYER, uninstalledAt: null, ...opts.install }]
      : []) as Row[],
    subs: (opts.sub
      ? [{ id: "sub_1", listingId: LISTING_ID, subscriberId: BUYER, cancelAtPeriodEnd: false, endReason: null, ...opts.sub }]
      : []) as Row[],
    agents: (opts.agents ?? []).map((id) => ({ id, orgId: BUYER })) as Row[],
    balance: opts.balance ?? 10_000n,
    ledger: [] as Row[],
    revenue: [] as Row[],
  };
  let seq = 0;

  const models: Row = {
    agentListing: {
      findUnique: async () => ({ ...state.listing }),
      update: async ({ data }: Row) => {
        for (const [k, v] of Object.entries<Row>(data)) {
          state.listing[k] += (v.increment ?? 0) - (v.decrement ?? 0);
        }
        return { ...state.listing };
      },
      aggregate: async () => ({ _count: { id: 1 }, _sum: { totalInstalls: state.listing.totalInstalls } }),
    },
    agentInstall: {
      findUnique: async () => (state.installs[0] ? { ...state.installs[0] } : null),
      findMany: async () => state.installs.map((i) => ({ ...i, listing: { ...state.listing } })),
      updateMany: async ({ where, data }: Row) => {
        const hit = state.installs.filter((i) => matches(i, where));
        for (const i of hit) Object.assign(i, data);
        return { count: hit.length };
      },
      update: async ({ where, data }: Row) => {
        const row = state.installs.find((i) => i.id === where.id)!;
        Object.assign(row, data);
        return { ...row };
      },
      create: async ({ data }: Row) => {
        if (state.installs.length > 0) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        const row = { id: `ins_${++seq}`, uninstalledAt: null, ...data };
        state.installs.push(row);
        return { ...row };
      },
    },
    agentSubscription: {
      findUnique: async () => (state.subs[0] ? { ...state.subs[0] } : null),
      findMany: async () => state.subs.map((s) => ({ ...s })),
      create: async ({ data }: Row) => {
        if (state.subs.length > 0) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        const row = { id: `sub_${++seq}`, ...data };
        state.subs.push(row);
        return { ...row };
      },
      updateMany: async ({ where, data }: Row) => {
        const hit = state.subs.filter((s) => matches(s, where));
        for (const s of hit) Object.assign(s, data);
        return { count: hit.length };
      },
    },
    agentToken: { findUnique: async () => null },
    agent: {
      findFirst: async ({ where }: Row) => state.agents.find((a) => matches(a, where)) ?? null,
      create: async ({ data }: Row) => {
        const row = { id: `agent_new_${++seq}`, ...data };
        state.agents.push(row);
        return row;
      },
    },
    creditBalance: {
      updateMany: async ({ where, data }: Row) => {
        if (state.balance < where.balanceCents.gte) return { count: 0 };
        state.balance -= data.balanceCents.decrement;
        return { count: 1 };
      },
      findUnique: async () => ({ balanceCents: state.balance }),
    },
    creditTransaction: {
      create: async ({ data }: Row) => {
        state.ledger.push(data);
        return data;
      },
    },
    marketplaceRevenue: {
      create: async ({ data }: Row) => {
        const row = { id: `rev_${++seq}`, ...data };
        state.revenue.push(row);
        return row;
      },
    },
    // No profile row: the reputation recalculation stops at its first read.
    publisherProfile: { findUnique: async () => null, update: async () => ({}) },
  };

  // One transaction at a time, as the row locks make it in Postgres: the
  // second waits for the first to commit, then runs against what it left.
  // Reads made before the transaction stay as stale as they were.
  let tail: Promise<unknown> = Promise.resolve();
  models.$transaction = (fn: (tx: Row) => Promise<unknown>) => {
    const run = tail.then(async () => {
      const snapshot = structuredClone({
        listing: state.listing,
        installs: state.installs,
        subs: state.subs,
        agents: state.agents,
        balance: state.balance,
        ledger: state.ledger,
        revenue: state.revenue,
      });
      try {
        return await fn(models);
      } catch (err) {
        Object.assign(state, snapshot);
        throw err;
      }
    });
    tail = run.catch(() => {});
    return run;
  };
  return { state, models };
}

async function withWorld<T>(
  world: ReturnType<typeof makeWorld>,
  body: (svc: typeof import("../services/marketplace.js")) => Promise<T>,
): Promise<T> {
  const { prisma } = (await import("../lib/prisma.js")) as unknown as { prisma: Row };
  const svc = await import("../services/marketplace.js");
  const originals: Row = {};
  for (const [name, fake] of Object.entries(world.models)) {
    originals[name] = prisma[name];
    prisma[name] = fake;
  }
  try {
    const result = await body(svc);
    // Let the fire-and-forget reputation recalculation settle on the fakes.
    await new Promise((resolve) => setImmediate(resolve));
    return result;
  } finally {
    for (const [name, original] of Object.entries(originals)) prisma[name] = original;
  }
}

const outcomes = (results: PromiseSettledResult<unknown>[]) => results.map((r) => r.status).sort();

// ============================================
// Subscribing on an active install
// ============================================

test("two concurrent subscribes on an active install with no subscription charge once", async () => {
  const world = makeWorld({
    pricingModel: "monthly",
    monthlyPriceCents: 1_000n,
    install: { status: "active", clonedAgentId: "agent_c0" },
    agents: ["agent_c0"],
  });
  await withWorld(world, async ({ installAgent }) => {
    const results = await Promise.allSettled([installAgent(LISTING_ID, BUYER), installAgent(LISTING_ID, BUYER)]);
    assert.deepEqual(outcomes(results), ["fulfilled", "rejected"]);
  });
  assert.equal(world.state.balance, 9_000n);
  assert.equal(world.state.ledger.length, 1);
  assert.equal(world.state.revenue.length, 1);
  assert.equal(world.state.subs.length, 1);
});

test("two concurrent resubscribes on an active install with a lapsed subscription charge once", async () => {
  const world = makeWorld({
    pricingModel: "monthly",
    monthlyPriceCents: 1_000n,
    install: { status: "active", clonedAgentId: "agent_c0" },
    agents: ["agent_c0"],
    sub: { status: "past_due", currentPeriodEnd: new Date(Date.now() - 10 * DAY), priceCents: 1_000n },
  });
  await withWorld(world, async ({ installAgent }) => {
    const results = await Promise.allSettled([installAgent(LISTING_ID, BUYER), installAgent(LISTING_ID, BUYER)]);
    assert.deepEqual(outcomes(results), ["fulfilled", "rejected"]);
  });
  assert.equal(world.state.balance, 9_000n);
  assert.equal(world.state.ledger.length, 1);
  assert.equal(world.state.subs[0]!.status, "active");
});

test("with the clone deleted, concurrent subscribes create one clone and leave none orphaned", async () => {
  const world = makeWorld({
    pricingModel: "monthly",
    monthlyPriceCents: 1_000n,
    install: { status: "active", clonedAgentId: "agent_deleted" },
  });
  await withWorld(world, async ({ installAgent }) => {
    const results = await Promise.allSettled([installAgent(LISTING_ID, BUYER), installAgent(LISTING_ID, BUYER)]);
    assert.deepEqual(outcomes(results), ["fulfilled", "rejected"]);
  });
  assert.equal(world.state.agents.length, 1);
  assert.equal(world.state.installs[0]!.clonedAgentId, world.state.agents[0]!.id);
  assert.equal(world.state.balance, 9_000n);
});

test("an install that runs cannot be installed again", async () => {
  const world = makeWorld({
    pricingModel: "per_request",
    pricePerRequestCents: 5n,
    install: { status: "active", clonedAgentId: "agent_c0" },
    agents: ["agent_c0"],
  });
  await withWorld(world, async ({ installAgent }) => {
    await assert.rejects(installAgent(LISTING_ID, BUYER), /already installed/);
  });

  const paidUp = makeWorld({
    pricingModel: "monthly",
    monthlyPriceCents: 1_000n,
    install: { status: "active", clonedAgentId: "agent_c0" },
    agents: ["agent_c0"],
    sub: { status: "active", currentPeriodEnd: new Date(Date.now() + 10 * DAY), priceCents: 1_000n },
  });
  await withWorld(paidUp, async ({ installAgent }) => {
    await assert.rejects(installAgent(LISTING_ID, BUYER), /already installed/);
  });
  assert.equal(paidUp.state.balance, 10_000n);
});

// ============================================
// Stale clone id
// ============================================

test("a request that read the install before another install repointed it cannot create a second clone", async () => {
  const world = makeWorld({
    pricingModel: "per_request",
    pricePerRequestCents: 5n,
    // Uninstalled, and the buyer has since deleted the old clone.
    install: { status: "uninstalled", clonedAgentId: "agent_deleted" },
  });
  await withWorld(world, async ({ installAgent, uninstallAgent }) => {
    // The stale request has read the row; before its transaction starts,
    // an install and an uninstall run to completion. The row is
    // 'uninstalled' again, but now points at the clone that install made.
    const realFind = world.models.agentSubscription.findUnique;
    let interleaved = false;
    world.models.agentSubscription.findUnique = async (args: Row) => {
      if (!interleaved) {
        interleaved = true;
        await installAgent(LISTING_ID, BUYER);
        await uninstallAgent(LISTING_ID, BUYER);
      }
      return realFind(args);
    };
    await assert.rejects(installAgent(LISTING_ID, BUYER), /already being installed/);
  });
  // One clone, and the install row still points at it.
  assert.equal(world.state.agents.length, 1);
  assert.equal(world.state.installs[0]!.clonedAgentId, world.state.agents[0]!.id);
  assert.equal(world.state.installs[0]!.status, "uninstalled");
});

// ============================================
// Pricing change
// ============================================

function repriced(install: { status: string }, endReason: string) {
  return makeWorld({
    pricingModel: "per_request",
    pricePerRequestCents: 100_000n,
    install: { ...install, clonedAgentId: "agent_c0" },
    agents: ["agent_c0"],
    sub: { status: "cancelled", currentPeriodEnd: new Date(Date.now() - DAY), priceCents: 100n, endReason },
  });
}

test("a repriced install stays paused until the buyer explicitly accepts the new pricing", async () => {
  const world = repriced({ status: "suspended" }, "pricing_changed");
  await withWorld(world, async ({ installAgent, PricingChangedError }) => {
    await assert.rejects(installAgent(LISTING_ID, BUYER), (err: unknown) => {
      assert.ok(err instanceof PricingChangedError);
      assert.deepEqual(err.pricing, {
        pricingModel: "per_request",
        pricePerRequestCents: 100_000,
        monthlyPriceCents: null,
      });
      return true;
    });
    assert.equal(world.state.installs[0]!.status, "suspended");
    assert.equal(world.state.subs[0]!.endReason, "pricing_changed");

    await installAgent(LISTING_ID, BUYER, { acceptNewPricing: true });
  });
  assert.equal(world.state.installs[0]!.status, "active");
  assert.equal(world.state.subs[0]!.endReason, null);
  // Accepting per-request pricing charges nothing by itself.
  assert.equal(world.state.balance, 10_000n);
  // A resumed install was never uncounted, so it is not counted again.
  assert.equal(world.state.listing.activeInstalls, 0);
});

test("accepting on an install that is still active is claimed once", async () => {
  // An archived listing published again as per-request: the install row
  // never left 'active', so the acceptance itself has to be exclusive.
  const world = repriced({ status: "active" }, "listing_archived");
  await withWorld(world, async ({ installAgent }) => {
    const results = await Promise.allSettled([
      installAgent(LISTING_ID, BUYER, { acceptNewPricing: true }),
      installAgent(LISTING_ID, BUYER, { acceptNewPricing: true }),
    ]);
    assert.deepEqual(outcomes(results), ["fulfilled", "rejected"]);
  });
  assert.equal(world.state.subs[0]!.endReason, null);
  assert.equal(world.state.agents.length, 1);
});

function ranOut(sub: Row, install = "active") {
  return makeWorld({
    pricingModel: "per_request",
    pricePerRequestCents: 100_000n,
    install: { status: install, clonedAgentId: "agent_c0" },
    agents: ["agent_c0"],
    sub: { currentPeriodStart: new Date(Date.now() - 40 * DAY), cancelledAt: null, priceCents: 100n, ...sub },
  });
}

for (const [name, sub] of [
  ["cancelled renewal, period just ended", { status: "active", cancelAtPeriodEnd: true, currentPeriodEnd: new Date(Date.now() - 60_000) }],
  ["worker not running, grace over", { status: "active", currentPeriodEnd: new Date(Date.now() - 10 * DAY) }],
] as const) {
  test(`a run-out subscription the renewal worker has not closed needs acceptance too (${name})`, async () => {
    const world = ranOut(sub);
    const periodEnd = world.state.subs[0]!.currentPeriodEnd;
    await withWorld(world, async ({ installAgent, getMyInstalls, PricingChangedError }) => {
      assert.equal((await getMyInstalls(BUYER))[0]!.access, "pricing_changed");
      await assert.rejects(installAgent(LISTING_ID, BUYER), PricingChangedError);
      assert.equal(world.state.subs[0]!.status, "active");

      const results = await Promise.allSettled([
        installAgent(LISTING_ID, BUYER, { acceptNewPricing: true }),
        installAgent(LISTING_ID, BUYER, { acceptNewPricing: true }),
      ]);
      assert.deepEqual(outcomes(results), ["fulfilled", "rejected"]);
      assert.equal((await getMyInstalls(BUYER))[0]!.access, "listing_pricing");
    });
    // Closed by the acceptance, so the worker's close (which matches an
    // open status) can no longer suspend the install.
    const row = world.state.subs[0]!;
    assert.equal(row.status, "cancelled");
    assert.equal(row.endReason, null);
    assert.equal(row.cancelAtPeriodEnd, false);
    assert.ok(row.cancelledAt instanceof Date);
    assert.equal(row.currentPeriodEnd.getTime(), periodEnd.getTime());
    assert.equal(world.state.installs[0]!.status, "active");
    assert.equal(world.state.agents.length, 1);
    assert.equal(world.state.balance, 10_000n);
    assert.equal(world.state.listing.activeInstalls, 0);
  });
}

test("an acceptance that read the row before the renewal worker closed it does not go through", async () => {
  const world = ranOut({ status: "active", currentPeriodEnd: new Date(Date.now() - 10 * DAY) });
  await withWorld(world, async ({ installAgent }) => {
    const realFind = world.models.agentSubscription.findUnique;
    world.models.agentSubscription.findUnique = async (args: Row) => {
      const read = await realFind(args);
      // The worker's close lands after the read: subscription ended with
      // the reason, install suspended.
      Object.assign(world.state.subs[0]!, { status: "cancelled", endReason: "pricing_changed" });
      world.state.installs[0]!.status = "suspended";
      return read;
    };
    await assert.rejects(installAgent(LISTING_ID, BUYER, { acceptNewPricing: true }), /already being installed/);
  });
  assert.equal(world.state.installs[0]!.status, "suspended");
  assert.equal(world.state.subs[0]!.endReason, "pricing_changed");
});

test("a suspended install whose subscription expired unpaid cannot be resubscribed onto per-request pricing without accepting it", async () => {
  const world = ranOut({ status: "expired", currentPeriodEnd: new Date(Date.now() - 10 * DAY) }, "suspended");
  await withWorld(world, async ({ installAgent, getMyInstalls, PricingChangedError }) => {
    assert.equal((await getMyInstalls(BUYER))[0]!.access, "pricing_changed");
    await assert.rejects(installAgent(LISTING_ID, BUYER), PricingChangedError);
    assert.equal(world.state.installs[0]!.status, "suspended");
    await installAgent(LISTING_ID, BUYER, { acceptNewPricing: true });
  });
  assert.equal(world.state.installs[0]!.status, "active");
  assert.equal(world.state.subs[0]!.status, "expired");
  assert.equal(world.state.balance, 10_000n);
});

// ============================================
// What the buyer is shown
// ============================================

test("the installs list reports the agreed price, not the listing's current one", async () => {
  const world = makeWorld({
    pricingModel: "monthly",
    monthlyPriceCents: 100n, // lowered after the buyer subscribed at $100
    install: { status: "active", clonedAgentId: "agent_c0" },
    sub: {
      status: "active",
      currentPeriodStart: new Date(Date.now() - 20 * DAY),
      currentPeriodEnd: new Date(Date.now() + 10 * DAY),
      cancelledAt: null,
      priceCents: 10_000n,
    },
  });
  await withWorld(world, async ({ getMyInstalls }) => {
    const [install] = await getMyInstalls(BUYER);
    assert.equal(install!.subscription!.priceCents, 10_000);
    assert.equal(install!.listing.monthlyPriceCents, 100);
    assert.equal(install!.access, "subscribed");
  });
});

test("an archived monthly listing whose subscription closed is reported as unlisted, not lapsed", async () => {
  const world = makeWorld({
    pricingModel: "monthly",
    monthlyPriceCents: 1_000n,
    listingStatus: "archived",
    install: { status: "active", clonedAgentId: "agent_c0" },
    sub: {
      status: "cancelled",
      currentPeriodStart: new Date(Date.now() - 40 * DAY),
      currentPeriodEnd: new Date(Date.now() - 10 * DAY),
      cancelledAt: new Date(),
      priceCents: 1_000n,
      endReason: "listing_archived",
    },
  });
  await withWorld(world, async ({ getMyInstalls }) => {
    const [install] = await getMyInstalls(BUYER);
    // The page offers Resubscribe only for 'subscription_lapsed'.
    assert.equal(install!.access, "unlisted");
    assert.equal(install!.subscription!.hasAccess, false);
  });
});

test("a legacy subscription with no stored price reports null, never the listing price", async () => {
  const world = makeWorld({
    pricingModel: "monthly",
    monthlyPriceCents: 9_000n,
    install: { status: "active", clonedAgentId: "agent_c0" },
    sub: {
      status: "active",
      currentPeriodStart: new Date(Date.now() - 20 * DAY),
      currentPeriodEnd: new Date(Date.now() + 10 * DAY),
      cancelledAt: null,
      priceCents: null,
    },
  });
  await withWorld(world, async ({ getMyInstalls }) => {
    const [install] = await getMyInstalls(BUYER);
    assert.equal(install!.subscription!.priceCents, null);
  });
});

// ============================================
// What the copy carries: entrypoint and graph
// ============================================

const GRAPH_NODES = [
  { id: "in", type: "input", data: { label: "Question", config: {} } },
  {
    id: "lookup",
    type: "api",
    data: {
      label: "Price feed",
      config: {
        method: "POST",
        timeoutMs: 5000,
        url: "https://prices.example.com/v1/quote",
        headers: { Authorization: "Bearer publisher-secret", "X-Api-Key": "pk_live_1", Accept: "application/json" },
      },
    },
  },
  { id: "answer", type: "llm", data: { label: "Answer", config: { systemPrompt: "Use the quote." } } },
];
const GRAPH_EDGES = [
  { id: "e1", source: "in", target: "lookup" },
  { id: "e2", source: "lookup", target: "answer" },
];

test("installing a graph agent copies its entrypoint and its graph", async () => {
  const world = makeWorld({
    pricingModel: "free",
    sourceAgent: {
      entrypoint: "graph",
      graph: { nodes: GRAPH_NODES, edges: GRAPH_EDGES, viewport: { x: 1, y: 2, zoom: 0.5 }, isValid: true },
    },
  });
  await withWorld(world, ({ installAgent }) => installAgent(LISTING_ID, BUYER));

  const clone = world.state.agents[0]!;
  assert.equal(clone.orgId, BUYER);
  assert.equal(clone.entrypoint, "graph");
  const graph = clone.graph.create;
  assert.deepEqual(graph.edges, GRAPH_EDGES);
  assert.deepEqual(graph.viewport, { x: 1, y: 2, zoom: 0.5 });
  assert.deepEqual(
    graph.nodes.map((n: Row) => [n.id, n.type, n.data.label]),
    [
      ["in", "input", "Question"],
      ["lookup", "api", "Price feed"],
      ["answer", "llm", "Answer"],
    ],
  );
  assert.deepEqual(graph.nodes[0], GRAPH_NODES[0]);
  assert.deepEqual(graph.nodes[2], GRAPH_NODES[2]);
  // What is not a request detail stays on the api node.
  assert.equal(graph.nodes[1].data.config.method, "POST");
  assert.equal(graph.nodes[1].data.config.timeoutMs, 5000);
});

test("a graph with no literal request details is copied whole and stays valid", async () => {
  const nodes = [
    GRAPH_NODES[0],
    {
      id: "call",
      type: "api",
      data: {
        label: "Follow the link",
        config: { url: "{{nodes.in}}", headers: { "X-Trace": "{{value | urlencode}}" }, body: "{{value | json}}" },
      },
    },
    { id: "sum", type: "tool", data: { label: "Sum", config: { toolName: "calculator", input: { expression: "2+2" } } } },
    GRAPH_NODES[2],
  ];
  const world = makeWorld({
    pricingModel: "free",
    sourceAgent: { entrypoint: "graph", graph: { nodes, edges: GRAPH_EDGES, isValid: true } },
  });
  const result = await withWorld(world, ({ installAgent }) => installAgent(LISTING_ID, BUYER));

  const graph = world.state.agents[0]!.graph.create;
  assert.deepEqual(graph.nodes, nodes);
  assert.equal(graph.isValid, true);
  assert.equal("validationErrors" in graph, false);
  assert.deepEqual(result.clonedAgent.needsConfiguration, []);
});

test("the publisher's request details in an api node are not copied to the buyer, whatever the header is called", async () => {
  const world = makeWorld({
    pricingModel: "free",
    sourceAgent: { entrypoint: "graph", graph: { nodes: GRAPH_NODES, edges: GRAPH_EDGES, isValid: true } },
  });
  const result = await withWorld(world, ({ installAgent }) => installAgent(LISTING_ID, BUYER));

  const graph = world.state.agents[0]!.graph.create;
  const copied = graph.nodes[1].data.config;
  assert.deepEqual(copied.headers, {});
  assert.equal("url" in copied, false);
  assert.doesNotMatch(JSON.stringify(world.state.agents[0]), /publisher-secret|pk_live_1|prices\.example\.com/);
  // The copy is not runnable yet, and says which node and why.
  assert.equal(graph.isValid, false);
  assert.equal(graph.validationErrors.length, 1);
  assert.match(graph.validationErrors[0], /"Price feed" \(api\).*url, headers\.Authorization, headers\.X-Api-Key, headers\.Accept/);
  assert.deepEqual(result.clonedAgent.needsConfiguration, [
    {
      nodeId: "lookup",
      label: "Price feed",
      type: "api",
      fields: ["url", "headers.Authorization", "headers.X-Api-Key", "headers.Accept"],
    },
  ]);
  // The publisher's own graph is untouched.
  assert.equal(GRAPH_NODES[1]!.data.config.headers!.Authorization, "Bearer publisher-secret");
  assert.equal(GRAPH_NODES[1]!.data.config.url, "https://prices.example.com/v1/quote");
});

// A graph template cannot read the agent's variables, so a credential is a
// literal, and it can sit anywhere in the request. Each of these reached
// the buyer while only headers with a credential-sounding name were dropped.
const SECRET_PLACES: Array<[string, { type: string; config: Record<string, unknown> }]> = [
  ["the URL path", { type: "api", config: { url: "https://api.telegram.org/bot123456:AAE-secret/sendMessage" } }],
  ["the query string", { type: "api", config: { url: "https://api.example.com/v1/data?api_key=AAE-secret&q={{input | urlencode}}" } }],
  ["the URL's userinfo", { type: "api", config: { url: "https://user:AAE-secret@api.example.com/v1" } }],
  ["a header with a plain name", { type: "api", config: { url: "{{value}}", headers: { "X-Auth": "AAE-secret" } } }],
  ["a header next to a reference", { type: "api", config: { url: "{{value}}", headers: { "X-Auth": "AAE-secret {{value}}" } } }],
  ["headers that are not an object", { type: "api", config: { url: "{{value}}", headers: "X-Auth: AAE-secret" } }],
  ["the body", { type: "api", config: { url: "{{value}}", method: "POST", body: '{"key":"AAE-secret","q":"{{input}}"}' } }],
  ["something dressed as a reference", { type: "api", config: { url: "{{AAE-secret}}" } }],
  ["a code node's source", { type: "code", config: { language: "python", code: 'KEY = "AAE-secret"\nprint(KEY)' } }],
  ["an http_request tool node", { type: "tool", config: { toolName: "http_request", input: { url: "{{value}}", headers: { "X-Auth": "AAE-secret" } } } }],
  ["an http_request tool node's JSON text", { type: "tool", config: { tool: "http_request", input: '{"url":"https://hooks.example.com/AAE-secret"}' } }],
  ["a code_interpreter tool node", { type: "tool", config: { skill: "code_interpreter", input: { code: 'print("AAE-secret")' } } }],
];

for (const [place, node] of SECRET_PLACES) {
  test(`a publisher's credential in ${place} does not reach the buyer`, async () => {
    const nodes = [GRAPH_NODES[0], { id: "lookup", type: node.type, data: { label: "Call", config: node.config } }, GRAPH_NODES[2]];
    const world = makeWorld({
      pricingModel: "free",
      sourceAgent: { entrypoint: "graph", graph: { nodes, edges: GRAPH_EDGES, isValid: true } },
    });
    const result = await withWorld(world, ({ installAgent }) => installAgent(LISTING_ID, BUYER));

    assert.doesNotMatch(JSON.stringify(world.state.agents[0]), /AAE-secret/);
    assert.doesNotMatch(JSON.stringify(result), /AAE-secret/);
    const graph = world.state.agents[0]!.graph.create;
    assert.equal(graph.nodes[1].id, "lookup");
    assert.equal(graph.isValid, false);
    assert.equal(result.clonedAgent.needsConfiguration.length, 1);
    assert.equal(result.clonedAgent.needsConfiguration[0]!.nodeId, "lookup");
  });
}

test("a reinstall that reuses the buyer's copy reports nothing to configure and writes no graph", async () => {
  const world = makeWorld({
    pricingModel: "free",
    install: { status: "uninstalled", clonedAgentId: "agent_c0" },
    agents: ["agent_c0"],
    sourceAgent: { entrypoint: "graph", graph: { nodes: GRAPH_NODES, edges: GRAPH_EDGES } },
  });
  const result = await withWorld(world, ({ installAgent }) => installAgent(LISTING_ID, BUYER));
  assert.equal(result.clonedAgent.id, "agent_c0");
  assert.deepEqual(result.clonedAgent.needsConfiguration, []);
  assert.equal(world.state.agents.length, 1);
});

test("a chat agent's copy is a chat agent, and a saved but unused graph still comes along", async () => {
  const plain = makeWorld({ pricingModel: "free" });
  await withWorld(plain, ({ installAgent }) => installAgent(LISTING_ID, BUYER));
  assert.equal(plain.state.agents[0]!.entrypoint, "chat");
  assert.equal("graph" in plain.state.agents[0]!, false);

  const drafted = makeWorld({
    pricingModel: "free",
    sourceAgent: { entrypoint: "chat", graph: { nodes: GRAPH_NODES, edges: GRAPH_EDGES } },
  });
  await withWorld(drafted, ({ installAgent }) => installAgent(LISTING_ID, BUYER));
  assert.equal(drafted.state.agents[0]!.entrypoint, "chat");
  assert.equal(drafted.state.agents[0]!.graph.create.nodes.length, 3);
});

test("a graph agent listed with no graph is copied as it is: graph entrypoint, no graph", async () => {
  const world = makeWorld({ pricingModel: "free", sourceAgent: { entrypoint: "graph", graph: null } });
  await withWorld(world, ({ installAgent }) => installAgent(LISTING_ID, BUYER));
  assert.equal(world.state.agents[0]!.entrypoint, "graph");
  assert.equal("graph" in world.state.agents[0]!, false);
});

test("only text made of the interpreter's own references counts as no literal", async () => {
  const { isReferenceOnly } = await import("../services/marketplaceClone.js");
  const { renderTemplate } = await import("../services/graphInterpreter.js");
  const references = ["", "  ", "{{value}}", "{{ input }}", "{{nodes.a-1.b}}", "{{item}}{{index}}", "{{value | urlencode}} {{nodes.x|json}}"];
  for (const text of references) {
    assert.equal(isReferenceOnly(text), true, text);
    // Agreement with the interpreter: with nothing to substitute, such a
    // text renders to no literal characters of its own.
    assert.equal(renderTemplate(text, "", {}, { item: "", index: "" }).replace(/""/g, "").trim(), "", text);
  }
  const literals = ["a", "Bearer {{value}}", "{{value}}/path", "{{ env.KEY }}", "{{sk_live_1}}", "{{value | sk_live_1}}", "{value}", "{{nodes.}}"];
  for (const text of literals) {
    assert.equal(isReferenceOnly(text), false, text);
  }
  for (const notText of [undefined, null, 42, true, {}, ["{{value}}"]]) {
    assert.equal(isReferenceOnly(notText), false, String(notText));
  }
});
