import assert from "node:assert/strict";
import { after, test } from "node:test";
import { startFakeNosanaApi, startRequestCounter, FAKE_MARKETS } from "./fakeNosanaApi.js";

// The two workers that act on stored Nosana ids - the deployment-status tick
// (observe, reclaim sweep) and the GPU billing tick (stop, runway) - with rows
// created by BOTH access modes.
//
// Three layers, each with its own test: the pure ticks (hand-written deps),
// the composition roots (a stub database), and the whole chain wired as the
// queues wire it, through the REAL NosanaClient and @nosana/sdk against the
// fake Nosana REST API on loopback.

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

const { NosanaClient, NosanaAccessModeUnavailableError } = await import("../services/nosana.js");
const { resetNosanaAccessConfigForTests } = await import("../config/nosanaAccess.js");
const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
const { buildDeploymentStatusTickDeps } = await import("../services/buildDeploymentStatusTickDeps.js");
const { runGpuBillingTick } = await import("../services/runGpuBillingTick.js");
const { buildGpuBillingTickDeps, resetRunwayThrottleForTests } = await import(
  "../services/buildGpuBillingTickDeps.js"
);
const { recordNosanaOrphan } = await import("../services/nosanaOrphans.js");
const { DRAFT_START_HOLD_MS, NosanaLifecycleError } = await import("../services/nosanaDeploymentLifecycle.js");

import type {
  DeploymentStatusRow,
  DeploymentStatusTickDeps,
  UnreachableNosanaDeployment,
  VaultReclaimCandidate,
} from "../services/runDeploymentStatusTick.js";
import type { GpuBillingRow, GpuBillingTickDeps } from "../services/runGpuBillingTick.js";

type Client = InstanceType<typeof NosanaClient>;

const NOW = new Date("2026-10-07T12:00:00.000Z");
const EP = { url: "https://abc.node.k8s.prd.nos.ci", port: 8000, opId: "ollama", online: true };
const RICH = { assignedCredits: 100, reservedCredits: 0, settledCredits: 0 };

function resetFake() {
  fake.rotateApiKey(fake.apiKey);
  fake.setBalance(RICH);
  fake.setMarkets(FAKE_MARKETS);
  fake.setOwner("11111111111111111111111111111111");
  fake.setInsufficientFunds(false);
  // Every create carries its name as the idempotency key, and Nosana keeps
  // keys unique: a name reused by an earlier test would answer 409.
  fake.deployments.clear();
  fake.requests.length = 0;
}

function sent(method: string, path: RegExp) {
  return fake.requests.filter((r) => r.method === method && path.test(r.path));
}

/** An API-key-only client: rows the wallet created have no credential here. */
async function apiClient(): Promise<Client> {
  resetNosanaAccessConfigForTests();
  const client = new NosanaClient();
  await client.initialize();
  return client;
}

async function nosanaDeployment(client: Client, name: string): Promise<string> {
  const created = await client.createDeployment(
    { version: "0.1", type: "container", meta: { trigger: "wheelsai" }, ops: [] } as never,
    "3060",
    1,
    { name },
  );
  return created.id;
}

const unavailable = () => new NosanaAccessModeUnavailableError("wallet");

// ============================================
// The pure status tick
// ============================================

function statusDeps(over: Partial<DeploymentStatusTickDeps> & { rows: DeploymentStatusRow[] }) {
  const { rows, ...rest } = over;
  const deps: DeploymentStatusTickDeps = {
    loadDeployments: async () => rows,
    observeDeployment: async () => ({ state: "starting", endpoints: [] }),
    persistTransition: async () => ({ count: 1 }),
    checkNodeHealth: async () => ({ healthy: true, latencyMs: 1 }),
    persistNodeHealth: async () => undefined,
    emitTransition: async () => undefined,
    ...rest,
  };
  return deps;
}

test("the status tick observes each row with ITS access mode, and skips - not fails - a row it has no credential for", async () => {
  const observed: Array<[string, string | undefined]> = [];
  const transitions: Array<{ id: string; toStatus: string; mode?: string }> = [];
  const reports: UnreachableNosanaDeployment[][] = [];
  const deps = statusDeps({
    rows: [
      { kind: "model", id: "by_key", orgId: "o", status: "provisioning", nosanaJobIds: ["dm_key"], nosanaAccessMode: "api_key" },
      { kind: "model", id: "by_wallet", orgId: "o", status: "running", nosanaJobIds: ["dm_wallet"], nosanaAccessMode: "wallet" },
      { kind: "agent", id: "agent_key", orgId: "o", status: "deploying", nosanaJobIds: ["dm_agent"], nosanaAccessMode: "api_key" },
      { kind: "model", id: "outage", orgId: "o", status: "running", nosanaJobIds: ["dm_down"], nosanaAccessMode: "api_key" },
    ],
    observeDeployment: async (id, mode) => {
      observed.push([id, mode]);
      if (mode === "wallet") throw unavailable();
      if (id === "dm_down") throw new Error("Nosana API timeout");
      return { state: "running", endpoints: [EP] };
    },
    persistTransition: async (t) => {
      transitions.push({ id: t.id, toStatus: t.toStatus, mode: t.nosanaAccessMode });
      return { count: 1 };
    },
    reportAccessModeUnavailable: (skipped) => void reports.push(skipped),
  });

  const result = await runDeploymentStatusTick({ now: NOW }, deps);

  assert.deepEqual(observed, [
    ["dm_key", "api_key"],
    ["dm_wallet", "wallet"],
    ["dm_agent", "api_key"],
    ["dm_down", "api_key"],
  ]);
  assert.deepEqual(transitions, [
    { id: "by_key", toStatus: "running", mode: "api_key" },
    { id: "agent_key", toStatus: "running", mode: "api_key" },
  ]);
  assert.equal(result.transitioned, 2);
  assert.equal(result.failed, 1, "only the outage is a failure to retry");
  assert.equal(result.accessModeUnavailable, 1);
  assert.equal(reports.length, 1, "reported once per tick");
  assert.deepEqual(reports[0], [
    { source: "row", id: "by_wallet", kind: "model", nosanaDeploymentId: "dm_wallet", accessMode: "wallet" },
  ]);
});

