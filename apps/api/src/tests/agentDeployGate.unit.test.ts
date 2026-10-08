/**
 * POST /api/agents/:id/deploy while AGENT_GPU_ENABLED is off: an honest 501
 * as the route's FIRST step. Nothing is looked up, checked or reserved, and
 * the Nosana client is never built. With the switch on the route does what it
 * did before.
 *
 * Hermetic: every delegate of the global prisma the route could reach is
 * replaced with one that records the call.
 */
import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { prisma } from "@wheelsai/db";

import { env } from "../config/env.js";
import { globalErrorHandler } from "../lib/errorHandler.js";
import { AGENT_GPU_UNAVAILABLE_MESSAGE, agentRoutes, createAgentRoutes } from "../routes/agents.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const MODEL_DEPLOYMENT_ID = "33333333-3333-4333-8333-333333333333";

const TOUCHED = ["agent", "agentDeployment", "deployment", "creditBalance", "creditTransaction", "orgSubscription"];

/** Records every database call the route makes. `agent` is what the lookup finds. */
function watchPrisma(agent: Record<string, unknown> | null = null) {
  const calls: string[] = [];
  const saved: Record<string, unknown> = {};
  const recorder = (model: string) =>
    new Proxy(
      {},
      {
        get: (_target, method: string) => async () => {
          calls.push(`${model}.${method}`);
          if (model === "agent" && method === "findFirst") return agent;
          if (method === "count") return 0;
          return null;
        },
      },
    );
  for (const model of TOUCHED) {
    saved[model] = (prisma as any)[model];
    (prisma as any)[model] = recorder(model);
  }
  saved.$transaction = (prisma as any).$transaction;
  (prisma as any).$transaction = async () => {
    calls.push("$transaction");
    throw new Error("no transaction is expected in this test");
  };
  return { calls, restore: () => Object.assign(prisma as any, saved) };
}

async function appWith(plugin = agentRoutes) {
  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  await app.register(sensible);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as any).auth = { userId: "u", orgId: "org-1", type: "jwt", role: "owner" };
  });
  await app.register(plugin);
  await app.ready();
  return app;
}

function withSwitch(value: boolean) {
  const before = (env as any).AGENT_GPU_ENABLED;
  (env as any).AGENT_GPU_ENABLED = value;
  return () => ((env as any).AGENT_GPU_ENABLED = before);
}

const GATE_BODY = {
  error: "agent_gpu_unavailable",
  message:
    "Dedicated GPUs for agents are being built. Nothing was reserved or charged. Your agent keeps answering on WheelsAI.",
};

test("the switch is off unless the operator turns it on", () => {
  assert.equal(env.AGENT_GPU_ENABLED, false);
  assert.equal(AGENT_GPU_UNAVAILABLE_MESSAGE, GATE_BODY.message);
});

test("with the switch off a deploy is a 501 before any lookup, preflight or reservation", async () => {
  const restoreSwitch = withSwitch(false);
  const watch = watchPrisma({ id: AGENT_ID, orgId: "org-1", modelConfig: { externalModel: "openai/gpt-4" } });
  const app = await appWith();
  try {
    const res = await app.inject({
      method: "POST",
      url: `/${AGENT_ID}/deploy`,
      payload: { gpuTier: "4090", replicas: 1 },
    });
    assert.equal(res.statusCode, 501);
    assert.deepEqual(res.json(), GATE_BODY);
    assert.deepEqual(watch.calls, [], "nothing was read or written");
  } finally {
    await app.close();
    watch.restore();
    restoreSwitch();
  }
});

test("the 501 comes first whatever was sent: a bad body, a bad id, a model deployment", async () => {
  const restoreSwitch = withSwitch(false);
  const watch = watchPrisma();
  const app = await appWith();
  try {
    const requests = [
      { url: `/${AGENT_ID}/deploy`, payload: {} },
      { url: `/${AGENT_ID}/deploy`, payload: { gpuTier: "no-such-tier", replicas: 99 } },
      { url: "/not-a-uuid/deploy", payload: { gpuTier: "4090" } },
      { url: `/${AGENT_ID}/deploy`, payload: { gpuTier: "4090", modelDeploymentId: MODEL_DEPLOYMENT_ID } },
    ];
    for (const { url, payload } of requests) {
      const res = await app.inject({ method: "POST", url, payload });
      assert.equal(res.statusCode, 501, url);
      assert.deepEqual(res.json(), GATE_BODY);
    }
    assert.deepEqual(watch.calls, []);
  } finally {
    await app.close();
    watch.restore();
    restoreSwitch();
  }
});

