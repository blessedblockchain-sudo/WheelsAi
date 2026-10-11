import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";

import sensible from "@fastify/sensible";
import Fastify, { type FastifyInstance, type preHandlerHookHandler } from "fastify";

import { createAgentRoutes } from "../routes/agents.js";
import { createPlaygroundRoutes } from "../routes/playground.js";
import type { HostedModelChoice } from "../services/hostedModelChoices.js";

// GET /api/agents/hosted-models: the models the caller's organization runs
// itself, for screens that have no agent yet. It sits beside /:agentId and
// the playground's /agents/:agentId/... routes, mounted here as index.ts
// mounts them, so the tests see the paths the product serves.

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

const choice = (orgId: string): HostedModelChoice => ({
  id: "wheelsai/llama-3.1-8b",
  displayName: "Llama 3.1 8B",
  available: true,
  state: "running",
  fineTuned: false,
  deployment: { id: `dep-of-${orgId}`, slug: "my-llama", name: "My Llama" },
});

interface Seen {
  listedFor: string[];
  agentLookups: unknown[];
}

/** The caller the `x-test-org` header names; without it, the 401 an unauthenticated caller gets. */
const headerAuth: preHandlerHookHandler = async (request, reply) => {
  const orgId = request.headers["x-test-org"];
  if (typeof orgId !== "string") {
    return reply.status(401).send({ error: "Unauthorized", message: "Authentication required" });
  }
  (request as { auth?: unknown }).auth = { orgId, userId: "user-1" };
};

async function buildApp(): Promise<{ app: FastifyInstance; seen: Seen }> {
  const seen: Seen = { listedFor: [], agentLookups: [] };
  const hostedModels = async (orgId: string) => {
    seen.listedFor.push(orgId);
    return [choice(orgId)];
  };
  const app = Fastify();
  await app.register(sensible);
  await app.register(
    createAgentRoutes({
      requireAuth: headerAuth,
      hostedModels,
      prisma: {
        agent: {
          findFirst: async ({ where }: any) => {
            seen.agentLookups.push(where);
            return null;
          },
        },
        agentDeployment: {},
      } as never,
    }),
    { prefix: "/api/agents" },
  );
  await app.register(createPlaygroundRoutes({ requireAuth: headerAuth, hostedModels }), { prefix: "/api" });
  await app.ready();
  return { app, seen };
}

test("GET /api/agents/hosted-models answers the caller's organization's list", async () => {
  const { app, seen } = await buildApp();
  const res = await app.inject({ method: "GET", url: "/api/agents/hosted-models", headers: { "x-test-org": ORG } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { hostedModels: [choice(ORG)] });
  assert.deepEqual(seen.listedFor, [ORG]);
  await app.close();
});

test("the list is scoped by the caller's own organization, not by anything the request says", async () => {
  const { app, seen } = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: `/api/agents/hosted-models?orgId=${OTHER_ORG}`,
    headers: { "x-test-org": ORG, "x-org-id": OTHER_ORG },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen.listedFor, [ORG]);
  assert.equal(res.json().hostedModels[0].deployment.id, `dep-of-${ORG}`);

  const theirs = await app.inject({ method: "GET", url: "/api/agents/hosted-models", headers: { "x-test-org": OTHER_ORG } });
  assert.equal(theirs.json().hostedModels[0].deployment.id, `dep-of-${OTHER_ORG}`);
  assert.deepEqual(seen.listedFor, [ORG, OTHER_ORG]);
  await app.close();
});

test("without credentials the route answers 401 and builds no list", async () => {
  const { app, seen } = await buildApp();
  const res = await app.inject({ method: "GET", url: "/api/agents/hosted-models" });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().hostedModels, undefined);
  assert.deepEqual(seen.listedFor, []);
  await app.close();
});

test("the static path is not shadowed by /:agentId, and does not shadow it", async () => {
  const { app, seen } = await buildApp();
  const headers = { "x-test-org": ORG };

  // "hosted-models" is not read as an agent id: no agent is looked up.
  const list = await app.inject({ method: "GET", url: "/api/agents/hosted-models", headers });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(seen.agentLookups, []);
  assert.deepEqual(seen.listedFor, [ORG]);

  // An agent's own routes still answer: this one looks the agent up and finds none.
  const agent = await app.inject({ method: "GET", url: `/api/agents/${AGENT_ID}`, headers });
  assert.equal(agent.statusCode, 404);
  assert.deepEqual(seen.agentLookups, [{ id: AGENT_ID, orgId: ORG }]);
  const usage = await app.inject({ method: "GET", url: `/api/agents/${AGENT_ID}/usage`, headers });
  assert.equal(usage.statusCode, 404);
  assert.equal(seen.agentLookups.length, 2);
  assert.deepEqual(seen.listedFor, [ORG], "an agent's route builds no hosted model list");

  // Only GET is the list: another verb on the path is /:agentId's, which refuses the id.
  const patch = await app.inject({ method: "PATCH", url: "/api/agents/hosted-models", headers, payload: {} });
  assert.ok(patch.statusCode >= 400);
  assert.deepEqual(seen.listedFor, [ORG]);
  await app.close();
});