test("the reclaim sweep with candidates of both modes: one report per tick, the reachable ones are still reclaimed", async () => {
  const reclaimed: Array<[string, string | undefined]> = [];
  const reports: UnreachableNosanaDeployment[][] = [];
  const candidates: VaultReclaimCandidate[] = [
    { id: "o1", nosanaDeploymentId: "dm_o_wallet", orphan: true, accessMode: "wallet" },
    { id: "o2", nosanaDeploymentId: "dm_o_key", orphan: true, accessMode: "api_key" },
    { id: "row_wallet", nosanaDeploymentId: "dm_r_wallet", accessMode: "wallet" },
    { id: "row_key", nosanaDeploymentId: "dm_r_key", accessMode: "api_key" },
    { id: "row_err", nosanaDeploymentId: "dm_r_err", accessMode: "api_key" },
  ];
  const deps = statusDeps({
    rows: [],
    loadVaultReclaimCandidates: async () => candidates,
    reclaimVault: async (candidate) => {
      reclaimed.push([candidate.nosanaDeploymentId, candidate.accessMode]);
      if (candidate.accessMode === "wallet") throw unavailable();
      if (candidate.id === "row_err") throw new Error("stop refused");
      return { reclaimed: true };
    },
    reportAccessModeUnavailable: (skipped) => void reports.push(skipped),
  });

  const result = await runDeploymentStatusTick({ now: NOW }, deps);

  assert.equal(reclaimed.length, 5, "one unreachable candidate does not stop the sweep");
  assert.equal(result.vaultsReclaimed, 2);
  assert.equal(result.vaultReclaimsFailed, 1);
  assert.equal(result.accessModeUnavailable, 2);
  assert.equal(reports.length, 1);
  assert.deepEqual(
    reports[0]!.map((r) => [r.source, r.id, r.orphan === true, r.accessMode]),
    [
      ["reclaim", "o1", true, "wallet"],
      ["reclaim", "row_wallet", false, "wallet"],
    ],
  );
});

test("a tick with nothing unreachable reports nothing, and a throwing reporter never fails the tick", async () => {
  let reports = 0;
  const quiet = await runDeploymentStatusTick(
    { now: NOW },
    statusDeps({ rows: [], reportAccessModeUnavailable: () => void (reports += 1) }),
  );
  assert.equal(quiet.accessModeUnavailable, 0);
  assert.equal(reports, 0);

  const noisy = await runDeploymentStatusTick(
    { now: NOW },
    statusDeps({
      rows: [{ kind: "model", id: "r", orgId: "o", status: "running", nosanaJobIds: ["dm"], nosanaAccessMode: "wallet" }],
      observeDeployment: async () => {
        throw unavailable();
      },
      reportAccessModeUnavailable: () => {
        throw new Error("logger down");
      },
    }),
  );
  assert.equal(noisy.accessModeUnavailable, 1);
});

// ============================================
// The status composition root: stamps become modes
// ============================================

interface ModelRow {
  id: string;
  orgId: string;
  status: string;
  engine: string;
  nosanaJobIds: string[];
  nosanaAccessMode: string | null;
  runGeneration: number;
  replicas: number;
  reservationCents: bigint | null;
  reservationReleasedAt: Date | null;
  vaultReclaimedAt: Date | null;
  stoppedAt: Date | null;
  billedThroughAt: Date | null;
  statusReason: string | null;
}
interface AgentRow {
  id: string;
  status: string;
  nosanaJobIds: string[];
  nosanaAccessMode: string | null;
  lastError?: string;
}
interface OrphanRow {
  id: string;
  nosanaDeploymentId: string;
  accessMode: string | null;
  sourceKind: string;
  sourceId: string | null;
  reason: string;
  reclaimedAt: Date | null;
  createdAt: Date;
}

function statusDb(seed: {
  models?: Array<Partial<ModelRow> & { id: string }>;
  agents?: Array<Partial<AgentRow> & { id: string }>;
  orphans?: Array<Partial<OrphanRow> & { id: string; nosanaDeploymentId: string }>;
}) {
  const models: ModelRow[] = (seed.models ?? []).map((m) => ({
    orgId: "org_1",
    status: "provisioning",
    engine: "ollama",
    nosanaJobIds: [],
    nosanaAccessMode: null,
    runGeneration: 0,
    replicas: 1,
    reservationCents: null,
    reservationReleasedAt: null,
    vaultReclaimedAt: null,
    stoppedAt: null,
    billedThroughAt: null,
    statusReason: null,
    ...m,
  }));
  const agents: AgentRow[] = (seed.agents ?? []).map((a) => ({
    status: "deploying",
    nosanaJobIds: [],
    nosanaAccessMode: null,
    ...a,
  }));
  const orphans: OrphanRow[] = (seed.orphans ?? []).map((o) => ({
    accessMode: null,
    sourceKind: "model",
    sourceId: null,
    reason: "test",
    reclaimedAt: null,
    createdAt: NOW,
    ...o,
  }));
  const nodes: Array<{ id: string; deploymentId: string; nodeUrl: string; healthStatus: string }> = [];
  const selects: Record<string, any> = {};

  const inStatus = (status: string, want: any) =>
    typeof want === "string" ? status === want : want?.in ? want.in.includes(status) : true;

  const prisma = {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
    agentDeployment: {
      findMany: async ({ where, select }: any) => {
        selects.agent = select;
        return agents
          .filter((a) => inStatus(a.status, where.status) && a.nosanaJobIds.length > 0)
          .map((a) => ({ ...a, reservationCents: null, reservationReleasedAt: null, agent: { orgId: "org_1" } }));
      },
      updateMany: async ({ where, data }: any) => {
        const a = agents.find((x) => x.id === where.id && x.status === where.status);
        if (!a) return { count: 0 };
        Object.assign(a, data);
        return { count: 1 };
      },
    },
    deployment: {
      findMany: async ({ where, select }: any) => {
        // The reclaim sweep's query is the one that asks about the vault stamp.
        const sweep = "vaultReclaimedAt" in where;
        selects[sweep ? "reclaim" : "model"] = select;
        return models
          .filter(
            (m) =>
              inStatus(m.status, where.status) &&
              m.nosanaJobIds.length > 0 &&
              (!sweep || m.vaultReclaimedAt === null),
          )
          .map((m) => ({ ...m, nodes: nodes.filter((n) => n.deploymentId === m.id) }));
      },
      findFirst: async ({ where }: any) =>
        models.find((m) => m.id === where.id && inStatus(m.status, where.status)) ?? null,
      updateMany: async ({ where, data }: any) => {
        const m = models.find(
          (x) =>
            x.id === where.id &&
            inStatus(x.status, where.status) &&
            (where.nosanaJobIds?.has === undefined || x.nosanaJobIds.includes(where.nosanaJobIds.has)) &&
            (!("vaultReclaimedAt" in where) || x.vaultReclaimedAt === where.vaultReclaimedAt),
        );
        if (!m) return { count: 0 };
        Object.assign(m, data);
        return { count: 1 };
      },
    },
    deploymentNode: {
      findMany: async ({ where }: any) => nodes.filter((n) => n.deploymentId === where.deploymentId),
      create: async ({ data }: any) => {
        const node = { id: `n${nodes.length + 1}`, deploymentId: data.deploymentId, nodeUrl: data.nodeUrl, healthStatus: data.healthStatus };
        nodes.push(node);
        return node;
      },
      deleteMany: async () => ({ count: 0 }),
      updateMany: async ({ where, data }: any) => {
        const n = nodes.find((x) => x.id === where.id);
        if (n) n.healthStatus = data.healthStatus;
        return { count: n ? 1 : 0 };
      },
    },
    nosanaOrphanDeployment: {
      findMany: async ({ select }: any) => {
        selects.orphan = select;
        return orphans.filter((o) => o.reclaimedAt === null);
      },
      updateMany: async ({ where, data }: any) => {
        const o = orphans.find((x) => x.id === where.id && x.reclaimedAt === null);
        if (!o) return { count: 0 };
        Object.assign(o, data);
        return { count: 1 };
      },
      createMany: async ({ data }: any) => {
        for (const d of data) {
          orphans.push({ id: `o${orphans.length + 1}`, accessMode: null, reclaimedAt: null, createdAt: NOW, ...d });
        }
        return { count: data.length };
      },
    },
  };
  return { prisma, models, agents, orphans, nodes, selects };
}

