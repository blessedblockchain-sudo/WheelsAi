/**
 * services/agentSlug.ts: the slug rule lifted from POST /api/agents, held to
 * what the route did before the lift.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { slugify, uniqueAgentSlug } from "../services/agentSlug.js";

const takenFrom = (slugs: string[]) => {
  const asked: string[] = [];
  return { asked, taken: async (slug: string) => (asked.push(slug), slugs.includes(slug)) };
};

test("slugify lower-cases and turns every run of other characters into one hyphen", () => {
  assert.equal(slugify("Support Bot"), "support-bot");
  assert.equal(slugify("  Hello,   World!  "), "hello-world");
  assert.equal(slugify("v2.0 — Agent_X"), "v2-0-agent-x");
  assert.equal(slugify("already-a-slug"), "already-a-slug");
  assert.equal(slugify("日本語"), "");
  assert.equal(slugify("---"), "");
});

test("a free name is used as it is, with one lookup", async () => {
  const world = takenFrom([]);
  assert.equal(await uniqueAgentSlug({ from: "Support Bot", taken: world.taken }), "support-bot");
  assert.deepEqual(world.asked, ["support-bot"]);
});

test("a taken name counts up from 1 until one is free", async () => {
  const world = takenFrom(["support-bot", "support-bot-1", "support-bot-2"]);
  assert.equal(await uniqueAgentSlug({ from: "Support Bot", taken: world.taken }), "support-bot-3");
  assert.deepEqual(world.asked, ["support-bot", "support-bot-1", "support-bot-2", "support-bot-3"]);
});

test("a name with no ASCII letters or digits gets agent-<six hex>, never an empty slug", async () => {
  const slug = await uniqueAgentSlug({ from: "日本語", taken: async () => false });
  assert.match(slug, /^agent-[0-9a-f]{6}$/);

  const fixed = await uniqueAgentSlug({ from: "!!!", taken: async () => false, randomSuffix: () => "abc123" });
  assert.equal(fixed, "agent-abc123");
});

test("the random root is chosen once, then counted up like any other", async () => {
  let draws = 0;
  const slug = await uniqueAgentSlug({
    from: "日本語",
    taken: async (candidate) => candidate === "agent-abc123",
    randomSuffix: () => ((draws += 1), "abc123"),
  });
  assert.equal(slug, "agent-abc123-1");
  assert.equal(draws, 1);
});
