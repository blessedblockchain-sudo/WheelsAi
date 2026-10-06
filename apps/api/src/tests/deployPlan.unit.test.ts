import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/deployPlan.ts — the compiler the unified
// /dashboard/launch wizard (plan A7) uses to turn a parsed character file
// + user-supplied env values + a GPU tier choice into a complete deploy
// plan: validation result, OpenClaw job definition, OpenClawChannel rows
// to create, and the Nosana resource plan.

async function loadEliza() {
  setupEnv();
  return import("../services/frameworks/eliza.js");
}

async function loadCompiler() {
  setupEnv();
  return import("../services/deployPlan.js");
}

const fullEnv = {
  OPENAI_API_KEY: "sk-test",
  DISCORD_API_TOKEN: "disc-test",
  DISCORD_APPLICATION_ID: "app-test",
  TELEGRAM_BOT_TOKEN: "tg-test",
};

const minimalCharacterJson = {
  name: "Eliza",
  username: "eliza",
  clients: ["discord", "telegram"],
  plugins: [],
  modelProvider: "openai",
};

// ============================================
// Happy path
// ============================================

test("compileDeployPlan returns isReady=true when every required env var is supplied", async () => {
  const { parseElizaCharacter } = await loadEliza();
  const { compileDeployPlan } = await loadCompiler();

  const agentSpec = parseElizaCharacter(minimalCharacterJson);
  const plan = compileDeployPlan({
    agentSpec,
    envValues: fullEnv,
    gpuTier: "4090",
  });

  assert.equal(plan.validation.isReady, true);
  assert.deepEqual(plan.validation.missingEnvVars, []);
});

test("compileDeployPlan emits channel bindings only for inbound-supported platforms", async () => {
  const { parseElizaCharacter } = await loadEliza();
  const { compileDeployPlan } = await loadCompiler();

  // Twitter is in the character but inbound-unsupported → no binding emitted
  const agentSpec = parseElizaCharacter({
    ...minimalCharacterJson,
    clients: ["discord", "telegram", "twitter"],
  });
  const plan = compileDeployPlan({
    agentSpec,
    envValues: { ...fullEnv, TWITTER_USERNAME: "u", TWITTER_PASSWORD: "p" },
    gpuTier: "4090",
  });

  const platforms = plan.channels.map((c) => c.platform).sort();
  assert.deepEqual(platforms, ["discord", "telegram"]);
});

test("compileDeployPlan picks the right Nosana market + price for the tier", async () => {
  const { parseElizaCharacter } = await loadEliza();
  const { compileDeployPlan } = await loadCompiler();

  const agentSpec = parseElizaCharacter(minimalCharacterJson);
  const plan = compileDeployPlan({
    agentSpec,
    envValues: fullEnv,
    gpuTier: "4090",
  });

  // The real Nosana mainnet nvidia-4090 market (services/nosanaMarkets.ts).
  assert.equal(plan.resourcePlan.market, "97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf");
  assert.equal(plan.resourcePlan.pricePerSecondUsd, 0.00025);
  assert.equal(plan.resourcePlan.replicas, 1);
});

test("compileDeployPlan honors a replicas override", async () => {
  const { parseElizaCharacter } = await loadEliza();
  const { compileDeployPlan } = await loadCompiler();

  const agentSpec = parseElizaCharacter(minimalCharacterJson);
  const plan = compileDeployPlan({
    agentSpec,
    envValues: fullEnv,
    gpuTier: "4070",
    replicas: 3,
  });
  assert.equal(plan.resourcePlan.replicas, 3);
});

// ============================================
// Validation
// ============================================

test("compileDeployPlan flags missing env vars without throwing", async () => {
  const { parseElizaCharacter } = await loadEliza();
  const { compileDeployPlan } = await loadCompiler();

  const agentSpec = parseElizaCharacter(minimalCharacterJson);
  const plan = compileDeployPlan({
    agentSpec,
    envValues: { OPENAI_API_KEY: "sk-test" }, // missing discord + telegram tokens
    gpuTier: "4090",
  });

  assert.equal(plan.validation.isReady, false);
  assert.deepEqual(plan.validation.missingEnvVars.sort(), [
    "DISCORD_API_TOKEN",
    "DISCORD_APPLICATION_ID",
    "TELEGRAM_BOT_TOKEN",
  ]);
});

