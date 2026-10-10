import assert from "node:assert/strict";
import test from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

/**
 * Who a version is attributed to, and whether rollback is all-or-nothing.
 *
 * An API key has no user behind it (request.auth.userId is null), and the
 * routes used to pass "" as the author's user id. Creating a version with a
 * key therefore failed on the author column, and rollback failed the same way
 * AFTER it had overwritten the live agent, leaving it rolled back with no
 * version recording that.
 *
 * Prisma is replaced by a small in-memory store whose $transaction restores
 * the store when the callback throws, as Postgres would. Every write is also
 * checked to have happened inside a transaction.
 */

process.env.NODE_ENV ??= "development";
process.env.LOG_LEVEL ??= "error";
process.env.DATABASE_URL ??= "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET ??= "12345678901234567890123456789012";

const ORG = "org_caller";
const OTHER_ORG = "org_other";
const AGENT = "22222222-2222-2222-2222-222222222222";
const KEY_ID = "99999999-9999-4999-8999-999999999999";
const USER_ID = "55555555-5555-4555-8555-555555555555";

const KEY_PRINCIPAL = {
  userId: null,
  orgId: ORG,
  type: "api_key",
  scopes: ["*"],
  apiKeyId: KEY_ID,
  apiKeyName: "CI",
  apiKeyPrefix: "wheels_live_abcd",
};
const USER_PRINCIPAL = { userId: USER_ID, orgId: ORG, type: "jwt", role: "member" };

interface Store {
  agent: Record<string, any>;
  graph: Record<string, any> | null;
  versions: Array<Record<string, any>>;
  diffs: Array<Record<string, any>>;
}

function seed(): Store {
  const snapshot = {
    name: "Agent",
    description: null,
    framework: "mastra",
    tools: [],
    modelConfig: {},
    sourceType: "inline",
    sourceUrl: null,
    sourceCode: null,
    env: {},
    graphNodes: null,
    graphEdges: null,
  };
  return {
    agent: { id: AGENT, orgId: ORG, ...snapshot, systemPrompt: "new prompt", version: "1.0.1" },
    graph: null,
    versions: [
      { ...snapshot, agentId: AGENT, version: "1.0.0", versionNumber: 1, systemPrompt: "old prompt", isLatest: false },
      { ...snapshot, agentId: AGENT, version: "1.0.1", versionNumber: 2, systemPrompt: "new prompt", isLatest: true },
    ],
    diffs: [],
  };
}

