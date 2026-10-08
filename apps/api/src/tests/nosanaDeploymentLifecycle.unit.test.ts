import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_STOP_READ_RETRY,
  NosanaLifecycleError,
  UnknownDeploymentStatusError,
  createAndStartDeployment,
  ensureVaultRunway,
  isNetworkFailure,
  normalizeEndpoints,
  normalizeStatus,
  planVaultFunding,
  readDeployment,
  reclaimVault,
  scaleDeployment,
  stopAndReclaim,
  toBaseUnits,
  withdrawAndVerify,
  type CreateDeploymentBody,
  type NosanaDeploymentsPort,
  type SdkDeploymentLike,
} from "../services/nosanaDeploymentLifecycle.js";

// Drives apps/api/src/services/nosanaDeploymentLifecycle.ts - the pure
// lifecycle (create -> fund -> start -> observe -> scale -> stop -> reclaim)
// over an injected port. No SDK, no network, no wallet.

// ============================================
// Fakes
// ============================================

interface FakeOptions {
  id?: string;
  status?: string;
  replicas?: number;
  endpoints?: SdkDeploymentLike["endpoints"];
  jobs?: SdkDeploymentLike["jobs"];
  events?: SdkDeploymentLike["events"];
  /** Vault starts with this much NOS (base units) / SOL (lamports). */
  nosBaseUnits?: number;
  solLamports?: number;
  topupError?: Error;
  startError?: Error;
  stopError?: Error;
  updateReplicaError?: Error;
  /** withdraw() rejects. */
  withdrawError?: Error;
  /** withdraw() resolves but moves no funds (the SDK swallows failed txs). */
  withdrawSwallows?: boolean;
  balanceError?: Error;
}

function fakeDeployment(opts: FakeOptions = {}) {
  const calls: string[] = [];
  const vault = { nos: opts.nosBaseUnits ?? 0, sol: opts.solLamports ?? 0 };
  const topups: Array<{ NOS?: number; SOL?: number; lamports?: boolean }> = [];
  const state = { status: opts.status ?? "DRAFT", replicas: opts.replicas ?? 1 };

  const deployment: SdkDeploymentLike & {
    calls: string[];
    topups: typeof topups;
    vault: any;
    /** What Nosana reports from now on. */
    setStatus(status: string): void;
  } = {
    id: opts.id ?? "dep_1",
    setStatus(status: string) {
      state.status = status;
    },
    get status() {
      return state.status;
    },
    get replicas() {
      return state.replicas;
    },
    endpoints: opts.endpoints,
    jobs: opts.jobs,
    events: opts.events,
    calls,
    topups,
    vault: {
      publicKey: { toBase58: () => "VaultPubkey1111111111111111111111111111111111" },
      async topup(options: { NOS?: number; SOL?: number; lamports?: boolean }) {
        calls.push("topup");
        topups.push(options);
        if (opts.topupError) throw opts.topupError;
        vault.nos += options.NOS ?? 0;
        vault.sol += options.SOL ?? 0;
      },
      async getBalance() {
        calls.push("getBalance");
        if (opts.balanceError) throw opts.balanceError;
        return { SOL: vault.sol / 1e9, NOS: vault.nos / 1e6 };
      },
      async withdraw() {
        calls.push("withdraw");
        if (opts.withdrawError) throw opts.withdrawError;
        if (opts.withdrawSwallows) return;
        vault.nos = 0;
        vault.sol = 0;
      },
    },
    async start() {
      calls.push("start");
      if (opts.startError) throw opts.startError;
      state.status = "STARTING";
    },
    async stop() {
      calls.push("stop");
      if (opts.stopError) throw opts.stopError;
      state.status = "STOPPING";
    },
    async updateReplicaCount(n: number) {
      calls.push(`updateReplicaCount:${n}`);
      if (opts.updateReplicaError) throw opts.updateReplicaError;
      state.replicas = n;
    },
  };
  return deployment;
}

function fakePort(
  deployment: ReturnType<typeof fakeDeployment>,
  over: {
    jobPrice?: bigint;
    priceError?: Error;
    createError?: Error;
    getError?: Error;
  } = {},
) {
  const calls: string[] = [];
  const bodies: CreateDeploymentBody[] = [];
  const port: NosanaDeploymentsPort = {
    async getMarketJobPrice(market) {
      calls.push(`price:${market}`);
      if (over.priceError) throw over.priceError;
      return over.jobPrice ?? 202n;
    },
    async create(body) {
      calls.push("create");
      bodies.push(body);
      if (over.createError) throw over.createError;
      return deployment;
    },
    async get(id) {
      calls.push(`get:${id}`);
      if (over.getError) throw over.getError;
      return deployment;
    },
  };
  return { port, calls, bodies };
}

const BASE_PARAMS = {
  name: "wheelsai-abc",
  marketAddress: "97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf",
  replicas: 2,
  jobTimeoutSeconds: 7200,
  definition: { version: "0.1", type: "container", ops: [] },
  fundSeconds: 14_400,
  solFeeLamportsPerReplica: 10_000_000n,
};

// ============================================
// planVaultFunding - exact bigint math
// ============================================

test("planVaultFunding: exact NOS base units and lamports, fee on top of jobPrice", () => {
  // 4090 market: jobPrice 202 base units/s. 202 x 1.10 = 222.2/s; x 2 replicas
  // x 14400 s = 6,399,360 base units (= 6.39936 NOS) with no rounding.
  const plan = planVaultFunding({
    jobPriceBaseUnitsPerSecond: 202n,
    replicas: 2,
    fundSeconds: 14_400,
    solFeeLamportsPerReplica: 10_000_000n,
  });
  assert.equal(plan.nosBaseUnits, 6_399_360n);
  assert.equal(plan.solLamports, 20_000_000n);
  assert.equal(plan.nosBaseUnitsPerSecondPerReplica, 223n, "222.2 rounds UP to 223");
});

