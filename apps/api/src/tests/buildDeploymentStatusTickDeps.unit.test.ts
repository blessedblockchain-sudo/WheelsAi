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

// Drives apps/api/src/services/buildDeploymentStatusTickDeps.ts — the
// composition root for the deployment-status BullMQ worker (plan D8, reworked
// for the Nosana Deployment Manager).
//
// Covers:
//   - loadDeployments: AgentDeployment + Deployment in non-terminal
//     states with non-empty nosanaJobIds, tagged with their kind
//   - observeDeployment: the strict Deployment-Manager seam + the env-gated
//     mock path (ALLOW_NOSANA_MOCK + mock_deploy_* → labelled mock observation)
//   - persistTransition: CAS updateMany on {id, status:fromStatus};
//     stoppedAt on terminal transitions; statusReason / billedThroughAt on
//     model rows; lastError on agent failures
//   - syncNodes: one DeploymentNode per REAL endpoint; fabricated rows removed
//   - the vault-reclaim sweep
//   - end-to-end through the real tick against an in-memory database

import type { DeploymentSnapshot } from "../services/nosanaDeploymentLifecycle.js";

const NOW = new Date("2026-06-12T12:00:00Z");

function snapshot(
  status: DeploymentSnapshot["status"],
  over: Partial<DeploymentSnapshot> = {},
): DeploymentSnapshot {
  return {
    id: "dm_1",
    status,
    endpoints: [],
    jobs: [],
    replicas: 1,
    events: [],
    invalidEndpointCount: 0,
    ...over,
  };
}

const EP = {
  url: "https://abc.node.k8s.prd.nos.ci",
  port: 8000,
  opId: "vllm-inference",
};

// ---------------------------------------------------------------------------
// A small in-memory database: just enough surface for the builder.
// ---------------------------------------------------------------------------

interface ModelRow {
  id: string;
  orgId: string;
  status: string;
  engine: string;
  gpuTier: string;
  replicas: number;
  nosanaJobIds: string[];
  runGeneration: number;
  reservationCents: bigint | null;
  reservationReleasedAt: Date | null;
  stoppedAt: Date | null;
  statusReason: string | null;
  billedThroughAt: Date | null;
  vaultReclaimedAt: Date | null;
  pendingReplicas: number | null;
  replicaChangeId: string | null;
  replicaChangeAt: Date | null;
  replicaChangeHoldCents: bigint | null;
  gpuStoppedAt: Date | null;
}
interface OrphanRow {
  id: string;
  nosanaDeploymentId: string;
  sourceKind: string;
  sourceId: string | null;
  reason: string;
  createdAt: Date;
  reclaimedAt: Date | null;
}
interface NodeRow {
  id: string;
  deploymentId: string;
  nosanaNodeId: string;
  nodeUrl: string;
  healthStatus: string;
  lastHealthCheck: Date | null;
  latencyMs: number | null;
}
interface AgentRow {
  id: string;
  status: string;
  nosanaJobIds: string[];
  orgId: string;
  reservationCents: bigint | null;
  reservationReleasedAt: Date | null;
  lastError: string | null;
  stoppedAt: Date | null;
}

function makeDb(seed: {
  models?: Array<Partial<ModelRow> & { id: string }>;
  agents?: Array<Partial<AgentRow> & { id: string }>;
  nodes?: Array<Partial<NodeRow> & { id: string; deploymentId: string; nodeUrl: string }>;
  balances?: Record<string, bigint>;
  orphans?: Array<Partial<OrphanRow> & { id: string; nosanaDeploymentId: string }>;
}) {
  const calls: Array<{ op: string; args: any }> = [];
  const models: ModelRow[] = (seed.models ?? []).map((m) => ({
    orgId: "org_1",
    status: "provisioning",
    engine: "vllm",
    gpuTier: "4090",
    replicas: 1,
    nosanaJobIds: ["dm_1"],
    runGeneration: 0,
    reservationCents: null,
    reservationReleasedAt: null,
    stoppedAt: null,
    statusReason: null,
    billedThroughAt: null,
    vaultReclaimedAt: null,
    pendingReplicas: null,
    replicaChangeId: null,
    replicaChangeAt: null,
    replicaChangeHoldCents: null,
    gpuStoppedAt: null,
    ...m,
  }));
  const orphans: OrphanRow[] = (seed.orphans ?? []).map((o) => ({
    sourceKind: "model",
    sourceId: null,
    reason: "test",
    createdAt: NOW,
    reclaimedAt: null,
    ...o,
  }));
  const agents: AgentRow[] = (seed.agents ?? []).map((a) => ({
    status: "deploying",
    nosanaJobIds: ["dm_a"],
    orgId: "org_1",
    reservationCents: null,
    reservationReleasedAt: null,
    lastError: null,
    stoppedAt: null,
    ...a,
  }));
  const nodes: NodeRow[] = (seed.nodes ?? []).map((n) => ({
    nosanaNodeId: "node_0",
    healthStatus: "unknown",
    lastHealthCheck: null,
    latencyMs: null,
    ...n,
  }));
  const balances = new Map(Object.entries(seed.balances ?? {}));
  // Failure injection: the next N credit updates throw (a release that fails).
  const failures = { creditUpdate: 0 };
  const ledger: Array<{ orgId: string; amountCents: bigint; type: string; referenceId: string }> = [];
  let nodeSeq = 100;

  const matchModel = (m: ModelRow, where: any): boolean => {
    if (where.id !== undefined && m.id !== where.id) return false;
    if (typeof where.status === "string" && m.status !== where.status) return false;
    if (where.status?.in && !where.status.in.includes(m.status)) return false;
    if (where.runGeneration !== undefined && m.runGeneration !== where.runGeneration) return false;
    if (where.nosanaJobIds?.isEmpty === false && m.nosanaJobIds.length === 0) return false;
    if (where.nosanaJobIds?.has !== undefined && !m.nosanaJobIds.includes(where.nosanaJobIds.has)) return false;
    if (where.reservationCents?.gt !== undefined && !((m.reservationCents ?? 0n) > where.reservationCents.gt)) return false;
    if ("vaultReclaimedAt" in where && where.vaultReclaimedAt === null && m.vaultReclaimedAt !== null) return false;
    if (where.stoppedAt?.gte && !(m.stoppedAt && m.stoppedAt >= where.stoppedAt.gte)) return false;
    if ("reservationReleasedAt" in where && where.reservationReleasedAt === null && m.reservationReleasedAt !== null) return false;
    if (where.replicas !== undefined && m.replicas !== where.replicas) return false;
    if ("replicaChangeId" in where && m.replicaChangeId !== where.replicaChangeId) return false;
    if ("billedThroughAt" in where && (m.billedThroughAt?.getTime() ?? null) !== (where.billedThroughAt?.getTime() ?? null)) return false;
    if (typeof where.reservationCents === "bigint" && m.reservationCents !== where.reservationCents) return false;
    return true;
  };

  const deployment = {
    findMany: async (args: any) => {
      calls.push({ op: "deployment.findMany", args });
      let rows = models.filter((m) => matchModel(m, args.where));
      if (args.take) rows = rows.slice(0, args.take);
      if (args.select?.nodes) {
        return rows.map((m) => ({
          ...m,
          nodes: nodes
            .filter((n) => n.deploymentId === m.id)
            .map((n) => ({ id: n.id, nodeUrl: n.nodeUrl, healthStatus: n.healthStatus })),
        }));
      }
      return rows;
    },
    findFirst: async (args: any) => {
      calls.push({ op: "deployment.findFirst", args });
      return models.find((m) => matchModel(m, args.where)) ?? null;
    },
    findUnique: async (args: any) => {
      calls.push({ op: "deployment.findUnique", args });
      const m = models.find((x) => x.id === args.where.id);
      return m ? { ...m } : null;
    },
    updateMany: async (args: any) => {
      calls.push({ op: "deployment.updateMany", args });
      let count = 0;
      for (const m of models) {
        if (matchModel(m, args.where)) {
          Object.assign(m, args.data);
          count += 1;
        }
      }
      return { count };
    },
  };
  const agentDeployment = {
    findMany: async (args: any) => {
      calls.push({ op: "agentDeployment.findMany", args });
      return agents
        .filter(
          (a) =>
            args.where.status.in.includes(a.status) &&
            (args.where.nosanaJobIds?.isEmpty === false ? a.nosanaJobIds.length > 0 : true) &&
            (args.where.reservationCents?.gt === undefined || (a.reservationCents ?? 0n) > args.where.reservationCents.gt) &&
            (!("reservationReleasedAt" in args.where) || a.reservationReleasedAt === args.where.reservationReleasedAt),
        )
        .slice(0, args.take ?? Infinity)
        .map((a) => ({ ...a, agent: { orgId: a.orgId } }));
    },
    findUnique: async (args: any) => {
      calls.push({ op: "agentDeployment.findUnique", args });
      const a = agents.find((x) => x.id === args.where.id);
      return a ? { ...a } : null;
    },
    updateMany: async (args: any) => {
      calls.push({ op: "agentDeployment.updateMany", args });
      let count = 0;
      for (const a of agents) {
        const ok =
          (args.where.id === undefined || a.id === args.where.id) &&
          (args.where.status === undefined || a.status === args.where.status) &&
          ("reservationReleasedAt" in args.where
            ? a.reservationReleasedAt === args.where.reservationReleasedAt
            : true);
        if (ok) {
          Object.assign(a, args.data);
          count += 1;
        }
      }
      return { count };
    },
  };
  const deploymentNode = {
    updateMany: async (args: any) => {
      calls.push({ op: "deploymentNode.updateMany", args });
      let count = 0;
      for (const n of nodes) {
        if (n.id === args.where.id) {
          Object.assign(n, args.data);
          count += 1;
        }
      }
      return { count };
    },
    findMany: async (args: any) => {
      calls.push({ op: "deploymentNode.findMany", args });
      return nodes
        .filter((n) => n.deploymentId === args.where.deploymentId)
        .map((n) => ({ id: n.id, nodeUrl: n.nodeUrl, healthStatus: n.healthStatus }));
    },
    create: async (args: any) => {
      calls.push({ op: "deploymentNode.create", args });
      const row: NodeRow = {
        id: `n_${nodeSeq++}`,
        deploymentId: args.data.deploymentId,
        nosanaNodeId: args.data.nosanaNodeId,
        nodeUrl: args.data.nodeUrl,
        healthStatus: args.data.healthStatus,
        lastHealthCheck: null,
        latencyMs: null,
      };
      nodes.push(row);
      return { id: row.id, nodeUrl: row.nodeUrl, healthStatus: row.healthStatus };
    },
    deleteMany: async (args: any) => {
      calls.push({ op: "deploymentNode.deleteMany", args });
      let count = 0;
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        if (args.where.id.in.includes(nodes[i]!.id)) {
          nodes.splice(i, 1);
          count += 1;
        }
      }
      return { count };
    },
  };
  const nosanaOrphanDeployment = {
    createMany: async (args: any) => {
      calls.push({ op: "nosanaOrphanDeployment.createMany", args });
      let count = 0;
      for (const d of args.data) {
        if (orphans.some((o) => o.nosanaDeploymentId === d.nosanaDeploymentId)) continue;
        orphans.push({ id: `orph_${orphans.length + 1}`, createdAt: NOW, reclaimedAt: null, ...d });
        count += 1;
      }
      return { count };
    },
    findMany: async (args: any) => {
      calls.push({ op: "nosanaOrphanDeployment.findMany", args });
      return orphans
        .filter((o) => o.reclaimedAt === null && o.createdAt >= args.where.createdAt.gte)
        .slice(0, args.take)
        .map((o) => ({ id: o.id, nosanaDeploymentId: o.nosanaDeploymentId }));
    },
    updateMany: async (args: any) => {
      calls.push({ op: "nosanaOrphanDeployment.updateMany", args });
      let count = 0;
      for (const o of orphans) {
        if (o.id === args.where.id && o.reclaimedAt === null) {
          Object.assign(o, args.data);
          count += 1;
        }
      }
      return { count };
    },
  };
  const tx = {
    deployment: {
      ...deployment,
      // Through the live delegate, so a test that wraps prisma.deployment.updateMany
      // also sees (and can interfere with) the writes made inside a transaction.
      updateMany: (args: any) => deployment.updateMany(args),
      update: async (args: any) => {
        const m = models.find((x) => x.id === args.where.id)!;
        Object.assign(m, args.data);
        return { ...m };
      },
    },
    agentDeployment,
    deploymentNode,
    creditBalance: {
      update: async (args: any) => {
        if (failures.creditUpdate > 0) {
          failures.creditUpdate -= 1;
          throw new Error("db down (credit update)");
        }
        const next = (balances.get(args.where.orgId) ?? 0n) + args.data.balanceCents.increment;
        balances.set(args.where.orgId, next);
        return { balanceCents: next };
      },
      updateMany: async (args: any) => {
        const bal = balances.get(args.where.orgId) ?? 0n;
        if (bal < args.where.balanceCents.gte) return { count: 0 };
        balances.set(args.where.orgId, bal - args.data.balanceCents.decrement);
        return { count: 1 };
      },
      findUnique: async (args: any) => ({ balanceCents: balances.get(args.where.orgId) ?? 0n }),
    },
    creditTransaction: {
      create: async (args: any) => {
        ledger.push({
          orgId: args.data.orgId,
          amountCents: args.data.amountCents,
          type: args.data.type,
          referenceId: args.data.referenceId,
        });
        return {};
      },
    },
  };
  const prisma = {
    deployment,
    agentDeployment,
    deploymentNode,
    nosanaOrphanDeployment,
    // A real transaction: everything the callback did is undone if it throws.
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => {
      const snap = {
        models: structuredClone(models),
        agents: structuredClone(agents),
        nodes: structuredClone(nodes),
        balances: new Map(balances),
        ledger: [...ledger],
      };
      try {
        return await fn(tx);
      } catch (err) {
        models.splice(0, models.length, ...snap.models);
        agents.splice(0, agents.length, ...snap.agents);
        nodes.splice(0, nodes.length, ...snap.nodes);
        balances.clear();
        for (const [k, v] of snap.balances) balances.set(k, v);
        ledger.splice(0, ledger.length, ...snap.ledger);
        throw err;
      }
    },
  };
  return { prisma, calls, models, agents, nodes, balances, ledger, failures, orphans };
}