async function buildHarness(
  principal: unknown,
  opts: { failVersionCreate?: boolean; arrange?: (store: Store) => void } = {},
) {
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
    orgSubscription: p.orgSubscription,
    agentListing: p.agentListing,
  };
  // No listing sells use of this agent: a rollback to a graph reads that
  // before it writes (versioningOnSale.unit.test.ts).
  p.agentListing = { findFirst: async () => null };
  // An API-key write is metered (requireAuth -> meterApiCall -> getOrgPlan).
  // Enterprise has no call cap, so the meter needs neither a database nor Redis.
  p.orgSubscription = { findUnique: async () => ({ plan: "enterprise", status: "active" }) };

  let store = seed();
  opts.arrange?.(store);
  let inTx = false;
  const writesOutsideTx: string[] = [];
  const userLookups: string[] = [];
  const write = (op: string) => {
    if (!inTx) writesOutsideTx.push(op);
  };
  const inOrg = (where: any) =>
    where.id === store.agent.id && (where.orgId === undefined || where.orgId === store.agent.orgId);

  p.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    const before = structuredClone(store);
    inTx = true;
    try {
      return await fn(p);
    } catch (error) {
      store = before;
      throw error;
    } finally {
      inTx = false;
    }
  };
  p.agent.findFirst = async ({ where }: any) =>
    inOrg(where) ? { ...store.agent, graph: store.graph } : null;
  p.agent.updateMany = async ({ where }: any) => {
    write("agent.updateMany");
    return { count: inOrg(where) ? 1 : 0 };
  };
  p.agent.update = async ({ data }: any) => {
    write("agent.update");
    Object.assign(store.agent, data);
    return store.agent;
  };
  p.agentGraph.upsert = async ({ create }: any) => {
    write("agentGraph.upsert");
    store.graph = { nodes: create.nodes, edges: create.edges };
    return store.graph;
  };
  p.agentVersion.findFirst = async () =>
    [...store.versions].sort((a, b) => b.versionNumber - a.versionNumber)[0] ?? null;
  p.agentVersion.findUnique = async ({ where }: any) =>
    store.versions.find((v) => v.version === where.agentId_version.version) ?? null;
  p.agentVersion.updateMany = async ({ data }: any) => {
    write("agentVersion.updateMany");
    for (const v of store.versions) if (v.isLatest) Object.assign(v, data);
    return { count: 1 };
  };
  p.agentVersion.create = async ({ data }: any) => {
    write("agentVersion.create");
    if (opts.failVersionCreate) throw new Error("insert failed");
    store.versions.push(data);
    return data;
  };
  p.agentVersionDiff.create = async ({ data }: any) => {
    write("agentVersionDiff.create");
    store.diffs.push(data);
    return data;
  };
  p.user.findUnique = async ({ where }: any) => {
    userLookups.push(where.id);
    return { displayName: "Ada", email: "ada@example.com" };
  };

  const app: FastifyInstance = Fastify({ logger: false });
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as unknown as { auth: unknown }).auth = principal;
  });
  await app.register(versioningRoutes, { prefix: "/api/versioning" });
  await app.ready();

  return {
    app,
    store: () => store,
    writesOutsideTx,
    userLookups,
    restore: async () => {
      p.$transaction = original.$transaction;
      Object.assign(p.agent, original.agent);
      Object.assign(p.agentVersion, original.agentVersion);
      Object.assign(p.agentVersionDiff, original.agentVersionDiff);
      Object.assign(p.agentGraph, original.agentGraph);
      Object.assign(p.user, original.user);
      p.orgSubscription = original.orgSubscription;
      p.agentListing = original.agentListing;
      await app.close();
    },
  };
}

const CREATE = `/api/versioning/agents/${AGENT}/versions`;
const ROLLBACK = `/api/versioning/agents/${AGENT}/versions/1.0.0/rollback`;

test("an API key can create a version, recorded as that key and not as a user", async () => {
  const h = await buildHarness(KEY_PRINCIPAL);
  try {
    const res = await h.app.inject({ method: "POST", url: CREATE, payload: { changeType: "minor" } });
    assert.equal(res.statusCode, 201, res.body);
    const created = h.store().versions.at(-1)!;
    assert.equal(created.version, "1.1.0");
    assert.equal(created.createdById, null);
    assert.equal(created.createdByApiKeyId, KEY_ID);
    assert.equal(created.createdByName, "API key (CI)");
    assert.equal(created.isLatest, true);
    assert.deepEqual(h.userLookups, [], "no user is looked up for a key");
    assert.deepEqual(h.writesOutsideTx, []);
  } finally {
    await h.restore();
  }
});

test("an unnamed API key is recorded by its prefix", async () => {
  const h = await buildHarness({ ...KEY_PRINCIPAL, apiKeyName: null });
  try {
    const res = await h.app.inject({ method: "POST", url: CREATE, payload: {} });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(h.store().versions.at(-1)!.createdByName, "API key (wheels_live_abcd)");
  } finally {
    await h.restore();
  }
});

test("a signed-in user's version is still recorded as that user", async () => {
  const h = await buildHarness(USER_PRINCIPAL);
  try {
    const res = await h.app.inject({ method: "POST", url: CREATE, payload: {} });
    assert.equal(res.statusCode, 201, res.body);
    const created = h.store().versions.at(-1)!;
    assert.equal(created.createdById, USER_ID);
    assert.equal(created.createdByApiKeyId, null);
    assert.equal(created.createdByName, "Ada");
    assert.deepEqual(h.userLookups, [USER_ID]);
  } finally {
    await h.restore();
  }
});

