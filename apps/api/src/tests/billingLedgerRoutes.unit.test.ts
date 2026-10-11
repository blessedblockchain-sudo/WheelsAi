import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

import { SPEND_GROUPS } from "@wheelsai/shared/ledger";

import { APP_EXPOSED_HEADERS } from "../lib/corsPolicy.js";
import { createBillingLedgerRoutes } from "../routes/billingLedger.js";
import { buildBillingLedgerStore } from "../services/buildBillingLedgerDeps.js";
import {
  ORG,
  OTHER_ORG,
  ledgerRow,
  makeBillingDb,
  uuid,
  type StandInTables,
} from "./billingLedgerStandIn.js";

// routes/billingLedger.ts: the five routes of the Billing page, to the
// contract. The caller's organization comes from the session or the key,
// never from the request.

const NOW = new Date("2026-10-11T15:30:00.000Z");
const at = (iso: string) => new Date(iso);

function seed(): Partial<StandInTables> {
  return {
    creditBalance: [
      { orgId: ORG, balanceCents: 4_210n },
      { orgId: OTHER_ORG, balanceCents: 77_700n },
    ],
    deployment: [
      { id: uuid(1), orgId: ORG, name: "support-llm", reservationCents: 1_200n, reservationReleasedAt: null, createdAt: at("2026-10-02T10:00:00Z") },
      { id: uuid(2), orgId: OTHER_ORG, name: "theirs", reservationCents: 9_900n, reservationReleasedAt: null, createdAt: at("2026-10-02T10:00:00Z") },
    ],
    creditTransaction: [
      ledgerRow({ id: uuid(11), type: "PURCHASE", amountCents: 5_000n, balanceAfter: 5_000n, description: "Credit purchase: $50", createdAt: at("2026-10-01T09:00:00Z") }),
      ledgerRow({ id: uuid(12), type: "deployment_reservation", amountCents: -1_200n, balanceAfter: 3_800n, description: "Deployment hold", createdAt: at("2026-10-02T10:00:00Z") }),
      ledgerRow({ id: uuid(13), type: "gpu_usage", amountCents: -150n, balanceAfter: 3_650n, description: "GPU usage (a4000 x2, 900s)", gpuSeconds: 1_800n, createdAt: at("2026-10-03T10:00:00Z") }),
      ledgerRow({ id: uuid(14), type: "usage", amountCents: -40n, balanceAfter: 3_610n, description: "-inference", createdAt: at("2026-10-03T10:00:00Z") }),
      ledgerRow({ orgId: OTHER_ORG, id: uuid(15), type: "gpu_usage", amountCents: -8_800n, balanceAfter: 1n, description: "Theirs", gpuSeconds: 36_000n, createdAt: at("2026-10-03T10:00:00Z") }),
    ],
    usageRecord: [
      { orgId: ORG, periodStart: at("2026-10-03T10:00:00Z"), requestCount: 12, inputTokens: 340n, outputTokens: 560n },
    ],
  };
}

async function buildApp(tables: Partial<StandInTables> = seed()) {
  const standIn = makeBillingDb(tables);
  const app = Fastify({ logger: false });
  // Stands in for the global auth hook: the principal comes from the test.
  app.addHook("onRequest", async (request) => {
    const org = request.headers["x-test-org"];
    if (typeof org === "string") {
      (request as unknown as { auth: unknown }).auth = {
        userId: "user_1",
        orgId: org,
        role: "member",
        type: request.headers["x-test-key"] ? "api_key" : "jwt",
      };
    }
  });
  const signedIn = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.auth) {
      return reply.status(401).send({ error: "Unauthorized", message: "Authentication required" });
    }
  };
  await app.register(
    createBillingLedgerRoutes({
      ledger: { store: buildBillingLedgerStore(standIn.db), now: () => NOW },
      guards: { signedIn: [signedIn] },
    }),
    { prefix: "/api/billing" },
  );
  const get = (url: string, org: string | null = ORG) =>
    app.inject({ method: "GET", url, headers: org ? { "x-test-org": org } : {} });
  return { app, get, ...standIn };
}

const ROUTES = ["/balance", "/holds", "/usage", "/transactions", "/transactions/export"];

test("GET /balance: available, held, total, and pending as the same figure as held", async () => {
  const { app, get } = await buildApp();
  try {
    const res = await get("/api/billing/balance");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      balance: { available: 42.1, held: 12, total: 54.1, pending: 12 },
    });
  } finally {
    await app.close();
  }
});

