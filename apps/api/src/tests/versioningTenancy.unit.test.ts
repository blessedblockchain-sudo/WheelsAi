import assert from "node:assert/strict";
import test from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

/**
 * Tenancy contract for /api/versioning.
 *
 * The route family took `agentId` straight from the URL into unscoped Prisma
 * queries — no org check in the route, the service, or anywhere between. Since
 * AgentVersion snapshots `sourceCode`, `systemPrompt`, and `env` (the agent's
 * environment variables), any authenticated user who knew an agent UUID could
 * read another org's source and secrets; rollbackToVersion's
 * `prisma.agent.update({where:{id: agentId}})` let them overwrite that org's
 * live agent config, and DELETE removed another org's version rows.
 *
 * These tests drive every endpoint in the family and pin three things:
 *   1. a foreign-org agentId is refused (404 agent_not_found), and the refusal
 *      happens BEFORE any version row is read or written
 *   2. the tenancy query always carries the caller's orgId
 *   3. a nonexistent agent is indistinguishable from a foreign one, so the
 *      API can't be used to enumerate agent IDs
 *
 * Prisma is monkey-patched rather than hit for real — same approach as the
 * sibling token-gate tests, so this runs in the no-infra unit tier.
 */

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ??
    "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}
setupEnv();

const CALLER_ORG = "org_caller";
const VICTIM_ORG = "org_victim";
const VICTIM_AGENT = "11111111-1111-1111-1111-111111111111";
const OWN_AGENT = "22222222-2222-2222-2222-222222222222";
const MISSING_AGENT = "33333333-3333-3333-3333-333333333333";

/** Which org each seeded agent belongs to. */
const AGENT_ORG: Record<string, string> = {
  [VICTIM_AGENT]: VICTIM_ORG,
  [OWN_AGENT]: CALLER_ORG,
};

type Where = { id?: string; orgId?: string };

interface Harness {
  app: FastifyInstance;
  /** Every `where` of an agent lookup or lock (findFirst, updateMany), in call order. */
  scopeQueries: Where[];
  /** Names of version-table operations reached, in call order. */
  versionOps: string[];
  restore: () => void;
}

/**
 * Register the real versioning routes over a faked prisma.
 *
 * `agent.findFirst` honors BOTH id and orgId, exactly as Postgres would — so
 * if the scoping were dropped again, the foreign-org cases below would sail
 * through into the version-table stubs and the assertions would fail.
 */