async function buildDeps(opts: {
  db: ReturnType<typeof makeDb>;
  getDeploymentStatus?: (id: string) => Promise<DeploymentSnapshot>;
  checkNodeHealth?: (
    nodeUrl: string,
    engine?: string,
  ) => Promise<{ healthy: boolean; latencyMs: number }>;
  allowMock?: boolean;
  polled?: string[];
  reclaimVault?: (id: string) => Promise<{ reclaimed: boolean }>;
  reclaimMaxAgeHours?: number;
}) {
  setupEnv();
  const { buildDeploymentStatusTickDeps } = await import(
    "../services/buildDeploymentStatusTickDeps.js"
  );
  return buildDeploymentStatusTickDeps({
    prisma: opts.db.prisma as never,
    getDeploymentStatus:
      opts.getDeploymentStatus ??
      (async (id) => {
        opts.polled?.push(id);
        return snapshot("running", { endpoints: [EP] });
      }),
    checkNodeHealth:
      opts.checkNodeHealth ?? (async () => ({ healthy: true, latencyMs: 40 })),
    allowMock: opts.allowMock ?? false,
    emitTransition: async () => {},
    reclaimVault: opts.reclaimVault,
    reclaimMaxAgeHours: opts.reclaimMaxAgeHours,
    pricePerSecondUsd: () => 0.00025, // 4090: $0.90/hour
    now: () => NOW,
  });
}

// ============================================
// loadDeployments — both tables, non-terminal, job ids present
// ============================================

test("loadDeployments merges agent + model rows tagged with their kind; model rows carry nodes + engine", async () => {
  const db = makeDb({
    agents: [{ id: "a1", status: "deploying", nosanaJobIds: ["dm_a"] }],
    models: [{ id: "m1", status: "provisioning", nosanaJobIds: ["dm_m"], engine: "ollama" }],
    nodes: [{ id: "n1", deploymentId: "m1", nodeUrl: "https://n1.node.nos.ci" }],
  });
  const deps = await buildDeps({ db });
  const rows = await deps.loadDeployments();
  assert.deepEqual(rows, [
    {
      kind: "agent",
      id: "a1",
      orgId: "org_1",
      status: "deploying",
      nosanaJobIds: ["dm_a"],
      // A row with no access-mode stamp was created by the wallet.
      nosanaAccessMode: "wallet",
      reservationCents: null,
      reservationReleasedAt: null,
    },
    {
      kind: "model",
      id: "m1",
      orgId: "org_1",
      status: "provisioning",
      engine: "ollama",
      nosanaJobIds: ["dm_m"],
      nosanaAccessMode: "wallet",
      runGeneration: 0,
      replicas: 1,
      replicaChange: null,
      reservationCents: null,
      reservationReleasedAt: null,
      nodes: [{ id: "n1", nodeUrl: "https://n1.node.nos.ci", healthStatus: "unknown" }],
    },
  ]);
});

test("loadDeployments filters to non-terminal statuses and non-empty job ids (per model's vocabulary)", async () => {
  const db = makeDb({});
  const deps = await buildDeps({ db });
  await deps.loadDeployments();

  const agentFind = db.calls.find((c) => c.op === "agentDeployment.findMany")!;
  assert.deepEqual(agentFind.args.where.status.in, ["pending", "building", "deploying", "running"]);
  assert.deepEqual(agentFind.args.where.nosanaJobIds, { isEmpty: false });

  const modelFind = db.calls.find((c) => c.op === "deployment.findMany")!;
  assert.deepEqual(modelFind.args.where.status.in, ["pending", "provisioning", "running", "degraded"]);
  assert.deepEqual(modelFind.args.where.nosanaJobIds, { isEmpty: false });
  assert.equal(modelFind.args.select.engine, true, "engine selects the health path");
  assert.deepEqual(modelFind.args.select.nodes, {
    select: { id: true, nodeUrl: true, healthStatus: true },
  });
});

test("loadDeployments polls 'running' rows too — a Nosana stop/error must be observable", async () => {
  const db = makeDb({});
  const deps = await buildDeps({ db });
  await deps.loadDeployments();
  assert.ok(db.calls.find((c) => c.op === "agentDeployment.findMany")!.args.where.status.in.includes("running"));
  assert.ok(db.calls.find((c) => c.op === "deployment.findMany")!.args.where.status.in.includes("running"));
});

// ============================================
// observeDeployment — strict seam + env-gated mock path
// ============================================