test("GET /holds: what is held, why, and the total", async () => {
  const { app, get } = await buildApp();
  try {
    const res = await get("/api/billing/holds");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      holds: [
        {
          kind: "deployment",
          id: uuid(1),
          name: "support-llm",
          amount: 12,
          since: "2026-10-02T10:00:00.000Z",
          note: "Held while this deployment runs. It comes back when the deployment stops.",
        },
      ],
      total: 12,
    });
  } finally {
    await app.close();
  }
});

test("GET /usage: the month, its spending by heading, GPU hours and the counts; the invented fields are gone", async () => {
  const { app, get } = await buildApp();
  try {
    const res = await get("/api/billing/usage");
    assert.equal(res.statusCode, 200);
    const { usage } = res.json();
    assert.deepEqual(Object.keys(usage).sort(), [
      "currentMonth", "gpuHours", "inputTokens", "month", "outputTokens", "requests", "spend",
    ]);
    assert.equal(usage.month, "2026-10");
    assert.equal(usage.currentMonth, 1.9);
    assert.deepEqual(usage.spend.map((s: { group: string }) => s.group), [...SPEND_GROUPS]);
    assert.deepEqual(
      usage.spend.filter((s: { amount: number }) => s.amount !== 0),
      [
        { group: "gpu", label: "GPU time", amount: 1.5 },
        { group: "inference", label: "Inference", amount: 0.4 },
      ],
    );
    assert.equal(usage.gpuHours, 0.5);
    assert.deepEqual([usage.requests, usage.inputTokens, usage.outputTokens], [12, 340, 560]);
    for (const gone of ["avgCostPerHour", "computeCost", "requestsCost", "tokensCost", "metered"]) {
      assert.ok(!(gone in usage), gone);
    }
  } finally {
    await app.close();
  }
});

test("GET /transactions: newest first, with limit, cursor and filter", async () => {
  const { app, get } = await buildApp();
  try {
    const all = await get("/api/billing/transactions");
    assert.equal(all.statusCode, 200);
    assert.deepEqual(all.json().transactions.map((t: { id: string }) => t.id), [
      // The two rows of the same moment: the id decides.
      uuid(14), uuid(13), uuid(12), uuid(11),
    ]);
    assert.equal(all.json().nextCursor, null);
    assert.deepEqual(all.json().transactions[3], {
      id: uuid(11),
      amount: 50,
      type: "purchase",
      kind: "added",
      label: "Credits added",
      description: "Credit purchase: $50",
      balanceAfter: 50,
      createdAt: "2026-10-01T09:00:00.000Z",
    });
    assert.equal(all.json().transactions[1].amount, -1.5);

    const first = await get("/api/billing/transactions?limit=3");
    assert.equal(first.json().transactions.length, 3);
    const cursor = first.json().nextCursor;
    assert.equal(typeof cursor, "string");
    const second = await get(`/api/billing/transactions?limit=3&cursor=${cursor}`);
    assert.deepEqual(second.json().transactions.map((t: { id: string }) => t.id), [uuid(11)]);
    assert.equal(second.json().nextCursor, null);

    const ids = async (filter: string) =>
      (await get(`/api/billing/transactions?filter=${filter}`)).json().transactions.map((t: { id: string }) => t.id);
    assert.deepEqual(await ids("added"), [uuid(11)]);
    assert.deepEqual(await ids("spent"), [uuid(14), uuid(13)]);
    assert.deepEqual(await ids("held"), [uuid(12)]);
  } finally {
    await app.close();
  }
});

test("GET /transactions: a bad limit, cursor or filter is 400 invalid_request with the contract's sentence", async () => {
  const { app, get } = await buildApp();
  try {
    for (const query of ["limit=0", "limit=201", "limit=abc", "cursor=nope", "filter=all", "filter=added&filter=spent", "limit=5&limit=6"]) {
      const res = await get(`/api/billing/transactions?${query}`);
      assert.equal(res.statusCode, 400, query);
      assert.deepEqual(res.json(), {
        error: "invalid_request",
        message: "That list could not be read. Reload the page and try again.",
      });
    }
  } finally {
    await app.close();
  }
});