function buildStatus(
  db: ReturnType<typeof statusDb>,
  over: Partial<Parameters<typeof buildDeploymentStatusTickDeps>[0]> = {},
) {
  return buildDeploymentStatusTickDeps({
    prisma: db.prisma as never,
    getDeploymentStatus: async (id) => ({
      id,
      status: "starting",
      endpoints: [],
      jobs: [],
      replicas: 1,
      events: [],
      invalidEndpointCount: 0,
    }),
    checkNodeHealth: async () => ({ healthy: true, latencyMs: 1 }),
    allowMock: false,
    emitTransition: async () => undefined,
    now: () => NOW,
    ...over,
  });
}

test("loadDeployments reads the access-mode stamp of both kinds; a row without one is the wallet's", async () => {
  const db = statusDb({
    models: [
      { id: "m_key", nosanaJobIds: ["dm_1"], nosanaAccessMode: "api_key" },
      { id: "m_old", nosanaJobIds: ["dm_2"], nosanaAccessMode: null },
    ],
    agents: [
      { id: "a_key", nosanaJobIds: ["dm_3"], nosanaAccessMode: "api_key" },
      { id: "a_old", nosanaJobIds: ["dm_4"] },
    ],
  });
  const rows = await buildStatus(db).loadDeployments();
  assert.deepEqual(
    Object.fromEntries(rows.map((r) => [r.id, r.nosanaAccessMode])),
    { a_key: "api_key", a_old: "wallet", m_key: "api_key", m_old: "wallet" },
  );
  assert.equal(db.selects.model.nosanaAccessMode, true);
  assert.equal(db.selects.agent.nosanaAccessMode, true);
});

test("observeDeployment and the reclaim pass the mode to the client calls; candidates carry it from rows and orphan records", async () => {
  // Ended longer ago than a start sent for it could still be on its way.
  const LONG_AGO = new Date(NOW.getTime() - DRAFT_START_HOLD_MS);
  const db = statusDb({
    models: [
      { id: "ended_key", status: "stopped", stoppedAt: NOW, nosanaJobIds: ["dm_k"], nosanaAccessMode: "api_key" },
      { id: "ended_old", status: "failed", stoppedAt: LONG_AGO, nosanaJobIds: ["dm_w"] },
    ],
    orphans: [
      { id: "o_key", nosanaDeploymentId: "dm_ok", accessMode: "api_key" },
      { id: "o_old", nosanaDeploymentId: "dm_ow" },
    ],
  });
  const reads: unknown[][] = [];
  const reclaims: unknown[][] = [];
  const deps = buildStatus(db, {
    getDeploymentStatus: async (...args) => {
      reads.push(args);
      return { id: args[0], status: "starting", endpoints: [], jobs: [], replicas: 1, events: [], invalidEndpointCount: 0 };
    },
    reclaimVault: async (...args) => {
      reclaims.push(args);
      return { reclaimed: true };
    },
  });

  await deps.observeDeployment("dm_x", "api_key");
  await deps.observeDeployment("dm_y", "wallet");
  assert.deepEqual(reads, [["dm_x", "api_key"], ["dm_y", "wallet"]]);

  const candidates = await deps.loadVaultReclaimCandidates!();
  assert.deepEqual(candidates, [
    { id: "o_key", nosanaDeploymentId: "dm_ok", orphan: true, accessMode: "api_key", endedAt: NOW },
    { id: "o_old", nosanaDeploymentId: "dm_ow", orphan: true, accessMode: "wallet", endedAt: NOW },
    { id: "ended_key", nosanaDeploymentId: "dm_k", accessMode: "api_key", endedAt: NOW },
    { id: "ended_old", nosanaDeploymentId: "dm_w", accessMode: "wallet", endedAt: LONG_AGO },
  ]);
  assert.equal(db.selects.reclaim.nosanaAccessMode, true);
  assert.equal(db.selects.orphan.accessMode, true);

  for (const candidate of candidates) await deps.reclaimVault!(candidate);
  assert.deepEqual(reclaims, [
    // Just ended: a start sent for it may still land, so a DRAFT is not released yet.
    ["dm_ok", "api_key", { startMayBeInFlight: true }],
    ["dm_ow", "wallet", { startMayBeInFlight: true }],
    ["dm_k", "api_key", { startMayBeInFlight: true }],
    ["dm_w", "wallet", { startMayBeInFlight: false }],
  ]);
});

