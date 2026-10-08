/**
 * services/agentPublicLink.ts and routes/agentPublicLink.ts: the owner's
 * switch for an agent's public page.
 *
 * The database is an in-memory stand-in that applies the same `where` the
 * service sends and holds the two unique indexes the real one has (one handle
 * per platform, one page key per agent), so "two enables make one key" and
 * "another organization's agent is not found" are tested as the queries, not
 * as a mock's return value. A transaction that throws is undone.
 */
import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import Fastify, { type FastifyInstance, type preHandlerAsyncHookHandler } from "fastify";

import { createRequireRole } from "../middleware/auth.js";
import { createAgentPublicLinkRoutes } from "../routes/agentPublicLink.js";
import {
  assignPublicHandle,
  ensurePageKey,
  ensurePublicPage,
  getPublicLink,
  isHandleConflict,
  PAGE_KEY_NAME,
  PublicLinkError,
  setPageUse,
  setPublicLink,
  type AgentPublicLinkDeps,
  type LinkAgentRow,
  type NewPageKey,
  type PageKeyRow,
  type PublicLinkTx,
} from "../services/agentPublicLink.js";
import { buildAgentPublicLinkDeps, toolOffForVisitors } from "../services/buildAgentPublicLinkDeps.js";
import { createFailClosedLimiter, createMemoryLimiterStore } from "../services/failClosedLimiter.js";
import { publicChatKeys, utcDay } from "../services/publicChat.js";
import { HANDLE_MESSAGES } from "../services/publicHandle.js";
import { PAGE_DAILY_CAP_DEFAULT, PAGE_DAILY_CAP_MAX, pageKeyUsable } from "../services/publicPageState.js";
import { SkillRegistry } from "../services/skills/registry.js";
import type { SkillDefinition } from "../services/skills/types.js";

const ORG = "org-owner";
const OTHER_ORG = "org-other";
const AGENT = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-08T12:00:00Z");
const WEB = "https://app.wheelsai.test";

interface StoredAgent extends LinkAgentRow {
  orgId: string;
}
interface StoredKey extends PageKeyRow, Omit<NewPageKey, "pageOfAgentId" | "dailyMessageCap" | "enabled"> {
  pageOfAgentId: string | null;
}

interface Hooks {
  /** Runs once, just before the page key insert: what another request did first. */
  beforeCreateKey?: () => void;
  /** Runs once, just before a compare-and-set on a key's `enabled`. */
  beforeSwitch?: () => void;
  /** Runs once, just before a handle is written. */
  beforeHandleWrite?: () => void;
}

const unique = (target: string) =>
  Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target: [target] } });