test("GET /transactions/export: a CSV file named by its range, for a session and for an API key", async () => {
  const { app, get } = await buildApp();
  try {
    const res = await get("/api/billing/transactions/export");
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /^text\/csv/);
    assert.equal(
      res.headers["content-disposition"],
      'attachment; filename="wheelsai-credits-2026-10-01-to-2026-10-11.csv"',
    );
    assert.deepEqual(res.body.split("\r\n"), [
      "Date (UTC),Type,What,Description,Amount (USD),Balance after (USD)",
      "2026-10-01T09:00:00.000Z,PURCHASE,Credits added,Credit purchase: $50,50,50",
      "2026-10-02T10:00:00.000Z,deployment_reservation,Held for a deployment,Deployment hold,-12,38",
      '2026-10-03T10:00:00.000Z,gpu_usage,GPU time,"GPU usage (a4000 x2, 900s)",-1.5,36.5',
      // A description that starts with a sign is made plain text; the amount is not.
      "2026-10-03T10:00:00.000Z,usage,Inference,'-inference,-0.4,36.1",
      "",
    ]);

    const ranged = await get("/api/billing/transactions/export?from=2026-10-02&to=2026-10-02");
    assert.equal(ranged.statusCode, 200);
    assert.equal(
      ranged.headers["content-disposition"],
      'attachment; filename="wheelsai-credits-2026-10-02-to-2026-10-02.csv"',
    );
    assert.equal(ranged.body.trim().split("\r\n").length, 2);

    // An API key of the organization reads the same file.
    const byKey = await app.inject({
      method: "GET",
      url: "/api/billing/transactions/export",
      headers: { "x-test-org": ORG, "x-test-key": "1" },
    });
    assert.equal(byKey.statusCode, 200);
    assert.equal(byKey.body, res.body);
  } finally {
    await app.close();
  }
});

test("GET /transactions/export: refusals carry the contract's codes and sentences", async () => {
  const { app, get } = await buildApp();
  try {
    for (const query of ["from=2026-10-01", "to=2026-10-01", "from=2026-10-05&to=2026-10-01", "from=soon&to=later", "from=2026-02-30&to=2026-03-01"]) {
      const res = await get(`/api/billing/transactions/export?${query}`);
      assert.equal(res.statusCode, 400, query);
      assert.deepEqual(res.json(), {
        error: "invalid_range",
        message: "Choose a start date and an end date, with the start first.",
      });
      assert.equal(res.headers["content-disposition"], undefined);
    }
  } finally {
    await app.close();
  }

  // Past what one file carries.
  const standIn = makeBillingDb();
  const store = buildBillingLedgerStore(standIn.db);
  const row = { id: uuid(1), amountCents: -1n, type: "usage", description: null, balanceAfter: 0n, createdAt: NOW };
  const big = Fastify({ logger: false });
  big.addHook("onRequest", async (request) => {
    (request as unknown as { auth: unknown }).auth = { userId: "u", orgId: ORG, role: "member", type: "jwt" };
  });
  await big.register(
    createBillingLedgerRoutes({
      ledger: {
        now: () => NOW,
        store: { ...store, ledgerInRange: async ({ take }) => Array.from({ length: take }, () => row) },
      },
      guards: { signedIn: [] },
    }),
    { prefix: "/api/billing" },
  );
  try {
    const res = await big.inject({ method: "GET", url: "/api/billing/transactions/export" });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), {
      error: "range_too_large",
      message: "That range holds more rows than one file can carry. Choose a shorter range.",
    });
  } finally {
    await big.close();
  }
});

test("the file's name is a header a browser may read", () => {
  assert.ok((APP_EXPOSED_HEADERS as readonly string[]).includes("Content-Disposition"));
});

test("every route: no principal is 401, and nothing is read", async () => {
  const { app, get, calls } = await buildApp();
  try {
    for (const route of ROUTES) {
      const res = await get(`/api/billing${route}`, null);
      assert.equal(res.statusCode, 401, route);
    }
    assert.equal(calls.length, 0);
  } finally {
    await app.close();
  }
});

