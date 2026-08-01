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

// Drives apps/api/src/services/runDeploymentStatusTick.ts — the pure
// orchestrator behind the deployment-status BullMQ worker (plan D8).
//
// Replaces the setTimeout(8000) "Simulate deployment completion" lie:
// transitions are OBSERVED from Nosana job state, persisted via
// compare-and-set, and the tick holds no in-memory state — restart
// safety falls out of it being a pure function of (DB rows, chain).

import type {
  DeploymentKind,
  DeploymentStatusRow,
  DeploymentStatusTransition,
  NodeHealthObservation,
  NosanaJobPollState,
} from "../services/runDeploymentStatusTick.js";

const NOW = new Date("2026-06-12T12:00:00Z");

function row(overrides: Partial<DeploymentStatusRow> = {}): DeploymentStatusRow {
  return {
    kind: "agent",
    id: "dep_1",
    status: "deploying",
    nosanaJobIds: ["job_1"],
    ...overrides,
  };
}

function makeDeps(opts: {
  rows: DeploymentStatusRow[];
  jobStates?: Record<string, NosanaJobPollState | Error>;
  persistCount?: number;
  /** Probe result (or throw) per nodeUrl; default healthy/40ms. */
  nodeProbes?: Record<string, { healthy: boolean; latencyMs: number } | Error>;
  persistNodeHealthError?: Error;
}) {
  const transitions: DeploymentStatusTransition[] = [];
  const polledJobs: string[] = [];
  const probedUrls: string[] = [];
  const nodeHealthWrites: NodeHealthObservation[] = [];
  return {
    transitions,
    polledJobs,
    probedUrls,
    nodeHealthWrites,
    deps: {
      loadDeployments: async () => opts.rows,
      getJobState: async (jobId: string) => {
        polledJobs.push(jobId);
        const state = opts.jobStates?.[jobId];
        if (state instanceof Error) throw state;
        return state ?? "running";
      },
      persistTransition: async (t: DeploymentStatusTransition) => {
        transitions.push(t);
        return { count: opts.persistCount ?? 1 };
      },
      checkNodeHealth: async (nodeUrl: string) => {
        probedUrls.push(nodeUrl);
        const probe = opts.nodeProbes?.[nodeUrl];
        if (probe instanceof Error) throw probe;
        return probe ?? { healthy: true, latencyMs: 40 };
      },
      persistNodeHealth: async (obs: NodeHealthObservation) => {
        if (opts.persistNodeHealthError) throw opts.persistNodeHealthError;
        nodeHealthWrites.push(obs);
      },
    },
  };
}

// ============================================
// Table-driven job-state → deployment-status mapping
// ============================================

test("mapJobStatesToDeploymentStatus: table", async () => {
  setupEnv();
  const { mapJobStatesToDeploymentStatus } = await import(
    "../services/runDeploymentStatusTick.js"
  );

  const cases: Array<{
    kind: DeploymentKind;
    states: NosanaJobPollState[];
    expected: string | null;
    why: string;
  }> = [
    // No observation possible.
    { kind: "agent", states: [], expected: null, why: "no jobs → nothing observed" },
    { kind: "model", states: ["queued"], expected: null, why: "queued → keep submit-path status" },
    { kind: "agent", states: ["queued", "queued"], expected: null, why: "all queued" },
    // Running.
    { kind: "agent", states: ["running"], expected: "running", why: "single running" },
    { kind: "model", states: ["running", "queued"], expected: "running", why: "any running (others queued)" },
    { kind: "agent", states: ["running", "completed"], expected: "running", why: "any running (others done)" },
    // Failures.
    { kind: "agent", states: ["failed"], expected: "failed", why: "all failed" },
    { kind: "model", states: ["failed", "failed"], expected: "failed", why: "all failed (model)" },
    // Partial failure with live capacity: model has 'degraded'; the
    // agent vocabulary doesn't, so agents stay running.
    { kind: "model", states: ["running", "failed"], expected: "degraded", why: "model partial failure" },
    { kind: "agent", states: ["running", "failed"], expected: "running", why: "agent has no degraded state" },
    // All ended.
    { kind: "agent", states: ["completed"], expected: "stopped", why: "job completed cleanly" },
    { kind: "model", states: ["completed", "completed"], expected: "stopped", why: "all completed" },
    { kind: "agent", states: ["completed", "failed"], expected: "failed", why: "ended with failures, none live" },
    { kind: "model", states: ["completed", "failed"], expected: "failed", why: "ended with failures (model)" },
    // Mixed queued+completed: not a definitive observation.
    { kind: "agent", states: ["queued", "completed"], expected: null, why: "replica still queued" },
  ];

  for (const c of cases) {
    assert.equal(
      mapJobStatesToDeploymentStatus(c.kind, c.states),
      c.expected,
      `${c.kind} [${c.states.join(",")}] — ${c.why}`,
    );
  }
});

