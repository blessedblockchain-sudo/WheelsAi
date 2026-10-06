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

// Drives holdAdditionalReplicas / returnReplicaReservation in
// services/deploymentCreditGate.ts - how a replica change moves the stored
// credit reservation (PATCH /deployments/:id).

const priceOf = () => 0.00025; // 4090: one billing hour = 90 cents per replica

function makeTx(initial: {
  balance: bigint;
  reservationCents: bigint | null;
  reservationReleasedAt?: Date | null;
  /** Runs between the read and the compare-and-set write (a concurrent writer). */
  afterRead?: (state: { reservationCents: bigint | null; reservationReleasedAt: Date | null }) => void;
}) {
  const state = {
    balance: initial.balance,
    reservationCents: initial.reservationCents,
    reservationReleasedAt: initial.reservationReleasedAt ?? null,
    ledger: [] as Array<{ amountCents: bigint; type: string; referenceId: string; balanceAfter: bigint }>,
  };
  const tx = {
    creditBalance: {
      updateMany: async ({ where, data }: any) => {
        if (state.balance < where.balanceCents.gte) return { count: 0 };
        state.balance -= data.balanceCents.decrement;
        return { count: 1 };
      },
      update: async ({ data }: any) => {
        state.balance += data.balanceCents.increment;
        return { balanceCents: state.balance };
      },
      findUnique: async () => ({ balanceCents: state.balance }),
    },
    creditTransaction: {
      create: async ({ data }: any) => {
        state.ledger.push({
          amountCents: data.amountCents,
          type: data.type,
          referenceId: data.referenceId,
          balanceAfter: data.balanceAfter,
        });
        return {};
      },
    },
    deployment: {
      findUnique: async () => {
        const snapshot = {
          reservationCents: state.reservationCents,
          reservationReleasedAt: state.reservationReleasedAt,
        };
        initial.afterRead?.(state);
        return snapshot;
      },
      update: async ({ data }: any) => {
        state.reservationCents = data.reservationCents;
        return {};
      },
      updateMany: async ({ where, data }: any) => {
        if (
          state.reservationReleasedAt !== null ||
          state.reservationCents !== where.reservationCents
        ) {
          return { count: 0 };
        }
        state.reservationCents = data.reservationCents;
        return { count: 1 };
      },
    },
  };
  return { state, tx };
}

test("holdAdditionalReplicas reserves the added replicas and grows the stored hold", async () => {
  setupEnv();
  const { holdAdditionalReplicas } = await import("../services/deploymentCreditGate.js");
  const { state, tx } = makeTx({ balance: 1000n, reservationCents: 90n });

  const result = await holdAdditionalReplicas({
    tx: tx as never,
    deploymentId: "dep_1",
    orgId: "org_1",
    gpuTier: "4090",
    addedReplicas: 2,
    pricePerSecondUsd: priceOf,
  });

  assert.deepEqual(result, { ok: true, reservedCents: 180n });
  assert.equal(state.balance, 820n);
  assert.equal(state.reservationCents, 270n, "90 + 2 x 90");
  assert.deepEqual(state.ledger, [
    { amountCents: -180n, type: "deployment_reservation", referenceId: "dep_1", balanceAfter: 820n },
  ]);
});

test("holdAdditionalReplicas: an unaffordable hold changes nothing", async () => {
  setupEnv();
  const { holdAdditionalReplicas } = await import("../services/deploymentCreditGate.js");
  const { state, tx } = makeTx({ balance: 100n, reservationCents: 90n });
  const result = await holdAdditionalReplicas({
    tx: tx as never,
    deploymentId: "dep_1",
    orgId: "org_1",
    gpuTier: "4090",
    addedReplicas: 2,
    pricePerSecondUsd: priceOf,
  });
  assert.deepEqual(result, { ok: false, reason: "insufficient_credits", requiredCents: 180n });
  assert.equal(state.balance, 100n);
  assert.equal(state.reservationCents, 90n);
  assert.equal(state.ledger.length, 0);
});