test("every route: with no guard passed, the routes ask for requireAuth themselves", async () => {
  const standIn = makeBillingDb(seed());
  const app = Fastify({ logger: false });
  await app.register(
    createBillingLedgerRoutes({
      ledger: { store: buildBillingLedgerStore(standIn.db), now: () => NOW },
    }),
    { prefix: "/api/billing" },
  );
  try {
    for (const route of ROUTES) {
      const res = await app.inject({ method: "GET", url: `/api/billing${route}` });
      assert.equal(res.statusCode, 401, route);
      assert.equal(res.json().error, "Unauthorized");
    }
    assert.equal(standIn.calls.length, 0);
  } finally {
    await app.close();
  }
});

test("every route: the organization is the caller's, whatever the request says", async () => {
  const { app, get } = await buildApp();
  try {
    // The other organization reads its own.
    assert.deepEqual((await get("/api/billing/balance", OTHER_ORG)).json(), {
      balance: { available: 777, held: 99, total: 876, pending: 99 },
    });
    assert.deepEqual(
      (await get("/api/billing/holds", OTHER_ORG)).json().holds.map((h: { name: string }) => h.name),
      ["theirs"],
    );
    assert.equal((await get("/api/billing/usage", OTHER_ORG)).json().usage.currentMonth, 88);
    assert.equal((await get("/api/billing/usage", OTHER_ORG)).json().usage.requests, 0);

    // Naming another organization in the query changes nothing.
    for (const route of ROUTES) {
      const sep = route.includes("?") ? "&" : "?";
      const mine = await get(`/api/billing${route}`);
      const poked = await get(`/api/billing${route}${sep}orgId=${OTHER_ORG}&org_id=${OTHER_ORG}&buyerId=${OTHER_ORG}`);
      assert.equal(poked.statusCode, 200, route);
      assert.equal(poked.body, mine.body, route);
      assert.ok(!poked.body.includes("Theirs") && !poked.body.includes("theirs"), route);
    }
    const list = await get("/api/billing/transactions", OTHER_ORG);
    assert.deepEqual(list.json().transactions.map((t: { id: string }) => t.id), [uuid(15)]);
    const file = await get("/api/billing/transactions/export", OTHER_ORG);
    assert.equal(file.body.trim().split("\r\n").length, 2);
    assert.ok(file.body.includes("Theirs"));
  } finally {
    await app.close();
  }
});

test("every route: an unexpected failure is 500 billing_unavailable, and no thrown text reaches the answer", async () => {
  const { app, get, fail } = await buildApp();
  try {
    fail(new Error('Invalid `prisma.creditTransaction.findMany()` invocation: column "secret_col" at postgresql://user:hunter2@db'));
    for (const route of ROUTES) {
      const res = await get(`/api/billing${route}`);
      assert.equal(res.statusCode, 500, route);
      assert.deepEqual(res.json(), {
        error: "billing_unavailable",
        message: "Billing could not be read. Try again in a moment.",
      });
      for (const leak of ["prisma", "secret_col", "hunter2", "postgresql"]) {
        assert.ok(!res.body.includes(leak), `${route}: ${leak}`);
      }
      assert.equal(res.headers["content-disposition"], undefined, route);
    }
    // And they answer again once the database does.
    fail(null);
    assert.equal((await get("/api/billing/balance")).statusCode, 200);
  } finally {
    await app.close();
  }
});

test("the routes mount beside routes/billing.ts under the same prefix: the handlers they replace are gone from it", async () => {
  const { billingRoutes } = await import("../routes/billing.js");
  const standIn = makeBillingDb(seed());
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (request) => {
    (request as unknown as { auth: unknown }).auth = { userId: "u", orgId: ORG, role: "member", type: "jwt" };
  });
  // A route declared twice would refuse to register.
  await app.register(billingRoutes, { prefix: "/api/billing" });
  await app.register(
    createBillingLedgerRoutes({
      ledger: { store: buildBillingLedgerStore(standIn.db), now: () => NOW },
      guards: { signedIn: [] },
    }),
    { prefix: "/api/billing" },
  );
  try {
    await app.ready();
    const balance = await app.inject({ method: "GET", url: "/api/billing/balance" });
    assert.equal(balance.statusCode, 200);
    // The answer is the new one: what is held is counted.
    assert.equal(balance.json().balance.held, 12);
    assert.equal(balance.json().balance.pending, 12);
    // What routes/billing.ts still serves is still there.
    const packages = await app.inject({ method: "GET", url: "/api/billing/packages" });
    assert.equal(packages.statusCode, 200);
    assert.ok(Array.isArray(packages.json().packages));
  } finally {
    await app.close();
  }
});
