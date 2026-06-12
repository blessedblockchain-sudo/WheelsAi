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
// composition root for the deployment-status BullMQ worker (plan D8).
//
// Covers:
//   - loadDeployments: AgentDeployment + Deployment in non-terminal
//     states with non-empty nosanaJobIds, tagged with their kind
//   - getJobState: strict NosanaClient seam + the env-gated mock path
//     (ALLOW_NOSANA_MOCK + mock_job_* / mock_deploy_* → running)
//   - persistTransition: CAS updateMany on {id, status:fromStatus};
//     stoppedAt recorded on terminal transitions; lastError recorded
//     on agent failures; model rows never get lastError (no column)

import type { NosanaJob } from "../services/nosana.js";

const NOW = new Date("2026-06-12T12:00:00Z");

function job(status: NosanaJob["status"]): NosanaJob {
  return { id: "job_1", market: "M", status };
}

function makePrismaStub(opts: {
  agentRows?: Array<{ id: string; status: string; nosanaJobIds: string[] }>;
  modelRows?: Array<{ id: string; status: string; nosanaJobIds: string[] }>;
}) {
  const calls: Array<{ op: string; args: any }> = [];
  return {
    calls,
    prisma: {
      agentDeployment: {
        findMany: async (args: any) => {
          calls.push({ op: "agentDeployment.findMany", args });
          return opts.agentRows ?? [];
        },
        updateMany: async (args: any) => {
          calls.push({ op: "agentDeployment.updateMany", args });
          return { count: 1 };
        },
      },
      deployment: {
        findMany: async (args: any) => {
          calls.push({ op: "deployment.findMany", args });
          return opts.modelRows ?? [];
        },
        updateMany: async (args: any) => {
          calls.push({ op: "deployment.updateMany", args });
          return { count: 1 };
        },
      },
    },
  };
}

async function buildDeps(opts: {
  stub: ReturnType<typeof makePrismaStub>;
  getJobStatus?: (jobId: string) => Promise<NosanaJob>;
  allowMock?: boolean;
  polled?: string[];
}) {
  setupEnv();
  const { buildDeploymentStatusTickDeps } = await import(
    "../services/buildDeploymentStatusTickDeps.js"
  );
  return buildDeploymentStatusTickDeps({
    prisma: opts.stub.prisma as never,
    getJobStatus:
      opts.getJobStatus ??
      (async (jobId) => {
        opts.polled?.push(jobId);
        return job("running");
      }),
    allowMock: opts.allowMock ?? false,
  });
}

// ============================================
// loadDeployments — both tables, non-terminal, job ids present
// ============================================

test("loadDeployments merges agent + model rows tagged with their kind", async () => {
  const stub = makePrismaStub({
    agentRows: [{ id: "a1", status: "deploying", nosanaJobIds: ["j1"] }],
    modelRows: [{ id: "m1", status: "provisioning", nosanaJobIds: ["j2"] }],
  });
  const deps = await buildDeps({ stub });
  const rows = await deps.loadDeployments();
  assert.deepEqual(rows, [
    { kind: "agent", id: "a1", status: "deploying", nosanaJobIds: ["j1"] },
    { kind: "model", id: "m1", status: "provisioning", nosanaJobIds: ["j2"] },
  ]);
});

test("loadDeployments filters to non-terminal statuses and non-empty job ids (per model's vocabulary)", async () => {
  const stub = makePrismaStub({});
  const deps = await buildDeps({ stub });
  await deps.loadDeployments();

  const agentFind = stub.calls.find((c) => c.op === "agentDeployment.findMany")!;
  assert.deepEqual(agentFind.args.where.status.in, [
    "pending",
    "building",
    "deploying",
    "running",
  ]);
  assert.deepEqual(agentFind.args.where.nosanaJobIds, { isEmpty: false });
  assert.deepEqual(agentFind.args.select, {
    id: true,
    status: true,
    nosanaJobIds: true,
  });

  const modelFind = stub.calls.find((c) => c.op === "deployment.findMany")!;
  assert.deepEqual(modelFind.args.where.status.in, [
    "pending",
    "provisioning",
    "running",
    "degraded",
  ]);
  assert.deepEqual(modelFind.args.where.nosanaJobIds, { isEmpty: false });
});

test("loadDeployments polls 'running' rows too — job end must be observable", async () => {
  // The setTimeout lie's other half: once flipped to running, nothing
  // ever looked again. The loader must include running rows so
  // completed/failed jobs get observed into stopped/failed.
  const stub = makePrismaStub({});
  const deps = await buildDeps({ stub });
  await deps.loadDeployments();
  const agentFind = stub.calls.find((c) => c.op === "agentDeployment.findMany")!;
  assert.ok(agentFind.args.where.status.in.includes("running"));
  const modelFind = stub.calls.find((c) => c.op === "deployment.findMany")!;
  assert.ok(modelFind.args.where.status.in.includes("running"));
});

// ============================================
// getJobState — strict seam + env-gated mock path
// ============================================

test("getJobState passes real job ids to the strict Nosana read", async () => {
  const polled: string[] = [];
  const deps = await buildDeps({
    stub: makePrismaStub({}),
    polled,
    allowMock: false,
  });
  const state = await deps.getJobState("RealJobPubkey111");
  assert.equal(state, "running");
  assert.deepEqual(polled, ["RealJobPubkey111"]);
});