test("an agent deployment that ends hands its id to the sweep WITH its access mode", async () => {
  const db = statusDb({ agents: [{ id: "a1", status: "running", nosanaJobIds: ["dm_a"], nosanaAccessMode: "api_key" }] });
  const deps = buildStatus(db, { reclaimVault: async () => ({ reclaimed: false }) });
  const result = await runDeploymentStatusTick({ now: NOW }, {
    ...deps,
    observeDeployment: async () => ({ state: "error", endpoints: [], detail: "node lost" }),
  });
  assert.equal(result.transitioned, 1);
  assert.equal(db.orphans.length, 1);
  assert.equal(db.orphans[0]!.nosanaDeploymentId, "dm_a");
  assert.equal(db.orphans[0]!.accessMode, "api_key");
});

test("recordNosanaOrphan writes the mode when it is known and leaves the column null (wallet) when it is not", async () => {
  const written: Array<Record<string, unknown>> = [];
  const db = { nosanaOrphanDeployment: { createMany: async ({ data }: any) => (written.push(...data), { count: 1 }) } };
  await recordNosanaOrphan(db, { nosanaDeploymentId: "dm_1", sourceKind: "agent", reason: "r", accessMode: "api_key" });
  await recordNosanaOrphan(db, { nosanaDeploymentId: "dm_2", sourceKind: "agent", reason: "r" });
  assert.equal(written[0]!.accessMode, "api_key");
  assert.equal("accessMode" in written[1]!, false);
});

// ============================================
// The status worker as the queue wires it, through the real client
// ============================================

test("the real tick with rows of both modes: the API-key row reaches running, its orphan is released once Nosana stops it, the wallet's are named and left alone", async () => {
  resetFake();
  const client = await apiClient();
  const live = await nosanaDeployment(client, "wheelsai-model-live");
  fake.settle(live);
  fake.setEndpoints(live, [{ opId: EP.opId, port: 8000, url: `${EP.url}/` }]);
  const leftover = await nosanaDeployment(client, "wheelsai-agent-leftover");
  fake.settle(leftover); // still RUNNING on Nosana: the sweep stops it

  const db = statusDb({
    models: [
      { id: "m_key", status: "provisioning", nosanaJobIds: [live], nosanaAccessMode: "api_key" },
      { id: "m_wallet", status: "running", nosanaJobIds: ["dm_wallet_run"] },
    ],
    orphans: [
      { id: "o_key", nosanaDeploymentId: leftover, accessMode: "api_key" },
      { id: "o_wallet", nosanaDeploymentId: "dm_wallet_orphan" },
    ],
  });
  const reports: UnreachableNosanaDeployment[][] = [];
  // Exactly the wiring of queues/deployment-status.queue.ts.
  const deps = buildStatus(db, {
    getDeploymentStatus: (id, mode) => client.getDeploymentStatus(id, mode),
    reclaimVault: (id, mode) => client.reclaimDeploymentVault(id, mode),
    reportAccessModeUnavailable: (skipped) => void reports.push(skipped),
  });
  fake.requests.length = 0;

  const first = await runDeploymentStatusTick({ now: NOW }, deps);

  assert.equal(db.models.find((m) => m.id === "m_key")!.status, "running");
  assert.deepEqual(db.models.find((m) => m.id === "m_key")!.billedThroughAt, NOW, "billing starts when it is observed live");
  assert.deepEqual(db.nodes.map((n) => n.nodeUrl), [EP.url]);
  assert.equal(db.models.find((m) => m.id === "m_wallet")!.status, "running", "untouched: neither failed nor stopped");
  assert.equal(first.failed, 0);
  assert.equal(first.accessModeUnavailable, 2);
  assert.equal(reports.length, 1, "one report for the tick");
  assert.deepEqual(
    reports[0]!.map((r) => [r.source, r.id, r.accessMode]),
    [
      ["row", "m_wallet", "wallet"],
      ["reclaim", "o_wallet", "wallet"],
    ],
  );
  // The orphan was running: the sweep asked Nosana to stop it; it is STOPPING.
  assert.equal(sent("POST", new RegExp(`/${leftover}/stop$`)).length, 1);
  assert.equal(first.vaultsPending, 1);
  assert.equal(db.orphans.find((o) => o.id === "o_key")!.reclaimedAt, null);
  assert.equal(fake.vaultCalls(), 0);
  assert.equal(rpc.count(), 0, "no Solana RPC request was made");

  fake.settle(leftover); // STOPPING -> STOPPED
  const second = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(second.vaultsReclaimed, 1);
  assert.deepEqual(db.orphans.find((o) => o.id === "o_key")!.reclaimedAt, NOW);
  assert.equal(db.orphans.find((o) => o.id === "o_wallet")!.reclaimedAt, null);
  assert.equal(reports.length, 2, "and once more on the next tick");
});

test("through the real client: Nosana RUNNING with its endpoint offline never bills; the row goes running - and billing starts - only once the endpoint is online", async () => {
  resetFake();
  const client = await apiClient();
  const created = await client.createDeployment(
    {
      version: "0.1",
      type: "container",
      meta: { trigger: "wheelsai" },
      ops: [{ type: "container/run", id: "ollama", args: { image: "docker.io/ollama/ollama:0.32.6", expose: 11434 } }],
    } as never,
    "3060",
    1,
    { name: "wheelsai-model-online-gate" },
  );
  const fakeRow = fake.deployments.get(created.id)!;
  // As live: RUNNING at once, and the endpoint exists from the create, offline.
  assert.equal(fakeRow.status, "RUNNING");
  assert.equal(fakeRow.endpoints.length, 1);
  assert.equal(fakeRow.endpoints[0]!.online, false);

  const db = statusDb({
    models: [{ id: "m1", status: "provisioning", nosanaJobIds: [created.id], nosanaAccessMode: "api_key" }],
  });
  const deps = buildStatus(db, {
    getDeploymentStatus: (id, mode) => client.getDeploymentStatus(id, mode, { jobs: false, events: "when_halted" }),
  });

  // No node ever takes it (the 3060 market had none idle): tick after tick,
  // nothing moves and nothing is billed.
  for (let i = 0; i < 3; i += 1) {
    const tick = await runDeploymentStatusTick({ now: NOW }, deps);
    assert.equal(tick.transitioned, 0);
  }
  const row = db.models[0]!;
  assert.equal(row.status, "provisioning");
  assert.equal(row.billedThroughAt ?? null, null, "no billing cursor: the GPU billing worker bills nothing");
  assert.equal(db.nodes.length, 0, "no node, so /v1 routes nowhere and nothing is probed");

  // A node takes the job and its tunnel comes up.
  fake.addJob(created.id);
  fake.setEndpointsOnline(created.id, true);
  const live = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(live.transitioned, 1);
  assert.equal(row.status, "running");
  assert.deepEqual(row.billedThroughAt, NOW, "billing starts at the moment it is observed online");
  assert.deepEqual(db.nodes.map((n) => n.nodeUrl), [fakeRow.endpoints[0]!.url], "one node for the one load-balanced URL");
});