test("planVaultFunding: a single ceil at the end, never per-second truncation", () => {
  // 1 base unit/s x 1.10 = 1.1/s; 3 s => 3.3 => 4 (ceil), not 3.
  const plan = planVaultFunding({
    jobPriceBaseUnitsPerSecond: 1n,
    replicas: 1,
    fundSeconds: 3,
    solFeeLamportsPerReplica: 0n,
  });
  assert.equal(plan.nosBaseUnits, 4n);
  assert.equal(plan.solLamports, 0n);
});

test("planVaultFunding: explicit fee, zero fee and the H100 price", () => {
  assert.equal(
    planVaultFunding({
      jobPriceBaseUnitsPerSecond: 757n,
      replicas: 1,
      fundSeconds: 3600,
      solFeeLamportsPerReplica: 1n,
      networkFeeBps: 0,
    }).nosBaseUnits,
    757n * 3600n,
  );
  assert.equal(
    planVaultFunding({
      jobPriceBaseUnitsPerSecond: 757n,
      replicas: 1,
      fundSeconds: 3600,
      solFeeLamportsPerReplica: 1n,
      networkFeeBps: 1000,
    }).nosBaseUnits,
    // 757 x 1.1 x 3600 = 2,997,720 exactly
    2_997_720n,
  );
});

test("planVaultFunding: handles values beyond 2^53 without precision loss", () => {
  const huge = 9_007_199_254_740_993n; // 2^53 + 1
  const plan = planVaultFunding({
    jobPriceBaseUnitsPerSecond: huge,
    replicas: 1,
    fundSeconds: 1,
    solFeeLamportsPerReplica: 0n,
    networkFeeBps: 0,
  });
  assert.equal(plan.nosBaseUnits, huge);
});

test("planVaultFunding rejects invalid inputs instead of guessing", () => {
  const ok = { jobPriceBaseUnitsPerSecond: 1n, replicas: 1, fundSeconds: 10, solFeeLamportsPerReplica: 1n };
  assert.throws(() => planVaultFunding({ ...ok, replicas: 0 }), RangeError);
  assert.throws(() => planVaultFunding({ ...ok, replicas: 1.5 }), RangeError);
  assert.throws(() => planVaultFunding({ ...ok, fundSeconds: 0 }), RangeError);
  assert.throws(() => planVaultFunding({ ...ok, jobPriceBaseUnitsPerSecond: -1n }), RangeError);
  assert.throws(() => planVaultFunding({ ...ok, networkFeeBps: -1 }), RangeError);
  assert.throws(() => planVaultFunding({ ...ok, solFeeLamportsPerReplica: -1n }), RangeError);
});

test("toBaseUnits accepts bigint / safe int / decimal string / BN-like and rejects the rest", () => {
  assert.equal(toBaseUnits(24n), 24n);
  assert.equal(toBaseUnits(24), 24n);
  assert.equal(toBaseUnits("757"), 757n);
  assert.equal(toBaseUnits({ toString: () => "202" }), 202n, "anchor BN exposes toString()");
  assert.throws(() => toBaseUnits(1.5), RangeError);
  assert.throws(() => toBaseUnits(-1), RangeError);
  assert.throws(() => toBaseUnits("abc"), RangeError);
  assert.throws(() => toBaseUnits(undefined), RangeError);
  assert.throws(() => toBaseUnits({}), RangeError);
});

// ============================================
// createAndStartDeployment
// ============================================

test("createAndStart: price -> create(confidential) -> topup(lamports) -> start, in that order", async () => {
  const dep = fakeDeployment();
  const { port, calls, bodies } = fakePort(dep, { jobPrice: 202n });

  const result = await createAndStartDeployment(port, BASE_PARAMS);

  assert.deepEqual(calls, [`price:${BASE_PARAMS.marketAddress}`, "create"]);
  assert.deepEqual(dep.calls, ["topup", "start"]);

  assert.equal(bodies.length, 1);
  const body = bodies[0]!;
  assert.equal(body.confidential, true, "job definitions must not be pinned to public IPFS");
  assert.equal(body.strategy, "SIMPLE-EXTEND");
  assert.equal(body.timeout, 7200, "short per-job timeout, not 30 days");
  assert.equal(body.replicas, 2);
  assert.equal(body.market, BASE_PARAMS.marketAddress);
  assert.equal(body.name, "wheelsai-abc");
  assert.deepEqual(body.job_definition, BASE_PARAMS.definition);

  assert.equal(dep.topups.length, 1);
  assert.deepEqual(dep.topups[0], { NOS: 6_399_360, SOL: 20_000_000, lamports: true });

  assert.equal(result.deploymentId, "dep_1");
  assert.equal(result.vaultAddress, "VaultPubkey1111111111111111111111111111111111");
  assert.equal(result.funding.nosBaseUnits, 6_399_360n);
  assert.equal(result.strategy, "SIMPLE-EXTEND");
});

test("createAndStart: strategy and network fee are honoured", async () => {
  const dep = fakeDeployment();
  const { port, bodies } = fakePort(dep, { jobPrice: 1000n });
  await createAndStartDeployment(port, {
    ...BASE_PARAMS,
    replicas: 1,
    strategy: "INFINITE",
    networkFeeBps: 0,
  });
  assert.equal(bodies[0]!.strategy, "INFINITE");
  assert.equal(dep.topups[0]!.NOS, 1000 * 14_400);
});