test("holdAdditionalReplicas on a legacy row with no stored hold starts one", async () => {
  setupEnv();
  const { holdAdditionalReplicas } = await import("../services/deploymentCreditGate.js");
  const { state, tx } = makeTx({ balance: 1000n, reservationCents: null });
  await holdAdditionalReplicas({
    tx: tx as never,
    deploymentId: "dep_1",
    orgId: "org_1",
    gpuTier: "4090",
    addedReplicas: 1,
    pricePerSecondUsd: priceOf,
  });
  assert.equal(state.reservationCents, 90n);
});

test("returnReplicaReservation credits back part of the hold with a ledger row", async () => {
  setupEnv();
  const { returnReplicaReservation } = await import("../services/deploymentCreditGate.js");
  const { state, tx } = makeTx({ balance: 500n, reservationCents: 270n });

  const result = await returnReplicaReservation({
    tx: tx as never,
    deploymentId: "dep_1",
    orgId: "org_1",
    cents: 180n,
    reason: "scale down x2",
  });

  assert.deepEqual(result, { returnedCents: 180n });
  assert.equal(state.balance, 680n);
  assert.equal(state.reservationCents, 90n);
  assert.deepEqual(state.ledger, [
    { amountCents: 180n, type: "deployment_reservation_release", referenceId: "dep_1", balanceAfter: 680n },
  ]);
});

test("returnReplicaReservation never returns more than the deployment still holds", async () => {
  setupEnv();
  const { returnReplicaReservation } = await import("../services/deploymentCreditGate.js");
  const { state, tx } = makeTx({ balance: 0n, reservationCents: 50n });
  const result = await returnReplicaReservation({
    tx: tx as never,
    deploymentId: "dep_1",
    orgId: "org_1",
    cents: 500n,
    reason: "scale down",
  });
  assert.deepEqual(result, { returnedCents: 50n });
  assert.equal(state.balance, 50n);
  assert.equal(state.reservationCents, 0n);
});

test("returnReplicaReservation is a no-op once the reservation was released or never held", async () => {
  setupEnv();
  const { returnReplicaReservation } = await import("../services/deploymentCreditGate.js");

  const released = makeTx({ balance: 500n, reservationCents: 90n, reservationReleasedAt: new Date() });
  assert.deepEqual(
    await returnReplicaReservation({ tx: released.tx as never, deploymentId: "d", orgId: "o", cents: 90n, reason: "x" }),
    { returnedCents: 0n },
  );
  assert.equal(released.state.balance, 500n, "the terminal release already refunded everything");

  const none = makeTx({ balance: 500n, reservationCents: null });
  assert.deepEqual(
    await returnReplicaReservation({ tx: none.tx as never, deploymentId: "d", orgId: "o", cents: 90n, reason: "x" }),
    { returnedCents: 0n },
  );
  assert.equal(none.state.ledger.length, 0);
});

// Review #1 (related): the scale-down path returns part of the hold in its OWN
// transaction, so the terminal release can commit between its read and write.

test("returnReplicaReservation: a release that commits between the read and the write means NO credit (no double refund)", async () => {
  setupEnv();
  const { returnReplicaReservation } = await import("../services/deploymentCreditGate.js");
  const { state, tx } = makeTx({
    balance: 500n,
    reservationCents: 270n,
    // the status worker's release lands right after we read 270
    afterRead: (st) => {
      st.reservationReleasedAt = new Date();
    },
  });
  const result = await returnReplicaReservation({
    tx: tx as never,
    deploymentId: "dep_1",
    orgId: "org_1",
    cents: 90n,
    reason: "scale down",
  });
  assert.deepEqual(result, { returnedCents: 0n });
  assert.equal(state.balance, 500n, "the release already refunded everything; this must not refund again");
  assert.equal(state.ledger.length, 0);
});

test("returnReplicaReservation: a concurrent resize of the hold between read and write also aborts it", async () => {
  setupEnv();
  const { returnReplicaReservation } = await import("../services/deploymentCreditGate.js");
  const { state, tx } = makeTx({
    balance: 500n,
    reservationCents: 270n,
    afterRead: (st) => {
      st.reservationCents = 360n; // another replica change grew the hold
    },
  });
  const result = await returnReplicaReservation({
    tx: tx as never, deploymentId: "dep_1", orgId: "org_1", cents: 90n, reason: "scale down",
  });
  assert.deepEqual(result, { returnedCents: 0n });
  assert.equal(state.reservationCents, 360n, "untouched");
  assert.equal(state.balance, 500n);
});
