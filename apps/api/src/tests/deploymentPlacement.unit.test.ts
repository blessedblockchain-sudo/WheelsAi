import assert from "node:assert/strict";
import { after, test } from "node:test";
import { creditTimeoutListError, startFakeNosanaApi, startRequestCounter, FAKE_MARKETS } from "./fakeNosanaApi.js";

// What the first live run exposed (2026-10-08), in the deployment-status tick:
//
//   - a deployment Nosana cannot place (it reports RUNNING and logs
//     JOB_LIST_ERROR on every attempt) sat in `provisioning` with no reason.
//     It now fails with a stable reason, is stopped on Nosana in the same
//     pass, its hold is returned exactly once and nothing is charged;
//   - a row that simply waits for a GPU keeps waiting, up to a limit;
//   - a model row became `running` (billed) when Nosana's endpoint came
//     online, before Ollama had the model in GPU memory. It now needs our
//     own probe of the endpoint to be healthy as well.
//
// Two layers: the pure tick with hand-written dependencies, and the whole
// chain as the queue wires it, through the REAL NosanaClient and @nosana/sdk
// against the stand-in Nosana API on loopback. No node is ever fetched: the
// stand-in's endpoints are names under nos.ci, so the probe is injected.

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
// The second attempt of the live run: 3000 seconds, sent as 50 minutes.
process.env.NOSANA_JOB_TIMEOUT_SECONDS = "3000";
for (const name of [
  "NOSANA_WALLET_PRIVATE_KEY",
  "NOSANA_ACCESS_MODE",
  "NOSANA_NETWORK",
  "NOSANA_TIMEOUT_UNIT",
  "NOSANA_MIN_CREDITS_USD",
  "NOSANA_MARKETS_JSON",
  "NOSANA_BATCH_JOB_TIMEOUT_SECONDS",
  "NOSANA_DEPLOYMENT_STRATEGY",
  "NOSANA_VAULT_FUND_SECONDS",
  "NOSANA_VAULT_MIN_RUNWAY_SECONDS",
  "ALLOW_NOSANA_MOCK",
  "SOLANA_WALLET",
  "ANCHOR_PROVIDER_URL",
]) {
  delete process.env[name];
}

const { NosanaClient, generateJobDefinition, ollamaModelLoaded, servedModelName } = await import(
  "../services/nosana.js"
);
const { getNosanaAccessConfig, resetNosanaAccessConfigForTests } = await import("../config/nosanaAccess.js");
const { resetNosanaDeployConfigForTests } = await import("../config/nosanaDeploy.js");
const {
  assessListing,
  listingHasFailed,
  runDeploymentStatusTick,
  DEFAULT_PROVISIONING_LIMIT_MS,
  LIST_ERROR_PERSIST_MS,
  LIST_FAILED_REASON,
  NO_CAPACITY_REASON,
  PLACEMENT_FAILURE_REASONS,
  PLACEMENT_FAILURE_SENTENCES,
  PROVISIONING_GRACE_MS,
  START_TIMEOUT_REASON,
} = await import("../services/runDeploymentStatusTick.js");
const { buildDeploymentStatusTickDeps } = await import("../services/buildDeploymentStatusTickDeps.js");
const { recordPlacementFailure, recentPlacementFailures, resetPlacementFailuresForTests, MAX_PLACEMENT_FAILURES } =
  await import("../services/nosanaPlacementFailures.js");
const { computePlatformCompute } = await import("../routes/platformCompute.js");
const { buildPlatformComputeDeps } = await import("../routes/platformComputeBindings.js");

import type {
  DeploymentObservation,
  DeploymentStatusRow,
  DeploymentStatusTickDeps,
  DeploymentStatusTransition,
  ObservedEndpoint,
  PlacementEvent,
  PlacementFailure,
} from "../services/runDeploymentStatusTick.js";

