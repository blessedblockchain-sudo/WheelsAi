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

// Drives apps/api/src/routes/launch.ts — the POST /launch handler that
// orchestrates the unified build→deploy flow:
//
//   parseElizaCharacter → compileDeployPlan
//   if !validation.isReady   → 400 with the missing env list
//   else persist + submit    → 200 with deployment record
//
// Persistence (creates Agent, OpenClawDeployment, OpenClawChannel rows) and
// nosana.submitJob are dependency-injected so this test never touches the
// DB, the encryption key, or the Solana RPC.

const characterJson = {
  name: "Eliza",
  username: "eliza",
  clients: ["discord", "telegram"],
  plugins: [],
  modelProvider: "openai",
};

const fullEnv = {
  OPENAI_API_KEY: "sk-test",
  DISCORD_API_TOKEN: "disc-test",
  DISCORD_APPLICATION_ID: "app-test",
  TELEGRAM_BOT_TOKEN: "tg-test",
};

interface PersistArgs {
  orgId: string;
  agentSlug: string;
  characterName: string;
  jobDefinition: unknown;
  channels: Array<{ platform: string; envKeys: readonly string[] }>;
  envValues: Record<string, string>;
  resourcePlan: unknown;
}

function makeApp(opts: {
  authed?: boolean;
  persist?: (a: PersistArgs) => Promise<{ deploymentId: string; agentId: string }>;
  submit?: (jobDefinition: unknown, market: string) => Promise<{ jobId: string }>;
}) {
  setupEnv();
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    if (opts.authed !== false) {
      request.auth = {
        userId: "user_1",
        orgId: "org_1",
        type: "jwt",
      };
    }
  });

  return import("../routes/launch.js").then(async (mod) => {
    await app.register(
      mod.createLaunchRoutes({
        persistDeployment:
          opts.persist ??
          (async () => ({ deploymentId: "dep_test", agentId: "agent_test" })),
        submitJob:
          opts.submit ?? (async () => ({ jobId: "job_test" })),
      }),
    );
    return app;
  });
}

// ============================================
// Auth gating
// ============================================

test("POST /launch returns 401 when the request is not authenticated", async () => {
  const app = await makeApp({ authed: false });
  const res = await app.inject({
    method: "POST",
    url: "/launch",
    payload: {
      characterJson,
      envValues: fullEnv,
      gpuTier: "4090",
    },
  });
  assert.equal(res.statusCode, 401);
});

// ============================================
// Validation
// ============================================

test("POST /launch returns 400 with the missing-env list when validation fails", async () => {
  const persistCalls: PersistArgs[] = [];
  const submitCalls: any[] = [];
  const app = await makeApp({
    persist: async (a) => {
      persistCalls.push(a);
      return { deploymentId: "x", agentId: "x" };
    },
    submit: async (j, m) => {
      submitCalls.push({ j, m });
      return { jobId: "x" };
    },
  });

  const res = await app.inject({
    method: "POST",
    url: "/launch",
    payload: {
      characterJson,
      envValues: { OPENAI_API_KEY: "sk-test" }, // missing the channel tokens
      gpuTier: "4090",
    },
  });

  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.error, "validation_failed");
  assert.deepEqual(
    body.missingEnvVars.sort(),
    ["DISCORD_API_TOKEN", "DISCORD_APPLICATION_ID", "TELEGRAM_BOT_TOKEN"],
  );
  // No side effects on validation failure.
  assert.equal(persistCalls.length, 0);
  assert.equal(submitCalls.length, 0);
});

