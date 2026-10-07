import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import sensible from "@fastify/sensible";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives routes/skills.ts - GET /skills, the catalogue the agent wizard and
// the playground's tools sidebar are built from. The contract: every skill is
// LISTED (never hidden), with `available` and a human reason when it is not.

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

async function makeApp(opts: {
  authed?: boolean;
  facts?: { hasKnowledgeBase: boolean } | null;
  env?: Record<string, string>;
}) {
  setupEnv();
  const { createSkillsRoutes } = await import("../routes/skills.js");
  const { createSkillRegistry } = await import("../services/skills/registry.js");
  const { loadSkillsConfig } = await import("../config/skills.js");

  const config = loadSkillsConfig(opts.env ?? {});
  const registry = createSkillRegistry({
    getConfig: () => ({ config, error: null }),
    getFileStore: () => null,
    getSandbox: () => null,
    knowledge: {
      loadKnowledgeBaseId: async () => null,
      search: async () => ({ results: [], mode: "keyword", fallbackReason: null }),
    },
  });

  const app = Fastify();
  await app.register(sensible);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    if (opts.authed !== false) {
      request.auth = { userId: "u1", orgId: "org_1", type: "jwt" };
    }
  });
  await app.register(
    createSkillsRoutes({
      getRegistry: () => registry,
      loadAgentFacts: async () => (opts.facts === undefined ? { hasKnowledgeBase: true } : opts.facts),
    }),
    { prefix: "/api" },
  );
  return app;
}

test("GET /api/skills requires authentication", async () => {
  const app = await makeApp({ authed: false });
  const res = await app.inject({ method: "GET", url: "/api/skills" });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test("GET /api/skills lists every skill, unconfigured ones flagged with a reason", async () => {
  const app = await makeApp({});
  const res = await app.inject({ method: "GET", url: "/api/skills" });
  assert.equal(res.statusCode, 200);
  const { skills } = res.json() as {
    skills: Array<{ key: string; available: boolean; unavailableReason: string | null; requires: string[]; moneyMoving: boolean }>;
  };

  const byKey = Object.fromEntries(skills.map((s) => [s.key, s]));
  assert.deepEqual(Object.keys(byKey).sort(), [
    "calculator",
    "code_interpreter",
    "file_read",
    "file_write",
    "http_request",
    "knowledge_search",
    "web_search",
  ]);
  assert.equal(byKey.calculator!.available, true);
  assert.equal(byKey.http_request!.available, true);
  assert.equal(byKey.web_search!.available, false);
  assert.equal(byKey.web_search!.unavailableReason, "web search is temporarily unavailable");
  assert.deepEqual(byKey.web_search!.requires, ["TAVILY_API_KEY"]);
  assert.match(byKey.code_interpreter!.unavailableReason!, /code execution is temporarily unavailable/);
  assert.match(byKey.file_read!.unavailableReason!, /file storage is temporarily unavailable/);
  assert.ok(skills.every((s) => s.moneyMoving === false));
  await app.close();
});

test("a configured provider flips its skill to available", async () => {
  const app = await makeApp({ env: { TAVILY_API_KEY: "tvly-x" } });
  const { skills } = (await app.inject({ method: "GET", url: "/api/skills" })).json() as {
    skills: Array<{ key: string; available: boolean; unavailableReason: string | null }>;
  };
  const search = skills.find((s) => s.key === "web_search")!;
  assert.equal(search.available, true);
  assert.equal(search.unavailableReason, null);
  assert.ok(!JSON.stringify(skills).includes("tvly-x"), "the key never appears in the catalogue");
  await app.close();
});

test("?agentId folds in agent-level facts: knowledge_search needs a bound knowledge base", async () => {
  const unbound = await makeApp({ facts: { hasKnowledgeBase: false } });
  const res = await unbound.inject({ method: "GET", url: `/api/skills?agentId=${AGENT_ID}` });
  const ks = (res.json() as { skills: Array<{ key: string; available: boolean; unavailableReason: string | null }> }).skills.find(
    (s) => s.key === "knowledge_search",
  )!;
  assert.equal(ks.available, false);
  assert.match(ks.unavailableReason!, /no knowledge base bound/);
  await unbound.close();

  const bound = await makeApp({ facts: { hasKnowledgeBase: true } });
  const ok = (await bound.inject({ method: "GET", url: `/api/skills?agentId=${AGENT_ID}` })).json() as {
    skills: Array<{ key: string; available: boolean }>;
  };
  assert.equal(ok.skills.find((s) => s.key === "knowledge_search")!.available, true);
  await bound.close();
});

test("?agentId for an agent outside the org is a 404, and a malformed id a 400", async () => {
  const app = await makeApp({ facts: null });
  assert.equal((await app.inject({ method: "GET", url: `/api/skills?agentId=${AGENT_ID}` })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/skills?agentId=nope" })).statusCode, 400);
  await app.close();
});
