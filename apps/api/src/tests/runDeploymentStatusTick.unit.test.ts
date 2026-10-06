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
// orchestrator behind the deployment-status BullMQ worker (plan D8, reworked
// for the Nosana Deployment Manager).
//
// `nosanaJobIds[0]` is a Deployment-Manager id. The tick observes it with the
// Deployment object (status + the real endpoints), persists transitions via
// compare-and-set, reconciles DeploymentNodes with the observed endpoints and
// holds no in-memory state — restart safety falls out of it being a pure
// function of (DB rows, Nosana).

import type {
  DeploymentKind,
  DeploymentNodeRow,
  DeploymentObservation,
  DeploymentStatusRow,
  DeploymentStatusTransition,
  NodeHealthObservation,
  ObservedDeploymentState,
  ObservedEndpoint,
  VaultReclaimCandidate,
} from "../services/runDeploymentStatusTick.js";

const NOW = new Date("2026-06-12T12:00:00Z");

function row(overrides: Partial<DeploymentStatusRow> = {}): DeploymentStatusRow {
  return {
    kind: "agent",
    id: "dep_1",
    orgId: "org_1",
    status: "deploying",
    nosanaJobIds: ["job_1"],
    ...overrides,
  };
}

const EP1: ObservedEndpoint = {
  url: "https://abc.node.k8s.prd.nos.ci",
  port: 8000,
  opId: "vllm-inference",
};

function observation(
  state: ObservedDeploymentState,
  endpoints: ObservedEndpoint[] = state === "running" ? [EP1] : [],
  extra: Partial<DeploymentObservation> = {},
): DeploymentObservation {
  return { state, endpoints, ...extra };
}

function makeDeps(opts: {
  rows: DeploymentStatusRow[];
  observations?: Record<string, DeploymentObservation | Error>;
  persistCount?: number;
  /** Probe result (or throw) per nodeUrl; default healthy/40ms. */
  nodeProbes?: Record<string, { healthy: boolean; latencyMs: number } | Error>;
  persistNodeHealthError?: Error;
  emitError?: Error;
  releaseError?: Error;
  syncError?: Error;
  withSync?: boolean;
  candidates?: VaultReclaimCandidate[];
  reclaimResults?: Record<string, { reclaimed: boolean } | Error>;
  candidateLoadError?: Error;
  unreleased?: Array<{
    kind: DeploymentKind;
    id: string;
    orgId: string;
    status: string;
    reservationCents: bigint;
  }>;
  unreleasedLoadError?: Error;
  /** releaseReservation throws for these ids (and only these, when set). */
  releaseErrorIds?: string[];
}) {
  const transitions: DeploymentStatusTransition[] = [];
  const observed: string[] = [];
  const probed: Array<{ url: string; engine?: string }> = [];
  const nodeHealthWrites: NodeHealthObservation[] = [];
  const emitted: DeploymentStatusTransition[] = [];
  const released: Array<{ id: string; reason: string; reservationCents: bigint }> = [];
  const synced: Array<{ deploymentId: string; endpoints: ObservedEndpoint[] }> = [];
  const reclaimed: string[] = [];

  const withSync = opts.withSync ?? true;
  const deps = {
    loadDeployments: async () => opts.rows,
    observeDeployment: async (id: string) => {
      observed.push(id);
      const o = opts.observations?.[id];
      if (o instanceof Error) throw o;
      return o ?? observation("running");
    },
    persistTransition: async (t: DeploymentStatusTransition) => {
      transitions.push(t);
      return { count: opts.persistCount ?? 1 };
    },
    ...(withSync
      ? {
          syncNodes: async (args: { deploymentId: string; endpoints: ObservedEndpoint[] }) => {
            synced.push(args);
            if (opts.syncError) throw opts.syncError;
            return args.endpoints.map(
              (e, i): DeploymentNodeRow => ({
                id: `node_${i}`,
                nodeUrl: e.url,
                healthStatus: "unknown",
              }),
            );
          },
        }
      : {}),
    checkNodeHealth: async (nodeUrl: string, engine?: string) => {
      probed.push({ url: nodeUrl, engine });
      const probe = opts.nodeProbes?.[nodeUrl];
      if (probe instanceof Error) throw probe;
      return probe ?? { healthy: true, latencyMs: 40 };
    },
    persistNodeHealth: async (obs: NodeHealthObservation) => {
      if (opts.persistNodeHealthError) throw opts.persistNodeHealthError;
      nodeHealthWrites.push(obs);
    },
    emitTransition: async (t: DeploymentStatusTransition) => {
      if (opts.emitError) throw opts.emitError;
      emitted.push(t);
    },
    releaseReservation: async (args: {
      kind: DeploymentKind;
      id: string;
      orgId: string;
      reservationCents: bigint;
      reason: string;
    }) => {
      if (opts.releaseError) throw opts.releaseError;
      if (opts.releaseErrorIds?.includes(args.id)) throw new Error("db down");
      released.push({ id: args.id, reason: args.reason, reservationCents: args.reservationCents });
      return { released: true };
    },
    loadUnreleasedReservations: async () => {
      if (opts.unreleasedLoadError) throw opts.unreleasedLoadError;
      return opts.unreleased ?? [];
    },
    loadVaultReclaimCandidates: async () => {
      if (opts.candidateLoadError) throw opts.candidateLoadError;
      return opts.candidates ?? [];
    },
    reclaimVault: async (c: VaultReclaimCandidate) => {
      reclaimed.push(c.nosanaDeploymentId);
      const r = opts.reclaimResults?.[c.nosanaDeploymentId];
      if (r instanceof Error) throw r;
      return r ?? { reclaimed: true };
    },
  };
  return { deps, transitions, observed, probed, nodeHealthWrites, emitted, released, synced, reclaimed };
}

