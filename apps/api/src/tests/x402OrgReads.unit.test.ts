import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";

// GET /api/x402/metrics, /payments and /payments/:paymentId read an
// organization's OWN x402 payments: those its deployments took. A payment
// with a listing was made by a stranger's wallet for one use of the
// organization's agent through the x402 door; its row names the seller as
// orgId, but the payer's wallet and the payer's failures are not the
// organization's to see. Hermetic: prisma.x402Payment is a stand-in that
// answers each where as the database would.

const ORG = "0f1e2d3c-4b5a-4968-8776-655443322110";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const DOOR_PAYER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

type Row = Record<string, any>;

function payment(over: Row): Row {
  const at = new Date("2026-10-14T09:00:00.000Z");
  return {
    id: "00000000-0000-4000-8000-000000000000",
    orgId: ORG,
    deploymentId: "d1d1d1d1-0000-4000-8000-000000000001",
    agentDeploymentId: null,
    listingId: null,
    messageHash: null,
    requestId: "req-1",
    network: "solana:devnet",
    asset: "USDC",
    amountRaw: "50000",
    amountUsd: 0.05,
    amountMicroUsd: null,
    payerAddress: "OwnPayer11111111111111111111111111111111111",
    payeeAddress: "Treasury1111111111111111111111111111111111",
    txSignature: "sig-own",
    signedTxB64: "c2lnbmVk",
    recentBlockhash: "hash",
    status: "settled",
    verifiedAt: at,
    settledAt: at,
    servedAt: at,
    submittedAt: at,
    failureReason: null,
    retryCount: 0,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

const OWN_SETTLED = payment({ id: "11111111-1111-4111-8111-111111111111", createdAt: new Date("2026-10-14T09:00:00.000Z") });
const OWN_FAILED = payment({
  id: "22222222-2222-4222-8222-222222222222",
  status: "failed",
  txSignature: "sig-own-failed",
  failureReason: "failed_on_chain",
  createdAt: new Date("2026-10-14T08:00:00.000Z"),
  updatedAt: new Date("2026-10-14T08:00:00.000Z"),
});
// A stranger's payments through the organization's agent's x402 door.
const DOOR_FAILED = payment({
  id: "33333333-3333-4333-8333-333333333333",
  deploymentId: null,
  listingId: "44444444-4444-4444-8444-444444444444",
  messageHash: "ab".repeat(32),
  payerAddress: DOOR_PAYER,
  status: "failed",
  txSignature: null,
  failureReason: "never_sent",
  createdAt: new Date("2026-10-14T10:00:00.000Z"),
  updatedAt: new Date("2026-10-14T10:00:00.000Z"),
});
const DOOR_VERIFIED = payment({
  id: "55555555-5555-4555-8555-555555555555",
  deploymentId: null,
  listingId: "44444444-4444-4444-8444-444444444444",
  messageHash: "cd".repeat(32),
  payerAddress: DOOR_PAYER,
  status: "verified",
  txSignature: "sig-door",
  createdAt: new Date("2026-10-14T11:00:00.000Z"),
});
const OTHER_ORGS = payment({ id: "66666666-6666-4666-8666-666666666666", orgId: OTHER_ORG, status: "failed" });

const ROWS = [OWN_SETTLED, OWN_FAILED, DOOR_FAILED, DOOR_VERIFIED, OTHER_ORGS];

/** Prisma's where for the shapes these reads use; a missing column is NULL. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key] ?? null;
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond) return cond.in.includes(value);
      if ("not" in cond) return value !== cond.not;
      throw new Error(`the stand-in does not know the condition on ${key}`);
    }
    return value === cond;
  });
}

async function withRoutes(fn: (inject: (url: string) => Promise<any>) => Promise<void>) {
  const { prisma } = await import("@wheelsai/db");
  const { x402Routes } = await import("../routes/x402.js");
  const Fastify = (await import("fastify")).default;
  const prismaAny = prisma as any;
  const saved = prismaAny.x402Payment;
  const desc = (rows: Row[]) => [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  prismaAny.x402Payment = {
    count: async ({ where }: Row = {}) => ROWS.filter((r) => matches(r, where)).length,
    findFirst: async ({ where }: Row = {}) => desc(ROWS.filter((r) => matches(r, where))).at(-1) ?? null,
    findMany: async ({ where, take, skip, select }: Row = {}) =>
      desc(ROWS.filter((r) => matches(r, where)))
        .slice(skip ?? 0, (skip ?? 0) + (take ?? ROWS.length))
        .map((r) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : r)),
  };
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as any).auth = { userId: "u", orgId: ORG, type: "jwt", role: "owner" };
  });
  await app.register(x402Routes, { prefix: "/api/x402" });
  try {
    await fn((url) => app.inject({ method: "GET", url }));
  } finally {
    await app.close();
    prismaAny.x402Payment = saved;
  }
}

/** One row as /payments has always shown it, field by field. */
function listed(row: Row): Row {
  return {
    id: row.id,
    requestId: row.requestId,
    deploymentId: row.deploymentId,
    network: row.network,
    asset: row.asset,
    amountRaw: row.amountRaw,
    amountUsd: row.amountUsd,
    payerAddress: row.payerAddress,
    payeeAddress: row.payeeAddress,
    txSignature: row.txSignature,
    status: row.status,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    settledAt: row.settledAt?.toISOString() ?? null,
    failureReason: row.failureReason,
    retryCount: row.retryCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

test("GET /api/x402/payments lists the organization's own payments as before, and none paid through its door", async () => {
  await withRoutes(async (inject) => {
    const res = await inject("/api/x402/payments");
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.payments, [listed(OWN_SETTLED), listed(OWN_FAILED)]);
    assert.deepEqual(body.pagination, { total: 2, limit: 20, offset: 0 });
    assert.ok(!res.body.includes(DOOR_PAYER), "a payer's wallet is not shown to the seller");

    // A filter by status keeps to the same rows.
    const failed = (await inject("/api/x402/payments?status=failed")).json();
    assert.deepEqual(failed.payments, [listed(OWN_FAILED)]);
    assert.equal(failed.pagination.total, 1);
    const verified = (await inject("/api/x402/payments?status=verified")).json();
    assert.deepEqual(verified.payments, []);
    assert.equal(verified.pagination.total, 0);
  });
});

test("GET /api/x402/payments/:paymentId finds the organization's own payment and not one paid through its door", async () => {
  await withRoutes(async (inject) => {
    const own = await inject(`/api/x402/payments/${OWN_FAILED.id}`);
    assert.equal(own.statusCode, 200, own.body);
    const shown = own.json().payment;
    assert.equal(shown.id, OWN_FAILED.id);
    assert.equal(shown.payerAddress, OWN_FAILED.payerAddress);
    assert.equal("signedTxB64" in shown, false);
    // The door's columns are not part of this answer.
    assert.equal(Object.keys(shown).includes("listingId"), false);
    assert.equal(Object.keys(shown).includes("messageHash"), false);

    for (const door of [DOOR_FAILED, DOOR_VERIFIED]) {
      const res = await inject(`/api/x402/payments/${door.id}`);
      assert.equal(res.statusCode, 404);
      assert.deepEqual(res.json(), { error: "Not Found", message: "X402 payment not found" });
    }
  });
});

test("GET /api/x402/metrics: the recent failures are the organization's own, never a payer's at its door", async () => {
  await withRoutes(async (inject) => {
    const res = await inject("/api/x402/metrics");
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(
      body.recentFailures.map((f: Row) => f.id),
      [OWN_FAILED.id],
    );
    assert.deepEqual(body.recentFailures[0], {
      id: OWN_FAILED.id,
      requestId: OWN_FAILED.requestId,
      txSignature: OWN_FAILED.txSignature,
      retryCount: 0,
      failureReason: "failed_on_chain",
      updatedAt: OWN_FAILED.updatedAt.toISOString(),
    });
    assert.ok(!res.body.includes("never_sent"));
  });
});
