import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/routes/payments.ts — the dashboard's full
// ComputePayment history view. Paginated + filterable by status + date.
//
// The agent-detail route already shows last N payments inline; this is
// the dedicated full-history surface (status filters, date scrubbing,
// CSV export downstream).
//
// Loader returns null when the agent has no treasury (not tokenized) —
// the route renders 404, distinct from "[] payments yet" which is 200.

type Status =
  | "PENDING"
  | "SUBMITTING"
  | "SUBMITTED"
  | "CONFIRMED"
  | "FAILED"
  | "PARKED";

interface FakePayment {
  id: string;
  amountLamports: bigint;
  computeSeconds: bigint;
  status: Status;
  txSignature: string | null;
  paidAt: Date | null;
  scheduledFor: Date;
  errorMessage: string | null;
  createdAt: Date;
}

function makeApp(opts: {
  authed?: boolean;
  loadPayments?: (args: {
    slug: string;
    orgId: string;
    limit: number;
    offset: number;
    status: Status | null;
    from: Date | null;
    to: Date | null;
  }) => Promise<{ payments: FakePayment[]; totalCount: number } | null>;
}) {
  setupEnv();
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    if (opts.authed !== false) {
      request.auth = { userId: "u1", orgId: "org_1", type: "jwt" };
    }
  });
  return import("../routes/payments.js").then(async (mod) => {
    await app.register(
      mod.createPaymentsRoutes({
        loadPayments: opts.loadPayments ?? (async () => null),
      }),
    );
    return app;
  });
}

const samplePayment = (overrides: Partial<FakePayment> = {}): FakePayment => ({
  id: "cp_1",
  amountLamports: 4_500_000n,
  computeSeconds: 3600n,
  status: "CONFIRMED",
  txSignature: "sig_1",
  paidAt: new Date("2026-04-26T11:00:00Z"),
  scheduledFor: new Date("2026-04-26T10:55:00Z"),
  errorMessage: null,
  createdAt: new Date("2026-04-26T10:55:00Z"),
  ...overrides,
});

// ============================================
// Auth + scoping
// ============================================

test("GET /agents/:slug/payments returns 401 when unauthenticated", async () => {
  const app = await makeApp({ authed: false });
  const res = await app.inject({
    method: "GET",
    url: "/agents/eliza/payments",
  });
  assert.equal(res.statusCode, 401);
});

test("GET /agents/:slug/payments returns 404 when loader returns null (missing or no treasury)", async () => {
  const app = await makeApp({ loadPayments: async () => null });
  const res = await app.inject({
    method: "GET",
    url: "/agents/missing/payments",
  });
  assert.equal(res.statusCode, 404);
});

test("GET /agents/:slug/payments scopes the loader by orgId", async () => {
  let observed = "";
  const app = await makeApp({
    loadPayments: async ({ orgId }) => {
      observed = orgId;
      return null;
    },
  });
  await app.inject({ method: "GET", url: "/agents/eliza/payments" });
  assert.equal(observed, "org_1");
});

// ============================================
// Happy path
// ============================================