test("createAndStart: topup failure stops + withdraws, never starts, and rethrows with the id", async () => {
  const dep = fakeDeployment({ topupError: new Error("insufficient SOL") });
  const { port } = fakePort(dep);

  await assert.rejects(
    () => createAndStartDeployment(port, BASE_PARAMS),
    (err: unknown) => {
      assert.ok(err instanceof NosanaLifecycleError);
      assert.equal(err.stage, "topup");
      assert.equal(err.deploymentId, "dep_1", "caller needs the id to retry the reclaim");
      assert.match(err.message, /insufficient SOL/);
      assert.match(err.message, /dep_1/);
      assert.equal(err.cleanup?.stopped, true);
      assert.equal(err.cleanup?.reclaimed, true, "empty vault verified at zero NOS");
      return true;
    },
  );
  assert.ok(dep.calls.includes("stop"), "stop attempted");
  assert.ok(dep.calls.includes("withdraw"), "withdraw attempted");
  assert.ok(!dep.calls.includes("start"), "a deployment that could not be funded must never start");
});

test("createAndStart: start failure stops + withdraws the funded vault and rethrows", async () => {
  const dep = fakeDeployment({ startError: new Error("deployment manager 500") });
  const { port } = fakePort(dep);

  await assert.rejects(
    () => createAndStartDeployment(port, BASE_PARAMS),
    (err: unknown) => {
      assert.ok(err instanceof NosanaLifecycleError);
      assert.equal(err.stage, "start");
      assert.equal(err.deploymentId, "dep_1");
      assert.equal(err.cleanup?.stopped, true);
      assert.equal(err.cleanup?.reclaimed, true, "the funded vault was emptied and verified");
      return true;
    },
  );
  // topup happened first, then start failed, then stop + withdraw
  assert.deepEqual(
    dep.calls.filter((c) => c !== "getBalance"),
    ["topup", "start", "stop", "withdraw"],
  );
});

test("createAndStart: failed cleanup is REPORTED (reclaimed=false), not hidden", async () => {
  const dep = fakeDeployment({
    startError: new Error("boom"),
    stopError: new Error("cannot stop"),
    withdrawSwallows: true, // the SDK swallows a failed withdraw tx
  });
  const { port } = fakePort(dep);

  await assert.rejects(
    () => createAndStartDeployment(port, BASE_PARAMS),
    (err: unknown) => {
      assert.ok(err instanceof NosanaLifecycleError);
      assert.equal(err.cleanup?.stopped, false);
      assert.equal(err.cleanup?.reclaimed, false, "funds still in the vault must not be reported reclaimed");
      assert.ok(err.cleanup!.errors.some((e) => e.startsWith("stop:")));
      return true;
    },
  );
});

test("createAndStart: an unreadable market price fails BEFORE anything is created", async () => {
  const dep = fakeDeployment();
  const { port, calls } = fakePort(dep, { priceError: new Error("account not found") });

  await assert.rejects(
    () => createAndStartDeployment(port, BASE_PARAMS),
    (err: unknown) => err instanceof NosanaLifecycleError && err.stage === "market_price",
  );
  assert.ok(!calls.includes("create"), "no draft deployment for a market we cannot price");
  assert.deepEqual(dep.calls, []);
});

test("createAndStart: a create failure needs no cleanup and carries no deployment id", async () => {
  const dep = fakeDeployment();
  const { port } = fakePort(dep, { createError: new Error("400 invalid job definition") });

  await assert.rejects(
    () => createAndStartDeployment(port, BASE_PARAMS),
    (err: unknown) => {
      assert.ok(err instanceof NosanaLifecycleError);
      assert.equal(err.stage, "create");
      assert.equal(err.deploymentId, undefined);
      return true;
    },
  );
  assert.deepEqual(dep.calls, []);
});

test("createAndStart refuses to under-fund: fundSeconds below the job timeout", async () => {
  const dep = fakeDeployment();
  const { port, calls } = fakePort(dep);
  await assert.rejects(
    () => createAndStartDeployment(port, { ...BASE_PARAMS, fundSeconds: 3600 }),
    RangeError,
  );
  assert.deepEqual(calls, [], "validated before any network call");
});

// ============================================
// readDeployment / normalisation
// ============================================

test("normalizeStatus maps every SDK status and is case-insensitive", () => {
  const expected: Record<string, string> = {
    DRAFT: "draft",
    ERROR: "error",
    STARTING: "starting",
    RUNNING: "running",
    STOPPING: "stopping",
    STOPPED: "stopped",
    INSUFFICIENT_FUNDS: "insufficient_funds",
    ARCHIVED: "archived",
  };
  for (const [raw, want] of Object.entries(expected)) {
    assert.equal(normalizeStatus(raw), want, raw);
    assert.equal(normalizeStatus(raw.toLowerCase()), want, raw.toLowerCase());
  }
});

test("normalizeStatus throws on an unknown status instead of inventing one", () => {
  assert.throws(() => normalizeStatus("PAUSED"), UnknownDeploymentStatusError);
  assert.throws(() => normalizeStatus(""), UnknownDeploymentStatusError);
  assert.throws(() => normalizeStatus("toString"), UnknownDeploymentStatusError);
});