// ============================================
// Table-driven observation → deployment-status mapping
// ============================================

test("mapObservationToStatus: table", async () => {
  setupEnv();
  const { mapObservationToStatus } = await import("../services/runDeploymentStatusTick.js");

  const cases: Array<{
    kind: DeploymentKind;
    current: string;
    obs: DeploymentObservation;
    next: string | null;
    reason?: string;
    why: string;
  }> = [
    // running needs a REAL endpoint
    { kind: "model", current: "provisioning", obs: observation("running"), next: "running", why: "RUNNING + endpoint" },
    { kind: "agent", current: "deploying", obs: observation("running"), next: "running", why: "agent RUNNING + endpoint" },
    { kind: "model", current: "provisioning", obs: observation("running", []), next: null, why: "RUNNING without a URL is still provisioning" },
    { kind: "agent", current: "deploying", obs: observation("running", []), next: null, why: "agent: no URL yet" },
    { kind: "model", current: "running", obs: observation("running", []), next: "degraded", reason: "no_live_endpoint", why: "a running model that lost every endpoint degrades" },
    { kind: "agent", current: "running", obs: observation("running", []), next: null, why: "agent vocabulary has no degraded" },
    { kind: "model", current: "degraded", obs: observation("running"), next: "running", why: "recovers when an endpoint returns" },
    { kind: "model", current: "provisioning", obs: observation("running", [], { mock: true }), next: "running", why: "dev mock may run without an endpoint" },
    // still coming up / going down: no observation
    { kind: "model", current: "provisioning", obs: observation("draft"), next: null, why: "draft" },
    { kind: "model", current: "provisioning", obs: observation("starting"), next: null, why: "starting" },
    { kind: "model", current: "running", obs: observation("stopping"), next: null, why: "stopping: the stopper finishes the job" },
    // terminal
    { kind: "model", current: "running", obs: observation("stopped"), next: "stopped", reason: "nosana_stopped", why: "stopped" },
    { kind: "agent", current: "running", obs: observation("archived"), next: "stopped", reason: "nosana_stopped", why: "archived" },
    { kind: "model", current: "provisioning", obs: observation("error"), next: "failed", reason: "nosana_error", why: "error without detail" },
    { kind: "model", current: "provisioning", obs: observation("error", [], { detail: "  JOB_FAILED: image pull failed " }), next: "failed", reason: "JOB_FAILED: image pull failed", why: "error reason comes from the Nosana event" },
    { kind: "model", current: "running", obs: observation("insufficient_funds"), next: "failed", reason: "nosana_insufficient_funds", why: "vault ran dry" },
  ];

  for (const c of cases) {
    const d = mapObservationToStatus(c.kind, c.current, c.obs);
    assert.equal(d.next, c.next, `${c.kind}/${c.current}/${c.obs.state} — ${c.why}`);
    if (c.reason !== undefined) assert.equal(d.reason, c.reason, `reason — ${c.why}`);
  }
});

// ============================================
// Only-on-change persistence
// ============================================

