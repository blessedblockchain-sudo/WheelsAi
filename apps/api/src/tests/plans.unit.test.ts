import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV ??= "development";
process.env.LOG_LEVEL ??= "error";
process.env.DATABASE_URL ??= "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET ??= "12345678901234567890123456789012";

const { effectivePlan, PLANS, PlanLimitError, usageMonth } = await import("../services/plans.js");

test("the plans match the pricing page", () => {
  assert.equal(PLANS.starter.maxAgents, 3);
  assert.equal(PLANS.starter.monthlyApiCalls, 1_000);
  assert.equal(PLANS.pro.priceMonthlyUsd, 49);
  assert.equal(PLANS.pro.maxAgents, null);
  assert.equal(PLANS.pro.monthlyApiCalls, 100_000);
  assert.equal(PLANS.pro.customDomains, true);
  assert.equal(PLANS.enterprise.sso, true);
});

test("paid features follow the subscription status", () => {
  assert.equal(effectivePlan(null), "starter");
  assert.equal(effectivePlan({ plan: "pro", status: "trialing" }), "pro");
  assert.equal(effectivePlan({ plan: "pro", status: "past_due" }), "pro");
  assert.equal(effectivePlan({ plan: "pro", status: "canceled" }), "starter");
  assert.equal(effectivePlan({ plan: "pro", status: "unpaid" }), "starter");
  assert.equal(effectivePlan({ plan: "enterprise", status: "manual" }), "enterprise");
  assert.equal(effectivePlan({ plan: "starter", status: "active" }), "starter");
});

test("usage months are UTC calendar months", () => {
  assert.equal(usageMonth(new Date("2026-10-31T23:59:59Z")), "2026-10");
  assert.equal(usageMonth(new Date("2026-11-01T00:00:00Z")), "2026-11");
});

test("API calls over the monthly allowance are refused; counter failures fail open", async () => {
  const { meterApiCall } = await import("../services/orgPlan.js");
  const counts = new Map<string, number>();
  const counter = {
    incr: async (k: string) => {
      counts.set(k, (counts.get(k) ?? 0) + 1);
      return counts.get(k)!;
    },
    expire: async () => 1,
    get: async (k: string) => String(counts.get(k) ?? 0),
  };
  const plan = { plan: "starter" as const, limits: { ...PLANS.starter, monthlyApiCalls: 2 } };
  await meterApiCall("o", { counter, plan });
  await meterApiCall("o", { counter, plan });
  await assert.rejects(meterApiCall("o", { counter, plan }), PlanLimitError);
  const broken = { incr: async () => { throw new Error("down"); }, expire: async () => 1, get: async () => null };
  assert.deepEqual(await meterApiCall("o", { counter: broken, plan }), { used: 0, limit: 2 });
  assert.deepEqual(
    await meterApiCall("o", { counter, plan: { plan: "enterprise", limits: PLANS.enterprise } }),
    { used: 0, limit: null },
  );
});

test("a Starter org cannot create a fourth agent; installs don't count", async () => {
  const { prisma } = await import("@wheelsai/db");
  const p = prisma as any;
  const saved = { orgSubscription: p.orgSubscription, agentInstall: p.agentInstall, agent: p.agent };
  let where: any;
  p.orgSubscription = { findUnique: async () => null };
  p.agentInstall = { findMany: async () => [{ clonedAgentId: "clone-1" }] };
  p.agent = { count: async (args: any) => { where = args.where; return 3; } };
  try {
    const { assertCanCreateAgent } = await import("../services/orgPlan.js");
    await assert.rejects(assertCanCreateAgent("o"), /up to 3 agents/);
    assert.deepEqual(where.id, { notIn: ["clone-1"] });
    p.orgSubscription = { findUnique: async () => ({ plan: "pro", status: "active" }) };
    await assertCanCreateAgent("o");
  } finally {
    Object.assign(p, saved);
  }
});

test("plan-limit errors reach clients as 403 / 429 with an upgrade link", async () => {
  const Fastify = (await import("fastify")).default;
  const { globalErrorHandler } = await import("../lib/errorHandler.js");
  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  app.get("/agents", async () => {
    throw new PlanLimitError("up to 3 agents", "starter", "maxAgents");
  });
  app.get("/v1", async () => {
    throw new PlanLimitError("calls used up", "starter", "monthlyApiCalls");
  });
  const a = await app.inject({ url: "/agents" });
  const b = await app.inject({ url: "/v1" });
  assert.equal(a.statusCode, 403);
  assert.equal(b.statusCode, 429);
  assert.equal(a.json().upgradeUrl, "/dashboard/billing?upgrade=pro");
  await app.close();
});
