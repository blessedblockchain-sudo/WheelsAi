import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

/**
 * H5: the fly tomls pointed their load-balancer check at /health, which
 * returns 200 unconditionally, so an instance with a dead database stayed in
 * rotation serving 500s. They now point at /health/ready.
 *
 * These pin the contract that repointing depends on: readiness must actually
 * go 503 when a dependency is gone, must not be fooled by a hung check, and
 * liveness must stay dependency-free.
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

const { createHealthRoutes } = await import("../routes/health.js");

const ok = async () => {};
const boom = async () => {
  throw new Error("connection refused");
};
const hang = () => new Promise<void>(() => {});

async function appWith(deps: {
  checkDatabase: () => Promise<void>;
  checkRedis: () => Promise<void>;
  timeoutMs?: number;
}) {
  const app = Fastify({ logger: false });
  await app.register(createHealthRoutes(deps), { prefix: "/health" });
  await app.ready();
  return app;
}

test("ready: 200 when both dependencies answer", async () => {
  const app = await appWith({ checkDatabase: ok, checkRedis: ok });
  const res = await app.inject({ method: "GET", url: "/health/ready" });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    status: "ready",
    checks: { database: "ok", redis: "ok" },
  });
  await app.close();
});

const FAILURE_CASES = [
  { name: "database down", db: boom, redis: ok, expect: { database: "failed", redis: "ok" } },
  { name: "redis down", db: ok, redis: boom, expect: { database: "ok", redis: "failed" } },
  { name: "both down", db: boom, redis: boom, expect: { database: "failed", redis: "failed" } },
];

for (const c of FAILURE_CASES) {
  test(`ready: 503 when ${c.name} — this is what pulls the machine from rotation`, async () => {
    const app = await appWith({ checkDatabase: c.db, checkRedis: c.redis });
    const res = await app.inject({ method: "GET", url: "/health/ready" });

    assert.equal(res.statusCode, 503);
    assert.equal(res.json().status, "not_ready");
    assert.deepEqual(res.json().checks, c.expect);
    await app.close();
  });
}

test("ready: a hung dependency fails the check instead of hanging the probe", async () => {
  // Without the timeout the handler would never respond, Fly's 5s check
  // would time out, and the failure would surface with no body saying which
  // dependency was stuck.
  const app = await appWith({
    checkDatabase: hang,
    checkRedis: ok,
    timeoutMs: 50,
  });

  const started = process.hrtime.bigint();
  const res = await app.inject({ method: "GET", url: "/health/ready" });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(res.statusCode, 503);
  assert.equal(res.json().checks.database, "failed");
  assert.ok(elapsedMs < 1000, `probe took ${elapsedMs}ms; should bail at ~50ms`);
  await app.close();
});

test("ready: checks run concurrently, so a slow db cannot mask a dead redis", async () => {
  // Run sequentially and the database would consume the whole budget before
  // Redis was attempted, reporting redis:"ok" during a Redis outage.
  const app = await appWith({
    checkDatabase: () => new Promise((resolve) => setTimeout(resolve, 120)),
    checkRedis: boom,
    timeoutMs: 400,
  });

  const res = await app.inject({ method: "GET", url: "/health/ready" });

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json().checks, { database: "ok", redis: "failed" });
  await app.close();
});

test("liveness stays 200 while dependencies are down, and touches neither", async () => {
  // A liveness probe that consults dependencies turns a Redis blip into a
  // simultaneous restart of every machine.
  let touched = false;
  const app = await appWith({
    checkDatabase: async () => {
      touched = true;
    },
    checkRedis: async () => {
      touched = true;
    },
  });

  for (const url of ["/health", "/health/live"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 200, `${url} must stay 200`);
    assert.equal(res.json().status, "ok");
  }
  assert.equal(touched, false, "liveness must not probe dependencies");
  await app.close();
});