test("observeDeployment passes the Deployment-Manager id to the strict read and maps the snapshot", async () => {
  const polled: string[] = [];
  const deps = await buildDeps({ db: makeDb({}), polled, allowMock: false });
  const obs = await deps.observeDeployment("DeploymentManagerId1");
  assert.deepEqual(polled, ["DeploymentManagerId1"]);
  assert.deepEqual(obs, { state: "running", endpoints: [EP], replicas: 1 });
});

test("observeDeployment surfaces the Nosana failure event as the reason for ERROR", async () => {
  const deps = await buildDeps({
    db: makeDb({}),
    getDeploymentStatus: async () =>
      snapshot("error", {
        events: [
          { type: "DEPLOYMENT_STARTED", message: "started", createdAt: "2026-06-12T10:00:00.000Z" },
          { type: "JOB_FAILED", message: "image pull failed", createdAt: "2026-06-12T10:05:00.000Z" },
          { type: "DEPLOYMENT_STOPPING", message: "stopping", createdAt: "2026-06-12T10:06:00.000Z" },
        ],
      }),
  });
  const obs = await deps.observeDeployment("dm_1");
  assert.equal(obs.state, "error");
  assert.equal(obs.detail, "JOB_FAILED: image pull failed");
});

test("observeDeployment: no events -> no detail (the tick records the generic reason)", async () => {
  const deps = await buildDeps({
    db: makeDb({}),
    getDeploymentStatus: async () => snapshot("error"),
  });
  assert.equal((await deps.observeDeployment("dm_1")).detail, undefined);
});

test("observeDeployment bubbles strict-read throws (API outage → row untouched upstream)", async () => {
  const deps = await buildDeps({
    db: makeDb({}),
    getDeploymentStatus: async () => {
      throw new Error("429 from Nosana");
    },
  });
  await assert.rejects(deps.observeDeployment("dm_1"), /429 from Nosana/);
});

test("mock ids yield a LABELLED mock observation ONLY when allowMock is set", async () => {
  // ALLOW_NOSANA_MOCK is boot-rejected in production, so this branch is
  // dev-only by construction.
  const polled: string[] = [];
  const deps = await buildDeps({ db: makeDb({}), polled, allowMock: true });
  assert.deepEqual(await deps.observeDeployment("mock_deploy_xyz"), {
    state: "running",
    endpoints: [],
    mock: true,
  });
  assert.deepEqual(await deps.observeDeployment("mock_job_abc"), {
    state: "running",
    endpoints: [],
    mock: true,
  });
  assert.deepEqual(polled, []); // never reached Nosana
});

test("without allowMock, mock ids go to the strict read (which throws on them)", async () => {
  const deps = await buildDeps({
    db: makeDb({}),
    allowMock: false,
    getDeploymentStatus: async (id) => {
      throw new Error(`Mock Nosana id cannot be queried: ${id}`);
    },
  });
  await assert.rejects(deps.observeDeployment("mock_deploy_abc"), /cannot be queried/);
});

// ============================================
// persistTransition — CAS, stoppedAt, reason, billing cursor
// ============================================

test("persistTransition CASes on {id, status: fromStatus} for agent rows", async () => {
  const db = makeDb({});
  const deps = await buildDeps({ db });
  await deps.persistTransition({
    kind: "agent",
    id: "a1",
    orgId: "org_1",
    fromStatus: "deploying",
    toStatus: "running",
    observedAt: NOW,
  });
  const update = db.calls.find((c) => c.op === "agentDeployment.updateMany")!;
  assert.deepEqual(update.args.where, { id: "a1", status: "deploying" });
  assert.deepEqual(update.args.data, { status: "running" }); // no stoppedAt on a live transition
});

test("model rows: running sets the GPU billing cursor and clears any stale reason", async () => {
  const db = makeDb({});
  const deps = await buildDeps({ db });
  await deps.persistTransition({
    kind: "model",
    id: "m1",
    orgId: "org_1",
    fromStatus: "provisioning",
    toStatus: "running",
    observedAt: NOW,
  });
  const update = db.calls.find((c) => c.op === "deployment.updateMany")!;
  assert.deepEqual(update.args.where, { id: "m1", status: "provisioning" });
  assert.deepEqual(update.args.data, {
    status: "running",
    statusReason: null,
    billedThroughAt: NOW,
  });
});

test("persistTransition records stoppedAt + reason on terminal transitions (both kinds)", async () => {
  const db = makeDb({});
  const deps = await buildDeps({ db });

  await deps.persistTransition({
    kind: "model",
    id: "m1",
    orgId: "org_1",
    fromStatus: "running",
    toStatus: "stopped",
    observedAt: NOW,
    reason: "nosana_stopped",
  });
  const modelUpdate = db.calls.find((c) => c.op === "deployment.updateMany")!;
  assert.deepEqual(modelUpdate.args.data, {
    status: "stopped",
    stoppedAt: NOW,
    statusReason: "nosana_stopped",
    // explicit: a stale "recovered" stamp from an earlier run must never survive
    vaultReclaimedAt: null,
  });

  await deps.persistTransition({
    kind: "agent",
    id: "a1",
    orgId: "org_1",
    fromStatus: "running",
    toStatus: "stopped",
    observedAt: NOW,
  });
  const agentUpdate = db.calls.find((c) => c.op === "agentDeployment.updateMany")!;
  assert.deepEqual(agentUpdate.args.data, { status: "stopped", stoppedAt: NOW });
});

test("persistTransition records the failure reason: lastError on agents, statusReason on models", async () => {
  const db = makeDb({});
  const deps = await buildDeps({ db });

  await deps.persistTransition({
    kind: "agent",
    id: "a1",
    orgId: "org_1",
    fromStatus: "running",
    toStatus: "failed",
    observedAt: NOW,
    reason: "JOB_FAILED: image pull failed",
  });
  const agentUpdate = db.calls.find((c) => c.op === "agentDeployment.updateMany")!;
  assert.equal(agentUpdate.args.data.status, "failed");
  assert.deepEqual(agentUpdate.args.data.stoppedAt, NOW);
  assert.equal(agentUpdate.args.data.lastError, "JOB_FAILED: image pull failed");

  await deps.persistTransition({
    kind: "model",
    id: "m1",
    orgId: "org_1",
    fromStatus: "running",
    toStatus: "failed",
    observedAt: NOW,
    reason: "nosana_insufficient_funds",
  });
  const modelUpdate = db.calls.find((c) => c.op === "deployment.updateMany")!;
  assert.equal(modelUpdate.args.data.statusReason, "nosana_insufficient_funds");
  assert.equal("lastError" in modelUpdate.args.data, false, "models have no lastError column");
  assert.equal("billedThroughAt" in modelUpdate.args.data, false, "no cursor for a failure");
});

// ============================================
// syncNodes — one node per REAL endpoint
// ============================================

test("syncNodes creates a node per endpoint url with the host as its identity", async () => {
  const db = makeDb({ models: [{ id: "m1", status: "provisioning" }] });
  const deps = await buildDeps({ db });
  const ep2 = { url: "https://def.node.k8s.prd.nos.ci", port: 8000, opId: "vllm-inference" };

  const result = await deps.syncNodes!({ deploymentId: "m1", endpoints: [EP, ep2] });

  assert.equal(result.length, 2);
  assert.deepEqual(
    db.nodes.map((n) => [n.nodeUrl, n.nosanaNodeId, n.healthStatus]),
    [
      [EP.url, "abc.node.k8s.prd.nos.ci", "unknown"],
      [ep2.url, "def.node.k8s.prd.nos.ci", "unknown"],
    ],
  );
});

test("syncNodes deletes the FABRICATED rows (empty url / node_N) and keeps matching nodes with their health", async () => {
  const db = makeDb({
    models: [{ id: "m1", status: "running" }],
    nodes: [
      { id: "fake0", deploymentId: "m1", nodeUrl: "", nosanaNodeId: "node_0" },
      { id: "fake1", deploymentId: "m1", nodeUrl: "", nosanaNodeId: "node_1" },
      { id: "real", deploymentId: "m1", nodeUrl: EP.url, healthStatus: "healthy" },
      { id: "dup", deploymentId: "m1", nodeUrl: EP.url, healthStatus: "unknown" },
    ],
  });
  const deps = await buildDeps({ db });

  const result = await deps.syncNodes!({ deploymentId: "m1", endpoints: [EP] });

  assert.deepEqual(result, [{ id: "real", nodeUrl: EP.url, healthStatus: "healthy" }]);
  assert.deepEqual(
    db.nodes.map((n) => n.id),
    ["real"],
  );
});

test("syncNodes with no endpoints removes every node", async () => {
  const db = makeDb({
    models: [{ id: "m1", status: "running" }],
    nodes: [{ id: "n1", deploymentId: "m1", nodeUrl: EP.url }],
  });
  const deps = await buildDeps({ db });
  assert.deepEqual(await deps.syncNodes!({ deploymentId: "m1", endpoints: [] }), []);
  assert.equal(db.nodes.length, 0);
});

test("syncNodes never creates nodes for a deployment that left service between load and write", async () => {
  const db = makeDb({ models: [{ id: "m1", status: "stopped" }] });
  const deps = await buildDeps({ db });
  assert.deepEqual(await deps.syncNodes!({ deploymentId: "m1", endpoints: [EP] }), []);
  assert.equal(db.nodes.length, 0, "no node may point /v1 at a stopped deployment");
});

// ============================================
// Node health — probe seam + race-safe persistence (plan A2)
// ============================================

