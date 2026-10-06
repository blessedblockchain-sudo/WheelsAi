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

// Drives apps/api/src/services/buildGpuBillingTickDeps.ts through the REAL
// runGpuBillingTick against an in-memory database with real transaction
// semantics (serialised, rolled back on throw). This is where the acceptance
// criteria live: exact cents for a window, the cursor advanced by CAS, no
// double billing across concurrent ticks, and stop + reservation release when
// the org cannot pay.

const T0 = new Date("2026-09-30T10:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

const PRICE: Record<string, number> = { "4090": 0.00025, "3060": 0.0001 };
const priceOf = (tier: string) => PRICE[tier] ?? 0;

interface Dep {
  id: string;
  orgId: string;
  gpuTier: string;
  replicas: number;
  status: string;
  nosanaJobIds: string[];
  billedThroughAt: Date | null;
  reservationCents: bigint | null;
  reservationReleasedAt: Date | null;
  stoppedAt: Date | null;
  statusReason: string | null;
  vaultReclaimedAt: Date | null;
  runGeneration: number;
  gpuStoppedAt: Date | null;
  runwayCheckedAt: Date | null;
  createdAt: Date;
}
interface State {
  deployments: Dep[];
  nodes: Array<{ id: string; deploymentId: string }>;
  balances: Record<string, bigint>;
  ledger: Array<{
    orgId: string;
    amountCents: bigint;
    type: string;
    referenceId: string;
    balanceAfter: bigint;
    description: string;
  }>;
}

function makeDb(seed: {
  deployments: Array<Partial<Dep> & { id: string }>;
  balances: Record<string, bigint>;
  nodes?: State["nodes"];
}) {
  const state: State = {
    deployments: seed.deployments.map((d, i) => ({
      orgId: "org_1",
      gpuTier: "4090",
      replicas: 1,
      status: "running",
      nosanaJobIds: [`dm_${d.id}`],
      billedThroughAt: T0,
      reservationCents: null,
      reservationReleasedAt: null,
      stoppedAt: null,
      statusReason: null,
      vaultReclaimedAt: null,
      runGeneration: 0,
      gpuStoppedAt: null,
      runwayCheckedAt: null,
      createdAt: new Date(T0.getTime() + i),
      ...d,
    })),
    nodes: seed.nodes ?? [],
    balances: { ...seed.balances },
    ledger: [],
  };

  const sameDate = (a: Date | null, b: Date | null) =>
    a === null || b === null ? a === b : a.getTime() === b.getTime();

  const matches = (d: Dep, where: any): boolean => {
    if (where.id !== undefined && d.id !== where.id) return false;
    if (typeof where.status === "string" && d.status !== where.status) return false;
    if (where.status?.in && !where.status.in.includes(d.status)) return false;
    if (where.replicas !== undefined && d.replicas !== where.replicas) return false;
    if ("billedThroughAt" in where && !sameDate(d.billedThroughAt, where.billedThroughAt)) return false;
    if ("reservationReleasedAt" in where && !sameDate(d.reservationReleasedAt, where.reservationReleasedAt)) return false;
    if (where.nosanaJobIds?.isEmpty === false && d.nosanaJobIds.length === 0) return false;
    if (where.nosanaJobIds?.has !== undefined && !d.nosanaJobIds.includes(where.nosanaJobIds.has)) return false;
    if (where.runGeneration !== undefined && d.runGeneration !== where.runGeneration) return false;
    if ("gpuStoppedAt" in where && !sameDate(d.gpuStoppedAt, where.gpuStoppedAt)) return false;
    if ("runwayCheckedAt" in where) {
      const want = where.runwayCheckedAt;
      if (want === null ? d.runwayCheckedAt !== null : !(d.runwayCheckedAt && d.runwayCheckedAt <= want.lte)) return false;
    }
    if (where.OR && !where.OR.some((alt: any) => matches(d, alt))) return false;
    return true;
  };

  const tx = {
    deployment: {
      findMany: async (args: any) =>
        state.deployments.filter((d) => matches(d, args.where)).map((d) => ({ ...d })),
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const d of state.deployments) {
          if (matches(d, where)) {
            Object.assign(d, data);
            count += 1;
          }
        }
        return { count };
      },
      findUnique: async ({ where }: any) => {
        const d = state.deployments.find((x) => x.id === where.id);
        return d ? { ...d } : null;
      },
    },
    creditBalance: {
      updateMany: async ({ where, data }: any) => {
        const bal = state.balances[where.orgId] ?? 0n;
        if (bal < where.balanceCents.gte) return { count: 0 };
        state.balances[where.orgId] = bal - data.balanceCents.decrement;
        return { count: 1 };
      },
      update: async ({ where, data }: any) => {
        state.balances[where.orgId] = (state.balances[where.orgId] ?? 0n) + data.balanceCents.increment;
        return { balanceCents: state.balances[where.orgId]! };
      },
      findUnique: async ({ where }: any) => ({ balanceCents: state.balances[where.orgId] ?? 0n }),
    },
    creditTransaction: {
      create: async ({ data }: any) => {
        state.ledger.push({ ...data });
        return {};
      },
    },
    deploymentNode: {
      deleteMany: async ({ where }: any) => {
        const before = state.nodes.length;
        state.nodes = state.nodes.filter((n) => n.deploymentId !== where.deploymentId);
        return { count: before - state.nodes.length };
      },
    },
    agentDeployment: {
      updateMany: async () => ({ count: 0 }),
    },
  };

  // Transactions serialise (a row lock) and roll back on throw.
  let chain: Promise<unknown> = Promise.resolve();
  const prisma = {
    deployment: tx.deployment,
    $transaction: <T>(fn: (t: unknown) => Promise<T>): Promise<T> => {
      const run = chain.then(async () => {
        const snapshot = structuredClone(state);
        try {
          return await fn(tx);
        } catch (err) {
          state.deployments = snapshot.deployments;
          state.nodes = snapshot.nodes;
          state.balances = snapshot.balances;
          state.ledger = snapshot.ledger;
          throw err;
        }
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
  return { prisma, state };
}

const bal = (db: ReturnType<typeof makeDb>, org: string): bigint => db.state.balances[org] ?? 0n;

async function build(
  db: ReturnType<typeof makeDb>,
  over: {
    stopDeployment?: (id: string) => Promise<{ reclaimed: boolean; alreadyStopped?: boolean }>;
    ensureRunway?: (a: { nosanaDeploymentId: string; gpuTier: string; replicas: number }) => Promise<{ toppedUp: boolean }>;
    emitStopped?: (row: { id: string }, reason: string) => Promise<void>;
  } = {},
) {
  setupEnv();
  const { buildGpuBillingTickDeps, resetRunwayThrottleForTests } = await import(
    "../services/buildGpuBillingTickDeps.js"
  );
  const { runGpuBillingTick } = await import("../services/runGpuBillingTick.js");
  resetRunwayThrottleForTests();
  // The builder's clock: the tick sets it to its own `now`, and a test can move
  // it forward from inside stopDeployment to model a slow Nosana stop.
  const clock = { value: T0 };
  const deps = buildGpuBillingTickDeps({
    prisma: db.prisma as never,
    pricePerSecondUsd: priceOf,
    stopDeployment: over.stopDeployment
      ? (id) => over.stopDeployment!(id)
      : async () => ({ reclaimed: true }),
    ensureRunway: over.ensureRunway,
    emitStopped: over.emitStopped as never,
    now: () => clock.value,
  });
  return {
    deps,
    clock,
    tick: (now: Date) => {
      clock.value = now;
      return runGpuBillingTick({ now }, deps);
    },
  };
}

// ============================================
// Exact cents + cursor CAS
// ============================================

test("a tick charges exact cents for the window and advances the cursor by the time they cover", async () => {
  const db = makeDb({ deployments: [{ id: "d1" }], balances: { org_1: 500n } });
  const { tick } = await build(db);

  // 100 s of a 4090: 250 uUSD/s x 100 s = 25,000 uUSD = 2.5 cents -> 2 cents (80 s).
  const result = await tick(at(100));

  assert.equal(result.charged, 1);
  assert.equal(result.chargedCents, 2n);
  assert.equal(db.state.balances.org_1, 498n);
  assert.deepEqual(db.state.deployments[0]!.billedThroughAt, at(80));
  assert.deepEqual(
    db.state.ledger.map((l) => [l.type, l.amountCents, l.referenceId, l.balanceAfter]),
    [["gpu_usage", -2n, "d1", 498n]],
  );

  // The remaining 20 s roll into the next window: 20 + 40 = 60 s -> 1 cent.
  const next = await tick(at(140));
  assert.equal(next.chargedCents, 1n);
  assert.equal(db.state.balances.org_1, 497n);
  assert.deepEqual(db.state.deployments[0]!.billedThroughAt, at(120));
});

test("billing each minute for an hour charges exactly the hour (4090 x1 = 90 cents)", async () => {
  const db = makeDb({ deployments: [{ id: "d1" }], balances: { org_1: 10_000n } });
  const { tick } = await build(db);
  for (let minute = 1; minute <= 60; minute += 1) {
    await tick(at(minute * 60));
  }
  assert.equal(10_000n - bal(db, "org_1"), 90n);
  assert.equal(
    db.state.ledger.reduce((sum, l) => sum + -l.amountCents, 0n),
    90n,
    "the ledger sums to what the balance lost",
  );
});

test("replicas multiply the charge", async () => {
  const db = makeDb({ deployments: [{ id: "d1", replicas: 2 }], balances: { org_1: 500n } });
  const { tick } = await build(db);
  await tick(at(60)); // 2 x 250 x 60 = 30,000 uUSD = 3 cents
  assert.equal(500n - bal(db, "org_1"), 3n);
});

test("a sub-cent window writes nothing and does not move the cursor", async () => {
  const db = makeDb({ deployments: [{ id: "d1", gpuTier: "3060" }], balances: { org_1: 500n } });
  const { tick } = await build(db);
  const result = await tick(at(30)); // 100 x 30 = 3,000 uUSD = 0.3 cent
  assert.equal(result.nothingToBill, 1);
  assert.equal(db.state.balances.org_1, 500n);
  assert.equal(db.state.ledger.length, 0);
  assert.deepEqual(db.state.deployments[0]!.billedThroughAt, T0);
});

test("a running row with no cursor gets one set to now - nothing is charged for the past", async () => {
  const db = makeDb({
    deployments: [{ id: "legacy", billedThroughAt: null }],
    balances: { org_1: 500n },
  });
  const { tick } = await build(db);
  const result = await tick(at(600));
  assert.equal(result.cursorsInitialised, 1);
  assert.deepEqual(db.state.deployments[0]!.billedThroughAt, at(600));
  assert.equal(db.state.balances.org_1, 500n);
  assert.equal(db.state.ledger.length, 0);
});

test("only RUNNING rows with a real Nosana id are billed (mock ids never consume a GPU)", async () => {
  const db = makeDb({
    deployments: [
      { id: "run" },
      { id: "stopped", status: "stopped" },
      { id: "degraded", status: "degraded" },
      { id: "provisioning", status: "provisioning" },
      { id: "mock", nosanaJobIds: ["mock_deploy_abc"] },
      { id: "nojob", nosanaJobIds: [] },
    ],
    balances: { org_1: 500n },
  });
  const { tick } = await build(db);
  const result = await tick(at(60));
  assert.equal(result.scanned, 1);
  assert.deepEqual(
    db.state.ledger.map((l) => l.referenceId),
    ["run"],
  );
});

// ============================================
// No double billing
// ============================================

test("two concurrent ticks over the same cursor bill the window exactly once", async () => {
  const db = makeDb({ deployments: [{ id: "d1" }], balances: { org_1: 500n } });
  const a = await build(db);
  const b = await build(db);

  const [ra, rb] = await Promise.all([a.tick(at(100)), b.tick(at(100))]);

  assert.equal(500n - bal(db, "org_1"), 2n, "2 cents once, not 4");
  assert.equal(db.state.ledger.length, 1);
  assert.equal(ra.charged + rb.charged, 1, "exactly one tick won the cursor CAS");
  assert.equal(ra.cursorLost + rb.cursorLost, 1, "the other saw a lost CAS");
});

// ============================================
// Unpayable: stop + release
// ============================================

test("an org that cannot pay is stopped on Nosana, marked insufficient_credits, and its reservation released once", async () => {
  const stops: string[] = [];
  const emitted: Array<[string, string]> = [];
  const db = makeDb({
    deployments: [
      {
        id: "poor",
        orgId: "org_poor",
        reservationCents: 100n, // taken at admission; balance is what is left
      },
    ],
    balances: { org_poor: 0n },
    nodes: [{ id: "n1", deploymentId: "poor" }],
  });
  const { tick } = await build(db, {
    stopDeployment: async (id) => {
      stops.push(id);
      return { reclaimed: true };
    },
    emitStopped: async (row, reason) => {
      emitted.push([row.id, reason]);
    },
  });

  // 300 s x 250 uUSD = 75,000 uUSD = 7.5 cents: the org owes 7, holds 0.
  const result = await tick(at(300));

  assert.equal(result.insufficientCredits, 1);
  assert.equal(result.stoppedForCredits, 1);
  assert.deepEqual(stops, ["dm_poor"], "Nosana was stopped");

  const dep = db.state.deployments[0]!;
  assert.equal(dep.status, "stopped");
  assert.equal(dep.statusReason, "insufficient_credits");
  assert.deepEqual(dep.stoppedAt, at(300));
  assert.deepEqual(dep.vaultReclaimedAt, at(300), "the stop reclaimed the vault");
  assert.deepEqual(dep.reservationReleasedAt, at(300), "reservation released");
  assert.equal(db.state.nodes.length, 0, "nodes removed");

  // Release (+100) first so it covers the final window; then the final window
  // (ceil(7.5) = 8 cents) is charged from it.
  assert.deepEqual(
    db.state.ledger.map((l) => [l.type, l.amountCents, l.referenceId]),
    [
      ["deployment_reservation_release", 100n, "poor"],
      ["gpu_usage", -8n, "poor"],
    ],
  );
  assert.equal(db.state.balances.org_poor, 92n);
  assert.deepEqual(emitted, [["poor", "insufficient_credits"]]);

  // The next tick does not see it (status stopped) - nothing is released or charged twice.
  const again = await tick(at(360));
  assert.equal(again.scanned, 0);
  assert.equal(db.state.ledger.length, 2);
  assert.equal(db.state.balances.org_poor, 92n);
});

test("the reservation is released EXACTLY once even if the tick repeats the stop path", async () => {
  const db = makeDb({
    deployments: [{ id: "poor", orgId: "org_poor", reservationCents: 100n }],
    balances: { org_poor: 0n },
  });
  const a = await build(db);
  const b = await build(db);
  await Promise.all([a.tick(at(300)), b.tick(at(300))]);

  const releases = db.state.ledger.filter((l) => l.type === "deployment_reservation_release");
  assert.equal(releases.length, 1, "one refund, not two");
  // 100 credited once; final window 8 cents debited once.
  assert.equal(db.state.balances.org_poor, 92n);
});

test("if Nosana will not stop, the row stays RUNNING, nothing is released, and the next tick retries", async () => {
  let failStop = true;
  const db = makeDb({
    deployments: [{ id: "poor", orgId: "org_poor", reservationCents: 100n }],
    balances: { org_poor: 0n },
  });
  const { tick } = await build(db, {
    stopDeployment: async () => {
      if (failStop) throw new Error("nosana 503");
      return { reclaimed: false };
    },
  });

  const first = await tick(at(300));
  assert.equal(first.stopFailed, 1);
  const dep = db.state.deployments[0]!;
  assert.equal(dep.status, "running", "never marked stopped without a confirmed stop");
  assert.equal(dep.reservationReleasedAt, null);
  assert.equal(db.state.balances.org_poor, 0n);
  assert.deepEqual(dep.billedThroughAt, T0, "the failed charge rolled back");

  failStop = false;
  const second = await tick(at(360));
  assert.equal(second.stoppedForCredits, 1);
  assert.equal(db.state.deployments[0]!.status, "stopped");
  assert.equal(db.state.deployments[0]!.vaultReclaimedAt, null, "reclaim still pending -> the status worker retries");
});

test("a rich org is unaffected by a poor org's stop in the same tick", async () => {
  const db = makeDb({
    deployments: [
      { id: "poor", orgId: "org_poor", reservationCents: 100n },
      { id: "rich", orgId: "org_rich" },
    ],
    balances: { org_poor: 0n, org_rich: 1000n },
  });
  const { tick } = await build(db);
  const result = await tick(at(300));
  assert.equal(result.stoppedForCredits, 1);
  assert.equal(result.charged, 1);
  assert.equal(db.state.deployments.find((d) => d.id === "rich")!.status, "running");
  assert.equal(1000n - bal(db, "org_rich"), 7n);
});

// ============================================
// Vault runway
// ============================================

test("the vault runway is refilled after a charge, at most once per interval per deployment", async () => {
  const refills: string[] = [];
  const db = makeDb({ deployments: [{ id: "d1" }], balances: { org_1: 5000n } });
  const { tick } = await build(db, {
    ensureRunway: async ({ nosanaDeploymentId }) => {
      refills.push(nosanaDeploymentId);
      return { toppedUp: true };
    },
  });

  await tick(at(60));
  await tick(at(120));
  await tick(at(180));
  assert.deepEqual(refills, ["dm_d1"], "throttled to one check per interval");

  await tick(at(60 + 10 * 60));
  assert.deepEqual(refills, ["dm_d1", "dm_d1"], "checked again after the interval");
});

test("the runway throttle survives the per-job rebuild of the deps - the queue builds fresh deps EVERY tick (review #8)", async () => {
  // queues/gpu-billing.queue.ts calls buildGpuBillingTickDeps inside the worker
  // callback, so a Map created per build was empty on every job and the
  // throttle never throttled.
  setupEnv();
  const { buildGpuBillingTickDeps, resetRunwayThrottleForTests } = await import(
    "../services/buildGpuBillingTickDeps.js"
  );
  const { runGpuBillingTick } = await import("../services/runGpuBillingTick.js");
  resetRunwayThrottleForTests();

  const refills: string[] = [];
  const db = makeDb({ deployments: [{ id: "d1" }], balances: { org_1: 5000n } });
  const runJob = async (now: Date) => {
    // a brand-new deps object per job, exactly like the queue
    const deps = buildGpuBillingTickDeps({
      prisma: db.prisma as never,
      pricePerSecondUsd: priceOf,
      stopDeployment: async () => ({ reclaimed: true }),
      ensureRunway: async ({ nosanaDeploymentId }) => {
        refills.push(nosanaDeploymentId);
        return { toppedUp: false };
      },
      now: () => now,
    });
    await runGpuBillingTick({ now }, deps);
  };

  await runJob(at(60));
  await runJob(at(120));
  await runJob(at(180));
  assert.deepEqual(refills, ["dm_d1"], "one check across three separately built jobs");

  await runJob(at(60 + 11 * 60));
  assert.equal(refills.length, 2, "and again once the interval has passed");
});

test("the runway throttle map is pruned, not unbounded", async () => {
  setupEnv();
  const { buildGpuBillingTickDeps, resetRunwayThrottleForTests, runwayThrottleSizeForTests } =
    await import("../services/buildGpuBillingTickDeps.js");
  resetRunwayThrottleForTests();
  // old0 exists: the fleet-wide claim (a CAS on its row) is what lets a check through.
  const db = makeDb({ deployments: [{ id: "old0" }], balances: {} });
  let nowMs = 0;
  const deps = buildGpuBillingTickDeps({
    prisma: db.prisma as never,
    stopDeployment: async () => ({ reclaimed: true }),
    ensureRunway: async () => ({ toppedUp: false }),
    runwayCheckIntervalMs: 1000,
    now: () => new Date(nowMs),
  });
  const row = (id: string) => ({
    id, orgId: "o", gpuTier: "4090", replicas: 1, status: "running", billedThroughAt: T0,
    nosanaDeploymentId: `dm_${id}`, runGeneration: 0, reservationCents: null, reservationReleasedAt: null,
  });
  // 1,200 distinct deployments checked long ago ...
  for (let i = 0; i < 1_200; i += 1) await deps.ensureRunway!(row(`old${i}`));
  assert.equal(runwayThrottleSizeForTests(), 1_200, "every check is remembered until a prune");
  // ... then time passes and a new check triggers the prune
  nowMs = 1_000_000;
  await deps.ensureRunway!(row("fresh"));
  // The size is the assertion that pins the prune: a stamp this old would not
  // throttle anyway, so "old0 is checked again" below holds with or without it.
  assert.equal(runwayThrottleSizeForTests(), 1, "only the fresh entry is left");
  // a stale entry was forgotten: checking it again is NOT throttled
  let called = 0;
  const again = buildGpuBillingTickDeps({
    prisma: db.prisma as never,
    stopDeployment: async () => ({ reclaimed: true }),
    ensureRunway: async () => {
      called += 1;
      return { toppedUp: false };
    },
    runwayCheckIntervalMs: 1000,
    now: () => new Date(nowMs),
  });
  await again.ensureRunway!(row("old0"));
  assert.equal(called, 1);
});

// ============================================
// Review #9: the final window of a credit-exhaustion stop
// ============================================

function poorDb(over: Partial<Dep> = {}) {
  return makeDb({
    deployments: [{ id: "poor", orgId: "org_poor", reservationCents: 100n, ...over }],
    balances: { org_poor: 0n },
    nodes: [{ id: "n1", deploymentId: "poor" }],
  });
}

test("the final window ends when the Nosana stop RETURNED, not when the tick started (review #9)", async () => {
  // The tick starts at +300 s; Nosana takes 30 s to confirm the stop. The GPU
  // ran until then, so the tail is billed up to +330 s.
  const db = poorDb();
  const { tick, clock } = await build(db, {
    stopDeployment: async () => {
      clock.value = at(330);
      return { reclaimed: true };
    },
  });

  await tick(at(300));

  const dep = db.state.deployments[0]!;
  assert.equal(dep.status, "stopped");
  assert.deepEqual(dep.stoppedAt, at(330), "stop time = after the stop call returned");
  assert.deepEqual(dep.reservationReleasedAt, at(330));
  // 330 s x 250 uUSD = 82,500 uUSD = 8.25 cents -> ceil 9 (not ceil(7.5) = 8 for the 300 s window)
  assert.deepEqual(
    db.state.ledger.map((l) => [l.type, l.amountCents]),
    [
      ["deployment_reservation_release", 100n],
      ["gpu_usage", -9n],
    ],
  );
  assert.deepEqual(dep.billedThroughAt, at(330));
});

test("the final window uses the cursor and replica count read FRESH inside the transaction (review #9)", async () => {
  // Between this tick loading the row (replicas 1, cursor T0) and finishing the
  // stop, a replica change settled the window to +200 s and set replicas to 2.
  const db = poorDb();
  const { tick, clock } = await build(db, {
    stopDeployment: async () => {
      const row = db.state.deployments[0]!;
      row.replicas = 2;
      row.billedThroughAt = at(200);
      clock.value = at(300);
      return { reclaimed: true };
    },
  });

  await tick(at(300));

  // 100 s (200 -> 300) x 2 replicas x 250 uUSD = 50,000 uUSD = 5 cents (the
  // stale snapshot would have billed 300 s x 1 replica = 8 cents)
  assert.deepEqual(
    db.state.ledger.filter((l) => l.type === "gpu_usage").map((l) => l.amountCents),
    [-5n],
  );
});

test("the credit-exhaustion stop writes vaultReclaimedAt EXPLICITLY (null when the vault was not recovered) (review #3)", async () => {
  const db = poorDb({ vaultReclaimedAt: at(-3600) }); // a stale stamp from an earlier run
  const { tick } = await build(db, { stopDeployment: async () => ({ reclaimed: false }) });
  await tick(at(300));
  assert.equal(db.state.deployments[0]!.status, "stopped");
  assert.equal(db.state.deployments[0]!.vaultReclaimedAt, null, "the old stamp is cleared, the sweep retries");
});

test("the release in the credit-exhaustion stop only opens for a terminal row (status guard)", async () => {
  const db = poorDb();
  const wheres: any[] = [];
  const inner = db.prisma.deployment.updateMany;
  (db.prisma.deployment as any).updateMany = async (args: any) => {
    wheres.push(args.where);
    return inner(args);
  };
  const { tick } = await build(db);
  await tick(at(300));
  const release = wheres.find((w) => w.reservationReleasedAt === null);
  assert.deepEqual(release.status, { in: ["stopped", "failed"] });
});

// ============================================
// The credit-exhaustion stop names the run it stopped
// ============================================

test("a credit-exhaustion stop that outlived a stop + restart does not stop the restarted run", async () => {
  // The tick loaded run 0 (dm_X), could not charge it, and its Nosana stop was
  // slow. Meanwhile the row was stopped and restarted: run 1 (dm_Y) is running
  // again. {id, status: running} alone matched run 1.
  const db = makeDb({
    deployments: [
      {
        id: "poor",
        orgId: "org_poor",
        nosanaJobIds: ["dm_Y"],
        runGeneration: 1,
        reservationCents: 90n,
        billedThroughAt: at(300),
      },
    ],
    balances: { org_poor: 5n },
    nodes: [{ id: "n1", deploymentId: "poor" }],
  });
  const { deps, clock } = await build(db);
  clock.value = at(400);
  const staleRow = {
    id: "poor", orgId: "org_poor", gpuTier: "4090", replicas: 1, status: "running", billedThroughAt: T0,
    nosanaDeploymentId: "dm_X", runGeneration: 0, reservationCents: 90n, reservationReleasedAt: null,
  };

  const out = await deps.markStoppedForInsufficientCredits(staleRow, { reclaimed: true });

  assert.deepEqual(out, { stopped: false });
  const row = db.state.deployments[0]!;
  assert.equal(row.status, "running", "run 1 was never stopped on Nosana");
  assert.equal(row.statusReason, null);
  assert.equal(row.vaultReclaimedAt, null, "dm_X's vault result is not stamped on dm_Y's run");
  assert.equal(row.reservationReleasedAt, null, "run 1 keeps its hold");
  assert.equal(bal(db, "org_poor"), 5n);
  assert.deepEqual(db.state.ledger, []);
  assert.equal(db.state.nodes.length, 1, "and its nodes");
});

test("the credit-exhaustion claim carries the run generation AND the Nosana id that was stopped", async () => {
  const db = makeDb({ deployments: [{ id: "poor", orgId: "org_poor", runGeneration: 2 }], balances: { org_poor: 0n } });
  const wheres: any[] = [];
  const inner = db.prisma.deployment.updateMany;
  (db.prisma.deployment as any).updateMany = async (args: any) => {
    wheres.push(args.where);
    return inner(args);
  };
  const { deps, clock } = await build(db);
  clock.value = at(60);
  const [row] = await deps.loadRunningDeployments();
  assert.equal(row!.runGeneration, 2, "loaded with the row");

  assert.deepEqual(await deps.markStoppedForInsufficientCredits(row!, { reclaimed: true }), { stopped: true });
  assert.deepEqual(wheres[0], {
    id: "poor",
    status: "running",
    runGeneration: 2,
    nosanaJobIds: { has: "dm_poor" },
  });

  // Same generation but a different Nosana id on the row is also a miss.
  db.state.deployments[0]!.status = "running";
  db.state.deployments[0]!.nosanaJobIds = ["dm_other"];
  assert.deepEqual(await deps.markStoppedForInsufficientCredits(row!, { reclaimed: true }), { stopped: false });
});

test("initialiseCursor is tied to the run that was loaded", async () => {
  const db = makeDb({ deployments: [{ id: "d1", billedThroughAt: null, runGeneration: 1 }], balances: {} });
  const { deps } = await build(db);
  const [row] = await deps.loadRunningDeployments();
  assert.deepEqual(await deps.initialiseCursor({ ...row!, runGeneration: 0 }, at(60)), { count: 0 });
  assert.equal(db.state.deployments[0]!.billedThroughAt, null);
  assert.deepEqual(await deps.initialiseCursor(row!, at(60)), { count: 1 });
});

// ============================================
// W2-9: a retried finalisation ends the final window when the GPUs stopped
// ============================================

test("a finalisation that fails after a confirmed stop is retried against the time the GPUs STOPPED, not the retry's clock", async () => {
  // Tick 1 (+300 s): cannot charge, Nosana stops the GPUs at +301 s, then the
  // finalisation transaction fails and the row rolls back to `running`.
  // Tick 2 (+360 s): Nosana reports "already stopped". Before, the final window
  // ran to tick 2's clock: 362 s (10 cents) for GPUs that ran 301 s (8 cents).
  const db = poorDb();
  let stops = 0;
  const { tick, clock } = await build(db, {
    stopDeployment: async () => {
      stops += 1;
      if (stops === 1) {
        clock.value = at(301);
        return { reclaimed: false, alreadyStopped: false };
      }
      clock.value = at(362);
      return { reclaimed: true, alreadyStopped: true };
    },
  });
  // A rollback swaps the fake's row objects, so the row is looked up afresh.
  const dep = () => db.state.deployments[0]!;

  const realTx = db.prisma.$transaction;
  let failNext = false;
  (db.prisma as any).$transaction = (fn: any) => {
    // chargeWindow's transaction runs first (and rolls back by itself); the
    // finalisation is the one made to fail.
    return realTx(async (tx: any) => {
      const out = await fn(tx);
      if (failNext) {
        failNext = false;
        throw new Error("P2024: pool timeout");
      }
      return out;
    });
  };

  const realStop = (db.prisma.deployment as any).updateMany;
  (db.prisma.deployment as any).updateMany = async (args: any) => {
    const out = await realStop(args);
    if (args.data.gpuStoppedAt) failNext = true; // the stop was recorded; fail what follows
    return out;
  };

  const first = await tick(at(300));
  assert.equal(first.failed, 1, "the finalisation failed");
  assert.equal(dep().status, "running", "rolled back");
  assert.deepEqual(dep().billedThroughAt, T0);
  assert.deepEqual(dep().gpuStoppedAt, at(301), "the confirmed stop time survived the rollback");
  assert.equal(db.state.ledger.length, 0);

  const second = await tick(at(360));
  assert.equal(second.stoppedForCredits, 1);
  assert.equal(dep().status, "stopped");
  assert.deepEqual(dep().stoppedAt, at(301), "the row stopped when the GPUs did");
  // 301 s x 250 uUSD = 7.525 cents -> 8, paid from the released hold.
  assert.deepEqual(
    db.state.ledger.map((l) => [l.type, l.amountCents]),
    [
      ["deployment_reservation_release", 100n],
      ["gpu_usage", -8n],
    ],
  );
  assert.deepEqual(dep().billedThroughAt, at(301));
});

test("a deployment Nosana had already stopped, with no recorded stop time, is not billed up to the tick's clock", async () => {
  const db = poorDb();
  const { tick } = await build(db, {
    stopDeployment: async () => ({ reclaimed: true, alreadyStopped: true }),
  });

  await tick(at(300));

  const dep = db.state.deployments[0]!;
  assert.equal(dep.status, "stopped");
  assert.equal(dep.gpuStoppedAt, null, "no stop time is invented");
  assert.deepEqual(db.state.ledger.map((l) => l.type), ["deployment_reservation_release"]);
  assert.deepEqual(dep.billedThroughAt, T0, "the window ends at the cursor");
});

test("a row whose GPUs are confirmed stopped is never billed past that time, even once the org can pay again", async () => {
  const db = makeDb({
    deployments: [{ id: "d1", gpuStoppedAt: at(100) }],
    balances: { org_1: 5000n },
  });
  const { tick } = await build(db);

  await tick(at(400));

  // 100 s x 250 uUSD = 2.5 cents -> 2 (80 s); never the 400 s the tick's clock says.
  assert.deepEqual(db.state.ledger.map((l) => l.amountCents), [-2n]);
  assert.deepEqual(db.state.deployments[0]!.billedThroughAt, at(80));
});

test("the stop time is recorded once per run and only on the run that was stopped", async () => {
  const db = poorDb({ runGeneration: 2 });
  const { deps, clock } = await build(db);
  const [row] = await deps.loadRunningDeployments();
  clock.value = at(50);
  await deps.stopDeployment(row!);
  assert.deepEqual(db.state.deployments[0]!.gpuStoppedAt, at(50));
  clock.value = at(90);
  await deps.stopDeployment(row!);
  assert.deepEqual(db.state.deployments[0]!.gpuStoppedAt, at(50), "a later call does not move it");

  const other = poorDb({ runGeneration: 3 });
  const built = await build(other);
  await built.deps.stopDeployment({ ...row!, runGeneration: 2 });
  assert.equal(other.state.deployments[0]!.gpuStoppedAt, null, "a restarted run is not stamped with the old run's stop");
});

// ============================================
// W2-8: the runway interval holds across API replicas
// ============================================

test("two API replicas' billing workers check a deployment's runway once per interval BETWEEN them", async () => {
  // Each replica has its own in-process throttle map. Before, pod B knew nothing
  // of pod A's check a minute earlier and ran the same three Nosana/RPC reads.
  setupEnv();
  const { buildGpuBillingTickDeps, resetRunwayThrottleForTests } = await import(
    "../services/buildGpuBillingTickDeps.js"
  );
  const { runGpuBillingTick } = await import("../services/runGpuBillingTick.js");
  const db = makeDb({ deployments: [{ id: "d1" }], balances: { org_1: 50_000n } });
  const checks: string[] = [];
  const jobOn = async (pod: string, now: Date) => {
    // A different process: none of the other pod's in-memory stamps.
    resetRunwayThrottleForTests();
    const deps = buildGpuBillingTickDeps({
      prisma: db.prisma as never,
      pricePerSecondUsd: priceOf,
      stopDeployment: async () => ({ reclaimed: true }),
      ensureRunway: async () => {
        checks.push(pod);
        return { toppedUp: false };
      },
      now: () => now,
    });
    await runGpuBillingTick({ now }, deps);
  };

  await jobOn("A", at(60));
  await jobOn("B", at(120));
  await jobOn("A", at(180));
  await jobOn("B", at(240));
  assert.deepEqual(checks, ["A"], "one check in the interval, whichever pod takes the job");
  assert.deepEqual(db.state.deployments[0]!.runwayCheckedAt, at(60));

  await jobOn("B", at(60 + 600));
  assert.deepEqual(checks, ["A", "B"], "and again once the interval has passed");
});