test("readDeployment: snapshot carries status, endpoints, jobs, replicas and events", async () => {
  const dep = fakeDeployment({
    status: "RUNNING",
    replicas: 2,
    endpoints: [
      { opId: "vllm-inference", port: 8000, url: "https://abc123.node.k8s.prd.nos.ci/", online: true },
      { opId: "vllm-inference", port: "8000", url: "https://def456.node.k8s.prd.nos.ci", online: false },
    ],
    jobs: [
      { tx: "t1", job: "JobA", deployment: "dep_1", revision: 1, status: "CONFIRMED" },
      { tx: "t2", job: "JobB", deployment: "dep_1", revision: 1, status: "PENDING" },
    ],
    events: [
      { category: "Deployment", deploymentId: "dep_1", type: "DEPLOYMENT_STARTED", message: "started", created_at: "2026-09-30T10:00:00.000Z" },
    ],
  });
  const { port } = fakePort(dep);

  const snap = await readDeployment(port, "dep_1");

  assert.equal(snap.id, "dep_1");
  assert.equal(snap.status, "running");
  assert.equal(snap.replicas, 2);
  assert.deepEqual(snap.endpoints, [
    { url: "https://abc123.node.k8s.prd.nos.ci", port: 8000, opId: "vllm-inference", online: true },
    { url: "https://def456.node.k8s.prd.nos.ci", port: "8000", opId: "vllm-inference", online: false },
  ]);
  assert.deepEqual(snap.jobs, [
    { job: "JobA", status: "CONFIRMED" },
    { job: "JobB", status: "PENDING" },
  ]);
  assert.deepEqual(snap.events, [
    { type: "DEPLOYMENT_STARTED", message: "started", createdAt: "2026-09-30T10:00:00.000Z" },
  ]);
  assert.equal(snap.invalidEndpointCount, 0);
});

test("readDeployment maps each deployment status without inventing endpoints", async () => {
  for (const [raw, want] of [
    ["DRAFT", "draft"],
    ["STARTING", "starting"],
    ["RUNNING", "running"],
    ["STOPPING", "stopping"],
    ["STOPPED", "stopped"],
    ["INSUFFICIENT_FUNDS", "insufficient_funds"],
    ["ERROR", "error"],
    ["ARCHIVED", "archived"],
  ] as const) {
    const { port } = fakePort(fakeDeployment({ status: raw }));
    const snap = await readDeployment(port, "dep_1");
    assert.equal(snap.status, want);
    assert.deepEqual(snap.endpoints, [], `${raw}: no endpoints reported -> none invented`);
    assert.deepEqual(snap.jobs, []);
  }
});

test("normalizeEndpoints keeps only real https URLs, dedupes, and never constructs one", () => {
  const { endpoints, invalid } = normalizeEndpoints([
    { opId: "a", port: 1, url: "https://x.node.nos.ci/" },
    { opId: "a", port: 1, url: "https://x.node.nos.ci", online: true }, // duplicate after trimming the slash
    { opId: "a", port: 1, url: "http://insecure.nos.ci" },
    { opId: "a", port: 1, url: "not a url" },
    { opId: "a", port: 1, url: "" },
    { opId: "a", port: 1, url: "https://user:pw@evil.nos.ci" },
  ]);
  // A duplicate that says online makes the one endpoint online.
  assert.deepEqual(endpoints, [{ url: "https://x.node.nos.ci", port: 1, opId: "a", online: true }]);
  assert.equal(invalid, 4);
  assert.deepEqual(normalizeEndpoints(undefined), { endpoints: [], invalid: 0 });
});

test("normalizeEndpoints: online only when Nosana says exactly true - absent, false or anything else is offline", () => {
  const { endpoints } = normalizeEndpoints([
    { opId: "a", port: 1, url: "https://a.node.nos.ci", online: true },
    { opId: "b", port: 1, url: "https://b.node.nos.ci", online: false },
    { opId: "c", port: 1, url: "https://c.node.nos.ci" },
    { opId: "d", port: 1, url: "https://d.node.nos.ci", online: "true" as never },
    { opId: "e", port: 1, url: "https://e.node.nos.ci", online: 1 as never },
  ]);
  assert.deepEqual(
    endpoints.map((e) => [e.opId, e.online]),
    [
      ["a", true],
      ["b", false],
      ["c", false],
      ["d", false],
      ["e", false],
    ],
  );
});

test("readDeployment: an API failure throws (strict read) and an unknown status throws", async () => {
  const failing = fakePort(fakeDeployment(), { getError: new Error("502 bad gateway") });
  await assert.rejects(
    () => readDeployment(failing.port, "dep_1"),
    (err: unknown) => err instanceof NosanaLifecycleError && err.stage === "read",
  );

  const weird = fakePort(fakeDeployment({ status: "PAUSED" }));
  await assert.rejects(() => readDeployment(weird.port, "dep_1"), UnknownDeploymentStatusError);
});

// ============================================
// stopAndReclaim / withdraw verification / reclaimVault
// ============================================

test("stopAndReclaim: stops a running deployment and reclaims the vault", async () => {
  const dep = fakeDeployment({ status: "RUNNING", nosBaseUnits: 5_000_000, solLamports: 5_000_000 });
  const { port } = fakePort(dep);

  const result = await stopAndReclaim(port, "dep_1");

  assert.equal(result.stopped, true);
  assert.equal(result.alreadyStopped, false);
  assert.equal(result.reclaimed, true);
  assert.equal(result.remainingNosBaseUnits, 0n);
  assert.deepEqual(
    dep.calls.filter((c) => c !== "getBalance"),
    ["stop", "withdraw"],
  );
});

test("stopAndReclaim tolerates a failing withdraw: stopped=true, reclaimed=false, reason kept", async () => {
  const dep = fakeDeployment({
    status: "RUNNING",
    nosBaseUnits: 5_000_000,
    withdrawError: new Error("Failed to withdraw from vault: deployment still running"),
  });
  const { port } = fakePort(dep);

  const result = await stopAndReclaim(port, "dep_1");

  assert.equal(result.stopped, true, "the stop itself took effect");
  assert.equal(result.reclaimed, false, "a later tick must retry");
  assert.equal(result.remainingNosBaseUnits, 5_000_000n);
  assert.match(result.reclaimError ?? "", /still running/);
});

