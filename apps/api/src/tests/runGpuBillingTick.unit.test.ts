import assert from "node:assert/strict";
import test from "node:test";

import {
  runGpuBillingTick,
  type GpuBillingRow,
  type GpuBillingTickDeps,
  type GpuChargeOutcome,
} from "../services/runGpuBillingTick.js";

// Drives apps/api/src/services/runGpuBillingTick.ts - the pure orchestrator
// behind the gpu-billing BullMQ worker. The money mechanics (CAS, conditional
// decrement, ledger) are covered in gpuBilling.unit.test.ts and the composed
// behaviour in buildGpuBillingTickDeps.unit.test.ts; this file pins the tick's
// decisions: who is charged, who is initialised, who is stopped and in what
// order, and that one bad row never stops the rest.

const NOW = new Date("2026-09-30T12:00:00.000Z");
const CURSOR = new Date("2026-09-30T11:59:00.000Z");

function row(over: Partial<GpuBillingRow> = {}): GpuBillingRow {
  return {
    id: "dep_1",
    orgId: "org_1",
    gpuTier: "4090",
    replicas: 1,
    status: "running",
    billedThroughAt: CURSOR,
    nosanaDeploymentId: "dm_1",
    runGeneration: 0,
    reservationCents: 100n,
    reservationReleasedAt: null,
    ...over,
  };
}

function makeDeps(opts: {
  rows: GpuBillingRow[];
  charge?: Record<string, GpuChargeOutcome | Error>;
  initCount?: number;
  stopError?: Record<string, Error>;
  finaliseStopped?: boolean;
  finaliseError?: Error;
  runway?: boolean;
  runwayError?: Error;
}) {
  const log: string[] = [];
  const deps: GpuBillingTickDeps = {
    loadRunningDeployments: async () => opts.rows,
    initialiseCursor: async (r) => {
      log.push(`init:${r.id}`);
      return { count: opts.initCount ?? 1 };
    },
    chargeWindow: async (r) => {
      log.push(`charge:${r.id}`);
      const o = opts.charge?.[r.id];
      if (o instanceof Error) throw o;
      return o ?? { kind: "charged", cents: 2n, coveredSeconds: 80 };
    },
    stopDeployment: async (r) => {
      log.push(`stop:${r.id}`);
      const e = opts.stopError?.[r.id];
      if (e) throw e;
      return { reclaimed: true };
    },
    markStoppedForInsufficientCredits: async (r) => {
      log.push(`finalise:${r.id}`);
      if (opts.finaliseError) throw opts.finaliseError;
      return { stopped: opts.finaliseStopped ?? true };
    },
    ...(opts.runway || opts.runwayError
      ? {
          ensureRunway: async (r: GpuBillingRow) => {
            log.push(`runway:${r.id}`);
            if (opts.runwayError) throw opts.runwayError;
            return { toppedUp: true };
          },
        }
      : {}),
  };
  return { deps, log };
}

test("charges each running deployment and sums the cents", async () => {
  const { deps, log } = makeDeps({
    rows: [row({ id: "a" }), row({ id: "b" })],
    charge: {
      a: { kind: "charged", cents: 3n, coveredSeconds: 60 },
      b: { kind: "charged", cents: 4n, coveredSeconds: 60 },
    },
  });
  const r = await runGpuBillingTick({ now: NOW }, deps);
  assert.equal(r.scanned, 2);
  assert.equal(r.charged, 2);
  assert.equal(r.chargedCents, 7n);
  assert.deepEqual(log, ["charge:a", "charge:b"]);
});

test("a running row with no cursor is initialised to now and NOT charged for the past", async () => {
  const { deps, log } = makeDeps({ rows: [row({ billedThroughAt: null })] });
  const r = await runGpuBillingTick({ now: NOW }, deps);
  assert.deepEqual(log, ["init:dep_1"], "no chargeWindow for a cursorless row");
  assert.equal(r.cursorsInitialised, 1);
  assert.equal(r.charged, 0);
});

test("a lost cursor-initialisation CAS is counted, not retried or charged", async () => {
  const { deps, log } = makeDeps({ rows: [row({ billedThroughAt: null })], initCount: 0 });
  const r = await runGpuBillingTick({ now: NOW }, deps);
  assert.equal(r.cursorLost, 1);
  assert.equal(r.cursorsInitialised, 0);
  assert.deepEqual(log, ["init:dep_1"]);
});

test("sub-cent windows and lost cursors are counted and never stop anything", async () => {
  const { deps, log } = makeDeps({
    rows: [row({ id: "a" }), row({ id: "b" })],
    charge: { a: { kind: "nothing_to_bill" }, b: { kind: "cursor_lost" } },
  });
  const r = await runGpuBillingTick({ now: NOW }, deps);
  assert.equal(r.nothingToBill, 1);
  assert.equal(r.cursorLost, 1);
  assert.equal(r.charged, 0);
  assert.ok(!log.some((l) => l.startsWith("stop:")));
});