test("checkNodeHealth passes the node URL and engine through to the client probe", async () => {
  const probed: Array<[string, string | undefined]> = [];
  const deps = await buildDeps({
    db: makeDb({}),
    checkNodeHealth: async (nodeUrl, engine) => {
      probed.push([nodeUrl, engine]);
      return { healthy: false, latencyMs: 123 };
    },
  });
  const result = await deps.checkNodeHealth("https://n1.node.nos.ci", "ollama");
  assert.deepEqual(result, { healthy: false, latencyMs: 123 });
  assert.deepEqual(probed, [["https://n1.node.nos.ci", "ollama"]]);
});

test("persistNodeHealth updateManys the probe result by node id (race-safe, no P2025)", async () => {
  const db = makeDb({});
  const deps = await buildDeps({ db });
  await deps.persistNodeHealth({
    nodeId: "n1",
    healthStatus: "healthy",
    latencyMs: 42,
    checkedAt: NOW,
  });
  const update = db.calls.find((c) => c.op === "deploymentNode.updateMany")!;
  assert.deepEqual(update.args.where, { id: "n1" });
  assert.deepEqual(update.args.data, {
    healthStatus: "healthy",
    lastHealthCheck: NOW,
    latencyMs: 42,
  });
});

// ============================================
// Vault reclaim sweep
// ============================================

test("loadVaultReclaimCandidates selects recent stopped/failed rows whose vault was not recovered", async () => {
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
  const db = makeDb({
    models: [
      { id: "fresh", status: "stopped", stoppedAt: hoursAgo(1), nosanaJobIds: ["dm_fresh"] },
      { id: "failed", status: "failed", stoppedAt: hoursAgo(2), nosanaJobIds: ["dm_failed"] },
      { id: "done", status: "stopped", stoppedAt: hoursAgo(1), vaultReclaimedAt: hoursAgo(0), nosanaJobIds: ["dm_done"] },
      { id: "old", status: "stopped", stoppedAt: hoursAgo(100), nosanaJobIds: ["dm_old"] },
      { id: "running", status: "running", nosanaJobIds: ["dm_running"] },
      { id: "mock", status: "stopped", stoppedAt: hoursAgo(1), nosanaJobIds: ["mock_deploy_x"] },
      { id: "nojob", status: "stopped", stoppedAt: hoursAgo(1), nosanaJobIds: [] },
    ],
  });
  const deps = await buildDeps({
    db,
    reclaimVault: async () => ({ reclaimed: true }),
    reclaimMaxAgeHours: 72,
  });
  const candidates = await deps.loadVaultReclaimCandidates!();
  assert.deepEqual(candidates, [
    { id: "fresh", nosanaDeploymentId: "dm_fresh", accessMode: "wallet" },
    { id: "failed", nosanaDeploymentId: "dm_failed", accessMode: "wallet" },
  ]);
});

test("reclaimVault records vaultReclaimedAt ONLY when the funds were verified recovered", async () => {
  const db = makeDb({
    models: [
      { id: "ok", status: "stopped", nosanaJobIds: ["dm_ok"] },
      { id: "pending", status: "stopped", nosanaJobIds: ["dm_pending"] },
    ],
  });
  const deps = await buildDeps({
    db,
    reclaimVault: async (id) => ({ reclaimed: id === "dm_ok" }),
  });

  assert.deepEqual(await deps.reclaimVault!({ id: "ok", nosanaDeploymentId: "dm_ok" }), { reclaimed: true });
  assert.deepEqual(await deps.reclaimVault!({ id: "pending", nosanaDeploymentId: "dm_pending" }), { reclaimed: false });

  assert.deepEqual(db.models.find((m) => m.id === "ok")!.vaultReclaimedAt, NOW);
  assert.equal(db.models.find((m) => m.id === "pending")!.vaultReclaimedAt, null, "retried next tick");
});

test("without a reclaimVault client the sweep is not wired", async () => {
  const deps = await buildDeps({ db: makeDb({}) });
  assert.equal(deps.loadVaultReclaimCandidates, undefined);
  assert.equal(deps.reclaimVault, undefined);
});

// ============================================
// End-to-end through the real tick
// ============================================

test("composition: RUNNING + endpoint -> running, a real node replaces the fabricated one, and it is probed healthy", async () => {
  // The W2-D acceptance test. /v1 selects nodes WHERE healthStatus='healthy'
  // on a deployment WHERE status='running' - this is the chain that makes a
  // model deployment servable.
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const db = makeDb({
    models: [{ id: "m1", status: "provisioning", nosanaJobIds: ["dm_1"] }],
    nodes: [{ id: "fake", deploymentId: "m1", nodeUrl: "", nosanaNodeId: "node_0" }],
  });
  const probed: Array<[string, string | undefined]> = [];
  const deps = await buildDeps({
    db,
    getDeploymentStatus: async () => snapshot("running", { endpoints: [EP] }),
    checkNodeHealth: async (url, engine) => {
      probed.push([url, engine]);
      return { healthy: true, latencyMs: 55 };
    },
  });

  const result = await runDeploymentStatusTick({ now: NOW }, deps);

  assert.equal(result.transitioned, 1);
  const model = db.models[0]!;
  assert.equal(model.status, "running");
  assert.deepEqual(model.billedThroughAt, NOW, "GPU billing starts when the endpoint is observed");
  assert.equal(db.nodes.length, 1, "the fabricated node_0 row is gone");
  const node = db.nodes[0]!;
  assert.equal(node.nodeUrl, EP.url, "nodeUrl is the endpoint Nosana reported");
  assert.equal(node.healthStatus, "healthy");
  assert.equal(node.latencyMs, 55);
  assert.deepEqual(probed, [[EP.url, "vllm"]]);
});

test("composition: ERROR -> failed + reason, hold released exactly once, nodes removed", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const db = makeDb({
    models: [{ id: "m1", status: "running", reservationCents: 90n }],
    nodes: [{ id: "n1", deploymentId: "m1", nodeUrl: EP.url }],
    balances: { org_1: 1000n },
  });
  const deps = await buildDeps({
    db,
    getDeploymentStatus: async () =>
      snapshot("error", {
        events: [{ type: "JOB_FAILED", message: "no host", createdAt: "2026-06-12T11:00:00.000Z" }],
      }),
  });

  const first = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(first.transitioned, 1);
  assert.equal(first.reservationsReleased, 1);
  const model = db.models[0]!;
  assert.equal(model.status, "failed");
  assert.equal(model.statusReason, "JOB_FAILED: no host");
  assert.deepEqual(model.stoppedAt, NOW);
  assert.equal(db.balances.get("org_1"), 1090n, "the 90c hold came back");
  assert.deepEqual(
    db.ledger.map((l) => [l.type, l.amountCents, l.referenceId]),
    [["deployment_reservation_release", 90n, "m1"]],
  );
  assert.equal(db.nodes.length, 0);

  // A second tick: the row is terminal and no longer loaded - no double refund.
  const second = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(second.scanned, 0);
  assert.equal(db.balances.get("org_1"), 1090n);
});

test("composition: deploying agent row + running deployment with an endpoint → CAS write to running", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const db = makeDb({
    agents: [{ id: "a1", status: "deploying", nosanaJobIds: ["dm_a"] }],
  });
  const deps = await buildDeps({ db });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(result.transitioned, 1);
  const update = db.calls.find((c) => c.op === "agentDeployment.updateMany")!;
  assert.deepEqual(update.args.where, { id: "a1", status: "deploying" });
  assert.deepEqual(update.args.data, { status: "running" });
});

test("composition: an API outage touches nothing — no updateMany / node write issued", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const db = makeDb({
    agents: [{ id: "a1", status: "deploying", nosanaJobIds: ["dm_a"] }],
    models: [{ id: "m1", status: "running", nosanaJobIds: ["dm_m"] }],
  });
  const deps = await buildDeps({
    db,
    getDeploymentStatus: async () => {
      throw new Error("fetch failed");
    },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(result.failed, 2);
  assert.equal(result.transitioned, 0);
  assert.equal(
    db.calls.filter((c) => c.op.endsWith("updateMany") || c.op.startsWith("deploymentNode.create") || c.op.endsWith("deleteMany")).length,
    0,
  );
});

// ============================================
// Review #1: the release credits the hold AS IT IS, not as the tick loaded it
// ============================================

test("a concurrent scale-down between load and release: the refund is the CURRENT hold, not the stale one (review #1)", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const db = makeDb({
    models: [{ id: "m1", status: "running", reservationCents: 200n, replicas: 2 }],
    balances: { org_1: 1000n },
  });
  const deps = await buildDeps({
    db,
    getDeploymentStatus: async () => {
      // The user scales 2 -> 1 (hold 200 -> 100) after the tick loaded the row
      // but before its release runs.
      db.models[0]!.replicas = 1;
      db.models[0]!.reservationCents = 100n;
      return snapshot("error");
    },
  });

  const result = await runDeploymentStatusTick({ now: NOW }, deps);

  assert.equal(result.reservationsReleased, 1);
  assert.equal(db.balances.get("org_1"), 1100n, "refunded 100 (the real hold), not the stale 200");
  assert.deepEqual(
    db.ledger.filter((l) => l.type === "deployment_reservation_release").map((l) => l.amountCents),
    [100n],
  );
});