test("withdrawAndVerify does not trust a withdraw that resolved but moved nothing", async () => {
  const dep = fakeDeployment({ nosBaseUnits: 123, withdrawSwallows: true });
  const outcome = await withdrawAndVerify(dep.vault);
  assert.equal(outcome.reclaimed, false);
  assert.equal(outcome.remainingNosBaseUnits, 123n);
});

test("withdrawAndVerify: an unreadable balance is NOT reclaimed", async () => {
  const dep = fakeDeployment({ balanceError: new Error("rpc down") });
  const outcome = await withdrawAndVerify(dep.vault);
  assert.equal(outcome.reclaimed, false);
  assert.equal(outcome.remainingNosBaseUnits, null);
});

test("stopAndReclaim does not call stop on an already-stopping/stopped deployment", async () => {
  for (const status of ["STOPPING", "STOPPED", "ARCHIVED", "DRAFT"]) {
    const dep = fakeDeployment({ status });
    const { port } = fakePort(dep);
    const result = await stopAndReclaim(port, "dep_1");
    assert.equal(result.alreadyStopped, true, status);
    assert.equal(result.stopped, true, status);
    assert.ok(!dep.calls.includes("stop"), `${status}: SDK stop() would throw 'already stopped'`);
    assert.ok(dep.calls.includes("withdraw"), `${status}: still tries to reclaim`);
  }
});

test("stopAndReclaim: a stop that fails and leaves the deployment running throws", async () => {
  const dep = fakeDeployment({ status: "RUNNING", stopError: new Error("api 500") });
  const { port } = fakePort(dep);
  await assert.rejects(
    () => stopAndReclaim(port, "dep_1"),
    (err: unknown) => err instanceof NosanaLifecycleError && err.stage === "stop" && err.deploymentId === "dep_1",
  );
  assert.ok(!dep.calls.includes("withdraw"), "no withdraw while the GPU may still be running");
});

// The second live run (2026-10-08): the owner pressed Stop, the read that
// precedes the stop failed on one unresolved name, and the deployment ran and
// was billed until Stop was pressed again.
function networkFailure(code = "EAI_AGAIN"): Error {
  const socket = Object.assign(new Error(`getaddrinfo ${code} dashboard.k8s.prd.nos.ci`), { code });
  // As the SDK's fetch reports it: "fetch failed", the socket error as its cause.
  return new TypeError("fetch failed", { cause: new TypeError("fetch failed", { cause: socket }) });
}

test("isNetworkFailure: a socket error anywhere in the chain of causes; an answer from Nosana is not one", () => {
  assert.equal(isNetworkFailure(networkFailure()), true);
  for (const code of ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]) {
    assert.equal(isNetworkFailure(networkFailure(code)), true, code);
  }
  assert.equal(isNetworkFailure(new Error("api 500")), false);
  assert.equal(isNetworkFailure(Object.assign(new Error("Not found"), { status: 404 })), false);
  assert.equal(isNetworkFailure(Object.assign(new Error("deadline"), { code: "nosana_timeout" })), false);
  assert.equal(isNetworkFailure(null), false);
  assert.equal(isNetworkFailure("EAI_AGAIN"), false);
  // A chain that never ends is not followed for ever.
  const loop: { cause?: unknown } = {};
  loop.cause = loop;
  assert.equal(isNetworkFailure(loop), false);
});

test("stopAndReclaim: the read before the stop is repeated after a network failure, and the stop then goes through", async () => {
  const dep = fakeDeployment({ status: "RUNNING" });
  const { port, calls } = fakePort(dep);
  const realGet = port.get.bind(port);
  let failures = 2;
  port.get = async (id) => {
    if (failures > 0) {
      failures -= 1;
      calls.push(`get-failed:${id}`);
      throw networkFailure();
    }
    return realGet(id);
  };
  const slept: number[] = [];

  const result = await stopAndReclaim(port, "dep_1", undefined, {
    readRetry: { attempts: 3, delayMs: 750, sleep: async (ms) => void slept.push(ms) },
  });

  assert.equal(result.stopped, true);
  assert.equal(result.alreadyStopped, false);
  assert.deepEqual(slept, [750, 750]);
  assert.deepEqual(calls.slice(0, 3), ["get-failed:dep_1", "get-failed:dep_1", "get:dep_1"]);
  assert.ok(dep.calls.includes("stop"));
  assert.deepEqual(DEFAULT_STOP_READ_RETRY, { attempts: 3, delayMs: 750 });
});

test("stopAndReclaim: a network failure on every read gives up after the last attempt, and nothing is stopped or released", async () => {
  const dep = fakeDeployment({ status: "RUNNING", nosBaseUnits: 5_000_000 });
  const { port, calls } = fakePort(dep, { getError: networkFailure() });
  const slept: number[] = [];
  await assert.rejects(
    () =>
      stopAndReclaim(port, "dep_1", undefined, {
        readRetry: { attempts: 3, delayMs: 750, sleep: async (ms) => void slept.push(ms) },
      }),
    (err: unknown) => err instanceof NosanaLifecycleError && err.stage === "stop" && /EAI_AGAIN|fetch failed/.test(err.message),
  );
  assert.deepEqual(calls, ["get:dep_1", "get:dep_1", "get:dep_1"]);
  assert.deepEqual(slept, [750, 750]);
  assert.deepEqual(dep.calls, [], "no stop and no withdraw without a read");
});