test("compileDeployPlan throws when GPU tier is unknown (no silent 3060 fallback in the planner)", async () => {
  const { parseElizaCharacter } = await loadEliza();
  const { compileDeployPlan } = await loadCompiler();

  const agentSpec = parseElizaCharacter(minimalCharacterJson);
  // The planner is stricter than computeMetering's fallback: an unknown tier here
  // means the wizard sent garbage, which would otherwise quietly bill at 3060 rates.
  assert.throws(
    () =>
      compileDeployPlan({
        agentSpec,
        envValues: fullEnv,
        gpuTier: "5090-fake",
      }),
    /gpuTier/i,
  );
});

test("compileDeployPlan throws on negative or zero replicas", async () => {
  const { parseElizaCharacter } = await loadEliza();
  const { compileDeployPlan } = await loadCompiler();

  const agentSpec = parseElizaCharacter(minimalCharacterJson);
  assert.throws(
    () =>
      compileDeployPlan({
        agentSpec,
        envValues: fullEnv,
        gpuTier: "4090",
        replicas: 0,
      }),
    /replicas/i,
  );
});

// ============================================
// Job definition
// ============================================

test("compileDeployPlan job definition exposes the OpenClaw port and requests GPU", async () => {
  const { parseElizaCharacter } = await loadEliza();
  const { compileDeployPlan } = await loadCompiler();

  const agentSpec = parseElizaCharacter(minimalCharacterJson);
  const plan = compileDeployPlan({
    agentSpec,
    envValues: fullEnv,
    gpuTier: "4090",
  });

  assert.equal(plan.jobDefinition.version, "0.1");
  assert.equal(plan.jobDefinition.type, "container");
  const op = plan.jobDefinition.ops[0]!;
  assert.equal(op.args.gpu, true);
  assert.deepEqual(op.args.expose, [3000]); // OpenClaw default port
  assert.ok(typeof op.args.image === "string" && op.args.image.length > 0);
});

test("compileDeployPlan injects only the env vars the character requires (no secret leak)", async () => {
  const { parseElizaCharacter } = await loadEliza();
  const { compileDeployPlan } = await loadCompiler();

  const agentSpec = parseElizaCharacter(minimalCharacterJson);
  const plan = compileDeployPlan({
    agentSpec,
    envValues: {
      ...fullEnv,
      // Random extra secret the character does not declare → must not end up in the job env.
      STRIPE_SECRET_KEY: "sk_live_xxx",
      ANOTHER_API_KEY: "leak-me",
    },
    gpuTier: "4090",
  });

  const env = plan.jobDefinition.ops[0]!.args.env ?? {};
  assert.equal(env.OPENAI_API_KEY, "sk-test");
  assert.equal(env.DISCORD_API_TOKEN, "disc-test");
  assert.ok(!("STRIPE_SECRET_KEY" in env));
  assert.ok(!("ANOTHER_API_KEY" in env));
});

test("compileDeployPlan exposes the agent slug + name in the job env so OpenClaw can identify itself", async () => {
  const { parseElizaCharacter } = await loadEliza();
  const { compileDeployPlan } = await loadCompiler();

  const agentSpec = parseElizaCharacter(minimalCharacterJson);
  const plan = compileDeployPlan({
    agentSpec,
    envValues: fullEnv,
    gpuTier: "4090",
  });

  const env = plan.jobDefinition.ops[0]!.args.env ?? {};
  assert.equal(env.AGENT_NAME, "Eliza");
  assert.equal(env.AGENT_SLUG, "eliza");
});

test("compileDeployPlan accepts an agentSlug override (collision resolution)", async () => {
  const { parseElizaCharacter } = await loadEliza();
  const { compileDeployPlan } = await loadCompiler();

  const agentSpec = parseElizaCharacter(minimalCharacterJson);
  const plan = compileDeployPlan({
    agentSpec,
    envValues: fullEnv,
    gpuTier: "4090",
    agentSlug: "eliza-2",
  });
  assert.equal(plan.jobDefinition.ops[0]!.args.env?.AGENT_SLUG, "eliza-2");
});

// ============================================
// Edge: character with zero clients (pure outbound / API-only agent)
// ============================================

test("compileDeployPlan tolerates a character with no clients (API-only agent)", async () => {
  const { parseElizaCharacter } = await loadEliza();
  const { compileDeployPlan } = await loadCompiler();

  const agentSpec = parseElizaCharacter({
    name: "Compute",
    clients: [],
    plugins: [],
    modelProvider: "openai",
  });
  const plan = compileDeployPlan({
    agentSpec,
    envValues: { OPENAI_API_KEY: "sk" },
    gpuTier: "3060",
  });

  assert.equal(plan.validation.isReady, true);
  assert.deepEqual(plan.channels, []);
});