test("GET /agents/:slug/payments returns the page with BigInts stringified + Dates as ISO", async () => {
  const app = await makeApp({
    loadPayments: async () => ({
      payments: [samplePayment()],
      totalCount: 1,
    }),
  });
  const res = await app.inject({
    method: "GET",
    url: "/agents/eliza/payments",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.totalCount, 1);
  assert.equal(body.payments.length, 1);
  const p = body.payments[0];
  assert.equal(p.id, "cp_1");
  assert.equal(typeof p.amountLamports, "string");
  assert.equal(p.amountLamports, "4500000");
  assert.equal(typeof p.computeSeconds, "string");
  assert.equal(p.status, "CONFIRMED");
  assert.equal(p.paidAt, "2026-04-26T11:00:00.000Z");
  assert.equal(p.scheduledFor, "2026-04-26T10:55:00.000Z");
});

test("GET /agents/:slug/payments returns an empty array when the treasury has no payments yet", async () => {
  const app = await makeApp({
    loadPayments: async () => ({ payments: [], totalCount: 0 }),
  });
  const res = await app.inject({
    method: "GET",
    url: "/agents/eliza/payments",
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().payments, []);
  assert.equal(res.json().totalCount, 0);
});

test("GET /agents/:slug/payments preserves nullable fields as null (not omitted)", async () => {
  // PENDING payments have null txSignature/paidAt; FAILED rows may have
  // an errorMessage. The dashboard branches on null, so the API must not
  // omit the keys.
  const app = await makeApp({
    loadPayments: async () => ({
      payments: [
        samplePayment({
          status: "PENDING",
          txSignature: null,
          paidAt: null,
          errorMessage: null,
        }),
      ],
      totalCount: 1,
    }),
  });
  const res = await app.inject({
    method: "GET",
    url: "/agents/eliza/payments",
  });
  const p = res.json().payments[0];
  assert.equal(p.txSignature, null);
  assert.equal(p.paidAt, null);
  assert.equal(p.errorMessage, null);
});

// ============================================
// Pagination
// ============================================

test("GET /agents/:slug/payments defaults limit=20 and offset=0", async () => {
  let observed: any = null;
  const app = await makeApp({
    loadPayments: async (args) => {
      observed = args;
      return { payments: [], totalCount: 0 };
    },
  });
  await app.inject({ method: "GET", url: "/agents/eliza/payments" });
  assert.equal(observed.limit, 20);
  assert.equal(observed.offset, 0);
});

test("GET /agents/:slug/payments forwards limit + offset query params", async () => {
  let observed: any = null;
  const app = await makeApp({
    loadPayments: async (args) => {
      observed = args;
      return { payments: [], totalCount: 0 };
    },
  });
  await app.inject({
    method: "GET",
    url: "/agents/eliza/payments?limit=50&offset=100",
  });
  assert.equal(observed.limit, 50);
  assert.equal(observed.offset, 100);
});

test("GET /agents/:slug/payments rejects limit > 100 with 400", async () => {
  const app = await makeApp({
    loadPayments: async () => ({ payments: [], totalCount: 0 }),
  });
  const res = await app.inject({
    method: "GET",
    url: "/agents/eliza/payments?limit=101",
  });
  assert.equal(res.statusCode, 400);
});

test("GET /agents/:slug/payments rejects negative offset with 400", async () => {
  const app = await makeApp({
    loadPayments: async () => ({ payments: [], totalCount: 0 }),
  });
  const res = await app.inject({
    method: "GET",
    url: "/agents/eliza/payments?offset=-5",
  });
  assert.equal(res.statusCode, 400);
});

// ============================================
// Status filter
// ============================================

test("GET /agents/:slug/payments forwards a recognized status filter", async () => {
  let observed: any = null;
  const app = await makeApp({
    loadPayments: async (args) => {
      observed = args;
      return { payments: [], totalCount: 0 };
    },
  });
  await app.inject({
    method: "GET",
    url: "/agents/eliza/payments?status=FAILED",
  });
  assert.equal(observed.status, "FAILED");
});

test("GET /agents/:slug/payments rejects an unrecognized status with 400", async () => {
  const app = await makeApp({
    loadPayments: async () => ({ payments: [], totalCount: 0 }),
  });
  const res = await app.inject({
    method: "GET",
    url: "/agents/eliza/payments?status=NOT_A_STATUS",
  });
  assert.equal(res.statusCode, 400);
});

test("GET /agents/:slug/payments forwards status=null when absent", async () => {
  let observed: any = null;
  const app = await makeApp({
    loadPayments: async (args) => {
      observed = args;
      return { payments: [], totalCount: 0 };
    },
  });
  await app.inject({ method: "GET", url: "/agents/eliza/payments" });
  assert.equal(observed.status, null);
});

// ============================================
// Date range
// ============================================

test("GET /agents/:slug/payments forwards from/to as Dates", async () => {
  let observed: any = null;
  const app = await makeApp({
    loadPayments: async (args) => {
      observed = args;
      return { payments: [], totalCount: 0 };
    },
  });
  const fromIso = "2026-04-26T00:00:00.000Z";
  const toIso = "2026-04-27T00:00:00.000Z";
  await app.inject({
    method: "GET",
    url: `/agents/eliza/payments?from=${fromIso}&to=${toIso}`,
  });
  assert.ok(observed.from instanceof Date);
  assert.ok(observed.to instanceof Date);
  assert.equal(observed.from.toISOString(), fromIso);
  assert.equal(observed.to.toISOString(), toIso);
});

test("GET /agents/:slug/payments rejects from > to with 400", async () => {
  const app = await makeApp({
    loadPayments: async () => ({ payments: [], totalCount: 0 }),
  });
  const res = await app.inject({
    method: "GET",
    url:
      "/agents/eliza/payments" +
      "?from=2026-04-27T00:00:00Z&to=2026-04-26T00:00:00Z",
  });
  assert.equal(res.statusCode, 400);
});

test("GET /agents/:slug/payments rejects an invalid date string with 400", async () => {
  const app = await makeApp({
    loadPayments: async () => ({ payments: [], totalCount: 0 }),
  });
  const res = await app.inject({
    method: "GET",
    url: "/agents/eliza/payments?from=not-a-date",
  });
  assert.equal(res.statusCode, 400);
});

// ============================================
// Echo
// ============================================

test("GET /agents/:slug/payments echoes limit, offset, totalCount, status, from, to in the response", async () => {
  const fromIso = "2026-04-26T00:00:00.000Z";
  const toIso = "2026-04-27T00:00:00.000Z";
  const app = await makeApp({
    loadPayments: async () => ({ payments: [], totalCount: 42 }),
  });
  const res = await app.inject({
    method: "GET",
    url: `/agents/eliza/payments?limit=5&offset=10&status=CONFIRMED&from=${fromIso}&to=${toIso}`,
  });
  const body = res.json();
  assert.equal(body.totalCount, 42);
  assert.equal(body.limit, 5);
  assert.equal(body.offset, 10);
  assert.equal(body.status, "CONFIRMED");
  assert.equal(body.from, fromIso);
  assert.equal(body.to, toIso);
});
