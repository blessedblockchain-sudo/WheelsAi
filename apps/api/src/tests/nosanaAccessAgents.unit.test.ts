import assert from "node:assert/strict";
import { after, test } from "node:test";
import { startFakeNosanaApi, startRequestCounter, FAKE_MARKETS } from "./fakeNosanaApi.js";

// The agent routes and OpenClaw with API-key access, through the process-wide
// NosanaClient (built by initialize() from the environment below) and the REAL
// @nosana/sdk against the fake Nosana REST API on loopback. The routes use the
// global prisma, so its delegates are patched per test and restored.

const fake = await startFakeNosanaApi();
const rpc = await startRequestCounter();
after(async () => {
  await fake.close();
  await rpc.close();
});

// Before any app module loads: config/env.ts and config/nosanaAccess.ts read these.
process.env.NODE_ENV = "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";
process.env.SOLANA_RPC_URL = rpc.url;
process.env.SOLANA_NETWORK = "devnet";
process.env.NOSANA_API_KEY = fake.apiKey;
process.env.NOSANA_API_URL = fake.url;
process.env.NOSANA_CREDITS_CACHE_MS = "0";
process.env.NOSANA_COST_CACHE_MS = "0";
for (const name of [
  "NOSANA_WALLET_PRIVATE_KEY",
  "NOSANA_ACCESS_MODE",
  "NOSANA_NETWORK",
  "NOSANA_TIMEOUT_UNIT",
  "NOSANA_MIN_CREDITS_USD",
  "NOSANA_MARKETS_JSON",
  "NOSANA_JOB_TIMEOUT_SECONDS",
  "ALLOW_NOSANA_MOCK",
  "SOLANA_WALLET",
  "ANCHOR_PROVIDER_URL",
]) {
  delete process.env[name];
}

const { prisma } = await import("@wheelsai/db");
const { getNosanaClient, NosanaOneShotUnavailableError, wheelsaiDeploymentName } = await import(
  "../services/nosana.js"
);

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const RICH = { assignedCredits: 100, reservedCredits: 0, settledCredits: 0 };

function resetFake() {
  fake.rotateApiKey(fake.apiKey);
  fake.setBalance(RICH);
  fake.setMarkets(FAKE_MARKETS);
  fake.setOwner("11111111111111111111111111111111");
  fake.setInsufficientFunds(false);
  fake.requests.length = 0;
}

function sent(method: string, path: RegExp) {
  return fake.requests.filter((r) => r.method === method && path.test(r.path));
}

/** Replaces delegates of the global prisma for one test. */
function patchPrisma(patch: Record<string, unknown>) {
  const saved: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    saved[key] = (prisma as any)[key];
    (prisma as any)[key] = patch[key];
  }
  return () => Object.assign(prisma as any, saved);
}

async function agentsApp(deployment: Record<string, unknown> | null = null) {
  const state = {
    created: 0,
    reserved: 0,
    writes: [] as Array<{ op: string; where: any; data: any }>,
    orphans: [] as any[],
  };
  const restorePrisma = patchPrisma({
    agent: {
      findFirst: async () => ({
        id: AGENT_ID,
        orgId: "org-1",
        slug: "my-agent",
        name: "My Agent",
        version: "1.0.0",
        framework: "mastra",
        systemPrompt: "",
        tools: [],
        env: {},
        modelConfig: { externalModel: "openai/gpt-4", temperature: 0.7, maxTokens: 1024 },
      }),
    },
    agentDeployment: {
      count: async () => 0,
      create: async () => {
        state.created += 1;
        return { id: DEPLOYMENT_ID, status: "pending", gpuTier: "3060", replicas: 1 };
      },
      findFirst: async () => deployment,
      findUnique: async () => null,
      update: async ({ where, data }: any) => (state.writes.push({ op: "update", where, data }), {}),
      updateMany: async ({ where, data }: any) => (state.writes.push({ op: "updateMany", where, data }), { count: 1 }),
    },
    creditBalance: {
      updateMany: async () => ((state.reserved += 1), { count: 1 }),
      findUnique: async () => ({ balanceCents: 10_000n }),
    },
    creditTransaction: { create: async () => ({}) },
    nosanaOrphanDeployment: {
      createMany: async ({ data }: any) => (state.orphans.push(...data), { count: data.length }),
    },
    orgSubscription: { findUnique: async () => ({ plan: "enterprise", status: "active" }) },
    $transaction: async (fn: any) => fn(prisma),
  });

  const Fastify = (await import("fastify")).default;
  const sensible = await import("@fastify/sensible");
  const { agentRoutes } = await import("../routes/agents.js");
  const { globalErrorHandler } = await import("../lib/errorHandler.js");
  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  await app.register(sensible.default);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as any).auth = { userId: "u", orgId: "org-1", type: "jwt", role: "owner" };
  });
  await app.register(agentRoutes);
  return {
    app,
    state,
    restore: async () => {
      await app.close();
      restorePrisma();
    },
  };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