test("tick persists an observed transition with CAS fields", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, transitions, observed } = makeDeps({
    rows: [row({ id: "dep_1", status: "deploying" })],
    observations: { job_1: observation("running") },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(result.transitioned, 1);
  assert.deepEqual(observed, ["job_1"], "polls the Deployment-Manager id");
  assert.deepEqual(transitions, [
    {
      kind: "agent",
      id: "dep_1",
      orgId: "org_1",
      fromStatus: "deploying",
      toStatus: "running",
      observedAt: NOW,
      nosanaDeploymentId: "job_1",
    },
  ]);
});

test("tick does NOT write when the observed status equals the current one", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, transitions } = makeDeps({
    rows: [row({ status: "running" })],
    observations: { job_1: observation("running") },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(transitions.length, 0);
  assert.equal(result.unchanged, 1);
  assert.equal(result.transitioned, 0);
});

test("tick does NOT write when the mapping yields null (still starting)", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, transitions } = makeDeps({
    rows: [row({ status: "deploying" })],
    observations: { job_1: observation("starting") },
  });
  await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(transitions.length, 0);
});

test("a row with no Nosana id is skipped, not polled", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, observed } = makeDeps({ rows: [row({ nosanaJobIds: [] })] });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.deepEqual(observed, []);
  assert.equal(result.unchanged, 1);
});

test("tick counts a CAS miss (count=0) as unchanged — concurrent writer won", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps } = makeDeps({
    rows: [row({ status: "deploying" })],
    observations: { job_1: observation("running") },
    persistCount: 0,
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(result.transitioned, 0);
  assert.equal(result.unchanged, 1);
});

// ============================================
// RUNNING + endpoints -> nodes (the heart of W2-D)
// ============================================

function modelRow(overrides: Partial<DeploymentStatusRow> = {}): DeploymentStatusRow {
  return row({
    kind: "model",
    id: "m1",
    status: "provisioning",
    engine: "vllm",
    nosanaJobIds: ["job_1"],
    nodes: [],
    ...overrides,
  });
}

test("model RUNNING + endpoints: provisioning -> running, one node per REAL endpoint, probed right away", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const ep2 = { url: "https://def.node.k8s.prd.nos.ci", port: 8000, opId: "vllm-inference" };
  const { deps, transitions, synced, probed, nodeHealthWrites } = makeDeps({
    rows: [modelRow()],
    observations: { job_1: observation("running", [EP1, ep2]) },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);

  assert.equal(transitions[0]!.toStatus, "running");
  assert.deepEqual(synced, [{ deploymentId: "m1", endpoints: [EP1, ep2] }]);
  assert.equal(result.nodeSyncs, 1);
  // The freshly created nodes are probed in the SAME tick, with the real URLs.
  assert.deepEqual(
    probed.map((p) => p.url),
    [EP1.url, ep2.url],
  );
  assert.equal(nodeHealthWrites.length, 2);
  assert.equal(result.nodesProbed, 2);
});

test("RUNNING without an endpoint does NOT become running and creates no node", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, transitions, synced, probed } = makeDeps({
    rows: [modelRow()],
    observations: { job_1: observation("running", []) },
  });
  await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(transitions.length, 0, "no URL = no running");
  // the reconcile with [] only removes (legacy fabricated) nodes; nothing is invented
  assert.deepEqual(synced, [{ deploymentId: "m1", endpoints: [] }]);
  assert.deepEqual(probed, []);
});

test("a STARTING deployment leaves its nodes alone", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, synced } = makeDeps({
    rows: [modelRow()],
    observations: { job_1: observation("starting") },
  });
  await runDeploymentStatusTick({ now: NOW }, deps);
  assert.deepEqual(synced, []);
});

test("agent rows never sync nodes (no nodes relation)", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, synced, probed } = makeDeps({
    rows: [row({ kind: "agent", status: "deploying" })],
    observations: { job_1: observation("running") },
  });
  await runDeploymentStatusTick({ now: NOW }, deps);
  assert.deepEqual(synced, []);
  assert.deepEqual(probed, []);
});

test("a running model that loses every endpoint degrades and its nodes are removed", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, transitions, synced } = makeDeps({
    rows: [
      modelRow({
        status: "running",
        nodes: [{ id: "n1", nodeUrl: EP1.url, healthStatus: "healthy" }],
      }),
    ],
    observations: { job_1: observation("running", []) },
  });
  await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(transitions[0]!.toStatus, "degraded");
  assert.equal(transitions[0]!.reason, "no_live_endpoint");
  assert.deepEqual(synced, [{ deploymentId: "m1", endpoints: [] }]);
});

