import assert from "node:assert/strict";
import test from "node:test";

// Env must be in place BEFORE the route module (and config/env.ts) is imported.
process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";

// Drives routes/agents.ts against a patched prisma and the REAL Nosana client
// with no platform wallet - the "compute is not configured" state.
//
//  - POST /:agentId/deploy used to answer 201, reserve credits, and only then
//    fail in the background submit. It must answer an honest 501 BEFORE any row
//    or reservation exists.
//  - POST /:agentId/deployments/:id/stop used to mark the row `stopped` even
//    when the Nosana stop threw. A stopped row is never polled again, so that
//    left the GPU running on platform funds; it must fail closed.

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";

async function agentsApp(deployment: Record<string, unknown> | null = null) {
  const { prisma } = await import("@wheelsai/db");
  const { env } = await import("../config/env.js");
  const state = {
    created: 0,
    reserved: 0,
    updates: [] as any[],
    transactions: 0,
    orphans: [] as any[],
  };

  const patch: Record<string, unknown> = {
    agent: {
      findFirst: async () => ({
        id: AGENT_ID,
        orgId: "org-1",
        slug: "my-agent",
        name: "My Agent",
        modelConfig: { externalModel: "openai/gpt-4" },
      }),
    },
    agentDeployment: {
      count: async () => 0,
      create: async () => {
        state.created += 1;
        return { id: DEPLOYMENT_ID, status: "pending", gpuTier: "4090", replicas: 1 };
      },
      findFirst: async () => deployment,
      update: async (args: any) => {
        state.updates.push(args);
        return {};
      },
      updateMany: async (args: any) => {
        state.updates.push(args);
        return { count: 1 };
      },
    },
    creditBalance: {
      updateMany: async () => {
        state.reserved += 1;
        return { count: 1 };
      },
      findUnique: async () => ({ balanceCents: 10_000n }),
    },
    creditTransaction: { create: async () => ({}) },
    nosanaOrphanDeployment: {
      createMany: async ({ data }: any) => {
        state.orphans.push(...data);
        return { count: data.length };
      },
    },
    orgSubscription: { findUnique: async () => ({ plan: "enterprise", status: "active" }) },
    $transaction: async (fn: any) => {
      state.transactions += 1;
      return fn(prisma);
    },
  };
  const saved: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) {
    saved[k] = (prisma as any)[k];
    (prisma as any)[k] = patch[k];
  }
  // No platform wallet and no dev mock: Nosana deploys are not configured.
  const envBefore = {
    key: (env as any).NOSANA_WALLET_PRIVATE_KEY,
    mock: (env as any).ALLOW_NOSANA_MOCK,
    agentGpu: (env as any).AGENT_GPU_ENABLED,
  };
  // The switch for agent GPUs is on here: these tests are about what the
  // deploy route does past its first gate (agentDeployGate.unit.test.ts
  // covers the 501 it answers while the switch is off).
  (env as any).AGENT_GPU_ENABLED = true;
  (env as any).NOSANA_WALLET_PRIVATE_KEY = undefined;
  (env as any).ALLOW_NOSANA_MOCK = false;

  const Fastify = (await import("fastify")).default;
  const sensible = await import("@fastify/sensible");
  const { agentRoutes } = await import("../routes/agents.js");
  const { globalErrorHandler } = await import("../lib/errorHandler.js");
  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  await app.register(sensible.default);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as any).auth = { userId: "u", orgId: "org-1", type: "jwt", role: "owner" };
  });
  await app.register(agentRoutes);

  return {
    app,
    state,
    restore: async () => {
      await app.close();
      Object.assign(prisma as any, saved);
      (env as any).NOSANA_WALLET_PRIVATE_KEY = envBefore.key;
      (env as any).ALLOW_NOSANA_MOCK = envBefore.mock;
      (env as any).AGENT_GPU_ENABLED = envBefore.agentGpu;
    },
  };
}

test("POST /:agentId/deploy with compute not configured is a 501 with a named reason: no row, no reservation, no 201", async () => {
  const { app, state, restore } = await agentsApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: `/${AGENT_ID}/deploy`,
      payload: { gpuTier: "4090", replicas: 1 },
    });
    assert.equal(res.statusCode, 501, "not a 201 that fails later in the background");
    assert.equal(res.json().error, "nosana_not_configured");
    assert.equal(res.json().message, "New GPU deployments are temporarily unavailable. Nothing was reserved or charged. Try again later.");
    assert.ok(!/NOSANA_/.test(res.json().message), "the setting is for the operator's log, not the customer");
    assert.equal(state.created, 0, "no deployment row was created");
    assert.equal(state.reserved, 0, "no credits were reserved");
    assert.equal(state.transactions, 0);
  } finally {
    await restore();
  }
});

test("the preflight runs AFTER request validation: a bad request is still a 400, not a 501", async () => {
  const { app, state, restore } = await agentsApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: `/${AGENT_ID}/deploy`,
      payload: { replicas: 1 }, // gpuTier missing
    });
    assert.equal(res.statusCode, 400);
    assert.equal(state.created, 0);
  } finally {
    await restore();
  }
});

test("agent stop fails closed: when Nosana does not confirm the stop the row is left as it was (502)", async () => {
  const { app, state, restore } = await agentsApp({
    id: DEPLOYMENT_ID,
    agentId: AGENT_ID,
    status: "running",
    nosanaJobIds: ["DeploymentManagerId1"],
  });
  try {
    const res = await app.inject({
      method: "POST",
      url: `/${AGENT_ID}/deployments/${DEPLOYMENT_ID}/stop`,
    });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error, "nosana_stop_failed");
    assert.deepEqual(state.updates, [], "the row is NOT marked stopped - it would never be polled again");
  } finally {
    await restore();
  }
});

test("agent stop of a deployment that never reached Nosana still marks it stopped", async () => {
  const { app, state, restore } = await agentsApp({
    id: DEPLOYMENT_ID,
    agentId: AGENT_ID,
    status: "pending",
    nosanaJobIds: [],
  });
  try {
    const res = await app.inject({
      method: "POST",
      url: `/${AGENT_ID}/deployments/${DEPLOYMENT_ID}/stop`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(state.updates.length, 1);
    assert.equal(state.updates[0].data.status, "stopped");
  } finally {
    await restore();
  }
});