// ============================================
// Agent deploy
// ============================================

test("agent deploy refused by the platform's credits: 503 with the reason, no row, no reservation", async () => {
  resetFake();
  fake.setBalance({ assignedCredits: 1, reservedCredits: 0, settledCredits: 0 });
  const { app, state, restore } = await agentsApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: `/${AGENT_ID}/deploy`,
      payload: { gpuTier: "3060", replicas: 1 },
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, "compute_capacity_unavailable");
    assert.equal(res.json().reason, "nosana_credits_low");
    assert.match(res.json().message, /Nothing was reserved/);
    assert.doesNotMatch(res.json().message, /\$|\d/);
    assert.equal(state.created, 0);
    assert.equal(state.reserved, 0);
    assert.equal(sent("POST", /\/api\/deployments\/create$/).length, 0);
  } finally {
    await restore();
  }
});

test("agent deploy with API-key access stores api_key beside the Nosana id, under a name derived from the row", async () => {
  resetFake();
  const { app, state, restore } = await agentsApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: `/${AGENT_ID}/deploy`,
      payload: { gpuTier: "3060", replicas: 1 },
    });
    assert.equal(res.statusCode, 201, res.body);
    // The submit runs in the background; its id-storing write is the signal.
    await until(() => state.writes.some((w) => w.data.nosanaJobIds), "the submit to store its id");

    const storing = state.writes.filter((w) => w.data.nosanaJobIds);
    assert.equal(storing.length, 1);
    assert.equal(storing[0]!.op, "updateMany", "a compare-and-set on the submit statuses");
    assert.equal(storing[0]!.data.nosanaAccessMode, "api_key", "same statement as the id");
    assert.equal(storing[0]!.data.nosanaJobIds.length, 1);
    const createCall = sent("POST", /\/api\/deployments\/create$/)[0]!;
    assert.equal((createCall.body as any).name, wheelsaiDeploymentName("agent", DEPLOYMENT_ID));
    assert.equal(fake.vaultCalls(), 0);
  } finally {
    await restore();
  }
});

// ============================================
// Agent stop
// ============================================

