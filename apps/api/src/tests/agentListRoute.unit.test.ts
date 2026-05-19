import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/routes/agentList.ts — paginated GET /agents for the
// dashboard list view. Each row carries enough summary state that the
// dashboard can render a useful card without a follow-up fetch:
//
//   id, name, slug, framework, createdAt
//   treasuryBalanceLamports (string for JSON safety), null if no treasury
//   activeDeploymentCount   (sum of replicas across running deployments)
//   tokenStatus             ('not_tokenized' | 'bonding' | 'graduated')

const LAMPORTS_PER_SOL = 1_000_000_000n;

type Sort = "newest" | "oldest" | "name" | "treasury_balance_desc";

interface AgentListEntry {
  id: string;
  name: string;
  slug: string;
  framework: string;
  createdAt: Date;
  treasuryBalanceLamports: bigint | null;
  activeDeploymentCount: number;
  tokenStatus: "not_tokenized" | "bonding" | "graduated";
}

function makeApp(opts: {
  authed?: boolean;
  loadAgentList?: (args: {
    orgId: string;
    limit: number;
    offset: number;
    sort: Sort;
  }) => Promise<{ agents: AgentListEntry[]; totalCount: number }>;
}) {
  setupEnv();
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    if (opts.authed !== false) {
      request.auth = { userId: "u1", orgId: "org_1", type: "jwt" };
    }
  });
  return import("../routes/agentList.js").then(async (mod) => {
    await app.register(
      mod.createAgentListRoutes({
        loadAgentList:
          opts.loadAgentList ??
          (async () => ({ agents: [], totalCount: 0 })),
      }),
    );
    return app;
  });
}

const sampleEntries: AgentListEntry[] = [
  {
    id: "agent_1",
    name: "Eliza",
    slug: "eliza",
    framework: "elizaos",
    createdAt: new Date("2026-04-25T00:00:00Z"),
    treasuryBalanceLamports: LAMPORTS_PER_SOL,
    activeDeploymentCount: 2,
    tokenStatus: "bonding",
  },
  {
    id: "agent_2",
    name: "Crewbot",
    slug: "crewbot",
    framework: "crewai",
    createdAt: new Date("2026-04-20T00:00:00Z"),
    treasuryBalanceLamports: null,
    activeDeploymentCount: 1,
    tokenStatus: "not_tokenized",
  },
];

// ============================================
// Auth + isolation
// ============================================

test("GET /agents returns 401 when unauthenticated", async () => {
  const app = await makeApp({ authed: false });
  const res = await app.inject({ method: "GET", url: "/agents" });
  assert.equal(res.statusCode, 401);
});

test("GET /agents scopes the lookup by orgId", async () => {
  let observedOrgId = "";
  const app = await makeApp({
    loadAgentList: async ({ orgId }) => {
      observedOrgId = orgId;
      return { agents: [], totalCount: 0 };
    },
  });
  await app.inject({ method: "GET", url: "/agents" });
  assert.equal(observedOrgId, "org_1");
});

// ============================================
// Empty + happy path
// ============================================

test("GET /agents returns an empty array + totalCount=0 when the org has no agents", async () => {
  const app = await makeApp({});
  const res = await app.inject({ method: "GET", url: "/agents" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.agents, []);
  assert.equal(body.totalCount, 0);
});

test("GET /agents serializes entries with BigInts as strings + Dates as ISO", async () => {
  const app = await makeApp({
    loadAgentList: async () => ({
      agents: sampleEntries,
      totalCount: 2,
    }),
  });
  const res = await app.inject({ method: "GET", url: "/agents" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.agents.length, 2);

  // Eliza: treasury balance string
  assert.equal(body.agents[0].name, "Eliza");
  assert.equal(typeof body.agents[0].treasuryBalanceLamports, "string");
  assert.equal(body.agents[0].treasuryBalanceLamports, "1000000000");
  assert.equal(body.agents[0].createdAt, "2026-04-25T00:00:00.000Z");

  // Crewbot: treasury null preserved
  assert.equal(body.agents[1].name, "Crewbot");
  assert.equal(body.agents[1].treasuryBalanceLamports, null);
  assert.equal(body.agents[1].tokenStatus, "not_tokenized");
});

test("GET /agents passes through totalCount + limit + offset for client pagination", async () => {
  const app = await makeApp({
    loadAgentList: async () => ({ agents: sampleEntries, totalCount: 42 }),
  });
  const res = await app.inject({
    method: "GET",
    url: "/agents?limit=2&offset=10",
  });
  const body = res.json();
  assert.equal(body.totalCount, 42);
  assert.equal(body.limit, 2);
  assert.equal(body.offset, 10);
});

// ============================================
// Pagination knobs
// ============================================

test("GET /agents defaults limit to 20 and offset to 0", async () => {
  let observed: any = null;
  const app = await makeApp({
    loadAgentList: async (args) => {
      observed = args;
      return { agents: [], totalCount: 0 };
    },
  });
  await app.inject({ method: "GET", url: "/agents" });
  assert.equal(observed.limit, 20);
  assert.equal(observed.offset, 0);
});

test("GET /agents honors limit + offset query params", async () => {
  let observed: any = null;
  const app = await makeApp({
    loadAgentList: async (args) => {
      observed = args;
      return { agents: [], totalCount: 0 };
    },
  });
  await app.inject({ method: "GET", url: "/agents?limit=50&offset=100" });
  assert.equal(observed.limit, 50);
  assert.equal(observed.offset, 100);
});

test("GET /agents rejects limit > 100 with 400 (bound load)", async () => {
  const app = await makeApp({});
  const res = await app.inject({ method: "GET", url: "/agents?limit=101" });
  assert.equal(res.statusCode, 400);
});

test("GET /agents rejects negative offset with 400", async () => {
  const app = await makeApp({});
  const res = await app.inject({ method: "GET", url: "/agents?offset=-5" });
  assert.equal(res.statusCode, 400);
});

test("GET /agents rejects limit=0 (non-positive) with 400", async () => {
  const app = await makeApp({});
  const res = await app.inject({ method: "GET", url: "/agents?limit=0" });
  assert.equal(res.statusCode, 400);
});

// ============================================
// Sort
// ============================================

test("GET /agents defaults sort to 'newest'", async () => {
  let observed: any = null;
  const app = await makeApp({
    loadAgentList: async (args) => {
      observed = args;
      return { agents: [], totalCount: 0 };
    },
  });
  await app.inject({ method: "GET", url: "/agents" });
  assert.equal(observed.sort, "newest");
});

test("GET /agents honors a recognized sort=oldest|name|treasury_balance_desc", async () => {
  for (const sort of ["oldest", "name", "treasury_balance_desc"] as const) {
    let observed: any = null;
    const app = await makeApp({
      loadAgentList: async (args) => {
        observed = args;
        return { agents: [], totalCount: 0 };
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `/agents?sort=${sort}`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(observed.sort, sort);
  }
});

test("GET /agents rejects an unsupported sort with 400", async () => {
  const app = await makeApp({});
  const res = await app.inject({
    method: "GET",
    url: "/agents?sort=garbage",
  });
  assert.equal(res.statusCode, 400);
});