const NOW = new Date("2026-10-08T00:53:05.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MINUTE = 60_000;
const M4090 = "97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf";
const LIVE_MESSAGE =
  "Error Failed to assign job batch: Credit-paid jobs must have a timeout of at least 3000 seconds; 600 was requested.";

const OFFLINE: ObservedEndpoint = { url: "https://zzz.node.k8s.prd.nos.ci", port: 11434, opId: "ollama-inference", online: false };
const ONLINE: ObservedEndpoint = { ...OFFLINE, online: true };

/** One refused listing attempt, as Nosana logs it: the reserve, then the error. Newest first. */
function refusedAttempt(at: Date): PlacementEvent[] {
  return [
    { type: "JOB_LIST_ERROR", message: LIVE_MESSAGE, createdAt: new Date(at.getTime() + 1_000).toISOString() },
    { type: "JOB_RESERVE_CONFIRMED", message: `Reserved 1 node(s) in market(s) ${M4090}`, createdAt: at.toISOString() },
  ];
}

const LISTED = (at: Date): PlacementEvent[] => [
  { type: "JOB_LIST_CONFIRMED", message: "Successfully listed job - abc", createdAt: new Date(at.getTime() + 1_000).toISOString() },
  { type: "JOB_RESERVE_CONFIRMED", message: `Reserved 1 node(s) in market(s) ${M4090}`, createdAt: at.toISOString() },
];

// ============================================
// The listing outcome, read from the events
// ============================================

test("assessListing: the newest listing outcome decides, and only listing events count", () => {
  assert.deepEqual(assessListing([]), { outcome: "none", errorCount: 0, firstErrorAt: null });
  // Reserved, nothing listed yet: still queued.
  assert.deepEqual(
    assessListing([{ type: "JOB_RESERVE_CONFIRMED", message: "Reserved 1 node(s)", createdAt: NOW.toISOString() }]),
    { outcome: "none", errorCount: 0, firstErrorAt: null },
  );
  assert.deepEqual(assessListing(LISTED(ago(MINUTE))), { outcome: "confirmed", errorCount: 0, firstErrorAt: null });

  const one = assessListing(refusedAttempt(ago(2 * MINUTE)));
  assert.equal(one.outcome, "error");
  assert.equal(one.errorCount, 1);
  assert.deepEqual(one.firstErrorAt, new Date(ago(2 * MINUTE).getTime() + 1_000));
  assert.equal(one.message, LIVE_MESSAGE);

  // Three attempts, newest first: the count, and when the run of errors began.
  const three = assessListing([
    ...refusedAttempt(ago(1 * MINUTE)),
    ...refusedAttempt(ago(4 * MINUTE)),
    ...refusedAttempt(ago(7 * MINUTE)),
  ]);
  assert.equal(three.errorCount, 3);
  assert.deepEqual(three.firstErrorAt, new Date(ago(7 * MINUTE).getTime() + 1_000));

  // An error Nosana got past: the listing after it is the outcome.
  assert.equal(assessListing([...LISTED(ago(MINUTE)), ...refusedAttempt(ago(4 * MINUTE))]).outcome, "confirmed");
  // A listing, then errors (an extension that fails): only the errors after it count.
  const after = assessListing([
    ...refusedAttempt(ago(1 * MINUTE)),
    ...LISTED(ago(5 * MINUTE)),
    ...refusedAttempt(ago(9 * MINUTE)),
  ]);
  assert.equal(after.outcome, "error");
  assert.equal(after.errorCount, 1);

  // A long message is cut, and a missing time does not throw.
  const long = assessListing([{ type: "JOB_LIST_ERROR", message: "x".repeat(900), createdAt: null }]);
  assert.equal(long.message!.length, 500);
  assert.equal(long.firstErrorAt, null);
});

test("listingHasFailed: an error that repeated, or one that has stood for five minutes; never a single fresh one", () => {
  const fresh = assessListing(refusedAttempt(ago(2 * MINUTE)));
  assert.equal(listingHasFailed(fresh, NOW), false, "Nosana's next attempt may get past it");
  const stood = assessListing(refusedAttempt(ago(LIST_ERROR_PERSIST_MS + 2_000)));
  assert.equal(listingHasFailed(stood, NOW), true);
  const twice = assessListing([...refusedAttempt(ago(10_000)), ...refusedAttempt(ago(3 * MINUTE))]);
  assert.equal(listingHasFailed(twice, NOW), true);
  assert.equal(listingHasFailed(assessListing([]), NOW), false);
  assert.equal(listingHasFailed(assessListing(LISTED(ago(40 * MINUTE))), NOW), false);
  // One error with no time on it cannot be said to have stood.
  assert.equal(listingHasFailed(assessListing([{ type: "JOB_LIST_ERROR", message: "x", createdAt: null }]), NOW), false);
});

test("each ending has a customer sentence: what happened, what happened to the money, no configuration detail", () => {
  assert.deepEqual([...PLACEMENT_FAILURE_REASONS], ["nosana_list_failed", "no_capacity", "start_timeout"]);
  for (const reason of PLACEMENT_FAILURE_REASONS) {
    const sentence = PLACEMENT_FAILURE_SENTENCES[reason];
    assert.match(sentence, /Nothing was charged/);
    assert.match(sentence, /returned/);
    assert.doesNotMatch(sentence, /nosana|timeout|NOSANA_|credit-paid|3000|JOB_/i);
  }
});

// ============================================
// The pure tick
// ============================================

function modelRow(over: Partial<DeploymentStatusRow> = {}): DeploymentStatusRow {
  return {
    kind: "model",
    id: "dep_1",
    orgId: "org_1",
    status: "provisioning",
    engine: "ollama",
    servedModel: "llama3.2:3b",
    nosanaJobIds: ["dm_1"],
    nosanaAccessMode: "api_key",
    runGeneration: 2,
    waitingSince: ago(3 * MINUTE),
    reservationCents: 90n,
    reservationReleasedAt: null,
    ...over,
  };
}

function pureDeps(opts: {
  rows: DeploymentStatusRow[];
  observation?: DeploymentObservation;
  events?: PlacementEvent[] | Error;
  probe?: { healthy: boolean; latencyMs: number };
  /** What a probe of an endpoint Nosana reports offline answers. Default: nothing answers there. */
  offlineProbe?: { healthy: boolean; latencyMs: number; pending?: boolean };
  persistCount?: number;
  withEvents?: boolean;
  stop?: () => Promise<{ stopRefused?: boolean }>;
}) {
  const transitions: DeploymentStatusTransition[] = [];
  const eventReads: Array<[string, string | undefined]> = [];
  const probed: Array<{ url: string; engine?: string; model?: string }> = [];
  const nodeHealth: Array<{ nodeId: string; healthStatus: string }> = [];
  const released: Array<{ id: string; reason: string; reservationCents: bigint; runGeneration?: number }> = [];
  const stopped: Array<[string, string | undefined]> = [];
  const reports: PlacementFailure[] = [];
  const synced: ObservedEndpoint[][] = [];
  const deps: DeploymentStatusTickDeps = {
    loadDeployments: async () => opts.rows,
    observeDeployment: async () => opts.observation ?? { state: "running", endpoints: [OFFLINE], replicas: 1 },
    persistTransition: async (t) => {
      transitions.push(t);
      return { count: opts.persistCount ?? 1 };
    },
    syncNodes: async ({ endpoints }) => {
      synced.push(endpoints);
      // As the real reconciliation does: a node that already exists is kept as it is.
      const existing = opts.rows.flatMap((row) => row.nodes ?? []);
      return endpoints.map(
        (e, i) => existing.find((node) => node.nodeUrl === e.url) ?? { id: `node_${i}`, nodeUrl: e.url, healthStatus: "unknown" },
      );
    },
    checkNodeHealth: async (url, engine, model) => {
      probed.push({ url, engine, model });
      // An endpoint Nosana reports offline has no container behind it, unless
      // the test says the node answers all the same.
      const endpoints = (opts.observation ?? { endpoints: [OFFLINE] }).endpoints;
      const reportedOnline = endpoints.some((e) => e.url === url && e.online === true);
      if (!reportedOnline) return opts.offlineProbe ?? { healthy: false, latencyMs: 700 };
      return opts.probe ?? { healthy: true, latencyMs: 12 };
    },
    persistNodeHealth: async (obs) => {
      nodeHealth.push({ nodeId: obs.nodeId, healthStatus: obs.healthStatus });
    },
    emitTransition: async () => undefined,
    releaseReservation: async (args) => {
      released.push({
        id: args.id,
        reason: args.reason,
        reservationCents: args.reservationCents,
        ...(args.runGeneration !== undefined ? { runGeneration: args.runGeneration } : {}),
      });
      return { released: true };
    },
    ...(opts.withEvents === false
      ? {}
      : {
          readPlacementEvents: async (id: string, mode?: "wallet" | "api_key") => {
            eventReads.push([id, mode]);
            if (opts.events instanceof Error) throw opts.events;
            return opts.events ?? [];
          },
        }),
    reportPlacementFailure: (failure) => {
      reports.push(failure);
    },
    stopHaltedDeployment: async (id, mode) => {
      stopped.push([id, mode]);
      return opts.stop ? opts.stop() : {};
    },
  };
  return { deps, transitions, eventReads, probed, nodeHealth, released, stopped, reports, synced };
}

const TWO_REFUSALS = [...refusedAttempt(ago(10_000)), ...refusedAttempt(ago(170_000))];

test("a provisioning row whose listing keeps failing is failed with nosana_list_failed, stopped in the same pass, released once, and reported with Nosana's message", async () => {
  const h = pureDeps({ rows: [modelRow()], events: TWO_REFUSALS });
  const result = await runDeploymentStatusTick({ now: NOW }, h.deps);

  assert.deepEqual(h.eventReads, [["dm_1", "api_key"]], "the events were read once, through the row's credential");
  assert.equal(h.transitions.length, 1);
  const t = h.transitions[0]!;
  assert.equal(t.fromStatus, "provisioning");
  assert.equal(t.toStatus, "failed");
  assert.equal(t.reason, LIST_FAILED_REASON, "a stable code, never Nosana's text");
  assert.equal(t.runGeneration, 2, "the CAS names the run that was observed");
  assert.equal(t.detail, LIVE_MESSAGE);

  assert.deepEqual(h.stopped, [["dm_1", "api_key"]], "stopped on Nosana in the same pass");
  assert.deepEqual(h.released, [{ id: "dep_1", reason: "failed", reservationCents: 90n, runGeneration: 2 }]);
  assert.deepEqual(h.synced, [[]], "no node may stay behind");
  assert.deepEqual(
    h.probed,
    [{ url: OFFLINE.url, engine: "ollama", model: "llama3.2:3b" }],
    "the endpoint Nosana reports offline was probed once, and nothing answered there",
  );

  assert.equal(h.reports.length, 1);
  assert.deepEqual(h.reports[0], {
    kind: "model",
    id: "dep_1",
    orgId: "org_1",
    nosanaDeploymentId: "dm_1",
    accessMode: "api_key",
    reason: "nosana_list_failed",
    detail: LIVE_MESSAGE,
    waitedSeconds: 180,
    observedAt: NOW,
  });
  assert.equal(result.transitioned, 1);
  assert.equal(result.placementFailures, 1);
  assert.equal(result.reservationsReleased, 1);
  assert.equal(result.haltedStops, 1);
  assert.equal(result.failed, 0);
});

test("one fresh listing error is not a failure yet: the row waits for Nosana's next attempt", async () => {
  const h = pureDeps({ rows: [modelRow()], events: refusedAttempt(ago(2 * MINUTE)) });
  const result = await runDeploymentStatusTick({ now: NOW }, h.deps);
  assert.equal(h.eventReads.length, 1);
  assert.equal(h.transitions.length, 0);
  assert.equal(h.stopped.length, 0);
  assert.equal(h.released.length, 0);
  assert.equal(result.unchanged, 1);
  assert.equal(result.placementFailures, 0);
});

test("...and one that has stood for five minutes is", async () => {
  const h = pureDeps({
    rows: [modelRow({ waitingSince: ago(7 * MINUTE) })],
    events: refusedAttempt(ago(LIST_ERROR_PERSIST_MS + 5_000)),
  });
  await runDeploymentStatusTick({ now: NOW }, h.deps);
  assert.equal(h.transitions[0]?.reason, LIST_FAILED_REASON);
  assert.equal(h.stopped.length, 1);
});

test("inside the grace period the events are not even read", async () => {
  const h = pureDeps({ rows: [modelRow({ waitingSince: ago(PROVISIONING_GRACE_MS - 1_000) })], events: TWO_REFUSALS });
  await runDeploymentStatusTick({ now: NOW }, h.deps);
  assert.equal(h.eventReads.length, 0);
  assert.equal(h.transitions.length, 0);

  const custom = pureDeps({ rows: [modelRow({ waitingSince: ago(20_000) })], events: TWO_REFUSALS });
  await runDeploymentStatusTick({ now: NOW, provisioningGraceMs: 10_000 }, custom.deps);
  assert.equal(custom.eventReads.length, 1, "the grace period is the tick's input");
  assert.equal(custom.transitions[0]?.reason, LIST_FAILED_REASON);
});

test("a row that simply waits for a free GPU keeps waiting: no error events, no failure", async () => {
  for (const events of [[], LISTED(ago(2 * MINUTE)), [...LISTED(ago(MINUTE)), ...refusedAttempt(ago(4 * MINUTE))]]) {
    const h = pureDeps({ rows: [modelRow({ waitingSince: ago(20 * MINUTE) })], events });
    const result = await runDeploymentStatusTick({ now: NOW }, h.deps);
    assert.equal(h.transitions.length, 0);
    assert.equal(h.stopped.length, 0);
    assert.equal(h.released.length, 0);
    assert.equal(result.unchanged, 1);
  }
});

test("past the provisioning limit a waiting row is failed with no_capacity, stopped and released: a hold is not kept for ever", async () => {
  const h = pureDeps({ rows: [modelRow({ waitingSince: ago(DEFAULT_PROVISIONING_LIMIT_MS) })], events: [] });
  const result = await runDeploymentStatusTick({ now: NOW }, h.deps);
  const t = h.transitions[0]!;
  assert.equal(t.toStatus, "failed");
  assert.equal(t.reason, NO_CAPACITY_REASON);
  assert.equal(t.detail, undefined);
  assert.deepEqual(h.stopped, [["dm_1", "api_key"]]);
  assert.deepEqual(h.released.map((r) => [r.id, r.reason]), [["dep_1", "failed"]]);
  assert.equal(h.reports[0]!.reason, "no_capacity");
  assert.equal(h.reports[0]!.waitedSeconds, 1_800);
  assert.equal(result.placementFailures, 1);

  // One second short of it: still waiting.
  const early = pureDeps({ rows: [modelRow({ waitingSince: ago(DEFAULT_PROVISIONING_LIMIT_MS - 1_000) })], events: [] });
  await runDeploymentStatusTick({ now: NOW }, early.deps);
  assert.equal(early.transitions.length, 0);

  // The limit is configurable.
  const short = pureDeps({ rows: [modelRow({ waitingSince: ago(6 * MINUTE) })], events: [] });
  await runDeploymentStatusTick({ now: NOW, provisioningLimitMs: 5 * MINUTE }, short.deps);
  assert.equal(short.transitions[0]?.reason, NO_CAPACITY_REASON);
});

test("the limit also ends a deployment Nosana still reports as starting, and one whose events cannot be read", async () => {
  const starting = pureDeps({
    rows: [modelRow({ waitingSince: ago(31 * MINUTE) })],
    observation: { state: "starting", endpoints: [] },
    events: [],
  });
  await runDeploymentStatusTick({ now: NOW }, starting.deps);
  assert.equal(starting.transitions[0]?.reason, NO_CAPACITY_REASON);
  assert.equal(starting.stopped.length, 1);

  const blind = pureDeps({ rows: [modelRow({ waitingSince: ago(31 * MINUTE) })], events: new Error("events route down") });
  const result = await runDeploymentStatusTick({ now: NOW }, blind.deps);
  assert.equal(blind.transitions[0]?.reason, NO_CAPACITY_REASON);
  assert.equal(result.failed, 0);

  // No events reader wired at all: the limit still applies.
  const none = pureDeps({ rows: [modelRow({ waitingSince: ago(31 * MINUTE) })], withEvents: false });
  await runDeploymentStatusTick({ now: NOW }, none.deps);
  assert.equal(none.transitions[0]?.reason, NO_CAPACITY_REASON);
});

test("events that cannot be read never fail a row before the limit", async () => {
  const h = pureDeps({ rows: [modelRow()], events: new Error("events route down") });
  const result = await runDeploymentStatusTick({ now: NOW }, h.deps);
  assert.equal(h.transitions.length, 0);
  assert.equal(result.failed, 0, "the row was read; only the explanation was not");
  assert.equal(result.unchanged, 1);
});

test("at the limit the reason says what was seen: a failing listing, a job that never became ready, or no GPU", async () => {
  const single = pureDeps({ rows: [modelRow({ waitingSince: ago(31 * MINUTE) })], events: refusedAttempt(ago(MINUTE)) });
  await runDeploymentStatusTick({ now: NOW }, single.deps);
  assert.equal(single.transitions[0]?.reason, LIST_FAILED_REASON);
  assert.equal(single.transitions[0]?.detail, LIVE_MESSAGE);

  const listed = pureDeps({ rows: [modelRow({ waitingSince: ago(31 * MINUTE) })], events: LISTED(ago(30 * MINUTE)) });
  await runDeploymentStatusTick({ now: NOW }, listed.deps);
  assert.equal(listed.transitions[0]?.reason, START_TIMEOUT_REASON, "a node took the job; it never came online");
});

test("only the CAS winner stops, releases and reports", async () => {
  const h = pureDeps({ rows: [modelRow()], events: TWO_REFUSALS, persistCount: 0 });
  const result = await runDeploymentStatusTick({ now: NOW }, h.deps);
  assert.equal(h.transitions.length, 1, "the CAS was tried");
  assert.equal(h.stopped.length, 0);
  assert.equal(h.released.length, 0);
  assert.equal(h.reports.length, 0);
  assert.equal(h.synced.length, 0);
  assert.equal(result.placementFailures, 0);
  assert.equal(result.unchanged, 1);
});

test("a stop Nosana refuses, or that cannot be sent, does not undo the failure: it is counted for the sweep", async () => {
  const refused = pureDeps({ rows: [modelRow()], events: TWO_REFUSALS, stop: async () => ({ stopRefused: true }) });
  const a = await runDeploymentStatusTick({ now: NOW }, refused.deps);
  assert.equal(a.transitioned, 1);
  assert.equal(a.haltedStopsFailed, 1);
  assert.equal(refused.released.length, 1);

  const thrown = pureDeps({
    rows: [modelRow()],
    events: TWO_REFUSALS,
    stop: async () => {
      throw new Error("network");
    },
  });
  const b = await runDeploymentStatusTick({ now: NOW }, thrown.deps);
  assert.equal(b.haltedStopsFailed, 1);
  assert.equal(b.failed, 0);
});

test("the rules leave alone: a running row, a mock, a row with no waiting time, and a Nosana deployment that is stopping", async () => {
  const cases: Array<[string, DeploymentStatusRow, DeploymentObservation]> = [
    ["running row with an online endpoint", modelRow({ status: "running", waitingSince: ago(90 * MINUTE) }), { state: "running", endpoints: [ONLINE] }],
    ["mock", modelRow({ waitingSince: ago(90 * MINUTE) }), { state: "running", endpoints: [], mock: true }],
    ["no waiting time on the row", modelRow({ waitingSince: undefined }), { state: "running", endpoints: [OFFLINE] }],
    ["stopping", modelRow({ waitingSince: ago(90 * MINUTE) }), { state: "stopping", endpoints: [] }],
  ];
  for (const [why, row, observation] of cases) {
    const h = pureDeps({ rows: [row], observation, events: TWO_REFUSALS });
    await runDeploymentStatusTick({ now: NOW }, h.deps);
    assert.equal(h.transitions.filter((t) => t.toStatus === "failed").length, 0, why);
    assert.equal(h.stopped.length, 0, why);
  }
});

test("a row whose run has been billed is never ended as a placement failure: those endings say nothing was charged", async () => {
  // Cannot be reached through the status machine (a waiting row has never
  // been running in its run); the rule holds even so.
  for (const events of [TWO_REFUSALS, []]) {
    const h = pureDeps({
      rows: [modelRow({ billedThisRun: true, waitingSince: ago(2 * DEFAULT_PROVISIONING_LIMIT_MS) })],
      events,
    });
    const result = await runDeploymentStatusTick({ now: NOW }, h.deps);
    assert.equal(h.transitions.length, 0);
    assert.equal(h.stopped.length, 0);
    assert.equal(h.released.length, 0);
    assert.equal(result.placementFailures, 0);
  }
});

test("an agent deployment Nosana cannot place ends the same way", async () => {
  const h = pureDeps({
    rows: [
      {
        kind: "agent",
        id: "ad_1",
        orgId: "org_1",
        status: "deploying",
        nosanaJobIds: ["dm_agent"],
        nosanaAccessMode: "api_key",
        waitingSince: ago(3 * MINUTE),
        reservationCents: 40n,
        reservationReleasedAt: null,
      },
    ],
    observation: { state: "running", endpoints: [] },
    events: TWO_REFUSALS,
  });
  await runDeploymentStatusTick({ now: NOW }, h.deps);
  assert.equal(h.transitions[0]?.toStatus, "failed");
  assert.equal(h.transitions[0]?.reason, LIST_FAILED_REASON);
  assert.deepEqual(h.stopped, [["dm_agent", "api_key"]]);
  assert.deepEqual(h.released.map((r) => r.id), ["ad_1"]);
  assert.equal(h.reports[0]!.kind, "agent");
});

// ---- readiness ----

test("online but not loaded: the model row stays provisioning and unbilled, and its node is marked unhealthy", async () => {
  const h = pureDeps({
    rows: [modelRow({ waitingSince: ago(69_000) })],
    observation: { state: "running", endpoints: [ONLINE], replicas: 1 },
    probe: { healthy: false, latencyMs: 31 },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, h.deps);

  assert.equal(h.transitions.length, 0, "no transition: `running` is what starts billing");
  assert.equal(result.transitioned, 0);
  assert.equal(result.awaitingReadiness, 1);
  assert.deepEqual(h.probed, [{ url: ONLINE.url, engine: "ollama", model: "llama3.2:3b" }], "one probe, told the model");
  assert.deepEqual(h.synced, [[ONLINE]], "the node exists, so its health is visible");
  assert.deepEqual(h.nodeHealth, [{ nodeId: "node_0", healthStatus: "unhealthy" }]);
  assert.equal(h.eventReads.length, 0, "a node serves: there is no listing to explain");
  assert.equal(h.stopped.length, 0);
});

test("loaded: the same row becomes running, with one probe", async () => {
  const h = pureDeps({
    rows: [modelRow({ waitingSince: ago(110_000) })],
    observation: { state: "running", endpoints: [ONLINE], replicas: 1 },
    probe: { healthy: true, latencyMs: 12 },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, h.deps);
  assert.equal(h.transitions.length, 1);
  assert.equal(h.transitions[0]!.toStatus, "running");
  assert.equal(h.transitions[0]!.observedAt, NOW);
  assert.equal(h.probed.length, 1, "the gate's probe is reused for the node");
  assert.deepEqual(h.nodeHealth, [{ nodeId: "node_0", healthStatus: "healthy" }]);
  assert.equal(result.awaitingReadiness, 0);
  assert.equal(result.nodesProbed, 1);
});

test("a degraded row recovers only when a probe is healthy too; a running row is not re-gated", async () => {
  const degraded = pureDeps({
    rows: [modelRow({ status: "degraded" })],
    observation: { state: "running", endpoints: [ONLINE] },
    probe: { healthy: false, latencyMs: 1 },
  });
  await runDeploymentStatusTick({ now: NOW }, degraded.deps);
  assert.equal(degraded.transitions.length, 0);

  const running = pureDeps({
    rows: [modelRow({ status: "running" })],
    observation: { state: "running", endpoints: [ONLINE] },
    probe: { healthy: false, latencyMs: 1 },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, running.deps);
  assert.equal(running.transitions.length, 0, "an unhealthy probe alone does not move a running row");
  assert.equal(result.awaitingReadiness, 0);
});

test("an agent deployment is not gated by the model probe", async () => {
  const h = pureDeps({
    rows: [{ kind: "agent", id: "ad_1", orgId: "org_1", status: "deploying", nosanaJobIds: ["dm_a"], waitingSince: ago(MINUTE) }],
    observation: { state: "running", endpoints: [ONLINE] },
    probe: { healthy: false, latencyMs: 1 },
  });
  await runDeploymentStatusTick({ now: NOW }, h.deps);
  assert.equal(h.transitions[0]?.toStatus, "running");
  assert.equal(h.probed.length, 0);
});

// The second live vLLM run (2026-10-08): the engine answered on the endpoint
// for half an hour while Nosana's record of the job still said QUEUED and the
// endpoint offline. The row sat in `provisioning` until the limit ended it as
// start_timeout. Nosana's flag is a hint; our probe of the endpoint decides.
test("an endpoint Nosana reports offline that answers our probe counts as online: the waiting row becomes running", async () => {
  const h = pureDeps({
    rows: [modelRow({ engine: "vllm", servedModel: "microsoft/Phi-3-mini-4k-instruct" })],
    observation: { state: "running", endpoints: [OFFLINE], replicas: 1 },
    offlineProbe: { healthy: true, latencyMs: 900 },
    events: LISTED(ago(170_000)),
  });
  const result = await runDeploymentStatusTick({ now: NOW }, h.deps);

  assert.equal(h.transitions.length, 1);
  assert.equal(h.transitions[0]!.fromStatus, "provisioning");
  assert.equal(h.transitions[0]!.toStatus, "running");
  assert.deepEqual(
    h.probed,
    [{ url: OFFLINE.url, engine: "vllm", model: "microsoft/Phi-3-mini-4k-instruct" }],
    "one probe: the gate and the node loop reuse it",
  );
  assert.deepEqual(h.synced, [[{ ...OFFLINE, online: true }]], "the endpoint is kept as a node, so requests are routed to it");
  assert.deepEqual(h.nodeHealth, [{ nodeId: "node_0", healthStatus: "healthy" }]);
  assert.equal(result.offlineEndpointsAnswering, 1);
  assert.equal(result.awaitingReadiness, 0);
  assert.equal(result.placementFailures, 0);
  assert.equal(h.eventReads.length, 0, "a row that serves is not a placement question");
  assert.equal(h.stopped.length, 0);
  assert.equal(h.released.length, 0);
});

test("inside the grace period an offline endpoint is not probed: nothing can answer in a deployment's first minute", async () => {
  const h = pureDeps({
    rows: [modelRow({ waitingSince: ago(PROVISIONING_GRACE_MS - 1_000) })],
    offlineProbe: { healthy: true, latencyMs: 900 },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, h.deps);
  assert.equal(h.probed.length, 0);
  assert.equal(h.transitions.length, 0);
  assert.equal(result.offlineEndpointsAnswering, 0);
});

test("an offline endpoint that does not answer changes nothing: the row waits, and the limit still ends it", async () => {
  const waiting = pureDeps({ rows: [modelRow()], events: LISTED(ago(170_000)) });
  let result = await runDeploymentStatusTick({ now: NOW }, waiting.deps);
  assert.equal(waiting.probed.length, 1);
  assert.equal(waiting.transitions.length, 0);
  assert.equal(result.offlineEndpointsAnswering, 0);

  const late = pureDeps({
    rows: [modelRow({ waitingSince: ago(DEFAULT_PROVISIONING_LIMIT_MS + 1_000) })],
    events: LISTED(ago(DEFAULT_PROVISIONING_LIMIT_MS)),
  });
  result = await runDeploymentStatusTick({ now: NOW }, late.deps);
  assert.equal(late.transitions[0]?.toStatus, "failed");
  assert.equal(late.transitions[0]?.reason, START_TIMEOUT_REASON);
  assert.deepEqual(late.stopped, [["dm_1", "api_key"]]);
});

test("a running row whose endpoint Nosana reports offline stays running while the node answers, and is degraded when it does not", async () => {
  const node = { id: "n1", nodeUrl: OFFLINE.url, healthStatus: "healthy" };
  // Nosana's flag dropped (its own health check missed); the node still answers.
  const serving = pureDeps({
    rows: [modelRow({ status: "running", nodes: [node], waitingSince: ago(20 * MINUTE) })],
    offlineProbe: { healthy: true, latencyMs: 300 },
  });
  let result = await runDeploymentStatusTick({ now: NOW }, serving.deps);
  assert.equal(serving.transitions.length, 0, "not degraded on Nosana's word alone");
  assert.equal(result.offlineEndpointsAnswering, 1);
  assert.equal(serving.probed.length, 1, "the probe that decided is reused for the node");

  // Nothing answers there: degraded, as before.
  const gone = pureDeps({
    rows: [modelRow({ status: "running", nodes: [node], waitingSince: ago(20 * MINUTE) })],
  });
  result = await runDeploymentStatusTick({ now: NOW }, gone.deps);
  assert.equal(gone.transitions[0]?.toStatus, "degraded");
  assert.equal(gone.transitions[0]?.reason, "no_live_endpoint");
  assert.equal(result.offlineEndpointsAnswering, 0);
});

// The same benefit of the doubt a node gets when Nosana reports it online: a
// probe that does not know yet (the one-token request is unanswered, the node
// is busy with a customer's answer) does not take a serving node out of service.
test("a running row whose endpoint Nosana reports offline stays running while the probe of its healthy node is pending", async () => {
  const node = { id: "n1", nodeUrl: OFFLINE.url, healthStatus: "healthy" };
  const h = pureDeps({
    rows: [modelRow({ status: "running", nodes: [node], waitingSince: ago(20 * MINUTE) })],
    offlineProbe: { healthy: false, latencyMs: 2004, pending: true },
  });
  const result = await runDeploymentStatusTick({ now: NOW }, h.deps);
  assert.equal(h.transitions.length, 0, "not degraded while the answer is not known");
  assert.deepEqual(h.synced, [[{ ...OFFLINE, online: true }]], "the node is kept, so requests are still routed to it");
  assert.deepEqual(h.nodeHealth, [], "its health is left as it was");
  assert.equal(h.probed.length, 1, "the probe is reused for the node");
  assert.equal(result.offlineEndpointsAnswering, 0, "nothing was seen answering");
  assert.equal(result.nodesUnhealthy, 0);
});

test("a pending probe of an offline endpoint keeps nothing else: not a node that was not healthy, and it never starts or resumes billing", async () => {
  // Running, but the node was not healthy before: no benefit of the doubt.
  for (const healthStatus of ["unhealthy", "unknown"]) {
    const h = pureDeps({
      rows: [
        modelRow({
          status: "running",
          nodes: [{ id: "n1", nodeUrl: OFFLINE.url, healthStatus }],
          waitingSince: ago(20 * MINUTE),
        }),
      ],
      offlineProbe: { healthy: false, latencyMs: 2004, pending: true },
    });
    await runDeploymentStatusTick({ now: NOW }, h.deps);
    assert.equal(h.transitions[0]?.toStatus, "degraded", healthStatus);
    assert.equal(h.transitions[0]?.reason, "no_live_endpoint");
  }

  // Running, healthy node on another URL: the pending endpoint is not that node.
  const other = pureDeps({
    rows: [
      modelRow({
        status: "running",
        nodes: [{ id: "n1", nodeUrl: "https://other.node.nos.ci", healthStatus: "healthy" }],
        waitingSince: ago(20 * MINUTE),
      }),
    ],
    offlineProbe: { healthy: false, latencyMs: 2004, pending: true },
  });
  await runDeploymentStatusTick({ now: NOW }, other.deps);
  assert.equal(other.transitions[0]?.toStatus, "degraded");

  // Degraded and waiting rows: `running` is what bills, and pending is not an answer.
  const node = { id: "n1", nodeUrl: OFFLINE.url, healthStatus: "healthy" };
  for (const status of ["degraded", "provisioning"]) {
    const h = pureDeps({
      rows: [modelRow({ status, nodes: [node], waitingSince: ago(20 * MINUTE) })],
      offlineProbe: { healthy: false, latencyMs: 2004, pending: true },
      events: LISTED(ago(170_000)),
    });
    const result = await runDeploymentStatusTick({ now: NOW }, h.deps);
    assert.equal(h.transitions.length, 0, status);
    assert.equal(result.offlineEndpointsAnswering, 0);
    assert.deepEqual(h.synced.at(-1), [], `${status}: no node is kept on a pending probe`);
  }
});

test("a degraded row comes back when its node answers, whatever Nosana's flag says", async () => {
  const h = pureDeps({
    rows: [modelRow({ status: "degraded", waitingSince: ago(20 * MINUTE) })],
    offlineProbe: { healthy: true, latencyMs: 300 },
  });
  await runDeploymentStatusTick({ now: NOW }, h.deps);
  assert.equal(h.transitions[0]?.fromStatus, "degraded");
  assert.equal(h.transitions[0]?.toStatus, "running");
  assert.equal(h.probed.length, 1);
});

test("offline endpoints are probed for model rows only, never for a mock, and only while Nosana reports the deployment running", async () => {
  const agent = pureDeps({
    rows: [{ ...modelRow(), kind: "agent", status: "deploying", engine: undefined, servedModel: undefined } as DeploymentStatusRow],
    offlineProbe: { healthy: true, latencyMs: 300 },
  });
  await runDeploymentStatusTick({ now: NOW }, agent.deps);
  assert.equal(agent.probed.length, 0, "an agent row has no model probe");

  const starting = pureDeps({
    rows: [modelRow()],
    observation: { state: "starting", endpoints: [OFFLINE], replicas: 1 },
    offlineProbe: { healthy: true, latencyMs: 300 },
  });
  await runDeploymentStatusTick({ now: NOW }, starting.deps);
  assert.equal(starting.probed.length, 0, "Nosana has not started it");
  assert.equal(starting.transitions.length, 0);

  const mock = pureDeps({
    rows: [modelRow()],
    observation: { state: "running", endpoints: [OFFLINE], replicas: 1, mock: true },
    offlineProbe: { healthy: true, latencyMs: 300 },
  });
  await runDeploymentStatusTick({ now: NOW }, mock.deps);
  assert.equal(mock.probed.length, 0);
});

test("a model that never loads is ended at the limit as start_timeout, without reading events", async () => {
  const h = pureDeps({
    rows: [modelRow({ waitingSince: ago(31 * MINUTE) })],
    observation: { state: "running", endpoints: [ONLINE] },
    probe: { healthy: false, latencyMs: 1 },
  });
  await runDeploymentStatusTick({ now: NOW }, h.deps);
  assert.equal(h.transitions[0]?.toStatus, "failed");
  assert.equal(h.transitions[0]?.reason, START_TIMEOUT_REASON);
  assert.equal(h.eventReads.length, 0);
  assert.deepEqual(h.stopped, [["dm_1", "api_key"]]);
  assert.equal(h.released.length, 1);
  assert.deepEqual(h.synced.at(-1), [], "its node is removed");
});

// ============================================
// The whole chain: real client, stand-in Nosana, a database with money
// ============================================

type Client = InstanceType<typeof NosanaClient>;

async function apiClient(): Promise<Client> {
  resetNosanaAccessConfigForTests();
  resetNosanaDeployConfigForTests();
  const client = new NosanaClient();
  await client.initialize();
  return client;
}

function resetFake() {
  fake.setBalance({ assignedCredits: 100, reservedCredits: 0, settledCredits: 0 });
  fake.setMarkets(FAKE_MARKETS);
  fake.setInsufficientFunds(false);
  fake.deployments.clear();
  fake.requests.length = 0;
  resetPlacementFailuresForTests();
}

function sent(method: string, path: RegExp) {
  return fake.requests.filter((r) => r.method === method && path.test(r.path));
}

interface Row {
  id: string;
  orgId: string;
  status: string;
  engine: string;
  gpuTier: string;
  nosanaJobIds: string[];
  nosanaAccessMode: string | null;
  runGeneration: number;
  replicas: number;
  updatedAt: Date;
  stoppedAt: Date | null;
  statusReason: string | null;
  billedThroughAt: Date | null;
  vaultReclaimedAt: Date | null;
  reservationCents: bigint | null;
  reservationReleasedAt: Date | null;
  model: { hfId: string };
}

/** A where clause of the few shapes the composition root sends. */
function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, want]) => {
    const have = row[key];
    if (want === null || typeof want !== "object" || want instanceof Date) return have === want;
    const w = want as Record<string, unknown>;
    if ("in" in w) return (w.in as unknown[]).includes(have);
    if ("isEmpty" in w) return (Array.isArray(have) && have.length === 0) === w.isEmpty;
    if ("has" in w) return Array.isArray(have) && have.includes(w.has);
    if ("gt" in w) return have !== null && have !== undefined && (have as bigint) > (w.gt as bigint);
    if ("gte" in w) return have instanceof Date && have.getTime() >= (w.gte as Date).getTime();
    throw new Error(`test database: unsupported where on ${key}`);
  });
}

function moneyDb(seed: Partial<Row> & { nosanaJobIds: string[] }, balanceCents = 910n) {
  const row: Row = {
    id: "0f6f1a3e-1111-4222-8333-444455556666",
    orgId: "org_1",
    status: "provisioning",
    engine: "ollama",
    gpuTier: "4090",
    nosanaAccessMode: "api_key",
    runGeneration: 0,
    replicas: 1,
    updatedAt: new Date(),
    stoppedAt: null,
    statusReason: null,
    billedThroughAt: null,
    vaultReclaimedAt: null,
    reservationCents: 90n,
    reservationReleasedAt: null,
    model: { hfId: "meta-llama/Llama-3.2-3B-Instruct" },
    ...seed,
  };
  const nodes: Array<{ id: string; deploymentId: string; nodeUrl: string; healthStatus: string }> = [];
  const ledger: Array<{ type: string; amountCents: bigint; referenceId: string; balanceAfter: bigint }> = [];
  const state = { balanceCents };
  const prisma = {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
    agentDeployment: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    deployment: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        matches(row as never, where) ? [{ ...row, nodes: nodes.filter((n) => n.deploymentId === row.id) }] : [],
      findFirst: async ({ where }: { where: Record<string, unknown> }) => (matches(row as never, where) ? row : null),
      findUnique: async () => row,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        if (!matches(row as never, where)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    deploymentNode: {
      findMany: async () => nodes.slice(),
      create: async ({ data }: { data: { deploymentId: string; nodeUrl: string; healthStatus: string } }) => {
        const node = { id: `n${nodes.length + 1}`, ...data };
        nodes.push(node);
        return node;
      },
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        const before = nodes.length;
        for (const id of where.id.in) {
          const at = nodes.findIndex((n) => n.id === id);
          if (at >= 0) nodes.splice(at, 1);
        }
        return { count: before - nodes.length };
      },
      updateMany: async ({ where, data }: { where: { id: string }; data: { healthStatus: string } }) => {
        const node = nodes.find((n) => n.id === where.id);
        if (node) node.healthStatus = data.healthStatus;
        return { count: node ? 1 : 0 };
      },
    },
    creditBalance: {
      update: async ({ data }: { data: { balanceCents: { increment: bigint } } }) => {
        state.balanceCents += data.balanceCents.increment;
        return { balanceCents: state.balanceCents };
      },
    },
    creditTransaction: {
      create: async ({ data }: { data: (typeof ledger)[number] }) => {
        ledger.push(data);
        return {};
      },
    },
  };
  return { prisma, row, nodes, ledger, state };
}

/** The dependencies as queues/deployment-status.queue.ts wires them; only the node probe is injected. */
function chainDeps(
  client: Client,
  db: ReturnType<typeof moneyDb>,
  probe: (url: string, engine?: string, model?: string) => Promise<{ healthy: boolean; latencyMs: number }>,
  now: () => Date,
) {
  return buildDeploymentStatusTickDeps({
    prisma: db.prisma as never,
    getDeploymentStatus: (id, mode) => client.getDeploymentStatus(id, mode, { jobs: false, events: "when_halted" }),
    checkNodeHealth: probe,
    servedModelName,
    listDeploymentEvents: (id, mode) => client.listDeploymentEvents(id, mode),
    reportPlacementFailure: recordPlacementFailure,
    reclaimVault: (id, mode, options) => client.reclaimDeploymentVault(id, mode, options),
    stopDeployment: (id, mode) => client.stopDeployment(id, mode),
    allowMock: false,
    emitTransition: async () => undefined,
    now,
  });
}

async function call(method: string, path: string): Promise<number> {
  const response = await fetch(`${fake.url}${path}`, { method, headers: { Authorization: `Bearer ${fake.apiKey}` } });
  await response.text();
  return response.status;
}

test("attempt 1 of the live run, end to end: ten minutes of timeout, RUNNING with a failing listing -> failed with a reason, stopped, the hold back once, nothing charged", async () => {
  resetFake();
  const client = await apiClient();
  // A deployment as Nosana held it on 2026-10-08: created with timeout 10
  // (minutes). The service can no longer create one (see the next test), so
  // it is placed in the stand-in as it was.
  const seeded = fake.seedDeployment({
    name: "wheelsai-model-0f6f1a3e-1111-4222-8333-444455556666-r0",
    status: "DRAFT",
    market: M4090,
    timeout: 10,
    endpoints: [{ opId: "ollama-inference", port: 11434, url: "https://attempt1.node.k8s.prd.nos.ci", online: false }],
  });
  assert.equal(await call("POST", `/api/deployments/${seeded.id}/start`), 200);
  assert.equal(seeded.status, "RUNNING", "Nosana says RUNNING at once");

  const started = new Date();
  let clock = started;
  const db = moneyDb({ nosanaJobIds: [seeded.id], updatedAt: started });
  const probes: string[] = [];
  // No node ever takes this job: whatever is asked of its endpoint, nothing answers.
  const deps = chainDeps(client, db, async (url) => (probes.push(url), { healthy: false, latencyMs: 700 }), () => clock);

  // 30 seconds in: inside the grace period, nothing is asked beyond the status.
  clock = new Date(started.getTime() + 30_000);
  fake.requests.length = 0;
  let tick = await runDeploymentStatusTick({ now: clock }, deps);
  assert.equal(tick.transitioned, 0);
  assert.equal(sent("GET", /\/events$/).length, 0);
  assert.equal(probes.length, 0, "and the endpoint is not probed yet");

  // 90 seconds in: one refused attempt so far. Read, and left to Nosana's next try.
  clock = new Date(started.getTime() + 90_000);
  tick = await runDeploymentStatusTick({ now: clock }, deps);
  assert.equal(sent("GET", /\/events$/).length, 1);
  assert.equal(tick.transitioned, 0);
  assert.equal(db.row.status, "provisioning");

  // Three minutes in Nosana has tried again: the same pair of events.
  assert.equal(fake.attemptList(seeded.id), null);
  clock = new Date(started.getTime() + 180_000);
  fake.requests.length = 0;
  tick = await runDeploymentStatusTick({ now: clock }, deps);

  assert.equal(tick.transitioned, 1);
  assert.equal(tick.placementFailures, 1);
  assert.equal(db.row.status, "failed");
  assert.equal(db.row.statusReason, "nosana_list_failed", "a stable code the dashboard explains");
  assert.deepEqual(db.row.stoppedAt, clock);
  // Stopped on Nosana in the same pass, once.
  assert.equal(sent("POST", new RegExp(`/${seeded.id}/stop$`)).length, 1);
  assert.equal(fake.deployments.get(seeded.id)!.status, "STOPPING");
  assert.equal(tick.haltedStops, 1);
  // The hold is back, once; nothing else moved.
  assert.equal(db.state.balanceCents, 1_000n);
  assert.deepEqual(
    db.ledger.map((l) => [l.type, l.amountCents, l.referenceId, l.balanceAfter]),
    [["deployment_reservation_release", 90n, db.row.id, 1_000n]],
  );
  assert.deepEqual(db.row.reservationReleasedAt instanceof Date, true);
  assert.equal(db.row.billedThroughAt, null, "never billed: it never ran");
  assert.deepEqual(
    [...new Set(probes)],
    ["https://attempt1.node.k8s.prd.nos.ci"],
    "after the grace period the endpoint Nosana reports offline is probed; nothing answers there",
  );
  assert.equal(tick.offlineEndpointsAnswering, 0);
  assert.equal(db.nodes.length, 0, "no node was ever created");
  // Nosana debited nothing either.
  assert.deepEqual(fake.balance(), { assignedCredits: 100, reservedCredits: 0, settledCredits: 0 });

  // Nosana's own message: recorded for the operator, not on the row.
  const seen = recentPlacementFailures();
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.detail, creditTimeoutListError(10));
  assert.equal(seen[0]!.reason, "nosana_list_failed");
  assert.equal(seen[0]!.id, db.row.id);
  assert.equal(
    Object.values(db.row).some((value) => typeof value === "string" && value.includes("Credit-paid")),
    false,
    "the customer's row carries the code only",
  );

  // Later ticks: the row is terminal, nothing is released or stopped twice.
  // The sweep waits for Nosana to finish stopping, then marks it released.
  clock = new Date(started.getTime() + 210_000);
  tick = await runDeploymentStatusTick({ now: clock }, deps);
  assert.equal(tick.transitioned, 0);
  assert.equal(tick.reservationsReleased, 0);
  assert.equal(tick.vaultsPending, 1);
  assert.equal(sent("POST", new RegExp(`/${seeded.id}/stop$`)).length, 1, "no second stop while it is stopping");
  fake.settle(seeded.id);
  clock = new Date(started.getTime() + 240_000);
  tick = await runDeploymentStatusTick({ now: clock }, deps);
  assert.equal(tick.vaultsReclaimed, 1);
  assert.equal(db.ledger.length, 1, "one ledger row for the one balance change");
  assert.equal(db.state.balanceCents, 1_000n);

  // The operator view lists it with Nosana's message.
  const view = await computePlatformCompute(
    buildPlatformComputeDeps({
      getClient: async () => client,
      prisma: {
        deployment: {
          findMany: async ({ where }: { where: Record<string, unknown> }) =>
            "statusReason" in where && matches(db.row as never, where) ? [db.row] : [],
        },
        agentDeployment: { findMany: async () => [] },
        trainingJob: { findMany: async () => [] },
        openClawDeployment: { findMany: async () => [] },
        nosanaOrphanDeployment: { findMany: async () => [] },
      } as never,
      getAccessConfig: getNosanaAccessConfig,
      adminKey: () => "k",
      observedPlacementFailures: recentPlacementFailures,
      now: () => clock,
    }),
  );
  assert.equal(view.placementFailures.state, "ok");
  assert.deepEqual(view.placementFailures.rows, [
    {
      source: "model",
      rowId: db.row.id,
      nosanaDeploymentId: seeded.id,
      reason: "nosana_list_failed",
      failedAt: db.row.stoppedAt!.toISOString(),
      detail: creditTimeoutListError(10),
    },
  ]);
});