test("a credits-mode run that ran out of funds is failed by the tick, stopped in the same pass, and released by the sweep once Nosana reports it stopped", async () => {
  resetFake();
  const client = await apiClient();
  const id = await nosanaDeployment(client, "wheelsai-model-out-of-funds");
  fake.setStatus(id, "INSUFFICIENT_FUNDS");
  fake.addEvent(id, "JOB_LIST_ERROR", "Error Failed to list job: Insufficient credits. Available: $0.091, Required: $0.524");
  const db = statusDb({
    models: [{ id: "m1", status: "provisioning", nosanaJobIds: [id], nosanaAccessMode: "api_key" }],
  });
  const deps = buildStatus(db, {
    getDeploymentStatus: (nosanaId, mode) => client.getDeploymentStatus(nosanaId, mode, { jobs: false, events: "when_halted" }),
    reclaimVault: (nosanaId, mode) => client.reclaimDeploymentVault(nosanaId, mode),
    stopDeployment: (nosanaId, mode) => client.stopDeployment(nosanaId, mode),
  });
  fake.requests.length = 0;

  const result = await runDeploymentStatusTick({ now: NOW }, deps);

  const row = db.models[0]!;
  assert.equal(row.status, "failed");
  assert.equal(row.statusReason, "nosana_insufficient_funds");
  // Stopped in the transition's own pass: Nosana would otherwise revive it
  // after a top-up of the shared balance. The sweep then reads STOPPING and
  // asks nothing more, and does not release it yet.
  assert.equal(result.haltedStops, 1);
  assert.equal(result.haltedStopsFailed, 0);
  assert.equal(sent("POST", new RegExp(`/${id}/stop$`)).length, 1, "one stop, from the transition");
  assert.equal(fake.deployments.get(id)!.status, "STOPPING");
  assert.equal(result.vaultsPending, 1);
  assert.equal(row.vaultReclaimedAt, null);
  fake.settle(id);
  const next = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(next.vaultsReclaimed, 1);
  assert.deepEqual(row.vaultReclaimedAt, NOW);
});

test("a halted run whose events cannot be read is still failed and stopped: the failed read costs only the failure text", async () => {
  resetFake();
  const client = await apiClient();
  const id = await nosanaDeployment(client, "wheelsai-model-halted-no-events");
  fake.setStatus(id, "ERROR");
  fake.addEvent(id, "JOB_LIST_ERROR", "Error Failed to list job: no node");
  // The events route fails for as long as anyone asks (a 5xx, or a key whose
  // scopes do not cover it).
  fake.failNext({ method: "GET", path: new RegExp(`/${id}/events$`) }, { status: 500, body: { error: "manager down" } }, 100);
  const db = statusDb({
    models: [{ id: "m1", status: "provisioning", nosanaJobIds: [id], nosanaAccessMode: "api_key" }],
  });
  // Exactly the read of queues/deployment-status.queue.ts.
  const deps = buildStatus(db, {
    getDeploymentStatus: (nosanaId, mode) => client.getDeploymentStatus(nosanaId, mode, { jobs: false, events: "when_halted" }),
    reclaimVault: (nosanaId, mode) => client.reclaimDeploymentVault(nosanaId, mode),
    stopDeployment: (nosanaId, mode) => client.stopDeployment(nosanaId, mode),
  });
  fake.requests.length = 0;

  const result = await runDeploymentStatusTick({ now: NOW }, deps);

  assert.equal(result.failed, 0, "the row was read");
  assert.equal(sent("GET", new RegExp(`/${id}/events$`)).length, 1, "the events were asked for");
  const row = db.models[0]!;
  assert.equal(row.status, "failed", "the halted state reached the row");
  assert.equal(row.statusReason, "nosana_error", "the code alone: Nosana's text could not be read");
  assert.equal(result.haltedStops, 1);
  assert.equal(sent("POST", new RegExp(`/${id}/stop$`)).length, 1);
  assert.equal(fake.deployments.get(id)!.status, "STOPPING");

  // A read that names the events itself stays strict.
  await assert.rejects(
    client.getDeploymentStatus(id, "api_key", { jobs: false, events: true }),
    (err: unknown) => (err as { code?: string }).code === "nosana_read_failed",
  );
});

test("a halted credits-mode run whose stop Nosana refuses is not released: the sweep asks again every tick until a stop is accepted and it has stopped", async () => {
  resetFake();
  const client = await apiClient();
  const id = await nosanaDeployment(client, "wheelsai-model-halted");
  fake.setStatus(id, "ERROR");
  fake.failNext({ method: "POST", path: new RegExp(`/${id}/stop$`) }, { status: 500, body: { error: "manager down" } }, 2);
  const db = statusDb({
    models: [{ id: "m1", status: "provisioning", nosanaJobIds: [id], nosanaAccessMode: "api_key" }],
  });
  const deps = buildStatus(db, {
    getDeploymentStatus: (nosanaId, mode) => client.getDeploymentStatus(nosanaId, mode, { jobs: false, events: "when_halted" }),
    reclaimVault: (nosanaId, mode) => client.reclaimDeploymentVault(nosanaId, mode),
    stopDeployment: (nosanaId, mode) => client.stopDeployment(nosanaId, mode),
  });

  // Tick 1: failed; the transition's stop and the sweep's are both refused.
  const first = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(db.models[0]!.status, "failed");
  assert.equal(first.haltedStopsFailed, 1);
  assert.equal(first.vaultsPending, 1, "refused: not released");
  assert.equal(db.models[0]!.vaultReclaimedAt, null);
  assert.equal(fake.deployments.get(id)!.status, "ERROR");

  // Tick 2: the sweep's stop is accepted - winding down, still not released.
  const second = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(second.vaultsPending, 1);
  assert.equal(fake.deployments.get(id)!.status, "STOPPING");
  assert.equal(db.models[0]!.vaultReclaimedAt, null);

  // Tick 3: Nosana reports it stopped - released.
  fake.settle(id);
  const third = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(third.vaultsReclaimed, 1);
  assert.deepEqual(db.models[0]!.vaultReclaimedAt, NOW);
  assert.equal(sent("POST", new RegExp(`/${id}/stop$`)).length, 3);
});

