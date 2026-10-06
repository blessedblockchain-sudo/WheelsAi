import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";
process.env.PUBLIC_API_URL = "https://api.example.com";

// Telegram channels on OpenClaw deployments, against an in-memory database
// and a fake Telegram. What these pin: a bot keeps its webhook exactly as
// long as a saved channel uses it. A losing duplicate add does not delete
// the winner's webhook, and removing the channel, the deployment or the
// agent releases it.

type Row = Record<string, any>;

const BOT_A = "111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BOT_B = "222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const DEP = "dep_1";
const ORG = "org_1";
const URL_FOR = (deploymentId: string) => `https://api.example.com/api/channels/webhooks/${deploymentId}/telegram`;

function makeWorld() {
  const state = {
    channels: [] as Row[],
    deployments: [{ id: DEP, agentId: "agent_1", agent: { id: "agent_1", orgId: ORG } }] as Row[],
    webhooks: new Map<string, string>(), // bot token -> webhook url
    telegramCalls: [] as string[],
    telegramDown: false,
  };
  let seq = 0;

  const models: Row = {
    openClawDeployment: {
      findFirst: async ({ where }: Row) => {
        const d = state.deployments.find((x) => x.id === where.id && x.agent.orgId === where.agent.orgId);
        return d ? { ...d, channels: state.channels.filter((c) => c.deploymentId === d.id) } : null;
      },
      delete: async ({ where }: Row) => {
        state.deployments = state.deployments.filter((d) => d.id !== where.id);
        // onDelete: Cascade
        state.channels = state.channels.filter((c) => c.deploymentId !== where.id);
        return {};
      },
    },
    openClawChannel: {
      findUnique: async ({ where }: Row) => {
        const key = where.deploymentId_platform;
        const row = key
          ? state.channels.find((c) => c.deploymentId === key.deploymentId && c.platform === key.platform)
          : state.channels.find((c) => c.id === where.id);
        if (!row) return null;
        return { ...row, deployment: state.deployments.find((d) => d.id === row.deploymentId) };
      },
      findMany: async ({ where }: Row) =>
        state.channels.filter(
          (c) =>
            c.platform === where.platform &&
            state.deployments.find((d) => d.id === c.deploymentId)?.agentId === where.deployment.agentId,
        ),
      create: async ({ data }: Row) => {
        // The unique (deploymentId, platform).
        if (state.channels.some((c) => c.deploymentId === data.deploymentId && c.platform === data.platform)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row = { id: `ch_${++seq}`, ...data };
        state.channels.push(row);
        return row;
      },
      delete: async ({ where }: Row) => {
        state.channels = state.channels.filter((c) => c.id !== where.id);
        return {};
      },
    },
  };

  const fakeFetch = async (url: string, init: { body: string }) => {
    const [, token, method] = /\/bot([^/]+)\/(\w+)$/.exec(url)!;
    state.telegramCalls.push(`${method}:${token!.slice(0, 6)}`);
    if (state.telegramDown) throw new Error("telegram unreachable");
    let result: unknown = true;
    if (method === "setWebhook") state.webhooks.set(token!, JSON.parse(init.body).url);
    if (method === "getWebhookInfo") result = { url: state.webhooks.get(token!) ?? "" };
    if (method === "deleteWebhook") state.webhooks.delete(token!);
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  };
  return { state, models, fakeFetch };
}

async function withWorld<T>(
  world: ReturnType<typeof makeWorld>,
  body: (svc: typeof import("../services/openclaw.js")) => Promise<T>,
): Promise<T> {
  const { prisma } = (await import("../lib/prisma.js")) as unknown as { prisma: Row };
  const svc = await import("../services/openclaw.js");
  const originals: Row = {};
  for (const [name, fake] of Object.entries(world.models)) {
    originals[name] = prisma[name];
    prisma[name] = fake;
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = world.fakeFetch as unknown as typeof fetch;
  try {
    return await body(svc);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, original] of Object.entries(originals)) prisma[name] = original;
  }
}

const telegram = (botToken: string) => ({ platform: "telegram", config: { botToken } });

// ============================================
// Concurrent add
// ============================================