test("a CAS loser does not touch nodes (the winner owns the row)", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, synced } = makeDeps({
    rows: [modelRow()],
    observations: { job_1: observation("running") },
    persistCount: 0,
  });
  await runDeploymentStatusTick({ now: NOW }, deps);
  assert.deepEqual(synced, []);
});

test("a node-sync failure is isolated: the status transition still lands", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, transitions } = makeDeps({
    rows: [modelRow()],
    observations: { job_1: observation("running") },
    syncError: new Error("DB down"),
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(transitions[0]!.toStatus, "running");
  assert.equal(result.nodeSyncsFailed, 1);
  assert.equal(result.failed, 0);
});

// ============================================
// Failure + reservation release (verified for ERROR)
// ============================================

test("ERROR -> failed with the Nosana reason, and the credit hold is released", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, transitions, released, synced } = makeDeps({
    rows: [
      modelRow({
        status: "provisioning",
        reservationCents: 90n,
        reservationReleasedAt: null,
        nodes: [{ id: "n1", nodeUrl: "", healthStatus: "unknown" }],
      }),
    ],
    observations: { job_1: observation("error", [], { detail: "JOB_FAILED: no GPU host accepted the job" }) },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);

  assert.equal(transitions[0]!.toStatus, "failed");
  assert.equal(transitions[0]!.reason, "JOB_FAILED: no GPU host accepted the job");
  assert.deepEqual(released, [{ id: "m1", reason: "failed", reservationCents: 90n }]);
  assert.equal(result.reservationsReleased, 1);
  assert.deepEqual(synced, [{ deploymentId: "m1", endpoints: [] }], "a failed deployment keeps no nodes");
});

test("INSUFFICIENT_FUNDS -> failed (nosana_insufficient_funds) and releases the hold", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, transitions, released } = makeDeps({
    rows: [modelRow({ status: "running", reservationCents: 50n })],
    observations: { job_1: observation("insufficient_funds") },
  });
  await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(transitions[0]!.reason, "nosana_insufficient_funds");
  assert.equal(released.length, 1);
});

test("STOPPED releases the hold too; an already-released or empty hold is skipped", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const stopped = makeDeps({
    rows: [modelRow({ status: "running", reservationCents: 10n })],
    observations: { job_1: observation("stopped") },
  });
  await runDeploymentStatusTick({ now: NOW }, stopped.deps);
  assert.equal(stopped.released.length, 1);

  const already = makeDeps({
    rows: [modelRow({ status: "running", reservationCents: 10n, reservationReleasedAt: NOW })],
    observations: { job_1: observation("stopped") },
  });
  await runDeploymentStatusTick({ now: NOW }, already.deps);
  assert.equal(already.released.length, 0);

  const none = makeDeps({
    rows: [modelRow({ status: "running", reservationCents: 0n })],
    observations: { job_1: observation("stopped") },
  });
  await runDeploymentStatusTick({ now: NOW }, none.deps);
  assert.equal(none.released.length, 0);
});

test("only the CAS WINNER releases; a refund failure never undoes the transition", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const loser = makeDeps({
    rows: [modelRow({ status: "running", reservationCents: 10n })],
    observations: { job_1: observation("error") },
    persistCount: 0,
  });
  await runDeploymentStatusTick({ now: NOW }, loser.deps);
  assert.equal(loser.released.length, 0);

  const boom = makeDeps({
    rows: [modelRow({ status: "running", reservationCents: 10n })],
    observations: { job_1: observation("error") },
    releaseError: new Error("db down"),
  });
  const result = await runDeploymentStatusTick({ now: NOW }, boom.deps);
  assert.equal(result.transitioned, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.reservationsReleased, 0);
});


// ============================================
// Unreleased-reservation sweep (review #2)
// ============================================

test("a release that failed after its transition is RETRIED by the sweep on a later tick", async () => {
  // Before: loadDeployments only loads non-terminal rows, so a release that
  // threw after the row went terminal was never attempted again by anyone.
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");

  // Tick 1: the row fails, its release throws.
  const first = makeDeps({
    rows: [modelRow({ status: "running", reservationCents: 10n })],
    observations: { job_1: observation("error") },
    releaseError: new Error("db down"),
  });
  const r1 = await runDeploymentStatusTick({ now: NOW }, first.deps);
  assert.equal(r1.transitioned, 1);
  assert.equal(r1.reservationsReleased, 0);
  assert.equal(r1.reservationReleasesFailed, 1);

  // Tick 2: the row is terminal (not loaded), but it is still unreleased in the
  // DB - the sweep selects it and the release now succeeds.
  const second = makeDeps({
    rows: [],
    unreleased: [{ kind: "model", id: "m1", orgId: "org_1", status: "failed", reservationCents: 10n }],
  });
  const r2 = await runDeploymentStatusTick({ now: NOW }, second.deps);
  assert.equal(r2.scanned, 0);
  assert.equal(r2.reservationsReleased, 1);
  assert.deepEqual(second.released, [{ id: "m1", reason: "failed", reservationCents: 10n }]);
});

