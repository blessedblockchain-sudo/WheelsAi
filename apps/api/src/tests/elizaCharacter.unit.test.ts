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

// Drives apps/api/src/services/frameworks/eliza.ts — the parser that takes
// an ElizaOS character.json and returns the deployment-relevant facts:
//
//   name / username   — display + slug
//   clients           — channel platforms the agent is configured for
//   plugins           — installed plugin packages
//   modelProvider     — which LLM the agent runs on
//   requiredEnvVars   — derived env keys the OpenClaw container must have
//                       set before the agent will boot (model API keys,
//                       per-client bot tokens, etc.)
//   channelBindings   — concrete (platform → OpenClawChannel) bindings the
//                       deploy wizard should provision
//
// This is the differentiator that makes "framework-aware deployment" real
// instead of a string enum (plan A10).

// ============================================
// Happy paths
// ============================================

test("parseElizaCharacter extracts name + username + slug from a minimal character", async () => {
  setupEnv();
  const { parseElizaCharacter } = await import(
    "../services/frameworks/eliza.js"
  );
  const result = parseElizaCharacter({
    name: "Eliza",
    username: "elizaBot",
    clients: [],
    plugins: [],
    modelProvider: "openai",
  });
  assert.equal(result.name, "Eliza");
  assert.equal(result.username, "elizaBot");
  assert.equal(result.slug, "elizabot");
});

test("parseElizaCharacter derives slug from name when username is omitted", async () => {
  const { parseElizaCharacter } = await import(
    "../services/frameworks/eliza.js"
  );
  const result = parseElizaCharacter({
    name: "Trump 2024 Bot",
    clients: [],
    plugins: [],
    modelProvider: "anthropic",
  });
  assert.equal(result.slug, "trump-2024-bot");
});

test("parseElizaCharacter normalizes the client list and dedupes aliases", async () => {
  const { parseElizaCharacter } = await import(
    "../services/frameworks/eliza.js"
  );
  // Eliza has historically used both 'twitter' and 'x' for the same client.
  const result = parseElizaCharacter({
    name: "x",
    clients: ["DISCORD", "twitter", "x", "telegram"],
    plugins: [],
    modelProvider: "openai",
  });
  assert.deepEqual(result.clients.sort(), ["discord", "telegram", "twitter"]);
});

// ============================================
// Plugin → client inference
// ============================================

test("parseElizaCharacter infers a missing discord client from @elizaos/plugin-discord", async () => {
  const { parseElizaCharacter } = await import(
    "../services/frameworks/eliza.js"
  );
  const result = parseElizaCharacter({
    name: "x",
    clients: [],
    plugins: ["@elizaos/plugin-bootstrap", "@elizaos/plugin-discord"],
    modelProvider: "openai",
  });
  assert.deepEqual(result.clients, ["discord"]);
  assert.deepEqual(result.plugins.sort(), [
    "@elizaos/plugin-bootstrap",
    "@elizaos/plugin-discord",
  ]);
});

test("parseElizaCharacter infers telegram + slack from their plugins", async () => {
  const { parseElizaCharacter } = await import(
    "../services/frameworks/eliza.js"
  );
  const result = parseElizaCharacter({
    name: "x",
    clients: [],
    plugins: ["@elizaos/plugin-telegram", "@elizaos/plugin-slack"],
    modelProvider: "openai",
  });
  assert.deepEqual(result.clients.sort(), ["slack", "telegram"]);
});

// ============================================
// Required env vars
// ============================================

test("parseElizaCharacter requires the OPENAI_API_KEY when modelProvider is openai", async () => {
  const { parseElizaCharacter } = await import(
    "../services/frameworks/eliza.js"
  );
  const result = parseElizaCharacter({
    name: "x",
    clients: [],
    plugins: [],
    modelProvider: "openai",
  });
  assert.ok(result.requiredEnvVars.includes("OPENAI_API_KEY"));
});

test("parseElizaCharacter requires the ANTHROPIC_API_KEY when modelProvider is anthropic", async () => {
  const { parseElizaCharacter } = await import(
    "../services/frameworks/eliza.js"
  );
  const result = parseElizaCharacter({
    name: "x",
    clients: [],
    plugins: [],
    modelProvider: "anthropic",
  });
  assert.ok(result.requiredEnvVars.includes("ANTHROPIC_API_KEY"));
});

test("parseElizaCharacter adds Discord env vars (token + app id + public key) when discord is a client", async () => {
  const { parseElizaCharacter } = await import(
    "../services/frameworks/eliza.js"
  );
  const result = parseElizaCharacter({
    name: "x",
    clients: ["discord"],
    plugins: [],
    modelProvider: "openai",
  });
  assert.ok(result.requiredEnvVars.includes("DISCORD_API_TOKEN"));
  assert.ok(result.requiredEnvVars.includes("DISCORD_APPLICATION_ID"));
  assert.ok(result.requiredEnvVars.includes("DISCORD_VOICE_CHANNEL_ID") === false); // voice optional
});