test("attempt 2 of the live run, end to end: 50 minutes, a job listed and reserved, online before the model is loaded -> provisioning and unbilled until /api/ps lists it", async () => {
  resetFake();
  const client = await apiClient();
  const definition = generateJobDefinition({
    modelId: "llama-3.2-3b",
    hfModelId: "meta-llama/Llama-3.2-3B-Instruct",
    engine: "ollama",
    maxTokens: 4096,
    gpuMemoryUtilization: 0.9,
  });
  const created = await client.createDeployment(definition, "4090", 1, {
    name: "wheelsai-model-0f6f1a3e-1111-4222-8333-444455556666-r1",
  });
  const onNosana = fake.deployments.get(created.id)!;
  assert.equal(onNosana.timeout, 50, "3000 seconds, sent in minutes");
  assert.equal(onNosana.status, "RUNNING");
  assert.equal(onNosana.events.length, 0, "no refused listing");

  const started = new Date();
  let clock = started;
  const db = moneyDb({ nosanaJobIds: [created.id], updatedAt: started, runGeneration: 1 });
  // What the node's GET /api/ps answers; the probe itself is the service's own reading of it.
  let ps: unknown = { models: [] };
  const probed: Array<[string, string | undefined, string | undefined]> = [];
  const deps = chainDeps(
    client,
    db,
    async (url, engine, model) => {
      probed.push([url, engine, model]);
      return { healthy: ollamaModelLoaded(ps, model), latencyMs: 20 };
    },
    () => clock,
  );

  // A node takes the job: the reservation is 50 minutes at the host price.
  assert.ok(fake.attemptList(created.id));
  assert.equal(fake.balance().reservedCredits, 0.303);
  assert.deepEqual(fake.creditRows.at(-1)!.amountUsd, 0.303);

  // 69 seconds after create the endpoint is online. The server answers; the
  // model is pulled but not in GPU memory.
  fake.setEndpointsOnline(created.id, true);
  clock = new Date(started.getTime() + 69_000);
  let tick = await runDeploymentStatusTick({ now: clock }, deps);
  assert.equal(tick.transitioned, 0);
  assert.equal(tick.awaitingReadiness, 1);
  assert.equal(db.row.status, "provisioning", "not running: the first request would wait for the load");
  assert.equal(db.row.billedThroughAt, null, "and not billed");
  assert.deepEqual(probed, [[onNosana.endpoints[0]!.url, "ollama", "llama3.2:3b"]], "asked for the deployment's own model");
  assert.deepEqual(db.nodes.map((n) => n.healthStatus), ["unhealthy"], "/v1 routes only to healthy nodes");
  assert.equal(sent("GET", /\/events$/).length, 0, "nothing to explain: a node serves");

  // Another model loaded is not this deployment's model.
  ps = { models: [{ name: "mistral:7b", model: "mistral:7b" }] };
  clock = new Date(started.getTime() + 99_000);
  tick = await runDeploymentStatusTick({ now: clock }, deps);
  assert.equal(db.row.status, "provisioning");

  // The preload has finished: the model is listed, with its VRAM.
  ps = { models: [{ name: "llama3.2:3b", model: "llama3.2:3b", size_vram: 5_980_000_000 }] };
  clock = new Date(started.getTime() + 129_000);
  tick = await runDeploymentStatusTick({ now: clock }, deps);
  assert.equal(tick.transitioned, 1);
  assert.equal(db.row.status, "running");
  assert.deepEqual(db.row.billedThroughAt, clock, "billing starts when the model can answer");
  assert.equal(db.row.statusReason, null);
  assert.deepEqual(db.nodes.map((n) => n.healthStatus), ["healthy"]);
  assert.equal(db.ledger.length, 0, "the hold is untouched while it runs");
  assert.equal(recentPlacementFailures().length, 0);
});

