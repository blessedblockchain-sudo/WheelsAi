import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCustomDomainEdgeDeps,
  ISSUANCE_LOCK_KEY,
  type CustomDomainEdgePrisma,
  type IssuanceGrantTx,
} from "../services/buildCustomDomainEdgeDeps.js";
import { ISSUANCE_NAME_WINDOW_MS, ISSUANCE_PER_NAME, ISSUANCE_WINDOW_MS } from "../services/customDomainRules.js";

// services/buildCustomDomainEdgeDeps.ts over an in-memory database: what the
// host router and the certificate question read. A hostname must resolve to a
// target inside its own organization, serve only while the plan includes
// custom domains, and no query may read certificate key columns.

interface Domain {
  id: string;
  orgId: string;
  domain: string;
  verifiedDomain: string | null;
  targetType: string;
  targetId: string;
  verificationStatus: string;
  routingStatus: string;
  sslStatus: string;
  enabled: boolean;
  isActive: boolean;
  headers: unknown;
  totalRequests: number;
  lastRequestAt: Date | null;
  customKey: string;
}

function domain(over: Partial<Domain> = {}): Domain {
  return {
    id: "d1",
    orgId: "org1",
    domain: "api.customer.com",
    verifiedDomain: "api.customer.com",
    targetType: "deployment",
    targetId: "dep-1",
    verificationStatus: "verified",
    routingStatus: "ok",
    sslStatus: "active",
    enabled: true,
    isActive: true,
    headers: null,
    totalRequests: 0,
    lastRequestAt: null,
    customKey: "PRIVATE KEY MATERIAL",
    ...over,
  };
}

function memory(seed: {
  domains: Domain[];
  subscriptions?: Array<{ orgId: string; plan: string; status: string }>;
  agents?: Array<{ id: string; orgId: string; slug: string }>;
  deployments?: Array<{ id: string; orgId: string; slug: string }>;
  limits?: { issuancePerOrg: number; issuancePlatform: number };
}) {
  const db = {
    subscriptions: [{ orgId: "org1", plan: "pro", status: "active" }],
    agents: [] as Array<{ id: string; orgId: string; slug: string }>,
    deployments: [{ id: "dep-1", orgId: "org1", slug: "llama-prod" }],
    ...seed,
  };
  const queries: Array<{ model: string; args: unknown }> = [];
  const pick = (row: object, select: object) =>
    Object.fromEntries(Object.keys(select).map((key) => [key, (row as Record<string, unknown>)[key]])) as never;
  const slugModel = (name: "agents" | "deployments") => ({
    findMany: async (args: { where: { id: { in: string[] } }; select: object }) => {
      queries.push({ model: name, args });
      return db[name].filter((row) => args.where.id.in.includes(row.id)).map((row) => pick(row, args.select));
    },
    count: async (args: { where: { id: string; orgId: string } }) => {
      queries.push({ model: name, args });
      return db[name].filter((row) => row.id === args.where.id && row.orgId === args.where.orgId).length;
    },
  });
  const grants: Array<{ orgId: string; domain: string; grantedAt: Date }> = [];
  // What happened inside grant transactions, in order.
  const grantLog: string[] = [];
  let openTransactions = 0;
  const tx: IssuanceGrantTx = {
    $queryRaw: async (query, ...values) => {
      grantLog.push(`lock ${query.join("?")} ${values.join(",")}`);
    },
    customDomainIssuanceGrant: {
      count: async ({ where }) => {
        grantLog.push("count");
        // Yields, so two transactions running at once would both count before either writes.
        await new Promise((resolve) => setImmediate(resolve));
        return grants.filter(
          (g) =>
            g.grantedAt.getTime() >= where.grantedAt.gte.getTime() &&
            (where.orgId === undefined || g.orgId === where.orgId) &&
            (where.domain === undefined || g.domain === where.domain),
        ).length;
      },
      create: async ({ data }) => {
        grantLog.push("create");
        grants.push(data);
      },
      deleteMany: async ({ where }) => {
        grantLog.push("prune");
        for (let i = grants.length - 1; i >= 0; i--) {
          if (grants[i]!.grantedAt.getTime() < where.grantedAt.lt.getTime()) grants.splice(i, 1);
        }
      },
    },
  };
  const prisma: CustomDomainEdgePrisma = {
    $transaction: async (run) => {
      openTransactions += 1;
      assert.equal(openTransactions, 1, "this process runs one grant transaction at a time");
      try {
        return await run(tx);
      } finally {
        openTransactions -= 1;
      }
    },
    customDomain: {
      findMany: async (args) => {
        queries.push({ model: "customDomain", args });
        return db.domains.filter((d) => d.verifiedDomain !== null).map((d) => pick(d, args.select));
      },
      findUnique: async (args) => {
        queries.push({ model: "customDomain", args });
        const row = db.domains.find((d) => d.verifiedDomain === args.where.verifiedDomain);
        return row ? pick(row, args.select) : null;
      },
      updateMany: async (args) => {
        queries.push({ model: "customDomain", args });
        const hit = db.domains.filter((d) => d.id === args.where.id);
        for (const d of hit) {
          d.totalRequests += args.data.totalRequests.increment;
          d.lastRequestAt = args.data.lastRequestAt;
        }
        return { count: hit.length };
      },
    },
    orgSubscription: {
      findMany: async (args) => {
        queries.push({ model: "orgSubscription", args });
        return db.subscriptions.filter((s) => args.where.orgId.in.includes(s.orgId));
      },
    },
    agent: slugModel("agents"),
    deployment: slugModel("deployments"),
  };
  const limits = seed.limits ?? { issuancePerOrg: 30, issuancePlatform: 200 };
  return { deps: buildCustomDomainEdgeDeps({ prisma, limits }), db, queries, grants, grantLog };
}