test("after a concurrent scale-UP the extra hold is refunded too (review #1)", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const db = makeDb({
    models: [{ id: "m1", status: "running", reservationCents: 90n }],
    balances: { org_1: 1000n },
  });
  const deps = await buildDeps({
    db,
    getDeploymentStatus: async () => {
      db.models[0]!.reservationCents = 180n; // 1 -> 2 replicas while the tick ran
      return snapshot("stopped");
    },
  });
  await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(db.balances.get("org_1"), 1180n, "the whole 180 came back");
});

// ============================================
// Review #2: a failed release is retried by the sweep
// ============================================

test("a release that fails after the transition is retried on the next tick by the sweep (review #2)", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  // A row that never ran: its release is a separate step after the transition.
  // (A row leaving `running` releases inside the transition itself - see "a
  // terminal edge whose release fails rolls the whole transition back".)
  const db = makeDb({
    models: [{ id: "m1", status: "provisioning", reservationCents: 90n }],
    balances: { org_1: 1000n },
  });
  const deps = await buildDeps({ db, getDeploymentStatus: async () => snapshot("error") });

  // Tick 1: the status change lands, the release's credit throws (its whole
  // transaction rolls back - including the barrier). The sweep retries within
  // the same tick, so the outage must outlast that retry too (2 failures).
  db.failures.creditUpdate = 2;
  const first = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(first.transitioned, 1);
  assert.equal(first.reservationsReleased, 0);
  assert.equal(first.reservationReleasesFailed, 2, "the in-tick release and its immediate sweep retry both failed");
  assert.equal(db.models[0]!.status, "failed");
  assert.equal(db.models[0]!.reservationReleasedAt, null, "still unreleased");
  assert.equal(db.balances.get("org_1"), 1000n);

  // Tick 2: the row is terminal, so loadDeployments no longer returns it - only
  // the sweep can rescue the org's money.
  const second = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(second.scanned, 0);
  assert.equal(second.reservationsReleased, 1);
  assert.equal(db.balances.get("org_1"), 1090n);
  assert.notEqual(db.models[0]!.reservationReleasedAt, null);

  // Tick 3: nothing left to release - never twice.
  const third = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(third.reservationsReleased, 0);
  assert.equal(db.balances.get("org_1"), 1090n);
});

test("loadUnreleasedReservations selects only TERMINAL rows whose hold is still held, for both kinds", async () => {
  const released = new Date("2026-06-12T11:00:00Z");
  const db = makeDb({
    models: [
      { id: "m_failed", status: "failed", reservationCents: 10n },
      { id: "m_stopped", status: "stopped", reservationCents: 20n },
      { id: "m_done", status: "stopped", reservationCents: 30n, reservationReleasedAt: released },
      { id: "m_zero", status: "failed", reservationCents: 0n },
      { id: "m_null", status: "failed", reservationCents: null },
      { id: "m_running", status: "running", reservationCents: 40n },
      { id: "m_pending", status: "pending", reservationCents: 50n }, // e.g. restarted: a LIVE hold
    ],
    agents: [
      { id: "a_failed", status: "failed", reservationCents: 15n, orgId: "org_9" },
      { id: "a_running", status: "running", reservationCents: 25n },
    ],
  });
  const deps = await buildDeps({ db });
  const rows = await deps.loadUnreleasedReservations!();
  assert.deepEqual(
    rows.map((r) => [r.kind, r.id, r.orgId, r.status, r.reservationCents]),
    [
      ["model", "m_failed", "org_1", "failed", 10n],
      ["model", "m_stopped", "org_1", "stopped", 20n],
      ["agent", "a_failed", "org_9", "failed", 15n],
    ],
  );
});

test("a late release cannot claim the live hold of a run the user restarted (status guard)", async () => {
  // Restart resets reservationReleasedAt to null for the NEW run's hold. A
  // release that arrives after the restart would otherwise refund it.
  const db = makeDb({
    models: [{ id: "m1", status: "pending", reservationCents: 90n, reservationReleasedAt: null }],
    balances: { org_1: 1000n },
  });
  const deps = await buildDeps({ db });
  const result = await deps.releaseReservation!({
    kind: "model",
    id: "m1",
    orgId: "org_1",
    reservationCents: 90n,
    reason: "failed",
  });
  assert.deepEqual(result, { released: false });
  assert.equal(db.models[0]!.reservationReleasedAt, null, "the new run's hold is untouched");
  assert.equal(db.balances.get("org_1"), 1000n);
});

// ============================================
// Review #3: the vault sweep cannot stamp a restarted run as recovered
// ============================================

test("the sweep's CAS names the reclaimed Nosana deployment AND requires a terminal row (review #3)", async () => {
  const db = makeDb({ models: [{ id: "m1", status: "stopped", nosanaJobIds: ["dm_X"] }] });
  const deps = await buildDeps({ db, reclaimVault: async () => ({ reclaimed: true }) });
  await deps.reclaimVault!({ id: "m1", nosanaDeploymentId: "dm_X" });
  const cas = db.calls.filter((c) => c.op === "deployment.updateMany").at(-1)!;
  assert.deepEqual(cas.args.where, {
    id: "m1",
    vaultReclaimedAt: null,
    nosanaJobIds: { has: "dm_X" },
    status: { in: ["stopped", "failed"] },
  });
});

test("a run restarted while the OLD vault's withdraw was in flight is NOT stamped recovered (review #3)", async () => {
  // Candidate loaded for run X; the user restarts: the row is now run Y
  // (pending, ids [Y], vaultReclaimedAt reset to null). X's withdraw then
  // succeeds. Keyed on the row id alone the sweep stamped Y "recovered" and Y's
  // NOS was never reclaimed.
  const db = makeDb({ models: [{ id: "m1", status: "stopped", nosanaJobIds: ["dm_X"] }] });
  const deps = await buildDeps({
    db,
    reclaimVault: async () => {
      // the restart lands during the withdraw
      const row = db.models[0]!;
      row.status = "pending";
      row.nosanaJobIds = ["dm_Y"];
      row.vaultReclaimedAt = null;
      return { reclaimed: true };
    },
  });

  const result = await deps.reclaimVault!({ id: "m1", nosanaDeploymentId: "dm_X" });

  assert.deepEqual(result, { reclaimed: true }, "X itself WAS recovered");
  assert.equal(db.models[0]!.vaultReclaimedAt, null, "but run Y is not marked recovered");
});

test("even with the same id, a row that is no longer terminal is not stamped", async () => {
  const db = makeDb({ models: [{ id: "m1", status: "stopped", nosanaJobIds: ["dm_X"] }] });
  const deps = await buildDeps({
    db,
    reclaimVault: async () => {
      db.models[0]!.status = "provisioning"; // e.g. restarted, id not yet replaced
      return { reclaimed: true };
    },
  });
  await deps.reclaimVault!({ id: "m1", nosanaDeploymentId: "dm_X" });
  assert.equal(db.models[0]!.vaultReclaimedAt, null);
});

// ============================================
// Review #5: billing edges of a running spell
// ============================================

const secondsBefore = (s: number) => new Date(NOW.getTime() - s * 1000);

test("running -> degraded settles the window BEFORE the degraded stretch (review #5)", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const db = makeDb({
    models: [{ id: "m1", status: "running", billedThroughAt: secondsBefore(100) }],
    balances: { org_1: 1000n },
  });
  // running on Nosana, but no live endpoint any more
  const deps = await buildDeps({
    db,
    getDeploymentStatus: async () => snapshot("running", { endpoints: [] }),
  });

  await runDeploymentStatusTick({ now: NOW }, deps);

  assert.equal(db.models[0]!.status, "degraded");
  // 100 s x 250 uUSD = 25,000 uUSD = 2.5 cents -> 2 cents (floor, 80 s covered)
  assert.deepEqual(
    db.ledger.filter((l) => l.type === "gpu_usage").map((l) => [l.amountCents, l.referenceId]),
    [[-2n, "m1"]],
  );
  assert.equal(db.balances.get("org_1"), 998n);
  assert.deepEqual(db.models[0]!.billedThroughAt, secondsBefore(20), "cursor advanced by the 80 s those cents cover");
});

test("degraded -> running resets the cursor: the degraded stretch is never billed, the pre-degrade stretch already was (review #5)", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const db = makeDb({
    models: [{ id: "m1", status: "degraded", billedThroughAt: secondsBefore(3600) }], // stale: degraded an hour ago
    balances: { org_1: 1000n },
  });
  const deps = await buildDeps({
    db,
    getDeploymentStatus: async () => snapshot("running", { endpoints: [EP] }),
  });
  await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(db.models[0]!.status, "running");
  assert.deepEqual(db.models[0]!.billedThroughAt, NOW);
  assert.equal(db.ledger.filter((l) => l.type === "gpu_usage").length, 0, "no charge for an hour of degraded time");
  assert.equal(db.balances.get("org_1"), 1000n);
});

test("a terminal transition seen by the tick settles the tail of the running window (review #5)", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  for (const [observed, to] of [["stopped", "stopped"], ["error", "failed"]] as const) {
    const db = makeDb({
      models: [{ id: "m1", status: "running", billedThroughAt: secondsBefore(100) }],
      balances: { org_1: 1000n },
    });
    const deps = await buildDeps({ db, getDeploymentStatus: async () => snapshot(observed) });
    await runDeploymentStatusTick({ now: NOW }, deps);
    assert.equal(db.models[0]!.status, to);
    assert.equal(db.balances.get("org_1"), 998n, `${observed}: the last 80 s are billed`);
    assert.equal(db.ledger.filter((l) => l.type === "gpu_usage").length, 1, observed);
  }
});