function fakeWorld(over: { agent?: Partial<StoredAgent>; keys?: StoredKey[] } = {}) {
  const state = {
    agents: [
      {
        id: AGENT,
        orgId: ORG,
        slug: "support-bot",
        isPublic: false,
        publicHandle: null,
        publicResults: false,
        tools: [{ name: "calculator" }],
        ...over.agent,
      },
      {
        id: OTHER_AGENT,
        orgId: OTHER_ORG,
        slug: "support-bot",
        isPublic: false,
        publicHandle: null,
        publicResults: false,
        tools: [],
      },
    ] as StoredAgent[],
    keys: [...(over.keys ?? [])],
  };
  const hooks: Hooks = {};
  const writes: string[] = [];
  let transactions = 0;
  let seq = 0;

  /** What other requests committed during a transaction: it stays when that transaction is undone. */
  const elsewhere: Array<() => void> = [];
  const fire = (name: keyof Hooks) => {
    const hook = hooks[name];
    if (!hook) return;
    delete hooks[name];
    elsewhere.push(hook);
    hook();
  };
  const matches = (row: object, where: Record<string, unknown>) =>
    Object.entries(where).every(
      ([field, value]) => value === undefined || (row as Record<string, unknown>)[field] === value,
    );

  const db: PublicLinkTx = {
    agent: {
      findFirst: async ({ where }) => {
        const agent = state.agents.find((candidate) => matches(candidate, where));
        return agent ? { ...agent } : null;
      },
      updateMany: async ({ where, data }) => {
        if (data.publicHandle !== undefined) fire("beforeHandleWrite");
        const hit = state.agents.filter((agent) => matches(agent, where));
        for (const agent of hit) {
          // The unique index on agents.public_handle.
          if (
            data.publicHandle !== undefined &&
            state.agents.some((other) => other.id !== agent.id && other.publicHandle === data.publicHandle)
          ) {
            throw unique("public_handle");
          }
          Object.assign(agent, data);
          writes.push(`agent:${Object.keys(data).join(",")}`);
        }
        return { count: hit.length };
      },
    },
    widgetKey: {
      findFirst: async ({ where }) => {
        const key = state.keys.find((candidate) => matches(candidate, where));
        return key
          ? { id: key.id, enabled: key.enabled, revokedAt: key.revokedAt, dailyMessageCap: key.dailyMessageCap }
          : null;
      },
      createMany: async ({ data, skipDuplicates }) => {
        assert.equal(skipDuplicates, true);
        fire("beforeCreateKey");
        let count = 0;
        for (const row of data) {
          // The unique index on widget_keys.page_of_agent_id, and the CHECK beside it.
          assert.equal(row.pageOfAgentId, row.agentId);
          if (state.keys.some((key) => key.pageOfAgentId === row.pageOfAgentId)) continue;
          seq += 1;
          state.keys.push({ ...row, id: `key-${seq}`, revokedAt: null });
          writes.push("key:create");
          count += 1;
        }
        return { count };
      },
      updateMany: async ({ where, data }) => {
        if (data.enabled !== undefined) fire("beforeSwitch");
        const hit = state.keys.filter((key) => matches(key, where));
        for (const key of hit) {
          Object.assign(key, data);
          writes.push(`key:${Object.keys(data).join(",")}`);
        }
        return { count: hit.length };
      },
    },
  };

  const limiter = createFailClosedLimiter(createMemoryLimiterStore(() => NOW.getTime()));
  let n = 0;
  const deps: AgentPublicLinkDeps = {
    db,
    transaction: async (fn) => {
      transactions += 1;
      const before = { agents: state.agents.map((a) => ({ ...a })), keys: state.keys.map((k) => ({ ...k })) };
      elsewhere.length = 0;
      try {
        return await fn(db);
      } catch (err) {
        state.agents = before.agents;
        state.keys = before.keys;
        for (const committed of elsewhere) committed();
        throw err;
      }
    },
    limiter,
    pageUrl: (handle) => `${WEB}/a/${handle}`,
    toolOffForVisitors: (name) => name === "http_request" || name === "file_read",
    keyDefaultDailyCap: 1000,
    generatePublicKey: () => `wpk_${String((n += 1)).padStart(32, "0")}`,
    now: () => NOW,
  };
  return {
    deps,
    db,
    state,
    hooks,
    writes,
    limiter,
    transactions: () => transactions,
    agent: () => state.agents.find((agent) => agent.id === AGENT)!,
    pageKeys: () => state.keys.filter((key) => key.pageOfAgentId === AGENT),
  };
}

const pageKey = (over: Partial<StoredKey> = {}): StoredKey => ({
  id: "key-existing",
  orgId: ORG,
  agentId: AGENT,
  pageOfAgentId: AGENT,
  publicKey: `wpk_${"e".repeat(32)}`,
  name: PAGE_KEY_NAME,
  allowedOrigins: [],
  dailyMessageCap: PAGE_DAILY_CAP_DEFAULT,
  storeTranscripts: false,
  enabled: true,
  revokedAt: null,
  ...over,
});

const refused = (status: number, code: string) => (err: unknown) => {
  assert.ok(err instanceof PublicLinkError, String(err));
  assert.equal(err.status, status);
  assert.equal(err.code, code);
  return true;
};

// ============================================
// On
// ============================================

test("on: the page is public, it has its address, and it has one page key made as the plan says", async () => {
  const world = fakeWorld();
  const link = await setPublicLink(world.deps, ORG, AGENT, { state: "on" });

  assert.deepEqual(link, {
    state: "on",
    handle: "support-bot",
    url: `${WEB}/a/support-bot`,
    dailyCap: PAGE_DAILY_CAP_DEFAULT,
    usedToday: 0,
    showResults: false,
    toolsOffForVisitors: false,
  });
  assert.equal(world.agent().isPublic, true);
  assert.equal(world.state.keys.length, 1);
  const { id, ...key } = world.state.keys[0]!;
  assert.equal(id, "key-1");
  assert.deepEqual(key, {
    orgId: ORG,
    agentId: AGENT,
    pageOfAgentId: AGENT,
    publicKey: `wpk_${"1".padStart(32, "0")}`,
    name: PAGE_KEY_NAME,
    // None: the platform's own origins always count.
    allowedOrigins: [],
    dailyMessageCap: 100,
    storeTranscripts: false,
    enabled: true,
    revokedAt: null,
  });
  assert.equal(pageKeyUsable(world.agent().isPublic, world.state.keys[0]!), true);
});

test("on, twice: one key, the same address, and the second call writes nothing", async () => {
  const world = fakeWorld();
  const first = await setPublicLink(world.deps, ORG, AGENT, { state: "on" });
  world.writes.length = 0;
  const second = await setPublicLink(world.deps, ORG, AGENT, { state: "on" });
  assert.deepEqual(second, first);
  assert.equal(world.pageKeys().length, 1);
  assert.deepEqual(world.writes, []);
});

