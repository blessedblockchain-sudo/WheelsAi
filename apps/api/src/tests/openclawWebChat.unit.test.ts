/**
 * "Web Chat" on an OpenClaw deployment creates a web chat key (the thing
 * routes/widget.ts serves), never an OpenClawChannel row that nothing reads.
 *
 * Run with: cd apps/api && npx tsx --test src/tests/openclawWebChat.unit.test.ts
 */
import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

type Row = Record<string, any>;

function makeWorld() {
  const state = {
    agents: [] as Row[],
    deployments: [{ id: "dep_1", agentId: "agent_1", agent: { id: "agent_1", orgId: "org_1" } }] as Row[],
    channels: [] as Row[],
    widgetKeys: [] as Row[],
  };
  let seq = 0;
  const models: Row = {
    agent: {
      create: async ({ data }: Row) => {
        const row = { id: `agent_${++seq + 1}`, ...data };
        state.agents.push(row);
        return row;
      },
    },
    openClawDeployment: {
      create: async ({ data }: Row) => {
        const row = { id: `dep_${++seq + 1}`, ...data };
        state.deployments.push({ ...row, agent: state.agents.find((a) => a.id === data.agentId) });
        return row;
      },
      findFirst: async ({ where }: Row) => {
        const d = state.deployments.find((x) => x.id === where.id && x.agent.orgId === where.agent.orgId);
        return d ? { ...d, channels: state.channels.filter((c) => c.deploymentId === d.id) } : null;
      },
    },
    openClawChannel: {
      findUnique: async () => null,
      create: async ({ data }: Row) => {
        const row = { id: `ch_${++seq}`, ...data };
        state.channels.push(row);
        return row;
      },
    },
    widgetKey: {
      create: async ({ data }: Row) => {
        const row = { id: `wk_${++seq}`, ...data };
        state.widgetKeys.push(row);
        return { id: row.id };
      },
    },
  };
  models.$transaction = async (body: (tx: Row) => Promise<unknown>) => body(models);
  return { state, models };
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
  try {
    return await body(svc);
  } finally {
    for (const [name, original] of Object.entries(originals)) prisma[name] = original;
  }
}

const deployment = {
  orgId: "org_9",
  name: "Helper",
  slug: "helper",
  modelConfig: {},
  gpuTier: "basic",
  envVars: {},
};

test("the look: a title and a #RRGGBB colour pass, anything else is left to the defaults", async () => {
  const { webChatKeyLook } = await import("../services/openclaw.js");
  assert.deepEqual(webChatKeyLook({ widgetTitle: "  Chat with us ", primaryColor: "#0088CC" }), {
    title: "Chat with us",
    primaryColor: "#0088cc",
  });
  assert.deepEqual(webChatKeyLook({ widgetTitle: "", primaryColor: "blue" }), {});
  assert.deepEqual(webChatKeyLook({}), {});
  assert.equal(webChatKeyLook({ widgetTitle: "x".repeat(200) }).title?.length, 60);
});

test("a deployment created with Web Chat gets a web chat key and no channel row for it", async () => {
  const world = makeWorld();
  const result = await withWorld(world, (svc) =>
    svc.createDeployment({
      ...deployment,
      channels: [
        { platform: "web", config: { widgetTitle: "Ask Helper", primaryColor: "#112233" } },
        { platform: "discord", config: { botToken: "t", publicKey: "k" } },
      ],
    }),
  );

  assert.equal(world.state.widgetKeys.length, 1);
  const key = world.state.widgetKeys[0]!;
  assert.equal(key.orgId, "org_9");
  assert.equal(key.agentId, result.agent.id);
  assert.match(key.publicKey, /^wpk_[A-Za-z0-9_-]{32}$/);
  // No site yet: only the dashboard's own preview may use it.
  assert.deepEqual(key.allowedOrigins, []);
  assert.equal(key.title, "Ask Helper");
  assert.equal(key.primaryColor, "#112233");
  assert.deepEqual(result.webChatKey, { id: key.id });

  assert.deepEqual(
    world.state.channels.map((c) => c.platform),
    ["discord"],
  );
});

test("a deployment without Web Chat gets no key", async () => {
  const world = makeWorld();
  const result = await withWorld(world, (svc) =>
    svc.createDeployment({ ...deployment, channels: [{ platform: "slack", config: {} }] }),
  );
  assert.equal(result.webChatKey, null);
  assert.equal(world.state.widgetKeys.length, 0);
});

test("adding Web Chat later: a key for the deployment's agent, in the caller's organization only", async () => {
  const world = makeWorld();
  await withWorld(world, async (svc) => {
    const key = await svc.addWebChatKey("dep_1", "org_1", { widgetTitle: "Hi" });
    assert.equal(world.state.widgetKeys.length, 1);
    assert.equal(world.state.widgetKeys[0]!.id, key.id);
    assert.equal(world.state.widgetKeys[0]!.agentId, "agent_1");
    assert.equal(world.state.widgetKeys[0]!.orgId, "org_1");

    await assert.rejects(svc.addWebChatKey("dep_1", "org_other", {}), /not found or access denied/);
    assert.equal(world.state.widgetKeys.length, 1);
  });
});

test("addChannel refuses the web platform, so a dead channel row cannot be made", async () => {
  const world = makeWorld();
  await withWorld(world, async (svc) => {
    await assert.rejects(svc.addChannel("dep_1", "org_1", { platform: "web", config: {} }), /web chat key/);
  });
  assert.equal(world.state.channels.length, 0);
  assert.equal(world.state.widgetKeys.length, 0);
});