test("the answer says what happened in product words: no setting name, no code in the sentence", async () => {
  const app = await appWith(createAgentRoutes({ agentGpuEnabled: () => false }));
  const watch = watchPrisma();
  try {
    const res = await app.inject({ method: "POST", url: `/${AGENT_ID}/deploy`, payload: { gpuTier: "4090" } });
    assert.equal(res.statusCode, 501);
    assert.doesNotMatch(res.json().message, /AGENT_GPU|NOSANA|env|_/);
    assert.match(res.json().message, /Nothing was reserved or charged/);
  } finally {
    await app.close();
    watch.restore();
  }
});

test("signing in still comes before the gate", async () => {
  const restoreSwitch = withSwitch(false);
  const watch = watchPrisma();
  const app = Fastify();
  await app.register(sensible);
  app.decorateRequest("auth", null);
  await app.register(agentRoutes);
  try {
    const res = await app.inject({ method: "POST", url: `/${AGENT_ID}/deploy`, payload: { gpuTier: "4090" } });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(watch.calls, []);
  } finally {
    await app.close();
    watch.restore();
    restoreSwitch();
  }
});

test("the other routes of an agent do not pass through the gate", async () => {
  const restoreSwitch = withSwitch(false);
  const watch = watchPrisma(null);
  const app = await appWith();
  try {
    const res = await app.inject({ method: "GET", url: `/${AGENT_ID}` });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(watch.calls, ["agent.findFirst"]);
  } finally {
    await app.close();
    watch.restore();
    restoreSwitch();
  }
});

test("with the switch on the route is unchanged: validation, then the lookup, then its own refusals", async () => {
  const restoreSwitch = withSwitch(true);
  try {
    // A bad request is still a 400, and nothing is read for it.
    let watch = watchPrisma();
    let app = await appWith();
    try {
      const bad = await app.inject({ method: "POST", url: `/${AGENT_ID}/deploy`, payload: {} });
      assert.equal(bad.statusCode, 400);
      assert.equal(bad.json().error, "validation_failed");
      assert.deepEqual(watch.calls, []);

      // An agent that is not this organization's is still a 404, after one lookup.
      const missing = await app.inject({ method: "POST", url: `/${AGENT_ID}/deploy`, payload: { gpuTier: "4090" } });
      assert.equal(missing.statusCode, 404);
      assert.deepEqual(watch.calls, ["agent.findFirst"]);
    } finally {
      await app.close();
      watch.restore();
    }

    // An agent with no model to run on is still refused by the route's own rule.
    watch = watchPrisma({ id: AGENT_ID, orgId: "org-1", modelConfig: {} });
    app = await appWith();
    try {
      const noModel = await app.inject({ method: "POST", url: `/${AGENT_ID}/deploy`, payload: { gpuTier: "4090" } });
      assert.equal(noModel.statusCode, 400);
      assert.match(noModel.json().message, /modelDeploymentId, externalModelUrl/);
      assert.deepEqual(watch.calls, ["agent.findFirst"]);
    } finally {
      await app.close();
      watch.restore();
    }

    // A deploy naming a model deployment is still answered by ITS 501, not the gate's.
    watch = watchPrisma({ id: AGENT_ID, orgId: "org-1", modelConfig: {} });
    (prisma as any).deployment = { findFirst: async () => ({ id: MODEL_DEPLOYMENT_ID, status: "running" }) };
    app = await appWith();
    try {
      const onModel = await app.inject({
        method: "POST",
        url: `/${AGENT_ID}/deploy`,
        payload: { gpuTier: "4090", modelDeploymentId: MODEL_DEPLOYMENT_ID },
      });
      assert.equal(onModel.statusCode, 501);
      assert.equal(onModel.json().error, "agent_model_deployment_unavailable");
    } finally {
      await app.close();
      watch.restore();
    }
  } finally {
    restoreSwitch();
  }
});

test("the switch is read per request, so turning it on needs no new routes", async () => {
  let enabled = false;
  const watch = watchPrisma(null);
  const app = await appWith(createAgentRoutes({ agentGpuEnabled: () => enabled }));
  try {
    const off = await app.inject({ method: "POST", url: `/${AGENT_ID}/deploy`, payload: { gpuTier: "4090" } });
    assert.equal(off.statusCode, 501);
    assert.equal(off.json().error, "agent_gpu_unavailable");
    enabled = true;
    const on = await app.inject({ method: "POST", url: `/${AGENT_ID}/deploy`, payload: { gpuTier: "4090" } });
    assert.equal(on.statusCode, 404);
  } finally {
    await app.close();
    watch.restore();
  }
});