test("stopAndReclaim: an answer from Nosana on the read is not repeated", async () => {
  const dep = fakeDeployment({ status: "RUNNING" });
  const { port, calls } = fakePort(dep, { getError: Object.assign(new Error("Deployment not found"), { status: 404 }) });
  const slept: number[] = [];
  await assert.rejects(
    () =>
      stopAndReclaim(port, "dep_1", undefined, {
        readRetry: { attempts: 3, delayMs: 750, sleep: async (ms) => void slept.push(ms) },
      }),
    (err: unknown) => err instanceof NosanaLifecycleError && err.stage === "stop",
  );
  assert.deepEqual(calls, ["get:dep_1"]);
  assert.deepEqual(slept, []);
});

test("stopAndReclaim: a stop that fails on the network is sent again, and one that did arrive is read as stopped", async () => {
  // The stop request fails on the network and so does the read after it:
  // nothing says whether it arrived. It is sent again and accepted.
  const dep = fakeDeployment({ status: "RUNNING" });
  const { port } = fakePort(dep);
  const realStop = dep.stop.bind(dep);
  const realGet = port.get.bind(port);
  let stopFailures = 1;
  let reads = 0;
  dep.stop = async () => {
    if (stopFailures > 0) {
      stopFailures -= 1;
      dep.calls.push("stop-failed");
      throw networkFailure("ECONNRESET");
    }
    return realStop();
  };
  port.get = async (id) => {
    reads += 1;
    // The first read is the one before the stop; the second follows the failed stop.
    if (reads === 2) throw networkFailure("ECONNRESET");
    return realGet(id);
  };
  const slept: number[] = [];
  const result = await stopAndReclaim(port, "dep_1", undefined, {
    stopRetry: { attempts: 4, delayMs: 2_500, sleep: async (ms) => void slept.push(ms) },
  });
  assert.equal(result.stopped, true);
  assert.deepEqual(slept, [2_500]);
  assert.deepEqual(dep.calls.filter((c) => c.startsWith("stop")), ["stop-failed", "stop"]);

  // The connection dropped after the stop had arrived: the read after it says
  // STOPPING, which is a stop.
  const arrived = fakeDeployment({ status: "RUNNING" });
  const second = fakePort(arrived);
  arrived.stop = async () => {
    arrived.calls.push("stop");
    arrived.setStatus("STOPPING");
    throw networkFailure("ECONNRESET");
  };
  const outcome = await stopAndReclaim(second.port, "dep_2", undefined, {
    stopRetry: { attempts: 4, delayMs: 2_500, sleep: async () => undefined },
  });
  assert.equal(outcome.stopped, true);
  assert.deepEqual(arrived.calls.filter((c) => c === "stop"), ["stop"], "not sent twice");
});

// The same incident one call later: every call resolves the name anew, so the
// read can succeed, the stop fail, and the read after it succeed again.
test("stopAndReclaim: a stop that fails on the network is sent again when the read after it still says RUNNING", async () => {
  const dep = fakeDeployment({ status: "RUNNING" });
  const { port } = fakePort(dep);
  const realStop = dep.stop.bind(dep);
  let stopFailures = 2;
  dep.stop = async () => {
    if (stopFailures > 0) {
      stopFailures -= 1;
      dep.calls.push("stop-failed");
      // The name did not resolve: the request never left.
      throw networkFailure("EAI_AGAIN");
    }
    return realStop();
  };
  const slept: number[] = [];
  const result = await stopAndReclaim(port, "dep_1", undefined, {
    stopRetry: { attempts: 4, delayMs: 2_500, sleep: async (ms) => void slept.push(ms) },
  });
  assert.equal(result.stopped, true);
  assert.deepEqual(slept, [2_500, 2_500]);
  assert.deepEqual(dep.calls.filter((c) => c.startsWith("stop")), ["stop-failed", "stop-failed", "stop"]);

  // Still bounded: a network that never comes back ends in the error, after the last attempt.
  const never = fakeDeployment({ status: "RUNNING", stopError: networkFailure("EAI_AGAIN") });
  const second = fakePort(never);
  const waits: number[] = [];
  await assert.rejects(
    () =>
      stopAndReclaim(second.port, "dep_2", undefined, {
        stopRetry: { attempts: 4, delayMs: 2_500, sleep: async (ms) => void waits.push(ms) },
      }),
    (err: unknown) => err instanceof NosanaLifecycleError && err.stage === "stop",
  );
  assert.deepEqual(waits, [2_500, 2_500, 2_500]);
  assert.equal(never.calls.filter((c) => c === "stop").length, 4);
  assert.ok(!never.calls.includes("withdraw"), "nothing is released while the GPU may still be running");
});

test("stopAndReclaim: a stop whose answer was lost and that Nosana then refuses as a duplicate is read as stopped", async () => {
  // The first stop arrived and its answer was lost; the read after it still
  // says RUNNING. The stop is sent again, Nosana refuses it (the deployment
  // is no longer in a state that accepts one), and the next read says STOPPING.
  const dep = fakeDeployment({ status: "RUNNING" });
  const { port } = fakePort(dep);
  let stops = 0;
  dep.stop = async () => {
    stops += 1;
    dep.calls.push("stop");
    if (stops === 1) throw networkFailure("ECONNRESET");
    dep.setStatus("STOPPING");
    throw new Error("api 500 INCORRECT_STATE");
  };
  const slept: number[] = [];
  const result = await stopAndReclaim(port, "dep_1", undefined, {
    stopRetry: { attempts: 4, delayMs: 2_500, sleep: async (ms) => void slept.push(ms) },
  });
  assert.equal(result.stopped, true);
  assert.deepEqual(slept, [2_500]);
  assert.equal(stops, 2, "an answer from Nosana is not repeated");
});