test("a losing concurrent add of the same bot leaves the winner's webhook in place", async () => {
  const world = makeWorld();
  await withWorld(world, async ({ addChannel }) => {
    const results = await Promise.allSettled([
      addChannel(DEP, ORG, telegram(BOT_A)),
      addChannel(DEP, ORG, telegram(BOT_A)),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  });
  assert.equal(world.state.channels.length, 1);
  // The saved, enabled channel still receives updates.
  assert.equal(world.state.webhooks.get(BOT_A), URL_FOR(DEP));
  assert.equal(world.state.telegramCalls.some((c) => c.startsWith("deleteWebhook")), false);
});

test("a losing concurrent add of a different bot points that bot away again", async () => {
  const world = makeWorld();
  await withWorld(world, async ({ addChannel }) => {
    const results = await Promise.allSettled([
      addChannel(DEP, ORG, telegram(BOT_A)),
      addChannel(DEP, ORG, telegram(BOT_B)),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  });
  assert.equal(world.state.webhooks.get(BOT_A), URL_FOR(DEP));
  assert.equal(world.state.webhooks.has(BOT_B), false);
});

test("the rollback decision: only a row holding this same bot keeps the registration", async () => {
  const { shouldRollBackTelegramRegistration } = await import("../services/openclaw.js");
  assert.equal(shouldRollBackTelegramRegistration(BOT_A, null), true); // nothing was saved
  assert.equal(shouldRollBackTelegramRegistration(BOT_A, { botToken: BOT_B }), true);
  assert.equal(shouldRollBackTelegramRegistration(BOT_A, {}), true); // the row did not decrypt
  assert.equal(shouldRollBackTelegramRegistration(BOT_A, { botToken: BOT_A }), false);
});

// ============================================
// Remove channel
// ============================================

test("removing a channel releases its webhook", async () => {
  const world = makeWorld();
  await withWorld(world, async ({ addChannel, removeChannel }) => {
    const channel = await addChannel(DEP, ORG, telegram(BOT_A));
    assert.deepEqual(await removeChannel(channel.id, ORG), { success: true });
  });
  assert.equal(world.state.channels.length, 0);
  assert.equal(world.state.webhooks.has(BOT_A), false);
});

test("removing a channel whose config no longer decrypts still reports success: the row is gone", async () => {
  const world = makeWorld();
  world.state.channels.push({
    id: "ch_old",
    deploymentId: DEP,
    platform: "telegram",
    configEncrypted: "sealed-under-a-key-that-was-rotated",
    enabled: true,
  });
  await withWorld(world, async ({ removeChannel }) => {
    assert.deepEqual(await removeChannel("ch_old", ORG), { success: true });
  });
  assert.equal(world.state.channels.length, 0);
});

test("removing a channel while Telegram is unreachable still reports success", async () => {
  const world = makeWorld();
  await withWorld(world, async ({ addChannel, removeChannel }) => {
    const channel = await addChannel(DEP, ORG, telegram(BOT_A));
    world.state.telegramDown = true;
    assert.deepEqual(await removeChannel(channel.id, ORG), { success: true });
  });
  assert.equal(world.state.channels.length, 0);
});

// ============================================
// Delete deployment / agent
// ============================================

test("deleting a deployment releases its Telegram webhook, after the delete", async () => {
  const world = makeWorld();
  await withWorld(world, async ({ addChannel, deleteDeployment }) => {
    await addChannel(DEP, ORG, telegram(BOT_A));
    world.state.telegramCalls.length = 0;
    await deleteDeployment(DEP, ORG);
  });
  assert.equal(world.state.deployments.length, 0);
  assert.equal(world.state.webhooks.has(BOT_A), false);
  assert.deepEqual(world.state.telegramCalls, ["getWebhookInfo:111111", "deleteWebhook:111111"]);
});

test("a bot its owner has pointed somewhere else is left alone", async () => {
  const world = makeWorld();
  await withWorld(world, async ({ addChannel, deleteDeployment }) => {
    await addChannel(DEP, ORG, telegram(BOT_A));
    world.state.webhooks.set(BOT_A, "https://elsewhere.example.com/hook");
    await deleteDeployment(DEP, ORG);
  });
  assert.equal(world.state.webhooks.get(BOT_A), "https://elsewhere.example.com/hook");
});

test("an agent's Telegram bots are collected before its delete and released after", async () => {
  const world = makeWorld();
  await withWorld(world, async ({ addChannel, collectAgentTelegramWebhooks, releaseTelegramWebhooks }) => {
    await addChannel(DEP, ORG, telegram(BOT_A));
    const targets = await collectAgentTelegramWebhooks("agent_1");
    assert.deepEqual(targets, [{ deploymentId: DEP, botToken: BOT_A }]);
    assert.deepEqual(await collectAgentTelegramWebhooks("agent_other"), []);

    // The agent delete cascades through the deployment to the channel.
    world.state.deployments.length = 0;
    world.state.channels.length = 0;
    await releaseTelegramWebhooks(targets);
  });
  assert.equal(world.state.webhooks.has(BOT_A), false);
});

test("releasing never throws, whatever the unregister call does", async () => {
  const { releaseTelegramWebhooks } = await import("../services/openclaw.js");
  await releaseTelegramWebhooks([{ deploymentId: DEP, botToken: BOT_A }], {
    publicApiUrl: "https://api.example.com",
    unregister: async () => {
      throw new Error("boom");
    },
  });
});

test("the agent delete route reads the agent's Telegram bots before the cascade and releases them after", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const route = readFileSync(path.join(here, "..", "routes", "agents.ts"), "utf8");
  const collect = route.indexOf("await collectAgentTelegramWebhooks(agentId)");
  const remove = route.indexOf("await prisma.agent.delete(");
  const release = route.indexOf("await releaseTelegramWebhooks(telegram)");
  assert.ok(collect > 0, "the route collects the Telegram bots");
  assert.ok(remove > collect, "before it deletes the agent (afterwards the tokens are gone)");
  assert.ok(release > remove, "and releases the webhooks once the rows are deleted");
});
