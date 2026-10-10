import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import "./unitEnv.js";

// The two places that read a deployment from the database on their own and
// must carry its fine-tuned model along: the workflow model step's wiring and
// GET /v1/models. (The /v1 proxy, the chat service and hosted-model
// resolution are covered in inferenceGpuBilled, deploymentChat and
// hostedModel.)

const ORG = "11111111-1111-4111-8111-111111111111";

async function withPrisma<T>(patch: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const { prisma } = await import("@wheelsai/db");
  const saved: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    saved[key] = (prisma as any)[key];
    (prisma as any)[key] = patch[key];
  }
  try {
    return await run();
  } finally {
    Object.assign(prisma as any, saved);
  }
}

test("workflow model step wiring: the deployment is read with its fine-tuned model and named for it", async () => {
  const { buildDeploymentChatDeps } = await import("../services/buildDeploymentChatDeps.js");
  const deps = buildDeploymentChatDeps();
  const hfId = "meta-llama/Meta-Llama-3.1-8B-Instruct";
  assert.equal(deps.servedModelName("vllm", hfId, "support-tone"), "ft-support-tone");
  assert.equal(deps.servedModelName("vllm", hfId, null), hfId);
  assert.equal(deps.servedModelName("vllm", hfId), hfId);
  assert.equal(deps.servedModelName("ollama", hfId), "llama3.1:8b");

  const queries: any[] = [];
  const row = { id: "dep-1", fineTunedModel: { slug: "support-tone" } };
  const found = await withPrisma(
    {
      deployment: {
        findFirst: async (args: any) => {
          queries.push(args);
          return row;
        },
      },
    },
    () => deps.findRunningDeployment({ orgId: ORG, deploymentId: "dep-1" }),
  );
  assert.deepEqual(queries[0].where, { id: "dep-1", orgId: ORG, status: "running" });
  assert.deepEqual(queries[0].include.fineTunedModel, { select: { slug: true } });
  assert.equal(found?.fineTunedModel?.slug, "support-tone");
});

test("GET /v1/models: the id stays the deployment slug; root and wheelsai say which base and fine-tuned model it serves", async () => {
  const { createOpenAiV1Routes } = await import("../routes/openaiV1.js");
  const queries: any[] = [];
  const app = Fastify();
  app.decorateRequest("auth", null);
  await app.register(
    createOpenAiV1Routes({
      unifiedAuth: async (request) => {
        (request as any).auth = { userId: null, orgId: ORG, type: "api_key", scopes: ["*"], apiKeyId: "k" };
      },
    }),
    { prefix: "/v1" },
  );

  const created = new Date("2026-10-01T00:00:00Z");
  const res = await withPrisma(
    {
      deployment: {
        findMany: async (args: any) => {
          queries.push(args);
          return [
            { slug: "tone-prod", createdAt: created, model: { hfId: "microsoft/Phi-3-mini-4k-instruct" }, fineTunedModel: { slug: "support-tone" } },
            { slug: "phi-plain", createdAt: created, model: { hfId: "microsoft/Phi-3-mini-4k-instruct" }, fineTunedModel: null },
          ];
        },
      },
      agent: { findMany: async () => [] },
      orchestration: { findMany: async () => [] },
      // The list also reads the agents this organization pays to use: none here.
      agentInstall: { findMany: async () => [] },
      agentSubscription: { findMany: async () => [] },
    },
    () => app.inject({ method: "GET", url: "/v1/models" }),
  );
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(queries[0].where, { orgId: ORG, status: "running" }, "the caller's organization only");
  assert.deepEqual(queries[0].select.fineTunedModel, { select: { slug: true } });

  const entry = (id: string, wheelsai: unknown) => ({
    id,
    object: "model",
    created: Math.floor(created.getTime() / 1000),
    owned_by: "wheelsai",
    permission: [],
    root: "microsoft/Phi-3-mini-4k-instruct",
    parent: null,
    wheelsai,
  });
  assert.deepEqual(res.json().data, [
    entry("tone-prod", {
      kind: "deployment",
      baseModel: "microsoft/Phi-3-mini-4k-instruct",
      fineTunedModel: "support-tone",
    }),
    entry("phi-plain", { kind: "deployment", baseModel: "microsoft/Phi-3-mini-4k-instruct" }),
  ]);
  // The adapter's engine-side name is never a public model id.
  assert.ok(!res.body.includes("ft-support-tone"));
  await app.close();
});