test("a start that passed its deadline and lands later: the unstarted DRAFT is not released, and the sweep stops it once it runs", async () => {
  resetFake();
  const client = await apiClient();
  (client as any).sleep = async () => undefined; // the waits between refused stops
  // The start call fails for us (its deadline passed) and has not reached
  // Nosana yet: the deployment still reads DRAFT, and a stop of it is refused.
  fake.failNext({ method: "POST", path: /\/start$/ }, { status: 504, body: { error: "gateway timeout" } });
  let failure: InstanceType<typeof NosanaLifecycleError> | undefined;
  await assert.rejects(
    client.createDeployment(
      { version: "0.1", type: "container", meta: { trigger: "wheelsai" }, ops: [] } as never,
      "3060",
      1,
      { name: "wheelsai-model-late-start" },
    ),
    (err: unknown) => {
      failure = err as InstanceType<typeof NosanaLifecycleError>;
      return err instanceof NosanaLifecycleError;
    },
  );
  const id = failure!.deploymentId!;
  assert.equal(fake.deployments.get(id)!.status, "DRAFT");
  assert.equal(failure!.cleanup?.stopped, false);
  assert.equal(failure!.cleanup?.reclaimed, false, "not released: the start may still land");

  // The row as submitToNosana leaves it: failed, the id kept, no stamp.
  const db = statusDb({
    models: [{ id: "m1", status: "failed", stoppedAt: NOW, nosanaJobIds: [id], nosanaAccessMode: "api_key" }],
  });
  let clock = NOW;
  // Exactly the wiring of queues/deployment-status.queue.ts.
  const deps = buildStatus(db, {
    reclaimVault: (nosanaId, mode, options) => client.reclaimDeploymentVault(nosanaId, mode, options),
    now: () => clock,
  });
  fake.requests.length = 0;

  const first = await runDeploymentStatusTick({ now: clock }, deps);
  assert.equal(first.vaultsPending, 1, "still DRAFT: read, not released");
  assert.equal(db.models[0]!.vaultReclaimedAt, null);
  assert.equal(sent("POST", /\/stop$/).length, 0, "Nosana refuses a stop of a DRAFT");

  // The start lands.
  fake.setStatus(id, "RUNNING");
  clock = new Date(NOW.getTime() + 60_000);
  const second = await runDeploymentStatusTick({ now: clock }, deps);
  assert.equal(sent("POST", new RegExp(`/${id}/stop$`)).length, 1, "running with nobody billed: stopped");
  assert.equal(fake.deployments.get(id)!.status, "STOPPING");
  assert.equal(second.vaultsPending, 1);
  fake.settle(id);
  const third = await runDeploymentStatusTick({ now: clock }, deps);
  assert.equal(third.vaultsReclaimed, 1);
  assert.deepEqual(db.models[0]!.vaultReclaimedAt, clock);

  // One whose start never lands is released once no start can still arrive.
  const idle = fake.seedDeployment({ name: "wheelsai-model-never-started", status: "DRAFT" });
  const db2 = statusDb({
    models: [{ id: "m2", status: "failed", stoppedAt: NOW, nosanaJobIds: [idle.id], nosanaAccessMode: "api_key" }],
  });
  const deps2 = buildStatus(db2, {
    reclaimVault: (nosanaId, mode, options) => client.reclaimDeploymentVault(nosanaId, mode, options),
    now: () => clock,
  });
  clock = new Date(NOW.getTime() + DRAFT_START_HOLD_MS - 1);
  assert.equal((await runDeploymentStatusTick({ now: clock }, deps2)).vaultsPending, 1);
  clock = new Date(NOW.getTime() + DRAFT_START_HOLD_MS);
  assert.equal((await runDeploymentStatusTick({ now: clock }, deps2)).vaultsReclaimed, 1);
  assert.deepEqual(db2.models[0]!.vaultReclaimedAt, clock);
});

// ============================================
// GPU billing
// ============================================

function billingRow(over: Partial<GpuBillingRow> = {}): GpuBillingRow {
  return {
    id: "dep_1",
    orgId: "org_1",
    gpuTier: "3060",
    replicas: 1,
    status: "running",
    billedThroughAt: new Date(NOW.getTime() - 60_000),
    nosanaDeploymentId: "dm_1",
    runGeneration: 0,
    reservationCents: 37n,
    reservationReleasedAt: null,
    ...over,
  };
}

test("the billing tick counts a short credits runway, and names - once - the rows it has no credential to stop", async () => {
  const stops: string[] = [];
  const reports: GpuBillingRow[][] = [];
  const deps: GpuBillingTickDeps = {
    loadRunningDeployments: async () => [
      billingRow({ id: "paid_key", nosanaAccessMode: "api_key" }),
      billingRow({ id: "broke_wallet", nosanaAccessMode: "wallet" }),
      billingRow({ id: "broke_key", nosanaAccessMode: "api_key" }),
      billingRow({ id: "paid_wallet", nosanaAccessMode: "wallet" }),
    ],
    initialiseCursor: async () => ({ count: 1 }),
    chargeWindow: async (row) =>
      row.id.startsWith("broke")
        ? { kind: "insufficient_credits", requiredCents: 1n }
        : { kind: "charged", cents: 1n, coveredSeconds: 60 },
    stopDeployment: async (row) => {
      stops.push(row.id);
      if (row.nosanaAccessMode === "wallet") throw unavailable();
      return { reclaimed: false };
    },
    markStoppedForInsufficientCredits: async () => ({ stopped: true }),
    ensureRunway: async (row) => {
      if (row.nosanaAccessMode === "wallet") throw unavailable();
      return { toppedUp: false, runwayLow: true };
    },
    reportAccessModeUnavailable: (rows) => void reports.push(rows),
  };

  const result = await runGpuBillingTick({ now: NOW }, deps);

  assert.deepEqual(stops, ["broke_wallet", "broke_key"]);
  assert.equal(result.stoppedForCredits, 1, "the API-key row was stopped");
  assert.equal(result.stopFailed, 1, "the wallet row stays running and billed");
  assert.equal(result.runwayLow, 1);
  assert.equal(result.runwayToppedUp, 0);
  assert.equal(result.runwayFailed, 0, "a missing credential is not a failed refill");
  assert.equal(result.accessModeUnavailable, 2);
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0]!.map((r) => r.id), ["broke_wallet", "paid_wallet"]);
});