test("the sweep releases both kinds, records the terminal status as the reason, and isolates failures", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, released } = makeDeps({
    rows: [],
    unreleased: [
      { kind: "model", id: "m_bad", orgId: "org_1", status: "stopped", reservationCents: 5n },
      { kind: "agent", id: "a_ok", orgId: "org_2", status: "failed", reservationCents: 7n },
      { kind: "model", id: "m_ok", orgId: "org_1", status: "stopped", reservationCents: 9n },
    ],
    releaseErrorIds: ["m_bad"],
  });
  const r = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.deepEqual(
    released.map((h) => [h.id, h.reason]),
    [["a_ok", "failed"], ["m_ok", "stopped"]],
    "one throwing release does not stop the others",
  );
  assert.equal(r.reservationsReleased, 2);
  assert.equal(r.reservationReleasesFailed, 1);
});

test("a sweep-load failure never fails the tick; a lost release barrier is not counted as a release", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const broken = makeDeps({ rows: [], unreleasedLoadError: new Error("db") });
  const r = await runDeploymentStatusTick({ now: NOW }, broken.deps);
  assert.equal(r.reservationReleasesFailed, 1);

  const { deps } = makeDeps({
    rows: [],
    unreleased: [{ kind: "model", id: "m1", orgId: "o", status: "failed", reservationCents: 5n }],
  });
  (deps as any).releaseReservation = async () => ({ released: false });
  const lost = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(lost.reservationsReleased, 0);
  assert.equal(lost.reservationReleasesFailed, 0);
});

test("the sweep is optional: without loadUnreleasedReservations nothing extra runs", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const r = await runDeploymentStatusTick(
    { now: NOW },
    {
      loadDeployments: async () => [],
      observeDeployment: async () => observation("running"),
      persistTransition: async () => ({ count: 1 }),
      checkNodeHealth: async () => ({ healthy: true, latencyMs: 1 }),
      persistNodeHealth: async () => {},
      emitTransition: async () => {},
      releaseReservation: async () => ({ released: true }),
    },
  );
  assert.equal(r.reservationsReleased, 0);
});

// ============================================
// Observed lifecycle end: running → stopped/failed
// ============================================

test("a running deployment that Nosana stops is observed into stopped", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, transitions } = makeDeps({
    rows: [row({ status: "running" })],
    observations: { job_1: observation("stopped") },
  });
  await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(transitions[0]!.toStatus, "stopped");
});

test("a running deployment that errors on Nosana is observed into failed", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, transitions } = makeDeps({
    rows: [row({ status: "running" })],
    observations: { job_1: observation("error") },
  });
  await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(transitions[0]!.toStatus, "failed");
});

// ============================================
// Per-row isolation: API/RPC errors leave rows untouched
// ============================================

test("an API throw for one row leaves it untouched and does not stop the others", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, transitions } = makeDeps({
    rows: [
      row({ id: "dep_rpc_down", status: "deploying", nosanaJobIds: ["job_down"] }),
      row({ id: "dep_ok", status: "deploying", nosanaJobIds: ["job_ok"] }),
    ],
    observations: {
      job_down: new Error("Nosana API unreachable"),
      job_ok: observation("running"),
    },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(result.scanned, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.transitioned, 1);
  assert.deepEqual(
    transitions.map((t) => t.id),
    ["dep_ok"],
  );
});

test("a failed read fabricates nothing: no transition, no node sync, no release", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, transitions, synced, released } = makeDeps({
    rows: [modelRow({ status: "running", reservationCents: 10n })],
    observations: { job_1: new Error("503") },
  });
  await runDeploymentStatusTick({ now: NOW }, deps);
  assert.deepEqual(transitions, []);
  assert.deepEqual(synced, []);
  assert.deepEqual(released, []);
});