test("on, twice at the same moment: the unique index decides, and both answer the one key", async () => {
  const world = fakeWorld();
  const [a, b] = await Promise.all([
    setPublicLink(world.deps, ORG, AGENT, { state: "on" }),
    setPublicLink(world.deps, ORG, AGENT, { state: "on" }),
  ]);
  assert.equal(a.state, "on");
  assert.deepEqual(a, b);
  assert.equal(world.state.keys.length, 1);
  assert.equal(world.writes.filter((write) => write === "key:create").length, 1);
});

test("on, losing the insert to another request: nothing is raised, and the loser reads the winner's key", async () => {
  const world = fakeWorld();
  // The other request's key lands between this one's look and its insert.
  world.hooks.beforeCreateKey = () => {
    world.state.keys.push(pageKey({ id: "key-winner", dailyMessageCap: 250 }));
  };
  const link = await setPublicLink(world.deps, ORG, AGENT, { state: "on" });
  assert.equal(link.state, "on");
  assert.equal(link.dailyCap, 250, "the winner's key, as it is");
  assert.deepEqual(world.state.keys.map((key) => key.id), ["key-winner"]);

  // The write itself, as a later batch calls it inside its own transaction.
  const again = fakeWorld();
  again.hooks.beforeCreateKey = () => void again.state.keys.push(pageKey({ id: "key-winner", enabled: false }));
  const key = await ensurePageKey(again.db, { orgId: ORG, agentId: AGENT });
  assert.deepEqual(key, { id: "key-winner", enabled: false, revokedAt: null, dailyMessageCap: 100 });
  assert.equal(again.state.keys.length, 1);
});

test("on, with a handle taken by another organization's agent of the same slug: the next candidate carries the id", async () => {
  const world = fakeWorld();
  world.state.agents[1]!.publicHandle = "support-bot";
  const link = await setPublicLink(world.deps, ORG, AGENT, { state: "on" });
  assert.equal(link.handle, "support-bot-11111111");
  assert.equal(link.url, `${WEB}/a/support-bot-11111111`);
});

test("on, losing the address to another agent between the look and the write: the transaction runs again and takes the next", async () => {
  const world = fakeWorld();
  world.hooks.beforeHandleWrite = () => {
    world.state.agents[1]!.publicHandle = "support-bot";
  };
  const link = await setPublicLink(world.deps, ORG, AGENT, { state: "on" });
  assert.equal(link.state, "on");
  assert.equal(link.handle, "support-bot-11111111");
  assert.equal(world.transactions(), 2);
  assert.equal(world.pageKeys().length, 1);
});

test("on keeps the address an agent already has", async () => {
  const world = fakeWorld({ agent: { isPublic: true, publicHandle: "our-helper" } });
  const link = await setPublicLink(world.deps, ORG, AGENT, { state: "on" });
  assert.equal(link.handle, "our-helper");
  assert.ok(!world.writes.includes("agent:publicHandle"));
});

// ============================================
// View only
// ============================================

test("an agent that is public today and has no key reads as view_only, and looking changes nothing", async () => {
  const world = fakeWorld({ agent: { isPublic: true, publicHandle: "support-bot" } });
  const link = await getPublicLink(world.deps, ORG, AGENT);
  assert.deepEqual(link, {
    state: "view_only",
    handle: "support-bot",
    url: `${WEB}/a/support-bot`,
    dailyCap: PAGE_DAILY_CAP_DEFAULT,
    usedToday: 0,
    showResults: false,
    toolsOffForVisitors: false,
  });
  assert.deepEqual(world.writes, []);
  assert.equal(world.state.keys.length, 0);
  assert.equal(world.transactions(), 0);

  // Nor does pausing: there is nothing to pause, and the answer is the state as it is.
  const paused = await setPublicLink(world.deps, ORG, AGENT, { state: "paused" });
  assert.equal(paused.state, "view_only");
  assert.deepEqual(world.writes, []);
});

test("a private agent reads as off, with no address until it has had one", async () => {
  const world = fakeWorld();
  const link = await getPublicLink(world.deps, ORG, AGENT);
  assert.equal(link.state, "off");
  assert.equal(link.handle, null);
  assert.equal(link.url, null);
  // Pausing never publishes a page.
  assert.equal((await setPublicLink(world.deps, ORG, AGENT, { state: "paused" })).state, "off");
  assert.equal(world.agent().isPublic, false);
});