async function buildHarness(): Promise<Harness> {
  const [{ versioningRoutes }, { prisma }] = await Promise.all([
    import("../routes/versioning.js"),
    import("@wheelsai/db"),
  ]);

  const p = prisma as any;
  const original = {
    $transaction: p.$transaction,
    agent: { ...p.agent },
    agentVersion: { ...p.agentVersion },
    agentVersionDiff: { ...p.agentVersionDiff },
    agentGraph: { ...p.agentGraph },
    user: { ...p.user },
  };

  const scopeQueries: Where[] = [];
  const versionOps: string[] = [];

  const record = <T>(op: string, value: T) => {
    versionOps.push(op);
    return value;
  };

  p.agent.findFirst = async ({ where }: { where: Where }) => {
    scopeQueries.push(where);
    const owner = where.id ? AGENT_ORG[where.id] : undefined;
    if (!owner) return null;
    // Deliberately faithful to Postgres, INCLUDING the un-scoped case: an
    // absent orgId filter matches on id alone. That way dropping the scope
    // reproduces the original vulnerability inside the test — the foreign-org
    // cases below sail through into the version tables and fail on the leak
    // assertion, not merely on a missing query parameter.
    if (where.orgId !== undefined && where.orgId !== owner) return null;
    return { id: where.id, orgId: owner, name: "agent", graph: null };
  };
  p.agent.update = async () => record("agent.update", {});
  // The row lock create and rollback take first. Faithful to Postgres the same
  // way findFirst is: it matches on id, and on orgId only when one is given.
  p.agent.updateMany = async ({ where }: { where: Where }) => {
    scopeQueries.push(where);
    const owner = where.id ? AGENT_ORG[where.id] : undefined;
    if (!owner) return { count: 0 };
    if (where.orgId !== undefined && where.orgId !== owner) return { count: 0 };
    return { count: 1 };
  };
  p.$transaction = async (fn: (tx: unknown) => unknown) => fn(p);

  const VERSION_ROW = {
    id: "ver_1",
    version: "1.0.0",
    versionNumber: 1,
    isLatest: false,
    isPublished: false,
    graphNodes: null,
    graphEdges: null,
    sourceCode: null,
  };

  p.agentVersion.findMany = async () => record("agentVersion.findMany", []);
  p.agentVersion.count = async () => record("agentVersion.count", 0);
  p.agentVersion.findFirst = async () =>
    record("agentVersion.findFirst", VERSION_ROW);
  p.agentVersion.findUnique = async () =>
    record("agentVersion.findUnique", VERSION_ROW);
  p.agentVersion.create = async () => record("agentVersion.create", VERSION_ROW);
  p.agentVersion.update = async () => record("agentVersion.update", VERSION_ROW);
  p.agentVersion.updateMany = async () =>
    record("agentVersion.updateMany", { count: 0 });
  p.agentVersion.delete = async () => record("agentVersion.delete", VERSION_ROW);
  p.agentVersionDiff.findUnique = async () =>
    record("agentVersionDiff.findUnique", null);
  p.agentVersionDiff.create = async () => record("agentVersionDiff.create", {});
  p.agentVersionDiff.deleteMany = async () =>
    record("agentVersionDiff.deleteMany", { count: 0 });
  p.agentGraph.upsert = async () => record("agentGraph.upsert", {});
  p.user.findUnique = async () => ({ displayName: "Tester", email: null });

  const app = Fastify({ logger: false });
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    // Stands in for the global auth hook: an authenticated member of
    // CALLER_ORG, which is exactly the principal the old code trusted with
    // every other org's agents.
    (request as unknown as { auth: unknown }).auth = {
      userId: "user_1",
      orgId: CALLER_ORG,
      role: "owner",
      type: "jwt",
    };
  });
  await app.register(versioningRoutes, { prefix: "/api/versioning" });
  await app.ready();

  return {
    app,
    scopeQueries,
    versionOps,
    restore: () => {
      p.$transaction = original.$transaction;
      Object.assign(p.agent, original.agent);
      Object.assign(p.agentVersion, original.agentVersion);
      Object.assign(p.agentVersionDiff, original.agentVersionDiff);
      Object.assign(p.agentGraph, original.agentGraph);
      Object.assign(p.user, original.user);
    },
  };
}

/** Every endpoint in the family, parameterized by agent id. */
const ENDPOINTS: Array<{
  name: string;
  method: "GET" | "POST" | "DELETE";
  url: (agentId: string) => string;
  payload?: unknown;
}> = [
  {
    name: "POST versions (create)",
    method: "POST",
    url: (a) => `/api/versioning/agents/${a}/versions`,
    payload: { changeType: "patch" },
  },
  {
    name: "GET versions (list)",
    method: "GET",
    url: (a) => `/api/versioning/agents/${a}/versions`,
  },
  {
    name: "GET history",
    method: "GET",
    url: (a) => `/api/versioning/agents/${a}/history`,
  },
  {
    name: "GET versions/latest",
    method: "GET",
    url: (a) => `/api/versioning/agents/${a}/versions/latest`,
  },
  {
    name: "GET versions/:version",
    method: "GET",
    url: (a) => `/api/versioning/agents/${a}/versions/1.0.0`,
  },
  {
    name: "GET compare",
    method: "GET",
    url: (a) => `/api/versioning/agents/${a}/compare?from=1.0.0&to=1.0.1`,
  },
  {
    name: "POST rollback",
    method: "POST",
    url: (a) => `/api/versioning/agents/${a}/versions/1.0.0/rollback`,
    payload: {},
  },
  {
    name: "POST tag",
    method: "POST",
    url: (a) => `/api/versioning/agents/${a}/versions/1.0.0/tag`,
    payload: { tags: ["release"] },
  },
  {
    name: "POST publish",
    method: "POST",
    url: (a) => `/api/versioning/agents/${a}/versions/1.0.0/publish`,
    payload: {},
  },
  {
    name: "DELETE versions/:version",
    method: "DELETE",
    url: (a) => `/api/versioning/agents/${a}/versions/1.0.0`,
  },
];