test("a terminal transition from DEGRADED (or provisioning) bills nothing: the degrade edge already settled", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  for (const status of ["degraded", "provisioning"]) {
    const db = makeDb({
      // a stale cursor from before the degrade, as the real row would carry
      models: [{ id: "m1", status, billedThroughAt: status === "degraded" ? secondsBefore(3600) : null }],
      balances: { org_1: 1000n },
    });
    const deps = await buildDeps({ db, getDeploymentStatus: async () => snapshot("error") });
    await runDeploymentStatusTick({ now: NOW }, deps);
    assert.equal(db.models[0]!.status, "failed", status);
    assert.equal(db.ledger.filter((l) => l.type === "gpu_usage").length, 0, `${status}: nothing billed`);
    assert.equal(db.balances.get("org_1"), 1000n, status);
  }
});

test("the settle takes what an unpayable org has and never blocks the transition (partial, no throw)", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const db = makeDb({
    models: [{ id: "m1", status: "running", billedThroughAt: secondsBefore(100) }],
    balances: { org_1: 1n }, // owes 2 cents
  });
  const deps = await buildDeps({ db, getDeploymentStatus: async () => snapshot("error") });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(result.transitioned, 1, "the deployment still leaves service");
  assert.equal(db.models[0]!.status, "failed");
  assert.equal(db.balances.get("org_1"), 0n, "charged what it had");
});

test("settling is idempotent against a concurrent stop that already billed past the observation", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  // The user's stop final-billed up to AFTER the tick's observation time.
  const db = makeDb({
    models: [{ id: "m1", status: "running", billedThroughAt: new Date(NOW.getTime() + 5000) }],
    balances: { org_1: 1000n },
  });
  const deps = await buildDeps({ db, getDeploymentStatus: async () => snapshot("stopped") });
  await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(db.ledger.filter((l) => l.type === "gpu_usage").length, 0, "no window left to bill");
  assert.equal(db.balances.get("org_1"), 1000n);
});

// ============================================
// Restarted runs: a row is reused, so every late write names its run
// ============================================

test("persistTransition: an observation of a run the user has since restarted does not touch the new run", async () => {
  // The tick loaded the row as running (generation 3) and Nosana then reported
  // THAT deployment stopped. Meanwhile the user stopped and restarted the row:
  // generation 4, running again on a new Nosana deployment. {id, status} alone
  // matched it and marked the live run stopped.
  const db = makeDb({
    models: [{ id: "m1", status: "running", runGeneration: 4, nosanaJobIds: ["dm_new"], billedThroughAt: NOW }],
    balances: { org_1: 1_000n },
  });
  const deps = await buildDeps({ db });
  const stale = {
    kind: "model" as const,
    id: "m1",
    orgId: "org_1",
    fromStatus: "running",
    toStatus: "stopped",
    observedAt: NOW,
    reason: "nosana_stopped",
    runGeneration: 3,
    nosanaDeploymentId: "dm_old",
  };

  assert.equal((await deps.persistTransition(stale)).count, 0);
  const row = db.models[0]!;
  assert.equal(row.status, "running", "the restarted run keeps running");
  assert.equal(row.stoppedAt, null);
  assert.equal(row.statusReason, null);

  // The same observation for the run it was made of still lands.
  assert.equal((await deps.persistTransition({ ...stale, runGeneration: 4 })).count, 1);
  assert.equal(row.status, "stopped");
});

test("persistTransition puts the loaded run generation into the model CAS (non-settling edges too)", async () => {
  const db = makeDb({ models: [{ id: "m1", status: "provisioning", runGeneration: 2 }] });
  const deps = await buildDeps({ db });
  await deps.persistTransition({
    kind: "model",
    id: "m1",
    orgId: "org_1",
    fromStatus: "provisioning",
    toStatus: "running",
    observedAt: NOW,
    runGeneration: 2,
  });
  const update = db.calls.find((c) => c.op === "deployment.updateMany")!;
  assert.deepEqual(update.args.where, { id: "m1", status: "provisioning", runGeneration: 2 });
});

test("the real tick carries each model row's run generation into its transition", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const db = makeDb({ models: [{ id: "m1", status: "provisioning", runGeneration: 7 }] });
  const deps = await buildDeps({ db });
  await runDeploymentStatusTick({ now: NOW }, deps);
  const update = db.calls.find((c) => c.op === "deployment.updateMany" && c.args.data.status === "running")!;
  assert.equal(update.args.where.runGeneration, 7);
  assert.equal(db.models[0]!.status, "running");
});

test("syncNodes gives a later run no nodes from an earlier run's endpoints", async () => {
  const db = makeDb({ models: [{ id: "m1", status: "provisioning", runGeneration: 5 }] });
  const deps = await buildDeps({ db });
  assert.deepEqual(await deps.syncNodes!({ deploymentId: "m1", endpoints: [EP], runGeneration: 4 }), []);
  assert.equal(db.nodes.length, 0, "the old run's endpoint is not attached to the new run");
  assert.equal((await deps.syncNodes!({ deploymentId: "m1", endpoints: [EP], runGeneration: 5 })).length, 1);
});

test("a transition-path release names its run: a restarted run that failed keeps its own release to its own writer", async () => {
  const db = makeDb({
    models: [{ id: "m1", status: "failed", runGeneration: 2, reservationCents: 90n }],
    balances: { org_1: 0n },
  });
  const deps = await buildDeps({ db });
  const stale = await deps.releaseReservation!({
    kind: "model", id: "m1", orgId: "org_1", reservationCents: 90n, reason: "stopped", runGeneration: 1,
  });
  assert.deepEqual(stale, { released: false });
  assert.equal(db.balances.get("org_1"), 0n);
  const own = await deps.releaseReservation!({
    kind: "model", id: "m1", orgId: "org_1", reservationCents: 90n, reason: "failed", runGeneration: 2,
  });
  assert.deepEqual(own, { released: true });
  assert.equal(db.balances.get("org_1"), 90n);
});

// ============================================
// Untracked Nosana deployments (nosana_orphan_deployments)
// ============================================

test("the vault sweep also covers untracked Nosana deployments, oldest first and within the give-up age", async () => {
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
  const db = makeDb({
    models: [{ id: "row", status: "stopped", stoppedAt: hoursAgo(1), nosanaJobIds: ["dm_row"] }],
    orphans: [
      { id: "o_live", nosanaDeploymentId: "dm_orphan", createdAt: hoursAgo(2) },
      { id: "o_done", nosanaDeploymentId: "dm_done", createdAt: hoursAgo(2), reclaimedAt: hoursAgo(1) },
      { id: "o_old", nosanaDeploymentId: "dm_ancient", createdAt: hoursAgo(100) },
    ],
  });
  const deps = await buildDeps({ db, reclaimVault: async () => ({ reclaimed: true }), reclaimMaxAgeHours: 72 });
  assert.deepEqual(await deps.loadVaultReclaimCandidates!(), [
    { id: "o_live", nosanaDeploymentId: "dm_orphan", orphan: true, accessMode: "wallet" },
    { id: "row", nosanaDeploymentId: "dm_row", accessMode: "wallet" },
  ]);
});

test("reclaiming an untracked deployment stamps the orphan record only once the funds are verified back", async () => {
  const db = makeDb({
    models: [{ id: "m1", status: "stopped", nosanaJobIds: ["dm_orphan"] }],
    orphans: [{ id: "o1", nosanaDeploymentId: "dm_orphan" }],
  });
  let reclaimed = false;
  const asked: string[] = [];
  const deps = await buildDeps({
    db,
    reclaimVault: async (id) => {
      asked.push(id);
      return { reclaimed };
    },
  });
  const candidate = { id: "o1", nosanaDeploymentId: "dm_orphan", orphan: true };

  assert.deepEqual(await deps.reclaimVault!(candidate), { reclaimed: false });
  assert.equal(db.orphans[0]!.reclaimedAt, null, "still pending: retried next tick");

  reclaimed = true;
  assert.deepEqual(await deps.reclaimVault!(candidate), { reclaimed: true });
  assert.deepEqual(db.orphans[0]!.reclaimedAt, NOW);
  assert.deepEqual(asked, ["dm_orphan", "dm_orphan"], "the client that stops-then-withdraws is used");
  assert.equal(db.models[0]!.vaultReclaimedAt, null, "an orphan's result is never stamped onto a deployment row");
});

test("the real tick drains an orphan: stop-and-withdraw through the sweep, then it is no longer a candidate", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const db = makeDb({ orphans: [{ id: "o1", nosanaDeploymentId: "dm_orphan" }] });
  const deps = await buildDeps({ db, reclaimVault: async () => ({ reclaimed: true }) });
  const first = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(first.vaultsReclaimed, 1);
  const second = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(second.vaultsReclaimed, 0);
  assert.equal(second.vaultsPending, 0);
});

test("an agent deployment the tick sees end hands its Nosana id to the orphan sweep (it has no vault stamp)", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const db = makeDb({ agents: [{ id: "a1", status: "running", nosanaJobIds: ["dm_agent"] }] });
  const reclaimedIds: string[] = [];
  const deps = await buildDeps({
    db,
    getDeploymentStatus: async () => snapshot("error"),
    reclaimVault: async (id) => {
      reclaimedIds.push(id);
      return { reclaimed: true };
    },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);

  assert.equal(db.agents[0]!.status, "failed");
  assert.equal(db.orphans.length, 1);
  assert.equal(db.orphans[0]!.nosanaDeploymentId, "dm_agent");
  assert.equal(db.orphans[0]!.sourceKind, "agent");
  assert.equal(db.orphans[0]!.sourceId, "a1");
  // ... and the sweep at the end of the same tick already reclaims it.
  assert.deepEqual(reclaimedIds, ["dm_agent"]);
  assert.equal(result.vaultsReclaimed, 1);
  assert.deepEqual(db.orphans[0]!.reclaimedAt, NOW);
});

