/**
 * CI guard: the WheelsHelper reference character file (the platform's
 * own dogfood agent at `examples/reference-agents/wheels-helper`)
 * stays valid against parseElizaCharacter. If someone bumps the
 * Eliza parser shape, this catches it before the reference agent
 * silently breaks in a deploy.
 *
 * Sole-purpose test, not a re-test of parseElizaCharacter — it pins
 * the spec for the WheelsHelper agent and nothing else.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

function loadCharacter(): unknown {
  const here = dirname(fileURLToPath(import.meta.url));
  // tests/ lives 3 levels deep under apps/api, the reference file is at
  // <repo>/examples/reference-agents/wheels-helper/character.json.
  const path = resolve(
    here,
    "..", "..", "..", "..",
    "examples", "reference-agents", "wheels-helper", "character.json",
  );
  return JSON.parse(readFileSync(path, "utf8"));
}

test("WheelsHelper character.json: parses without warnings or errors", async () => {
  setupEnv();
  const { parseElizaCharacter } = await import(
    "../services/frameworks/eliza.js"
  );

  const parsed = parseElizaCharacter(loadCharacter());

  assert.equal(parsed.name, "WheelsHelper");
  assert.equal(parsed.username, "wheels-helper");
  assert.equal(parsed.slug, "wheels-helper");
  assert.equal(parsed.modelProvider, "anthropic");
  assert.deepEqual(parsed.warnings, [], "no parse warnings should be emitted");
});

test("WheelsHelper character.json: declares Discord + Telegram inbound channels", async () => {
  setupEnv();
  const { parseElizaCharacter } = await import(
    "../services/frameworks/eliza.js"
  );

  const parsed = parseElizaCharacter(loadCharacter());

  // Bindings are the (platform, envKeys) pairs the channel-webhooks
  // pipeline (plan A6) needs to register subscriptions for. The
  // reference agent is configured for both Discord and Telegram.
  const platforms = parsed.channelBindings.map((b) => b.platform).sort();
  assert.deepEqual(platforms, ["discord", "telegram"]);
});

test("WheelsHelper character.json: requires the right env vars", async () => {
  setupEnv();
  const { parseElizaCharacter } = await import(
    "../services/frameworks/eliza.js"
  );

  const parsed = parseElizaCharacter(loadCharacter());

  // Failing this test = somebody changed the character file in a way
  // that adds/removes channels and didn't update the deployment runbook.
  // Update both or rebase.
  assert.deepEqual(parsed.requiredEnvVars, [
    "ANTHROPIC_API_KEY",
    "DISCORD_API_TOKEN",
    "DISCORD_APPLICATION_ID",
    "TELEGRAM_BOT_TOKEN",
  ]);
});
