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
setupEnv();

import {
  runDeploymentStatusTick,
  type DeploymentStatusTickDeps,
} from "../services/runDeploymentStatusTick.js";

// deploymentCreditGate reaches config/env at module scope, and ESM hoists
// every import above setupEnv() — so this one is loaded lazily, after the
// env is in place.
const loadGate = () => import("../services/deploymentCreditGate.js");

// A deployment took a credit hold at admission and NOTHING ever gave it
// back. Observed live: creating a deployment reserved $0.37, the status
// worker flipped it to `failed` ~20s later, and the balance stayed down —
// the org paid for capacity it never received. A successful deployment
// was worse in a quieter way: it kept the hold AND was charged metered
// usage on top.

interface LedgerRow {
  type: string;
  amountCents: bigint;
  referenceId: string;
  balanceAfter: bigint;
}

function makeTx(opts: { casCount?: number; balance?: bigint } = {}) {
  const state = {
    balance: opts.balance ?? 1_000n,
    ledger: [] as LedgerRow[],
    casWheres: [] as unknown[],
  };
  const table = {
    updateMany: async (args: { where: unknown }) => {
      state.casWheres.push(args.where);
      return { count: opts.casCount ?? 1 };
    },
  };
  const tx = {
    deployment: table,
    agentDeployment: table,
    creditBalance: {
      update: async (a: { data: { balanceCents: { increment: bigint } } }) => {
        state.balance += a.data.balanceCents.increment;
        return { balanceCents: state.balance };
      },
      updateMany: async () => ({ count: 1 }),
      findUnique: async () => ({ balanceCents: state.balance }),
    },
    creditTransaction: {
      create: async (a: { data: LedgerRow }) => {
        state.ledger.push(a.data);
        return {};
      },
    },
  };
  return { tx, state };
}

test("a released reservation credits the balance back and is auditable", async () => {
  const { releaseDeploymentReservation } = await loadGate();
  const { tx, state } = makeTx({ balance: 463n });
  const result = await releaseDeploymentReservation({
    tx: tx as never,
    kind: "model",
    deploymentId: "dep-1",
    orgId: "org-1",
    reservationCents: 37n,
    reason: "failed",
  });

  assert.deepEqual(result, { released: true, amountCents: 37n });
  assert.equal(state.balance, 500n, "the hold is back");
  assert.equal(state.ledger.length, 1);
  assert.equal(state.ledger[0]!.type, "deployment_reservation_release");
  assert.equal(state.ledger[0]!.amountCents, 37n);
  // The deployment id — the original reservation used
  // `deploy:<model>:<timestamp>`, which could not be traced to any row.
  assert.equal(state.ledger[0]!.referenceId, "dep-1");
  assert.equal(state.ledger[0]!.balanceAfter, 500n);
});

test("LOSING the CAS refunds nothing — two ticks cannot double-refund", async () => {
  const { releaseDeploymentReservation } = await loadGate();
  const { tx, state } = makeTx({ casCount: 0, balance: 463n });
  const result = await releaseDeploymentReservation({
    tx: tx as never,
    kind: "model",
    deploymentId: "dep-1",
    orgId: "org-1",
    reservationCents: 37n,
    reason: "failed",
  });
  assert.deepEqual(result, { released: false, reason: "already_released" });
  assert.equal(state.balance, 463n, "balance untouched");
  assert.equal(state.ledger.length, 0);
});

test("the CAS guards on reservationReleasedAt being null", async () => {
  const { releaseDeploymentReservation } = await loadGate();
  const { tx, state } = makeTx();
  await releaseDeploymentReservation({
    tx: tx as never,
    kind: "agent",
    deploymentId: "ad-1",
    orgId: "org-1",
    reservationCents: 10n,
    reason: "stopped",
  });
  assert.deepEqual(state.casWheres[0], {
    id: "ad-1",
    reservationReleasedAt: null,
  });
});