test("loadRoutes: verified rows only, each with its target's slug and its serving flag", async () => {
  const { deps } = memory({
    domains: [
      domain(),
      domain({ id: "d2", domain: "chat.customer.com", verifiedDomain: "chat.customer.com", targetType: "agent", targetId: "ag-1", isActive: false }),
      // Pending claims are not routes at all.
      domain({ id: "d3", domain: "pending.customer.com", verifiedDomain: null, verificationStatus: "pending" }),
    ],
    agents: [{ id: "ag-1", orgId: "org1", slug: "support-bot" }],
  });
  assert.deepEqual(await deps.loadRoutes(), [
    { domainId: "d1", orgId: "org1", domain: "api.customer.com", targetType: "deployment", targetSlug: "llama-prod", serving: true, headers: {} },
    // Verified but not serving: present, so the prober's proof can be answered.
    { domainId: "d2", orgId: "org1", domain: "chat.customer.com", targetType: "agent", targetSlug: "support-bot", serving: false, headers: {} },
  ]);
});

test("loadRoutes: a target is only ever resolved inside the domain's own organization", async () => {
  const { deps } = memory({
    domains: [
      // Points at a deployment id that belongs to ANOTHER organization.
      domain({ targetId: "dep-theirs" }),
      // An agent id used as a deployment target.
      domain({ id: "d2", domain: "b.customer.com", verifiedDomain: "b.customer.com", targetId: "ag-1" }),
    ],
    agents: [{ id: "ag-1", orgId: "org1", slug: "support-bot" }],
    deployments: [{ id: "dep-theirs", orgId: "org2", slug: "their-secret-model" }],
  });
  for (const route of await deps.loadRoutes()) {
    assert.equal(route.targetSlug, null, route.domain);
    assert.equal(route.serving, false, route.domain);
  }
});

test("loadRoutes: a lapsed plan stops routing on the next load, whatever is_active still says", async () => {
  for (const [subscriptions, serving] of [
    [[{ orgId: "org1", plan: "pro", status: "active" }], true],
    [[{ orgId: "org1", plan: "pro", status: "trialing" }], true],
    [[{ orgId: "org1", plan: "enterprise", status: "manual" }], true],
    [[{ orgId: "org1", plan: "pro", status: "canceled" }], false],
    [[{ orgId: "org1", plan: "starter", status: "active" }], false],
    [[], false],
  ] as const) {
    const { deps } = memory({ domains: [domain()], subscriptions: [...subscriptions] });
    assert.equal((await deps.loadRoutes())[0]!.serving, serving, JSON.stringify(subscriptions));
  }
});

test("loadRoutes: stored headers are filtered again on the way out", async () => {
  const { deps } = memory({
    domains: [domain({ headers: { "X-Team": "support", "Set-Cookie": "a=b", "X-Bad": "a\r\nb" } })],
  });
  assert.deepEqual((await deps.loadRoutes())[0]!.headers, { "X-Team": "support" });
});

test("loadRoutes: one query per table however many domains, and none when there is nothing to look up", async () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    domain({ id: `d${i}`, domain: `h${i}.customer.com`, verifiedDomain: `h${i}.customer.com` }),
  );
  const { deps, queries } = memory({ domains: many });
  await deps.loadRoutes();
  assert.deepEqual(queries.map((q) => q.model).sort(), ["customDomain", "deployments", "orgSubscription"]);

  const empty = memory({ domains: [] });
  assert.deepEqual(await empty.deps.loadRoutes(), []);
  assert.deepEqual(empty.queries.map((q) => q.model), ["customDomain"]);
});

