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

// Drives the framework-dispatch generalization (plan A7+A10):
//
//   1. compileDeployPlan accepts any ParsedAgentSpec (the structural shape
//      both Eliza and CrewAi parsers produce). No more eliza-specific
//      coupling in the planner.
//
//   2. POST /launch reads a `framework` field on the body and routes to
//      the right parser before calling compileDeployPlan.

// ============================================
// compileDeployPlan accepts the CrewAi shape directly
// ============================================

test("compileDeployPlan compiles a CrewAi spec (no channels, model+tool envs propagated)", async () => {
  setupEnv();
  const { parseCrewAi } = await import("../services/frameworks/crewai.js");
  const { compileDeployPlan } = await import("../services/deployPlan.js");

  const spec = parseCrewAi(
    `
researcher:
  role: "Analyst"
  goal: "Research"
  backstory: "x"
  llm: "openai/gpt-4"
  tools:
    - SerperDevTool
`.trim(),
    { name: "research-crew" },
  );

  const plan = compileDeployPlan({
    agentSpec: spec,
    envValues: {
      OPENAI_API_KEY: "sk-test",
      SERPER_API_KEY: "serp-test",
    },
    gpuTier: "4090",
  });

  assert.equal(plan.validation.isReady, true);
  // No channels emitted for CrewAi (API-only).
  assert.deepEqual(plan.channels, []);
  // Job env carries the CrewAi-specific envs (model + tool).
  const env = plan.jobDefinition.ops[0]!.args.env ?? {};
  assert.equal(env.OPENAI_API_KEY, "sk-test");
  assert.equal(env.SERPER_API_KEY, "serp-test");
  assert.equal(env.AGENT_NAME, "research-crew");
  assert.equal(env.AGENT_SLUG, "research-crew");
});

test("compileDeployPlan flags the right missing envs for a CrewAi spec", async () => {
  const { parseCrewAi } = await import("../services/frameworks/crewai.js");
  const { compileDeployPlan } = await import("../services/deployPlan.js");

  const spec = parseCrewAi(
    `
a:
  role: "x"
  goal: "y"
  backstory: "z"
  llm: "anthropic/claude-3-opus"
  tools:
    - BraveSearchTool
`.trim(),
    { name: "x" },
  );

  const plan = compileDeployPlan({
    agentSpec: spec,
    envValues: { ANTHROPIC_API_KEY: "ak" }, // missing BRAVE_API_KEY
    gpuTier: "4090",
  });

  assert.equal(plan.validation.isReady, false);
  assert.deepEqual(plan.validation.missingEnvVars, ["BRAVE_API_KEY"]);
});

// ============================================
// Eliza spec still works under the renamed param
// ============================================

test("compileDeployPlan still accepts an Eliza spec under the agentSpec param (backward compat)", async () => {
  const { parseElizaCharacter } = await import("../services/frameworks/eliza.js");
  const { compileDeployPlan } = await import("../services/deployPlan.js");

  const spec = parseElizaCharacter({
    name: "Eliza",
    clients: ["discord"],
    plugins: [],
    modelProvider: "openai",
  });

  const plan = compileDeployPlan({
    agentSpec: spec,
    envValues: {
      OPENAI_API_KEY: "sk",
      DISCORD_API_TOKEN: "d",
      DISCORD_APPLICATION_ID: "a",
    },
    gpuTier: "4090",
  });

  assert.equal(plan.validation.isReady, true);
  assert.deepEqual(
    plan.channels.map((c) => c.platform),
    ["discord"],
  );
});

// ============================================
// Launch route framework dispatch
// ============================================

function makeApp(deps: {
  authed?: boolean;
  persist?: any;
  submit?: any;
}) {
  setupEnv();
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    if (deps.authed !== false) {
      request.auth = { userId: "u1", orgId: "org_1", type: "jwt" };
    }
  });
  return import("../routes/launch.js").then(async (mod) => {
    await app.register(
      mod.createLaunchRoutes({
        persistDeployment:
          deps.persist ??
          (async () => ({ deploymentId: "dep", agentId: "agent" })),
        submitJob: deps.submit ?? (async () => ({ jobId: "job" })),
      }),
    );
    return app;
  });
}

test("POST /launch routes a crewai framework body through the CrewAi parser", async () => {
  const captured: any[] = [];
  const app = await makeApp({
    persist: async (a: any) => {
      captured.push(a);
      return { deploymentId: "dep_x", agentId: "agent_x" };
    },
  });

  const res = await app.inject({
    method: "POST",
    url: "/launch",
    payload: {
      framework: "crewai",
      crewName: "Research Crew",
      characterJson: {
        researcher: {
          role: "x",
          goal: "y",
          backstory: "z",
          llm: "openai/gpt-4",
          tools: ["SerperDevTool"],
        },
      },
      envValues: {
        OPENAI_API_KEY: "sk",
        SERPER_API_KEY: "serp",
      },
      gpuTier: "4090",
    },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().agentId, "agent_x");
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.agentSlug, "research-crew");
  // No channels emitted for CrewAi.
  assert.deepEqual(captured[0]!.channels, []);
});

test("POST /launch with framework='elizaos' routes through the Eliza parser (backward compat)", async () => {
  const app = await makeApp({});
  const res = await app.inject({
    method: "POST",
    url: "/launch",
    payload: {
      framework: "elizaos",
      characterJson: {
        name: "Eliza",
        clients: ["discord"],
        plugins: [],
        modelProvider: "openai",
      },
      envValues: {
        OPENAI_API_KEY: "sk",
        DISCORD_API_TOKEN: "d",
        DISCORD_APPLICATION_ID: "a",
      },
      gpuTier: "4090",
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(
    body.channels.map((c: any) => c.platform),
    ["discord"],
  );
});

test("POST /launch defaults to framework='elizaos' when the field is omitted (backward compat for existing clients)", async () => {
  const app = await makeApp({});
  const res = await app.inject({
    method: "POST",
    url: "/launch",
    payload: {
      // no framework field
      characterJson: {
        name: "Eliza",
        clients: ["discord"],
        plugins: [],
        modelProvider: "openai",
      },
      envValues: {
        OPENAI_API_KEY: "sk",
        DISCORD_API_TOKEN: "d",
        DISCORD_APPLICATION_ID: "a",
      },
      gpuTier: "4090",
    },
  });
  assert.equal(res.statusCode, 200);
});

test("POST /launch returns 400 for an unsupported framework", async () => {
  const app = await makeApp({});
  const res = await app.inject({
    method: "POST",
    url: "/launch",
    payload: {
      framework: "autogen",
      characterJson: {},
      envValues: {},
      gpuTier: "4090",
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "unsupported_framework");
});

test("POST /launch with framework='crewai' but missing crewName falls back to a default slug", async () => {
  // CrewAi parsers need a name; the route has to fall back gracefully so the
  // wizard doesn't 400 on optional metadata.
  const app = await makeApp({});
  const res = await app.inject({
    method: "POST",
    url: "/launch",
    payload: {
      framework: "crewai",
      characterJson: {
        a: { role: "x", goal: "y", backstory: "z", llm: "openai/gpt-4" },
      },
      envValues: { OPENAI_API_KEY: "sk" },
      gpuTier: "4090",
    },
  });
  assert.equal(res.statusCode, 200);
});