test("stopAndReclaim: a stop Nosana answers with an error is not repeated when the read after it fails", async () => {
  const dep = fakeDeployment({ status: "RUNNING", stopError: new Error("api 500") });
  const { port } = fakePort(dep);
  const realGet = port.get.bind(port);
  let reads = 0;
  port.get = async (id) => {
    reads += 1;
    if (reads > 1) throw networkFailure();
    return realGet(id);
  };
  const slept: number[] = [];
  await assert.rejects(
    () =>
      stopAndReclaim(port, "dep_1", undefined, {
        stopRetry: { attempts: 4, delayMs: 2_500, sleep: async (ms) => void slept.push(ms) },
      }),
    (err: unknown) => err instanceof NosanaLifecycleError && err.stage === "stop",
  );
  assert.deepEqual(slept, [], "an answer is an answer: nothing to wait for");
  assert.deepEqual(dep.calls.filter((c) => c === "stop"), ["stop"]);
});

test("stopAndReclaim: a deployment Nosana already halted (ERROR / INSUFFICIENT_FUNDS) is stoppable even if Nosana refuses the stop", async () => {
  for (const status of ["ERROR", "INSUFFICIENT_FUNDS"]) {
    const dep = fakeDeployment({ status, nosBaseUnits: 500, stopError: new Error("cannot stop an errored deployment") });
    const { port } = fakePort(dep);
    const result = await stopAndReclaim(port, "dep_1");
    assert.equal(result.stopped, true, status);
    assert.equal(result.reclaimed, true, `${status}: the vault is still recovered`);
    assert.ok(dep.calls.includes("stop"), `${status}: a stop is still attempted`);
  }
});

test("stopAndReclaim: stop throwing because another stopper won the race is success", async () => {
  const base = fakeDeployment({ status: "RUNNING", stopError: new Error("Deployment is already stopped") });
  let reads = 0;
  const racePort: NosanaDeploymentsPort = {
    getMarketJobPrice: async () => 1n,
    create: async () => base,
    get: async () => {
      reads += 1;
      // first read: running (we try to stop); second read: someone else stopped it
      return reads === 1 ? base : fakeDeployment({ status: "STOPPING" });
    },
  };
  const result = await stopAndReclaim(racePort, "dep_1");
  assert.equal(result.stopped, true);
});

test("reclaimVault STOPS a Nosana deployment that is still running although our row is terminal (review #7)", async () => {
  // The sweep only asks about rows that are stopped/failed in OUR database. A
  // Nosana deployment still RUNNING/STARTING for such a row burns platform NOS
  // with nobody paying - reporting "still running" and moving on left it running.
  for (const status of ["RUNNING", "STARTING"]) {
    const dep = fakeDeployment({ status, nosBaseUnits: 100 });
    const { port } = fakePort(dep);
    const result = await reclaimVault(port, "dep_1");
    assert.ok(dep.calls.includes("stop"), `${status}: the stop is issued`);
    assert.equal(result.state, status.toLowerCase());
    // the funds can only be withdrawn once the jobs wound down: the fake lets the
    // withdraw succeed, the real API commonly does not (-> reclaimed=false, retried)
    assert.ok(dep.calls.indexOf("stop") < dep.calls.indexOf("withdraw"), "stop first, then the withdraw attempt");
  }
});

test("reclaimVault: a stop that cannot be issued THROWS (a silent reclaimed=false would leave the GPU running)", async () => {
  const dep = fakeDeployment({ status: "RUNNING", nosBaseUnits: 100, stopError: new Error("api 500") });
  const { port } = fakePort(dep);
  await assert.rejects(
    () => reclaimVault(port, "dep_1"),
    (err: unknown) => err instanceof NosanaLifecycleError && err.stage === "stop" && err.deploymentId === "dep_1",
  );
  assert.ok(!dep.calls.includes("withdraw"), "no withdraw while the GPU may still be running");
});

test("reclaimVault: losing the stop race to another stopper is fine", async () => {
  const base = fakeDeployment({ status: "RUNNING", nosBaseUnits: 100, stopError: new Error("already stopped") });
  let reads = 0;
  const port: NosanaDeploymentsPort = {
    getMarketJobPrice: async () => 1n,
    create: async () => base,
    get: async () => {
      reads += 1;
      return reads === 1 ? base : fakeDeployment({ status: "STOPPING", nosBaseUnits: 100 });
    },
  };
  const result = await reclaimVault(port, "dep_1");
  assert.equal(result.state, "running");
});

test("reclaimVault: an already stopped deployment is not stopped again", async () => {
  const dep = fakeDeployment({ status: "STOPPED", nosBaseUnits: 100 });
  await reclaimVault(fakePort(dep).port, "dep_1");
  assert.ok(!dep.calls.includes("stop"), "SDK stop() would throw 'already stopped'");
});

test("reclaimVault: stopped deployment with funds is reclaimed; errored one is stopped first", async () => {
  const stopped = fakeDeployment({ status: "STOPPED", nosBaseUnits: 100 });
  const r1 = await reclaimVault(fakePort(stopped).port, "dep_1");
  assert.equal(r1.reclaimed, true);

  const errored = fakeDeployment({ status: "ERROR", nosBaseUnits: 100 });
  const r2 = await reclaimVault(fakePort(errored).port, "dep_1");
  assert.equal(r2.reclaimed, true);
  assert.ok(errored.calls.includes("stop"), "an ERROR deployment may still hold jobs");
});

// ============================================
// scaleDeployment
// ============================================