test("a failing subscription lookup fails the whole load: no route is served on a guess", async () => {
  const prismaThatFails = buildCustomDomainEdgeDeps({
    limits: { issuancePerOrg: 30, issuancePlatform: 200 },
    prisma: {
      $transaction: async () => {
        throw new Error("not used");
      },
      customDomain: {
        findMany: async () => [{ id: "d1", orgId: "org1", domain: "api.customer.com", targetType: "deployment", targetId: "dep-1", isActive: true, headers: null }],
        findUnique: async () => null,
        updateMany: async () => ({ count: 0 }),
      },
      orgSubscription: {
        findMany: async () => {
          throw new Error("subscriptions unavailable");
        },
      },
      agent: { findMany: async () => [], count: async () => 0 },
      deployment: { findMany: async () => [{ id: "dep-1", orgId: "org1", slug: "llama-prod" }], count: async () => 1 },
    },
  });
  await assert.rejects(() => prismaThatFails.loadRoutes(), /subscriptions unavailable/);
  await assert.rejects(() => prismaThatFails.isEntitled("org1"), /subscriptions unavailable/);
});

test("findVerifiedDomain looks the name up by the verified claim and never selects key material", async () => {
  const { deps, queries } = memory({
    domains: [domain(), domain({ id: "d3", orgId: "org2", domain: "api.customer.com", verifiedDomain: null, verificationStatus: "pending" })],
  });
  assert.deepEqual(await deps.findVerifiedDomain("api.customer.com"), {
    id: "d1",
    orgId: "org1",
    domain: "api.customer.com",
    targetType: "deployment",
    targetId: "dep-1",
    verificationStatus: "verified",
    routingStatus: "ok",
    sslStatus: "active",
    enabled: true,
  });
  assert.equal(await deps.findVerifiedDomain("nobody.example.org"), null);
  await deps.loadRoutes();
  for (const { args } of queries) {
    const select = (args as { select?: Record<string, unknown> }).select ?? {};
    for (const column of ["customKey", "customCert", "customCertChain", "verificationToken"]) {
      assert.equal(column in select, false, column);
    }
  }
});

test("isEntitled and targetExists answer for one organization", async () => {
  const { deps } = memory({
    domains: [],
    agents: [{ id: "ag-1", orgId: "org1", slug: "support-bot" }],
  });
  assert.equal(await deps.isEntitled("org1"), true);
  assert.equal(await deps.isEntitled("org-without-subscription"), false);

  assert.equal(await deps.targetExists({ orgId: "org1", targetType: "deployment", targetId: "dep-1" }), true);
  assert.equal(await deps.targetExists({ orgId: "org2", targetType: "deployment", targetId: "dep-1" }), false);
  assert.equal(await deps.targetExists({ orgId: "org1", targetType: "agent", targetId: "ag-1" }), true);
  assert.equal(await deps.targetExists({ orgId: "org1", targetType: "agent", targetId: "dep-1" }), false);
  assert.equal(await deps.targetExists({ orgId: "org1", targetType: "workflow", targetId: "dep-1" }), false);
});

test("increment adds to the stored count; it never sets it", async () => {
  const { deps, db } = memory({ domains: [domain({ totalRequests: 40 })] });
  const at = new Date("2026-10-06T12:00:00Z");
  await deps.increment({ domainId: "d1", count: 3, lastRequestAt: at });
  await deps.increment({ domainId: "d1", count: 2, lastRequestAt: at });
  assert.equal(db.domains[0]!.totalRequests, 45);
  assert.equal(db.domains[0]!.lastRequestAt, at);
  // A domain deleted in the meantime: nothing to add to, and no error.
  await deps.increment({ domainId: "gone", count: 9, lastRequestAt: at });
});

// ---------------------------------------------------------------------------
// The issuance budget
// ---------------------------------------------------------------------------

const T0 = new Date("2026-10-06T12:00:00Z");
const after = (ms: number) => new Date(T0.getTime() + ms);

