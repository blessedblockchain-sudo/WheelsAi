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

// Drives apps/api/src/services/creditGrant.ts (B2/T1) — the ONE way
// credits come into existence. Every rail (Stripe webhook, wallet
// top-up, dev mock) funnels through it, so the invariant "balance moved
// ⇔ a ledger row explains it, with the right balanceAfter" is enforced
// once instead of re-implemented per rail.

interface Recorded {
  ledger: Array<{
    type: string;
    amountCents: bigint;
    balanceAfter: bigint;
    referenceId: string;
    description: string;
  }>;
  balance: bigint;
}

function makeTx(startingBalance = 0n) {
  const state: Recorded = { ledger: [], balance: startingBalance };
  const tx = {
    creditBalance: {
      upsert: async (args: { update: { balanceCents: { increment: bigint } } }) => {
        state.balance += args.update.balanceCents.increment;
        return { balanceCents: state.balance };
      },
      update: async (args: { data: { balanceCents: { increment: bigint } } }) => {
        state.balance += args.data.balanceCents.increment;
        return { balanceCents: state.balance };
      },
    },
    creditTransaction: {
      create: async (args: { data: Recorded["ledger"][number] }) => {
        state.ledger.push(args.data);
        return {};
      },
    },
  };
  return { tx, state };
}

test("a purchase writes one ledger row whose balanceAfter matches the new balance", async () => {
  setupEnv();
  const { grantCredits } = await import("../services/creditGrant.js");
  const { tx, state } = makeTx(1_000n);

  const result = await grantCredits(tx as never, {
    orgId: "org_1",
    amountCents: 5_000n,
    referenceId: "cs_test_123",
    description: "Credit purchase: $50",
  });

  assert.equal(state.balance, 6_000n);
  assert.equal(result.balanceAfterCents, 6_000n);
  assert.equal(result.grantedCents, 5_000n);
  assert.equal(state.ledger.length, 1);
  assert.equal(state.ledger[0]!.type, "purchase");
  assert.equal(state.ledger[0]!.balanceAfter, 6_000n);
  assert.equal(state.ledger[0]!.referenceId, "cs_test_123");
});

test("a bonus is a SECOND ledger row, and each row's balanceAfter is its own", async () => {
  const { grantCredits } = await import("../services/creditGrant.js");
  const { tx, state } = makeTx(0n);

  const result = await grantCredits(tx as never, {
    orgId: "org_1",
    amountCents: 10_000n,
    bonusCents: 1_500n,
    referenceId: "cs_test_456",
    description: "Credit purchase: $100",
  });

  assert.equal(state.ledger.length, 2);
  assert.equal(state.ledger[0]!.type, "purchase");
  assert.equal(state.ledger[0]!.balanceAfter, 10_000n, "balance after the purchase only");
  assert.equal(state.ledger[1]!.type, "bonus");
  assert.equal(state.ledger[1]!.balanceAfter, 11_500n, "balance after the bonus");
  assert.equal(result.grantedCents, 11_500n);
  // The running balance is reconstructable from the ledger alone.
  const summed = state.ledger.reduce((s, r) => s + r.amountCents, 0n);
  assert.equal(summed, state.balance);
});

test("both rows carry the SAME referenceId — a double-delivered webhook stays auditable", async () => {
  const { grantCredits } = await import("../services/creditGrant.js");
  const { tx, state } = makeTx();
  await grantCredits(tx as never, {
    orgId: "org_1",
    amountCents: 50_000n,
    bonusCents: 10_000n,
    referenceId: "topup_row_abc",
    description: "USDC top-up",
  });
  assert.deepEqual(
    state.ledger.map((r) => r.referenceId),
    ["topup_row_abc", "topup_row_abc"],
  );
});

test("a labelPrefix marks non-production rails on every row", async () => {
  const { grantCredits } = await import("../services/creditGrant.js");
  const { tx, state } = makeTx();
  await grantCredits(tx as never, {
    orgId: "org_1",
    amountCents: 5_000n,
    bonusCents: 500n,
    referenceId: "ref",
    description: "USDC top-up",
    labelPrefix: "[devnet-test] ",
  });
  assert.ok(state.ledger.every((r) => r.description.startsWith("[devnet-test] ")));
});

test("nonsense grants are refused rather than silently written", async () => {
  const { grantCredits } = await import("../services/creditGrant.js");
  const { tx, state } = makeTx();

  await assert.rejects(
    grantCredits(tx as never, {
      orgId: "o",
      amountCents: 0n,
      referenceId: "r",
      description: "d",
    }),
    /must be positive/,
  );
  await assert.rejects(
    grantCredits(tx as never, {
      orgId: "o",
      amountCents: 100n,
      bonusCents: -1n,
      referenceId: "r",
      description: "d",
    }),
    /cannot be negative/,
  );
  await assert.rejects(
    grantCredits(tx as never, {
      orgId: "o",
      amountCents: 100n,
      referenceId: "",
      description: "d",
    }),
    /referenceId is required/,
  );

  assert.equal(state.ledger.length, 0, "no partial writes");
  assert.equal(state.balance, 0n);
});

test("the bonus ladder is tiered and the purchase bounds are enforced", async () => {
  const {
    bonusForAmount,
    validatePurchaseAmount,
    MIN_PURCHASE_DOLLARS,
  } = await import("../services/creditPackages.js");

  assert.equal(bonusForAmount(10), 0);
  assert.equal(bonusForAmount(49.99), 0);
  assert.equal(bonusForAmount(50), 5);
  assert.equal(bonusForAmount(75), 5, "free-form amounts get their tier");
  assert.equal(bonusForAmount(100), 15);
  assert.equal(bonusForAmount(500), 100);
  assert.equal(bonusForAmount(10_000), 100);

  assert.equal(validatePurchaseAmount(50), null);
  assert.match(validatePurchaseAmount(MIN_PURCHASE_DOLLARS - 1)!, /Minimum/);
  assert.match(validatePurchaseAmount(10_001)!, /Maximum/);
  assert.match(validatePurchaseAmount(Number.NaN)!, /must be a number/);
});