test("an agent transition that is not terminal, or that lost its CAS, records no orphan", async () => {
  const db = makeDb({ agents: [{ id: "a1", status: "deploying", nosanaJobIds: ["dm_agent"] }] });
  const deps = await buildDeps({ db });
  const base = { kind: "agent" as const, id: "a1", orgId: "org_1", observedAt: NOW, nosanaDeploymentId: "dm_agent" };
  await deps.persistTransition({ ...base, fromStatus: "deploying", toStatus: "running" });
  await deps.persistTransition({ ...base, fromStatus: "deploying", toStatus: "failed" }); // row is `running` now: miss
  assert.equal(db.agents[0]!.status, "running");
  assert.equal(db.orphans.length, 0);
});

test("recordNosanaOrphan is idempotent on the Nosana id, skips mock ids, and reports a failed write instead of throwing", async () => {
  const { recordNosanaOrphan } = await import("../services/nosanaOrphans.js");
  const db = makeDb({});
  const args = { nosanaDeploymentId: "dm_x", sourceKind: "model" as const, sourceId: "dep_1", reason: "stopped_during_submit" };
  assert.equal(await recordNosanaOrphan(db.prisma, args), true);
  assert.equal(await recordNosanaOrphan(db.prisma, args), true);
  assert.equal(db.orphans.length, 1, "one record per Nosana deployment");
  const create = db.calls.find((c) => c.op === "nosanaOrphanDeployment.createMany")!;
  assert.equal(create.args.skipDuplicates, true, "no unique-violation to handle");

  assert.equal(await recordNosanaOrphan(db.prisma, { ...args, nosanaDeploymentId: "mock_deploy_1" }), true);
  assert.equal(db.orphans.length, 1, "a mock id never existed on Nosana");

  const broken = { nosanaOrphanDeployment: { createMany: async () => { throw new Error("db down"); } } };
  assert.equal(await recordNosanaOrphan(broken as never, args), false, "the caller can still refuse the request");
});

// ============================================
// Settlement order: the status claim first, the money second, together or not at all
// ============================================

const leaveRunning = (toStatus: string, over: Record<string, unknown> = {}) => ({
  kind: "model" as const,
  id: "m1",
  orgId: "org_1",
  fromStatus: "running",
  toStatus,
  observedAt: NOW,
  runGeneration: 0,
  nosanaDeploymentId: "dm_1",
  ...over,
});

test("a stale tick whose status CAS loses charges NOTHING (two overlapping ticks)", async () => {
  // Tick A already moved the row running -> degraded and settled up to its own
  // observation. Tick B still holds `running` and observed 400 s later. Before,
  // B settled first (the cursor CAS has no status condition), then lost the
  // status CAS - and the transaction committed 400 s of GPU time with no live
  // endpoint.
  for (const [current, to] of [["degraded", "degraded"], ["stopped", "stopped"], ["stopped", "failed"]] as const) {
    const db = makeDb({
      models: [{ id: "m1", status: current, billedThroughAt: secondsBefore(400) }],
      balances: { org_1: 1000n },
    });
    const deps = await buildDeps({ db });

    const out = await deps.persistTransition(leaveRunning(to));

    assert.equal(out.count, 0, `${current} <- ${to}`);
    assert.equal(db.balances.get("org_1"), 1000n, "not a cent");
    assert.equal(db.ledger.length, 0);
    assert.deepEqual(db.models[0]!.billedThroughAt, secondsBefore(400), "the cursor is the winner's");
  }
});

test("the status claim is written BEFORE the cursor: bill second, under the claim's lock", async () => {
  const db = makeDb({
    models: [{ id: "m1", status: "running", billedThroughAt: secondsBefore(100) }],
    balances: { org_1: 1000n },
  });
  const deps = await buildDeps({ db });
  await deps.persistTransition(leaveRunning("degraded"));
  const writes = db.calls.filter((c) => c.op === "deployment.updateMany").map((c) => Object.keys(c.args.data).sort().join(","));
  assert.deepEqual(writes, ["status,statusReason", "billedThroughAt"]);
});

test("a settle that loses its cursor under the claim rolls the status change back - never a silent success", async () => {
  // Before, cursor_lost was ignored and the edge committed with its window
  // unbilled (a recovery resets the cursor; a terminal row is never billed again).
  const db = makeDb({
    models: [{ id: "m1", status: "running", billedThroughAt: secondsBefore(100) }],
    balances: { org_1: 1000n },
  });
  const deps = await buildDeps({ db });
  const real = db.prisma.deployment.updateMany;
  (db.prisma.deployment as any).updateMany = async (args: any) =>
    "billedThroughAt" in args.where ? { count: 0 } : real(args);

  await assert.rejects(() => deps.persistTransition(leaveRunning("degraded")), /cursor/);

  assert.equal(db.models[0]!.status, "running", "the row is observed afresh next tick");
  assert.equal(db.ledger.length, 0);
});

test("a terminal edge releases the hold BEFORE the final window, so the hold pays for it (zero balance)", async () => {
  // Before: the settle ran against a zero balance (charged 0, forgave the
  // rest), and the whole hold was refunded afterwards in another transaction.
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  for (const observed of ["stopped", "error"] as const) {
    const db = makeDb({
      models: [{ id: "m1", status: "running", reservationCents: 90n, billedThroughAt: secondsBefore(100) }],
      balances: { org_1: 0n },
    });
    const deps = await buildDeps({ db, getDeploymentStatus: async () => snapshot(observed) });

    const result = await runDeploymentStatusTick({ now: NOW }, deps);

    assert.deepEqual(
      db.ledger.map((l) => [l.type, l.amountCents]),
      [
        ["deployment_reservation_release", 90n],
        ["gpu_usage", -2n],
      ],
      observed,
    );
    assert.equal(db.balances.get("org_1"), 88n, "the hold less the final window");
    assert.equal(result.reservationsReleased, 1, "released once, counted once");
    assert.equal(result.reservationReleasesFailed, 0);
    assert.deepEqual(db.models[0]!.reservationReleasedAt, NOW);

    // The next tick's sweep finds nothing left to release.
    const again = await runDeploymentStatusTick({ now: NOW }, deps);
    assert.equal(again.reservationsReleased, 0);
    assert.equal(db.balances.get("org_1"), 88n);
  }
});

test("a degrade edge does NOT release the hold: the run is not over", async () => {
  const db = makeDb({
    models: [{ id: "m1", status: "running", reservationCents: 90n, billedThroughAt: secondsBefore(100) }],
    balances: { org_1: 1000n },
  });
  const deps = await buildDeps({ db });
  const out = await deps.persistTransition(leaveRunning("degraded"));
  assert.equal(out.reservationReleased, false);
  assert.equal(db.models[0]!.reservationReleasedAt, null);
  assert.deepEqual(db.ledger.map((l) => l.type), ["gpu_usage"]);
});

test("a terminal edge whose release fails rolls the whole transition back: status, hold and charge move together", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const db = makeDb({
    models: [{ id: "m1", status: "running", reservationCents: 90n, billedThroughAt: secondsBefore(100) }],
    balances: { org_1: 0n },
  });
  const deps = await buildDeps({ db, getDeploymentStatus: async () => snapshot("error") });

  db.failures.creditUpdate = 1;
  const first = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(first.transitioned, 0);
  assert.equal(first.failed, 1);
  assert.equal(db.models[0]!.status, "running", "not terminal with its final window unpaid");
  assert.equal(db.models[0]!.reservationReleasedAt, null);
  assert.equal(db.ledger.length, 0);

  const second = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(second.transitioned, 1);
  assert.equal(db.models[0]!.status, "failed");
  assert.equal(db.balances.get("org_1"), 88n);
});

test("a terminal edge bills up to the recorded GPU stop time, not up to the tick that noticed", async () => {
  // A stop Nosana confirmed 60 s ago whose own transaction failed: the row is
  // still `running` and carries gpuStoppedAt.
  const db = makeDb({
    models: [{ id: "m1", status: "running", billedThroughAt: secondsBefore(100), gpuStoppedAt: secondsBefore(60) }],
    balances: { org_1: 1000n },
  });
  const deps = await buildDeps({ db });
  await deps.persistTransition(leaveRunning("stopped"));
  // 40 s x 250 uUSD = exactly 1 cent (100 s would have been 2).
  assert.deepEqual(db.ledger.map((l) => [l.type, l.amountCents]), [["gpu_usage", -1n]]);
  assert.deepEqual(db.models[0]!.billedThroughAt, secondsBefore(60));
});

// ============================================
// Replica reconciliation: `replicas` is what Nosana runs
// ============================================

const STALE_S = 6 * 60; // older than REPLICA_CHANGE_STALE_MS (5 min)
const claimOn = (to: number, ageSeconds: number, holdCents: bigint | null) => ({
  pendingReplicas: to,
  replicaChangeId: "chg_1",
  replicaChangeAt: secondsBefore(ageSeconds),
  replicaChangeHoldCents: holdCents,
});
const live = (replicas: number) => async () => snapshot("running", { endpoints: [EP], replicas });