test("grantIssuance: one organization cannot spend more than its share, whatever names it uses", async () => {
  const { deps, grants } = memory({ domains: [], limits: { issuancePerOrg: 3, issuancePlatform: 200 } });
  const answers = [];
  for (let i = 0; i < 5; i++) {
    answers.push(await deps.grantIssuance({ orgId: "attacker", domain: `a${i}.evil.com`, now: after(i * 1000) }));
  }
  assert.deepEqual(answers, [
    { granted: true },
    { granted: true },
    { granted: true },
    { granted: false, reason: "issuance_budget_organization" },
    { granted: false, reason: "issuance_budget_organization" },
  ]);
  // A refusal records nothing, and another organization is not affected.
  assert.equal(grants.length, 3);
  assert.deepEqual(await deps.grantIssuance({ orgId: "org1", domain: "api.customer.com", now: after(9000) }), {
    granted: true,
  });

  // The window slides: three hours after its first grant the organization has room again.
  assert.deepEqual(
    await deps.grantIssuance({ orgId: "attacker", domain: "a9.evil.com", now: after(ISSUANCE_WINDOW_MS - 1) }),
    { granted: false, reason: "issuance_budget_organization" },
  );
  assert.deepEqual(
    await deps.grantIssuance({ orgId: "attacker", domain: "a9.evil.com", now: after(ISSUANCE_WINDOW_MS + 1) }),
    { granted: true },
  );
});

test("grantIssuance: the platform's budget holds across organizations", async () => {
  const { deps, grants } = memory({ domains: [], limits: { issuancePerOrg: 2, issuancePlatform: 5 } });
  const granted = [];
  for (let i = 0; i < 8; i++) {
    granted.push(await deps.grantIssuance({ orgId: `org${i % 4}`, domain: `n${i}.example.net`, now: after(i) }));
  }
  assert.equal(granted.filter((g) => g.granted).length, 5);
  assert.deepEqual(granted[5], { granted: false, reason: "issuance_budget_platform" });
  assert.equal(grants.length, 5);
});

test("grantIssuance: one name is granted at most five times an hour", async () => {
  const { deps } = memory({ domains: [] });
  const ask = (ms: number) => deps.grantIssuance({ orgId: "org1", domain: "api.customer.com", now: after(ms) });
  for (let i = 0; i < ISSUANCE_PER_NAME; i++) assert.deepEqual(await ask(i), { granted: true });
  assert.deepEqual(await ask(10), { granted: false, reason: "issuance_budget_domain" });
  assert.deepEqual(await ask(ISSUANCE_NAME_WINDOW_MS + 10), { granted: true });
});

test("grantIssuance: a burst of questions at once is counted one by one, under the lock", async () => {
  const { deps, grants, grantLog } = memory({ domains: [], limits: { issuancePerOrg: 4, issuancePlatform: 200 } });
  // 300 handshakes for 300 fresh names arriving together: if each counted
  // before any recorded, every one of them would see room.
  const answers = await Promise.all(
    Array.from({ length: 300 }, (_, i) =>
      deps.grantIssuance({ orgId: "attacker", domain: `a${i}.evil.com`, now: after(i) }),
    ),
  );
  assert.equal(answers.filter((a) => a.granted).length, 4);
  assert.equal(grants.length, 4);

  // Each transaction takes the lock before it counts, and counts before it writes.
  assert.match(grantLog[0]!, /^lock SELECT pg_advisory_xact_lock\(hashtext\(\?\)\)::text /);
  assert.ok(grantLog[0]!.endsWith(ISSUANCE_LOCK_KEY));
  assert.deepEqual(grantLog.slice(1, 6), ["count", "count", "count", "create", "prune"]);
  assert.equal(grantLog.filter((entry) => entry.startsWith("lock")).length, 300);
});

test("grantIssuance: a failed transaction is an error, and the next grant still runs", async () => {
  const { deps, grants } = memory({ domains: [] });
  const original = Array.prototype.push;
  // The first create fails; nothing is recorded and the caller sees the error.
  let failed = false;
  grants.push = function (...items) {
    if (!failed) {
      failed = true;
      throw new Error("write failed");
    }
    return original.apply(this, items);
  };
  await assert.rejects(() => deps.grantIssuance({ orgId: "org1", domain: "api.customer.com", now: T0 }), /write failed/);
  assert.deepEqual(await deps.grantIssuance({ orgId: "org1", domain: "api.customer.com", now: T0 }), { granted: true });
  assert.equal(grants.length, 1);
});

test("grantIssuance: grants older than a day are removed when a new one is recorded", async () => {
  const { deps, grants } = memory({ domains: [] });
  await deps.grantIssuance({ orgId: "org1", domain: "old.customer.com", now: T0 });
  await deps.grantIssuance({ orgId: "org1", domain: "new.customer.com", now: after(25 * 60 * 60_000) });
  assert.deepEqual(grants.map((g) => g.domain), ["new.customer.com"]);
});