function billingDb(rows: Array<Record<string, unknown>>) {
  const prisma = {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
    deployment: {
      findMany: async () => rows,
      // The runway claim (CAS on runwayCheckedAt) always wins here.
      updateMany: async () => ({ count: 1 }),
    },
  };
  return prisma;
}

test("billing deps: the row's mode reaches stop and the runway check; a short credits runway is reported and never topped up, once per interval", async () => {
  resetRunwayThrottleForTests();
  const stops: unknown[][] = [];
  const runways: unknown[] = [];
  const low: Array<{ id: string; runwaySeconds: number; minRunwaySeconds: number }> = [];
  let clock = NOW;
  const deps = buildGpuBillingTickDeps({
    prisma: billingDb([
      { id: "by_key", orgId: "o", gpuTier: "3060", replicas: 2, status: "running", billedThroughAt: NOW, nosanaJobIds: ["dm_key"], nosanaAccessMode: "api_key", runGeneration: 0, reservationCents: null, reservationReleasedAt: null },
      { id: "by_wallet", orgId: "o", gpuTier: "3060", replicas: 1, status: "running", billedThroughAt: NOW, nosanaJobIds: ["dm_wallet"], nosanaAccessMode: null, runGeneration: 0, reservationCents: null, reservationReleasedAt: null },
    ]) as never,
    stopDeployment: async (...args) => {
      stops.push(args);
      return { reclaimed: false };
    },
    ensureRunway: async (args) => {
      runways.push(args);
      return args.accessMode === "api_key"
        ? { toppedUp: false, runwaySeconds: 900, reason: "credits" }
        : { toppedUp: true, runwaySeconds: 900 };
    },
    minRunwaySeconds: 1_800,
    onCreditsRunwayLow: ({ row, runwaySeconds, minRunwaySeconds }) =>
      void low.push({ id: row.id, runwaySeconds, minRunwaySeconds }),
    now: () => clock,
  });

  const rows = await deps.loadRunningDeployments();
  assert.deepEqual(rows.map((r) => [r.id, r.nosanaAccessMode]), [["by_key", "api_key"], ["by_wallet", "wallet"]]);
  const [byKey, byWallet] = rows as [GpuBillingRow, GpuBillingRow];

  await deps.stopDeployment(byKey);
  await deps.stopDeployment(byWallet);
  assert.deepEqual(stops, [["dm_key", "api_key"], ["dm_wallet", "wallet"]]);

  assert.deepEqual(await deps.ensureRunway!(byKey), { toppedUp: false, runwayLow: true });
  assert.deepEqual(await deps.ensureRunway!(byWallet), { toppedUp: true }, "a wallet runway below the minimum is a top-up, not a report");
  assert.deepEqual(runways, [
    { nosanaDeploymentId: "dm_key", gpuTier: "3060", replicas: 2, accessMode: "api_key" },
    { nosanaDeploymentId: "dm_wallet", gpuTier: "3060", replicas: 1, accessMode: "wallet" },
  ]);
  assert.deepEqual(low, [{ id: "by_key", runwaySeconds: 900, minRunwaySeconds: 1_800 }]);

  // The next billing tick, a minute later: throttled, so not reported again.
  clock = new Date(NOW.getTime() + 60_000);
  assert.deepEqual(await deps.ensureRunway!(byKey), { toppedUp: false });
  assert.equal(low.length, 1);
  // After the interval it is checked, and reported, again.
  clock = new Date(NOW.getTime() + 601_000);
  assert.deepEqual(await deps.ensureRunway!(byKey), { toppedUp: false, runwayLow: true });
  assert.equal(low.length, 2);
});

test("billing through the real client: the credits runway check tops nothing up and a thin balance is reported", async () => {
  resetFake();
  resetRunwayThrottleForTests();
  const client = await apiClient();
  const id = await nosanaDeployment(client, "wheelsai-model-billing");
  fake.settle(id);
  // About 14 micro-USD per second for a 3060: one cent is roughly 700 seconds.
  fake.setBalance({ assignedCredits: 0.01, reservedCredits: 0, settledCredits: 0 });
  const low: number[] = [];
  // Exactly the wiring of queues/gpu-billing.queue.ts.
  const deps = buildGpuBillingTickDeps({
    prisma: billingDb([]) as never,
    stopDeployment: (nosanaId, mode) => client.stopDeployment(nosanaId, mode),
    ensureRunway: ({ nosanaDeploymentId, gpuTier, replicas, accessMode }) =>
      client.ensureDeploymentRunway(nosanaDeploymentId, gpuTier, replicas, accessMode),
    minRunwaySeconds: 1_800,
    onCreditsRunwayLow: ({ runwaySeconds }) => void low.push(runwaySeconds),
    now: () => NOW,
  });
  fake.requests.length = 0;

  const runway = await deps.ensureRunway!(billingRow({ nosanaDeploymentId: id, nosanaAccessMode: "api_key" }));

  assert.deepEqual(runway, { toppedUp: false, runwayLow: true });
  assert.equal(low.length, 1);
  assert.ok(low[0]! > 0 && low[0]! < 1_800, `runway ${low[0]}s is short`);
  assert.equal(fake.vaultCalls(), 0, "nothing to top up");
  assert.equal(sent("POST", /./).length + sent("PATCH", /./).length, 0, "a read-only check");

  // And the stop of an unpaid deployment goes through the same credential.
  const stop = await deps.stopDeployment(billingRow({ nosanaDeploymentId: id, nosanaAccessMode: "api_key" }));
  assert.equal(stop.alreadyStopped, false);
  assert.equal(sent("POST", new RegExp(`/${id}/stop$`)).length, 1);
});

// ============================================
// A running row whose account has no credential here is not billed
// ============================================