test("a revoked page key counts as no key, and on then makes a new one", async () => {
  // As services/webChannel.ts leaves a revoked key: the mark is cleared.
  const cleared = fakeWorld({
    agent: { isPublic: true, publicHandle: "support-bot" },
    keys: [pageKey({ id: "key-old", pageOfAgentId: null, enabled: false, revokedAt: NOW })],
  });
  assert.equal((await getPublicLink(cleared.deps, ORG, AGENT)).state, "view_only");
  assert.equal((await setPublicLink(cleared.deps, ORG, AGENT, { state: "on" })).state, "on");
  assert.deepEqual(cleared.state.keys.map((key) => [key.id, key.pageOfAgentId, key.enabled]), [
    ["key-old", null, false],
    ["key-1", AGENT, true],
  ]);

  // A revoked row that still carries the mark is let go, not switched back on.
  const marked = fakeWorld({
    agent: { isPublic: true, publicHandle: "support-bot" },
    keys: [pageKey({ id: "key-old", enabled: false, revokedAt: NOW })],
  });
  assert.equal((await getPublicLink(marked.deps, ORG, AGENT)).state, "view_only");
  assert.equal((await setPublicLink(marked.deps, ORG, AGENT, { state: "on" })).state, "on");
  assert.deepEqual(marked.state.keys.map((key) => [key.id, key.pageOfAgentId, key.enabled, key.revokedAt]), [
    ["key-old", null, false, NOW],
    ["key-1", AGENT, true, null],
  ]);
});

// ============================================
// Pause and resume
// ============================================

test("pause and resume are a compare-and-set on the page key; the page stays public and the key is the same", async () => {
  const world = fakeWorld();
  await setPublicLink(world.deps, ORG, AGENT, { state: "on" });
  world.writes.length = 0;

  const paused = await setPublicLink(world.deps, ORG, AGENT, { state: "paused" });
  assert.equal(paused.state, "paused");
  assert.equal(world.agent().isPublic, true);
  assert.equal(world.state.keys[0]!.enabled, false);
  assert.deepEqual(world.writes, ["key:enabled"]);

  // Again: already paused, so nothing is written.
  assert.equal((await setPublicLink(world.deps, ORG, AGENT, { state: "paused" })).state, "paused");
  assert.deepEqual(world.writes, ["key:enabled"]);

  const resumed = await setPublicLink(world.deps, ORG, AGENT, { state: "on" });
  assert.equal(resumed.state, "on");
  assert.deepEqual(world.state.keys.map((key) => [key.id, key.enabled]), [["key-1", true]]);
  assert.deepEqual(world.writes, ["key:enabled", "key:enabled"]);
});

test("a compare-and-set that lost is not an error: the answer is the state as it now is", async () => {
  // Someone resumed it first.
  const resume = fakeWorld({ agent: { isPublic: true, publicHandle: "support-bot" }, keys: [pageKey({ enabled: false })] });
  resume.hooks.beforeSwitch = () => {
    resume.state.keys[0]!.enabled = true;
  };
  assert.equal((await setPublicLink(resume.deps, ORG, AGENT, { state: "on" })).state, "on");
  assert.deepEqual(resume.writes, []);

  // Someone revoked the key on the Channels page while this request paused it.
  const pause = fakeWorld({ agent: { isPublic: true, publicHandle: "support-bot" }, keys: [pageKey()] });
  pause.hooks.beforeSwitch = () => {
    Object.assign(pause.state.keys[0]!, { enabled: false, revokedAt: NOW, pageOfAgentId: null });
  };
  assert.equal((await setPublicLink(pause.deps, ORG, AGENT, { state: "paused" })).state, "view_only");
  assert.deepEqual(pause.writes, []);

  // The write itself says whether it moved anything.
  const direct = fakeWorld({ keys: [pageKey({ enabled: false })] });
  assert.deepEqual(await setPageUse(direct.db, { orgId: ORG, agentId: AGENT, enabled: false }), { changed: false });
  assert.deepEqual(await setPageUse(direct.db, { orgId: ORG, agentId: AGENT, enabled: true }), { changed: true });
  assert.deepEqual(await setPageUse(direct.db, { orgId: OTHER_ORG, agentId: AGENT, enabled: false }), { changed: false });
  assert.equal(direct.state.keys[0]!.enabled, true);
});

// ============================================
// Off
// ============================================

test("off: the page is private, its key is disabled with it, and the address is kept for next time", async () => {
  const world = fakeWorld();
  await setPublicLink(world.deps, ORG, AGENT, { state: "on" });

  const off = await setPublicLink(world.deps, ORG, AGENT, { state: "off" });
  assert.equal(off.state, "off");
  assert.equal(off.handle, "support-bot");
  assert.equal(off.url, `${WEB}/a/support-bot`);
  assert.equal(world.agent().isPublic, false);
  assert.equal(world.agent().publicHandle, "support-bot");
  assert.equal(world.state.keys[0]!.enabled, false, "the key cannot be used while the page is off");
  assert.equal(world.state.keys[0]!.pageOfAgentId, AGENT);

  const on = await setPublicLink(world.deps, ORG, AGENT, { state: "on" });
  assert.equal(on.state, "on");
  assert.equal(on.handle, "support-bot");
  assert.deepEqual(world.state.keys.map((key) => [key.id, key.enabled]), [["key-1", true]]);
});

// ============================================
// The address, the cap and the results switch
// ============================================