test("agent stop goes through the row's access mode, and a release still pending is handed to the sweep with that mode", async () => {
  resetFake();
  const client = await getNosanaClient();
  const created = await client.createDeployment(
    { version: "0.1", type: "container", meta: { trigger: "wheelsai" }, ops: [] } as never,
    "3060",
    1,
    { name: "wheelsai-agent-stop" },
  );
  fake.settle(created.id);
  const { app, state, restore } = await agentsApp({
    id: DEPLOYMENT_ID,
    agentId: AGENT_ID,
    status: "running",
    nosanaJobIds: [created.id],
    nosanaAccessMode: "api_key",
  });
  try {
    fake.requests.length = 0;
    const res = await app.inject({
      method: "POST",
      url: `/${AGENT_ID}/deployments/${DEPLOYMENT_ID}/stop`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(sent("POST", new RegExp(`/${created.id}/stop$`)).length, 1);
    assert.equal(state.writes.at(-1)!.data.status, "stopped");
    // The fake answers STOPPING: the sweep confirms the release later.
    assert.equal(state.orphans.length, 1);
    assert.equal(state.orphans[0].nosanaDeploymentId, created.id);
    assert.equal(state.orphans[0].accessMode, "api_key");
  } finally {
    await restore();
  }
});

test("agent stop of a row the wallet created, with only the API key here: the owner's stop lands and the id goes to the sweep with its account", async () => {
  resetFake();
  const { app, state, restore } = await agentsApp({
    id: DEPLOYMENT_ID,
    agentId: AGENT_ID,
    status: "running",
    nosanaJobIds: ["dm_wallet_run"],
    // No stamp: created before API-key access, so by the wallet.
  });
  try {
    const res = await app.inject({
      method: "POST",
      url: `/${AGENT_ID}/deployments/${DEPLOYMENT_ID}/stop`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(state.writes.length, 1);
    assert.equal(state.writes[0]!.data.status, "stopped");
    // A stopped agent row is never polled again: the record is what stops it
    // on Nosana once the wallet is back, and what the operator view lists.
    assert.equal(state.orphans.length, 1);
    assert.equal(state.orphans[0].nosanaDeploymentId, "dm_wallet_run");
    assert.equal(state.orphans[0].sourceKind, "agent");
    assert.equal(state.orphans[0].sourceId, DEPLOYMENT_ID);
    assert.equal(state.orphans[0].reason, "agent_stop_account_unavailable");
    assert.equal(state.orphans[0].accessMode, "wallet");
    assert.equal(fake.requests.length, 0, "the API-key account was never asked about it");
  } finally {
    await restore();
  }
});

test("agent stop of an unreachable row is still refused when even the sweep record cannot be written", async () => {
  resetFake();
  const { app, state, restore } = await agentsApp({
    id: DEPLOYMENT_ID,
    agentId: AGENT_ID,
    status: "running",
    nosanaJobIds: ["dm_wallet_run"],
  });
  const undo = patchPrisma({
    nosanaOrphanDeployment: {
      createMany: async () => {
        throw new Error("database is down");
      },
    },
  });
  try {
    const res = await app.inject({
      method: "POST",
      url: `/${AGENT_ID}/deployments/${DEPLOYMENT_ID}/stop`,
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, "nosana_access_mode_unavailable");
    assert.deepEqual(state.writes, [], "left as it was: nothing would ever stop it");
  } finally {
    undo();
    await restore();
  }
});

// ============================================
// OpenClaw: one-shot jobs have no private equivalent with an API key
// ============================================

test("OpenClaw start and restart with API-key access are refused by name before any row moves or any job is stopped", async () => {
  resetFake();
  const writes: unknown[] = [];
  const restore = patchPrisma({
    openClawDeployment: {
      findFirst: async () => ({
        id: "oc_1",
        agentId: AGENT_ID,
        status: "RUNNING",
        nosanaJobId: null,
        nosanaAccessMode: null,
        channels: [],
        agent: { id: AGENT_ID, orgId: "org-1", name: "Claw", slug: "claw", modelConfig: {} },
      }),
      update: async (args: unknown) => (writes.push(args), {}),
    },
  });
  try {
    const { startDeployment, restartDeployment } = await import("../services/openclaw.js");
    const refused = (err: unknown) =>
      err instanceof NosanaOneShotUnavailableError && err.code === "nosana_one_shot_unavailable";
    await assert.rejects(startDeployment("oc_1", "org-1"), refused);
    await assert.rejects(restartDeployment("oc_1", "org-1"), refused);
    assert.deepEqual(writes, [], "no status was written");
    assert.equal(fake.requests.length, 0, "nothing was asked of Nosana");
  } finally {
    restore();
  }
});

test("the OpenClaw routes answer that refusal with 501 and the reason, and leave other errors alone", async () => {
  const { replyOneShotUnavailable } = await import("../routes/openclaw.js");
  const sentReplies: Array<{ status: number; body: any }> = [];
  const reply = {
    status(code: number) {
      return { send: (body: unknown) => void sentReplies.push({ status: code, body }) };
    },
  };
  assert.equal(replyOneShotUnavailable(reply as never, new NosanaOneShotUnavailableError()), true);
  assert.equal(replyOneShotUnavailable(reply as never, new Error("Deployment not found or access denied")), false);
  assert.equal(sentReplies.length, 1);
  assert.equal(sentReplies[0]!.status, 501);
  assert.equal(sentReplies[0]!.body.reason, "nosana_one_shot_unavailable");
  assert.match(sentReplies[0]!.body.message, /Nothing was changed/);
});