test("loadDeployments errors bubble so BullMQ records the tick failure", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  await assert.rejects(
    runDeploymentStatusTick(
      { now: NOW },
      {
        loadDeployments: async () => {
          throw new Error("DB unreachable");
        },
        observeDeployment: async () => observation("running"),
        persistTransition: async () => ({ count: 1 }),
        checkNodeHealth: async () => ({ healthy: true, latencyMs: 1 }),
        persistNodeHealth: async () => {},
        emitTransition: async () => {},
      },
    ),
    /DB unreachable/,
  );
});

// ============================================
// Node health probes (plan A2)
// ============================================

function modelRowWithNode(
  overrides: Partial<DeploymentStatusRow> = {},
): DeploymentStatusRow {
  return modelRow({
    status: "running",
    nodes: [{ id: "n1", nodeUrl: "https://node1.node.nos.ci", healthStatus: "unknown" }],
    ...overrides,
  });
}

// With syncNodes absent the tick probes the nodes it was loaded with.
function noSync(opts: Parameters<typeof makeDeps>[0]) {
  return makeDeps({ ...opts, withSync: false });
}

test("an ok probe flips a node unknown → healthy with latency and checkedAt", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, nodeHealthWrites } = noSync({
    rows: [modelRowWithNode()],
    observations: { job_1: observation("running") },
    nodeProbes: { "https://node1.node.nos.ci": { healthy: true, latencyMs: 42 } },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.deepEqual(nodeHealthWrites, [
    { nodeId: "n1", healthStatus: "healthy", latencyMs: 42, checkedAt: NOW },
  ]);
  assert.equal(result.nodesProbed, 1);
  assert.equal(result.nodesUnhealthy, 0);
});

test("the probe is told the deployment's engine (vllm /health vs ollama /api/tags)", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const vllm = noSync({ rows: [modelRowWithNode({ engine: "vllm" })] });
  await runDeploymentStatusTick({ now: NOW }, vllm.deps);
  assert.equal(vllm.probed[0]!.engine, "vllm");

  const ollama = noSync({ rows: [modelRowWithNode({ engine: "ollama" })] });
  await runDeploymentStatusTick({ now: NOW }, ollama.deps);
  assert.equal(ollama.probed[0]!.engine, "ollama");
});

test("a failed probe marks the node unhealthy", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, nodeHealthWrites } = noSync({
    rows: [modelRowWithNode()],
    nodeProbes: { "https://node1.node.nos.ci": { healthy: false, latencyMs: 5001 } },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(nodeHealthWrites[0]!.healthStatus, "unhealthy");
  assert.equal(result.nodesUnhealthy, 1);
});

test("health is persisted even when unchanged — lastHealthCheck is a freshness signal", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, nodeHealthWrites } = noSync({
    rows: [
      modelRowWithNode({
        nodes: [{ id: "n1", nodeUrl: "https://node1.node.nos.ci", healthStatus: "healthy" }],
      }),
    ],
  });
  await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(nodeHealthWrites.length, 1);
});

test("nodes with an empty nodeUrl are not probed — they stay unknown", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, probed, nodeHealthWrites } = noSync({
    rows: [
      modelRowWithNode({ nodes: [{ id: "n1", nodeUrl: "", healthStatus: "unknown" }] }),
    ],
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.deepEqual(probed, []);
  assert.deepEqual(nodeHealthWrites, []);
  assert.equal(result.nodesProbed, 0);
});

test("agent rows carry no nodes and trigger no probes", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, probed } = makeDeps({
    rows: [row({ kind: "agent", status: "running" })],
  });
  await runDeploymentStatusTick({ now: NOW }, deps);
  assert.deepEqual(probed, []);
});

test("a probe-persist throw is isolated: the row's status observation still lands and the tick completes", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, transitions } = makeDeps({
    rows: [
      modelRowWithNode({ status: "provisioning" }),
      modelRowWithNode({ id: "m2", status: "provisioning" }),
    ],
    observations: { job_1: observation("running") },
    persistNodeHealthError: new Error("DB write failed"),
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.deepEqual(
    transitions.map((t) => t.toStatus),
    ["running", "running"],
  );
  assert.equal(result.nodeProbesFailed, 2);
  assert.equal(result.nodesProbed, 0);
});

test("an API outage on the observation does not blind the health probe", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, nodeHealthWrites } = makeDeps({
    rows: [modelRowWithNode()],
    observations: { job_1: new Error("Nosana API unreachable") },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(result.failed, 1);
  assert.equal(result.nodesProbed, 1);
  assert.equal(nodeHealthWrites[0]!.healthStatus, "healthy");
});