test("parseElizaCharacter adds TELEGRAM_BOT_TOKEN when telegram is a client", async () => {
  const { parseElizaCharacter } = await import(
    "../services/frameworks/eliza.js"
  );
  const result = parseElizaCharacter({
    name: "x",
    clients: ["telegram"],
    plugins: [],
    modelProvider: "openai",
  });
  assert.ok(result.requiredEnvVars.includes("TELEGRAM_BOT_TOKEN"));
});

test("parseElizaCharacter adds Slack env vars when slack is a client", async () => {
  const { parseElizaCharacter } = await import(
    "../services/frameworks/eliza.js"
  );
  const result = parseElizaCharacter({
    name: "x",
    clients: ["slack"],
    plugins: [],
    modelProvider: "openai",
  });
  assert.ok(result.requiredEnvVars.includes("SLACK_BOT_TOKEN"));
  assert.ok(result.requiredEnvVars.includes("SLACK_SIGNING_SECRET"));
});

test("parseElizaCharacter dedupes required env vars", async () => {
  const { parseElizaCharacter } = await import(
    "../services/frameworks/eliza.js"
  );
  // discord client AND discord plugin → only one set of env vars
  const result = parseElizaCharacter({
    name: "x",
    clients: ["discord"],
    plugins: ["@elizaos/plugin-discord"],
    modelProvider: "openai",
  });
  const tokenCount = result.requiredEnvVars.filter(
    (v) => v === "DISCORD_API_TOKEN",
  ).length;
  assert.equal(tokenCount, 1);
});

// ============================================
// Channel bindings (deploy wizard input)
// ============================================

test("parseElizaCharacter emits a channelBinding for each supported client", async () => {
  const { parseElizaCharacter } = await import(
    "../services/frameworks/eliza.js"
  );
  const result = parseElizaCharacter({
    name: "x",
    clients: ["discord", "telegram"],
    plugins: [],
    modelProvider: "openai",
  });
  const platforms = result.channelBindings.map((b) => b.platform).sort();
  assert.deepEqual(platforms, ["discord", "telegram"]);
  // Each binding declares which env keys feed it so the wizard can collect them.
  const discord = result.channelBindings.find((b) => b.platform === "discord")!;
  assert.ok(discord.envKeys.includes("DISCORD_API_TOKEN"));
});

test("parseElizaCharacter does NOT emit a channelBinding for twitter (no inbound webhook support yet)", async () => {
  const { parseElizaCharacter } = await import(
    "../services/frameworks/eliza.js"
  );
  // twitter → outbound only via the eliza twitter client, no inbound webhook
  const result = parseElizaCharacter({
    name: "x",
    clients: ["twitter", "discord"],
    plugins: [],
    modelProvider: "openai",
  });
  const platforms = result.channelBindings.map((b) => b.platform);
  assert.ok(!platforms.includes("twitter"));
  assert.ok(platforms.includes("discord"));
});

// ============================================
// Validation
// ============================================

test("parseElizaCharacter throws when the character is missing a name", async () => {
  const { parseElizaCharacter } = await import(
    "../services/frameworks/eliza.js"
  );
  assert.throws(
    () =>
      parseElizaCharacter({
        clients: [],
        plugins: [],
        modelProvider: "openai",
      } as any),
    /name/i,
  );
});

test("parseElizaCharacter throws when modelProvider is unsupported", async () => {
  const { parseElizaCharacter } = await import(
    "../services/frameworks/eliza.js"
  );
  assert.throws(
    () =>
      parseElizaCharacter({
        name: "x",
        clients: [],
        plugins: [],
        modelProvider: "intercept",
      } as any),
    /modelProvider/i,
  );
});

test("parseElizaCharacter ignores unknown clients but records them in warnings", async () => {
  const { parseElizaCharacter } = await import(
    "../services/frameworks/eliza.js"
  );
  const result = parseElizaCharacter({
    name: "x",
    clients: ["discord", "myspace", "irc"],
    plugins: [],
    modelProvider: "openai",
  });
  assert.deepEqual(result.clients, ["discord"]);
  assert.deepEqual(result.warnings.sort(), [
    "unsupported_client:irc",
    "unsupported_client:myspace",
  ]);
});

test("parseElizaCharacter accepts a JSON string input as a convenience", async () => {
  const { parseElizaCharacter } = await import(
    "../services/frameworks/eliza.js"
  );
  const json = JSON.stringify({
    name: "x",
    clients: ["discord"],
    plugins: [],
    modelProvider: "openai",
  });
  const result = parseElizaCharacter(json);
  assert.equal(result.name, "x");
  assert.deepEqual(result.clients, ["discord"]);
});