test("a caller cannot choose the author name through the request body", async () => {
  const h = await buildHarness(KEY_PRINCIPAL);
  try {
    const res = await h.app.inject({
      method: "POST",
      url: CREATE,
      payload: { createdByName: "The Owner", createdById: USER_ID },
    });
    assert.equal(res.statusCode, 201, res.body);
    const created = h.store().versions.at(-1)!;
    assert.equal(created.createdByName, "API key (CI)");
    assert.equal(created.createdById, null);
  } finally {
    await h.restore();
  }
});

test("an unknown changeType is refused before anything is written", async () => {
  const h = await buildHarness(KEY_PRINCIPAL);
  try {
    const res = await h.app.inject({ method: "POST", url: CREATE, payload: { changeType: "huge" } });
    assert.equal(res.statusCode, 400);
    assert.equal(h.store().versions.length, 2);
  } finally {
    await h.restore();
  }
});

test("an API key can roll back: the agent is restored and the rollback is recorded as the key's", async () => {
  const h = await buildHarness(KEY_PRINCIPAL);
  try {
    const res = await h.app.inject({ method: "POST", url: ROLLBACK, payload: {} });
    assert.equal(res.statusCode, 200, res.body);
    const s = h.store();
    assert.equal(s.agent.systemPrompt, "old prompt");
    const recorded = s.versions.at(-1)!;
    assert.equal(recorded.version, "1.0.2");
    assert.equal(recorded.systemPrompt, "old prompt");
    assert.deepEqual(recorded.tags, ["rollback"]);
    assert.equal(recorded.createdByApiKeyId, KEY_ID);
    assert.equal(recorded.createdById, null);
    assert.equal(s.agent.version, "1.0.2");
    assert.equal(s.versions.filter((v) => v.isLatest).length, 1);
    assert.deepEqual(h.writesOutsideTx, []);
  } finally {
    await h.restore();
  }
});

test("rollback is atomic: when recording the version fails, the agent is left as it was", async () => {
  const h = await buildHarness(KEY_PRINCIPAL, { failVersionCreate: true });
  try {
    const res = await h.app.inject({ method: "POST", url: ROLLBACK, payload: {} });
    assert.equal(res.statusCode, 400);
    const s = h.store();
    assert.equal(s.agent.systemPrompt, "new prompt");
    assert.equal(s.agent.version, "1.0.1");
    assert.equal(s.versions.length, 2);
    assert.equal(s.versions.find((v) => v.version === "1.0.1")!.isLatest, true);
    // The rollback only holds if no write escaped the transaction.
    assert.deepEqual(h.writesOutsideTx, []);
  } finally {
    await h.restore();
  }
});

test("create is atomic: a failed insert does not leave the agent without a latest version", async () => {
  const h = await buildHarness(USER_PRINCIPAL, { failVersionCreate: true });
  try {
    const res = await h.app.inject({ method: "POST", url: CREATE, payload: {} });
    assert.equal(res.statusCode, 400);
    assert.equal(h.store().versions.filter((v) => v.isLatest).length, 1);
    assert.deepEqual(h.writesOutsideTx, []);
  } finally {
    await h.restore();
  }
});