test("POST /launch returns 400 when the character JSON is malformed", async () => {
  const app = await makeApp({});
  const res = await app.inject({
    method: "POST",
    url: "/launch",
    payload: {
      characterJson: { clients: ["discord"], plugins: [], modelProvider: "openai" }, // missing name
      envValues: fullEnv,
      gpuTier: "4090",
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_character");
});

test("POST /launch returns 400 when modelProvider is unsupported", async () => {
  const app = await makeApp({});
  const res = await app.inject({
    method: "POST",
    url: "/launch",
    payload: {
      characterJson: { ...characterJson, modelProvider: "rogue-llm" },
      envValues: fullEnv,
      gpuTier: "4090",
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_character");
});

test("POST /launch returns 400 when gpuTier is unknown (no silent fallback)", async () => {
  const app = await makeApp({});
  const res = await app.inject({
    method: "POST",
    url: "/launch",
    payload: { characterJson, envValues: fullEnv, gpuTier: "5090-fake" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_gpu_tier");
});

test("POST /launch returns 400 when payload is missing required fields", async () => {
  const app = await makeApp({});
  const res = await app.inject({
    method: "POST",
    url: "/launch",
    payload: { gpuTier: "4090" },
  });
  assert.equal(res.statusCode, 400);
});

// ============================================
// Happy path
// ============================================

test("POST /launch persists + submits + returns 200 with deployment + job ids on the happy path", async () => {
  const persistCalls: PersistArgs[] = [];
  const submitCalls: any[] = [];
  const app = await makeApp({
    persist: async (a) => {
      persistCalls.push(a);
      return { deploymentId: "dep_42", agentId: "agent_42" };
    },
    submit: async (j, m) => {
      submitCalls.push({ j, m });
      return { jobId: "job_42" };
    },
  });

  const res = await app.inject({
    method: "POST",
    url: "/launch",
    payload: { characterJson, envValues: fullEnv, gpuTier: "4090" },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.deploymentId, "dep_42");
  assert.equal(body.agentId, "agent_42");
  assert.equal(body.jobId, "job_42");
  assert.deepEqual(
    body.channels.map((c: any) => c.platform).sort(),
    ["discord", "telegram"],
  );
  assert.equal(body.resourcePlan.tier, "4090");

  assert.equal(persistCalls.length, 1);
  const p = persistCalls[0]!;
  assert.equal(p.orgId, "org_1");
  assert.equal(p.agentSlug, "eliza");
  assert.equal(p.characterName, "Eliza");
  assert.equal(p.envValues.OPENAI_API_KEY, "sk-test");

  assert.equal(submitCalls.length, 1);
  assert.equal(submitCalls[0]!.m, "97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf");
});

test("POST /launch honors a replicas override and forwards it to persist", async () => {
  const persistCalls: PersistArgs[] = [];
  const app = await makeApp({
    persist: async (a) => {
      persistCalls.push(a);
      return { deploymentId: "x", agentId: "x" };
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/launch",
    payload: {
      characterJson,
      envValues: fullEnv,
      gpuTier: "4070",
      replicas: 3,
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().resourcePlan.replicas, 3);
  assert.equal((persistCalls[0]!.resourcePlan as any).replicas, 3);
});

// ============================================
// Failure surfaces
// ============================================

test("POST /launch returns 500 when persistence throws", async () => {
  const app = await makeApp({
    persist: async () => {
      throw new Error("db down");
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/launch",
    payload: { characterJson, envValues: fullEnv, gpuTier: "4090" },
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error, "persistence_failed");
});

test("POST /launch returns 502 when Nosana submission fails (so the wizard can retry-the-deploy without re-creating the agent)", async () => {
  let persistedDeploymentId = "";
  const app = await makeApp({
    persist: async () => {
      persistedDeploymentId = "dep_99";
      return { deploymentId: persistedDeploymentId, agentId: "agent_99" };
    },
    submit: async () => {
      throw new Error("nosana down");
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/launch",
    payload: { characterJson, envValues: fullEnv, gpuTier: "4090" },
  });
  assert.equal(res.statusCode, 502);
  const body = res.json();
  assert.equal(body.error, "nosana_submit_failed");
  // The agent + deployment row was already created — surface its id so the
  // client can call a "retry submit" endpoint instead of re-running the wizard.
  assert.equal(body.deploymentId, "dep_99");
});