// ============================================
// Only-on-change persistence
// ============================================

test("tick persists an observed transition with CAS fields", async () => {
  const { runDeploymentStatusTick } = await import(
    "../services/runDeploymentStatusTick.js"
  );
  const { deps, transitions } = makeDeps({
    rows: [row({ id: "dep_1", status: "deploying" })],
    jobStates: { job_1: "running" },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(result.transitioned, 1);
  assert.deepEqual(transitions, [
    {
      kind: "agent",
      id: "dep_1",
      fromStatus: "deploying",
      toStatus: "running",
      observedAt: NOW,
    },
  ]);
});

test("tick does NOT write when the observed status equals the current one", async () => {
  const { runDeploymentStatusTick } = await import(
    "../services/runDeploymentStatusTick.js"
  );
  const { deps, transitions } = makeDeps({
    rows: [row({ status: "running" })],
    jobStates: { job_1: "running" },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(transitions.length, 0);
  assert.equal(result.unchanged, 1);
  assert.equal(result.transitioned, 0);
});

test("tick does NOT write when the mapping yields null (queued in flight)", async () => {
  const { runDeploymentStatusTick } = await import(
    "../services/runDeploymentStatusTick.js"
  );
  const { deps, transitions } = makeDeps({
    rows: [row({ status: "deploying" })],
    jobStates: { job_1: "queued" },
  });
  await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(transitions.length, 0);
});

test("tick counts a CAS miss (count=0) as unchanged — concurrent writer won", async () => {
  const { runDeploymentStatusTick } = await import(
    "../services/runDeploymentStatusTick.js"
  );
  const { deps } = makeDeps({
    rows: [row({ status: "deploying" })],
    jobStates: { job_1: "running" },
    persistCount: 0,
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(result.transitioned, 0);
  assert.equal(result.unchanged, 1);
});

// ============================================
// Observed lifecycle end: running → stopped/failed
// ============================================

test("a running deployment whose job completes is observed into stopped", async () => {
  // The other half of the setTimeout lie: the fake flip to running was
  // never followed by any real observation again — jobs that ended
  // stayed 'running' forever (eligibility kept passing).
  const { runDeploymentStatusTick } = await import(
    "../services/runDeploymentStatusTick.js"
  );
  const { deps, transitions } = makeDeps({
    rows: [row({ status: "running" })],
    jobStates: { job_1: "completed" },
  });
  await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(transitions[0]!.toStatus, "stopped");
});

test("a running deployment whose job fails is observed into failed", async () => {
  const { runDeploymentStatusTick } = await import(
    "../services/runDeploymentStatusTick.js"
  );
  const { deps, transitions } = makeDeps({
    rows: [row({ status: "running" })],
    jobStates: { job_1: "failed" },
  });
  await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(transitions[0]!.toStatus, "failed");
});

// ============================================
// Per-row isolation: SDK/RPC errors leave rows untouched
// ============================================

test("an RPC throw for one row leaves it untouched and does not stop the others", async () => {
  const { runDeploymentStatusTick } = await import(
    "../services/runDeploymentStatusTick.js"
  );
  const { deps, transitions } = makeDeps({
    rows: [
      row({ id: "dep_rpc_down", status: "deploying", nosanaJobIds: ["job_down"] }),
      row({ id: "dep_ok", status: "deploying", nosanaJobIds: ["job_ok"] }),
    ],
    jobStates: {
      job_down: new Error("RPC unreachable"),
      job_ok: "running",
    },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(result.scanned, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.transitioned, 1);
  // Only the reachable row transitioned; the blinded row was untouched.
  assert.deepEqual(
    transitions.map((t) => t.id),
    ["dep_ok"],
  );
});

test("a partial job-poll failure on a multi-replica row fails the WHOLE row (no write from partial data)", async () => {
  const { runDeploymentStatusTick } = await import(
    "../services/runDeploymentStatusTick.js"
  );
  const { deps, transitions } = makeDeps({
    rows: [
      row({ nosanaJobIds: ["job_a", "job_b"] }),
    ],
    jobStates: {
      job_a: "running",
      job_b: new Error("timeout"),
    },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(result.failed, 1);
  assert.equal(transitions.length, 0);
});

test("loadDeployments errors bubble so BullMQ records the tick failure", async () => {
  const { runDeploymentStatusTick } = await import(
    "../services/runDeploymentStatusTick.js"
  );
  await assert.rejects(
    runDeploymentStatusTick(
      { now: NOW },
      {
        loadDeployments: async () => {
          throw new Error("DB unreachable");
        },
        getJobState: async () => "running" as const,
        persistTransition: async () => ({ count: 1 }),
        checkNodeHealth: async () => ({ healthy: true, latencyMs: 1 }),
        persistNodeHealth: async () => {},
      },
    ),
    /DB unreachable/,
  );
});

// ============================================
// Node health probes (plan A2) — the only writer that can mark a
// DeploymentNode healthy. /v1 selects healthy nodes; before this
// existed every inference request 503'd forever.
// ============================================

function modelRowWithNode(
  overrides: Partial<DeploymentStatusRow> = {},
): DeploymentStatusRow {
  return row({
    kind: "model",
    id: "m1",
    status: "running",
    nosanaJobIds: ["job_1"],
    nodes: [{ id: "n1", nodeUrl: "https://node1.node.nos.ci", healthStatus: "unknown" }],
    ...overrides,
  });
}

test("an ok probe flips a node unknown → healthy with latency and checkedAt", async () => {
  const { runDeploymentStatusTick } = await import(
    "../services/runDeploymentStatusTick.js"
  );
  const { deps, nodeHealthWrites } = makeDeps({
    rows: [modelRowWithNode()],
    jobStates: { job_1: "running" },
    nodeProbes: { "https://node1.node.nos.ci": { healthy: true, latencyMs: 42 } },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.deepEqual(nodeHealthWrites, [
    {
      nodeId: "n1",
      healthStatus: "healthy",
      latencyMs: 42,
      checkedAt: NOW,
    },
  ]);
  assert.equal(result.nodesProbed, 1);
  assert.equal(result.nodesUnhealthy, 0);
});

test("a failed probe marks the node unhealthy", async () => {
  const { runDeploymentStatusTick } = await import(
    "../services/runDeploymentStatusTick.js"
  );
  const { deps, nodeHealthWrites } = makeDeps({
    rows: [modelRowWithNode()],
    jobStates: { job_1: "running" },
    nodeProbes: { "https://node1.node.nos.ci": { healthy: false, latencyMs: 5001 } },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(nodeHealthWrites[0]!.healthStatus, "unhealthy");
  assert.equal(result.nodesUnhealthy, 1);
});

test("health is persisted even when unchanged — lastHealthCheck is a freshness signal", async () => {
  const { runDeploymentStatusTick } = await import(
    "../services/runDeploymentStatusTick.js"
  );
  const { deps, nodeHealthWrites } = makeDeps({
    rows: [
      modelRowWithNode({
        nodes: [
          { id: "n1", nodeUrl: "https://node1.node.nos.ci", healthStatus: "healthy" },
        ],
      }),
    ],
    jobStates: { job_1: "running" },
  });
  await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(nodeHealthWrites.length, 1);
});

test("nodes with an empty nodeUrl are not probed — mock/fallback rows stay unknown", async () => {
  const { runDeploymentStatusTick } = await import(
    "../services/runDeploymentStatusTick.js"
  );
  const { deps, probedUrls, nodeHealthWrites } = makeDeps({
    rows: [
      modelRowWithNode({
        nodes: [{ id: "n1", nodeUrl: "", healthStatus: "unknown" }],
      }),
    ],
    jobStates: { job_1: "running" },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.deepEqual(probedUrls, []);
  assert.deepEqual(nodeHealthWrites, []);
  assert.equal(result.nodesProbed, 0);
});

test("agent rows carry no nodes and trigger no probes", async () => {
  const { runDeploymentStatusTick } = await import(
    "../services/runDeploymentStatusTick.js"
  );
  const { deps, probedUrls } = makeDeps({
    rows: [row({ kind: "agent", status: "running" })],
    jobStates: { job_1: "running" },
  });
  await runDeploymentStatusTick({ now: NOW }, deps);
  assert.deepEqual(probedUrls, []);
});

test("a probe-persist throw is isolated: the row's status observation still lands and the tick completes", async () => {
  const { runDeploymentStatusTick } = await import(
    "../services/runDeploymentStatusTick.js"
  );
  const { deps, transitions } = makeDeps({
    rows: [
      modelRowWithNode({ status: "provisioning" }),
      modelRowWithNode({
        id: "m2",
        status: "provisioning",
        nodes: [{ id: "n2", nodeUrl: "https://node2.node.nos.ci", healthStatus: "unknown" }],
      }),
    ],
    jobStates: { job_1: "running" },
    persistNodeHealthError: new Error("DB write failed"),
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  // Both rows still transitioned provisioning → running.
  assert.deepEqual(
    transitions.map((t) => t.toStatus),
    ["running", "running"],
  );
  assert.equal(result.nodeProbesFailed, 2);
  assert.equal(result.nodesProbed, 0);
});

test("an RPC outage on the job read does not blind the health probe", async () => {
  // Chain reads and node HTTP endpoints fail independently — a blinded
  // row still gets its nodes probed.
  const { runDeploymentStatusTick } = await import(
    "../services/runDeploymentStatusTick.js"
  );
  const { deps, nodeHealthWrites } = makeDeps({
    rows: [modelRowWithNode()],
    jobStates: { job_1: new Error("RPC unreachable") },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(result.failed, 1);
  assert.equal(result.nodesProbed, 1);
  assert.equal(nodeHealthWrites[0]!.healthStatus, "healthy");
});

// ============================================
// No in-memory state — restart safety
// ============================================

test("two identical ticks observe identically (pure function of rows + chain, no module state)", async () => {
  const { runDeploymentStatusTick } = await import(
    "../services/runDeploymentStatusTick.js"
  );
  const run = async () => {
    const { deps, transitions } = makeDeps({
      rows: [row({ status: "deploying" })],
      jobStates: { job_1: "running" },
    });
    const result = await runDeploymentStatusTick({ now: NOW }, deps);
    return { result, transitions };
  };
  const first = await run();
  // "Restart": a fresh tick over the same persisted state — nothing
  // carried over from the first run.
  const second = await run();
  assert.deepEqual(first.result, second.result);
  assert.deepEqual(first.transitions, second.transitions);
});