test("a handle the owner typed is judged as typed: the rules are a 400 by field, and nothing is written", async () => {
  const world = fakeWorld();
  for (const [handle, message] of [
    ["Ab", HANDLE_MESSAGES.invalid_format],
    ["Support-Bot", HANDLE_MESSAGES.invalid_format],
    [" support-bot", HANDLE_MESSAGES.invalid_format],
    ["-support", HANDLE_MESSAGES.invalid_format],
    ["dashboard", HANDLE_MESSAGES.reserved],
  ] as const) {
    await assert.rejects(setPublicLink(world.deps, ORG, AGENT, { state: "on", handle }), (err: unknown) => {
      assert.ok(err instanceof PublicLinkError);
      assert.equal(err.status, 400);
      assert.deepEqual(err.body, {
        error: "validation_failed",
        message,
        fields: { handle: message },
        details: { formErrors: [], fieldErrors: { handle: [message] } },
      });
      return true;
    });
  }
  assert.deepEqual(world.writes, []);
  assert.equal(world.transactions(), 0);
  assert.equal(world.agent().isPublic, false);
});

test("a handle another agent has is 409 handle_taken, whether seen at the look or lost at the write, and the whole change is undone", async () => {
  const world = fakeWorld();
  world.state.agents[1]!.publicHandle = "helpdesk";
  await assert.rejects(setPublicLink(world.deps, ORG, AGENT, { state: "on", handle: "helpdesk" }), (err: unknown) => {
    assert.ok(refused(409, "handle_taken")(err));
    assert.equal((err as PublicLinkError).message, HANDLE_MESSAGES.taken);
    return true;
  });
  assert.equal(world.agent().isPublic, false, "the page was not published on the way");
  assert.equal(world.state.keys.length, 0);

  const raced = fakeWorld();
  raced.hooks.beforeHandleWrite = () => {
    raced.state.agents[1]!.publicHandle = "helpdesk";
  };
  await assert.rejects(
    setPublicLink(raced.deps, ORG, AGENT, { state: "on", handle: "helpdesk" }),
    refused(409, "handle_taken"),
  );
  assert.equal(raced.transactions(), 1, "a typed address is not tried again");
  assert.equal(raced.agent().publicHandle, null);
});

test("a typed handle is set in every state, replaces the one before, and is its own when sent again", async () => {
  const world = fakeWorld();
  assert.equal((await setPublicLink(world.deps, ORG, AGENT, { state: "off", handle: "helpdesk" })).handle, "helpdesk");
  assert.equal(world.agent().isPublic, false);
  const on = await setPublicLink(world.deps, ORG, AGENT, { state: "on", handle: "front-desk" });
  assert.deepEqual([on.state, on.handle, on.url], ["on", "front-desk", `${WEB}/a/front-desk`]);
  world.writes.length = 0;
  assert.equal((await setPublicLink(world.deps, ORG, AGENT, { state: "on", handle: "front-desk" })).handle, "front-desk");
  assert.deepEqual(world.writes, []);
});

test("dailyCap is the page key's daily cap; showResults is the agent's", async () => {
  const world = fakeWorld();
  const link = await setPublicLink(world.deps, ORG, AGENT, { state: "on", dailyCap: 25, showResults: true });
  assert.equal(link.dailyCap, 25);
  assert.equal(link.showResults, true);
  assert.equal(world.state.keys[0]!.dailyMessageCap, 25);
  assert.equal(world.agent().publicResults, true);

  const paused = await setPublicLink(world.deps, ORG, AGENT, { state: "paused", dailyCap: PAGE_DAILY_CAP_MAX, showResults: false });
  assert.deepEqual([paused.state, paused.dailyCap, paused.showResults], ["paused", PAGE_DAILY_CAP_MAX, false]);

  // A cap cleared on the Channels page reads as the platform's default for a key.
  world.state.keys[0]!.dailyMessageCap = null;
  assert.equal((await getPublicLink(world.deps, ORG, AGENT)).dailyCap, 1000);

  // With no page key there is nowhere to keep a cap: the answer is what a new link starts with.
  const none = fakeWorld();
  assert.equal((await setPublicLink(none.deps, ORG, AGENT, { state: "off", dailyCap: 5 })).dailyCap, PAGE_DAILY_CAP_DEFAULT);
  assert.equal(none.state.keys.length, 0);
});

