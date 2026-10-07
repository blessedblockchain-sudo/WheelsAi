import assert from "node:assert/strict";
import test from "node:test";

import { loadSkillsConfig } from "../config/skills.js";
import { InMemoryAgentFileStore } from "../services/skills/agentFileStore.js";
import type { BuiltinSkillDeps } from "../services/skills/builtinDeps.js";
import { SkillRegistry, createSkillRegistry } from "../services/skills/registry.js";
import { resolveToolMode } from "../services/skills/runMode.js";
import type { SkillDefinition, ToolContext, ToolMode } from "../services/skills/types.js";

// The `public` tool mode: an anonymous visitor is typing (the web chat
// widget, Try it). No skill that moves money, changes the agent's saved
// data, reads it back, or sends a request to an address the model chooses.

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  mode: "public",
  agentId: "agent_1",
  orgId: "org_1",
  ...over,
});

function makeDeps(over: Partial<BuiltinSkillDeps> = {}): BuiltinSkillDeps {
  const config = loadSkillsConfig({});
  return {
    getConfig: () => ({ config, error: null }),
    getFileStore: () => null,
    getSandbox: () => null,
    knowledge: {
      loadKnowledgeBaseId: async () => null,
      search: async () => ({ results: [], mode: "keyword", fallbackReason: null }),
    },
    guardDeps: { resolveHost: async () => ["93.184.216.34"] },
    ...over,
  };
}

const fakeSkill = (over: Partial<SkillDefinition> = {}): SkillDefinition => ({
  key: "fake",
  version: "1.0.0",
  name: "Fake",
  description: "fake",
  inputSchema: { type: "object", properties: {} },
  moneyMoving: false,
  execute: async () => ({ status: "ok", output: "ran" }),
  ...over,
});

const ALL = ["calculator", "web_search", "knowledge_search", "code_interpreter", "http_request", "file_read", "file_write"];

test("a public visitor is offered the agent's harmless tools and none of the four kinds", () => {
  const registry = createSkillRegistry(makeDeps());
  const offered = registry.toolSpecs(ALL, { mode: "public" }).map((spec) => spec.function.name);
  assert.deepEqual(offered, ["calculator", "web_search", "knowledge_search", "code_interpreter"]);

  // The owner's own chat still has all of them.
  assert.deepEqual(
    registry.toolSpecs(ALL, { mode: "playground" }).map((spec) => spec.function.name),
    ALL,
  );
});

test("file_read and file_write are refused at execute time, with the reason, and never touch storage", async () => {
  const store = new InMemoryAgentFileStore();
  await store.put("agent-files/org_1/agent_1/notes.txt", "the owner's private notes");
  const registry = createSkillRegistry(makeDeps({ getFileStore: () => store }));

  const read = await registry.execute("file_read", { path: "notes.txt" }, ctx());
  assert.equal(read.status, "unavailable");
  assert.match((read as { reason: string }).reason, /reads the agent's saved data.*public visitors/);
  assert.ok(!JSON.stringify(read).includes("private notes"));

  const listed = await registry.execute("file_read", {}, ctx());
  assert.equal(listed.status, "unavailable", "listing the files is reading them");

  const written = await registry.execute("file_write", { path: "notes.txt", content: "defaced" }, ctx());
  assert.equal(written.status, "unavailable");
  assert.match((written as { reason: string }).reason, /changes the agent's saved data.*public mode.*visitor/);
  assert.equal(store.objects.get("agent-files/org_1/agent_1/notes.txt"), "the owner's private notes");
});

test("http_request is refused for a public visitor, and no allowlist brings it back", async () => {
  let fetched = false;
  const registry = createSkillRegistry(
    makeDeps({
      fetchImpl: (async () => {
        fetched = true;
        return new Response("ok");
      }) as unknown as typeof fetch,
    }),
  );
  for (const outboundAllowed of [undefined, [], ["http_request"]]) {
    const context = ctx({ ...(outboundAllowed && { outboundAllowed }) });
    assert.deepEqual(
      registry.toolSpecs(["http_request"], context).map((spec) => spec.function.name),
      [],
    );
    const result = await registry.execute("http_request", { url: "https://example.com/" }, context);
    assert.equal(result.status, "unavailable");
    assert.match((result as { reason: string }).reason, /sends data to an address the model chooses.*public visitors/);
  }
  assert.equal(fetched, false);
});

test("a money-moving skill never runs for a public visitor", async () => {
  let ran = false;
  const registry = new SkillRegistry([
    fakeSkill({
      key: "hire_agent",
      moneyMoving: true,
      execute: async () => {
        ran = true;
        return { status: "ok", output: "hired" };
      },
    }),
    fakeSkill({ key: "calculator" }),
  ]);
  assert.deepEqual(
    registry.toolSpecs(["hire_agent", "calculator"], { mode: "public" }).map((spec) => spec.function.name),
    ["calculator"],
  );
  const result = await registry.execute("hire_agent", {}, ctx());
  assert.equal(result.status, "unavailable");
  assert.match((result as { reason: string }).reason, /moves money.*public/);
  assert.equal(ran, false);
});

test("each of the four flags alone is enough to withhold a skill", () => {
  const registry = new SkillRegistry([
    fakeSkill({ key: "spends", moneyMoving: true }),
    fakeSkill({ key: "writes", writesState: true }),
    fakeSkill({ key: "reads", readsPrivateState: true }),
    fakeSkill({ key: "sends", sendsOutbound: true }),
    fakeSkill({ key: "plain" }),
  ]);
  const keys = ["spends", "writes", "reads", "sends", "plain"];
  assert.deepEqual(
    registry.toolSpecs(keys, { mode: "public" }).map((spec) => spec.function.name),
    ["plain"],
  );
  for (const key of keys.slice(0, 4)) {
    assert.notEqual(registry.modeBlock(registry.get(key)!, { mode: "public" }), null, key);
  }
});

test("the other modes are as they were: a marketplace clone still reads and writes its own files", async () => {
  const store = new InMemoryAgentFileStore();
  const registry = createSkillRegistry(makeDeps({ getFileStore: () => store }));
  const trial = ctx({ mode: "trial" });
  assert.deepEqual(
    registry.toolSpecs(["file_read", "file_write", "http_request"], trial).map((spec) => spec.function.name),
    ["file_read", "file_write", "http_request"],
  );
  assert.equal((await registry.execute("file_write", { path: "a.txt", content: "mine" }, trial)).status, "ok");
  assert.deepEqual(await registry.execute("file_read", { path: "a.txt" }, trial), { status: "ok", output: "mine" });

  // Reading is still allowed where only writing is refused.
  for (const mode of ["test", "hired"] as const satisfies readonly ToolMode[]) {
    assert.equal(registry.modeBlock(registry.get("file_read")!, { mode }), null, mode);
    assert.notEqual(registry.modeBlock(registry.get("file_write")!, { mode }), null, mode);
  }
});

test("public is never loosened: an installed copy in a widget does not become trial, which reads and writes", async () => {
  let looked = false;
  const mode = await resolveToolMode(
    { agentId: "agent_1", orgId: "org_1", base: "public" },
    {
      isMarketplaceInstall: async () => {
        looked = true;
        return true;
      },
    },
  );
  assert.equal(mode, "public");
  assert.equal(looked, false);
});