// ============================================
// Vault reclaim sweep
// ============================================

test("vault sweep: reclaimed / still-pending / failing candidates are counted and isolated", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps, reclaimed } = makeDeps({
    rows: [],
    candidates: [
      { id: "a", nosanaDeploymentId: "dm_a" },
      { id: "b", nosanaDeploymentId: "dm_b" },
      { id: "c", nosanaDeploymentId: "dm_c" },
    ],
    reclaimResults: {
      dm_a: { reclaimed: true },
      dm_b: { reclaimed: false },
      dm_c: new Error("rpc down"),
    },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.deepEqual(reclaimed, ["dm_a", "dm_b", "dm_c"], "one failure does not stop the rest");
  assert.equal(result.vaultsReclaimed, 1);
  assert.equal(result.vaultsPending, 1);
  assert.equal(result.vaultReclaimsFailed, 1);
});

test("vault sweep: a candidate-load failure never fails the tick", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps } = makeDeps({ rows: [], candidateLoadError: new Error("db") });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(result.vaultReclaimsFailed, 1);
});

test("vault sweep is optional: absent deps mean it is skipped", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const result = await runDeploymentStatusTick(
    { now: NOW },
    {
      loadDeployments: async () => [],
      observeDeployment: async () => observation("running"),
      persistTransition: async () => ({ count: 1 }),
      checkNodeHealth: async () => ({ healthy: true, latencyMs: 1 }),
      persistNodeHealth: async () => {},
      emitTransition: async () => {},
    },
  );
  assert.equal(result.vaultsReclaimed + result.vaultsPending + result.vaultReclaimsFailed, 0);
});

// ============================================
// No in-memory state — restart safety
// ============================================

test("two identical ticks observe identically (pure function of rows + Nosana, no module state)", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const run = async () => {
    const { deps, transitions } = makeDeps({
      rows: [row({ status: "deploying" })],
      observations: { job_1: observation("running") },
    });
    const result = await runDeploymentStatusTick({ now: NOW }, deps);
    return { result, transitions };
  };
  const first = await run();
  const second = await run();
  assert.deepEqual(first.result, second.result);
  assert.deepEqual(first.transitions, second.transitions);
});

// ============================================
// Tick-observed webhook emission (Wave 1)
// ============================================

test("a CAS-winning transition is emitted; a CAS loser is not", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const winner = makeDeps({
    rows: [row({ status: "deploying" })],
    observations: { job_1: observation("running") },
  });
  await runDeploymentStatusTick({ now: NOW }, winner.deps);
  assert.equal(winner.emitted.length, 1);
  assert.equal(winner.emitted[0]!.toStatus, "running");
  assert.equal(winner.emitted[0]!.orgId, "org_1");

  const loser = makeDeps({
    rows: [row({ status: "deploying" })],
    observations: { job_1: observation("running") },
    persistCount: 0,
  });
  await runDeploymentStatusTick({ now: NOW }, loser.deps);
  assert.equal(loser.emitted.length, 0);
});

test("an emitTransition throw never fails the row", async () => {
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps } = makeDeps({
    rows: [row({ status: "deploying" })],
    observations: { job_1: observation("running") },
    emitError: new Error("webhook store down"),
  });
  const result = await runDeploymentStatusTick({ now: NOW }, deps);
  assert.equal(result.transitioned, 1);
  assert.equal(result.failed, 0);
});

// ============================================
// Replica reconciliation: when the tick asks for it
// ============================================