test("the service can no longer create attempt 1: with the API key paying, a ten-minute timeout stops at the configuration", async () => {
  resetFake();
  const saved = process.env.NOSANA_JOB_TIMEOUT_SECONDS;
  process.env.NOSANA_JOB_TIMEOUT_SECONDS = "600";
  try {
    const client = await apiClient();
    await assert.rejects(
      client.createDeployment({ version: "0.1", type: "container", meta: { trigger: "wheelsai" }, ops: [] } as never, "4090", 1, {
        name: "wheelsai-ten-minutes",
      }),
      /NOSANA_JOB_TIMEOUT_SECONDS=600 is below 3000/,
    );
    assert.equal(sent("POST", /deployments\/create$/).length, 0, "nothing reached Nosana");
  } finally {
    process.env.NOSANA_JOB_TIMEOUT_SECONDS = saved;
    resetNosanaDeployConfigForTests();
  }
});

test("the operator's record of placement failures is bounded and newest first", () => {
  resetPlacementFailuresForTests();
  for (let i = 0; i < MAX_PLACEMENT_FAILURES + 5; i += 1) {
    recordPlacementFailure({
      kind: "model",
      id: `dep_${i}`,
      orgId: "o",
      nosanaDeploymentId: `dm_${i}`,
      reason: "no_capacity",
      waitedSeconds: 1_800,
      observedAt: new Date(NOW.getTime() + i),
    });
  }
  const kept = recentPlacementFailures();
  assert.equal(kept.length, MAX_PLACEMENT_FAILURES);
  assert.equal(kept[0]!.id, `dep_${MAX_PLACEMENT_FAILURES + 4}`);
  resetPlacementFailuresForTests();
  assert.equal(recentPlacementFailures().length, 0);
});

