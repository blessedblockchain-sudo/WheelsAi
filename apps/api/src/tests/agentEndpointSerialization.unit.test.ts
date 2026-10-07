import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Env must be in place BEFORE the route module (and config/env.ts) is imported.
process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";

import sensible from "@fastify/sensible";
import Fastify, { type FastifyInstance } from "fastify";

// The agent endpoint used to be `https://agents.wheelsai.io/<slug>`: a host
// nothing serves, written onto the deployment row at submit time and returned
// verbatim. These tests drive the real agent read routes and pin that the
// endpoint is now computed from PUBLIC_API_URL - and that the old value, which
// existing rows still hold until the migration runs, can never come back out.

const ORG = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const DEPLOYMENT_ID = "33333333-3333-4333-8333-333333333333";
const FABRICATED = "https://agents.wheelsai.io/support-bot";
const BASE = "https://api.example.test/";

const deployment = (status: string, id = DEPLOYMENT_ID) => ({
  id,
  agentId: AGENT_ID,
  status,
  endpoint: FABRICATED,
  gpuTier: "rtx-3060",
  replicas: 1,
  nosanaJobIds: ["job-1"],
  createdAt: new Date("2026-10-01T00:00:00Z"),
});

const agentRow = (deployments: Array<ReturnType<typeof deployment>>) => ({
  id: AGENT_ID,
  orgId: ORG,
  name: "Support Bot",
  slug: "support-bot",
  description: null,
  framework: "mastra",
  version: "1.0.0",
  tags: [],
  isPublic: false,
  env: null,
  secrets: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
  deployments,
});

async function buildApp(
  deployments: Array<ReturnType<typeof deployment>>,
  publicApiUrl: string | null = BASE,
): Promise<FastifyInstance> {
  const { createAgentRoutes } = await import("../routes/agents.js");
  const row = agentRow(deployments);
  const scoped = (where: { orgId?: string; id?: string }) =>
    where.orgId === ORG && (where.id === undefined || where.id === AGENT_ID);
  const app = Fastify();
  await app.register(sensible);
  await app.register(
    createAgentRoutes({
      requireAuth: async (request) => {
        (request as { auth?: unknown }).auth = { orgId: ORG, userId: "user-1" };
      },
      publicApiUrl: () => publicApiUrl ?? undefined,
      prisma: {
        agent: {
          findMany: async ({ where }: any) => (scoped(where) ? [row] : []),
          findFirst: async ({ where }: any) => (scoped(where) ? row : null),
        },
        agentDeployment: {
          findFirst: async ({ where }: any) => deployments.find((d) => d.id === where.id) ?? null,
        },
      } as never,
    }),
    { prefix: "/api/agents" },
  );
  await app.ready();
  return app;
}

const ENDPOINT = "https://api.example.test/v1/agents/support-bot/chat/completions";

test("a running agent deployment shows the /v1 agent endpoint; any other status shows null", async () => {
  for (const status of ["pending", "building", "deploying", "running", "stopped", "failed"]) {
    const app = await buildApp([deployment(status)]);
    const expected = status === "running" ? ENDPOINT : null;

    const one = await app.inject({ method: "GET", url: `/api/agents/${AGENT_ID}/deployments/${DEPLOYMENT_ID}` });
    assert.equal(one.statusCode, 200);
    assert.equal(one.json().deployment.endpoint, expected, `deployment route, ${status}`);

    const list = await app.inject({ method: "GET", url: "/api/agents" });
    assert.equal(list.json().agents[0].latestDeployment.endpoint, expected, `list, ${status}`);

    const detail = await app.inject({ method: "GET", url: `/api/agents/${AGENT_ID}` });
    assert.equal(detail.json().agent.deployments[0].endpoint, expected, `detail, ${status}`);

    for (const res of [one, list, detail]) {
      assert.ok(!res.body.includes("agents.wheelsai.io"), "the stored fabricated value never leaves the API");
    }
    await app.close();
  }
});

test("GET /api/agents/:id carries apiEndpoint, openaiBaseUrl and openaiModel", async () => {
  // With NO deployment at all: the agent's API is served by this platform
  // and does not wait for a GPU.
  const app = await buildApp([]);
  const expected = {
    apiEndpoint: ENDPOINT,
    openaiBaseUrl: "https://api.example.test/v1/agents/support-bot",
    openaiModel: "agent/support-bot",
  };

  const detail = (await app.inject({ method: "GET", url: `/api/agents/${AGENT_ID}` })).json().agent;
  assert.deepEqual(
    { apiEndpoint: detail.apiEndpoint, openaiBaseUrl: detail.openaiBaseUrl, openaiModel: detail.openaiModel },
    expected,
  );
  assert.deepEqual(detail.deployments, []);

  const listed = (await app.inject({ method: "GET", url: "/api/agents" })).json().agents[0];
  assert.deepEqual(
    { apiEndpoint: listed.apiEndpoint, openaiBaseUrl: listed.openaiBaseUrl, openaiModel: listed.openaiModel },
    expected,
  );
  assert.equal(listed.latestDeployment, null);
  await app.close();
});

test("without PUBLIC_API_URL the API returns no endpoint rather than inventing one", async () => {
  const app = await buildApp([deployment("running")], null);
  const detail = (await app.inject({ method: "GET", url: `/api/agents/${AGENT_ID}` })).json().agent;
  assert.equal(detail.apiEndpoint, null);
  assert.equal(detail.openaiBaseUrl, null);
  assert.equal(detail.openaiModel, "agent/support-bot");
  assert.equal(detail.deployments[0].endpoint, null);
  await app.close();
});

// ============================================
// Source pins
// ============================================

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(SRC, relative), "utf8");

test("routes/agents.ts never writes or contains wheelsai.io", () => {
  const routes = source("routes/agents.ts");
  assert.doesNotMatch(routes, /wheelsai\.io/);
  assert.doesNotMatch(routes, /endpoint:\s*`/, "no endpoint is assembled from a template in the route");
  // The submit step stores the job id and the access mode that created it,
  // and nothing else (no endpoint).
  assert.match(
    routes,
    /data: \{\s*nosanaJobIds: \[nosanaDeployment\.id\],\s*nosanaAccessMode: nosanaDeployment\.accessMode \?\? null,\s*\}/,
  );
  // Every read goes through the pure serializers.
  assert.ok((routes.match(/serializeAgentDeployment\(/g) ?? []).length >= 3);
  assert.ok((routes.match(/agentApiEndpoints\(/g) ?? []).length >= 2);

  // The builders themselves name no host.
  const builders = source("services/publicEndpoints.ts").replace(/\/\*\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(builders, /https?:\/\//);
});

test("the migration clears the fabricated endpoints and repairs unaddressable slugs", () => {
  const migrations = path.join(SRC, "..", "..", "..", "packages", "db", "prisma", "migrations");
  const dir = readdirSync(migrations).find((name) => name.endsWith("_agent_api_endpoint"));
  assert.ok(dir, "the agent endpoint migration exists");
  assert.match(dir!, /^2026100710\d{4}_/, "inside this feature's migration range");
  const sql = readFileSync(path.join(migrations, dir!, "migration.sql"), "utf8");
  assert.match(sql, /UPDATE "agent_deployments"\s+SET "endpoint" = NULL\s+WHERE "endpoint" LIKE 'https:\/\/agents\.wheelsai\.io\/%'/);
  assert.match(sql, /UPDATE "agents"[\s\S]*WHERE "slug" = '' OR "slug" LIKE '-%'/);
});