test("the tick reconciles replicas only for a stale claim or an unclaimed mismatch, from the count Nosana reports", async () => {
  setupEnv();
  const { runDeploymentStatusTick, REPLICA_CHANGE_STALE_MS } = await import(
    "../services/runDeploymentStatusTick.js"
  );
  const claim = (ageMs: number) => ({ id: "chg", to: 4, claimedAt: new Date(NOW.getTime() - ageMs), holdCents: 180n });
  const model = (id: string, over: Partial<DeploymentStatusRow> = {}) =>
    row({ kind: "model", id, status: "running", nosanaJobIds: [id], runGeneration: 7, replicas: 2, ...over });

  const cases: Array<[string, DeploymentStatusRow, DeploymentObservation, boolean]> = [
    ["same count, no claim", model("same"), observation("running", [EP1], { replicas: 2 }), false],
    ["mismatch, no claim", model("drift"), observation("running", [EP1], { replicas: 4 }), true],
    ["fresh claim", model("fresh", { replicaChange: claim(REPLICA_CHANGE_STALE_MS - 1) }), observation("running", [EP1], { replicas: 4 }), false],
    ["stale claim, applied", model("stale", { replicaChange: claim(REPLICA_CHANGE_STALE_MS) }), observation("running", [EP1], { replicas: 4 }), true],
    ["stale claim, not applied", model("stale2", { replicaChange: claim(REPLICA_CHANGE_STALE_MS) }), observation("running", [EP1], { replicas: 2 }), true],
    ["degraded (running on Nosana, no endpoint)", model("deg", { status: "degraded" }), observation("running", [], { replicas: 4 }), true],
    ["Nosana not running", model("stopping"), observation("stopping", [], { replicas: 4 }), false],
    ["ended this tick", model("ended"), observation("stopped", [], { replicas: 4 }), false],
    ["still provisioning", model("prov", { status: "provisioning" }), observation("starting", [], { replicas: 4 }), false],
    ["dev mock", model("mock"), observation("running", [], { replicas: 4, mock: true }), false],
    ["no count reported", model("nocount"), observation("running", [EP1]), false],
    ["agent row", row({ id: "agent", status: "running", nosanaJobIds: ["agent"] }), observation("running", [EP1], { replicas: 4 }), false],
  ];

  for (const [name, r, obs, expected] of cases) {
    const { deps } = makeDeps({ rows: [r], observations: { [r.nosanaJobIds[0]!]: obs } });
    const calls: any[] = [];
    const result = await runDeploymentStatusTick(
      { now: NOW },
      {
        ...deps,
        reconcileReplicas: async (args) => {
          calls.push(args);
          return { reconciled: true };
        },
      },
    );
    assert.equal(calls.length, expected ? 1 : 0, name);
    assert.equal(result.replicasReconciled, expected ? 1 : 0, name);
    if (expected) {
      assert.equal(calls[0].observedReplicas, obs.replicas, name);
      assert.equal(calls[0].replicas, 2, `${name}: the count as loaded is the CAS guard`);
      assert.equal(calls[0].runGeneration, 7, `${name}: and so is the run`);
      assert.deepEqual(calls[0].claim, r.replicaChange ?? null, name);
      assert.deepEqual(calls[0].observedAt, NOW, name);
    }
  }
});

test("a row whose status CAS was lost is not reconciled, and a reconcile failure is isolated and counted", async () => {
  setupEnv();
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const model = (id: string, status = "running") =>
    row({ kind: "model", id, status, nosanaJobIds: [id], replicas: 2 });

  // Lost CAS (running -> degraded, count 0): a concurrent writer owns the row.
  const lost = makeDeps({
    rows: [model("m1")],
    observations: { m1: observation("running", [], { replicas: 4 }) },
    persistCount: 0,
  });
  let called = 0;
  await runDeploymentStatusTick(
    { now: NOW },
    { ...lost.deps, reconcileReplicas: async () => ((called += 1), { reconciled: true }) },
  );
  assert.equal(called, 0);

  const broken = makeDeps({
    rows: [model("bad"), model("good")],
    observations: {
      bad: observation("running", [EP1], { replicas: 4 }),
      good: observation("running", [EP1], { replicas: 4 }),
    },
  });
  const result = await runDeploymentStatusTick(
    { now: NOW },
    {
      ...broken.deps,
      reconcileReplicas: async ({ id }) => {
        if (id === "bad") throw new Error("db down");
        return { reconciled: id === "good" };
      },
    },
  );
  assert.equal(result.replicaReconcilesFailed, 1);
  assert.equal(result.replicasReconciled, 1, "the other row still ran");
  assert.equal(result.failed, 0, "a reconcile failure does not fail the row's status observation");
  assert.equal(broken.probed.length, 2, "nor its node probes");
});

test("a hold released inside persistTransition is counted once; the follow-up release is the CAS no-op", async () => {
  setupEnv();
  const { runDeploymentStatusTick } = await import("../services/runDeploymentStatusTick.js");
  const { deps } = makeDeps({
    rows: [row({ kind: "model", id: "m1", status: "running", reservationCents: 90n, reservationReleasedAt: null })],
    observations: { job_1: observation("stopped") },
  });
  const result = await runDeploymentStatusTick(
    { now: NOW },
    {
      ...deps,
      persistTransition: async () => ({ count: 1, reservationReleased: true }),
      releaseReservation: async () => ({ released: false }), // already released: its CAS misses
    },
  );
  assert.equal(result.reservationsReleased, 1);
});