test("a stale scale-up claim Nosana DID apply (the request died after the call) is committed: count, old-count window, hold kept", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const db = makeDb({
    models: [{
      id: "m1", status: "running", replicas: 1, billedThroughAt: secondsBefore(100),
      reservationCents: 270n, ...claimOn(3, STALE_S, 180n),
    }],
    nodes: [{ id: "n1", deploymentId: "m1", nodeUrl: EP.url }],
    balances: { org_1: 1000n },
  });
  const deps = await buildDeps({ db, getDeploymentStatus: live(3) });

  const result = await runDeploymentStatusTick({ now: NOW }, deps);

  const row = db.models[0]!;
  assert.equal(result.replicasReconciled, 1);
  assert.equal(row.replicas, 3, "billing now charges what Nosana runs");
  assert.equal(row.replicaChangeId, null);
  assert.equal(row.pendingReplicas, null);
  assert.equal(row.replicaChangeHoldCents, null);
  // 100 s at the OLD count x1 = 2.5 cents, closed completely (rounded up).
  assert.deepEqual(db.ledger.map((l) => [l.type, l.amountCents]), [["gpu_usage", -3n]]);
  assert.deepEqual(row.billedThroughAt, NOW);
  assert.equal(row.reservationCents, 270n, "the hold the claim took now backs the 3 replicas");
});

test("a stale scale-up claim Nosana did NOT apply is cleared and exactly its hold comes back", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const db = makeDb({
    models: [{
      id: "m1", status: "running", replicas: 1, billedThroughAt: secondsBefore(100),
      reservationCents: 90n + 173n, ...claimOn(3, STALE_S, 173n), // not the estimate: what was taken
    }],
    nodes: [{ id: "n1", deploymentId: "m1", nodeUrl: EP.url }],
    balances: { org_1: 1000n },
  });
  const deps = await buildDeps({ db, getDeploymentStatus: live(1) });

  const result = await runDeploymentStatusTick({ now: NOW }, deps);

  const row = db.models[0]!;
  assert.equal(result.replicasReconciled, 1);
  assert.equal(row.replicas, 1);
  assert.equal(row.replicaChangeId, null, "PATCH is possible again");
  assert.equal(row.reservationCents, 90n);
  assert.deepEqual(db.ledger.map((l) => [l.type, l.amountCents]), [["deployment_reservation_release", 173n]]);
  assert.deepEqual(row.billedThroughAt, secondsBefore(100), "the count did not change: the open window is the billing tick's");
});

test("a stale scale-DOWN claim Nosana applied is committed and the removed replicas' hold returned", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const db = makeDb({
    models: [{
      id: "m1", status: "running", replicas: 3, billedThroughAt: secondsBefore(100),
      reservationCents: 270n, ...claimOn(1, STALE_S, null),
    }],
    nodes: [{ id: "n1", deploymentId: "m1", nodeUrl: EP.url }],
    balances: { org_1: 1000n },
  });
  const deps = await buildDeps({ db, getDeploymentStatus: live(1) });

  await runDeploymentStatusTick({ now: NOW }, deps);

  const row = db.models[0]!;
  assert.equal(row.replicas, 1);
  assert.equal(row.reservationCents, 90n);
  // 100 s x 3 replicas = 7.5 cents at the old count -> 8, then 2 replicas' hold back.
  assert.deepEqual(db.ledger.map((l) => [l.type, l.amountCents]), [
    ["gpu_usage", -8n],
    ["deployment_reservation_release", 180n],
  ]);
});

test("a FRESH claim is left alone: its request is still talking to Nosana", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const db = makeDb({
    models: [{
      id: "m1", status: "running", replicas: 1, billedThroughAt: secondsBefore(100),
      reservationCents: 270n, ...claimOn(3, 30, 180n),
    }],
    nodes: [{ id: "n1", deploymentId: "m1", nodeUrl: EP.url }],
    balances: { org_1: 1000n },
  });
  // Nosana already runs 3; the request has not committed yet.
  const deps = await buildDeps({ db, getDeploymentStatus: live(3) });

  const result = await runDeploymentStatusTick({ now: NOW }, deps);

  assert.equal(result.replicasReconciled, 0);
  assert.equal(db.models[0]!.replicas, 1);
  assert.equal(db.models[0]!.replicaChangeId, "chg_1");
  assert.equal(db.ledger.length, 0);
});

test("a count that differs from Nosana with NO claim is corrected: the end state of a failed revert no longer bills the wrong count forever", async () => {
  // The W2-6 end state: the row says x10 while Nosana runs x1.
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const db = makeDb({
    models: [{ id: "m1", status: "running", replicas: 10, billedThroughAt: secondsBefore(40), reservationCents: 900n }],
    nodes: [{ id: "n1", deploymentId: "m1", nodeUrl: EP.url }],
    balances: { org_1: 1000n },
  });
  const deps = await buildDeps({ db, getDeploymentStatus: live(1) });

  const result = await runDeploymentStatusTick({ now: NOW }, deps);

  const row = db.models[0]!;
  assert.equal(result.replicasReconciled, 1);
  assert.equal(row.replicas, 1);
  assert.equal(row.reservationCents, 90n, "9 replicas' hold handed back");
  assert.deepEqual(row.billedThroughAt, NOW, "the x1 rate starts now");

  // And a count Nosana raised (a request that died after a reconciler cleared
  // its claim): the hold follows if the org has it.
  const up = makeDb({
    models: [{ id: "m1", status: "running", replicas: 1, billedThroughAt: NOW, reservationCents: 90n }],
    nodes: [{ id: "n1", deploymentId: "m1", nodeUrl: EP.url }],
    balances: { org_1: 1000n },
  });
  await runDeploymentStatusTick({ now: NOW }, await buildDeps({ db: up, getDeploymentStatus: live(3) }));
  assert.equal(up.models[0]!.replicas, 3);
  assert.equal(up.models[0]!.reservationCents, 270n);
  assert.equal(up.balances.get("org_1"), 820n);
});

test("reconciliation is a CAS on the row as loaded: a PATCH that claimed (or committed) since makes it a no-op", async () => {
  const db = makeDb({
    models: [{ id: "m1", status: "running", replicas: 1, billedThroughAt: secondsBefore(100), reservationCents: 90n }],
    balances: { org_1: 1000n },
  });
  const deps = await buildDeps({ db });
  const args = {
    id: "m1", orgId: "org_1", runGeneration: 0, replicas: 1, claim: null, observedReplicas: 3, observedAt: NOW,
  };

  // A PATCH claimed after the tick loaded the row.
  Object.assign(db.models[0]!, claimOn(3, 1, 180n));
  assert.deepEqual(await deps.reconcileReplicas!(args), { reconciled: false });

  // The PATCH committed: the count the tick loaded is gone.
  Object.assign(db.models[0]!, { replicas: 3, replicaChangeId: null, pendingReplicas: null });
  assert.deepEqual(await deps.reconcileReplicas!(args), { reconciled: false });

  // A restarted run.
  Object.assign(db.models[0]!, { replicas: 1, runGeneration: 1 });
  assert.deepEqual(await deps.reconcileReplicas!(args), { reconciled: false });

  // A stale claim the request resolved itself in the meantime.
  Object.assign(db.models[0]!, { runGeneration: 0 });
  const stale = { id: "chg_old", to: 3, claimedAt: secondsBefore(STALE_S), holdCents: 180n };
  assert.deepEqual(await deps.reconcileReplicas!({ ...args, claim: stale }), { reconciled: false });

  assert.equal(db.ledger.length, 0, "none of them moved money");
  assert.equal(db.balances.get("org_1"), 1000n);
});

test("a degraded row's count is reconciled without billing: it has no open window", async () => {
  const db = makeDb({
    models: [{ id: "m1", status: "degraded", replicas: 3, billedThroughAt: secondsBefore(3600), reservationCents: 270n }],
    balances: { org_1: 1000n },
  });
  const deps = await buildDeps({ db });
  await deps.reconcileReplicas!({
    id: "m1", orgId: "org_1", runGeneration: 0, replicas: 3, claim: null, observedReplicas: 1, observedAt: NOW,
  });
  assert.equal(db.models[0]!.replicas, 1);
  assert.deepEqual(db.ledger.map((l) => l.type), ["deployment_reservation_release"]);
});

test("replicaHoldReturnCents: the hold follows the count Nosana runs", async () => {
  setupEnv();
  const { replicaHoldReturnCents } = await import("../services/deploymentCreditGate.js");
  const price = () => 0.00025; // 90 cents per replica-hour
  const cents = (from: number, to: number | null, actual: number, claimHoldCents: bigint | null = null) =>
    replicaHoldReturnCents({ gpuTier: "4090", from, to, actual, claimHoldCents, pricePerSecondUsd: price });
  assert.equal(cents(1, 3, 3, 180n), 0n, "scale-up applied: keep");
  assert.equal(cents(1, 3, 1, 173n), 173n, "scale-up not applied: exactly the claim's cents");
  assert.equal(cents(1, 3, 2, 180n), 90n, "half applied");
  assert.equal(cents(3, 1, 1), 180n, "scale-down applied");
  assert.equal(cents(3, 1, 3), 0n, "scale-down not applied");
  assert.equal(cents(10, null, 1), 810n, "drift down, no claim");
  assert.equal(cents(1, null, 4), 0n, "drift up: nothing to return");
  assert.equal(cents(2, 4, 1, 180n), 270n, "below both: the claim's cents and one more replica");
});
