import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV ??= "development";
process.env.LOG_LEVEL ??= "error";
process.env.DATABASE_URL ??= "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET ??= "12345678901234567890123456789012";

// Agent env vars hold provider keys and bot tokens. Before this they were
// stored in plaintext, returned in full by GET /api/agents/:id, copied into
// every buyer's org on marketplace install, and snapshotted in plaintext.

const secrets = await import("../services/agentSecrets.js");

test("sealed env round-trips and never stores a value in the clear", () => {
  const sealed = secrets.sealAgentEnv({ OPENAI_API_KEY: "sk-live-abc123", FLAG: "true" });
  assert.deepEqual(sealed.keys, ["FLAG", "OPENAI_API_KEY"]);
  assert.ok(!JSON.stringify(sealed).includes("sk-live-abc123"));
  assert.deepEqual(secrets.openAgentEnv(sealed), { OPENAI_API_KEY: "sk-live-abc123", FLAG: "true" });
});

test("legacy plaintext rows still open, and nulls/garbage open to empty", () => {
  assert.deepEqual(secrets.openAgentEnv({ A: "1", B: 2, C: true, D: { x: 1 } }), {
    A: "1",
    B: "2",
    C: "true",
  });
  assert.deepEqual(secrets.openAgentEnv(null), {});
  assert.deepEqual(secrets.openAgentEnv(undefined), {});
  assert.deepEqual(secrets.openAgentEnv("nope"), {});
});

test("a tampered ciphertext fails closed instead of returning garbage", () => {
  const sealed = secrets.sealAgentEnv({ K: "v" });
  const parts = sealed.__sealed.split(":");
  const flipped = parts[2]!.startsWith("0") ? `1${parts[2]!.slice(1)}` : `0${parts[2]!.slice(1)}`;
  assert.throws(() => secrets.openAgentEnv({ ...sealed, __sealed: `${parts[0]}:${parts[1]}:${flipped}` }));
});

test("PATCH merge: strings set, null deletes, unmentioned keys survive", () => {
  const start = secrets.sealAgentEnv({ KEEP: "k", REPLACE: "old", DROP: "d" });
  const next = secrets.mergeAgentEnv(start, { REPLACE: "new", DROP: null, ADD: "a" });
  assert.deepEqual(secrets.openAgentEnv(next), { KEEP: "k", REPLACE: "new", ADD: "a" });
});

test("redaction exposes names only", () => {
  const red = secrets.redactAgentEnv(secrets.sealAgentEnv({ SECRET: "shh" }));
  assert.deepEqual(red, { keys: ["SECRET"] });
  assert.deepEqual(secrets.redactAgentEnv({ LEGACY: "plain" }), { keys: ["LEGACY"] });
});

test("openclaw channel configs keep their on-disk format through the shared helper", async () => {
  const { encryptConfig, decryptConfig } = await import("../services/openclaw.js");
  const cipher = encryptConfig({ botToken: "t" });
  assert.equal(cipher.split(":").length, 3);
  assert.deepEqual(decryptConfig(cipher), { botToken: "t" });
});

async function agentsAppWith(prismaAgent: Record<string, unknown>) {
  const { prisma } = await import("@wheelsai/db");
  const saved = (prisma as any).agent;
  (prisma as any).agent = prismaAgent;
  const Fastify = (await import("fastify")).default;
  const sensible = await import("@fastify/sensible");
  const { agentRoutes } = await import("../routes/agents.js");
  const app = Fastify();
  await app.register(sensible.default);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as unknown as { auth: unknown }).auth = {
      userId: "u1",
      orgId: "0f1e2d3c-4b5a-4968-8776-655443322110",
      type: "jwt",
      role: "owner",
    };
  });
  await app.register(agentRoutes);
  return { app, restore: () => ((prisma as any).agent = saved) };
}

const AGENT_ID = "11111111-2222-4333-8444-555555555555";

test("GET /:agentId returns variable names, never values", async () => {
  const row = {
    id: AGENT_ID,
    name: "a",
    env: secrets.sealAgentEnv({ OPENAI_API_KEY: "sk-live-abc123" }),
    deployments: [],
  };
  const { app, restore } = await agentsAppWith({ findFirst: async () => row });
  try {
    const res = await app.inject({ method: "GET", url: `/${AGENT_ID}` });
    assert.equal(res.statusCode, 200);
    assert.ok(!res.body.includes("sk-live-abc123"));
    assert.ok(!res.body.includes("__sealed"));
    assert.deepEqual(res.json().agent.env, { keys: ["OPENAI_API_KEY"] });
  } finally {
    restore();
  }
});

test("PATCH merges env and stores it sealed", async () => {
  let written: any;
  const row = {
    id: AGENT_ID,
    name: "a",
    version: "1.0.0",
    modelConfig: {},
    env: secrets.sealAgentEnv({ KEEP: "k" }),
  };
  const { app, restore } = await agentsAppWith({
    findFirst: async () => row,
    update: async ({ data }: any) => {
      written = data;
      return { ...row, ...data };
    },
  });
  try {
    const res = await app.inject({
      method: "PATCH",
      url: `/${AGENT_ID}`,
      payload: { env: { NEW_KEY: "sk-new" } },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(secrets.isSealedAgentEnv(written.env));
    assert.deepEqual(secrets.openAgentEnv(written.env), { KEEP: "k", NEW_KEY: "sk-new" });
    assert.ok(!res.body.includes("sk-new"));
    assert.deepEqual(res.json().agent.env, { keys: ["KEEP", "NEW_KEY"] });
  } finally {
    restore();
  }
});

test("marketplace install never copies the publisher's env into the buyer's org", async () => {
  const { prisma } = await import("@wheelsai/db");
  const p = prisma as any;
  const saved = {
    agentListing: p.agentListing,
    agentInstall: p.agentInstall,
    agent: p.agent,
    publisherProfile: p.publisherProfile,
    $transaction: p.$transaction,
  };
  let createdAgentData: any;
  p.$transaction = async (fn: (tx: any) => unknown) => fn(p);
  p.agentListing = {
    findUnique: async () => ({
      id: "l1",
      status: "published",
      publisherId: "pub-org",
      agent: {
        name: "Pub",
        slug: "pub",
        framework: "custom",
        tools: [],
        modelConfig: {},
        sourceType: "inline",
        version: "1.0.0",
        tags: [],
        env: secrets.sealAgentEnv({ OPENAI_API_KEY: "sk-publisher-secret" }),
      },
    }),
    update: async () => ({}),
    aggregate: async () => ({ _sum: {}, _avg: {}, _count: 0 }),
    count: async () => 0,
    findMany: async () => [],
  };
  p.agentInstall = {
    findUnique: async () => null,
    create: async ({ data }: any) => ({ id: "i1", ...data }),
  };
  p.agent = {
    create: async ({ data }: any) => {
      createdAgentData = data;
      return { id: "clone", name: data.name, slug: data.slug };
    },
  };
  p.publisherProfile = { update: async () => ({}), upsert: async () => ({}), findUnique: async () => null };
  try {
    const { installAgent } = await import("../services/marketplace.js");
    await installAgent("l1", "buyer-org").catch(() => undefined); // stats helpers may fail on stubs
    assert.ok(createdAgentData, "clone was created");
    assert.equal("env" in createdAgentData, false);
    assert.ok(!JSON.stringify(createdAgentData).includes("sk-publisher-secret"));
  } finally {
    Object.assign(p, saved);
  }
});