for (const endpoint of ENDPOINTS) {
  test(`${endpoint.name}: another org's agent is 404, before any version row is touched`, async () => {
    const h = await buildHarness();
    try {
      const res = await h.app.inject({
        method: endpoint.method,
        url: endpoint.url(VICTIM_AGENT),
        payload: endpoint.payload as never,
      });

      assert.equal(res.statusCode, 404, `expected 404, got ${res.statusCode}`);
      assert.equal(res.json().error, "agent_not_found");
      // The refusal must precede every read/write against the version tables.
      assert.deepEqual(
        h.versionOps,
        [],
        `leaked version-table access: ${h.versionOps.join(", ")}`,
      );
    } finally {
      h.restore();
      await h.app.close();
    }
  });

  test(`${endpoint.name}: scopes its agent lookup by the caller's orgId`, async () => {
    const h = await buildHarness();
    try {
      await h.app.inject({
        method: endpoint.method,
        url: endpoint.url(OWN_AGENT),
        payload: endpoint.payload as never,
      });

      assert.ok(
        h.scopeQueries.length > 0,
        "no agent lookup was issued — the handler never checked tenancy",
      );
      for (const where of h.scopeQueries) {
        assert.equal(
          where.orgId,
          CALLER_ORG,
          `agent lookup missing/incorrect orgId: ${JSON.stringify(where)}`,
        );
        assert.equal(where.id, OWN_AGENT);
      }
    } finally {
      h.restore();
      await h.app.close();
    }
  });
}

test("own-org agent passes the tenancy gate and reaches the version tables", async () => {
  const h = await buildHarness();
  try {
    const res = await h.app.inject({
      method: "GET",
      url: `/api/versioning/agents/${OWN_AGENT}/versions`,
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { versions: [], total: 0 });
    assert.ok(
      h.versionOps.includes("agentVersion.findMany"),
      "same-org read should reach the version tables",
    );
  } finally {
    h.restore();
    await h.app.close();
  }
});

test("a nonexistent agent is indistinguishable from another org's agent", async () => {
  const h = await buildHarness();
  try {
    const [foreign, missing] = await Promise.all([
      h.app.inject({
        method: "GET",
        url: `/api/versioning/agents/${VICTIM_AGENT}/versions`,
      }),
      h.app.inject({
        method: "GET",
        url: `/api/versioning/agents/${MISSING_AGENT}/versions`,
      }),
    ]);

    // Same status AND same body — any divergence turns this route into an
    // existence oracle for other orgs' agent IDs.
    assert.equal(foreign.statusCode, 404);
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(foreign.json(), missing.json());
  } finally {
    h.restore();
    await h.app.close();
  }
});

test("service layer refuses a foreign org even when called directly", async () => {
  // Route-level guards can be bypassed by a future caller importing the
  // service; the check lives in the service, so assert it there too.
  const h = await buildHarness();
  try {
    const { getAgentVersion, AgentNotFoundError } = await import(
      "../services/versioning.js"
    );

    await assert.rejects(
      () => getAgentVersion({ agentId: VICTIM_AGENT, orgId: CALLER_ORG }, "1.0.0"),
      AgentNotFoundError,
    );
    assert.deepEqual(h.versionOps, []);
  } finally {
    h.restore();
    await h.app.close();
  }
});