test("an org that cannot pay: Nosana is stopped FIRST, then the row is finalised", async () => {
  const { deps, log } = makeDeps({
    rows: [row()],
    charge: { dep_1: { kind: "insufficient_credits", requiredCents: 2n } },
  });
  const r = await runGpuBillingTick({ now: NOW }, deps);
  assert.deepEqual(log, ["charge:dep_1", "stop:dep_1", "finalise:dep_1"]);
  assert.equal(r.insufficientCredits, 1);
  assert.equal(r.stoppedForCredits, 1);
  assert.equal(r.stopFailed, 0);
});

test("if Nosana cannot be stopped the row is NOT marked stopped (retried next tick)", async () => {
  const { deps, log } = makeDeps({
    rows: [row()],
    charge: { dep_1: { kind: "insufficient_credits", requiredCents: 2n } },
    stopError: { dep_1: new Error("nosana 503") },
  });
  const r = await runGpuBillingTick({ now: NOW }, deps);
  assert.deepEqual(log, ["charge:dep_1", "stop:dep_1"], "no finalise without a confirmed stop");
  assert.equal(r.stopFailed, 1);
  assert.equal(r.stoppedForCredits, 0);
  assert.equal(r.failed, 0, "an expected, retryable condition - not a row failure");
});

test("a finalise that loses the status CAS is counted as a concurrent writer, not a stop", async () => {
  const { deps } = makeDeps({
    rows: [row()],
    charge: { dep_1: { kind: "insufficient_credits", requiredCents: 2n } },
    finaliseStopped: false,
  });
  const r = await runGpuBillingTick({ now: NOW }, deps);
  assert.equal(r.stoppedForCredits, 0);
  assert.equal(r.cursorLost, 1);
});

test("a finalise failure after a confirmed stop is isolated; the status worker will observe the stop", async () => {
  const { deps } = makeDeps({
    rows: [row({ id: "a" }), row({ id: "b" })],
    charge: { a: { kind: "insufficient_credits", requiredCents: 2n } },
    finaliseError: new Error("db down"),
  });
  const r = await runGpuBillingTick({ now: NOW }, deps);
  assert.equal(r.failed, 1);
  assert.equal(r.charged, 1, "row b still billed");
});

test("one failing row never stops the others", async () => {
  const { deps, log } = makeDeps({
    rows: [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })],
    charge: { b: new Error("db deadlock") },
  });
  const r = await runGpuBillingTick({ now: NOW }, deps);
  assert.equal(r.scanned, 3);
  assert.equal(r.failed, 1);
  assert.equal(r.charged, 2);
  assert.deepEqual(log, ["charge:a", "charge:b", "charge:c"]);
});

test("the vault runway is refilled only for rows that were just charged", async () => {
  const { deps, log } = makeDeps({
    rows: [row({ id: "a" }), row({ id: "b" })],
    charge: { a: { kind: "charged", cents: 1n, coveredSeconds: 40 }, b: { kind: "nothing_to_bill" } },
    runway: true,
  });
  const r = await runGpuBillingTick({ now: NOW }, deps);
  assert.deepEqual(log.filter((l) => l.startsWith("runway")), ["runway:a"]);
  assert.equal(r.runwayToppedUp, 1);
});

test("a runway failure is counted but never fails the billing of the row", async () => {
  const { deps } = makeDeps({
    rows: [row()],
    runwayError: new Error("nosana down"),
  });
  const r = await runGpuBillingTick({ now: NOW }, deps);
  assert.equal(r.charged, 1);
  assert.equal(r.runwayFailed, 1);
  assert.equal(r.failed, 0);
});

test("loadRunningDeployments errors bubble so BullMQ records the tick failure", async () => {
  await assert.rejects(
    runGpuBillingTick(
      { now: NOW },
      {
        loadRunningDeployments: async () => {
          throw new Error("db unreachable");
        },
        initialiseCursor: async () => ({ count: 1 }),
        chargeWindow: async () => ({ kind: "nothing_to_bill" }),
        stopDeployment: async () => ({ reclaimed: true }),
        markStoppedForInsufficientCredits: async () => ({ stopped: true }),
      },
    ),
    /db unreachable/,
  );
});

test("an empty tick is a clean no-op", async () => {
  const { deps } = makeDeps({ rows: [] });
  const r = await runGpuBillingTick({ now: NOW }, deps);
  assert.equal(r.scanned, 0);
  assert.equal(r.chargedCents, 0n);
});

test("the credit-exhaustion finalisation is NOT handed the tick's start time: it takes its own clock after the stop (review #9)", async () => {
  let args: unknown[] = [];
  const { deps } = makeDeps({
    rows: [row()],
    charge: { dep_1: { kind: "insufficient_credits", requiredCents: 2n } },
  });
  deps.markStoppedForInsufficientCredits = async (...a: unknown[]) => {
    args = a;
    return { stopped: true };
  };
  await runGpuBillingTick({ now: NOW }, deps);
  assert.equal(args.length, 2, "(row, stop) only");
  assert.ok(!args.some((a) => a instanceof Date), "no stale timestamp crosses the seam");
});