test("the composition root: rows carry their waiting time and served model, agents get the sentence, and the probe is told the model", async () => {
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const updatedAt = ago(4 * MINUTE);
  const probeArgs: unknown[][] = [];
  const deps = buildDeploymentStatusTickDeps({
    prisma: {
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
      agentDeployment: {
        findMany: async () => [
          { id: "ad_1", status: "deploying", nosanaJobIds: ["dm_a"], nosanaAccessMode: "api_key", updatedAt, reservationCents: null, reservationReleasedAt: null, agent: { orgId: "org_1" } },
        ],
        updateMany: async (args: { where: unknown; data: Record<string, unknown> }) => {
          updates.push(args);
          return { count: 1 };
        },
      },
      deployment: {
        findMany: async () => [
          {
            id: "dep_1",
            orgId: "org_1",
            status: "provisioning",
            engine: "ollama",
            nosanaJobIds: ["dm_m"],
            nosanaAccessMode: "api_key",
            updatedAt,
            billedThroughAt: null,
            model: { hfId: "meta-llama/Llama-3.2-3B-Instruct" },
            runGeneration: 0,
            replicas: 1,
            reservationCents: 90n,
            reservationReleasedAt: null,
            nodes: [],
          },
        ],
        updateMany: async (args: { where: unknown; data: Record<string, unknown> }) => {
          updates.push(args);
          return { count: 1 };
        },
      },
      deploymentNode: {},
    } as never,
    getDeploymentStatus: async () => {
      throw new Error("not read here");
    },
    checkNodeHealth: async (...args) => {
      probeArgs.push(args);
      return { healthy: true, latencyMs: 1 };
    },
    servedModelName,
    listDeploymentEvents: async () => [
      { type: "JOB_LIST_ERROR", message: LIVE_MESSAGE, createdAt: NOW.toISOString(), tx: "abc" },
    ],
    allowMock: false,
    emitTransition: async () => undefined,
  });

  const rows = await deps.loadDeployments();
  const agent = rows.find((r) => r.kind === "agent")!;
  const model = rows.find((r) => r.kind === "model")!;
  assert.deepEqual(agent.waitingSince, updatedAt);
  assert.deepEqual(model.waitingSince, updatedAt);
  assert.equal(model.servedModel, "llama3.2:3b");
  assert.equal(agent.servedModel, undefined);
  assert.equal(model.billedThisRun, undefined, "no billing cursor: never billed in this run");

  assert.deepEqual(await deps.readPlacementEvents!("dm_m", "api_key"), [
    { type: "JOB_LIST_ERROR", message: LIVE_MESSAGE, createdAt: NOW.toISOString() },
  ]);
  await deps.checkNodeHealth("https://x.node.k8s.prd.nos.ci", "ollama", "llama3.2:3b");
  assert.deepEqual(probeArgs, [["https://x.node.k8s.prd.nos.ci", "ollama", "llama3.2:3b"]]);

  // A model row stores the code; Nosana's text is not written anywhere a customer reads.
  await deps.persistTransition({
    kind: "model", id: "dep_1", orgId: "org_1", fromStatus: "provisioning", toStatus: "failed",
    observedAt: NOW, reason: "nosana_list_failed", detail: LIVE_MESSAGE, runGeneration: 0,
  });
  assert.equal(updates[0]!.data.statusReason, "nosana_list_failed");
  assert.equal(JSON.stringify(updates[0]!.data).includes("Credit-paid"), false);
  // An agent deployment shows its lastError to the customer: the sentence.
  await deps.persistTransition({
    kind: "agent", id: "ad_1", orgId: "org_1", fromStatus: "deploying", toStatus: "failed",
    observedAt: NOW, reason: "no_capacity", detail: LIVE_MESSAGE,
  });
  assert.equal(updates[1]!.data.lastError, PLACEMENT_FAILURE_SENTENCES.no_capacity);
});
