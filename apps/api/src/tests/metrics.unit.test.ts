import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

/**
 * H1: the fly tomls scrape `/metrics`, which did not exist.
 *
 * These pin the two things that make the endpoint worth having:
 *   - queue depth is actually reported, and a Redis failure degrades to a
 *     visible -1 rather than a vanished series or a 500
 *   - the optional METRICS_TOKEN gate is enforced, in constant time
 */

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ??
    "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}
setupEnv();

const { createMetrics, QUEUE_NAMES } = await import("../services/metrics.js");
const { createMetricsRoutes } = await import("../routes/metrics.js");

const HEALTHY = { waiting: 3, active: 1, delayed: 0, failed: 2 };

test("every queue in the fleet is reported", async () => {
  const seen: string[] = [];
  const m = createMetrics({
    async getQueueCounts(name) {
      seen.push(name);
      return HEALTHY;
    },
  });

  const text = await m.registry.metrics();

  assert.deepEqual(
    [...seen].sort(),
    [...QUEUE_NAMES].sort(),
    "collector must scrape every queue",
  );
  // The money-path workers specifically — these are the ones B5 silently killed.
  for (const q of ["payment-submit", "fee-router", "treasury-settlement"]) {
    assert.ok(
      text.includes(`queue="${q}"`),
      `missing series for ${q}`,
    );
  }
});

test("queue counts land on the right labels", async () => {
  const m = createMetrics({
    async getQueueCounts() {
      return HEALTHY;
    },
    queueNames: ["payment-submit"],
  });

  const text = await m.registry.metrics();

  assert.match(
    text,
    /wheelsai_queue_jobs\{[^}]*queue="payment-submit"[^}]*state="waiting"[^}]*\} 3/,
  );
  assert.match(
    text,
    /wheelsai_queue_jobs\{[^}]*queue="payment-submit"[^}]*state="failed"[^}]*\} 2/,
  );
});

test("a Redis failure reports -1 instead of dropping the series or 500ing", async () => {
  // The whole point of the gauge is to surface a dead worker fleet. If the
  // scrape threw, or silently omitted the queue, the outage would look
  // identical to an idle queue on a dashboard.
  const m = createMetrics({
    async getQueueCounts() {
      throw new Error("READONLY You can't write against a read only replica");
    },
    queueNames: ["payment-submit"],
  });

  const text = await m.registry.metrics();

  assert.match(
    text,
    /wheelsai_queue_jobs\{[^}]*queue="payment-submit"[^}]*state="waiting"[^}]*\} -1/,
  );
});

test("default process metrics are present", async () => {
  const m = createMetrics({
    async getQueueCounts() {
      return HEALTHY;
    },
    queueNames: [],
  });
  const text = await m.registry.metrics();
  assert.ok(text.includes("wheelsai_process_cpu_seconds_total"));
  assert.ok(text.includes("wheelsai_nodejs_eventloop_lag_seconds"));
});

test("http observations are labelled by route pattern, not concrete path", async () => {
  const m = createMetrics({
    async getQueueCounts() {
      return HEALTHY;
    },
    queueNames: [],
  });

  m.observeRequest({
    method: "GET",
    route: "/api/agents/:agentId",
    statusCode: 200,
    durationSeconds: 0.012,
  });

  const text = await m.registry.metrics();
  assert.ok(text.includes('route="/api/agents/:agentId"'));
  assert.ok(text.includes("wheelsai_http_requests_total"));
});

async function appWithToken(token?: string) {
  const m = createMetrics({
    async getQueueCounts() {
      return HEALTHY;
    },
    queueNames: [],
  });
  const app = Fastify({ logger: false });
  await app.register(createMetricsRoutes({ registry: m.registry, token }));
  await app.ready();
  return app;
}

test("no token configured: open, as Fly's 6PN scraper requires", async () => {
  const app = await appWithToken(undefined);
  const res = await app.inject({ method: "GET", url: "/metrics" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] as string, /text\/plain/);
  await app.close();
});

test("token configured: correct bearer is accepted", async () => {
  const app = await appWithToken("s3cret-token");
  const res = await app.inject({
    method: "GET",
    url: "/metrics",
    headers: { authorization: "Bearer s3cret-token" },
  });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test("token configured: missing, wrong, and wrong-length bearers are all refused", async () => {
  const app = await appWithToken("s3cret-token");

  for (const headers of [
    undefined,
    { authorization: "Bearer wrong-token" },
    { authorization: "Bearer short" }, // different length — must not throw
    { authorization: "s3cret-token" }, // no Bearer prefix
  ]) {
    const res = await app.inject({ method: "GET", url: "/metrics", headers });
    // 404, not 401: a prober should not learn that metrics exist here.
    assert.equal(res.statusCode, 404, `expected 404 for ${JSON.stringify(headers)}`);
    assert.ok(!res.body.includes("wheelsai_"), "must not leak metric text");
  }

  await app.close();
});