test("rolling back to a version that does not exist changes nothing", async () => {
  const h = await buildHarness(KEY_PRINCIPAL);
  try {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/versioning/agents/${AGENT}/versions/9.9.9/rollback`,
      payload: {},
    });
    assert.equal(res.statusCode, 400);
    assert.equal(h.store().agent.systemPrompt, "new prompt");
    assert.equal(h.store().versions.length, 2);
  } finally {
    await h.restore();
  }
});

test("a key from another org cannot create or roll back: 404 and nothing written", async () => {
  const h = await buildHarness({ ...KEY_PRINCIPAL, orgId: OTHER_ORG });
  try {
    for (const url of [CREATE, ROLLBACK]) {
      const res = await h.app.inject({ method: "POST", url, payload: {} });
      assert.equal(res.statusCode, 404);
      assert.equal(res.json().error, "agent_not_found");
    }
    assert.equal(h.store().agent.systemPrompt, "new prompt");
    assert.equal(h.store().versions.length, 2);
  } finally {
    await h.restore();
  }
});

test("a principal with no identity to record is refused, not attributed to a blank user", async () => {
  const h = await buildHarness({ userId: null, orgId: ORG, type: "api_key", scopes: ["*"] });
  try {
    for (const url of [CREATE, ROLLBACK]) {
      const res = await h.app.inject({ method: "POST", url, payload: {} });
      assert.equal(res.statusCode, 401);
    }
    assert.equal(h.store().agent.systemPrompt, "new prompt");
    assert.equal(h.store().versions.length, 2);
  } finally {
    await h.restore();
  }
});

// ============================================
// The entrypoint is part of a version
// ============================================

const NODES = [{ id: "in", type: "input" }, { id: "llm", type: "llm" }];
const EDGES = [{ id: "e1", source: "in", target: "llm" }];

test("a version records whether the agent answers as a chat or through its graph", async () => {
  const chat = await buildHarness(USER_PRINCIPAL);
  try {
    await chat.app.inject({ method: "POST", url: CREATE, payload: {} });
    assert.equal(chat.store().versions.at(-1)!.entrypoint, "chat");
  } finally {
    await chat.restore();
  }

  const graph = await buildHarness(USER_PRINCIPAL, {
    arrange: (store) => {
      store.agent.entrypoint = "graph";
      store.graph = { nodes: NODES, edges: EDGES };
    },
  });
  try {
    const res = await graph.app.inject({ method: "POST", url: CREATE, payload: {} });
    assert.equal(res.statusCode, 201, res.body);
    const created = graph.store().versions.at(-1)!;
    assert.equal(created.entrypoint, "graph");
    assert.deepEqual(created.graphNodes, NODES);
  } finally {
    await graph.restore();
  }
});

test("rolling back to a graph version restores the graph entrypoint with the graph", async () => {
  const h = await buildHarness(USER_PRINCIPAL, {
    arrange: (store) => {
      // 1.0.0 answered through its graph; the agent was since switched to chat.
      Object.assign(store.versions[0]!, { entrypoint: "graph", graphNodes: NODES, graphEdges: EDGES });
      store.versions[1]!.entrypoint = "chat";
      store.agent.entrypoint = "chat";
    },
  });
  try {
    const res = await h.app.inject({ method: "POST", url: ROLLBACK, payload: {} });
    assert.equal(res.statusCode, 200, res.body);
    const s = h.store();
    assert.equal(s.agent.entrypoint, "graph");
    assert.deepEqual(s.graph, { nodes: NODES, edges: EDGES });
    // The version that records the rollback carries it too, and the diff says so.
    assert.equal(s.versions.at(-1)!.entrypoint, "graph");
    assert.deepEqual(s.diffs.at(-1)!.changes.entrypoint, { from: "chat", to: "graph" });
    assert.deepEqual(h.writesOutsideTx, []);
  } finally {
    await h.restore();
  }
});

test("rolling back to a chat version switches a graph agent back to chat", async () => {
  const h = await buildHarness(USER_PRINCIPAL, {
    arrange: (store) => {
      store.versions[0]!.entrypoint = "chat";
      store.versions[1]!.entrypoint = "graph";
      store.agent.entrypoint = "graph";
      store.graph = { nodes: NODES, edges: EDGES };
    },
  });
  try {
    const res = await h.app.inject({ method: "POST", url: ROLLBACK, payload: {} });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(h.store().agent.entrypoint, "chat");
    assert.equal(h.store().versions.at(-1)!.entrypoint, "chat");
  } finally {
    await h.restore();
  }
});

test("a version taken before the entrypoint was recorded leaves the agent's entrypoint alone", async () => {
  const h = await buildHarness(USER_PRINCIPAL, {
    arrange: (store) => {
      store.versions[0]!.entrypoint = null;
      store.agent.entrypoint = "graph";
      store.graph = { nodes: NODES, edges: EDGES };
    },
  });
  try {
    const res = await h.app.inject({ method: "POST", url: ROLLBACK, payload: {} });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(h.store().agent.entrypoint, "graph");
    assert.equal(h.store().agent.systemPrompt, "old prompt");
  } finally {
    await h.restore();
  }
});
