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

const {
  DEPLOYMENT_RESERVATION_SECONDS,
  estimateDeploymentReservationCents,
  reserveDeploymentCredits,
} = await import("../services/deploymentCreditGate.js");
type CreditReservationPrisma = import("../services/deploymentCreditGate.js").CreditReservationPrisma;

// A4 (REMEDIATION_PLAN): GPU deployments are platform-paid; admission
// requires an atomic credit reservation. These tests pin the conditional-
// decrement semantics (no read-check-write race) and the ledger row.

const PRICE = () => 0.0005; // $0.0005/s → $1.80/h per replica

function makeStub(initialCents: bigint) {
  let balance = initialCents;
  const ledger: Array<{ amountCents: bigint; type: string; balanceAfter: bigint }> = [];

  const tx: CreditReservationPrisma = {
    creditBalance: {
      async updateMany({ where, data }) {
        // Mirrors `WHERE org_id = ? AND balance_cents >= ?` semantics.
        if (balance >= where.balanceCents.gte) {
          balance -= data.balanceCents.decrement;
          return { count: 1 };
        }
        return { count: 0 };
      },
      async findUnique() {
        return { balanceCents: balance };
      },
    },
    creditTransaction: {
      async create({ data }) {
        ledger.push({
          amountCents: data.amountCents,
          type: data.type,
          balanceAfter: data.balanceAfter,
        });
        return {};
      },
    },
  };

  return { tx, ledger, getBalance: () => balance };
}

test("estimate: 1 billing hour per replica, rounded up to cents", () => {
  // 0.0005 * 3600 = $1.80/replica → 180 cents; x3 replicas = 540
  assert.equal(DEPLOYMENT_RESERVATION_SECONDS, 3600);
  assert.equal(estimateDeploymentReservationCents("rtx4090", 1, PRICE), 180n);
  assert.equal(estimateDeploymentReservationCents("rtx4090", 3, PRICE), 540n);
  // replicas floor at 1
  assert.equal(estimateDeploymentReservationCents("rtx4090", 0, PRICE), 180n);
});

test("reservation succeeds: balance decremented, negative ledger row written", async () => {
  const { tx, ledger, getBalance } = makeStub(1000n);
  const result = await reserveDeploymentCredits({
    tx,
    orgId: "org_1",
    gpuTier: "rtx4090",
    replicas: 1,
    referenceId: "deploy:test:1",
    pricePerSecondUsd: PRICE,
  });

  assert.equal(result.ok, true);
  assert.equal(getBalance(), 820n);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]!.amountCents, -180n);
  assert.equal(ledger[0]!.type, "deployment_reservation");
  assert.equal(ledger[0]!.balanceAfter, 820n);
});

test("insufficient balance: no decrement, no ledger row, requiredCents surfaced", async () => {
  const { tx, ledger, getBalance } = makeStub(100n);
  const result = await reserveDeploymentCredits({
    tx,
    orgId: "org_1",
    gpuTier: "rtx4090",
    replicas: 1,
    referenceId: "deploy:test:2",
    pricePerSecondUsd: PRICE,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "insufficient_credits");
    assert.equal(result.requiredCents, 180n);
  }
  assert.equal(getBalance(), 100n);
  assert.equal(ledger.length, 0);
});

test("missing balance row behaves as insufficient (no credits = no deploy)", async () => {
  const tx: CreditReservationPrisma = {
    creditBalance: {
      async updateMany() {
        return { count: 0 }; // no row matches the WHERE
      },
      async findUnique() {
        return null;
      },
    },
    creditTransaction: {
      async create() {
        throw new Error("must not write a ledger row when reservation fails");
      },
    },
  };
  const result = await reserveDeploymentCredits({
    tx,
    orgId: "org_none",
    gpuTier: "rtx4090",
    replicas: 1,
    referenceId: "deploy:test:3",
    pricePerSecondUsd: PRICE,
  });
  assert.equal(result.ok, false);
});

test("two sequential reservations against a balance covering one: exactly one succeeds", async () => {
  const { tx, ledger } = makeStub(200n); // covers one 180-cent reservation
  const first = await reserveDeploymentCredits({
    tx,
    orgId: "org_1",
    gpuTier: "rtx4090",
    replicas: 1,
    referenceId: "deploy:race:1",
    pricePerSecondUsd: PRICE,
  });
  const second = await reserveDeploymentCredits({
    tx,
    orgId: "org_1",
    gpuTier: "rtx4090",
    replicas: 1,
    referenceId: "deploy:race:2",
    pricePerSecondUsd: PRICE,
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(ledger.length, 1);
});