test("usedToday is the counter the public chat keeps for the key, read and never written; unreadable is null", async () => {
  const world = fakeWorld();
  await setPublicLink(world.deps, ORG, AGENT, { state: "on" });
  const counter = publicChatKeys.widgetKeyDay("key-1", utcDay(NOW));
  for (let i = 0; i < 3; i += 1) {
    await world.limiter.consume([{ scope: "key", key: counter, limit: 100, windowSeconds: 3600 }]);
  }
  assert.equal((await getPublicLink(world.deps, ORG, AGENT)).usedToday, 3);
  assert.equal((await getPublicLink(world.deps, ORG, AGENT)).usedToday, 3, "reading does not count");

  // The store is down: null, and the answer is still given.
  const unreadable = await getPublicLink({ ...world.deps, limiter: { peek: async () => null } }, ORG, AGENT);
  assert.equal(unreadable.usedToday, null);
  assert.equal(unreadable.state, "on");
  const throwing = await getPublicLink(
    { ...world.deps, limiter: { peek: async () => Promise.reject(new Error("redis is down")) } },
    ORG,
    AGENT,
  );
  assert.equal(throwing.usedToday, null);
  assert.equal(throwing.state, "on");
});

test("toolsOffForVisitors asks the registry's own rule for the public tool mode", async () => {
  const world = fakeWorld({ agent: { tools: [{ name: "calculator" }, { name: "http_request" }, "junk", null] } });
  assert.equal((await getPublicLink(world.deps, ORG, AGENT)).toolsOffForVisitors, true);
  world.agent().tools = [{ name: "calculator" }, { name: "web_search" }];
  assert.equal((await getPublicLink(world.deps, ORG, AGENT)).toolsOffForVisitors, false);
  world.agent().tools = null;
  assert.equal((await getPublicLink(world.deps, ORG, AGENT)).toolsOffForVisitors, false);

  // The production predicate: SkillRegistry.modeBlock, the rule the chat runtime applies.
  const skill = (key: string, flags: Partial<SkillDefinition>): SkillDefinition =>
    ({ key, version: "1", name: key, description: key, inputSchema: {}, moneyMoving: false, execute: async () => ({ status: "ok", output: "" }), ...flags }) as SkillDefinition;
  const registry = new SkillRegistry([
    skill("plain", {}),
    skill("outbound", { sendsOutbound: true }),
    skill("reader", { readsPrivateState: true }),
    skill("writer", { writesState: true }),
    skill("payer", { moneyMoving: true }),
  ]);
  assert.deepEqual(
    ["plain", "outbound", "reader", "writer", "payer", "not-a-skill"].map((name) => toolOffForVisitors(name, registry)),
    [false, true, true, true, true, false],
  );
  for (const name of ["plain", "outbound", "reader", "writer", "payer"]) {
    assert.equal(
      toolOffForVisitors(name, registry),
      registry.toolSpecs([name], { mode: "public" }).length === 0,
      `${name}: off for visitors exactly when the runtime withholds it`,
    );
  }
});

// ============================================
// Organizations, and the writes on their own
// ============================================

test("another organization's agent is not found, on read and on write, and nothing of it changes", async () => {
  const world = fakeWorld();
  await assert.rejects(getPublicLink(world.deps, OTHER_ORG, AGENT), refused(404, "agent_not_found"));
  for (const state of ["on", "paused", "off"] as const) {
    await assert.rejects(setPublicLink(world.deps, OTHER_ORG, AGENT, { state }), refused(404, "agent_not_found"));
  }
  await assert.rejects(ensurePublicPage(world.db, { orgId: OTHER_ORG, agentId: AGENT }), refused(404, "agent_not_found"));
  assert.deepEqual(world.writes, []);
  assert.equal(world.agent().isPublic, false);
  assert.equal(world.state.keys.length, 0);
});

test("ensurePublicPage: public, with the handle given, the one it has, or the first free candidate", async () => {
  const world = fakeWorld();
  assert.deepEqual(await ensurePublicPage(world.db, { orgId: ORG, agentId: AGENT }), { handle: "support-bot" });
  assert.equal(world.agent().isPublic, true);
  assert.deepEqual(await ensurePublicPage(world.db, { orgId: ORG, agentId: AGENT }), { handle: "support-bot" });
  assert.deepEqual(await ensurePublicPage(world.db, { orgId: ORG, agentId: AGENT, handle: "front-desk" }), { handle: "front-desk" });
  await assert.rejects(ensurePublicPage(world.db, { orgId: ORG, agentId: AGENT, handle: "api" }), refused(400, "validation_failed"));
  assert.equal(world.state.keys.length, 0, "it never makes a page key");

  // Inside a transaction a lost write is the database's own error, for the caller to run again.
  const raced = fakeWorld();
  raced.hooks.beforeHandleWrite = () => {
    raced.state.agents[1]!.publicHandle = "support-bot";
  };
  await assert.rejects(ensurePublicPage(raced.db, { orgId: ORG, agentId: AGENT }), (err: unknown) => isHandleConflict(err));
});

test("assignPublicHandle outside a transaction moves to the next candidate on a clash, and never changes a handle", async () => {
  const world = fakeWorld();
  world.hooks.beforeHandleWrite = () => {
    world.state.agents[1]!.publicHandle = "support-bot";
  };
  assert.equal(await assignPublicHandle(world.db, { id: AGENT, slug: "support-bot" }), "support-bot-11111111");
  assert.equal(await assignPublicHandle(world.db, { id: AGENT, slug: "renamed" }), "support-bot-11111111");
  assert.equal(world.agent().publicHandle, "support-bot-11111111");
});