test("scaleDeployment: scaling up funds ONLY the added replicas, then updates the count", async () => {
  const dep = fakeDeployment({ status: "RUNNING", replicas: 1 });
  const { port } = fakePort(dep, { jobPrice: 100n });

  const result = await scaleDeployment(port, "dep_1", 3, {
    marketAddress: BASE_PARAMS.marketAddress,
    fundSeconds: 3600,
    solFeeLamportsPerReplica: 5n,
    networkFeeBps: 0,
  });

  assert.equal(result.previousReplicas, 1);
  assert.equal(result.replicas, 3);
  // 2 added replicas x 100/s x 3600 s
  assert.deepEqual(dep.topups, [{ NOS: 2 * 100 * 3600, SOL: 10, lamports: true }]);
  assert.deepEqual(dep.calls, ["topup", "updateReplicaCount:3"], "fund first, then scale");
});

test("scaleDeployment: scaling down never tops up", async () => {
  const dep = fakeDeployment({ status: "RUNNING", replicas: 3 });
  const { port } = fakePort(dep);
  const result = await scaleDeployment(port, "dep_1", 1, {
    marketAddress: BASE_PARAMS.marketAddress,
    fundSeconds: 3600,
  });
  assert.equal(result.funded, null);
  assert.deepEqual(dep.calls, ["updateReplicaCount:1"]);
});

test("scaleDeployment: no-op when the count is unchanged", async () => {
  const dep = fakeDeployment({ status: "RUNNING", replicas: 2 });
  const { port } = fakePort(dep);
  const result = await scaleDeployment(port, "dep_1", 2, {
    marketAddress: BASE_PARAMS.marketAddress,
    fundSeconds: 3600,
  });
  assert.equal(result.funded, null);
  assert.deepEqual(dep.calls, []);
});

test("scaleDeployment refuses when the deployment is not running", async () => {
  const dep = fakeDeployment({ status: "STOPPED", replicas: 1 });
  const { port } = fakePort(dep);
  await assert.rejects(
    () =>
      scaleDeployment(port, "dep_1", 2, {
        marketAddress: BASE_PARAMS.marketAddress,
        fundSeconds: 3600,
      }),
    (err: unknown) =>
      err instanceof NosanaLifecycleError && err.stage === "scale" && err.code === "nosana_not_running",
  );
  assert.deepEqual(dep.calls, []);
});

test("scaleDeployment: a funding failure does not change the replica count", async () => {
  const dep = fakeDeployment({ status: "RUNNING", replicas: 1, topupError: new Error("no SOL") });
  const { port } = fakePort(dep);
  await assert.rejects(
    () =>
      scaleDeployment(port, "dep_1", 2, {
        marketAddress: BASE_PARAMS.marketAddress,
        fundSeconds: 3600,
      }),
    (err: unknown) => err instanceof NosanaLifecycleError && err.stage === "scale",
  );
  assert.ok(!dep.calls.some((c) => c.startsWith("updateReplicaCount")));
});

// ============================================
// ensureVaultRunway
// ============================================

test("ensureVaultRunway tops the vault up to the target when the runway is short", async () => {
  // per-second for 1 replica at jobPrice 100, no fee = 100 base units/s.
  // Vault holds 100 x 600 => 600 s of runway; minimum is 3600 s.
  const dep = fakeDeployment({ status: "RUNNING", nosBaseUnits: 60_000, solLamports: 50 });
  const { port } = fakePort(dep, { jobPrice: 100n });

  const result = await ensureVaultRunway(port, "dep_1", {
    marketAddress: BASE_PARAMS.marketAddress,
    replicas: 1,
    minRunwaySeconds: 3600,
    fundSeconds: 7200,
    solFeeLamportsPerReplica: 50n,
    networkFeeBps: 0,
  });

  assert.equal(result.toppedUp, true);
  assert.equal(result.runwaySeconds, 600);
  // target = 100 x 7200 = 720,000; have 60,000 => top up 660,000
  assert.deepEqual(dep.topups, [{ NOS: 660_000, SOL: 0, lamports: true }]);
});

test("ensureVaultRunway does nothing when the runway is sufficient", async () => {
  const dep = fakeDeployment({ status: "RUNNING", nosBaseUnits: 1_000_000, solLamports: 50 });
  const { port } = fakePort(dep, { jobPrice: 100n });
  const result = await ensureVaultRunway(port, "dep_1", {
    marketAddress: BASE_PARAMS.marketAddress,
    replicas: 1,
    minRunwaySeconds: 3600,
    fundSeconds: 7200,
    solFeeLamportsPerReplica: 50n,
    networkFeeBps: 0,
  });
  assert.equal(result.toppedUp, false);
  assert.equal(result.runwaySeconds, 10_000);
  assert.deepEqual(dep.topups, []);
});

test("ensureVaultRunway refills SOL on its own and skips deployments that are not running", async () => {
  const solLow = fakeDeployment({ status: "RUNNING", nosBaseUnits: 1_000_000, solLamports: 1 });
  const r1 = await ensureVaultRunway(fakePort(solLow, { jobPrice: 100n }).port, "dep_1", {
    marketAddress: BASE_PARAMS.marketAddress,
    replicas: 2,
    minRunwaySeconds: 10,
    fundSeconds: 20,
    solFeeLamportsPerReplica: 50n,
    networkFeeBps: 0,
  });
  assert.equal(r1.toppedUp, true);
  assert.deepEqual(solLow.topups, [{ NOS: 0, SOL: 99, lamports: true }]);

  const stopped = fakeDeployment({ status: "STOPPED" });
  const r2 = await ensureVaultRunway(fakePort(stopped).port, "dep_1", {
    marketAddress: BASE_PARAMS.marketAddress,
    replicas: 1,
    minRunwaySeconds: 10,
    fundSeconds: 20,
  });
  assert.equal(r2.toppedUp, false);
  assert.equal(r2.reason, "not_running");
});