test("getJobState bubbles strict-read throws (RPC outage → row untouched upstream)", async () => {
  const deps = await buildDeps({
    stub: makePrismaStub({}),
    getJobStatus: async () => {
      throw new Error("429 from RPC");
    },
  });
  await assert.rejects(deps.getJobState("RealJobPubkey111"), /429 from RPC/);
});

test("mock ids are treated as running ONLY when allowMock is set", async () => {
  // ALLOW_NOSANA_MOCK is boot-rejected in production, so this branch is
  // dev-only by construction.
  const polled: string[] = [];
  const deps = await buildDeps({
    stub: makePrismaStub({}),
    polled,
    allowMock: true,
  });
  assert.equal(await deps.getJobState("mock_job_abc"), "running");
  assert.equal(await deps.getJobState("mock_deploy_xyz"), "running");
  assert.deepEqual(polled, []); // never reached the chain
});

test("without allowMock, mock ids go to the strict read (which throws on them)", async () => {
  const deps = await buildDeps({
    stub: makePrismaStub({}),
    allowMock: false,
    getJobStatus: async (jobId) => {
      throw new Error(`Mock Nosana id cannot be queried on-chain: ${jobId}`);
    },
  });
  await assert.rejects(deps.getJobState("mock_job_abc"), /cannot be queried/);
});

// ============================================
// persistTransition — CAS, stoppedAt, lastError
// ============================================

test("persistTransition CASes on {id, status: fromStatus} for agent rows", async () => {
  const stub = makePrismaStub({});
  const deps = await buildDeps({ stub });
  await deps.persistTransition({
    kind: "agent",
    id: "a1",
    fromStatus: "deploying",
    toStatus: "running",
    observedAt: NOW,
  });
  const update = stub.calls.find((c) => c.op === "agentDeployment.updateMany")!;
  assert.deepEqual(update.args.where, { id: "a1", status: "deploying" });
  assert.deepEqual(update.args.data, { status: "running" }); // no stoppedAt on a live transition
});

test("persistTransition records stoppedAt on terminal transitions (both kinds)", async () => {
  const stub = makePrismaStub({});
  const deps = await buildDeps({ stub });

  await deps.persistTransition({
    kind: "model",
    id: "m1",
    fromStatus: "running",
    toStatus: "stopped",
    observedAt: NOW,
  });
  const modelUpdate = stub.calls.find((c) => c.op === "deployment.updateMany")!;
  assert.deepEqual(modelUpdate.args.data, { status: "stopped", stoppedAt: NOW });

  await deps.persistTransition({
    kind: "agent",
    id: "a1",
    fromStatus: "running",
    toStatus: "stopped",
    observedAt: NOW,
  });
  const agentUpdate = stub.calls.find((c) => c.op === "agentDeployment.updateMany")!;
  assert.deepEqual(agentUpdate.args.data, { status: "stopped", stoppedAt: NOW });
});

test("persistTransition records lastError on agent failure; model rows have no lastError column", async () => {
  const stub = makePrismaStub({});
  const deps = await buildDeps({ stub });

  await deps.persistTransition({
    kind: "agent",
    id: "a1",
    fromStatus: "running",
    toStatus: "failed",
    observedAt: NOW,
  });
  const agentUpdate = stub.calls.find((c) => c.op === "agentDeployment.updateMany")!;
  assert.equal(agentUpdate.args.data.status, "failed");
  assert.deepEqual(agentUpdate.args.data.stoppedAt, NOW);
  assert.equal(typeof agentUpdate.args.data.lastError, "string");

  await deps.persistTransition({
    kind: "model",
    id: "m1",
    fromStatus: "running",
    toStatus: "failed",
    observedAt: NOW,
  });
  const modelUpdate = stub.calls.find((c) => c.op === "deployment.updateMany")!;
  assert.equal("lastError" in modelUpdate.args.data, false);
});

// ============================================
// End-to-end through the tick: restart-safe observation
// ============================================

test("composition: deploying agent row + running job → CAS write to running through the real tick", async () => {
  const { runDeploymentStatusTick } = await import(
    "../services/runDeploymentStatusTick.js"
  );
  const stub = makePrismaStub({
    agentRows: [{ id: "a1", status: "deploying", nosanaJobIds: ["JobPubkey1"] }],
  });
  const deps = await buildDeps({
    stub,
    getJobStatus: async () => job("running"),
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(result.transitioned, 1);
  const update = stub.calls.find((c) => c.op === "agentDeployment.updateMany")!;
  assert.deepEqual(update.args.where, { id: "a1", status: "deploying" });
  assert.deepEqual(update.args.data, { status: "running" });
});

test("composition: RPC outage touches nothing — no updateMany issued", async () => {
  const { runDeploymentStatusTick } = await import(
    "../services/runDeploymentStatusTick.js"
  );
  const stub = makePrismaStub({
    agentRows: [{ id: "a1", status: "deploying", nosanaJobIds: ["JobPubkey1"] }],
    modelRows: [{ id: "m1", status: "running", nosanaJobIds: ["JobPubkey2"] }],
  });
  const deps = await buildDeps({
    stub,
    getJobStatus: async () => {
      throw new Error("fetch failed");
    },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(result.failed, 2);
  assert.equal(result.transitioned, 0);
  assert.equal(
    stub.calls.filter((c) => c.op.endsWith("updateMany")).length,
    0,
  );
});