test("isHandleConflict: a unique violation on the handle, and nothing else", () => {
  assert.equal(isHandleConflict({ code: "P2002", meta: { target: ["public_handle"] } }), true);
  assert.equal(isHandleConflict({ code: "P2002", meta: { target: "agents_public_handle_key" } }), true);
  assert.equal(isHandleConflict({ code: "P2002" }), true);
  assert.equal(isHandleConflict({ code: "P2002", meta: { target: ["org_id", "slug"] } }), false);
  assert.equal(isHandleConflict({ code: "P2025" }), false);
  assert.equal(isHandleConflict(new Error("boom")), false);
  assert.equal(isHandleConflict(null), false);
});

// ============================================
// The composition root
// ============================================

test("buildAgentPublicLinkDeps: the link is built from PUBLIC_WEB_URL, else CORS_ORIGIN, and calls go to the client's delegates", async () => {
  const calls: string[] = [];
  const delegate = (name: string) =>
    new Proxy({}, { get: (_target, method) => async () => (calls.push(`${name}.${String(method)}`), null) });
  let addresses: { publicWebUrl: string | undefined; corsOrigin: string | undefined } = {
    publicWebUrl: "https://app.example.test/",
    corsOrigin: "http://localhost:3000",
  };
  const deps = buildAgentPublicLinkDeps({
    prisma: {
      agent: delegate("agent"),
      widgetKey: delegate("widgetKey"),
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => (calls.push("$transaction"), fn({ tx: true })),
    } as never,
    limiter: { peek: async () => 7 },
    registry: () => new SkillRegistry([]),
    webAddresses: () => addresses,
    keyDefaultDailyCap: 500,
  });

  assert.equal(deps.pageUrl("support-bot"), "https://app.example.test/a/support-bot");
  addresses = { publicWebUrl: undefined, corsOrigin: "http://localhost:3000" };
  assert.equal(deps.pageUrl("support-bot"), "http://localhost:3000/a/support-bot");
  addresses = { publicWebUrl: undefined, corsOrigin: undefined };
  assert.equal(deps.pageUrl("support-bot"), null);

  assert.equal(deps.keyDefaultDailyCap, 500);
  assert.equal(deps.toolOffForVisitors("anything"), false);
  await deps.db.agent.findFirst({ where: { id: AGENT, orgId: ORG }, select: {} as never });
  await deps.db.widgetKey.updateMany({ where: { pageOfAgentId: AGENT, orgId: ORG }, data: {} });
  assert.deepEqual(await deps.transaction(async (tx) => tx), { tx: true });
  assert.deepEqual(calls, ["agent.findFirst", "widgetKey.updateMany", "$transaction"]);
});

// ============================================
// As HTTP
// ============================================

async function server(options: { role?: string | null; world?: ReturnType<typeof fakeWorld> } = {}) {
  const world = options.world ?? fakeWorld();
  const app = Fastify();
  app.decorateRequest("auth", null);
  // Stands in for the global auth hook: a test names its caller in headers.
  app.addHook("onRequest", async (request) => {
    const org = request.headers["x-test-org"];
    if (typeof org !== "string") return;
    (request as { auth: unknown }).auth =
      request.headers["x-test-api-key"] === "1"
        ? { orgId: org, userId: null, type: "api_key", apiKeyId: "key_1" }
        : { orgId: org, userId: "user-1", type: "jwt" };
  });
  const auth: preHandlerAsyncHookHandler = async (request, reply) => {
    if (!request.auth) return reply.status(401).send({ error: "Unauthorized", message: "Authentication required" });
  };
  // The real role guard, over a membership lookup the test controls.
  const requireRole = createRequireRole({
    getMemberRole: async () => (options.role === undefined ? "owner" : options.role),
  });
  await app.register(
    createAgentPublicLinkRoutes({
      link: world.deps,
      guards: { auth, manage: requireRole("owner", "admin") as preHandlerAsyncHookHandler },
    }),
    { prefix: "/api/agents" },
  );
  await app.ready();
  return { app, world };
}

const owner = { "x-test-org": ORG };
const get = (app: FastifyInstance, headers: Record<string, string> = owner, agentId = AGENT) =>
  app.inject({ method: "GET", url: `/api/agents/${agentId}/public-link`, headers });
const put = (app: FastifyInstance, body: unknown, headers: Record<string, string> = owner, agentId = AGENT) =>
  app.inject({
    method: "PUT",
    url: `/api/agents/${agentId}/public-link`,
    headers: { "content-type": "application/json", ...headers },
    payload: JSON.stringify(body),
  });