test("a zero reservation is a no-op, not a zero-value ledger row", async () => {
  const { releaseDeploymentReservation } = await loadGate();
  const { tx, state } = makeTx();
  const result = await releaseDeploymentReservation({
    tx: tx as never,
    kind: "model",
    deploymentId: "dep-1",
    orgId: "org-1",
    reservationCents: 0n,
    reason: "failed",
  });
  assert.deepEqual(result, { released: false, reason: "nothing_reserved" });
  assert.equal(state.ledger.length, 0);
});

// ============================================
// The tick's release trigger
// ============================================

function tickDeps(
  over: Partial<DeploymentStatusTickDeps> = {},
): { deps: DeploymentStatusTickDeps; released: unknown[] } {
  const released: unknown[] = [];
  const deps: DeploymentStatusTickDeps = {
    loadDeployments: async () => [],
    getJobState: async () => "failed",
    persistTransition: async () => ({ count: 1 }),
    checkNodeHealth: async () => ({ healthy: true, latencyMs: 1 }),
    persistNodeHealth: async () => {},
    emitTransition: async () => {},
    releaseReservation: async (args) => {
      released.push(args);
      return { released: true };
    },
    ...over,
  };
  return { deps, released };
}

function row(over: Record<string, unknown> = {}) {
  return {
    kind: "model" as const,
    id: "dep-1",
    orgId: "org-1",
    status: "running",
    nosanaJobIds: ["job-1"],
    reservationCents: 37n,
    reservationReleasedAt: null,
    ...over,
  };
}

test("a deployment observed FAILED releases its hold", async () => {
  const { deps, released } = tickDeps({
    loadDeployments: async () => [row()],
    getJobState: async () => "failed",
  });
  const result = await runDeploymentStatusTick({ now: new Date() }, deps);
  assert.equal(result.reservationsReleased, 1);
  assert.equal((released[0] as { reason: string }).reason, "failed");
  assert.equal((released[0] as { reservationCents: bigint }).reservationCents, 37n);
});

test("a deployment observed COMPLETED (stopped) also releases — the hold is not a fee", async () => {
  // The ticket bought admission; actual consumption is billed by
  // metering. Keeping the hold after the run would charge twice.
  const { deps, released } = tickDeps({
    loadDeployments: async () => [row()],
    getJobState: async () => "completed",
  });
  const result = await runDeploymentStatusTick({ now: new Date() }, deps);
  assert.equal(result.reservationsReleased, 1);
  assert.equal((released[0] as { reason: string }).reason, "stopped");
});

test("only the CAS WINNER releases — a losing tick refunds nothing", async () => {
  const { deps, released } = tickDeps({
    loadDeployments: async () => [row()],
    persistTransition: async () => ({ count: 0 }),
  });
  const result = await runDeploymentStatusTick({ now: new Date() }, deps);
  assert.equal(result.reservationsReleased, 0);
  assert.equal(released.length, 0);
});

test("an already-released deployment is not released again", async () => {
  const { deps, released } = tickDeps({
    loadDeployments: async () => [row({ reservationReleasedAt: new Date() })],
  });
  await runDeploymentStatusTick({ now: new Date() }, deps);
  assert.equal(released.length, 0);
});

test("a deployment with no hold is skipped", async () => {
  const { deps, released } = tickDeps({
    loadDeployments: async () => [row({ reservationCents: null })],
  });
  await runDeploymentStatusTick({ now: new Date() }, deps);
  assert.equal(released.length, 0);
});

test("a refund failure never undoes the status transition", async () => {
  // The status change is already committed; the row still has a null
  // reservationReleasedAt, which is what selects it for a later retry.
  const { deps } = tickDeps({
    loadDeployments: async () => [row()],
    releaseReservation: async () => {
      throw new Error("db unavailable");
    },
  });
  const result = await runDeploymentStatusTick({ now: new Date() }, deps);
  assert.equal(result.transitioned, 1, "the transition still counted");
  assert.equal(result.reservationsReleased, 0);
});