test("the billing tick charges nothing for a row it cannot reach: the cursor moves with no charge, the row is named, the others are billed", async () => {
  const charged: string[] = [];
  const skipped: Array<[string, Date]> = [];
  const stops: string[] = [];
  const cursors: string[] = [];
  const reports: GpuBillingRow[][] = [];
  const deps: GpuBillingTickDeps = {
    loadRunningDeployments: async () => [
      billingRow({ id: "by_key", nosanaAccessMode: "api_key" }),
      billingRow({ id: "by_wallet", nosanaAccessMode: "wallet" }),
      billingRow({ id: "by_wallet_new", nosanaAccessMode: "wallet", billedThroughAt: null }),
    ],
    initialiseCursor: async (row) => (cursors.push(row.id), { count: 1 }),
    chargeWindow: async (row) => {
      charged.push(row.id);
      // Were it asked, the wallet row's org could not pay - and the stop that
      // follows could never succeed without the credential.
      return row.nosanaAccessMode === "wallet"
        ? { kind: "insufficient_credits", requiredCents: 1n }
        : { kind: "charged", cents: 2n, coveredSeconds: 60 };
    },
    stopDeployment: async (row) => (stops.push(row.id), { reclaimed: false }),
    markStoppedForInsufficientCredits: async () => ({ stopped: true }),
    canReach: (row) => row.nosanaAccessMode === "api_key",
    skipUnreachableWindow: async (row, now) => (skipped.push([row.id, now]), { count: 1 }),
    reportAccessModeUnavailable: (rows) => void reports.push(rows),
  };

  const result = await runGpuBillingTick({ now: NOW }, deps);

  assert.deepEqual(charged, ["by_key"], "the unreachable rows were never charged");
  assert.deepEqual(stops, [], "and never sent to a stop that cannot succeed");
  assert.deepEqual(cursors, []);
  assert.deepEqual(skipped, [["by_wallet", NOW], ["by_wallet_new", NOW]]);
  assert.equal(result.charged, 1);
  assert.equal(result.chargedCents, 2n);
  assert.equal(result.unbilledUnreachable, 2);
  assert.equal(result.accessModeUnavailable, 2);
  assert.equal(result.insufficientCredits, 0);
  assert.equal(result.stopFailed, 0);
  assert.equal(result.failed, 0);
  assert.equal(reports.length, 1, "named once per tick");
  assert.deepEqual(reports[0]!.map((r) => r.id), ["by_wallet", "by_wallet_new"]);
});

test("billing deps: hasAccessMode decides by the row's stamp, and the skip is a cursor CAS with no ledger row", async () => {
  const writes: Array<{ where: any; data: any }> = [];
  let transactions = 0;
  const cursor = new Date(NOW.getTime() - 3_600_000);
  const prisma = {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => ((transactions += 1), fn(prisma)),
    deployment: {
      findMany: async () => [
        { id: "by_key", orgId: "o", gpuTier: "3060", replicas: 1, status: "running", billedThroughAt: cursor, nosanaJobIds: ["dm_key"], nosanaAccessMode: "api_key", runGeneration: 3, reservationCents: null, reservationReleasedAt: null },
        { id: "by_wallet", orgId: "o", gpuTier: "3060", replicas: 1, status: "running", billedThroughAt: cursor, nosanaJobIds: ["dm_wallet"], nosanaAccessMode: null, runGeneration: 4, reservationCents: null, reservationReleasedAt: null },
      ],
      updateMany: async (args: any) => (writes.push(args), { count: 1 }),
    },
  };
  const asked: string[] = [];
  const deps = buildGpuBillingTickDeps({
    prisma: prisma as never,
    stopDeployment: async () => ({ reclaimed: false }),
    hasAccessMode: (mode) => (asked.push(mode), mode === "api_key"),
  });
  const rows = await deps.loadRunningDeployments();
  assert.equal(deps.canReach!(rows[0]!), true);
  assert.equal(deps.canReach!(rows[1]!), false, "an unstamped row is the wallet's");
  assert.deepEqual(asked, ["api_key", "wallet"]);

  assert.deepEqual(await deps.skipUnreachableWindow!(rows[1]!, NOW), { count: 1 });
  assert.deepEqual(writes, [
    {
      where: { id: "by_wallet", status: "running", runGeneration: 4, billedThroughAt: cursor },
      data: { billedThroughAt: NOW },
    },
  ]);
  assert.equal(transactions, 0, "no charge transaction, so no debit and no ledger row");

  // Without the dependency every row is reachable, as before.
  const legacy = buildGpuBillingTickDeps({ prisma: prisma as never, stopDeployment: async () => ({ reclaimed: false }) });
  assert.equal(legacy.canReach, undefined);
  assert.equal(legacy.skipUnreachableWindow, undefined);
});

test("billing through the real client: an hour-old cursor of a wallet row is moved without a debit when only the API key is loaded", async () => {
  resetFake();
  const client = await apiClient(); // API key only
  const cursor = new Date(NOW.getTime() - 3_600_000);
  const row = { id: "by_wallet", orgId: "o", gpuTier: "3060", replicas: 1, status: "running", billedThroughAt: cursor as Date, nosanaJobIds: ["dm_wallet_run"], nosanaAccessMode: null, runGeneration: 0, reservationCents: null, reservationReleasedAt: null };
  let debits = 0;
  const prisma = {
    $transaction: async () => {
      debits += 1;
      throw new Error("the charge transaction must not run");
    },
    deployment: {
      findMany: async () => [row],
      updateMany: async ({ where, data }: any) => {
        if (where.billedThroughAt?.getTime() !== row.billedThroughAt.getTime()) return { count: 0 };
        row.billedThroughAt = data.billedThroughAt;
        return { count: 1 };
      },
    },
  };
  const reports: GpuBillingRow[][] = [];
  const deps = buildGpuBillingTickDeps({
    prisma: prisma as never,
    stopDeployment: (id, mode) => client.stopDeployment(id, mode),
    // As queues/gpu-billing.queue.ts wires it.
    hasAccessMode: (mode) => client.getAccessMode() === "none" || client.hasAccessMode(mode),
    reportAccessModeUnavailable: (rows) => void reports.push(rows),
  });

  const result = await runGpuBillingTick({ now: NOW }, deps);
  assert.equal(result.charged, 0);
  assert.equal(result.unbilledUnreachable, 1);
  assert.equal(result.failed, 0);
  assert.equal(debits, 0);
  assert.equal(row.billedThroughAt.getTime(), NOW.getTime(), "the hour is not billed later in one piece either");
  assert.equal(reports.length, 1);
  assert.equal(fake.requests.length, 0);
});