test("GET and PUT answer the same shape, and PUT sets what it is sent", async () => {
  const { app, world } = await server();
  assert.deepEqual((await get(app)).json(), {
    state: "off",
    handle: null,
    url: null,
    dailyCap: 100,
    usedToday: 0,
    showResults: false,
    toolsOffForVisitors: false,
  });
  assert.deepEqual(world.writes, [], "a GET changes nothing");

  const on = await put(app, { state: "on", dailyCap: 40, handle: "front-desk", showResults: true });
  assert.equal(on.statusCode, 200);
  assert.deepEqual(on.json(), {
    state: "on",
    handle: "front-desk",
    url: `${WEB}/a/front-desk`,
    dailyCap: 40,
    usedToday: 0,
    showResults: true,
    toolsOffForVisitors: false,
  });
  assert.deepEqual((await get(app)).json(), on.json());
  assert.equal((await put(app, { state: "paused" })).json().state, "paused");
  assert.equal((await put(app, { state: "off" })).json().state, "off");
  await app.close();
});

test("PUT is for an owner or admin: a member reads the link and cannot change it; an API key may", async () => {
  const member = await server({ role: "member" });
  assert.equal((await get(member.app)).statusCode, 200);
  const denied = await put(member.app, { state: "on" });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error, "insufficient_role");
  assert.deepEqual(member.world.writes, []);
  assert.equal(member.world.agent().isPublic, false);
  await member.app.close();

  for (const role of ["owner", "admin"]) {
    const allowed = await server({ role });
    assert.equal((await put(allowed.app, { state: "on" })).statusCode, 200);
    await allowed.app.close();
  }

  const key = await server({ role: null });
  assert.equal((await put(key.app, { state: "on" }, { ...owner, "x-test-api-key": "1" })).statusCode, 200);
  await key.app.close();

  const nobody = await server();
  assert.equal((await get(nobody.app, {})).statusCode, 401);
  assert.equal((await put(nobody.app, { state: "on" }, {})).statusCode, 401);
  await nobody.app.close();
});

test("another organization's agent is 404, never 403, on both routes", async () => {
  const { app, world } = await server();
  const theirs = { "x-test-org": OTHER_ORG };
  const read = await get(app, theirs);
  assert.equal(read.statusCode, 404);
  assert.deepEqual(read.json(), { error: "agent_not_found", message: "Agent not found" });
  const write = await put(app, { state: "on" }, theirs);
  assert.equal(write.statusCode, 404);
  assert.deepEqual(write.json(), { error: "agent_not_found", message: "Agent not found" });
  assert.equal(world.agent().isPublic, false);
  assert.equal((await get(app, owner, "33333333-3333-4333-8333-333333333333")).statusCode, 404);
  await app.close();
});

test("PUT refusals: handle rules and bounds are 400 validation_failed by field; a clash is 409 handle_taken", async () => {
  const { app, world } = await server();
  world.state.agents[1]!.publicHandle = "helpdesk";

  const reserved = await put(app, { state: "on", handle: "dashboard" });
  assert.equal(reserved.statusCode, 400);
  assert.deepEqual(reserved.json(), {
    error: "validation_failed",
    message: HANDLE_MESSAGES.reserved,
    fields: { handle: HANDLE_MESSAGES.reserved },
    details: { formErrors: [], fieldErrors: { handle: [HANDLE_MESSAGES.reserved] } },
  });
  const malformed = await put(app, { state: "on", handle: "No" });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().fields.handle, HANDLE_MESSAGES.invalid_format);

  const taken = await put(app, { state: "on", handle: "helpdesk" });
  assert.equal(taken.statusCode, 409);
  assert.deepEqual(taken.json(), { error: "handle_taken", message: HANDLE_MESSAGES.taken });

  const cap = "Choose a daily limit from 1 to 100,000 uses.";
  for (const dailyCap of [0, -1, 100_001, 1.5, "20", null]) {
    const res = await put(app, { state: "on", dailyCap });
    assert.equal(res.statusCode, 400, `dailyCap ${String(dailyCap)}`);
    assert.equal(res.json().error, "validation_failed");
    assert.equal(res.json().fields.dailyCap, cap);
    assert.equal(res.json().message, cap);
  }
  for (const dailyCap of [1, 100_000]) {
    assert.equal((await put(app, { state: "off", dailyCap })).statusCode, 200);
  }

  for (const body of [{}, { state: "view_only" }, { state: "paid" }, { state: "on", extra: true }, { state: "on", showResults: "yes" }]) {
    const res = await put(app, body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.json().error, "validation_failed");
    assert.equal(typeof res.json().message, "string");
  }
  assert.equal((await get(app, owner, "not-an-id")).statusCode, 400);
  assert.equal(world.agent().isPublic, false, "no refused request published the page");
  assert.equal(world.state.keys.length, 0);
  await app.close();
});
